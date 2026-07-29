import type { Client } from "@temporalio/client";
import { createCreativeRun, enqueueCreativeWork, getRunSnapshot } from "../creative";
import type { NovelPostgresRepository } from "../postgres-repository";
import { PROJECT_PLAN_STAGES } from "./project-plan";

export const FOUNDATION_TASK_CHAIN = PROJECT_PLAN_STAGES;

export interface StartBootstrapInput {
  projectId: string;
  objective: string;
  idempotencyKey: string;
  includeChapterPlan?: boolean;
  progression?: "automatic" | "user-driven";
  reviewGate?: "manual" | "auto" | "none";
  taskQueue?: string;
}

/**
 * Creates and starts the durable foundation workflow used by HTTP and MCP.
 * The CreativeRun id is also the workflow_runs id and Temporal workflow id so
 * model tasks, signals, persisted status, and Temporal history share one key.
 */
export async function startNovelBootstrap(
  repository: NovelPostgresRepository,
  temporal: Client,
  input: StartBootstrapInput,
) {
  // chapter-plan 已由滚动故事弧蓝图替代。保留入参仅用于旧客户端兼容。
  const includeChapterPlan = false;
  const existingId = await repository.findBootstrapRunId(input.projectId, input.idempotencyKey);
  if (existingId) {
    const snapshot = await getRunSnapshot(repository, existingId);
    if (snapshot) {
      return {
        run: snapshot.run,
        workItems: snapshot.workItems.map((item) => item.id),
        taskChain: snapshot.workItems.map((item) => item.taskKey).filter((value): value is string => Boolean(value)),
        workflowId: snapshot.run.id,
        temporalRunId: undefined,
        reused: true,
      };
    }
  }

  const run = await createCreativeRun(repository, {
    projectId: input.projectId,
    mode: "chapter",
    policy: {
      reviewGate: input.reviewGate ?? "none",
      progression: input.progression ?? "automatic",
    },
    payload: {
      objective: input.objective,
      includeChapterPlan,
      bootstrap: true,
      bootstrapKey: input.idempotencyKey,
    },
  });

  const taskChain = [
    ...FOUNDATION_TASK_CHAIN.map((task) => ({
      taskKey: task.taskKey,
      dependsOn: [...task.dependsOn],
      instruction: `${task.instruction}。项目目标：${input.objective}`,
    })),
  ];

  const workItems: string[] = [];
  const workItemByTaskKey = new Map<string, string>();
  for (const task of taskChain) {
    const dependsOn = task.dependsOn.map((taskKey) => {
      const workItemId = workItemByTaskKey.get(taskKey);
      if (!workItemId) throw new Error(`foundation DAG 引用了尚未定义的依赖：${task.taskKey} -> ${taskKey}`);
      return workItemId;
    });
    const item = await enqueueCreativeWork(repository, run.id, {
      kind: "generation",
      taskKey: task.taskKey,
      instruction: task.instruction,
      dependsOn,
      parameters: { bootstrap: true },
    });
    workItems.push(item.id);
    workItemByTaskKey.set(task.taskKey, item.id);
  }
  await repository.initializeProjectPlan({
    projectId: input.projectId,
    workItemByTaskKey,
    includedTaskKeys: taskChain.map((task) => task.taskKey),
  });

  const workflowId = run.id;
  await repository.putWorkflowRun({
    id: workflowId,
    workflowType: "creative-run",
    projectId: input.projectId,
    temporalWorkflowId: workflowId,
    status: "accepted",
    payload: {
      runId: run.id,
      objective: input.objective,
      includeChapterPlan,
      bootstrapKey: input.idempotencyKey,
    },
  });
  const handle = await temporal.workflow.start("creativeRunWorkflow", {
    args: [run.id],
    taskQueue: input.taskQueue ?? "novel-v2",
    workflowId,
  });

  return {
    run,
    workItems,
    taskChain: taskChain.map((task) => task.taskKey),
    workflowId,
    temporalRunId: handle.firstExecutionRunId,
    reused: false,
  };
}
