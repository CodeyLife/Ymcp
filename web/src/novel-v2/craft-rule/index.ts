/**
 * V2 Craft Rule 候选演进模块。
 * 设计依据：AGENTS.md + Phase B-2 craft-rule 模块 + v2-refactor-followup-plan.md C-2.5 方案 B。
 * 7 个核心函数：create / inspect / recordEvidence / evaluateFoundation / submitReview / promote / rollback。
 * 基于 Postgres（craft_rule_candidates 表），不依赖 IndexedDB。
 *
 * promote/rollback 接入独立的 CraftRulePromotionService（不与 evaluation/promotion.ts 共用 CandidateBundle）。
 * 回归验证：promote 后用 evidenceCases 重跑，对比 qualityScore 不回退；失败自动 rollback。
 */
import { randomUUID } from "node:crypto";
import type { NovelPostgresRepository } from "../postgres-repository";
import type { ModelGateway } from "../model-gateway";
import type { PromotionReceipt } from "../protocol";
import type { ModelRoutingSnapshot } from "../model-routing";
import { createCraftRulePromotionService } from "./promotion-service";
import { compileStageContext } from "../stage-context";

// ===== 类型定义 =====

export interface CraftRuleScopeAnalysis {
  observedSymptom: string;
  failingLayer: string;
  underlyingMechanism: string;
  affectedInputClass: string;
  intendedBenefits: string[];
  boundaries: string[];
  nonGoals: string[];
  regressionRisks: string[];
}

export interface CraftRuleEvidenceCase {
  scenarioClass: string;
  scenarioRole: "source-failure" | "cross-scenario";
  baselineWorkItemId: string;
  candidateWorkItemId: string;
  capturedAt: number;
  /** LLM 评估分数（0-100），由 evaluateCraftRuleOnFoundation 填充。回归验证时用 candidateScore 作为基线。 */
  baselineScore?: number;
  candidateScore?: number;
  blockerDelta?: number;
  majorDelta?: number;
  /** 基础任务类型，由 evaluateCraftRuleOnFoundation 填充。 */
  taskKey?: string;
  /** 评估摘要，由 evaluateCraftRuleOnFoundation 填充。 */
  summary?: string;
}

export interface CraftRuleReview {
  role: string;
  reviewerId: string;
  reviewRunId: string;
  model: string;
  provider?: string;
  promptFingerprint?: string;
  verdict: "passed" | "revise" | "rejected";
  summary: string;
  concerns: string[];
  submittedAt: number;
}

export interface CraftRuleLearningSource {
  assessmentId: string;
  conclusion: string;
  mechanism: string;
}

export type CraftRuleCandidateStatus = "proposed" | "evidencing" | "reviewing" | "promoted" | "rolled-back" | "rejected";

export interface CraftRuleCandidate {
  id: string;
  projectId: string;
  targetKind: "skill" | "system-prompt";
  targetId: string;
  beforeVersion: string;
  proposedVersion: string;
  beforeText: string;
  afterText: string;
  rationale: string;
  scope: CraftRuleScopeAnalysis;
  status: CraftRuleCandidateStatus;
  evidenceCases: CraftRuleEvidenceCase[];
  reviews: CraftRuleReview[];
  learningSource?: CraftRuleLearningSource;
  /**
   * P0-C1 修复（2026-07-27）：题材适用性（仅 targetKind="skill" 时有意义）。
   *
   * 设计依据：Phase 3.3 + AGENTS.md「reusable contracts over case-specific rules」——
   * craft rule 通过 learning 闭环沉淀题材相关规则，promote 时写入 skill_definitions.applicable_genres，
   * 让 resolveSkillBundle 能按 genre 匹配题材特化 skill。
   * 留空数组表示题材无关（与现有 skill 行为一致）。
   * 不内置金手指/系统流特化枚举——genre 字符串由调用方定义。
   */
  applicableGenres?: string[];
  createdAt: string;
  updatedAt: string;
}

type CandidateRow = {
  id: string; project_id: string; target_kind: "skill" | "system-prompt"; target_id: string;
  before_version: string; proposed_version: string; before_text: string; after_text: string;
  rationale: string; scope: CraftRuleScopeAnalysis; status: CraftRuleCandidateStatus;
  evidence_cases: CraftRuleEvidenceCase[]; reviews: CraftRuleReview[];
  learning_source: CraftRuleLearningSource | null;
  applicable_genres: string[] | null;
  created_at: Date | string; updated_at: Date | string;
};

// ===== 辅助 =====

const CANDIDATE_COLUMNS =
  "id, project_id, target_kind, target_id, before_version, proposed_version, before_text, after_text, rationale, scope, status, evidence_cases, reviews, learning_source, applicable_genres, created_at, updated_at";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * 计算 patch 自增版本号。兼容 "1.0.0" 与 "v1.2.3"：保留前缀风格。无版本号回退为 "0.0.1"。
 */
export function nextPatchVersion(version: string | null | undefined): string {
  if (!version || !version.trim()) return "0.0.1";
  const hasVPrefix = version.startsWith("v");
  const parts = (hasVPrefix ? version.slice(1) : version).split(".").map((n) => Number.parseInt(n, 10));
  const major = Number.isFinite(parts[0]) ? parts[0] : 0;
  const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
  const patch = Number.isFinite(parts[2]) ? parts[2] : 0;
  const next = `${major}.${minor}.${patch + 1}`;
  return hasVPrefix ? `v${next}` : next;
}

function mapRow(row: CandidateRow): CraftRuleCandidate {
  return {
    id: row.id, projectId: row.project_id, targetKind: row.target_kind, targetId: row.target_id,
    beforeVersion: row.before_version, proposedVersion: row.proposed_version,
    beforeText: row.before_text, afterText: row.after_text, rationale: row.rationale,
    scope: row.scope, status: row.status,
    evidenceCases: Array.isArray(row.evidence_cases) ? row.evidence_cases : [],
    reviews: Array.isArray(row.reviews) ? row.reviews : [],
    learningSource: row.learning_source ?? undefined,
    applicableGenres: Array.isArray(row.applicable_genres) ? row.applicable_genres : [],
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

async function fetchCandidate(
  repository: NovelPostgresRepository, projectId: string, candidateId: string,
): Promise<CraftRuleCandidate> {
  const result = await repository.pool.query<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS} FROM craft_rule_candidates WHERE id = $1 AND project_id = $2`,
    [candidateId, projectId],
  );
  if (!result.rowCount) throw new Error(`CraftRuleCandidate 不存在：${candidateId}`);
  return mapRow(result.rows[0]);
}

/**
 * 解析 system-prompt target 的 targetId。
 *
 * targetId 约定格式：
 * - "<projectId>:<templateId>"：跨项目引用（如 "proj-123:chapter-draft-system"）
 * - "<templateId>"：当前项目内引用（fallback 到 input.projectId）
 *
 * 返回 [projectId, templateId] 二元组。
 */
function splitPromptTargetId(targetId: string, fallbackProjectId: string): [string, string] {
  const idx = targetId.indexOf(":");
  if (idx < 0) return [fallbackProjectId, targetId];
  const projectId = targetId.slice(0, idx);
  const templateId = targetId.slice(idx + 1);
  if (!projectId || !templateId) {
    throw new Error(`system-prompt targetId 格式非法：${targetId}（期望 "<projectId>:<templateId>" 或 "<templateId>"）`);
  }
  return [projectId, templateId];
}

// ===== 1. createCraftRuleCandidate =====

export async function createCraftRuleCandidate(
  repository: NovelPostgresRepository,
  input: {
    projectId: string; targetKind: "skill" | "system-prompt"; targetId: string;
    afterText: string; rationale: string; scope: CraftRuleScopeAnalysis;
    learningSource?: CraftRuleLearningSource;
    /**
     * P0-C1: 题材适用性（仅 targetKind="skill" 时有意义）。
     * 留空数组表示题材无关；非空数组表示仅适用于列出的 genre。
     * promote 时写入 skill_definitions.applicable_genres。
     */
    applicableGenres?: string[];
  },
): Promise<CraftRuleCandidate> {
  if (input.targetKind !== "skill" && input.targetKind !== "system-prompt") {
    throw new Error(`targetKind 必须为 skill | system-prompt，实际为 ${input.targetKind}`);
  }
  if (!input.afterText || input.afterText.length < 100) {
    throw new Error(`afterText 必填且长度 >= 100（实际 ${input.afterText?.length ?? 0}）`);
  }
  if (!input.rationale.trim()) throw new Error("rationale 必填且非空");
  for (const field of ["observedSymptom", "failingLayer", "underlyingMechanism", "affectedInputClass"] as const) {
    if (!input.scope[field] || !String(input.scope[field]).trim()) {
      throw new Error(`scope.${field} 必填且非空`);
    }
  }
  if (input.learningSource) {
    const existing = await repository.pool.query<{ id: string }>(
      "SELECT id FROM craft_rule_candidates WHERE project_id=$1 AND learning_source->>'assessmentId'=$2 ORDER BY created_at DESC LIMIT 1",
      [input.projectId, input.learningSource.assessmentId],
    );
    if (existing.rowCount) return fetchCandidate(repository, input.projectId, existing.rows[0].id);
  }

  // 查询当前 target 的 version + content 作为 beforeVersion / beforeText
  let beforeVersion: string;
  let beforeText: string;
  if (input.targetKind === "skill") {
    const result = await repository.pool.query<{ version: string; prompt_sections: unknown }>(
      "SELECT version, prompt_sections FROM skill_definitions WHERE skill_id = $1", [input.targetId],
    );
    if (!result.rowCount) throw new Error(`SkillDefinition 不存在：${input.targetId}`);
    beforeVersion = result.rows[0].version;
    // beforeText/afterText 是 prompt_sections 的 JSON 序列化文本，与 promotion.ts 处理一致
    beforeText = JSON.stringify(result.rows[0].prompt_sections ?? {});
  } else {
    // system-prompt target：从 prompt_templates 表加载（项目内 + template_id）
    // targetId 格式约定为 "<projectId>:<templateId>"，由调用方传入
    const [promptProjectId, templateId] = splitPromptTargetId(input.targetId, input.projectId);
    const result = await repository.pool.query<{ version: string; content: string }>(
      "SELECT version, content FROM prompt_templates WHERE project_id = $1 AND template_id = $2",
      [promptProjectId, templateId],
    );
    if (!result.rowCount) {
      throw new Error(`PromptTemplate 不存在：project_id=${promptProjectId}, template_id=${templateId}`);
    }
    beforeVersion = result.rows[0].version;
    beforeText = result.rows[0].content;
  }
  if (beforeText === input.afterText) {
    const satisfied = await repository.pool.query<{ id: string }>(
      `SELECT id FROM craft_rule_candidates
       WHERE project_id=$1 AND target_kind=$2 AND target_id=$3 AND after_text=$4
         AND status <> 'rejected'
       ORDER BY created_at DESC LIMIT 1`,
      [input.projectId, input.targetKind, input.targetId, input.afterText],
    );
    if (satisfied.rowCount) return fetchCandidate(repository, input.projectId, satisfied.rows[0].id);
    throw new Error("afterText 与 beforeText 相同，且没有可证明该改进已应用的候选");
  }

  const proposedVersion = nextPatchVersion(beforeVersion);
  const id = `crc-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const applicableGenres = input.applicableGenres ?? [];
  const inserted = await repository.pool.query(
    `INSERT INTO craft_rule_candidates(id, project_id, target_kind, target_id, before_version, proposed_version, before_text, after_text, rationale, scope, status, evidence_cases, reviews, learning_source, applicable_genres, created_at, updated_at)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'proposed', '[]'::jsonb, '[]'::jsonb, $11, $12, to_timestamp($13 / 1000.0), to_timestamp($13 / 1000.0))
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [id, input.projectId, input.targetKind, input.targetId, beforeVersion, proposedVersion,
     beforeText, input.afterText, input.rationale, JSON.stringify(input.scope),
     input.learningSource ? JSON.stringify(input.learningSource) : null,
     applicableGenres.length ? applicableGenres : null,
     now],
  );
  if (inserted.rowCount) return fetchCandidate(repository, input.projectId, id);
  if (input.learningSource) {
    const existing = await repository.pool.query<{ id: string }>(
      "SELECT id FROM craft_rule_candidates WHERE project_id=$1 AND learning_source->>'assessmentId'=$2 LIMIT 1",
      [input.projectId, input.learningSource.assessmentId],
    );
    if (existing.rowCount) return fetchCandidate(repository, input.projectId, existing.rows[0].id);
  }
  throw new Error("CraftRuleCandidate 写入冲突，但未找到对应的 learning assessment 候选");
}

// ===== 2. inspectCraftRuleCandidate =====

export async function inspectCraftRuleCandidate(
  repository: NovelPostgresRepository, projectId: string, candidateId: string,
): Promise<CraftRuleCandidate | null> {
  const result = await repository.pool.query<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS} FROM craft_rule_candidates WHERE id = $1 AND project_id = $2`,
    [candidateId, projectId],
  );
  return result.rowCount ? mapRow(result.rows[0]) : null;
}

// ===== 3. recordCraftRuleEvidence =====

export async function recordCraftRuleEvidence(
  repository: NovelPostgresRepository,
  input: {
    projectId: string; candidateId: string; scenarioClass: string;
    scenarioRole: "source-failure" | "cross-scenario";
    baselineWorkItemId: string; candidateWorkItemId: string;
  },
): Promise<CraftRuleCandidate> {
  const candidate = await fetchCandidate(repository, input.projectId, input.candidateId);
  if (candidate.status !== "proposed" && candidate.status !== "evidencing") {
    throw new Error(`候选状态必须为 proposed 或 evidencing，当前为 ${candidate.status}`);
  }
  if (!input.baselineWorkItemId || !input.candidateWorkItemId) {
    throw new Error("baselineWorkItemId / candidateWorkItemId 必填且非空");
  }
  for (const workItemId of [input.baselineWorkItemId, input.candidateWorkItemId]) {
    const exists = await repository.pool.query<{ id: string }>(
      "SELECT id FROM creative_work_items WHERE id = $1", [workItemId],
    );
    if (!exists.rowCount) throw new Error(`CreativeWorkItem 不存在：${workItemId}`);
  }
  const evidenceCases: CraftRuleEvidenceCase[] = [...candidate.evidenceCases, {
    scenarioClass: input.scenarioClass,
    scenarioRole: input.scenarioRole,
    baselineWorkItemId: input.baselineWorkItemId,
    candidateWorkItemId: input.candidateWorkItemId,
    capturedAt: Date.now(),
  }];
  await repository.pool.query(
    "UPDATE craft_rule_candidates SET evidence_cases = $3, status = 'evidencing', updated_at = now() WHERE id = $1 AND project_id = $2",
    [input.candidateId, input.projectId, JSON.stringify(evidenceCases)],
  );
  return fetchCandidate(repository, input.projectId, input.candidateId);
}

// ===== 4. evaluateCraftRuleOnFoundation =====

/**
 * 基础任务评估输出 schema。LLM 返回结构化结果，用于对比 before/after prompt 的质量。
 */
const foundationEvaluationSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    qualityScore: { type: "number", minimum: 0, maximum: 100, description: "整体质量评分（0-100），越高越好" },
    blockerCount: { type: "number", minimum: 0, description: "阻塞性问题数量" },
    majorCount: { type: "number", minimum: 0, description: "主要问题数量" },
    summary: { type: "string", description: "评估摘要（一句话）" },
    output: { type: "string", description: "基础任务实际产出（用于人工复核）" },
  },
  required: ["qualityScore", "blockerCount", "majorCount", "summary", "output"],
};

interface FoundationEvaluationResult {
  qualityScore: number;
  blockerCount: number;
  majorCount: number;
  summary: string;
  output: string;
}

/**
 * 用给定 prompt 文本作为 system prompt 跑一次基础任务，返回结构化评估结果。
 *
 * 复用 model.generateStructured，purpose=planning.foundation，taskKey 映射到具体基础任务。
 * 输出 schema 强制要求 qualityScore/blockerCount/majorCount/summary/output，便于回归对比。
 */
async function runFoundationTaskWithPrompt(params: {
  model: ModelGateway;
  routingSnapshot: ModelRoutingSnapshot;
  projectId: string;
  workflowId: string;
  taskId: string;
  taskKey: "project-positioning" | "architecture" | "story-bible" | "characters" | "relations" | "worldview";
  promptText: string;
  instruction?: string;
  scenarioClass: string;
}): Promise<FoundationEvaluationResult> {
  const systemPrompt = params.promptText;
  const userPrompt = [
    `# 基础任务：${params.taskKey}`,
    `# 场景类别：${params.scenarioClass}`,
    "",
    params.instruction ?? "请按 skill prompt 要求执行基础任务，并输出结构化评估结果。",
    "",
    "请输出 JSON：qualityScore（0-100）、blockerCount、majorCount、summary、output（基础任务实际产出）。",
  ].join("\n");
  const promptPackage = compileStageContext({
    projectId: params.projectId,
    workflowId: params.workflowId,
    purpose: "planning.foundation",
    stage: "foundation",
    system: systemPrompt,
    schema: foundationEvaluationSchema,
    maxInputTokens: 128_000,
    reservedOutputTokens: 4_096,
    sections: [{ id: "craft-rule-evaluation", kind: "background", title: "规则回归场景与基础任务", text: userPrompt, priority: "required", provenanceRefs: [params.taskId, params.scenarioClass] }],
  });

  const result = await params.model.generateStructured<FoundationEvaluationResult>({
    purpose: "planning.foundation",
    schema: foundationEvaluationSchema,
    system: systemPrompt,
    prompt: promptPackage.instruction,
    routingSnapshot: params.routingSnapshot,
    workflowRunId: params.workflowId,
    taskId: params.taskId,
    promptContext: promptPackage.manifest,
  });
  return result.value;
}

export async function evaluateCraftRuleOnFoundation(
  repository: NovelPostgresRepository,
  model: ModelGateway,
  input: {
    projectId: string; candidateId: string;
    taskKey: "project-positioning" | "architecture" | "story-bible" | "characters" | "relations" | "worldview";
    scenarioClass: string; scenarioRole: "source-failure" | "cross-scenario"; instruction?: string;
  },
): Promise<{ evidence: CraftRuleEvidenceCase; observations: Record<string, unknown> }> {
  const candidate = await fetchCandidate(repository, input.projectId, input.candidateId);
  if (candidate.status !== "proposed" && candidate.status !== "evidencing") {
    throw new Error(`候选状态必须为 proposed 或 evidencing，当前为 ${candidate.status}`);
  }

  // 1. 获取当前路由快照（用于 LLM 调用）
  const routingSnapshot = model.getRoutingSnapshot();

  // 2. 用 beforeText（旧 skill prompt）作为 system prompt 跑一次 baseline
  const baselineResult = await runFoundationTaskWithPrompt({
    model, routingSnapshot, projectId: input.projectId, workflowId: `craft-rule:${input.candidateId}:${input.scenarioClass}`, taskId: `${input.candidateId}:${input.taskKey}:baseline`, taskKey: input.taskKey,
    promptText: candidate.beforeText,
    instruction: input.instruction, scenarioClass: input.scenarioClass,
  });

  // 3. 用 afterText（新 skill prompt）作为 system prompt 跑一次 candidate
  const candidateResult = await runFoundationTaskWithPrompt({
    model, routingSnapshot, projectId: input.projectId, workflowId: `craft-rule:${input.candidateId}:${input.scenarioClass}`, taskId: `${input.candidateId}:${input.taskKey}:candidate`, taskKey: input.taskKey,
    promptText: candidate.afterText,
    instruction: input.instruction, scenarioClass: input.scenarioClass,
  });

  // 4. 对比两次输出，构造 evidence case
  const evidence: CraftRuleEvidenceCase = {
    scenarioClass: input.scenarioClass,
    scenarioRole: input.scenarioRole,
    baselineWorkItemId: `baseline:${candidate.id}:${input.taskKey}:${Date.now()}`,
    candidateWorkItemId: `candidate:${candidate.id}:${input.taskKey}:${Date.now()}`,
    capturedAt: Date.now(),
    baselineScore: baselineResult.qualityScore,
    candidateScore: candidateResult.qualityScore,
    blockerDelta: candidateResult.blockerCount - baselineResult.blockerCount,
    majorDelta: candidateResult.majorCount - baselineResult.majorCount,
    taskKey: input.taskKey,
    summary: `baseline=${baselineResult.qualityScore} → candidate=${candidateResult.qualityScore}（Δ=${candidateResult.qualityScore - baselineResult.qualityScore}），blocker Δ=${candidateResult.blockerCount - baselineResult.blockerCount}，major Δ=${candidateResult.majorCount - baselineResult.majorCount}`,
  };

  const evidenceCases = [...candidate.evidenceCases, evidence];
  await repository.pool.query(
    "UPDATE craft_rule_candidates SET evidence_cases = $3, status = 'evidencing', updated_at = now() WHERE id = $1 AND project_id = $2",
    [input.candidateId, input.projectId, JSON.stringify(evidenceCases)],
  );

  return {
    evidence,
    observations: {
      taskKey: input.taskKey,
      scenarioClass: input.scenarioClass,
      instruction: input.instruction ?? null,
      candidateId: candidate.id,
      targetKind: candidate.targetKind,
      targetId: candidate.targetId,
      baseline: baselineResult,
      candidate: candidateResult,
      scoreDelta: candidateResult.qualityScore - baselineResult.qualityScore,
      blockerDelta: evidence.blockerDelta,
      majorDelta: evidence.majorDelta,
    },
  };
}

// ===== 5. submitCraftRuleReview =====

export async function submitCraftRuleReview(
  repository: NovelPostgresRepository,
  input: {
    projectId: string; candidateId: string; role: string; reviewerId: string; reviewRunId: string;
    model: string; provider?: string; promptFingerprint?: string;
    verdict: "passed" | "revise" | "rejected"; summary: string; concerns: string[];
  },
): Promise<CraftRuleCandidate> {
  const candidate = await fetchCandidate(repository, input.projectId, input.candidateId);
  if (candidate.status !== "evidencing" && candidate.status !== "reviewing") {
    throw new Error(`候选状态必须为 evidencing 或 reviewing，当前为 ${candidate.status}`);
  }
  const review: CraftRuleReview = {
    role: input.role, reviewerId: input.reviewerId, reviewRunId: input.reviewRunId, model: input.model,
    provider: input.provider, promptFingerprint: input.promptFingerprint, verdict: input.verdict,
    summary: input.summary, concerns: Array.isArray(input.concerns) ? input.concerns : [],
    submittedAt: Date.now(),
  };
  const reviews = [...candidate.reviews, review];
  const nextStatus: CraftRuleCandidateStatus = input.verdict === "rejected" ? "rejected" : "reviewing";
  await repository.pool.query(
    "UPDATE craft_rule_candidates SET reviews = $3, status = $4, updated_at = now() WHERE id = $1 AND project_id = $2",
    [input.candidateId, input.projectId, JSON.stringify(reviews), nextStatus],
  );
  return fetchCandidate(repository, input.projectId, input.candidateId);
}

// ===== 6. promoteCraftRuleCandidate =====

/**
 * 回归验证：promote 后用新版本（afterText）重跑 evidenceCases 中的 scenarioClass，
 * 对比 qualityScore 不回退。
 *
 * AGENTS.md 契约：promote 后必须做回归验证（用新版本重跑失败场景）。
 *
 * 判定规则：
 * - 若所有 evidenceCase 的 newScore >= candidateScore - REGRESSION_TOLERANCE，则 passed
 * - 否则 failed，返回具体 reasons
 *
 * @returns passed: 是否通过；reasons: 失败原因列表（passed=false 时非空）
 */
const REGRESSION_TOLERANCE = 5; // 容忍 5 分以内的回退（LLM 输出有随机性）

async function runRegressionVerification(params: {
  repository: NovelPostgresRepository;
  model: ModelGateway;
  candidate: CraftRuleCandidate;
}): Promise<{ passed: boolean; reasons: string[]; details: Array<{ scenarioClass: string; candidateScore: number; newScore: number; delta: number }> }> {
  const { model, candidate } = params;
  const routingSnapshot = model.getRoutingSnapshot();
  const reasons: string[] = [];
  const details: Array<{ scenarioClass: string; candidateScore: number; newScore: number; delta: number }> = [];

  // 只对 evaluateCraftRuleOnFoundation 产生的 evidenceCase（有 taskKey + candidateScore）做回归
  const regressableCases = candidate.evidenceCases.filter(
    (c) => c.taskKey && typeof c.candidateScore === "number",
  );

  for (const evidenceCase of regressableCases) {
    const taskKey = evidenceCase.taskKey as "project-positioning" | "architecture" | "story-bible" | "characters" | "relations" | "worldview";
    const candidateScore = evidenceCase.candidateScore as number;
    const result = await runFoundationTaskWithPrompt({
      model, routingSnapshot, projectId: candidate.projectId, workflowId: `craft-rule:${candidate.id}:regression`, taskId: `${candidate.id}:${taskKey}:regression:${evidenceCase.scenarioClass}`, taskKey,
      promptText: candidate.afterText,
      instruction: `回归验证：重跑 scenarioClass=${evidenceCase.scenarioClass}，对比 candidateScore=${candidateScore}`,
      scenarioClass: evidenceCase.scenarioClass,
    });
    const delta = result.qualityScore - candidateScore;
    details.push({
      scenarioClass: evidenceCase.scenarioClass,
      candidateScore,
      newScore: result.qualityScore,
      delta,
    });
    if (delta < -REGRESSION_TOLERANCE) {
      reasons.push(
        `scenarioClass=${evidenceCase.scenarioClass} 回归失败：candidateScore=${candidateScore} → newScore=${result.qualityScore}（Δ=${delta}，低于容忍阈值 -${REGRESSION_TOLERANCE}）`,
      );
    }
  }

  return { passed: reasons.length === 0, reasons, details };
}

export async function promoteCraftRuleCandidate(
  repository: NovelPostgresRepository,
  model: ModelGateway,
  input: { projectId: string; candidateId: string },
): Promise<{ candidate: CraftRuleCandidate; receipt: PromotionReceipt; regressionVerified: boolean; regressionDetails?: unknown }> {
  const candidate = await fetchCandidate(repository, input.projectId, input.candidateId);
  if (candidate.status !== "reviewing") {
    throw new Error(`候选状态必须为 reviewing，当前为 ${candidate.status}`);
  }
  if (candidate.reviews.filter((r) => r.verdict === "passed").length === 0) {
    throw new Error("晋升需要至少 1 条 verdict=passed 的 review");
  }
  const regressableCases = candidate.evidenceCases.filter((evidence) => evidence.taskKey && typeof evidence.candidateScore === "number");
  const roles = new Set(regressableCases.map((evidence) => evidence.scenarioRole));
  const scenarioClasses = new Set(regressableCases.map((evidence) => evidence.scenarioClass));
  if (!roles.has("source-failure") || !roles.has("cross-scenario") || scenarioClasses.size < 2) {
    throw new Error("晋升前必须具备原失败场景和至少一个不同 scenarioClass 的异构回归证据");
  }

  // 1. 调用 CraftRulePromotionService.promote（原子事务：UPDATE skill_definitions + INSERT receipt + UPDATE candidate.status）
  // service 内部会校验 target 版本未漂移（stale-target-version 检测）
  const promotionService = createCraftRulePromotionService(repository);
  const receipt = await promotionService.promote({
    candidate,
    authorId: `craft-rule-bot:${candidate.id}`,
  });

  // 2. 检查 receipt 状态：若 promote 失败，直接抛错（不进入回归验证）
  if (receipt.status !== "promoted") {
    throw new Error(`promote 失败：${receipt.failureReason ?? "未知原因"}（receiptId=${receipt.id}）`);
  }

  // 3. 回归验证：用新版本（afterText）重跑 evidenceCases，对比 qualityScore 不回退
  // AGENTS.md 契约：promote 后必须做回归验证，失败自动 rollback
  const regressionResult = await runRegressionVerification({
    repository, model, candidate,
  });

  if (!regressionResult.passed) {
    // 回归失败，自动 rollback
    await promotionService.rollback(receipt.id);
    throw new Error(
      `回归验证失败：${regressionResult.reasons.join("; ")}，已自动 rollback（receiptId=${receipt.id}）`,
    );
  }

  return {
    candidate: await fetchCandidate(repository, input.projectId, input.candidateId),
    receipt,
    regressionVerified: true,
    regressionDetails: regressionResult.details,
  };
}

// ===== 7. rollbackCraftRuleCandidate =====

export async function rollbackCraftRuleCandidate(
  repository: NovelPostgresRepository,
  _model: ModelGateway,
  input: { projectId: string; candidateId: string },
): Promise<{ candidate: CraftRuleCandidate; receiptId: string }> {
  const candidate = await fetchCandidate(repository, input.projectId, input.candidateId);
  if (candidate.status !== "promoted") {
    throw new Error(`候选状态必须为 promoted，当前为 ${candidate.status}`);
  }

  // 通过 CraftRulePromotionService.rollback 原子回滚
  // receiptId 格式固定为 `promote:<candidateId>`
  const receiptId = `promote:${candidate.id}`;
  const promotionService = createCraftRulePromotionService(repository);
  await promotionService.rollback(receiptId);

  return {
    candidate: await fetchCandidate(repository, input.projectId, input.candidateId),
    receiptId,
  };
}
