import type { Artifact, CommitResult, FactApprovalSummary, Review, RuntimeLearningAssessmentV2 } from "../protocol";
import { DEFAULT_MAX_AUTO_REVISIONS, decideRevision, evaluateCommitGate } from "../temporal/revision-policy";

export type ChapterDraftState = { artifact: Artifact; text: string };

export interface ChapterLifecycleResult {
  draft: ChapterDraftState;
  reviews: Review[];
  iteration: number;
  finalScore: number;
  commitGate: ReturnType<typeof evaluateCommitGate>;
  commitResult?: CommitResult;
  enrichmentError?: string;
  commitBlocked?: Record<string, unknown>;
  /** P0 #1：opt-in 人工事实审批门触发时返回（factApprovalMode="manual" 且存在 pending 事实）。 */
  factApprovalBlocked?: { pendingIds: string[] };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function finalizeChapterLifecycle(params: {
  projectId: string;
  draft: ChapterDraftState;
  reviews: Review[];
  commit(current: ChapterDraftState, reviews: Review[]): Promise<CommitResult>;
  enrich(current: ChapterDraftState, commitResult: CommitResult): Promise<void>;
  assessLearning(current: ChapterDraftState, reviews: Review[]): Promise<RuntimeLearningAssessmentV2>;
  progress(payload: Record<string, unknown>): Promise<unknown>;
}): Promise<{ commitResult: CommitResult; enrichmentError?: string }> {
  const commitResult = await params.commit(params.draft, params.reviews);
  let enrichmentError: string | undefined;
  try {
    await params.enrich(params.draft, commitResult);
  } catch (error) {
    enrichmentError = failureMessage(error);
  }
  try {
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
  review(current: ChapterDraftState): Promise<Review[]>;
  revise(current: ChapterDraftState, reviews: Review[], iteration: number): Promise<ChapterDraftState>;
  assessLearning(current: ChapterDraftState, reviews: Review[]): Promise<RuntimeLearningAssessmentV2>;
  extractFacts(current: ChapterDraftState): Promise<Artifact>;
  approveFacts(factArtifact: Artifact, current: ChapterDraftState): Promise<FactApprovalSummary>;
  commit(current: ChapterDraftState, reviews: Review[]): Promise<CommitResult>;
  enrich(current: ChapterDraftState, commitResult: CommitResult): Promise<void>;
  progress(payload: Record<string, unknown>): Promise<unknown>;
  beforeRevision?(iteration: number): Promise<void>;
  afterRevision?(draft: ChapterDraftState, iteration: number): Promise<void>;
  commitBlocked?: Record<string, unknown>;
  /** P0 #1：为 true 时，若 approveFacts 返回 pending>0，则在 commit 前返回 factApprovalBlocked 交由工作流走人工审批。 */
  requireManualFactApproval?: boolean;
}): Promise<ChapterLifecycleResult> {
  let draft = params.initialDraft;
  let reviews = await params.review(draft);
  let previousScore: number | undefined;
  let iteration = 0;

  while (true) {
    const decision = decideRevision({ reviews, iteration, maxIterations: DEFAULT_MAX_AUTO_REVISIONS, previousScore });
    await params.progress({ stage: "revision-decision", iteration, decision: decision.reason, currentScore: decision.currentScore });
    if (!decision.shouldRevise) break;
    await params.assessLearning(draft, reviews);
    await params.beforeRevision?.(iteration + 1);
    draft = await params.revise(draft, reviews, iteration + 1);
    await params.afterRevision?.(draft, iteration + 1);
    previousScore = decision.currentScore;
    iteration += 1;
    reviews = await params.review(draft);
  }

  await params.assessLearning(draft, reviews);
  const finalDecision = decideRevision({ reviews, iteration, maxIterations: DEFAULT_MAX_AUTO_REVISIONS, previousScore });
  const commitGate = evaluateCommitGate(reviews, draft.artifact.fingerprint);
  if (params.commitBlocked) return { draft, reviews, iteration, finalScore: finalDecision.currentScore, commitGate, commitBlocked: params.commitBlocked };
  if (!commitGate.passed) return { draft, reviews, iteration, finalScore: finalDecision.currentScore, commitGate };

  // Facts are durable manuscript state. Extract them only after the review gate
  // passes so manual approval can follow the same approval -> facts -> commit order.
  const factArtifact = await params.extractFacts(draft);
  const factApproval = await params.approveFacts(factArtifact, draft);
  // P0 #1: opt-in 人工事实审批门。存在 pending 事实时提前返回，交由工作流等待作者确认。
  if (params.requireManualFactApproval && factApproval.pending > 0) {
    return { draft, reviews, iteration, finalScore: finalDecision.currentScore, commitGate, factApprovalBlocked: { pendingIds: factApproval.pendingIds } };
  }
  const { commitResult, enrichmentError } = await finalizeChapterLifecycle({
    projectId: params.projectId,
    draft,
    reviews,
    commit: params.commit,
    enrich: params.enrich,
    assessLearning: params.assessLearning,
    progress: params.progress,
  });
  return { draft, reviews, iteration, finalScore: finalDecision.currentScore, commitGate, commitResult, enrichmentError };
}
