import { streamNovelModel } from "../ai";
import { formatContextPacket } from "../context";
import { DEFAULT_CHAPTER_TARGET_WORDS } from "../db";
import { compileNovelStagePrompt, resolveNovelSkills } from "../skills";
import { buildChapterDraftPrompt, buildDraftSectionContract, chapterOutputTokenBudget, planDraftSections } from "../prose-prompts";
import { novelMemoryService } from "../memory-service";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";
import { asBlueprint } from "../workflow-shared";
import { runDeterministicQualityChecks } from "../quality";
import { repairDraftStructureOnce } from "./draft-structure-repair";

export const draftStageHandler: StageHandler = {
  stage: "draft",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project, document, db } = ctx;
    const packetPromise = run.conversationThreadId
      ? novelMemoryService.compileStageContext({ threadId: run.conversationThreadId, stage: "draft", role: "writer", instruction: "依据已批准蓝图生成整章正文", workflowRunId: run.id, skillStage: "drafting", db: ctx.db })
      : db.contextPackets.get(run.contextPacketId!);
    const [packet, blueprint, skills] = await Promise.all([
      packetPromise,
      db.workflowArtifacts.get(run.blueprintArtifactId!),
      resolveNovelSkills({ projectId: run.projectId, stage: "drafting", explicitSkillIds: ["embodied-prose", "serial-rhythm", "character-voice-matrix", "imagery-aesthetics", "prose-discipline"], db: ctx.db }),
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
    const endingHook = blueprintData?.endingHook;

    try {
      const beats = Array.isArray(blueprint.structuredData?.beats)
        ? blueprint.structuredData.beats as Array<{ action: string; emotion: string; outcome: string }>
        : [];
      const sections = planDraftSections(beats, targetWords);
      const sectionContents: string[] = [];
      const promptHashes: string[] = [];
      for (const section of sections) {
        const previousEnding = sectionContents.join("\n\n").slice(-1200);
        const generated = await streamNovelModel({
          model: project.settings.textModel,
          temperature: project.settings.temperature,
          role: "writer",
          skillPrompt,
          maxTokens: chapterOutputTokenBudget(section.targetWords),
          prompt: `${buildChapterDraftPrompt({
            targetWords,
            blueprintMarkdown: blueprint.contentMarkdown,
            contextMarkdown: formatContextPacket(packet),
            mustHappen,
            forbidden,
          })}\n\n${buildDraftSectionContract(section, previousEnding, endingHook)}`,
        });
        sectionContents.push(generated.content);
        promptHashes.push(generated.promptHash);
      }
      const combined = sectionContents.join("\n\n");
      const repaired = await repairDraftStructureOnce({ content: combined, model: project.settings.textModel, skillPrompt });
      // 改进 #8：mechanical pre-review（draft 落库前跑 runDeterministicQualityChecks 预检）
      // 目的：在 draft 落库前快速识别解释性总结、模板化表达和章尾缺开放压力等机械模式，
      // 让 review-stage 能在 deterministic findings 基础上聚焦语义层面问题。本预检不阻塞 draft-stage，
      // 仅打印警告。最终聚合发生在 review-stage 的 aggregateQuality（与 reviewer findings 合并去重）。
      try {
        const preCheck = runDeterministicQualityChecks({ text: repaired.content, blueprint: blueprintData });
        if (preCheck.issues.length > 0) {
          const major = preCheck.issues.filter((i) => i.severity === "major" || i.severity === "blocker");
          const warning = preCheck.issues.filter((i) => i.severity === "warning");
          if (major.length > 0 || warning.length > 0) {
            console.warn(`[draft-stage] mechanical pre-review 发现 ${major.length} 个 major+/blocker、${warning.length} 个 warning（不阻塞 draft，将由 review-stage 聚合）：\n${preCheck.issues.map((i) => `  - [${i.severity}] ${i.title} (${i.rule})`).join("\n")}`);
          }
        }
      } catch (preCheckError) {
        console.warn("[draft-stage] mechanical pre-review 调用异常（已忽略，不阻塞 draft）", preCheckError);
      }
      const result = { content: repaired.content, promptHash: repaired.promptHash ?? promptHashes.join("+") };
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
      const nextRun = await ctx.transition(run, "review", "running", { draftArtifactId: artifact.id, contextPacketId: packet.id });
      return { run: nextRun };
    } catch (error) {
      await ctx.failAgent(agent, error);
      throw error;
    }
  },
};
