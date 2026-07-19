import { applyManuscriptChanges, prepareManuscriptChanges } from "../manuscript-review";
import { recordPreferenceSignal } from "../preferences";
import type { WorkflowRun } from "../types";
import type { ApprovalContext, ApprovalHandler } from "../workflow-stages";

export const manuscriptApprovalHandler: ApprovalHandler = {
  stage: "manuscript-approval",
  async approve(ctx: ApprovalContext, params: { approved: boolean; feedback?: string; manuscriptChangeIds?: string[] }): Promise<WorkflowRun> {
    const { run, db } = ctx;
    const pendingProposals = await db.proposals
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
      await Promise.all(pendingProposals.map((item) => db.proposals.update(item.id, { status: "rejected", updatedAt: Date.now() })));
      const pendingChanges = await db.manuscriptChanges.where("workflowRunId").equals(run.id).filter((change) => change.status === "pending").toArray();
      if (pendingChanges.length) await db.manuscriptChanges.where("id").anyOf(pendingChanges.map((change) => change.id)).modify({ status: "rejected", decidedAt: Date.now(), updatedAt: Date.now(), updatedBy: "local-user" });
      const nextRun = await ctx.transition(run, "revision", "running");
      return nextRun;
    }

    const [artifact, document] = await Promise.all([
      db.workflowArtifacts.get(run.draftArtifactId!),
      db.documents.get(run.targetDocumentId),
    ]);
    if (!artifact || !document) throw new Error("正文产物或章节不存在");
    const changes = await prepareManuscriptChanges({
      projectId: run.projectId,
      documentId: document.id,
      proposedText: artifact.contentMarkdown,
      workflowRunId: run.id,
      sourceArtifactId: artifact.id,
    }, db);
    const applied = await applyManuscriptChanges({
      documentId: document.id,
      sourceArtifactId: artifact.id,
      selectedChangeIds: params.manuscriptChangeIds ?? changes.filter((change) => change.status === "pending").map((change) => change.id),
      label: `批准正文 ${new Date().toLocaleString("zh-CN")}`,
    }, db);
    await recordPreferenceSignal({
      projectId: run.projectId,
      sourceType: "proposal-accepted",
      sourceId: artifact.id,
      category: "manuscript",
      preference: "采用该章节正文风格与处理",
      evidence: applied.document.plainText.slice(0, 300),
      weight: 1,
    }, db);
    await Promise.all(pendingProposals.map((item) => db.proposals.update(item.id, { status: "accepted", updatedAt: Date.now() })));
    const nextRun = await ctx.transition(run, "fact-extraction", "running");
    return nextRun;
  },
};
