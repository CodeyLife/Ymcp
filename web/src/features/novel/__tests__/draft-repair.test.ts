import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({ streamNovelModel: vi.fn() }));

import { streamNovelModel } from "../ai";
import { repairDraftStructureOnce, repairEmphasisDevaluation, repairInterpretiveSummaries, repairPunctuationBreaks, truncateTrailingSecondEnding } from "../workflow-stages/draft-structure-repair";

beforeEach(() => {
  vi.mocked(streamNovelModel).mockReset();
});

describe("draft structure repair", () => {
  it("deterministically merges fragmented paragraphs and strips wrappers without calling the model", async () => {
    const invalid = ["以下是正文：", "风停了。", "他抬起头。", "远处有人走来。"].join("\n\n");

    const result = await repairDraftStructureOnce({
      content: invalid,
      model: "test-model",
      skillPrompt: "修复契约",
    });

    // 改进后：4 段 ≥4 阈值触发合并，3 个短叙事段合并为 1 段，"以下是正文："被移除
    // 确定性修复即可解决，无需调用 LLM
    expect(streamNovelModel).not.toHaveBeenCalled();
    expect(result.repaired).toBe(true);
    expect(result.content).toBe("风停了。他抬起头。远处有人走来。");
  });

  it("stitches short action beats to adjacent dialogue without changing manuscript characters", async () => {
    const fragmented = [
      "顾石生抬眼看他。",
      "“你已经拖过三日了。”",
      "罗二把硬饼藏到身后。",
      "“三日和五日，也没差多少。”",
      "井下传来撑木开裂的声音。",
      "“别下去。”",
      "顾石生把断剑塞紧，走向井绳。",
      "“药铺日落就关门。”",
    ].join("\n\n");

    const result = await repairDraftStructureOnce({ content: fragmented, model: "test-model", skillPrompt: "修复契约" });

    expect(streamNovelModel).not.toHaveBeenCalled();
    expect(result.report.issues.some((item) => item.rule === "style.fragmented-paragraphs")).toBe(false);
    expect(result.content).toContain("顾石生抬眼看他。“你已经拖过三日了。”");
    expect(result.content.replace(/\s/g, "")).toBe(fragmented.replace(/\s/g, ""));
  });

  it("does not call the model when only semantic-repeat review issues remain", async () => {
    const progression = [
      "队伍沿官道向南走。沈砚留在最后，观察每个人携带的东西。",
      "孩子的鞋带断了。沈砚用布条系好，孩子把半块饼递给他。",
      "夜里粮袋见底。几个青壮围着粮袋争执，赵婶重新分了粮。",
      "天亮后众人再次上路。旧甲男人发现异常，让所有人保持安静。",
    ];
    const filler = Array.from({ length: 6 }, (_, index) => `第${index + 1}处路标倒在荒草里。众人从旁经过，没有停下查看。`);
    const repeated = progression.map((paragraph) => paragraph.replace("。", "，又继续。"));
    const content = [...progression, ...filler, ...repeated].join("\n\n");

    const result = await repairDraftStructureOnce({ content, model: "test-model", skillPrompt: "修复契约" });

    // Loop 3+ 引入确定性去重：plot.repeated-progression 虽为 repairable: false，
    // 但确定性去重仍会删除重复段（LLM 无法修复此类语义重复，必须由系统兜底）。
    // 核心断言：LLM 不被调用，且重复段已被移除。
    expect(streamNovelModel).not.toHaveBeenCalled();
    expect(result.repaired).toBe(true);
    expect(result.content).toBe([...progression, ...filler].join("\n\n"));
  });

  it("preserves a legitimate long scene after a short transition", () => {
    const opening = Array.from({ length: 4 }, (_, index) => `开场第${index + 1}段铺陈山路上的风雪与行人，各自携带不同物件缓慢前行。`);
    const transition = "天亮了。";
    const continuation = Array.from({ length: 3 }, (_, index) => `后续场景第${index + 1}段${"展开新的行动、对话和环境变化，推动队伍穿过山口并面对不同阻碍。".repeat(5)}`);
    const content = [...opening, transition, ...continuation].join("\n\n");

    expect(truncateTrailingSecondEnding(content)).toEqual({ truncated: false, content, removedChars: 0 });
  });

  it("truncates a trailing scene only when it repeats an earlier progression", () => {
    const progression = Array.from({ length: 3 }, (_, index) => `重复推进第${index + 1}段${"队伍核对粮袋、越过山口并在风雪中重新分配守夜次序。".repeat(6)}`);
    const middle = Array.from({ length: 4 }, (_, index) => `中段第${index + 1}处发生新的事件，人物作出不同选择并承担相应结果。`);
    const transition = "夜色已经落定。";
    const content = [...progression, ...middle, transition, ...progression].join("\n\n");

    const result = truncateTrailingSecondEnding(content);

    expect(result.truncated).toBe(true);
    expect(result.content).toBe([...progression, ...middle, transition].join("\n\n"));
  });

  it("calls the model for structural issues that cannot be resolved deterministically", async () => {
    // 使用足够长的段落避免触发碎片化合并，但保留格式问题需要 LLM 修复
    const longPara1 = "风停了很久很久，久到连呼吸都变得迟缓。他站在原地没有动，只是看着远方。";
    const longPara2 = "他抬起头，看见远处有人走来。那人的脚步声在空旷的街道上回荡，越来越近。";
    const invalid = ["```", longPara1, longPara2, "```"].join("\n\n");
    const repaired = `${longPara1}\n\n${longPara2}`;
    vi.mocked(streamNovelModel).mockResolvedValueOnce({ content: repaired, promptHash: "repair" });

    const result = await repairDraftStructureOnce({
      content: invalid,
      model: "test-model",
      skillPrompt: "修复契约",
    });

    expect(result.content).toBe(repaired);
    expect(result.repaired).toBe(true);
  });

  it("falls back to deterministically cleaned content when the repair changes manuscript wording", async () => {
    // 使用足够多的段落让合并触发，但保留格式标记让 LLM 被调用
    const paragraphs = ["以下是正文：", "风停了很久很久。", "他抬起头来。", "远处有人走来。", "脚步声越来越近了。"];
    const invalid = paragraphs.join("\n\n");
    vi.mocked(streamNovelModel).mockResolvedValueOnce({
      content: "风忽然停了。他抬头望向远处。\n\n官道上有一个陌生人走来。",
      promptHash: "rewritten",
    });

    const result = await repairDraftStructureOnce({ content: invalid, model: "test-model", skillPrompt: "修复契约" });
    // LLM 改变了正文用词，回退到确定性清洗结果
    expect(result.repaired).toBe(true);
    expect(result.content).toContain("风停了很久很久。");
  });

  it("repairs punctuation breaks where closing quotes are followed by redundant periods", async () => {
    // #18：LLM 系统性产出 "xxx。"。后续叙事 模式（句末标点在内 + 引号外多余句号）
    const broken = "\u201C前面有城。\u201D\u3002阿落忽然开口。\n\n\u201C以前应该是一座修士城。\u201D\u3002阿落闭着眼感受片刻。";
    const fixed = repairPunctuationBreaks(broken);
    // 引号外多余句号被移除，引号内句末标点保留
    expect(fixed).toBe("\u201C前面有城。\u201D阿落忽然开口。\n\n\u201C以前应该是一座修士城。\u201D阿落闭着眼感受片刻。");
    // 不应影响引号内无句末标点的正常用法
    const normal = "\u201C走吧\u201D\u3002他站起来。";
    expect(repairPunctuationBreaks(normal)).toBe(normal);
  });

  it("applies punctuation repair during draft structure repair", async () => {
    // 足够长的段落避免触发碎片化合并，仅测试标点修复
    const longPara1 = "\u201C前面有城。\u201D\u3002阿落忽然开口，声音低沉而清晰，像是风里带来的某种预兆。";
    const longPara2 = "沈青衫停下脚步，望向前方那片被风沙遮掩的荒原，心中升起一种说不出的迟疑。";
    const content = `${longPara1}\n\n${longPara2}`;

    const result = await repairDraftStructureOnce({ content, model: "test-model", skillPrompt: "修复契约" });

    // 引号外多余句号被移除
    expect(result.content).not.toContain("\u201D\u3002");
    expect(result.content).toContain("\u201D阿落忽然开口");
  });

  it("removes author-style interpretive summary sentences from narrative paragraphs", () => {
    const content = [
      "她没有回头。寒露落在发间。",
      "她第一次知道，离开一座山门，不一定需要有人赶。有时候，是自己先转身。",
      "她沿着后山旧路奔去，脚踝隐隐作痛。",
    ].join("\n\n");

    const result = repairInterpretiveSummaries(content);

    expect(result.repaired).toBe(true);
    expect(result.removedCount).toBe(1);
    expect(result.content).toContain("她没有回头。寒露落在发间。");
    expect(result.content).toContain("她沿着后山旧路奔去");
    expect(result.content).not.toContain("她第一次知道");
  });

  it("removes interpretive sentences within multi-sentence paragraphs without dropping other content", () => {
    const content = [
      "她推开暗门。里面没有尸体。也没有打斗痕迹。这意味着有人提前来过，而且知道要找什么。她将铜扣放回原处。",
    ].join("\n\n");

    const result = repairInterpretiveSummaries(content);

    expect(result.repaired).toBe(true);
    expect(result.content).toContain("她推开暗门。里面没有尸体。也没有打斗痕迹。");
    expect(result.content).toContain("她将铜扣放回原处。");
    expect(result.content).not.toContain("这意味着");
  });

  it("preserves dialogue paragraphs containing interpretive-looking phrases", () => {
    const content = [
      "\u201C她第一次知道这件事的时候，也是在这个渡口。\u201D老人缓缓开口。",
      "她沿着后山旧路奔去。",
    ].join("\n\n");

    const result = repairInterpretiveSummaries(content);

    expect(result.repaired).toBe(false);
    expect(result.content).toBe(content);
  });

  it("does not remove concrete action without explanatory conclusions", () => {
    const content = "她咬住牙，沿着后山旧路奔去。身后传来一声闷响。她没有回头。";

    const result = repairInterpretiveSummaries(content);

    expect(result.repaired).toBe(false);
    expect(result.content).toBe(content);
  });

  it("removes she-knows-if motivational explanation patterns", () => {
    const content = [
      "一路上，她没有喊人，也没有再去看那些倒下的身影。",
      "不是不想看，而是她知道，若现在停下来，脚就再也迈不出去。",
      "她转身往正阁走。",
    ].join("\n\n");

    const result = repairInterpretiveSummaries(content);

    expect(result.repaired).toBe(true);
    expect(result.content).toContain("一路上，她没有喊人");
    expect(result.content).toContain("她转身往正阁走。");
    expect(result.content).not.toContain("她知道，若现在停下来");
  });

  it("removes 'she first felt' interpretive sentences (D1 觉得 extension)", () => {
    const content = [
      "她没有回头。寒露落在发间。",
      "她第一次觉得，这卷薄薄的册子，比一柄剑还重。",
      "她转身往正阁走。",
    ].join("\n\n");

    const result = repairInterpretiveSummaries(content);

    expect(result.repaired).toBe(true);
    expect(result.removedCount).toBe(1);
    expect(result.content).toContain("她没有回头。寒露落在发间。");
    expect(result.content).toContain("她转身往正阁走。");
    expect(result.content).not.toContain("她第一次觉得");
  });

  it("removes excess emphasis words beyond 2 occurrences", () => {
    const content = [
      "院外忽然有人奔来，脚步乱得不像听潮阁弟子。",
      "藏书楼方向，火光忽然窜起。那不是普通失火。",
      "直到天将亮时，江面忽然起了大雾。",
      "忽然，一盏灯出现在雾里。很小。",
    ].join("\n\n");

    const result = repairEmphasisDevaluation(content);

    expect(result.repaired).toBe(true);
    expect(result.removedCount).toBe(2);
    // 前两次保留
    expect(result.content).toContain("院外忽然有人奔来");
    expect(result.content).toContain("火光忽然窜起");
    // 第三次及以后删除
    expect(result.content).not.toContain("江面忽然起了大雾");
    expect(result.content).toContain("江面起了大雾");
    // "忽然，"连同逗号删除
    expect(result.content).not.toContain("忽然，一盏灯");
    expect(result.content).toContain("一盏灯出现在雾里");
  });

  it("preserves emphasis words within 2 occurrences", () => {
    const content = [
      "院外忽然有人奔来。",
      "火光忽然窜起。",
    ].join("\n\n");

    const result = repairEmphasisDevaluation(content);

    expect(result.repaired).toBe(false);
    expect(result.content).toBe(content);
  });

  it("does not remove emphasis words from dialogue paragraphs", () => {
    const content = [
      "\u201C他忽然回头看了我一眼。\u201D老人缓缓开口。",
      "\u201C忽然就下雨了。\u201D",
      "\u201C忽然就不见了。\u201D",
      "\u201C忽然又出现了。\u201D",
    ].join("\n\n");

    const result = repairEmphasisDevaluation(content);

    // 全部在对白段中：虽计入全局计数但无法删除（人物语气保留）
    expect(result.repaired).toBe(false);
    expect(result.content).toBe(content);
  });

  it("counts dialogue emphasis words toward the global limit (D5)", () => {
    // 对白段 1 个"忽然" + 叙事段 2 个"忽然" = 3 次，超限
    // 对白中的保留，第 3 次叙事段中的删除
    const content = [
      "\u201C他忽然回头看了我一眼。\u201D老人缓缓开口。",
      "院外忽然有人奔来，脚步乱得不像听潮阁弟子。",
      "火光忽然窜起。那不是普通失火。",
    ].join("\n\n");

    const result = repairEmphasisDevaluation(content);

    expect(result.repaired).toBe(true);
    expect(result.removedCount).toBe(1);
    // 对白中的保留
    expect(result.content).toContain("他忽然回头看了我一眼");
    // 第 1 个叙事段保留
    expect(result.content).toContain("院外忽然有人奔来");
    // 第 2 个叙事段超限删除
    expect(result.content).not.toContain("火光忽然窜起");
    expect(result.content).toContain("火光窜起");
  });

  it("removes 'she first discovered' interpretive sentences (D4 发现 extension)", () => {
    const content = [
      "她没有回头。寒露落在发间。",
      "这一夜，她第一次发现自己学了十六年的剑，不是为了站在父亲身后。",
      "她沿着后山旧路奔去，脚踝隐隐作痛。",
    ].join("\n\n");

    const result = repairInterpretiveSummaries(content);

    expect(result.repaired).toBe(true);
    expect(result.removedCount).toBe(1);
    expect(result.content).toContain("她没有回头。寒露落在发间。");
    expect(result.content).toContain("她沿着后山旧路奔去");
    expect(result.content).not.toContain("她第一次发现");
  });
});
