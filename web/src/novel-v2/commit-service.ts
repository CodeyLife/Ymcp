import { randomUUID } from "node:crypto";
import type { ChapterMemory, CommitRequest, CommitResult, RuntimeLearningAssessmentV2 } from "./protocol";
import { NovelPostgresRepository } from "./postgres-repository";
import { ContentObjectStore, type ObjectStoreAdapter } from "./object-store";
import type { ModelGateway } from "./model-gateway";
import type { ModelRoutingSnapshot } from "./model-routing";
import type { MemoryIndex } from "./qdrant-memory";
import { createChapterMemoryFromRevision } from "./chapter-memory";

/**
 * V2 Commit Service：负责章节定稿提交 + chapter memory 创建。
 *
 * 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约。
 *
 * 流程：
 * 1. 双门审核（internal + independent）：必须同时具备当前 artifact 的内部门和独立门证据
 * 2. 写入 objectStore（正文落盘）
 * 3. commitRevision：写入 manuscript_revisions + 推进 current_revision + 写 idempotency_keys
 * 4. createChapterMemoryFromRevision：从定稿正文提取章节记忆（summary/keyEvents/...）
 *    - 失败不阻塞 commit（revision 已落库），只记录错误让上游 learning 闭环感知
 *    - 符合 AGENTS.md「不阻塞 commit」契约
 *
 * chapter memory 依赖注入（可选）：
 * - model + routingSnapshot + memoryIndex 都提供时，启用 chapter memory 创建
 * - 缺失时跳过（向后兼容，如测试环境无 LLM/Qdrant 时仍可 commit）
 */
export interface ChapterMemoryDeps {
  model: ModelGateway;
  memoryIndex?: MemoryIndex;
  /** 默认 routingSnapshot（commit activity 不传 routingSnapshot 时用此值）。 */
  defaultRoutingSnapshot?: ModelRoutingSnapshot;
  workflowRunId?: string;
  /** 章节顺序号（若提供，直接用；否则从 repository 查 manuscript_documents.narrative_order）。 */
  narrativeOrder?: number;
}

export class CommitService {
  constructor(
    private readonly repository: NovelPostgresRepository,
    private readonly objects: ObjectStoreAdapter = new ContentObjectStore(),
    /** 可选的 chapter memory 依赖。缺失时 commit 不创建 chapter memory（向后兼容）。 */
    private readonly chapterMemoryDeps?: ChapterMemoryDeps,
  ) {}

  async commit(input: CommitRequest & { text: string }): Promise<CommitResult & { chapterMemory?: ChapterMemory }> {
    const independent = input.reviews.some((review) => review.identity === "independent" && review.verdict === "passed" && review.artifactFingerprint === input.artifact.fingerprint);
    const internal = input.reviews.some((review) => review.identity === "internal" && review.verdict === "passed" && review.artifactFingerprint === input.artifact.fingerprint);
    if (!independent || !internal) throw new Error("正式提交必须同时具备当前 artifact 的内部门和独立门证据");
    return this.persistApprovedRevision(input);
  }

  /** Commit a manuscript only after an explicit durable author approval signal. */
  async commitAuthorApproved(input: CommitRequest & { text: string }): Promise<CommitResult & { chapterMemory?: ChapterMemory }> {
    const authorApproval = input.reviews.some((review) =>
      review.identity === "human"
      && review.verdict === "passed"
      && review.artifactFingerprint === input.artifact.fingerprint,
    );
    if (!authorApproval) throw new Error("作者批准提交必须包含当前 artifact 的 human passed 证据");
    return this.persistApprovedRevision(input);
  }

  private async persistApprovedRevision(input: CommitRequest & { text: string }): Promise<CommitResult & { chapterMemory?: ChapterMemory }> {
    const object = await this.objects.putText(input.text);
    const result = await this.repository.commitRevision({ ...input, contentHash: object.hash, objectKey: object.key, revisionId: randomUUID() });

    // chapter memory 创建：失败不阻塞 commit（revision 已落库），记录到 learning 闭环
    // 设计依据：AGENTS.md「不阻塞 commit」契约 + Phase 1.2 chapter memory 闭环
    // 失败处理：构造 RuntimeLearningAssessmentV2(conclusion=no-shared-learning) 让 learning 闭环感知症状
    if (this.chapterMemoryDeps) {
      try {
        const narrativeOrder = this.chapterMemoryDeps.narrativeOrder ?? await this.lookupNarrativeOrder(input.projectId, input.documentId);
        const chapterMemory = await createChapterMemoryFromRevision(
          {
            projectId: input.projectId,
            documentId: input.documentId,
            revisionId: result.revisionId,
            narrativeOrder,
            text: input.text,
            artifact: input.artifact,
            model: this.chapterMemoryDeps.model,
            routingSnapshot: this.chapterMemoryDeps.defaultRoutingSnapshot,
            workflowRunId: this.chapterMemoryDeps.workflowRunId,
            taskId: `${input.artifact.taskId}:chapter-memory`,
          },
          { repository: this.repository, objects: this.objects, memoryIndex: this.chapterMemoryDeps.memoryIndex },
        );
        return { ...result, chapterMemory };
      } catch (error) {
        // chapter memory 创建失败：记录到 learning 闭环（conclusion=no-shared-learning，仅 symptom 不构造 candidate）
        // 设计依据：AGENTS.md「review-stage → learning 通路」契约——审核结果必须反馈到 learning
        await this.recordChapterMemoryFailure(input, result.revisionId, error instanceof Error ? error : new Error(String(error)));
        return result;
      }
    }
    return result;
  }

  /**
   * 把 chapter memory 创建失败记录为 RuntimeLearningAssessmentV2。
   *
   * 设计依据：AGENTS.md「review-stage → learning 通路」契约——
   * 不允许审核/提取结果只写入 qualityReport 而不反馈到 learning。
   * chapter memory 失败属于 fact-extraction 层故障，记录 symptom + failingLayer
   * 让 learning 闭环感知（conclusion=no-shared-learning 表示不构造 candidate，
   * 仅作为运行时症状留痕，供后续 propose-improvement 分析使用）。
   */
  private async recordChapterMemoryFailure(input: CommitRequest & { text: string }, revisionId: string, error: Error): Promise<void> {
    const message = error.message || String(error);
    console.warn(`[commit-service] chapter memory 创建失败（不阻塞 commit）：${message}`);
    try {
      const assessment: RuntimeLearningAssessmentV2 = {
        id: `learning:chapter-memory-failure:${revisionId}`,
        projectId: input.projectId,
        source: {
          workflowId: this.chapterMemoryDeps?.workflowRunId ?? "commit-service",
          artifactId: input.artifact.id,
          reviewIds: input.reviews.map((review) => review.id),
          fingerprint: input.artifact.fingerprint,
        },
        conclusion: "no-shared-learning",
        symptom: `chapter memory 创建失败：${message}`,
        failingLayer: "commit-stage.chapter-memory",
        createdAt: Date.now(),
      };
      await this.repository.recordLearningAssessment(assessment);
    } catch (recordError) {
      // learning 记录失败不应再掩盖原始 commit 成功，只警告
      console.warn(`[commit-service] learning 记录失败：${(recordError as Error).message}`);
    }
  }

  /**
   * 查询章节顺序号（manuscript_documents.narrative_order）。
   *
   * 用于 chapter memory 的 narrativeRange 字段。
   */
  private async lookupNarrativeOrder(projectId: string, documentId: string): Promise<number> {
    const narrativeOrder = await this.repository.getDocumentNarrativeOrder(projectId, documentId);
    if (narrativeOrder === undefined) throw new Error(`章节不存在：${documentId}`);
    return narrativeOrder;
  }
}
