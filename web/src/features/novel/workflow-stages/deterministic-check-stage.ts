import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

export const deterministicCheckStageHandler: StageHandler = {
  stage: "deterministic-check",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run } = ctx;
    // mustHappen 确定性检查已移除（containsMeaning bigram 匹配对文学化措辞误报率过高）。
    // LLM plot-reviewer 独立检查节拍遗漏，比确定性 bigram 匹配更准确。
    // 此阶段保留为 pass-through，确保 workflow stage 序列不变。
    const nextRun = await ctx.transition(run, "review");
    return { run: nextRun };
  },
};
