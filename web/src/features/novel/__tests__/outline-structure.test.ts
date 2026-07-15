import { describe, expect, it } from "vitest";

import { analyzeOutlineProposal, analyzeOutlineStructure } from "../outline-structure";
import type { OutlineNode, ProposalItem } from "../types";

function node(id: string, kind: OutlineNode["kind"], parentId?: string, order = 0) {
  return { id, kind, parentId, order, title: id };
}

function item(id: string, tempId: string, kind: OutlineNode["kind"], parentId?: string, order = 0): ProposalItem {
  return {
    id,
    tempId,
    label: tempId,
    operation: "create",
    targetTable: "outlineNodes",
    status: "pending",
    payload: { kind, title: tempId, summary: "概要", order, ...(parentId ? { parentId } : {}) },
    rationale: "测试",
    dependencies: [],
  };
}

describe("outline structure analysis", () => {
  it("accepts a valid act, sequence, event hierarchy", () => {
    const analysis = analyzeOutlineStructure([
      node("act", "act"),
      node("sequence", "sequence", "act"),
      node("event", "event", "sequence"),
    ]);
    expect(analysis.issues).toEqual([]);
    expect(analysis.roots.map((value) => value.id)).toEqual(["act"]);
    expect(analysis.invalidNodes).toEqual([]);
  });

  it("keeps orphaned and wrongly nested nodes out of the formal tree", () => {
    const analysis = analyzeOutlineStructure([
      node("act", "act"),
      node("orphan", "event", "missing"),
      node("wrong", "sequence", "orphan"),
    ]);
    expect(analysis.roots.map((value) => value.id)).toEqual(["act"]);
    expect(analysis.invalidNodes.map((value) => value.id)).toEqual(["orphan", "wrong"]);
    expect(analysis.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["missing-parent", "wrong-parent-kind"]));
  });

  it("reports duplicate sibling order values", () => {
    const analysis = analyzeOutlineStructure([
      node("act-a", "act", undefined, 0),
      node("act-b", "act", undefined, 0),
    ]);
    expect(analysis.issues.filter((issue) => issue.code === "duplicate-order")).toHaveLength(2);
  });
});

describe("outline proposal analysis", () => {
  it("resolves temp references into a reviewable tree", () => {
    const analysis = analyzeOutlineProposal([
      item("i-act", "act-1", "act"),
      item("i-seq", "seq-1", "sequence", "ref:act-1"),
      item("i-event", "event-1", "event", "ref:seq-1"),
    ]);
    expect(analysis.issues).toEqual([]);
    expect(analysis.roots[0].id).toBe("act-1");
    expect(analysis.nodes.find((value) => value.id === "event-1")?.parentId).toBe("seq-1");
  });

  it("blocks partial selection that leaves a sequence empty", () => {
    const analysis = analyzeOutlineProposal([
      item("i-act", "act-1", "act"),
      item("i-seq", "seq-1", "sequence", "ref:act-1"),
    ]);
    expect(analysis.issues.map((issue) => issue.code)).toContain("missing-child");
  });
});

