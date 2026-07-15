import { callStructuredNovelModel } from "../ai";
import { formatContextPacket } from "../context";
import { DEFAULT_CHAPTER_TARGET_WORDS, novelDb } from "../db";
import { compileNovelStagePrompt, resolveNovelSkills } from "../skills";
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
      skillPrompt: compileNovelStagePrompt(skills.skills, "planning"),
      schema: blueprintSchema,
      prompt: `为“${document.title}”生成章节蓝图。章节目标字数由系统设置为 ${document.blueprint.targetWords || DEFAULT_CHAPTER_TARGET_WORDS} 字，你只需按该篇幅规划，不要生成字数。\n\n当前章节要求：${document.blueprint.objective || "尚未规划，请结合全书架构、故事大纲与当前长线位置设计"}\n\n先选择本章唯一的主导叙事功能：建立故事背景与日常秩序、深化人物内心与关系、积累情绪和压力、埋设或提醒线索、承担行动推进、消化既有后果，或兑现阶段节点。不要默认选择行动推进或阶段兑现；相邻章节应有张弛和功能差异。\n\n大纲是跨章节分配材料的上限，不是本章待办清单。只把本章确实到达兑现窗口、删去就会破坏连续性的内容写入 mustHappen；把尚需铺垫的秘密、关系跃迁、重大转折、伏笔回收和后续节点写入 forbidden。informationRelease 允许为空，也允许只让人物误读或局部感知。endingHook 可以是情感余韵、关系张力、未完成动作、意象变化或安静的认知缺口，不必制造突发危险。\n\n使用 2 至 8 个必要节拍。相邻节拍保持时间、注意力或因果连续，但不是每个节拍都必须改变局势。允许用完整节拍承载环境与社会背景、人物独处、生活过程、回忆触发、关系相处、情感发酵和文学意象；这些内容应深化读者体验，而不是重复已知信息。对手只有实际在场或施加影响时才需要反制。禁止为凑结构强造选择、代价、转折或钩子。\n${feedback ? `\n用户退回意见：${feedback.contentMarkdown}` : ""}\n\n冻结上下文：\n${formatContextPacket(packet)}`,
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
