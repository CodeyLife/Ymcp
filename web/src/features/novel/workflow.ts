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
  /**
   * true 表示 structuredData 来自 fallback 路径（隔离闭环候选晋升），
   * 缺失 beats/startingState 等 ChapterBlueprint 不存储的生成期字段，
   * 已用占位符补齐以满足 blueprintSchema。下游应感知降级状态并在提示中标注。
   *
   * false/undefined 表示 structuredData 来自正式库历史 blueprint artifact，字段完整。
   */
  degraded?: boolean;
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

    // F-002 修复 + TODO P1 契约违反标记：fallback 路径产出的 structuredData 来自 ChapterBlueprint 存储模型，
    // 缺失 beats/startingState 等 blueprintSchema required 字段（这些字段仅存在于
    // 实验库 blueprint artifact.structuredData，实验库删除后不可恢复）。
    //
    // 契约违反说明（AGENTS.md「章节审校工作流复用·产物回填契约」要求"保留 beats/title/startingState 等
    // ChapterBlueprint 不存储的字段"）：此处用占位字符串注入虚构 beats/startingState 而非真实字段，
    // 违反"reviewer 拿到真实蓝图"的契约意图。当前作为 isolation 闭环晋升章节的兜底保留，但属已知技术债。
    // 修复方向：（1）在 isolation 闭环晋升时同步快照 blueprint artifact.structuredData 到 document.blueprint
    // 持久化字段，避免后续实验库删除后不可读；（2）或扩展 blueprintSchema 让 degraded 路径可省略 beats 字段。
    // 任一修复落地后删除此 fallback 占位逻辑。
    const fallbackBlueprint = document.blueprint;
    const DEGRADED_PLACEHOLDER = "（降级复用：原 blueprint artifact 已不可读，请基于正文反向推断）";
    const structuredData: Record<string, unknown> = {
      title: document.title,
      ...fallbackBlueprint,
      startingState: DEGRADED_PLACEHOLDER,
      beats: [
        { action: DEGRADED_PLACEHOLDER, emotion: "", outcome: "" },
        { action: DEGRADED_PLACEHOLDER, emotion: "", outcome: "" },
      ],
      characters: fallbackBlueprint.characterIds,
      locations: fallbackBlueprint.locationIds,
      degraded: true,
    };
    return {
      contentMarkdown: renderStoredChapterBlueprint(document.title, structuredData),
      structuredData,
      model: typeof provenance.model === "string" ? provenance.model : undefined,
      degraded: true,
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
 * @param params.externalDraft 外部 LLM 提交的重写正文——提供时 draft artifact 用此内容替代 document.plainText，
 *   走标准 review→revision→commit 闭环审核重写质量，不直接覆盖正式稿。用于支持"外部 LLM 主动重写章节正文"
 *   工作方式，与 novel_change_patch（proposal item 重写）共同覆盖 chapter 层与 change 层的外部协同创作。
 */
export async function startChapterReviewWorkflow(params: { projectId: string; documentId: string; instruction?: string; blocking?: boolean; externalDraft?: string }, db: NovelDatabase = novelDb) {
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
  // findReusableChapterBlueprint 会在核验晋升链路后使用正式 document.blueprint 并标记 degraded。
  const priorBlueprint = await findReusableChapterBlueprint(params.projectId, params.documentId, db);
  if (!priorBlueprint) throw new Error("找不到历史章节蓝图：仅能复用已完成章节流程中的合法蓝图产物");

  // F-002 修复：fallback 蓝图缺失 beats/startingState 等 ChapterBlueprint 不存储的字段。
  // 在 instruction 中标注降级状态，让 reviewer 知道蓝图节拍不可读、需基于正文反向推断；
  // 不抛错以保持"已晋升章节仍可审校"的原有行为，但显式提示降级场景。
  const degradedSuffix = priorBlueprint.degraded
    ? "\n\n注意：复用的历史蓝图为降级版本（来自隔离闭环候选晋升，原 blueprint artifact 不可读），beats 与 startingState 字段缺失。审校时请基于当前正文反向推断本章节拍与起点，不依赖蓝图节拍。"
    : "";
  const instruction = (params.instruction?.trim() || `对已定稿章节《${document.title}》进行严苛读者视角审校与文案优化`) + degradedSuffix;
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
  // F-002：degraded 蓝图在 title 中标注，便于 UI 与审计追溯降级状态
  const blueprintTitleSuffix = priorBlueprint.degraded ? "（审校复用·降级）" : "（审校复用）";
  const blueprintArtifact = await saveArtifact(run, {
    projectId: run.projectId,
    workflowRunId: run.id,
    stage: "blueprint",
    kind: "blueprint",
    title: `${document.title}蓝图${blueprintTitleSuffix}`,
    contentMarkdown: priorBlueprint.contentMarkdown,
    structuredData: priorBlueprint.structuredData,
    model: priorBlueprint.model,
    skillRefs: [],
    contextPacketId: packet.id,
  }, db);

  // 包装正文为本 run 的 draft artifact。外部 LLM 提交 externalDraft 时用重写正文替代 document.plainText，
  // 走标准 review→revision→commit 闭环审核重写质量，不直接覆盖正式稿。
  const hasExternalDraft = typeof params.externalDraft === "string" && params.externalDraft.trim().length > 0;
  const draftContent = hasExternalDraft ? params.externalDraft!.trim() : document.plainText;
  const draftTitleSuffix = hasExternalDraft ? "（外部重写·审校前）" : "（审校前）";
  const draftArtifact = await saveArtifact(run, {
    projectId: run.projectId,
    workflowRunId: run.id,
    stage: "draft",
    kind: "draft",
    title: `${document.title}正文${draftTitleSuffix}`,
    contentMarkdown: draftContent,
    model: project.settings.textModel,
    skillRefs: [],
    contextPacketId: packet.id,
  }, db);
  // 外部重写场景在 instruction 中标注，让 reviewer 知道审核的是外部 LLM 重写版本而非原 LLM 生成正文。
  if (hasExternalDraft) {
    const externalDraftNote = `\n\n注意：本次审校的 draft artifact 是外部 LLM 提交的重写正文（非原生成流程产出）。审核重点：(1) 重写是否保留了原章节的关键情节、人物状态、伏笔与因果；(2) 重写是否解决了原章节的问题（见 instruction 中审核重点）；(3) 重写是否引入新的事实冲突或风格断裂。若重写质量达标则 commit，若有 issues 则 revision-stage 让原 LLM 基于重写版本修订。`;
    const promptArtifact = await db.workflowArtifacts.where("workflowRunId").equals(run.id).filter((item) => item.stage === "context" && item.kind === "prompt").first();
    if (promptArtifact) {
      await db.workflowArtifacts.put({ ...promptArtifact, contentMarkdown: promptArtifact.contentMarkdown + externalDraftNote, updatedAt: Date.now() });
    }
  }

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
