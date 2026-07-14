import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
  callStructuredNovelModel: vi.fn(async ({ role }: { role: string }) => role === "fact-extractor"
    ? { data: { summary: "无变化", facts: [] }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "fact" }
    : { data: { scores: { plot: 1, characterVoice: 1, sceneEmbodiment: 1, dialogue: 1, pacing: 1, specificity: 1, hookPayoff: 1, continuity: 1 }, issues: [] }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "review" }),
  streamNovelModel: vi.fn(),
}));

import { createChapter, createNovelProject, novelDb, recordBase } from "../db";
import type { NovelContextPacket, QualityReport, WorkflowArtifact, WorkflowRun } from "../types";
import { advanceChapterWorkflow } from "../workflow";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
});

function artifact(run: WorkflowRun, input: Pick<WorkflowArtifact, "id" | "stage" | "kind" | "title" | "contentMarkdown"> & Partial<WorkflowArtifact>): WorkflowArtifact {
  return { ...recordBase(run.projectId), workflowRunId: run.id, skillRefs: [], ...input };
}

function packet(projectId: string): NovelContextPacket {
  return { ...recordBase(projectId), task: "chapter-draft", instruction: "继续写作", sources: [], tokenBudget: 1000, estimatedTokens: 0, omittedSourceIds: [], skillRefs: [], compiledAt: Date.now() };
}

describe("chapter workflow regressions", () => {
  it("continues from fact extraction through commit", async () => {
    const project = await createNovelProject({ title: "提交闭环", genre: ["都市"], premise: "正文最终必须提交。" });
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "fact-extraction", stageIndex: 8, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft", factCandidateIds: [], startedAt: Date.now() };
    const draft = artifact(run, { id: "draft", stage: "draft", kind: "draft", title: "正文", contentMarkdown: "雨停了。" });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.add(draft);

    const completed = await advanceChapterWorkflow(run.id);

    expect(completed.status).toBe("completed");
    expect(completed.currentStage).toBe("commit");
    expect(await novelDb.snapshots.where("projectId").equals(project.id).count()).toBe(1);
  });

  it("waits for manuscript approval when no review issue can be located", async () => {
    const project = await createNovelProject({ title: "无法定位问题", genre: ["悬疑"], premise: "审校意见缺少段落位置。" });
    const document = await createChapter(project.id, "第一章");
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "revision", stageIndex: 6, revisionIteration: 0, draftArtifactId: "draft", blueprintArtifactId: "blueprint", qualityReportId: "report", factCandidateIds: [], startedAt: Date.now() };
    const draft = artifact(run, { id: "draft", stage: "draft", kind: "draft", title: "正文", contentMarkdown: "第一段。\n\n第二段。" });
    const blueprint = artifact(run, { id: "blueprint", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "蓝图" });
    const report: QualityReport = { ...recordBase(project.id), id: "report", workflowRunId: run.id, artifactId: draft.id, iteration: 0, scores: { plot: 3, characterVoice: 3, sceneEmbodiment: 3, dialogue: 3, pacing: 3, specificity: 3, hookPayoff: 3, continuity: 3 }, weightedScore: 3, blockerCount: 0, passed: false, issues: [{ id: "issue", dimension: "plot", severity: "major", title: "问题", description: "无法定位", rule: "test", suggestion: "人工判断", deterministic: false }], metrics: {}, reviewerRoles: [] };
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);
    await novelDb.qualityReports.add(report);

    const waiting = await advanceChapterWorkflow(run.id);

    expect(waiting).toMatchObject({ status: "waiting-approval", currentStage: "manuscript-approval" });
    expect(await novelDb.proposals.where("projectId").equals(project.id).and((item) => item.targetId === run.id && item.status === "pending").count()).toBe(1);
  });

  it("restores the previous draft when a revision scores lower", async () => {
    const project = await createNovelProject({ title: "修订回滚", genre: ["悬疑"], premise: "低分修订不能替换原稿。" });
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "review", stageIndex: 5, revisionIteration: 1, previousScore: 4.2, contextPacketId: context.id, blueprintArtifactId: "blueprint", draftArtifactId: "revised", qualityReportId: "previous-report", factCandidateIds: [], startedAt: Date.now() };
    const original = artifact(run, { id: "original", stage: "draft", kind: "draft", title: "原稿", contentMarkdown: "原稿内容。" });
    const revised = artifact(run, { id: "revised", stage: "revision", kind: "revision", title: "修订稿", contentMarkdown: "较差修订。", parentArtifactId: original.id });
    const blueprint = artifact(run, { id: "blueprint", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "蓝图" });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([original, revised, blueprint]);

    const waiting = await advanceChapterWorkflow(run.id);

    expect(waiting).toMatchObject({ status: "waiting-approval", currentStage: "manuscript-approval", draftArtifactId: original.id, qualityReportId: "previous-report" });
    expect((await novelDb.proposals.where("projectId").equals(project.id).and((item) => item.targetId === run.id).first())?.artifactId).toBe(original.id);
  });
});
