import { novelDb } from "../db";
import { commitAcceptedFacts, createWorkflowSnapshot } from "../facts";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

export const commitStageHandler: StageHandler = {
  stage: "commit",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, document } = ctx;
    const draft = await novelDb.workflowArtifacts.get(run.draftArtifactId!);
    if (!draft) throw new Error("最终正文产物不存在");
    await commitAcceptedFacts(run.projectId, run.id);
    await createWorkflowSnapshot({ projectId: run.projectId, documentId: document.id, label: `${document.title}完成`, summary: draft.contentMarkdown.slice(0, 800) });
    const nextRun = await ctx.transition(run, "commit", "completed", { finishedAt: Date.now() });
    return { run: nextRun };
  },
};
