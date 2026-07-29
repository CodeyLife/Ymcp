/**
 * V2 项目快照：捕获/校验项目快照，计算 ProjectHead。
 *
 * 设计依据：AGENTS.md + Phase B-1.3 重构计划。
 *
 * 职责：
 * - captureProjectSnapshot：查询正式库 8 张表，组装为 ProjectSnapshotBundle，写入 project_snapshots
 * - computeProjectHead：查询 novel_projects.current_revision + final 章节内容哈希列表
 * - computeSnapshotHash：对 payload 的稳定 JSON 序列化做 SHA-256
 * - verifyProjectSnapshot：重算 hash 比对
 *
 * 与 v1 的区别：v1 用 Dexie 事务捕获多表记录，v2 直接用 SQL 查询；
 * v1 的 ProjectHead 含 finalDocumentHeads 详情，v2 简化为 finalDocumentHashes 字符串列表
 * （protocol.ts 已定义 ProjectHead 只有 projectRevision + finalDocumentHashes）。
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  Artifact,
  ExecutionBlueprint,
  ManuscriptDocumentSummary,
  MemoryClaim,
  MemoryBundle,
  MemoryKind,
  MemoryAuthority,
  NovelIntent,
  ProjectHead,
  ProjectSnapshotBundle,
  Review,
  ReviewIssue,
  SkillDescriptor,
} from "../protocol";
import type { NovelPostgresRepository } from "../postgres-repository";

// ===== 行类型映射 =====

type DocumentRow = {
  id: string;
  project_id: string;
  title: string;
  narrative_order: string | number;
  pov_character_id: string | null;
  current_revision_id: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type MemoryClaimRow = {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  content: string;
  subject_refs: string[] | null;
  narrative_start: string | number | null;
  narrative_end: string | number | null;
  knowledge_scope: Record<string, unknown>;
  authority: string;
  confidence: string | number;
  source_revision_ids: string[] | null;
  content_hash: string;
  supersedes: string[] | null;
  predicate: string | null;
  source_artifact_id: string | null;
  decided_by: string | null;
  decided_at: Date | string | null;
  created_at: Date | string;
};

type SkillRow = {
  skill_id: string;
  version: string;
  capabilities: string[] | null;
  applicable_tasks: string[] | null;
  required_memory_kinds: string[] | null;
  conflicts: string[] | null;
  quality_gates: string[] | null;
  prompt_sections: Record<string, unknown> | null;
  enabled: boolean;
  updated_at: Date | string;
};

type EntityRow = {
  id: string;
  kind: string;
  name: string;
  payload: Record<string, unknown>;
};

type RelationRow = {
  id: string;
  subject_id: string;
  predicate: string;
  object_id: string;
};

type RevisionRow = {
  id: string;
  project_id: string;
  document_id: string;
  revision: string | number;
  base_revision: string | number;
  content_hash: string;
  artifact_id: string | null;
  created_at: Date | string;
};

type ArtifactRow = {
  id: string;
  project_id: string;
  task_id: string;
  attempt_id: string;
  kind: string;
  content_hash: string;
  object_key: string | null;
  base_revision: string | number;
  fingerprint: string;
  payload: Record<string, unknown> | null;
  created_at: Date | string;
};

type ReviewRow = {
  id: string;
  project_id: string;
  artifact_id: string;
  reviewer_id: string;
  identity: string;
  verdict: string;
  artifact_fingerprint: string;
  issues: unknown;
  score: string | number | null;
  role: string | null;
  model_provenance: Review["modelProvenance"] | null;
  created_at: Date | string;
};

type ExecutionBlueprintRow = { id: string; intent_id: string; preflight_id: string; memory_bundle_id: string; skill_bundle_id: string; payload: ExecutionBlueprint; fingerprint: string };
type MemoryBundleRow = { id: string; preflight_id: string; payload: MemoryBundle; fingerprint: string };
type NovelIntentRow = { payload: NovelIntent };
type ContentBlobRow = { content_hash: string; object_key: string; byte_length: string | number };

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapDocumentRow(row: DocumentRow): ManuscriptDocumentSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    narrativeOrder: Number(row.narrative_order),
    povCharacterId: row.pov_character_id ?? undefined,
    currentRevisionId: row.current_revision_id ?? undefined,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapMemoryClaimRow(row: MemoryClaimRow): MemoryClaim {
  return {
    id: row.id,
    projectId: row.project_id,
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
    sourceRevisionIds: row.source_revision_ids ?? [],
    contentHash: row.content_hash,
    supersedes: row.supersedes ?? [],
    predicate: row.predicate ?? undefined,
    sourceArtifactId: row.source_artifact_id ?? undefined,
    decidedBy: row.decided_by ?? undefined,
    decidedAt: row.decided_at ? iso(row.decided_at) : undefined,
  };
}

function mapSkillRow(row: SkillRow): SkillDescriptor {
  return {
    skillId: row.skill_id,
    version: row.version,
    capabilities: row.capabilities ?? [],
    applicableTasks: (row.applicable_tasks ?? []) as SkillDescriptor["applicableTasks"],
    requiredMemoryKinds: (row.required_memory_kinds ?? []) as MemoryKind[],
    conflicts: row.conflicts ?? [],
    qualityGates: row.quality_gates ?? [],
    promptSections: (row.prompt_sections ?? {}) as SkillDescriptor["promptSections"],
    enabled: row.enabled,
  };
}

function mapArtifactRow(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    kind: row.kind as Artifact["kind"],
    contentHash: row.content_hash,
    objectKey: row.object_key ?? undefined,
    baseRevision: Number(row.base_revision),
    fingerprint: row.fingerprint,
    structuredData: row.payload ?? {},
    createdAt: new Date(row.created_at).getTime(),
  };
}

function mapReviewRow(row: ReviewRow): Review {
  const issues = Array.isArray(row.issues) ? (row.issues as ReviewIssue[]) : [];
  return {
    id: row.id,
    projectId: row.project_id,
    artifactId: row.artifact_id,
    reviewerId: row.reviewer_id,
    identity: row.identity as Review["identity"],
    verdict: row.verdict as Review["verdict"],
    issues,
    score: row.score === null ? undefined : Number(row.score),
    role: row.role ?? undefined,
    modelProvenance: row.model_provenance ?? undefined,
    artifactFingerprint: row.artifact_fingerprint,
    createdAt: new Date(row.created_at).getTime(),
  };
}

// ===== 稳定 JSON 序列化 =====

/**
 * 对 payload 做稳定 JSON 序列化：递归排序 key、过滤 undefined。
 *
 * 用于计算可复现的快照哈希。
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

// ===== 公共接口 =====

/**
 * 对 payload 的稳定 JSON 序列化做 SHA-256 哈希。
 *
 * 用于快照完整性校验：捕获时计算并存储，恢复/晋升时重算比对。
 */
export function computeSnapshotHash(payload: ProjectSnapshotBundle["payload"]): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

/**
 * 计算项目依赖头：novel_projects.current_revision + final 章节内容哈希列表。
 *
 * finalDocumentHashes 按 narrativeOrder 升序排列，任一变化都意味着正式库已前进。
 *
 * @throws 若项目不存在
 */
export async function computeProjectHead(
  repository: NovelPostgresRepository,
  projectId: string,
): Promise<ProjectHead> {
  const projectResult = await repository.pool.query<{ current_revision: string }>(
    "SELECT current_revision FROM novel_projects WHERE id = $1",
    [projectId],
  );
  if (!projectResult.rowCount) throw new Error(`项目不存在：${projectId}`);

  const documentsResult = await repository.pool.query<{ content_hash: string | null; narrative_order: string | number; id: string }>(
    `SELECT d.id, d.narrative_order, mr.content_hash
     FROM manuscript_documents d
     LEFT JOIN manuscript_revisions mr ON mr.id = d.current_revision_id
     WHERE d.project_id = $1 AND d.status = 'final'
     ORDER BY d.narrative_order, d.id`,
    [projectId],
  );

  const finalDocumentHashes = documentsResult.rows
    .map((row) => row.content_hash)
    .filter((hash): hash is string => typeof hash === "string" && hash.length > 0);

  return {
    projectRevision: Number(projectResult.rows[0].current_revision),
    finalDocumentHashes,
  };
}

/**
 * 捕获项目快照：查询 8 张表，组装为 ProjectSnapshotBundle，写入 project_snapshots。
 *
 * payload 包含 documents + memoryClaims + skillDefinitions + entities + relations +
 * revisions + artifacts + reviews 的完整序列化数据。
 * hash 是 payload 的稳定 SHA-256 哈希。
 * head 是当前 ProjectHead（projectRevision + finalDocumentHashes）。
 *
 * @throws 若项目不存在
 */
export async function captureProjectSnapshot(
  repository: NovelPostgresRepository,
  projectId: string,
): Promise<ProjectSnapshotBundle> {
  // 校验项目存在
  const projectResult = await repository.pool.query<{ current_revision: string }>(
    "SELECT current_revision FROM novel_projects WHERE id = $1",
    [projectId],
  );
  if (!projectResult.rowCount) throw new Error(`项目不存在：${projectId}`);

  // 并行查询 8 张表
  const [
    documentRows,
    memoryClaimRows,
    skillRows,
    entityRows,
    relationRows,
    revisionRows,
    artifactRows,
    reviewRows,
    novelIntentRows,
    contentBlobRows,
    executionBlueprintRows,
    memoryBundleRows,
  ] = await Promise.all([
    repository.pool.query<DocumentRow>(
      "SELECT id, project_id, title, narrative_order, pov_character_id, current_revision_id, status, created_at, updated_at FROM manuscript_documents WHERE project_id = $1 ORDER BY narrative_order, id",
      [projectId],
    ),
    repository.pool.query<MemoryClaimRow>(
      "SELECT id, project_id, kind, title, content, subject_refs, narrative_start, narrative_end, knowledge_scope, authority, confidence, source_revision_ids, content_hash, supersedes, predicate, source_artifact_id, decided_by, decided_at, created_at FROM memory_claims WHERE project_id = $1 ORDER BY created_at, id",
      [projectId],
    ),
    repository.pool.query<SkillRow>(
      "SELECT skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled, updated_at FROM skill_definitions ORDER BY skill_id",
    ),
    repository.pool.query<EntityRow>(
      "SELECT id, kind, name, payload FROM entities WHERE project_id = $1 ORDER BY id",
      [projectId],
    ),
    repository.pool.query<RelationRow>(
      "SELECT id, subject_id, predicate, object_id FROM relations WHERE project_id = $1 ORDER BY id",
      [projectId],
    ),
    repository.pool.query<RevisionRow>(
      "SELECT id, project_id, document_id, revision, base_revision, content_hash, artifact_id, created_at FROM manuscript_revisions WHERE project_id = $1 ORDER BY revision, id",
      [projectId],
    ),
    repository.pool.query<ArtifactRow>(
      "SELECT id, project_id, task_id, attempt_id, kind, content_hash, object_key, base_revision, fingerprint, payload, created_at FROM artifacts WHERE project_id = $1 ORDER BY created_at, id",
      [projectId],
    ),
    repository.pool.query<ReviewRow>(
      "SELECT id, project_id, artifact_id, reviewer_id, identity, verdict, artifact_fingerprint, issues, score, role, model_provenance, created_at FROM reviews WHERE project_id = $1 ORDER BY created_at, id",
      [projectId],
    ),
    repository.pool.query<NovelIntentRow>("SELECT payload FROM novel_intents WHERE project_id=$1 ORDER BY created_at,id", [projectId]),
    repository.pool.query<ContentBlobRow>(
      `SELECT DISTINCT cb.content_hash,cb.object_key,cb.byte_length
       FROM content_blobs cb
       JOIN manuscript_revisions mr ON mr.content_hash=cb.content_hash
       WHERE mr.project_id=$1 ORDER BY cb.content_hash`,
      [projectId],
    ),
    repository.pool.query<ExecutionBlueprintRow>("SELECT id,intent_id,preflight_id,memory_bundle_id,skill_bundle_id,payload,fingerprint FROM execution_blueprints WHERE project_id=$1 ORDER BY id", [projectId]),
    repository.pool.query<MemoryBundleRow>("SELECT id,preflight_id,payload,fingerprint FROM memory_bundles WHERE project_id=$1 ORDER BY id", [projectId]),
  ]);

  // 组装 payload（revisions 包含 extra 字段 projectId/artifactId/createdAt 供恢复使用）
  const payload = {
    documents: documentRows.rows.map(mapDocumentRow),
    memoryClaims: memoryClaimRows.rows.map(mapMemoryClaimRow),
    skillDefinitions: skillRows.rows.map(mapSkillRow),
    entities: entityRows.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      payload: row.payload ?? {},
    })),
    relations: relationRows.rows.map((row) => ({
      id: row.id,
      subjectId: row.subject_id,
      predicate: row.predicate,
      objectId: row.object_id,
    })),
    revisions: revisionRows.rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      revision: Number(row.revision),
      contentHash: row.content_hash,
      baseRevision: Number(row.base_revision),
      // extra fields for restore (not in protocol type but stored in JSONB)
      projectId: row.project_id,
      artifactId: row.artifact_id,
      createdAt: iso(row.created_at),
    })),
    artifacts: artifactRows.rows.map(mapArtifactRow),
    reviews: reviewRows.rows.map(mapReviewRow),
    novelIntents: novelIntentRows.rows.map((row) => row.payload),
    contentBlobs: contentBlobRows.rows.map((row) => ({ contentHash: row.content_hash, objectKey: row.object_key, byteLength: Number(row.byte_length) })),
    executionBlueprints: executionBlueprintRows.rows.map((row) => ({ id: row.id, intentId: row.intent_id, preflightId: row.preflight_id, memoryBundleId: row.memory_bundle_id, skillBundleId: row.skill_bundle_id, payload: row.payload, fingerprint: row.fingerprint })),
    memoryBundles: memoryBundleRows.rows.map((row) => ({ id: row.id, preflightId: row.preflight_id, narrativeCutoff: row.payload.narrativeCutoff, sourceRevisionIds: row.payload.sourceRevisionIds, tokenBudget: row.payload.tokenBudget, payload: row.payload, fingerprint: row.fingerprint })),
  } as ProjectSnapshotBundle["payload"];

  const hash = computeSnapshotHash(payload);
  const head = await computeProjectHead(repository, projectId);
  const id = randomUUID();
  const createdAt = Date.now();

  await repository.pool.query(
    "INSERT INTO project_snapshots(id, project_id, hash, payload, head, created_at) VALUES($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))",
    [id, projectId, hash, JSON.stringify(payload), JSON.stringify(head), createdAt],
  );

  return { id, projectId, hash, payload, head, createdAt };
}

/**
 * 校验快照完整性：重算 payload 哈希并与 expectedHash 比对。
 *
 * 用于实验工作区恢复前的完整性检查，以及晋升时的快照一致性验证。
 */
export function verifyProjectSnapshot(
  bundle: ProjectSnapshotBundle,
  expectedHash: string,
): { valid: boolean; reason?: string } {
  const computed = computeSnapshotHash(bundle.payload);
  if (computed !== expectedHash) {
    return {
      valid: false,
      reason: `快照哈希不匹配：expected=${expectedHash.slice(0, 16)}... computed=${computed.slice(0, 16)}...`,
    };
  }
  return { valid: true };
}
