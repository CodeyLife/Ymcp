import type { Review } from "../protocol";

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
  if (!reviews.length) return 0;
  const scores = reviews.map((review) => {
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

export function evaluateCommitGate(reviews: Review[], artifactFingerprint: string) {
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
  const qualityFailure = hasBlockingIssue
    ? "blocking-issue"
    : lowReviewer
      ? "reviewer-score"
      : requiredReviews.length > 0 && overallScore < MIN_AUTOMATIC_COMMIT_SCORE
        ? "overall-score"
        : undefined;
  return {
    passed: missingRoles.length === 0
      && requiredReviews.every((review) => review?.verdict === "passed")
      && !qualityFailure,
    reviewIds: currentReviews.map((review) => review.id),
    failedReviewIds: currentReviews.filter((review) => review.verdict !== "passed").map((review) => review.id),
    missingRoles,
    ...(qualityFailure ? { qualityFailure } : {}),
    overallScore,
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
  const currentScore = scoreReviews(params.reviews);
  const previousScore = params.previousScore;
  const improvement = previousScore === undefined ? Number.POSITIVE_INFINITY : currentScore - previousScore;
  const blocker = hasBlocker(params.reviews);
  const major = hasBlockerOrMajor(params.reviews);
  const passed = allReviewsPassed(params.reviews);
  const belowQualityScore = currentScore < MIN_AUTOMATIC_COMMIT_SCORE
    || params.reviews.some((review) => scoreReviews([review]) < MIN_REVIEWER_SCORE);

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
