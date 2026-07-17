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
    expect(prompt).toContain("按动作因果、注意力变化和情绪停顿组织段落");
    expect(prompt).toContain("主角拒绝交易");
    expect(prompt).toContain("验收条件，不是要在节拍之外再写一次的附加场景");
    expect(prompt).toContain("同一结果若同时出现在条目、蓝图节拍和章尾落点中，只兑现一次");
    expect(prompt).toContain("解释幕后真相");
    expect(prompt).toContain("参考目标约 2400 个中文字符");
    expect(prompt).toContain("完整成稿须超过 3000 字");
    expect(prompt).toContain("只使用已批准蓝图和正文已经建立");
    expect(prompt).toContain("一个与人物身份、经验或当下责任直接相关的可见触发");
    expect(prompt).toContain("开放选择不能只停在看景、沉默或泛化情绪");
    expect(prompt).toContain("不得为了制造结果替人物答应、拒绝或完成选择");
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

  it("integrates endingHook into the final beat instead of creating a second event", () => {
    const beats = Array.from({ length: 5 }, (_, index) => ({ action: `行动${index + 1}`, emotion: `情绪${index + 1}`, outcome: `结果${index + 1}` }));
    const sections = planDraftSections(beats, 5000);
    const endingHook = "她听见门外有人叫出自己从未公开的名字。";
    const lastContract = buildDraftSectionContract(sections[2], "上一段结尾", endingHook);
    const middleContract = buildDraftSectionContract(sections[1], "上一段结尾", endingHook);

    expect(lastContract).toContain("章尾落点");
    expect(lastContract).toContain(endingHook);
    expect(lastContract).toContain("两者若描述相同事件，该事件只发生一次");
    expect(lastContract).toContain("章尾呈现是同类结果的唯一兑现时机");
    expect(lastContract).toContain("不得另造一个承担相同悬念、选择或关系功能的预热钩子");
    expect(lastContract).toContain("不得在最后节拍完整落地前结束本段");
    expect(lastContract).toContain("不得为了制造钩子发明新人物、新物证或新事件");
    expect(lastContract).toContain("每个段落都必须推进尚未完成的叙事功能");
    expect(lastContract).not.toMatch(/封存\/查验|多次封存|多次查看|萧承晏|沈知微|顾长安/);
    expect(lastContract).toContain("必须写完上述所有节拍");
    expect(lastContract).toContain("不得跳过最后节拍");
    expect(lastContract).not.toContain("可以完成章尾余韵");
    expect(lastContract).not.toContain("6. 行动");
    // 中间段不合并章尾呈现
    expect(middleContract).not.toContain("章尾落点");
    expect(middleContract).toContain("这不是章尾");
    // endingHook 位于最后节拍内部（在行动5之后），而不是第六个事件。
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
    expect(plotPrompt).toContain("禁止用\"如果后续这样写\"");
    expect(plotPrompt).toContain("blocker/major 的 excerpt 必须引用触发判断的原文");
    expect(`${stylePrompt}\n${plotPrompt}`).not.toMatch(/魏公公|东宫|皇子|宦官|仵作|史官|封存命令/);
  });

  it("materially different counter-example: prompt fixes generalize across genres and scenes", () => {
    // 反例场景：宫廷权谋（与基准的荒野流民题材 materially different）
    // 验证修复点（意象回声尾句 + 观察否定概括句）在共享层的指导是题材无关的
    const courtIntriguePrompt = buildChapterDraftPrompt({
      targetWords: 5000,
      blueprintMarkdown: "## 蓝图\n宫廷夜宴，主角发现毒酒",
      contextMarkdown: "## 冻结上下文\n主角：史官沈知微",
      mustHappen: ["主角发现酒中有异"],
      forbidden: ["解释幕后真凶"],
    });

    // 修复点：观察否定概括句指导（sceneEmbodiment fix）须出现在任意题材的 prompt 中
    expect(courtIntriguePrompt).toContain("观察否定概括句");
    expect(courtIntriguePrompt).toContain("没有X，没有Y，只是Z");
    // 验证指导中包含跨题材示例（江湖/宫廷/市井），不限于基准的荒野题材
    expect(courtIntriguePrompt).toContain("宫廷场景");
    expect(courtIntriguePrompt).toContain("江湖场景");
    expect(courtIntriguePrompt).toContain("市井场景");
    // 验证宫廷题材本身的词汇不出现在通用指导中（避免过拟合）
    expect(courtIntriguePrompt).not.toMatch(/荒野|流民|沈砚|木车|旧金属物件/);

    // 修复点：意象回声尾句指导（hookPayoff fix）须出现在任意题材的章尾契约中
    const courtBeats = [
      { action: "史官入宴", emotion: "警惕", outcome: "入座" },
      { action: "发现酒色异常", emotion: "压抑", outcome: "确认有毒" },
      { action: "选择是否揭发", emotion: "权衡", outcome: "按兵不动" },
    ];
    const courtSections = planDraftSections(courtBeats, 5000);
    const courtEndingHook = "他端起酒杯，却没有饮下。殿外的更鼓正好敲了三声。";
    const courtLastContract = buildDraftSectionContract(
      courtSections[2],
      "上一段结尾",
      courtEndingHook,
    );

    expect(courtLastContract).toContain("意象回声尾句");
    expect(courtLastContract).toContain("第二次收束");
    expect(courtLastContract).toContain("删掉最后一句后");
    // 验证宫廷题材的 endingHook 正确合并到最后节拍
    expect(courtLastContract).toContain(courtEndingHook);
    expect(courtLastContract).toContain("这是最后一段");
    // 验证宫廷题材词汇不出现在通用章尾指导中
    expect(courtLastContract).not.toMatch(/荒野|流民|沈砚|旧路/);
  });
});
