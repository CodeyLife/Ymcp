import type { Review } from "../protocol";
import type { ManuscriptStructuralReport } from "../application/manuscript-structure";
import { buildRevisionBrief } from "../application/revision-brief";
import type { ReviewDimension } from "../prompts/schemas";

export const REQUIRED_CHAPTER_REVIEWERS = [
  { role: "plot-reviewer", identity: "internal" },
  { role: "continuity-reviewer", identity: "internal" },
  { role: "style-reviewer", identity: "independent" },
  { role: "character-reviewer", identity: "independent" },
  { role: "reader-reviewer", identity: "independent" },
] as const;

/**
 * V2 修订决策模块。
 *
 * 与 v1 [workflow-shared.ts] 的 shouldAutoRevise 等价，但参数化为 v2 Review 结构。
 *
 * 决策规则：
 * - 所有 review verdict=passed → 才视为整体通过
 * - blocker issue 存在 → 必须修订（直到无 blocker 或达到上限）
 * - major issue 存在 + 改善度 ≥ 0.15 → 继续修订
 * - 改善度 < 0.15（连续两轮无显著改善）→ 停止修订，避免无限循环
 * - 达到 maxAutoRevisions 上限 → 停止修订，进入人工队列
 */

export interface RevisionDecision {
  readonly shouldRevise: boolean;
  readonly reason: string;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly currentScore: number;
  readonly previousScore?: number;
  readonly improvement: number;
  readonly hasBlocker: boolean;
  readonly hasMajor: boolean;
}

export const DEFAULT_MAX_AUTO_REVISIONS = 2;
export const MIN_IMPROVEMENT_THRESHOLD = 0.15;
export const MIN_AUTOMATIC_COMMIT_SCORE = 4.0;
export const MIN_REVIEWER_SCORE = 3.5;

/**
 * 计算 review 列表的综合质量分数（0-5）。
 *
 * Prefer the role-specific score persisted by the reviewer. Legacy reviews
 * without a score retain the severity-derived fallback.
 */
export function scoreReviews(reviews: Review[]): number {
  const scoredReviews = reviews.filter((review) => review.role !== "structural-validator");
  if (!scoredReviews.length) return 0;
  const scores = scoredReviews.map((review) => {
    if (typeof review.score === "number" && Number.isFinite(review.score)) return Math.max(0, Math.min(5, review.score));
    let fallback = 5;
    for (const issue of review.issues) {
      if (issue.severity === "blocker") fallback -= 1.5;
      else if (issue.severity === "major") fallback -= 0.5;
    }
    return Math.max(0, fallback);
  });
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

/**
 * 判断是否还有 blocker 或 major。
 */
export function hasBlockerOrMajor(reviews: Review[]): boolean {
  return reviews.some((review) => review.issues.some((issue) => issue.severity === "blocker" || issue.severity === "major"));
}

export function hasBlocker(reviews: Review[]): boolean {
  return reviews.some((review) => review.issues.some((issue) => issue.severity === "blocker"));
}

/**
 * 判断是否所有 review verdict 都是 passed。
 */
export function allReviewsPassed(reviews: Review[]): boolean {
  return reviews.length > 0 && reviews.every((review) => review.verdict === "passed");
}

export interface CommitGateOptions {
  /** 由冻结章节蓝图计算；未提供时兼容旧调用，不增加历史门槛。 */
  applicableDimensions?: readonly ReviewDimension[];
}

function missingDimensionEvidence(reviews: Review[], applicableDimensions: readonly ReviewDimension[] | undefined): ReviewDimension[] {
  if (!applicableDimensions?.length) return [];
  return [...new Set(applicableDimensions)].filter((dimension) => !reviews.some((review) =>
    typeof review.dimensionScores?.[dimension] === "number"
    || review.issues.some((issue) => issue.dimension === dimension),
  ));
}

export function evaluateCommitGate(
  reviews: Review[],
  artifactFingerprint: string,
  structuralReport: ManuscriptStructuralReport,
  options?: CommitGateOptions,
) {
  const currentReviews = reviews.filter((review) => review.artifactFingerprint === artifactFingerprint);
  const requiredReviews = REQUIRED_CHAPTER_REVIEWERS.map(({ role, identity }) =>
    currentReviews.find((review) => review.role === role && review.identity === identity),
  );
  const missingRoles = REQUIRED_CHAPTER_REVIEWERS
    .filter((_, index) => !requiredReviews[index])
    .map(({ role }) => role);
  const overallScore = scoreReviews(requiredReviews.filter((review): review is Review => Boolean(review)));
  const lowReviewer = requiredReviews.find((review) => review && scoreReviews([review]) < MIN_REVIEWER_SCORE);
  const hasBlockingIssue = requiredReviews.some((review) => review?.issues.some((issue) => issue.severity === "blocker" || issue.severity === "major"));
  const missingDimensions = missingDimensionEvidence(requiredReviews.filter((review): review is Review => Boolean(review)), options?.applicableDimensions);
  const qualityFailure = hasBlockingIssue
    ? "blocking-issue"
    : missingDimensions.length
      ? "dimension-coverage"
    : lowReviewer
      ? "reviewer-score"
      : requiredReviews.length > 0 && overallScore < MIN_AUTOMATIC_COMMIT_SCORE
        ? "overall-score"
        : undefined;
  return {
    passed: missingRoles.length === 0
      && requiredReviews.every((review) => review?.verdict === "passed")
      && structuralReport.passed
      && !qualityFailure,
    reviewIds: currentReviews.map((review) => review.id),
    failedReviewIds: currentReviews.filter((review) => review.verdict !== "passed").map((review) => review.id),
    missingRoles,
    ...(qualityFailure ? { qualityFailure } : {}),
    ...(missingDimensions.length ? { missingDimensions } : {}),
    ...(!structuralReport.passed ? { structuralFailure: "structural-blocker" as const } : {}),
    overallScore,
  };
}

export interface CandidateQualityKey {
  structuralPassed: boolean;
  blockerCount: number;
  majorCount: number;
  minimumReviewerScore: number;
  overallScore: number;
  /** Per-reviewer scores let the local degradation guard inspect every role, not just the minimum. */
  reviewerScores: Record<string, number>;
}

export function candidateQualityKey(reviews: Review[], structuralReport: ManuscriptStructuralReport): CandidateQualityKey {
  const current = reviews.filter((review) => review.role !== "structural-validator");
  const scores = current.map((review) => scoreReviews([review]));
  const issueFamilies = buildRevisionBrief(current).clusters.map(({ issue }) => issue);
  const reviewerScores = Object.fromEntries(current.map((review) => [`${review.role}:${review.identity}`, scoreReviews([review])]));
  return {
    structuralPassed: structuralReport.passed,
    blockerCount: issueFamilies.filter((item) => item.severity === "blocker").length,
    majorCount: issueFamilies.filter((item) => item.severity === "major").length,
    minimumReviewerScore: scores.length ? Math.min(...scores) : 0,
    overallScore: scoreReviews(current),
    reviewerScores,
  };
}

/**
 * 修订质量改善阈值：当修订稿的综合分数比基线高出此值，
 * 且未引入新 blocker/major、最低 reviewer 分数仍达标时，
 * 即使某个 reviewer 分数下降也接受修订。
 *
 * 根因：严格字典序比较会拒绝"整体改善但某维度略降"的修订，
 * 导致有效的部分改善被丢弃，修订流程陷入停滞。
 */
export const PARTIAL_IMPROVEMENT_THRESHOLD = 0.2;

/**
 * 单个 reviewer 分数最大允许下降幅度。
 * 与 PARTIAL_IMPROVEMENT_THRESHOLD 配合使用：即使整体改善达标，
 * 任何单个 reviewer 的分数下降不得超过此值，防止局部质量退化被整体改善掩盖。
 * 对齐 workflow-map.md §6.3"同类最高分"回退原则。
 */
export const MAX_REVIEWER_SCORE_DROP = 0.5;

export function isCandidateQualityBetter(candidate: CandidateQualityKey, currentBest: CandidateQualityKey): boolean {
  if (candidate.structuralPassed !== currentBest.structuralPassed) return candidate.structuralPassed;
  if (candidate.blockerCount !== currentBest.blockerCount) return candidate.blockerCount < currentBest.blockerCount;
  if (candidate.majorCount !== currentBest.majorCount) return candidate.majorCount < currentBest.majorCount;

  const baselineReviewerScores = Object.keys(currentBest.reviewerScores ?? {});
  const reviewerScoreDrop = baselineReviewerScores.length
    ? Math.max(...baselineReviewerScores.map((reviewer) => (currentBest.reviewerScores[reviewer] ?? 0) - (candidate.reviewerScores?.[reviewer] ?? 0)), 0)
    : currentBest.minimumReviewerScore - candidate.minimumReviewerScore;
  if (reviewerScoreDrop > MAX_REVIEWER_SCORE_DROP) return false;

  // Partial improvement acceptance: when the candidate has no more blockers/majors
  // than the current best (guaranteed by checks above), accept it if the overall
  // score improves meaningfully AND the minimum reviewer score stays above the
  // commit-gate threshold AND no single reviewer's score drops beyond the guarded
  // delta. This prevents rejecting revisions that improve overall quality but
  // slightly lower one reviewer's score, while preventing excessive local regression.
  const overallImprovement = candidate.overallScore - currentBest.overallScore;
  if (
    overallImprovement >= PARTIAL_IMPROVEMENT_THRESHOLD
    && candidate.minimumReviewerScore >= MIN_REVIEWER_SCORE
    && reviewerScoreDrop <= MAX_REVIEWER_SCORE_DROP
  ) {
    return true;
  }

  if (candidate.minimumReviewerScore !== currentBest.minimumReviewerScore) return candidate.minimumReviewerScore > currentBest.minimumReviewerScore;
  return candidate.overallScore > currentBest.overallScore;
}

// ─────────────────────────────────────────────────────────────────────────────
// RC5: Named Entity Drift Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 提取文本中引号包裹的专有名词（角色名、物品名、地名等）。
 *
 * 检测中文引号「」、『』、""、'' 中长度 2-10 的内容，
 * 过滤掉明显不是专有名词的内容（如完整句子、常见词组）。
 */
function extractQuotedNames(text: string): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /「([^」]{2,10})」/g,
    /『([^』]{2,10})』/g,
    /\u201c([^\u201d]{2,10})\u201d/g, // "..."
    /\u2018([^\u2019]{2,10})\u2019/g, // '...'
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      names.add(match[1].trim());
    }
  }
  return names;
}

/**
 * 检测修订前后命名实体的漂移。
 *
 * 根因（RC5）：修订 LLM 在修复非一致性问题时，可能顺手改变其他已建立的
 * 专有名词（如把"枯荣"改成"定风波"）。这种事实漂移不会被质量分数检测到，
 * 因为分数只反映审核维度的改善，不检测未触及事实是否被保留。
 *
 * 检测策略：比较源文本和修订文本中引号包裹的专有名词集合。
 * - disappeared: 源文本有但修订文本没有的名称（可能被错误替换）
 * - appeared: 修订文本有但源文本没有的名称（可能是幻觉引入的新名称）
 *
 * 注意：这是一次检测，不自动拒绝修订。漂移结果应由调用方结合审核问题
 * 判断是否为预期变更（如一致性约束要求统一名称）。
 */
export interface NamedEntityDrift {
  disappeared: string[];
  appeared: string[];
  hasDrift: boolean;
}

export function detectNamedEntityDrift(sourceText: string, revisedText: string): NamedEntityDrift {
  const sourceNames = extractQuotedNames(sourceText);
  const revisedNames = extractQuotedNames(revisedText);
  const disappeared = [...sourceNames].filter((name) => !revisedNames.has(name));
  const appeared = [...revisedNames].filter((name) => !sourceNames.has(name));
  return {
    disappeared,
    appeared,
    hasDrift: disappeared.length > 0 || appeared.length > 0,
  };
}

/**
 * 修订决策：是否需要继续修订。
 *
 * 与 v1 shouldAutoRevise 等价但返回更丰富的决策对象（含 reason）。
 *
 * @param params.reviews 当前轮的 review 列表
 * @param params.iteration 当前修订轮次（0=首次审核，1=第一次修订后审核，...）
 * @param params.maxIterations 最大修订轮次（默认 2）
 * @param params.previousScore 上一轮分数（首次为 undefined）
 */
export function decideRevision(params: {
  reviews: Review[];
  iteration: number;
  maxIterations?: number;
  previousScore?: number;
}): RevisionDecision {
  const maxIterations = params.maxIterations ?? DEFAULT_MAX_AUTO_REVISIONS;
  const scoredReviews = params.reviews.filter((review) => review.role !== "structural-validator");
  const currentScore = scoreReviews(scoredReviews);
  const previousScore = params.previousScore;
  const improvement = previousScore === undefined ? Number.POSITIVE_INFINITY : currentScore - previousScore;
  const blocker = hasBlocker(params.reviews);
  const major = hasBlockerOrMajor(params.reviews);
  const passed = allReviewsPassed(params.reviews);
  const belowQualityScore = currentScore < MIN_AUTOMATIC_COMMIT_SCORE
    || scoredReviews.some((review) => scoreReviews([review]) < MIN_REVIEWER_SCORE);

  let shouldRevise = false;
  let reason = "";

  if (passed && !belowQualityScore) {
    shouldRevise = false;
    reason = "所有 reviewer 通过";
  } else if (params.iteration >= maxIterations) {
    shouldRevise = false;
    reason = `达到修订上限 ${maxIterations} 轮，进入人工队列`;
  } else if (blocker) {
    shouldRevise = true;
    reason = `存在 blocker，必须修订（第 ${params.iteration + 1}/${maxIterations} 轮）`;
  } else if (belowQualityScore) {
    shouldRevise = true;
    reason = `质量分未达到自动定稿门槛（综合 ${currentScore.toFixed(2)} / ${MIN_AUTOMATIC_COMMIT_SCORE.toFixed(2)}）`;
  } else if (!major) {
    shouldRevise = false;
    reason = "无 blocker 或 major，仅 warning 可人工微调";
  } else if (improvement < MIN_IMPROVEMENT_THRESHOLD) {
    shouldRevise = false;
    reason = `改善度 ${improvement.toFixed(2)} < 阈值 ${MIN_IMPROVEMENT_THRESHOLD}，停止修订避免无限循环`;
  } else {
    shouldRevise = true;
    reason = previousScore === undefined
      ? `初始审校存在 major，建立修订基线（第 ${params.iteration + 1}/${maxIterations} 轮）`
      : `存在 major 且改善度 ${improvement.toFixed(2)} ≥ ${MIN_IMPROVEMENT_THRESHOLD}，继续修订（第 ${params.iteration + 1}/${maxIterations} 轮）`;
  }

  return {
    shouldRevise,
    reason,
    iteration: params.iteration,
    maxIterations,
    currentScore,
    previousScore,
    improvement: improvement === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : improvement,
    hasBlocker: blocker,
    hasMajor: major,
  };
}
