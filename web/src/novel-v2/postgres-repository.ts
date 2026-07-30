import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { foundationArtifactToMemoryClaim } from "./foundation-memory";
import {
  PROJECT_PLAN_STAGES,
  REQUIRED_APPROVED_PLAN_TASK_KEYS,
  foundationTaskKey,
  transitivePlanDependents,
  approvedProjectBookTitle,
  type ProjectPlanSection,
  type ProjectPlanStatus,
  type ProjectPlanTaskKey,
} from "./application/project-plan";
import type { FactExtractionOutput } from "./prompts/schemas";
import type {
  Artifact,
  CandidateBundle,
  ChapterMemory,
  CommitRequest,
  CommitResult,
  ContextManifest,
  ExecutionBlueprint,
  FactApprovalSummary,
  ManuscriptDocumentSummary,
  MemoryBundle,
  MemoryClaim,
  MemoryHit,
  NovelIntent,
  NovelProjectDetail,
  PreflightPlan,
  ProjectSnapshotBundle,
  PromotionReceipt,
  RetrievalFacet,
  Review,
  ReviewIssue,
  RuntimeLearningAssessmentV2,
  SkillBundle,
  SkillDescriptor,
  TaskAttemptRecord,
  WorkflowRunRecord,
} from "./protocol";
import type { ModelInvocationAudit, ModelPromptExecution } from "./model-gateway";
import type { ModelRoutingConfig, ModelRoutingSnapshot, ModelTaskRecord, ModelWorkPackage } from "./model-routing";
import type { ObjectStoreAdapter } from "./object-store";
import { countNovelCharacters } from "./word-count";
import type { ObjectStoreIdentity } from "./object-store";
import { canGenerateNextStoryArcBatch, planningContextFingerprint, type ChapterBlueprintRecord, type ChapterPlanningContext, type ChapterSceneBlueprint, type NarrativeArcPlan, type StoryArcBatchRecord, type StoryArcBundle, type StoryArcRecord } from "./application/story-arc";
import { aggregateChapterReviews, reviewIssueFingerprint, type ChapterReviewIssueStatus } from "./chapter-review-snapshot";
import {
  bookSynopsisSourceFingerprint,
  bookTitleSourceFingerprint,
  parseBookTitleCandidatesMetadata,
  type BookSynopsisRecord,
  type BookTitleCandidatesRecord,
} from "./application/book-synopsis";
import { chapterTitleSourceFingerprint, type ChapterTitleSource } from "./application/chapter-title";

export interface NovelProjectSnapshot {
  projectId: string;
  currentRevision: number;
  targetDocumentId?: string;
  targetDocumentOrder?: number;
  povCharacterId?: string;
  /**
   * Phase 3.3 题材与前提（可选）。
   *
   * 从 novel_projects.metadata 读取，由项目创建时指定。
   * 不内置固定题材枚举——任何字符串都可作为 genre。
   */
  genre?: string;
  premise?: string;
}

export type KnowledgeRecordKind = "planning" | "worldview" | "characters" | "relations" | "timeline" | "facts" | "skills" | "foundation";

type ProjectRow = { id: string; title: string; current_revision: string | number; metadata: Record<string, unknown>; created_at: Date | string; updated_at: Date | string };
type DocumentRow = { id: string; project_id: string; title: string; narrative_order: string | number; pov_character_id: string | null; current_revision_id: string | null; status: string; created_at: Date | string; updated_at: Date | string; word_count?: string | number | null; latest_revision?: string | number | null; chapter_goal?: string | null; blocking_issue_count?: string | number | null; review_score?: string | number | null; review_verdict?: "passed" | "revise" | "blocked" | null; review_stale?: boolean | null; arc_id?: string | null; arc_title?: string | null; arc_planning_status?: string | null };
type WorkflowRunRow = { id: string; workflow_type: string; project_id: string; temporal_workflow_id: string; status: string; payload: Record<string, unknown>; created_at: Date | string; updated_at: Date | string };
type ArtifactRow = { id: string; project_id: string; task_id: string; attempt_id: string; kind: Artifact["kind"]; content_hash: string; object_key: string | null; base_revision: string | number; fingerprint: string; payload: Record<string, unknown>; created_at: Date | string };
type TaskAttemptRow = { id: string; workflow_run_id: string | null; task_id: string; lease_owner: string | null; lease_expires_at: Date | string | null; heartbeat_at: Date | string | null; status: TaskAttemptRecord["status"]; payload: Record<string, unknown> };
type ModelTaskRow = { id: string; workflow_run_id: string; task_id: string; purpose: ModelTaskRecord["purpose"]; config_revision: string; candidate_index: number; status: ModelTaskRecord["status"]; work_package: ModelWorkPackage; result: ModelTaskRecord["result"] | null; idempotency_key: string; created_at: Date | string; updated_at: Date | string };
type ProjectPlanSectionRow = { project_id: string; task_key: string; work_item_id: string | null; source_artifact_id: string | null; status: ProjectPlanStatus; payload: Record<string, unknown>; edit_revision: string | number; approved_at: Date | string | null; created_at: Date | string; updated_at: Date | string };
type ArcRow = { id: string; volume_id: string; project_id: string; title: string; ordinal: string | number; planning_status: StoryArcRecord["planningStatus"]; execution_status: StoryArcRecord["executionStatus"]; payload: NarrativeArcPlan; source_artifact_id: string | null; blueprint_artifact_id: string | null; context_fingerprint: string | null; edit_revision: string | number; approved_at: Date | string | null; completed_at: Date | string | null; abandoned_at: Date | string | null; updated_at: Date | string };
type ChapterBlueprintRow = { id: string; arc_id: string; project_id: string; document_id: string | null; title: string; ordinal: string | number; status: string; payload: Record<string, unknown>; source_artifact_id: string | null; blueprint_revision: string | number };
type StoryArcBatchRow = { id: string; arc_id: string; project_id: string; batch_index: string | number; start_chapter_index: string | number; end_chapter_index: string | number; status: StoryArcBatchRecord["status"]; entry_fingerprint: string; source_artifact_id: string | null; payload: Record<string, unknown>; approved_at: Date | string | null };

function iso(value: Date | string) { return value instanceof Date ? value.toISOString() : value; }
export function isTransientPostgresStartupError(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown };
  const code = typeof record.code === "string" ? record.code : undefined;
  if (code && new Set(["57P03", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]).has(code)) return true;
  const message = typeof record.message === "string" ? record.message : "";
  return /database system is (starting up|not yet accepting connections)|consistent recovery state has not been yet reached|connection terminated unexpectedly/i.test(message);
}

function documentFromRow(row: DocumentRow): ManuscriptDocumentSummary {
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
    wordCount: row.word_count === undefined || row.word_count === null ? undefined : Number(row.word_count),
    latestRevision: row.latest_revision === undefined || row.latest_revision === null ? undefined : Number(row.latest_revision),
    chapterGoal: row.chapter_goal ?? undefined,
    blockingIssueCount: row.blocking_issue_count === undefined || row.blocking_issue_count === null ? undefined : Number(row.blocking_issue_count),
    reviewScore: row.review_score === undefined || row.review_score === null ? undefined : Number(row.review_score),
    reviewVerdict: row.review_verdict ?? undefined,
    reviewStale: row.review_stale ?? undefined,
    arcId: row.arc_id ?? undefined,
    arcTitle: row.arc_title ?? undefined,
    arcPlanningStatus: row.arc_planning_status ?? undefined,
  };
}
function workflowFromRow(row: WorkflowRunRow): WorkflowRunRecord {
  return { id: row.id, workflowType: row.workflow_type, projectId: row.project_id, temporalWorkflowId: row.temporal_workflow_id, status: row.status, payload: row.payload ?? {}, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function taskAttemptFromRow(row: TaskAttemptRow): TaskAttemptRecord {
  return { id: row.id, workflowRunId: row.workflow_run_id ?? undefined, taskId: row.task_id, leaseOwner: row.lease_owner ?? undefined, leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : undefined, heartbeatAt: row.heartbeat_at ? iso(row.heartbeat_at) : undefined, status: row.status, payload: row.payload ?? {} };
}
function artifactFromRow(row: ArtifactRow): Artifact {
  return { id: row.id, projectId: row.project_id, taskId: row.task_id, attemptId: row.attempt_id, kind: row.kind, contentHash: row.content_hash, objectKey: row.object_key ?? undefined, baseRevision: Number(row.base_revision), fingerprint: row.fingerprint, structuredData: row.payload ?? {}, createdAt: new Date(row.created_at).getTime() };
}
function modelTaskFromRow(row: ModelTaskRow): ModelTaskRecord {
  return { id: row.id, workflowRunId: row.workflow_run_id, taskId: row.task_id, purpose: row.purpose, configRevision: row.config_revision, candidateIndex: row.candidate_index, status: row.status, workPackage: row.work_package, result: row.result ?? undefined, idempotencyKey: row.idempotency_key, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function projectPlanSectionFromRow(row: ProjectPlanSectionRow): ProjectPlanSection {
  return {
    projectId: row.project_id,
    taskKey: row.task_key as ProjectPlanTaskKey,
    workItemId: row.work_item_id ?? undefined,
    sourceArtifactId: row.source_artifact_id ?? undefined,
    status: row.status,
    payload: row.payload ?? {},
    editRevision: Number(row.edit_revision),
    approvedAt: row.approved_at ? iso(row.approved_at) : undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function chapterBlueprintFromRow(row: ChapterBlueprintRow): ChapterBlueprintRecord {
  const payload = row.payload ?? {};
  return {
    id: row.id,
    arcId: row.arc_id,
    projectId: row.project_id,
    documentId: row.document_id ?? undefined,
    globalOrder: Number(row.ordinal),
    status: row.status,
    sourceArtifactId: row.source_artifact_id ?? undefined,
    blueprintRevision: Number(row.blueprint_revision),
    index: typeof payload.index === "number" ? payload.index : Number(row.ordinal),
    title: typeof payload.title === "string" ? payload.title : row.title,
    summary: typeof payload.summary === "string" ? payload.summary : "",
    chapterPurpose: typeof payload.chapterPurpose === "string" ? payload.chapterPurpose : "",
    dramaticQuestion: typeof payload.dramaticQuestion === "string" ? payload.dramaticQuestion : "",
    povCharacterId: typeof payload.povCharacterId === "string" ? payload.povCharacterId : undefined,
    emotionalMovement: typeof payload.emotionalMovement === "string" ? payload.emotionalMovement : "",
    stateDeltaBudget: typeof payload.stateDeltaBudget === "string" ? payload.stateDeltaBudget : "",
    optionalBeats: Array.isArray(payload.optionalBeats) ? payload.optionalBeats.filter((value): value is string => typeof value === "string") : [],
    scenes: Array.isArray(payload.scenes) ? payload.scenes.flatMap<ChapterSceneBlueprint>((value, index) => {
      if (typeof value === "string") return [{ title: value, summary: value, participants: [] as string[] }];
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const scene = value as Record<string, unknown>;
      return [{
        title: typeof scene.title === "string" ? scene.title : `场景 ${index + 1}`,
        summary: typeof scene.summary === "string" ? scene.summary : "",
        goal: typeof scene.goal === "string" ? scene.goal : undefined,
        participants: Array.isArray(scene.participants) ? scene.participants.filter((item): item is string => typeof item === "string") : [],
        turn: typeof scene.turn === "string" ? scene.turn : undefined,
        outcome: typeof scene.outcome === "string" ? scene.outcome : undefined,
      }];
    }) : [],
    continuityConstraints: Array.isArray(payload.continuityConstraints) ? payload.continuityConstraints.filter((value): value is string => typeof value === "string") : [],
    setupRefs: Array.isArray(payload.setupRefs) ? payload.setupRefs.filter((value): value is string => typeof value === "string") : [],
    payoffRefs: Array.isArray(payload.payoffRefs) ? payload.payoffRefs.filter((value): value is string => typeof value === "string") : [],
    closingForce: typeof payload.closingForce === "string" ? payload.closingForce : "",
    freedom: typeof payload.freedom === "string" ? payload.freedom : "",
  };
}

export class NovelPostgresRepository {
  readonly pool: Pool;
  private readonly connectionConfig: PoolConfig;

  constructor(config: PoolConfig | string = process.env.DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp") {
    this.connectionConfig = typeof config === "string" ? { connectionString: config } : { ...config };
    this.pool = new Pool(this.connectionConfig);
  }

  forSchema(schemaName: string): NovelPostgresRepository {
    if (!/^[a-z_][a-z0-9_]*$/u.test(schemaName)) throw new Error(`非法 schema 名：${schemaName}`);
    return new NovelPostgresRepository({
      ...this.connectionConfig,
      options: `-c search_path=${schemaName},pg_catalog`,
    });
  }

  async migrate() {
    const migrationsDir = process.env.NOVEL_V2_MIGRATIONS_DIR ?? join(process.cwd(), "deploy", "postgres");
    const files = readdirSync(migrationsDir).filter((file) => /^\d{3}_.+\.sql$/u.test(file)).sort();
    if (!files.length) throw new Error(`没有找到 V2 数据库迁移：${migrationsDir}`);
    const client = await this.connectForMigration();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('ymcp-novel-v2-migrations'))");
      await client.query("CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      for (const file of files) {
        const sql = readFileSync(join(migrationsDir, file), "utf8");
        const rawChecksum = createHash("sha256").update(sql).digest("hex");
        const normalizedSql = sql.replace(/\r\n?/gu, "\n");
        const checksum = createHash("sha256").update(normalizedSql).digest("hex");
        const applied = await client.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE version=$1", [file]);
        if (applied.rowCount) {
          if (applied.rows[0].checksum !== checksum && applied.rows[0].checksum !== rawChecksum) {
            const legacyWorkspaceObjects = file === "022_chapter_workspace.sql"
              ? await client.query<{ object_count: number }>(`
                  SELECT count(*)::int AS object_count FROM (
                    SELECT table_name,column_name FROM information_schema.columns
                    WHERE table_schema=current_schema() AND (
                      (table_name='workflow_run_summaries' AND column_name IN ('final_status','metrics')) OR
                      (table_name='chapter_review_snapshots' AND column_name IN ('reviewed_content_hash','dimension_scores')) OR
                      (table_name='manuscript_revisions' AND column_name IN ('retention_class','expires_at'))
                    )
                  ) markers
                `)
              : { rows: [{ object_count: 0 }] };
            if (legacyWorkspaceObjects.rows[0]?.object_count !== 6) throw new Error(`已应用迁移被修改：${file}`);
            await client.query("UPDATE schema_migrations SET checksum=$2 WHERE version=$1", [file, checksum]);
          }
          continue;
        }
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [file, checksum]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw new Error(`数据库迁移失败 ${file}: ${(error as Error).message}`, { cause: error });
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('ymcp-novel-v2-migrations'))").catch(() => undefined);
      client.release();
    }
    await this.backfillCurrentChapterReviewSnapshots();
  }

  async backfillMissingContentWordCounts(objects: ObjectStoreAdapter): Promise<{ updated: number; failed: number }> {
    const result = await this.pool.query<{ content_hash: string; object_key: string }>(
      "SELECT content_hash,object_key FROM content_blobs WHERE word_count IS NULL ORDER BY created_at,content_hash",
    );
    let updated = 0;
    let failed = 0;
    for (const row of result.rows) {
      try {
        const text = await objects.getText(row.object_key);
        const update = await this.pool.query(
          "UPDATE content_blobs SET word_count=$2 WHERE content_hash=$1 AND word_count IS NULL",
          [row.content_hash, countNovelCharacters(text)],
        );
        updated += update.rowCount ?? 0;
      } catch {
        failed += 1;
      }
    }
    return { updated, failed };
  }

  async recordMemoryGateCheck(input: { projectId: string; workflowId: string; criticalMissingFacets: string[]; blockAfter?: number }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const missing = [...new Set(input.criticalMissingFacets)].sort();
      const result = await client.query<{ consecutive_critical_misses: number; last_missing_facets: string[] }>(`
        INSERT INTO memory_gate_states(project_id,consecutive_critical_misses,last_missing_facets,last_workflow_id,last_checked_at)
        VALUES($1,$2,$3,$4,now())
        ON CONFLICT(project_id) DO UPDATE SET
          consecutive_critical_misses=CASE WHEN cardinality(EXCLUDED.last_missing_facets)=0 THEN 0 ELSE memory_gate_states.consecutive_critical_misses+1 END,
          last_missing_facets=EXCLUDED.last_missing_facets,
          last_workflow_id=EXCLUDED.last_workflow_id,
          last_checked_at=now()
        RETURNING consecutive_critical_misses,last_missing_facets
      `, [input.projectId, missing.length ? 1 : 0, missing, input.workflowId]);
      const state = result.rows[0];
      const blocked = missing.length > 0 && state.consecutive_critical_misses >= (input.blockAfter ?? 3);
      if (blocked) {
        await this.appendOutboxTx(client, "memory-gate", input.projectId, "memory-gate.blocked", { projectId: input.projectId, workflowId: input.workflowId, consecutiveCriticalMisses: state.consecutive_critical_misses, missingFacets: state.last_missing_facets });
      }
      await client.query("COMMIT");
      return { consecutiveCriticalMisses: state.consecutive_critical_misses, missingFacets: state.last_missing_facets, blocked };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async connectForMigration(): Promise<PoolClient> {
    const timeoutMs = Number(process.env.NOVEL_V2_POSTGRES_CONNECT_TIMEOUT_MS ?? 60_000);
    const intervalMs = Number(process.env.NOVEL_V2_POSTGRES_CONNECT_RETRY_MS ?? 1_000);
    const deadline = Date.now() + Math.max(timeoutMs, 0);
    let attempt = 0;
    let lastError: unknown;
    while (true) {
      try {
        return await this.pool.connect();
      } catch (error) {
        lastError = error;
        if (!isTransientPostgresStartupError(error) || Date.now() >= deadline) break;
        attempt += 1;
        const remainingMs = Math.max(deadline - Date.now(), 0);
        await delay(Math.min(intervalMs * Math.min(attempt, 5), remainingMs));
      }
    }
    throw new Error(`Postgres 未在 ${timeoutMs}ms 内准备好：${(lastError as Error)?.message ?? String(lastError)}`, { cause: lastError });
  }

  async requestMemoryRebuild(projectId: string) {
    const result = await this.pool.query<{ consecutive_critical_misses: number; last_missing_facets: string[]; rebuild_requested_at: Date }>(`
      INSERT INTO memory_gate_states(project_id,rebuild_requested_at,last_checked_at)
      VALUES($1,now(),now())
      ON CONFLICT(project_id) DO UPDATE SET rebuild_requested_at=now(),last_checked_at=now()
      RETURNING consecutive_critical_misses,last_missing_facets,rebuild_requested_at
    `, [projectId]);
    await this.appendOutbox("memory-gate", projectId, "memory.rebuild-requested", { projectId, requestedAt: result.rows[0].rebuild_requested_at });
    return { projectId, status: "rebuild-requested" as const, consecutiveCriticalMisses: result.rows[0].consecutive_critical_misses, missingFacets: result.rows[0].last_missing_facets };
  }

  async completeMemoryRebuild(projectId: string, indexedClaims: number) {
    await this.pool.query(`
      INSERT INTO memory_gate_states(project_id,consecutive_critical_misses,last_missing_facets,last_checked_at)
      VALUES($1,0,'{}',now())
      ON CONFLICT(project_id) DO UPDATE SET consecutive_critical_misses=0,last_missing_facets='{}',last_checked_at=now(),rebuild_requested_at=NULL
    `, [projectId]);
    await this.appendOutbox("memory-gate", projectId, "memory.rebuild-completed", { projectId, indexedClaims });
    return { projectId, status: "ready" as const, indexedClaims };
  }

  async backfillCurrentChapterReviewSnapshots(): Promise<number> {
    const result = await this.pool.query<{ artifact_id: string }>(`
      SELECT DISTINCT mr.artifact_id
      FROM manuscript_documents d JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
      WHERE mr.artifact_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM chapter_review_snapshots s WHERE s.document_id=d.id AND s.reviewed_content_hash=mr.content_hash)
    `);
    let refreshed = 0;
    for (const row of result.rows) if (await this.refreshChapterReviewSnapshot(row.artifact_id)) refreshed += 1;
    return refreshed;
  }

  async health() {
    await this.pool.query("SELECT 1");
    return { postgres: true };
  }

  async projectModelRoutingConfig(config: ModelRoutingConfig, snapshot: ModelRoutingSnapshot) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM provider_configs");
      await client.query("DELETE FROM model_routes");
      for (const profile of snapshot.profiles) {
        await client.query(
          `INSERT INTO provider_configs(id,provider,model,capabilities,config,enabled,config_revision,label,protocol,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
          [profile.id, profile.protocol, profile.model, profile.capabilities, { baseUrl: profile.baseUrl, responseMode: profile.responseMode, timeoutMs: profile.timeoutMs, contextWindow: profile.contextWindow, secretRef: profile.secretRef, hasSecret: profile.hasSecret }, profile.enabled, snapshot.id, profile.label, profile.protocol],
        );
      }
      for (const [taskClass, route] of Object.entries(config.routes)) {
        const apiCandidates = route.candidates.filter((candidate): candidate is Extract<(typeof route.candidates)[number], { executor: "api" }> => candidate.executor === "api");
        await client.query(
          `INSERT INTO model_routes(task_class,primary_provider_id,fallback_provider_id,budget,candidates,conversation_policy,config_revision,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,now())`,
          [taskClass, apiCandidates[0]?.profileId ?? "external-mcp", apiCandidates[1]?.profileId ?? null, { maxInputTokens: route.maxInputTokens, maxOutputTokens: route.maxOutputTokens }, JSON.stringify(route.candidates), route.conversationPolicy ?? "stateless", snapshot.id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async recordModelInvocation(input: ModelInvocationAudit): Promise<void> {
    await this.pool.query(
      `INSERT INTO model_invocations(workflow_run_id,task_id,purpose,config_revision,candidate_index,executor,profile_id,protocol,model,status,input_tokens,output_tokens,provider_input_tokens,provider_output_tokens,estimated_input_tokens,estimated_output_tokens,usage_source,latency_ms,prompt_fingerprint,response_id,error_category)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [input.workflowRunId ?? null, input.taskId ?? null, input.purpose, input.configRevision, input.candidateIndex, input.executor, input.profileId ?? null, input.protocol ?? null, input.model, input.status, input.inputTokens, input.outputTokens, input.providerInputTokens ?? null, input.providerOutputTokens ?? null, input.estimatedInputTokens ?? null, input.estimatedOutputTokens ?? null, input.usageSource ?? "provider", input.latencyMs, input.promptFingerprint, input.responseId ?? null, input.errorCategory ?? null],
    );
  }

  async listModelUsage(limit = 100) {
    const result = await this.pool.query(
      `SELECT purpose,profile_id,protocol,model,status,usage_source,COUNT(*)::int AS calls,COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,COALESCE(SUM(provider_input_tokens),0)::bigint AS provider_input_tokens,COALESCE(SUM(provider_output_tokens),0)::bigint AS provider_output_tokens,COALESCE(SUM(estimated_input_tokens),0)::bigint AS estimated_input_tokens,COALESCE(SUM(estimated_output_tokens),0)::bigint AS estimated_output_tokens,COALESCE(AVG(latency_ms),0)::int AS average_latency_ms
       FROM model_invocations GROUP BY purpose,profile_id,protocol,model,status,usage_source ORDER BY MAX(created_at) DESC LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async createModelTask(workPackage: ModelWorkPackage, idempotencyKey: string): Promise<ModelTaskRecord> {
    const result = await this.pool.query<ModelTaskRow>(
      `INSERT INTO model_tasks(id,workflow_run_id,task_id,purpose,config_revision,candidate_index,status,work_package,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8)
       ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=model_tasks.updated_at
       RETURNING *`,
      [workPackage.id, workPackage.workflowRunId, workPackage.taskId, workPackage.purpose, workPackage.configRevision, workPackage.candidateIndex, workPackage, idempotencyKey],
    );
    return modelTaskFromRow(result.rows[0]);
  }

  async listModelTasks(status: ModelTaskRecord["status"] = "pending", limit = 50): Promise<ModelTaskRecord[]> {
    await this.reopenExpiredModelTasks();
    const result = await this.pool.query<ModelTaskRow>("SELECT * FROM model_tasks WHERE status=$1 ORDER BY created_at ASC LIMIT $2", [status, limit]);
    return result.rows.map(modelTaskFromRow);
  }

  async getModelTask(taskId: string): Promise<ModelTaskRecord | undefined> {
    await this.reopenExpiredModelTasks();
    const result = await this.pool.query<ModelTaskRow>("SELECT * FROM model_tasks WHERE id=$1", [taskId]);
    return result.rows[0] ? modelTaskFromRow(result.rows[0]) : undefined;
  }

  async claimModelTask(input: { taskId: string; attemptId: string; leaseOwner: string; leaseMs: number }): Promise<ModelTaskRecord> {
    await this.reopenExpiredModelTasks();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const task = await client.query<ModelTaskRow>("SELECT * FROM model_tasks WHERE id=$1 FOR UPDATE", [input.taskId]);
      if (!task.rowCount) throw new Error("外部模型任务不存在");
      if (task.rows[0].status !== "pending") throw new Error(`外部模型任务不可领取：${task.rows[0].status}`);
      await client.query("UPDATE model_tasks SET status='claimed',updated_at=now() WHERE id=$1", [input.taskId]);
      const leaseExpires = new Date(Date.now() + input.leaseMs);
      await client.query(
        `INSERT INTO task_attempts(id,workflow_run_id,task_id,lease_owner,lease_expires_at,heartbeat_at,status,payload)
         VALUES($1,$2,$3,$4,$5,now(),'claimed',$6)
         ON CONFLICT(id) DO UPDATE SET lease_owner=EXCLUDED.lease_owner,lease_expires_at=EXCLUDED.lease_expires_at,heartbeat_at=now(),status='claimed',payload=task_attempts.payload || EXCLUDED.payload`,
        [input.attemptId, task.rows[0].workflow_run_id, input.taskId, input.leaseOwner, leaseExpires, { modelTaskId: input.taskId }],
      );
      await client.query("COMMIT");
      return (await this.getModelTask(input.taskId))!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async heartbeatModelTask(input: { taskId: string; attemptId: string; leaseOwner: string; leaseMs: number }): Promise<void> {
    const leaseExpires = new Date(Date.now() + input.leaseMs);
    const result = await this.pool.query(
      `UPDATE task_attempts SET heartbeat_at=now(),lease_expires_at=$4,status='running'
       WHERE id=$1 AND task_id=$2 AND lease_owner=$3 AND lease_expires_at>now()`,
      [input.attemptId, input.taskId, input.leaseOwner, leaseExpires],
    );
    if (!result.rowCount) throw new Error("任务租约不存在、已过期或不属于当前执行者");
    await this.pool.query("UPDATE model_tasks SET status='running',updated_at=now() WHERE id=$1 AND status IN ('claimed','running')", [input.taskId]);
  }

  async submitModelTask(input: { taskId: string; attemptId: string; leaseOwner: string; inputFingerprint: string; result: ModelTaskRecord["result"] }): Promise<ModelTaskRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const task = await client.query<ModelTaskRow>("SELECT * FROM model_tasks WHERE id=$1 FOR UPDATE", [input.taskId]);
      if (!task.rowCount) throw new Error("外部模型任务不存在");
      const row = task.rows[0];
      if (row.status === "submitted") { await client.query("COMMIT"); return modelTaskFromRow(row); }
      if (row.work_package.inputFingerprint !== input.inputFingerprint) throw new Error("输入指纹不匹配，任务上下文已变化");
      const lease = await client.query("SELECT 1 FROM task_attempts WHERE id=$1 AND task_id=$2 AND lease_owner=$3 AND lease_expires_at>now()", [input.attemptId, input.taskId, input.leaseOwner]);
      if (!lease.rowCount) throw new Error("任务租约不存在、已过期或不属于当前执行者");
      if (typeof input.result?.text !== "string" && input.result?.value === undefined) throw new Error("外部任务结果必须包含 text 或 value");
      const updated = await client.query<ModelTaskRow>("UPDATE model_tasks SET status='submitted',result=$2,updated_at=now() WHERE id=$1 RETURNING *", [input.taskId, input.result]);
      await client.query("UPDATE task_attempts SET status='submitted',heartbeat_at=now() WHERE id=$1", [input.attemptId]);
      await client.query("COMMIT");
      return modelTaskFromRow(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async failModelTask(input: { taskId: string; attemptId: string; leaseOwner: string; reason: string }): Promise<ModelTaskRecord> {
    const lease = await this.pool.query("SELECT 1 FROM task_attempts WHERE id=$1 AND task_id=$2 AND lease_owner=$3", [input.attemptId, input.taskId, input.leaseOwner]);
    if (!lease.rowCount) throw new Error("任务 attempt 不属于当前执行者");
    const result = await this.pool.query<ModelTaskRow>("UPDATE model_tasks SET status='failed',result=$2,updated_at=now() WHERE id=$1 RETURNING *", [input.taskId, { text: "", value: { reason: input.reason } }]);
    if (!result.rowCount) throw new Error("外部模型任务不存在");
    await this.pool.query("UPDATE task_attempts SET status='failed',payload=payload || $2 WHERE id=$1", [input.attemptId, { reason: input.reason }]);
    return modelTaskFromRow(result.rows[0]);
  }

  private async reopenExpiredModelTasks(): Promise<void> {
    await this.pool.query(
      `UPDATE model_tasks mt SET status='pending',updated_at=now()
       WHERE mt.status IN ('claimed','running') AND NOT EXISTS (
         SELECT 1 FROM task_attempts ta WHERE ta.task_id=mt.id AND ta.status IN ('claimed','running') AND ta.lease_expires_at>now()
       )`,
    );
  }

  async searchMemory(input: { projectId: string; facets: RetrievalFacet[]; narrativeCutoff?: number; povCharacterId?: string }): Promise<MemoryHit[]> {
    // P2-G1: 词法检索 SQL 修正为 OR 匹配
    // 设计依据：AGENTS.md「root-cause analysis」——原实现 `pattern = '%${terms.join(" ")}%'`
    // 把多关键词拼成精确短语匹配（如 "李雷 韩梅梅 学校" → '%李雷 韩梅梅 学校%'），
    // 只有 content 包含完整连续短语才命中，导致单个关键词命中也无法召回。
    // 修正为：每个 term 独立 ILIKE OR 匹配，任一关键词命中即召回，
    // 再用命中数（lexicalRank）做排序权重。
    //
    // P2-G2: 同时计算 lexicalRank（命中 term 数 / 总 term 数），
    // 让 buildMemoryBundle 能做三轨加权融合（semantic + lexical + graph）。
    const results: MemoryHit[] = [];
    for (const facet of input.facets) {
      const terms = facet.query.split(/\s+/u).filter(Boolean).slice(0, 8);
      if (terms.length === 0) continue;
      // 每个 term 在 WHERE 子句和 SELECT lexical_rank 中复用同一参数占位符（PostgreSQL 支持）
      const params: unknown[] = [input.projectId];
      const orClauses: string[] = [];
      for (const term of terms) {
        params.push(`%${term}%`);
        const contentParam = params.length;
        params.push(`%${term}%`);
        const titleParam = params.length;
        orClauses.push(`content ILIKE $${contentParam} OR title ILIKE $${titleParam}`);
      }
      params.push(terms);
      orClauses.push(`subject_refs && $${params.length}`);
      let extra = "";
      if (input.narrativeCutoff !== undefined) {
        params.push(input.narrativeCutoff);
        extra += ` AND (narrative_start IS NULL OR narrative_start <= $${params.length})`;
      }
      // lexical_rank 表达式：复用 $2..$(2+terms.length*2-1) 参数
      // 每 term 占 2 个参数位（content pattern + title pattern），从 $2 开始
      const lexicalRankSelect = terms.map((_, idx) => {
        const contentParam = 2 + idx * 2;
        const titleParam = 3 + idx * 2;
        return `(CASE WHEN content ILIKE $${contentParam} OR title ILIKE $${titleParam} THEN 1 ELSE 0 END)`;
      }).join(" + ");
      const sql = `SELECT *, (${lexicalRankSelect})::REAL / ${terms.length} AS lexical_rank FROM memory_claims WHERE project_id = $1 AND authority IN ('approved','author','derived') AND (${orClauses.join(" OR ")}) ${extra} ORDER BY lexical_rank DESC, confidence DESC, created_at DESC LIMIT 32`;
      const rows = await this.pool.query<any>(sql, params);
      for (const row of rows.rows) {
        if (facet.knowledgeCharacterId && row.knowledge_scope?.characterId && row.knowledge_scope.characterId !== facet.knowledgeCharacterId) continue;
        const lexicalRank = Number(row.lexical_rank ?? 0);
        results.push({
          id: row.id,
          projectId: row.project_id,
          kind: row.kind,
          title: row.title,
          content: row.content,
          subjectRefs: row.subject_refs ?? [],
          narrativeRange: { start: row.narrative_start ?? undefined, end: row.narrative_end ?? undefined },
          knowledgeScope: row.knowledge_scope,
          authority: row.authority,
          confidence: Number(row.confidence),
          sourceRevisionIds: row.source_revision_ids ?? [],
          contentHash: row.content_hash,
          supersedes: row.supersedes ?? [],
          predicate: row.predicate ?? undefined,
          sourceArtifactId: row.source_artifact_id ?? undefined,
          decidedBy: row.decided_by ?? undefined,
          decidedAt: row.decided_at ? iso(row.decided_at) : undefined,
          // P2-G2: score 用 lexicalRank 加权（0.7 lexical + 0.3 confidence）
          score: 0.7 * lexicalRank + 0.3 * Number(row.confidence),
          matchedFacet: facet.kind,
          reason: `postgres lexical match:${facet.kind}`,
          // P2-G2: 填充 lexicalRank 字段，让 buildMemoryBundle 三轨融合能识别
          lexicalRank,
        });
      }
    }
    const merged = new Map<string, MemoryHit>();
    for (const hit of results) {
      const existing = merged.get(hit.id);
      if (!existing) {
        merged.set(hit.id, { ...hit, matchedFacets: [hit.matchedFacet] });
        continue;
      }
      const preferred = hit.score > existing.score ? hit : existing;
      merged.set(hit.id, {
        ...preferred,
        matchedFacets: [...new Set([...(existing.matchedFacets ?? [existing.matchedFacet]), hit.matchedFacet])],
        lexicalRank: Math.max(existing.lexicalRank ?? 0, hit.lexicalRank ?? 0),
        reason: `${existing.reason} | ${hit.reason}`,
      });
    }
    return [...merged.values()];
  }

  async ensureProject(projectId: string, title = projectId, metadata?: Record<string, unknown>) {
    if (metadata && Object.keys(metadata).length) {
      // Phase 3.3: 支持 premise/genre 等元数据写入（题材通用差异化，不内置金手指/系统流特化）
      await this.pool.query(
        "INSERT INTO novel_projects(id, title, metadata) VALUES($1, $2, $3::jsonb) ON CONFLICT(id) DO UPDATE SET title=COALESCE(NULLIF(EXCLUDED.title,''), novel_projects.title), metadata=novel_projects.metadata || EXCLUDED.metadata, updated_at=now()",
        [projectId, title, JSON.stringify(metadata)],
      );
    } else {
      await this.pool.query("INSERT INTO novel_projects(id, title) VALUES($1, $2) ON CONFLICT(id) DO UPDATE SET title=COALESCE(NULLIF(EXCLUDED.title,''), novel_projects.title), updated_at=now()", [projectId, title]);
    }
  }

  async listProjects() {
    const result = await this.pool.query(`
      SELECT p.id,p.title,p.current_revision,p.metadata,p.created_at,p.updated_at,
        latest.status AS latest_run_status
      FROM novel_projects p
      LEFT JOIN LATERAL (
        SELECT status FROM workflow_runs r WHERE r.project_id=p.id ORDER BY r.updated_at DESC LIMIT 1
      ) latest ON TRUE
      ORDER BY p.updated_at DESC
    `);
    return result.rows.map((row: ProjectRow & { latest_run_status?: string | null }) => ({ id: row.id, title: row.title, currentRevision: Number(row.current_revision), current_revision: Number(row.current_revision), metadata: row.metadata ?? {}, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), updated_at: iso(row.updated_at), latestRunStatus: row.latest_run_status ?? undefined }));
  }

  async getProjectDetail(projectId: string): Promise<NovelProjectDetail> {
    const project = await this.pool.query<ProjectRow>("SELECT id,title,current_revision,metadata,created_at,updated_at FROM novel_projects WHERE id=$1", [projectId]);
    if (!project.rowCount) throw new Error("项目不存在");
    const documents = await this.pool.query<DocumentRow>(`
      SELECT d.id,d.project_id,d.title,d.narrative_order,d.pov_character_id,d.current_revision_id,d.status,d.created_at,d.updated_at,
        COALESCE(cb.word_count, 0) AS word_count,
        mr.revision AS latest_revision,
        cps.chapter_goal,
        COUNT(crsi.id)::int AS blocking_issue_count,
        crs.overall_score AS review_score,crs.verdict AS review_verdict,
        CASE WHEN crs.id IS NULL THEN NULL ELSE crs.reviewed_content_hash<>mr.content_hash END AS review_stale,
        a.id AS arc_id,a.title AS arc_title,a.planning_status AS arc_planning_status
      FROM manuscript_documents d
      LEFT JOIN chapters ch ON ch.document_id=d.id
      LEFT JOIN arcs a ON a.id=ch.arc_id
      LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
      LEFT JOIN content_blobs cb ON cb.content_hash=mr.content_hash
      LEFT JOIN chapter_production_specs cps ON cps.document_id=d.id
      LEFT JOIN chapter_review_snapshots crs ON crs.document_id=d.id
      LEFT JOIN chapter_review_snapshot_issues crsi ON crsi.snapshot_id=crs.id AND crsi.severity='blocker' AND crsi.status='pending'
      WHERE d.project_id=$1
      GROUP BY d.id,d.project_id,d.title,d.narrative_order,d.pov_character_id,d.current_revision_id,d.status,d.created_at,d.updated_at,cb.word_count,mr.revision,cps.chapter_goal,crs.id,crs.overall_score,crs.verdict,crs.reviewed_content_hash,mr.content_hash,a.id,a.title,a.planning_status
      ORDER BY d.narrative_order,d.id
    `, [projectId]);
    const runs = await this.listProjectRuns(projectId, 5);
    const row = project.rows[0];
    return { id: row.id, title: row.title, currentRevision: Number(row.current_revision), metadata: row.metadata ?? {}, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), documents: documents.rows.map(documentFromRow), latestRuns: runs };
  }

  async ensureDocument(input: { projectId: string; documentId?: string; title: string; narrativeOrder?: number; povCharacterId?: string; status?: string; chapterGoal?: string }): Promise<ManuscriptDocumentSummary> {
    await this.ensureProject(input.projectId);
    const id = input.documentId?.trim() || randomUUID();
    const order = input.narrativeOrder ?? await this.nextDocumentOrder(input.projectId);
    const result = await this.pool.query<DocumentRow>(`INSERT INTO manuscript_documents(id,project_id,title,narrative_order,pov_character_id,status)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(project_id,narrative_order) DO UPDATE SET title=EXCLUDED.title,pov_character_id=EXCLUDED.pov_character_id,status=EXCLUDED.status,updated_at=now()
      RETURNING id,project_id,title,narrative_order,pov_character_id,current_revision_id,status,created_at,updated_at`, [id, input.projectId, input.title, order, input.povCharacterId ?? null, input.status ?? "planned"]);
    const document = documentFromRow(result.rows[0]);
    await this.upsertChapterProductionSpec({ projectId: input.projectId, documentId: document.id, chapterGoal: input.chapterGoal });
    return document;
  }

  async updateProject(input: { projectId: string; title?: string; metadata?: Record<string, unknown> }) {
    const result = await this.pool.query<ProjectRow>(`
      UPDATE novel_projects
      SET title=COALESCE($2, title),
          metadata=(metadata || COALESCE($3, '{}'::jsonb)) - CASE WHEN $2::text IS NULL THEN '__unchanged__' ELSE 'bookTitleCandidates' END,
          updated_at=now()
      WHERE id=$1
      RETURNING id,title,current_revision,metadata,created_at,updated_at
    `, [input.projectId, input.title ?? null, input.metadata ?? null]);
    if (!result.rowCount) throw new Error("项目不存在");
    await this.appendOutbox("novel-project", input.projectId, "project.updated", { projectId: input.projectId, title: input.title });
    return this.getProjectDetail(input.projectId);
  }

  async recordPromptExecution(input: ModelPromptExecution, objects: ObjectStoreAdapter): Promise<void> {
    if (!input.workflowRunId || !input.taskId) return;
    const promptObject = await objects.putText(JSON.stringify({ system: input.system, prompt: input.prompt }));
    const responseObject = input.response === undefined ? undefined : await objects.putText(input.response);
    const retentionDays = Math.max(1, Number(process.env.NOVEL_PROMPT_RETENTION_DAYS ?? 30));
    const id = `prompt:${randomUUID()}`;
    await this.pool.query(
      `INSERT INTO prompt_executions(id,workflow_run_id,task_id,purpose,candidate_index,status,prompt_fingerprint,response_fingerprint,prompt_object_key,response_object_key,context_manifest,error_category,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+($13::text || ' days')::interval)`,
      [id, input.workflowRunId, input.taskId, input.purpose, input.candidateIndex, input.status, input.promptFingerprint, responseObject?.hash ?? null, promptObject.key, responseObject?.key ?? null, input.contextManifest ?? null, input.errorCategory ?? null, retentionDays],
    );
  }

  async listPromptExecutions(workflowId: string) {
    const result = await this.pool.query<{
      id: string; workflow_run_id: string; task_id: string; purpose: string; candidate_index: number; status: string;
      prompt_fingerprint: string; response_fingerprint: string | null; prompt_object_key: string | null; response_object_key: string | null;
      context_manifest: Record<string, unknown> | null; error_category: string | null; expires_at: Date | string; created_at: Date | string;
    }>(`SELECT * FROM prompt_executions WHERE workflow_run_id=$1 ORDER BY created_at,id`, [workflowId]);
    return result.rows.map((row) => ({
      id: row.id,
      workflowId: row.workflow_run_id,
      taskId: row.task_id,
      purpose: row.purpose,
      candidateIndex: row.candidate_index,
      status: row.status,
      promptFingerprint: row.prompt_fingerprint,
      responseFingerprint: row.response_fingerprint ?? undefined,
      contextManifest: row.context_manifest ?? undefined,
      errorCategory: row.error_category ?? undefined,
      expiresAt: iso(row.expires_at),
      createdAt: iso(row.created_at),
      snapshotAvailable: Boolean(row.prompt_object_key) && new Date(row.expires_at).getTime() > Date.now(),
    }));
  }

  async getPromptExecutionSnapshot(id: string, objects: ObjectStoreAdapter) {
    const result = await this.pool.query<{ prompt_object_key: string | null; response_object_key: string | null }>("SELECT prompt_object_key,response_object_key FROM prompt_executions WHERE id=$1 AND expires_at>now()", [id]);
    const row = result.rows[0];
    if (!row?.prompt_object_key) return undefined;
    return {
      prompt: await objects.getText(row.prompt_object_key),
      response: row.response_object_key ? await objects.getText(row.response_object_key) : undefined,
    };
  }

  async cleanupExpiredPromptExecutions(): Promise<{ deleted: number; orphanedObjectKeys: string[] }> {
    const expired = await this.pool.query<{ prompt_object_key: string | null; response_object_key: string | null }>(`
      WITH snapshots AS (
        SELECT id,prompt_object_key,response_object_key FROM prompt_executions
        WHERE expires_at<=now() AND (prompt_object_key IS NOT NULL OR response_object_key IS NOT NULL)
        FOR UPDATE
      ), cleared AS (
        UPDATE prompt_executions AS execution
        SET prompt_object_key=NULL,response_object_key=NULL
        FROM snapshots WHERE execution.id=snapshots.id
        RETURNING snapshots.prompt_object_key,snapshots.response_object_key
      )
      SELECT * FROM cleared
    `);
    const keys = [...new Set(expired.rows.flatMap((row) => [row.prompt_object_key, row.response_object_key]).filter((key): key is string => Boolean(key)))];
    if (!keys.length) return { deleted: 0, orphanedObjectKeys: [] };
    const referenced = await this.pool.query<{ object_key: string }>(`
      SELECT prompt_object_key AS object_key FROM prompt_executions WHERE prompt_object_key=ANY($1)
      UNION SELECT response_object_key FROM prompt_executions WHERE response_object_key=ANY($1)
      UNION SELECT object_key FROM content_blobs WHERE object_key=ANY($1)
      UNION SELECT object_key FROM artifacts WHERE object_key=ANY($1)
    `, [keys]);
    const retained = new Set(referenced.rows.map((row) => row.object_key));
    return { deleted: expired.rowCount ?? 0, orphanedObjectKeys: keys.filter((key) => !retained.has(key)) };
  }

  async saveBookSynopsisIfCurrent(input: { projectId: string; sourceFingerprint: string; synopsis: BookSynopsisRecord }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sectionRows = await client.query<ProjectPlanSectionRow>(
        `SELECT project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at
         FROM project_plan_sections WHERE project_id=$1 FOR UPDATE`,
        [input.projectId],
      );
      const project = await client.query<ProjectRow>(
        "SELECT id,title,current_revision,metadata,created_at,updated_at FROM novel_projects WHERE id=$1 FOR UPDATE",
        [input.projectId],
      );
      if (!project.rowCount) throw new Error("项目不存在");
      const byKey = new Map(sectionRows.rows.map((row) => [row.task_key, projectPlanSectionFromRow(row)]));
      const sections = PROJECT_PLAN_STAGES.flatMap((stage) => {
        const section = byKey.get(stage.taskKey);
        return section ? [section] : [];
      });
      const currentFingerprint = bookSynopsisSourceFingerprint({ projectTitle: project.rows[0].title, sections });
      if (currentFingerprint !== input.sourceFingerprint) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        "UPDATE novel_projects SET metadata=metadata || $2::jsonb,updated_at=now() WHERE id=$1",
        [input.projectId, { bookSynopsis: input.synopsis }],
      );
      await client.query("COMMIT");
      await this.appendOutbox("novel-project", input.projectId, "project.synopsis-updated", { projectId: input.projectId, sourceFingerprint: input.sourceFingerprint });
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveBookTitleCandidatesIfCurrent(input: { projectId: string; sourceFingerprint: string; candidates: BookTitleCandidatesRecord }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sectionRows = await client.query<ProjectPlanSectionRow>(
        `SELECT project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at
         FROM project_plan_sections WHERE project_id=$1 FOR UPDATE`,
        [input.projectId],
      );
      const project = await client.query<ProjectRow>(
        "SELECT id,title,current_revision,metadata,created_at,updated_at FROM novel_projects WHERE id=$1 FOR UPDATE",
        [input.projectId],
      );
      if (!project.rowCount) throw new Error("项目不存在");
      const byKey = new Map(sectionRows.rows.map((row) => [row.task_key, projectPlanSectionFromRow(row)]));
      const sections = PROJECT_PLAN_STAGES.flatMap((stage) => {
        const section = byKey.get(stage.taskKey);
        return section ? [section] : [];
      });
      if (bookTitleSourceFingerprint(sections) !== input.sourceFingerprint) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        "UPDATE novel_projects SET metadata=metadata || $2::jsonb,updated_at=now() WHERE id=$1",
        [input.projectId, { bookTitleCandidates: input.candidates }],
      );
      await client.query("COMMIT");
      await this.appendOutbox("novel-project", input.projectId, "project.title-candidates-updated", { projectId: input.projectId, sourceFingerprint: input.sourceFingerprint });
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async selectBookTitleCandidate(input: { projectId: string; sourceFingerprint: string; title: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sectionRows = await client.query<ProjectPlanSectionRow>(
        `SELECT project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at
         FROM project_plan_sections WHERE project_id=$1 FOR UPDATE`,
        [input.projectId],
      );
      const project = await client.query<ProjectRow>(
        "SELECT id,title,current_revision,metadata,created_at,updated_at FROM novel_projects WHERE id=$1 FOR UPDATE",
        [input.projectId],
      );
      if (!project.rowCount) throw new Error("项目不存在");
      const byKey = new Map(sectionRows.rows.map((row) => [row.task_key, projectPlanSectionFromRow(row)]));
      const sections = PROJECT_PLAN_STAGES.flatMap((stage) => {
        const section = byKey.get(stage.taskKey);
        return section ? [section] : [];
      });
      if (bookTitleSourceFingerprint(sections) !== input.sourceFingerprint) throw new Error("全书规划已变化，请重新生成书名候选");
      const candidates = parseBookTitleCandidatesMetadata(project.rows[0].metadata);
      if (!candidates || candidates.sourceFingerprint !== input.sourceFingerprint) throw new Error("书名候选已失效，请重新生成");
      const selected = candidates.candidates.find((candidate) => candidate.title === input.title.trim());
      if (!selected) throw new Error("只能选择当前书名候选中的一项");
      await client.query(
        "UPDATE novel_projects SET title=$2,metadata=metadata - 'bookTitleCandidates',updated_at=now() WHERE id=$1",
        [input.projectId, selected.title],
      );
      await client.query("COMMIT");
      await this.appendOutbox("novel-project", input.projectId, "project.title-selected", { projectId: input.projectId, title: selected.title, sourceFingerprint: input.sourceFingerprint });
      return this.getProjectDetail(input.projectId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteProject(projectId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM task_attempts WHERE workflow_run_id IN (SELECT temporal_workflow_id FROM workflow_runs WHERE project_id=$1) OR workflow_run_id IN (SELECT id FROM workflow_runs WHERE project_id=$1)", [projectId]);
      await client.query("DELETE FROM workflow_runs WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM learning_assessments WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM context_manifests WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM retrieval_runs WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM execution_blueprints WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM skill_bundles WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM memory_bundles WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM preflight_plans WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM novel_intents WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM memory_claims WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM reviews WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM artifacts WHERE project_id=$1", [projectId]);
      const result = await client.query("DELETE FROM novel_projects WHERE id=$1 RETURNING id", [projectId]);
      await client.query("COMMIT");
      return { deleted: Boolean(result.rowCount), projectId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async updateDocument(input: { projectId: string; documentId: string; title?: string; narrativeOrder?: number; povCharacterId?: string | null; status?: string; chapterGoal?: string }): Promise<ManuscriptDocumentSummary> {
    const result = await this.pool.query<DocumentRow>(`
      UPDATE manuscript_documents
      SET title=COALESCE($3, title),
        narrative_order=COALESCE($4, narrative_order),
        pov_character_id=CASE WHEN $5::boolean THEN $6 ELSE pov_character_id END,
        status=COALESCE($7, status),
        updated_at=now()
      WHERE project_id=$1 AND id=$2
      RETURNING id,project_id,title,narrative_order,pov_character_id,current_revision_id,status,created_at,updated_at
    `, [input.projectId, input.documentId, input.title ?? null, input.narrativeOrder ?? null, input.povCharacterId !== undefined, input.povCharacterId ?? null, input.status ?? null]);
    if (!result.rowCount) throw new Error("章节不存在");
    if (input.chapterGoal !== undefined) await this.upsertChapterProductionSpec({ projectId: input.projectId, documentId: input.documentId, chapterGoal: input.chapterGoal });
    await this.appendOutbox("manuscript-document", input.documentId, "document.updated", { projectId: input.projectId, documentId: input.documentId });
    return documentFromRow(result.rows[0]);
  }

  async deleteDocument(projectId: string, documentId: string) {
    const result = await this.pool.query("DELETE FROM manuscript_documents WHERE project_id=$1 AND id=$2 RETURNING id", [projectId, documentId]);
    await this.appendOutbox("manuscript-document", documentId, "document.deleted", { projectId, documentId, deleted: Boolean(result.rowCount) });
    return { deleted: Boolean(result.rowCount), projectId, documentId };
  }

  private async nextDocumentOrder(projectId: string): Promise<number> {
    const result = await this.pool.query<{ next_order: number }>("SELECT COALESCE(MAX(narrative_order),0)+1 AS next_order FROM manuscript_documents WHERE project_id=$1", [projectId]);
    return Number(result.rows[0]?.next_order ?? 1);
  }

  async getRecord(table: "preflight_plans" | "memory_bundles" | "skill_bundles" | "execution_blueprints" | "artifacts" | "context_manifests" | "learning_assessments", id: string) {
    const result = await this.pool.query(`SELECT payload FROM ${table} WHERE id=$1`, [id]);
    return result.rows[0]?.payload ?? null;
  }

  async listOutbox(projectId?: string, afterId = 0) {
    const result = await this.pool.query("SELECT id,aggregate_type,aggregate_id,event_type,payload,created_at FROM outbox_events WHERE id>$1 AND ($2::text IS NULL OR payload->>'projectId'=$2) ORDER BY id LIMIT 200", [afterId, projectId ?? null]);
    return result.rows;
  }

  async putReview(review: Review, options: { refreshChapterSnapshot?: boolean } = {}) {
    // pg 对 JS 数组使用 PostgreSQL array literal 序列化（{elem1,elem2}），而非 JSON。
    // issues 是 JS 对象数组，直接传给 jsonb 列会导致 "invalid input syntax for type json" 错误。
    // 修复：显式 JSON.stringify，让 pg 以字符串参数发送，PostgreSQL 再解析为 jsonb。
    // modelProvenance 是对象，pg 本身会正确序列化为 JSON，但显式 stringify 保持一致性。
    await this.pool.query("INSERT INTO reviews(id,project_id,artifact_id,reviewer_id,identity,verdict,artifact_fingerprint,issues,model_provenance,score,role,dimension_scores) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING", [review.id, review.projectId, review.artifactId, review.reviewerId, review.identity, review.verdict, review.artifactFingerprint, JSON.stringify(review.issues), review.modelProvenance ? JSON.stringify(review.modelProvenance) : null, review.score ?? null, review.role ?? null, JSON.stringify(review.dimensionScores ?? {})]);
    if (options.refreshChapterSnapshot !== false) await this.refreshChapterReviewSnapshot(review.artifactId);
    return review;
  }

  async getReviewsByIds(ids: string[]): Promise<Review[]> {
    if (!ids.length) return [];
    const result = await this.pool.query<any>("SELECT * FROM reviews WHERE id=ANY($1::text[])", [ids]);
    const byId = new Map<string, Review>(result.rows.map((row) => [row.id, {
      id: row.id,
      projectId: row.project_id,
      artifactId: row.artifact_id,
      reviewerId: row.reviewer_id,
      identity: row.identity,
      verdict: row.verdict,
      artifactFingerprint: row.artifact_fingerprint,
      issues: row.issues ?? [],
      score: row.score === null ? undefined : Number(row.score),
      role: row.role ?? undefined,
      dimensionScores: row.dimension_scores ?? {},
      modelProvenance: row.model_provenance ?? undefined,
      createdAt: new Date(row.created_at).getTime(),
    }]));
    return ids.flatMap((id) => {
      const review = byId.get(id);
      return review ? [review] : [];
    });
  }

  async expireModelTask(taskId: string, reason: string): Promise<void> {
    await this.pool.query(
      "UPDATE model_tasks SET status='failed',result=$2,updated_at=now() WHERE id=$1 AND status IN ('pending','claimed','running')",
      [taskId, { value: { reason, expired: true } }],
    );
    await this.pool.query("UPDATE task_attempts SET status='failed',payload=payload || $2 WHERE task_id=$1 AND status IN ('claimed','running')", [taskId, { reason, expired: true }]);
  }

  async expireWorkflowModelTasks(workflowRunId: string, reason: string): Promise<number> {
    const result = await this.pool.query(
      "UPDATE model_tasks SET status='failed',result=$2,updated_at=now() WHERE workflow_run_id=$1 AND status IN ('pending','claimed','running')",
      [workflowRunId, { text: "", value: { reason } }],
    );
    return result.rowCount ?? 0;
  }

  async listIndexableMemoryClaims(input: { offset?: number; limit?: number; projectId?: string } = {}): Promise<MemoryClaim[]> {
    const result = await this.pool.query<any>(
      `SELECT * FROM memory_claims
       WHERE authority IN ('approved','author','derived') AND ($3::text IS NULL OR project_id=$3)
       ORDER BY project_id,created_at,id OFFSET $1 LIMIT $2`,
      [input.offset ?? 0, input.limit ?? 500, input.projectId ?? null],
    );
    return result.rows.map((row: any) => ({
      id: row.id, projectId: row.project_id, kind: row.kind, title: row.title, content: row.content,
      subjectRefs: row.subject_refs ?? [], narrativeRange: { start: row.narrative_start ?? undefined, end: row.narrative_end ?? undefined },
      knowledgeScope: row.knowledge_scope, authority: row.authority, confidence: Number(row.confidence),
      sourceRevisionIds: row.source_revision_ids ?? [], contentHash: row.content_hash, supersedes: row.supersedes ?? [],
      predicate: row.predicate ?? undefined, sourceArtifactId: row.source_artifact_id ?? undefined,
    }));
  }

  async countIndexableMemoryClaims(): Promise<number> {
    const claims = await this.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM memory_claims WHERE authority IN ('approved','author','derived')");
    const chapters = await this.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM chapter_memories");
    return Number(claims.rows[0]?.count ?? 0) + Number(chapters.rows[0]?.count ?? 0);
  }

  async listAllChapterMemories(input: { offset?: number; limit?: number; projectId?: string } = {}): Promise<ChapterMemory[]> {
    const result = await this.pool.query<any>("SELECT * FROM chapter_memories WHERE ($3::text IS NULL OR project_id=$3) ORDER BY project_id,narrative_start,id OFFSET $1 LIMIT $2", [input.offset ?? 0, input.limit ?? 500, input.projectId ?? null]);
    return result.rows.map((row: any) => ({
      id: row.id, projectId: row.project_id, documentId: row.document_id, revisionId: row.revision_id,
      narrativeRange: { start: Number(row.narrative_start), end: Number(row.narrative_end) }, summary: row.summary,
      keyEvents: row.key_events ?? [], characterStates: row.character_states ?? [], unresolvedThreads: row.unresolved_threads ?? [],
      emotionalArc: row.emotional_arc ?? undefined, fingerprint: row.fingerprint, createdAt: new Date(row.created_at).getTime(),
    }));
  }

  async upsertChapterProductionSpec(input: { projectId: string; documentId: string; chapterGoal?: string; blueprint?: Record<string, unknown>; blueprintFingerprint?: string; sourceArtifactId?: string }) {
    const result = await this.pool.query(`
      INSERT INTO chapter_production_specs(document_id,project_id,chapter_goal,blueprint,blueprint_fingerprint,source_artifact_id)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(document_id) DO UPDATE SET
        chapter_goal=CASE WHEN $7::boolean THEN EXCLUDED.chapter_goal ELSE chapter_production_specs.chapter_goal END,
        blueprint=CASE WHEN $8::boolean THEN EXCLUDED.blueprint ELSE chapter_production_specs.blueprint END,
        blueprint_fingerprint=CASE WHEN $8::boolean THEN EXCLUDED.blueprint_fingerprint ELSE chapter_production_specs.blueprint_fingerprint END,
        source_artifact_id=CASE WHEN $8::boolean THEN EXCLUDED.source_artifact_id ELSE chapter_production_specs.source_artifact_id END,
        updated_at=now()
      RETURNING document_id,project_id,chapter_goal,blueprint,blueprint_fingerprint,source_artifact_id,updated_at
    `, [input.documentId, input.projectId, input.chapterGoal ?? "", JSON.stringify(input.blueprint ?? {}), input.blueprintFingerprint ?? "", input.sourceArtifactId ?? null, input.chapterGoal !== undefined, input.blueprint !== undefined]);
    return result.rows[0];
  }

  async getChapterWorkspace(projectId: string, documentId: string) {
    const document = await this.pool.query(`
      SELECT d.id,d.project_id,d.title,d.narrative_order,d.pov_character_id,d.current_revision_id,d.status,d.created_at,d.updated_at,
        mr.revision,mr.content_hash,cb.object_key,cb.byte_length,
        cps.chapter_goal,cps.blueprint,cps.blueprint_fingerprint,cps.updated_at AS spec_updated_at,
        crs.id AS review_id,crs.revision_id AS reviewed_revision_id,crs.reviewed_content_hash,crs.artifact_fingerprint,
        crs.source_workflow_id,crs.verdict,crs.complete,crs.overall_score,crs.dimension_scores,crs.reviewer_roles,crs.reviewed_at
      FROM manuscript_documents d
      LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
      LEFT JOIN content_blobs cb ON cb.content_hash=mr.content_hash
      LEFT JOIN chapter_production_specs cps ON cps.document_id=d.id
      LEFT JOIN chapter_review_snapshots crs ON crs.document_id=d.id
      WHERE d.project_id=$1 AND d.id=$2
    `, [projectId, documentId]);
    if (!document.rowCount) return undefined;
    const row = document.rows[0];
    const issues = row.review_id ? await this.pool.query(`
      SELECT id,issue_fingerprint,dimension,severity,title,description,evidence_quote,paragraph,revision_ranges,rule,suggestion,source_roles,status,updated_at
      FROM chapter_review_snapshot_issues WHERE snapshot_id=$1
      ORDER BY CASE severity WHEN 'blocker' THEN 0 WHEN 'major' THEN 1 ELSE 2 END,created_at,id
    `, [row.review_id]) : { rows: [] };
    const versions = await this.pool.query(`
      SELECT mr.id,mr.revision,mr.content_hash,mr.retention_class,mr.label,mr.expires_at,mr.created_at,
        mr.id=d.current_revision_id AS is_current
      FROM manuscript_revisions mr JOIN manuscript_documents d ON d.id=mr.document_id
      WHERE mr.project_id=$1 AND mr.document_id=$2
      ORDER BY mr.revision DESC LIMIT 20
    `, [projectId, documentId]);
    return {
      document: {
        id: row.id, projectId: row.project_id, title: row.title, narrativeOrder: Number(row.narrative_order),
        povCharacterId: row.pov_character_id ?? undefined, status: row.status, currentRevisionId: row.current_revision_id ?? undefined,
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      },
      content: row.current_revision_id ? { revisionId: row.current_revision_id, revision: Number(row.revision), contentHash: row.content_hash, objectKey: row.object_key, byteLength: Number(row.byte_length ?? 0) } : undefined,
      spec: { chapterGoal: row.chapter_goal ?? "", blueprint: row.blueprint ?? {}, blueprintFingerprint: row.blueprint_fingerprint ?? "", updatedAt: row.spec_updated_at ? iso(row.spec_updated_at) : undefined },
      review: row.review_id ? {
        id: row.review_id, revisionId: row.reviewed_revision_id ?? undefined, reviewedContentHash: row.reviewed_content_hash,
        artifactFingerprint: row.artifact_fingerprint, sourceWorkflowId: row.source_workflow_id ?? undefined, verdict: row.verdict,
        complete: row.complete, overallScore: row.overall_score === null ? undefined : Number(row.overall_score), dimensionScores: row.dimension_scores ?? {},
        reviewerRoles: row.reviewer_roles ?? [], reviewedAt: iso(row.reviewed_at), stale: row.reviewed_content_hash !== row.content_hash,
        issues: issues.rows.map((issue) => ({ id: issue.id, fingerprint: issue.issue_fingerprint, dimension: issue.dimension ?? undefined, severity: issue.severity, title: issue.title, description: issue.description ?? undefined, evidenceQuote: issue.evidence_quote, paragraph: issue.paragraph ?? undefined, revisionRanges: issue.revision_ranges ?? [], rule: issue.rule ?? undefined, suggestion: issue.suggestion ?? undefined, sourceRoles: issue.source_roles ?? [], status: issue.status, updatedAt: iso(issue.updated_at) })),
      } : undefined,
      versions: versions.rows.map((version) => ({ id: version.id, revision: Number(version.revision), contentHash: version.content_hash, retentionClass: version.retention_class, label: version.label ?? undefined, expiresAt: version.expires_at ? iso(version.expires_at) : undefined, createdAt: iso(version.created_at), current: version.is_current })),
    };
  }

  async updateChapterReviewIssueStatus(input: { projectId: string; documentId: string; issueId: string; status: ChapterReviewIssueStatus }) {
    const result = await this.pool.query(`
      UPDATE chapter_review_snapshot_issues i SET status=$4,updated_at=now()
      FROM chapter_review_snapshots s
      WHERE i.snapshot_id=s.id AND s.project_id=$1 AND s.document_id=$2 AND i.id=$3
      RETURNING i.id,i.status,i.updated_at
    `, [input.projectId, input.documentId, input.issueId, input.status]);
    if (!result.rowCount) throw new Error("审核意见不存在");
    return { id: result.rows[0].id, status: result.rows[0].status, updatedAt: iso(result.rows[0].updated_at) };
  }

  async addChapterReviewIssue(input: {
    projectId: string;
    documentId: string;
    severity: ReviewIssue["severity"];
    title: string;
    description?: string;
    evidenceQuote?: string;
    paragraph?: number;
    suggestion?: string;
  }) {
    const title = input.title.trim();
    const evidenceQuote = input.evidenceQuote?.trim() || title;
    const suggestion = input.suggestion?.trim() || undefined;
    if (!title) throw new Error("审核意见标题不能为空");
    const snapshot = await this.pool.query<{ id: string; reviewed_content_hash: string; current_content_hash: string | null; complete: boolean }>(`
      SELECT s.id,s.reviewed_content_hash,mr.content_hash AS current_content_hash,s.complete
      FROM chapter_review_snapshots s
      JOIN manuscript_documents d ON d.id=s.document_id AND d.project_id=s.project_id
      LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
      WHERE s.project_id=$1 AND s.document_id=$2
    `, [input.projectId, input.documentId]);
    const current = snapshot.rows[0];
    if (!current?.complete) throw new Error("当前章节没有完整审核快照");
    if (!current.current_content_hash || current.reviewed_content_hash !== current.current_content_hash) throw new Error("审核快照已过期，请先重新审校当前正文");
    const issue: ReviewIssue = {
      severity: input.severity,
      title,
      description: input.description?.trim() || undefined,
      evidence: evidenceQuote,
      excerpt: evidenceQuote,
      paragraph: input.paragraph,
      revisionRanges: input.paragraph ? [{ start: input.paragraph, end: input.paragraph }] : [],
      suggestion,
      rule: "author-review-note",
    };
    const id = randomUUID();
    const fingerprint = `author:${reviewIssueFingerprint(issue)}:${id}`;
    const result = await this.pool.query(`
      INSERT INTO chapter_review_snapshot_issues(id,snapshot_id,issue_fingerprint,dimension,severity,title,description,evidence_quote,paragraph,revision_ranges,rule,suggestion,source_roles,status)
      VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')
      RETURNING id,issue_fingerprint,dimension,severity,title,description,evidence_quote,paragraph,revision_ranges,rule,suggestion,source_roles,status,updated_at
    `, [id, current.id, fingerprint, input.severity, title, issue.description ?? null, evidenceQuote, input.paragraph ?? null, JSON.stringify(issue.revisionRanges), issue.rule, suggestion ?? null, ["author"]]);
    const row = result.rows[0];
    return { id: row.id, fingerprint: row.issue_fingerprint, dimension: row.dimension ?? undefined, severity: row.severity, title: row.title, description: row.description ?? undefined, evidenceQuote: row.evidence_quote, paragraph: row.paragraph ?? undefined, revisionRanges: row.revision_ranges ?? [], rule: row.rule ?? undefined, suggestion: row.suggestion ?? undefined, sourceRoles: row.source_roles ?? [], status: row.status, updatedAt: iso(row.updated_at) };
  }

  async getTargetedChapterReviewIssues(input: { projectId: string; documentId: string; issueIds: string[] }): Promise<{ snapshotId: string; reviewedContentHash: string; fingerprints: string[]; issues: ReviewIssue[] }> {
    const issueIds = [...new Set(input.issueIds.map((id) => id.trim()).filter(Boolean))];
    if (!issueIds.length) throw new Error("至少选择一条待处理审核意见");
    if (issueIds.length !== input.issueIds.length) throw new Error("目标审核意见不能重复");
    const snapshot = await this.pool.query<{ id: string; reviewed_content_hash: string; current_content_hash: string | null; complete: boolean }>(`
      SELECT s.id,s.reviewed_content_hash,mr.content_hash AS current_content_hash,s.complete
      FROM chapter_review_snapshots s
      JOIN manuscript_documents d ON d.id=s.document_id AND d.project_id=s.project_id
      LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
      WHERE s.project_id=$1 AND s.document_id=$2
    `, [input.projectId, input.documentId]);
    const current = snapshot.rows[0];
    if (!current?.complete) throw new Error("当前章节没有完整审核快照");
    if (!current.current_content_hash || current.reviewed_content_hash !== current.current_content_hash) throw new Error("审核快照已过期，请先重新审校当前正文");
    const rows = await this.pool.query<{
      id: string; issue_fingerprint: string; dimension: string | null; severity: ReviewIssue["severity"]; title: string; description: string | null;
      evidence_quote: string; paragraph: number | null; revision_ranges: Array<{ start: number; end: number }> | null;
      rule: string | null; suggestion: string | null; status: ChapterReviewIssueStatus;
    }>(`
      SELECT id,issue_fingerprint,dimension,severity,title,description,evidence_quote,paragraph,revision_ranges,rule,suggestion,status
      FROM chapter_review_snapshot_issues
      WHERE snapshot_id=$1 AND id=ANY($2::text[])
      ORDER BY id
    `, [current.id, issueIds]);
    if (rows.rowCount !== issueIds.length) throw new Error("部分审核意见不属于当前章节快照");
    if (rows.rows.some((row) => row.status !== "pending")) throw new Error("只能修复状态为待处理的审核意见");
    const issues = rows.rows.map((row): ReviewIssue => ({
      dimension: row.dimension ?? undefined,
      severity: row.severity,
      title: row.title,
      description: row.description ?? undefined,
      evidence: row.evidence_quote,
      excerpt: row.evidence_quote,
      paragraph: row.paragraph ?? undefined,
      revisionRanges: row.revision_ranges ?? [],
      rule: row.rule ?? undefined,
      suggestion: row.suggestion ?? undefined,
    }));
    if (issues.some((issue) => !issue.revisionRanges?.length && !issue.paragraph && !issue.excerpt?.trim())) throw new Error("所选审核意见缺少可定位的正文证据");
    return { snapshotId: current.id, reviewedContentHash: current.reviewed_content_hash, fingerprints: rows.rows.map((row) => row.issue_fingerprint), issues };
  }

  async saveManualRevision(input: { projectId: string; documentId: string; expectedContentHash: string; text: string; contentHash: string; objectKey: string; label?: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ current_revision: string; current_revision_id: string | null; content_hash: string | null }>(`
        SELECT p.current_revision,d.current_revision_id,mr.content_hash
        FROM novel_projects p JOIN manuscript_documents d ON d.project_id=p.id
        LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
        WHERE p.id=$1 AND d.id=$2 FOR UPDATE OF p,d
      `, [input.projectId, input.documentId]);
      if (!current.rowCount) throw new Error("章节不存在");
      if ((current.rows[0].content_hash ?? "") !== input.expectedContentHash) throw new Error("正文已被其他操作更新，请刷新后重新编辑");
      if (input.contentHash === input.expectedContentHash) {
        await client.query("COMMIT");
        return { unchanged: true, revisionId: current.rows[0].current_revision_id, revision: Number(current.rows[0].current_revision), contentHash: input.contentHash };
      }
      const revision = Number(current.rows[0].current_revision) + 1;
      const revisionId = randomUUID();
      if (current.rows[0].current_revision_id) await client.query("UPDATE manuscript_revisions SET retention_class='rolling',expires_at=COALESCE(expires_at,now()+interval '30 days') WHERE id=$1 AND retention_class<>'named'", [current.rows[0].current_revision_id]);
      await client.query("INSERT INTO content_blobs(content_hash,object_key,byte_length,word_count) VALUES($1,$2,$3,$4) ON CONFLICT(content_hash) DO UPDATE SET word_count=COALESCE(content_blobs.word_count,EXCLUDED.word_count)", [input.contentHash, input.objectKey, Buffer.byteLength(input.text, "utf8"), countNovelCharacters(input.text)]);
      await client.query(`
        INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash,retention_class,label,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $7='named' THEN NULL ELSE now()+interval '30 days' END)
      `, [revisionId, input.projectId, input.documentId, revision, Number(current.rows[0].current_revision), input.contentHash, input.label ? "named" : "rolling", input.label ?? null]);
      await client.query("UPDATE manuscript_documents SET current_revision_id=$1,status='final',updated_at=now() WHERE id=$2", [revisionId, input.documentId]);
      await client.query("UPDATE novel_projects SET current_revision=$1,updated_at=now() WHERE id=$2", [revision, input.projectId]);
      await this.appendOutboxTx(client, "manuscript-revision", revisionId, "manuscript-revision.saved", { projectId: input.projectId, documentId: input.documentId, revision, contentHash: input.contentHash, source: "web-author" });
      await client.query("COMMIT");
      return { unchanged: false, revisionId, revision, contentHash: input.contentHash };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async nameManuscriptVersion(input: { projectId: string; documentId: string; revisionId: string; label: string }) {
    const result = await this.pool.query(`UPDATE manuscript_revisions SET retention_class='named',label=$4,expires_at=NULL
      WHERE id=$3 AND project_id=$1 AND document_id=$2 RETURNING id,revision,content_hash,label,created_at`, [input.projectId, input.documentId, input.revisionId, input.label]);
    if (!result.rowCount) throw new Error("正文版本不存在");
    return { id: result.rows[0].id, revision: Number(result.rows[0].revision), contentHash: result.rows[0].content_hash, label: result.rows[0].label, createdAt: iso(result.rows[0].created_at) };
  }

  async restoreManuscriptVersion(input: { projectId: string; documentId: string; revisionId: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const source = await client.query<{ content_hash: string }>("SELECT content_hash FROM manuscript_revisions WHERE id=$3 AND project_id=$1 AND document_id=$2", [input.projectId, input.documentId, input.revisionId]);
      if (!source.rowCount) throw new Error("正文版本不存在");
      const head = await client.query<{ current_revision: string; current_revision_id: string | null }>("SELECT p.current_revision,d.current_revision_id FROM novel_projects p JOIN manuscript_documents d ON d.project_id=p.id WHERE p.id=$1 AND d.id=$2 FOR UPDATE OF p,d", [input.projectId, input.documentId]);
      if (!head.rowCount) throw new Error("章节不存在");
      if (head.rows[0].current_revision_id) await client.query("UPDATE manuscript_revisions SET retention_class='rolling',expires_at=COALESCE(expires_at,now()+interval '30 days') WHERE id=$1 AND retention_class<>'named'", [head.rows[0].current_revision_id]);
      const revision = Number(head.rows[0].current_revision) + 1;
      const revisionId = randomUUID();
      await client.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash,retention_class,expires_at) VALUES($1,$2,$3,$4,$5,$6,'rolling',now()+interval '30 days')", [revisionId, input.projectId, input.documentId, revision, Number(head.rows[0].current_revision), source.rows[0].content_hash]);
      await client.query("UPDATE manuscript_documents SET current_revision_id=$1,status='final',updated_at=now() WHERE id=$2", [revisionId, input.documentId]);
      await client.query("UPDATE novel_projects SET current_revision=$1,updated_at=now() WHERE id=$2", [revision, input.projectId]);
      await this.appendOutboxTx(client, "manuscript-revision", revisionId, "manuscript-revision.restored", { projectId: input.projectId, documentId: input.documentId, revision, sourceRevisionId: input.revisionId });
      await client.query("COMMIT");
      return { revisionId, revision, contentHash: source.rows[0].content_hash };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async cleanupExpiredChapterData(cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)) {
    const eligible = await this.pool.query<WorkflowRunRow>(`
      SELECT id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at
      FROM workflow_runs
      WHERE status IN ('completed','succeeded') AND updated_at<$1
        AND (workflow_type='chapter-review' OR payload#>>'{intent,target,kind}'='chapter' OR payload->>'documentId' IS NOT NULL)
        AND NOT (payload ? 'diagnosticsCleanedAt')
      ORDER BY updated_at LIMIT 100
    `, [cutoff]);
    let artifactsDeleted = 0;
    let runsCompacted = 0;
    for (const run of eligible.rows) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query<WorkflowRunRow>("SELECT id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at FROM workflow_runs WHERE id=$1 FOR UPDATE", [run.id]);
        if (!locked.rowCount || locked.rows[0].payload?.diagnosticsCleanedAt) { await client.query("COMMIT"); continue; }
        const current = locked.rows[0];
        const documentId = typeof current.payload.documentId === "string"
          ? current.payload.documentId
          : typeof (current.payload.intent as { target?: { id?: unknown } } | undefined)?.target?.id === "string"
            ? (current.payload.intent as { target: { id: string } }).target.id
            : null;
        const artifactRows = await client.query<{ id: string }>("SELECT id FROM artifacts WHERE project_id=$1 AND (payload->>'workflowId'=$2 OR payload->>'runId'=$2)", [current.project_id, current.temporal_workflow_id]);
        const artifactIds = artifactRows.rows.map((row) => row.id);
        const reviewCount = artifactIds.length ? await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM reviews WHERE artifact_id=ANY($1::text[])", [artifactIds]) : { rows: [{ count: "0" }] };
        const eventCount = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM outbox_events WHERE (aggregate_type='workflow-run' AND aggregate_id=$1) OR payload->>'workflowId'=$1 OR payload->>'runId'=$1", [current.temporal_workflow_id]);
        const usage = await client.query<{ calls: string; input_tokens: string; output_tokens: string }>("SELECT COUNT(*)::text AS calls,COALESCE(SUM(input_tokens),0)::text AS input_tokens,COALESCE(SUM(output_tokens),0)::text AS output_tokens FROM model_invocations WHERE workflow_run_id=$1", [current.temporal_workflow_id]);
        const elapsedMs = Math.max(0, new Date(current.updated_at).getTime() - new Date(current.created_at).getTime());
        const finalStage = typeof current.payload.stage === "string" ? current.payload.stage : null;
        const failureSummary = typeof current.payload.error === "string" ? current.payload.error.slice(0, 1000) : null;
        await client.query(`
          INSERT INTO workflow_run_summaries(workflow_run_id,project_id,document_id,workflow_type,final_status,final_stage,elapsed_ms,failure_summary,metrics,cleaned_at,completed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10)
          ON CONFLICT(workflow_run_id) DO UPDATE SET cleaned_at=EXCLUDED.cleaned_at,metrics=EXCLUDED.metrics
        `, [current.id, current.project_id, documentId, current.workflow_type, current.status, finalStage, elapsedMs, failureSummary, {
          artifacts: artifactIds.length, reviews: Number(reviewCount.rows[0]?.count ?? 0), events: Number(eventCount.rows[0]?.count ?? 0),
          modelCalls: Number(usage.rows[0]?.calls ?? 0), inputTokens: Number(usage.rows[0]?.input_tokens ?? 0), outputTokens: Number(usage.rows[0]?.output_tokens ?? 0),
        }, current.updated_at]);
        if (artifactIds.length) {
          await client.query("UPDATE manuscript_revisions SET artifact_id=NULL WHERE artifact_id=ANY($1::text[])", [artifactIds]);
          await client.query("DELETE FROM artifacts WHERE id=ANY($1::text[])", [artifactIds]);
        }
        await client.query("DELETE FROM task_attempts WHERE workflow_run_id=$1 OR workflow_run_id=$2", [current.id, current.temporal_workflow_id]);
        await client.query("DELETE FROM model_tasks WHERE workflow_run_id=$1", [current.temporal_workflow_id]);
        await client.query("DELETE FROM outbox_events WHERE (aggregate_type='workflow-run' AND aggregate_id=$1) OR payload->>'workflowId'=$1 OR payload->>'runId'=$1", [current.temporal_workflow_id]);
        const compactPayload = {
          documentId, finalScore: typeof current.payload.finalScore === "number" ? current.payload.finalScore : undefined,
          reasonCode: typeof current.payload.reasonCode === "string" ? current.payload.reasonCode : undefined,
          diagnosticsCleanedAt: new Date().toISOString(),
        };
        await client.query("UPDATE workflow_runs SET payload=$2 WHERE id=$1", [current.id, compactPayload]);
        await client.query("COMMIT");
        artifactsDeleted += artifactIds.length;
        runsCompacted += 1;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    await this.pool.query(`
      WITH ranked AS (
        SELECT mr.id,mr.document_id,mr.expires_at,mr.id=d.current_revision_id AS is_current,
          ROW_NUMBER() OVER(PARTITION BY mr.document_id ORDER BY mr.revision DESC) AS position
        FROM manuscript_revisions mr JOIN manuscript_documents d ON d.id=mr.document_id
        WHERE mr.retention_class='rolling'
      )
      DELETE FROM manuscript_revisions mr USING ranked r
      WHERE mr.id=r.id AND NOT r.is_current AND (r.expires_at<now() OR r.position>10)
    `);
    const orphaned = await this.pool.query<{ content_hash: string; object_key: string }>(`
      DELETE FROM content_blobs cb
      WHERE NOT EXISTS (SELECT 1 FROM manuscript_revisions mr WHERE mr.content_hash=cb.content_hash)
        AND NOT EXISTS (SELECT 1 FROM manuscript_blocks mb WHERE mb.content_hash=cb.content_hash)
        AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.content_hash=cb.content_hash)
      RETURNING content_hash,object_key
    `);
    return { runsCompacted, artifactsDeleted, orphanedObjects: orphaned.rows.map((row) => ({ contentHash: row.content_hash, objectKey: row.object_key })) };
  }

  async refreshChapterReviewSnapshot(artifactId: string, revisionId?: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const refreshed = await this.refreshChapterReviewSnapshotTx(client, artifactId, revisionId);
      await client.query("COMMIT");
      return refreshed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async refreshChapterReviewSnapshotTx(client: PoolClient, artifactId: string, revisionId?: string): Promise<boolean> {
    const subject = await client.query<{
      project_id: string; content_hash: string; fingerprint: string; workflow_id: string | null; document_id: string | null;
    }>(`
      SELECT a.project_id,a.content_hash,a.fingerprint,
        COALESCE(a.payload->>'workflowId',a.payload->>'runId') AS workflow_id,
        COALESCE(w.payload->>'documentId',w.payload#>>'{intent,target,id}',mr.document_id) AS document_id
      FROM artifacts a
      LEFT JOIN workflow_runs w ON w.temporal_workflow_id=COALESCE(a.payload->>'workflowId',a.payload->>'runId')
      LEFT JOIN manuscript_revisions mr ON mr.artifact_id=a.id
      WHERE a.id=$1
    `, [artifactId]);
    const target = subject.rows[0];
    if (!target?.document_id) return false;
    if (!revisionId) {
      const current = await client.query<{ content_hash: string | null }>(`
        SELECT mr.content_hash FROM manuscript_documents d
        LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
        WHERE d.id=$1 AND d.project_id=$2
      `, [target.document_id, target.project_id]);
      if (!current.rows[0]?.content_hash || current.rows[0].content_hash !== target.content_hash) return false;
    }

    const rows = await client.query<{
      id: string; project_id: string; artifact_id: string; reviewer_id: string; identity: Review["identity"];
      verdict: Review["verdict"]; issues: Review["issues"]; score: number | null; role: string | null;
      dimension_scores: Review["dimensionScores"]; artifact_fingerprint: string; created_at: Date | string;
    }>(`
      SELECT id,project_id,artifact_id,reviewer_id,identity,verdict,issues,score,role,dimension_scores,artifact_fingerprint,created_at
      FROM reviews WHERE artifact_id=$1 ORDER BY created_at,id
    `, [artifactId]);
    const reviews: Review[] = rows.rows.map((row) => ({
      id: row.id, projectId: row.project_id, artifactId: row.artifact_id, reviewerId: row.reviewer_id,
      identity: row.identity, verdict: row.verdict, issues: row.issues ?? [], score: row.score === null ? undefined : Number(row.score),
      role: row.role ?? undefined, dimensionScores: row.dimension_scores ?? {}, artifactFingerprint: row.artifact_fingerprint,
      createdAt: new Date(row.created_at).getTime(),
    }));
    const existing = await client.query<{ id: string }>("SELECT id FROM chapter_review_snapshots WHERE document_id=$1 FOR UPDATE", [target.document_id]);
    const snapshotId = existing.rows[0]?.id ?? randomUUID();
    const prior = existing.rowCount
      ? await client.query<{ issue_fingerprint: string; status: ChapterReviewIssueStatus }>("SELECT issue_fingerprint,status FROM chapter_review_snapshot_issues WHERE snapshot_id=$1", [snapshotId])
      : { rows: [] };
    const snapshot = aggregateChapterReviews(reviews, new Map(prior.rows.map((row) => [row.issue_fingerprint, row.status])));
    if (!snapshot.complete) return false;
    const reviewedAt = new Date(Math.max(...reviews.map((review) => review.createdAt)));
    await client.query(`
      INSERT INTO chapter_review_snapshots(id,document_id,project_id,revision_id,reviewed_content_hash,artifact_fingerprint,source_workflow_id,verdict,complete,overall_score,dimension_scores,reviewer_roles,reviewed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10,$11,$12)
      ON CONFLICT(document_id) DO UPDATE SET
        revision_id=EXCLUDED.revision_id,reviewed_content_hash=EXCLUDED.reviewed_content_hash,
        artifact_fingerprint=EXCLUDED.artifact_fingerprint,source_workflow_id=EXCLUDED.source_workflow_id,verdict=EXCLUDED.verdict,
        complete=TRUE,overall_score=EXCLUDED.overall_score,dimension_scores=EXCLUDED.dimension_scores,reviewer_roles=EXCLUDED.reviewer_roles,
        reviewed_at=EXCLUDED.reviewed_at,updated_at=now()
    `, [snapshotId, target.document_id, target.project_id, revisionId ?? null, target.content_hash, target.fingerprint, target.workflow_id, snapshot.verdict, snapshot.overallScore ?? null, JSON.stringify(snapshot.dimensionScores), snapshot.reviewerRoles, reviewedAt]);
    await client.query("DELETE FROM chapter_review_snapshot_issues WHERE snapshot_id=$1", [snapshotId]);
    for (const issue of snapshot.issues) {
      await client.query(`
        INSERT INTO chapter_review_snapshot_issues(id,snapshot_id,issue_fingerprint,dimension,severity,title,description,evidence_quote,paragraph,revision_ranges,rule,suggestion,source_roles,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      `, [issue.id, snapshotId, issue.fingerprint, issue.dimension ?? null, issue.severity, issue.title, issue.description ?? null, issue.evidenceQuote, issue.paragraph ?? null, JSON.stringify(issue.revisionRanges), issue.rule ?? null, issue.suggestion ?? null, issue.sourceRoles, issue.status]);
    }
    return true;
  }

  async listSkills(_projectId: string): Promise<SkillDescriptor[]> {
    type SkillRow = { skill_id: string; version: string; capabilities: string[] | null; applicable_tasks: PreflightPlan["taskClass"][] | null; required_memory_kinds: SkillDescriptor["requiredMemoryKinds"] | null; conflicts: string[] | null; quality_gates: string[] | null; prompt_sections: SkillDescriptor["promptSections"] | null; applicable_genres: string[] | null; enabled: boolean };
    const result = await this.pool.query<SkillRow>("SELECT * FROM skill_definitions WHERE enabled = TRUE ORDER BY skill_id");
    return result.rows.map((row: SkillRow) => ({ skillId: row.skill_id, version: row.version, capabilities: row.capabilities ?? [], applicableTasks: row.applicable_tasks ?? [], requiredMemoryKinds: row.required_memory_kinds ?? [], conflicts: row.conflicts ?? [], qualityGates: row.quality_gates ?? [], promptSections: row.prompt_sections ?? {}, applicableGenres: row.applicable_genres ?? [], enabled: row.enabled }));
  }

  async listKnowledgeRecords(projectId: string, kind: KnowledgeRecordKind): Promise<Array<Record<string, unknown>>> {
    if (kind === "foundation") return (await this.listFoundationArtifacts(projectId)).map((artifact) => ({ ...artifact, payload: artifact.structuredData ?? {} }));
    if (kind === "skills") {
      const result = await this.pool.query("SELECT skill_id AS id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, applicable_genres, enabled, updated_at FROM skill_definitions ORDER BY skill_id");
      return result.rows.map((row) => ({
        id: row.id,
        version: row.version,
        capabilities: row.capabilities ?? [],
        applicableTasks: row.applicable_tasks ?? [],
        requiredMemoryKinds: row.required_memory_kinds ?? [],
        conflicts: row.conflicts ?? [],
        qualityGates: row.quality_gates ?? [],
        promptSections: row.prompt_sections ?? {},
        applicableGenres: row.applicable_genres ?? [],
        enabled: row.enabled,
        updatedAt: row.updated_at,
      }));
    }
    if (kind === "planning" || kind === "worldview" || kind === "characters") {
      const entityKind = kind === "characters" ? "character" : kind;
      const result = await this.pool.query("SELECT id, kind, name, payload FROM entities WHERE project_id=$1 AND kind=$2 ORDER BY name,id", [projectId, entityKind]);
      return result.rows;
    }
    if (kind === "relations") {
      const result = await this.pool.query("SELECT id, subject_id, predicate, object_id, valid_from, valid_to, source_revision_id FROM relations WHERE project_id=$1 ORDER BY id", [projectId]);
      return result.rows.map((row) => ({ id: row.id, subjectId: row.subject_id, predicate: row.predicate, objectId: row.object_id, validFrom: row.valid_from, validTo: row.valid_to, sourceRevisionId: row.source_revision_id }));
    }
    if (kind === "timeline") {
      const result = await this.pool.query("SELECT id, narrative_time, event_type, content, source_revision_id FROM timeline_events WHERE project_id=$1 ORDER BY narrative_time,id", [projectId]);
      return result.rows.map((row) => ({ id: row.id, narrativeTime: Number(row.narrative_time), eventType: row.event_type, content: row.content ?? {}, sourceRevisionId: row.source_revision_id }));
    }
    const result = await this.pool.query("SELECT id, subject_id, predicate, object_value, truth_status, confidence, narrative_start, narrative_end FROM facts WHERE project_id=$1 ORDER BY narrative_start NULLS LAST,id", [projectId]);
    return result.rows.map((row) => ({ id: row.id, subjectId: row.subject_id, predicate: row.predicate, objectValue: row.object_value ?? {}, truthStatus: row.truth_status, confidence: Number(row.confidence), narrativeStart: row.narrative_start === null ? undefined : Number(row.narrative_start), narrativeEnd: row.narrative_end === null ? undefined : Number(row.narrative_end) }));
  }

  async upsertKnowledgeRecord(projectId: string, kind: Exclude<KnowledgeRecordKind, "foundation">, input: Record<string, unknown>) {
    const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : randomUUID();
    if (kind === "skills") {
      const version = typeof input.version === "string" && input.version.trim() ? input.version.trim() : "1.0.0";
      await this.pool.query(`INSERT INTO skill_definitions(skill_id,version,capabilities,applicable_tasks,required_memory_kinds,conflicts,quality_gates,prompt_sections,applicable_genres,enabled)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(skill_id) DO UPDATE SET version=EXCLUDED.version,capabilities=EXCLUDED.capabilities,applicable_tasks=EXCLUDED.applicable_tasks,required_memory_kinds=EXCLUDED.required_memory_kinds,conflicts=EXCLUDED.conflicts,quality_gates=EXCLUDED.quality_gates,prompt_sections=EXCLUDED.prompt_sections,applicable_genres=EXCLUDED.applicable_genres,enabled=EXCLUDED.enabled,updated_at=now()`,
      [id, version, input.capabilities ?? [], input.applicableTasks ?? input.applicable_tasks ?? [], input.requiredMemoryKinds ?? input.required_memory_kinds ?? [], input.conflicts ?? [], input.qualityGates ?? input.quality_gates ?? [], input.promptSections ?? input.prompt_sections ?? {}, input.applicableGenres ?? input.applicable_genres ?? [], input.enabled !== false]);
    } else if (kind === "planning" || kind === "worldview" || kind === "characters") {
      const entityKind = kind === "characters" ? "character" : kind;
      const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : id;
      await this.pool.query("INSERT INTO entities(id,project_id,kind,name,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET kind=EXCLUDED.kind,name=EXCLUDED.name,payload=EXCLUDED.payload", [id, projectId, entityKind, name, input.payload ?? {}]);
    } else if (kind === "relations") {
      const subjectId = String(input.subjectId ?? input.subject_id ?? "").trim();
      const predicate = String(input.predicate ?? "").trim();
      const objectId = String(input.objectId ?? input.object_id ?? "").trim();
      if (!subjectId || !predicate || !objectId) throw new Error("关系记录需要 subjectId、predicate、objectId");
      await this.pool.query("INSERT INTO relations(id,project_id,subject_id,predicate,object_id,valid_from,valid_to,source_revision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET subject_id=EXCLUDED.subject_id,predicate=EXCLUDED.predicate,object_id=EXCLUDED.object_id,valid_from=EXCLUDED.valid_from,valid_to=EXCLUDED.valid_to,source_revision_id=EXCLUDED.source_revision_id", [id, projectId, subjectId, predicate, objectId, input.validFrom ?? input.valid_from ?? null, input.validTo ?? input.valid_to ?? null, input.sourceRevisionId ?? input.source_revision_id ?? null]);
    } else if (kind === "timeline") {
      const eventType = String(input.eventType ?? input.event_type ?? "").trim();
      const narrativeTime = Number(input.narrativeTime ?? input.narrative_time);
      if (!eventType || !Number.isFinite(narrativeTime)) throw new Error("时间线记录需要 eventType 和 narrativeTime");
      await this.pool.query("INSERT INTO timeline_events(id,project_id,narrative_time,event_type,content,source_revision_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET narrative_time=EXCLUDED.narrative_time,event_type=EXCLUDED.event_type,content=EXCLUDED.content,source_revision_id=EXCLUDED.source_revision_id", [id, projectId, narrativeTime, eventType, input.content ?? {}, input.sourceRevisionId ?? input.source_revision_id ?? null]);
    } else {
      const predicate = String(input.predicate ?? "").trim();
      if (!predicate) throw new Error("事实记录需要 predicate");
      await this.pool.query("INSERT INTO facts(id,project_id,subject_id,predicate,object_value,truth_status,confidence,narrative_start,narrative_end) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET subject_id=EXCLUDED.subject_id,predicate=EXCLUDED.predicate,object_value=EXCLUDED.object_value,truth_status=EXCLUDED.truth_status,confidence=EXCLUDED.confidence,narrative_start=EXCLUDED.narrative_start,narrative_end=EXCLUDED.narrative_end", [id, projectId, input.subjectId ?? input.subject_id ?? null, predicate, input.objectValue ?? input.object_value ?? {}, input.truthStatus ?? input.truth_status ?? "candidate", Number(input.confidence ?? 0), input.narrativeStart ?? input.narrative_start ?? null, input.narrativeEnd ?? input.narrative_end ?? null]);
    }
    await this.recordKnowledgeMutation(projectId, kind, id, "upsert", input);
    return { id, kind, record: (await this.listKnowledgeRecords(projectId, kind)).find((record) => record.id === id) ?? null };
  }

  async deleteKnowledgeRecord(projectId: string, kind: Exclude<KnowledgeRecordKind, "foundation">, id: string) {
    const table = kind === "skills" ? "skill_definitions" : kind === "planning" || kind === "worldview" || kind === "characters" ? "entities" : kind === "relations" ? "relations" : kind === "timeline" ? "timeline_events" : "facts";
    const idColumn = kind === "skills" ? "skill_id" : "id";
    const projectClause = kind === "skills" ? "" : " AND project_id=$2";
    const params = kind === "skills" ? [id] : [id, projectId];
    const result = await this.pool.query(`DELETE FROM ${table} WHERE ${idColumn}=$1${projectClause} RETURNING ${idColumn} AS id`, params);
    await this.recordKnowledgeMutation(projectId, kind, id, "delete", { deleted: Boolean(result.rowCount) });
    return { deleted: Boolean(result.rowCount), id, kind };
  }

  private async recordKnowledgeMutation(projectId: string, kind: string, id: string, action: "upsert" | "delete", payload: Record<string, unknown>) {
    await this.pool.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,$3,$4,$5,$6)", [projectId, "web", `knowledge.${action}`, kind, id, payload]);
    await this.appendOutbox(kind, id, `knowledge.${action}`, { projectId, kind, id });
  }

  async getProjectSnapshot(projectId: string, targetDocumentId?: string): Promise<NovelProjectSnapshot> {
    const project = await this.pool.query<{ current_revision: string; metadata: Record<string, unknown> }>("SELECT current_revision, metadata FROM novel_projects WHERE id = $1", [projectId]);
    if (!project.rowCount) throw new Error("项目不存在");
    // Phase 3.3: 从 metadata 读取 genre/premise（题材通用差异化，不内置金手指/系统流特化）
    const metadata = project.rows[0].metadata ?? {};
    const genre = typeof metadata.genre === "string" ? metadata.genre : undefined;
    const premise = typeof metadata.premise === "string" ? metadata.premise : undefined;
    if (!targetDocumentId) return { projectId, currentRevision: Number(project.rows[0].current_revision), genre, premise };
    const document = await this.pool.query<{ narrative_order: number; pov_character_id: string | null }>("SELECT narrative_order, pov_character_id FROM manuscript_documents WHERE id = $1 AND project_id = $2", [targetDocumentId, projectId]);
    const row = document.rows[0];
    if (!row) throw new Error("目标章节不存在");
    return { projectId, currentRevision: Number(project.rows[0].current_revision), targetDocumentId, targetDocumentOrder: row.narrative_order, povCharacterId: row.pov_character_id ?? undefined, genre, premise };
  }

  async putIntent(intent: NovelIntent) {
    const result = await this.pool.query("INSERT INTO novel_intents(id, project_id, source, objective, payload, idempotency_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,idempotency_key) DO UPDATE SET objective=EXCLUDED.objective RETURNING payload", [intent.id, intent.projectId, intent.source, intent.objective, intent, intent.idempotencyKey]);
    return result.rows[0]?.payload as NovelIntent;
  }

  async putWorkflowRun(input: { id: string; workflowType: string; projectId: string; temporalWorkflowId: string; status: string; payload?: Record<string, unknown> }) {
    const result = await this.pool.query<WorkflowRunRow>(`INSERT INTO workflow_runs(id,workflow_type,project_id,temporal_workflow_id,status,payload)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(temporal_workflow_id) DO UPDATE SET status=EXCLUDED.status,payload=workflow_runs.payload || EXCLUDED.payload,updated_at=now()
      RETURNING id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at`, [input.id, input.workflowType, input.projectId, input.temporalWorkflowId, input.status, input.payload ?? {}]);
    await this.appendOutbox("workflow-run", input.temporalWorkflowId, `workflow.${input.status}`, { projectId: input.projectId, workflowId: input.temporalWorkflowId, runId: input.id });
    return workflowFromRow(result.rows[0]);
  }

  async updateWorkflowRunStatus(temporalWorkflowId: string, status: string, payload: Record<string, unknown> = {}) {
    const result = await this.pool.query<WorkflowRunRow>("UPDATE workflow_runs SET status=$2,payload=payload || $3,updated_at=now() WHERE temporal_workflow_id=$1 RETURNING id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at", [temporalWorkflowId, status, payload]);
    if (!result.rowCount) return undefined;
    const row = workflowFromRow(result.rows[0]);
    await this.appendOutbox("workflow-run", row.temporalWorkflowId, `workflow.${status}`, { projectId: row.projectId, workflowId: row.temporalWorkflowId, runId: row.id, ...payload });
    return row;
  }

  async claimHumanDecision(input: { workflowId: string; artifactId: string; decision: "approve" | "reject" | "revise" | "abandon"; authorId: string; feedback?: string; revisionBase?: "current" | "previous" }) {
    const submittedAt = new Date().toISOString();
    const claim = {
      artifactId: input.artifactId,
      decision: input.decision,
      authorId: input.authorId,
      ...(input.feedback ? { feedback: input.feedback } : {}),
      ...(input.revisionBase ? { revisionBase: input.revisionBase } : {}),
      submittedAt,
    };
    const result = await this.pool.query<WorkflowRunRow>(
      `UPDATE workflow_runs
       SET payload=payload || jsonb_build_object('pendingHumanDecision',$3::jsonb),updated_at=now()
       WHERE temporal_workflow_id=$1
         AND status='manual-review-required'
         AND payload->>'artifactId'=$2
         AND COALESCE(payload->'pendingHumanDecision'->>'artifactId','')<>$2
       RETURNING id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at`,
      [input.workflowId, input.artifactId, JSON.stringify(claim)],
    );
    return result.rows[0] ? workflowFromRow(result.rows[0]) : undefined;
  }

  async releaseHumanDecisionClaim(workflowId: string, artifactId: string) {
    const result = await this.pool.query<WorkflowRunRow>(
      `UPDATE workflow_runs
       SET payload=payload-'pendingHumanDecision',updated_at=now()
       WHERE temporal_workflow_id=$1
         AND payload->'pendingHumanDecision'->>'artifactId'=$2
       RETURNING id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at`,
      [workflowId, artifactId],
    );
    return result.rows[0] ? workflowFromRow(result.rows[0]) : undefined;
  }

  async replacePendingHumanArtifact(input: { workflowId: string; currentArtifactId: string; replacement: Artifact; authorId: string }) {
    const editedAt = new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<WorkflowRunRow>(
        `SELECT id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at
         FROM workflow_runs
         WHERE temporal_workflow_id=$1
           AND project_id=$2
           AND status='manual-review-required'
           AND payload->>'artifactId'=$3
           AND payload->'pendingHumanDecision' IS NULL
         FOR UPDATE`,
        [input.workflowId, input.replacement.projectId, input.currentArtifactId],
      );
      if (!locked.rowCount) {
        await client.query("ROLLBACK");
        return undefined;
      }
      await client.query(
        "INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING",
        [
          input.replacement.id,
          input.replacement.projectId,
          input.replacement.taskId,
          input.replacement.attemptId,
          input.replacement.kind,
          input.replacement.contentHash,
          input.replacement.objectKey ?? "",
          input.replacement.baseRevision,
          input.replacement.fingerprint,
          input.replacement.structuredData ?? {},
        ],
      );
      const result = await client.query<WorkflowRunRow>(
        `UPDATE workflow_runs
         SET payload=payload || jsonb_build_object(
             'artifactId', $4::text,
             'replacedArtifactId', $3::text,
             'authorEditedAt', $5::text,
             'authorEditedBy', $6::text
           ),
           updated_at=now()
         WHERE temporal_workflow_id=$1
           AND project_id=$2
           AND status='manual-review-required'
           AND payload->>'artifactId'=$3
           AND payload->'pendingHumanDecision' IS NULL
         RETURNING id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at`,
        [input.workflowId, input.replacement.projectId, input.currentArtifactId, input.replacement.id, editedAt, input.authorId],
      );
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const row = workflowFromRow(result.rows[0]);
      await this.appendOutboxTx(client, "artifact", input.replacement.id, `artifact.${input.replacement.kind}.ready`, { projectId: input.replacement.projectId, artifactId: input.replacement.id, taskId: input.replacement.taskId, fingerprint: input.replacement.fingerprint, replacesArtifactId: input.currentArtifactId });
      await this.appendOutboxTx(client, "workflow-run", row.temporalWorkflowId, "workflow.artifact-replaced", { projectId: row.projectId, workflowId: row.temporalWorkflowId, runId: row.id, artifactId: input.replacement.id, replacedArtifactId: input.currentArtifactId, authorEditedAt: editedAt });
      await client.query("COMMIT");
      return { run: row, artifact: input.replacement };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getWorkflowRunByTemporalId(temporalWorkflowId: string) {
    const result = await this.pool.query<WorkflowRunRow>("SELECT id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at FROM workflow_runs WHERE temporal_workflow_id=$1", [temporalWorkflowId]);
    return result.rows[0] ? workflowFromRow(result.rows[0]) : undefined;
  }

  async listProjectRuns(projectId: string, limit = 20): Promise<WorkflowRunRecord[]> {
    const result = await this.pool.query<WorkflowRunRow>("SELECT id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at FROM workflow_runs WHERE project_id=$1 ORDER BY updated_at DESC LIMIT $2", [projectId, limit]);
    return result.rows.map(workflowFromRow);
  }

  async findBootstrapRunId(projectId: string, idempotencyKey: string): Promise<string | undefined> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM creative_runs
       WHERE project_id=$1 AND payload->>'bootstrapKey'=$2
       ORDER BY created_at DESC LIMIT 1`,
      [projectId, idempotencyKey],
    );
    return result.rows[0]?.id;
  }

  async initializeProjectPlan(input: {
    projectId: string;
    workItemByTaskKey: Map<string, string>;
    includedTaskKeys: readonly string[];
  }): Promise<ProjectPlanSection[]> {
    const included = new Set(input.includedTaskKeys);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const stage of PROJECT_PLAN_STAGES) {
        if (!included.has(stage.taskKey)) continue;
        const status: ProjectPlanStatus = stage.dependsOn.length === 0 ? "ready" : "locked";
        await client.query(
          `INSERT INTO project_plan_sections(project_id,task_key,work_item_id,status,payload)
           VALUES($1,$2,$3,$4,'{}'::jsonb)
           ON CONFLICT(project_id,task_key) DO UPDATE SET
             work_item_id=EXCLUDED.work_item_id,
             status=EXCLUDED.status,
             approved_at=NULL,
             updated_at=now()`,
          [input.projectId, stage.taskKey, input.workItemByTaskKey.get(stage.taskKey) ?? null, status],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.listProjectPlanSections(input.projectId);
  }

  async listProjectPlanSections(projectId: string): Promise<ProjectPlanSection[]> {
    const result = await this.pool.query<ProjectPlanSectionRow>(
      `SELECT project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at
       FROM project_plan_sections WHERE project_id=$1`,
      [projectId],
    );
    const byKey = new Map(result.rows.map((row) => [row.task_key, projectPlanSectionFromRow(row)]));
    return PROJECT_PLAN_STAGES.flatMap((stage) => {
      const section = byKey.get(stage.taskKey);
      return section ? [section] : [];
    });
  }

  async getProjectPlanSection(projectId: string, taskKey: ProjectPlanTaskKey): Promise<ProjectPlanSection | undefined> {
    const result = await this.pool.query<ProjectPlanSectionRow>(
      `SELECT project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at
       FROM project_plan_sections WHERE project_id=$1 AND task_key=$2`,
      [projectId, taskKey],
    );
    return result.rows[0] ? projectPlanSectionFromRow(result.rows[0]) : undefined;
  }

  async markProjectPlanGenerating(projectId: string, taskKey: ProjectPlanTaskKey): Promise<ProjectPlanSection> {
    const result = await this.pool.query<ProjectPlanSectionRow>(
      `UPDATE project_plan_sections SET status='generating',updated_at=now()
       WHERE project_id=$1 AND task_key=$2 AND status IN ('ready','stale','failed')
       RETURNING project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at`,
      [projectId, taskKey],
    );
    if (!result.rowCount) throw new Error(`规划阶段当前不可生成：${taskKey}`);
    return projectPlanSectionFromRow(result.rows[0]);
  }

  async prepareProjectPlanRegeneration(input: {
    projectId: string;
    taskKey: ProjectPlanTaskKey;
    workItemId: string;
    actor: string;
  }): Promise<ProjectPlanSection> {
    const stage = PROJECT_PLAN_STAGES.find((candidate) => candidate.taskKey === input.taskKey)!;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (stage.dependsOn.length) {
        const dependencies = await client.query<{ task_key: string; status: ProjectPlanStatus }>(
          "SELECT task_key,status FROM project_plan_sections WHERE project_id=$1 AND task_key=ANY($2::text[])",
          [input.projectId, stage.dependsOn],
        );
        const approved = new Set(dependencies.rows.filter((row) => row.status === "approved").map((row) => row.task_key));
        const missing = stage.dependsOn.filter((key) => !approved.has(key));
        if (missing.length) throw new Error(`规划阶段依赖尚未确认：${missing.join(", ")}`);
      }
      const result = await client.query<ProjectPlanSectionRow>(
        `UPDATE project_plan_sections SET work_item_id=$3,status='generating',approved_at=NULL,updated_at=now()
         WHERE project_id=$1 AND task_key=$2
         RETURNING project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at`,
        [input.projectId, input.taskKey, input.workItemId],
      );
      if (!result.rowCount) throw new Error(`规划阶段不存在：${input.taskKey}`);
      const dependents = transitivePlanDependents(input.taskKey);
      if (dependents.length) {
        await client.query(
          `UPDATE project_plan_sections SET status='stale',approved_at=NULL,updated_at=now()
           WHERE project_id=$1 AND task_key=ANY($2::text[]) AND status <> 'locked'`,
          [input.projectId, dependents],
        );
      }
      await client.query(
        "UPDATE arcs SET planning_status='stale',approved_at=NULL,context_fingerprint=NULL,updated_at=now() WHERE project_id=$1 AND execution_status NOT IN ('completed','abandoned')",
        [input.projectId],
      );
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'plan.section.regeneration-started','project-plan-section',$3,$4)",
        [input.projectId, input.actor, input.taskKey, { workItemId: input.workItemId, staleDependents: dependents }],
      );
      await client.query("COMMIT");
      return projectPlanSectionFromRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async projectFoundationArtifact(artifact: Artifact): Promise<ProjectPlanSection | undefined> {
    const taskKey = foundationTaskKey(artifact);
    if (!taskKey) return undefined;
    const result = await this.pool.query<ProjectPlanSectionRow>(
      `INSERT INTO project_plan_sections(project_id,task_key,work_item_id,source_artifact_id,status,payload)
       VALUES($1,$2,$3,$4,'awaiting-confirmation',$5)
       ON CONFLICT(project_id,task_key) DO UPDATE SET
         work_item_id=COALESCE(EXCLUDED.work_item_id,project_plan_sections.work_item_id),
         source_artifact_id=EXCLUDED.source_artifact_id,
         status='awaiting-confirmation',payload=EXCLUDED.payload,approved_at=NULL,updated_at=now()
       RETURNING project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at`,
      [artifact.projectId, taskKey, artifact.structuredData?.workItemId ?? null, artifact.id, artifact.structuredData ?? {}],
    );
    return projectPlanSectionFromRow(result.rows[0]);
  }

  async replaceProjectPlanSection(input: {
    projectId: string;
    taskKey: ProjectPlanTaskKey;
    artifact: Artifact;
    actor: string;
  }): Promise<ProjectPlanSection> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ProjectPlanSectionRow>(
        `UPDATE project_plan_sections SET source_artifact_id=$3,payload=$4,status='awaiting-confirmation',
           edit_revision=edit_revision+1,approved_at=NULL,updated_at=now()
         WHERE project_id=$1 AND task_key=$2
         RETURNING project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at`,
        [input.projectId, input.taskKey, input.artifact.id, input.artifact.structuredData ?? {}],
      );
      if (!result.rowCount) throw new Error(`规划阶段不存在：${input.taskKey}`);
      const dependents = transitivePlanDependents(input.taskKey);
      if (dependents.length) {
        await client.query(
          `UPDATE project_plan_sections SET status='stale',approved_at=NULL,updated_at=now()
           WHERE project_id=$1 AND task_key=ANY($2::text[]) AND status <> 'locked'`,
          [input.projectId, dependents],
        );
      }
      await client.query(
        "UPDATE arcs SET planning_status='stale',approved_at=NULL,context_fingerprint=NULL,updated_at=now() WHERE project_id=$1 AND execution_status NOT IN ('completed','abandoned')",
        [input.projectId],
      );
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'plan.section.updated','project-plan-section',$3,$4)",
        [input.projectId, input.actor, input.taskKey, { artifactId: input.artifact.id, editRevision: Number(result.rows[0].edit_revision) }],
      );
      await client.query("COMMIT");
      return projectPlanSectionFromRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async approveProjectPlanSection(projectId: string, taskKey: ProjectPlanTaskKey, artifactId: string, actor: string): Promise<ProjectPlanSection[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<ProjectPlanSectionRow>(
        `SELECT project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at
         FROM project_plan_sections WHERE project_id=$1 AND task_key=$2 FOR UPDATE`,
        [projectId, taskKey],
      );
      if (!current.rowCount) throw new Error(`规划阶段不存在：${taskKey}`);
      if (current.rows[0].source_artifact_id !== artifactId) throw new Error("规划内容已变化，请刷新后重新确认");
      await client.query(
        "UPDATE project_plan_sections SET status='approved',approved_at=now(),updated_at=now() WHERE project_id=$1 AND task_key=$2",
        [projectId, taskKey],
      );
      if (taskKey === "project-positioning") {
        const bookTitle = approvedProjectBookTitle(current.rows[0].payload);
        if (bookTitle) {
          await client.query("UPDATE novel_projects SET title=$2,updated_at=now() WHERE id=$1", [projectId, bookTitle]);
          await client.query(
            "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'project.title.adopted','novel-project',$1,$3)",
            [projectId, actor, { title: bookTitle, sourceArtifactId: artifactId, taskKey }],
          );
        }
      }
      for (const stage of PROJECT_PLAN_STAGES) {
        if (!stage.dependsOn.includes(taskKey as never)) continue;
        const dependencyResult = await client.query<{ task_key: string; status: ProjectPlanStatus }>(
          "SELECT task_key,status FROM project_plan_sections WHERE project_id=$1 AND task_key=ANY($2::text[])",
          [projectId, stage.dependsOn],
        );
        if (stage.dependsOn.every((key) => dependencyResult.rows.some((row) => row.task_key === key && row.status === "approved"))) {
          await client.query(
            "UPDATE project_plan_sections SET status='ready',updated_at=now() WHERE project_id=$1 AND task_key=$2 AND status IN ('locked','stale')",
            [projectId, stage.taskKey],
          );
        }
      }
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'plan.section.approved','project-plan-section',$3,$4)",
        [projectId, actor, taskKey, { artifactId }],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.listProjectPlanSections(projectId);
  }

  async listCurrentFoundationArtifacts(projectId: string, approvedOnly = true): Promise<Artifact[]> {
    const result = await this.pool.query<ArtifactRow>(
      `SELECT a.id,a.project_id,a.task_id,a.attempt_id,a.kind,a.content_hash,a.object_key,a.base_revision,a.fingerprint,a.payload,a.created_at
       FROM project_plan_sections ps JOIN artifacts a ON a.id=ps.source_artifact_id
       WHERE ps.project_id=$1 AND ($2::boolean=FALSE OR ps.status='approved')`,
      [projectId, approvedOnly],
    );
    const byKey = new Map(result.rows.map((row) => {
      const artifact = artifactFromRow(row);
      return [foundationTaskKey(artifact), artifact] as const;
    }));
    return PROJECT_PLAN_STAGES.flatMap((stage) => {
      const artifact = byKey.get(stage.taskKey);
      return artifact ? [artifact] : [];
    });
  }

  async assertRequiredPlanApproved(projectId: string): Promise<void> {
    const result = await this.pool.query<{ task_key: string }>(
      "SELECT task_key FROM project_plan_sections WHERE project_id=$1 AND status='approved' AND task_key=ANY($2::text[])",
      [projectId, REQUIRED_APPROVED_PLAN_TASK_KEYS],
    );
    const approved = new Set(result.rows.map((row) => row.task_key));
    const missing = REQUIRED_APPROVED_PLAN_TASK_KEYS.filter((key) => !approved.has(key));
    if (missing.length) throw new Error(`全书规划尚未确认：${missing.join(", ")}`);
  }

  async getProjectPlanRun(projectId: string): Promise<{ runId: string; status: string } | undefined> {
    const result = await this.pool.query<{ id: string; status: string }>(
      `SELECT cr.id,cr.status FROM creative_runs cr
       WHERE cr.project_id=$1 AND cr.payload->>'bootstrap'='true'
       ORDER BY cr.created_at DESC LIMIT 1`,
      [projectId],
    );
    return result.rows[0] ? { runId: result.rows[0].id, status: result.rows[0].status } : undefined;
  }

  private async ensureOutlineRoot(projectId: string, client: Pool | PoolClient = this.pool): Promise<string> {
    const project = await client.query<{ title: string }>("SELECT title FROM novel_projects WHERE id=$1", [projectId]);
    if (!project.rowCount) throw new Error("项目不存在");
    const bookId = `book:${projectId}`;
    const volumeId = `volume:${projectId}:1`;
    await client.query("INSERT INTO books(id,project_id,title) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [bookId, projectId, project.rows[0].title]);
    await client.query("INSERT INTO volumes(id,book_id,title,ordinal) VALUES($1,$2,'正文',1) ON CONFLICT DO NOTHING", [volumeId, bookId]);
    return volumeId;
  }

  async createNextStoryArc(input: { projectId: string; workflowId: string; authorIntent?: string }): Promise<StoryArcRecord> {
    await this.assertRequiredPlanApproved(input.projectId);
    const client = await this.pool.connect();
    let arcId = "";
    try {
      await client.query("BEGIN");
      const unfinished = await client.query<{ id: string }>(
        "SELECT id FROM arcs WHERE project_id=$1 AND execution_status NOT IN ('completed','abandoned') ORDER BY ordinal DESC LIMIT 1 FOR UPDATE",
        [input.projectId],
      );
      if (unfinished.rowCount) throw new Error("上一故事弧尚未完成或放弃，不能规划下一故事弧");
      const volumeId = await this.ensureOutlineRoot(input.projectId, client);
      const ordinalResult = await client.query<{ ordinal: number }>("SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM arcs WHERE project_id=$1", [input.projectId]);
      const ordinal = Number(ordinalResult.rows[0]?.ordinal ?? 1);
      arcId = randomUUID();
      const payload = { title: `故事弧 ${ordinal}`, objective: input.authorIntent || "依据当前宏观规划和已定稿故事状态，形成一个完整的小故事", entryState: "", centralConflict: "", development: [], resolution: "", exitState: "", plotThreadRefs: [], foreshadowingRefs: [], expectedChapterCount: 0, phases: [], authorIntent: input.authorIntent, workflowId: input.workflowId };
      await client.query(
        `INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload)
         VALUES($1,$2,$3,$4,$5,'generating','planned',$6)`,
        [arcId, volumeId, input.projectId, payload.title, ordinal, payload],
      );
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'runtime','story-arc.created','story-arc',$2,$3)",
        [input.projectId, arcId, { workflowId: input.workflowId, authorIntent: input.authorIntent }],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return (await this.getStoryArc(input.projectId, arcId))!;
  }

  async projectStoryArcBundle(input: { projectId: string; arcId: string; bundle: StoryArcBundle; artifact: Artifact; actor: string; edited?: boolean }): Promise<StoryArcRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<ArcRow>("SELECT * FROM arcs WHERE id=$1 AND project_id=$2 FOR UPDATE", [input.arcId, input.projectId]);
      if (!current.rowCount) throw new Error("故事弧不存在");
      if (current.rows[0].execution_status === "completed" || current.rows[0].execution_status === "abandoned") throw new Error("已结束故事弧不可改写");
      const existing = await client.query<ChapterBlueprintRow>("SELECT id,arc_id,project_id,document_id,title,ordinal,status,payload,source_artifact_id,blueprint_revision FROM chapters WHERE arc_id=$1 ORDER BY ordinal", [input.arcId]);
      const existingByLocal = new Map(existing.rows.map((row) => [Number(row.payload?.index ?? 0), row]));
      const linkedDocumentIds = existing.rows.flatMap((row) => row.document_id ? [row.document_id] : []);
      const linkedDocuments = linkedDocumentIds.length
        ? await client.query<{ id: string; status: string; current_revision_id: string | null }>("SELECT id,status,current_revision_id FROM manuscript_documents WHERE id=ANY($1::text[]) FOR UPDATE", [linkedDocumentIds])
        : { rows: [] };
      const linkedDocumentById = new Map(linkedDocuments.rows.map((row) => [row.id, row]));
      const minExisting = existing.rows.length ? Math.min(...existing.rows.map((row) => Number(row.ordinal))) : undefined;
      const next = await client.query<{ ordinal: number }>(
        "SELECT GREATEST(COALESCE((SELECT MAX(ordinal) FROM chapters WHERE project_id=$1),0),COALESCE((SELECT MAX(narrative_order) FROM manuscript_documents WHERE project_id=$1),0))+1 AS ordinal",
        [input.projectId],
      );
      const baseOrder = input.bundle.batch.batchIndex === 1 ? minExisting ?? Number(next.rows[0]?.ordinal ?? 1) : Number(next.rows[0]?.ordinal ?? 1);
      const batchId = `batch:${input.arcId}:${input.bundle.batch.batchIndex}`;
      const isInitialBatch = input.bundle.batch.batchIndex === 1;
      if (!isInitialBatch && current.rows[0].planning_status !== "approved") throw new Error("上一故事弧批次尚未批准");
      if (!isInitialBatch) {
        const approvedArc = current.rows[0].payload as NarrativeArcPlan;
        for (const field of ["title", "objective", "entryState", "exitState", "expectedChapterCount"] as const) {
          if (JSON.stringify(input.bundle.arc[field]) !== JSON.stringify(approvedArc[field])) throw new Error(`后续批次不得改写故事弧边界：${field}`);
        }
      }
      await client.query(
        `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,source_artifact_id,payload)
         VALUES($1,$2,$3,$4,$5,$6,'awaiting-review',$7,$8)
         ON CONFLICT(arc_id,batch_index) DO UPDATE SET end_chapter_index=EXCLUDED.end_chapter_index,status='awaiting-review',source_artifact_id=EXCLUDED.source_artifact_id,payload=EXCLUDED.payload,updated_at=now()`,
        [batchId, input.arcId, input.projectId, input.bundle.batch.batchIndex, input.bundle.batch.startChapterIndex, input.bundle.batch.startChapterIndex + input.bundle.chapters.length - 1, input.artifact.id, input.bundle.batch],
      );
      const keptIds: string[] = [];
      for (const chapter of input.bundle.chapters) {
        const globalIndex = input.bundle.batch.startChapterIndex + chapter.index - 1;
        const previous = existingByLocal.get(globalIndex);
        const linkedDocument = previous?.document_id ? linkedDocumentById.get(previous.document_id) : undefined;
        const isProtected = Boolean(linkedDocument && (linkedDocument.status !== "planned" || linkedDocument.current_revision_id));
        const chapterId = previous?.id ?? chapter.id ?? randomUUID();
        const globalOrder = previous ? Number(previous.ordinal) : baseOrder + chapter.index - 1;
        keptIds.push(chapterId);
        if (previous && isProtected) continue;
        await client.query(
          `INSERT INTO chapters(id,arc_id,project_id,document_id,title,ordinal,status,payload,source_artifact_id,blueprint_revision,batch_id,batch_index,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,'planned',$7,$8,$9,$10,$11,now())
           ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,payload=EXCLUDED.payload,source_artifact_id=EXCLUDED.source_artifact_id,
             blueprint_revision=chapters.blueprint_revision+1,batch_id=EXCLUDED.batch_id,batch_index=EXCLUDED.batch_index,updated_at=now()`,
          [chapterId, input.arcId, input.projectId, previous?.document_id ?? null, chapter.title, globalOrder, { ...chapter, id: chapterId, index: globalIndex }, input.artifact.id, previous ? Number(previous.blueprint_revision) + 1 : 0, batchId, input.bundle.batch.batchIndex],
        );
        if (!isProtected) {
          await client.query("DELETE FROM scenes WHERE chapter_id=$1", [chapterId]);
          for (let index = 0; index < chapter.scenes.length; index += 1) {
            const scene = chapter.scenes[index];
            await client.query("INSERT INTO scenes(id,chapter_id,ordinal,summary,payload) VALUES($1,$2,$3,$4,$5)", [randomUUID(), chapterId, index + 1, scene.summary, scene]);
          }
        }
      }
      const batchEnd = input.bundle.batch.startChapterIndex + input.bundle.chapters.length - 1;
      const removable = existing.rows.filter((row) => {
        const index = Number(row.payload?.index ?? 0);
        return index >= input.bundle.batch.startChapterIndex && index <= batchEnd && !keptIds.includes(row.id) && !row.document_id;
      }).map((row) => row.id);
      if (removable.length) await client.query("DELETE FROM chapters WHERE id=ANY($1::text[])", [removable]);
      await client.query(
        `UPDATE arcs SET title=CASE WHEN $7 THEN $3 ELSE title END,payload=CASE WHEN $7 THEN $4 ELSE payload END,source_artifact_id=COALESCE(source_artifact_id,$5),blueprint_artifact_id=$5,
           planning_status='awaiting-review',context_fingerprint=NULL,approved_at=NULL,
           edit_revision=edit_revision+$6,updated_at=now() WHERE id=$1 AND project_id=$2`,
        [input.arcId, input.projectId, input.bundle.arc.title, input.bundle.arc, input.artifact.id, input.edited ? 1 : 0, isInitialBatch],
      );
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,$3,'story-arc',$4,$5)",
        [input.projectId, input.actor, input.edited ? "story-arc.edited" : "story-arc.generated", input.arcId, { artifactId: input.artifact.id, chapterCount: input.bundle.chapters.length }],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return (await this.getStoryArc(input.projectId, input.arcId))!;
  }

  async listStoryArcs(projectId: string): Promise<StoryArcRecord[]> {
    const arcs = await this.pool.query<ArcRow>("SELECT * FROM arcs WHERE project_id=$1 ORDER BY ordinal", [projectId]);
    const result: StoryArcRecord[] = [];
    for (const arc of arcs.rows) result.push((await this.getStoryArc(projectId, arc.id))!);
    return result;
  }

  async getStoryArc(projectId: string, arcId: string): Promise<StoryArcRecord | undefined> {
    const [arcResult, chapterResult, batchResult] = await Promise.all([
      this.pool.query<ArcRow>("SELECT * FROM arcs WHERE id=$1 AND project_id=$2", [arcId, projectId]),
      this.pool.query<ChapterBlueprintRow>("SELECT id,arc_id,project_id,document_id,title,ordinal,status,payload,source_artifact_id,blueprint_revision FROM chapters WHERE arc_id=$1 AND project_id=$2 ORDER BY ordinal", [arcId, projectId]),
      this.pool.query<StoryArcBatchRow>("SELECT * FROM story_arc_batches WHERE arc_id=$1 AND project_id=$2 ORDER BY batch_index", [arcId, projectId]),
    ]);
    const row = arcResult.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      volumeId: row.volume_id,
      ordinal: Number(row.ordinal),
      planningStatus: row.planning_status,
      executionStatus: row.execution_status,
      arc: row.payload,
      chapters: chapterResult.rows.map(chapterBlueprintFromRow),
      batches: batchResult.rows.map((batch) => ({ id: batch.id, arcId: batch.arc_id, projectId: batch.project_id, batchIndex: Number(batch.batch_index), startChapterIndex: Number(batch.start_chapter_index), endChapterIndex: Number(batch.end_chapter_index), complete: batch.payload?.complete === true, status: batch.status, entryFingerprint: batch.entry_fingerprint, sourceArtifactId: batch.source_artifact_id ?? undefined, approvedAt: batch.approved_at ? iso(batch.approved_at) : undefined })),
      sourceArtifactId: row.source_artifact_id ?? undefined,
      blueprintArtifactId: row.blueprint_artifact_id ?? undefined,
      contextFingerprint: row.context_fingerprint ?? undefined,
      editRevision: Number(row.edit_revision),
      approvedAt: row.approved_at ? iso(row.approved_at) : undefined,
      completedAt: row.completed_at ? iso(row.completed_at) : undefined,
      abandonedAt: row.abandoned_at ? iso(row.abandoned_at) : undefined,
      updatedAt: iso(row.updated_at),
    };
  }

  async prepareNextStoryArcBatch(projectId: string, arcId: string): Promise<{ batchIndex: number; startChapterIndex: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const arc = await client.query<ArcRow>("SELECT * FROM arcs WHERE id=$1 AND project_id=$2 FOR UPDATE", [arcId, projectId]);
      if (!arc.rowCount || arc.rows[0].planning_status !== "approved" || arc.rows[0].execution_status !== "active") throw new Error("故事弧当前不可生成下一批次");
      const batches = await client.query<StoryArcBatchRow>("SELECT * FROM story_arc_batches WHERE arc_id=$1 ORDER BY batch_index FOR UPDATE", [arcId]);
      const last = batches.rows.at(-1);
      if (!last || last.status !== "approved" || last.payload?.complete === true) throw new Error("上一批次未批准或故事弧已完成");
      if (Number(last.end_chapter_index) >= Number((arc.rows[0].payload as NarrativeArcPlan).expectedChapterCount ?? Number.POSITIVE_INFINITY)) throw new Error("故事弧已达到预计章节数，请先完成或调整弧计划");
      if (batches.rows.some((batch) => batch.status === "generating" || batch.status === "awaiting-review")) throw new Error("已有批次正在生成或等待审核");
      const progress = await client.query<{ planned: string; finalized: string }>(
        `SELECT count(*)::text AS planned,count(*) FILTER (WHERE d.status='final')::text AS finalized
         FROM chapters c LEFT JOIN manuscript_documents d ON d.id=c.document_id WHERE c.batch_id=$1`, [last.id],
      );
      if (!canGenerateNextStoryArcBatch({ plannedInBatch: Number(progress.rows[0]?.planned ?? 0), finalizedInBatch: Number(progress.rows[0]?.finalized ?? 0), batchStatus: last.status })) {
        throw new Error("当前批次尚未达到 70% 定稿门槛");
      }
      const batchIndex = Number(last.batch_index) + 1;
      const startChapterIndex = Number(last.end_chapter_index) + 1;
      const id = `batch:${arcId}:${batchIndex}`;
      const entryFingerprint = createHash("sha256").update(JSON.stringify({ arcId, batchIndex, startChapterIndex, finalized: progress.rows[0]?.finalized, updatedAt: arc.rows[0].updated_at })).digest("hex");
      await client.query(`INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,entry_fingerprint,payload)
        VALUES($1,$2,$3,$4,$5,$5,'generating',$6,$7)`, [id, arcId, projectId, batchIndex, startChapterIndex, entryFingerprint, { complete: false }]);
      await client.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'runtime','story-arc-batch.started','story-arc-batch',$2,$3)", [projectId, id, { arcId, batchIndex, startChapterIndex, entryFingerprint }]);
      await client.query("COMMIT");
      return { batchIndex, startChapterIndex };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failStoryArcBatch(projectId: string, arcId: string, batchIndex: number, reason: string): Promise<void> {
    await this.pool.query("UPDATE story_arc_batches SET status='failed',payload=payload || $4,updated_at=now() WHERE project_id=$1 AND arc_id=$2 AND batch_index=$3 AND status='generating'", [projectId, arcId, batchIndex, { failureReason: reason }]);
  }

  async getStoryArcWorkflow(projectId: string, arcId: string): Promise<WorkflowRunRecord | undefined> {
    const result = await this.pool.query<WorkflowRunRow>(
      "SELECT id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at FROM workflow_runs WHERE project_id=$1 AND workflow_type='story-arc-planning' AND payload->>'arcId'=$2 ORDER BY created_at DESC LIMIT 1",
      [projectId, arcId],
    );
    return result.rows[0] ? workflowFromRow(result.rows[0]) : undefined;
  }

  async previewStoryArcApproval(projectId: string, arcId: string) {
    const arc = await this.getStoryArc(projectId, arcId);
    if (!arc || arc.planningStatus !== "awaiting-review" || !arc.blueprintArtifactId) throw new Error("故事弧当前不可确认");
    const creates: Array<{ chapterId: string; index: number; title: string }> = [];
    const updates: Array<{ chapterId: string; documentId: string; index: number; title: string }> = [];
    const conflicts: Array<{ chapterId: string; documentId: string; index: number; title: string; reason: string }> = [];
    for (const chapter of arc.chapters) {
      if (!chapter.documentId) creates.push({ chapterId: chapter.id, index: chapter.globalOrder, title: chapter.title });
      else {
        const doc = await this.pool.query<{ status: string; current_revision_id: string | null }>("SELECT status,current_revision_id FROM manuscript_documents WHERE id=$1 AND project_id=$2", [chapter.documentId, projectId]);
        if (!doc.rowCount || doc.rows[0].current_revision_id || doc.rows[0].status !== "planned") conflicts.push({ chapterId: chapter.id, documentId: chapter.documentId, index: chapter.globalOrder, title: chapter.title, reason: "章节已有正文或已进入创作流程" });
        else updates.push({ chapterId: chapter.id, documentId: chapter.documentId, index: chapter.globalOrder, title: chapter.title });
      }
    }
    return { creates, updates, conflicts, artifactId: arc.blueprintArtifactId };
  }

  async approveStoryArc(projectId: string, arcId: string, artifactId: string, actor: string) {
    const preview = await this.previewStoryArcApproval(projectId, arcId);
    if (preview.artifactId !== artifactId) throw new Error("故事弧蓝图已变化，请刷新后重新确认");
    const macro = await this.listCurrentFoundationArtifacts(projectId);
    const contextFingerprint = createHash("sha256").update(JSON.stringify({ macro: macro.map((item) => [foundationTaskKey(item), item.id, item.fingerprint]), artifactId })).digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const item of preview.creates) {
        const chapter = await client.query<ChapterBlueprintRow>("SELECT id,arc_id,project_id,document_id,title,ordinal,status,payload,source_artifact_id,blueprint_revision FROM chapters WHERE id=$1 FOR UPDATE", [item.chapterId]);
        const blueprint = chapterBlueprintFromRow(chapter.rows[0]);
        const documentId = randomUUID();
        await client.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,pov_character_id,status) VALUES($1,$2,$3,$4,$5,'planned')", [documentId, projectId, blueprint.title, blueprint.globalOrder, blueprint.povCharacterId ?? null]);
        await client.query("UPDATE chapters SET document_id=$2,updated_at=now() WHERE id=$1", [blueprint.id, documentId]);
        const source = blueprint.sourceArtifactId ? await client.query<{ fingerprint: string }>("SELECT fingerprint FROM artifacts WHERE id=$1", [blueprint.sourceArtifactId]) : { rows: [] };
        await client.query(`INSERT INTO chapter_production_specs(document_id,project_id,chapter_goal,blueprint,blueprint_fingerprint,source_artifact_id)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(document_id) DO UPDATE SET chapter_goal=EXCLUDED.chapter_goal,blueprint=EXCLUDED.blueprint,blueprint_fingerprint=EXCLUDED.blueprint_fingerprint,source_artifact_id=EXCLUDED.source_artifact_id,updated_at=now()`,
        [documentId, projectId, blueprint.chapterPurpose, chapter.rows[0].payload, source.rows[0]?.fingerprint ?? "", blueprint.sourceArtifactId ?? null]);
      }
      for (const item of preview.updates) {
        const chapter = await client.query<ChapterBlueprintRow>("SELECT id,arc_id,project_id,document_id,title,ordinal,status,payload,source_artifact_id,blueprint_revision FROM chapters WHERE id=$1", [item.chapterId]);
        const blueprint = chapterBlueprintFromRow(chapter.rows[0]);
        await client.query("UPDATE manuscript_documents SET title=$3,pov_character_id=$4,updated_at=now() WHERE id=$1 AND project_id=$2 AND status='planned' AND current_revision_id IS NULL", [item.documentId, projectId, blueprint.title, blueprint.povCharacterId ?? null]);
        const source = blueprint.sourceArtifactId ? await client.query<{ fingerprint: string }>("SELECT fingerprint FROM artifacts WHERE id=$1", [blueprint.sourceArtifactId]) : { rows: [] };
        await client.query(`INSERT INTO chapter_production_specs(document_id,project_id,chapter_goal,blueprint,blueprint_fingerprint,source_artifact_id)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(document_id) DO UPDATE SET chapter_goal=EXCLUDED.chapter_goal,blueprint=EXCLUDED.blueprint,blueprint_fingerprint=EXCLUDED.blueprint_fingerprint,source_artifact_id=EXCLUDED.source_artifact_id,updated_at=now()`,
        [item.documentId, projectId, blueprint.chapterPurpose, chapter.rows[0].payload, source.rows[0]?.fingerprint ?? "", blueprint.sourceArtifactId ?? null]);
      }
      await client.query("UPDATE arcs SET planning_status='approved',execution_status='active',context_fingerprint=$3,approved_at=now(),updated_at=now() WHERE id=$1 AND project_id=$2", [arcId, projectId, contextFingerprint]);
      await client.query("UPDATE story_arc_batches SET status='approved',approved_at=now(),updated_at=now() WHERE arc_id=$1 AND project_id=$2 AND status='awaiting-review'", [arcId, projectId]);
      await client.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'story-arc.approved','story-arc',$3,$4)", [projectId, actor, arcId, { artifactId, preview, contextFingerprint }]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { arc: await this.getStoryArc(projectId, arcId), preview };
  }

  async abandonStoryArc(projectId: string, arcId: string, reason: string, actor: string) {
    const result = await this.pool.query("UPDATE arcs SET execution_status='abandoned',abandoned_at=now(),updated_at=now(),payload=payload || $3 WHERE id=$1 AND project_id=$2 AND execution_status<>'completed' RETURNING id", [arcId, projectId, { abandonmentReason: reason }]);
    if (!result.rowCount) throw new Error("故事弧不存在或已完成");
    await this.pool.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'story-arc.abandoned','story-arc',$3,$4)", [projectId, actor, arcId, { reason }]);
    return this.getStoryArc(projectId, arcId);
  }

  async markStoryArcGenerating(projectId: string, arcId: string, actor: string) {
    const result = await this.pool.query("UPDATE arcs SET planning_status='generating',approved_at=NULL,context_fingerprint=NULL,updated_at=now() WHERE id=$1 AND project_id=$2 AND execution_status NOT IN ('completed','abandoned') RETURNING id", [arcId, projectId]);
    if (!result.rowCount) throw new Error("故事弧当前不可重基线");
    await this.pool.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'story-arc.rebase-started','story-arc',$3,'{}')", [projectId, actor, arcId]);
    return this.getStoryArc(projectId, arcId);
  }

  async failStoryArc(projectId: string, arcId: string, reason: string) {
    await this.pool.query("UPDATE arcs SET planning_status='failed',updated_at=now(),payload=payload || $3 WHERE id=$1 AND project_id=$2 AND execution_status NOT IN ('completed','abandoned')", [arcId, projectId, { failureReason: reason }]);
    await this.pool.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'runtime','story-arc.failed','story-arc',$2,$3)", [projectId, arcId, { reason }]);
  }

  async getStoryArcPlanningInput(projectId: string) {
    const [project, macro, memories, threads] = await Promise.all([
      this.pool.query<{ title: string }>("SELECT title FROM novel_projects WHERE id=$1", [projectId]),
      this.listCurrentFoundationArtifacts(projectId),
      this.getChapterMemories({ projectId, limit: 6 }),
      this.pool.query<{ id: string; title: string; payload: Record<string, unknown> }>("SELECT id,title,payload FROM plot_threads WHERE project_id=$1 AND status='open' ORDER BY id", [projectId]),
    ]);
    if (!project.rowCount) throw new Error("项目不存在");
    return {
      projectTitle: project.rows[0].title,
      macro: macro.map((artifact) => ({ taskKey: foundationTaskKey(artifact) ?? "unknown", title: typeof artifact.structuredData?.title === "string" ? artifact.structuredData.title : "", summary: typeof artifact.structuredData?.summary === "string" ? artifact.structuredData.summary : "" })),
      recentChapters: memories.slice().reverse().map((memory) => ({ order: memory.narrativeRange.end, summary: memory.summary, unresolvedThreads: memory.unresolvedThreads, emotionalArc: memory.emotionalArc })),
      openThreads: threads.rows,
    };
  }

  async getChapterPlanningContext(projectId: string, documentId: string, allowHistorical = false): Promise<ChapterPlanningContext> {
    const chapterResult = await this.pool.query<ChapterBlueprintRow & { planning_status: string; context_fingerprint: string | null; arc_payload: NarrativeArcPlan }>(
      `SELECT c.id,c.arc_id,c.project_id,c.document_id,c.title,c.ordinal,c.status,c.payload,c.source_artifact_id,c.blueprint_revision,
         a.planning_status,a.context_fingerprint,a.payload AS arc_payload
       FROM chapters c JOIN arcs a ON a.id=c.arc_id WHERE c.project_id=$1 AND c.document_id=$2`,
      [projectId, documentId],
    );
    if (!chapterResult.rowCount) throw new Error("目标章节尚未关联故事弧蓝图");
    const row = chapterResult.rows[0];
    if (!allowHistorical && row.planning_status !== "approved") throw new Error(`目标故事弧蓝图不可用：${row.planning_status}`);
    const chapter = chapterBlueprintFromRow(row);
    const [macro, neighborsResult] = await Promise.all([
      this.listCurrentFoundationArtifacts(projectId),
      this.pool.query<ChapterBlueprintRow>("SELECT id,arc_id,project_id,document_id,title,ordinal,status,payload,source_artifact_id,blueprint_revision FROM chapters WHERE arc_id=$1 AND id<>$2 ORDER BY ABS(ordinal-$3),ordinal LIMIT 2", [row.arc_id, row.id, row.ordinal]),
    ]);
    const macroPlanArtifacts = macro.map((artifact) => ({ id: artifact.id, taskKey: foundationTaskKey(artifact) ?? "unknown", title: typeof artifact.structuredData?.title === "string" ? artifact.structuredData.title : "", summary: typeof artifact.structuredData?.summary === "string" ? artifact.structuredData.summary : "", payload: artifact.structuredData ?? {} }));
    const sourceArtifactIds = [...macro.map((artifact) => artifact.id), ...(row.source_artifact_id ? [row.source_artifact_id] : [])];
    const withoutFingerprint = {
      projectId,
      arcId: row.arc_id,
      chapterBlueprintId: row.id,
      macroPlanArtifacts,
      arc: row.arc_payload,
      chapter,
      neighbors: neighborsResult.rows.map(chapterBlueprintFromRow).map(({ id, globalOrder, title, summary, chapterPurpose }) => ({ id, globalOrder, title, summary, chapterPurpose })),
      sourceArtifactIds,
    };
    const context = { ...withoutFingerprint, fingerprint: planningContextFingerprint(withoutFingerprint) };
    if (!allowHistorical) {
      const currentArcFingerprint = createHash("sha256").update(JSON.stringify({ macro: macro.map((item) => [foundationTaskKey(item), item.id, item.fingerprint]), artifactId: row.source_artifact_id })).digest("hex");
      if (!row.context_fingerprint || currentArcFingerprint !== row.context_fingerprint) {
        await this.pool.query("UPDATE arcs SET planning_status='stale',approved_at=NULL,updated_at=now() WHERE id=$1 AND execution_status<>'completed'", [row.arc_id]);
        throw new Error("故事弧蓝图与当前宏观规划不一致，请先重基线");
      }
    }
    return context;
  }

  async findNextPlannedArcDocument(projectId: string): Promise<ManuscriptDocumentSummary | undefined> {
    const result = await this.pool.query<DocumentRow>(
      `SELECT d.id,d.project_id,d.title,d.narrative_order,d.pov_character_id,d.current_revision_id,d.status,d.created_at,d.updated_at
       FROM manuscript_documents d JOIN chapters c ON c.document_id=d.id JOIN arcs a ON a.id=c.arc_id
       WHERE d.project_id=$1 AND d.status='planned' AND d.current_revision_id IS NULL AND a.planning_status='approved' AND a.execution_status='active'
       ORDER BY d.narrative_order LIMIT 1`,
      [projectId],
    );
    return result.rows[0] ? documentFromRow(result.rows[0]) : undefined;
  }

  async putChapterPlanningContext(blueprintId: string, documentId: string, context: ChapterPlanningContext): Promise<void> {
    await this.pool.query(
      `INSERT INTO chapter_planning_contexts(id,project_id,document_id,arc_id,chapter_blueprint_id,source_artifact_ids,payload,fingerprint)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
      [blueprintId, context.projectId, documentId, context.arcId, context.chapterBlueprintId, context.sourceArtifactIds, context, context.fingerprint],
    );
  }

  async getChapterPlanningContextSnapshot(blueprintId: string): Promise<ChapterPlanningContext | undefined> {
    const result = await this.pool.query<{ payload: ChapterPlanningContext }>("SELECT payload FROM chapter_planning_contexts WHERE id=$1", [blueprintId]);
    return result.rows[0]?.payload;
  }

  async previewChapterPlanApplication(projectId: string): Promise<{
    creates: Array<{ index: number; title: string; summary?: string }>;
    updates: Array<{ documentId: string; index: number; fromTitle: string; title: string; summary?: string }>;
    conflicts: Array<{ documentId: string; index: number; title: string; reason: string }>;
  }> {
    await this.assertRequiredPlanApproved(projectId);
    const section = await this.getProjectPlanSection(projectId, "chapter-plan");
    const structured = section?.payload.structuredData;
    const chapters = structured && typeof structured === "object" && !Array.isArray(structured)
      ? (structured as Record<string, unknown>).chapters
      : undefined;
    if (!Array.isArray(chapters)) throw new Error("章节计划缺少 chapters 数组");
    const existing = await this.pool.query<DocumentRow>(
      "SELECT id,project_id,title,narrative_order,pov_character_id,current_revision_id,status,created_at,updated_at FROM manuscript_documents WHERE project_id=$1",
      [projectId],
    );
    const byOrder = new Map(existing.rows.map((row) => [Number(row.narrative_order), row]));
    const preview = { creates: [] as Array<{ index: number; title: string; summary?: string }>, updates: [] as Array<{ documentId: string; index: number; fromTitle: string; title: string; summary?: string }>, conflicts: [] as Array<{ documentId: string; index: number; title: string; reason: string }> };
    for (const raw of chapters) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const chapter = raw as Record<string, unknown>;
      const index = Number(chapter.index);
      const title = typeof chapter.title === "string" ? chapter.title.trim() : "";
      const summary = typeof chapter.summary === "string" ? chapter.summary : undefined;
      if (!Number.isInteger(index) || index < 1 || !title) continue;
      const document = byOrder.get(index);
      if (!document) preview.creates.push({ index, title, summary });
      else if (document.current_revision_id || document.status !== "planned") preview.conflicts.push({ documentId: document.id, index, title: document.title, reason: "章节已有正文或已进入创作流程" });
      else if (document.title !== title) preview.updates.push({ documentId: document.id, index, fromTitle: document.title, title, summary });
    }
    return preview;
  }

  async applyChapterPlan(projectId: string) {
    const preview = await this.previewChapterPlanApplication(projectId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const chapter of preview.creates) {
        await client.query(
          "INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,$3,$4,'planned')",
          [randomUUID(), projectId, chapter.title, chapter.index],
        );
      }
      for (const chapter of preview.updates) {
        await client.query(
          "UPDATE manuscript_documents SET title=$3,updated_at=now() WHERE id=$1 AND project_id=$2 AND status='planned' AND current_revision_id IS NULL",
          [chapter.documentId, projectId, chapter.title],
        );
      }
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'web-author','plan.chapters.applied','project-plan',$1,$2)",
        [projectId, preview],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { ...preview, applied: { created: preview.creates.length, updated: preview.updates.length } };
  }

  async listRunArtifacts(temporalWorkflowId: string): Promise<Artifact[]> {
    const run = await this.getWorkflowRunByTemporalId(temporalWorkflowId);
    if (!run) return [];
    const result = await this.pool.query<ArtifactRow>(`
      SELECT id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload,created_at
      FROM artifacts
       WHERE project_id=$1 AND (payload->>'workflowId'=$2 OR payload->>'runId'=$2)
      ORDER BY created_at DESC
      LIMIT 100
    `, [run.projectId, temporalWorkflowId]);
    return result.rows.map(artifactFromRow);
  }

  async assertRuntimeObjectStoreIdentity(identity: ObjectStoreIdentity): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('ymcp-novel-v2-object-store'))");
      const result = await client.query<{ value: ObjectStoreIdentity }>("SELECT value FROM runtime_configuration WHERE key='object-store' FOR UPDATE");
      const recorded = result.rows[0]?.value;
      if (recorded && recorded.fingerprint !== identity.fingerprint) {
        throw new Error(`对象存储配置与数据库绑定不一致：数据库=${recorded.backend}:${recorded.location}，当前=${identity.backend}:${identity.location}`);
      }
      if (!recorded) {
        await client.query("INSERT INTO runtime_configuration(key,value) VALUES('object-store',$1)", [identity]);
      } else {
        await client.query("UPDATE runtime_configuration SET updated_at=now() WHERE key='object-store'");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getRuntimeConfiguration<T>(key: string): Promise<T | undefined> {
    const result = await this.pool.query<{ value: T }>("SELECT value FROM runtime_configuration WHERE key=$1", [key]);
    return result.rows[0]?.value;
  }

  async setRuntimeConfiguration(key: string, value: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      "INSERT INTO runtime_configuration(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
      [key, value],
    );
  }

  async listCurrentDocumentObjectKeys(): Promise<Array<{ documentId: string; title: string; objectKey: string }>> {
    const result = await this.pool.query<{ document_id: string; title: string; object_key: string }>(
      `SELECT d.id AS document_id,d.title,cb.object_key
       FROM manuscript_documents d
       JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
       JOIN content_blobs cb ON cb.content_hash=mr.content_hash
       WHERE d.status='final'`,
    );
    return result.rows.map((row) => ({ documentId: row.document_id, title: row.title, objectKey: row.object_key }));
  }

  async listReferencedObjectKeys(): Promise<Array<{ objectKey: string; contentHash: string; reference: string }>> {
    const result = await this.pool.query<{ object_key: string; content_hash: string; reference: string }>(`
      SELECT cb.object_key,cb.content_hash,'content-blob'::text AS reference
      FROM content_blobs cb
      WHERE EXISTS (SELECT 1 FROM manuscript_revisions mr WHERE mr.content_hash=cb.content_hash)
         OR EXISTS (SELECT 1 FROM manuscript_blocks mb WHERE mb.content_hash=cb.content_hash)
         OR EXISTS (SELECT 1 FROM artifacts a WHERE a.content_hash=cb.content_hash)
      UNION
      SELECT a.object_key,a.content_hash,'artifact'::text AS reference FROM artifacts a
      ORDER BY object_key
    `);
    return result.rows.map((row) => ({ objectKey: row.object_key, contentHash: row.content_hash, reference: row.reference }));
  }

  async listRunReviews(temporalWorkflowId: string) {
    const run = await this.getWorkflowRunByTemporalId(temporalWorkflowId);
    if (!run) return [];
    const result = await this.pool.query<{
      id: string; artifact_id: string; reviewer_id: string;
      identity: "internal" | "independent" | "human";
      verdict: "passed" | "revise" | "blocked";
      issues: Review["issues"]; score: number | null; role: string | null; dimension_scores: Review["dimensionScores"];
      created_at: Date | string;
    }>(`
      SELECT r.id,r.artifact_id,r.reviewer_id,r.identity,r.verdict,r.issues,r.score,r.role,r.dimension_scores,r.created_at
      FROM reviews r
      JOIN artifacts a ON a.id=r.artifact_id
      WHERE r.project_id=$1 AND (a.payload->>'workflowId'=$2 OR a.payload->>'runId'=$2)
      ORDER BY r.created_at ASC,r.id ASC
    `, [run.projectId, temporalWorkflowId]);
    return result.rows.map((row) => ({
      id: row.id, artifactId: row.artifact_id, reviewerId: row.reviewer_id,
      identity: row.identity, verdict: row.verdict, issues: row.issues ?? [],
      score: row.score === null ? undefined : Number(row.score), role: row.role ?? undefined, dimensionScores: row.dimension_scores ?? {},
      createdAt: new Date(row.created_at).getTime(),
    }));
  }

  async listRunOutbox(temporalWorkflowId: string, afterId = 0) {
    const run = await this.getWorkflowRunByTemporalId(temporalWorkflowId);
    if (!run) return [];
    const result = await this.pool.query(`
      WITH run_artifacts AS (
        SELECT id FROM artifacts
        WHERE project_id=$1 AND (payload->>'workflowId'=$2 OR payload->>'runId'=$2)
      )
      SELECT id,aggregate_type,aggregate_id,event_type,payload,created_at
      FROM outbox_events
      WHERE id>$3 AND payload->>'projectId'=$1 AND (
        (aggregate_type='workflow-run' AND aggregate_id=$2)
        OR payload->>'workflowId'=$2 OR payload->>'runId'=$2
        OR payload->'source'->>'workflowId'=$2
        OR aggregate_id IN (SELECT id FROM run_artifacts)
        OR payload->>'artifactId' IN (SELECT id FROM run_artifacts)
        OR payload->>'sourceArtifactId' IN (SELECT id FROM run_artifacts)
      )
      ORDER BY id LIMIT 200
    `, [run.projectId, temporalWorkflowId, afterId]);
    return result.rows;
  }

  /**
   * 列出项目下所有 foundation artifacts(全书规划产出)。
   *
   * 设计依据:AGENTS.md「root-cause analysis」——v2 重构后 foundation artifacts 未被章节生成
   * 消费,导致章节生成不基于全书规划。此方法是数据访问层入口,供 novelIntentWorkflow 加载
   * 全书规划产出并注入到章节生成的 blueprint/prompt。
   *
   * 性能:单项目 foundation artifacts 通常 ≤ 11 条(对应 bootstrap_run 的 taskChain),
   * 不需要分页。ORDER BY created_at ASC 保证依赖链顺序(后生成的覆盖先生成的)。
   */
  async listFoundationArtifacts(projectId: string): Promise<Artifact[]> {
    const result = await this.pool.query<ArtifactRow>(`
      SELECT id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload,created_at
      FROM artifacts
      WHERE project_id=$1 AND kind='foundation'
      ORDER BY created_at ASC
    `, [projectId]);
    return result.rows.map(artifactFromRow);
  }

  async getArtifactById(projectId: string, artifactId: string): Promise<Artifact | undefined> {
    const result = await this.pool.query<ArtifactRow>(
      `SELECT id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload,created_at
       FROM artifacts WHERE project_id=$1 AND id=$2`,
      [projectId, artifactId],
    );
    return result.rows[0] ? artifactFromRow(result.rows[0]) : undefined;
  }

  async getArtifact(artifactId: string): Promise<Artifact | undefined> {
    const result = await this.pool.query<ArtifactRow>(
      `SELECT id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload,created_at
       FROM artifacts WHERE id=$1`,
      [artifactId],
    );
    return result.rows[0] ? artifactFromRow(result.rows[0]) : undefined;
  }

  async createNextDocument(projectId: string, title?: string): Promise<ManuscriptDocumentSummary> {
    const narrativeOrder = await this.nextDocumentOrder(projectId);
    return this.ensureDocument({ projectId, title: title?.trim() || `第 ${narrativeOrder} 章`, narrativeOrder, status: "planned" });
  }

  async getDocumentStatus(projectId: string, documentId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ status: string }>("SELECT status FROM manuscript_documents WHERE project_id=$1 AND id=$2", [projectId, documentId]);
    return result.rows[0]?.status;
  }

  async getChapterReviewPreflight(projectId: string, documentId: string): Promise<{ status: string; baseRevision: number; activeWorkflowId?: string; hasBlueprint: boolean } | undefined> {
    const document = await this.pool.query<{ status: string; current_revision: string | number }>(
      `SELECT d.status,p.current_revision FROM manuscript_documents d JOIN novel_projects p ON p.id=d.project_id WHERE d.project_id=$1 AND d.id=$2`,
      [projectId, documentId],
    );
    if (!document.rowCount) return undefined;
    const [activeWorkflowId, blueprint] = await Promise.all([
      this.findActiveChapterReview(projectId, documentId),
      this.findHistoricalBlueprintForDocument(projectId, documentId),
    ]);
    return { status: document.rows[0].status, baseRevision: Number(document.rows[0].current_revision), activeWorkflowId, hasBlueprint: Boolean(blueprint) };
  }

  async findActiveChapterReview(projectId: string, documentId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ temporal_workflow_id: string }>(
      "SELECT temporal_workflow_id FROM workflow_runs WHERE project_id=$1 AND payload->>'documentId'=$2 AND workflow_type='chapter-review' AND status IN ('accepted','running','manual-review-required') ORDER BY updated_at DESC LIMIT 1",
      [projectId, documentId],
    );
    return result.rows[0]?.temporal_workflow_id;
  }

  async getPromotionReceiptById(receiptId: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.pool.query("SELECT id,candidate_id,project_id,status,result,failure_reason,created_at FROM promotion_receipts WHERE id=$1", [receiptId]);
    return result.rows[0];
  }

  async getCraftRuleTarget(target: { kind: "skill" | "system-prompt"; projectId: string; targetId: string }): Promise<Record<string, unknown> | undefined> {
    if (target.kind === "system-prompt") {
      const separator = target.targetId.indexOf(":");
      const projectId = separator >= 0 ? target.targetId.slice(0, separator) : target.projectId;
      const templateId = separator >= 0 ? target.targetId.slice(separator + 1) : target.targetId;
      if (!projectId || !templateId) return undefined;
      const result = await this.pool.query("SELECT project_id,template_id,version,stage,content,content_fingerprint,active,created_at,updated_at FROM prompt_templates WHERE project_id=$1 AND template_id=$2", [projectId, templateId]);
      return result.rows[0];
    }
    const result = await this.pool.query("SELECT skill_id,version,capabilities,applicable_tasks,required_memory_kinds,conflicts,quality_gates,prompt_sections,enabled,updated_at FROM skill_definitions WHERE skill_id=$1 ORDER BY version DESC LIMIT 1", [target.targetId]);
    return result.rows[0];
  }

  async countDocuments(projectId: string): Promise<number> {
    const result = await this.pool.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM manuscript_documents WHERE project_id=$1", [projectId]);
    return Number(result.rows[0]?.count ?? 0);
  }

  async findHistoricalBlueprintForDocument(projectId: string, documentId: string): Promise<{ blueprint: ExecutionBlueprint; artifactId: string } | undefined> {
    const result = await this.pool.query<{ payload: ExecutionBlueprint; artifact_id: string }>(
      `SELECT eb.payload,a.id AS artifact_id
       FROM artifacts a
       JOIN execution_blueprints eb ON a.task_id=eb.id || ':draft'
       JOIN novel_intents ni ON ni.id=eb.intent_id
       WHERE a.project_id=$1 AND a.kind='draft'
         AND ni.payload->'target'->>'kind'='chapter'
         AND ni.payload->'target'->>'id'=$2
       ORDER BY a.created_at DESC LIMIT 1`,
      [projectId, documentId],
    );
    return result.rows[0] ? { blueprint: result.rows[0].payload, artifactId: result.rows[0].artifact_id } : undefined;
  }

  async getFinalDocumentContentRef(projectId: string, documentId: string): Promise<{ title: string; status: string; revision: number; sourceRevisionId?: string; artifactId?: string; contentHash: string; objectKey: string } | undefined> {
    const result = await this.pool.query<{ title: string; status: string; revision_id: string | null; revision: string | number | null; artifact_id: string | null; content_hash: string | null; object_key: string | null }>(
      `SELECT d.title,d.status,mr.id AS revision_id,mr.revision,mr.artifact_id,mr.content_hash,cb.object_key
       FROM manuscript_documents d
       LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
       LEFT JOIN content_blobs cb ON cb.content_hash=mr.content_hash
       WHERE d.project_id=$1 AND d.id=$2`,
      [projectId, documentId],
    );
    const row = result.rows[0];
    if (!row || row.revision === null || !row.revision_id || !row.content_hash || !row.object_key) return row ? { title: row.title, status: row.status, revision: 0, contentHash: "", objectKey: "" } : undefined;
    return { title: row.title, status: row.status, revision: Number(row.revision), sourceRevisionId: row.revision_id, artifactId: row.artifact_id ?? undefined, contentHash: row.content_hash, objectKey: row.object_key };
  }

  async listCapturedSnapshots(projectId: string): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query("SELECT id,project_id,hash,head,created_at FROM project_snapshots WHERE project_id=$1 ORDER BY created_at DESC", [projectId]);
    return result.rows;
  }

  async getCapturedSnapshot(snapshotId: string, projectId?: string): Promise<ProjectSnapshotBundle | undefined> {
    const result = projectId
      ? await this.pool.query("SELECT id,project_id,hash,payload,head,created_at FROM project_snapshots WHERE id=$1 AND project_id=$2", [snapshotId, projectId])
      : await this.pool.query("SELECT id,project_id,hash,payload,head,created_at FROM project_snapshots WHERE id=$1", [snapshotId]);
    const row = result.rows[0];
    return row ? { id: row.id, projectId: row.project_id, hash: row.hash, payload: row.payload, head: row.head, createdAt: new Date(row.created_at).getTime() } : undefined;
  }

  async listCandidateBundles(projectId: string): Promise<CandidateBundle[]> {
    const result = await this.pool.query("SELECT payload FROM candidate_bundles WHERE project_id=$1 ORDER BY created_at DESC", [projectId]);
    return result.rows.map((row) => row.payload);
  }

  async getCandidateBundle(candidateId: string): Promise<CandidateBundle | undefined> {
    const result = await this.pool.query("SELECT payload FROM candidate_bundles WHERE id=$1", [candidateId]);
    return result.rows[0]?.payload;
  }

  async saveCandidateBundle(candidate: CandidateBundle): Promise<void> {
    await this.pool.query(
      "INSERT INTO candidate_bundles(id,experiment_id,project_id,payload,fingerprint,created_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(id) DO NOTHING",
      [candidate.id, candidate.experimentId, candidate.sourceProjectId, candidate, candidate.manuscript.contentHash],
    );
  }

  async listPromotionReceipts(projectId: string): Promise<PromotionReceipt[]> {
    const result = await this.pool.query("SELECT id,candidate_id,project_id,status,result,failure_reason,created_at FROM promotion_receipts WHERE project_id=$1 ORDER BY created_at DESC", [projectId]);
    return result.rows.map((row) => ({ id: row.id, candidateId: row.candidate_id, projectId: row.project_id, status: row.status, result: row.result, failureReason: row.failure_reason ?? undefined, createdAt: new Date(row.created_at).getTime() }));
  }

  async getDocumentRevisionBaseline(projectId: string, documentId: string): Promise<{ revision: number; contentHash: string } | undefined> {
    const result = await this.pool.query<{ revision: string | number; content_hash: string }>(
      `SELECT mr.revision,mr.content_hash FROM manuscript_documents d
       JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
       WHERE d.project_id=$1 AND d.id=$2`,
      [projectId, documentId],
    );
    return result.rows[0] ? { revision: Number(result.rows[0].revision), contentHash: result.rows[0].content_hash } : undefined;
  }

  async getDocumentNarrativeOrder(projectId: string, documentId: string): Promise<number | undefined> {
    const result = await this.pool.query<{ narrative_order: string | number }>("SELECT narrative_order FROM manuscript_documents WHERE project_id=$1 AND id=$2", [projectId, documentId]);
    return result.rows[0] ? Number(result.rows[0].narrative_order) : undefined;
  }

  async getLatestMemoryBundle(projectId: string): Promise<MemoryBundle | undefined> {
    const result = await this.pool.query<{ payload: MemoryBundle }>("SELECT payload FROM memory_bundles WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1", [projectId]);
    return result.rows[0]?.payload;
  }

  async ensureFoundationMemoryClaims(projectId: string): Promise<MemoryClaim[]> {
    const artifacts = await this.listFoundationArtifacts(projectId);
    if (!artifacts.length) return [];
    const claimIds = artifacts.map((artifact) => `foundation:${artifact.id}`);
    const existing = await this.pool.query<{ id: string }>(
      "SELECT id FROM memory_claims WHERE project_id=$1 AND id = ANY($2::text[])",
      [projectId, claimIds],
    );
    const existingIds = new Set(existing.rows.map((row) => row.id));
    const missing = artifacts.filter((artifact) => !existingIds.has(`foundation:${artifact.id}`));
    if (!missing.length) return [];

    const runIds = [...new Set(missing.map((artifact) => artifact.structuredData?.runId).filter((value): value is string => typeof value === "string"))];
    const objectives = new Map<string, string>();
    if (runIds.length) {
      const runs = await this.pool.query<{ id: string; objective: string | null }>(
        "SELECT id,payload->>'objective' AS objective FROM creative_runs WHERE id = ANY($1::text[])",
        [runIds],
      );
      for (const run of runs.rows) if (run.objective) objectives.set(run.id, run.objective);
    }

    const recorded: MemoryClaim[] = [];
    for (const artifact of missing) {
      const runId = typeof artifact.structuredData?.runId === "string" ? artifact.structuredData.runId : undefined;
      const claim = foundationArtifactToMemoryClaim(artifact, { objective: runId ? objectives.get(runId) : undefined });
      recorded.push(...await this.recordMemoryClaims({ projectId, claims: [claim], sourceArtifactId: artifact.id }));
    }
    return recorded;
  }

  async putCognition(plan: PreflightPlan, memory: MemoryBundle, skills: SkillBundle, blueprint: ExecutionBlueprint, context?: ContextManifest) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (context?.retrievalRunId) await client.query("INSERT INTO retrieval_runs(id,project_id,query,result) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING", [context.retrievalRunId, context.projectId, { preflightId: context.preflightId }, { includedClaimIds: context.includedClaimIds, excludedClaimIds: context.excludedClaimIds }]);
      await client.query("INSERT INTO preflight_plans(id,intent_id,project_id,payload,fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING", [plan.id, plan.intentId, plan.projectId, plan, plan.sourceFingerprint]);
      await client.query("INSERT INTO memory_bundles(id,project_id,preflight_id,payload,fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING", [memory.id, memory.projectId, memory.preflightId, memory, memory.fingerprint]);
      await client.query("INSERT INTO skill_bundles(id,project_id,preflight_id,payload,fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING", [skills.id, skills.projectId, skills.preflightId, skills, skills.fingerprint]);
      if (context) await client.query("INSERT INTO context_manifests(id,project_id,retrieval_run_id,source_revision_ids,token_budget,truncation_reason,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING", [context.id, context.projectId, context.retrievalRunId ?? null, context.sourceRevisionIds, context.tokenBudget, context.truncationReason ?? null, context.fingerprint, context]);
      await client.query("INSERT INTO execution_blueprints(id,project_id,intent_id,preflight_id,memory_bundle_id,skill_bundle_id,payload,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING", [blueprint.id, blueprint.projectId, blueprint.intentId, blueprint.preflightId, blueprint.memoryBundleId, blueprint.skillBundleId, blueprint, blueprint.fingerprint]);
      await this.appendOutboxTx(client, "execution-blueprint", blueprint.id, "execution-blueprint.ready", { ...blueprint, projectId: blueprint.projectId });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async upsertTaskAttempt(input: { id: string; workflowRunId?: string; taskId: string; status: TaskAttemptRecord["status"]; leaseOwner?: string; leaseMs?: number; payload?: Record<string, unknown> }) {
    const leaseExpires = input.leaseOwner && input.leaseMs ? new Date(Date.now() + input.leaseMs) : null;
    const result = await this.pool.query<TaskAttemptRow>(`INSERT INTO task_attempts(id,workflow_run_id,task_id,lease_owner,lease_expires_at,heartbeat_at,status,payload)
      VALUES($1,$2,$3,$4,$5,now(),$6,$7)
      ON CONFLICT(id) DO UPDATE SET workflow_run_id=COALESCE(EXCLUDED.workflow_run_id,task_attempts.workflow_run_id),lease_owner=COALESCE(EXCLUDED.lease_owner,task_attempts.lease_owner),lease_expires_at=COALESCE(EXCLUDED.lease_expires_at,task_attempts.lease_expires_at),heartbeat_at=now(),status=EXCLUDED.status,payload=task_attempts.payload || EXCLUDED.payload
      RETURNING id,workflow_run_id,task_id,lease_owner,lease_expires_at,heartbeat_at,status,payload`, [input.id, input.workflowRunId ?? null, input.taskId, input.leaseOwner ?? null, leaseExpires, input.status, input.payload ?? {}]);
    const row = taskAttemptFromRow(result.rows[0]);
    await this.appendOutbox("task-attempt", row.id, `task.${row.status}`, { workflowRunId: row.workflowRunId, taskId: row.taskId, attemptId: row.id, ...row.payload });
    return row;
  }

  async recordTaskSignal(input: { workflowId: string; taskId: string; signal: string; payload?: Record<string, unknown> }) {
    const attemptId = typeof input.payload?.attemptId === "string" ? input.payload.attemptId : `${input.taskId}:signal`;
    const status: TaskAttemptRecord["status"] = input.signal === "claim" ? "claimed" : input.signal === "heartbeat" ? "running" : input.signal === "artifact" ? "submitted" : input.signal === "review" ? "reviewed" : input.signal === "fail" ? "failed" : "running";
    return this.upsertTaskAttempt({ id: attemptId, workflowRunId: input.workflowId, taskId: input.taskId, status, leaseOwner: typeof input.payload?.leaseOwner === "string" ? input.payload.leaseOwner : undefined, leaseMs: 10 * 60_000, payload: { signal: input.signal, ...(input.payload ?? {}) } });
  }

  async recordArtifact(artifact: Artifact) {
    await this.pool.query("INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING", [artifact.id, artifact.projectId, artifact.taskId, artifact.attemptId, artifact.kind, artifact.contentHash, artifact.objectKey ?? "", artifact.baseRevision, artifact.fingerprint, artifact.structuredData ?? {}]);
    await this.appendOutbox("artifact", artifact.id, `artifact.${artifact.kind}.ready`, { projectId: artifact.projectId, artifactId: artifact.id, taskId: artifact.taskId, fingerprint: artifact.fingerprint });
  }

  async recordFactExtraction(input: { projectId: string; artifact: Artifact; claims: MemoryClaim[] }): Promise<MemoryClaim[]> {
    await this.recordArtifact(input.artifact);
    return this.recordMemoryClaims({ projectId: input.projectId, claims: input.claims, sourceArtifactId: input.artifact.id });
  }

  async recordMemoryClaims(input: { projectId: string; claims: MemoryClaim[]; sourceArtifactId?: string }): Promise<MemoryClaim[]> {
    if (!input.claims.length) return [];
    const recorded: MemoryClaim[] = [];
    for (const claim of input.claims) {
      // 二次去重：与数据库中已有 contentHash 比对（避免并发写入重复事实）
      const existing = await this.pool.query<{ id: string }>("SELECT id FROM memory_claims WHERE project_id=$1 AND content_hash=$2 LIMIT 1", [input.projectId, claim.contentHash]);
      if (existing.rowCount) continue;
      // P1-E5: ON CONFLICT 补全所有可变字段，避免 re-extract 时部分字段陈旧。
      // 设计依据：AGENTS.md「root-cause analysis」——原 ON CONFLICT 只更新
      // content/content_hash/confidence，导致 title/subject_refs/narrative_start/
      // narrative_end/knowledge_scope/authority/source_revision_ids/supersedes 在
      // claim id 冲突时保留旧值。当 character-enrichment 或 fact-extraction 重跑时，
      // supersedes 字段不更新会让 retrieval 层无法屏蔽被覆盖的旧 claim（P0-A1 修复失效）。
      await this.pool.query(
        "INSERT INTO memory_claims(id,project_id,kind,title,content,subject_refs,narrative_start,narrative_end,knowledge_scope,authority,confidence,source_revision_ids,content_hash,supersedes,source_artifact_id,predicate) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(id) DO UPDATE SET kind=EXCLUDED.kind,title=EXCLUDED.title,content=EXCLUDED.content,subject_refs=EXCLUDED.subject_refs,narrative_start=EXCLUDED.narrative_start,narrative_end=EXCLUDED.narrative_end,knowledge_scope=EXCLUDED.knowledge_scope,authority=EXCLUDED.authority,confidence=EXCLUDED.confidence,source_revision_ids=EXCLUDED.source_revision_ids,content_hash=EXCLUDED.content_hash,supersedes=EXCLUDED.supersedes,source_artifact_id=COALESCE(EXCLUDED.source_artifact_id,memory_claims.source_artifact_id),predicate=COALESCE(EXCLUDED.predicate,memory_claims.predicate)",
        [
          claim.id,
          claim.projectId,
          claim.kind,
          claim.title,
          claim.content,
          claim.subjectRefs,
          claim.narrativeRange?.start ?? null,
          claim.narrativeRange?.end ?? null,
          // knowledge_scope 是 jsonb 列：pg 对 JS 字符串不会自动加引号，
          // 必须显式 JSON.stringify 让 "author" 变成 '"author"'（合法 JSON 字符串）。
          // 与 putReview 的 issues 数组→jsonb 同类问题。
          JSON.stringify(claim.knowledgeScope),
          claim.authority,
          claim.confidence,
          claim.sourceRevisionIds,
          claim.contentHash,
          claim.supersedes,
          input.sourceArtifactId ?? claim.sourceArtifactId ?? null,
          claim.predicate ?? null,
        ],
      );
      await this.appendOutbox("memory-claim", claim.id, "memory-claim.upserted", { projectId: claim.projectId, claimId: claim.id, sourceArtifactId: input.sourceArtifactId, novelty: "new" });
      recorded.push(claim);
    }
    return recorded;
  }

  /**
   * Phase 3.1 写入叙事元素（伏笔/承诺/兑现）。
   *
   * 设计依据：Phase 3.1 计划——激活 foreshadowing/promises/payoffs 表。
   * 由 recordFactExtraction 在写入 claims 后调用，把 LLM 提取的 narrativeElements
   * 持久化到对应表，建立 payoff → foreshadowing/promise 的关联。
   *
   * 失败不阻塞 fact-extraction（claims 已写入），只记录警告。
   * payoff 关联策略：
   * - payoffType=foreshadowing：用 matchedTriggerKeywords 匹配未兑现 foreshadowing 的 trigger_keywords
   * - payoffType=promise：用 matchedPromiser 匹配未兑现 promise 的 promiser
   * 匹配不到时 payoff 仍写入（payoff_revision_id 关联当前章节），但不更新 foreshadowing/promise 状态。
   */
  async recordNarrativeElements(input: {
    projectId: string;
    documentId: string;
    artifact: Artifact;
    revisionId: string;
    narrativeElements: NonNullable<FactExtractionOutput["narrativeElements"]>;
    /** 当前章节的叙事顺序（1-based）。用于让未兑现伏笔按叙事顺序过滤，避免剧透未来章节。 */
    narrativeOrder?: number;
  }): Promise<{ foreshadowings: number; promises: number; payoffs: number }> {
    const { projectId, documentId, artifact, revisionId, narrativeElements, narrativeOrder } = input;
    const revision = await this.pool.query<{ id: string }>(
      "SELECT id FROM manuscript_revisions WHERE id=$1 AND project_id=$2 AND document_id=$3",
      [revisionId, projectId, documentId],
    );
    if (!revision.rowCount) throw new Error(`叙事元素投影要求已提交且归属匹配的 revision：${revisionId}`);
    let foreshadowingCount = 0;
    let promiseCount = 0;
    let payoffCount = 0;

    // 1. 写入 foreshadowings
    for (const f of narrativeElements.foreshadowings ?? []) {
      const id = `foreshadowing:${projectId}:${createHash("sha256").update(`${artifact.id}:${f.description}`).digest("hex").slice(0, 12)}`;
      await this.pool.query(
        "INSERT INTO foreshadowing(id, project_id, planted_revision_id, status, payload, narrative_order) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload, narrative_order=EXCLUDED.narrative_order",
        [id, projectId, revisionId, "open", { description: f.description, triggerKeywords: f.triggerKeywords, expectedPayoffWindow: f.expectedPayoffWindow, evidence: f.evidence, artifactId: artifact.id }, narrativeOrder ?? null],
      );
      foreshadowingCount += 1;
    }

    // 2. 写入 promises
    for (const p of narrativeElements.promises ?? []) {
      const id = `promise:${projectId}:${createHash("sha256").update(`${artifact.id}:${p.promiser}:${p.statement}`).digest("hex").slice(0, 12)}`;
      await this.pool.query(
        "INSERT INTO promises(id, project_id, statement, source_revision_id, status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET statement=EXCLUDED.statement",
        [id, projectId, p.statement, revisionId, "open"],
      );
      // payload 单独存（promises 表无 payload 列，用 statement 拼接 promiser/promisee）
      // TODO Phase 3.3: 若后续加 payload 列，再迁移
      promiseCount += 1;
    }

    // 3. 写入 payoffs 并尝试关联未兑现的 foreshadowing/promise
    for (const payoff of narrativeElements.payoffs ?? []) {
      const payoffId = `payoff:${projectId}:${createHash("sha256").update(`${artifact.id}:${payoff.description}`).digest("hex").slice(0, 12)}`;
      let matchedPromiseId: string | null = null;

      if (payoff.payoffType === "promise" && payoff.matchedPromiser) {
        // 查找未兑现的 promise，按 promiser 匹配（promiser 存在 statement 前缀，由步骤 2 写入）
        // 简化匹配：用 LIKE 模糊匹配 promiser 名字
        const candidate = await this.pool.query<{ id: string }>(
          "SELECT id FROM promises WHERE project_id=$1 AND status='open' AND statement ILIKE $2 ORDER BY source_revision_id DESC LIMIT 1",
          [projectId, `%${payoff.matchedPromiser}%`],
        );
        if (candidate.rowCount) matchedPromiseId = candidate.rows[0].id;
      }

      await this.pool.query(
        "INSERT INTO payoffs(id, promise_id, revision_id, evidence) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET evidence=EXCLUDED.evidence",
        [payoffId, matchedPromiseId ?? "unmatched", revisionId, { description: payoff.description, payoffType: payoff.payoffType, matchedTriggerKeywords: payoff.matchedTriggerKeywords, matchedPromiser: payoff.matchedPromiser, intensity: payoff.intensity, artifactId: artifact.id }],
      );

      // 若匹配到 promise，更新 promise 状态为 fulfilled
      if (matchedPromiseId) {
        await this.pool.query("UPDATE promises SET status='fulfilled' WHERE id=$1", [matchedPromiseId]);
      }

      // payoffType=foreshadowing 时，尝试用 matchedTriggerKeywords 关联并更新 foreshadowing 状态
      if (payoff.payoffType === "foreshadowing" && payoff.matchedTriggerKeywords?.length) {
        const openForeshadowings = await this.pool.query<{ id: string; payload: { triggerKeywords?: string[] } }>(
          "SELECT id, payload FROM foreshadowing WHERE project_id=$1 AND status='open'",
          [projectId],
        );
        for (const row of openForeshadowings.rows) {
          const triggerKeywords = row.payload?.triggerKeywords ?? [];
          const hasMatch = triggerKeywords.some((kw) => payoff.matchedTriggerKeywords!.includes(kw));
          if (hasMatch) {
            await this.pool.query("UPDATE foreshadowing SET status='fulfilled', payoff_revision_id=$2 WHERE id=$1", [row.id, revisionId]);
          }
        }
      }

      payoffCount += 1;
    }

    return { foreshadowings: foreshadowingCount, promises: promiseCount, payoffs: payoffCount };
  }

  async getChapterTitleSource(projectId: string, documentId: string): Promise<Omit<ChapterTitleSource, "plainText" | "blueprint"> & { blueprint: Record<string, unknown>; objectKey?: string } | undefined> {
    const result = await this.pool.query<{
      project_title: string; document_id: string; current_title: string; narrative_order: string | number;
      chapter_goal: string | null; blueprint: Record<string, unknown> | null; blueprint_fingerprint: string | null;
      content_hash: string | null; object_key: string | null;
    }>(`
      SELECT p.title AS project_title,d.id AS document_id,d.title AS current_title,d.narrative_order,
        cps.chapter_goal,cps.blueprint,cps.blueprint_fingerprint,mr.content_hash,cb.object_key
      FROM manuscript_documents d
      JOIN novel_projects p ON p.id=d.project_id
      LEFT JOIN chapter_production_specs cps ON cps.document_id=d.id
      LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
      LEFT JOIN content_blobs cb ON cb.content_hash=mr.content_hash
      WHERE d.project_id=$1 AND d.id=$2
    `, [projectId, documentId]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      projectTitle: row.project_title,
      documentId: row.document_id,
      currentTitle: row.current_title,
      narrativeOrder: Number(row.narrative_order),
      chapterGoal: row.chapter_goal ?? "",
      blueprint: row.blueprint ?? {},
      blueprintFingerprint: row.blueprint_fingerprint ?? "",
      contentHash: row.content_hash ?? undefined,
      objectKey: row.object_key ?? undefined,
    };
  }

  async saveGeneratedChapterTitleIfCurrent(input: { projectId: string; documentId: string; sourceFingerprint: string; title: string }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        project_title: string; document_id: string; current_title: string; narrative_order: string | number;
        chapter_goal: string | null; blueprint: Record<string, unknown> | null; blueprint_fingerprint: string | null; content_hash: string | null;
      }>(`
        SELECT p.title AS project_title,d.id AS document_id,d.title AS current_title,d.narrative_order,
          cps.chapter_goal,cps.blueprint,cps.blueprint_fingerprint,mr.content_hash
        FROM manuscript_documents d
        JOIN novel_projects p ON p.id=d.project_id
        LEFT JOIN chapter_production_specs cps ON cps.document_id=d.id
        LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
        WHERE d.project_id=$1 AND d.id=$2
        FOR UPDATE OF d,p
      `, [input.projectId, input.documentId]);
      const row = result.rows[0];
      if (!row) throw new Error("章节不存在");
      const currentFingerprint = chapterTitleSourceFingerprint({
        projectTitle: row.project_title,
        documentId: row.document_id,
        currentTitle: row.current_title,
        narrativeOrder: Number(row.narrative_order),
        chapterGoal: row.chapter_goal ?? "",
        blueprintFingerprint: row.blueprint_fingerprint ?? "",
        contentHash: row.content_hash ?? undefined,
      });
      if (currentFingerprint !== input.sourceFingerprint) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query("UPDATE manuscript_documents SET title=$3,updated_at=now() WHERE project_id=$1 AND id=$2", [input.projectId, input.documentId, input.title]);
      await client.query(
        "UPDATE chapters SET title=$3,payload=jsonb_set(payload,'{title}',to_jsonb($3::text),true),updated_at=now() WHERE project_id=$1 AND document_id=$2",
        [input.projectId, input.documentId, input.title],
      );
      await client.query("COMMIT");
      await this.appendOutbox("manuscript-document", input.documentId, "chapter.title-generated", { projectId: input.projectId, documentId: input.documentId, title: input.title, sourceFingerprint: input.sourceFingerprint });
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordProjectionFailure(input: { projectId: string; projectionType: string; aggregateId: string; payload: Record<string, unknown>; error: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO projection_failures(project_id,projection_type,aggregate_id,payload,error_message,attempts,updated_at)
       VALUES($1,$2,$3,$4,$5,1,now())
       ON CONFLICT(projection_type,aggregate_id) DO UPDATE SET payload=EXCLUDED.payload,error_message=EXCLUDED.error_message,status='pending',attempts=projection_failures.attempts+1,updated_at=now()`,
      [input.projectId, input.projectionType, input.aggregateId, input.payload, input.error],
    );
  }

  async heartbeatRuntimeService(input: { serviceId: string; serviceType: string; status: string; details?: Record<string, unknown> }): Promise<void> {
    await this.pool.query(
      `INSERT INTO runtime_services(service_id,service_type,status,details,heartbeat_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT(service_id) DO UPDATE SET status=EXCLUDED.status,details=EXCLUDED.details,heartbeat_at=now()`,
      [input.serviceId, input.serviceType, input.status, input.details ?? {}],
    );
  }

  async latestRuntimeService(serviceType: string): Promise<{ serviceId: string; status: string; details: Record<string, unknown>; heartbeatAt: string } | undefined> {
    const result = await this.pool.query<{ service_id: string; status: string; details: Record<string, unknown>; heartbeat_at: Date | string }>(
      "SELECT service_id,status,details,heartbeat_at FROM runtime_services WHERE service_type=$1 ORDER BY heartbeat_at DESC LIMIT 1",
      [serviceType],
    );
    const row = result.rows[0];
    return row ? { serviceId: row.service_id, status: row.status, details: row.details, heartbeatAt: new Date(row.heartbeat_at).toISOString() } : undefined;
  }

  /**
   * Phase 3.1 查询未兑现的伏笔与承诺，供 drafting/revision 注入上下文。
   *
   * 设计依据：Phase 3.1 计划——buildMemoryBundle 把未兑现的 foreshadowing/promise
   * 注入上下文（高优先级），提醒 LLM 本章是否应兑现。
   *
   * 返回结构化数据，由 retrieveMemory activity 包装为 MemoryHit[] 注入 MemoryBundle。
   */
  async getOpenForeshadowingAndPromises(projectId: string, narrativeCutoff?: number): Promise<{
    foreshadowings: Array<{ id: string; description: string; triggerKeywords: string[]; expectedPayoffWindow: string; plantedRevisionId: string }>;
    promises: Array<{ id: string; promiser: string; promisee: string; statement: string; sourceRevisionId: string }>;
  }> {
    // P0 #2: 按叙事顺序过滤未兑现伏笔，避免长篇后期审校注入"未来章节"埋设的伏笔造成剧透。
    // narrativeCutoff = 当前章节顺序 - 1（由 retrieveMemory 传入），只有 planted 在 cutoff 之前
    // （narrative_order <= cutoff）的伏笔才对当前章节可见、可被其兑现。迁移会尽力回填旧数据；
    // 仍无法确定顺序的记录在有 cutoff 时隐藏，避免未知来源被错误当作过去事实而泄露未来剧情。
    const foreshadowingSql = narrativeCutoff === undefined
      ? "SELECT id, planted_revision_id, payload FROM foreshadowing WHERE project_id=$1 AND status='open' ORDER BY planted_revision_id ASC"
      : "SELECT id, planted_revision_id, payload FROM foreshadowing WHERE project_id=$1 AND status='open' AND narrative_order <= $2 ORDER BY narrative_order ASC, planted_revision_id ASC";
    const foreshadowingParams = narrativeCutoff === undefined ? [projectId] : [projectId, narrativeCutoff];
    // 查询未兑现的 foreshadowing
    const foreshadowingRows = await this.pool.query<{ id: string; planted_revision_id: string; payload: { description?: string; triggerKeywords?: string[]; expectedPayoffWindow?: string } }>(
      foreshadowingSql,
      foreshadowingParams,
    );
    const foreshadowings = foreshadowingRows.rows.map((row) => ({
      id: row.id,
      description: row.payload?.description ?? "",
      triggerKeywords: row.payload?.triggerKeywords ?? [],
      expectedPayoffWindow: row.payload?.expectedPayoffWindow ?? "未指定",
      plantedRevisionId: row.planted_revision_id,
    }));

    // 查询未兑现的 promises
    const promiseRows = await this.pool.query<{ id: string; statement: string; source_revision_id: string }>(
      "SELECT id, statement, source_revision_id FROM promises WHERE project_id=$1 AND status='open' ORDER BY source_revision_id ASC",
      [projectId],
    );
    // promiser/promisee 存在 statement 前缀（由 recordNarrativeElements 步骤 2 写入时拼接）
    // 简化解析：statement 字段直接返回，promiser/promisee 从 statement 中解析（或留空）
    const promises = promiseRows.rows.map((row) => ({
      id: row.id,
      promiser: "", // TODO Phase 3.3: promises 表加 payload 列后补充
      promisee: "",
      statement: row.statement,
      sourceRevisionId: row.source_revision_id,
    }));

    return { foreshadowings, promises };
  }

  /**
   * Phase 3.2 写入爽点曲线（payoff_curve 表）。
   *
   * 设计依据：Phase 3.2 计划 + AGENTS.md「reusable contracts over case-specific rules」。
   * 由 extractFacts activity 在写入 claims/narrativeElements 后调用，把 LLM 提取的
   * payoffMoments 持久化到 payoff_curve 表，供 reader-reviewer 检查连续无爽点。
   *
   * 失败不阻塞 fact-extraction（claims/narrativeElements 已写入），只记录警告。
   *
   * payoff_type 是通用爽感维度（achievement/recognition/reversal/emotional/mystery），
   * 非 Phase 3.3 已移除的金手指/系统流特化——任何题材的爽感剧情都可用同一维度衡量。
   */
  async recordPayoffCurve(input: {
    projectId: string;
    documentId: string;
    revisionId: string;
    narrativeOrder: number;
    payoffMoments: NonNullable<FactExtractionOutput["payoffMoments"]>;
  }): Promise<number> {
    const { projectId, documentId, revisionId, narrativeOrder, payoffMoments } = input;
    let recorded = 0;
    for (const moment of payoffMoments) {
      const id = `payoff-curve:${projectId}:${createHash("sha256").update(`${revisionId}:${moment.payoffType}:${moment.description}`).digest("hex").slice(0, 12)}`;
      await this.pool.query(
        `INSERT INTO payoff_curve(id, project_id, document_id, revision_id, narrative_order, payoff_type, intensity, setup_revision_id, payoff_description, evidence, setup_description)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT(id) DO UPDATE SET intensity=EXCLUDED.intensity, payoff_description=EXCLUDED.payoff_description, evidence=COALESCE(EXCLUDED.evidence, payoff_curve.evidence), setup_description=COALESCE(EXCLUDED.setup_description, payoff_curve.setup_description)`,
        [
          id,
          projectId,
          documentId,
          revisionId,
          narrativeOrder,
          moment.payoffType,
          moment.intensity,
          null, // setup_revision_id 暂留空（fact-extraction 阶段无前章铺垫映射）
          moment.description,
          // P2-G4: 落库 evidence（正文逐字证据）和 setupDescription（铺垫描述）
          // 设计依据：AGENTS.md「reusable contracts」——evidence 是审校/learning 根因分析
          // 的事实依据，不允许只存描述不存证据。setupDescription 可为空（LLM 可选返回）。
          moment.evidence ?? null,
          moment.setupDescription ?? null,
        ],
      );
      recorded += 1;
    }
    return recorded;
  }

  /**
   * Phase 3.2 查询最近 N 章的爽点统计，供 reader-reviewer 检查连续无爽点。
   *
   * 设计依据：Phase 3.2 计划——reader-reviewer 需要「连续 N 章无爽点」的事实依据，
   * 不允许 LLM 凭感觉判断。本方法返回结构化数据，由 review activity 注入 prompt。
   *
   * 返回值：
   * - recentChapters：最近 N 章的爽点分布（按章聚合，intensity 之和）
   * - consecutiveNoPayoff：连续无爽点的章数（从最新章向前数）
   * - totalPayoffs：最近 N 章的爽点总数
   * - byType：按 payoff_type 分组的爽点数（用于检查某类型爽点长期缺失）
   */
  async getRecentPayoffStats(input: {
    projectId: string;
    /** 截止章节（不含），通常是当前审校章节的 narrative_order */
    narrativeCutoff: number;
    /** 回溯章节数，默认 5 */
    windowSize?: number;
  }): Promise<{
    recentChapters: Array<{ narrativeOrder: number; payoffCount: number; maxIntensity: number; totalIntensity: number; types: string[] }>;
    consecutiveNoPayoff: number;
    totalPayoffs: number;
    byType: Record<string, number>;
  }> {
    const { projectId, narrativeCutoff, windowSize = 5 } = input;
    const startOrder = Math.max(1, narrativeCutoff - windowSize);
    const result = await this.pool.query<{
      narrative_order: number;
      payoff_type: string;
      intensity: number;
    }>(
      `SELECT narrative_order, payoff_type, intensity FROM payoff_curve
       WHERE project_id=$1 AND narrative_order >= $2 AND narrative_order < $3
       ORDER BY narrative_order ASC, intensity DESC`,
      [projectId, startOrder, narrativeCutoff],
    );

    // 按章聚合
    const byChapter = new Map<number, { payoffCount: number; maxIntensity: number; totalIntensity: number; types: Set<string> }>();
    const byType: Record<string, number> = {};
    for (const row of result.rows) {
      const order = Number(row.narrative_order);
      const entry = byChapter.get(order) ?? { payoffCount: 0, maxIntensity: 0, totalIntensity: 0, types: new Set<string>() };
      entry.payoffCount += 1;
      entry.maxIntensity = Math.max(entry.maxIntensity, Number(row.intensity));
      entry.totalIntensity += Number(row.intensity);
      entry.types.add(row.payoff_type);
      byChapter.set(order, entry);
      byType[row.payoff_type] = (byType[row.payoff_type] ?? 0) + 1;
    }

    // P2-G3: consecutiveNoPayoff 不截断——独立查询无爽点后缀长度
    // 设计依据：AGENTS.md「root-cause analysis」——原实现只在 windowSize=5 内数连续无爽点，
    // 导致真实干旱超过 5 章时被截断报告为 5，reader-reviewer 误判「干旱不严重」。
    // 修复：consecutiveNoPayoff 单独查询，从 cutoff-1 向前数到第一章有爽点或 chapter 1，
    // 不受 windowSize 限制。recentChapters 仍保留 windowSize 截断（避免 prompt 过长）。
    let consecutiveNoPayoff = 0;
    if (narrativeCutoff > 1) {
      // 查询 cutoff 之前所有「有爽点」的章节的最大 narrative_order，
      // consecutiveNoPayoff = (cutoff - 1) - that_max，若不存在则为 cutoff - 1
      const droughtResult = await this.pool.query<{ max_order: number | null }>(
        `SELECT MAX(narrative_order) AS max_order FROM payoff_curve
         WHERE project_id=$1 AND narrative_order < $2`,
        [projectId, narrativeCutoff],
      );
      const lastPayoffOrder = droughtResult.rows[0]?.max_order;
      if (lastPayoffOrder === null || lastPayoffOrder === undefined) {
        // cutoff 之前从未有爽点 → 干旱 = cutoff - 1（从第 1 章到 cutoff-1 章全无爽点）
        consecutiveNoPayoff = narrativeCutoff - 1;
      } else {
        consecutiveNoPayoff = Math.max(0, narrativeCutoff - 1 - Number(lastPayoffOrder));
      }
    }

    const recentChapters = Array.from(byChapter.entries())
      .map(([order, entry]) => ({
        narrativeOrder: order,
        payoffCount: entry.payoffCount,
        maxIntensity: entry.maxIntensity,
        totalIntensity: entry.totalIntensity,
        types: [...entry.types],
      }))
      .sort((a, b) => a.narrativeOrder - b.narrativeOrder);

    return {
      recentChapters,
      consecutiveNoPayoff,
      totalPayoffs: result.rowCount ?? 0,
      byType,
    };
  }

  /**
   * 写入 chapter memory（章节级结构化摘要）。
   *
   * 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约。
   * 通过 (project_id, document_id) 唯一约束：同一章节只保留最新 chapter memory，
   * revision_id 变化时 UPSERT 覆盖（章节重审后 chapter memory 跟随更新）。
   */
  async createChapterMemory(input: ChapterMemory): Promise<ChapterMemory> {
    await this.pool.query(
      `INSERT INTO chapter_memories(id,project_id,document_id,revision_id,narrative_start,narrative_end,summary,key_events,character_states,unresolved_threads,emotional_arc,fingerprint,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         revision_id=EXCLUDED.revision_id,
         narrative_start=EXCLUDED.narrative_start,
         narrative_end=EXCLUDED.narrative_end,
         summary=EXCLUDED.summary,
         key_events=EXCLUDED.key_events,
         character_states=EXCLUDED.character_states,
         unresolved_threads=EXCLUDED.unresolved_threads,
         emotional_arc=EXCLUDED.emotional_arc,
         fingerprint=EXCLUDED.fingerprint,
         created_at=EXCLUDED.created_at`,
      [
        input.id,
        input.projectId,
        input.documentId,
        input.revisionId,
        input.narrativeRange.start,
        input.narrativeRange.end,
        input.summary,
        JSON.stringify(input.keyEvents),
        JSON.stringify(input.characterStates),
        JSON.stringify(input.unresolvedThreads),
        input.emotionalArc ?? null,
        input.fingerprint,
        input.createdAt,
      ],
    );
    await this.appendOutbox("chapter-memory", input.id, "chapter-memory.upserted", {
      projectId: input.projectId,
      documentId: input.documentId,
      revisionId: input.revisionId,
      narrativeStart: input.narrativeRange.start,
      narrativeEnd: input.narrativeRange.end,
    });
    return input;
  }

  async refreshChapterMemoryRollup(projectId: string, narrativeOrder: number, windowSize = 20): Promise<MemoryClaim> {
    const start = Math.floor(Math.max(0, narrativeOrder - 1) / windowSize) * windowSize + 1;
    const end = start + windowSize - 1;
    const memories = (await this.getChapterMemories({ projectId, narrativeCutoff: end, limit: windowSize }))
      .filter((memory) => memory.narrativeRange.start >= start && memory.narrativeRange.start <= end);
    if (!memories.length) throw new Error(`第 ${start}-${end} 章没有可汇总的 chapter memory`);

    const unresolved = [...new Set(memories.flatMap((memory) => memory.unresolvedThreads))].slice(0, 80);
    const latestCharacterStates = new Map<string, string>();
    for (const memory of memories) for (const state of memory.characterStates) latestCharacterStates.set(state.characterId, state.stateSnapshot);
    const chapterSummaries = memories.map((memory) => `第${memory.narrativeRange.start}章：${memory.summary}`);
    const content = [
      `章节窗口：第${start}-${Math.min(end, memories.at(-1)?.narrativeRange.end ?? end)}章`,
      `阶段进展：\n${chapterSummaries.join("\n")}`,
      unresolved.length ? `尚未解决：${unresolved.join("；")}` : "尚未解决：无",
      latestCharacterStates.size ? `窗口末角色状态：${[...latestCharacterStates].map(([characterId, state]) => `${characterId}——${state}`).join("；")}` : "",
    ].filter(Boolean).join("\n").slice(0, 12_000);
    const id = `chapter-memory:rollup:${projectId}:${start}-${end}`;
    const claim: MemoryClaim = {
      id,
      projectId,
      kind: "hierarchical",
      title: `第${start}-${end}章长期记忆汇总`,
      content,
      subjectRefs: [...latestCharacterStates.keys()],
      narrativeRange: { start, end: Math.min(end, memories.at(-1)?.narrativeRange.end ?? end) },
      knowledgeScope: "author",
      authority: "derived",
      confidence: 0.9,
      sourceRevisionIds: [...new Set(memories.map((memory) => memory.revisionId))],
      contentHash: createHash("sha256").update(content).digest("hex"),
      supersedes: [],
      predicate: "chapter-memory-rollup",
    };
    const [recorded] = await this.recordMemoryClaims({ projectId, claims: [claim] });
    return recorded ?? claim;
  }

  /**
   * 按项目 + 章节顺序范围检索 chapter memory（用于 buildMemoryBundle 注入前章摘要）。
   *
   * 每个 document 可能有多个 chapter memory（每 revision 一条），用 DISTINCT ON 取最新一条。
   * 排序：按 narrative_start ASC（章节顺序），让上游能按时间线串联前章进展。
   * narrativeCutoff：若提供，只返回 narrative_start <= cutoff 的章节（叙事截止前）。
   */
  async getChapterMemories(input: { projectId: string; narrativeCutoff?: number; limit?: number }): Promise<ChapterMemory[]> {
    const params: unknown[] = [input.projectId];
    let cutoffClause = "";
    if (input.narrativeCutoff !== undefined) {
      params.push(input.narrativeCutoff);
      cutoffClause = ` AND narrative_start <= $${params.length}`;
    }
    params.push(input.limit ?? 32);
    const limitClause = ` LIMIT $${params.length}`;
    const result = await this.pool.query<any>(
      `WITH latest_per_document AS (
         SELECT DISTINCT ON (document_id)
           id,project_id,document_id,revision_id,narrative_start,narrative_end,summary,key_events,character_states,unresolved_threads,emotional_arc,fingerprint,created_at
         FROM chapter_memories
         WHERE project_id=$1${cutoffClause}
         ORDER BY document_id ASC, created_at DESC, id DESC
       ), recent AS (
         SELECT * FROM latest_per_document
         ORDER BY narrative_start DESC, created_at DESC, id DESC${limitClause}
       )
       SELECT * FROM recent
       ORDER BY narrative_start ASC, created_at ASC, id ASC`,
      params,
    );
    return result.rows.map((row: any) => ({
      id: row.id,
      projectId: row.project_id,
      documentId: row.document_id,
      revisionId: row.revision_id,
      narrativeRange: { start: Number(row.narrative_start), end: Number(row.narrative_end) },
      summary: row.summary,
      keyEvents: row.key_events ?? [],
      characterStates: row.character_states ?? [],
      unresolvedThreads: row.unresolved_threads ?? [],
      emotionalArc: row.emotional_arc ?? undefined,
      fingerprint: row.fingerprint,
      createdAt: Number(row.created_at),
    }));
  }

  /**
   * 按 documentId 查询单条 chapter memory（章节审校时取最近 chapter memory）。
   */
  async getChapterMemoryByDocument(projectId: string, documentId: string): Promise<ChapterMemory | undefined> {
    const result = await this.pool.query<any>(
      `SELECT id,project_id,document_id,revision_id,narrative_start,narrative_end,summary,key_events,character_states,unresolved_threads,emotional_arc,fingerprint,created_at
       FROM chapter_memories
       WHERE project_id=$1 AND document_id=$2
       ORDER BY created_at DESC
       LIMIT 1`,
      [projectId, documentId],
    );
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    return {
      id: row.id,
      projectId: row.project_id,
      documentId: row.document_id,
      revisionId: row.revision_id,
      narrativeRange: { start: Number(row.narrative_start), end: Number(row.narrative_end) },
      summary: row.summary,
      keyEvents: row.key_events ?? [],
      characterStates: row.character_states ?? [],
      unresolvedThreads: row.unresolved_threads ?? [],
      emotionalArc: row.emotional_arc ?? undefined,
      fingerprint: row.fingerprint,
      createdAt: Number(row.created_at),
    };
  }

  async recordLearningAssessment(assessment: RuntimeLearningAssessmentV2) {
    if (assessment.conclusion === "propose-improvement" && (!assessment.underlyingMechanism || !assessment.affectedInputClass || !assessment.candidate)) throw new Error("propose-improvement 必须包含机制、影响输入类和候选变更");
    await this.pool.query("INSERT INTO learning_assessments(id,project_id,source,conclusion,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,conclusion=EXCLUDED.conclusion", [assessment.id, assessment.projectId, assessment.source, assessment.conclusion, assessment]);
    await this.appendOutbox("learning-assessment", assessment.id, `learning.${assessment.conclusion}`, { projectId: assessment.projectId, assessmentId: assessment.id, source: assessment.source, proposeImprovement: assessment.conclusion === "propose-improvement" });
    return assessment;
  }

  async requestLearningPromotion(assessmentId: string) {
    const result = await this.pool.query<{ project_id: string; payload: RuntimeLearningAssessmentV2 }>("SELECT project_id,payload FROM learning_assessments WHERE id=$1", [assessmentId]);
    const assessment = result.rows[0]?.payload;
    if (!assessment) throw new Error("learning assessment 不存在");
    if (assessment.conclusion !== "propose-improvement" || !assessment.candidate) throw new Error("只有 propose-improvement 可进入 promote 回归验证");
    await this.pool.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,$3,$4,$5,$6)", [result.rows[0].project_id, "runtime-learning", "promotion-regression-required", "learning-assessment", assessmentId, { assessmentId, candidate: assessment.candidate, regressionRisks: assessment.regressionRisks ?? [] }]);
    await this.appendOutbox("learning-assessment", assessmentId, "learning.promotion-regression-required", { projectId: result.rows[0].project_id, assessmentId, targetKind: assessment.candidate.targetKind, targetId: assessment.candidate.targetId });
    return { assessmentId, promoted: false, status: "regression-validation-required" as const, candidate: assessment.candidate };
  }

  async listFactCandidates(projectId: string, documentId?: string): Promise<MemoryClaim[]> {
    const result = await this.pool.query<any>(
      `SELECT mc.*
       FROM memory_claims mc
       LEFT JOIN artifacts fact_artifact ON fact_artifact.id=mc.source_artifact_id
       LEFT JOIN artifacts source_artifact ON source_artifact.id=fact_artifact.payload->>'sourceArtifactId'
       WHERE mc.project_id=$1 AND mc.authority='candidate'
         AND ($2::text IS NULL OR source_artifact.payload->>'documentId'=$2)
       ORDER BY mc.created_at DESC,mc.id`,
      [projectId, documentId ?? null],
    );
    return result.rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      kind: row.kind,
      title: row.title,
      content: row.content,
      subjectRefs: row.subject_refs ?? [],
      narrativeRange: { start: row.narrative_start ?? undefined, end: row.narrative_end ?? undefined },
      knowledgeScope: row.knowledge_scope,
      authority: row.authority,
      confidence: Number(row.confidence),
      sourceRevisionIds: row.source_revision_ids ?? [],
      contentHash: row.content_hash,
      supersedes: row.supersedes ?? [],
      predicate: row.predicate ?? undefined,
      sourceArtifactId: row.source_artifact_id ?? undefined,
      decidedBy: row.decided_by ?? undefined,
      decidedAt: row.decided_at ? iso(row.decided_at) : undefined,
    }));
  }

  async decideFactCandidate(input: { projectId: string; claimId: string; actorId: string; decision: "approve" | "reject"; reason?: string }): Promise<{ claimId: string; authority: "approved" | "rejected" }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ authority: string }>("SELECT authority FROM memory_claims WHERE id=$1 AND project_id=$2 FOR UPDATE", [input.claimId, input.projectId]);
      if (!current.rowCount) throw new Error(`事实候选不存在：${input.claimId}`);
      if (current.rows[0].authority !== "candidate") throw new Error(`事实候选已处理（当前 authority=${current.rows[0].authority}）`);
      const authority = input.decision === "approve" ? "approved" : "rejected";
      await client.query("UPDATE memory_claims SET authority=$3,decided_by=$4,decided_at=now() WHERE id=$1 AND project_id=$2", [input.claimId, input.projectId, authority, input.actorId]);
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,$3,'memory-claim',$4,$5)",
        [input.projectId, input.actorId, `fact-candidate.${input.decision}`, input.claimId, { decision: input.decision, reason: input.reason }],
      );
      await this.appendOutboxTx(client, "memory-claim", input.claimId, `memory-claim.${authority}`, { projectId: input.projectId, claimId: input.claimId, actorId: input.actorId, reason: input.reason });
      await client.query("COMMIT");
      return { claimId: input.claimId, authority };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getFactExtractionContext(projectId: string): Promise<{ contentHashes: Set<string>; claimsIndex: Map<string, string[]> }> {
    const result = await this.pool.query<{ id: string; content_hash: string; subject_refs: string[] | null; predicate: string | null }>(
      "SELECT id,content_hash,subject_refs,predicate FROM memory_claims WHERE project_id=$1 AND authority <> 'rejected'",
      [projectId],
    );
    const contentHashes = new Set<string>();
    const claimsIndex = new Map<string, string[]>();
    for (const row of result.rows) {
      contentHashes.add(row.content_hash);
      if (!row.predicate) continue;
      for (const subject of row.subject_refs ?? []) {
        const key = `${subject}|${row.predicate}`;
        claimsIndex.set(key, [...(claimsIndex.get(key) ?? []), row.id]);
      }
    }
    return { contentHashes, claimsIndex };
  }

  async recordFactApprovalPolicy(input: { projectId: string; artifactId: string; workflowId: string }): Promise<FactApprovalSummary> {
    // P0 #1: 记录自动审批决定——derived 事实视为 runtime 自动批准，写入 decided_by/decided_at 以便审计。
    // 此前该函数仅做统计、不改 authority，导致"审批"形同虚设。
    await this.pool.query(
      "UPDATE memory_claims SET decided_by='runtime', decided_at=now() WHERE project_id=$1 AND source_artifact_id=$2 AND authority='derived'",
      [input.projectId, input.artifactId],
    );
    const result = await this.pool.query<{ authority: string; count: string }>(
      "SELECT authority,count(*)::text AS count FROM memory_claims WHERE project_id=$1 AND source_artifact_id=$2 GROUP BY authority",
      [input.projectId, input.artifactId],
    );
    const counts = new Map(result.rows.map((row) => [row.authority, Number(row.count)]));
    const pendingIds = (await this.pool.query<{ id: string }>(
      "SELECT id FROM memory_claims WHERE project_id=$1 AND source_artifact_id=$2 AND authority='candidate'",
      [input.projectId, input.artifactId],
    )).rows.map((row) => row.id);
    const summary: FactApprovalSummary = { autoApproved: counts.get("derived") ?? 0, pending: counts.get("candidate") ?? 0, pendingIds };
    await this.pool.query(
      "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'runtime','fact-approval.policy-applied','artifact',$2,$3)",
      [input.projectId, input.artifactId, { workflowId: input.workflowId, ...summary }],
    );
    await this.appendOutbox("artifact", input.artifactId, "fact-approval.policy-applied", { projectId: input.projectId, workflowId: input.workflowId, ...summary });
    return summary;
  }

  /**
   * P0 #1: 批量批准事实候选（人工事实审批门通过时调用）。
   * 将 candidate 事实翻转为 approved（authority=approved, decided_by='author'）。
   * 返回更新后的 MemoryClaim 列表，由 activity 层（createNovelWorkflowActivities.approveFactClaims）
   * 写回 Qdrant 向量索引；本函数只负责 PostgreSQL 真源。
   */
  async approveFactClaims(input: { projectId: string; ids: string[] }): Promise<MemoryClaim[]> {
    if (input.ids.length === 0) return [];
    await this.pool.query(
      "UPDATE memory_claims SET authority='approved', decided_by='author', decided_at=now() WHERE project_id=$1 AND id = ANY($2::text[]) AND authority='candidate'",
      [input.projectId, input.ids],
    );
    const result = await this.pool.query<any>(
      "SELECT * FROM memory_claims WHERE project_id=$1 AND id = ANY($2::text[])",
      [input.projectId, input.ids],
    );
    return result.rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      kind: row.kind,
      title: row.title,
      content: row.content,
      subjectRefs: row.subject_refs ?? [],
      narrativeRange: { start: row.narrative_start ?? undefined, end: row.narrative_end ?? undefined },
      knowledgeScope: row.knowledge_scope,
      authority: row.authority,
      confidence: Number(row.confidence),
      sourceRevisionIds: row.source_revision_ids ?? [],
      contentHash: row.content_hash,
      supersedes: row.supersedes ?? [],
      predicate: row.predicate ?? undefined,
      sourceArtifactId: row.source_artifact_id ?? undefined,
      decidedBy: row.decided_by ?? undefined,
      decidedAt: row.decided_at ? iso(row.decided_at) : undefined,
    }));
  }

  async appendCreativeRunEvent(runId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    await this.pool.query("INSERT INTO creative_run_events(run_id,event_type,payload) VALUES($1,$2,$3)", [runId, eventType, payload]);
  }

  async getFoundationWorkContext(projectId: string, dependencyWorkItemIds: string[], currentTaskKey?: ProjectPlanTaskKey): Promise<{
    project: { title: string; metadata: Record<string, unknown> };
    priorArtifacts: Array<{ taskKey: string; title: string; summary: string }>;
  }> {
    const projectResult = await this.pool.query<{ title: string; metadata: Record<string, unknown> }>("SELECT title,metadata FROM novel_projects WHERE id=$1", [projectId]);
    const project = projectResult.rows[0];
    if (!project) throw new Error(`项目不存在：${projectId}`);
    const stage = currentTaskKey ? PROJECT_PLAN_STAGES.find((candidate) => candidate.taskKey === currentTaskKey) : undefined;
    if (!dependencyWorkItemIds.length && !stage?.dependsOn.length) return { project, priorArtifacts: [] };
    const result = currentTaskKey
      ? await this.pool.query<{ task_key: string | null; payload: Record<string, unknown> | null }>(
        `SELECT ps.task_key,a.payload
         FROM project_plan_sections ps
         JOIN artifacts a ON a.id=ps.source_artifact_id
         WHERE ps.project_id=$1 AND ps.task_key=ANY($2::text[]) AND ps.status='approved'`,
        [projectId, stage?.dependsOn ?? []],
      )
      : await this.pool.query<{ task_key: string | null; payload: Record<string, unknown> | null }>(
        `SELECT wi.task_key,a.payload
         FROM creative_work_items wi
         LEFT JOIN LATERAL (
           SELECT payload FROM artifacts WHERE id=wi.artifact_refs[array_length(wi.artifact_refs,1)]
         ) a ON TRUE
         WHERE wi.id=ANY($1::text[])`,
        [dependencyWorkItemIds],
      );
    const priorArtifacts = result.rows.flatMap((row) => {
      const title = row.payload?.title;
      const summary = row.payload?.summary;
      return typeof title === "string" && typeof summary === "string"
        ? [{ taskKey: row.task_key ?? "unknown", title, summary }]
        : [];
    });
    return { project, priorArtifacts };
  }

  async commitRevision(input: CommitRequest & { text: string; contentHash: string; objectKey: string; revisionId: string }): Promise<CommitResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ result: CommitResult }>("SELECT result FROM idempotency_keys WHERE project_id=$1 AND key=$2", [input.projectId, input.idempotencyKey]);
      if (existing.rowCount) { await client.query("COMMIT"); return existing.rows[0].result; }
      const project = await client.query<{ current_revision: string }>("SELECT current_revision FROM novel_projects WHERE id=$1 FOR UPDATE", [input.projectId]);
      if (!project.rowCount || Number(project.rows[0].current_revision) !== input.baseRevision) throw new Error("正式稿基线已变化，需要重新生成和审核");
      await client.query("INSERT INTO content_blobs(content_hash,object_key,byte_length,word_count) VALUES($1,$2,$3,$4) ON CONFLICT(content_hash) DO UPDATE SET word_count=COALESCE(content_blobs.word_count,EXCLUDED.word_count)", [input.contentHash, input.objectKey, Buffer.byteLength(input.text, "utf8"), countNovelCharacters(input.text)]);
      await client.query("INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING", [input.artifact.id, input.projectId, input.artifact.taskId, input.artifact.attemptId, input.artifact.kind, input.contentHash, input.objectKey, input.baseRevision, input.artifact.fingerprint, input.artifact.structuredData ?? {}]);
      // 修复：显式 JSON.stringify，与 putReview 一致。
      // 原因：review.issues 是 ReviewIssue[]，pg 直接传数组到 jsonb 列时，
      // 若元素含 undefined/Date/特殊对象会触发 "invalid input syntax for type json" 错误
      // （如 "Expected ":", but found ",""）。先 JSON.stringify 为字符串，让 PostgreSQL 解析为 jsonb。
      for (const review of input.reviews) await client.query("INSERT INTO reviews(id,project_id,artifact_id,reviewer_id,identity,verdict,artifact_fingerprint,issues,score,role,model_provenance,dimension_scores) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING", [review.id, input.projectId, review.artifactId, review.reviewerId, review.identity, review.verdict, review.artifactFingerprint, JSON.stringify(review.issues), review.score ?? null, review.role ?? null, review.modelProvenance ? JSON.stringify(review.modelProvenance) : null, JSON.stringify(review.dimensionScores ?? {})]);
      const revision = input.baseRevision + 1;
      const currentDocument = await client.query<{ current_revision_id: string | null }>("SELECT current_revision_id FROM manuscript_documents WHERE id=$1 AND project_id=$2 FOR UPDATE", [input.documentId, input.projectId]);
      if (currentDocument.rows[0]?.current_revision_id) await client.query("UPDATE manuscript_revisions SET retention_class='rolling',expires_at=COALESCE(expires_at,now()+interval '30 days') WHERE id=$1 AND retention_class<>'named'", [currentDocument.rows[0].current_revision_id]);
      await client.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash,artifact_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [input.revisionId, input.projectId, input.documentId, revision, input.baseRevision, input.contentHash, input.artifact.id]);
      await this.refreshChapterReviewSnapshotTx(client, input.artifact.id, input.revisionId);
      await client.query("UPDATE manuscript_documents SET current_revision_id=$1,status='final',updated_at=now() WHERE id=$2 AND project_id=$3", [input.revisionId, input.documentId, input.projectId]);
      await client.query(
        `UPDATE arcs a SET execution_status='completed',completed_at=now(),updated_at=now()
         WHERE a.id=(SELECT arc_id FROM chapters WHERE document_id=$1)
           AND a.execution_status='active'
           AND EXISTS (SELECT 1 FROM chapters c WHERE c.arc_id=a.id)
           AND NOT EXISTS (
             SELECT 1 FROM chapters c JOIN manuscript_documents d ON d.id=c.document_id
             WHERE c.arc_id=a.id AND d.status<>'final'
           )`,
        [input.documentId],
      );
      await client.query("UPDATE novel_projects SET current_revision=$1,updated_at=now() WHERE id=$2", [revision, input.projectId]);
      const result = { revisionId: input.revisionId, revision, contentHash: input.contentHash, outboxEventId: 0 };
      const event = await this.appendOutboxTx(client, "manuscript-revision", input.revisionId, "manuscript-revision.committed", { projectId: input.projectId, documentId: input.documentId, revision, contentHash: input.contentHash });
      result.outboxEventId = event;
      await client.query("INSERT INTO idempotency_keys(project_id,key,result) VALUES($1,$2,$3)", [input.projectId, input.idempotencyKey, result]);
      await client.query("INSERT INTO commit_records(id,project_id,revision_id,artifact_fingerprint,base_revision,result) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), input.projectId, input.revisionId, input.artifact.fingerprint, input.baseRevision, result]);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  private async appendOutbox(aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>) {
    const result = await this.pool.query<{ id: number }>("INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4) RETURNING id", [aggregateType, aggregateId, eventType, payload]);
    return Number(result.rows[0].id);
  }

  private async appendOutboxTx(client: PoolClient, aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>) {
    const result = await client.query<{ id: number }>("INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4) RETURNING id", [aggregateType, aggregateId, eventType, payload]);
    return Number(result.rows[0].id);
  }

  async close() { await this.pool.end(); }
}
