/**
 * V2 晋升服务：把 CandidateBundle 原子地写回正式库。
 *
 * 设计依据：AGENTS.md + Phase B-1.3 重构计划。
 *
 * 职责：
 * - promote：幂等检查 → 依赖头校验 → contentHash 校验 → 单事务写入 → receipt
 * - rollback：根据 receipt.result 反向恢复
 * - getReceipt：查询幂等 receipt
 *
 * 与 v1 的区别：v1 用 Dexie 事务，v2 用 Postgres 单事务（BEGIN/COMMIT/ROLLBACK）。
 *
 * 原子性：promote 在单个 Postgres 事务内完成所有写入；任一步骤抛错则整个事务回滚。
 * 幂等性：以 `promote:<candidateId>` 作为 receipt id，同一 candidateId 重复 promote 返回同一 receipt。
 *
 * 失败模式：
 * - stale-baseline：dependencyHead 不一致
 * - content-hash-mismatch：manuscript.contentHash 与重算结果不一致
 * - 事务失败：写 failed receipt
 *
 * promote 负责原子写回与可回滚 receipt；promote 后的正式快照回归由 closed-loop
 * 编排器强制执行，失败时调用 rollback 恢复正文、事实和 skill prompt。
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  AuthorDecision,
  CandidateBundle,
  MemoryClaim,
  MemoryKind,
  MemoryAuthority,
  PromotionReceipt,
} from "../protocol";
import type { NovelPostgresRepository } from "../postgres-repository";
import { ContentObjectStore, type ObjectStoreAdapter } from "../object-store";
import { computeProjectHead } from "./project-snapshot";
import { computeManuscriptContentHash, verifyCandidateBundle } from "./candidate-bundle";
import { parseSerializedPromptSections } from "./prompt-sections";

// ===== 类型 =====

export interface PromotionService {
  promote(candidate: CandidateBundle, decision: AuthorDecision): Promise<PromotionReceipt>;
  rollback(receiptId: string): Promise<void>;
  getReceipt(candidateId: string): Promise<PromotionReceipt | null>;
}

// ===== 辅助 =====

function headsEqual(left: { projectRevision: number; finalDocumentHashes: string[] }, right: { projectRevision: number; finalDocumentHashes: string[] }): boolean {
  if (left.projectRevision !== right.projectRevision) return false;
  if (left.finalDocumentHashes.length !== right.finalDocumentHashes.length) return false;
  for (let i = 0; i < left.finalDocumentHashes.length; i += 1) {
    if (left.finalDocumentHashes[i] !== right.finalDocumentHashes[i]) return false;
  }
  return true;
}

type ReceiptRow = {
  id: string;
  candidate_id: string;
  project_id: string;
  status: string;
  result: Record<string, unknown>;
  failure_reason: string | null;
  created_at: Date | string;
};

function mapReceiptRow(row: ReceiptRow): PromotionReceipt {
  const result = row.result ?? {};
  return {
    id: row.id,
    candidateId: row.candidate_id,
    projectId: row.project_id,
    status: row.status as PromotionReceipt["status"],
    result: {
      revisionId: typeof result.revisionId === "string" ? result.revisionId : undefined,
      skillUpdates: Array.isArray(result.skillUpdates) ? (result.skillUpdates as string[]) : undefined,
      factIds: Array.isArray(result.factIds) ? (result.factIds as string[]) : undefined,
    },
    failureReason: row.failure_reason ?? undefined,
    createdAt: new Date(row.created_at).getTime(),
  };
}

// ===== 实现 =====

class PromotionServiceImpl implements PromotionService {
  constructor(
    private readonly repository: NovelPostgresRepository,
    private readonly objects: ObjectStoreAdapter = new ContentObjectStore(),
  ) {}

  async getReceipt(candidateId: string): Promise<PromotionReceipt | null> {
    const result = await this.repository.pool.query<ReceiptRow>(
      "SELECT id, candidate_id, project_id, status, result, failure_reason, created_at FROM promotion_receipts WHERE candidate_id = $1",
      [candidateId],
    );
    if (!result.rowCount) return null;
    return mapReceiptRow(result.rows[0]);
  }

  async promote(candidate: CandidateBundle, decision: AuthorDecision): Promise<PromotionReceipt> {
    // 1. 决策基础校验
    if (decision.decision !== "accept") {
      return this.writeFailedReceipt(candidate, `AuthorDecision.decision 必须为 accept，实际为 ${decision.decision}`);
    }
    if (!decision.authorId) {
      return this.writeFailedReceipt(candidate, "AuthorDecision.authorId 缺失");
    }

    // 2. 幂等检查
    const existing = await this.getReceipt(candidate.id);
    if (existing && existing.status === "promoted") {
      return existing;
    }

    // 3. CandidateBundle 自身完整性
    const verification = verifyCandidateBundle(candidate);
    if (!verification.valid) {
      return this.writeFailedReceipt(candidate, `deterministic-blocker：${verification.issues.join("；")}`);
    }

    // 4. contentHash 校验（传输篡改检测）
    const recomputedContentHash = computeManuscriptContentHash(
      candidate.manuscript.plainText,
      candidate.manuscript.contentHtml,
    );
    if (recomputedContentHash !== candidate.manuscript.contentHash) {
      return this.writeFailedReceipt(candidate, "content-hash-mismatch：manuscript.contentHash 与重算结果不一致");
    }

    // 5. 依赖头校验（基线漂移检测）
    let currentHead;
    try {
      currentHead = await computeProjectHead(this.repository, candidate.sourceProjectId);
    } catch (error) {
      return this.writeFailedReceipt(candidate, `无法重算 dependencyHead：${(error as Error).message}`);
    }
    if (!headsEqual(currentHead, candidate.dependencyHead)) {
      return this.writeFailedReceipt(candidate, "stale-baseline：正式库 dependencyHead 已变化，候选包基于过时基线");
    }

    // 6. 执行原子事务
    const receiptId = `promote:${candidate.id}`;
    const now = Date.now();
    const newRevisionId = randomUUID();
    const newArtifactId = randomUUID();
    const newRevision = candidate.target.baseRevision + 1;
    const object = await this.objects.putText(candidate.manuscript.plainText);
    if (object.hash !== candidate.manuscript.contentHash) {
      return this.writeFailedReceipt(candidate, "content-hash-mismatch：对象存储正文 hash 与候选包不一致");
    }

    const client = await this.repository.pool.connect();
    try {
      await client.query("BEGIN");

      // 6.1 写 candidate_bundles（供 rollback 读取）
      await client.query(
        "INSERT INTO candidate_bundles(id, experiment_id, project_id, payload, fingerprint, created_at) VALUES($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0)) ON CONFLICT(id) DO NOTHING",
        [
          candidate.id,
          candidate.experimentId,
          candidate.sourceProjectId,
          JSON.stringify(candidate),
          candidate.manuscript.contentHash,
          now,
        ],
      );

      // 6.2 INSERT content_blobs
      await client.query(
        "INSERT INTO content_blobs(content_hash, object_key, byte_length) VALUES($1, $2, $3) ON CONFLICT(content_hash) DO NOTHING",
        [candidate.manuscript.contentHash, object.key, object.bytes],
      );

      // 6.3 INSERT artifacts
      await client.query(
        "INSERT INTO artifacts(id, project_id, task_id, attempt_id, kind, content_hash, object_key, base_revision, fingerprint, payload, created_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11 / 1000.0)) ON CONFLICT(id) DO NOTHING",
        [
          newArtifactId,
          candidate.sourceProjectId,
          `promote:${candidate.id}`,
          `promote:${candidate.id}`,
          "revision",
          candidate.manuscript.contentHash,
          object.key,
          candidate.target.baseRevision,
          candidate.manuscript.contentHash,
          JSON.stringify({
            title: candidate.manuscript.title,
            plainText: candidate.manuscript.plainText,
            contentHtml: candidate.manuscript.contentHtml,
            wordCount: candidate.manuscript.wordCount,
            sourceArtifactId: candidate.manuscript.sourceArtifactId,
            promotedFrom: candidate.id,
          }),
          now,
        ],
      );

      // 6.4 INSERT manuscript_revisions
      await client.query(
        "INSERT INTO manuscript_revisions(id, project_id, document_id, revision, base_revision, content_hash, artifact_id) VALUES($1, $2, $3, $4, $5, $6, $7)",
        [
          newRevisionId,
          candidate.sourceProjectId,
          candidate.target.documentId,
          newRevision,
          candidate.target.baseRevision,
          candidate.manuscript.contentHash,
          newArtifactId,
        ],
      );

      // 6.5 UPDATE manuscript_documents
      await client.query(
        "UPDATE manuscript_documents SET current_revision_id = $1, status = 'final', updated_at = now() WHERE id = $2 AND project_id = $3",
        [newRevisionId, candidate.target.documentId, candidate.sourceProjectId],
      );

      // 6.6 UPDATE novel_projects
      await client.query(
        "UPDATE novel_projects SET current_revision = $1, updated_at = now() WHERE id = $2",
        [newRevision, candidate.sourceProjectId],
      );

      // 6.7 INSERT memory_claims（去重，用 content_hash）
      const createdFactIds: string[] = [];
      for (const fact of candidate.acceptedFacts) {
        const claimId = randomUUID();
        const contentHash = createHash("sha256").update(JSON.stringify(fact.payload), "utf8").digest("hex");
        const dedup = await client.query<{ id: string }>(
          "SELECT id FROM memory_claims WHERE project_id = $1 AND content_hash = $2 LIMIT 1",
          [candidate.sourceProjectId, contentHash],
        );
        if (dedup.rowCount) continue;

        const claim: MemoryClaim = {
          id: claimId,
          projectId: candidate.sourceProjectId,
          kind: fact.payload.kind as MemoryKind,
          title: fact.payload.title,
          content: fact.payload.content,
          subjectRefs: fact.payload.subjectRefs,
          narrativeRange: fact.payload.narrativeRange,
          knowledgeScope: fact.payload.knowledgeScope,
          authority: fact.payload.authority as MemoryAuthority,
          confidence: fact.payload.confidence,
          sourceRevisionIds: [newRevisionId],
          contentHash,
          supersedes: [],
        };

        await client.query(
          "INSERT INTO memory_claims(id, project_id, kind, title, content, subject_refs, narrative_start, narrative_end, knowledge_scope, authority, confidence, source_revision_ids, content_hash, supersedes) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT(id) DO NOTHING",
          [
            claim.id,
            claim.projectId,
            claim.kind,
            claim.title,
            claim.content,
            claim.subjectRefs,
            claim.narrativeRange?.start ?? null,
            claim.narrativeRange?.end ?? null,
            JSON.stringify(claim.knowledgeScope),
            claim.authority,
            claim.confidence,
            claim.sourceRevisionIds,
            claim.contentHash,
            claim.supersedes,
          ],
        );
        createdFactIds.push(claimId);
      }

      // 6.8 UPDATE skill_definitions（对每个 iteratedSkill）
      const skillUpdates: string[] = [];
      for (const iterated of candidate.iteratedSkills) {
        const promptSectionsJson = JSON.stringify(
          parseSerializedPromptSections(iterated.afterPrompt, `skill ${iterated.skillId} 的 afterPrompt`),
        );

        await client.query(
          "UPDATE skill_definitions SET prompt_sections = $2::jsonb, updated_at = now() WHERE skill_id = $1",
          [iterated.skillId, promptSectionsJson],
        );
        skillUpdates.push(iterated.skillId);
      }

      // 6.9 INSERT commit_records
      await client.query(
        "INSERT INTO commit_records(id, project_id, revision_id, artifact_fingerprint, base_revision, result) VALUES($1, $2, $3, $4, $5, $6)",
        [
          randomUUID(),
          candidate.sourceProjectId,
          newRevisionId,
          candidate.manuscript.contentHash,
          candidate.target.baseRevision,
          JSON.stringify({
            revisionId: newRevisionId,
            revision: newRevision,
            contentHash: candidate.manuscript.contentHash,
            promotedFrom: candidate.id,
          }),
        ],
      );

      // 6.10 INSERT promotion_receipts（status=promoted）
      const receipt: PromotionReceipt = {
        id: receiptId,
        candidateId: candidate.id,
        projectId: candidate.sourceProjectId,
        status: "promoted",
        result: {
          revisionId: newRevisionId,
          skillUpdates,
          factIds: createdFactIds,
        },
        createdAt: now,
      };

      await client.query(
        "INSERT INTO promotion_receipts(id, candidate_id, project_id, status, result, created_at) VALUES($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0)) ON CONFLICT(candidate_id) DO UPDATE SET status = EXCLUDED.status, result = EXCLUDED.result",
        [
          receipt.id,
          receipt.candidateId,
          receipt.projectId,
          receipt.status,
          JSON.stringify(receipt.result),
          now,
        ],
      );

      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      await client.query("ROLLBACK");
      const errorMessage = (error as Error).message ?? String(error);
      // 写 failed receipt（事务外）
      await this.writeFailedReceipt(candidate, `transaction-failure：${errorMessage}`, receiptId);
      throw error;
    } finally {
      client.release();
    }
  }

  async rollback(receiptId: string): Promise<void> {
    // 1. 读取 receipt
    const receiptResult = await this.repository.pool.query<ReceiptRow>(
      "SELECT id, candidate_id, project_id, status, result, failure_reason, created_at FROM promotion_receipts WHERE id = $1",
      [receiptId],
    );
    if (!receiptResult.rowCount) throw new Error(`receipt 不存在：${receiptId}`);
    const receipt = mapReceiptRow(receiptResult.rows[0]);
    if (receipt.status !== "promoted") {
      throw new Error(`只能 rollback 已 promoted 的 receipt，当前状态：${receipt.status}`);
    }

    // 2. 读取 candidate_bundles 获取回滚所需信息
    const candidateResult = await this.repository.pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM candidate_bundles WHERE id = $1",
      [receipt.candidateId],
    );
    if (!candidateResult.rowCount) throw new Error(`candidate bundle 不存在：${receipt.candidateId}`);
    const candidate = candidateResult.rows[0].payload as unknown as CandidateBundle;

    const revisionId = receipt.result.revisionId;
    const factIds = receipt.result.factIds ?? [];
    const skillUpdates = receipt.result.skillUpdates ?? [];
    const documentId = candidate.target.documentId;
    const baseRevision = candidate.target.baseRevision;

    if (!revisionId) throw new Error("receipt.result.revisionId 缺失，无法 rollback");

    const client = await this.repository.pool.connect();
    try {
      await client.query("BEGIN");

      // 3.1 删除 memory_claims
      for (const factId of factIds) {
        await client.query("DELETE FROM memory_claims WHERE id = $1", [factId]);
      }

      const promotedRevision = await client.query<{ artifact_id: string | null; content_hash: string }>(
        "SELECT artifact_id,content_hash FROM manuscript_revisions WHERE id=$1",
        [revisionId],
      );

      // 3.2 删除 manuscript_revisions 及其晋升 artifact；不可变 blob 仅在无引用时清理。
      await client.query("DELETE FROM manuscript_revisions WHERE id = $1", [revisionId]);
      const promotedArtifactId = promotedRevision.rows[0]?.artifact_id;
      if (promotedArtifactId) await client.query("DELETE FROM artifacts WHERE id=$1", [promotedArtifactId]);
      const promotedHash = promotedRevision.rows[0]?.content_hash;
      if (promotedHash) {
        await client.query(
          "DELETE FROM content_blobs cb WHERE cb.content_hash=$1 AND NOT EXISTS (SELECT 1 FROM manuscript_revisions mr WHERE mr.content_hash=cb.content_hash)",
          [promotedHash],
        );
      }

      // 3.3 恢复 manuscript_documents：指向 baseRevision 的 revision
      const baseRevisionResult = await client.query<{ id: string }>(
        "SELECT id FROM manuscript_revisions WHERE document_id = $1 AND revision = $2 LIMIT 1",
        [documentId, baseRevision],
      );
      if (baseRevisionResult.rowCount) {
        await client.query(
          "UPDATE manuscript_documents SET current_revision_id = $1, status = 'final', updated_at = now() WHERE id = $2 AND project_id = $3",
          [baseRevisionResult.rows[0].id, documentId, receipt.projectId],
        );
      }

      // 3.4 恢复 novel_projects.current_revision
      await client.query(
        "UPDATE novel_projects SET current_revision = $1, updated_at = now() WHERE id = $2",
        [candidate.dependencyHead.projectRevision, receipt.projectId],
      );

      // 3.5 恢复 skill_definitions（从 iterated_skills 的 before_prompt）
      for (const skillId of skillUpdates) {
        const iterated = candidate.iteratedSkills.find((item) => item.skillId === skillId);
        if (iterated) {
          const beforePrompt = iterated.beforePrompt;
          let promptSectionsJson: string;
          try {
            JSON.parse(beforePrompt);
            promptSectionsJson = beforePrompt;
          } catch {
            promptSectionsJson = JSON.stringify({ drafting: beforePrompt });
          }
          await client.query(
            "UPDATE skill_definitions SET prompt_sections = $2::jsonb, updated_at = now() WHERE skill_id = $1",
            [skillId, promptSectionsJson],
          );
        }
      }

      // 3.6 更新 receipt status = rolled-back
      await client.query(
        "UPDATE promotion_receipts SET status = 'rolled-back' WHERE id = $1",
        [receiptId],
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeFailedReceipt(
    candidate: CandidateBundle,
    reason: string,
    explicitId?: string,
  ): Promise<PromotionReceipt> {
    const receiptId = explicitId ?? `promote:${candidate.id}`;
    const now = Date.now();
    const receipt: PromotionReceipt = {
      id: receiptId,
      candidateId: candidate.id,
      projectId: candidate.sourceProjectId,
      status: "failed",
      result: {},
      failureReason: reason,
      createdAt: now,
    };
    try {
      await this.repository.pool.query(
        "INSERT INTO promotion_receipts(id, candidate_id, project_id, status, result, failure_reason, created_at) VALUES($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0)) ON CONFLICT(candidate_id) DO UPDATE SET status = EXCLUDED.status, failure_reason = EXCLUDED.failure_reason",
        [receipt.id, receipt.candidateId, receipt.projectId, receipt.status, JSON.stringify(receipt.result), reason, now],
      );
    } catch {
      // 写 failed receipt 也失败时，只返回内存 receipt
    }
    return receipt;
  }
}

// ===== 工厂 =====

/**
 * 创建晋升服务实例。
 *
 * @param repository 正式库 repository（promote 只写此库）
 */
export function createPromotionService(repository: NovelPostgresRepository, objects?: ObjectStoreAdapter): PromotionService {
  return new PromotionServiceImpl(repository, objects);
}
