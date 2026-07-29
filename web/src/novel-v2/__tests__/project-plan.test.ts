import { describe, expect, it } from "vitest";
import {
  PROJECT_PLAN_STAGES,
  approvedProjectBookTitle,
  isProjectPlanTaskKey,
  transitivePlanDependents,
} from "../application/project-plan";
import { buildFoundationPrompt } from "../prompts/foundation";

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

  it("requires a formal Chinese book title in project positioning", () => {
    const prompt = buildFoundationPrompt({
      taskKey: "project-positioning",
      instruction: "完成项目定位",
      projectTitle: "technical-project-id",
      premise: "一位归乡者追查旧案",
      priorArtifacts: [],
    });
    expect(prompt).toContain("正式书名");
    expect(prompt).toContain("bookTitle");
    expect(prompt).toContain("不要沿用项目 ID、英文代号或临时标题");
  });

  it("only adopts an explicit Chinese title from approved positioning data", () => {
    expect(approvedProjectBookTitle({ structuredData: { positioning: { bookTitle: "《长夜归舟》" } } })).toBe("长夜归舟");
    expect(approvedProjectBookTitle({ structuredData: { positioning: { bookTitle: "technical-project-id" } } })).toBeUndefined();
    expect(approvedProjectBookTitle({ summary: "正文里偶然提到《别人的作品》" } as never)).toBeUndefined();
  });
});
