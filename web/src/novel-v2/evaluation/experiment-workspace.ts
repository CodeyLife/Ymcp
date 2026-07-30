/**
 * V2 实验工作区：Postgres schema 隔离的实验环境管理。
 *
 * 设计依据：AGENTS.md + Phase B-1.3 重构计划。
 *
 * 与 v1 的区别：v1 用 Dexie（IndexedDB）实现实验库隔离（每个实验一个独立数据库），
 * v2 改用 Postgres schema 隔离（CREATE SCHEMA experiment_<id>）。
 *
 * 职责：
 * - createExperimentWorkspace：创建 schema + 影子表 + 恢复快照数据 + 记录工作区
 * - getExperimentWorkspace：按 ID 查询工作区并返回 handle
 * - listExperimentWorkspaces：列出项目的所有工作区
 * - ExperimentWorkspaceHandle：提供 query/close/delete 方法
 *
 * 影子表（无 FK 约束，实验隔离）：novel_projects, manuscript_documents, memory_claims,
 * skill_definitions, artifacts, reviews, manuscript_revisions, content_blobs。
 *
 * 安全：schemaName 由 experimentId 派生（exp-<ts>-<random> → experiment_exp_<ts>_<random>），
 * 创建前做标识符合法性校验，防止 SQL 注入。
 */
import type { Pool, QueryResult, QueryResultRow } from "pg";
import type { ExperimentWorkspace, ProjectSnapshotBundle } from "../protocol";
import { NovelPostgresRepository } from "../postgres-repository";
import { verifyProjectSnapshot } from "./project-snapshot";

// ===== 类型 =====

/**
 * 实验工作区句柄：在 ExperimentWorkspace 基础上提供 query/close/delete。
 *
 * query 执行的 SQL 应使用 ${schemaName}.table_name 形式引用实验 schema 内的表。
 */
export interface ExperimentWorkspaceHandle extends ExperimentWorkspace {
  /** 在实验 schema 内执行查询（SQL 文本需包含 schema 限定名） */
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Create a schema-bound repository using the same database connection as this workspace. */
  createRepository(): NovelPostgresRepository;
  /** 关闭实验（保留数据，status='closed'） */
  close(): Promise<void>;
  /** 删除实验（DROP SCHEMA CASCADE + 删除工作区记录） */
  delete(): Promise<void>;
}

// ===== 辅助 =====

/**
 * 生成实验 ID：exp-<timestamp>-<random>。
 */
function generateExperimentId(): string {
  return `exp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 从 experimentId 派生 schema 名：experiment_<id with underscores>。
 */
function schemaNameFromExperimentId(experimentId: string): string {
  return `experiment_${experimentId.replace(/-/g, "_")}`;
}

/**
 * 校验 schema 名是否为合法 Postgres 标识符。
 */
function assertValidSchemaName(schemaName: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schemaName)) {
    throw new Error(`非法 schema 名：${schemaName}`);
  }
}

type WorkspaceRow = {
  id: string;
  project_id: string;
  schema_name: string;
  base_snapshot_id: string;
  base_snapshot_hash: string;
  status: string;
  created_at: Date | string;
  closed_at: Date | string | null;
};

export const EXPERIMENT_RUNTIME_TABLES = [
  "arcs", "artifacts", "audit_records", "books", "chapter_memories", "chapter_planning_contexts", "chapter_production_specs",
  "chapter_review_snapshot_issues", "chapter_review_snapshots", "chapters",
  "character_knowledge", "commit_records", "content_blobs", "context_manifests",
  "craft_rule_candidates", "creative_reviews", "creative_run_events", "creative_runs",
  "creative_work_items", "entities", "execution_blueprints", "fact_sources", "facts",
  "foreshadowing", "idempotency_keys", "learning_assessments", "manuscript_blocks",
  "manuscript_documents", "manuscript_revisions", "memory_bundles", "memory_claims", "memory_gate_states",
  "memory_snapshots", "model_invocations", "model_routes", "model_tasks", "novel_intents",
  "novel_projects", "outbox_events", "payoff_curve", "payoffs", "plot_threads",
  "preflight_plans", "project_plan_sections", "projection_failures", "promises", "prompt_templates", "provider_configs", "quality_gates",
  "relations", "retrieval_runs", "reviews", "scenes", "skill_bindings", "skill_bundles",
  "skill_definitions", "skill_versions", "skills", "story_arc_batches", "task_attempts", "timeline_events",
  "usage_ledger", "volumes", "workflow_run_summaries", "workflow_runs",
] as const;

function mapWorkspaceRow(row: WorkspaceRow): ExperimentWorkspace {
  return {
    id: row.id,
    projectId: row.project_id,
    schemaName: row.schema_name,
    baseSnapshotId: row.base_snapshot_id,
    baseSnapshotHash: row.base_snapshot_hash,
    status: row.status as ExperimentWorkspace["status"],
    createdAt: new Date(row.created_at).getTime(),
    closedAt: row.closed_at ? new Date(row.closed_at).getTime() : undefined,
  };
}

function createHandle(pool: Pool, workspace: ExperimentWorkspace, repository: NovelPostgresRepository): ExperimentWorkspaceHandle {
  return {
    ...workspace,
    query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
      return pool.query<T>(text, params as unknown[]);
    },
    createRepository(): NovelPostgresRepository {
      return repository.forSchema(workspace.schemaName);
    },
    async close(): Promise<void> {
      await pool.query(
        "UPDATE experiment_workspaces SET status = 'closed', closed_at = now() WHERE id = $1",
        [workspace.id],
      );
    },
    async delete(): Promise<void> {
      const schemaName = workspace.schemaName;
      assertValidSchemaName(schemaName);
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.query("DELETE FROM experiment_workspaces WHERE id = $1", [workspace.id]);
    },
  };
}

// ===== 影子表创建 =====

/**
 * 在实验 schema 内创建影子表（无 FK 约束，实验隔离）。
 *
 * 影子表列表：novel_projects, manuscript_documents, memory_claims, skill_definitions,
 * artifacts, reviews, manuscript_revisions, content_blobs。
 */
async function createShadowTables(pool: Pool, schemaName: string): Promise<void> {
  assertValidSchemaName(schemaName);
  // Explicit ownership is an isolation boundary: public can also contain
  // LiteLLM or other services' tables, which must never be cloned or mutated.
  const existing = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])",
    [EXPERIMENT_RUNTIME_TABLES],
  );
  const existingNames = new Set(existing.rows.map((row) => row.tablename));
  const missing = EXPERIMENT_RUNTIME_TABLES.filter((tablename) => !existingNames.has(tablename));
  if (missing.length) throw new Error(`V2 runtime schema 不完整：${missing.join(", ")}`);
  for (const tablename of EXPERIMENT_RUNTIME_TABLES) {
    await pool.query(`CREATE TABLE ${schemaName}.${tablename} (LIKE public.${tablename} INCLUDING ALL)`);
  }
}

// ===== 快照恢复 =====

/**
 * 将快照 payload 恢复到实验 schema 各表。
 *
 * 恢复顺序：novel_projects → content_blobs → manuscript_documents → manuscript_revisions →
 * artifacts → reviews → memory_claims → skill_definitions。
 * 影子表无 FK 约束，顺序仅为逻辑清晰。
 */
async function restoreProjectSnapshot(
  pool: Pool,
  schemaName: string,
  bundle: ProjectSnapshotBundle,
): Promise<void> {
  assertValidSchemaName(schemaName);
  const s = schemaName;

  // 1. novel_projects（快照不含 project 详情，从 bundle.projectId 推断最小记录）
  await pool.query(
    `INSERT INTO ${s}.novel_projects(id, title, current_revision, metadata, created_at, updated_at)
     VALUES($1, $2, $3, $4::jsonb, now(), now())
     ON CONFLICT(id) DO NOTHING`,
    [bundle.projectId, bundle.projectId, bundle.head.projectRevision, "{}"],
  );

  // 2. content_blobs: restore the exact immutable object-store references.
  for (const blob of bundle.payload.contentBlobs) {
    await pool.query(
      `INSERT INTO ${s}.content_blobs(content_hash, object_key, byte_length, word_count)
       VALUES($1, $2, $3, $4) ON CONFLICT(content_hash) DO NOTHING`,
      [blob.contentHash, blob.objectKey, blob.byteLength, blob.wordCount ?? null],
    );
  }

  // 3. manuscript_documents
  for (const doc of bundle.payload.documents) {
    await pool.query(
      `INSERT INTO ${s}.manuscript_documents(id, project_id, title, narrative_order, pov_character_id, current_revision_id, status, created_at, updated_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        doc.id,
        doc.projectId,
        doc.title,
        doc.narrativeOrder,
        doc.povCharacterId ?? null,
        doc.currentRevisionId ?? null,
        doc.status,
        doc.createdAt,
        doc.updatedAt,
      ],
    );
  }

  // 4. manuscript_revisions（含 extra 字段 projectId/artifactId/createdAt）
  for (const rev of bundle.payload.revisions) {
    const extra = rev as typeof rev & { projectId?: string; artifactId?: string | null; createdAt?: string };
    await pool.query(
      `INSERT INTO ${s}.manuscript_revisions(id, project_id, document_id, revision, base_revision, content_hash, artifact_id, created_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        rev.id,
        extra.projectId ?? bundle.projectId,
        rev.documentId,
        rev.revision,
        rev.baseRevision,
        rev.contentHash,
        extra.artifactId ?? null,
        extra.createdAt ?? new Date().toISOString(),
      ],
    );
  }

  // 5. artifacts
  for (const art of bundle.payload.artifacts) {
    await pool.query(
      `INSERT INTO ${s}.artifacts(id, project_id, task_id, attempt_id, kind, content_hash, object_key, base_revision, fingerprint, payload, created_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11 / 1000.0))`,
      [
        art.id,
        art.projectId,
        art.taskId,
        art.attemptId,
        art.kind,
        art.contentHash,
        art.objectKey ?? "",
        art.baseRevision,
        art.fingerprint,
        JSON.stringify(art.structuredData ?? {}),
        art.createdAt,
      ],
    );
  }

  // 6. reviews
  for (const review of bundle.payload.reviews) {
    await pool.query(
      `INSERT INTO ${s}.reviews(id, project_id, artifact_id, reviewer_id, identity, verdict, artifact_fingerprint, issues, score, role, model_provenance, created_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12 / 1000.0))`,
      [
        review.id,
        review.projectId,
        review.artifactId,
        review.reviewerId,
        review.identity,
        review.verdict,
        review.artifactFingerprint,
        JSON.stringify(review.issues),
        review.score ?? null,
        review.role ?? null,
        review.modelProvenance ? JSON.stringify(review.modelProvenance) : null,
        review.createdAt,
      ],
    );
  }

  // 7. memory_claims
  for (const claim of bundle.payload.memoryClaims) {
    await pool.query(
      `INSERT INTO ${s}.memory_claims(id, project_id, kind, title, content, subject_refs, narrative_start, narrative_end, knowledge_scope, authority, confidence, source_revision_ids, content_hash, supersedes, predicate, source_artifact_id, decided_by, decided_at, created_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now())`,
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
        claim.predicate ?? null,
        claim.sourceArtifactId ?? null,
        claim.decidedBy ?? null,
        claim.decidedAt ?? null,
      ],
    );
  }

  // 8. skill_definitions
  for (const skill of bundle.payload.skillDefinitions) {
    await pool.query(
      `INSERT INTO ${s}.skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, enabled, updated_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [
        skill.skillId,
        skill.version,
        skill.capabilities,
        skill.applicableTasks,
        skill.requiredMemoryKinds,
        skill.conflicts,
        skill.qualityGates,
        JSON.stringify(skill.promptSections),
        skill.enabled,
      ],
    );
  }

  // 9. cognition records required by the formal chapter-review entrypoint.
  for (const intent of bundle.payload.novelIntents) {
    await pool.query(
      `INSERT INTO ${s}.novel_intents(id,project_id,source,objective,payload,idempotency_key,created_at)
       VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7 / 1000.0))`,
      [intent.id, intent.projectId, intent.source, intent.objective, JSON.stringify(intent), intent.idempotencyKey, intent.createdAt],
    );
  }
  for (const memory of bundle.payload.memoryBundles) {
    await pool.query(
      `INSERT INTO ${s}.memory_bundles(id,project_id,preflight_id,fingerprint,payload)
       VALUES($1,$2,$3,$4,$5)`,
      [memory.id, bundle.projectId, memory.preflightId, memory.fingerprint, JSON.stringify(memory.payload)],
    );
  }
  for (const blueprint of bundle.payload.executionBlueprints) {
    await pool.query(
      `INSERT INTO ${s}.execution_blueprints(id,project_id,intent_id,preflight_id,memory_bundle_id,skill_bundle_id,payload,fingerprint)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [blueprint.id, bundle.projectId, blueprint.intentId, blueprint.preflightId, blueprint.memoryBundleId, blueprint.skillBundleId, JSON.stringify(blueprint.payload), blueprint.fingerprint],
    );
  }
}

// ===== 公共接口 =====

/**
 * 从不可变项目快照创建隔离实验工作区。
 *
 * 步骤：
 * 1. 校验快照完整性（verifyProjectSnapshot）
 * 2. 生成 experimentId（若未提供）+ schemaName
 * 3. CREATE SCHEMA + 创建影子表
 * 4. restoreProjectSnapshot：将 payload 写入实验 schema 各表
 * 5. 在公共 experiment_workspaces 表插入记录
 *
 * 失败时尝试清理已创建的 schema，避免残留。
 */
export async function createExperimentWorkspace(
  repository: NovelPostgresRepository,
  bundle: ProjectSnapshotBundle,
  experimentId?: string,
): Promise<ExperimentWorkspaceHandle> {
  // 1. 校验快照
  const verification = verifyProjectSnapshot(bundle, bundle.hash);
  if (!verification.valid) {
    throw new Error(`项目快照校验失败，无法创建实验工作区：${verification.reason ?? "未知原因"}`);
  }

  // 2. 生成 ID + schemaName
  const id = experimentId ?? generateExperimentId();
  const schemaName = schemaNameFromExperimentId(id);
  assertValidSchemaName(schemaName);

  const pool = repository.pool;

  // 3. CREATE SCHEMA + 影子表
  try {
    await pool.query(`CREATE SCHEMA ${schemaName}`);
    await createShadowTables(pool, schemaName);
  } catch (error) {
    // 创建失败时清理已创建的 schema
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    } catch {
      // 忽略清理失败，抛出原始错误
    }
    throw error;
  }

  // 4. 恢复快照
  try {
    await restoreProjectSnapshot(pool, schemaName, bundle);
  } catch (error) {
    // 恢复失败时清理 schema
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    } catch {
      // 忽略清理失败
    }
    throw error;
  }

  // 5. 插入工作区记录
  const createdAt = Date.now();
  await pool.query(
    `INSERT INTO experiment_workspaces(id, project_id, schema_name, base_snapshot_id, base_snapshot_hash, status, created_at)
     VALUES($1, $2, $3, $4, $5, 'active', to_timestamp($6 / 1000.0))`,
    [id, bundle.projectId, schemaName, bundle.id, bundle.hash, createdAt],
  );

  const workspace: ExperimentWorkspace = {
    id,
    projectId: bundle.projectId,
    schemaName,
    baseSnapshotId: bundle.id,
    baseSnapshotHash: bundle.hash,
    status: "active",
    createdAt,
  };

  return createHandle(pool, workspace, repository);
}

/**
 * 按 ID 查询实验工作区，返回 handle 或 null。
 *
 * 若工作区状态为 'deleted'，返回 null。
 */
export async function getExperimentWorkspace(
  repository: NovelPostgresRepository,
  experimentId: string,
): Promise<ExperimentWorkspaceHandle | null> {
  const result = await repository.pool.query<WorkspaceRow>(
    "SELECT id, project_id, schema_name, base_snapshot_id, base_snapshot_hash, status, created_at, closed_at FROM experiment_workspaces WHERE id = $1",
    [experimentId],
  );
  if (!result.rowCount) return null;
  const workspace = mapWorkspaceRow(result.rows[0]);
  if (workspace.status === "deleted") return null;
  return createHandle(repository.pool, workspace, repository);
}

/**
 * 列出项目的所有实验工作区（不含 handle 方法）。
 */
export async function listExperimentWorkspaces(
  repository: NovelPostgresRepository,
  projectId: string,
): Promise<ExperimentWorkspace[]> {
  const result = await repository.pool.query<WorkspaceRow>(
    "SELECT id, project_id, schema_name, base_snapshot_id, base_snapshot_hash, status, created_at, closed_at FROM experiment_workspaces WHERE project_id = $1 AND status != 'deleted' ORDER BY created_at DESC",
    [projectId],
  );
  return result.rows.map(mapWorkspaceRow);
}
