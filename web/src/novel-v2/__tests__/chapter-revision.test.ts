import { describe, expect, it } from "vitest";
import { applyRevisionWindows, applyTargetedRevisionReplacements, buildAuthorRevisionAlignmentPrompt, buildAuthorRevisionBrief, buildAuthorRevisionRepairPrompt, buildFullChapterRevisionPrompt, buildFullChapterRevisionPromptPackage, buildRevisionWindowPrompt, buildTargetedRevisionBatchPrompt, planRevisionWindows, revisionWindowsCoverAllIssues, shouldUseRevisionWindows } from "../prompts/chapter-revision";
import type { MemoryBundle, ReviewIssue, SkillBundle } from "../protocol";

const memory: MemoryBundle = {
  id: "m", projectId: "p", preflightId: "pf", claims: [], conflicts: [], missingFacets: [], tokenBudget: 1000, sourceRevisionIds: [], fingerprint: "m", createdAt: 1,
  narrativeRhythm: {
    arcId: "arc-1",
    fingerprint: "rhythm-1",
    chapters: [{ documentId: "doc-1", revisionId: "rev-1", narrativeOrder: 1, title: "雨后", summary: "两人清理现场", keyEvents: ["归还钥匙"], emotionalArc: "紧张转为克制", narrativeFunction: "aftermath", thematicMode: "absent", themeCarrier: "none", issueFamilies: [] }],
  },
};

describe("chapter revision windows", () => {
  it("compiles full revision sources as separate auditable sections", () => {
    const revisionMemory: MemoryBundle = {
      ...memory,
      claims: [{ id: "episodic-1", projectId: "p", kind: "episodic", title: "重复前章摘要", content: "两人清理现场", subjectRefs: [], knowledgeScope: "author", authority: "derived", confidence: 1, sourceRevisionIds: ["rev-1"], contentHash: "episodic-1", supersedes: [], score: 1, matchedFacet: "chapter-memory", reason: "pinned" }],
    };
    const packageResult = buildFullChapterRevisionPromptPackage({
      projectId: "p", workflowId: "wf", system: "revision", sourceArtifactId: "artifact-1",
      maxInputTokens: 20_000, maxOutputTokens: 4_000, text: "旧正文", memory: revisionMemory,
      issues: [{ severity: "major", title: "对白直白", evidence: "原句", suggestion: "改为行动与停顿" }],
      authorInstruction: "重新设计对白，让戒备通过动作呈现。",
    });
    expect(packageResult.manifest.sections.map((section) => section.id)).toEqual(expect.arrayContaining(["revision-contract", "author-instruction", "source-manuscript", "revision-interpretation-guide", "review-issues", "revision-facts", "revision-rhythm", "revision-skills"]));
    expect(packageResult.instruction).toContain("雨后");
    expect(packageResult.instruction.match(/重新设计对白，让戒备通过动作呈现。/g)).toHaveLength(1);
    expect(packageResult.sections.find((section) => section.id === "revision-facts")?.text).not.toContain("重复前章摘要");
  });

  it("merges overlapping evidence ranges and leaves unrelated paragraphs untouched", () => {
    const issues: ReviewIssue[] = [
      { severity: "major", title: "抽象结论", evidence: "第二段", revisionRanges: [{ start: 2, end: 2 }], suggestion: "改为动作" },
      { severity: "major", title: "重复解释", evidence: "第三段", paragraph: 3, suggestion: "删除解释" },
    ];
    const text = "第一段\n\n第二段\n\n第三段\n\n第四段";
    const windows = planRevisionWindows(text, issues);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ start: 1, end: 2 });
    expect(applyRevisionWindows(text, [{ window: windows[0], text: "新二段\n\n新三段" }])).toBe("第一段\n\n新二段\n\n新三段\n\n第四段");
  });

  it("locates an issue by excerpt and includes evidence plus read-only neighbors with rewrite as reference-only", () => {
    const issue: ReviewIssue = { severity: "major", title: "心理总结", evidence: "他感到安全", excerpt: "他感到安全", rewriteExample: "他把杯沿摆正。" };
    const text = "雨落下来。\n\n他感到安全。\n\n电话响了。";
    const [window] = planRevisionWindows(text, [issue]);
    const prompt = buildRevisionWindowPrompt({ text, window, memory });
    expect(window).toMatchObject({ start: 1, end: 1 });
    expect(prompt).toContain("他把杯沿摆正。");
    expect(prompt).toContain("不得直接搬用");
    expect(prompt).toContain("必须自行完成实际改写");
    expect(prompt).toContain("雨落下来。");
    expect(prompt).toContain("电话响了。");
    expect(prompt).toContain("连续章节叙事节奏");
  });

  it("applies multiple targeted replacements while preserving every protected paragraph", () => {
    const text = "雪落在门外。\n\n她说自己不怕。\n\n炉火仍旧安静。\n\n像齿轮一样精确。\n\n天亮了。";
    const issues: ReviewIssue[] = [
      { severity: "warning", title: "情绪直说", evidence: "她说自己不怕", revisionRanges: [{ start: 2, end: 2 }] },
      { severity: "major", title: "意象失配", evidence: "像齿轮一样精确", revisionRanges: [{ start: 4, end: 4 }] },
    ];
    const windows = planRevisionWindows(text, issues);
    const revised = applyTargetedRevisionReplacements(text, windows, [
      { start: 2, end: 2, text: "她把发抖的手藏进袖中。" },
      { start: 4, end: 4, text: "纹路一笔不差地扣回阵眼。" },
    ]);

    expect(revised).toBe("雪落在门外。\n\n她把发抖的手藏进袖中。\n\n炉火仍旧安静。\n\n纹路一笔不差地扣回阵眼。\n\n天亮了。");
    expect(() => applyTargetedRevisionReplacements(text, windows, [{ start: 1, end: 1, text: "越界修改" }])).toThrow(/目标修订窗口/);
    expect(() => applyTargetedRevisionReplacements(text, windows, [{ start: 2, end: 2, text: "只改一个窗口" }])).toThrow(/全部目标修订窗口/);
  });

  it("tells external editors to return the exact original chapter ranges", () => {
    const text = "一。\n\n二。\n\n三。\n\n四。\n\n五。";
    const windows = planRevisionWindows(text, [
      { severity: "warning", title: "二", evidence: "二。", revisionRanges: [{ start: 2, end: 2 }] },
      { severity: "major", title: "四", evidence: "四。", revisionRanges: [{ start: 4, end: 4 }] },
    ]);

    const prompt = buildTargetedRevisionBatchPrompt({ text, windows, memory });

    expect(prompt).toContain("完整返回以下所有范围：2-2、4-4");
    expect(prompt).toContain('"start":2,"end":2');
    expect(prompt).toContain('"start":4,"end":4');
  });

  it("applies the author's supplemental direction to every selected revision window", () => {
    const text = "风停了。\n\n她推开门。\n\n灯仍亮着。";
    const windows = planRevisionWindows(text, [
      { severity: "major", title: "动作缺少阻力", evidence: "她推开门。", revisionRanges: [{ start: 2, end: 2 }] },
    ]);

    const prompt = buildTargetedRevisionBatchPrompt({
      text,
      windows,
      memory,
      authorInstruction: "保留克制语气，并通过门轴阻滞表现人物犹豫。",
    });

    expect(prompt).toContain("作者补充修改要求");
    expect(prompt).toContain("保留克制语气，并通过门轴阻滞表现人物犹豫");
    expect(prompt).toContain("不得借反馈越过目标段落或新增未建立事实");
  });

  it("detects when an unlocated author requirement cannot be executed inside review windows", () => {
    const located: ReviewIssue = { severity: "warning", title: "第二段重复", evidence: "她推开门。", revisionRanges: [{ start: 2, end: 2 }] };
    const authorRequirement: ReviewIssue = { severity: "warning", title: "作者补充修改要求", evidence: "作者要求减少整章对白", suggestion: "女主保持高冷，只保留必要对白" };
    const text = "风停了。\n\n她推开门。\n\n她问他为何来。";
    const windows = planRevisionWindows(text, [located, authorRequirement]);

    expect(revisionWindowsCoverAllIssues(windows, [located])).toBe(true);
    expect(revisionWindowsCoverAllIssues(windows, [located, authorRequirement])).toBe(false);
  });

  it("allows author-directed regeneration to use review issue windows", () => {
    expect(shouldUseRevisionWindows({ requiresFullRevision: false })).toBe(true);
    expect(shouldUseRevisionWindows({ requiresFullRevision: false, authorInstruction: "重新设计本章对白关系和信息释放。" })).toBe(true);
    expect(shouldUseRevisionWindows({ requiresFullRevision: true })).toBe(false);
  });

  it("places unlocated author requirements at the top of the full-chapter revision prompt", () => {
    const prompt = buildFullChapterRevisionPrompt({
      text: "她问他为何来。",
      issues: [{ severity: "warning", title: "对白过多", evidence: "她问他为何来。" }],
      memory,
      authorInstruction: "女主保持高冷，删除尬聊，只留下能引发好奇的必要对白。",
    });

    expect(prompt.indexOf("作者反馈转译为本轮修订策略（最高优先级）")).toBeLessThan(prompt.indexOf("## 原文"));
    expect(prompt).toContain("女主保持高冷，删除尬聊");
    expect(prompt).toContain("逐项落实作者策略和审核问题");
    expect(prompt.match(/女主保持高冷，删除尬聊/gu)).toHaveLength(1);
  });

  it("frames rewrite examples as reference-only direction, not candidate text to copy", () => {
    const issue: ReviewIssue = {
      severity: "major",
      title: "视角越界",
      evidence: "他重新估量着眼前的人",
      revisionRanges: [{ start: 1, end: 1 }],
      suggestion: "只保留视角人物可感知的动作",
      rewriteExample: "转而在心中重新估量着眼前这个衣衫寒酸的弟子",
    };
    const text = "他重新估量着眼前的人。";
    const windows = planRevisionWindows(text, [issue]);

    const fullPrompt = buildFullChapterRevisionPrompt({ text, issues: [issue], memory });
    const windowPrompt = buildTargetedRevisionBatchPrompt({ text, windows, memory });

    expect(fullPrompt).toContain(issue.rewriteExample);
    expect(fullPrompt).toContain("不得直接搬用");
    expect(windowPrompt).toContain(issue.rewriteExample);
    expect(windowPrompt).toContain("不得直接搬用");
  });

  it("does not let full skill prompts compete with an explicit author direction", () => {
    const skills: SkillBundle = {
      id: "skills",
      projectId: "p",
      preflightId: "pf",
      skills: [{
        skillId: "ensemble-voice",
        version: "1.0.0",
        qualityGates: [],
        promptSections: { revision: "让每个有动作的次要角色都增加一段对白。" },
      }],
      conflicts: [],
      missingCapabilities: [],
      fingerprint: "skills",
      createdAt: 1,
    };
    const directed = buildFullChapterRevisionPrompt({
      text: "她沉默着收起琴。",
      issues: [],
      memory,
      skills,
      authorInstruction: "减少对白，让人物关系主要通过动作和停顿呈现。",
    });
    const reviewOnly = buildFullChapterRevisionPrompt({ text: "她沉默着收起琴。", issues: [], memory, skills });

    expect(directed).not.toContain("让每个有动作的次要角色都增加一段对白");
    expect(directed).toContain("仅作为不冲突时的背景参考");
    expect(reviewOnly).toContain("让每个有动作的次要角色都增加一段对白");
  });

  it("keeps factual memories but collapses broad foundation prose during author-directed revision", () => {
    const broadContent = "宏观创作说明".repeat(500);
    const directedMemory: MemoryBundle = {
      ...memory,
      claims: [
        { id: "foundation", projectId: "p", kind: "hierarchical", title: "全书叙事架构", content: broadContent, subjectRefs: [], narrativeRange: { start: 0 }, knowledgeScope: "author", authority: "derived", confidence: 0.8, sourceRevisionIds: [], contentHash: "foundation", supersedes: [], score: 1, matchedFacet: "plot", reason: "test" },
        { id: "fact", projectId: "p", kind: "episodic", title: "人物已经离开车站", content: "人物已经离开车站，下一幕不能仍在站台。", subjectRefs: [], narrativeRange: { start: 1 }, knowledgeScope: "author", authority: "derived", confidence: 1, sourceRevisionIds: [], contentHash: "fact", supersedes: [], score: 1, matchedFacet: "continuity", reason: "test" },
      ],
    };
    const prompt = buildFullChapterRevisionPrompt({ text: "他站在雨里。", issues: [], memory: directedMemory, authorInstruction: "让这一幕更舒缓，多留一些环境感受。" });

    expect(prompt).toContain("人物已经离开车站，下一幕不能仍在站台");
    expect(prompt).toContain("全书叙事架构");
    expect(prompt).not.toContain(broadContent);
    expect(prompt).toContain("宏观背景索引（软参考）");
  });

  it("assesses observable author-goal alignment instead of keyword presence", () => {
    const prompt = buildAuthorRevisionAlignmentPrompt({
      original: "她快速交代完往事，立刻推门离开。",
      candidate: "她快速说明旧事，随即推门离开。",
      authorInstruction: "这一段慢下来，让回忆通过房间里的旧物自然浮现。",
    });

    expect(prompt).toContain("实际阅读效果判断");
    expect(prompt).toContain("仅修复无关审校问题、删除一处重复或做同义替换不算完成");
    expect(prompt).toContain("这一段慢下来");
    expect(prompt).toContain("她快速说明旧事");
  });

  it("feeds unmet natural-language goals back into a complete-text repair", () => {
    const prompt = buildAuthorRevisionRepairPrompt({
      original: "她问：\"你来做什么？\"他答：\"来找你。\"",
      candidate: "她问：\"你为何来？\"他答：\"来寻你。\"",
      authorInstruction: "重做人物之间的交流，让疏离感主要来自行动和停顿。",
      alignment: { satisfied: false, summary: "仍是同义替换", unmetRequirements: ["交流结构没有改变"], evidence: ["问答句式与原文相同"] },
      memory,
    });

    expect(prompt).toContain("交流结构没有改变");
    expect(prompt).toContain("问答句式与原文相同");
    expect(prompt).toContain("当前候选（在此基础上继续修订）");
    expect(prompt).toContain("雨后");
    expect(prompt).not.toContain("对白必须少于");
  });

  it("passes author feedback through as-is without a fixed intent taxonomy", () => {
    const brief = buildAuthorRevisionBrief("对白设计太烂了，女主高冷一点，不要强调道和理，只引发读者好奇。");

    expect(brief).toContain("对白设计太烂了");
    expect(brief).toContain("女主高冷一点");
    expect(brief).toContain("不要强调道和理");
    expect(brief).toContain("只引发读者好奇");
    expect(brief).toContain("不要用关键词表替作者归类");
    expect(brief).toContain("自行判断受影响范围");
    expect(brief).not.toContain("6 类意图");
    expect(brief).not.toContain("示例词");
  });

  it("preserves materially different feedback without special-case vocabulary", () => {
    const brief = buildAuthorRevisionBrief("这段太干巴巴，散文化一点，节奏太慢。");

    expect(brief).toContain("这段太干巴巴，散文化一点，节奏太慢。");
    expect(brief).toContain("阅读效果、叙事选择和保留边界");
  });

  it("returns default brief when no author instruction provided", () => {
    const brief = buildAuthorRevisionBrief(undefined);
    expect(brief).toContain("无作者补充取舍");
  });

  it("keeps author direction general instead of keyword-specific hard constraints", () => {
    const brief = buildAuthorRevisionBrief("对白设计太烂了，女主高冷一点，不要强调道和理，只引发读者好奇。");

    expect(brief).toContain("作者原话（最高优先级）");
    expect(brief).toContain("对白设计太烂了");
    expect(brief).toContain("自行判断受影响范围");
    expect(brief).toContain("调整所有必要段落");
    expect(brief).not.toContain("对白策略");
    expect(brief).not.toContain("高冷不是");
  });
});
