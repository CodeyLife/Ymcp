import { streamNovelModel } from "../ai";
import { bigramSimilarity, normalizedParagraph, splitDraftParagraphs } from "../draft-structure";
import { novelDb } from "../db";
import { runDeterministicQualityChecks } from "../quality";
import { compileNovelStagePrompt, resolveNovelSkills } from "../skills";
import { asBlueprint } from "../workflow-shared";
import { truncateTrailingSecondEnding } from "./draft-structure-repair";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

/**
 * 过滤掉 LLM 输出中与原文相似度高的段落，避免补写阶段引入"重述+扩展"重复段。
 * 阈值 0.45：补写段落应承载新节拍（行动+结果），不应与原文任何段落结构相似。
 */
function filterRedundantNewParagraphs(newParagraphs: string[], existingParagraphs: string[]): string[] {
  const existingNormalized = existingParagraphs.map(normalizedParagraph).filter((text) => text.length >= 12);
  return newParagraphs.filter((para) => {
    const trimmed = para.trim();
    if (!trimmed) return false;
    const norm = normalizedParagraph(trimmed);
    if (norm.length < 16) return false; // 太短不构成有效节拍段落
    for (const existing of existingNormalized) {
      const sim = bigramSimilarity(norm, existing);
      if (sim > 0.45) return false; // 与某段相似度超过 45%，视为重述，丢弃
    }
    return true;
  });
}

export const deterministicCheckStageHandler: StageHandler = {
  stage: "deterministic-check",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project, document } = ctx;
    const [draft, blueprint] = await Promise.all([
      novelDb.workflowArtifacts.get(run.draftArtifactId!),
      novelDb.workflowArtifacts.get(run.blueprintArtifactId!),
    ]);
    if (!draft) throw new Error("确定性检查输入不完整：缺少正文产物");

    const blueprintData = blueprint?.structuredData ? asBlueprint(blueprint.structuredData) : undefined;
    const checks = runDeterministicQualityChecks({ text: draft.contentMarkdown, blueprint: blueprintData });
    const missingBeats = checks.issues.filter(
      (item) => item.rule === "chapter-blueprint.mustHappen" && item.severity === "blocker",
    );

    if (missingBeats.length === 0) {
      const nextRun = await ctx.transition(run, "review");
      return { run: nextRun };
    }

    const skills = await resolveNovelSkills({
      projectId: run.projectId,
      stage: "revision",
      explicitSkillIds: ["embodied-prose"],
    });
    const { agent } = await ctx.createAgentRecord({
      run,
      role: "revision-editor",
      goal: `定向补写 ${missingBeats.length} 个缺失节拍`,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
    });

    const beatList = missingBeats.map((item, index) => `${index + 1}. ${item.description}`).join("\n");
    const existingParagraphs = splitDraftParagraphs(draft.contentMarkdown);
    const forbiddenList = blueprintData?.forbidden ?? [];
    const forbiddenReminder = forbiddenList.length > 0
      ? `\n## 章节禁止事项（补写段落同样不可触碰）\n${forbiddenList.map((item) => `- ${item}`).join("\n")}\n`
      : "";
    const result = await streamNovelModel({
      model: project.settings.textModel,
      temperature: Math.min(project.settings.temperature, 0.45),
      role: "revision-editor",
      skillPrompt: compileNovelStagePrompt(skills.skills, "revision"),
      prompt: `为以下章节正文补写缺失的必要节拍。每个节拍输出为独立段落（段落之间用空行分隔），每段约 200-400 字。
${forbiddenReminder}
## 严禁重复
- 严禁复述、重写、概括或扩展正文已有的任何情节、对话、场景、物件或心理活动
- 严禁重复任何已有段落的句式、意象或描述
- 只输出真正"新增"的节拍段落，让节拍以具体行动和可识别结果呈现
- 不要输出标题、注释、解释、原文重复或前后承接说明
- 不要输出"以下是补写段落"等回复包装

## 标点规范
- 对白用中文弯引号"…"，句末标点放在引号内，引号外不再重复句号

## 缺失的必要节拍
${beatList}

## 当前正文（仅供理解上下文，不得复制其中任何内容）
${draft.contentMarkdown}

## 输出要求
- 直接输出新增段落，段落之间用空行分隔
- 每段必须让对应节拍以具体行动和可识别结果呈现
- 保持第三人称限知视角和已有文风
- 不要解释机制，通过行动和物件表现`,
    });
    await ctx.finishAgent(agent, { ...result, artifactId: draft.id });

    // 关键修复：对 LLM 输出做段落级重复检测，丢弃任何与原文相似的"重述段"
    const newParagraphs = splitDraftParagraphs(result.content);
    const filteredNewParagraphs = filterRedundantNewParagraphs(newParagraphs, existingParagraphs);

    if (filteredNewParagraphs.length === 0) {
      // LLM 输出全部被视为重述：不补写，直接进入 review（review 会标记 mustHappen 缺失，但不会引入重复段）
      const nextRun = await ctx.transition(run, "review", "running");
      return { run: nextRun };
    }

    const blocks = existingParagraphs;
    const ending = blocks.at(-1) ?? "";
    const body = ending ? blocks.slice(0, -1) : blocks;
    const rawPatched = [...body, ...filteredNewParagraphs, ending].filter(Boolean).join("\n\n");

    // 补写后检测并截断"第二个结尾"：补写段常在章尾驱动力之后重新展开事件链
    const tailResult = truncateTrailingSecondEnding(rawPatched);
    const patchedText = tailResult.truncated ? tailResult.content : rawPatched;

    const patchedArtifact = await ctx.saveArtifact(run, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "deterministic-check",
      kind: "draft",
      title: `${document.title}节拍补写稿`,
      contentMarkdown: patchedText,
      parentArtifactId: draft.id,
      model: project.settings.textModel,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
      contextPacketId: run.contextPacketId,
    });

    const nextRun = await ctx.transition(run, "review", "running", { draftArtifactId: patchedArtifact.id });
    return { run: nextRun };
  },
};
