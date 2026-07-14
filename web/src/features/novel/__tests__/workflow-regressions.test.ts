import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
  callStructuredNovelModel: vi.fn(async ({ role }: { role: string }) => role === "fact-extractor"
    ? { data: { summary: "无变化", facts: [] }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "fact" }
    : { data: { scores: { plot: 1, characterVoice: 1, sceneEmbodiment: 1, dialogue: 1, pacing: 1, specificity: 1, hookPayoff: 1, continuity: 1 }, issues: [] }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "review" }),
  streamNovelModel: vi.fn(),
}));

import { callStructuredNovelModel, streamNovelModel } from "../ai";
import { addEntity, createChapter, createNovelProject, novelDb, recordBase, saveApprovedDocumentRevision, updateProject } from "../db";
import type { NovelContextPacket, QualityIssue, QualityReport, WorkflowArtifact, WorkflowRun } from "../types";
import { advanceChapterWorkflow } from "../workflow";
import { findIssueParagraph } from "../workflow-stages/revision-stage";

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
  it("locates review excerpts despite punctuation and whitespace differences", () => {
    const issue = {
      id: "fuzzy",
      dimension: "pacing",
      severity: "major",
      title: "动作停滞",
      description: "需要压缩",
      rule: "test",
      suggestion: "收紧动作",
      deterministic: false,
      excerpt: "林澈 在雨里，停下脚步！",
    } satisfies QualityIssue;

    expect(findIssueParagraph(issue, ["潮声越过防波堤。", "林澈在雨里停下脚步。"])).toBe(1);
    expect(findIssueParagraph({ ...issue, excerpt: "完全无关的审校摘录" }, ["潮声越过防波堤。", "林澈在雨里停下脚步。"])).toBe(-1);
  });

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

  it("waits for author fact approval when automatic commits are disabled", async () => {
    const project = await createNovelProject({ title: "事实审批", genre: ["都市"], premise: "事实必须先确认。" });
    const document = await createChapter(project.id, "第一章");
    const approved = await saveApprovedDocumentRevision({ ...document, plainText: "陆沉抵达北港。", contentHtml: "<p>陆沉抵达北港。</p>", wordCount: 7, status: "review" }, "批准正文", "ai");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "fact-extraction", stageIndex: 8, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft-facts", factCandidateIds: [], startedAt: Date.now() };
    const draft = artifact(run, { id: "draft-facts", stage: "draft", kind: "draft", title: "正文", contentMarkdown: "陆沉抵达北港。" });
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "角色抵达北港", facts: [{ targetTable: "entities", targetId: "character-1", field: "character.state.location", after: "北港", evidence: "陆沉抵达北港。", confidence: 0.98, novelty: "update", conflict: false }] },
      usage: { inputTokens: 1, outputTokens: 1 },
      promptHash: "fact-approval",
    });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.add(draft);

    const waiting = await advanceChapterWorkflow(run.id);

    expect(waiting).toMatchObject({ status: "waiting-approval", currentStage: "fact-approval" });
    expect(await novelDb.factCandidates.where("workflowRunId").equals(run.id).first()).toMatchObject({ status: "pending", risk: "safe", sourceRevisionId: approved.revision.id });
  });

  it("auto-accepts only safe state changes and keeps high-risk facts for review", async () => {
    const project = await createNovelProject({ title: "风险审批", genre: ["悬疑"], premise: "安全状态可以自动提交。" });
    await updateProject(project.id, { settings: { ...project.settings, autoCommitFacts: true } });
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "fact-extraction", stageIndex: 8, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft-risk", factCandidateIds: [], startedAt: Date.now() };
    const draft = artifact(run, { id: "draft-risk", stage: "draft", kind: "draft", title: "正文", contentMarkdown: "陆沉抵达北港，并承认自己是继承人。" });
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "角色状态与秘密变化", facts: [
        { targetTable: "entities", targetId: "character-1", field: "character.state.location", after: "北港", evidence: "陆沉抵达北港。", confidence: 0.98, novelty: "update", conflict: false },
        { targetTable: "entities", targetId: "character-1", field: "character.secret", after: "继承人", evidence: "陆沉承认自己是继承人。", confidence: 0.99, novelty: "update", conflict: false },
      ] },
      usage: { inputTokens: 1, outputTokens: 1 },
      promptHash: "fact-risk",
    });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.add(draft);

    const waiting = await advanceChapterWorkflow(run.id);
    const facts = await novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray();

    expect(waiting).toMatchObject({ status: "waiting-approval", currentStage: "fact-approval" });
    expect(facts.find((item) => item.field === "character.state.location")).toMatchObject({ status: "accepted", decisionSource: "auto-policy", risk: "safe" });
    expect(facts.find((item) => item.field === "character.secret")).toMatchObject({ status: "pending", risk: "high" });
  });

  it("creates a revision-bound chapter memory when all extracted facts are safely committed", async () => {
    const project = await createNovelProject({ title: "章节记忆", genre: ["都市"], premise: "已批准章节形成叶级记忆。" });
    await updateProject(project.id, { settings: { ...project.settings, autoCommitFacts: true } });
    const character = await addEntity(project.id, "character", "陆沉");
    const document = await createChapter(project.id, "第一章");
    const approved = await saveApprovedDocumentRevision({ ...document, plainText: "陆沉抵达北港。", contentHtml: "<p>陆沉抵达北港。</p>", wordCount: 7, status: "review" }, "批准正文", "ai");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "fact-extraction", stageIndex: 8, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft-memory", factCandidateIds: [], startedAt: Date.now() };
    const draft = artifact(run, { id: "draft-memory", stage: "draft", kind: "draft", title: "正文", contentMarkdown: "陆沉抵达北港。" });
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "陆沉抵达北港，开始新的调查。", facts: [{ targetTable: "entities", targetId: character.id, field: "character.state.location", after: "北港", evidence: "陆沉抵达北港。", confidence: 0.98, novelty: "update", conflict: false }] },
      usage: { inputTokens: 1, outputTokens: 1 },
      promptHash: "fact-memory",
    });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.add(draft);

    const completed = await advanceChapterWorkflow(run.id);
    const memory = await novelDb.derivedMemories.where("documentId").equals(document.id).first();

    expect(completed).toMatchObject({ status: "completed", currentStage: "commit" });
    expect(memory).toMatchObject({ level: "chapter", status: "active", sourceRevisionId: approved.revision.id, summary: "陆沉抵达北港，开始新的调查。" });
  });

  it("shortcircuits to manuscript approval when only warning issues exist", async () => {
    const project = await createNovelProject({ title: "无法定位问题", genre: ["悬疑"], premise: "审校意见缺少段落位置。" });
    const document = await createChapter(project.id, "第一章");
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "revision", stageIndex: 6, revisionIteration: 0, draftArtifactId: "draft", blueprintArtifactId: "blueprint", qualityReportId: "report", factCandidateIds: [], startedAt: Date.now() };
    const draft = artifact(run, { id: "draft", stage: "draft", kind: "draft", title: "正文", contentMarkdown: "第一段。\n\n第二段。" });
    const blueprint = artifact(run, { id: "blueprint", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "蓝图" });
    const report: QualityReport = { ...recordBase(project.id), id: "report", workflowRunId: run.id, artifactId: draft.id, iteration: 0, scores: { plot: 3, characterVoice: 3, sceneEmbodiment: 3, dialogue: 3, pacing: 3, specificity: 3, hookPayoff: 3, continuity: 3 }, weightedScore: 3, blockerCount: 0, passed: false, issues: [{ id: "issue", dimension: "plot", severity: "warning", title: "问题", description: "无法定位", rule: "test", suggestion: "人工判断", deterministic: false }], metrics: {}, reviewerRoles: [] };
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);
    await novelDb.qualityReports.add(report);

    const waiting = await advanceChapterWorkflow(run.id);

    expect(waiting).toMatchObject({ status: "waiting-approval", currentStage: "manuscript-approval" });
    expect(await novelDb.proposals.where("projectId").equals(project.id).and((item) => item.targetId === run.id && item.status === "pending").count()).toBe(1);
    expect(streamNovelModel).not.toHaveBeenCalled();
  });

  it("never degrades to a whole-chapter rewrite when a major issue cannot be located", async () => {
    const project = await createNovelProject({ title: "安全降级", genre: ["悬疑"], premise: "无法定位段落时保留原文。" });
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "revision", stageIndex: 6, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft", blueprintArtifactId: "blueprint", qualityReportId: "report", factCandidateIds: [], startedAt: Date.now() };
    const draft = artifact(run, { id: "draft", stage: "draft", kind: "draft", title: "正文", contentMarkdown: "第一段。\n\n第二段。" });
    const blueprint = artifact(run, { id: "blueprint", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "蓝图" });
    const report: QualityReport = { ...recordBase(project.id), id: "report", workflowRunId: run.id, artifactId: draft.id, iteration: 0, scores: { plot: 3, characterVoice: 3, sceneEmbodiment: 3, dialogue: 3, pacing: 3, specificity: 3, hookPayoff: 3, continuity: 3 }, weightedScore: 3, blockerCount: 0, passed: false, issues: [{ id: "issue", dimension: "plot", severity: "major", title: "问题", description: "无法定位", rule: "test", suggestion: "人工判断", deterministic: false }], metrics: {}, reviewerRoles: [] };
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);
    await novelDb.qualityReports.add(report);
    const waiting = await advanceChapterWorkflow(run.id);

    expect(streamNovelModel).not.toHaveBeenCalled();
    expect(waiting).toMatchObject({ status: "waiting-approval", currentStage: "manuscript-approval" });
    const unchanged = await novelDb.workflowArtifacts.get(waiting.draftArtifactId!);
    expect(unchanged?.contentMarkdown).toBe(draft.contentMarkdown);
    expect((await novelDb.proposals.where("projectId").equals(project.id).and((item) => item.targetId === run.id).first())?.title).toContain("无法安全定位");
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
