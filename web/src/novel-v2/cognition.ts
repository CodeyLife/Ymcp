import type {
  ExecutionBlueprint,
  ContextManifest,
  MemoryBundle,
  MemoryProvider,
  NovelIntent,
  PreflightPlan,
  PreflightProjectSnapshot,
  RetrievalFacet,
  SkillBundle,
  SkillProvider,
  BlueprintTask,
} from "./protocol";

function hash(value: unknown): string {
  const text = JSON.stringify(value, Object.keys(value as object).sort());
  let result = 2166136261;
  for (let index = 0; index < text.length; index += 1) result = Math.imul(result ^ text.charCodeAt(index), 16777619);
  return (result >>> 0).toString(16).padStart(8, "0");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

function authorityRank(authority: MemoryBundle["claims"][number]["authority"]): number {
  return ({ approved: 4, author: 3, derived: 2, candidate: 1 } as const)[authority] ?? 0;
}

function terms(value: string): string[] {
  return [...new Set(value.split(/[\s,，。；;、/\\|]+/u).map((item) => item.trim()).filter((item) => item.length >= 2))].slice(0, 24);
}

function classify(intent: NovelIntent): PreflightPlan["taskClass"] {
  const text = `${intent.objective} ${(intent.requestedStage ?? "")}`;
  if (/审核|审校|检查|质量/u.test(text)) return "review";
  if (/修订|重写|修改|润色/u.test(text)) return "revision";
  if (/记忆|索引|摘要|事实提取/u.test(text)) return "memory-maintenance";
  if (/架构|世界观|角色|关系|大纲|规划/u.test(text)) return "planning";
  return intent.requestedStage === "foundation" ? "foundation" : "drafting";
}

function facetsFor(intent: NovelIntent, snapshot: PreflightProjectSnapshot, taskClass: PreflightPlan["taskClass"]): RetrievalFacet[] {
  const query = terms(intent.objective).join(" ") || intent.objective.trim();
  const cutoff = snapshot.targetDocumentOrder === undefined ? undefined : snapshot.targetDocumentOrder - 1;
  const facets: RetrievalFacet[] = [
    { kind: "fact", query, required: taskClass !== "foundation", narrativeCutoff: cutoff },
    { kind: "entity", query, required: taskClass === "drafting" || taskClass === "revision", narrativeCutoff: cutoff },
    { kind: "thread", query, required: taskClass === "planning" || taskClass === "drafting", narrativeCutoff: cutoff },
    { kind: "foreshadowing", query, required: taskClass === "planning" || taskClass === "drafting", narrativeCutoff: cutoff },
    { kind: "style", query: "作者风格 叙事声音 语言约束", required: false },
    { kind: "author-preference", query: "作者偏好 禁区 创作意图", required: false },
  ];
  if (snapshot.povCharacterId) facets.push({ kind: "relation", query, required: true, narrativeCutoff: cutoff, knowledgeCharacterId: snapshot.povCharacterId });
  return facets;
}

export function createPreflightPlan(intent: NovelIntent, snapshot: PreflightProjectSnapshot, now = Date.now()): PreflightPlan {
  if (intent.projectId !== snapshot.projectId) throw new Error("Intent 与项目快照不匹配");
  if (!intent.objective.trim()) throw new Error("创作目标不能为空");
  const taskClass = classify(intent);
  const facets = facetsFor(intent, snapshot, taskClass);
  return {
    id: `preflight:${intent.id}`,
    intentId: intent.id,
    projectId: intent.projectId,
    taskClass,
    stage: intent.requestedStage ?? (taskClass === "review" ? "review" : taskClass === "revision" ? "revision" : taskClass === "drafting" ? "drafting" : "planning"),
    targetDocumentId: intent.target?.id ?? snapshot.targetDocumentId,
    narrativeCutoff: snapshot.targetDocumentOrder === undefined ? undefined : snapshot.targetDocumentOrder - 1,
    povCharacterId: snapshot.povCharacterId,
    facets,
    risk: taskClass === "drafting" || taskClass === "revision" ? "high" : taskClass === "review" ? "medium" : "low",
    requiresIndependentReview: taskClass === "drafting" || taskClass === "revision" || taskClass === "planning",
    createdAt: now,
    sourceFingerprint: hash({ intent, snapshot }),
  };
}

export async function buildMemoryBundle(plan: PreflightPlan, input: { projectId: string; provider: MemoryProvider; tokenBudget?: number }, now = Date.now()): Promise<MemoryBundle> {
  const claims = await input.provider.search({ projectId: input.projectId, facets: plan.facets, narrativeCutoff: plan.narrativeCutoff, povCharacterId: plan.povCharacterId });
  const tokenBudget = input.tokenBudget ?? 24_000;
  const visible = claims.filter((claim) => claim.narrativeRange?.start === undefined || plan.narrativeCutoff === undefined || claim.narrativeRange.start <= plan.narrativeCutoff);
  const ordered = [...visible].sort((left, right) => authorityRank(right.authority) - authorityRank(left.authority) || right.score - left.score || right.confidence - left.confidence);
  let spent = 0;
  const budgeted = ordered.filter((claim) => {
    const cost = estimateTokens(`${claim.title}\n${claim.content}`);
    if (spent + cost > tokenBudget) return false;
    spent += cost;
    return true;
  });
  const required = new Set(plan.facets.filter((facet) => facet.required).map((facet) => facet.kind));
  const found = new Set(budgeted.map((claim) => claim.matchedFacet));
  const missingFacets = [...required].filter((facet) => !found.has(facet));
  const sourceRevisionIds = [...new Set(budgeted.flatMap((claim) => claim.sourceRevisionIds))];
  const conflicts = budgeted.flatMap((claim) => claim.supersedes.map((superseded) => ({ claimIds: [claim.id, superseded], subjectRefs: claim.subjectRefs, reason: "当前 claim 声明覆盖了旧 claim，需在提交前确认", blocking: false }))).filter((conflict, index, all) => index === all.findIndex((candidate) => candidate.claimIds.join(":") === conflict.claimIds.join(":")));
  const bundle = {
    id: `memory:${plan.id}`,
    projectId: input.projectId,
    preflightId: plan.id,
    claims: budgeted,
    conflicts,
    missingFacets,
    tokenBudget,
    sourceRevisionIds,
    narrativeCutoff: plan.narrativeCutoff,
    fingerprint: "",
    createdAt: now,
  } satisfies Omit<MemoryBundle, "fingerprint"> & { fingerprint: string };
  bundle.fingerprint = hash({ ...bundle, fingerprint: undefined });
  return bundle;
}

export function buildContextManifest(plan: PreflightPlan, memory: MemoryBundle, input: { retrievalRunId?: string; allClaimIds?: string[] } = {}, now = Date.now()): ContextManifest {
  if (memory.preflightId !== plan.id) throw new Error("记忆包不属于当前 Preflight");
  const includedClaimIds = memory.claims.map((claim) => claim.id);
  const excludedClaimIds = (input.allClaimIds ?? []).filter((id) => !includedClaimIds.includes(id));
  const estimatedTokens = memory.claims.reduce((sum, claim) => sum + estimateTokens(`${claim.title}\n${claim.content}`), 0);
  const manifest: ContextManifest = {
    id: `context:${plan.id}`,
    projectId: plan.projectId,
    preflightId: plan.id,
    memoryBundleId: memory.id,
    retrievalRunId: input.retrievalRunId,
    sourceRevisionIds: memory.sourceRevisionIds,
    includedClaimIds,
    excludedClaimIds,
    narrativeCutoff: plan.narrativeCutoff,
    tokenBudget: memory.tokenBudget,
    estimatedTokens,
    truncationReason: excludedClaimIds.length ? "budget" : memory.missingFacets.length ? "future-cutoff" : "none",
    fingerprint: "",
    createdAt: now,
  };
  manifest.fingerprint = hash({ ...manifest, fingerprint: undefined });
  return manifest;
}

export async function resolveSkillBundle(plan: PreflightPlan, memory: MemoryBundle, input: { projectId: string; provider: SkillProvider; requestedCapabilities?: string[] }, now = Date.now()): Promise<SkillBundle> {
  const available = (await input.provider.list(input.projectId)).filter((skill) => skill.enabled && skill.applicableTasks.includes(plan.taskClass));
  const capabilities = new Set(input.requestedCapabilities ?? []);
  const selected = available.filter((skill) => skill.capabilities.some((capability) => capabilities.has(capability)) || skill.requiredMemoryKinds.some((kind) => memory.claims.some((claim) => claim.kind === kind)) || skill.qualityGates.length > 0);
  const chosen = selected.length ? selected : available.slice(0, 3);
  const ids = new Set(chosen.map((skill) => skill.skillId));
  const conflicts = chosen.flatMap((skill) => skill.conflicts.filter((id) => ids.has(id)).map((id) => ({ skillId: skill.skillId, conflictsWith: id })));
  const bundle: SkillBundle = { id: `skills:${plan.id}`, projectId: input.projectId, preflightId: plan.id, skills: chosen.map((skill) => ({ skillId: skill.skillId, version: skill.version, qualityGates: skill.qualityGates })), conflicts, missingCapabilities: [...capabilities].filter((capability) => !chosen.some((skill) => skill.capabilities.includes(capability))), fingerprint: "", createdAt: now };
  bundle.fingerprint = hash({ ...bundle, fingerprint: undefined });
  return bundle;
}

export function compileExecutionBlueprint(intent: NovelIntent, plan: PreflightPlan, memory: MemoryBundle, skills: SkillBundle, snapshot: PreflightProjectSnapshot, context?: ContextManifest, now = Date.now()): ExecutionBlueprint {
  if (memory.preflightId !== plan.id || skills.preflightId !== plan.id) throw new Error("认知快照不属于当前 Preflight");
  if (context && (context.preflightId !== plan.id || context.memoryBundleId !== memory.id)) throw new Error("上下文清单不属于当前 Preflight");
  if (memory.missingFacets.length && plan.risk === "high") throw new Error(`高风险任务缺少记忆维度：${memory.missingFacets.join("、")}`);
  if (skills.conflicts.length) throw new Error("Skill 冲突，不能生成执行蓝图");
  const retrieve: BlueprintTask = { id: `${plan.id}:retrieve`, kind: "retrieve", role: "memory-curator", dependsOn: [], readSet: memory.sourceRevisionIds, writeSet: [], queue: "memory", independentReviewRequired: false };
  const draft: BlueprintTask = { id: `${plan.id}:draft`, kind: plan.taskClass === "review" ? "review" : plan.taskClass === "revision" ? "revise" : "draft", role: plan.taskClass === "review" ? "reader-reviewer" : "writer", dependsOn: [retrieve.id], readSet: memory.sourceRevisionIds, writeSet: intent.target?.id ? [intent.target.id] : [], queue: "writer", independentReviewRequired: plan.requiresIndependentReview };
  const review: BlueprintTask = { id: `${plan.id}:review`, kind: "review", role: "quality-editor", dependsOn: [draft.id], readSet: [draft.id, ...memory.sourceRevisionIds], writeSet: [], queue: "reviewer", independentReviewRequired: true };
  const commit: BlueprintTask = { id: `${plan.id}:commit`, kind: "memory-update", role: "fact-extractor", dependsOn: [review.id], readSet: [draft.id, review.id], writeSet: intent.target?.id ? [intent.target.id] : [], queue: "memory", independentReviewRequired: false };
  const blueprint: ExecutionBlueprint = { id: `blueprint:${intent.id}`, projectId: intent.projectId, intentId: intent.id, preflightId: plan.id, memoryBundleId: memory.id, skillBundleId: skills.id, contextManifestId: context?.id, baseRevision: snapshot.currentRevision, tasks: [retrieve, draft, review, commit], commitPolicy: plan.requiresIndependentReview ? "dual-gate" : "human-only", budget: { maxInputTokens: memory.tokenBudget, maxOutputTokens: plan.taskClass === "drafting" || plan.taskClass === "revision" ? 16_000 : 8_000 }, fingerprint: "", createdAt: now };
  blueprint.fingerprint = hash({ ...blueprint, fingerprint: undefined });
  return blueprint;
}
