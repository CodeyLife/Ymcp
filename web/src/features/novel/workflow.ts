import "./workflow-stages/index"; // 触发 handler 注册（显式导入目录 index，避免与 workflow-stages.ts 文件歧义）
import { compileNovelContext } from "./context";
import { novelDb, recordBase, type NovelDatabase } from "./db";
import { APPROVAL_HANDLERS, STAGE_HANDLERS } from "./workflow-stages";
import {
  BUILTIN_CHAPTER_WORKFLOW,
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

interface ReusableChapterBlueprint {
  contentMarkdown: string;
  structuredData: Record<string, unknown>;
  model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function renderStoredChapterBlueprint(title: string, data: Record<string, unknown>) {
  const list = (value: unknown) => Array.isArray(value) && value.length > 0
    ? value.map((item) => `- ${String(item)}`).join("\n")
    : "- 无";
  return `# ${title}\n\n## 目标字数\n${String(data.targetWords ?? 5000)} 字\n\n## 章节目标\n${String(data.objective ?? "")}\n\n## 核心冲突\n${String(data.conflict ?? "")}\n\n## 信息释放\n${list(data.informationRelease)}\n\n## 必须发生\n${list(data.mustHappen)}\n\n## 可调整事项\n${list(data.flexible)}\n\n## 禁止事项\n${list(data.forbidden)}\n\n## 章尾驱动力\n${String(data.endingHook ?? "")}`;
}

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

export async function findReusableChapterBlueprint(projectId: string, documentId: string, db: NovelDatabase = novelDb): Promise<ReusableChapterBlueprint | undefined> {
  const priorRuns = (await listDocumentWorkflowRuns(projectId, documentId, db))
    .filter((item) => item.status === "completed" && item.blueprintArtifactId)
    .sort((left, right) => (right.finishedAt ?? right.updatedAt) - (left.finishedAt ?? left.updatedAt));
  for (const priorRun of priorRuns) {
    const artifact = await db.workflowArtifacts.get(priorRun.blueprintArtifactId!);
    if (artifact?.workflowRunId === priorRun.id && artifact.kind === "blueprint" && artifact.stage === "blueprint" && artifact.structuredData) {
      return { contentMarkdown: artifact.contentMarkdown, structuredData: artifact.structuredData, model: artifact.model };
    }
  }

  // 隔离闭环只把晋升结果与 provenance 写回正式库，不复制实验 WorkflowRun/Artifact。
  // 只有晋升 receipt、当前批准 revision 和候选的 blueprint 阶段证据形成完整链路时，
  // 才允许使用正式 document.blueprint；这样不会降级复用失败或未批准候选。
  const document = await db.documents.get(documentId);
  if (!document || document.projectId !== projectId || document.status !== "final" || !document.approvedRevisionId) return undefined;
  const approvedRevision = await db.revisions.get(document.approvedRevisionId);
  if (!approvedRevision || approvedRevision.projectId !== projectId || approvedRevision.documentId !== documentId || approvedRevision.approvalStatus !== "approved") return undefined;

  const completedWorks = await db.creativeWorkItems
    .where("projectId")
    .equals(projectId)
    .filter((item) => item.kind === "chapter-workflow" && item.status === "completed" && item.targetId === documentId)
    .toArray();
  completedWorks.sort((left, right) => right.updatedAt - left.updatedAt);
  for (const work of completedWorks) {
    const candidate = work.parameters.closedLoopCandidate;
    if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.sourceProjectId !== projectId) continue;
    const target = candidate.targetDocument;
    const manuscript = candidate.manuscript;
    const provenance = candidate.provenance;
    if (!isRecord(target) || target.documentId !== documentId || !isRecord(manuscript) || typeof manuscript.sourceWorkflowRunId !== "string" || !isRecord(provenance)) continue;
    if (!work.artifactRefs.includes(candidate.id)) continue;

    const artifactIds = Array.isArray(provenance.workflowArtifactIds)
      ? provenance.workflowArtifactIds.filter((item): item is string => typeof item === "string")
      : [];
    const stageEvidence = Array.isArray(provenance.stagePromptEvidence)
      ? provenance.stagePromptEvidence.find((item) => isRecord(item) && item.stage === "blueprint" && typeof item.artifactId === "string")
      : undefined;
    const blueprintArtifactId = stageEvidence && typeof stageEvidence.artifactId === "string" ? stageEvidence.artifactId : undefined;
    if (!blueprintArtifactId || !artifactIds.includes(blueprintArtifactId) || !blueprintArtifactId.startsWith(`artifact:${manuscript.sourceWorkflowRunId}:blueprint:`)) continue;

    const receipt = await db.operationReceipts
      .where("[candidateId+status]")
      .equals([candidate.id, "completed"])
      .filter((item) => item.projectId === projectId && item.action === "promote-candidate")
      .first();
    const promotedRevisionId = receipt?.receipts.revisionId;
    if (!promotedRevisionId || !work.artifactRefs.includes(promotedRevisionId)) continue;
    const promotedRevision = await db.revisions.get(promotedRevisionId);
    if (!promotedRevision
      || promotedRevision.projectId !== projectId
      || promotedRevision.documentId !== documentId
      || !["approved", "superseded"].includes(promotedRevision.approvalStatus ?? "")) continue;

    const structuredData: Record<string, unknown> = { title: document.title, ...document.blueprint };
    return {
      contentMarkdown: renderStoredChapterBlueprint(document.title, structuredData),
      structuredData,
      model: typeof provenance.model === "string" ? provenance.model : undefined,
    };
  }
  return undefined;
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

/**
 * 启动"章节审校优化"工作流：对已 final 但内容不完美的章节，复用正式章节生成的审核+优化闭环。
 *
 * 设计原则（参考 AGENTS.md「章节审校工作流复用」）：
 * - 复用而非新建：从 review 阶段半截启动，复用 reviewStageHandler / revisionStageHandler /
 *   manuscriptApprovalHandler / factExtractionStageHandler / factApprovalHandler / commitStageHandler /
 *   characterEnrichmentStageHandler，不重写审核与修订逻辑。
 * - 产物回填：把 document.plainText 包装为 draft artifact、把历史 blueprint artifact 复用为
 *   blueprint artifact，使 review-stage 能拿到 draft+blueprint+contextPacket 三件套。
 * - 不跳过 fact-extraction/commit：让 fact-extraction 用 novelty 字段去重，commit-stage 更新
 *   document.plainText/contentHtml 并对新 revision 创建 chapter memory，保持与正式生成一致。
 *   // TODO P2：review-only 模式下 commit-stage 跳过 createChapterMemory 的去重策略待补充
 *
 * 前置条件：
 * - document.status === "final"（只对已定稿章节开放重审，未定稿章节走正式生成流程）
 * - 无活跃工作流（避免并发改写同一章节）
 * - 存在历史 blueprint artifact，或存在可核验的正式候选晋升链路。前者保留完整
 *   structuredData；后者使用晋升后正式存储的 document.blueprint。
 *
 * @param params.projectId 项目 ID
 * @param params.documentId 章节 ID
 * @param params.instruction 可选审校指令（注入到 context packet）
 * @param params.blocking false 时异步推进，true 时阻塞至首次审批门禁
 */
export async function startChapterReviewWorkflow(params: { projectId: string; documentId: string; instruction?: string; blocking?: boolean }, db: NovelDatabase = novelDb) {
  const [project, document] = await Promise.all([db.projects.get(params.projectId), db.documents.get(params.documentId)]);
  if (!project || !document || document.projectId !== params.projectId) throw new Error("章节或项目不存在");
  if (document.status !== "final") throw new Error("章节审校优化仅对已定稿章节开放；未定稿章节请走正式生成流程");

  const active = await db.workflowRuns
    .where("targetDocumentId")
    .equals(params.documentId)
    .filter((item) => item.projectId === params.projectId && !["completed", "cancelled", "failed"].includes(item.status))
    .first();
  if (active) throw new Error("当前章节已有活跃工作流，请先完成或取消后再启动审校优化");

  // 优先复用历史 artifact 的完整 structuredData；隔离候选的实验 artifact 未写回正式库时，
  // findReusableChapterBlueprint 会在核验晋升链路后使用正式 document.blueprint。
  const priorBlueprint = await findReusableChapterBlueprint(params.projectId, params.documentId, db);
  if (!priorBlueprint) throw new Error("找不到历史章节蓝图：仅能复用已完成章节流程中的合法蓝图产物");

  // 编译审校上下文：task="chapter-review" 区分正式生成，stage="review" 让 skill 解析走审校分支
  const instruction = params.instruction?.trim() || `对已定稿章节《${document.title}》进行严苛读者视角审校与文案优化`;
  const packet = await compileNovelContext({
    projectId: params.projectId,
    task: "chapter-review",
    instruction,
    targetDocumentId: params.documentId,
    stage: "review",
    db,
    consumer: { workflowRunId: undefined, stage: "review", role: "quality-editor" },
  });

  // 创建 review-only run：currentStage="review"，stageIndex 指向 BUILTIN_CHAPTER_WORKFLOW.stages 中 review 的位置
  const reviewStageIndex = BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("review");
  const run: WorkflowRun = {
    ...recordBase(params.projectId),
    workflowId: CHAPTER_WORKFLOW_ID,
    targetDocumentId: params.documentId,
    status: "running",
    currentStage: "review",
    stageIndex: reviewStageIndex,
    revisionIteration: 0,
    factCandidateIds: [],
    // 不设置 conversationThreadId/creativeBriefId：review-stage 在无 threadId 时走 contextPacketId 路径
    contextPacketId: packet.id,
    startedAt: Date.now(),
  };
  await db.workflowRuns.add(run);
  await saveArtifact(run, {
    projectId: run.projectId,
    workflowRunId: run.id,
    stage: "context",
    kind: "prompt",
    title: "章节重审指令",
    contentMarkdown: instruction,
    structuredData: { mode: "chapter-review" },
    skillRefs: [],
    contextPacketId: packet.id,
  }, db);

  // 包装历史 blueprint 为本 run 的 blueprint artifact（structuredData 透传，contentMarkdown 复用历史）
  const blueprintArtifact = await saveArtifact(run, {
    projectId: run.projectId,
    workflowRunId: run.id,
    stage: "blueprint",
    kind: "blueprint",
    title: `${document.title}蓝图（审校复用）`,
    contentMarkdown: priorBlueprint.contentMarkdown,
    structuredData: priorBlueprint.structuredData,
    model: priorBlueprint.model,
    skillRefs: [],
    contextPacketId: packet.id,
  }, db);

  // 包装 document.plainText 为本 run 的 draft artifact
  const draftArtifact = await saveArtifact(run, {
    projectId: run.projectId,
    workflowRunId: run.id,
    stage: "draft",
    kind: "draft",
    title: `${document.title}正文（审校前）`,
    contentMarkdown: document.plainText,
    model: project.settings.textModel,
    skillRefs: [],
    contextPacketId: packet.id,
  }, db);

  // 把 artifact id 回填到 run，advanceChapterWorkflow 才能让 review-stage 拿到
  const initialized = await transition(run, "review", "running", {
    contextPacketId: packet.id,
    blueprintArtifactId: blueprintArtifact.id,
    draftArtifactId: draftArtifact.id,
  }, db);

  if (params.blocking === false) {
    advanceChapterWorkflow(initialized.id, db).catch((error) => { void failRun(initialized, error, db); });
    return initialized;
  }
  return advanceChapterWorkflow(initialized.id, db);
}
