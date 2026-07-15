import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import OutlineProposalReview from "../OutlineProposalReview";
import { PLANNING_MODE_OPTIONS } from "../PlanningWorkspace";
import type { AIProposal } from "../types";

describe("unified planning workspace", () => {
  it("offers one planning surface and a chapter matrix", () => {
    expect(PLANNING_MODE_OPTIONS.map((item) => item.label)).toEqual(["全书规划", "章节矩阵"]);
  });

  it("reviews plot segments and formal chapters without an event layer", () => {
    const proposal: AIProposal = {
      id: "proposal", projectId: "project", schemaVersion: 8, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test",
      title: "剧情段与章节设计", operation: "structured:plot-design", taskKey: "plot-design", scope: "plot-design", targetId: "phase-1", status: "pending", previewMarkdown: "", patches: [], contextPacketId: "context", model: "test", outlineGenerationMode: "plot-segment-append",
      items: [
        { id: "segment", tempId: "segment", label: "离开故乡", operation: "create", targetTable: "outlineNodes", status: "pending", payload: { phaseId: "phase-1", title: "离开故乡", summary: "封锁迫使主角离开。", order: 0 }, rationale: "", dependencies: [] },
        { id: "chapter-1", tempId: "chapter-1", label: "封锁之夜", operation: "create", targetTable: "documents", status: "pending", payload: { plotSegmentId: "ref:segment", title: "封锁之夜", summary: "主角决定离开。", order: 0, blueprint: {} }, rationale: "", dependencies: [] },
        { id: "chapter-2", tempId: "chapter-2", label: "城门之外", operation: "create", targetTable: "documents", status: "pending", payload: { plotSegmentId: "ref:segment", title: "城门之外", summary: "主角付出代价。", order: 1, blueprint: {} }, rationale: "", dependencies: [] },
      ],
    };
    const html = renderToStaticMarkup(<App><OutlineProposalReview proposal={proposal} onRegenerate={() => undefined} /></App>);
    expect(html).toContain("审核剧情段与章节");
    expect(html).toContain("1 个剧情段");
    expect(html).toContain("2 个章节");
    expect(html).not.toContain("原子事件");
  });
});
