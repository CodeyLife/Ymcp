import type { StoryArcBundle } from "./story-arc";

export const CHAPTER_PLAN_CHECK_DIMENSIONS = ["alignment", "choice-cost", "relationship-stage", "earned-outcome"] as const;
export type ChapterPlanCheckDimension = (typeof CHAPTER_PLAN_CHECK_DIMENSIONS)[number];

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
}

export interface StoryArcReviewOutput {
  verdict: "passed" | "revise" | "blocked";
  summary: string;
  issues: Array<{ severity: "blocker" | "major" | "warning"; title: string; evidence: string; suggestion: string }>;
  chapterChecks: ChapterPlanValidationCheck[];
}

export function compileChapterPlanValidationReport(bundle: StoryArcBundle, checks: ChapterPlanValidationCheck[]): ChapterPlanValidationReport {
  const expected = bundle.chapters.flatMap((chapter) => CHAPTER_PLAN_CHECK_DIMENSIONS.map((dimension) => ({ chapterIndex: chapter.index, dimension })));
  const validChapterIndices = new Set(bundle.chapters.map((chapter) => chapter.index));
  const normalized = checks.filter((check, index, all) => validChapterIndices.has(check.chapterIndex)
    && CHAPTER_PLAN_CHECK_DIMENSIONS.includes(check.dimension)
    && index === all.findIndex((candidate) => candidate.chapterIndex === check.chapterIndex && candidate.dimension === check.dimension));
  const missingChecks = expected.filter((item) => !normalized.some((check) => check.chapterIndex === item.chapterIndex && check.dimension === item.dimension));
  const blockingChecks = normalized.filter((check) => check.verdict !== "passed");
  return { passed: missingChecks.length === 0 && blockingChecks.length === 0, checks: normalized, missingChecks, blockingChecks };
}

export function validateStoryArcReview(bundle: StoryArcBundle, review: StoryArcReviewOutput): ChapterPlanValidationReport {
  const report = compileChapterPlanValidationReport(bundle, Array.isArray(review.chapterChecks) ? review.chapterChecks : []);
  if (report.missingChecks.length) throw new Error(`故事弧审核缺少逐章校验：${report.missingChecks.map((item) => `第${item.chapterIndex}章/${item.dimension}`).join("、")}`);
  const hasBlockingIssue = review.issues.some((item) => item.severity === "blocker" || item.severity === "major");
  if ((!report.passed || hasBlockingIssue) && review.verdict === "passed") throw new Error("故事弧审核结论与逐章校验不一致");
  return report;
}

export function storyArcReviewStrategy(reviewPolicy: "manual" | "auto") {
  return {
    automaticReview: true as const,
    automaticRevision: reviewPolicy === "auto",
    humanApproval: reviewPolicy === "manual",
  };
}
