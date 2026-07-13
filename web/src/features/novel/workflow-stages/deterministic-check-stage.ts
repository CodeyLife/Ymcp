import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

/**
 * 确定性规则检查 stage。
 * 当前为占位实现：直接 transition 到 review 阶段。
 * TODO P2: 未来可在此 stage 中插入独立的确定性检查逻辑（不依赖 AI），如字数、节奏、模板化表达检测。
 */
export const deterministicCheckStageHandler: StageHandler = {
  stage: "deterministic-check",
  async execute(ctx: StageContext): Promise<StageResult> {
    const nextRun = await ctx.transition(ctx.run, "review");
    return { run: nextRun };
  },
};
