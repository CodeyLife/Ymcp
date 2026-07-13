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
