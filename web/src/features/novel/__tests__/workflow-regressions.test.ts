import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
  callStructuredNovelModel: vi.fn(async ({ role }: { role: string }) => {
    if (role === "fact-extractor") return { data: { summary: "无变化", facts: [] }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "fact" };
    if (role === "character-enricher") return { data: { enrichments: [] }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "enrichment" };
    return { data: { scores: { plot: 1, characterVoice: 1, sceneEmbodiment: 1, dialogue: 1, pacing: 1, specificity: 1, hookPayoff: 1, continuity: 1 }, issues: [] }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "review" };
  }),
  streamNovelModel: vi.fn(),
}));

import { callStructuredNovelModel, streamNovelModel } from "../ai";
import { addEntity, createChapter, createNovelProject, novelDb, recordBase, saveApprovedDocumentRevision } from "../db";
import type { NovelContextPacket, QualityIssue, QualityReport, WorkflowArtifact, WorkflowRun } from "../types";
import { advanceChapterWorkflow } from "../workflow";
import { collectRevisionParagraphs, findIssueParagraph, isRevisionRefusal } from "../workflow-stages/revision-stage";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
  vi.mocked(streamNovelModel).mockReset();
  vi.mocked(callStructuredNovelModel).mockClear();
});

function artifact(run: WorkflowRun, input: Pick<WorkflowArtifact, "id" | "stage" | "kind" | "title" | "contentMarkdown"> & Partial<WorkflowArtifact>): WorkflowArtifact {
  return { ...recordBase(run.projectId), workflowRunId: run.id, skillRefs: [], ...input };
}

function packet(projectId: string): NovelContextPacket {
  return { ...recordBase(projectId), task: "chapter-draft", instruction: "继续写作", sources: [], estimatedTokens: 0, omittedSourceIds: [], skillRefs: [], compiledAt: Date.now() };
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

  it("unlocks structural revision ranges named in legacy review suggestions", () => {
    const issue = {
      id: "structural-repeat",
      dimension: "plot",
      severity: "major",
      title: "后半章推进重复",
      description: "第292—293段的车辆事件与第169—189段的受阻事件形成重复。",
      paragraph: 33,
      rule: "plot.repeated-progression",
      suggestion: "删除或合并第291—296段，只保留一套结尾推进。",
      deterministic: false,
    } satisfies QualityIssue;
    const paragraphs = Array.from({ length: 300 }, (_, index) => `第${index + 1}段正文。`);

    expect(collectRevisionParagraphs(issue, paragraphs)).toEqual([32, 290, 291, 292, 293, 294, 295]);
  });

  it("uses explicit revision ranges instead of comparison-only paragraph references", () => {
    const issue = {
      id: "explicit-structural-repeat",
      dimension: "plot",
      severity: "major",
      title: "重复推进",
      description: "第292—296段与第169—189段作用重复。",
      paragraph: 169,
      revisionRanges: [{ start: 292, end: 296 }],
      rule: "plot.repeated-progression",
      suggestion: "删除后出现的重复推进。",
      deterministic: false,
    } satisfies QualityIssue;
    const paragraphs = Array.from({ length: 300 }, (_, index) => `第${index + 1}段正文。`);

    expect(collectRevisionParagraphs(issue, paragraphs)).toEqual([291, 292, 293, 294, 295]);
  });

  it("recognizes constraint explanations so they cannot become manuscript revisions", () => {
    expect(isRevisionRefusal("无法在当前约束下提交有效修订稿。需要先确认解除部分保留锁定。")).toBe(true);
    expect(isRevisionRefusal("他终于完成修订稿，推门走入雨中。")).toBe(false);
  });

  it("repairs a structurally invalid draft once before saving it into the workflow", async () => {
    const project = await createNovelProject({ title: "段落修复", genre: ["悬疑"], premise: "正文必须以常规段落进入审校。" });
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "draft", stageIndex: 3, revisionIteration: 0, contextPacketId: context.id, blueprintArtifactId: "blueprint-draft-repair", factCandidateIds: [], startedAt: Date.now() };
    const blueprint = artifact(run, { id: "blueprint-draft-repair", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "目标：进入废弃驿站。", structuredData: { title: "第一章", objective: "进入驿站", startingState: "官道", beats: [], endingHook: "门后有脚步", characters: [], locations: [], informationRelease: [], mustHappen: [], flexible: [], forbidden: [] } });
    const invalid = ["以下是正文：", "风停了。", "他抬起头。", "远处有人走来。"].join("\n\n");
    // 全文修订模式：draft 生成后 workflow 继续到 review→revision，因正文 <300 字触发
    // chapter.minimum-substance (major)，revision 阶段会再次调用 streamNovelModel
    vi.mocked(streamNovelModel)
      .mockResolvedValueOnce({ content: invalid, promptHash: "draft-invalid" })
      .mockResolvedValueOnce({ content: "风停了。他抬起头。远处有人走来。", promptHash: "revision-short" });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.add(blueprint);

    await advanceChapterWorkflow(run.id);

    const draft = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((item) => item.stage === "draft").first();
    // repairDraftStructureOnce 确定性合并+移除格式标记，不调用 LLM 修复
    // streamNovelModel 被调用 2 次：1=draft 生成，2=revision 全文修订（chapter.minimum-substance 触发）
    expect(streamNovelModel).toHaveBeenCalledTimes(2);
    // "以下是正文："被移除，3 个短叙事段合并为 1 段
    expect(draft?.contentMarkdown).toBe("风停了。他抬起头。远处有人走来。");
  });

  it("repairs structural wrappers in a directed revision before saving the revision artifact", async () => {
    const project = await createNovelProject({ title: "修订格式", genre: ["悬疑"], premise: "定向修订只能返回一份正文。" });
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "revision", stageIndex: 6, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft-before-format-revision", blueprintArtifactId: "blueprint-format-revision", qualityReportId: "report-format-revision", factCandidateIds: [], startedAt: Date.now() };
    const draft = artifact(run, { id: "draft-before-format-revision", stage: "draft", kind: "draft", title: "原稿", contentMarkdown: "风从门缝里灌进来。他压低灯芯，屋里暗了一层。\n\n脚步停在门外。他没有出声，只把短刀移到手边。" });
    const blueprint = artifact(run, { id: "blueprint-format-revision", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "蓝图", structuredData: { title: "第一章", objective: "守住屋门", startingState: "屋内", beats: [], endingHook: "门外来人", characters: [], locations: [], informationRelease: [], mustHappen: [], flexible: [], forbidden: [] } });
    const report: QualityReport = { ...recordBase(project.id), id: "report-format-revision", workflowRunId: run.id, artifactId: draft.id, iteration: 0, scores: { plot: 2, characterVoice: 4, sceneEmbodiment: 4, dialogue: 4, pacing: 4, specificity: 4, hookPayoff: 4, continuity: 4 }, weightedScore: 3.5, blockerCount: 0, passed: false, issues: [{ id: "revise-range", dimension: "plot", severity: "major", title: "动作结果不清", description: "补足人物应对结果。", revisionRanges: [{ start: 1, end: 2 }], rule: "plot.action-result", suggestion: "在原范围内补足结果。", deterministic: false }], metrics: {}, reviewerRoles: [] };
    const invalid = ["以下是修订后的正文：", "风停了。", "灯暗了。", "脚步来到门外。"].join("\n\n");
    // 全文修订模式：revision 生成后 workflow 继续到 review→revision，因正文 <300 字触发
    // chapter.minimum-substance (major)，revision 阶段会再次调用 streamNovelModel
    vi.mocked(streamNovelModel)
      .mockResolvedValueOnce({ content: invalid, promptHash: "revision-invalid" })
      .mockResolvedValueOnce({ content: "风停了。灯暗了。脚步来到门外。", promptHash: "revision-short" });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);
    await novelDb.qualityReports.add(report);

    await advanceChapterWorkflow(run.id);

    const revision = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((item) => item.stage === "revision").first();
    // repairDraftStructureOnce 确定性移除"以下是修订后的正文："并合并短段
    // streamNovelModel 被调用 2 次：1=revision 生成，2=revision 全文修订（chapter.minimum-substance 触发）
    expect(streamNovelModel).toHaveBeenCalledTimes(2);
    expect(revision?.contentMarkdown).toBe("风停了。灯暗了。脚步来到门外。");
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
    expect(completed.currentStage).toBe("character-enrichment");
    expect(await novelDb.snapshots.where("projectId").equals(project.id).count()).toBe(1);
  });

  it("waits for author fact approval for high-risk changes", async () => {
    const project = await createNovelProject({ title: "事实审批", genre: ["都市"], premise: "事实必须先确认。" });
    const document = await createChapter(project.id, "第一章");
    const approved = await saveApprovedDocumentRevision({ ...document, plainText: "陆沉抵达北港。", contentHtml: "<p>陆沉抵达北港。</p>", wordCount: 7, status: "review" }, "批准正文", "ai");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "fact-extraction", stageIndex: 8, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft-facts", factCandidateIds: [], startedAt: Date.now() };
    const draft = artifact(run, { id: "draft-facts", stage: "draft", kind: "draft", title: "正文", contentMarkdown: "陆沉抵达北港。" });
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "角色承认身份", facts: [{ targetTable: "entities", targetId: "character-1", field: "character.secret", after: "继承人", evidence: "陆沉承认自己是继承人。", confidence: 0.98, novelty: "update", conflict: false }] },
      usage: { inputTokens: 1, outputTokens: 1 },
      promptHash: "fact-approval",
    });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.add(draft);

    const waiting = await advanceChapterWorkflow(run.id);

    expect(waiting).toMatchObject({ status: "waiting-approval", currentStage: "fact-approval" });
    expect(await novelDb.factCandidates.where("workflowRunId").equals(run.id).first()).toMatchObject({ status: "pending", risk: "high", sourceRevisionId: approved.revision.id });
  });

  it("auto-accepts only safe state changes and keeps high-risk facts for review", async () => {
    const project = await createNovelProject({ title: "风险审批", genre: ["悬疑"], premise: "安全状态可以自动提交。" });
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

    expect(completed).toMatchObject({ status: "completed", currentStage: "character-enrichment" });
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

  it("triggers full-text revision for major issues without paragraph location", async () => {
    const project = await createNovelProject({ title: "全文修订", genre: ["悬疑"], premise: "无法定位段落时仍进行全文修订。" });
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "revision", stageIndex: 6, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft", blueprintArtifactId: "blueprint", qualityReportId: "report", factCandidateIds: [], startedAt: Date.now() };
    const draft = artifact(run, { id: "draft", stage: "draft", kind: "draft", title: "正文", contentMarkdown: "第一段。\n\n第二段。" });
    const blueprint = artifact(run, { id: "blueprint", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "蓝图" });
    const report: QualityReport = { ...recordBase(project.id), id: "report", workflowRunId: run.id, artifactId: draft.id, iteration: 0, scores: { plot: 3, characterVoice: 3, sceneEmbodiment: 3, dialogue: 3, pacing: 3, specificity: 3, hookPayoff: 3, continuity: 3 }, weightedScore: 3, blockerCount: 0, passed: false, issues: [{ id: "issue", dimension: "plot", severity: "major", title: "问题", description: "无法定位", rule: "test", suggestion: "人工判断", deterministic: false }], metrics: {}, reviewerRoles: [] };
    // 全文修订模式：major 问题即使无法定位到具体段落，也触发 LLM 全文修订
    vi.mocked(streamNovelModel).mockResolvedValue({ content: "第一段修订内容。\n\n第二段修订内容。", promptHash: "revision" });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);
    await novelDb.qualityReports.add(report);

    const waiting = await advanceChapterWorkflow(run.id);

    // 全文修订模式：streamNovelModel 被调用（major 问题触发 LLM 全文修订）
    expect(streamNovelModel).toHaveBeenCalled();
    expect(waiting).toMatchObject({ status: "waiting-approval", currentStage: "manuscript-approval" });
    // 修订产物存在
    const revisions = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((item) => item.stage === "revision").toArray();
    expect(revisions.length).toBeGreaterThan(0);
  });

  it("falls back to deterministic deletion when revision output is too similar to original (R10)", async () => {
    const project = await createNovelProject({ title: "相似度回退", genre: ["悬疑"], premise: "LLM 返回与原文实质相同时回退到确定性删除。" });
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "revision", stageIndex: 6, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft-similar", blueprintArtifactId: "blueprint-similar", qualityReportId: "report-similar", factCandidateIds: [], startedAt: Date.now() };
    // 使用足够长的段落避免碎片化合并干扰断言
    const draftContent = "寒灯挂在庙檐下，火苗被风吹得摇晃。沈雁声推门进去，庙中有一张旧木桌，桌上放着一壶热茶。她从怀中取出门人录，陆无名三个字静静留在那里。\n\n佩剑客从佛像旁走出，衣着整洁，剑穗随步轻摆。那是她曾见过的样式。听潮阁已灭，所以才要寻。他递茶试探，言语温雅却句句指向旧事。\n\n她抬手一挥，桌上的寒灯翻倒。灯油洒在地面，火光被夜风卷起。佩剑客人退了一步。沈雁声借这一瞬掠向侧墙，剑锋擦过她的袖口。";
    const draft = artifact(run, { id: "draft-similar", stage: "draft", kind: "draft", title: "正文", contentMarkdown: draftContent });
    const blueprint = artifact(run, { id: "blueprint-similar", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "蓝图" });
    const report: QualityReport = { ...recordBase(project.id), id: "report-similar", workflowRunId: run.id, artifactId: draft.id, iteration: 0, scores: { plot: 3, characterVoice: 3, sceneEmbodiment: 3, dialogue: 3, pacing: 3, specificity: 3, hookPayoff: 3, continuity: 3 }, weightedScore: 3, blockerCount: 0, passed: false, issues: [{ id: "issue-similar", dimension: "plot", severity: "major", title: "心理判断句", description: "需要修订", revisionRanges: [{ start: 1, end: 1 }], rule: "style.test", suggestion: "改写第一段", deterministic: false }], metrics: {}, reviewerRoles: [] };
    // Mock LLM 返回与原文完全相同的内容（相似度 = 1.0 > 0.92）
    vi.mocked(streamNovelModel).mockResolvedValue({ content: draftContent, promptHash: "no-change" });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);
    await novelDb.qualityReports.add(report);

    const waiting = await advanceChapterWorkflow(run.id);

    // R10: similarity > 0.92 触发回退——major issue 对应段落被确定性删除
    expect(streamNovelModel).toHaveBeenCalled();
    expect(waiting).toMatchObject({ status: "waiting-approval", currentStage: "manuscript-approval" });
    const revision = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((item) => item.stage === "revision").first();
    // 第一段（含"门人录"）应被删除
    expect(revision?.contentMarkdown).not.toContain("门人录");
    // 后续段落保留
    expect(revision?.contentMarkdown).toContain("佩剑客从佛像旁走出");
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
