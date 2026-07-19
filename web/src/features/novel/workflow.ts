import "./workflow-stages/index"; // 触发 handler 注册（显式导入目录 index，避免与 workflow-stages.ts 文件歧义）
import { novelDb, recordBase, type NovelDatabase } from "./db";
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

export async function listDocumentWorkflowRuns(projectId: string, documentId: string, db: NovelDatabase = novelDb) {
  return db.workflowRuns
    .where("targetDocumentId")
    .equals(documentId)
    .filter((run) => run.projectId === projectId)
    .reverse()
    .sortBy("createdAt");
}

export async function assertPrecedingChaptersFinal(projectId: string, documentId: string, db: NovelDatabase = novelDb) {
  const document = await db.documents.get(documentId);
  if (!document || document.projectId !== projectId) throw new Error("章节或项目不存在");
  const unfinished = await db.documents
    .where("projectId")
    .equals(projectId)
    .filter((item) => !item.deletedAt && item.order < document.order && item.status !== "final")
    .sortBy("order");
  if (unfinished.length > 0) {
    throw new Error(`请先正式提交前置章节：${unfinished.map((item) => item.title).join("、")}。前章正文与事实未定稿时不能启动后章生产。`);
  }
}

export async function startChapterWorkflow(params: { projectId: string; documentId: string; threadId: string; briefId: string; instruction?: string; blocking?: boolean }, db: NovelDatabase = novelDb) {
  const [project, document] = await Promise.all([db.projects.get(params.projectId), db.documents.get(params.documentId)]);
  if (!project || !document || document.projectId !== params.projectId) throw new Error("章节或项目不存在");
  await assertPrecedingChaptersFinal(params.projectId, params.documentId, db);
  const [thread, brief] = await Promise.all([db.conversationThreads.get(params.threadId), db.creativeBriefs.get(params.briefId)]);
  if (!thread || thread.projectId !== params.projectId || thread.targetId !== params.documentId) throw new Error("协作对话与目标章节不匹配");
  if (!brief || brief.threadId !== thread.id || brief.targetDocumentId !== document.id || brief.status !== "confirmed") throw new Error("请先确认本章创作简报");
  const active = await db.workflowRuns.where("projectId").equals(params.projectId).and((item) => item.targetDocumentId === params.documentId && !["completed", "cancelled", "failed"].includes(item.status)).first();
  if (active) return active;
  const run: WorkflowRun = { ...recordBase(params.projectId), workflowId: CHAPTER_WORKFLOW_ID, targetDocumentId: params.documentId, status: "running", currentStage: "context", stageIndex: 0, revisionIteration: 0, factCandidateIds: [], conversationThreadId: thread.id, creativeBriefId: brief.id, startedAt: Date.now() };
  await db.workflowRuns.add(run);
  const briefInstruction = params.instruction?.trim() || [brief.goal, brief.tone ? `基调：${brief.tone}` : "", brief.languageRequirements.length ? `语言要求：${brief.languageRequirements.join("；")}` : "", brief.mustHappen.length ? `必写：${brief.mustHappen.join("；")}` : "", brief.forbidden.length ? `禁写：${brief.forbidden.join("；")}` : ""].filter(Boolean).join("\n");
  await saveArtifact(run, { projectId: run.projectId, workflowRunId: run.id, stage: "context", kind: "prompt", title: "已确认创作简报", contentMarkdown: briefInstruction, structuredData: { creativeBriefId: brief.id, threadId: thread.id }, skillRefs: [] }, db);
  if (params.blocking === false) {
    advanceChapterWorkflow(run.id, db).catch((error) => { void failRun(run, error, db); });
    return run;
  }
  return advanceChapterWorkflow(run.id, db);
}

export async function advanceChapterWorkflow(runId: string, db: NovelDatabase = novelDb): Promise<WorkflowRun> {
  let run = await db.workflowRuns.get(runId);
  if (!run) throw new Error("工作流不存在");
  if (["waiting-approval", "paused", "completed", "cancelled"].includes(run.status)) return run;
  try {
    for (let guard = 0; guard < 20 && run.status === "running"; guard += 1) {
      const project = await db.projects.get(run.projectId);
      const document = await db.documents.get(run.targetDocumentId);
      if (!project || !document) throw new Error("工作流目标已不存在");
      const handler = STAGE_HANDLERS.get(run.currentStage);
      if (!handler) throw new Error(`未知 stage：${run.currentStage}`);
      const result = await handler.execute({
        run,
        project,
        document,
        db,
        saveArtifact: (run: WorkflowRun, input: Parameters<typeof saveArtifact>[1]) => saveArtifact(run, input, db),
        latestArtifact: (runId: string, kinds: Parameters<typeof latestArtifact>[1]) => latestArtifact(runId, kinds, db),
        transition: (run: WorkflowRun, stage: Parameters<typeof transition>[1], status?: Parameters<typeof transition>[2], changes?: Parameters<typeof transition>[3]) => transition(run, stage, status, changes, db),
        createAgentRecord: (params: Parameters<typeof createAgentRecord>[0]) => createAgentRecord(params, db),
        finishAgent: (agent: Parameters<typeof finishAgent>[0], params: Parameters<typeof finishAgent>[1]) => finishAgent(agent, params, db),
        failAgent: (agent: Parameters<typeof failAgent>[0], error: Parameters<typeof failAgent>[1]) => failAgent(agent, error, db),
        createApprovalProposal: (run: WorkflowRun, artifact: Parameters<typeof createApprovalProposal>[1], operation: string, title: string) => createApprovalProposal(run, artifact, operation, title, db),
      });
      run = result.run;
      if (result.continueLoop === false) break;
    }
    return run;
  } catch (error) {
    return failRun(run, error, db);
  }
}

export async function approveWorkflowStage(runId: string, params: { approved: boolean; feedback?: string; manuscriptChangeIds?: string[] }, db: NovelDatabase = novelDb) {
  const run = await db.workflowRuns.get(runId);
  if (!run || run.status !== "waiting-approval") throw new Error("工作流当前不在审批状态");
  const handler = APPROVAL_HANDLERS.get(run.currentStage);
  if (!handler) throw new Error(`未知审批阶段：${run.currentStage}`);
  const nextRun = await handler.approve({
    run,
    db,
    transition: (run: WorkflowRun, stage: Parameters<typeof transition>[1], status?: Parameters<typeof transition>[2], changes?: Parameters<typeof transition>[3]) => transition(run, stage, status, changes, db),
    saveArtifact: (run: WorkflowRun, input: Parameters<typeof saveArtifact>[1]) => saveArtifact(run, input, db),
  }, params);
  // approval handler 完成 transition 后，若进入 running 状态则自动推进工作流
  if (nextRun.status === "running") return advanceChapterWorkflow(nextRun.id, db);
  return nextRun;
}

export async function pauseWorkflow(runId: string, db: NovelDatabase = novelDb) {
  const run = await db.workflowRuns.get(runId);
  if (!run || !["running", "waiting-approval"].includes(run.status)) return run;
  return transition(run, run.currentStage, "paused", {}, db);
}

export async function resumeWorkflow(runId: string, db: NovelDatabase = novelDb) {
  const run = await db.workflowRuns.get(runId);
  if (!run || !["paused", "failed"].includes(run.status)) return run;
  const isApprovalStage = run.currentStage.endsWith("-approval");
  const targetStatus = isApprovalStage ? "waiting-approval" : "running";
  const resumed = await transition(run, run.currentStage, targetStatus, { error: undefined }, db);
  if (isApprovalStage) return resumed;
  return advanceChapterWorkflow(resumed.id, db);
}

export async function cancelWorkflow(runId: string, db: NovelDatabase = novelDb) {
  const run = await db.workflowRuns.get(runId);
  if (!run || ["completed", "cancelled"].includes(run.status)) return run;
  return transition(run, run.currentStage, "cancelled", { finishedAt: Date.now() }, db);
}
