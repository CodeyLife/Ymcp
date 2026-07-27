import { defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type { Artifact, ExecutionBlueprint, MemoryBundle, NovelIntent, PreflightPlan, PreflightProjectSnapshot, Review, SkillBundle } from "../protocol";

export interface NovelWorkflowActivities {
  updateWorkflowStatus(input: { workflowId: string; status: string; payload?: Record<string, unknown> }): Promise<unknown>;
  loadProjectSnapshot(input: { projectId: string; targetDocumentId?: string }): Promise<PreflightProjectSnapshot>;
  createPreflight(input: { intent: NovelIntent; snapshot: PreflightProjectSnapshot }): Promise<PreflightPlan>;
  retrieveMemory(input: { projectId: string; plan: PreflightPlan }): Promise<MemoryBundle>;
  resolveSkills(input: { projectId: string; plan: PreflightPlan; memory: MemoryBundle; requestedCapabilities?: string[] }): Promise<SkillBundle>;
  compileBlueprint(input: { intent: NovelIntent; plan: PreflightPlan; memory: MemoryBundle; skills: SkillBundle; snapshot: PreflightProjectSnapshot }): Promise<ExecutionBlueprint>;
  draft(input: { intent: NovelIntent; blueprint: ExecutionBlueprint; memory: MemoryBundle; skills: SkillBundle }): Promise<{ artifact: Artifact; text: string }>;
  review(input: { artifact: Artifact; text: string; identity: "internal" | "independent" }): Promise<Review>;
  revise(input: { intent: NovelIntent; artifact: Artifact; text: string; reviews: Review[]; memory: MemoryBundle }): Promise<{ artifact: Artifact; text: string }>;
  extractFacts(input: { projectId: string; artifact: Artifact; text: string }): Promise<Artifact>;
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
  setHandler(claimSignal, (payload) => { signals.push({ type: "claim", payload }); });
  setHandler(heartbeatSignal, (payload) => { signals.push({ type: "heartbeat", payload }); });
  setHandler(artifactSignal, (payload) => { signals.push({ type: "artifact", payload }); });
  setHandler(reviewSignal, (payload) => { signals.push({ type: "review", payload }); });
  setHandler(failSignal, (payload) => { signals.push({ type: "fail", payload }); });
  setHandler(humanSignal, (payload) => { signals.push({ type: "humanSignal", payload }); });

  await activities.updateWorkflowStatus({ workflowId, status: "running" });
  try {
    const snapshot = await activities.loadProjectSnapshot({ projectId: intent.projectId, targetDocumentId: intent.target?.id });
    const plan = await activities.createPreflight({ intent, snapshot });
    const memory = await activities.retrieveMemory({ projectId: intent.projectId, plan });
    const skills = await activities.resolveSkills({ projectId: intent.projectId, plan, memory, requestedCapabilities: intent.requestedCapabilities });
    const blueprint = await activities.compileBlueprint({ intent, plan, memory, skills, snapshot });
    if (!intent.target?.id || plan.taskClass === "planning" || plan.taskClass === "foundation") {
      await activities.updateWorkflowStatus({ workflowId, status: "completed", payload: { blueprintId: blueprint.id, signalCount: signals.length } });
      return blueprint;
    }
    let draft = await activities.draft({ intent, blueprint, memory, skills });
    let reviews = [await activities.review({ artifact: draft.artifact, text: draft.text, identity: "internal" }), await activities.review({ artifact: draft.artifact, text: draft.text, identity: "independent" })];
    if (reviews.some((review) => review.verdict !== "passed")) {
      draft = await activities.revise({ intent, artifact: draft.artifact, text: draft.text, reviews, memory });
      reviews = [await activities.review({ artifact: draft.artifact, text: draft.text, identity: "internal" }), await activities.review({ artifact: draft.artifact, text: draft.text, identity: "independent" })];
    }
    await activities.extractFacts({ projectId: intent.projectId, artifact: draft.artifact, text: draft.text });
    if (reviews.some((review) => review.verdict !== "passed")) throw new Error("审核未通过，任务进入人工队列");
    await activities.commit({ projectId: intent.projectId, documentId: intent.target.id, artifact: draft.artifact, text: draft.text, reviews, baseRevision: blueprint.baseRevision, idempotencyKey: intent.idempotencyKey });
    await activities.updateWorkflowStatus({ workflowId, status: "completed", payload: { blueprintId: blueprint.id, signalCount: signals.length } });
    return blueprint;
  } catch (error) {
    await activities.updateWorkflowStatus({ workflowId, status: "failed", payload: { error: error instanceof Error ? error.message : String(error), signalCount: signals.length } });
    throw error;
  }
}
