import { novelDb, saveDocument } from "../db";
import { recordPreferenceSignal } from "../preferences";
import type { WorkflowRun } from "../types";
import type { ApprovalContext, ApprovalHandler } from "../workflow-stages";

export const manuscriptApprovalHandler: ApprovalHandler = {
  stage: "manuscript-approval",
  async approve(ctx: ApprovalContext, params: { approved: boolean; feedback?: string }): Promise<WorkflowRun> {
    const { run } = ctx;
    const pendingProposals = await novelDb.proposals
      .where("projectId")
      .equals(run.projectId)
      .and((item) => item.targetId === run.id && item.status === "pending")
      .toArray();

    if (!params.approved) {
      await ctx.saveArtifact(run, {
        projectId: run.projectId,
        workflowRunId: run.id,
        stage: "manuscript-approval",
        kind: "review",
        title: "正文退回意见",
        contentMarkdown: params.feedback || "请依据质量报告继续修订。",
        skillRefs: [],
      });
      await Promise.all(pendingProposals.map((item) => novelDb.proposals.update(item.id, { status: "rejected", updatedAt: Date.now() })));
      const nextRun = await ctx.transition(run, "revision", "running");
      return nextRun;
    }

    const [artifact, document] = await Promise.all([
      novelDb.workflowArtifacts.get(run.draftArtifactId!),
      novelDb.documents.get(run.targetDocumentId),
    ]);
    if (!artifact || !document) throw new Error("正文产物或章节不存在");
    const html = artifact.contentMarkdown
      .split(/\n{2,}/)
      .map((item) => `<p>${item.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`)
      .join("");
    await saveDocument(
      {
        ...document,
        contentHtml: html,
        plainText: artifact.contentMarkdown,
        wordCount: (artifact.contentMarkdown.match(/[\u3400-\u9fff]|[a-zA-Z0-9]+/g) ?? []).length,
        status: "review",
      },
      `采纳工作流正文前 ${new Date().toLocaleString("zh-CN")}`,
    );
    await recordPreferenceSignal({
      projectId: run.projectId,
      sourceType: "proposal-accepted",
      sourceId: artifact.id,
      category: "manuscript",
      preference: "采用该章节正文风格与处理",
      evidence: artifact.contentMarkdown.slice(0, 300),
      weight: 1,
    });
    await Promise.all(pendingProposals.map((item) => novelDb.proposals.update(item.id, { status: "accepted", updatedAt: Date.now() })));
    const nextRun = await ctx.transition(run, "fact-extraction", "running");
    return nextRun;
  },
};
