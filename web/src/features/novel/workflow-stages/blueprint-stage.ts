import { callStructuredNovelModel } from "../ai";
import { formatContextPacket } from "../context";
import { DEFAULT_CHAPTER_TARGET_WORDS, novelDb } from "../db";
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
      prompt: `为“${document.title}”生成章节蓝图。章节目标字数由系统设置为 ${document.blueprint.targetWords || DEFAULT_CHAPTER_TARGET_WORDS} 字，你只需按该篇幅规划，不要生成字数。\n\n当前章节要求：${document.blueprint.objective || "尚未规划，请结合全书架构与故事大纲设计"}\n故事大纲的每个节点 summary 已包含'原因→触发→阻碍→直接结果→延迟后果'的叙事节拍，请在生成蓝图时从中提取：阻碍→conflict（章节冲突），直接结果→turningPoint（价值转折点），延迟后果→mustHappen（本章需落实的节拍）。\n${feedback ? `\n用户退回意见：${feedback.contentMarkdown}` : ""}\n\n冻结上下文：\n${formatContextPacket(packet)}`,
    });
    const targetWords = document.blueprint.targetWords || DEFAULT_CHAPTER_TARGET_WORDS;
    const structuredData = { ...result.data, targetWords };
    const artifact = await ctx.saveArtifact(run, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "blueprint",
      kind: "blueprint",
      title: `${document.title}蓝图`,
      contentMarkdown: blueprintMarkdown(result.data, targetWords),
      structuredData,
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
