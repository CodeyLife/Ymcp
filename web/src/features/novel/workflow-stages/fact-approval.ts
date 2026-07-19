import type { WorkflowRun } from "../types";
import type { ApprovalContext, ApprovalHandler } from "../workflow-stages";

export const factApprovalHandler: ApprovalHandler = {
  stage: "fact-approval",
  async approve(ctx: ApprovalContext, params: { approved: boolean; feedback?: string }): Promise<WorkflowRun> {
    const { run, db } = ctx;
    const pendingProposals = await db.proposals
      .where("projectId")
      .equals(run.projectId)
      .and((item) => item.targetId === run.id && item.status === "pending")
      .toArray();

    if (!params.approved) {
      await Promise.all(run.factCandidateIds.map((id) => db.factCandidates.update(id, { status: "rejected", updatedAt: Date.now() })));
      await Promise.all(pendingProposals.map((item) => db.proposals.update(item.id, { status: "rejected", updatedAt: Date.now() })));
    } else {
      const undecided = await db.factCandidates
        .where("workflowRunId")
        .equals(run.id)
        .and((item) => item.status === "pending")
        .count();
      if (undecided > 0) throw new Error(`仍有 ${undecided} 项事实未决定`);
      await Promise.all(pendingProposals.map((item) => db.proposals.update(item.id, { status: "accepted", updatedAt: Date.now() })));
    }
    const nextRun = await ctx.transition(run, "commit", "running");
    return nextRun;
  },
};
