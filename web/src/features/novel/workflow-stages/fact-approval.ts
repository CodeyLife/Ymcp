import { novelDb } from "../db";
import type { WorkflowRun } from "../types";
import type { ApprovalContext, ApprovalHandler } from "../workflow-stages";

export const factApprovalHandler: ApprovalHandler = {
  stage: "fact-approval",
  async approve(ctx: ApprovalContext, params: { approved: boolean; feedback?: string }): Promise<WorkflowRun> {
    const { run } = ctx;
    const pendingProposals = await novelDb.proposals
      .where("projectId")
      .equals(run.projectId)
      .and((item) => item.targetId === run.id && item.status === "pending")
      .toArray();

    if (!params.approved) {
      await Promise.all(run.factCandidateIds.map((id) => novelDb.factCandidates.update(id, { status: "rejected", updatedAt: Date.now() })));
      await Promise.all(pendingProposals.map((item) => novelDb.proposals.update(item.id, { status: "rejected", updatedAt: Date.now() })));
    } else {
      const undecided = await novelDb.factCandidates
        .where("workflowRunId")
        .equals(run.id)
        .and((item) => item.status === "pending")
        .count();
      if (undecided > 0) throw new Error(`仍有 ${undecided} 项事实未决定`);
      await Promise.all(pendingProposals.map((item) => novelDb.proposals.update(item.id, { status: "accepted", updatedAt: Date.now() })));
    }
    const nextRun = await ctx.transition(run, "commit", "running");
    return nextRun;
  },
};
