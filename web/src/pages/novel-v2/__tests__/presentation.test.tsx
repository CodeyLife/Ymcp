import { describe, expect, it } from "vitest";
import { projectDisplayTitle, workflowTypeMeta } from "../presentation";
import { isChapterWorkflowRun, type NovelWorkflowRunRecord } from "@/lib/novelApi";

describe("novel workspace presentation", () => {
  it("hides technical project identifiers until a readable book title is selected", () => {
    expect(projectDisplayTitle("spirit-logic-v4-20260729", "spirit-logic-v4-20260729")).toBe("未命名作品");
    expect(projectDisplayTitle("长夜归舟")).toBe("长夜归舟");
    expect(projectDisplayTitle("The Long Return", "project-1")).toBe("The Long Return");
  });

  it("gives title and synopsis workflows readable Chinese labels", () => {
    expect(workflowTypeMeta("book-title-candidates").label).toBe("书名生成");
    expect(workflowTypeMeta("book-synopsis").label).toBe("作品简介生成");
  });

  it("does not treat a background chapter-title task as chapter production", () => {
    const run = { workflowType: "chapter-title", payload: { documentId: "chapter-1" } } as unknown as NovelWorkflowRunRecord;
    expect(isChapterWorkflowRun(run)).toBe(false);
  });
});
