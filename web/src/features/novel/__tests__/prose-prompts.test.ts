import { describe, expect, it } from "vitest";
import { buildChapterDraftPrompt, buildChapterReviewPrompt } from "../prose-prompts";

describe("production prose prompts", () => {
  it("builds an ordered scene-first drafting contract instead of a beat checklist", () => {
    const prompt = buildChapterDraftPrompt({
      targetWords: 2400,
      blueprintMarkdown: "蓝图正文",
      contextMarkdown: "冻结事实",
      mustHappen: ["主角拒绝交易"],
      forbidden: ["解释幕后真相"],
    });

    expect(prompt.indexOf("事实、人物知识边界")).toBeLessThan(prompt.indexOf("视角人物为一个当下欲望"));
    expect(prompt.indexOf("视角人物为一个当下欲望")).toBeLessThan(prompt.indexOf("意象、辞藻和句式装饰"));
    expect(prompt).toContain("蓝图是因果材料，不是待逐项复述的清单");
    expect(prompt).toContain("信息发现只有迫使人物选择或承担后果时才算推进");
    expect(prompt).toContain("不要替人物总结“这意味着什么”");
    expect(prompt).toContain("不相容的当下目的");
    expect(prompt).toContain("稳定的交锋策略");
    expect(prompt).toContain("不要每句话或每轮对白都另起空行");
    expect(prompt).toContain("主角拒绝交易");
    expect(prompt).toContain("解释幕后真相");
    expect(prompt).toContain("目标约 2400 个中文字符");
    expect(prompt).not.toMatch(/剑来|雪中悍刀行|我在风花雪月里等你|烽火戏诸侯/);
  });

  it("gives reviewers production score anchors and role-specific anti-mechanical checks", () => {
    const stylePrompt = buildChapterReviewPrompt({
      role: "style-reviewer",
      blueprintMarkdown: "蓝图",
      numberedDraft: "【第1段】\n正文",
      reviewerContext: "事实",
    });
    const plotPrompt = buildChapterReviewPrompt({
      role: "plot-reviewer",
      blueprintMarkdown: "蓝图",
      numberedDraft: "【第1段】\n正文",
      reviewerContext: "事实",
    });

    expect(stylePrompt).toContain("形式完整、情节都写到了，不等于 4 分以上");
    expect(stylePrompt).toContain("解释性心理总结");
    expect(stylePrompt).toContain("意象替人物说理");
    expect(plotPrompt).toContain("蓝图是否被熔成因果链，而不是逐项交差");
    expect(plotPrompt).toContain("人物行动是否制造不可逆结果和长线余波");
    expect(plotPrompt).toContain("revisionRanges");
  });
});
