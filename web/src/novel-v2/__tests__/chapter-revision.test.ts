import { describe, expect, it } from "vitest";
import { applyRevisionWindows, buildRevisionWindowPrompt, planRevisionWindows } from "../prompts/chapter-revision";
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
});
