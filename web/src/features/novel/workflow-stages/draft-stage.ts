import { streamNovelModel } from "../ai";
import { formatContextPacket } from "../context";
import { DEFAULT_CHAPTER_TARGET_WORDS, novelDb } from "../db";
import { compileNovelStagePrompt, resolveNovelSkills } from "../skills";
import { buildChapterDraftPrompt } from "../prose-prompts";
import { novelMemoryService } from "../memory-service";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";
import { asBlueprint } from "../workflow-shared";
import { repairDraftStructureOnce } from "./draft-structure-repair";

export const draftStageHandler: StageHandler = {
  stage: "draft",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project, document } = ctx;
    const packetPromise = run.conversationThreadId
      ? novelMemoryService.compileStageContext({ threadId: run.conversationThreadId, stage: "draft", role: "writer", instruction: "依据已批准蓝图生成整章正文", workflowRunId: run.id, skillStage: "drafting" })
      : novelDb.contextPackets.get(run.contextPacketId!);
    const [packet, blueprint, skills] = await Promise.all([
      packetPromise,
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
    const skillPrompt = compileNovelStagePrompt(skills.skills, "drafting");
    const targetWords = document.blueprint.targetWords || DEFAULT_CHAPTER_TARGET_WORDS;

    const blueprintData = blueprint.structuredData ? asBlueprint(blueprint.structuredData) : undefined;
    const forbidden = blueprintData?.forbidden ?? [];
    const mustHappen = blueprintData?.mustHappen ?? [];

    try {
      const generated = await streamNovelModel({
        model: project.settings.textModel,
        temperature: project.settings.temperature,
        role: "writer",
        skillPrompt,
        maxTokens: 8192,
        prompt: buildChapterDraftPrompt({
          targetWords,
          blueprintMarkdown: blueprint.contentMarkdown,
          contextMarkdown: formatContextPacket(packet),
          mustHappen,
          forbidden,
        }),
      });
      const repaired = await repairDraftStructureOnce({ content: generated.content, model: project.settings.textModel, skillPrompt });
      const result = { ...generated, content: repaired.content, promptHash: repaired.promptHash ?? generated.promptHash };
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
      const nextRun = await ctx.transition(run, "deterministic-check", "running", { draftArtifactId: artifact.id, contextPacketId: packet.id });
      return { run: nextRun };
    } catch (error) {
      await ctx.failAgent(agent, error);
      throw error;
    }
  },
};
