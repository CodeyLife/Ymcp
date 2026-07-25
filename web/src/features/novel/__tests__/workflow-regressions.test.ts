import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
  callStructuredNovelModel: vi.fn(async ({ role }: { role: string }) => {
    if (role === "fact-extractor") return { data: { summary: "无变化", facts: [] }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "fact" };
    if (role === "character-enricher") return { data: { enrichments: [] }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "enrichment" };
    return { data: { scores: { plot: 1, characterVoice: 1, sceneEmbodiment: 1, dialogue: 1, specificity: 1, hookPayoff: 1, continuity: 1 }, issues: [] }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "review" };
  }),
  streamNovelModel: vi.fn(),
}));

import { callStructuredNovelModel, streamNovelModel } from "../ai";
import { addEntity, createChapter, createNovelProject, novelDb, recordBase, saveApprovedDocumentRevision } from "../db";
import type { ContextSource, NovelContextPacket, QualityIssue, QualityReport, WorkflowArtifact, WorkflowRun } from "../types";
import { advanceChapterWorkflow } from "../workflow";
import { applyRevisionWindows, collectRevisionParagraphs, findIssueParagraph, isBlueprintCoverageIssue, isRevisionRefusal, planRevisionWindows, selectRevisionIssuesForFeedback, shouldPromoteWarning } from "../workflow-stages/revision-stage";
import { isQualityRegression } from "../workflow-stages/review-stage";

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

/**
 * 构造带实体档案源的 contextPacket，用于验证 revision-stage 局部修订注入冻结上下文。
 */
function packetWithSources(projectId: string, marker: string): NovelContextPacket {
  const entitySource: ContextSource = {
    id: `entity-${marker}`,
    kind: "entity",
    title: `角色档案-${marker}`,
    content: `角色${marker}在第二章已得知密信内容，本章不得重新揭示。`,
    weight: 1.0,
    pinned: true,
    estimatedTokens: 50,
    reason: "实体档案",
    contentHash: marker,
    priorityClass: "invariant",
    layer: "mandatory",
    visibilityReason: "跨章连续性",
  };
  return { ...recordBase(projectId), task: "chapter-draft", instruction: "继续写作", sources: [entitySource], estimatedTokens: 50, omittedSourceIds: [], skillRefs: [], compiledAt: Date.now() };
}

describe("chapter workflow regressions", () => {
  it("merges adjacent revision ranges and only replaces their paragraph window", () => {
    const paragraphs = ["第一段", "第二段", "第三段", "第四段"];
    const first = { id: "a", dimension: "specificity", severity: "major", title: "碎片", description: "碎片", revisionRanges: [{ start: 2, end: 2 }], rule: "style.short", suggestion: "合并", deterministic: false } satisfies QualityIssue;
    const second = { ...first, id: "b", revisionRanges: [{ start: 3, end: 3 }] } satisfies QualityIssue;

    const planned = planRevisionWindows([first, second], paragraphs);
    expect(planned.windows).toHaveLength(1);
    expect(planned.windows[0]).toMatchObject({ start: 1, end: 2 });
    expect(applyRevisionWindows(paragraphs, [{ ...planned.windows[0], replacement: ["第二、三段局部改写"] }])).toEqual(["第一段", "第二、三段局部改写", "第四段"]);
  });

  it("keeps deterministic deletions out of revision windows and gives deletion precedence", () => {
    const paragraphs = ["第一段", "重复段", "需要局部改写的第三段", "第四段"];
    const issue = { id: "overlap", dimension: "specificity", severity: "major", title: "重叠问题", description: "第二、三段需要处理", revisionRanges: [{ start: 2, end: 3 }], rule: "style.overlap", suggestion: "局部修订", deterministic: false } satisfies QualityIssue;
    const deleted = new Set([1]);

    const planned = planRevisionWindows([issue], paragraphs, deleted);
    expect(planned.windows).toMatchObject([{ start: 2, end: 2 }]);
    expect(planned.windows[0].issues[0].revisionRanges).toEqual([{ start: 3, end: 3 }]);
    expect(applyRevisionWindows(paragraphs, [{ start: 1, end: 2, issues: [issue], replacement: ["不应采用的重叠替换"] }], deleted))
      .toEqual(["第一段", "需要局部改写的第三段", "第四段"]);
  });

  it("keeps unlocatable revision issues out of automatic rewrite windows", () => {
    const issue = { id: "missing", dimension: "plot", severity: "major", title: "无法定位", description: "无原文证据", rule: "plot.unknown", suggestion: "人工判断", deterministic: false } satisfies QualityIssue;
    const planned = planRevisionWindows([issue], ["原文第一段", "原文第二段"]);
    expect(planned.windows).toEqual([]);
    expect(planned.unlocated).toEqual([issue]);
  });

  it("limits an explicit POV revision request to POV-related issues", () => {
    const issue = (id: string, title: string): QualityIssue => ({ id, dimension: "continuity", severity: "major", title, description: title, rule: id, suggestion: title, deterministic: false });
    const pov = issue("pov", "视角越界进入他人心理");
    const prose = issue("prose", "短句碎片过多");
    const repetition = issue("repeat", "意象重复");
    expect(selectRevisionIssuesForFeedback([pov, prose, repetition], "只修限知视角和罗渡心理解释")).toEqual([pov]);
  });

  it("recognizes a missing final blueprint beat as a completion issue", () => {
    const issue = { id: "coverage", dimension: "plot", severity: "blocker", title: "最后节拍未完成", description: "正文在对白开头截断，章尾驱动力缺失。", rule: "chapter.incomplete-blueprint", suggestion: "补完末节拍", deterministic: false } satisfies QualityIssue;
    expect(isBlueprintCoverageIssue(issue)).toBe(true);
  });

  it("locates review excerpts despite punctuation and whitespace differences", () => {
    const issue = {
      id: "fuzzy",
      dimension: "specificity",
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

  it("keeps heuristic reader-retention warnings out of automatic revision", () => {
    const openingHookIssue: QualityIssue = {
      id: "oh", dimension: "readerRetention", severity: "warning",
      title: "开篇可能缺乏吸引力", description: "前200字未出现问号或反常细节。",
      paragraph: 1, revisionRanges: [{ start: 1, end: 2 }],
      rule: "reader.opening-hook", suggestion: "衔接上一章未解压力或抛出反常细节。", deterministic: true,
    };
    const endingHookIssue: QualityIssue = {
      id: "eh", dimension: "hookPayoff", severity: "warning",
      title: "章尾可能缺乏开放压力", description: "末段停留在封闭画面。",
      paragraph: 10, revisionRanges: [{ start: 9, end: 10 }],
      rule: "style.chapter-ending-hook", suggestion: "加入指向未解信息的细节。", deterministic: true,
    };
    expect(shouldPromoteWarning(openingHookIssue)).toBe(false);
    expect(shouldPromoteWarning(endingHookIssue)).toBe(false);
  });

  it("does not promote non-retention warnings or already-major issues", () => {
    // 非 reader-retention 的 warning 不应被新规则误升级
    const unrelatedWarning: QualityIssue = {
      id: "uw", dimension: "specificity", severity: "warning",
      title: "段落边界微调", description: "某段可略微压缩。",
      rule: "style.minor-tweak", suggestion: "压缩。", deterministic: true,
    };
    // 已是 major 的 issue 不经 shouldPromoteWarning（函数开头 severity !== warning 直接返回 false）
    const alreadyMajor: QualityIssue = {
      id: "am", dimension: "plot", severity: "major",
      title: "章尾可能缺乏开放压力", description: "末段封闭。",
      rule: "style.chapter-ending-hook", suggestion: "补钩子。", deterministic: false,
    };
    expect(shouldPromoteWarning(unrelatedWarning)).toBe(false);
    expect(shouldPromoteWarning(alreadyMajor)).toBe(false);
  });

  it("repairs a structurally invalid draft once before saving it into the workflow", async () => {
    const project = await createNovelProject({ title: "段落修复", genre: ["悬疑"], premise: "正文必须以常规段落进入审校。" });
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "draft", stageIndex: 3, revisionIteration: 0, contextPacketId: context.id, blueprintArtifactId: "blueprint-draft-repair", factCandidateIds: [], startedAt: Date.now() };
    const blueprint = artifact(run, { id: "blueprint-draft-repair", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "目标：进入废弃驿站。", structuredData: { title: "第一章", objective: "进入驿站", startingState: "官道", beats: [], endingHook: "门后有脚步", characters: [], locations: [], informationRelease: [], mustHappen: [], flexible: [], forbidden: [] } });
    const invalid = ["以下是正文：", "风停了。", "他抬起头。", "远处有人走来。"].join("\n\n");
    vi.mocked(streamNovelModel).mockResolvedValueOnce({ content: invalid, promptHash: "draft-invalid" });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.add(blueprint);

    await advanceChapterWorkflow(run.id);

    const draft = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((item) => item.stage === "draft").first();
    // repairDraftStructureOnce 确定性合并+移除格式标记，不调用 LLM 修复
    // 最低篇幅问题没有安全局部范围，不得再用第二次模型调用重写全文
    expect(streamNovelModel).toHaveBeenCalledTimes(1);
    // "以下是正文："被移除，正文段落边界保持不变
    expect(draft?.contentMarkdown).toBe("风停了。\n\n他抬起头。\n\n远处有人走来。");
  });

  it("repairs structural wrappers in a directed revision before saving the revision artifact", async () => {
    const project = await createNovelProject({ title: "修订格式", genre: ["悬疑"], premise: "定向修订只能返回一份正文。" });
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "revision", stageIndex: 6, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft-before-format-revision", blueprintArtifactId: "blueprint-format-revision", qualityReportId: "report-format-revision", factCandidateIds: [], startedAt: Date.now() };
    const draft = artifact(run, { id: "draft-before-format-revision", stage: "draft", kind: "draft", title: "原稿", contentMarkdown: "风从门缝里灌进来。他压低灯芯，屋里暗了一层。\n\n脚步停在门外。他没有出声，只把短刀移到手边。" });
    const blueprint = artifact(run, { id: "blueprint-format-revision", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "蓝图", structuredData: { title: "第一章", objective: "守住屋门", startingState: "屋内", beats: [], endingHook: "门外来人", characters: [], locations: [], informationRelease: [], mustHappen: [], flexible: [], forbidden: [] } });
    const report: QualityReport = { ...recordBase(project.id), id: "report-format-revision", workflowRunId: run.id, artifactId: draft.id, iteration: 0, scores: { plot: 2, characterVoice: 4, sceneEmbodiment: 4, dialogue: 4, specificity: 4, hookPayoff: 4, continuity: 4, readerRetention: 4 }, weightedScore: 3.5, blockerCount: 0, passed: false, issues: [{ id: "revise-range", dimension: "plot", severity: "major", title: "动作结果不清", description: "补足人物应对结果。", revisionRanges: [{ start: 1, end: 2 }], rule: "plot.action-result", suggestion: "在原范围内补足结果。", deterministic: false }], metrics: {}, reviewerRoles: [] };
    const invalid = ["以下是修订后的正文：", "风停了。", "灯暗了。", "脚步来到门外。"].join("\n\n");
    // 修订输出不足 1000 字时直接保留原文并转人工，不再浪费一轮审校调用。
    vi.mocked(streamNovelModel)
      .mockResolvedValueOnce({ content: invalid, promptHash: "revision-invalid" })
      .mockResolvedValueOnce({ content: "风停了。灯暗了。脚步来到门外。", promptHash: "revision-short" });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);
    await novelDb.qualityReports.add(report);

    await advanceChapterWorkflow(run.id);

    const revision = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((item) => item.stage === "revision").first();
    expect(streamNovelModel).toHaveBeenCalledTimes(1);
    expect(revision?.contentMarkdown).toBe(draft.contentMarkdown);
    expect((await novelDb.workflowRuns.get(run.id))?.currentStage).toBe("manuscript-approval");
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
    const character = await addEntity(project.id, "character", "陆沉");
    const document = await createChapter(project.id, "第一章");
    const approved = await saveApprovedDocumentRevision({ ...document, plainText: "陆沉抵达北港。", contentHtml: "<p>陆沉抵达北港。</p>", wordCount: 7, status: "review" }, "批准正文", "ai");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "fact-extraction", stageIndex: 8, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft-facts", factCandidateIds: [], startedAt: Date.now() };
    const draft = artifact(run, { id: "draft-facts", stage: "draft", kind: "draft", title: "正文", contentMarkdown: "陆沉抵达北港。" });
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "角色承认身份", facts: [{ targetTable: "entities", targetId: character.id, field: "character.secret", after: "继承人", evidence: "陆沉承认自己是继承人。", confidence: 0.98, novelty: "update", conflict: false }] },
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
    const character = await addEntity(project.id, "character", "陆沉");
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "fact-extraction", stageIndex: 8, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft-risk", factCandidateIds: [], startedAt: Date.now() };
    const draft = artifact(run, { id: "draft-risk", stage: "draft", kind: "draft", title: "正文", contentMarkdown: "陆沉抵达北港，并承认自己是继承人。" });
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "角色状态与秘密变化", facts: [
        { targetTable: "entities", targetId: character.id, field: "character.state.location", after: "北港", evidence: "陆沉抵达北港。", confidence: 0.98, novelty: "update", conflict: false },
        { targetTable: "entities", targetId: character.id, field: "character.secret", after: "继承人", evidence: "陆沉承认自己是继承人。", confidence: 0.99, novelty: "update", conflict: false },
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
    const report: QualityReport = { ...recordBase(project.id), id: "report", workflowRunId: run.id, artifactId: draft.id, iteration: 0, scores: { plot: 3, characterVoice: 3, sceneEmbodiment: 3, dialogue: 3, specificity: 3, hookPayoff: 3, continuity: 3, readerRetention: 3 }, weightedScore: 3, blockerCount: 0, passed: false, issues: [{ id: "issue", dimension: "plot", severity: "warning", title: "问题", description: "无法定位", rule: "test", suggestion: "人工判断", deterministic: false }], metrics: {}, reviewerRoles: [] };
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);
    await novelDb.qualityReports.add(report);

    const waiting = await advanceChapterWorkflow(run.id);

    expect(waiting).toMatchObject({ status: "waiting-approval", currentStage: "manuscript-approval" });
    expect(await novelDb.proposals.where("projectId").equals(project.id).and((item) => item.targetId === run.id && item.status === "pending").count()).toBe(1);
    expect(streamNovelModel).not.toHaveBeenCalled();
  });

  it("preserves the manuscript for major issues without paragraph location", async () => {
    const project = await createNovelProject({ title: "安全修订", genre: ["悬疑"], premise: "无法定位段落时保留正文。" });
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "revision", stageIndex: 6, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft", blueprintArtifactId: "blueprint", qualityReportId: "report", factCandidateIds: [], startedAt: Date.now() };
    const draft = artifact(run, { id: "draft", stage: "draft", kind: "draft", title: "正文", contentMarkdown: "第一段。\n\n第二段。" });
    const blueprint = artifact(run, { id: "blueprint", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "蓝图" });
    const report: QualityReport = { ...recordBase(project.id), id: "report", workflowRunId: run.id, artifactId: draft.id, iteration: 0, scores: { plot: 3, characterVoice: 3, sceneEmbodiment: 3, dialogue: 3, specificity: 3, hookPayoff: 3, continuity: 3, readerRetention: 3 }, weightedScore: 3, blockerCount: 0, passed: false, issues: [{ id: "issue", dimension: "plot", severity: "major", title: "问题", description: "无法定位", rule: "test", suggestion: "人工判断", deterministic: false }], metrics: {}, reviewerRoles: [] };
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);
    await novelDb.qualityReports.add(report);

    const waiting = await advanceChapterWorkflow(run.id);

    expect(streamNovelModel).not.toHaveBeenCalled();
    expect(waiting).toMatchObject({ status: "waiting-approval", currentStage: "manuscript-approval" });
    // 修订产物存在
    const revisions = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((item) => item.stage === "revision").toArray();
    expect(revisions.length).toBeGreaterThan(0);
  });

  it("preserves the manuscript when a local revision fails fidelity checks", async () => {
    const project = await createNovelProject({ title: "相似度回退", genre: ["悬疑"], premise: "LLM 返回与原文实质相同时回退到确定性删除。" });
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "revision", stageIndex: 6, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft-similar", blueprintArtifactId: "blueprint-similar", qualityReportId: "report-similar", factCandidateIds: [], startedAt: Date.now() };
    // 使用足够长的段落避免碎片化合并干扰断言
    const draftContent = "寒灯挂在庙檐下，火苗被风吹得摇晃。沈雁声推门进去，庙中有一张旧木桌，桌上放着一壶热茶。她从怀中取出门人录，陆无名三个字静静留在那里。\n\n佩剑客从佛像旁走出，衣着整洁，剑穗随步轻摆。那是她曾见过的样式。听潮阁已灭，所以才要寻。他递茶试探，言语温雅却句句指向旧事。\n\n她抬手一挥，桌上的寒灯翻倒。灯油洒在地面，火光被夜风卷起。佩剑客人退了一步。沈雁声借这一瞬掠向侧墙，剑锋擦过她的袖口。";
    const draft = artifact(run, { id: "draft-similar", stage: "draft", kind: "draft", title: "正文", contentMarkdown: draftContent });
    const blueprint = artifact(run, { id: "blueprint-similar", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "蓝图" });
    const report: QualityReport = { ...recordBase(project.id), id: "report-similar", workflowRunId: run.id, artifactId: draft.id, iteration: 0, scores: { plot: 3, characterVoice: 3, sceneEmbodiment: 3, dialogue: 3, specificity: 3, hookPayoff: 3, continuity: 3, readerRetention: 3 }, weightedScore: 3, blockerCount: 0, passed: false, issues: [{ id: "issue-similar", dimension: "plot", severity: "major", title: "心理判断句", description: "需要修订", revisionRanges: [{ start: 1, end: 1 }], rule: "style.test", suggestion: "改写第一段", deterministic: false }], metrics: {}, reviewerRoles: [] };
    // Mock LLM 返回与原文完全相同的内容（相似度 = 1.0 > 0.92）
    vi.mocked(streamNovelModel).mockResolvedValue({ content: draftContent, promptHash: "no-change" });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);
    await novelDb.qualityReports.add(report);

    const waiting = await advanceChapterWorkflow(run.id);

    // 局部修订未形成安全替换时，不得删除非重复问题对应的原文
    expect(streamNovelModel).toHaveBeenCalled();
    expect(waiting).toMatchObject({ status: "waiting-approval", currentStage: "manuscript-approval" });
    const revision = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((item) => item.stage === "revision").first();
    expect(revision?.contentMarkdown).toContain("门人录");
    expect(revision?.contentMarkdown).toContain("佩剑客从佛像旁走出");
  });

  it("routes all-fidelity-failed revisions above the 1000-word floor to manual approval instead of review loop", async () => {
    // F-011 修复回归：draft > 1000 字 + 所有局部修订窗口均未通过保真校验（replacements=0、paragraphsToDelete=空）
    // 修复前：failAgent 未 return → finishAgent 覆盖 failed 状态为 completed → transition(review) 回环浪费 6 次 LLM 调用
    // 修复后：failAgent + repair + saveArtifact + createApprovalProposal + transition(manuscript-approval) + return
    const project = await createNovelProject({ title: "全窗口保真失败", genre: ["悬疑"], premise: "F-011 回归覆盖。" });
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "revision", stageIndex: 6, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft-fidelity", blueprintArtifactId: "blueprint-fidelity", qualityReportId: "report-fidelity", factCandidateIds: [], startedAt: Date.now() };
    // 构造 > 1000 字的原文，避免落入 <=1000 字分支
    const longParagraph = "寒灯挂在庙檐下，火苗被风吹得摇晃。沈雁声推门进去，庙中有一张旧木桌，桌上放着一壶热茶。她从怀中取出门人录，陆无名三个字静静留在那里。佩剑客从佛像旁走出，衣着整洁，剑穗随步轻摆。那是她曾见过的样式。听潮阁已灭，所以才要寻。他递茶试探，言语温雅却句句指向旧事。她抬手一挥，桌上的寒灯翻倒。灯油洒在地面，火光被夜风卷起。佩剑客人退了一步。沈雁声借这一瞬掠向侧墙，剑锋擦过她的袖口。".repeat(6);
    const draft = artifact(run, { id: "draft-fidelity", stage: "draft", kind: "draft", title: "正文", contentMarkdown: longParagraph });
    const blueprint = artifact(run, { id: "blueprint-fidelity", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "蓝图" });
    const report: QualityReport = { ...recordBase(project.id), id: "report-fidelity", workflowRunId: run.id, artifactId: draft.id, iteration: 0, scores: { plot: 3, characterVoice: 3, sceneEmbodiment: 3, dialogue: 3, specificity: 3, hookPayoff: 3, continuity: 3, readerRetention: 3 }, weightedScore: 3, blockerCount: 0, passed: false, issues: [{ id: "issue-fidelity", dimension: "plot", severity: "major", title: "心理判断句", description: "需要修订", revisionRanges: [{ start: 1, end: 1 }], rule: "style.test", suggestion: "改写第一段", deterministic: false }], metrics: {}, reviewerRoles: [] };
    // Mock LLM 返回与原文完全相同的内容（unchanged > 0.995）→ 所有窗口保真失败
    vi.mocked(streamNovelModel).mockResolvedValue({ content: longParagraph, promptHash: "no-change" });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);
    await novelDb.qualityReports.add(report);

    const waiting = await advanceChapterWorkflow(run.id);

    // 必须停在人工审批，不得回环 review
    expect(waiting).toMatchObject({ status: "waiting-approval", currentStage: "manuscript-approval" });
    // agent 必须保留 failed 状态，不被 finishAgent 覆盖为 completed
    const failedAgent = await novelDb.agentRuns.where("projectId").equals(project.id).and((item) => item.workflowRunId === run.id && item.status === "failed").first();
    expect(failedAgent).toBeDefined();
    const completedAgent = await novelDb.agentRuns.where("projectId").equals(project.id).and((item) => item.workflowRunId === run.id && item.status === "completed").first();
    expect(completedAgent).toBeUndefined();
    // 必须保存 fallback 修订稿（结构修复后）并转人工
    const revision = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((item) => item.stage === "revision").first();
    expect(revision).toBeDefined();
    expect(revision?.contentMarkdown).toContain("门人录");
  });

  it("does not regress a revision that removes major issues despite a slightly lower score", () => {
    const base = { ...recordBase("project"), workflowRunId: "run", artifactId: "artifact", iteration: 0, scores: { plot: 4, characterVoice: 4, sceneEmbodiment: 4, dialogue: 4, specificity: 4, hookPayoff: 4, continuity: 4, readerRetention: 4 }, blockerCount: 0, passed: false, metrics: {}, reviewerRoles: [] };
    const major = { id: "major", dimension: "plot", severity: "major", title: "主要问题", description: "问题", rule: "plot.test", suggestion: "修订", deterministic: false } satisfies QualityIssue;
    const previous = { ...base, weightedScore: 4.2, issues: [major] } satisfies QualityReport;
    const current = { ...base, id: "current", weightedScore: 4.1, issues: [] } satisfies QualityReport;
    expect(isQualityRegression({ previous, current })).toBe(false);
  });

  it("regresses a higher-scoring revision that introduces a blocker", () => {
    const base = { ...recordBase("project"), workflowRunId: "run", artifactId: "artifact", iteration: 0, scores: { plot: 4, characterVoice: 4, sceneEmbodiment: 4, dialogue: 4, specificity: 4, hookPayoff: 4, continuity: 4, readerRetention: 4 }, passed: false, metrics: {}, reviewerRoles: [] };
    const blocker = { id: "blocker", dimension: "continuity", severity: "blocker", title: "事实冲突", description: "冲突", rule: "continuity.test", suggestion: "恢复事实", deterministic: false } satisfies QualityIssue;
    const previous = { ...base, weightedScore: 3.8, blockerCount: 0, issues: [] } satisfies QualityReport;
    const current = { ...base, id: "current-blocked", weightedScore: 4.3, blockerCount: 1, issues: [blocker] } satisfies QualityReport;
    expect(isQualityRegression({ previous, current })).toBe(true);
  });

  it("does not compare weighted scores across scoring versions", () => {
    const base = { ...recordBase("project"), workflowRunId: "run", artifactId: "artifact", iteration: 0, scores: { plot: 4, characterVoice: 4, sceneEmbodiment: 4, dialogue: 4, specificity: 4, hookPayoff: 4, continuity: 4, readerRetention: 4 }, blockerCount: 0, passed: false, issues: [], metrics: {}, reviewerRoles: [] };
    const previous = { ...base, scoringVersion: 1, weightedScore: 4.4 } satisfies QualityReport;
    const current = { ...base, id: "current-v2", scoringVersion: 2, weightedScore: 3.8 } satisfies QualityReport;

    expect(isQualityRegression({ previous, current })).toBe(false);
  });

  it("restores the previous draft when a revision scores lower", async () => {
    const project = await createNovelProject({ title: "修订回滚", genre: ["悬疑"], premise: "低分修订不能替换原稿。" });
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "review", stageIndex: 5, revisionIteration: 1, previousScore: 4.2, contextPacketId: context.id, blueprintArtifactId: "blueprint", draftArtifactId: "revised", qualityReportId: "previous-report", factCandidateIds: [], startedAt: Date.now() };
    const original = artifact(run, { id: "original", stage: "draft", kind: "draft", title: "原稿", contentMarkdown: "原稿内容。" });
    const revised = artifact(run, { id: "revised", stage: "revision", kind: "revision", title: "修订稿", contentMarkdown: "较差修订。", parentArtifactId: original.id });
    const blueprint = artifact(run, { id: "blueprint", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "蓝图" });
    // F-001 修复后，isQualityRegression 调用方必须传入 comparablePreviousScore（previousReport 不可读时为 undefined）。
    // 要让回归路径生效（previousReport 存在 + scoringVersion 兼容 + 分数下降），必须把 previousReport 加入 db 让其可读。
    const previousReport: QualityReport = { ...recordBase(project.id), id: "previous-report", workflowRunId: run.id, artifactId: original.id, iteration: 0, scoringVersion: 3, scores: { plot: 4, characterVoice: 4, sceneEmbodiment: 4, dialogue: 4, specificity: 4, hookPayoff: 4, continuity: 4, readerRetention: 4 }, weightedScore: 4.2, blockerCount: 0, passed: false, issues: [], metrics: {}, reviewerRoles: [] };
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([original, revised, blueprint]);
    await novelDb.qualityReports.add(previousReport);

    const waiting = await advanceChapterWorkflow(run.id);

    expect(waiting).toMatchObject({ status: "waiting-approval", currentStage: "manuscript-approval", draftArtifactId: original.id, qualityReportId: "previous-report" });
    expect((await novelDb.proposals.where("projectId").equals(project.id).and((item) => item.targetId === run.id).first())?.artifactId).toBe(original.id);
  });

  it("injects contextPacket digest into the local revision prompt (audit Loop 1 问题 A 修复验证)", async () => {
    // 验证 revision-stage 局部修订 LLM 调用 prompt 包含冻结上下文摘要。
    // 修复前：局部修订 prompt 不注入 contextPacket，跨章连续性修订缺前章事实。
    // 修复后：通过 buildRevisionContextDigest(packet) 注入 formatReviewerContext 摘要。
    const project = await createNovelProject({ title: "上下文注入验证", genre: ["悬疑"], premise: "局部修订需注入冻结上下文。" });
    const document = await createChapter(project.id, "第一章");
    const context = packetWithSources(project.id, "沈雁声");
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "revision", stageIndex: 6, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft-ctx", blueprintArtifactId: "blueprint-ctx", qualityReportId: "report-ctx", factCandidateIds: [], startedAt: Date.now() };
    const draftContent = "寒灯挂在庙檐下，火苗被风吹得摇晃。沈雁声推门进去，庙中有一张旧木桌，桌上放着一壶热茶。她从怀中取出门人录，陆无名三个字静静留在那里。\n\n佩剑客从佛像旁走出，衣着整洁，剑穗随步轻摆。那是她曾见过的样式。听潮阁已灭，所以才要寻。他递茶试探，言语温雅却句句指向旧事。";
    const draft = artifact(run, { id: "draft-ctx", stage: "draft", kind: "draft", title: "正文", contentMarkdown: draftContent });
    const blueprint = artifact(run, { id: "blueprint-ctx", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "蓝图" });
    const report: QualityReport = { ...recordBase(project.id), id: "report-ctx", workflowRunId: run.id, artifactId: draft.id, iteration: 0, scores: { plot: 3, characterVoice: 3, sceneEmbodiment: 3, dialogue: 3, specificity: 3, hookPayoff: 3, continuity: 3, readerRetention: 3 }, weightedScore: 3, blockerCount: 0, passed: false, issues: [{ id: "issue-ctx", dimension: "continuity", severity: "major", title: "跨章事实", description: "需要核对前章", revisionRanges: [{ start: 1, end: 1 }], rule: "continuity.cross-chapter", suggestion: "核对沈雁声已知信息", deterministic: false }], metrics: {}, reviewerRoles: [] };
    vi.mocked(streamNovelModel).mockResolvedValue({ content: "寒灯挂在庙檐下，火苗被风吹得摇晃。沈雁声推门进去，庙中有一张旧木桌。", promptHash: "ctx-fix" });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);
    await novelDb.qualityReports.add(report);

    await advanceChapterWorkflow(run.id);

    // streamNovelModel 必须被调用（局部修订路径触发）
    expect(streamNovelModel).toHaveBeenCalled();
    const revisionCall = vi.mocked(streamNovelModel).mock.calls.find((call) => (call[0] as { role?: string }).role === "revision-editor");
    expect(revisionCall).toBeDefined();
    const prompt = (revisionCall![0] as { prompt: string }).prompt;
    // 修复验证：prompt 必须包含冻结上下文段，且包含 contextPacket 中的实体档案内容
    expect(prompt).toContain("冻结上下文");
    expect(prompt).toContain("沈雁声在第二章已得知密信内容");
    // 修订契约第 2 条必须要求以冻结上下文为准
    expect(prompt).toContain('修订涉及跨章事实时必须以"冻结上下文"为准');
  });

  it("falls back to explicit no-context hint when contextPacket has no sources (audit Loop 1 问题 A 边界验证)", async () => {
    // 边界场景：contextPacket 存在但 sources 为空 → formatReviewerContext 返回空 → buildRevisionContextDigest 返回 undefined
    // 修复后：prompt 注入显式提示"本章无冻结上下文...不得新增原文与蓝图中都不存在的事实"
    const project = await createNovelProject({ title: "空上下文边界", genre: ["悬疑"], premise: "空 packet 不得阻塞修订。" });
    const document = await createChapter(project.id, "第一章");
    const context = packet(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "revision", stageIndex: 6, revisionIteration: 0, contextPacketId: context.id, draftArtifactId: "draft-empty-ctx", blueprintArtifactId: "blueprint-empty-ctx", qualityReportId: "report-empty-ctx", factCandidateIds: [], startedAt: Date.now() };
    const draftContent = "寒灯挂在庙檐下，火苗被风吹得摇晃。沈雁声推门进去，庙中有一张旧木桌，桌上放着一壶热茶。她从怀中取出门人录，陆无名三个字静静留在那里。\n\n佩剑客从佛像旁走出，衣着整洁，剑穗随步轻摆。那是她曾见过的样式。听潮阁已灭，所以才要寻。";
    const draft = artifact(run, { id: "draft-empty-ctx", stage: "draft", kind: "draft", title: "正文", contentMarkdown: draftContent });
    const blueprint = artifact(run, { id: "blueprint-empty-ctx", stage: "blueprint", kind: "blueprint", title: "蓝图", contentMarkdown: "蓝图" });
    const report: QualityReport = { ...recordBase(project.id), id: "report-empty-ctx", workflowRunId: run.id, artifactId: draft.id, iteration: 0, scores: { plot: 3, characterVoice: 3, sceneEmbodiment: 3, dialogue: 3, specificity: 3, hookPayoff: 3, continuity: 3, readerRetention: 3 }, weightedScore: 3, blockerCount: 0, passed: false, issues: [{ id: "issue-empty-ctx", dimension: "specificity", severity: "major", title: "碎片", description: "需要修订", revisionRanges: [{ start: 1, end: 1 }], rule: "style.short", suggestion: "改写第一段", deterministic: false }], metrics: {}, reviewerRoles: [] };
    vi.mocked(streamNovelModel).mockResolvedValue({ content: "寒灯挂在庙檐下，火苗被风吹得摇晃。沈雁声推门进去，庙中有一张旧木桌。", promptHash: "empty-ctx" });
    await novelDb.contextPackets.add(context);
    await novelDb.workflowRuns.add(run);
    await novelDb.workflowArtifacts.bulkAdd([draft, blueprint]);
    await novelDb.qualityReports.add(report);

    await advanceChapterWorkflow(run.id);

    const revisionCall = vi.mocked(streamNovelModel).mock.calls.find((call) => (call[0] as { role?: string }).role === "revision-editor");
    expect(revisionCall).toBeDefined();
    const prompt = (revisionCall![0] as { prompt: string }).prompt;
    // 边界验证：空 packet 时注入显式提示，不得臆造事实
    expect(prompt).toContain("本章无冻结上下文");
    expect(prompt).toContain("不得新增原文与蓝图中都不存在的事实");
  });
});
