import { describe, expect, it } from "vitest";
import { buildChapterDraftPrompt, buildChapterReviewPrompt, buildDraftSectionContract, chapterOutputTokenBudget, planDraftSections } from "../prose-prompts";

describe("production prose prompts", () => {
  it("builds an ordered scene-first drafting contract instead of a beat checklist", () => {
    const prompt = buildChapterDraftPrompt({
      targetWords: 2400,
      blueprintMarkdown: "蓝图正文",
      contextMarkdown: "冻结事实",
      mustHappen: ["主角拒绝交易"],
      forbidden: ["解释幕后真相"],
    });

    expect(prompt.indexOf("事实、人物知识边界")).toBeLessThan(prompt.indexOf("本章主导叙事功能与兑现边界"));
    expect(prompt.indexOf("本章主导叙事功能与兑现边界")).toBeLessThan(prompt.indexOf("意象、辞藻和句式装饰"));
    expect(prompt).toContain("蓝图规定本章可用的材料与边界");
    expect(prompt).toContain("主线可以暂不前进");
    expect(prompt).toContain("人物内心可以充分展开");
    expect(prompt).toContain("不强制设置明显波峰");
    expect(prompt).toContain("情感余韵");
    expect(prompt).toContain("不要替人物总结“这意味着什么”");
    expect(prompt).toContain("试探、陪伴、闲谈、礼俗或共同劳动");
    expect(prompt).toContain("普通交流也能积累关系和人物质地");
    expect(prompt).toContain("不要每句话或每轮对白都另起空行");
    expect(prompt).toContain("主角拒绝交易");
    expect(prompt).toContain("解释幕后真相");
    expect(prompt).toContain("参考目标约 2400 个中文字符");
    expect(prompt).toContain("完整成稿须超过 3000 字");
    expect(prompt).toContain("只使用已批准蓝图和正文已经建立");
    expect(prompt).not.toMatch(/魏成礼|魏公公|东宫|皇子|宦官|仵作|史官|具体不可能的物证细节/);
    expect(prompt).not.toMatch(/剑来|雪中悍刀行|我在风花雪月里等你|烽火戏诸侯/);
  });

  it("scales the output budget with the approved chapter length", () => {
    expect(chapterOutputTokenBudget(2400)).toBe(8192);
    expect(chapterOutputTokenBudget(5000)).toBe(12000);
    expect(chapterOutputTokenBudget(10000)).toBe(24000);
    expect(chapterOutputTokenBudget(50000)).toBe(24000);
  });

  it("partitions blueprint beats into contiguous drafting sections with explicit continuation contracts", () => {
    const beats = Array.from({ length: 5 }, (_, index) => ({ action: `行动${index + 1}`, emotion: `情绪${index + 1}`, outcome: `结果${index + 1}` }));
    const sections = planDraftSections(beats, 5000);

    expect(sections.map((section) => section.beats.map((beat) => beat.action))).toEqual([["行动1", "行动2"], ["行动3", "行动4"], ["行动5"]]);
    expect(sections.every((section) => section.targetWords === 1667)).toBe(true);
    expect(buildDraftSectionContract(sections[1], "上一段结尾")).toContain("第一句必须自然承接");
    expect(buildDraftSectionContract(sections[1], "上一段结尾")).toContain("不得总结主题、制造结尾");
    expect(buildDraftSectionContract(sections[1], "上一段结尾")).toContain("不得以相同句式");
    expect(buildDraftSectionContract(sections[2], "上一段结尾")).toContain("可以完成章尾余韵");
  });

  it("appends endingHook as a synthetic beat in the last section contract when provided", () => {
    const beats = Array.from({ length: 5 }, (_, index) => ({ action: `行动${index + 1}`, emotion: `情绪${index + 1}`, outcome: `结果${index + 1}` }));
    const sections = planDraftSections(beats, 5000);
    const endingHook = "她听见门外有人叫出自己从未公开的名字。";
    const lastContract = buildDraftSectionContract(sections[2], "上一段结尾", endingHook);
    const middleContract = buildDraftSectionContract(sections[1], "上一段结尾", endingHook);

    // endingHook 作为合成节拍出现在 beat 列表中
    expect(lastContract).toContain("章尾落点");
    expect(lastContract).toContain(endingHook);
    expect(lastContract).toContain("不得在最后节拍完整落地前结束本段");
    expect(lastContract).toContain("不得为了增强钩子另造异常、危险、物证或角色");
    expect(lastContract).toContain("每个段落都必须推进尚未完成的叙事功能");
    expect(lastContract).not.toMatch(/封存\/查验|多次封存|多次查看|萧承晏|沈知微|顾长安/);
    expect(lastContract).toContain("必须写完上述所有节拍");
    expect(lastContract).toContain("不得跳过最后节拍");
    expect(lastContract).not.toContain("可以完成章尾余韵");
    // 中间段不追加合成节拍
    expect(middleContract).not.toContain("章尾落点");
    expect(middleContract).toContain("这不是章尾");
    // 确认 endingHook 是最后一个节拍（在"行动5"之后）
    const lastBeatIndex = lastContract.indexOf(endingHook);
    const action5Index = lastContract.indexOf("行动5");
    expect(lastBeatIndex).toBeGreaterThan(action5Index);
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
    expect(plotPrompt).toContain("是否把大纲压缩成当章任务清单");
    expect(plotPrompt).toContain("铺陈、相处和余波章不要求不可逆结果");
    expect(plotPrompt).toContain("背景展开、人物内省、情感抒发、文学意象和日常过程可以是章节主体");
    expect(plotPrompt).toContain("revisionRanges");
    expect(`${stylePrompt}\n${plotPrompt}`).not.toMatch(/魏公公|东宫|皇子|宦官|仵作|史官|封存命令/);
  });
});
