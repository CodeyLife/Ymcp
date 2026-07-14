import { streamNovelModel } from "../ai";
import { novelDb } from "../db";
import { runDeterministicQualityChecks } from "../quality";
import { formatSkillPrompt, resolveNovelSkills } from "../skills";
import { asBlueprint } from "../workflow-shared";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

/**
 * 确定性规则检查 stage。
 * 在 draft/revision 之后、review 之前运行：
 * 1. 检查 mustHappen 节拍是否在正文中以可识别方式呈现
 * 2. 若有缺失节拍，调用 LLM 定向补写（非全量重写），插入到正文末段之前
 * 3. 保存补写后的正文为新 draft artifact，更新 run.draftArtifactId
 * 4. 转入 review 阶段
 */
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
    const result = await streamNovelModel({
      model: project.settings.textModel,
      temperature: Math.min(project.settings.temperature, 0.45),
      role: "revision-editor",
      skillPrompt: formatSkillPrompt(skills.skills),
      prompt: `你需要为以下章节正文补写缺失的必要节拍。只输出需要插入的段落文本，每段约200-400字。段落应自然融入故事，保持已有文风和视角。

## 缺失的必要节拍
${beatList}

## 当前正文（最后一段是章尾驱动力，不要修改或重复）
${draft.contentMarkdown}

## 要求
- 只输出新增段落，不要重复原文
- 每段必须让对应节拍以具体行动和可识别结果呈现
- 保持第三人称限知视角
- 不要解释机制，通过行动和物件表现
- 段落之间用空行分隔`,
    });
    await ctx.finishAgent(agent, { ...result, artifactId: draft.id });

    const blocks = draft.contentMarkdown.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
    const ending = blocks.at(-1) ?? "";
    const body = ending ? blocks.slice(0, -1) : blocks;
    const patchedText = [...body, result.content, ending].filter(Boolean).join("\n\n");

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
