import { createHash, randomUUID } from "node:crypto";
import type { Review, ReviewIssue } from "./protocol";
import { REQUIRED_CHAPTER_REVIEWERS } from "./temporal/revision-policy";
import { REVIEWER_DIMENSIONS, type ReviewerRole } from "./prompts/chapter-review";
import { REVIEW_DIMENSIONS, type ReviewDimension } from "./prompts/schemas";

export type ChapterReviewVerdict = "passed" | "revise" | "blocked";
export type ChapterReviewIssueStatus = "pending" | "ignored" | "resolved";

export interface ChapterReviewSnapshotIssue {
  id: string;
  fingerprint: string;
  dimension?: string;
  severity: ReviewIssue["severity"];
  title: string;
  description?: string;
  evidenceQuote: string;
  paragraph?: number;
  revisionRanges: Array<{ start: number; end: number }>;
  rule?: string;
  suggestion?: string;
  sourceRoles: string[];
  status: ChapterReviewIssueStatus;
}

export interface ChapterReviewSnapshotData {
  verdict: ChapterReviewVerdict;
  complete: boolean;
  overallScore?: number;
  dimensionScores: Partial<Record<ReviewDimension, number>>;
  reviewerRoles: string[];
  issues: ChapterReviewSnapshotIssue[];
}

function normalized(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function reviewIssueFingerprint(issue: ReviewIssue): string {
  return createHash("sha256")
    .update([issue.dimension ?? "", normalized(issue.title), normalized(issue.excerpt ?? issue.evidence), normalized(issue.rule)].join("\u0000"))
    .digest("hex");
}

function aggregateVerdict(reviews: Review[]): ChapterReviewVerdict {
  if (reviews.some((review) => review.verdict === "blocked" || review.issues.some((issue) => issue.severity === "blocker"))) return "blocked";
  if (reviews.some((review) => review.verdict === "revise")) return "revise";
  return "passed";
}

export function aggregateChapterReviews(
  reviews: Review[],
  priorStatuses: ReadonlyMap<string, ChapterReviewIssueStatus> = new Map(),
): ChapterReviewSnapshotData {
  const latestByRole = new Map<string, Review>();
  for (const review of [...reviews].sort((left, right) => left.createdAt - right.createdAt)) {
    if (review.role) latestByRole.set(review.role, review);
  }
  const required = REQUIRED_CHAPTER_REVIEWERS.map(({ role }) => latestByRole.get(role)).filter((review): review is Review => Boolean(review));
  const complete = required.length === REQUIRED_CHAPTER_REVIEWERS.length;
  const dimensionScores: Partial<Record<ReviewDimension, number>> = {};

  for (const review of required) {
    const role = review.role as ReviewerRole;
    for (const dimension of REVIEWER_DIMENSIONS[role] ?? []) {
      const score = review.dimensionScores?.[dimension] ?? review.score;
      if (typeof score === "number" && Number.isFinite(score)) dimensionScores[dimension] = Math.max(0, Math.min(5, score));
    }
  }

  const scores = REVIEW_DIMENSIONS.map((dimension) => dimensionScores[dimension]).filter((score): score is number => typeof score === "number");
  const overallScore = complete && scores.length === REVIEW_DIMENSIONS.length
    ? scores.reduce((sum, score) => sum + score, 0) / scores.length
    : undefined;

  const merged = new Map<string, ChapterReviewSnapshotIssue>();
  for (const review of required) {
    for (const issue of review.issues) {
      const fingerprint = reviewIssueFingerprint(issue);
      const existing = merged.get(fingerprint);
      if (existing) {
        existing.sourceRoles = [...new Set([...existing.sourceRoles, review.role ?? review.reviewerId])];
        continue;
      }
      merged.set(fingerprint, {
        id: randomUUID(),
        fingerprint,
        dimension: issue.dimension,
        severity: issue.severity,
        title: issue.title,
        description: issue.description,
        evidenceQuote: issue.excerpt ?? issue.evidence,
        paragraph: issue.paragraph,
        revisionRanges: issue.revisionRanges ?? [],
        rule: issue.rule,
        suggestion: issue.suggestion,
        sourceRoles: [review.role ?? review.reviewerId],
        status: priorStatuses.get(fingerprint) ?? "pending",
      });
    }
  }

  return {
    verdict: aggregateVerdict(required),
    complete,
    overallScore,
    dimensionScores,
    reviewerRoles: required.map((review) => review.role ?? review.reviewerId),
    issues: [...merged.values()],
  };
}
