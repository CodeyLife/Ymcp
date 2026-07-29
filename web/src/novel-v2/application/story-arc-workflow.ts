import { randomUUID } from "node:crypto";
import type { Client } from "@temporalio/client";
import type { NovelPostgresRepository } from "../postgres-repository";

export async function startStoryArcPlanning(
  repository: NovelPostgresRepository,
  temporal: Client,
  input: { projectId: string; mode: "web" | "mcp"; authorIntent?: string; taskQueue?: string; arcId?: string },
) {
  const workflowId = `story-arc-${randomUUID()}`;
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
    payload: { arcId: arc.id, mode: input.mode, authorIntent: input.authorIntent, rebase: Boolean(input.arcId) },
  });
  const handle = await temporal.workflow.start("storyArcPlanningWorkflow", {
    args: [{ workflowId, projectId: input.projectId, arcId: arc.id, mode: input.mode, authorIntent: input.authorIntent }],
    taskQueue: input.taskQueue ?? "novel-v2",
    workflowId,
  });
  return { arcId: arc.id, workflowId, runId: handle.firstExecutionRunId, status: "accepted" };
}
