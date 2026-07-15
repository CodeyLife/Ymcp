import { streamNovelModel } from "../ai";
import { formatContextPacket } from "../context";
import { DEFAULT_CHAPTER_TARGET_WORDS, novelDb } from "../db";
import { compileNovelStagePrompt, resolveNovelSkills } from "../skills";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";
import { asBlueprint } from "../workflow-shared";
import { repairDraftStructureOnce } from "./draft-structure-repair";

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
    const skillPrompt = compileNovelStagePrompt(skills.skills, "drafting");
    const targetWords = document.blueprint.targetWords || DEFAULT_CHAPTER_TARGET_WORDS;

    // #17 修复：从蓝图结构化数据提取 forbidden/mustHappen，在 prompt 顶部以最高优先级呈现
    const blueprintData = blueprint.structuredData ? asBlueprint(blueprint.structuredData) : undefined;
    const forbidden = blueprintData?.forbidden ?? [];
    const mustHappen = blueprintData?.mustHappen ?? [];
    const forbiddenSection = forbidden.length > 0
      ? `\n## 章节禁止事项（绝对不可触碰，违反将导致章节作废）\n${forbidden.map((item) => `- ${item}`).join("\n")}\n\n上述禁止事项是硬约束。无论情节如何推进，都不得在正文中直接揭示、完整解释、恢复或显现这些内容。只能通过暗示、留白、侧面反应让读者感知到背后有更深的层次，但不得给出答案。\n`
      : "";
    const mustHappenSection = mustHappen.length > 0
      ? `\n## 必须发生的节拍（本章必须落实）\n${mustHappen.map((item) => `- ${item}`).join("\n")}\n\n每个节拍必须以具体行动和可识别结果呈现，不能只靠叙述性概括带过。\n`
      : "";

    try {
      const generated = await streamNovelModel({
        model: project.settings.textModel,
        temperature: project.settings.temperature,
        role: "writer",
        skillPrompt,
        maxTokens: 8192,
        prompt: `只输出章节正文，不要解释，不要输出标题、代码围栏、:::directive 包装或任何 Markdown 格式标记。
${forbiddenSection}${mustHappenSection}
## 标点规范
- 对白用中文弯引号"…"，句末标点放在引号内，引号外不再重复句号
- 正确："前面有城。"阿落忽然开口。  错误："前面有城。"。阿落忽然开口。

## 强调词约束
- "忽然""突然""第一次""终于""竟然"等强调词每章最多使用 2 次
- 用具体事件、动作或意象呈现认知转变，不要依赖强调词
- 避免连续使用相同的强调词

## 篇幅要求
本章目标字数：${targetWords} 字（中文字符计）。正文必须接近该篇幅，不得明显偏短。通过展开场景细节、人物心理、对话潜台词与环境意象来达到字数，不得通过重复内容或注水填充。

## 段落要求
- 每个叙事段落应包含 2-5 个句子，避免单句成段
- 对白、明确转折和强冲击可以单句成段，但单句叙事段不得连续出现 3 个
- 段落之间用空行分隔，保持中文长篇小说的段落节奏

## 已批准蓝图
${blueprint.contentMarkdown}

## 严禁
- 严禁在正文中重复蓝图内容或上下文摘要
- 严禁在章节末尾自行补写"重述"或"总结"段落
- 严禁复述已经写过的情节、对话或场景
- 正文必须是一次性连贯叙事，不包含任何"第二次开场"或"第二个结尾"

## 冻结上下文
${formatContextPacket(packet)}`,
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
      const nextRun = await ctx.transition(run, "deterministic-check", "running", { draftArtifactId: artifact.id });
      return { run: nextRun };
    } catch (error) {
      await ctx.failAgent(agent, error);
      throw error;
    }
  },
};
