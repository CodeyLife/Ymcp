import { describe, expect, it } from "vitest";
import { applyCreativeBriefToBlueprint, findBlueprintPovConflicts, formatCreativeBriefContract } from "../workflow-brief";
import type { ChapterBlueprint, CreativeBrief } from "../types";

describe("creative brief workflow contract", () => {
  it("overrides model drift with author-confirmed POV, length and boundaries", () => {
    const blueprint: ChapterBlueprint = { objective: "相遇", endingHook: "少年看见她收起油布", povCharacterId: "wrong", locationIds: [], characterIds: ["wrong"], plotThreadIds: [], foreshadowingIds: [], conflict: "观察", informationRelease: [], mustHappen: ["模型节拍"], flexible: [], forbidden: ["模型禁写"], targetWords: 2000 };
    const brief = { povCharacterId: "boy", goal: "陌生少年进入渡口", tone: "克制", languageRequirements: ["限知"], mustHappen: ["少年出现"], forbidden: ["解释来历"], targetWords: 5000 } as CreativeBrief;

    const result = applyCreativeBriefToBlueprint(blueprint, brief);
    expect(result.povCharacterId).toBe("boy");
    expect(result.characterIds).toEqual(["wrong", "boy"]);
    expect(result.mustHappen).toEqual(["少年出现", "模型节拍"]);
    expect(result.forbidden).toEqual(["解释来历", "模型禁写"]);
    expect(result.targetWords).toBe(5000);
    const contract = formatCreativeBriefContract(brief, "旧渡少年");
    expect(contract).toContain("POV：旧渡少年（ID: boy）");
    expect(contract).toContain("mustHappen 和每个 beats.emotion");
  });

  it("detects non-POV interiority in blueprint goals and beat emotions", () => {
    const conflicts = findBlueprintPovConflicts({
      objective: "让沈砚秋感受到熟悉生活中的偏差",
      startingState: "少年站在渡口外沿",
      beats: [{ action: "沈砚秋走近少年", emotion: "沈砚秋克制心中的疑惑", outcome: "两人交谈" }],
      endingHook: "少年看见她收起油布",
    }, ["沈砚秋", "罗渡"]);
    expect(conflicts.map((item) => item.field)).toEqual(["章节目标", "节拍 1 情绪"]);
  });

  it("detects non-POV discoveries and judgments in mustHappen", () => {
    const conflicts = findBlueprintPovConflicts({
      mustHappen: ["沈砚秋发现旧账册被人换过", "罗渡察觉守门人的试探", "少年亲眼看见渡船靠岸"],
    }, ["沈砚秋", "罗渡"]);

    expect(conflicts.map((item) => item.field)).toEqual(["必写 1", "必写 2"]);
  });

  it("allows observable actions by non-POV characters", () => {
    expect(findBlueprintPovConflicts({
      objective: "少年在渡口遇见沈砚秋",
      startingState: "沈砚秋在案后抄写路引，少年隔窗看见她停笔",
      beats: [{ action: "沈砚秋把油布递给少年", emotion: "少年迟疑后接过", outcome: "少年留在檐下" }],
    }, ["沈砚秋"])).toEqual([]);
  });

  it("does not assign the POV character's following clause to a named speaker", () => {
    expect(findBlueprintPovConflicts({
      endingHook: "沈砚秋在雨声里听见罗渡留下的话，知道旧渡口那个陌生少年仍未离开。她望向窗外，意识到这份停留已经超过寻常过客的时间。",
    }, ["罗渡", "旧渡少年"])).toEqual([]);
  });

  it("rejects first-person blueprint fields under a third-person contract", () => {
    expect(findBlueprintPovConflicts({
      objective: "在旧渡口寻找熟悉痕迹",
      startingState: "我在雨后走近旧渡口",
      beats: [{ action: "少年触碰木桩", emotion: "少年感到木纹冰凉", outcome: "他停下脚步" }],
    }, ["沈砚秋"], true).map((item) => item.field)).toEqual(["起点"]);
  });
});
