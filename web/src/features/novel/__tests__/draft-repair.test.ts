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

  it("preserves adjacent paragraphs that reuse vocabulary in a different order", async () => {
    const content = [
      "他将木匣放在案上，又把钥匙收入袖中，转身吩咐众人封门。",
      "他转身吩咐众人封门，又将钥匙收入袖中，最后把木匣放在案上。",
    ].join("\n\n");

    const result = await repairDraftStructureOnce({ content, model: "test-model", skillPrompt: "修复契约" });

    expect(result.content).toBe(content);
    expect(streamNovelModel).not.toHaveBeenCalled();
  });

  it("preserves a short ending that reuses established motifs while advancing their state", () => {
    // 早期长段（≥100 字符）：建立并重复 寒灯/断穗/门人录/夜雾/佩剑客/她没有回头/转身/走入 主题
    const early = [
      "寒灯挂在庙檐下，火苗被风吹得摇晃，时明时暗。沈雁声推门进去，庙中有一张旧木桌，桌上放着一壶热茶。她从怀中取出门人录，陆无名三个字静静留在那里。断穗的编法她曾见过，那是指尖能记住的旧事，不会轻易忘记。",
      "佩剑客从佛像旁走出，衣着整洁，剑穗随步轻摆，穗子的编法让她多看一眼。那是她曾见过的样式。听潮阁已灭，所以才要寻。他递茶试探，言语温雅却句句指向旧事。她没有回头，也没有坐下。只是看着茶面，等他先开口。",
      "他的声音依旧温和，可庙门已经被他身后的位置封住。沈雁声看了一眼门外，夜雾正在压低。她明白，继续留下只会让更多东西被看见。她已经露了痕迹，下一刻便要做出选择。剑未出鞘，她已经感到了杀意，只是还不确定来人究竟想要什么。",
      "她抬手一挥，桌上的寒灯翻倒，灯油洒在地面，火光被夜风卷起。佩剑客人退了一步。她转身掠向侧墙，剑锋擦过她的袖口。她走入夜雾，身影很快被江风吞没。庙外雾已经漫过荒草，她踏入雾中，不再停留。地上落下一截断穗，那是从她身上落下的。",
    ];
    // 高潮收束（2 个短段，<100 字符）
    const climax = [
      "她没有回头。庙外雾已经漫过荒草。",
      "佩剑客追到门前。地上留下一截断穗。",
    ];
    // 结尾复用既有意象，但让信物状态和人物行动继续变化，不属于段落重演。
    const secondEnding = [
      "佩剑客拾起断穗。穗尾旧线已经发白。",
      "寒灯重新燃起。火苗比先前更低。",
      "门人录还在。断穗已经不在。她没有回头。",
      "她转身走入夜雾。朝另一个方向行去。",
    ];
    const content = [...early, ...climax, ...secondEnding].join("\n\n");

    const result = truncateTrailingSecondEnding(content);

    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
  });

  it("does not truncate a short-paragraph ending when themes are not repeated", () => {
    const early = Array.from({ length: 5 }, (_, index) =>
      `第${index + 1}段长叙事文本展开新的场景和行动，人物面对不同处境作出各自的选择。`.repeat(2));
    const ending = [
      "雨停了。她收起伞。",
      "远处传来钟声。",
      "她转身离开。",
      "门在身后合上。",
    ];
    const content = [...early, ...ending].join("\n\n");

    const result = truncateTrailingSecondEnding(content);

    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
  });

  it("preserves a mixed ending when repeated motifs lead to a new action", () => {
    // 混合对白的尾声仍产生带走信物这一新行动，不应只因主题词重复而删除。
    const early = [
      "寒灯挂在庙檐下，火苗被风吹得摇晃，时明时暗。沈雁声推门进去，庙中有一张旧木桌，桌上放着一壶热茶。她从怀中取出门人录，陆无名三个字静静留在那里。断穗的编法她曾见过，那是指尖能记住的旧事，不会轻易忘记。寒灯的火苗映着她的剑，像在等一个了结。",
      "佩剑客沿着渡口一路查访，把旧事的边角从人嘴里慢慢捞出来。他带着一张被水浸过的旧纸，纸上只剩几道淡墨，却足以让他辨认出断穗的回环扣编法。门人录的旧债在他心中压着，寒灯的光映在剑鞘上，像在等一个了结。断穗的回环扣编法他认得，那是旧日门人录的记号。",
      "夜雾从江面漫过来，盖住了石阶和荒草。沈雁声在废庙中等着，寒灯的火苗缩成细线，又顽强撑住。她知道佩剑客会来，断穗的线索已经留下了，门人录的旧事终究要面对。她没有回头，转身走入夜雾。寒灯的火苗映着她的剑。",
      "废庙的寒灯仍亮着，灯油是新添的，铜片被擦亮了一圈。佩剑客推门进来，目光扫过残墙和神像，落在那盏寒灯上。他取出门人录的旧纸，把断穗压在纸面边缘。寒灯的火苗映着他的剑，淡墨被灯火照出几道模糊的痕。门人录的旧债又回来了。",
    ];
    const climax = ["她没有回头。庙外雾已经漫过荒草。", "佩剑客追到门前。地上留下一截断穗。"];
    const secondEnding = [
      "寒灯仍亮着。废庙中，佩剑客拾起断穗。青黑色。",
      "他将断穗放在掌心。门人录的旧债又回来了。",
      "淡墨被灯火照出几道模糊的痕。寒灯的火苗映着他的剑。",
      "“原来线索在这里。”",
      "寒灯的火苗映着他的剑。他带走了一件从门人录落下的信物。",
    ];
    const content = [...early, ...climax, ...secondEnding].join("\n\n");
    const result = truncateTrailingSecondEnding(content);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
  });

  it("truncates a cross-genre tail that concretely replays several earlier paragraphs", () => {
    const earlier = [
      "舱门警报亮起。导航员输入返航坐标。",
      "主引擎降到怠速。飞船转向木卫二。",
      "值班员关掉广播。观察窗重新结霜。",
    ];
    const middle = Array.from({ length: 4 }, (_, index) =>
      `航行日志第${index + 1}节记录新的故障排查，机组更换不同模块并确认了新的风险。`.repeat(4));
    const climax = ["通讯恢复了。", "地球的回信只有一行。"];
    const replay = [
      "舱门警报亮起。导航员输入返航坐标。",
      "主引擎降到怠速。飞船转向木卫二。",
      "值班员关掉广播。观察窗重新结霜。",
    ];
    const content = [...earlier, ...middle, ...climax, ...replay].join("\n\n");

    const result = truncateTrailingSecondEnding(content);

    expect(result.truncated).toBe(true);
    expect(result.content).toBe([...earlier, ...middle, ...climax].join("\n\n"));
  });

  it("does not rewrite short-sentence punctuation to satisfy a style score", async () => {
    const content = "警报响了。舱门开了。人影出现。";

    const result = await repairDraftStructureOnce({ content, model: "test-model", skillPrompt: "修复契约" });

    expect(result.content).toBe(content);
    expect(streamNovelModel).not.toHaveBeenCalled();
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

