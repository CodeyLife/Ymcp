import { randomUUID } from "node:crypto";
import type { ChapterMemory, CommitRequest, CommitResult, RuntimeLearningAssessmentV2 } from "./protocol";
import { NovelPostgresRepository } from "./postgres-repository";
import { ContentObjectStore, type ObjectStoreAdapter } from "./object-store";
import type { ModelGateway } from "./model-gateway";
import type { ModelRoutingSnapshot } from "./model-routing";
import type { MemoryIndex } from "./qdrant-memory";
import { createChapterMemoryFromRevision, persistChapterMemoryOutput, validateChapterMemoryOutput } from "./chapter-memory";
import { evaluateCommitGate } from "./temporal/revision-policy";
import type { ChapterStateDelta, FactExtractionOutput } from "./prompts/schemas";
import { inspectManuscript, type ManuscriptStructuralReport } from "./application/manuscript-structure";
import type { ReviewDimension } from "./prompts/schemas";

type CommitDerivedData = {
  structuralReport: ManuscriptStructuralReport;
  payoffMoments?: FactExtractionOutput["payoffMoments"];
  narrativeElements?: FactExtractionOutput["narrativeElements"];
  narrativeOrder?: number;
  chapterMemoryDelta?: ChapterStateDelta["chapterMemory"];
  factArtifactId?: string;
  applicableReviewDimensions?: readonly ReviewDimension[];
};

/**
 * V2 Commit Service：负责章节定稿提交 + chapter memory 创建。
 *
 * 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约。
 *
 * 流程：
 * 1. 五角色审核：必须具备当前 artifact 的全部角色通过证据
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

  async commit(input: CommitRequest & { text: string } & CommitDerivedData): Promise<CommitResult & { chapterMemory?: ChapterMemory }> {
    const gate = evaluateCommitGate(input.reviews, input.artifact.fingerprint, input.structuralReport, { applicableDimensions: input.applicableReviewDimensions });
    if (!gate.passed) throw new Error(`正式提交必须具备当前 artifact 的完整五角色通过证据；缺失角色：${gate.missingRoles.join("、") || "无"}`);
    if (!inspectManuscript({ text: input.text }).passed) throw new Error("正式提交正文未通过确定性结构复检");
    return this.persistApprovedRevision(input);
  }

  /** Commit a manuscript only after an explicit durable author approval signal. */
  async commitAuthorApproved(input: CommitRequest & { text: string; approvalEvidenceId: string } & CommitDerivedData): Promise<CommitResult & { chapterMemory?: ChapterMemory }> {
    if (!input.structuralReport.passed || !inspectManuscript({ text: input.text }).passed) throw new Error("作者覆盖不能越过正文结构 blocker");
    const evidence = await this.repository.getApprovalEvidenceById(input.approvalEvidenceId);
    if (!evidence
      || evidence.projectId !== input.projectId
      || evidence.artifactId !== input.artifact.id
      || evidence.decision !== "approve"
      || evidence.actorSource !== "interactive-web") {
      throw new Error("作者批准提交必须绑定当前项目和 artifact 的 interactive-web 批准证据");
    }
    return this.persistApprovedRevision(input);
  }

  private async persistApprovedRevision(input: CommitRequest & { text: string } & CommitDerivedData): Promise<CommitResult & { chapterMemory?: ChapterMemory }> {
    const object = await this.objects.putText(input.text);
    const result = await this.repository.commitRevision({ ...input, contentHash: object.hash, objectKey: object.key, revisionId: randomUUID() });

    if (this.chapterMemoryDeps?.memoryIndex) {
      try {
        if (result.removedClaimIds?.length) await this.chapterMemoryDeps.memoryIndex.deleteClaims?.(input.projectId, result.removedClaimIds);
        const retrievable = (result.activatedClaims ?? []).filter((claim) => ["approved", "author", "derived"].includes(claim.authority));
        if (retrievable.length) await this.chapterMemoryDeps.memoryIndex.upsertClaims(input.projectId, retrievable);
      } catch (error) {
        console.warn(`[commit-service] 事实索引同步失败（PostgreSQL 已完成修订切换，可重建索引）：${(error as Error).message}`);
      }
    }

    if (input.narrativeElements) {
      try {
        await this.repository.recordNarrativeElements({
          projectId: input.projectId,
          documentId: input.documentId,
          artifact: input.artifact,
          revisionId: result.revisionId,
          narrativeOrder: input.narrativeOrder,
          narrativeElements: input.narrativeElements,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[commit-service] 叙事元素写入失败（正文 revision 已提交，可重放）：${message}`);
        await this.repository.recordProjectionFailure({
          projectId: input.projectId,
          projectionType: "narrative-elements",
          aggregateId: result.revisionId,
          payload: { documentId: input.documentId, artifactId: input.artifact.id, revisionId: result.revisionId, narrativeOrder: input.narrativeOrder, narrativeElements: input.narrativeElements },
          error: message,
        }).catch((recordError) => console.warn(`[commit-service] 投影失败记录写入失败：${(recordError as Error).message}`));
      }
    }

    if (input.payoffMoments?.length && input.narrativeOrder !== undefined) {
      try {
        await this.repository.recordPayoffCurve({
          projectId: input.projectId,
          documentId: input.documentId,
          revisionId: result.revisionId,
          narrativeOrder: input.narrativeOrder,
          payoffMoments: input.payoffMoments,
        });
      } catch (error) {
        console.warn(`[commit-service] 爽点曲线写入失败（正文 revision 已提交）：${(error as Error).message}`);
      }
    }

    // chapter memory 创建：失败不阻塞 commit（revision 已落库），记录到 learning 闭环
    // 设计依据：AGENTS.md「不阻塞 commit」契约 + Phase 1.2 chapter memory 闭环
    // 失败处理：构造 RuntimeLearningAssessmentV2(conclusion=no-shared-learning) 让 learning 闭环感知症状
    let chapterMemory: ChapterMemory | undefined;
    if (this.chapterMemoryDeps) {
      try {
        const narrativeOrder = this.chapterMemoryDeps.narrativeOrder ?? await this.lookupNarrativeOrder(input.projectId, input.documentId);
        const memoryInput = {
            projectId: input.projectId,
            documentId: input.documentId,
            revisionId: result.revisionId,
            narrativeOrder,
            text: input.text,
            artifact: input.artifact,
        };
        let chapterMemoryDelta = input.chapterMemoryDelta;
        if (chapterMemoryDelta) {
          try { validateChapterMemoryOutput(chapterMemoryDelta); }
          catch (error) {
            console.warn(`[commit-service] ChapterStateDelta 的章节记忆无效，回退独立提取：${(error as Error).message}`);
            chapterMemoryDelta = undefined;
          }
        }
        chapterMemory = chapterMemoryDelta
          ? await persistChapterMemoryOutput(memoryInput, { repository: this.repository, objects: this.objects, memoryIndex: this.chapterMemoryDeps.memoryIndex }, chapterMemoryDelta)
          : await createChapterMemoryFromRevision(
          {
            ...memoryInput,
            model: this.chapterMemoryDeps.model,
            routingSnapshot: this.chapterMemoryDeps.defaultRoutingSnapshot,
            workflowRunId: this.chapterMemoryDeps.workflowRunId,
            taskId: `${input.artifact.taskId}:chapter-memory`,
          },
          { repository: this.repository, objects: this.objects, memoryIndex: this.chapterMemoryDeps.memoryIndex },
        );
      } catch (error) {
        // chapter memory 创建失败：记录到 learning 闭环（conclusion=no-shared-learning，仅 symptom 不构造 candidate）
        // 设计依据：AGENTS.md「review-stage → learning 通路」契约——审核结果必须反馈到 learning
        await this.recordChapterMemoryFailure(input, result.revisionId, error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (chapterMemory) {
      try {
        const narrativeOrder = input.narrativeOrder ?? chapterMemory.narrativeRange.end;
        await this.repository.recordNarrativeStateSnapshot({
          projectId: input.projectId,
          documentId: input.documentId,
          revisionId: result.revisionId,
          narrativeOrder,
          chapterMemory,
          narrativeElements: input.narrativeElements,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[commit-service] 叙事状态账本写入失败（正文 revision 已提交，可重建）：${message}`);
        await this.repository.recordProjectionFailure({
          projectId: input.projectId,
          projectionType: "narrative-state-snapshot",
          aggregateId: result.revisionId,
          payload: { documentId: input.documentId, revisionId: result.revisionId, narrativeOrder: input.narrativeOrder },
          error: message,
        }).catch((recordError) => console.warn(`[commit-service] 叙事账本投影失败记录写入失败：${(recordError as Error).message}`));
      }
    }
    return chapterMemory ? { ...result, chapterMemory } : result;
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
