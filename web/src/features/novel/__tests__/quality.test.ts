import { describe, expect, it } from "vitest";
import { aggregateQuality, runDeterministicQualityChecks } from "../quality";

describe("novel quality gates", () => {
  it("creates blockers for forbidden content and missing mandatory beats", () => {
    const result = runDeterministicQualityChecks({
      text: "主角忽然获得无代价的读心能力。\n\n他立刻离开现场。",
      blueprint: { objective: "发现线索", locationIds: [], characterIds: [], conflict: "追查", informationRelease: [], mustHappen: ["主角发现染血账本"], flexible: [], forbidden: ["获得读心能力"], targetWords: 3000 },
    });
    expect(result.issues.filter((item) => item.severity === "blocker")).toHaveLength(2);
  });

  it("does not satisfy a mandatory action from entity mentions alone", () => {
    const result = runDeterministicQualityChecks({
      text: "阿落望向师父，玉佩仍藏在她的袖中。两人没有交谈，随后各自离开。",
      blueprint: { objective: "交出信物", locationIds: [], characterIds: [], conflict: "是否信任", informationRelease: [], mustHappen: ["阿落取出玉佩交给师父"], flexible: [], forbidden: [], targetWords: 3000 },
    });

    expect(result.issues.some((item) => item.rule === "chapter-blueprint.mustHappen")).toBe(true);
  });

  it("does not satisfy a multi-clause beat from only its first action", () => {
    const result = runDeterministicQualityChecks({
      text: "阿落取出玉佩，握在掌心端详许久，最后又收回袖中。",
      blueprint: { objective: "交出信物", locationIds: [], characterIds: [], conflict: "是否信任", informationRelease: [], mustHappen: ["阿落取出玉佩，交给师父"], flexible: [], forbidden: [], targetWords: 3000 },
    });

    expect(result.issues.some((item) => item.rule === "chapter-blueprint.mustHappen")).toBe(true);
  });

  it("treats template expression density as a warning, not a blocker", () => {
    const text = Array.from({ length: 5 }, () => "他眼中闪过一丝迟疑，嘴角微微上扬。随后他看向门外。 ").join("\n\n");
    const result = runDeterministicQualityChecks({ text });
    expect(result.issues.some((item) => item.rule === "style.template-density" && item.severity === "warning")).toBe(true);
    expect(result.issues.some((item) => item.rule === "style.template-density" && item.severity === "blocker")).toBe(false);
  });

  it("requires no blockers, a dimension floor and the weighted threshold", () => {
    const deterministic = runDeterministicQualityChecks({ text: "足够具体的场景正文。".repeat(80) });
    const passed = aggregateQuality({ deterministic, threshold: 3.7 });
    expect(passed.passed).toBe(true);
    const failed = aggregateQuality({ deterministic, threshold: 4.8 });
    expect(failed.passed).toBe(false);
  });

  it("preserves all revision ranges when duplicate reviewer issues are merged", () => {
    const deterministic = runDeterministicQualityChecks({ text: "足够具体的场景正文。".repeat(80) });
    const baseIssue = {
      dimension: "plot" as const,
      severity: "major" as const,
      title: "后半章推进重复",
      description: "后半章出现第二套推进。",
      rule: "plot.repeated-progression",
      suggestion: "删除重复事件。",
    };
    const result = aggregateQuality({
      deterministic,
      threshold: 3.7,
      reviewers: [
        { role: "plot-reviewer", scores: { plot: 2 }, issues: [{ ...baseIssue, revisionRanges: [{ start: 291, end: 293 }] }] },
        { role: "pacing-reviewer", scores: { pacing: 2 }, issues: [{ ...baseIssue, revisionRanges: [{ start: 294, end: 296 }] }] },
      ],
    });

    expect(result.issues.find((item) => item.rule === baseIssue.rule)?.revisionRanges).toEqual([
      { start: 291, end: 293 },
      { start: 294, end: 296 },
    ]);
  });

  it("does not pass a chapter while a structural major issue remains", () => {
    const distinct = Array.from({ length: 5 }, (_, index) => `第${index + 1}队商旅越过山口，领队逐一核对车轮和水囊。天色转暗后，他们在背风处扎营并安排守夜。营火升起时，伙计开始清点沿途损耗。`);
    const repeated = "第一队商旅越过山口，领队逐一核对车轮和水囊。天色转暗后，他们在背风处扎营并安排守夜。营火升起时，伙计开始清点沿途损耗。";
    const deterministic = runDeterministicQualityChecks({ text: [repeated, ...distinct, repeated].join("\n\n") });

    const result = aggregateQuality({ deterministic, threshold: 3.7 });

    expect(deterministic.issues.some((item) => item.rule === "plot.exact-paragraph-repeat")).toBe(true);
    expect(result.passed).toBe(false);
  });
});

describe("prose discipline checks", () => {
  it("promotes draft structure violations into deterministic quality issues", () => {
    const text = ["风停了。", "他抬起头。", "远处有人走来。", "脚步越来越近。"].join("\n\n");

    const result = runDeterministicQualityChecks({ text });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "style.fragmented-paragraphs",
        severity: "major",
        dimension: "pacing",
        revisionRanges: [{ start: 1, end: 4 }],
      }),
    ]));
  });

  it("flags emphasis word devaluation when a word exceeds 2 occurrences", () => {
    const text = "他第一次意识到危险。\n\n第一次，他选择了沉默。\n\n这是他第一次真正感到恐惧。";
    const result = runDeterministicQualityChecks({ text });
    expect(result.issues.some((item) => item.rule === "style.emphasis-devaluation" && item.description.includes("第一次"))).toBe(true);
  });

  it("flags direct emotion declarations", () => {
    const text = "他站在原地，他很悲伤，没有说话。\n\n风继续吹着。";
    const result = runDeterministicQualityChecks({ text });
    expect(result.issues.some((item) => item.rule === "style.emotion-direct" && item.excerpt?.includes("他很悲伤"))).toBe(true);
  });

  it("flags excessive short-sentence streaks beyond 2 occurrences", () => {
    const text = "速度。力量。变化。\n\n停下。风停。灯灭。\n\n关门。锁门。走人。";
    const result = runDeterministicQualityChecks({ text });
    expect(result.issues.some((item) => item.rule === "style.short-sentence-tic")).toBe(true);
  });

  it("keeps short-sentence streaks continuous across paragraph boundaries", () => {
    const text = ["风停。", "灯灭。", "门响。", "人来。", "刀出。", "血落。", "雨落。", "车停。", "马嘶。", "他终于向后退了一步。"].join("\n\n");

    const result = runDeterministicQualityChecks({ text });

    expect(result.issues.some((item) => item.rule === "style.short-sentence-tic")).toBe(true);
  });

  it("does not count dialogue-only paragraphs as short-sentence tic streaks", () => {
    const dialogue = ["“走。”", "“等等。”", "“快点。”", "“有人。”", "“在哪？”", "“门外。”", "“别动。”", "“听着。”", "“来了。”"];
    const text = [...dialogue, "门外的脚步声越过长廊，最后停在半掩的木门前。屋里的人都握紧武器，没有继续交谈。"].join("\n\n");

    const result = runDeterministicQualityChecks({ text });

    expect(result.issues.some((item) => item.rule === "style.short-sentence-tic")).toBe(false);
  });

  it("flags aphorism density when exceeding 3 endings", () => {
    const text = "所谓成长不过是学会沉默。\n\n也许离别就是人生的常态。\n\n这便是命运。\n\n或许遗忘才是最终的答案。";
    const result = runDeterministicQualityChecks({ text });
    expect(result.issues.some((item) => item.rule === "style.aphorism-density")).toBe(true);
  });

  it("counts imagery density in metrics", () => {
    const text = "风吹过雪地，月光照在剑上，灯火摇曳。";
    const result = runDeterministicQualityChecks({ text });
    expect(result.metrics.imageryDensity).toBeGreaterThan(0);
  });
});
