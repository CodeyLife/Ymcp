/**
 * 晋升服务：把 CandidateBundle 原子地写回正式库。
 *
 * 设计依据：docs/novel-real-data-evaluation-architecture.md §4.4 / §5.3。
 *
 * 接入点：闭环工作流（bench/CLI/UI）在 CandidateBundle 通过作者审批后调用
 * `createPromotionService(canonicalDb).promote(candidate, decision)`。
 *
 * 与实验库的关系：PromotionService 只写正式库，不读/写实验库。所有实验库产物
 * 已被 extractCandidateBundle 归一化进 CandidateBundle，本服务消费 bundle 即可。
 *
 * 原子性保证：promote 在单个 Dexie 事务内完成所有写入；任一步骤抛错则整个事务
 * 回滚，正式库保持原样。事务外只读取幂等 receipt，不写入业务数据。
 *
 * 幂等性：以 `promote:${candidate.id}` 作为 operationId，写入 operationReceipts 表。
 * 同一 candidateId 重复 promote 直接返回已存在的 receipt，不会重复创建 revision/
 * factAssertion/skill 更新。
 *
 * 失败模式：
 * - `stale-baseline`：正式库 dependencyHead 与 candidate.dependencyHead 不一致，
 *   说明实验期间正式库已前进，拒绝晋升，不写任何数据。
 * - `content-hash-mismatch`：candidate.manuscript.contentHash 与重算结果不一致，
 *   说明 bundle 在传输/序列化中被篡改，拒绝晋升。
 * - `deterministic-blocker`：candidate 缺少必填字段或 verifyCandidateBundle 不通过。
 * - `transaction-failure`：事务内任一写入抛错；事务回滚，receipt 记录失败原因。
 */
import {
  documentContentHash,
  invalidateRevisionDependentsInCurrentTransaction,
  novelDb,
  recordBase,
  type NovelDatabase,
} from "../db";
import type {
  DocumentRevision,
  FactCandidate,
  ManuscriptDocument,
  NovelSkillManifest,
  ProjectSkillBinding,
} from "../types";
import { commitAcceptedFacts, createWorkflowSnapshot, factProjectionValuesEqual, readFactField } from "../facts";
import { createChapterMemory } from "../memory";
import { upsertEmbedding } from "../retrieval";
import { BUILTIN_NOVEL_SKILLS } from "../skills";
import { captureProjectSnapshot, type ProjectHead } from "./project-snapshot";
import {
  computeManuscriptContentHash,
  computeWorkflowInputHash,
  verifyCandidateBundle,
} from "./candidate-bundle";
import type {
  AuthorDecision,
  CandidateBundle,
  OperationReceipt,
  PromotionCheck,
  PromotionReceipt,
  PromotionService,
} from "./types";

// ===== 依赖头重算 =====

/**
 * 从正式库当前状态重算 ProjectHead。
 *
 * 与 project-snapshot.ts 的 buildProjectHead 等价，但只读取 documents + projects，
 * 不捕获完整快照——inspect 是只读检查，不需要 records。
 */
async function recomputeDependencyHead(db: NovelDatabase, projectId: string): Promise<ProjectHead> {
  const [project, documents] = await Promise.all([
    db.projects.get(projectId),
    db.documents.where("projectId").equals(projectId).toArray(),
  ]);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  const finalDocuments = documents
    .filter((document) => document.status === "final" && !document.deletedAt)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const latest = finalDocuments.at(-1);
  return {
    projectRevision: project.revision,
    currentSnapshotId: project.currentSnapshotId,
    latestFinalDocumentId: latest?.id,
    latestFinalDocumentOrder: latest?.order,
    finalDocumentHeads: finalDocuments.map((document) => ({
      documentId: document.id,
      documentRevision: document.revision,
      approvedRevisionId: document.approvedRevisionId,
      contentHash: documentContentHash(document),
    })),
  };
}

function headsEqual(left: ProjectHead, right: ProjectHead): boolean {
  if (left.projectRevision !== right.projectRevision) return false;
  if (left.currentSnapshotId !== right.currentSnapshotId) return false;
  if (left.latestFinalDocumentId !== right.latestFinalDocumentId) return false;
  if (left.latestFinalDocumentOrder !== right.latestFinalDocumentOrder) return false;
  if (left.finalDocumentHeads.length !== right.finalDocumentHeads.length) return false;
  for (let index = 0; index < left.finalDocumentHeads.length; index += 1) {
    const leftHead = left.finalDocumentHeads[index]!;
    const rightHead = right.finalDocumentHeads[index]!;
    if (
      leftHead.documentId !== rightHead.documentId
      || leftHead.documentRevision !== rightHead.documentRevision
      || leftHead.approvedRevisionId !== rightHead.approvedRevisionId
      || leftHead.contentHash !== rightHead.contentHash
    ) {
      return false;
    }
  }
  return true;
}

// ===== 工厂 =====

/**
 * 创建晋升服务实例。
 *
 * @param canonicalDb 正式库实例（默认全局 novelDb）。PromotionService 只写此库。
 */
export function createPromotionService(canonicalDb: NovelDatabase = novelDb): PromotionService {
  return new PromotionServiceImpl(canonicalDb);
}

// ===== 实现 =====

class PromotionServiceImpl implements PromotionService {
  constructor(private readonly db: NovelDatabase) {}

  async inspect(candidate: CandidateBundle): Promise<PromotionCheck> {
    const issues: string[] = [];
    const deterministicBlockers: string[] = [];

    // 1. CandidateBundle 自身完整性（同步校验）
    const verification = verifyCandidateBundle(candidate);
    if (!verification.valid) {
      deterministicBlockers.push(...verification.issues);
    }

    // 2. 重算 manuscript.contentHash（传输篡改检测）
    let recomputedContentHash = "";
    try {
      recomputedContentHash = await computeManuscriptContentHash({
        title: candidate.manuscript.title,
        summary: candidate.manuscript.summary,
        contentHtml: candidate.manuscript.contentHtml,
        plainText: candidate.manuscript.plainText,
        wordCount: candidate.manuscript.wordCount,
      });
      if (recomputedContentHash !== candidate.manuscript.contentHash) {
        deterministicBlockers.push(
          `manuscript.contentHash 不匹配：candidate=${candidate.manuscript.contentHash.slice(0, 12)}... recomputed=${recomputedContentHash.slice(0, 12)}...`,
        );
      }
    } catch (error) {
      deterministicBlockers.push(`重算 manuscript.contentHash 失败：${(error as Error).message}`);
    }

    // 3. 重算 dependencyHead（基线漂移检测）
    let recomputedDependencyHead: ProjectHead;
    try {
      recomputedDependencyHead = await recomputeDependencyHead(this.db, candidate.sourceProjectId);
    } catch (error) {
      // 正式库读不到项目，直接拒绝
      return {
        status: "rejected",
        issues: [`无法重算 dependencyHead：${(error as Error).message}`],
        recomputedDependencyHead: {
          projectRevision: -1,
          finalDocumentHeads: [],
        },
        baselineMatches: false,
        deterministicBlockers,
      };
    }

    let snapshotMatches = false;
    try {
      const currentSnapshot = await captureProjectSnapshot(this.db, candidate.sourceProjectId, "manual");
      snapshotMatches = currentSnapshot.manifest.snapshotHash === candidate.baseSnapshotHash;
    } catch (error) {
      deterministicBlockers.push(`重算正式库项目快照失败：${(error as Error).message}`);
    }
    let workflowInputMatches = false;
    if (candidate.workflowInput) {
      const [conversationThread, creativeBrief] = await Promise.all([
        this.db.conversationThreads.get(candidate.workflowInput.conversationThreadId),
        this.db.creativeBriefs.get(candidate.workflowInput.creativeBriefId),
      ]);
      workflowInputMatches = Boolean(conversationThread && creativeBrief)
        && await computeWorkflowInputHash(conversationThread) === candidate.workflowInput.conversationThreadHash
        && await computeWorkflowInputHash(creativeBrief) === candidate.workflowInput.creativeBriefHash;
    }
    const baselineMatches = headsEqual(recomputedDependencyHead, candidate.dependencyHead)
      && snapshotMatches
      && workflowInputMatches;
    if (!baselineMatches) {
      issues.push(!workflowInputMatches
        ? "创作简报或检索源覆盖已变化，候选包基于过时输入"
        : snapshotMatches
          ? "正式库 dependencyHead 已变化，候选包基于过时基线"
          : "正式库项目快照已变化，候选包基于过时基线");
    }

    // 4. 综合判定状态
    let status: PromotionCheck["status"];
    if (deterministicBlockers.length > 0) {
      status = "rejected";
    } else if (!baselineMatches) {
      status = "stale-baseline";
    } else {
      status = "ready";
    }

    return {
      status,
      issues,
      recomputedDependencyHead,
      baselineMatches,
      deterministicBlockers,
    };
  }

  async promote(candidate: CandidateBundle, decision: AuthorDecision): Promise<PromotionReceipt> {
    // 1. 决策基础校验
    if (!decision.accepted) {
      return this.buildRejectedReceipt(candidate, "AuthorDecision.accepted 必须为 true");
    }
    if (decision.authorId.length === 0) {
      return this.buildRejectedReceipt(candidate, "AuthorDecision.authorId 缺失");
    }

    // 2. 幂等检查：以 candidateId 派生 operationId
    const operationId = `promote:${candidate.id}`;
    const existing = await this.db.operationReceipts
      .where("[operationId+status]")
      .equals([operationId, "completed"])
      .first();
    if (existing) {
      const operationIds = existing.receipts.operationIds
        ?? (await this.db.operations.where("operationId").equals(operationId).toArray()).map((item) => item.id);
      return {
        candidateId: candidate.id,
        operationId: existing.operationId,
        status: "already-promoted",
        promotedAt: existing.completedAt ?? existing.createdAt,
        createdRevisionId: existing.receipts.revisionId,
        createdFactAssertionIds: existing.receipts.factAssertionIds,
        createdMemoryIds: existing.receipts.memoryIds,
        createdSnapshotId: existing.receipts.snapshotId,
        createdOperationIds: operationIds,
      };
    }

    // 3. inspect 通过才能晋升
    const check = await this.inspect(candidate);
    if (check.status !== "ready") {
      const reason = check.status === "stale-baseline"
        ? "stale-baseline：候选包基线已过时"
        : check.deterministicBlockers.length > 0
          ? `deterministic-blocker：${check.deterministicBlockers.join("；")}`
          : `rejected：${check.issues.join("；")}`;
      return this.buildRejectedReceipt(candidate, reason);
    }

    // 4. 准备事务写入所需的数据
    const db = this.db;
    const projectId = candidate.sourceProjectId;
    const now = Date.now();
    const receiptId = recordBase(projectId).id;

    // 4.1 读取目标 document 的当前状态（事务外读，事务内会再次 get 校验）
    const targetDocument = await db.documents.get(candidate.targetDocument.documentId);
    if (!targetDocument) {
      return this.buildRejectedReceipt(candidate, `目标 document 不存在：${candidate.targetDocument.documentId}`);
    }
    if (targetDocument.id !== candidate.targetDocument.documentId
      || targetDocument.revision !== candidate.targetDocument.baseRevision
      || documentContentHash(targetDocument) !== candidate.targetDocument.baseContentHash
      || targetDocument.approvedRevisionId !== candidate.targetDocument.baseApprovedRevisionId) {
      return this.buildRejectedReceipt(
        candidate,
        "目标 document 在正式库的状态与 candidate.targetDocument 不一致（基线已变化）",
      );
    }

    // 4.2 过滤出作者接受的 facts / skills / bindings
    const acceptedFactIds = new Set(decision.acceptedFactIds);
    const acceptedSkillIds = new Set(decision.acceptedSkillIds);
    const acceptedBindingKeys = new Set(decision.acceptedBindingKeys);
    const acceptedFacts = candidate.acceptedFacts.filter((fact) => acceptedFactIds.has(fact.sourceCandidateId));
    const acceptedSkills = candidate.iteratedSkills.filter((skill) => acceptedSkillIds.has(skill.skillId));
    const acceptedBindings = candidate.iteratedBindings.filter((binding) => acceptedBindingKeys.has(binding.skillId));

    // 5. 执行原子事务
    try {
      const result = await db.transaction(
        "rw",
        db.tables,
        async () => {
          // 5.1 二次读取，校验基线未变（事务内乐观锁）
          const latestDocument = await db.documents.get(candidate.targetDocument.documentId);
          if (!latestDocument) throw new Error("目标 document 在事务中消失");
          if (latestDocument.revision !== candidate.targetDocument.baseRevision
            || documentContentHash(latestDocument) !== candidate.targetDocument.baseContentHash) {
            throw new Error(`目标 document 在事务内被修改：expected revision=${candidate.targetDocument.baseRevision} actual=${latestDocument.revision}`);
          }

          // 5.2 supersede 旧 approvedRevision
          const supersededRevisionId = latestDocument.approvedRevisionId;
          if (supersededRevisionId) {
            await db.revisions.update(supersededRevisionId, {
              approvalStatus: "superseded",
              updatedAt: now,
              updatedBy: ACTOR_ID_FOR_PROMOTION,
            });
            await invalidateRevisionDependentsInCurrentTransaction(
              db,
              projectId,
              [supersededRevisionId],
              "来源正文修订已被候选晋升取代",
            );
          }

          // 5.3 创建新 approved DocumentRevision
          const revisionBase = recordBase(projectId);
          const newRevision: DocumentRevision = {
            ...revisionBase,
            documentId: latestDocument.id,
            label: `候选包晋升 ${candidate.id.slice(0, 8)}`,
            contentHtml: candidate.manuscript.contentHtml,
            plainText: candidate.manuscript.plainText,
            source: "ai",
            parentRevisionId: supersededRevisionId,
            branch: latestDocument.branch,
            approvalStatus: "approved",
            approvedAt: now,
            contentHash: documentContentHash({
              contentHtml: candidate.manuscript.contentHtml,
              plainText: candidate.manuscript.plainText,
            }),
          };
          await db.revisions.add(newRevision);

          // 5.4 更新 ManuscriptDocument
          //    status 强制为 "final"：晋升意味着候选稿件已通过作者审批并成为正式库的
          //    新 approved revision，章节状态必须从 "draft" 前进到 "final"。
          //    Loop 8 因 chapter1 原本就是 "final" 未暴露此问题；Loop 9 的 chapter2
          //    原始为 "draft"，暴露了 promote 未更新 status 的缺陷。
          const updatedDocument: ManuscriptDocument = {
            ...latestDocument,
            contentHtml: candidate.manuscript.contentHtml,
            plainText: candidate.manuscript.plainText,
            title: candidate.manuscript.title,
            summary: candidate.manuscript.summary,
            wordCount: candidate.manuscript.wordCount,
            status: "final",
            approvedRevisionId: newRevision.id,
            revision: latestDocument.revision + 1,
            updatedAt: now,
            updatedBy: ACTOR_ID_FOR_PROMOTION,
          };
          await db.documents.put(updatedDocument);

          // 5.5 通过正式事实提交路径重放领域投影、认知与审计。
          for (const fact of acceptedFacts) {
            const factBase = recordBase(projectId);
            const input = fact.projectionInput;
            if (input.targetId) {
              const projectionTarget = await db.table(input.targetTable).get(input.targetId) as Record<string, unknown> | undefined;
              if (!projectionTarget || projectionTarget.projectId !== projectId) {
                throw new Error(`事实投影目标不存在或不属于当前项目：${input.targetTable}.${input.targetId}`);
              }
              const currentValue = readFactField(projectionTarget, input.field);
              if (!factProjectionValuesEqual(currentValue, input.before)) {
                throw new Error(`事实投影目标已变化，需要重新评估：${input.targetTable}.${input.targetId}.${input.field}`);
              }
            }
            const replayCandidate: FactCandidate = {
              ...factBase,
              id: fact.sourceCandidateId,
              workflowRunId: candidate.manuscript.sourceWorkflowRunId ?? `promotion:${candidate.id}`,
              sourceArtifactId: `candidate:${candidate.id}`,
              sourceRevisionId: newRevision.id,
              targetTable: input.targetTable,
              targetId: input.targetId,
              field: input.field,
              subject: fact.payload.subject,
              predicate: fact.payload.predicate,
              object: fact.payload.object,
              polarity: fact.payload.polarity,
              truthStatus: fact.payload.truthStatus,
              timeMode: fact.payload.timeMode,
              validFrom: fact.payload.validFrom,
              validTo: fact.payload.validTo,
              revealedAt: fact.payload.revealedAt,
              humanReadable: fact.payload.humanReadable,
              knowledgeDeltas: input.knowledgeDeltas,
              before: input.before,
              after: input.after,
              evidence: fact.payload.evidence,
              paragraph: fact.payload.paragraph,
              confidence: fact.payload.confidence,
              novelty: input.novelty,
              conflict: false,
              risk: "safe",
              riskReason: input.riskReason,
              status: "accepted",
              decisionSource: "author",
              decidedAt: decision.decidedAt,
            };
            await db.factCandidates.add(replayCandidate);
          }
          await commitAcceptedFacts(projectId, candidate.manuscript.sourceWorkflowRunId ?? `promotion:${candidate.id}`, db);
          const committedCandidates = acceptedFacts.length
            ? await db.factCandidates.bulkGet(acceptedFacts.map((fact) => fact.sourceCandidateId))
            : [];
          const createdFactAssertionIds = committedCandidates
            .map((fact) => fact?.committedAssertionId)
            .filter((id): id is string => Boolean(id));
          if (createdFactAssertionIds.length !== acceptedFacts.length) {
            throw new Error(`事实投影未完整提交：expected=${acceptedFacts.length} actual=${createdFactAssertionIds.length}`);
          }

          // 5.6 创建与正式 revision 绑定的章节记忆和故事状态快照。
          const chapterMemory = await createChapterMemory({
            projectId,
            documentId: updatedDocument.id,
            sourceRevisionId: newRevision.id,
            summary: candidate.manuscript.summary,
            content: {
              factAssertionIds: createdFactAssertionIds,
              stateChanges: acceptedFacts
                .filter((fact) => fact.projectionInput.targetTable === "entities")
                .map((fact) => fact.payload.humanReadable),
              knowledgeChanges: acceptedFacts.flatMap((fact) => (fact.projectionInput.knowledgeDeltas ?? [])
                .map((delta) => `${delta.characterId}：${delta.stance} · ${fact.payload.humanReadable}`)),
              relationshipChanges: acceptedFacts
                .filter((fact) => fact.projectionInput.targetTable === "relations")
                .map((fact) => fact.payload.humanReadable),
              threadProgress: acceptedFacts
                .filter((fact) => fact.projectionInput.targetTable === "plotThreads")
                .map((fact) => fact.payload.humanReadable),
              foreshadowingProgress: acceptedFacts
                .filter((fact) => fact.projectionInput.targetTable === "foreshadowing")
                .map((fact) => fact.payload.humanReadable),
            },
          }, db);
          const storySnapshot = await createWorkflowSnapshot({
            projectId,
            documentId: updatedDocument.id,
            label: `${updatedDocument.title}完成`,
            summary: candidate.manuscript.summary,
          }, db);

          // 5.7 更新 NovelSkillManifest.prompt（仅 accepted skills）
          for (const iterated of acceptedSkills) {
            const stored = await db.skills
              .where("skillId")
              .equals(iterated.skillId)
              .filter((skill) => skill.projectId === projectId || skill.projectId === "__user__")
              .toArray();
            const projectSkill = stored.find((skill) => skill.projectId === projectId);
            const userSkill = stored.find((skill) => skill.projectId === "__user__");
            const builtinSkill = BUILTIN_NOVEL_SKILLS.find((skill) => skill.skillId === iterated.skillId);
            const effective = projectSkill ?? userSkill ?? builtinSkill;
            if (!effective) throw new Error(`无法晋升未知 skill：${iterated.skillId}`);
            if (effective.prompt !== iterated.beforePrompt) throw new Error(`skill 已变化，需要重新评估：${iterated.skillId}`);
            const updated: NovelSkillManifest = {
              ...effective,
              ...(projectSkill ?? recordBase(projectId)),
              projectId,
              source: "project",
              readonly: false,
              prompt: iterated.afterPrompt,
              revision: (projectSkill?.revision ?? 0) + 1,
              updatedAt: now,
              updatedBy: ACTOR_ID_FOR_PROMOTION,
            };
            await db.skills.put(updated);
          }

          // 5.8 更新 ProjectSkillBinding（仅 accepted bindings）
          for (const iterated of acceptedBindings) {
            const existing = await db.projectSkills
              .where("[projectId+skillId]")
              .equals([projectId, iterated.skillId])
              .first();
            const current = existing ? { enabled: existing.enabled, priorityOverride: existing.priorityOverride } : null;
            if (JSON.stringify(current) !== JSON.stringify(iterated.before)) {
              throw new Error(`skill binding 已变化，需要重新评估：${iterated.skillId}`);
            }
            const binding: ProjectSkillBinding = {
              ...(existing ?? recordBase(projectId)),
              projectId,
              skillId: iterated.skillId,
              enabled: iterated.after.enabled,
              priorityOverride: iterated.after.priorityOverride,
              config: existing?.config ?? {},
              revision: (existing?.revision ?? 0) + 1,
              updatedAt: now,
              updatedBy: ACTOR_ID_FOR_PROMOTION,
            };
            await db.projectSkills.put(binding);
          }

          // 5.9 写入 ChangeOperation（章节正文变更审计）
          const operationBase = recordBase(projectId);
          const operationId = `promote:${candidate.id}`;
          const changeOperation = {
            ...operationBase,
            operationId,
            deviceId: "promotion-service",
            actorId: decision.authorId,
            logicalClock: now,
            entityTable: "documents",
            entityId: latestDocument.id,
            action: "update" as const,
            fieldChanges: {
              contentHtml: { before: latestDocument.contentHtml, after: candidate.manuscript.contentHtml },
              plainText: { before: latestDocument.plainText, after: candidate.manuscript.plainText },
              summary: { before: latestDocument.summary, after: candidate.manuscript.summary },
              wordCount: { before: latestDocument.wordCount, after: candidate.manuscript.wordCount },
              approvedRevisionId: { before: supersededRevisionId ?? null, after: newRevision.id },
              revision: { before: latestDocument.revision, after: updatedDocument.revision },
            },
            syncStatus: "local" as const,
            idempotencyKey: operationId,
          };
          await db.operations.add(changeOperation);

          // 5.10 写入 OperationReceipt（幂等键）
          const receipt: OperationReceipt = {
            id: receiptId,
            projectId,
            operationId,
            candidateId: candidate.id,
            action: "promote-candidate",
            status: "completed",
            createdAt: now,
            completedAt: now,
            receipts: {
              revisionId: newRevision.id,
              factAssertionIds: createdFactAssertionIds,
              memoryIds: [chapterMemory.id],
              snapshotId: storySnapshot.id,
              operationIds: [changeOperation.id],
            },
          };
          await db.operationReceipts.put(receipt);

          return {
            revisionId: newRevision.id,
            factAssertionIds: createdFactAssertionIds,
            memoryIds: [chapterMemory.id],
            snapshotId: storySnapshot.id,
            operationIds: [changeOperation.id],
            operationId,
            document: updatedDocument,
          };
        },
      );

      await upsertEmbedding({
        projectId,
        targetTable: "documents",
        targetId: result.document.id,
        content: [result.document.title, result.document.summary, result.document.plainText].filter(Boolean).join("\n"),
        db,
      }).catch(() => { /* semantic indexing degrades to keyword retrieval */ });

      return {
        candidateId: candidate.id,
        operationId: result.operationId,
        status: "promoted",
        promotedAt: now,
        createdRevisionId: result.revisionId,
        createdFactAssertionIds: result.factAssertionIds,
        createdMemoryIds: result.memoryIds,
        createdSnapshotId: result.snapshotId,
        createdOperationIds: result.operationIds,
      };
    } catch (error) {
      // 事务已自动回滚，正式库保持原样。写一条 failed receipt 用于审计。
      const errorMessage = (error as Error).message ?? String(error);
      try {
        const failedReceipt: OperationReceipt = {
          id: receiptId,
          projectId,
          operationId,
          candidateId: candidate.id,
          action: "promote-candidate",
          status: "failed",
          createdAt: now,
          completedAt: Date.now(),
          receipts: {
            revisionId: undefined,
            factAssertionIds: [],
            memoryIds: [],
            snapshotId: undefined,
          },
          error: errorMessage,
        };
        await this.db.operationReceipts.put(failedReceipt);
      } catch {
        // 写失败 receipt 也失败时，只把原始错误返回；事务回滚保证正式库未污染
      }
      return {
        candidateId: candidate.id,
        operationId,
        status: "rejected",
        promotedAt: now,
        createdFactAssertionIds: [],
        createdMemoryIds: [],
        createdOperationIds: [],
        error: errorMessage,
      };
    }
  }

  private async buildRejectedReceipt(candidate: CandidateBundle, reason: string): Promise<PromotionReceipt> {
    return {
      candidateId: candidate.id,
      operationId: `promote:${candidate.id}`,
      status: "rejected",
      promotedAt: Date.now(),
      createdFactAssertionIds: [],
      createdMemoryIds: [],
      createdOperationIds: [],
      error: reason,
    };
  }
}

const ACTOR_ID_FOR_PROMOTION = "promotion-service";
