import { describe, expect, it } from "vitest";
import {
  PROJECT_PLAN_STAGES,
  isProjectPlanTaskKey,
  transitivePlanDependents,
} from "../application/project-plan";

describe("project plan dependency contract", () => {
  it("keeps one ordered, complete stage vocabulary", () => {
    expect(PROJECT_PLAN_STAGES.map((stage) => stage.taskKey)).toEqual([
      "project-positioning", "architecture", "characters", "worldview", "relations",
      "plot-threads", "foreshadowing", "timeline", "story-control", "plot-design",
    ]);
    expect(isProjectPlanTaskKey("chapter-plan")).toBe(true);
    expect(isProjectPlanTaskKey("fixture-only-stage")).toBe(false);
  });

  it("invalidates every transitive consumer of an edited upstream decision", () => {
    const affected = new Set(transitivePlanDependents("characters"));
    for (const key of ["relations", "plot-threads", "foreshadowing", "timeline", "story-control", "plot-design"]) {
      expect(affected.has(key as never), key).toBe(true);
    }
    expect(affected.has("architecture")).toBe(false);
  });

  it("keeps unrelated branches valid when worldview changes", () => {
    const affected = new Set(transitivePlanDependents("worldview"));
    expect(affected.has("characters")).toBe(false);
    expect(affected.has("relations")).toBe(true);
    expect(affected.has("plot-design")).toBe(true);
  });
});
