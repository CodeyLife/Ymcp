import { novelDb } from "../db";
import { commitAcceptedFacts, createWorkflowSnapshot } from "../facts";
import { createChapterMemory } from "../memory";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

export const commitStageHandler: StageHandler = {
  stage: "commit",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, document } = ctx;
    const draft = await novelDb.workflowArtifacts.get(run.draftArtifactId!);
    if (!draft) throw new Error("最终正文产物不存在");
    await commitAcceptedFacts(run.projectId, run.id);
    const [factArtifact, candidates] = await Promise.all([
      novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((artifact) => artifact.kind === "fact-delta").last(),
      novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray(),
    ]);
    const summary = String(factArtifact?.structuredData?.summary || draft.contentMarkdown.slice(0, 800));
    const factAssertionIds = candidates.map((candidate) => candidate.committedAssertionId).filter((id): id is string => Boolean(id));
    if (document.approvedRevisionId) {
      await createChapterMemory({
        projectId: run.projectId,
        documentId: document.id,
        sourceRevisionId: document.approvedRevisionId,
        summary,
        content: {
          factAssertionIds,
          stateChanges: candidates.filter((candidate) => candidate.committedAssertionId && candidate.targetTable === "entities").map((candidate) => candidate.humanReadable ?? `${candidate.field}：${String(candidate.after)}`),
          knowledgeChanges: candidates.flatMap((candidate) => (candidate.knowledgeDeltas ?? []).map((delta) => `${delta.characterId}：${delta.stance} · ${candidate.humanReadable ?? candidate.predicate ?? candidate.field}`)),
          relationshipChanges: candidates.filter((candidate) => candidate.committedAssertionId && candidate.targetTable === "relations").map((candidate) => candidate.humanReadable ?? `${candidate.field}：${String(candidate.after)}`),
          threadProgress: candidates.filter((candidate) => candidate.committedAssertionId && candidate.targetTable === "plotThreads").map((candidate) => candidate.humanReadable ?? `${candidate.field}：${String(candidate.after)}`),
          foreshadowingProgress: candidates.filter((candidate) => candidate.committedAssertionId && candidate.targetTable === "foreshadowing").map((candidate) => candidate.humanReadable ?? `${candidate.field}：${String(candidate.after)}`),
        },
      });
    }
    await createWorkflowSnapshot({ projectId: run.projectId, documentId: document.id, label: `${document.title}完成`, summary });
    const nextRun = await ctx.transition(run, "commit", "completed", { finishedAt: Date.now() });
    return { run: nextRun };
  },
};
