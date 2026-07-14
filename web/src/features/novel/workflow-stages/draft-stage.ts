import { streamNovelModel } from "../ai";
import { formatContextPacket } from "../context";
import { novelDb } from "../db";
import { formatSkillPrompt, resolveNovelSkills } from "../skills";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

export const draftStageHandler: StageHandler = {
  stage: "draft",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project, document } = ctx;
    const [packet, blueprint, skills] = await Promise.all([
      novelDb.contextPackets.get(run.contextPacketId!),
      novelDb.workflowArtifacts.get(run.blueprintArtifactId!),
      resolveNovelSkills({ projectId: run.projectId, stage: "drafting", explicitSkillIds: ["embodied-prose", "serial-rhythm", "character-voice-matrix", "imagery-aesthetics", "prose-discipline"] }),
    ]);
    if (!packet || !blueprint) throw new Error("已批准蓝图或上下文不存在");
    const { agent } = await ctx.createAgentRecord({
      run,
      role: "writer",
      goal: "依据批准蓝图生成章节草稿",
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
    });
    const result = await streamNovelModel({
      model: project.settings.textModel,
      temperature: project.settings.temperature,
      role: "writer",
      skillPrompt: formatSkillPrompt(skills.skills),
      prompt: `只输出章节正文，不要解释。\n\n已批准蓝图：\n${blueprint.contentMarkdown}\n\n冻结上下文：\n${formatContextPacket(packet)}`,
    });
    const artifact = await ctx.saveArtifact(run, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "draft",
      kind: "draft",
      title: `${document.title}草稿`,
      contentMarkdown: result.content,
      model: project.settings.textModel,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
      contextPacketId: packet.id,
    });
    await ctx.finishAgent(agent, { ...result, artifactId: artifact.id });
    const nextRun = await ctx.transition(run, "deterministic-check", "running", { draftArtifactId: artifact.id });
    return { run: nextRun };
  },
};
