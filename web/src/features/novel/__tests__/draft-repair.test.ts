import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({ streamNovelModel: vi.fn() }));

import { streamNovelModel } from "../ai";
import { repairDraftStructureOnce, repairPunctuationBreaks, truncateTrailingSecondEnding } from "../workflow-stages/draft-structure-repair";

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
});
