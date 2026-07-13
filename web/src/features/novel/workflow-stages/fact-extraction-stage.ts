import { callStructuredNovelModel } from "../ai";
import { formatContextPacket } from "../context";
import { novelDb } from "../db";
import { storeFactCandidates, type ExtractedFact } from "../facts";
import { formatSkillPrompt, resolveNovelSkills } from "../skills";
import { factSchema } from "../workflow-shared";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

export const factExtractionStageHandler: StageHandler = {
  stage: "fact-extraction",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project } = ctx;
    const [draft, packet, skills] = await Promise.all([
      novelDb.workflowArtifacts.get(run.draftArtifactId!),
      novelDb.contextPackets.get(run.contextPacketId!),
      resolveNovelSkills({ projectId: run.projectId, stage: "fact-extraction", explicitSkillIds: ["fact-delta-extraction"] }),
    ]);
    if (!draft || !packet) throw new Error("事实提取输入不完整");
    const { agent } = await ctx.createAgentRecord({
      run,
      role: "fact-extractor",
      goal: "提取正文事实差异",
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
    });
    const result = await callStructuredNovelModel<Record<string, unknown>>({
      model: project.settings.textModel,
      temperature: 0,
      role: "fact-extractor",
      skillPrompt: formatSkillPrompt(skills.skills),
      schema: factSchema,
      prompt: `从已批准正文提取结构化差异。targetId 只能使用上下文中真实存在的 ID；无法确定目标时省略 targetId。\n\n正文：\n${draft.contentMarkdown}\n\n事实库：\n${formatContextPacket(packet)}`,
    });
    const data = result.data as { summary: string; facts: ExtractedFact[] };
    const facts = await storeFactCandidates({ projectId: run.projectId, workflowRunId: run.id, sourceArtifactId: draft.id, facts: data.facts });
    const artifact = await ctx.saveArtifact(run, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "fact-extraction",
      kind: "fact-delta",
      title: "事实与状态差异",
      contentMarkdown: `# 事实差异\n\n${data.summary}\n\n${facts.map((item) => `- ${item.targetTable}.${item.field}：${String(item.after)}\n  - 证据：${item.evidence}\n  - 置信度：${Math.round(item.confidence * 100)}%${item.conflict ? " · 存在冲突" : ""}`).join("\n") || "未提取到变化"}`,
      structuredData: { summary: data.summary },
      model: project.settings.textModel,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
      contextPacketId: packet.id,
    });
    await ctx.finishAgent(agent, { ...result, artifactId: artifact.id });
    await ctx.createApprovalProposal(run, artifact, "workflow-facts", "事实差异待确认");
    const nextRun = await ctx.transition(run, "fact-approval", "waiting-approval", { factCandidateIds: facts.map((item) => item.id) });
    return { run: nextRun, continueLoop: false };
  },
};
