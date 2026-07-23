import { novelDb, recordBase, type NovelDatabase } from "./db";
import { BUILTIN_NOVEL_SKILLS, getEffectiveSkill, nextPatchVersion, parseNovelSkill, setProjectSkill } from "./skills";
import { BUILTIN_PROMPT_TEMPLATES, listPromptTemplates } from "./prompt-templates";
import { callStructuredNovelModel } from "./ai";
import { getGenerationTask } from "./generation";
import {
  createCreativeRun,
  enqueueCreativeWork,
  executeCreativeCommand,
  type CreativeExecutionDependencies,
} from "./creative-execution";
import type {
  CraftRuleCandidate,
  CraftRuleReviewDecision,
  CraftRuleReviewRole,
  CraftRuleScopeAnalysis,
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
  latestReviews: Partial<Record<CraftRuleReviewRole, CraftRuleReviewDecision>>;
}

const CHAPTER_WORKFLOW_RULE_STAGES = new Set(["planning", "drafting", "review", "revision", "fact-extraction", "character-enrichment"]);
export const FOUNDATION_EVALUATION_TASKS = ["project-positioning", "architecture", "story-bible", "characters", "relations", "worldview"] as const satisfies NovelGenerationTaskKey[];

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

async function deriveChapterScenario(documentId: string, projectId: string, db: NovelDatabase) {
  const document = await db.documents.get(documentId);
  if (!document || document.projectId !== projectId || document.deletedAt) throw new Error("证据章节不存在或不属于当前项目");
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
  if (cases.some((item) => item.blockerDelta > 0 || item.majorDelta > 0)) reasons.push("候选规则不得增加 blocker 或 major");
  if (cases.some((item) => item.candidateScore < item.baselineScore - 0.2)) reasons.push("单个场景质量分回退不得超过 0.2");
  if (cases.length >= 3 && averageScoreDelta < 0.1) reasons.push("跨场景平均质量提升必须达到 0.1");

  const latestReviews: Partial<Record<CraftRuleReviewRole, CraftRuleReviewDecision>> = {};
  for (const review of candidate.reviews) latestReviews[review.role] = review;
  for (const role of REQUIRED_REVIEW_ROLES) {
    if (!latestReviews[role]) reasons.push(`缺少 ${role} 审核`);
    else if (latestReviews[role]?.verdict !== "passed") reasons.push(`${role} 审核未通过`);
    else if (latestReviews[role]?.reviewedVersion !== candidate.proposedVersion || latestReviews[role]?.evidenceFingerprint !== evidenceFingerprint(candidate)) {
      reasons.push(`${role} 审核早于当前证据集，需要重新审核`);
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
    if (currentReviews.some((review) => review.reviewer === "external-llm" && !review.model?.trim())) {
      reasons.push("外部 LLM 审核必须记录模型身份");
    }
  }
  return { ready: reasons.length === 0, reasons, averageScoreDelta, latestReviews };
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
  };
  await db.craftRuleCandidates.add(candidate);
  return candidate;
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
  if (["promoted", "rolled-back"].includes(candidate.status)) throw new Error("已结束的规则候选不能追加证据");
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
  const baseline = baselineWork.parameters.closedLoopCandidate as CandidateQuality | undefined;
  const changed = candidateWork.parameters.closedLoopCandidate as CandidateQuality | undefined;
  if (!baseline?.qualityEvidence || !changed?.qualityEvidence) throw new Error("评测工作项缺少质量证据");
  const scenario = chapterPair
    ? await deriveChapterScenario(baselineWork.targetId!, candidate.projectId, db)
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
  candidate.evidenceCases = [...candidate.evidenceCases.filter((item) => item.subjectId !== evidence.subjectId), evidence];
  return refreshStatus(candidate, db);
}

export async function evaluateCraftRuleOnChapter(input: {
  candidateId: string;
  documentId: string;
  scenarioClass: string;
}, dependencies: CreativeExecutionDependencies = {}, db: NovelDatabase = novelDb): Promise<CraftRuleCandidate> {
  const candidate = await db.craftRuleCandidates.get(input.candidateId);
  if (!candidate || ["promoted", "rolled-back"].includes(candidate.status)) throw new Error("规则候选不存在或已结束");
  const document = await db.documents.get(input.documentId);
  if (!document || document.projectId !== candidate.projectId || document.deletedAt) throw new Error("评测章节不存在或不属于当前项目");
  const scenarioClass = input.scenarioClass.trim();
  if (!scenarioClass) throw new Error("创作场景类别不能为空");
  const targetStages = candidate.targetKind === "skill"
    ? (await getEffectiveSkill(candidate.projectId, candidate.targetId, db))?.stages
    : (await listPromptTemplates(candidate.projectId, db)).find((item) => item.templateId === candidate.targetId)?.stages;
  if (!targetStages || !supportsChapterRuleEvaluation(targetStages)) {
    throw new Error("该规则仅适用于基础设定阶段，不能用章节工作流评测；需要对应阶段的隔离评测器");
  }
  const candidateId = candidate.id;
  const documentId = document.id;

  const run = await createCreativeRun({
    projectId: candidate.projectId,
    mode: "segment-auto",
    objective: `评测规则候选 ${candidate.targetId}@${candidate.proposedVersion}：${scenarioClass}`,
    policy: { maxIterations: 2 },
  }, db);
  const baseline = await enqueueCreativeWork(run.id, {
    kind: "chapter-workflow",
    targetId: documentId,
    instruction: document.blueprint.objective || document.summary || `完成${document.title}`,
    parameters: { evaluationRole: "baseline", scenarioClass, ruleCandidateId: candidateId },
  }, db);
  const changed = await enqueueCreativeWork(run.id, {
    kind: "chapter-workflow",
    targetId: documentId,
    instruction: document.blueprint.objective || document.summary || `完成${document.title}`,
    parameters: { evaluationRole: "candidate", scenarioClass, ruleCandidateId: candidateId },
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
}, dependencies: FoundationRuleEvaluationDependencies = {}, db: NovelDatabase = novelDb): Promise<CraftRuleCandidate> {
  const candidate = await db.craftRuleCandidates.get(input.candidateId);
  if (!candidate || ["promoted", "rolled-back"].includes(candidate.status)) throw new Error("规则候选不存在或已结束");
  if (!FOUNDATION_EVALUATION_TASKS.includes(input.taskKey)) throw new Error("不支持的基础设定评测任务");
  const targetStages = candidate.targetKind === "skill"
    ? (await getEffectiveSkill(candidate.projectId, candidate.targetId, db))?.stages
    : (await listPromptTemplates(candidate.projectId, db)).find((item) => item.templateId === candidate.targetId)?.stages;
  if (!targetStages || !supportsFoundationRuleEvaluation(targetStages)) throw new Error("该规则不适用于基础设定阶段");
  const project = await db.projects.get(candidate.projectId);
  if (!project) throw new Error("项目不存在");
  const task = getGenerationTask(input.taskKey);
  const scenarioClass = input.scenarioClass.trim();
  if (!scenarioClass) throw new Error("创作场景类别不能为空");
  const instruction = input.instruction?.trim() || task.defaultInstruction;
  const [architecture, entities, relations, segments, documents] = await Promise.all([
    db.architectures.where("projectId").equals(candidate.projectId).first(),
    db.entities.where("projectId").equals(candidate.projectId).toArray(),
    db.relations.where("projectId").equals(candidate.projectId).toArray(),
    db.outlineNodes.where("projectId").equals(candidate.projectId).sortBy("order"),
    db.documents.where("projectId").equals(candidate.projectId).sortBy("order"),
  ]);
  const projectContext = JSON.stringify({
    project: { title: project.title, premise: project.premise, genre: project.genre, audience: project.audience, themes: project.themes, sellingPoints: project.sellingPoints, pov: project.pov, tone: project.tone, languageStyle: project.languageStyle, targetWords: project.targetWords },
    architecture: architecture ? { centralQuestion: architecture.centralQuestion, centralConflict: architecture.centralConflict, synopsis: architecture.synopsis, phases: architecture.phases } : null,
    entities: entities.map((entity) => ({ kind: entity.kind, name: entity.name, summary: entity.summary, description: entity.description, character: entity.character })),
    relations: relations.map((relation) => ({ fromEntityId: relation.fromEntityId, toEntityId: relation.toEntityId, relationType: relation.relationType, publicLabel: relation.publicLabel, privateTruth: relation.privateTruth })),
    segments: segments.map((segment) => ({ title: segment.title, summary: segment.summary, phaseId: segment.phaseId })),
    chapters: documents.map((document) => ({ title: document.title, summary: document.summary, status: document.status, objective: document.blueprint.objective })),
  });
  const scenarioProfile = {
    taskKey: input.taskKey,
    taskScope: task.scope,
    architectureState: architecture ? "present" : "absent",
    entityState: countBand(entities.length),
    relationState: countBand(relations.length),
    planningState: countBand(segments.length + documents.length),
  };
  const scenarioSignature = JSON.stringify(scenarioProfile);
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
  const commonParameters = { evaluationKind: "foundation-isolated-v1", scenarioClass, scenarioProfile, scenarioSignature, ruleCandidateId: candidate.id };
  const baseline = await enqueueCreativeWork(run.id, { kind: "generation", taskKey: input.taskKey, targetId, instruction, parameters: { ...commonParameters, evaluationRole: "baseline" } }, db);
  const changed = await enqueueCreativeWork(run.id, { kind: "generation", taskKey: input.taskKey, targetId, instruction, parameters: { ...commonParameters, evaluationRole: "candidate" } }, db);
  const executor = async (work: Parameters<NonNullable<CreativeExecutionDependencies["executor"]>>[0]) => {
    const evaluationRole = work.parameters.evaluationRole === "candidate" ? "candidate" : "baseline";
    const ruleText = evaluationRole === "candidate" ? candidate.afterText : candidate.beforeText;
    const artifact = await generate({ taskKey: input.taskKey, instruction: work.instruction, projectContext, ruleText, model: project.settings.textModel });
    const assessment = await assess({ taskKey: input.taskKey, instruction: work.instruction, projectContext, artifact, model: project.settings.textModel });
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
    verdict: input.verdict,
    summary: input.summary.trim(),
    concerns: [...new Set(input.concerns ?? [])],
    evidenceFingerprint: evidenceFingerprint(candidate),
    reviewedVersion: candidate.proposedVersion,
    reviewedAt: Date.now(),
  }];
  return refreshStatus(candidate, db);
}

export async function promoteCraftRuleCandidate(candidateId: string, db: NovelDatabase = novelDb): Promise<CraftRuleCandidate> {
  return db.transaction("rw", db.skills, db.projectSkills, db.promptTemplateVersions, db.craftRuleCandidates, async () => {
    const candidate = await db.craftRuleCandidates.get(candidateId);
    if (!candidate) throw new Error("规则候选不存在");
    const gate = evaluateCraftRuleGate(candidate);
    if (!gate.ready || candidate.status !== "ready") throw new Error(`规则候选未通过晋升门禁：${gate.reasons.join("；")}`);
    if (candidate.targetKind === "skill") {
      const current = await getEffectiveSkill(candidate.projectId, candidate.targetId, db);
      if (!current || current.version !== candidate.beforeVersion || current.prompt !== candidate.beforeText) throw new Error("Skill 基线已变化，需要重新评测");
      const next: NovelSkillManifest = { ...current, ...recordBase(candidate.projectId), projectId: candidate.projectId, source: "project", readonly: false, version: candidate.proposedVersion, prompt: candidate.afterText };
      await db.skills.add(next);
      await setProjectSkill(candidate.projectId, candidate.targetId, true, next.version, db);
      candidate.promotedRecordId = next.id;
    } else {
      const current = (await listPromptTemplates(candidate.projectId, db)).find((item) => item.templateId === candidate.targetId);
      if (!current || current.version !== candidate.beforeVersion || current.content !== candidate.beforeText) throw new Error("系统 Prompt 基线已变化，需要重新评测");
      const activeProject = await db.promptTemplateVersions.where("[projectId+templateId]").equals([candidate.projectId, candidate.targetId]).and((item) => item.active).toArray();
      await db.promptTemplateVersions.bulkPut(activeProject.map((item) => ({ ...item, active: false, revision: item.revision + 1, updatedAt: Date.now() })));
      const next: PromptTemplateVersion = { ...current, ...recordBase(candidate.projectId), projectId: candidate.projectId, source: "project", version: candidate.proposedVersion, content: candidate.afterText, active: true, previousVersionId: current.id };
      await db.promptTemplateVersions.add(next);
      candidate.promotedRecordId = next.id;
    }
    candidate.status = "promoted";
    candidate.promotedAt = Date.now();
    candidate.updatedAt = candidate.promotedAt;
    candidate.revision += 1;
    await db.craftRuleCandidates.put(candidate);
    return candidate;
  });
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

export async function inspectCraftRuleCandidate(candidateId: string, db: NovelDatabase = novelDb) {
  const candidate = await db.craftRuleCandidates.get(candidateId);
  if (!candidate) throw new Error("规则候选不存在");
  return { candidate, gate: evaluateCraftRuleGate(candidate) };
}
