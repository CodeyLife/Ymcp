import { randomUUID } from "node:crypto";
import type { Client } from "@temporalio/client";
import type { NovelPostgresRepository } from "../postgres-repository";

export async function startStoryArcPlanning(
  repository: NovelPostgresRepository,
  temporal: Client,
  input: { projectId: string; mode: "web" | "mcp"; reviewPolicy?: "manual" | "auto"; authorIntent?: string; taskQueue?: string; arcId?: string },
) {
  const workflowId = `story-arc-${randomUUID()}`;
  const reviewPolicy = input.reviewPolicy ?? (input.mode === "mcp" ? "auto" : "manual");
  const arc = input.arcId
    ? await repository.markStoryArcGenerating(input.projectId, input.arcId, input.mode === "web" ? "web-author" : "mcp")
    : await repository.createNextStoryArc({ projectId: input.projectId, workflowId, authorIntent: input.authorIntent });
  if (!arc) throw new Error("故事弧不存在");
  await repository.putWorkflowRun({
    id: workflowId,
    workflowType: "story-arc-planning",
    projectId: input.projectId,
    temporalWorkflowId: workflowId,
    status: "accepted",
    payload: { arcId: arc.id, mode: input.mode, reviewPolicy, authorIntent: input.authorIntent, rebase: Boolean(input.arcId) },
  });
  const handle = await temporal.workflow.start("storyArcPlanningWorkflow", {
    args: [{ workflowId, projectId: input.projectId, arcId: arc.id, mode: input.mode, reviewPolicy, authorIntent: input.authorIntent }],
    taskQueue: input.taskQueue ?? "novel-v2",
    workflowId,
  });
  return { arcId: arc.id, workflowId, runId: handle.firstExecutionRunId, status: "accepted" };
}

export async function startStoryArcBatchPlanning(
  repository: NovelPostgresRepository,
  temporal: Client,
  input: { projectId: string; arcId: string; mode: "web" | "mcp"; reviewPolicy?: "manual" | "auto"; taskQueue?: string },
) {
  const workflowId = `story-arc-batch-${randomUUID()}`;
  const reviewPolicy = input.reviewPolicy ?? (input.mode === "mcp" ? "auto" : "manual");
  const batch = await repository.prepareNextStoryArcBatch(input.projectId, input.arcId);
  await repository.putWorkflowRun({
    id: workflowId,
    workflowType: "story-arc-planning",
    projectId: input.projectId,
    temporalWorkflowId: workflowId,
    status: "accepted",
    payload: { arcId: input.arcId, mode: input.mode, reviewPolicy, batchIndex: batch.batchIndex, startChapterIndex: batch.startChapterIndex },
  });
  try {
    const handle = await temporal.workflow.start("storyArcPlanningWorkflow", {
      args: [{ workflowId, projectId: input.projectId, arcId: input.arcId, mode: input.mode, reviewPolicy, ...batch }],
      taskQueue: input.taskQueue ?? "novel-v2",
      workflowId,
    });
    return { arcId: input.arcId, workflowId, runId: handle.firstExecutionRunId, status: "accepted", ...batch };
  } catch (error) {
    await repository.failStoryArcBatch(input.projectId, input.arcId, batch.batchIndex, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
