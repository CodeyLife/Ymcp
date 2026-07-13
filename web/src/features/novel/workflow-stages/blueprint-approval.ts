import { appendOperation, novelDb } from "../db";
import { recordPreferenceSignal } from "../preferences";
import type { WorkflowRun } from "../types";
import { asBlueprint } from "../workflow-shared";
import type { ApprovalContext, ApprovalHandler } from "../workflow-stages";

export const blueprintApprovalHandler: ApprovalHandler = {
  stage: "blueprint-approval",
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
        stage: "blueprint-approval",
        kind: "review",
        title: "蓝图退回意见",
        contentMarkdown: params.feedback || "请重新规划章节。",
        skillRefs: [],
      });
      await Promise.all(pendingProposals.map((item) => novelDb.proposals.update(item.id, { status: "rejected", updatedAt: Date.now() })));
      const nextRun = await ctx.transition(run, "blueprint", "running");
      return nextRun;
    }

    const artifact = await novelDb.workflowArtifacts.get(run.blueprintArtifactId!);
    const document = await novelDb.documents.get(run.targetDocumentId);
    if (!artifact?.structuredData || !document) throw new Error("蓝图产物或章节不存在");
    const nextBlueprint = asBlueprint(artifact.structuredData, document.blueprint);
    await novelDb.transaction("rw", novelDb.documents, novelDb.operations, async () => {
      await novelDb.documents.update(document.id, { blueprint: nextBlueprint, revision: document.revision + 1, updatedAt: Date.now() });
      await appendOperation(run.projectId, "documents", document.id, "update", { blueprint: { before: document.blueprint, after: nextBlueprint } });
    });
    await recordPreferenceSignal({ projectId: run.projectId, sourceType: "proposal-accepted", sourceId: artifact.id, category: "chapter-blueprint", preference: "采用该章节蓝图结构", evidence: artifact.contentMarkdown.slice(0, 300), weight: 1 });
    await Promise.all(pendingProposals.map((item) => novelDb.proposals.update(item.id, { status: "accepted", updatedAt: Date.now() })));
    const nextRun = await ctx.transition(run, "draft", "running");
    return nextRun;
  },
};
