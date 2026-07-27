import Dexie from "dexie";
import { novelDb, recordBase, type NovelDatabase } from "./db";
import { BUILTIN_NOVEL_SKILLS, getEffectiveSkill, nextPatchVersion, parseNovelSkill, setProjectSkill } from "./skills";
import { BUILTIN_PROMPT_TEMPLATES, listPromptTemplates } from "./prompt-templates";
import { callStructuredNovelModel } from "./ai";
import { getGenerationTask } from "./generation";
import {
  createCreativeRun,
  enqueueCreativeWork,
  executeCreativeCommand,
  buildChapterEvaluationContextSnapshot,
  type CreativeExecutionDependencies,
} from "./creative-execution";
import { captureProjectSnapshot, verifyProjectSnapshot, type ProjectSnapshotBundle } from "./evaluation/project-snapshot";
import type {
  CraftRuleCandidate,
  CraftRuleReviewDecision,
  CraftRuleReviewRole,
  CraftRuleScopeAnalysis,
  CraftRuleLearningSource,
  CraftRuleReplaySnapshot,
  CraftRulePromotionObservation,
  FoundationEvaluationTaskKey,
  LearningAssessment,
  ManuscriptDocument,
  NovelSkillManifest,
  NovelSkillStage,
  NovelGenerationTaskKey,
  PromptTemplateVersion,
} from "./types";

const REQUIRED_REVIEW_ROLES: CraftRuleReviewRole[] = ["plot-editor", "character-editor", "prose-editor", "long-form-editor"];
const SCOPE_TEXT_FIELDS: Array<keyof Pick<CraftRuleScopeAnalysis, "observedSymptom" | "failingLayer" | "underlyingMechanism" | "affectedInputClass">> = [
  "observedSymptom",
  "failingLayer",
  "underlyingMechanism",
  "affectedInputClass",
];
const SCOPE_LIST_FIELDS: Array<keyof Pick<CraftRuleScopeAnalysis, "intendedBenefits" | "boundaries" | "nonGoals" | "regressionRisks">> = [
  "intendedBenefits",
  "boundaries",
  "nonGoals",
  "regressionRisks",
];

export interface CraftRuleGate {
  ready: boolean;
  reasons: string[];
  averageScoreDelta: number;
  variedDimensions: string[];
  latestReviews: Partial<Record<CraftRuleReviewRole, CraftRuleReviewDecision>>;
}

export interface CraftRuleObservationGate {
  ready: boolean;
  reasons: string[];
  variedDimensions: string[];
}

export type CraftRuleNextAction =
  | { type: "improvement.evaluate"; candidateId: string; reason: string; requiredCases: number; variedDimensions: string[] }
  | { type: "improvement.review"; candidateId: string; reason: string; roles: CraftRuleReviewRole[] }
  | { type: "improvement.promote"; candidateId: string }
  | { type: "improvement.observe"; candidateId: string; reason: string; requiredObservations: number; suggestedSubjects: CraftRuleObservationSubject[] }
  | { type: "improvement.revise"; candidateId: string; reason: string }
  | { type: "improvement.rollback"; candidateId: string };

export type CraftRuleObservationSubject =
  | { subjectKind: "chapter"; subjectId: string; documentId: string; scenarioClass: string; scenarioProfile: Record<string, string> }
  | { subjectKind: "foundation-task"; subjectId: string; taskKey: FoundationEvaluationTaskKey; scenarioClass: string; scenarioProfile: Record<string, string> };

const CHAPTER_WORKFLOW_RULE_STAGES = new Set(["planning", "drafting", "review", "revision", "fact-extraction", "character-enrichment"]);
export const FOUNDATION_EVALUATION_TASKS = ["project-positioning", "architecture", "story-bible", "characters", "relations", "worldview"] as const satisfies NovelGenerationTaskKey[];
const REVIEW_CRITERIA_VERSION = "craft-rule-review-v1";
const REVIEW_ROLE_FOCUS: Record<CraftRuleReviewRole, string[]> = {
  "plot-editor": ["causality", "objective-conflict", "pacing"],
  "character-editor": ["motivation", "agency", "relationship-continuity"],
  "prose-editor": ["language", "imagery", "sentence-control"],
  "long-form-editor": ["cross-chapter-continuity", "repetition-risk", "long-term-side-effects"],
};

export function supportsChapterRuleEvaluation(stages: NovelSkillStage[]): boolean {
  return stages.some((stage) => CHAPTER_WORKFLOW_RULE_STAGES.has(stage));
}

export function supportsFoundationRuleEvaluation(stages: NovelSkillStage[]): boolean {
  return stages.includes("foundation");
}

function evidenceFingerprint(candidate: Pick<CraftRuleCandidate, "evidenceCases">): string {
  return candidate.evidenceCases
    .map((item) => `${item.caseId}:${item.baselineWorkItemId}:${item.candidateWorkItemId}`)
    .sort()
    .join("|");
}

function countBand(count: number): string {
  if (count === 0) return "none";
  if (count === 1) return "single";
  if (count <= 3) return "few";
  return "many";
}

function lengthBand(words: number): string {
  if (words < 2000) return "short";
  if (words < 4500) return "standard";
  return "extended";
}

function deriveChapterScenarioFromDocument(document: ManuscriptDocument) {
  const profile = {
    characterCountBand: countBand(document.blueprint.characterIds.length),
    mustHappenBand: countBand(document.blueprint.mustHappen.length),
    informationReleaseBand: countBand(document.blueprint.informationRelease.length),
    conflictMode: document.blueprint.conflict.trim() ? "explicit" : "implicit-or-none",
    manuscriptState: document.wordCount > 0 || document.plainText.trim() ? "existing-manuscript" : "outline-only",
    targetLengthBand: lengthBand(document.blueprint.targetWords),
  };
  return { profile, signature: JSON.stringify(profile) };
}

const REQUIRED_SCENARIO_DIMENSIONS = [
  "taskKey",
  "architectureState",
  "entityState",
  "relationState",
  "planningState",
  "chapterFunction",
  "pov",
  "textType",
  "conflictType",
  "narrativePhase",
  "characterCountBand",
  "mustHappenBand",
  "informationReleaseBand",
  "conflictMode",
  "manuscriptState",
  "targetLengthBand",
] as const;

function scenarioDimensionCoverage(cases: Array<{ scenarioProfile: Record<string, string | undefined> }>): string[] {
  return REQUIRED_SCENARIO_DIMENSIONS.filter((dimension) => {
    const values = new Set(cases.map((item) => item.scenarioProfile?.[dimension]).filter(Boolean));
    return values.size >= 2;
  });
}

export function evaluateCraftRuleObservationGate(candidate: CraftRuleCandidate): CraftRuleObservationGate {
  const observations = candidate.promotionObservations ?? [];
  const reasons: string[] = [];
  const variedDimensions = scenarioDimensionCoverage(observations);
  if (observations.length < 3) reasons.push("晋升后至少需要 3 组真实运行观察");
  if (new Set(observations.map((item) => item.subjectId)).size < 3) reasons.push("晋升后观察至少需要覆盖 3 个不同章节或基础任务");
  if (new Set(observations.map((item) => item.scenarioSignature)).size < 3) reasons.push("晋升后观察至少需要覆盖 3 类不同输入结构");
  if (variedDimensions.length < 2) reasons.push("晋升后观察至少需要覆盖 2 个真实输入维度");
  if (observations.some((item) => item.outcome === "regressed")) reasons.push("晋升后观察存在质量回退");
  return { ready: reasons.length === 0, reasons, variedDimensions };
}

function requireScope(scope: CraftRuleScopeAnalysis): void {
  if (!scope || typeof scope !== "object") throw new Error("规则候选 scope 不能为空");
  for (const key of SCOPE_TEXT_FIELDS) {
    if (typeof scope[key] !== "string" || !scope[key].trim()) throw new Error(`规则候选 scope.${key} 不能为空`);
  }
  for (const key of SCOPE_LIST_FIELDS) {
    const value = scope[key];
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`规则候选 scope.${key} 至少需要一项非空说明`);
    }
  }
}

function validateSkillPrompt(skill: NovelSkillManifest, prompt: string, version: string): void {
  parseNovelSkill(JSON.stringify({
    skillId: skill.skillId,
    version,
    name: skill.name,
    description: skill.description,
    locale: skill.locale,
    category: skill.category,
    stages: skill.stages,
    triggers: skill.triggers,
    requires: skill.requires,
    conflicts: skill.conflicts,
    priority: skill.priority,
    inputSchema: skill.inputSchema,
    outputSchema: skill.outputSchema,
    prompt,
    qualityChecks: skill.qualityChecks,
    sourceUrl: skill.sourceUrl,
    license: skill.license,
  }));
}

export function evaluateCraftRuleGate(candidate: CraftRuleCandidate): CraftRuleGate {
  const reasons: string[] = [];
  const cases = candidate.evidenceCases;
  const distinctSubjects = new Set(cases.map((item) => item.subjectId ?? item.documentId));
  const distinctScenarios = new Set(cases.map((item) => item.scenarioSignature));
  const averageScoreDelta = cases.length
    ? cases.reduce((sum, item) => sum + item.candidateScore - item.baselineScore, 0) / cases.length
    : 0;
  if (cases.length < 3) reasons.push("至少需要 3 组真实基线/候选对照");
  if (distinctSubjects.size < 3) reasons.push("至少需要覆盖 3 个不同章节或基础创作任务");
  if (distinctScenarios.size < 3) reasons.push("实际输入结构至少需要覆盖 3 类不同创作场景");
  const variedDimensions = scenarioDimensionCoverage(cases);
  if (variedDimensions.length < 2) reasons.push("跨场景证据至少需要覆盖 2 个真实输入维度，不能只更换场景标签");
  if (cases.some((item) => item.blockerDelta > 0 || item.majorDelta > 0)) reasons.push("候选规则不得增加 blocker 或 major");
  if (cases.some((item) => item.candidateScore < item.baselineScore - 0.2)) reasons.push("单个场景质量分回退不得超过 0.2");
  if (cases.length >= 3 && averageScoreDelta < 0.1) reasons.push("跨场景平均质量提升必须达到 0.1");
  if (!candidate.learningSource?.replay && !candidate.promotionReplay) reasons.push("缺少冻结失败场景");

  const latestReviews: Partial<Record<CraftRuleReviewRole, CraftRuleReviewDecision>> = {};
  for (const review of candidate.reviews) latestReviews[review.role] = review;
  for (const role of REQUIRED_REVIEW_ROLES) {
    if (!latestReviews[role]) reasons.push(`缺少 ${role} 审核`);
    else if (latestReviews[role]?.verdict !== "passed") reasons.push(`${role} 审核未通过`);
    else if (latestReviews[role]?.reviewedVersion !== candidate.proposedVersion || latestReviews[role]?.evidenceFingerprint !== evidenceFingerprint(candidate)) {
      reasons.push(`${role} 审核早于当前证据集，需要重新审核`);
    } else if (latestReviews[role]?.reviewCriteriaVersion !== REVIEW_CRITERIA_VERSION
      || JSON.stringify(latestReviews[role]?.focusAreas) !== JSON.stringify(REVIEW_ROLE_FOCUS[role])) {
      reasons.push(`${role} 审核缺少当前角色专属检查证据，需要重新审核`);
    }
  }
  const currentReviews = Object.values(latestReviews).filter((review): review is CraftRuleReviewDecision => Boolean(review));
  if (currentReviews.length === REQUIRED_REVIEW_ROLES.length) {
    if (new Set(currentReviews.map((review) => review.reviewRunId)).size < REQUIRED_REVIEW_ROLES.length) {
      reasons.push("四项角色审核必须来自彼此独立的审核运行");
    }
    if (new Set(currentReviews.map((review) => `${review.reviewer}:${review.reviewerId}`)).size < 2) {
      reasons.push("四项角色审核至少需要两个独立审核主体");
    }
    const independentSources = new Set(currentReviews.map((review) => review.reviewer === "user"
      ? `user:${review.reviewerId}`
      : `model:${review.modelIdentity ?? `${review.provider ?? "unknown"}:${review.model ?? "unknown"}`}`));
    if (independentSources.size < 2) reasons.push("四项角色审核至少需要两个独立模型或用户审核主体");
    if (currentReviews.some((review) => review.reviewer === "external-llm" && !review.model?.trim())) {
      reasons.push("外部 LLM 审核必须记录模型身份");
    }
  }
  return { ready: reasons.length === 0, reasons, averageScoreDelta, variedDimensions, latestReviews };
}

function validateCompleteRuleRevision(beforeText: string, afterText: string): void {
  const normalized = afterText.trim();
  if (/(?:TODO|TBD|待补充|内容略|其余同上|保持其余不变|在原(?:规则|prompt|提示词)基础上)/i.test(normalized)) {
    throw new Error("规则候选必须提交可独立使用的完整全文，不能包含占位符或 diff 式指令");
  }
  if (beforeText.trim().length >= 250 && normalized.length < beforeText.trim().length * 0.4) {
    throw new Error("规则候选相对当前完整基线截断过多，无法证明保留了无关规则");
  }
}

async function refreshStatus(candidate: CraftRuleCandidate, db: NovelDatabase): Promise<CraftRuleCandidate> {
  const gate = evaluateCraftRuleGate(candidate);
  const rejected = Object.values(gate.latestReviews).some((review) => review?.verdict === "rejected");
  candidate.status = rejected ? "rejected" : gate.ready ? "ready" : candidate.evidenceCases.length || candidate.reviews.length ? "evaluating" : "proposed";
  candidate.updatedAt = Date.now();
  candidate.revision += 1;
  await db.craftRuleCandidates.put(candidate);
  return candidate;
}

export async function createCraftRuleCandidate(input: {
  projectId: string;
  targetKind: CraftRuleCandidate["targetKind"];
  targetId: string;
  afterText: string;
  rationale: string;
  scope: CraftRuleScopeAnalysis;
  learningSource?: CraftRuleLearningSource;
  expectedTargetVersion?: string;
  expectedTargetContentFingerprint?: string;
}, db: NovelDatabase = novelDb): Promise<CraftRuleCandidate> {
  if (input.targetKind !== "skill" && input.targetKind !== "system-prompt") throw new Error("规则候选 targetKind 无效");
  if (!input.afterText.trim() || input.afterText.trim().length < 100) throw new Error("规则候选内容过短，无法表达通用机制与边界");
  if (!input.rationale.trim()) throw new Error("规则候选缺少修改理由");
  requireScope(input.scope);
  let beforeVersion: string;
  let beforeText: string;
  let targetStages: NovelSkillStage[];
  if (input.targetKind === "skill") {
    const skill = await getEffectiveSkill(input.projectId, input.targetId, db);
    if (!skill) throw new Error("目标 Skill 不存在");
    beforeVersion = skill.version;
    beforeText = skill.prompt;
    targetStages = skill.stages;
    validateSkillPrompt(skill, input.afterText.trim(), nextPatchVersion(skill.version));
  } else {
    const template = (await listPromptTemplates(input.projectId, db)).find((item) => item.templateId === input.targetId);
    if (!template) throw new Error("目标系统 Prompt 不存在");
    beforeVersion = template.version;
    beforeText = template.content;
    targetStages = template.stages;
  }
  if (!targetStages.length) throw new Error("目标规则没有可评测阶段");
  validateCompleteRuleRevision(beforeText, input.afterText);
  if (input.expectedTargetVersion && beforeVersion !== input.expectedTargetVersion) throw new Error("审核期目标规则版本已变化，需要重新评估 learning 提案");
  if (input.expectedTargetContentFingerprint && await Dexie.waitFor(textFingerprint(beforeText)) !== input.expectedTargetContentFingerprint) throw new Error("审核期目标规则内容已变化，需要重新评估 learning 提案");
  if (beforeText.trim() === input.afterText.trim()) throw new Error("规则候选与当前生效内容相同");
  const candidate: CraftRuleCandidate = {
    ...recordBase(input.projectId),
    targetKind: input.targetKind,
    targetId: input.targetId,
    beforeVersion,
    proposedVersion: nextPatchVersion(beforeVersion),
    beforeText,
    afterText: input.afterText.trim(),
    rationale: input.rationale.trim(),
    scope: structuredClone(input.scope),
    status: "proposed",
    evidenceCases: [],
    reviews: [],
    learningSource: input.learningSource ? structuredClone(input.learningSource) : undefined,
  };
  await db.craftRuleCandidates.add(candidate);
  return candidate;
}

function chapterReplayFingerprintInput(replay: Extract<CraftRuleReplaySnapshot, { subjectKind: "chapter" }>) {
  const snapshot = replay.chapter.projectSnapshot as ProjectSnapshotBundle;
  return JSON.stringify({
    snapshotHash: snapshot.manifest.snapshotHash,
    subjectId: replay.subjectId,
    instruction: replay.chapter.instruction,
    thread: replay.chapter.thread,
    brief: replay.chapter.brief,
  });
}

function foundationReplayFingerprintInput(replay: Extract<CraftRuleReplaySnapshot, { subjectKind: "foundation-task" }>) {
  return JSON.stringify({
    subjectId: replay.subjectId,
    taskKey: replay.foundation.taskKey,
    instruction: replay.foundation.instruction,
    projectContext: replay.foundation.projectContext,
    model: replay.foundation.model,
  });
}

async function assertReplayIntegrity(replay: CraftRuleReplaySnapshot): Promise<void> {
  if (replay.subjectKind === "chapter") {
    const verification = await verifyProjectSnapshot(replay.chapter.projectSnapshot as ProjectSnapshotBundle);
    if (!verification.valid) throw new Error(`冻结项目快照校验失败：${verification.issues.join("；")}`);
  }
  const fingerprintInput = replay.subjectKind === "chapter" ? chapterReplayFingerprintInput(replay) : foundationReplayFingerprintInput(replay);
  if (await textFingerprint(fingerprintInput) !== replay.inputFingerprint) throw new Error("冻结失败场景指纹不匹配");
}

export async function captureChapterRuleReplay(input: {
  projectId: string;
  documentId: string;
  instruction: string;
  scenarioClass: string;
}, db: NovelDatabase = novelDb): Promise<Extract<CraftRuleReplaySnapshot, { subjectKind: "chapter" }>> {
  const document = await db.documents.get(input.documentId);
  if (!document || document.projectId !== input.projectId || document.deletedAt) throw new Error("无法冻结不存在的章节评测场景");
  const instruction = input.instruction.trim() || document.blueprint.objective || document.summary || `完成${document.title}`;
  const [projectSnapshot, context] = await Promise.all([
    captureProjectSnapshot(db, input.projectId, "replay"),
    buildChapterEvaluationContextSnapshot(document, instruction, db),
  ]);
  const replay: Extract<CraftRuleReplaySnapshot, { subjectKind: "chapter" }> = {
    subjectKind: "chapter",
    subjectId: document.id,
    scenarioClass: input.scenarioClass.trim() || "章节规则评测",
    capturedAt: Date.now(),
    inputFingerprint: "",
    chapter: { projectSnapshot, thread: structuredClone(context.thread), brief: structuredClone(context.brief), instruction },
  };
  replay.inputFingerprint = await textFingerprint(chapterReplayFingerprintInput(replay));
  return replay;
}

export async function createCraftRuleCandidateFromLearning(input: {
  projectId: string;
  learning: LearningAssessment;
  source: CraftRuleLearningSource;
}, db: NovelDatabase = novelDb): Promise<CraftRuleCandidate | undefined> {
  if (input.learning.conclusion === "no-shared-learning") return undefined;
  const learning = input.learning;
  return db.transaction("rw", db.craftRuleCandidates, db.skills, db.projectSkills, db.promptTemplateVersions, async () => {
    const existing = await db.craftRuleCandidates
      .where("[projectId+learningSource.fingerprint]")
      .equals([input.projectId, input.source.fingerprint])
      .first();
    if (existing) return existing;
    const { proposal } = learning;
    if (!proposal.targetVersion || !proposal.targetContentFingerprint) {
      throw new Error("learning 改进候选缺少审核时规则版本或内容指纹");
    }
    return createCraftRuleCandidate({
      projectId: input.projectId,
      targetKind: proposal.targetKind,
      targetId: proposal.targetId,
      afterText: proposal.afterText,
      rationale: proposal.rationale,
      scope: {
        observedSymptom: proposal.observedSymptom,
        failingLayer: proposal.failingLayer,
        underlyingMechanism: learning.underlyingMechanism,
        affectedInputClass: learning.affectedInputClass,
        intendedBenefits: proposal.intendedBenefits,
        boundaries: proposal.boundaries,
        nonGoals: proposal.nonGoals,
        regressionRisks: proposal.regressionRisks,
      },
      learningSource: input.source,
      expectedTargetVersion: proposal.targetVersion,
      expectedTargetContentFingerprint: proposal.targetContentFingerprint,
    }, db);
  });
}

type CandidateQuality = { id?: string; qualityEvidence?: { weightedScore?: number; blockerCount?: number; majorCount?: number } };
type RuleApplication = {
  candidateId?: string;
  evaluationRole?: string;
  targetKind?: string;
  targetId?: string;
  version?: string;
  promptFingerprint?: string;
  stages?: string[];
};

export async function recordCraftRuleEvidence(input: {
  candidateId: string;
  scenarioClass: string;
  baselineWorkItemId: string;
  candidateWorkItemId: string;
}, db: NovelDatabase = novelDb): Promise<CraftRuleCandidate> {
  const candidate = await db.craftRuleCandidates.get(input.candidateId);
  if (!candidate) throw new Error("规则候选不存在");
  if (candidate.status === "rolled-back") throw new Error("已回滚的规则候选不能追加证据");
  if (!input.scenarioClass.trim()) throw new Error("scenarioClass 不能为空");
  const [baselineWork, candidateWork] = await Promise.all([
    db.creativeWorkItems.get(input.baselineWorkItemId),
    db.creativeWorkItems.get(input.candidateWorkItemId),
  ]);
  if (!baselineWork || !candidateWork || baselineWork.projectId !== candidate.projectId || candidateWork.projectId !== candidate.projectId) throw new Error("评测工作项不存在或不属于当前项目");
  if (baselineWork.status !== "completed" || candidateWork.status !== "completed") throw new Error("基线与候选工作项必须都已完成");
  const chapterPair = baselineWork.kind === "chapter-workflow" && candidateWork.kind === "chapter-workflow";
  const foundationPair = baselineWork.kind === "generation" && candidateWork.kind === "generation"
    && baselineWork.parameters.evaluationKind === "foundation-isolated-v1"
    && candidateWork.parameters.evaluationKind === "foundation-isolated-v1"
    && baselineWork.taskKey === candidateWork.taskKey;
  if ((!chapterPair && !foundationPair) || baselineWork.targetId !== candidateWork.targetId) {
    throw new Error("规则证据必须来自同一章节或同一基础创作任务的隔离 A/B 工作对");
  }
  if (baselineWork.parameters.evaluationRole !== "baseline") throw new Error("基线工作项缺少 evaluationRole=baseline");
  if (candidateWork.parameters.evaluationRole !== "candidate" || candidateWork.parameters.ruleCandidateId !== candidate.id) throw new Error("候选工作项没有应用当前规则候选");
  if (baselineWork.parameters.ruleCandidateId !== candidate.id) throw new Error("基线工作项没有绑定当前规则候选");
  if (baselineWork.parameters.scenarioClass !== input.scenarioClass.trim() || candidateWork.parameters.scenarioClass !== input.scenarioClass.trim()) {
    throw new Error("证据场景类别与评测工作项不一致");
  }
  if (candidate.evidenceCases.some((item) => item.baselineWorkItemId === baselineWork.id || item.candidateWorkItemId === candidateWork.id)) {
    throw new Error("同一基线/候选工作对不能重复计入证据");
  }
  const baselineApplication = baselineWork.parameters.ruleApplication as RuleApplication | undefined;
  const candidateApplication = candidateWork.parameters.ruleApplication as RuleApplication | undefined;
  for (const [label, application, role] of [["基线", baselineApplication, "baseline"], ["候选", candidateApplication, "candidate"]] as const) {
    if (!application || application.candidateId !== candidate.id || application.evaluationRole !== role
      || application.targetKind !== candidate.targetKind || application.targetId !== candidate.targetId
      || application.version !== candidate.proposedVersion || !application.promptFingerprint || !application.stages?.length) {
      throw new Error(`${label}工作项缺少可验证的规则 Prompt provenance`);
    }
  }
  if (baselineApplication!.promptFingerprint === candidateApplication!.promptFingerprint) {
    throw new Error("基线与候选 Prompt 指纹相同，不能证明规则文本已发生变化");
  }
  const baselineReplay = baselineWork.parameters.replaySnapshot as CraftRuleReplaySnapshot | undefined;
  const candidateReplay = candidateWork.parameters.replaySnapshot as CraftRuleReplaySnapshot | undefined;
  if (!baselineReplay || !candidateReplay || baselineReplay.inputFingerprint !== candidateReplay.inputFingerprint) {
    throw new Error("规则评测工作项缺少一致的冻结回放快照");
  }
  if ((chapterPair && baselineReplay.subjectKind !== "chapter") || (foundationPair && baselineReplay.subjectKind !== "foundation-task") || baselineReplay.subjectId !== baselineWork.targetId) {
    throw new Error("冻结回放快照与规则评测目标不匹配");
  }
  await assertReplayIntegrity(baselineReplay);
  const baseline = baselineWork.parameters.closedLoopCandidate as CandidateQuality | undefined;
  const changed = candidateWork.parameters.closedLoopCandidate as CandidateQuality | undefined;
  if (!baseline?.qualityEvidence || !changed?.qualityEvidence) throw new Error("评测工作项缺少质量证据");
  const frozenDocument = baselineReplay.subjectKind === "chapter"
    ? (baselineReplay.chapter.projectSnapshot as ProjectSnapshotBundle).records.documents.find((item) => item.id === baselineReplay.subjectId) as unknown as ManuscriptDocument | undefined
    : undefined;
  if (chapterPair && !frozenDocument) throw new Error("章节冻结回放快照缺少目标正文");
  const scenario = chapterPair
    ? deriveChapterScenarioFromDocument(frozenDocument!)
    : {
      profile: structuredClone(baselineWork.parameters.scenarioProfile as Record<string, string>),
      signature: String(baselineWork.parameters.scenarioSignature ?? ""),
    };
  if (!scenario.signature || !scenario.profile || (foundationPair && JSON.stringify(scenario.profile) !== JSON.stringify(candidateWork.parameters.scenarioProfile))) {
    throw new Error("基础评测工作项缺少一致的场景签名");
  }
  const evidence = {
    caseId: crypto.randomUUID(),
    scenarioClass: input.scenarioClass.trim(),
    subjectKind: chapterPair ? "chapter" as const : "foundation-task" as const,
    subjectId: baselineWork.targetId!,
    documentId: chapterPair ? baselineWork.targetId! : undefined,
    scenarioSignature: scenario.signature,
    scenarioProfile: scenario.profile,
    baselineWorkItemId: baselineWork.id,
    candidateWorkItemId: candidateWork.id,
    baselineArtifactId: String(baseline.id ?? baselineWork.artifactRefs[0]),
    candidateArtifactId: String(changed.id ?? candidateWork.artifactRefs[0]),
    baselineScore: baseline.qualityEvidence.weightedScore ?? 0,
    candidateScore: changed.qualityEvidence.weightedScore ?? 0,
    blockerDelta: (changed.qualityEvidence.blockerCount ?? 0) - (baseline.qualityEvidence.blockerCount ?? 0),
    majorDelta: (changed.qualityEvidence.majorCount ?? 0) - (baseline.qualityEvidence.majorCount ?? 0),
    recordedAt: Date.now(),
  };
  if (candidate.status === "promoted") {
    if ([...candidate.evidenceCases, ...(candidate.promotionObservations ?? [])].some((item) => item.subjectId === evidence.subjectId && item.scenarioSignature === evidence.scenarioSignature)) {
      throw new Error("晋升后 observation 必须使用未参与候选评测的新场景");
    }
    const candidateBlockers = changed.qualityEvidence.blockerCount ?? 0;
    const candidateMajors = changed.qualityEvidence.majorCount ?? 0;
    const passed = candidateBlockers === 0 && candidateMajors === 0
      && evidence.candidateScore >= evidence.baselineScore
      && evidence.blockerDelta <= 0 && evidence.majorDelta <= 0;
    const observation: CraftRulePromotionObservation = {
      observationId: crypto.randomUUID(),
      scenarioClass: evidence.scenarioClass,
      subjectKind: evidence.subjectKind,
      subjectId: evidence.subjectId,
      scenarioSignature: evidence.scenarioSignature,
      scenarioProfile: evidence.scenarioProfile,
      baselineArtifactId: evidence.baselineArtifactId,
      candidateArtifactId: evidence.candidateArtifactId,
      baselineScore: evidence.baselineScore,
      candidateScore: evidence.candidateScore,
      blockerDelta: evidence.blockerDelta,
      majorDelta: evidence.majorDelta,
      observedAt: Date.now(),
      outcome: passed ? "passed" : "regressed",
    };
    candidate.promotionObservations = [...(candidate.promotionObservations ?? []), observation];
    candidate.updatedAt = Date.now();
    candidate.revision += 1;
    await db.craftRuleCandidates.put(candidate);
    return passed ? candidate : rollbackCraftRuleCandidate(candidate.id, db);
  }
  if (candidate.promotionValidation?.status === "pending") {
    const candidateBlockers = changed.qualityEvidence.blockerCount ?? 0;
    const candidateMajors = changed.qualityEvidence.majorCount ?? 0;
    const passed = candidateBlockers === 0 && candidateMajors === 0
      && evidence.candidateScore >= evidence.baselineScore
      && evidence.blockerDelta <= 0 && evidence.majorDelta <= 0;
    candidate.promotionValidation = {
      status: passed ? "passed" : "failed",
      subjectKind: evidence.subjectKind,
      subjectId: evidence.subjectId,
      scenarioClass: evidence.scenarioClass,
      activeVersion: candidate.proposedVersion,
      workItemId: candidateWork.id,
      artifactId: evidence.candidateArtifactId,
      summary: passed
        ? `新版本回归通过：${evidence.baselineScore.toFixed(2)} -> ${evidence.candidateScore.toFixed(2)}`
        : `新版本回归失败：blocker=${candidateBlockers}, major=${candidateMajors}, score ${evidence.baselineScore.toFixed(2)} -> ${evidence.candidateScore.toFixed(2)}`,
      checkedAt: Date.now(),
    };
    candidate.updatedAt = Date.now();
    candidate.revision += 1;
    await db.craftRuleCandidates.put(candidate);
    return candidate;
  }
  candidate.promotionReplay ??= structuredClone(baselineReplay);
  candidate.evidenceCases = [...candidate.evidenceCases.filter((item) => item.subjectId !== evidence.subjectId), evidence];
  return refreshStatus(candidate, db);
}

export async function evaluateCraftRuleOnChapter(input: {
  candidateId: string;
  documentId: string;
  scenarioClass: string;
  replay?: Extract<CraftRuleReplaySnapshot, { subjectKind: "chapter" }>;
}, dependencies: CreativeExecutionDependencies = {}, db: NovelDatabase = novelDb): Promise<CraftRuleCandidate> {
  const candidate = await db.craftRuleCandidates.get(input.candidateId);
  if (!candidate || candidate.status === "rolled-back") throw new Error("规则候选不存在或已回滚");
  if (input.replay) {
    if (input.replay.subjectId !== input.documentId) throw new Error("章节冻结回放快照与目标不匹配");
    await assertReplayIntegrity(input.replay);
  }
  const frozenDocument = input.replay
    ? (input.replay.chapter.projectSnapshot as ProjectSnapshotBundle).records.documents.find((item) => item.id === input.documentId) as unknown as ManuscriptDocument | undefined
    : undefined;
  const document = frozenDocument ?? await db.documents.get(input.documentId);
  if (!document || document.projectId !== candidate.projectId || document.deletedAt) throw new Error("评测章节不存在或不属于当前项目");
  const scenarioClass = input.scenarioClass.trim();
  if (!scenarioClass) throw new Error("创作场景类别不能为空");
  const replay = input.replay ?? await captureChapterRuleReplay({ projectId: candidate.projectId, documentId: document.id, instruction: document.blueprint.objective || document.summary || `完成${document.title}`, scenarioClass }, db);
  const targetStages = candidate.targetKind === "skill"
    ? (await getEffectiveSkill(candidate.projectId, candidate.targetId, db))?.stages
    : (await listPromptTemplates(candidate.projectId, db)).find((item) => item.templateId === candidate.targetId)?.stages;
  if (!targetStages || !supportsChapterRuleEvaluation(targetStages)) {
    throw new Error("该规则仅适用于基础设定阶段，不能用章节工作流评测；需要对应阶段的隔离评测器");
  }
  const candidateId = candidate.id;
  const documentId = document.id;
  const instruction = replay.chapter.instruction;

  const run = await createCreativeRun({
    projectId: candidate.projectId,
    mode: "segment-auto",
    objective: `评测规则候选 ${candidate.targetId}@${candidate.proposedVersion}：${scenarioClass}`,
    policy: { maxIterations: 2 },
  }, db);
  const baseline = await enqueueCreativeWork(run.id, {
    kind: "chapter-workflow",
    targetId: documentId,
    instruction,
    parameters: { evaluationRole: "baseline", scenarioClass, ruleCandidateId: candidateId, replaySnapshot: replay },
  }, db);
  const changed = await enqueueCreativeWork(run.id, {
    kind: "chapter-workflow",
    targetId: documentId,
    instruction,
    parameters: { evaluationRole: "candidate", scenarioClass, ruleCandidateId: candidateId, replaySnapshot: replay },
  }, db);

  async function completeEvaluationWork(workItemId: string, label: string) {
    const keyRoot = `rule-eval:${candidateId}:${documentId}:${run.id}:${label}`;
    const maxIterations = run.policy.maxIterations ?? 0;
    for (let attempt = 0; attempt <= maxIterations; attempt += 1) {
      await executeCreativeCommand({ runId: run.id, type: "work.start", workItemId, idempotencyKey: `${keyRoot}:start:${attempt}` }, { ...dependencies, db });
      const current = await db.creativeWorkItems.get(workItemId);
      if (current?.status === "completed") return current;
      if (current?.status !== "blocked" || attempt >= maxIterations) {
        throw new Error(`${label}评测未通过审核：${current?.summary ?? current?.error ?? "未知原因"}`);
      }
      await executeCreativeCommand({
        runId: run.id,
        type: "work.revise",
        workItemId,
        idempotencyKey: `${keyRoot}:revise:${attempt}`,
      }, { ...dependencies, db });
    }
    throw new Error(`${label}评测超过最大迭代次数`);
  }

  await completeEvaluationWork(baseline.id, "基线");
  await completeEvaluationWork(changed.id, "候选");
  return recordCraftRuleEvidence({
    candidateId,
    scenarioClass,
    baselineWorkItemId: baseline.id,
    candidateWorkItemId: changed.id,
  }, db);
}

type FoundationEvaluationArtifact = {
  artifactMarkdown: string;
  designNotes: string[];
};

type FoundationEvaluationAssessment = {
  scores: Record<"plotPotential" | "characterAgency" | "worldCausality" | "longFormCapacity" | "specificity" | "styleFitness", number>;
  issues: Array<{ severity: "blocker" | "major" | "warning"; summary: string }>;
  summary: string;
};

export interface FoundationRuleEvaluationDependencies {
  generate?: (input: { taskKey: NovelGenerationTaskKey; instruction: string; projectContext: string; ruleText: string; model: string }) => Promise<FoundationEvaluationArtifact>;
  assess?: (input: { taskKey: NovelGenerationTaskKey; instruction: string; projectContext: string; artifact: FoundationEvaluationArtifact; model: string }) => Promise<FoundationEvaluationAssessment>;
}

const foundationArtifactSchema = {
  type: "object", additionalProperties: false, required: ["artifactMarkdown", "designNotes"],
  properties: {
    artifactMarkdown: { type: "string", minLength: 100 },
    designNotes: { type: "array", items: { type: "string" } },
  },
} as const;

const foundationAssessmentSchema = {
  type: "object", additionalProperties: false, required: ["scores", "issues", "summary"],
  properties: {
    scores: {
      type: "object", additionalProperties: false,
      required: ["plotPotential", "characterAgency", "worldCausality", "longFormCapacity", "specificity", "styleFitness"],
      properties: Object.fromEntries(["plotPotential", "characterAgency", "worldCausality", "longFormCapacity", "specificity", "styleFitness"].map((key) => [key, { type: "number", minimum: 1, maximum: 5 }])),
    },
    issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["severity", "summary"], properties: { severity: { enum: ["blocker", "major", "warning"] }, summary: { type: "string" } } } },
    summary: { type: "string" },
  },
} as const;

async function textFingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function evaluateCraftRuleOnFoundation(input: {
  candidateId: string;
  taskKey: typeof FOUNDATION_EVALUATION_TASKS[number];
  scenarioClass: string;
  instruction?: string;
  replay?: Extract<CraftRuleReplaySnapshot, { subjectKind: "foundation-task" }>;
}, dependencies: FoundationRuleEvaluationDependencies = {}, db: NovelDatabase = novelDb): Promise<CraftRuleCandidate> {
  const candidate = await db.craftRuleCandidates.get(input.candidateId);
  if (!candidate || candidate.status === "rolled-back") throw new Error("规则候选不存在或已回滚");
  if (!FOUNDATION_EVALUATION_TASKS.includes(input.taskKey)) throw new Error("不支持的基础设定评测任务");
  const targetStages = candidate.targetKind === "skill"
    ? (await getEffectiveSkill(candidate.projectId, candidate.targetId, db))?.stages
    : (await listPromptTemplates(candidate.projectId, db)).find((item) => item.templateId === candidate.targetId)?.stages;
  if (!targetStages || !supportsFoundationRuleEvaluation(targetStages)) throw new Error("该规则不适用于基础设定阶段");
  const scenarioClass = input.scenarioClass.trim();
  if (!scenarioClass) throw new Error("创作场景类别不能为空");
  if (input.replay) {
    if (input.replay.subjectId !== `foundation:${input.taskKey}` || input.replay.foundation.taskKey !== input.taskKey) throw new Error("基础任务冻结回放快照与目标不匹配");
    await assertReplayIntegrity(input.replay);
  }
  const liveContext = input.replay ? undefined : await buildFoundationEvaluationContext({ projectId: candidate.projectId, taskKey: input.taskKey, instruction: input.instruction }, db);
  const project = liveContext?.project ?? await db.projects.get(candidate.projectId);
  if (!project) throw new Error("项目不存在");
  const task = liveContext?.task ?? getGenerationTask(input.taskKey);
  const replay = input.replay ?? await captureFoundationRuleReplay({ projectId: candidate.projectId, taskKey: input.taskKey, instruction: input.instruction, scenarioClass }, db);
  const instruction = replay.foundation.instruction;
  const projectContext = replay.foundation.projectContext;
  const scenarioProfile = liveContext?.scenarioProfile ?? { taskKey: input.taskKey, frozenInputFingerprint: replay.inputFingerprint };
  const scenarioSignature = liveContext?.scenarioSignature ?? replay.inputFingerprint;
  const generate = dependencies.generate ?? (async (params) => (await callStructuredNovelModel<FoundationEvaluationArtifact>({
    model: params.model,
    temperature: 0.45,
    role: "architect",
    skillPrompt: `# 待评测规则\n${params.ruleText}`,
    schema: foundationArtifactSchema,
    maxTokens: 8192,
    prompt: `# 隔离基础创作评测\n任务：${params.taskKey}\n作者要求：${params.instruction}\n依据冻结项目上下文产出可审阅的完整创作方案。不得修改正式项目，不得讨论规则本身。\n\n# 冻结项目上下文\n${params.projectContext}`,
  })).data);
  const assess = dependencies.assess ?? (async (params) => (await callStructuredNovelModel<FoundationEvaluationAssessment>({
    model: params.model,
    temperature: 0.1,
    role: "quality-editor",
    schema: foundationAssessmentSchema,
    maxTokens: 4096,
    prompt: `# 基础创作产物盲审\n不知道产物使用了哪一版规则。只依据作者要求、冻结上下文和实际产物，分别评价剧情潜力、人物主体性、世界因果、长篇承载力、具体性与项目文体适配。问题必须来自产物证据，不因结构不同而扣分。\n\n任务：${params.taskKey}\n作者要求：${params.instruction}\n冻结上下文：${params.projectContext}\n\n待审产物：\n${params.artifact.artifactMarkdown}`,
  })).data);

  const run = await createCreativeRun({ projectId: candidate.projectId, mode: "segment-auto", objective: `基础规则评测 ${candidate.targetId}@${candidate.proposedVersion}：${input.taskKey}`, policy: { maxIterations: 0 } }, db);
  const targetId = `foundation:${input.taskKey}`;
  const commonParameters = { evaluationKind: "foundation-isolated-v1", scenarioClass, scenarioProfile, scenarioSignature, ruleCandidateId: candidate.id, replaySnapshot: replay };
  const baseline = await enqueueCreativeWork(run.id, { kind: "generation", taskKey: input.taskKey, targetId, instruction, parameters: { ...commonParameters, evaluationRole: "baseline" } }, db);
  const changed = await enqueueCreativeWork(run.id, { kind: "generation", taskKey: input.taskKey, targetId, instruction, parameters: { ...commonParameters, evaluationRole: "candidate" } }, db);
  const executor = async (work: Parameters<NonNullable<CreativeExecutionDependencies["executor"]>>[0]) => {
    const evaluationRole = work.parameters.evaluationRole === "candidate" ? "candidate" : "baseline";
    const ruleText = evaluationRole === "candidate" ? candidate.afterText : candidate.beforeText;
    const artifact = await generate({ taskKey: input.taskKey, instruction: work.instruction, projectContext, ruleText, model: replay.foundation.model });
    const assessment = await assess({ taskKey: input.taskKey, instruction: work.instruction, projectContext, artifact, model: replay.foundation.model });
    const scoreValues = Object.values(assessment.scores);
    const weightedScore = scoreValues.reduce((sum, score) => sum + score, 0) / scoreValues.length;
    const artifactId = `${work.id}:foundation-artifact`;
    work.parameters.ruleApplication = { candidateId: candidate.id, evaluationRole, targetKind: candidate.targetKind, targetId: candidate.targetId, version: candidate.proposedVersion, promptFingerprint: await textFingerprint(`${candidate.targetKind}:${candidate.targetId}:${candidate.proposedVersion}:${ruleText}`), stages: ["foundation"] };
    work.parameters.closedLoopCandidate = {
      id: artifactId,
      foundationArtifact: artifact,
      foundationAssessment: assessment,
      qualityEvidence: {
        weightedScore,
        blockerCount: assessment.issues.filter((issue) => issue.severity === "blocker").length,
        majorCount: assessment.issues.filter((issue) => issue.severity === "major").length,
        dimensionScores: assessment.scores,
        topIssues: assessment.issues.map((issue) => ({ severity: issue.severity, dimension: "foundation", summary: issue.summary })),
      },
    };
    return { artifactRefs: [artifactId], summary: `${task.label}隔离产物已生成，盲审 ${weightedScore.toFixed(2)}` };
  };
  const reviewer = async (work: Parameters<NonNullable<CreativeExecutionDependencies["reviewer"]>>[0]) => ({ subjectArtifactId: work.artifactRefs[0]!, reviewer: "internal" as const, verdict: "passed" as const, issues: [], summary: "隔离产物和盲审证据已完整保存" });
  const accepter = async (work: Parameters<NonNullable<CreativeExecutionDependencies["accepter"]>>[0]) => ({ artifactRefs: work.artifactRefs, summary: work.summary ?? "隔离评测完成" });
  for (const work of [baseline, changed]) {
    await executeCreativeCommand({ runId: run.id, type: "work.start", workItemId: work.id, idempotencyKey: `foundation-rule-eval:${candidate.id}:${input.taskKey}:${run.id}:${work.parameters.evaluationRole}` }, { db, executor, reviewer, accepter });
  }
  return recordCraftRuleEvidence({ candidateId: candidate.id, scenarioClass, baselineWorkItemId: baseline.id, candidateWorkItemId: changed.id }, db);
}

export async function submitCraftRuleReview(input: {
  candidateId: string;
  role: CraftRuleReviewRole;
  reviewer: "external-llm" | "user";
  reviewerId: string;
  reviewRunId: string;
  model?: string;
  provider?: string;
  promptFingerprint?: string;
  verdict: CraftRuleReviewDecision["verdict"];
  summary: string;
  concerns?: string[];
}, db: NovelDatabase = novelDb): Promise<CraftRuleCandidate> {
  const candidate = await db.craftRuleCandidates.get(input.candidateId);
  if (!candidate) throw new Error("规则候选不存在");
  if (["promoted", "rolled-back"].includes(candidate.status)) throw new Error("已结束的规则候选不能追加审核");
  if (!REQUIRED_REVIEW_ROLES.includes(input.role)) throw new Error("未知规则审核角色");
  if (input.reviewer !== "external-llm" && input.reviewer !== "user") throw new Error("未知规则审核来源");
  if (!(["passed", "revise", "rejected"] as string[]).includes(input.verdict)) throw new Error("未知规则审核结论");
  if (!input.reviewerId?.trim()) throw new Error("规则审核缺少 reviewerId");
  if (!input.reviewRunId?.trim()) throw new Error("规则审核缺少独立 reviewRunId");
  if (input.reviewer === "external-llm" && !input.model?.trim()) throw new Error("外部 LLM 审核缺少模型身份");
  if (!input.summary.trim()) throw new Error("规则审核摘要不能为空");
  candidate.reviews = [...candidate.reviews, {
    role: input.role,
    reviewer: input.reviewer,
    reviewerId: input.reviewerId.trim(),
    reviewRunId: input.reviewRunId.trim(),
    model: input.model?.trim() || undefined,
    provider: input.provider?.trim() || undefined,
    modelIdentity: input.reviewer === "external-llm" ? `${input.provider?.trim() || "unknown"}:${input.model!.trim()}` : undefined,
    promptFingerprint: input.promptFingerprint?.trim() || undefined,
    reviewInputFingerprint: `${candidate.proposedVersion}:${evidenceFingerprint(candidate)}:${input.role}`,
    reviewCriteriaVersion: REVIEW_CRITERIA_VERSION,
    focusAreas: [...REVIEW_ROLE_FOCUS[input.role]],
    verdict: input.verdict,
    summary: input.summary.trim(),
    concerns: [...new Set(input.concerns ?? [])],
    evidenceFingerprint: evidenceFingerprint(candidate),
    reviewedVersion: candidate.proposedVersion,
    reviewedAt: Date.now(),
  }];
  return refreshStatus(candidate, db);
}

export interface CraftRulePromotionDependencies {
  evaluateChapter?: typeof evaluateCraftRuleOnChapter;
  evaluateFoundation?: typeof evaluateCraftRuleOnFoundation;
}

export async function promoteCraftRuleCandidate(candidateId: string, db: NovelDatabase = novelDb, dependencies: CraftRulePromotionDependencies = {}): Promise<CraftRuleCandidate> {
  let candidate = await db.craftRuleCandidates.get(candidateId);
  if (!candidate) throw new Error("规则候选不存在");
  const initialCandidate = candidate;
  const gate = evaluateCraftRuleGate(candidate);
  if (!gate.ready || candidate.status !== "ready") throw new Error(`规则候选未通过晋升门禁：${gate.reasons.join("；")}`);
  const replay = candidate.learningSource?.replay ?? candidate.promotionReplay;
  if (!replay) throw new Error("规则候选缺少冻结失败场景，不能执行晋升回归");
  await assertReplayIntegrity(replay);
  candidate.promotionValidation = {
    status: "pending",
    subjectKind: replay.subjectKind,
    subjectId: replay.subjectId,
    scenarioClass: replay.scenarioClass,
    activeVersion: candidate.proposedVersion,
    summary: "正在以候选新版本重跑冻结失败场景，验证通过前不会激活",
    checkedAt: Date.now(),
  };
  candidate.updatedAt = Date.now();
  candidate.revision += 1;
  await db.craftRuleCandidates.put(candidate);

  async function failValidation(error: unknown) {
    const current = await db.craftRuleCandidates.get(candidateId);
    if (!current) return initialCandidate;
    current.status = "rolled-back";
    current.promotionValidation = {
      ...(current.promotionValidation ?? initialCandidate.promotionValidation!),
      status: "failed",
      summary: error instanceof Error ? error.message : "晋升回归执行失败，新版本未激活",
      checkedAt: Date.now(),
    };
    current.updatedAt = Date.now();
    current.revision += 1;
    await db.craftRuleCandidates.put(current);
    return current;
  }

  try {
    if (replay.subjectKind === "chapter") {
      await (dependencies.evaluateChapter ?? evaluateCraftRuleOnChapter)({ candidateId: candidate.id, documentId: replay.subjectId, scenarioClass: replay.scenarioClass, replay }, {}, db);
    } else {
      await (dependencies.evaluateFoundation ?? evaluateCraftRuleOnFoundation)({ candidateId: candidate.id, taskKey: replay.foundation.taskKey, scenarioClass: replay.scenarioClass, instruction: replay.foundation.instruction, replay }, {}, db);
    }
  } catch (error) {
    return failValidation(error);
  }

  candidate = (await db.craftRuleCandidates.get(candidateId)) ?? candidate;
  if (candidate.promotionValidation?.status !== "passed") {
    return failValidation(new Error(candidate.promotionValidation?.summary || "冻结失败场景回归未通过，新版本未激活"));
  }

  return db.transaction("rw", db.skills, db.projectSkills, db.promptTemplateVersions, db.craftRuleCandidates, async () => {
    const currentCandidate = await db.craftRuleCandidates.get(candidateId);
    if (!currentCandidate || currentCandidate.status !== "ready" || currentCandidate.promotionValidation?.status !== "passed") throw new Error("规则候选回归状态已变化，不能激活");
    if (currentCandidate.targetKind === "skill") {
      const current = await getEffectiveSkill(currentCandidate.projectId, currentCandidate.targetId, db);
      if (!current || current.version !== currentCandidate.beforeVersion || current.prompt !== currentCandidate.beforeText) throw new Error("Skill 基线已变化，需要重新评测");
      const next: NovelSkillManifest = { ...current, ...recordBase(currentCandidate.projectId), projectId: currentCandidate.projectId, source: "project", readonly: false, version: currentCandidate.proposedVersion, prompt: currentCandidate.afterText };
      await db.skills.add(next);
      await setProjectSkill(currentCandidate.projectId, currentCandidate.targetId, true, next.version, db);
      currentCandidate.promotedRecordId = next.id;
    } else {
      const current = (await listPromptTemplates(currentCandidate.projectId, db)).find((item) => item.templateId === currentCandidate.targetId);
      if (!current || current.version !== currentCandidate.beforeVersion || current.content !== currentCandidate.beforeText) throw new Error("系统 Prompt 基线已变化，需要重新评测");
      const activeProject = await db.promptTemplateVersions.where("[projectId+templateId]").equals([currentCandidate.projectId, currentCandidate.targetId]).and((item) => item.active).toArray();
      await db.promptTemplateVersions.bulkPut(activeProject.map((item) => ({ ...item, active: false, revision: item.revision + 1, updatedAt: Date.now() })));
      const next: PromptTemplateVersion = { ...current, ...recordBase(currentCandidate.projectId), projectId: currentCandidate.projectId, source: "project", version: currentCandidate.proposedVersion, content: currentCandidate.afterText, active: true, previousVersionId: current.id };
      await db.promptTemplateVersions.add(next);
      currentCandidate.promotedRecordId = next.id;
    }
    currentCandidate.status = "promoted";
    currentCandidate.promotedAt = Date.now();
    currentCandidate.updatedAt = currentCandidate.promotedAt;
    currentCandidate.revision += 1;
    await db.craftRuleCandidates.put(currentCandidate);
    return currentCandidate;
  });
}

async function buildFoundationEvaluationContext(input: { projectId: string; taskKey: FoundationEvaluationTaskKey; instruction?: string }, db: NovelDatabase) {
  const project = await db.projects.get(input.projectId);
  if (!project) throw new Error("项目不存在");
  const task = getGenerationTask(input.taskKey);
  const instruction = input.instruction?.trim() || task.defaultInstruction;
  const [architecture, entities, relations, segments, documents] = await Promise.all([
    db.architectures.where("projectId").equals(input.projectId).first(),
    db.entities.where("projectId").equals(input.projectId).toArray(),
    db.relations.where("projectId").equals(input.projectId).toArray(),
    db.outlineNodes.where("projectId").equals(input.projectId).sortBy("order"),
    db.documents.where("projectId").equals(input.projectId).sortBy("order"),
  ]);
  const projectContext = JSON.stringify({
    project: { title: project.title, premise: project.premise, genre: project.genre, audience: project.audience, themes: project.themes, sellingPoints: project.sellingPoints, pov: project.pov, tone: project.tone, languageStyle: project.languageStyle, targetWords: project.targetWords },
    architecture: architecture ? { centralQuestion: architecture.centralQuestion, centralConflict: architecture.centralConflict, synopsis: architecture.synopsis, phases: architecture.phases } : null,
    entities: entities.map((entity) => ({ kind: entity.kind, name: entity.name, summary: entity.summary, description: entity.description, character: entity.character })),
    relations: relations.map((relation) => ({ fromEntityId: relation.fromEntityId, toEntityId: relation.toEntityId, relationType: relation.relationType, publicLabel: relation.publicLabel, privateTruth: relation.privateTruth })),
    segments: segments.map((segment) => ({ title: segment.title, summary: segment.summary, phaseId: segment.phaseId })),
    chapters: documents.map((document) => ({ title: document.title, summary: document.summary, status: document.status, objective: document.blueprint.objective })),
  });
  const scenarioProfile = { taskKey: input.taskKey, taskScope: task.scope, architectureState: architecture ? "present" : "absent", entityState: countBand(entities.length), relationState: countBand(relations.length), planningState: countBand(segments.length + documents.length) };
  return { project, task, instruction, projectContext, scenarioProfile, scenarioSignature: JSON.stringify(scenarioProfile) };
}

export async function captureFoundationRuleReplay(input: { projectId: string; taskKey: FoundationEvaluationTaskKey; instruction?: string; scenarioClass: string }, db: NovelDatabase = novelDb): Promise<Extract<CraftRuleReplaySnapshot, { subjectKind: "foundation-task" }>> {
  const context = await buildFoundationEvaluationContext(input, db);
  const replay: Extract<CraftRuleReplaySnapshot, { subjectKind: "foundation-task" }> = {
    subjectKind: "foundation-task",
    subjectId: `foundation:${input.taskKey}`,
    scenarioClass: input.scenarioClass.trim() || `基础任务:${input.taskKey}`,
    capturedAt: Date.now(),
    inputFingerprint: "",
    foundation: { taskKey: input.taskKey, instruction: context.instruction, projectContext: context.projectContext, model: context.project.settings.textModel },
  };
  replay.inputFingerprint = await textFingerprint(foundationReplayFingerprintInput(replay));
  return replay;
}

export async function rollbackCraftRuleCandidate(candidateId: string, db: NovelDatabase = novelDb): Promise<CraftRuleCandidate> {
  return db.transaction("rw", db.skills, db.projectSkills, db.promptTemplateVersions, db.craftRuleCandidates, async () => {
    const candidate = await db.craftRuleCandidates.get(candidateId);
    if (!candidate || candidate.status !== "promoted") throw new Error("只有已晋升规则候选可以回滚");
    if (candidate.targetKind === "skill") {
      const current = await getEffectiveSkill(candidate.projectId, candidate.targetId, db);
      if (!current || current.id !== candidate.promotedRecordId || current.version !== candidate.proposedVersion) {
        throw new Error("当前激活 Skill 已被后续版本替换，不能回滚旧候选");
      }
      const persistedTargets = await db.skills.where("[projectId+skillId]").anyOf([
        ["__user__", candidate.targetId],
        [candidate.projectId, candidate.targetId],
      ]).toArray();
      const hasTarget = persistedTargets.some((item) => item.version === candidate.beforeVersion)
        || BUILTIN_NOVEL_SKILLS.some((item) => item.skillId === candidate.targetId && item.version === candidate.beforeVersion);
      if (!hasTarget) throw new Error("回滚目标 Skill 版本不存在");
      await setProjectSkill(candidate.projectId, candidate.targetId, true, candidate.beforeVersion, db);
    } else {
      const current = (await listPromptTemplates(candidate.projectId, db)).find((item) => item.templateId === candidate.targetId);
      if (!current || current.id !== candidate.promotedRecordId || current.version !== candidate.proposedVersion) {
        throw new Error("当前激活 Prompt 已被后续版本替换，不能回滚旧候选");
      }
      const versions = await db.promptTemplateVersions.where("[projectId+templateId]").equals([candidate.projectId, candidate.targetId]).toArray();
      const hasProjectTarget = versions.some((item) => item.version === candidate.beforeVersion);
      const hasBuiltinTarget = BUILTIN_PROMPT_TEMPLATES.some((item) => item.templateId === candidate.targetId && item.version === candidate.beforeVersion);
      if (!hasProjectTarget && !hasBuiltinTarget) throw new Error("回滚目标 Prompt 版本不存在");
      const updates = versions.map((item) => ({ ...item, active: item.version === candidate.beforeVersion, revision: item.revision + 1, updatedAt: Date.now() }));
      await db.promptTemplateVersions.bulkPut(updates);
    }
    candidate.status = "rolled-back";
    candidate.updatedAt = Date.now();
    candidate.revision += 1;
    await db.craftRuleCandidates.put(candidate);
    return candidate;
  });
}

async function suggestObservationSubjects(candidate: CraftRuleCandidate, db: NovelDatabase): Promise<CraftRuleObservationSubject[]> {
  const targetStages = candidate.targetKind === "skill"
    ? (await getEffectiveSkill(candidate.projectId, candidate.targetId, db))?.stages
    : (await listPromptTemplates(candidate.projectId, db)).find((item) => item.templateId === candidate.targetId)?.stages;
  if (!targetStages) return [];
  const observedKeys = new Set([
    ...candidate.evidenceCases.map((item) => `${item.subjectId}:${item.scenarioSignature}`),
    ...(candidate.promotionObservations ?? []).map((item) => `${item.subjectId}:${item.scenarioSignature}`),
  ]);
  const knownProfiles = [...candidate.evidenceCases.map((item) => item.scenarioProfile), ...(candidate.promotionObservations ?? []).map((item) => item.scenarioProfile)];
  const noveltyScore = (profile: Record<string, string | undefined>) => Object.entries(profile)
    .filter(([, value]) => Boolean(value))
    .reduce((score, [dimension, value]) => score + (knownProfiles.some((known) => known[dimension] === value) ? 0 : 1), 0);
  const suggestions: Array<CraftRuleObservationSubject & { novelty: number; priority: number }> = [];
  if (supportsChapterRuleEvaluation(targetStages)) {
    const documents = await db.documents.where("projectId").equals(candidate.projectId).filter((item) => !item.deletedAt).toArray();
    for (const document of documents) {
      const scenario = deriveChapterScenarioFromDocument(document);
      if (observedKeys.has(`${document.id}:${scenario.signature}`)) continue;
      suggestions.push({
        subjectKind: "chapter",
        subjectId: document.id,
        documentId: document.id,
        scenarioClass: `晋升观察:${document.title}`,
        scenarioProfile: scenario.profile,
        novelty: noveltyScore(scenario.profile),
        priority: document.status === "final" ? 2 : document.status === "draft" ? 1 : 0,
      });
    }
  }
  if (supportsFoundationRuleEvaluation(targetStages)) {
    for (const taskKey of FOUNDATION_EVALUATION_TASKS) {
      const context = await buildFoundationEvaluationContext({ projectId: candidate.projectId, taskKey }, db);
      const subjectId = `foundation:${taskKey}`;
      if (observedKeys.has(`${subjectId}:${context.scenarioSignature}`)) continue;
      suggestions.push({ subjectKind: "foundation-task", subjectId, taskKey, scenarioClass: `晋升观察:${taskKey}`, scenarioProfile: context.scenarioProfile, novelty: noveltyScore(context.scenarioProfile), priority: 1 });
    }
  }
  return suggestions
    .sort((left, right) => right.novelty - left.novelty || right.priority - left.priority || left.subjectId.localeCompare(right.subjectId))
    .slice(0, 3)
    .map((item): CraftRuleObservationSubject => item.subjectKind === "chapter"
      ? { subjectKind: item.subjectKind, subjectId: item.subjectId, documentId: item.documentId, scenarioClass: item.scenarioClass, scenarioProfile: item.scenarioProfile }
      : { subjectKind: item.subjectKind, subjectId: item.subjectId, taskKey: item.taskKey, scenarioClass: item.scenarioClass, scenarioProfile: item.scenarioProfile });
}

export async function inspectCraftRuleCandidate(candidateId: string, db: NovelDatabase = novelDb) {
  const candidate = await db.craftRuleCandidates.get(candidateId);
  if (!candidate) throw new Error("规则候选不存在");
  const gate = evaluateCraftRuleGate(candidate);
  const observationGate = evaluateCraftRuleObservationGate(candidate);
  const nextActions: CraftRuleNextAction[] = [];
  if (candidate.status === "rejected") {
    nextActions.push({ type: "improvement.revise", candidateId, reason: "候选被独立审核拒绝，需要基于 concerns 创建新的不可变候选" });
  } else if (candidate.status === "promoted") {
    const observationCount = candidate.promotionObservations?.length ?? 0;
    if (!observationGate.ready) {
      nextActions.push({ type: "improvement.observe", candidateId, reason: observationGate.reasons.join("；"), requiredObservations: Math.max(0, 3 - observationCount), suggestedSubjects: await suggestObservationSubjects(candidate, db) });
    }
  } else if (candidate.status !== "rolled-back") {
    const evidenceReasons = gate.reasons.filter((reason) => reason.includes("场景") || reason.includes("基线/候选") || reason.includes("不同章节") || reason.includes("质量") || reason.includes("blocker") || reason.includes("major"));
    if (evidenceReasons.length) {
      nextActions.push({ type: "improvement.evaluate", candidateId, reason: evidenceReasons.join("；"), requiredCases: Math.max(0, 3 - candidate.evidenceCases.length), variedDimensions: gate.variedDimensions });
    }
    const reviewRoles = REQUIRED_REVIEW_ROLES.filter((role) => {
      const review = gate.latestReviews[role];
      return !review || review.verdict !== "passed" || review.reviewedVersion !== candidate.proposedVersion
        || review.evidenceFingerprint !== evidenceFingerprint(candidate) || review.reviewCriteriaVersion !== REVIEW_CRITERIA_VERSION;
    });
    if (reviewRoles.length) nextActions.push({ type: "improvement.review", candidateId, reason: "提交绑定当前候选版本、证据集和角色检查契约的独立审核", roles: reviewRoles });
    if (gate.ready && candidate.status === "ready") nextActions.push({ type: "improvement.promote", candidateId });
  }
  return { candidate, gate, observationGate, nextActions };
}
