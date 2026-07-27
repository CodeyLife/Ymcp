import { defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type { Artifact, ContextManifest, ExecutionBlueprint, MemoryBundle, NovelIntent, PreflightPlan, PreflightProjectSnapshot, Review, RuntimeLearningAssessmentV2, SkillBundle, TaskAttemptRecord } from "../protocol";

export interface NovelWorkflowActivities {
  updateWorkflowStatus(input: { workflowId: string; status: string; payload?: Record<string, unknown> }): Promise<unknown>;
  loadProjectSnapshot(input: { projectId: string; targetDocumentId?: string }): Promise<PreflightProjectSnapshot>;
  createPreflight(input: { intent: NovelIntent; snapshot: PreflightProjectSnapshot }): Promise<PreflightPlan>;
  retrieveMemory(input: { projectId: string; plan: PreflightPlan }): Promise<MemoryBundle>;
  resolveSkills(input: { projectId: string; plan: PreflightPlan; memory: MemoryBundle; requestedCapabilities?: string[] }): Promise<SkillBundle>;
  compileBlueprint(input: { intent: NovelIntent; plan: PreflightPlan; memory: MemoryBundle; skills: SkillBundle; snapshot: PreflightProjectSnapshot }): Promise<{ blueprint: ExecutionBlueprint; context: ContextManifest }>;
  recordWorkflowSignal(input: { workflowId: string; taskId: string; signal: string; payload?: Record<string, unknown> }): Promise<unknown>;
  updateTaskAttempt(input: { id: string; workflowRunId?: string; taskId: string; status: TaskAttemptRecord["status"]; payload?: Record<string, unknown> }): Promise<unknown>;
  draft(input: { intent: NovelIntent; blueprint: ExecutionBlueprint; memory: MemoryBundle; skills: SkillBundle }): Promise<{ artifact: Artifact; text: string }>;
  review(input: { artifact: Artifact; text: string; identity: "internal" | "independent" }): Promise<Review>;
  revise(input: { intent: NovelIntent; artifact: Artifact; text: string; reviews: Review[]; memory: MemoryBundle }): Promise<{ artifact: Artifact; text: string }>;
  extractFacts(input: { projectId: string; artifact: Artifact; text: string }): Promise<Artifact>;
  assessLearning(input: { projectId: string; workflowId: string; artifact: Artifact; reviews: Review[] }): Promise<RuntimeLearningAssessmentV2>;
  commit(input: { projectId: string; documentId: string; artifact: Artifact; text: string; reviews: Review[]; baseRevision: number; idempotencyKey: string }): Promise<unknown>;
}

export const claimSignal = defineSignal<[unknown]>("claim");
export const heartbeatSignal = defineSignal<[unknown]>("heartbeat");
export const artifactSignal = defineSignal<[unknown]>("artifact");
export const reviewSignal = defineSignal<[unknown]>("review");
export const failSignal = defineSignal<[unknown]>("fail");
export const humanSignal = defineSignal<[unknown]>("humanSignal");

const activities = proxyActivities<NovelWorkflowActivities>({ startToCloseTimeout: "10 minutes", retry: { maximumAttempts: 3 } });

export async function novelIntentWorkflow(intent: NovelIntent, workflowId = `novel-intent-${intent.id}`): Promise<ExecutionBlueprint> {
  const signals: Array<{ type: string; payload: unknown }> = [];
  const persistSignal = async (type: string, payload: unknown) => {
    signals.push({ type, payload });
    const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    await activities.recordWorkflowSignal({ workflowId, taskId: typeof body.taskId === "string" ? body.taskId : `${workflowId}:external`, signal: type, payload: body });
  };
  setHandler(claimSignal, async (payload) => { await persistSignal("claim", payload); });
  setHandler(heartbeatSignal, async (payload) => { await persistSignal("heartbeat", payload); });
  setHandler(artifactSignal, async (payload) => { await persistSignal("artifact", payload); });
  setHandler(reviewSignal, async (payload) => { await persistSignal("review", payload); });
  setHandler(failSignal, async (payload) => { await persistSignal("fail", payload); });
  setHandler(humanSignal, async (payload) => { await persistSignal("humanSignal", payload); });

  await activities.updateWorkflowStatus({ workflowId, status: "running" });
  try {
    const snapshot = await activities.loadProjectSnapshot({ projectId: intent.projectId, targetDocumentId: intent.target?.id });
    const plan = await activities.createPreflight({ intent, snapshot });
    const memory = await activities.retrieveMemory({ projectId: intent.projectId, plan });
    const skills = await activities.resolveSkills({ projectId: intent.projectId, plan, memory, requestedCapabilities: intent.requestedCapabilities });
    const { blueprint } = await activities.compileBlueprint({ intent, plan, memory, skills, snapshot });
    if (!intent.target?.id || plan.taskClass === "planning" || plan.taskClass === "foundation") {
      await activities.updateWorkflowStatus({ workflowId, status: "completed", payload: { blueprintId: blueprint.id, signalCount: signals.length } });
      return blueprint;
    }
    await activities.updateTaskAttempt({ id: `${blueprint.id}:draft:attempt-1`, workflowRunId: workflowId, taskId: `${blueprint.id}:draft`, status: "running", payload: { taskKind: "draft" } });
    let draft = await activities.draft({ intent, blueprint, memory, skills });
    await activities.updateTaskAttempt({ id: draft.artifact.attemptId, workflowRunId: workflowId, taskId: draft.artifact.taskId, status: "submitted", payload: { artifactId: draft.artifact.id, fingerprint: draft.artifact.fingerprint } });
    await activities.updateTaskAttempt({ id: `${blueprint.id}:review:attempt-1`, workflowRunId: workflowId, taskId: `${blueprint.id}:review`, status: "running", payload: { taskKind: "review" } });
    let reviews = [await activities.review({ artifact: draft.artifact, text: draft.text, identity: "internal" }), await activities.review({ artifact: draft.artifact, text: draft.text, identity: "independent" })];
    await activities.updateTaskAttempt({ id: `${blueprint.id}:review:attempt-1`, workflowRunId: workflowId, taskId: `${blueprint.id}:review`, status: "reviewed", payload: { reviewIds: reviews.map((review) => review.id), verdicts: reviews.map((review) => review.verdict) } });
    if (reviews.some((review) => review.verdict !== "passed")) {
      await activities.assessLearning({ projectId: intent.projectId, workflowId, artifact: draft.artifact, reviews });
      await activities.updateTaskAttempt({ id: `${blueprint.id}:revise:attempt-1`, workflowRunId: workflowId, taskId: `${blueprint.id}:revise`, status: "running", payload: { taskKind: "revise" } });
      draft = await activities.revise({ intent, artifact: draft.artifact, text: draft.text, reviews, memory });
      reviews = [await activities.review({ artifact: draft.artifact, text: draft.text, identity: "internal" }), await activities.review({ artifact: draft.artifact, text: draft.text, identity: "independent" })];
      await activities.updateTaskAttempt({ id: draft.artifact.attemptId, workflowRunId: workflowId, taskId: draft.artifact.taskId, status: "reviewed", payload: { artifactId: draft.artifact.id, reviewIds: reviews.map((review) => review.id) } });
    }
    await activities.extractFacts({ projectId: intent.projectId, artifact: draft.artifact, text: draft.text });
    await activities.assessLearning({ projectId: intent.projectId, workflowId, artifact: draft.artifact, reviews });
    if (reviews.some((review) => review.verdict !== "passed")) throw new Error("审核未通过，任务进入人工队列");
    await activities.commit({ projectId: intent.projectId, documentId: intent.target.id, artifact: draft.artifact, text: draft.text, reviews, baseRevision: blueprint.baseRevision, idempotencyKey: intent.idempotencyKey });
    await activities.updateTaskAttempt({ id: `${blueprint.id}:commit:attempt-1`, workflowRunId: workflowId, taskId: `${blueprint.id}:commit`, status: "completed", payload: { artifactId: draft.artifact.id } });
    await activities.updateWorkflowStatus({ workflowId, status: "completed", payload: { blueprintId: blueprint.id, signalCount: signals.length } });
    return blueprint;
  } catch (error) {
    await activities.updateWorkflowStatus({ workflowId, status: "failed", payload: { error: error instanceof Error ? error.message : String(error), signalCount: signals.length } });
    throw error;
  }
}
