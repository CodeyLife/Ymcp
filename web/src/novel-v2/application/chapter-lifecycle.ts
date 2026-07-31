import type { Artifact, CommitResult, FactApprovalSummary, Review, ReviewIssue, RuntimeLearningAssessmentV2 } from "../protocol";
import type { ManuscriptStructuralReport } from "./manuscript-structure";
import { candidateQualityKey, DEFAULT_MAX_AUTO_REVISIONS, decideRevision, evaluateCommitGate, isCandidateQualityBetter } from "../temporal/revision-policy";

export type ChapterDraftState = { artifact: Artifact; text: string };

export interface ChapterLifecycleResult {
  draft: ChapterDraftState;
  reviews: Review[];
  iteration: number;
  finalScore: number;
  commitGate: ReturnType<typeof evaluateCommitGate>;
  structuralReport: ManuscriptStructuralReport;
  commitResult?: CommitResult;
  enrichmentError?: string;
  commitBlocked?: Record<string, unknown>;
  /** P0 #1：opt-in 人工事实审批门触发时返回（factApprovalMode="manual" 且存在 pending 事实）。 */
  factApprovalBlocked?: { pendingIds: string[]; factArtifact: Artifact };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function finalizeChapterLifecycle(params: {
  projectId: string;
  draft: ChapterDraftState;
  reviews: Review[];
  structuralReport: ManuscriptStructuralReport;
  commit(current: ChapterDraftState, reviews: Review[], factArtifact: Artifact | undefined, structuralReport: ManuscriptStructuralReport): Promise<CommitResult>;
  enrich(current: ChapterDraftState, commitResult: CommitResult, factArtifact?: Artifact): Promise<void>;
  assessLearning(current: ChapterDraftState, reviews: Review[]): Promise<RuntimeLearningAssessmentV2>;
  progress(payload: Record<string, unknown>): Promise<unknown>;
  factArtifact?: Artifact;
  assessPostCommitLearning?: boolean;
}): Promise<{ commitResult: CommitResult; enrichmentError?: string }> {
  const commitResult = await params.commit(params.draft, params.reviews, params.factArtifact, params.structuralReport);
  let enrichmentError: string | undefined;
  try {
    await params.enrich(params.draft, commitResult, params.factArtifact);
  } catch (error) {
    enrichmentError = failureMessage(error);
  }
  if (params.assessPostCommitLearning !== false) try {
    const postCommitReviews = enrichmentError
      ? [...params.reviews, {
          id: `enrichment-error:${commitResult.revisionId}`,
          projectId: params.projectId,
          artifactId: params.draft.artifact.id,
          reviewerId: "enrichment-worker",
          identity: "internal" as const,
          verdict: "passed" as const,
          issues: [{ severity: "warning" as const, title: "角色富化失败", description: enrichmentError, evidence: `revisionId=${commitResult.revisionId}`, rule: "commit.enrichment-failure" }],
          createdAt: Date.now(),
          artifactFingerprint: params.draft.artifact.fingerprint,
        }]
      : params.reviews;
    await params.assessLearning(params.draft, postCommitReviews);
  } catch (error) {
    await params.progress({ stage: "post-commit-learning-failed", error: failureMessage(error) });
  }
  return { commitResult, enrichmentError };
}

/** Shared application lifecycle for Temporal and isolated experiments. */
export async function runChapterLifecycle(params: {
  projectId: string;
  initialDraft: ChapterDraftState;
  inspect(current: ChapterDraftState): Promise<{ report: ManuscriptStructuralReport; review: Review }>;
  review(current: ChapterDraftState): Promise<Review[]>;
  revise(current: ChapterDraftState, reviews: Review[], iteration: number, directedIssues?: ReviewIssue[]): Promise<ChapterDraftState>;
  assessLearning(current: ChapterDraftState, reviews: Review[]): Promise<RuntimeLearningAssessmentV2>;
  extractFacts(current: ChapterDraftState): Promise<Artifact>;
  approveFacts(factArtifact: Artifact, current: ChapterDraftState): Promise<FactApprovalSummary>;
  commit(current: ChapterDraftState, reviews: Review[], factArtifact: Artifact, structuralReport: ManuscriptStructuralReport): Promise<CommitResult>;
  enrich(current: ChapterDraftState, commitResult: CommitResult, factArtifact?: Artifact): Promise<void>;
  progress(payload: Record<string, unknown>): Promise<unknown>;
  beforeRevision?(iteration: number): Promise<void>;
  afterRevision?(draft: ChapterDraftState, iteration: number): Promise<void>;
  commitBlocked?: Record<string, unknown>;
  directedRevision?: {
    issues: ReviewIssue[];
    requireManuscriptApproval: true;
    baseline?: { reviews: Review[]; structuralReport: ManuscriptStructuralReport };
  };
  learningMode?: "legacy-each-stage" | "terminal-candidate";
  /** Temporal patch compatibility for targeted runs started before revision-first ordering. */
  reviewBeforeDirectedRevision?: boolean;
  /** Preserve a newly reviewed directed-revision source when the revision does not improve it. */
  preserveDirectedRevisionCandidate?: boolean;
  /** P0 #1：为 true 时，若 approveFacts 返回 pending>0，则在 commit 前返回 factApprovalBlocked 交由工作流走人工审批。 */
  requireManualFactApproval?: boolean;
}): Promise<ChapterLifecycleResult> {
  let draft = params.initialDraft;
  let previousScore: number | undefined;
  let iteration = 0;
  const reviewCandidate = async (current: ChapterDraftState) => {
    const inspected = await params.inspect(current);
    if (!inspected.report.passed) return { structuralReport: inspected.report, reviews: [inspected.review] };
    return { structuralReport: inspected.report, reviews: [inspected.review, ...await params.review(current)] };
  };

  if (params.directedRevision) {
    if (params.reviewBeforeDirectedRevision) {
      let evaluated = await reviewCandidate(draft);
      let reviews = evaluated.reviews;
      const baselineDraft = draft;
      const baselineEvaluation = evaluated;
      const baselineQuality = candidateQualityKey(reviews, evaluated.structuralReport);
      await params.progress({ stage: "revision-decision", iteration: 0, decision: "directed-revision", targetIssueCount: params.directedRevision.issues.length });
      if (params.learningMode !== "terminal-candidate") await params.assessLearning(draft, reviews);
      await params.beforeRevision?.(1);
      draft = await params.revise(draft, reviews, 1, params.directedRevision.issues);
      await params.afterRevision?.(draft, 1);
      evaluated = await reviewCandidate(draft);
      reviews = evaluated.reviews;
      const revisedQuality = candidateQualityKey(reviews, evaluated.structuralReport);
      if (params.preserveDirectedRevisionCandidate && !isCandidateQualityBetter(revisedQuality, baselineQuality)) {
        await params.progress({ stage: "revision-reverted", iteration: 1, reason: `定向修订降低质量，保留原候选 structural=${baselineQuality.structuralPassed} blocker=${baselineQuality.blockerCount} major=${baselineQuality.majorCount} min=${baselineQuality.minimumReviewerScore.toFixed(2)} score=${baselineQuality.overallScore.toFixed(2)}` });
        draft = baselineDraft;
        evaluated = baselineEvaluation;
        reviews = baselineEvaluation.reviews;
      }
      await params.progress({ stage: "manuscript-approval", iteration: 1, decision: "targeted-revision-completed", targetIssueCount: params.directedRevision.issues.length });
      await params.assessLearning(draft, reviews);
      const finalDecision = decideRevision({ reviews, iteration: 1, maxIterations: 1, previousScore: undefined });
      return {
        draft,
        reviews,
        iteration: 1,
        finalScore: finalDecision.currentScore,
        structuralReport: evaluated.structuralReport,
        commitGate: evaluateCommitGate(reviews, draft.artifact.fingerprint, evaluated.structuralReport),
        commitBlocked: { reasonCode: "targeted-manuscript-approval", targetIssueCount: params.directedRevision.issues.length },
      };
    }
    const directedReviews: Review[] = [{
      id: `directed-review:${draft.artifact.id}`,
      projectId: params.projectId,
      artifactId: draft.artifact.id,
      reviewerId: "author-selected-review-issues",
      identity: "human",
      verdict: "revise",
      issues: params.directedRevision.issues,
      artifactFingerprint: draft.artifact.fingerprint,
      createdAt: 0,
    }];
    await params.progress({ stage: "revision", iteration: 0, decision: "directed-revision", targetIssueCount: params.directedRevision.issues.length });
    if (params.learningMode !== "terminal-candidate") await params.assessLearning(draft, directedReviews);
    await params.beforeRevision?.(1);
    draft = await params.revise(draft, directedReviews, 1, params.directedRevision.issues);
    await params.afterRevision?.(draft, 1);
    iteration = 1;
    let evaluated = await reviewCandidate(draft);
    let reviews = evaluated.reviews;
    if (params.directedRevision.baseline) {
      const revisedQuality = candidateQualityKey(reviews, evaluated.structuralReport);
      const baselineQuality = candidateQualityKey(params.directedRevision.baseline.reviews, params.directedRevision.baseline.structuralReport);
      if (!isCandidateQualityBetter(revisedQuality, baselineQuality)) {
        await params.progress({ stage: "revision-reverted", iteration, reason: `定向修订降低质量，保留原候选 structural=${baselineQuality.structuralPassed} blocker=${baselineQuality.blockerCount} major=${baselineQuality.majorCount} min=${baselineQuality.minimumReviewerScore.toFixed(2)} score=${baselineQuality.overallScore.toFixed(2)}` });
        draft = params.initialDraft;
        evaluated = { structuralReport: params.directedRevision.baseline.structuralReport, reviews: params.directedRevision.baseline.reviews };
        reviews = evaluated.reviews;
      }
    }
    await params.progress({ stage: "manuscript-approval", iteration, decision: "targeted-revision-completed", targetIssueCount: params.directedRevision.issues.length });
    await params.assessLearning(draft, reviews);
    const finalDecision = decideRevision({ reviews, iteration, maxIterations: 1, previousScore: undefined });
    return {
      draft,
      reviews,
      iteration,
      finalScore: finalDecision.currentScore,
      structuralReport: evaluated.structuralReport,
      commitGate: evaluateCommitGate(reviews, draft.artifact.fingerprint, evaluated.structuralReport),
      commitBlocked: {
        reasonCode: "targeted-manuscript-approval",
        targetIssueCount: params.directedRevision.issues.length,
      },
    };
  }
  let evaluated = await reviewCandidate(draft);
  let reviews = evaluated.reviews;
  let structuralReport = evaluated.structuralReport;
  // Best-draft tracking: auto-revision can degrade quality (observed: 4.9 → 4.0,
  // improvement -0.90). The revision loop correctly stops on degradation, but
  // previously kept the degraded draft. Tracking the best version across all
  // iterations ensures commit/fact-extraction/learning always use the best draft.
  //
  // "Better" is defined as: no-blocker always beats has-blocker; within the same
  // blocker status, higher score wins. This prevents reverting to a blocker draft
  // when the revision removed the blocker but lowered the overall score.
  let bestDraft = draft;
  let bestReviews = reviews;
  let bestStructuralReport = structuralReport;
  let bestQuality = candidateQualityKey(reviews, structuralReport);

  while (true) {
    const decision = decideRevision({ reviews, iteration, maxIterations: DEFAULT_MAX_AUTO_REVISIONS, previousScore });
    await params.progress({ stage: "revision-decision", iteration, decision: decision.reason, currentScore: decision.currentScore });
    if (!decision.shouldRevise) break;
    if (params.learningMode !== "terminal-candidate") await params.assessLearning(draft, reviews);
    await params.beforeRevision?.(iteration + 1);
    draft = await params.revise(draft, reviews, iteration + 1);
    await params.afterRevision?.(draft, iteration + 1);
    previousScore = decision.currentScore;
    iteration += 1;
    evaluated = await reviewCandidate(draft);
    reviews = evaluated.reviews;
    structuralReport = evaluated.structuralReport;

    // Update best-draft tracking if this revision is strictly better.
    const revisedQuality = candidateQualityKey(reviews, structuralReport);
    const isBetter = isCandidateQualityBetter(revisedQuality, bestQuality);
    if (isBetter) {
      bestQuality = revisedQuality;
      bestDraft = draft;
      bestReviews = reviews;
      bestStructuralReport = structuralReport;
    }
  }

  // If auto-revision degraded quality, revert to the best-scoring draft.
  if (bestDraft !== draft) {
    await params.progress({ stage: "revision-reverted", iteration, reason: `修订降低质量，回退至最佳版本 structural=${bestQuality.structuralPassed} blocker=${bestQuality.blockerCount} major=${bestQuality.majorCount} min=${bestQuality.minimumReviewerScore.toFixed(2)} score=${bestQuality.overallScore.toFixed(2)}` });
    draft = bestDraft;
    reviews = bestReviews;
    structuralReport = bestStructuralReport;
  }

  await params.assessLearning(draft, reviews);
  const finalDecision = decideRevision({ reviews, iteration, maxIterations: DEFAULT_MAX_AUTO_REVISIONS, previousScore });
  const commitGate = evaluateCommitGate(reviews, draft.artifact.fingerprint, structuralReport);
  if (params.commitBlocked) return { draft, reviews, iteration, finalScore: finalDecision.currentScore, structuralReport, commitGate, commitBlocked: params.commitBlocked };
  if (!commitGate.passed) return { draft, reviews, iteration, finalScore: finalDecision.currentScore, structuralReport, commitGate };

  // Facts are durable manuscript state. Extract them only after the review gate
  // passes so manual approval can follow the same approval -> facts -> commit order.
  const factArtifact = await params.extractFacts(draft);
  const factApproval = await params.approveFacts(factArtifact, draft);
  // P0 #1: opt-in 人工事实审批门。存在 pending 事实时提前返回，交由工作流等待作者确认。
  if (params.requireManualFactApproval && factApproval.pending > 0) {
    return { draft, reviews, iteration, finalScore: finalDecision.currentScore, structuralReport, commitGate, factApprovalBlocked: { pendingIds: factApproval.pendingIds, factArtifact } };
  }
  const { commitResult, enrichmentError } = await finalizeChapterLifecycle({
    projectId: params.projectId,
    draft,
    reviews,
    structuralReport,
    commit: params.commit,
    enrich: params.enrich,
    assessLearning: params.assessLearning,
    progress: params.progress,
    factArtifact,
    assessPostCommitLearning: params.learningMode !== "terminal-candidate",
  });
  return { draft, reviews, iteration, finalScore: finalDecision.currentScore, structuralReport, commitGate, commitResult, enrichmentError };
}
