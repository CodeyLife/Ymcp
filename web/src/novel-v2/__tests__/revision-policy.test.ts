import { describe, expect, it } from "vitest";
import {
  allReviewsPassed,
  decideRevision,
  DEFAULT_MAX_AUTO_REVISIONS,
  evaluateCommitGate,
  hasBlocker,
  hasBlockerOrMajor,
  MIN_IMPROVEMENT_THRESHOLD,
  scoreReviews,
  type RevisionDecision,
} from "../temporal/revision-policy";
import type { Artifact, Review } from "../protocol";

const artifact: Artifact = { id: "artifact-1", projectId: "p1", taskId: "task-1", attemptId: "attempt-1", kind: "draft", contentHash: "hash", objectKey: "obj", baseRevision: 0, createdAt: 1, fingerprint: "fp-1" };

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: "review-1",
    projectId: "p1",
    artifactId: artifact.id,
    reviewerId: "internal-style",
    identity: "internal",
    role: "style-reviewer",
    verdict: "passed",
    issues: [],
    createdAt: 2,
    artifactFingerprint: artifact.fingerprint,
    ...overrides,
  };
}

function issue(severity: "blocker" | "major" | "warning", title = "issue") {
  return { severity, title, evidence: `evidence-${title}` };
}

describe("revision-policy scoreReviews", () => {
  it("returns 0 for empty reviews", () => {
    expect(scoreReviews([])).toBe(0);
  });

  it("returns 5 when reviews have no issues", () => {
    expect(scoreReviews([makeReview(), makeReview({ id: "review-2" })])).toBe(5);
  });

  it("averages severity-derived legacy reviewer scores with a floor of 0", () => {
    const score = scoreReviews([
      makeReview({ id: "r1", issues: [issue("blocker", "b1"), issue("major", "m1")] }),
      makeReview({ id: "r2", issues: [issue("warning", "w1")] }),
    ]);
    expect(score).toBeCloseTo(4, 5);

    const floored = scoreReviews([
      makeReview({ id: "r1", issues: [issue("blocker"), issue("blocker"), issue("blocker"), issue("blocker")] }),
    ]);
    expect(floored).toBe(0);
  });

  it("uses persisted role scores instead of double-counting overlapping issues", () => {
    const reviews = [
      makeReview({ id: "r1", score: 3.5, issues: [issue("major", "same-pattern")] }),
      makeReview({ id: "r2", score: 4.5, issues: [issue("major", "same-pattern")] }),
    ];
    expect(scoreReviews(reviews)).toBe(4);
  });
});

describe("revision-policy classification helpers", () => {
  it("hasBlocker and hasBlockerOrMajor distinguish severities", () => {
    const onlyWarning = [makeReview({ issues: [issue("warning")] })];
    expect(hasBlocker(onlyWarning)).toBe(false);
    expect(hasBlockerOrMajor(onlyWarning)).toBe(false);

    const withMajor = [makeReview({ issues: [issue("warning"), issue("major")] })];
    expect(hasBlocker(withMajor)).toBe(false);
    expect(hasBlockerOrMajor(withMajor)).toBe(true);

    const withBlocker = [makeReview({ issues: [issue("blocker")] })];
    expect(hasBlocker(withBlocker)).toBe(true);
    expect(hasBlockerOrMajor(withBlocker)).toBe(true);
  });

  it("allReviewsPassed requires non-empty list and every verdict=passed", () => {
    expect(allReviewsPassed([])).toBe(false);
    expect(allReviewsPassed([makeReview({ verdict: "passed" }), makeReview({ id: "r2", verdict: "revise" })])).toBe(false);
    expect(allReviewsPassed([makeReview({ verdict: "passed" }), makeReview({ id: "r2", verdict: "passed" })])).toBe(true);
  });

  it("keeps a failed dual gate out of formal commit and exposes the review receipt", () => {
    const reviews = [
      makeReview({ id: "internal", identity: "internal", verdict: "revise" }),
      makeReview({ id: "independent", identity: "independent", verdict: "passed" }),
      makeReview({ id: "stale", identity: "internal", artifactFingerprint: "old-fingerprint" }),
    ];

    expect(evaluateCommitGate(reviews, artifact.fingerprint)).toEqual({
      passed: false,
      reviewIds: ["internal", "independent"],
      failedReviewIds: ["internal"],
    });
  });

  it("allows formal commit only when both reviewer identities pass the current artifact", () => {
    const reviews = [
      makeReview({ id: "internal", identity: "internal" }),
      makeReview({ id: "independent", identity: "independent" }),
    ];

    expect(evaluateCommitGate(reviews, artifact.fingerprint).passed).toBe(true);
  });
});

describe("revision-policy decideRevision branches", () => {
  it("stops when all reviewers pass regardless of iteration", () => {
    const decision = decideRevision({ reviews: [makeReview({ verdict: "passed" })], iteration: 0 });
    expect(decision.shouldRevise).toBe(false);
    expect(decision.reason).toContain("通过");
    expect(decision.currentScore).toBe(5);
  });

  it("stops when iteration reaches the max ceiling even with blockers", () => {
    const decision = decideRevision({
      reviews: [makeReview({ verdict: "blocked", issues: [issue("blocker")] })],
      iteration: DEFAULT_MAX_AUTO_REVISIONS,
    });
    expect(decision.shouldRevise).toBe(false);
    expect(decision.reason).toContain("修订上限");
    expect(decision.hasBlocker).toBe(true);
  });

  it("forces revision when a blocker exists and iteration is below the ceiling", () => {
    const decision = decideRevision({
      reviews: [makeReview({ verdict: "revise", issues: [issue("blocker")] })],
      iteration: 0,
    });
    expect(decision.shouldRevise).toBe(true);
    expect(decision.reason).toContain("blocker");
    expect(decision.improvement).toBe(Number.POSITIVE_INFINITY);
  });

  it("stops when only warnings remain (no blocker or major)", () => {
    const decision = decideRevision({
      reviews: [makeReview({ verdict: "revise", issues: [issue("warning")] })],
      iteration: 0,
    });
    expect(decision.shouldRevise).toBe(false);
    expect(decision.reason).toContain("warning");
    expect(decision.hasMajor).toBe(false);
  });

  it("stops when improvement falls below the threshold to avoid infinite loops", () => {
    const previousScore = 3;
    const currentScore = previousScore + (MIN_IMPROVEMENT_THRESHOLD - 0.01);
    // 构造一个 major issue 但 score 仅微涨的场景：1 major = -0.5 分
    // previousScore=3 → 3 major 累计 -1.5 → score=3.5；improvement=0.5 显然超阈值，
    // 因此需要更精细的构造。这里用更直接的方式：previousScore 接近 currentScore。
    const decision = decideRevision({
      reviews: [makeReview({ verdict: "revise", issues: [issue("major")] })],
      iteration: 1,
      previousScore: 4.6, // currentScore=4.5, improvement=-0.1 < 0.15
    });
    expect(decision.currentScore).toBeCloseTo(4.5, 5);
    expect(decision.shouldRevise).toBe(false);
    expect(decision.reason).toContain("改善度");
    expect(currentScore).toBeGreaterThan(previousScore);
  });

  it("continues revising when major exists and improvement is above the threshold", () => {
    const decision = decideRevision({
      reviews: [makeReview({ verdict: "revise", issues: [issue("major")] })],
      iteration: 0,
      previousScore: 3, // currentScore=4.5, improvement=1.5 >= 0.15
    });
    expect(decision.shouldRevise).toBe(true);
    expect(decision.reason).toContain("major");
    expect(decision.improvement).toBeGreaterThanOrEqual(MIN_IMPROVEMENT_THRESHOLD);
  });

  it("respects custom maxIterations override", () => {
    const decision = decideRevision({
      reviews: [makeReview({ verdict: "revise", issues: [issue("blocker")] })],
      iteration: 4,
      maxIterations: 5,
    });
    expect(decision.shouldRevise).toBe(true);
    expect(decision.maxIterations).toBe(5);
    expect(decision.iteration).toBe(4);
  });

  it("returns a fully populated RevisionDecision snapshot", () => {
    const decision: RevisionDecision = decideRevision({
      reviews: [makeReview({ verdict: "revise", issues: [issue("blocker"), issue("major")] })],
      iteration: 1,
      previousScore: 2,
    });
    expect(decision).toMatchObject({
      shouldRevise: true,
      iteration: 1,
      maxIterations: DEFAULT_MAX_AUTO_REVISIONS,
      hasBlocker: true,
      hasMajor: true,
    });
    expect(decision.previousScore).toBe(2);
    expect(decision.improvement).toBeGreaterThan(0);
  });
});
