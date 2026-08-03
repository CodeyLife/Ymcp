import { describe, expect, it } from "vitest";
import { aggregateChapterReviews, reviewIssueFingerprint } from "../chapter-review-snapshot";
import type { Review, ReviewIssue } from "../protocol";
import { REVIEW_DIMENSIONS } from "../prompts/schemas";

const responsibilities = {
  "plot-reviewer": ["plot", "hookPayoff"],
  "continuity-reviewer": ["continuity", "worldbuilding"],
  "style-reviewer": ["sceneEmbodiment", "specificity", "humor", "subtext"],
  "character-reviewer": ["characterVoice", "dialogue", "ensemble"],
  "reader-reviewer": ["readerRetention", "romance", "narrativePacing"],
} as const;

function makeReview(role: keyof typeof responsibilities, identity: Review["identity"], score: number, issues: ReviewIssue[] = []): Review {
  const dimensionScores = Object.fromEntries(REVIEW_DIMENSIONS.map((dimension) => [dimension, score]));
  return { id: role, projectId: "p1", artifactId: "a1", reviewerId: role, role, identity, verdict: issues.length ? "revise" : "passed", issues, score, dimensionScores, createdAt: 1, artifactFingerprint: "fp1" };
}

function completeReviews(issue: ReviewIssue[] = []) {
  return [
    makeReview("plot-reviewer", "internal", 4, issue),
    makeReview("continuity-reviewer", "internal", 3),
    makeReview("style-reviewer", "independent", 5, issue),
    makeReview("character-reviewer", "independent", 2),
    makeReview("reader-reviewer", "independent", 1),
  ];
}

describe("aggregateChapterReviews", () => {
  it("persists every responsible reviewer dimension without issue-derived fallback", () => {
    const snapshot = aggregateChapterReviews(completeReviews());
    expect(snapshot.complete).toBe(true);
    expect(snapshot.dimensionScores).toEqual({ plot: 4, hookPayoff: 4, continuity: 3, worldbuilding: 3, sceneEmbodiment: 5, specificity: 5, humor: 5, subtext: 5, characterVoice: 2, dialogue: 2, ensemble: 2, readerRetention: 1, romance: 1, narrativePacing: 1 });
    expect(snapshot.overallScore).toBe(43 / 14);
    expect(snapshot.verdict).toBe("passed");
  });

  it("does not fabricate a score when a required reviewer is missing", () => {
    const snapshot = aggregateChapterReviews(completeReviews().slice(0, 4));
    expect(snapshot.complete).toBe(false);
    expect(snapshot.overallScore).toBeUndefined();
  });

  it("merges the same issue across roles and inherits the user's status", () => {
    const issue: ReviewIssue = { severity: "major", title: "因果跳步", description: "转折缺少触发", evidence: "他忽然答应了。", excerpt: "他忽然答应了。", dimension: "plot", suggestion: "补足促成选择的信息" };
    const fingerprint = reviewIssueFingerprint(issue);
    const snapshot = aggregateChapterReviews(completeReviews([issue]), new Map([[fingerprint, "ignored"]]));
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.issues[0]).toMatchObject({ fingerprint, status: "ignored", sourceRoles: ["plot-reviewer", "style-reviewer"] });
    expect(snapshot.verdict).toBe("revise");
  });
});
