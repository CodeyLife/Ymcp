import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

export const deterministicCheckStageHandler: StageHandler = {
  stage: "deterministic-check",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run } = ctx;
    // 仅用于恢复旧版仍停留在该 stage 的运行；新流程由 draft/revision 直接进入 review。
    const nextRun = await ctx.transition(run, "review");
    return { run: nextRun };
  },
};
