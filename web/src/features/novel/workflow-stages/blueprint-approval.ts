import { appendOperation } from "../db";
import { recordPreferenceSignal } from "../preferences";
import type { WorkflowRun } from "../types";
import { asBlueprint } from "../workflow-shared";
import { applyCreativeBriefToBlueprint, findBlueprintPovConflicts } from "../workflow-brief";
import type { ApprovalContext, ApprovalHandler } from "../workflow-stages";

export const blueprintApprovalHandler: ApprovalHandler = {
  stage: "blueprint-approval",
  async approve(ctx: ApprovalContext, params: { approved: boolean; feedback?: string }): Promise<WorkflowRun> {
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
        stage: "blueprint-approval",
        kind: "review",
        title: "蓝图退回意见",
        contentMarkdown: params.feedback || "请重新规划章节。",
        skillRefs: [],
      });
      await Promise.all(pendingProposals.map((item) => db.proposals.update(item.id, { status: "rejected", updatedAt: Date.now() })));
      const nextRun = await ctx.transition(run, "blueprint", "running");
      return nextRun;
    }

    const artifact = await db.workflowArtifacts.get(run.blueprintArtifactId!);
    const document = await db.documents.get(run.targetDocumentId);
    const brief = run.creativeBriefId ? await db.creativeBriefs.get(run.creativeBriefId) : undefined;
    if (!artifact?.structuredData || !document || !brief || brief.status !== "confirmed") throw new Error("蓝图产物、章节或已确认创作简报不存在");
    if (brief.povCharacterId) {
      const characters = await db.entities.where("projectId").equals(run.projectId).and((item) => item.kind === "character").toArray();
      const otherNames = characters.filter((item) => item.id !== brief.povCharacterId).map((item) => item.name).filter(Boolean);
      const requiresThirdPerson = brief.languageRequirements.some((item) => item.includes("第三人称"));
      const conflicts = findBlueprintPovConflicts(artifact.structuredData, otherNames, requiresThirdPerson);
      if (conflicts.length > 0) {
        const feedback = `蓝图与已确认 POV 或叙述人称冲突：${conflicts.map((item) => `${item.field}不符合简报（${item.text}）`).join("；")}。所有情绪、判断和认知只能属于指定 POV；第三人称合同下不得使用“我”组织蓝图；其他角色只能通过可观察的动作、神态和对白呈现。`;
        await ctx.saveArtifact(run, {
          projectId: run.projectId,
          workflowRunId: run.id,
          stage: "blueprint-approval",
          kind: "review",
          title: "蓝图 POV 一致性退回",
          contentMarkdown: feedback,
          skillRefs: [],
        });
        await Promise.all(pendingProposals.map((item) => db.proposals.update(item.id, { status: "rejected", updatedAt: Date.now() })));
        return ctx.transition(run, "blueprint", "running");
      }
    }
    const nextBlueprint = applyCreativeBriefToBlueprint(asBlueprint(artifact.structuredData, document.blueprint), brief);
    await db.transaction("rw", db.documents, db.operations, async () => {
      await db.documents.update(document.id, { blueprint: nextBlueprint, revision: document.revision + 1, updatedAt: Date.now() });
      await appendOperation(run.projectId, "documents", document.id, "update", { blueprint: { before: document.blueprint, after: nextBlueprint } }, db);
    });
    await recordPreferenceSignal({ projectId: run.projectId, sourceType: "proposal-accepted", sourceId: artifact.id, category: "chapter-blueprint", preference: "采用该章节蓝图结构", evidence: artifact.contentMarkdown.slice(0, 300), weight: 1 }, db);
    await Promise.all(pendingProposals.map((item) => db.proposals.update(item.id, { status: "accepted", updatedAt: Date.now() })));
    const nextRun = await ctx.transition(run, "draft", "running");
    return nextRun;
  },
};
