import { describe, expect, it } from "vitest";
import { applyRevisionWindows, applyTargetedRevisionReplacements, buildAuthorRevisionBrief, buildFullChapterRevisionPrompt, buildRevisionWindowPrompt, buildTargetedRevisionBatchPrompt, planRevisionWindows, revisionWindowsCoverAllIssues } from "../prompts/chapter-revision";
import type { MemoryBundle, ReviewIssue } from "../protocol";

const memory: MemoryBundle = { id: "m", projectId: "p", preflightId: "pf", claims: [], conflicts: [], missingFacets: [], tokenBudget: 1000, sourceRevisionIds: [], fingerprint: "m", createdAt: 1 };

describe("chapter revision windows", () => {
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

  it("locates an issue by excerpt and includes evidence plus read-only neighbors", () => {
    const issue: ReviewIssue = { severity: "major", title: "心理总结", evidence: "他感到安全", excerpt: "他感到安全", rewriteExample: "他把杯沿摆正。" };
    const text = "雨落下来。\n\n他感到安全。\n\n电话响了。";
    const [window] = planRevisionWindows(text, [issue]);
    const prompt = buildRevisionWindowPrompt({ text, window, memory });
    expect(window).toMatchObject({ start: 1, end: 1 });
    expect(prompt).toContain("改写参考：他把杯沿摆正。");
    expect(prompt).toContain("雨落下来。");
    expect(prompt).toContain("电话响了。");
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
  });

  it("passes author feedback through as-is and provides genre-agnostic intent contract (no keyword matching)", () => {
    // P1-3: 旧实现用正则匹配 5 类关键词，作者用新词（如"散文化""太干巴巴"）会被静默忽略。
    // 新实现：原文透传 + 6 类意图契约，让 LLM 自识别任意自然语言反馈。
    const brief = buildAuthorRevisionBrief("对白设计太烂了，女主高冷一点，不要强调道和理，只引发读者好奇。");

    // 1. 作者原文必须透传，不做关键词过滤
    expect(brief).toContain("对白设计太烂了");
    expect(brief).toContain("女主高冷一点");
    expect(brief).toContain("不要强调道和理");
    expect(brief).toContain("只引发读者好奇");

    // 2. 6 类意图契约必须全部存在（覆盖作者反馈的完整空间）
    expect(brief).toContain("叙事节奏");
    expect(brief).toContain("对白风格");
    expect(brief).toContain("情感基调");
    expect(brief).toContain("信息密度");
    expect(brief).toContain("视角处理");
    expect(brief).toContain("场景策略");

    // 3. 意图识别契约必须明确告知 LLM "不限于示例词"
    expect(brief).toContain("不限于下方列举的示例词");

    // 4. 跨题材正例必须存在（让 LLM 看到如何从模糊反馈提取意图）
    expect(brief).toContain("跨题材正例");
    expect(brief).toContain("太干巴巴");
  });

  it("handles genre-agnostic feedback words that original regex missed (散文化/节奏慢/太干巴巴)", () => {
    // P1-3 回归测试：这些词在原正则中均不命中，反馈会被静默丢弃。
    // 新实现：原文透传 + 意图契约，LLM 能从任意词识别意图。
    const brief = buildAuthorRevisionBrief("这段太干巴巴，散文化一点，节奏太慢。");

    expect(brief).toContain("这段太干巴巴");
    expect(brief).toContain("散文化一点");
    expect(brief).toContain("节奏太慢");
    // 意图契约仍存在（不因反馈词未命中正则而丢失）
    expect(brief).toContain("叙事节奏");
    expect(brief).toContain("信息密度");
  });

  it("returns default brief when no author instruction provided", () => {
    const brief = buildAuthorRevisionBrief(undefined);
    expect(brief).toContain("无作者补充取舍");
  });
});
