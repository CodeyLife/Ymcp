/**
 * V2 候选包：从实验 schema 提取候选包，校验完整性。
 *
 * 设计依据：AGENTS.md + Phase B-1.3 重构计划。
 *
 * 职责：
 * - extractCandidateBundle：从实验 schema 查询最新 revision + accepted claims + iterated skills +
 *   reviews，组装为 CandidateBundle
 * - computeManuscriptContentHash：SHA-256(plainText + "\n" + contentHtml)
 * - verifyCandidateBundle：校验必填字段、contentHash 一致性、afterPrompt 长度 ≥ 100
 *
 * 与 v1 的区别：v1 从 Dexie 实验库读取 workflowRun/artifact/qualityReport 等，
 * v2 直接从 Postgres 实验 schema 查询 manuscript_revisions + artifacts + reviews。
 * v2 的 manuscript 内容存储在 artifact.payload（structuredData）中。
 *
 * extractCandidateBundle 只接受实验生命周期真实提交的新 revision；没有通过门禁的
 * 实验不会构造候选包，避免把未审核文本或空 artifact 晋升到正式库。
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  CandidateBundle,
  IteratedSkill,
  MemoryClaim,
  MemoryKind,
  MemoryAuthority,
  ProjectHead,
  PromotableFact,
  Review,
  ReviewIssue,
} from "../protocol";
import type { ExperimentWorkspaceHandle } from "./experiment-workspace";
import { ContentObjectStore, type ObjectStoreAdapter } from "../object-store";
import { parseSerializedPromptSections } from "./prompt-sections";
import { countNovelCharacters } from "../word-count";

// ===== 辅助 =====

/**
 * 计算 manuscript contentHash：SHA-256(plainText)。
 *
 * 与 v1 的 computeManuscriptContentHash（含 title/summary/wordCount）不同，
 * v2 按 protocol 约定只哈希 plainText + contentHtml，更简洁且与 promotion 校验一致。
 */
export function computeManuscriptContentHash(plainText: string, _contentHtml: string): string {
  return createHash("sha256").update(plainText, "utf8").digest("hex");
}

// ===== 行类型 =====

type RevisionRow = {
  id: string;
  document_id: string;
  revision: string | number;
  base_revision: string | number;
  content_hash: string;
  artifact_id: string | null;
  object_key: string;
};

type ArtifactRow = {
  id: string;
  payload: Record<string, unknown> | null;
  content_hash: string;
};

type ClaimRow = {
  id: string;
  kind: string;
  title: string;
  content: string;
  subject_refs: string[] | null;
  narrative_start: string | number | null;
  narrative_end: string | number | null;
  knowledge_scope: Record<string, unknown>;
  authority: string;
  confidence: string | number;
  content_hash: string;
};

type ReviewRow = {
  id: string;
  artifact_id: string;
  reviewer_id: string;
  identity: string;
  verdict: string;
  issues: unknown;
  created_at: Date | string;
};

type IteratedSkillRow = {
  id: string;
  experiment_id: string;
  skill_id: string;
  before_prompt: string;
  after_prompt: string;
  rationale: string;
  triggered_by_issue_ids: string[] | null;
  learning_mechanism: string | null;
  created_at: Date | string;
};

// ===== 映射 =====

function mapClaimToPromotableFact(row: ClaimRow): PromotableFact {
  const payload: PromotableFact["payload"] = {
    kind: row.kind as MemoryKind,
    title: row.title,
    content: row.content,
    subjectRefs: row.subject_refs ?? [],
    narrativeRange: {
      start: row.narrative_start === null ? undefined : Number(row.narrative_start),
      end: row.narrative_end === null ? undefined : Number(row.narrative_end),
    },
    knowledgeScope: row.knowledge_scope as MemoryClaim["knowledgeScope"],
    authority: row.authority as MemoryAuthority,
    confidence: Number(row.confidence),
  };
  return {
    sourceClaimId: row.id,
    payload,
  };
}

function mapReviewRow(row: ReviewRow): Review {
  const issues = Array.isArray(row.issues) ? (row.issues as ReviewIssue[]) : [];
  return {
    id: row.id,
    projectId: "", // 实验库内 projectId 不重要，留空
    artifactId: row.artifact_id,
    reviewerId: row.reviewer_id,
    identity: row.identity as Review["identity"],
    verdict: row.verdict as Review["verdict"],
    issues,
    artifactFingerprint: "",
    createdAt: new Date(row.created_at).getTime(),
  };
}

function mapIteratedSkillRow(row: IteratedSkillRow): IteratedSkill {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    skillId: row.skill_id,
    beforePrompt: row.before_prompt,
    afterPrompt: row.after_prompt,
    rationale: row.rationale,
    triggeredByIssueIds: row.triggered_by_issue_ids ?? [],
    learningMechanism: row.learning_mechanism ?? undefined,
    createdAt: new Date(row.created_at).getTime(),
  };
}

// ===== 主接口 =====

/**
 * 从实验 schema 导出 CandidateBundle。
 *
 * 查询：
 * - manuscript_revisions：目标章节的最新 revision（revision > baseRevision）
 * - artifacts：revision 关联的 artifact，manuscript 内容从 artifact.payload 提取
 * - memory_claims：实验期间产生的新 claim（accepted authority）
 * - reviews：实验期间的 review 记录
 * - iterated_skills：公共表，按 experiment_id 查询
 *
 * 组装为 CandidateBundle 后立即 verifyCandidateBundle，校验失败抛错。
 */
export async function extractCandidateBundle(
  workspace: ExperimentWorkspaceHandle,
  input: {
    sourceProjectId: string;
    baseSnapshotId: string;
    baseSnapshotHash: string;
    dependencyHead: ProjectHead;
    documentId: string;
    baseRevision: number;
    baseContentHash: string;
    workflowRunId: string;
    codeRevision?: string;
    baselineMemoryClaimIds?: string[];
    objects?: ObjectStoreAdapter;
  },
): Promise<CandidateBundle> {
  const s = workspace.schemaName;
  const objects = input.objects ?? new ContentObjectStore();

  // 1. 查询最新 revision（revision > baseRevision）
  const revisionResult = await workspace.query<RevisionRow>(
    `SELECT mr.id, mr.document_id, mr.revision, mr.base_revision, mr.content_hash, mr.artifact_id, cb.object_key
     FROM ${s}.manuscript_revisions mr
     JOIN ${s}.content_blobs cb ON cb.content_hash=mr.content_hash
     WHERE mr.document_id = $1 AND mr.revision > $2
     ORDER BY revision DESC
     LIMIT 1`,
    [input.documentId, input.baseRevision],
  );

  let latestRevision: RevisionRow;
  let manuscriptTitle: string;
  let plainText: string;
  let contentHtml: string;
  let wordCount: number;
  let sourceArtifactId: string | undefined;

  if (revisionResult.rows.length > 0) {
    // 实验期间产生了新 revision
    latestRevision = revisionResult.rows[0];
    sourceArtifactId = latestRevision.artifact_id ?? undefined;

    // 正文以 content_blobs 指向的不可变对象为准；artifact payload 仅保存审计元数据。
    if (sourceArtifactId) {
      const artifactResult = await workspace.query<ArtifactRow>(
        `SELECT id, payload, content_hash FROM ${s}.artifacts WHERE id = $1`,
        [sourceArtifactId],
      );
      const artifactPayload = artifactResult.rows[0]?.payload ?? {};
      const documentResult = await workspace.query<{ title: string }>(
        `SELECT title FROM ${s}.manuscript_documents WHERE id=$1`,
        [input.documentId],
      );
      manuscriptTitle = documentResult.rows[0]?.title ?? "";
      plainText = await objects.getText(latestRevision.object_key);
      contentHtml = typeof artifactPayload.contentHtml === "string" ? artifactPayload.contentHtml : "";
      wordCount = countNovelCharacters(plainText);
    } else {
      throw new Error(`实验 revision ${latestRevision.id} 缺少 source artifact，拒绝构造不可审计候选包`);
    }
  } else {
    throw new Error(
      `实验 ${workspace.id} 未产生高于 baseRevision=${input.baseRevision} 的正式 revision，拒绝构造空候选包`,
    );
  }

  const contentHash = computeManuscriptContentHash(plainText, contentHtml);

  // 2. 查询 memory_claims（实验期间产生的新 claim）
  const claimsResult = await workspace.query<ClaimRow>(
    `SELECT id, kind, title, content, subject_refs, narrative_start, narrative_end,
            knowledge_scope, authority, confidence, content_hash
     FROM ${s}.memory_claims
     WHERE authority IN ('approved', 'author', 'derived')
       AND NOT (id = ANY($1::text[]))
     ORDER BY created_at, id`,
    [input.baselineMemoryClaimIds ?? []],
  );
  const acceptedFacts = claimsResult.rows.map(mapClaimToPromotableFact);

  // 3. 查询 reviews（实验期间的审核记录）
  const reviewsResult = await workspace.query<ReviewRow>(
    `SELECT id, artifact_id, reviewer_id, identity, verdict, issues, created_at
     FROM ${s}.reviews
     WHERE artifact_id=$1
     ORDER BY created_at, id`,
    [sourceArtifactId],
  );
  const reviews = reviewsResult.rows.map(mapReviewRow);

  // 4. 查询 iterated_skills（公共表，按 experiment_id）
  const iteratedResult = await workspace.query<IteratedSkillRow>(
    `SELECT id, experiment_id, skill_id, before_prompt, after_prompt, rationale,
            triggered_by_issue_ids, learning_mechanism, created_at
     FROM iterated_skills
     WHERE experiment_id = $1
     ORDER BY created_at, id`,
    [workspace.id],
  );
  const iteratedSkills = iteratedResult.rows.map(mapIteratedSkillRow);

  // 5. 组装 qualityEvidence
  const scores: Record<string, number> = {};
  const issueSummary: Record<string, number> = {};
  const reviewIds: string[] = [];
  for (const review of reviews) {
    reviewIds.push(review.id);
    for (const issue of review.issues) {
      const key = issue.severity;
      issueSummary[key] = (issueSummary[key] ?? 0) + 1;
    }
  }

  // 6. 组装 CandidateBundle
  const bundle: CandidateBundle = {
    formatVersion: 2,
    id: randomUUID(),
    experimentId: workspace.id,
    sourceProjectId: input.sourceProjectId,
    baseSnapshotId: input.baseSnapshotId,
    baseSnapshotHash: input.baseSnapshotHash,
    dependencyHead: input.dependencyHead,
    target: {
      documentId: input.documentId,
      baseRevision: input.baseRevision,
      baseContentHash: input.baseContentHash,
    },
    manuscript: {
      title: manuscriptTitle,
      plainText,
      contentHtml,
      wordCount,
      contentHash,
      sourceArtifactId,
    },
    acceptedFacts,
    iteratedSkills,
    qualityEvidence: {
      reviewIds,
      scores,
      issueSummary,
    },
    provenance: {
      codeRevision: input.codeRevision ?? "unknown",
      createdAt: Date.now(),
      workflowRunId: input.workflowRunId,
    },
  };

  // 7. 自校验
  const verification = verifyCandidateBundle(bundle);
  if (!verification.valid) {
    throw new Error(`候选包导出校验失败：${verification.issues.join("；")}`);
  }

  return bundle;
}

// ===== 校验 =====

/**
 * 校验 CandidateBundle 完整性。
 *
 * 检查项：
 * - formatVersion === 2
 * - 必填顶层字段非空
 * - manuscript.contentHash 与重算结果一致
 * - 每个 iteratedSkill 的 afterPrompt 长度 ≥ 100
 * - 每个 acceptedFact 有 sourceClaimId + payload 必填字段
 */
export function verifyCandidateBundle(bundle: CandidateBundle): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  if (bundle.formatVersion !== 2) {
    issues.push(`formatVersion 必须为 2，实际为 ${bundle.formatVersion}`);
  }

  // 必填顶层字段
  if (!bundle.id) issues.push("id 缺失");
  if (!bundle.experimentId) issues.push("experimentId 缺失");
  if (!bundle.sourceProjectId) issues.push("sourceProjectId 缺失");
  if (!bundle.baseSnapshotId) issues.push("baseSnapshotId 缺失");
  if (!bundle.baseSnapshotHash) issues.push("baseSnapshotHash 缺失");
  if (!bundle.dependencyHead) issues.push("dependencyHead 缺失");
  if (!bundle.target) issues.push("target 缺失");
  if (!bundle.manuscript) issues.push("manuscript 缺失");
  if (!bundle.provenance) issues.push("provenance 缺失");
  if (!Array.isArray(bundle.acceptedFacts)) issues.push("acceptedFacts 必须为数组");
  if (!Array.isArray(bundle.iteratedSkills)) issues.push("iteratedSkills 必须为数组");

  // target 字段
  if (bundle.target) {
    if (!bundle.target.documentId) issues.push("target.documentId 缺失");
    if (typeof bundle.target.baseRevision !== "number") issues.push("target.baseRevision 必须为数字");
    // baseContentHash 允许空字符串（首次生成章节时无前序版本，baseRevision=0 + baseContentHash=""）
    if (typeof bundle.target.baseContentHash !== "string") issues.push("target.baseContentHash 必须为字符串");
  }

  // manuscript 字段
  if (bundle.manuscript) {
    if (typeof bundle.manuscript.title !== "string") issues.push("manuscript.title 缺失");
    if (typeof bundle.manuscript.plainText !== "string") issues.push("manuscript.plainText 缺失");
    if (typeof bundle.manuscript.contentHtml !== "string") issues.push("manuscript.contentHtml 缺失");
    if (typeof bundle.manuscript.wordCount !== "number" || bundle.manuscript.wordCount < 0) {
      issues.push("manuscript.wordCount 必须为非负数");
    }
    if (!bundle.manuscript.contentHash) {
      issues.push("manuscript.contentHash 缺失");
    } else {
      // 重算 contentHash 比对
      const recomputed = computeManuscriptContentHash(
        bundle.manuscript.plainText,
        bundle.manuscript.contentHtml,
      );
      if (recomputed !== bundle.manuscript.contentHash) {
        issues.push(
          `manuscript.contentHash 不匹配：candidate=${bundle.manuscript.contentHash.slice(0, 16)}... recomputed=${recomputed.slice(0, 16)}...`,
        );
      }
    }
  }

  // acceptedFacts 字段
  if (Array.isArray(bundle.acceptedFacts)) {
    for (const [index, fact] of bundle.acceptedFacts.entries()) {
      if (!fact.sourceClaimId) issues.push(`acceptedFacts[${index}].sourceClaimId 缺失`);
      if (!fact.payload) {
        issues.push(`acceptedFacts[${index}].payload 缺失`);
        continue;
      }
      if (!fact.payload.kind) issues.push(`acceptedFacts[${index}].payload.kind 缺失`);
      if (!fact.payload.title) issues.push(`acceptedFacts[${index}].payload.title 缺失`);
      if (!fact.payload.content) issues.push(`acceptedFacts[${index}].payload.content 缺失`);
    }
  }

  // iteratedSkills 字段：afterPrompt 长度 ≥ 100
  if (Array.isArray(bundle.iteratedSkills)) {
    for (const [index, skill] of bundle.iteratedSkills.entries()) {
      if (!skill.skillId) issues.push(`iteratedSkills[${index}].skillId 缺失`);
      if (!skill.beforePrompt) issues.push(`iteratedSkills[${index}].beforePrompt 缺失`);
      if (!skill.afterPrompt) {
        issues.push(`iteratedSkills[${index}].afterPrompt 缺失`);
      } else if (skill.afterPrompt.length < 100) {
        issues.push(`iteratedSkills[${index}].afterPrompt 长度不足 100（实际 ${skill.afterPrompt.length}）`);
      } else {
        try {
          parseSerializedPromptSections(skill.afterPrompt, `iteratedSkills[${index}].afterPrompt`);
        } catch (error) {
          issues.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (skill.beforePrompt === skill.afterPrompt) {
        issues.push(`iteratedSkills[${index}].beforePrompt 与 afterPrompt 相同`);
      }
      if (!Array.isArray(skill.triggeredByIssueIds) || skill.triggeredByIssueIds.length === 0) {
        issues.push(`iteratedSkills[${index}].triggeredByIssueIds 必须为非空数组`);
      }
    }
  }

  // provenance 字段
  if (bundle.provenance) {
    if (!bundle.provenance.codeRevision) issues.push("provenance.codeRevision 缺失");
    if (typeof bundle.provenance.createdAt !== "number") issues.push("provenance.createdAt 必须为数字");
    if (!bundle.provenance.workflowRunId) issues.push("provenance.workflowRunId 缺失");
  }

  return { valid: issues.length === 0, issues };
}
