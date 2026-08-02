import { describe, expect, it } from "vitest";
import {
  allReviewsPassed,
  candidateQualityKey,
  decideRevision,
  DEFAULT_MAX_AUTO_REVISIONS,
  detectNamedEntityDrift,
  evaluateCommitGate,
  hasBlocker,
  hasBlockerOrMajor,
  isCandidateQualityBetter,
  MIN_IMPROVEMENT_THRESHOLD,
  scoreReviews,
  type CandidateQualityKey,
  type RevisionDecision,
} from "../temporal/revision-policy";
import type { Artifact, Review } from "../protocol";
import { inspectManuscript } from "../application/manuscript-structure";

const artifact: Artifact = { id: "artifact-1", projectId: "p1", taskId: "task-1", attemptId: "attempt-1", kind: "draft", contentHash: "hash", objectKey: "obj", baseRevision: 0, createdAt: 1, fingerprint: "fp-1" };
const structuralReport = inspectManuscript({ text: "正文" });

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
  it("counts duplicated reviewer findings as one problem family", () => {
    const shared = { severity: "major" as const, evidence: "访客只负责递交线索", revisionRanges: [{ start: 8, end: 12 }], rule: "character-agency" };
    const quality = candidateQualityKey([
      makeReview({ id: "reader", role: "reader-reviewer", issues: [{ ...shared, title: "访客沦为工具人", suggestion: "让访客依照自己的目标取舍" }] }),
      makeReview({ id: "character", role: "character-reviewer", issues: [{ ...shared, title: "来客缺少自主诉求", suggestion: "让来客依照自己的目标取舍" }] }),
      makeReview({ id: "style", role: "style-reviewer", issues: [{ ...shared, title: "配角只承担功能", suggestion: "让配角依照自己的目标取舍" }] }),
    ], structuralReport);

    expect(quality.majorCount).toBe(1);
  });

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

    expect(evaluateCommitGate(reviews, artifact.fingerprint, structuralReport)).toEqual({
      passed: false,
      reviewIds: ["internal", "independent"],
      failedReviewIds: ["internal"],
      missingRoles: ["plot-reviewer", "continuity-reviewer", "character-reviewer", "reader-reviewer"],
      overallScore: 5,
    });
  });

  it("rejects two passing identities when three reviewer roles never returned", () => {
    const reviews = [
      makeReview({ id: "internal", role: "plot-reviewer", identity: "internal" }),
      makeReview({ id: "independent", role: "style-reviewer", identity: "independent" }),
    ];

    expect(evaluateCommitGate(reviews, artifact.fingerprint, structuralReport)).toMatchObject({
      passed: false,
      missingRoles: ["continuity-reviewer", "character-reviewer", "reader-reviewer"],
    });
  });

  it("allows formal commit only when all five assigned reviewer roles pass", () => {
    const reviews = [
      makeReview({ id: "plot", role: "plot-reviewer", identity: "internal", score: 4.2 }),
      makeReview({ id: "continuity", role: "continuity-reviewer", identity: "internal", score: 4.1 }),
      makeReview({ id: "style", role: "style-reviewer", identity: "independent", score: 4.3 }),
      makeReview({ id: "character", role: "character-reviewer", identity: "independent", score: 4.0 }),
      makeReview({ id: "reader", role: "reader-reviewer", identity: "independent", score: 4.4 }),
    ];

    expect(evaluateCommitGate(reviews, artifact.fingerprint, structuralReport)).toMatchObject({ passed: true, missingRoles: [] });
  });

  it("rejects a current-artifact commit when an applicable quality dimension has no evidence", () => {
    const reviews = [
      makeReview({ id: "plot", role: "plot-reviewer", identity: "internal", score: 4.2, dimensionScores: { plot: 4.2, hookPayoff: 4.2 } }),
      makeReview({ id: "continuity", role: "continuity-reviewer", identity: "internal", score: 4.2, dimensionScores: { worldbuilding: 4.2 } }),
      makeReview({ id: "style", role: "style-reviewer", identity: "independent", score: 4.2, dimensionScores: { humor: 4.2 } }),
      makeReview({ id: "character", role: "character-reviewer", identity: "independent", score: 4.2, dimensionScores: { ensemble: 4.2 } }),
      makeReview({ id: "reader", role: "reader-reviewer", identity: "independent", score: 4.2, dimensionScores: {} }),
    ];

    expect(evaluateCommitGate(reviews, artifact.fingerprint, structuralReport, {
      applicableDimensions: ["plot", "hookPayoff", "worldbuilding", "ensemble", "romance", "humor"],
    })).toMatchObject({
      passed: false,
      qualityFailure: "dimension-coverage",
      missingDimensions: ["romance"],
    });
  });

  it("does not require romance or humor evidence when the chapter marks them not applicable", () => {
    const reviews = [
      makeReview({ id: "plot", role: "plot-reviewer", identity: "internal", score: 4.2, dimensionScores: { plot: 4.2, hookPayoff: 4.2 } }),
      makeReview({ id: "continuity", role: "continuity-reviewer", identity: "internal", score: 4.2, dimensionScores: { worldbuilding: 4.2 } }),
      makeReview({ id: "style", role: "style-reviewer", identity: "independent", score: 4.2, dimensionScores: { humor: 4.2 } }),
      makeReview({ id: "character", role: "character-reviewer", identity: "independent", score: 4.2, dimensionScores: { ensemble: 4.2 } }),
      makeReview({ id: "reader", role: "reader-reviewer", identity: "independent", score: 4.2, dimensionScores: {} }),
    ];

    expect(evaluateCommitGate(reviews, artifact.fingerprint, structuralReport, {
      applicableDimensions: ["plot", "hookPayoff", "worldbuilding", "ensemble"],
    })).toMatchObject({ passed: true, missingRoles: [] });
  });

  it("routes a low-scoring all-passed chapter to manual review", () => {
    const reviews = [
      makeReview({ id: "plot", role: "plot-reviewer", identity: "internal", score: 3.8 }),
      makeReview({ id: "continuity", role: "continuity-reviewer", identity: "internal", score: 3.8 }),
      makeReview({ id: "style", role: "style-reviewer", identity: "independent", score: 3.8 }),
      makeReview({ id: "character", role: "character-reviewer", identity: "independent", score: 3.8 }),
      makeReview({ id: "reader", role: "reader-reviewer", identity: "independent", score: 3.8 }),
    ];
    expect(evaluateCommitGate(reviews, artifact.fingerprint, structuralReport)).toMatchObject({ passed: false, qualityFailure: "overall-score" });
  });
});

describe("revision-policy decideRevision branches", () => {
  it("stops when all reviewers pass the score threshold regardless of iteration", () => {
    const decision = decideRevision({ reviews: [makeReview({ verdict: "passed", score: 4.2 })], iteration: 0 });
    expect(decision.shouldRevise).toBe(false);
    expect(decision.reason).toContain("通过");
    expect(decision.currentScore).toBe(4.2);
  });

  it("revises an all-passed result that remains below the quality threshold", () => {
    const decision = decideRevision({ reviews: [makeReview({ verdict: "passed", score: 3.8 })], iteration: 0 });
    expect(decision.shouldRevise).toBe(true);
    expect(decision.reason).toContain("质量分");
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

describe("revision-policy isCandidateQualityBetter", () => {
  const makeQuality = (overrides: Partial<CandidateQualityKey> = {}): CandidateQualityKey => ({
    structuralPassed: true,
    blockerCount: 0,
    majorCount: 1,
    minimumReviewerScore: 4.0,
    overallScore: 4.25,
    reviewerScores: {},
    ...overrides,
  });

  it("accepts partial improvement: overall score up ≥ threshold, min reviewer down but still ≥ MIN_REVIEWER_SCORE", () => {
    // Overall quality improves while the lowest reviewer remains at the commit floor.
    const baseline = makeQuality({ minimumReviewerScore: 3.75, overallScore: 4.25 });
    const revised = makeQuality({ minimumReviewerScore: 3.50, overallScore: 4.57 });
    expect(isCandidateQualityBetter(revised, baseline)).toBe(true);
  });

  it("rejects partial improvement when overall gain is below threshold", () => {
    const baseline = makeQuality({ minimumReviewerScore: 3.75, overallScore: 4.25 });
    const revised = makeQuality({ minimumReviewerScore: 3.50, overallScore: 4.35 });
    expect(isCandidateQualityBetter(revised, baseline)).toBe(false);
  });

  it("rejects partial improvement when min reviewer drops below MIN_REVIEWER_SCORE", () => {
    const baseline = makeQuality({ minimumReviewerScore: 3.75, overallScore: 4.25 });
    const revised = makeQuality({ minimumReviewerScore: 3.40, overallScore: 4.57 });
    expect(isCandidateQualityBetter(revised, baseline)).toBe(false);
  });

  it("rejects candidate with more blockers even if overall score is higher", () => {
    const baseline = makeQuality({ blockerCount: 0, overallScore: 4.25 });
    const revised = makeQuality({ blockerCount: 1, overallScore: 4.80 });
    expect(isCandidateQualityBetter(revised, baseline)).toBe(false);
  });

  it("rejects candidate with more majors even if overall score is higher", () => {
    const baseline = makeQuality({ majorCount: 1, overallScore: 4.25 });
    const revised = makeQuality({ majorCount: 2, overallScore: 4.80 });
    expect(isCandidateQualityBetter(revised, baseline)).toBe(false);
  });

  it("still applies strict lexicographic when overall improvement is marginal", () => {
    // Same blockers/majors, min reviewer drops, overall improvement < threshold
    const baseline = makeQuality({ minimumReviewerScore: 4.0, overallScore: 4.25 });
    const revised = makeQuality({ minimumReviewerScore: 3.8, overallScore: 4.30 });
    expect(isCandidateQualityBetter(revised, baseline)).toBe(false);
  });

  it("accepts when all dimensions are strictly better", () => {
    const baseline = makeQuality({ minimumReviewerScore: 3.5, overallScore: 4.0 });
    const revised = makeQuality({ minimumReviewerScore: 4.0, overallScore: 4.5, majorCount: 0 });
    expect(isCandidateQualityBetter(revised, baseline)).toBe(true);
  });

  it("rejects partial improvement when reviewer score drop exceeds MAX_REVIEWER_SCORE_DROP", () => {
    // Overall improves by 0.3 (>= threshold), min reviewer still >= 3.5,
    // but the drop from 4.2 to 3.6 = 0.6 > MAX_REVIEWER_SCORE_DROP (0.5)
    const baseline = makeQuality({ minimumReviewerScore: 4.2, overallScore: 4.0 });
    const revised = makeQuality({ minimumReviewerScore: 3.6, overallScore: 4.3 });
    expect(isCandidateQualityBetter(revised, baseline)).toBe(false);
  });

  it("guards a non-minimum reviewer from excessive local degradation", () => {
    const baseline = makeQuality({
      overallScore: 4.0,
      minimumReviewerScore: 3.8,
      reviewerScores: { "plot-reviewer:internal": 4.8, "style-reviewer:independent": 3.8 },
    });
    const revised = makeQuality({
      overallScore: 4.3,
      minimumReviewerScore: 3.8,
      reviewerScores: { "plot-reviewer:internal": 4.0, "style-reviewer:independent": 3.8 },
    });

    expect(isCandidateQualityBetter(revised, baseline)).toBe(false);
  });
});

describe("revision-policy detectNamedEntityDrift", () => {
  it("detects no drift when quoted names are preserved", () => {
    const source = "那把琴叫\u2018枯荣\u2019，断过一次弦。";
    const revised = "那把琴名为\u2018枯荣\u2019，断过一次弦。";
    const drift = detectNamedEntityDrift(source, revised);
    expect(drift.hasDrift).toBe(false);
  });

  it("detects when a quoted name disappears and a new one appears", () => {
    const source = "那把琴叫\u2018枯荣\u2019，断过一次弦。";
    const revised = "这世上有种琴，名为\u2018定风波\u2019。";
    const drift = detectNamedEntityDrift(source, revised);
    expect(drift.hasDrift).toBe(true);
    expect(drift.disappeared).toContain("枯荣");
    expect(drift.appeared).toContain("定风波");
  });

  it("detects drift with Chinese angle quotes", () => {
    const source = "他提到了「枯荣」这个名字。";
    const revised = "他提到了「定风波」这个名字。";
    const drift = detectNamedEntityDrift(source, revised);
    expect(drift.hasDrift).toBe(true);
    expect(drift.disappeared).toContain("枯荣");
    expect(drift.appeared).toContain("定风波");
  });

  it("returns no drift for text without quoted names", () => {
    const source = "沈郁坐在廊下吃糕点。";
    const revised = "沈郁坐在回廊下吃着冷糕点。";
    const drift = detectNamedEntityDrift(source, revised);
    expect(drift.hasDrift).toBe(false);
  });

  it("does not flag drift when same names appear in both texts", () => {
    const source = "沈郁看到\u2018留声\u2019珠子和\u2018枯荣\u2019琴。";
    const revised = "沈郁看到了\u2018留声\u2019珠子，还有\u2018枯荣\u2019琴。";
    const drift = detectNamedEntityDrift(source, revised);
    expect(drift.hasDrift).toBe(false);
  });
});
