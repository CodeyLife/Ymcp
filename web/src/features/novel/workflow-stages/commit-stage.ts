import { commitAcceptedFacts, createWorkflowSnapshot } from "../facts";
import { createChapterMemory, sanitizeMemorySummary } from "../memory";
import { toHtml } from "../manuscript-review";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

export const commitStageHandler: StageHandler = {
  stage: "commit",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, document, db } = ctx;
    const draft = await db.workflowArtifacts.get(run.draftArtifactId!);
    if (!draft) throw new Error("最终正文产物不存在");
    await commitAcceptedFacts(run.projectId, run.id, db);
    const [factArtifact, candidates] = await Promise.all([
      db.workflowArtifacts.where("workflowRunId").equals(run.id).and((artifact) => artifact.kind === "fact-delta").last(),
      db.factCandidates.where("workflowRunId").equals(run.id).toArray(),
    ]);
    const fallbackSummary = draft.contentMarkdown.slice(0, 800);
    const summary = sanitizeMemorySummary(String(factArtifact?.structuredData?.summary || ""), fallbackSummary);
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
      }, db);
    }
    await createWorkflowSnapshot({ projectId: run.projectId, documentId: document.id, label: `${document.title}完成`, summary }, db);
    // 关键修复：commit 阶段必须更新 document 的 summary 与 status，否则章节永远停在 review 状态、摘要为空
    // Loop 9 修复 #14：无条件同步 plainText/contentHtml 到 document
    // 根因：manuscript-approval 的 applyManuscriptChanges 在新章节（plainText 为空）时可能不生成 changes，
    // 导致 plainText 保持空值。commit-stage 作为最终保存点，必须用 draft.contentMarkdown 填充 plainText。
    // draftArtifactId 指向的 artifact 就是 manuscript-approval 批准的最终正文，内容与 plainText 应一致。
    const draftText = draft.contentMarkdown ?? "";
    const wordCount = (draftText.match(/[\u3400-\u9fff]|[a-zA-Z0-9]+/g) ?? []).length;
    await db.documents.update(document.id, {
      summary,
      status: "final",
      wordCount,
      plainText: draftText,
      contentHtml: toHtml(draftText),
      updatedAt: Date.now(),
      updatedBy: "local-user",
    });
    // 进入 character-enrichment 阶段：基于本章既定事实完善人物形象
    const nextRun = await ctx.transition(run, "character-enrichment", "running");
    return { run: nextRun, continueLoop: true };
  },
};
