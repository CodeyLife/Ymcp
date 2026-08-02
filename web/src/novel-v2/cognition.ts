import type {
  Artifact,
  ExecutionBlueprint,
  ContextManifest,
  MemoryBundle,
  MemoryHit,
  MemorySelectionReceipt,
  MemoryProvider,
  NovelIntent,
  PreflightPlan,
  PreflightProjectSnapshot,
  RetrievalFacet,
  SkillBundle,
  SkillProvider,
  BlueprintTask,
} from "./protocol";
import type { ChapterPlanningContext } from "./application/story-arc";
import { canonicalSha256 } from "./canonical-json";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

function authorityRank(authority: MemoryBundle["claims"][number]["authority"]): number {
  return ({ approved: 4, author: 3, derived: 2, candidate: 1, rejected: 0 } as const)[authority] ?? 0;
}

function compareCandidates(left: MemoryHit, right: MemoryHit): number {
  const tokenDifference = estimateTokens(`${left.title}\n${left.content}`) - estimateTokens(`${right.title}\n${right.content}`);
  return authorityRank(right.authority) - authorityRank(left.authority)
    || right.score - left.score
    || right.confidence - left.confidence
    || tokenDifference
    || left.id.localeCompare(right.id);
}

function selectionReceipt(claim: MemoryHit, status: MemorySelectionReceipt["status"], reason: MemorySelectionReceipt["reason"]): MemorySelectionReceipt {
  return {
    claimId: claim.id,
    matchedFacets: matchedFacetsOf(claim),
    score: claim.score,
    authority: claim.authority,
    tokenCost: estimateTokens(`${claim.title}\n${claim.content}`),
    status,
    reason,
    sourceRevisionIds: claim.sourceRevisionIds,
  };
}

export function matchedFacetsOf(claim: MemoryBundle["claims"][number]): string[] {
  return claim.matchedFacets?.length ? claim.matchedFacets : [claim.matchedFacet];
}

export function isMemoryClaimVisibleAtCutoff(claim: MemoryBundle["claims"][number], narrativeCutoff?: number): boolean {
  if (narrativeCutoff === undefined || !claim.narrativeRange) return true;
  const { start, end } = claim.narrativeRange;
  if (start !== undefined && start > narrativeCutoff) return false;
  // A chapter-memory rollup contains prose and outcomes for its entire window,
  // while an ordinary range can mean that one atomic fact remains valid. Fail
  // closed only for the aggregate domain type when its content crosses cutoff.
  return claim.predicate !== "chapter-memory-rollup" || end === undefined || end <= narrativeCutoff;
}

function terms(value: string): string[] {
  return [...new Set(value.split(/[\s,，。；;、/\\|]+/u).map((item) => item.trim()).filter((item) => item.length >= 2))].slice(0, 24);
}

function classify(intent: NovelIntent): PreflightPlan["taskClass"] {
  // 显式 chapter target 优先：target.kind="chapter" + target.id 表示章节生成任务，
  // 无论 objective 文本是否含"架构"/"世界观"等关键词，都应分类为 drafting。
  // 原因：章节 objective 常包含"按 chapter-plan 架构产出""世界观铺陈"等描述性文字，
  // 这些是章节内容说明，不是任务类型声明。任务类型由 target.kind 决定。
  if (intent.target?.kind === "chapter" && intent.target?.id) {
    return "drafting";
  }
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
  // P1-D2: POV 视角角色档案查询关键词
  // 设计依据：AGENTS.md「root-cause analysis」——entity/relation facet 原先只用
  // intent.objective 关键词做向量召回，无法精确命中 POV 角色的 entities/relations 记录。
  // POV 角色档案（voiceAnchor、关系网）是 drafting/revision 的核心上下文，
  // 必须用 povCharacterId 显式召回，避免被 dense embedding 的语义漂移稀释。
  const povCharacterId = snapshot.povCharacterId;
  const entityQuery = povCharacterId ? `${query} 视角人物 ${povCharacterId} 角色档案 声部锚点 动机` : query;
  const factQuery = taskClass === "drafting" || taskClass === "revision" || taskClass === "review"
    ? `${query} 项目规划 章节计划 世界观设定 人物档案 主线剧情`
    : query;
  // facet required 策略：
  // - fact：drafting/revision/planning/review 都必填（fact 是跨章节一致性的最小单元）
  // - entity/thread/foreshadowing：drafting 时 required=false。
  //   原因：早期章节（前 5 章）的 entities/threads/foreshadowings 表可能尚未填充——
  //   fact-extraction 不一定每次都产出 narrativeElements，character enrichment 逐步建立 entities。
  //   强制 required 会阻塞早期章节生成。仍尝试召回（required=false），有数据就用，没有就不阻塞。
  // - chapter-memory/relation：见下方单独处理
  const facets: RetrievalFacet[] = [
    { kind: "fact", query: factQuery, required: taskClass !== "foundation", narrativeCutoff: cutoff },
    { kind: "entity", query: entityQuery, required: false, narrativeCutoff: cutoff, ...(povCharacterId ? { knowledgeCharacterId: povCharacterId } : {}) },
    { kind: "thread", query: `${query} 主线 支线 剧情线 冲突`, required: false, narrativeCutoff: cutoff },
    { kind: "foreshadowing", query: `${query} 伏笔 承诺 线索 兑现`, required: false, narrativeCutoff: cutoff },
    { kind: "style", query: "作者风格 叙事声音 语言约束", required: false },
    { kind: "author-preference", query: "作者偏好 禁区 创作意图", required: false },
  ];
  // chapter-memory facet：drafting/revision 任务必填（非首章），planning/review 任务可选
  // 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约——
  // chapter memory 是跨章节一致性的核心，drafting 时必须召回前章 summary；
  // 首章（targetDocumentOrder <= 1）无前章，required=false 但仍尝试召回（可能为空）；
  // foundation 任务（世界观建立）也不强制要求 chapter memory。
  const hasPriorChapters = snapshot.targetDocumentOrder === undefined ? false : snapshot.targetDocumentOrder > 1;
  if (taskClass === "drafting" || taskClass === "revision") {
    facets.push({ kind: "chapter-memory", query: "前章摘要 关键事件 角色状态 未解线索", required: hasPriorChapters, narrativeCutoff: cutoff });
  } else if (taskClass === "planning" || taskClass === "review") {
    facets.push({ kind: "chapter-memory", query: "前章摘要 关键事件 角色状态 未解线索", required: false, narrativeCutoff: cutoff });
  }
  // P1-D2: relation facet 用 povCharacterId 召回视角角色的关系网（声部/动机/关系增量）
  // required=false：早期章节（前 5 章）可能尚未建立 relation 记录，强制 required 会阻塞 drafting。
  // 角色关系网在 character enrichment 阶段逐步建立，前几章缺失是正常状态，不应阻塞章节生成。
  if (povCharacterId) facets.push({ kind: "relation", query: `${query} 视角人物 ${povCharacterId} 关系网`, required: false, narrativeCutoff: cutoff, knowledgeCharacterId: povCharacterId });
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
    replacementRevisionId: snapshot.targetDocumentStatus === "final" ? snapshot.targetDocumentRevisionId : undefined,
    narrativeCutoff: snapshot.targetDocumentOrder === undefined ? undefined : snapshot.targetDocumentOrder - 1,
    povCharacterId: snapshot.povCharacterId,
    facets,
    risk: taskClass === "drafting" || taskClass === "revision" ? "high" : taskClass === "review" ? "medium" : "low",
    requiresIndependentReview: taskClass === "drafting" || taskClass === "revision" || taskClass === "planning",
    createdAt: now,
    sourceFingerprint: canonicalSha256({ intent, snapshot }),
  };
}

/**
 * Phase 2.3 动态上下文预算：根据 taskClass + totalChapters 计算合理的 token budget。
 *
 * 设计依据：Phase 2.3 计划 + AGENTS.md「root-cause analysis」——
 * 原 24K 固定预算对百万字长篇裁剪过激，导致前章事实/伏笔/角色状态被丢弃。
 *
 * 决策规则（覆盖更广的失败类，非针对单一章节调参）：
 * - foundation/planning：24K（默认，规划任务不需要太多上下文）
 * - drafting/revision 且 totalChapters < 50：32K（短篇，正常预算）
 * - drafting/revision 且 totalChapters >= 50：48K（中篇，需要更多前章记忆）
 * - drafting/revision 且 totalChapters >= 200：64K（长篇后期，需 chapter memory + 伏笔 + 角色状态全量）
 *
 * 硬上限：不超过 64K（避免超出模型上下文窗口 60% 的安全边界）。
 * 调用方可在 model-routing profile 的 contextLimit 中配置更小的上限。
 */
export function computeTokenBudget(taskClass: PreflightPlan["taskClass"], totalChapters?: number): number {
  const DEFAULT_BUDGET = 24_000;
  const HARD_LIMIT = 64_000;
  if (taskClass !== "drafting" && taskClass !== "revision") return DEFAULT_BUDGET;
  if (totalChapters === undefined) return DEFAULT_BUDGET;
  if (totalChapters >= 200) return HARD_LIMIT;
  if (totalChapters >= 50) return 48_000;
  return 32_000;
}

export async function buildMemoryBundle(plan: PreflightPlan, input: { projectId: string; provider: MemoryProvider; tokenBudget?: number; pinnedClaims?: MemoryHit[] }, now = Date.now()): Promise<MemoryBundle> {
  const retrieved = await input.provider.search({ projectId: input.projectId, facets: plan.facets, narrativeCutoff: plan.narrativeCutoff, povCharacterId: plan.povCharacterId });
  const pinnedIds = new Set((input.pinnedClaims ?? []).map((claim) => claim.id));
  const claims = [...(input.pinnedClaims ?? []), ...retrieved];
  const tokenBudget = input.tokenBudget ?? 24_000;
  const receipts: MemorySelectionReceipt[] = [];
  const visible = claims.filter((claim) => {
    if (claim.lifecycleStatus === "staged") {
      receipts.push(selectionReceipt(claim, "excluded", "inactive"));
      return false;
    }
    const allowed = isMemoryClaimVisibleAtCutoff(claim, plan.narrativeCutoff);
    if (!allowed) receipts.push(selectionReceipt(claim, "excluded", "future-cutoff"));
    return allowed;
  });
  const deduplicated = new Map<string, MemoryHit>();
  for (const claim of visible) {
    const semanticKey = claim.identityHash && (claim.valueHash ?? claim.contentHash)
      ? `value:${claim.identityHash}:${claim.valueHash ?? claim.contentHash}`
      : `id:${claim.id}`;
    const existing = deduplicated.get(semanticKey);
    if (!existing) {
      deduplicated.set(semanticKey, claim);
      continue;
    }
    receipts.push(selectionReceipt(claim, "excluded", claim.id === existing.id ? "duplicate" : "merged-source"));
    const preferred = pinnedIds.has(existing.id)
      ? existing
      : pinnedIds.has(claim.id)
        ? claim
        : [existing, claim].sort(compareCandidates)[0];
    deduplicated.set(semanticKey, {
      ...preferred,
      matchedFacets: [...new Set([...matchedFacetsOf(existing), ...matchedFacetsOf(claim)])],
      sourceRevisionIds: [...new Set([...existing.sourceRevisionIds, ...claim.sourceRevisionIds])],
    });
  }
  const ordered = [...deduplicated.values()].sort(compareCandidates);
  let spent = 0;
  const selected = new Map<string, { claim: MemoryHit; reason: MemorySelectionReceipt["reason"] }>();
  const select = (claim: MemoryHit, reason: MemorySelectionReceipt["reason"]): boolean => {
    if (selected.has(claim.id)) return true;
    const cost = estimateTokens(`${claim.title}\n${claim.content}`);
    if (spent + cost > tokenBudget) return false;
    spent += cost;
    selected.set(claim.id, { claim, reason });
    return true;
  };
  const pinned = ordered.filter((candidate) => pinnedIds.has(candidate.id));
  for (const claim of pinned) {
    if (!select(claim, "pinned-narrative")) {
      const cost = estimateTokens(`${claim.title}\n${claim.content}`);
      throw new Error(`冻结叙事上下文超过记忆预算：${claim.id} 需要约 ${cost} tokens，已使用 ${spent}/${tokenBudget}。请提高预算或压缩叙事状态账本，不能静默丢弃 pinned 内容。`);
    }
  }
  const required = new Set(plan.facets.filter((facet) => facet.required).map((facet) => facet.kind));
  for (const facet of required) {
    if ([...selected.values()].some(({ claim }) => matchedFacetsOf(claim).includes(facet))) continue;
    for (const claim of ordered.filter((candidate) => matchedFacetsOf(candidate).includes(facet))) {
      if (select(claim, "required-facet")) break;
    }
  }
  for (const claim of ordered) select(claim, "ranked-fill");
  const budgeted = [...selected.values()].map(({ claim }) => claim);
  for (const { claim, reason } of selected.values()) receipts.push(selectionReceipt(claim, "included", reason));
  for (const claim of ordered.filter((candidate) => !selected.has(candidate.id))) receipts.push(selectionReceipt(claim, "excluded", "budget"));
  const found = new Set(budgeted.flatMap(matchedFacetsOf));
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
    selectionReceipts: receipts,
    fingerprint: "",
    createdAt: now,
  } satisfies Omit<MemoryBundle, "fingerprint"> & { fingerprint: string };
  bundle.fingerprint = canonicalSha256({ ...bundle, fingerprint: undefined, createdAt: undefined });
  return bundle;
}

export function buildContextManifest(plan: PreflightPlan, memory: MemoryBundle, input: { retrievalRunId?: string } = {}, now = Date.now()): ContextManifest {
  if (memory.preflightId !== plan.id) throw new Error("记忆包不属于当前 Preflight");
  const receipts = memory.selectionReceipts ?? memory.claims.map((claim) => selectionReceipt(claim, "included", "ranked-fill"));
  const includedClaimIds = [...new Set(receipts.filter((receipt) => receipt.status === "included").map((receipt) => receipt.claimId))];
  const includedSet = new Set(includedClaimIds);
  const excludedClaimIds = [...new Set(receipts.filter((receipt) => receipt.status === "excluded" && !includedSet.has(receipt.claimId)).map((receipt) => receipt.claimId))];
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
    selectionReceipts: receipts,
    truncationReason: receipts.some((receipt) => receipt.reason === "budget") ? "budget" : receipts.some((receipt) => receipt.reason === "future-cutoff") ? "future-cutoff" : "none",
    fingerprint: "",
    createdAt: now,
  };
  manifest.fingerprint = canonicalSha256({ ...manifest, fingerprint: undefined, createdAt: undefined });
  return manifest;
}

export async function resolveSkillBundleForTask(input: {
  projectId: string;
  provider: SkillProvider;
  taskClasses: readonly string[];
  requestedCapabilities?: string[];
  genre?: string;
  preflightId?: string;
  memory?: MemoryBundle;
}, now = Date.now()): Promise<SkillBundle> {
  const available = (await input.provider.list(input.projectId)).filter((skill) => skill.enabled
    && input.taskClasses.some((taskClass) => skill.applicableTasks.includes(taskClass as never)));
  const memory = input.memory;
  const capabilities = new Set(input.requestedCapabilities ?? []);
  // qualityGates describe how an already-active skill is verified; they are not
  // activation signals. Treating them as such injects every quality skill into
  // every chapter, producing duplicated and sometimes contradictory commands.
  // A skill activates through an explicitly requested capability, required
  // memory that is actually present, or by declaring neither (an intentional
  // task-applicable baseline skill).
  const selected = available.filter((skill) => skill.capabilities.some((capability) => capabilities.has(capability))
    || skill.requiredMemoryKinds.some((kind) => memory?.claims.some((claim) => claim.kind === kind))
    || (skill.capabilities.length === 0 && skill.requiredMemoryKinds.length === 0));
  // Phase 3.3: 题材通用差异化——优先选择 applicableGenres 为空（题材无关）或包含当前 genre 的 skill
  // 设计依据：AGENTS.md「reusable contracts over case-specific rules」——
  // 不内置金手指/系统流特化枚举，只提供 genre 字符串匹配机制。
  // genre 匹配是软偏好：若无匹配 genre 的 skill，仍回退到题材无关的 skill。
  const genreMatched = selected.filter((skill) => !skill.applicableGenres?.length || (input.genre ? skill.applicableGenres.includes(input.genre) : true));
  const chosen = genreMatched.length ? genreMatched : selected;
  const ids = new Set(chosen.map((skill) => skill.skillId));
  const conflicts = chosen.flatMap((skill) => skill.conflicts.filter((id) => ids.has(id)).map((id) => ({ skillId: skill.skillId, conflictsWith: id })));
  const preflightId = input.preflightId ?? `stage:${input.taskClasses[0] ?? "unknown"}`;
  const bundle: SkillBundle = { id: `skills:${preflightId}`, projectId: input.projectId, preflightId, skills: chosen.map((skill) => ({ skillId: skill.skillId, version: skill.version, capabilities: skill.capabilities, applicableTasks: skill.applicableTasks, requiredMemoryKinds: skill.requiredMemoryKinds, qualityGates: skill.qualityGates, promptSections: skill.promptSections })), conflicts, missingCapabilities: [...capabilities].filter((capability) => !chosen.some((skill) => skill.capabilities.includes(capability))), fingerprint: "", createdAt: now };
  bundle.fingerprint = canonicalSha256({ ...bundle, fingerprint: undefined, createdAt: undefined });
  return bundle;
}

export async function resolveSkillBundle(plan: PreflightPlan, memory: MemoryBundle, input: { projectId: string; provider: SkillProvider; requestedCapabilities?: string[]; genre?: string }, now = Date.now()): Promise<SkillBundle> {
  return resolveSkillBundleForTask({ ...input, taskClasses: [plan.taskClass], preflightId: plan.id, memory }, now);
}

export function compileExecutionBlueprint(intent: NovelIntent, plan: PreflightPlan, memory: MemoryBundle, skills: SkillBundle, snapshot: PreflightProjectSnapshot, context?: ContextManifest, foundationArtifacts?: Artifact[], planningContext?: ChapterPlanningContext, now = Date.now()): ExecutionBlueprint {
  if (memory.preflightId !== plan.id || skills.preflightId !== plan.id) throw new Error("认知快照不属于当前 Preflight");
  if (context && (context.preflightId !== plan.id || context.memoryBundleId !== memory.id)) throw new Error("上下文清单不属于当前 Preflight");
  const availableFacets = new Set(memory.claims.flatMap(matchedFacetsOf));
  const missingFacets = [...new Set(plan.facets.map((facet) => facet.kind).filter((kind) => !availableFacets.has(kind)))];
  const hasPriorChapter = (snapshot.targetDocumentOrder ?? 0) > 1;
  // P0: Memory gate degradation — previously, missing "fact"/"chapter-memory" facets
  // caused a hard throw that blocked ALL chapter generation. But the embedding service
  // can be temporarily unavailable (observed: HTTP 502), leaving Qdrant empty even when
  // PostgreSQL has claims. A hard throw prevents any progress; instead, degrade to
  // manual-review so the workflow can proceed and the human can assess quality.
  // Root cause: AGENTS.md「root-cause analysis」— the throw was a downstream manifestation
  // of an infra-level embedding failure, not a genuine "no facts exist" condition.
  const criticalMissingFacets = plan.taskClass === "drafting" || plan.taskClass === "revision"
    ? missingFacets.filter((kind) => kind === "fact" || (kind === "chapter-memory" && hasPriorChapter))
    : [];
  if (criticalMissingFacets.length) {
    console.warn(`[memory-gate] 关键记忆维度缺失（降级为 manual-review，不阻断生成）：${criticalMissingFacets.join("、")}。可能原因：embedding 服务不可用导致 Qdrant 索引为空。`);
  }
  const manualReviewFacets = plan.taskClass === "revision"
    ? missingFacets.filter((kind) => kind === "entity" || kind === "thread" || kind === "foreshadowing" || criticalMissingFacets.includes(kind))
    : plan.taskClass === "review"
      ? missingFacets.filter((kind) => kind === "fact" || kind === "entity" || kind === "thread" || kind === "foreshadowing" || kind === "chapter-memory")
      : plan.taskClass === "drafting"
        ? criticalMissingFacets
        : [];
  if (skills.conflicts.length) throw new Error("Skill 冲突，不能生成执行蓝图");
  const retrieve: BlueprintTask = { id: `${plan.id}:retrieve`, kind: "retrieve", role: "memory-curator", dependsOn: [], readSet: memory.sourceRevisionIds, writeSet: [], queue: "memory", independentReviewRequired: false };
  const draft: BlueprintTask = { id: `${plan.id}:draft`, kind: plan.taskClass === "review" ? "review" : plan.taskClass === "revision" ? "revise" : "draft", role: plan.taskClass === "review" ? "reader-reviewer" : "writer", dependsOn: [retrieve.id], readSet: memory.sourceRevisionIds, writeSet: intent.target?.id ? [intent.target.id] : [], queue: "writer", independentReviewRequired: plan.requiresIndependentReview };
  const review: BlueprintTask = { id: `${plan.id}:review`, kind: "review", role: "quality-editor", dependsOn: [draft.id], readSet: [draft.id, ...memory.sourceRevisionIds], writeSet: [], queue: "reviewer", independentReviewRequired: true };
  const commit: BlueprintTask = { id: `${plan.id}:commit`, kind: "memory-update", role: "fact-extractor", dependsOn: [review.id], readSet: [draft.id, review.id], writeSet: intent.target?.id ? [intent.target.id] : [], queue: "memory", independentReviewRequired: false };
  // 全书规划 artifact 引用:仅当调用方传入 foundationArtifacts 时填充。
  // 设计依据:AGENTS.md「root-cause analysis」——章节生成必须基于全书规划,
  // blueprint 持有 foundationArtifactIds 让 draft activity 知道应注入哪些规划产出,
  // 同时供审计/learning 闭环感知上下文质量。
  const foundationArtifactIds = foundationArtifacts?.length ? foundationArtifacts.map((artifact) => artifact.id) : undefined;
  const blueprint: ExecutionBlueprint = { id: `blueprint:${intent.id}`, projectId: intent.projectId, intentId: intent.id, preflightId: plan.id, memoryBundleId: memory.id, skillBundleId: skills.id, contextManifestId: context?.id, baseRevision: snapshot.currentRevision, tasks: [retrieve, draft, review, commit], commitPolicy: plan.requiresIndependentReview ? "dual-gate" : "human-only", factApprovalMode: intent.factApprovalMode ?? "auto", budget: { maxInputTokens: memory.tokenBudget, maxOutputTokens: plan.taskClass === "drafting" || plan.taskClass === "revision" ? 16_000 : 8_000 }, memoryGate: { status: manualReviewFacets.length ? "manual-review" : "passed", missingFacets, manualReviewFacets }, foundationArtifactIds, arcId: planningContext?.arcId, chapterBlueprintId: planningContext?.chapterBlueprintId, planningContextFingerprint: planningContext?.fingerprint, fingerprint: "", createdAt: now };
  blueprint.fingerprint = canonicalSha256({ ...blueprint, fingerprint: undefined, createdAt: undefined });
  return blueprint;
}
