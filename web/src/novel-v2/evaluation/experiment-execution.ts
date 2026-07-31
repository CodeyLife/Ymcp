import { randomUUID } from "node:crypto";
import { runChapterLifecycle } from "../application/chapter-lifecycle";
import type { ManuscriptStructuralReport } from "../application/manuscript-structure";
import { ContentObjectStore } from "../object-store";
import type { ModelGateway } from "../model-gateway";
import type { Artifact, NovelIntent, Review, RuntimeLearningAssessmentV2 } from "../protocol";
import type { ReviewerRole } from "../prompts/chapter-review";
import { createNovelWorkflowActivities } from "../temporal/activities";
import type { ExperimentWorkspaceHandle } from "./experiment-workspace";

const REVIEWERS: Array<{ role: ReviewerRole; identity: "internal" | "independent" }> = [
  { role: "plot-reviewer", identity: "internal" },
  { role: "continuity-reviewer", identity: "internal" },
  { role: "style-reviewer", identity: "independent" },
  { role: "character-reviewer", identity: "independent" },
  { role: "reader-reviewer", identity: "independent" },
];

export interface ExperimentExecutionResult {
  workflowRunId: string;
  reviews: Review[];
  learningAssessment?: RuntimeLearningAssessmentV2;
  artifact: Artifact;
  committed: boolean;
  finalScore: number;
  structuralReport: ManuscriptStructuralReport;
}

/** Run the formal chapter review lifecycle inside an isolated schema. */
export async function executeChapterReviewExperiment(input: {
  workspace: ExperimentWorkspaceHandle;
  model: ModelGateway;
  projectId: string;
  documentId: string;
  instruction?: string;
}): Promise<ExperimentExecutionResult> {
  const repository = input.workspace.createRepository();
  const objectStore = new ContentObjectStore();
  const activities = createNovelWorkflowActivities({
    repository,
    memoryProvider: { search: (request) => repository.searchMemory(request) },
    skillProvider: { list: (projectId) => repository.listSkills(projectId) },
    modelGateway: input.model,
    objectStore,
  });
  const workflowRunId = `experiment-review-${input.workspace.id}-${randomUUID()}`;
  let latestLearning: RuntimeLearningAssessmentV2 | undefined;
  try {
    await repository.putWorkflowRun({ id: workflowRunId, workflowType: "chapter-review-experiment", projectId: input.projectId, temporalWorkflowId: workflowRunId, status: "running", payload: { documentId: input.documentId, instruction: input.instruction, experimentId: input.workspace.id } });
    const snapshot = await activities.loadProjectSnapshot({ projectId: input.projectId, targetDocumentId: input.documentId });
    const blueprintRecord = await activities.loadHistoricalBlueprint({ projectId: input.projectId, documentId: input.documentId });
    const [documentState, routingSnapshot, memory, skills] = await Promise.all([
      activities.loadDocumentPlainText({ projectId: input.projectId, documentId: input.documentId }),
      activities.getDefaultRoutingSnapshot({ projectId: input.projectId, documentId: input.documentId }),
      activities.retrieveMemoryForReview({ projectId: input.projectId, documentId: input.documentId, blueprint: blueprintRecord.blueprint }),
      activities.resolveReviewSkills({ projectId: input.projectId, preflightId: blueprintRecord.blueprint.preflightId }),
    ]);
    const initialArtifact = await activities.createReviewDraft({ projectId: input.projectId, documentId: input.documentId, workflowId: workflowRunId, sourceRevisionId: documentState.sourceRevisionId, sourceArtifactId: documentState.artifactId, blueprint: blueprintRecord.blueprint, text: documentState.plainText, baseRevision: snapshot.currentRevision });

    const reviewOne = async (current: { artifact: Artifact; text: string }, role: ReviewerRole, identity: "internal" | "independent"): Promise<Review> => {
      const generated = await activities.review({ workflowId: workflowRunId, artifact: current.artifact, text: current.text, blueprint: blueprintRecord.blueprint, memory, skills, role, identity, routingSnapshot, narrativeOrder: snapshot.targetDocumentOrder });
      if (generated.kind !== "completed") throw new Error(`实验执行不允许等待 external-mcp：${generated.task.id}`);
      return generated.review;
    };
    const reviewAll = async (current: { artifact: Artifact; text: string }): Promise<Review[]> => {
      const settled = await Promise.allSettled(REVIEWERS.map(({ role, identity }) => reviewOne(current, role, identity)));
      const reviews = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      if (!reviews.some((review) => review.identity === "internal") || !reviews.some((review) => review.identity === "independent")) {
        const reasons = settled.flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []);
        throw new Error(`实验审校未形成双门证据：${reasons.join("；")}`);
      }
      return reviews;
    };
    const reviewIntent: NovelIntent = { id: workflowRunId, projectId: input.projectId, source: "chapter-review", objective: input.instruction?.trim() || "严苛审校并优化已定稿章节", target: { kind: "chapter", id: input.documentId, order: snapshot.targetDocumentOrder }, requestedStage: "revision", idempotencyKey: workflowRunId, createdAt: Date.now() };

    const lifecycle = await runChapterLifecycle({
      projectId: input.projectId,
      initialDraft: { artifact: initialArtifact, text: documentState.plainText },
      inspect: (current) => activities.inspectManuscript({ projectId: input.projectId, artifact: current.artifact, text: current.text }),
      review: reviewAll,
      revise: async (current, reviews) => {
        const generated = await activities.revise({ workflowId: workflowRunId, intent: reviewIntent, artifact: current.artifact, text: current.text, reviews, memory, blueprint: blueprintRecord.blueprint, skills, routingSnapshot });
        if (generated.kind !== "completed") throw new Error(`实验修订不允许等待 external-mcp：${generated.task.id}`);
        return generated;
      },
      assessLearning: async (current, reviews) => {
        const generated = await activities.assessLearning({ projectId: input.projectId, workflowId: workflowRunId, assessmentKey: `${current.artifact.id}:${reviews.length}`, artifact: current.artifact, reviews, routingSnapshot });
        if (generated.kind !== "completed") throw new Error(`实验学习评估不允许等待 external-mcp：${generated.task.id}`);
        latestLearning = generated.assessment;
        return generated.assessment;
      },
      extractFacts: async (current) => {
        const generated = await activities.extractFacts({ workflowId: workflowRunId, projectId: input.projectId, artifact: current.artifact, text: current.text, blueprint: blueprintRecord.blueprint, routingSnapshot, documentId: input.documentId, narrativeOrder: snapshot.targetDocumentOrder });
        if (generated.kind !== "completed") throw new Error(`实验事实提取不允许等待 external-mcp：${generated.task.id}`);
        return generated.artifact;
      },
      approveFacts: (factArtifact) => activities.approveFacts({ workflowId: workflowRunId, projectId: input.projectId, artifact: factArtifact }),
      commit: (current, reviews, factArtifact, structuralReport) => activities.commit({ projectId: input.projectId, documentId: input.documentId, artifact: current.artifact, factArtifact, narrativeOrder: snapshot.targetDocumentOrder, text: current.text, reviews, structuralReport, baseRevision: snapshot.currentRevision, idempotencyKey: workflowRunId }),
      enrich: async (current, commitResult, factArtifact) => {
        if (snapshot.targetDocumentOrder === undefined) return;
        const generated = await activities.enrichCharacters({ workflowId: workflowRunId, projectId: input.projectId, documentId: input.documentId, revisionId: commitResult.revisionId, narrativeOrder: snapshot.targetDocumentOrder, artifact: current.artifact, factArtifact, text: current.text, routingSnapshot });
        if (generated.kind !== "completed") throw new Error(`实验角色富化不允许等待 external-mcp：${generated.task.id}`);
      },
      progress: (payload) => repository.updateWorkflowRunStatus(workflowRunId, "running", payload),
    });
    await repository.updateWorkflowRunStatus(workflowRunId, lifecycle.commitResult ? "completed" : "manual-review-required", { finalScore: lifecycle.finalScore, artifactId: lifecycle.draft.artifact.id, reviewIds: lifecycle.commitGate.reviewIds, failedReviewIds: lifecycle.commitGate.failedReviewIds });
    return { workflowRunId, reviews: lifecycle.reviews, learningAssessment: latestLearning, artifact: lifecycle.draft.artifact, committed: Boolean(lifecycle.commitResult), finalScore: lifecycle.finalScore, structuralReport: lifecycle.structuralReport };
  } catch (error) {
    await repository.updateWorkflowRunStatus(workflowRunId, "failed", { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    throw error;
  } finally {
    await repository.close();
  }
}
