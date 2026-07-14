import "./workflow-stages/index"; // 触发 handler 注册（显式导入目录 index，避免与 workflow-stages.ts 文件歧义）
import { novelDb, recordBase } from "./db";
import { APPROVAL_HANDLERS, STAGE_HANDLERS } from "./workflow-stages";
import {
  CHAPTER_WORKFLOW_ID,
  createAgentRecord,
  createApprovalProposal,
  failAgent,
  failRun,
  finishAgent,
  latestArtifact,
  saveArtifact,
  transition,
} from "./workflow-shared";
import type { WorkflowRun } from "./types";

// Re-export 公共 API（保持 UI 和测试的导入路径不变）
export { BUILTIN_CHAPTER_WORKFLOW, CHAPTER_WORKFLOW_ID, shouldAutoRevise } from "./workflow-shared";

export async function startChapterWorkflow(params: { projectId: string; documentId: string; instruction?: string; blocking?: boolean }) {
  const [project, document] = await Promise.all([novelDb.projects.get(params.projectId), novelDb.documents.get(params.documentId)]);
  if (!project || !document || document.projectId !== params.projectId) throw new Error("章节或项目不存在");
  const active = await novelDb.workflowRuns.where("projectId").equals(params.projectId).and((item) => item.targetDocumentId === params.documentId && !["completed", "cancelled", "failed"].includes(item.status)).first();
  if (active) return active;
  const run: WorkflowRun = { ...recordBase(params.projectId), workflowId: CHAPTER_WORKFLOW_ID, targetDocumentId: params.documentId, status: "running", currentStage: "context", stageIndex: 0, revisionIteration: 0, factCandidateIds: [], startedAt: Date.now() };
  await novelDb.workflowRuns.add(run);
  if (params.instruction) await saveArtifact(run, { projectId: run.projectId, workflowRunId: run.id, stage: "context", kind: "prompt", title: "用户创作要求", contentMarkdown: params.instruction, skillRefs: [] });
  if (params.blocking === false) {
    advanceChapterWorkflow(run.id).catch((error) => { void failRun(run, error); });
    return run;
  }
  return advanceChapterWorkflow(run.id);
}

export async function advanceChapterWorkflow(runId: string): Promise<WorkflowRun> {
  let run = await novelDb.workflowRuns.get(runId);
  if (!run) throw new Error("工作流不存在");
  if (["waiting-approval", "paused", "completed", "cancelled"].includes(run.status)) return run;
  try {
    for (let guard = 0; guard < 20 && run.status === "running"; guard += 1) {
      const project = await novelDb.projects.get(run.projectId);
      const document = await novelDb.documents.get(run.targetDocumentId);
      if (!project || !document) throw new Error("工作流目标已不存在");
      const handler = STAGE_HANDLERS.get(run.currentStage);
      if (!handler) throw new Error(`未知 stage：${run.currentStage}`);
      const result = await handler.execute({
        run,
        project,
        document,
        saveArtifact,
        latestArtifact,
        transition,
        createAgentRecord,
        finishAgent,
        failAgent,
        createApprovalProposal,
      });
      run = result.run;
      if (result.continueLoop === false) break;
    }
    return run;
  } catch (error) {
    return failRun(run, error);
  }
}

export async function approveWorkflowStage(runId: string, params: { approved: boolean; feedback?: string; manuscriptChangeIds?: string[] }) {
  const run = await novelDb.workflowRuns.get(runId);
  if (!run || run.status !== "waiting-approval") throw new Error("工作流当前不在审批状态");
  const handler = APPROVAL_HANDLERS.get(run.currentStage);
  if (!handler) throw new Error(`未知审批阶段：${run.currentStage}`);
  const nextRun = await handler.approve({ run, transition, saveArtifact }, params);
  // approval handler 完成 transition 后，若进入 running 状态则自动推进工作流
  if (nextRun.status === "running") return advanceChapterWorkflow(nextRun.id);
  return nextRun;
}

export async function pauseWorkflow(runId: string) {
  const run = await novelDb.workflowRuns.get(runId);
  if (!run || !["running", "waiting-approval"].includes(run.status)) return run;
  return transition(run, run.currentStage, "paused");
}

export async function resumeWorkflow(runId: string) {
  const run = await novelDb.workflowRuns.get(runId);
  if (!run || !["paused", "failed"].includes(run.status)) return run;
  const isApprovalStage = run.currentStage.endsWith("-approval");
  const targetStatus = isApprovalStage ? "waiting-approval" : "running";
  const resumed = await transition(run, run.currentStage, targetStatus, { error: undefined });
  if (isApprovalStage) return resumed;
  return advanceChapterWorkflow(resumed.id);
}

export async function cancelWorkflow(runId: string) {
  const run = await novelDb.workflowRuns.get(runId);
  if (!run || ["completed", "cancelled"].includes(run.status)) return run;
  return transition(run, run.currentStage, "cancelled", { finishedAt: Date.now() });
}
