import { describe, expect, it } from "vitest";

import { analyzeOutlineProposal, analyzeOutlineStructure } from "../outline-structure";
import type { ArchitecturePhase, OutlineNode, ProposalItem } from "../types";

const phases: ArchitecturePhase[] = [{ id: "phase-1", title: "第一幕", purpose: "建立困境", turningPoint: "被迫离开", order: 0, locked: false, primaryCurveId: "main" }];

function node(id: string, phaseId = "phase-1", order = 0): OutlineNode {
  return { id, projectId: "project", schemaVersion: 8, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test", phaseId, order, title: id, summary: "概要" };
}

function item(id: string, phaseId = "phase-1", order = 0): ProposalItem {
  return { id, tempId: id, label: id, operation: "create", targetTable: "outlineNodes", status: "pending", payload: { phaseId, title: id, summary: "概要", order }, rationale: "测试", dependencies: [] };
}

describe("outline structure analysis", () => {
  it("accepts plot segments that belong to an architecture phase", () => {
    const analysis = analyzeOutlineStructure([node("segment-a", "phase-1", 0), node("segment-b", "phase-1", 1)], phases);
    expect(analysis.issues).toEqual([]);
    expect(analysis.nodes.map((value) => value.id)).toEqual(["segment-a", "segment-b"]);
  });

  it("rejects a plot segment whose phase does not exist", () => {
    const analysis = analyzeOutlineStructure([node("orphan", "missing")], phases);
    expect(analysis.invalidNodes.map((value) => value.id)).toEqual(["orphan"]);
    expect(analysis.issues[0]).toMatchObject({ code: "missing-phase", nodeId: "orphan" });
  });

  it("reports duplicate order values inside the same phase", () => {
    const analysis = analyzeOutlineStructure([node("a", "phase-1", 0), node("b", "phase-1", 0)], phases);
    expect(analysis.issues.filter((issue) => issue.code === "duplicate-order")).toHaveLength(2);
  });
});

describe("outline proposal analysis", () => {
  it("uses the same phase ownership rules for proposal plot segments", () => {
    expect(analyzeOutlineProposal([item("segment")], phases).issues).toEqual([]);
    expect(analyzeOutlineProposal([item("orphan", "missing")], phases).issues[0]?.code).toBe("missing-phase");
  });
});
