import { describe, expect, it } from "vitest";
import { analyzeDraftStructure } from "../draft-structure";

describe("draft structure analysis", () => {
  it("flags fragmented narration even when every short sentence is separated by a blank line", () => {
    const text = [
      "风停了。",
      "他抬起头。",
      "远处有人走来。",
      "脚步越来越近。",
      "他握紧手里的木棍。",
      "那人却停在路边。",
    ].join("\n\n");

    const report = analyzeDraftStructure(text);

    expect(report.paragraphCount).toBe(6);
    expect(report.singleSentenceNarrativeRatio).toBe(1);
    expect(report.maxConsecutiveSingleSentenceNarrative).toBe(6);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "style.fragmented-paragraphs", severity: "major" }),
    ]));
  });

  it("blocks response wrappers, markdown headings, code fences, and horizontal rules", () => {
    const text = [
      "以下是正文：",
      "# 第一章",
      "```markdown",
      "风从门缝里灌进来。他把灯芯压低，屋里随即暗了一层。",
      "```",
      "---",
      "脚步声停在门外。他没有出声，只把短刀移到手边。",
    ].join("\n\n");

    const report = analyzeDraftStructure(text);

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "format.response-wrapper", severity: "blocker", paragraph: 1 }),
      expect.objectContaining({ rule: "format.markdown-heading", severity: "blocker", paragraph: 2 }),
      expect.objectContaining({ rule: "format.code-fence", severity: "blocker" }),
      expect.objectContaining({ rule: "format.horizontal-rule", severity: "blocker", paragraph: 6 }),
    ]));
  });

  it("locates the later copy of an exactly repeated narrative paragraph", () => {
    const text = [
      "雨越下越密。他沿着墙根往前走，鞋底不断打滑。",
      "守门人抬手拦住他，又朝城外的队伍看了一眼。",
      "雨越下越密。他沿着墙根往前走，鞋底不断打滑。",
    ].join("\n\n");

    const report = analyzeDraftStructure(text);

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "plot.exact-paragraph-repeat",
        severity: "major",
        revisionRanges: [{ start: 3, end: 3 }],
        repairable: false,
      }),
    ]));
  });

  it("does not classify adjacent vocabulary reuse as a duplicate", () => {
    const text = [
      "他将木匣放在案上，又把钥匙收入袖中，转身吩咐众人封门。",
      "他转身吩咐众人封门，又将钥匙收入袖中，最后把木匣放在案上。",
    ].join("\n\n");

    const report = analyzeDraftStructure(text);

    expect(report.issues).toEqual([]);
  });

  it("locates the later four-paragraph window when a progression is repeated after a gap", () => {
    const firstProgression = [
      "队伍沿着官道向南走。沈砚留在最后，先观察每个人携带的东西。",
      "一个孩子的鞋带断了。沈砚用布条系好，孩子把半块饼递给他。",
      "夜里粮袋见底。几个青壮围着粮袋争执，赵婶最终重新分了粮。",
      "天亮后众人再次上路。旧甲男人发现前方异常，让所有人保持安静。",
    ];
    const filler = Array.from({ length: 6 }, (_, index) => `第${index + 1}处路标倒在荒草里。风把尘土卷过路面，没有人停下来查看。`);
    const repeatedProgression = [
      "队伍继续沿着官道向南走。沈砚仍留在最后，先观察每个人携带的东西。",
      "另一个孩子的鞋带断了。沈砚用布条系好，孩子又把半块饼递给他。",
      "夜里粮袋再次见底。几个青壮围着粮袋争执，赵婶最后重新分了粮。",
      "天亮后众人又一次上路。旧甲男人发现前方异常，让所有人继续保持安静。",
    ];

    const report = analyzeDraftStructure([...firstProgression, ...filler, ...repeatedProgression].join("\n\n"));

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "plot.repeated-progression",
        severity: "major",
        revisionRanges: [{ start: 11, end: 14 }],
        repairable: false,
      }),
    ]));
  });

  it("allows dialogue-only paragraphs and a limited narrative impact beat", () => {
    const text = [
      "雨下了一夜，院中的石阶泛着冷光。守门人缩在檐下，不时看向街口。",
      "“谁在那里？”",
      "没有人回答。",
      "沈砚沿墙走到后门。他先摸了摸生锈的门闩，又俯身检查泥地上的脚印。",
      "“门外没人，脚印却是新的。”",
      "守门人终于站直身体。他提起灯笼，和沈砚一起绕向院墙外侧。",
    ].join("\n\n");

    const report = analyzeDraftStructure(text);

    expect(report.issues.some((item) => item.rule === "style.fragmented-paragraphs")).toBe(false);
  });

  it("treats dialogue paragraphs as boundaries between narrative impact beats", () => {
    const impactAndDialogue = [
      "门响了。",
      "“谁？”",
      "灯灭了。",
      "“别出声。”",
      "脚步停了。",
    ];
    const normalNarration = Array.from({ length: 7 }, (_, index) => `第${index + 1}盏灯沿着长廊依次亮起。守夜人检查门窗后，继续向前巡查。`);

    const report = analyzeDraftStructure([...impactAndDialogue, ...normalNarration].join("\n\n"));

    expect(report.singleSentenceNarrativeRatio).toBe(0.3);
    expect(report.maxConsecutiveSingleSentenceNarrative).toBe(1);
    expect(report.issues.some((item) => item.rule === "style.fragmented-paragraphs")).toBe(false);
  });

  it("does not mistake a recurring image for repeated progression", () => {
    const text = [
      "清晨的雾压在河面上。船夫收起缆绳，催众人尽快登船。",
      "沈砚在船尾找到空位。他把包袱放在脚边，默记两岸的地形。",
      "午后风向骤变。船身撞过暗流，几只木箱滑向另一侧。",
      "众人合力稳住货物。船夫重新调整帆索，才让船头转回航道。",
      "傍晚他们抵达渡口。岸边商贩正在收摊，炊烟越过低矮屋顶。",
      "沈砚跟着人群进城。他先找到客栈，又去打听次日的车马。",
      "夜里雾气再次升起。窗外的河水看不真切，只剩零散灯影。",
      "他整理白天得到的消息。几条线索互相矛盾，还不能得出结论。",
      "更鼓响过两次。客栈楼下有人进门，很快又压低声音离开。",
      "沈砚没有追出去。他吹灭灯火，继续听着走廊里的动静。",
    ].join("\n\n");

    const report = analyzeDraftStructure(text);

    expect(report.issues.some((item) => item.rule === "plot.repeated-progression")).toBe(false);
  });
});
