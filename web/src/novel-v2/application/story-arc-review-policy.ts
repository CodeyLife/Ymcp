import type { StoryArcBundle, StoryArcRebaseTarget } from "./story-arc";

/**
 * 逐章审核维度清单。
 *
 * longform-function 维度（2026-08-02 调整）：
 * 设计依据：长篇章节不是逐章交付新信息或新压力的流水线；余波、等待、恢复、
 * 气氛、相处、误判和重复仪式都可以是合法章节功能。逐章审核只判断该章
 * narrativeFunction / readerExperience / scenes 是否在当前故事弧位置成立，不能要求
 * 每章都推进主线、引入新压力或产生可量化“新贡献”。重复退化、压力停滞和主题词
 * 复用放到整弧窗口维度判断。
 */
export const CHAPTER_PLAN_CHECK_DIMENSIONS = ["alignment", "choice-cost", "relationship-stage", "earned-outcome", "function-fit", "theme-restraint", "worldbuilding-fit", "ensemble-agency", "romance-arc", "humor-fit", "longform-function"] as const;
export type ChapterPlanCheckDimension = (typeof CHAPTER_PLAN_CHECK_DIMENSIONS)[number];

/**
 * 整弧审核维度清单。
 *
 * motif-integration 维度（2026-08-02 新增）：
 * 设计依据：实际项目中出现的退化不是某个标题或题材词的问题，而是故事弧把
 * 核心卖点/职业/主题隐喻反复贴到标题、场景名和行动描述表层，导致章节像概念
 * 展示而非可追读事件。该维度检查母题是否被转写为具体事件、感官压力、人物选择
 * 和递进意象，并允许偶发点题；只有连续标签化、同义反复或删除母题词后场景失去
 * 可读事件时才判失败。通用维度，不识别特定题材/角色/词语。
 *
 * longform-hierarchy 维度（2026-08-02 新增）：
 * 检查全书命题、卷级矛盾、故事弧、批次和章节之间是否分层清晰。局部蓝图
 * 只能承担当前层级的功能，不能把卷级目标压缩成一批章节，也不能把作者侧
 * 分析词当成正文世界规则。
 *
 * window-variation 维度（2026-08-02 新增）：
 * 检查连续章节窗口是否形成有意义的节奏变化。允许重复场景、情绪或动作，
 * 但重复应改变读者理解、人物关系、社会质地、信息角度、情绪重量或行动代价；
 * 若只是同一关键词、同一场景压力和同一反应逻辑的机械复用，则进入修订。
 *
 * pressure-trajectory 维度（2026-08-01 调整）：
 * 检查弧/批次窗口内是否存在可辨识的外部压力或张力形态变化。该维度不再
 * 要求每章都新增或加剧压力；安静章可以通过停顿、余波和等待成立。
 */
export const ARC_PLAN_CHECK_DIMENSIONS = ["function-rhythm", "theme-distribution", "motif-evolution", "motif-integration", "longform-hierarchy", "window-variation", "pressure-trajectory"] as const;
export type ArcPlanCheckDimension = (typeof ARC_PLAN_CHECK_DIMENSIONS)[number];

export interface ChapterPlanValidationCheck {
  chapterIndex: number;
  dimension: ChapterPlanCheckDimension;
  verdict: "passed" | "revise" | "blocked";
  evidence: string;
  reason: string;
}

export interface ChapterPlanValidationReport {
  passed: boolean;
  checks: ChapterPlanValidationCheck[];
  missingChecks: Array<{ chapterIndex: number; dimension: ChapterPlanCheckDimension }>;
  blockingChecks: ChapterPlanValidationCheck[];
  arcChecks: ArcPlanValidationCheck[];
  missingArcChecks: ArcPlanCheckDimension[];
  blockingArcChecks: ArcPlanValidationCheck[];
}

export interface ArcPlanValidationCheck {
  dimension: ArcPlanCheckDimension;
  verdict: "passed" | "revise" | "blocked";
  evidence: string;
  reason: string;
}

export interface StoryArcReviewOutput {
  verdict: "passed" | "revise" | "blocked";
  summary: string;
  issues: Array<{ severity: "blocker" | "major" | "warning"; title: string; evidence: string; suggestion: string }>;
  chapterChecks: ChapterPlanValidationCheck[];
  arcChecks: ArcPlanValidationCheck[];
  authorityChecks: Array<{
    chapterIndex: number;
    verdict: "passed" | "revise" | "blocked";
    unresolvedAtClose: string[];
    checkedPaths: string[];
    candidateClaims: string[];
    frozenEvidence: string[];
    certaintyUpgrades: Array<{ candidateClaim: string; frozenBoundary: string; reason: string }>;
    reason: string;
  }>;
}

export function storyArcAuthorityPaths(chapter: StoryArcBundle["chapters"][number]): string[] {
  const paths = ["summary", "stateTransition.after"];
  chapter.scenes.forEach((scene, sceneIndex) => {
    paths.push(`scenes[${sceneIndex}].turn`, `scenes[${sceneIndex}].outcome`);
    scene.participantStakes?.forEach((stake, stakeIndex) => {
      if (!stake.knowledgeBasis) return;
      (["want", "leverage", "withholding", "failureCost"] as const).forEach((field) => {
        if (stake.knowledgeBasis?.[field] === "observable-inference") paths.push(`scenes[${sceneIndex}].participantStakes[${stakeIndex}].${field}`);
      });
    });
  });
  return paths;
}

export function storyArcAuthorityClaims(chapter: StoryArcBundle["chapters"][number]): string[] {
  const claims = [chapter.summary, chapter.stateTransition?.after ?? ""];
  chapter.scenes.forEach((scene) => {
    claims.push(scene.turn ?? "", scene.outcome ?? "");
    scene.participantStakes?.forEach((stake) => {
      if (!stake.knowledgeBasis) return;
      (["want", "leverage", "withholding", "failureCost"] as const).forEach((field) => {
        if (stake.knowledgeBasis?.[field] === "observable-inference") claims.push(stake[field]);
      });
    });
  });
  return claims;
}

function stablePlannedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stablePlannedValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => key !== "narrativeScale" && !(key === "unresolvedAtClose" && Array.isArray(item) && item.length === 0))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stablePlannedValue(item)]));
}

function frozenRebaseBlueprint(targetChapter: StoryArcRebaseTarget["chapters"][number] | undefined): StoryArcBundle["chapters"][number] | undefined {
  if (!targetChapter) return undefined;
  if (targetChapter.plannedBlueprint && !targetChapter.revisionId && !targetChapter.committedMemory) return targetChapter.plannedBlueprint;
  return targetChapter.committedBlueprint;
}

function matchesFrozenRebaseBlueprint(chapter: StoryArcBundle["chapters"][number], targetChapter: StoryArcRebaseTarget["chapters"][number] | undefined): boolean {
  const plannedBlueprint = frozenRebaseBlueprint(targetChapter);
  if (!targetChapter || !plannedBlueprint) return false;
  const candidateValue = JSON.stringify(stablePlannedValue(chapter));
  const plannedValue = JSON.stringify(stablePlannedValue(plannedBlueprint));
  return candidateValue === plannedValue;
}

function frozenAuthorityEvidence(chapter: StoryArcBundle["chapters"][number], targetChapter: StoryArcRebaseTarget["chapters"][number] | undefined): string[] {
  const frozenBlueprint = frozenRebaseBlueprint(targetChapter);
  if (!frozenBlueprint) return [];
  const paths = storyArcAuthorityPaths(frozenBlueprint);
  const claims = storyArcAuthorityClaims(frozenBlueprint);
  const evidence = paths
    .map((path, index) => `${path}=${claims[index] ?? ""}`)
    .filter((item) => item.slice(item.indexOf("=") + 1).trim());
  return evidence.length
    ? evidence
    : [`冻结蓝图与第 ${chapter.index} 章候选逐项一致；本轮未新增事实断言。`];
}

function issueMentionsChapter(issue: StoryArcReviewOutput["issues"][number], chapterIndex: number): boolean {
  return new RegExp(`第\\s*${chapterIndex}\\s*章`).test(`${issue.title}\n${issue.evidence}\n${issue.suggestion}`);
}

function isNarrativeScaleConcern(text: string): boolean {
  return /narrativeScale|scale|展开深度|体量|compact|standard|extended|stoppingCondition|developmentAxes/.test(text);
}

export function normalizeStoryArcReviewAuthority(bundle: StoryArcBundle, review: StoryArcReviewOutput, rebaseTarget?: StoryArcRebaseTarget): StoryArcReviewOutput {
  const frozenChapterIndices = new Set(bundle.chapters
    .filter((chapter) => matchesFrozenRebaseBlueprint(chapter, rebaseTarget?.chapters.find((targetChapter) => targetChapter.globalOrder === chapter.index)))
    .map((chapter) => chapter.index));
  return {
    ...review,
    issues: review.issues.filter((issue) => ![...frozenChapterIndices].some((chapterIndex) => issueMentionsChapter(issue, chapterIndex) && !isNarrativeScaleConcern(`${issue.title}\n${issue.evidence}\n${issue.suggestion}`))),
    chapterChecks: review.chapterChecks.map((check) => frozenChapterIndices.has(check.chapterIndex) && check.verdict !== "passed" && !isNarrativeScaleConcern(`${check.dimension}\n${check.evidence}\n${check.reason}`)
      ? { ...check, verdict: "passed" as const, reason: "本次重基线冻结既有蓝图字段；该维度未指向 narrativeScale 新增契约，不阻塞重基线。" }
      : check),
    authorityChecks: review.authorityChecks.map((check) => {
      const chapter = bundle.chapters.find((candidate) => candidate.index === check.chapterIndex);
      const targetChapter = rebaseTarget?.chapters.find((candidate) => candidate.globalOrder === check.chapterIndex);
      const rebaseBlueprintIsFrozen = chapter && frozenChapterIndices.has(chapter.index);
      return chapter ? {
        ...check,
        unresolvedAtClose: [...(chapter.unresolvedAtClose ?? [])],
        checkedPaths: storyArcAuthorityPaths(chapter),
        candidateClaims: storyArcAuthorityClaims(chapter),
        verdict: rebaseBlueprintIsFrozen ? "passed" as const : check.verdict,
        frozenEvidence: rebaseBlueprintIsFrozen ? frozenAuthorityEvidence(chapter, targetChapter) : check.frozenEvidence,
        certaintyUpgrades: rebaseBlueprintIsFrozen ? [] : check.certaintyUpgrades,
        reason: rebaseBlueprintIsFrozen ? "候选与重基线冻结蓝图一致；本次只审核 narrativeScale 新增契约与结构完整性。" : check.reason,
      } : check;
    }),
  };
}

const VERDICT_RANK = { passed: 0, revise: 1, blocked: 2 } as const;

export function mergeStoryArcReviews(bundle: StoryArcBundle, reviews: StoryArcReviewOutput[], rebaseTarget?: StoryArcRebaseTarget): StoryArcReviewOutput {
  if (!reviews.length) throw new Error("故事弧审核合并至少需要一份审核结果");
  const normalized = reviews.map((review) => normalizeStoryArcReviewAuthority(bundle, review, rebaseTarget));
  const worst = <T extends { verdict: "passed" | "revise" | "blocked" }>(items: T[]) => items.reduce((selected, item) => VERDICT_RANK[item.verdict] > VERDICT_RANK[selected.verdict] ? item : selected);
  const chapterChecks = bundle.chapters.flatMap((chapter) => CHAPTER_PLAN_CHECK_DIMENSIONS.map((dimension) => worst(normalized.map((review) => review.chapterChecks.find((check) => check.chapterIndex === chapter.index && check.dimension === dimension)).filter((check): check is ChapterPlanValidationCheck => Boolean(check)))));
  const arcChecks = ARC_PLAN_CHECK_DIMENSIONS.map((dimension) => worst(normalized.map((review) => review.arcChecks.find((check) => check.dimension === dimension)).filter((check): check is ArcPlanValidationCheck => Boolean(check))));
  const authorityChecks = bundle.chapters.map((chapter) => {
    const checks = normalized.map((review) => review.authorityChecks.find((check) => check.chapterIndex === chapter.index)).filter((check): check is StoryArcReviewOutput["authorityChecks"][number] => Boolean(check));
    const selected = worst(checks);
    const certaintyUpgrades = checks.flatMap((check) => check.certaintyUpgrades).filter((upgrade, index, all) => index === all.findIndex((candidate) => candidate.candidateClaim === upgrade.candidateClaim && candidate.frozenBoundary === upgrade.frozenBoundary));
    return {
      ...selected,
      verdict: certaintyUpgrades.length ? "revise" as const : selected.verdict,
      frozenEvidence: [...new Set(checks.flatMap((check) => check.frozenEvidence))],
      certaintyUpgrades,
      reason: [...new Set(checks.map((check) => check.reason))].join("；"),
    };
  });
  const issues = normalized.flatMap((review) => review.issues).filter((issue, index, all) => index === all.findIndex((candidate) => candidate.title === issue.title && candidate.evidence === issue.evidence));
  for (const check of authorityChecks) {
    for (const upgrade of check.certaintyUpgrades) {
      issues.push({ severity: "major", title: `第 ${check.chapterIndex} 章存在未获事实支持的确定性升级`, evidence: upgrade.candidateClaim, suggestion: `退回冻结边界：${upgrade.frozenBoundary}。${upgrade.reason}` });
    }
  }
  const verdict = issues.some((issue) => issue.severity === "blocker") || authorityChecks.some((check) => check.verdict === "blocked")
    ? "blocked" as const
    : issues.some((issue) => issue.severity === "major") || chapterChecks.some((check) => check.verdict !== "passed") || arcChecks.some((check) => check.verdict !== "passed") || authorityChecks.some((check) => check.verdict !== "passed")
      ? "revise" as const
      : "passed" as const;
  return { verdict, summary: normalized.map((review) => review.summary).join("\n"), issues, chapterChecks, arcChecks, authorityChecks };
}

export function compileChapterPlanValidationReport(bundle: StoryArcBundle, checks: ChapterPlanValidationCheck[], arcChecks: ArcPlanValidationCheck[] = []): ChapterPlanValidationReport {
  const expected = bundle.chapters.flatMap((chapter) => CHAPTER_PLAN_CHECK_DIMENSIONS.map((dimension) => ({ chapterIndex: chapter.index, dimension })));
  const validChapterIndices = new Set(bundle.chapters.map((chapter) => chapter.index));
  const normalized = checks.filter((check, index, all) => validChapterIndices.has(check.chapterIndex)
    && CHAPTER_PLAN_CHECK_DIMENSIONS.includes(check.dimension)
    && index === all.findIndex((candidate) => candidate.chapterIndex === check.chapterIndex && candidate.dimension === check.dimension));
  const missingChecks = expected.filter((item) => !normalized.some((check) => check.chapterIndex === item.chapterIndex && check.dimension === item.dimension));
  const blockingChecks = normalized.filter((check) => check.verdict !== "passed");
  const normalizedArcChecks = arcChecks.filter((check, index, all) => ARC_PLAN_CHECK_DIMENSIONS.includes(check.dimension)
    && index === all.findIndex((candidate) => candidate.dimension === check.dimension));
  const missingArcChecks = ARC_PLAN_CHECK_DIMENSIONS.filter((dimension) => !normalizedArcChecks.some((check) => check.dimension === dimension));
  const blockingArcChecks = normalizedArcChecks.filter((check) => check.verdict !== "passed");
  return {
    passed: missingChecks.length === 0 && blockingChecks.length === 0 && missingArcChecks.length === 0 && blockingArcChecks.length === 0,
    checks: normalized,
    missingChecks,
    blockingChecks,
    arcChecks: normalizedArcChecks,
    missingArcChecks,
    blockingArcChecks,
  };
}

export function validateStoryArcReview(bundle: StoryArcBundle, review: StoryArcReviewOutput): ChapterPlanValidationReport {
  const report = compileChapterPlanValidationReport(bundle, Array.isArray(review.chapterChecks) ? review.chapterChecks : [], Array.isArray(review.arcChecks) ? review.arcChecks : []);
  if (report.missingChecks.length) throw new Error(`故事弧审核缺少逐章校验：${report.missingChecks.map((item) => `第${item.chapterIndex}章/${item.dimension}`).join("、")}`);
  if (report.missingArcChecks.length) throw new Error(`故事弧审核缺少整弧校验：${report.missingArcChecks.join("、")}`);
  const authorityChecks = Array.isArray(review.authorityChecks) ? review.authorityChecks : [];
  for (const chapter of bundle.chapters) {
    const matches = authorityChecks.filter((check) => check.chapterIndex === chapter.index);
    if (matches.length !== 1) throw new Error(`故事弧审核缺少第${chapter.index}章唯一的事实权威校验`);
    const check = matches[0];
    if (!check.candidateClaims.length || !check.frozenEvidence.length || !check.reason.trim()) throw new Error(`第${chapter.index}章事实权威校验缺少候选断言、冻结依据或结论理由`);
    const expectedPaths = storyArcAuthorityPaths(chapter);
    if (JSON.stringify(check.checkedPaths) !== JSON.stringify(expectedPaths) || check.candidateClaims.length !== expectedPaths.length) {
      throw new Error(`第${chapter.index}章事实权威校验未逐项覆盖运行时指定的候选路径`);
    }
    if (JSON.stringify(check.unresolvedAtClose) !== JSON.stringify(chapter.unresolvedAtClose ?? [])) throw new Error(`第${chapter.index}章事实权威校验未逐项覆盖 unresolvedAtClose`);
    if (check.certaintyUpgrades.length > 0 && check.verdict === "passed") throw new Error(`第${chapter.index}章事实权威校验发现确定性升级却标记通过`);
  }
  const hasBlockingIssue = review.issues.some((item) => item.severity === "blocker" || item.severity === "major");
  const hasAuthorityFailure = authorityChecks.some((check) => check.verdict !== "passed" || check.certaintyUpgrades.length > 0);
  if ((!report.passed || hasBlockingIssue || hasAuthorityFailure) && review.verdict === "passed") throw new Error("故事弧审核结论与逐章校验不一致");
  return report;
}

export function storyArcReviewStrategy(reviewPolicy: "manual" | "auto") {
  return {
    automaticReview: true as const,
    automaticRevision: reviewPolicy === "auto",
    humanApproval: reviewPolicy === "manual",
  };
}
