import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Artifact,
  CommitRequest,
  CommitResult,
  ContextManifest,
  ExecutionBlueprint,
  ManuscriptDocumentSummary,
  MemoryBundle,
  MemoryClaim,
  MemoryHit,
  NovelIntent,
  NovelProjectDetail,
  PreflightPlan,
  RetrievalFacet,
  RuntimeLearningAssessmentV2,
  SkillBundle,
  SkillDescriptor,
  TaskAttemptRecord,
  WorkflowRunRecord,
} from "./protocol";

export interface NovelProjectSnapshot {
  projectId: string;
  currentRevision: number;
  targetDocumentId?: string;
  targetDocumentOrder?: number;
  povCharacterId?: string;
}

type ProjectRow = { id: string; title: string; current_revision: string | number; metadata: Record<string, unknown>; created_at: Date | string; updated_at: Date | string };
type DocumentRow = { id: string; project_id: string; title: string; narrative_order: string | number; pov_character_id: string | null; current_revision_id: string | null; status: string; created_at: Date | string; updated_at: Date | string };
type WorkflowRunRow = { id: string; workflow_type: string; project_id: string; temporal_workflow_id: string; status: string; payload: Record<string, unknown>; created_at: Date | string; updated_at: Date | string };
type TaskAttemptRow = { id: string; workflow_run_id: string | null; task_id: string; lease_owner: string | null; lease_expires_at: Date | string | null; heartbeat_at: Date | string | null; status: TaskAttemptRecord["status"]; payload: Record<string, unknown> };

function iso(value: Date | string) { return value instanceof Date ? value.toISOString() : value; }
function sha256(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function documentFromRow(row: DocumentRow): ManuscriptDocumentSummary {
  return { id: row.id, projectId: row.project_id, title: row.title, narrativeOrder: Number(row.narrative_order), povCharacterId: row.pov_character_id ?? undefined, currentRevisionId: row.current_revision_id ?? undefined, status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function workflowFromRow(row: WorkflowRunRow): WorkflowRunRecord {
  return { id: row.id, workflowType: row.workflow_type, projectId: row.project_id, temporalWorkflowId: row.temporal_workflow_id, status: row.status, payload: row.payload ?? {}, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function taskAttemptFromRow(row: TaskAttemptRow): TaskAttemptRecord {
  return { id: row.id, workflowRunId: row.workflow_run_id ?? undefined, taskId: row.task_id, leaseOwner: row.lease_owner ?? undefined, leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : undefined, heartbeatAt: row.heartbeat_at ? iso(row.heartbeat_at) : undefined, status: row.status, payload: row.payload ?? {} };
}

export class NovelPostgresRepository {
  readonly pool: Pool;

  constructor(config: PoolConfig | string = process.env.DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp") {
    this.pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  async migrate() {
    const schemaPath = process.env.NOVEL_V2_SCHEMA_PATH ?? join(process.cwd(), "deploy", "postgres", "001_novel_v2.sql");
    await this.pool.query(readFileSync(schemaPath, "utf8"));
    await this.pool.query(`
      INSERT INTO skill_definitions(skill_id, version, capabilities, applicable_tasks, required_memory_kinds, quality_gates, prompt_sections)
      VALUES
        ('longform-continuity', '1.0.0', ARRAY['draft','revision'], ARRAY['drafting','revision','review'], ARRAY['canonical','episodic','hierarchical'], ARRAY['continuity'], '{"drafting":"longform continuity"}'),
        ('independent-quality-gate', '1.0.0', ARRAY['review'], ARRAY['drafting','revision','review','planning'], ARRAY['canonical','episodic'], ARRAY['independent-review'], '{"review":"independent quality gate"}'),
        ('memory-consolidation', '1.0.0', ARRAY['memory'], ARRAY['memory-maintenance','planning','drafting','review','revision'], ARRAY['canonical','episodic','hierarchical'], ARRAY['memory-provenance'], '{"fact-extraction":"memory provenance"}')
      ON CONFLICT(skill_id) DO NOTHING
    `);
  }

  async health() {
    await this.pool.query("SELECT 1");
    return { postgres: true };
  }

  async searchMemory(input: { projectId: string; facets: RetrievalFacet[]; narrativeCutoff?: number; povCharacterId?: string }): Promise<MemoryHit[]> {
    const results: MemoryHit[] = [];
    for (const facet of input.facets) {
      const terms = facet.query.split(/\s+/u).filter(Boolean).slice(0, 8);
      const pattern = `%${terms.join(" ")}%`;
      const params: unknown[] = [input.projectId, pattern];
      let extra = "";
      if (input.narrativeCutoff !== undefined) { params.push(input.narrativeCutoff); extra += ` AND (narrative_start IS NULL OR narrative_start <= $${params.length})`; }
      const rows = await this.pool.query<any>(`SELECT * FROM memory_claims WHERE project_id = $1 AND (content ILIKE $2 OR title ILIKE $2 OR subject_refs && string_to_array($2, ' ')) ${extra} ORDER BY confidence DESC, created_at DESC LIMIT 32`, params);
      for (const row of rows.rows) {
        if (facet.knowledgeCharacterId && row.knowledge_scope?.characterId && row.knowledge_scope.characterId !== facet.knowledgeCharacterId) continue;
        results.push({ id: row.id, projectId: row.project_id, kind: row.kind, title: row.title, content: row.content, subjectRefs: row.subject_refs ?? [], narrativeRange: { start: row.narrative_start ?? undefined, end: row.narrative_end ?? undefined }, knowledgeScope: row.knowledge_scope, authority: row.authority, confidence: Number(row.confidence), sourceRevisionIds: row.source_revision_ids ?? [], contentHash: row.content_hash, supersedes: row.supersedes ?? [], score: Number(row.confidence), matchedFacet: facet.kind, reason: `postgres lexical match:${facet.kind}` });
      }
    }
    return [...new Map(results.map((claim) => [claim.id, claim])).values()];
  }

  async ensureProject(projectId: string, title = projectId) {
    await this.pool.query("INSERT INTO novel_projects(id, title) VALUES($1, $2) ON CONFLICT(id) DO UPDATE SET title=COALESCE(NULLIF(EXCLUDED.title,''), novel_projects.title), updated_at=now()", [projectId, title]);
  }

  async listProjects() {
    const result = await this.pool.query("SELECT id,title,current_revision,metadata,created_at,updated_at FROM novel_projects ORDER BY updated_at DESC");
    return result.rows;
  }

  async getProjectDetail(projectId: string): Promise<NovelProjectDetail> {
    const project = await this.pool.query<ProjectRow>("SELECT id,title,current_revision,metadata,created_at,updated_at FROM novel_projects WHERE id=$1", [projectId]);
    if (!project.rowCount) throw new Error("项目不存在");
    const documents = await this.pool.query<DocumentRow>("SELECT id,project_id,title,narrative_order,pov_character_id,current_revision_id,status,created_at,updated_at FROM manuscript_documents WHERE project_id=$1 ORDER BY narrative_order,id", [projectId]);
    const row = project.rows[0];
    return { id: row.id, title: row.title, currentRevision: Number(row.current_revision), metadata: row.metadata ?? {}, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), documents: documents.rows.map(documentFromRow) };
  }

  async ensureDocument(input: { projectId: string; documentId?: string; title: string; narrativeOrder?: number; povCharacterId?: string; status?: string }): Promise<ManuscriptDocumentSummary> {
    await this.ensureProject(input.projectId);
    const id = input.documentId?.trim() || randomUUID();
    const order = input.narrativeOrder ?? await this.nextDocumentOrder(input.projectId);
    const result = await this.pool.query<DocumentRow>(`INSERT INTO manuscript_documents(id,project_id,title,narrative_order,pov_character_id,status)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(project_id,narrative_order) DO UPDATE SET title=EXCLUDED.title,pov_character_id=EXCLUDED.pov_character_id,status=EXCLUDED.status,updated_at=now()
      RETURNING id,project_id,title,narrative_order,pov_character_id,current_revision_id,status,created_at,updated_at`, [id, input.projectId, input.title, order, input.povCharacterId ?? null, input.status ?? "planned"]);
    return documentFromRow(result.rows[0]);
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

  async putReview(review: { id: string; projectId: string; artifactId: string; reviewerId: string; identity: string; verdict: string; artifactFingerprint: string; issues: unknown[] }) {
    await this.pool.query("INSERT INTO reviews(id,project_id,artifact_id,reviewer_id,identity,verdict,artifact_fingerprint,issues) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING", [review.id, review.projectId, review.artifactId, review.reviewerId, review.identity, review.verdict, review.artifactFingerprint, review.issues]);
    return review;
  }

  async listSkills(_projectId: string): Promise<SkillDescriptor[]> {
    type SkillRow = { skill_id: string; version: string; capabilities: string[] | null; applicable_tasks: PreflightPlan["taskClass"][] | null; required_memory_kinds: SkillDescriptor["requiredMemoryKinds"] | null; conflicts: string[] | null; quality_gates: string[] | null; prompt_sections: SkillDescriptor["promptSections"] | null; enabled: boolean };
    const result = await this.pool.query<SkillRow>("SELECT * FROM skill_definitions WHERE enabled = TRUE ORDER BY skill_id");
    return result.rows.map((row: SkillRow) => ({ skillId: row.skill_id, version: row.version, capabilities: row.capabilities ?? [], applicableTasks: row.applicable_tasks ?? [], requiredMemoryKinds: row.required_memory_kinds ?? [], conflicts: row.conflicts ?? [], qualityGates: row.quality_gates ?? [], promptSections: row.prompt_sections ?? {}, enabled: row.enabled }));
  }

  async getProjectSnapshot(projectId: string, targetDocumentId?: string): Promise<NovelProjectSnapshot> {
    const project = await this.pool.query<{ current_revision: string }>("SELECT current_revision FROM novel_projects WHERE id = $1", [projectId]);
    if (!project.rowCount) throw new Error("项目不存在");
    if (!targetDocumentId) return { projectId, currentRevision: Number(project.rows[0].current_revision) };
    const document = await this.pool.query<{ narrative_order: number; pov_character_id: string | null }>("SELECT narrative_order, pov_character_id FROM manuscript_documents WHERE id = $1 AND project_id = $2", [targetDocumentId, projectId]);
    const row = document.rows[0];
    if (!row) throw new Error("目标章节不存在");
    return { projectId, currentRevision: Number(project.rows[0].current_revision), targetDocumentId, targetDocumentOrder: row.narrative_order, povCharacterId: row.pov_character_id ?? undefined };
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

  async getWorkflowRunByTemporalId(temporalWorkflowId: string) {
    const result = await this.pool.query<WorkflowRunRow>("SELECT id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at FROM workflow_runs WHERE temporal_workflow_id=$1", [temporalWorkflowId]);
    return result.rows[0] ? workflowFromRow(result.rows[0]) : undefined;
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

  async recordFactExtraction(input: { projectId: string; artifact: Artifact; text: string }): Promise<MemoryClaim[]> {
    await this.recordArtifact(input.artifact);
    const content = input.text.trim();
    if (!content) return [];
    const fragments = content.split(/[。！？!?；;\n]+/u).map((item) => item.trim()).filter((item) => item.length >= 8).slice(0, 12);
    const claims: MemoryClaim[] = [];
    for (const [index, fragment] of fragments.entries()) {
      const contentHash = sha256(fragment);
      const existing = await this.pool.query<{ id: string }>("SELECT id FROM memory_claims WHERE project_id=$1 AND content_hash=$2 LIMIT 1", [input.projectId, contentHash]);
      if (existing.rowCount) continue;
      const subjectRefs = [...new Set(Array.from(fragment.matchAll(/[《“]?([\p{Script=Han}A-Za-z0-9_]{2,12})[”》]?/gu)).map((match) => match[1]).slice(0, 8))];
      const claim: MemoryClaim = { id: `claim:${input.artifact.id}:${index}`, projectId: input.projectId, kind: /承诺|约定|誓言|伏笔|线索/u.test(fragment) ? "hierarchical" : "episodic", title: fragment.slice(0, 32), content: fragment, subjectRefs, narrativeRange: undefined, knowledgeScope: "author", authority: "derived", confidence: 0.62, sourceRevisionIds: [], contentHash, supersedes: [] };
      await this.pool.query("INSERT INTO memory_claims(id,project_id,kind,title,content,subject_refs,narrative_start,narrative_end,knowledge_scope,authority,confidence,source_revision_ids,content_hash,supersedes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO UPDATE SET content=EXCLUDED.content,content_hash=EXCLUDED.content_hash,confidence=EXCLUDED.confidence", [claim.id, claim.projectId, claim.kind, claim.title, claim.content, claim.subjectRefs, null, null, claim.knowledgeScope, claim.authority, claim.confidence, claim.sourceRevisionIds, claim.contentHash, claim.supersedes]);
      await this.appendOutbox("memory-claim", claim.id, "memory-claim.upserted", { projectId: claim.projectId, claimId: claim.id, sourceArtifactId: input.artifact.id, novelty: "new" });
      claims.push(claim);
    }
    return claims;
  }

  async recordLearningAssessment(assessment: RuntimeLearningAssessmentV2) {
    if (assessment.conclusion === "propose-improvement" && (!assessment.underlyingMechanism || !assessment.affectedInputClass || !assessment.candidate)) throw new Error("propose-improvement 必须包含机制、影响输入类和候选变更");
    await this.pool.query("INSERT INTO learning_assessments(id,project_id,source,conclusion,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,conclusion=EXCLUDED.conclusion", [assessment.id, assessment.projectId, assessment.source, assessment.conclusion, assessment]);
    await this.appendOutbox("learning-assessment", assessment.id, `learning.${assessment.conclusion}`, { projectId: assessment.projectId, assessmentId: assessment.id, source: assessment.source, proposeImprovement: assessment.conclusion === "propose-improvement" });
    return assessment;
  }

  async commitRevision(input: CommitRequest & { text: string; contentHash: string; objectKey: string; revisionId: string }): Promise<CommitResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ result: CommitResult }>("SELECT result FROM idempotency_keys WHERE project_id=$1 AND key=$2", [input.projectId, input.idempotencyKey]);
      if (existing.rowCount) { await client.query("COMMIT"); return existing.rows[0].result; }
      const project = await client.query<{ current_revision: string }>("SELECT current_revision FROM novel_projects WHERE id=$1 FOR UPDATE", [input.projectId]);
      if (!project.rowCount || Number(project.rows[0].current_revision) !== input.baseRevision) throw new Error("正式稿基线已变化，需要重新生成和审核");
      await client.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,$3) ON CONFLICT(content_hash) DO NOTHING", [input.contentHash, input.objectKey, Buffer.byteLength(input.text, "utf8")]);
      await client.query("INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING", [input.artifact.id, input.projectId, input.artifact.taskId, input.artifact.attemptId, input.artifact.kind, input.contentHash, input.objectKey, input.baseRevision, input.artifact.fingerprint, input.artifact.structuredData ?? {}]);
      for (const review of input.reviews) await client.query("INSERT INTO reviews(id,project_id,artifact_id,reviewer_id,identity,verdict,artifact_fingerprint,issues) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING", [review.id, input.projectId, review.artifactId, review.reviewerId, review.identity, review.verdict, review.artifactFingerprint, review.issues]);
      const revision = input.baseRevision + 1;
      await client.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash,artifact_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [input.revisionId, input.projectId, input.documentId, revision, input.baseRevision, input.contentHash, input.artifact.id]);
      await client.query("UPDATE manuscript_documents SET current_revision_id=$1,status='final',updated_at=now() WHERE id=$2 AND project_id=$3", [input.revisionId, input.documentId, input.projectId]);
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
