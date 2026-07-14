import { describe, expect, it } from "vitest";
import { aggregateQuality, runDeterministicQualityChecks } from "../quality";

describe("novel quality gates", () => {
  it("creates blockers for forbidden content and missing mandatory beats", () => {
    const result = runDeterministicQualityChecks({
      text: "主角忽然获得无代价的读心能力。\n\n他立刻离开现场。",
      blueprint: { objective: "发现线索", locationIds: [], characterIds: [], conflict: "追查", informationRelease: [], turningPoint: "发现账本", hook: "有人跟踪", mustHappen: ["主角发现染血账本"], flexible: [], forbidden: ["获得读心能力"], targetWords: 3000 },
    });
    expect(result.issues.filter((item) => item.severity === "blocker")).toHaveLength(2);
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
});

describe("prose discipline checks", () => {
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
