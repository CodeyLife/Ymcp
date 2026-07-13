import { callStructuredNovelModel, streamNovelModel } from "./ai";
import { compileNovelContext, formatContextPacket } from "./context";
import { appendOperation, novelDb, recordBase, saveDocument } from "./db";
import { commitAcceptedFacts, createWorkflowSnapshot, storeFactCandidates, type ExtractedFact } from "./facts";
import { recordPreferenceSignal } from "./preferences";
import { runDeterministicQualityChecks, saveQualityReport, type ReviewerFinding } from "./quality";
import { formatSkillPrompt, resolveNovelSkills } from "./skills";
import type {
  AgentRun,
  ChapterBlueprint,
  NovelAgentRole,
  QualityDimension,
  QualityIssue,
  WorkflowArtifact,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStage,
} from "./types";

export const CHAPTER_WORKFLOW_ID = "standard-chapter-v2";

export const BUILTIN_CHAPTER_WORKFLOW: WorkflowDefinition = {
  id: `builtin:${CHAPTER_WORKFLOW_ID}`,
  projectId: "__builtin__",
  schemaVersion: 2,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  createdBy: "system",
  updatedBy: "system",
  workflowId: CHAPTER_WORKFLOW_ID,
  name: "标准章节创作",
  description: "蓝图审批、正文生成、五类审校、定向修订、正文审批和事实回写。",
  stages: ["context", "blueprint", "blueprint-approval", "draft", "deterministic-check", "review", "revision", "manuscript-approval", "fact-extraction", "fact-approval", "commit"],
  requiredSkillIds: ["story-facts-invariant", "chapter-blueprint", "embodied-prose", "serial-rhythm", "continuity-audit", "style-specificity-audit", "plot-pacing-audit", "fact-delta-extraction"],
  maxAutoRevisions: 2,
  qualityThreshold: 3.7,
  builtin: true,
};

export function shouldAutoRevise(params: { passed: boolean; iteration: number; maxIterations: number; previousScore?: number; currentScore: number }) {
  const improvement = params.previousScore === undefined ? Number.POSITIVE_INFINITY : params.currentScore - params.previousScore;
  return !params.passed && params.iteration < params.maxIterations && improvement >= 0.15;
}

const blueprintSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "objective", "startingState", "beats", "endingHook", "characters", "locations", "informationRelease", "mustHappen", "flexible", "forbidden", "targetWords"],
  properties: {
    title: { type: "string" }, objective: { type: "string" }, startingState: { type: "string" },
    beats: { type: "array", minItems: 4, maxItems: 10, items: { type: "object", additionalProperties: false, required: ["action", "emotion", "outcome"], properties: { action: { type: "string" }, emotion: { type: "string" }, outcome: { type: "string" } } } },
    endingHook: { type: "string" }, characters: { type: "array", items: { type: "string" } }, locations: { type: "array", items: { type: "string" } },
    informationRelease: { type: "array", items: { type: "string" } }, mustHappen: { type: "array", items: { type: "string" } }, flexible: { type: "array", items: { type: "string" } }, forbidden: { type: "array", items: { type: "string" } }, targetWords: { type: "integer", minimum: 500, maximum: 30000 },
  },
};

const qualityDimensions: QualityDimension[] = ["plot", "characterVoice", "sceneEmbodiment", "dialogue", "pacing", "specificity", "hookPayoff", "continuity"];
const reviewerSchema = {
  type: "object", additionalProperties: false, required: ["scores", "issues"],
  properties: {
    scores: { type: "object", additionalProperties: false, properties: Object.fromEntries(qualityDimensions.map((item) => [item, { type: "number", minimum: 0, maximum: 5 }])) },
    issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["dimension", "severity", "title", "description", "rule", "suggestion"], properties: {
      dimension: { enum: qualityDimensions }, severity: { enum: ["blocker", "major", "warning"] }, title: { type: "string" }, description: { type: "string" }, excerpt: { type: "string" }, paragraph: { type: "integer", minimum: 1 }, rule: { type: "string" }, sourceId: { type: "string" }, suggestion: { type: "string" },
    } } },
  },
};

const factSchema = {
  type: "object", additionalProperties: false, required: ["summary", "facts"], properties: {
    summary: { type: "string" },
    facts: { type: "array", items: { type: "object", additionalProperties: false, required: ["targetTable", "field", "after", "evidence", "confidence", "novelty", "conflict"], properties: {
      targetTable: { enum: ["projects", "entities", "relations", "outlineNodes", "plotThreads", "foreshadowing", "timelineEvents", "snapshots"] }, targetId: { type: "string" }, field: { type: "string" }, before: {}, after: {}, evidence: { type: "string" }, paragraph: { type: "integer", minimum: 1 }, confidence: { type: "number", minimum: 0, maximum: 1 }, novelty: { enum: ["new", "update", "duplicate"] }, conflict: { type: "boolean" },
    } } },
  },
};

function blueprintMarkdown(data: Record<string, unknown>) {
  const beats = data.beats as Array<{ action: string; emotion: string; outcome: string }>;
  return `# ${data.title}\n\n## 章节目标\n${data.objective}\n\n## 起点\n${data.startingState}\n\n## 节拍\n${beats.map((beat, index) => `${index + 1}. **行动**：${beat.action}\n   - 情绪：${beat.emotion}\n   - 结果：${beat.outcome}`).join("\n")}\n\n## 章尾驱动力\n${data.endingHook}\n\n## 必须发生\n${(data.mustHappen as string[]).map((item) => `- ${item}`).join("\n")}\n\n## 禁止事项\n${(data.forbidden as string[]).map((item) => `- ${item}`).join("\n") || "- 无"}`;
}

function asBlueprint(data: Record<string, unknown>, existing?: ChapterBlueprint): ChapterBlueprint {
  const beats = data.beats as Array<{ action: string; emotion: string; outcome: string }>;
  return {
    objective: String(data.objective),
    povCharacterId: existing?.povCharacterId,
    locationIds: existing?.locationIds ?? [],
    characterIds: existing?.characterIds ?? [],
    conflict: beats.map((item) => item.action).join(" → "),
    informationRelease: data.informationRelease as string[],
    turningPoint: beats.at(-2)?.outcome ?? beats.at(-1)?.outcome ?? "",
    hook: String(data.endingHook),
    mustHappen: data.mustHappen as string[],
    flexible: data.flexible as string[],
    forbidden: data.forbidden as string[],
    targetWords: Number(data.targetWords),
  };
}

function stableArtifactBase(run: WorkflowRun, stage: WorkflowStage, kind: WorkflowArtifact["kind"]) {
  return { ...recordBase(run.projectId), id: `artifact:${run.id}:${stage}:${run.revisionIteration}:${kind}`, workflowRunId: run.id, stage, kind };
}

type ArtifactInput = Omit<WorkflowArtifact, "id" | "schemaVersion" | "revision" | "createdAt" | "updatedAt" | "createdBy" | "updatedBy" | "deletedAt">;

async function saveArtifact(run: WorkflowRun, input: ArtifactInput) {
  const artifact: WorkflowArtifact = { ...stableArtifactBase(run, input.stage, input.kind), ...input };
  await novelDb.workflowArtifacts.put(artifact);
  return artifact;
}

async function latestArtifact(runId: string, kinds: WorkflowArtifact["kind"][]) {
  const items = await novelDb.workflowArtifacts.where("workflowRunId").equals(runId).reverse().sortBy("createdAt");
  return items.find((item) => kinds.includes(item.kind));
}

async function transition(run: WorkflowRun, stage: WorkflowStage, status: WorkflowRun["status"] = "running", changes: Partial<WorkflowRun> = {}) {
  const next: WorkflowRun = { ...run, ...changes, currentStage: stage, stageIndex: BUILTIN_CHAPTER_WORKFLOW.stages.indexOf(stage), status, revision: run.revision + 1, updatedAt: Date.now() };
  await novelDb.workflowRuns.put(next);
  return next;
}

async function createAgentRecord(params: { run: WorkflowRun; role: NovelAgentRole; goal: string; skillRefs: string[] }) {
  const project = await novelDb.projects.get(params.run.projectId);
  if (!project) throw new Error("项目不存在");
  const agent: AgentRun = { ...recordBase(params.run.projectId), workflowRunId: params.run.id, goal: params.goal, status: "running", model: project.settings.textModel, promptVersion: "novel-workflow-v2", role: params.role, skillRefs: params.skillRefs, artifactRefs: [], attempt: params.run.revisionIteration + 1, startedAt: Date.now(), steps: [{ id: crypto.randomUUID(), title: params.goal, tool: "model.chat", status: "running" }] };
  await novelDb.agentRuns.add(agent);
  return { project, agent };
}

async function finishAgent(agent: AgentRun, params: { promptHash: string; usage?: { inputTokens: number; outputTokens: number }; artifactId?: string }) {
  agent.status = "completed"; agent.finishedAt = Date.now(); agent.promptHash = params.promptHash; agent.usage = params.usage; agent.artifactRefs = params.artifactId ? [params.artifactId] : []; agent.steps[0].status = "completed";
  await novelDb.agentRuns.put({ ...agent, revision: agent.revision + 1, updatedAt: Date.now() });
}

async function failRun(run: WorkflowRun, error: unknown) {
  const message = error instanceof Error ? error.message : "未知工作流错误";
  const next = { ...run, status: "failed" as const, error: message, revision: run.revision + 1, updatedAt: Date.now() };
  await novelDb.workflowRuns.put(next);
  return next;
}

async function createApprovalProposal(run: WorkflowRun, artifact: WorkflowArtifact, operation: string, title: string) {
  const existing = await novelDb.proposals.where("projectId").equals(run.projectId).and((item) => item.targetId === run.id && item.operation === operation && item.status === "pending").first();
  if (existing) return existing;
  const project = await novelDb.projects.get(run.projectId);
  const proposal = { ...recordBase(run.projectId), title, operation, targetId: run.id, status: "pending" as const, previewMarkdown: artifact.contentMarkdown, patches: [], contextPacketId: run.contextPacketId ?? "", artifactId: artifact.id, model: project?.settings.textModel ?? "" };
  await novelDb.proposals.add(proposal);
  return proposal;
}

export async function startChapterWorkflow(params: { projectId: string; documentId: string; instruction?: string }) {
  const [project, document] = await Promise.all([novelDb.projects.get(params.projectId), novelDb.documents.get(params.documentId)]);
  if (!project || !document || document.projectId !== params.projectId) throw new Error("章节或项目不存在");
  const active = await novelDb.workflowRuns.where("projectId").equals(params.projectId).and((item) => item.targetDocumentId === params.documentId && !["completed", "cancelled", "failed"].includes(item.status)).first();
  if (active) return active;
  const run: WorkflowRun = { ...recordBase(params.projectId), workflowId: CHAPTER_WORKFLOW_ID, targetDocumentId: params.documentId, status: "running", currentStage: "context", stageIndex: 0, revisionIteration: 0, factCandidateIds: [], startedAt: Date.now() };
  await novelDb.workflowRuns.add(run);
  if (params.instruction) await saveArtifact(run, { projectId: run.projectId, workflowRunId: run.id, stage: "context", kind: "prompt", title: "用户创作要求", contentMarkdown: params.instruction, skillRefs: [] });
  return advanceChapterWorkflow(run.id);
}

export async function advanceChapterWorkflow(runId: string): Promise<WorkflowRun> {
  const initialRun = await novelDb.workflowRuns.get(runId);
  if (!initialRun) throw new Error("工作流不存在");
  let run: WorkflowRun = initialRun;
  if (["waiting-approval", "paused", "completed", "cancelled"].includes(run.status)) return run;
  try {
    for (let guard = 0; guard < 20 && run.status === "running"; guard += 1) {
      const project = await novelDb.projects.get(run.projectId);
      const document = await novelDb.documents.get(run.targetDocumentId);
      if (!project || !document) throw new Error("工作流目标已不存在");
      if (run.currentStage === "context") {
        const prompt = await latestArtifact(run.id, ["prompt"]);
        const skills = await resolveNovelSkills({ projectId: run.projectId, stage: "planning", explicitSkillIds: BUILTIN_CHAPTER_WORKFLOW.requiredSkillIds });
        if (skills.conflicts.length) throw new Error(`Skill 冲突：${skills.conflicts.map((item) => `${item.skillId} ↔ ${item.conflictsWith}`).join("；")}`);
        const packet = await compileNovelContext({ projectId: run.projectId, task: "chapter-workflow", instruction: prompt?.contentMarkdown || "为当前章节执行标准创作工作流", targetDocumentId: document.id, stage: "planning", resolvedSkills: skills.skills });
        run = await transition(run, "blueprint", "running", { contextPacketId: packet.id });
        continue;
      }
      if (run.currentStage === "blueprint") {
        const [packet, outline, feedback, skills] = await Promise.all([
          novelDb.contextPackets.get(run.contextPacketId!),
          novelDb.outlineNodes.get(document.outlineNodeId),
          latestArtifact(run.id, ["review"]),
          resolveNovelSkills({ projectId: run.projectId, stage: "planning", explicitSkillIds: ["chapter-blueprint"] }),
        ]);
        if (!packet || !outline) throw new Error("章节上下文或大纲不存在");
        const { agent } = await createAgentRecord({ run, role: "architect", goal: "生成可审批章节蓝图", skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`) });
        const result = await callStructuredNovelModel<Record<string, unknown>>({ model: project.settings.textModel, temperature: 0.55, role: "architect", skillPrompt: formatSkillPrompt(skills.skills), schema: blueprintSchema, prompt: `为“${document.title}”生成章节蓝图。\n\n当前大纲：${outline.summary}\n${feedback ? `\n用户退回意见：${feedback.contentMarkdown}` : ""}\n\n冻结上下文：\n${formatContextPacket(packet)}` });
        const artifact = await saveArtifact(run, { projectId: run.projectId, workflowRunId: run.id, stage: "blueprint", kind: "blueprint", title: `${document.title}蓝图`, contentMarkdown: blueprintMarkdown(result.data), structuredData: result.data, model: project.settings.textModel, skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`), contextPacketId: packet.id });
        await finishAgent(agent, { ...result, artifactId: artifact.id });
        await createApprovalProposal(run, artifact, "workflow-blueprint", "章节蓝图待批准");
        run = await transition(run, "blueprint-approval", "waiting-approval", { blueprintArtifactId: artifact.id });
        continue;
      }
      if (run.currentStage === "draft") {
        const [packet, blueprint, skills] = await Promise.all([novelDb.contextPackets.get(run.contextPacketId!), novelDb.workflowArtifacts.get(run.blueprintArtifactId!), resolveNovelSkills({ projectId: run.projectId, stage: "drafting", explicitSkillIds: ["embodied-prose", "serial-rhythm", "character-voice-matrix"] })]);
        if (!packet || !blueprint) throw new Error("已批准蓝图或上下文不存在");
        const { agent } = await createAgentRecord({ run, role: "writer", goal: "依据批准蓝图生成章节草稿", skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`) });
        const result = await streamNovelModel({ model: project.settings.textModel, temperature: project.settings.temperature, role: "writer", skillPrompt: formatSkillPrompt(skills.skills), prompt: `只输出章节正文，不要解释。\n\n已批准蓝图：\n${blueprint.contentMarkdown}\n\n冻结上下文：\n${formatContextPacket(packet)}` });
        const artifact = await saveArtifact(run, { projectId: run.projectId, workflowRunId: run.id, stage: "draft", kind: "draft", title: `${document.title}草稿`, contentMarkdown: result.content, model: project.settings.textModel, skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`), contextPacketId: packet.id });
        await finishAgent(agent, { ...result, artifactId: artifact.id });
        run = await transition(run, "deterministic-check", "running", { draftArtifactId: artifact.id });
        continue;
      }
      if (run.currentStage === "deterministic-check") {
        run = await transition(run, "review");
        continue;
      }
      if (run.currentStage === "review") {
        const [draft, blueprint, packet] = await Promise.all([novelDb.workflowArtifacts.get(run.draftArtifactId!), novelDb.workflowArtifacts.get(run.blueprintArtifactId!), novelDb.contextPackets.get(run.contextPacketId!)]);
        if (!draft || !blueprint || !packet) throw new Error("审校输入不完整");
        const blueprintData = blueprint.structuredData ? asBlueprint(blueprint.structuredData) : undefined;
        const deterministic = runDeterministicQualityChecks({ text: draft.contentMarkdown, blueprint: blueprintData });
        const roles: NovelAgentRole[] = ["style-reviewer", "character-reviewer", "continuity-reviewer", "plot-reviewer", "pacing-reviewer"];
        const reviewers = await Promise.all(roles.map(async (role) => {
          const skills = await resolveNovelSkills({ projectId: run.projectId, stage: "review" });
          const { agent } = await createAgentRecord({ run, role, goal: `${role} 独立审校`, skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`) });
          const result = await callStructuredNovelModel<Record<string, unknown>>({ model: project.settings.textModel, temperature: 0.15, role, skillPrompt: formatSkillPrompt(skills.skills), schema: reviewerSchema, prompt: `独立审校下面正文。不要读取或猜测写作者解释。只报告职责范围内且有证据的问题。\n\n蓝图：\n${blueprint.contentMarkdown}\n\n正文：\n${draft.contentMarkdown}\n\n相关事实：\n${formatContextPacket(packet)}` });
          await finishAgent(agent, result);
          const data = result.data as { scores: Partial<Record<QualityDimension, number>>; issues: Array<Omit<QualityIssue, "id" | "deterministic">> };
          return { role, scores: data.scores, issues: data.issues } satisfies ReviewerFinding;
        }));
        const report = await saveQualityReport({ projectId: run.projectId, workflowRunId: run.id, artifactId: draft.id, iteration: run.revisionIteration, deterministic, reviewers, threshold: project.settings.qualityThreshold });
        const reportArtifact = await saveArtifact(run, { projectId: run.projectId, workflowRunId: run.id, stage: "review", kind: "review", title: `质量报告 · 第 ${run.revisionIteration + 1} 轮`, contentMarkdown: `# 质量报告\n\n总分：${report.weightedScore} / 5\n\n阻断：${report.blockerCount}\n\n${report.issues.map((item) => `- [${item.severity}] ${item.title}：${item.description}\n  - 建议：${item.suggestion}`).join("\n") || "未发现问题"}`, structuredData: { reportId: report.id }, skillRefs: [], contextPacketId: packet.id });
        const shouldRevise = shouldAutoRevise({ passed: report.passed, iteration: run.revisionIteration, maxIterations: project.settings.maxAutoRevisions, previousScore: run.previousScore, currentScore: report.weightedScore });
        if (shouldRevise) run = await transition(run, "revision", "running", { qualityReportId: report.id, previousScore: report.weightedScore });
        else {
          await createApprovalProposal(run, draft, "workflow-manuscript", report.passed ? "章节正文已通过审校" : "章节正文需人工决策");
          run = await transition(run, "manuscript-approval", "waiting-approval", { qualityReportId: report.id, draftArtifactId: draft.id });
        }
        void reportArtifact;
        continue;
      }
      if (run.currentStage === "revision") {
        const [draft, report, feedback, skills] = await Promise.all([novelDb.workflowArtifacts.get(run.draftArtifactId!), novelDb.qualityReports.get(run.qualityReportId!), latestArtifact(run.id, ["review"]), resolveNovelSkills({ projectId: run.projectId, stage: "revision", explicitSkillIds: ["embodied-prose", "style-specificity-audit"] })]);
        if (!draft || !report) throw new Error("修订输入不完整");
        const { agent } = await createAgentRecord({ run, role: "revision-editor", goal: "按质量报告定向修订", skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`) });
        const result = await streamNovelModel({ model: project.settings.textModel, temperature: Math.min(project.settings.temperature, 0.55), role: "revision-editor", skillPrompt: formatSkillPrompt(skills.skills), prompt: `只输出修订后的完整正文。仅处理报告中的有效问题，保留已通过内容。\n\n质量问题：\n${report.issues.map((item) => `[${item.severity}] ${item.title}：${item.description}；建议：${item.suggestion}`).join("\n")}\n${feedback?.stage === "manuscript-approval" ? `\n用户意见：${feedback.contentMarkdown}` : ""}\n\n原正文：\n${draft.contentMarkdown}` });
        const nextIteration = run.revisionIteration + 1;
        const revisedRun = { ...run, revisionIteration: nextIteration };
        const artifact = await saveArtifact(revisedRun, { projectId: run.projectId, workflowRunId: run.id, stage: "revision", kind: "revision", title: `${document.title}修订稿 ${nextIteration}`, contentMarkdown: result.content, parentArtifactId: draft.id, model: project.settings.textModel, skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`), contextPacketId: run.contextPacketId });
        await finishAgent(agent, { ...result, artifactId: artifact.id });
        run = await transition(run, "deterministic-check", "running", { draftArtifactId: artifact.id, revisionIteration: nextIteration });
        continue;
      }
      if (run.currentStage === "fact-extraction") {
        const [draft, packet, skills] = await Promise.all([novelDb.workflowArtifacts.get(run.draftArtifactId!), novelDb.contextPackets.get(run.contextPacketId!), resolveNovelSkills({ projectId: run.projectId, stage: "fact-extraction", explicitSkillIds: ["fact-delta-extraction"] })]);
        if (!draft || !packet) throw new Error("事实提取输入不完整");
        const { agent } = await createAgentRecord({ run, role: "fact-extractor", goal: "提取正文事实差异", skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`) });
        const result = await callStructuredNovelModel<Record<string, unknown>>({ model: project.settings.textModel, temperature: 0, role: "fact-extractor", skillPrompt: formatSkillPrompt(skills.skills), schema: factSchema, prompt: `从已批准正文提取结构化差异。targetId 只能使用上下文中真实存在的 ID；无法确定目标时省略 targetId。\n\n正文：\n${draft.contentMarkdown}\n\n事实库：\n${formatContextPacket(packet)}` });
        const data = result.data as { summary: string; facts: ExtractedFact[] };
        const facts = await storeFactCandidates({ projectId: run.projectId, workflowRunId: run.id, sourceArtifactId: draft.id, facts: data.facts });
        const artifact = await saveArtifact(run, { projectId: run.projectId, workflowRunId: run.id, stage: "fact-extraction", kind: "fact-delta", title: "事实与状态差异", contentMarkdown: `# 事实差异\n\n${data.summary}\n\n${facts.map((item) => `- ${item.targetTable}.${item.field}：${String(item.after)}\n  - 证据：${item.evidence}\n  - 置信度：${Math.round(item.confidence * 100)}%${item.conflict ? " · 存在冲突" : ""}`).join("\n") || "未提取到变化"}`, structuredData: { summary: data.summary }, model: project.settings.textModel, skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`), contextPacketId: packet.id });
        await finishAgent(agent, { ...result, artifactId: artifact.id });
        await createApprovalProposal(run, artifact, "workflow-facts", "事实差异待确认");
        run = await transition(run, "fact-approval", "waiting-approval", { factCandidateIds: facts.map((item) => item.id) });
        continue;
      }
      if (run.currentStage === "commit") {
        const draft = await novelDb.workflowArtifacts.get(run.draftArtifactId!);
        if (!draft) throw new Error("最终正文产物不存在");
        await commitAcceptedFacts(run.projectId, run.id);
        await createWorkflowSnapshot({ projectId: run.projectId, documentId: document.id, label: `${document.title}完成`, summary: draft.contentMarkdown.slice(0, 800) });
        run = await transition(run, "commit", "completed", { finishedAt: Date.now() });
        continue;
      }
      break;
    }
    return run;
  } catch (error) {
    return failRun(run, error);
  }
}

export async function approveWorkflowStage(runId: string, params: { approved: boolean; feedback?: string }) {
  const initialRun = await novelDb.workflowRuns.get(runId);
  if (!initialRun || initialRun.status !== "waiting-approval") throw new Error("工作流当前不在审批状态");
  let run: WorkflowRun = initialRun;
  const pendingProposals = await novelDb.proposals.where("projectId").equals(run.projectId).and((item) => item.targetId === run.id && item.status === "pending").toArray();
  if (run.currentStage === "blueprint-approval") {
    if (!params.approved) {
      await saveArtifact(run, { projectId: run.projectId, workflowRunId: run.id, stage: "blueprint-approval", kind: "review", title: "蓝图退回意见", contentMarkdown: params.feedback || "请重新规划章节。", skillRefs: [] });
      await Promise.all(pendingProposals.map((item) => novelDb.proposals.update(item.id, { status: "rejected", updatedAt: Date.now() })));
      run = await transition(run, "blueprint", "running");
      return advanceChapterWorkflow(run.id);
    }
    const artifact = await novelDb.workflowArtifacts.get(run.blueprintArtifactId!);
    const document = await novelDb.documents.get(run.targetDocumentId);
    const outline = document && await novelDb.outlineNodes.get(document.outlineNodeId);
    if (!artifact?.structuredData || !outline) throw new Error("蓝图产物或章节节点不存在");
    const nextBlueprint = asBlueprint(artifact.structuredData, outline.blueprint);
    await novelDb.transaction("rw", novelDb.outlineNodes, novelDb.operations, async () => {
      await novelDb.outlineNodes.update(outline.id, { blueprint: nextBlueprint, status: "planned", revision: outline.revision + 1, updatedAt: Date.now() });
      await appendOperation(run!.projectId, "outlineNodes", outline.id, "update", { blueprint: { before: outline.blueprint, after: nextBlueprint } });
    });
    await recordPreferenceSignal({ projectId: run.projectId, sourceType: "proposal-accepted", sourceId: artifact.id, category: "chapter-blueprint", preference: "采用该章节蓝图结构", evidence: artifact.contentMarkdown.slice(0, 300), weight: 1 });
    await Promise.all(pendingProposals.map((item) => novelDb.proposals.update(item.id, { status: "accepted", updatedAt: Date.now() })));
    run = await transition(run, "draft", "running");
    return advanceChapterWorkflow(run.id);
  }
  if (run.currentStage === "manuscript-approval") {
    if (!params.approved) {
      await saveArtifact(run, { projectId: run.projectId, workflowRunId: run.id, stage: "manuscript-approval", kind: "review", title: "正文退回意见", contentMarkdown: params.feedback || "请依据质量报告继续修订。", skillRefs: [] });
      await Promise.all(pendingProposals.map((item) => novelDb.proposals.update(item.id, { status: "rejected", updatedAt: Date.now() })));
      run = await transition(run, "revision", "running");
      return advanceChapterWorkflow(run.id);
    }
    const [artifact, document] = await Promise.all([novelDb.workflowArtifacts.get(run.draftArtifactId!), novelDb.documents.get(run.targetDocumentId)]);
    if (!artifact || !document) throw new Error("正文产物或章节不存在");
    const html = artifact.contentMarkdown.split(/\n{2,}/).map((item) => `<p>${item.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`).join("");
    await saveDocument({ ...document, contentHtml: html, plainText: artifact.contentMarkdown, wordCount: (artifact.contentMarkdown.match(/[\u3400-\u9fff]|[a-zA-Z0-9]+/g) ?? []).length, status: "review" }, `采纳工作流正文前 ${new Date().toLocaleString("zh-CN")}`);
    await recordPreferenceSignal({ projectId: run.projectId, sourceType: "proposal-accepted", sourceId: artifact.id, category: "manuscript", preference: "采用该章节正文风格与处理", evidence: artifact.contentMarkdown.slice(0, 300), weight: 1 });
    await Promise.all(pendingProposals.map((item) => novelDb.proposals.update(item.id, { status: "accepted", updatedAt: Date.now() })));
    run = await transition(run, "fact-extraction", "running");
    return advanceChapterWorkflow(run.id);
  }
  if (run.currentStage === "fact-approval") {
    if (!params.approved) {
      await Promise.all(run.factCandidateIds.map((id) => novelDb.factCandidates.update(id, { status: "rejected", updatedAt: Date.now() })));
      await Promise.all(pendingProposals.map((item) => novelDb.proposals.update(item.id, { status: "rejected", updatedAt: Date.now() })));
    } else {
      const undecided = await novelDb.factCandidates.where("workflowRunId").equals(run.id).and((item) => item.status === "pending").count();
      if (undecided > 0) throw new Error(`仍有 ${undecided} 项事实未决定`);
      await Promise.all(pendingProposals.map((item) => novelDb.proposals.update(item.id, { status: "accepted", updatedAt: Date.now() })));
    }
    run = await transition(run, "commit", "running");
    return advanceChapterWorkflow(run.id);
  }
  throw new Error("未知审批阶段");
}

export async function pauseWorkflow(runId: string) {
  const run = await novelDb.workflowRuns.get(runId);
  if (!run || run.status !== "running") return run;
  return transition(run, run.currentStage, "paused");
}

export async function resumeWorkflow(runId: string) {
  const run = await novelDb.workflowRuns.get(runId);
  if (!run || !["paused", "failed"].includes(run.status)) return run;
  const resumed = await transition(run, run.currentStage, "running", { error: undefined });
  return advanceChapterWorkflow(resumed.id);
}

export async function cancelWorkflow(runId: string) {
  const run = await novelDb.workflowRuns.get(runId);
  if (!run || ["completed", "cancelled"].includes(run.status)) return run;
  return transition(run, run.currentStage, "cancelled", { finishedAt: Date.now() });
}
