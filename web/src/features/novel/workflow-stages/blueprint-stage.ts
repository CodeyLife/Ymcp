import { callStructuredNovelModel } from "../ai";
import { formatContextPacket } from "../context";
import { novelDb } from "../db";
import { formatSkillPrompt, resolveNovelSkills } from "../skills";
import { blueprintMarkdown, blueprintSchema } from "../workflow-shared";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

export const blueprintStageHandler: StageHandler = {
  stage: "blueprint",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project, document } = ctx;
    const [packet, feedback, skills] = await Promise.all([
      novelDb.contextPackets.get(run.contextPacketId!),
      ctx.latestArtifact(run.id, ["review"]),
      resolveNovelSkills({ projectId: run.projectId, stage: "planning", explicitSkillIds: ["chapter-blueprint"] }),
    ]);
    if (!packet) throw new Error("章节上下文不存在");
    const { agent } = await ctx.createAgentRecord({
      run,
      role: "architect",
      goal: "生成可审批章节蓝图",
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
    });
    const result = await callStructuredNovelModel<Record<string, unknown>>({
      model: project.settings.textModel,
      temperature: 0.55,
      role: "architect",
      skillPrompt: formatSkillPrompt(skills.skills),
      schema: blueprintSchema,
      prompt: `为“${document.title}”生成章节蓝图。\n\n当前章节要求：${document.blueprint.objective || "尚未规划，请结合全书架构与故事大纲设计"}\n${feedback ? `\n用户退回意见：${feedback.contentMarkdown}` : ""}\n\n冻结上下文：\n${formatContextPacket(packet)}`,
    });
    const artifact = await ctx.saveArtifact(run, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "blueprint",
      kind: "blueprint",
      title: `${document.title}蓝图`,
      contentMarkdown: blueprintMarkdown(result.data),
      structuredData: result.data,
      model: project.settings.textModel,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
      contextPacketId: packet.id,
    });
    await ctx.finishAgent(agent, { ...result, artifactId: artifact.id });
    await ctx.createApprovalProposal(run, artifact, "workflow-blueprint", "章节蓝图待批准");
    const nextRun = await ctx.transition(run, "blueprint-approval", "waiting-approval", { blueprintArtifactId: artifact.id });
    return { run: nextRun, continueLoop: false };
  },
};
