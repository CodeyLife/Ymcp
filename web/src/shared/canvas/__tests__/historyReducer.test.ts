import { describe, expect, it } from "vitest";

import { commitHistory, createEmptyHistory, redoHistory, undoHistory } from "../hooks/historyReducer";
import type { CanvasEdge, CanvasNode } from "../types";

type Domain = { name: string };

function node(id: string, name: string): CanvasNode<Domain> {
  return { id, kind: "character", position: { x: 0, y: 0 }, width: 200, height: 100, data: { name } };
}

function edge(id: string, from: string, to: string): CanvasEdge {
  return { id, fromNodeId: from, toNodeId: to };
}

describe("createEmptyHistory", () => {
  it("returns a state with empty past/future and null lastCommitted", () => {
    const state = createEmptyHistory<Domain>();
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
    expect(state.lastCommitted).toBeNull();
  });
});

describe("commitHistory", () => {
  it("sets lastCommitted on first commit without pushing to past", () => {
    const state = createEmptyHistory<Domain>();
    const snapshot = { nodes: [node("n1", "A")], edges: [] };
    const next = commitHistory(state, snapshot, 50);
    expect(next.lastCommitted?.nodes).toHaveLength(1);
    expect(next.lastCommitted?.nodes[0].data.name).toBe("A");
    expect(next.past).toEqual([]);
    expect(next.future).toEqual([]);
  });

  it("pushes the previous lastCommitted to past on subsequent commit and clears future", () => {
    const initial = { nodes: [node("n1", "A")], edges: [] };
    let state = commitHistory(createEmptyHistory<Domain>(), initial, 50);
    state = commitHistory(state, { nodes: [node("n1", "A"), node("n2", "B")], edges: [edge("e1", "n1", "n2")] }, 50);

    expect(state.past).toHaveLength(1);
    expect(state.past[0].nodes).toHaveLength(1);
    expect(state.lastCommitted?.nodes).toHaveLength(2);
    expect(state.lastCommitted?.edges).toHaveLength(1);
    expect(state.future).toEqual([]);
  });

  it("respects maxHistory by trimming the oldest past entry", () => {
    let state = createEmptyHistory<Domain>();
    for (let i = 0; i < 5; i++) {
      state = commitHistory(state, { nodes: [node(`n${i}`, `v${i}`)], edges: [] }, 3);
    }
    // 5 commits with maxHistory=3: lastCommitted=v4, past=[v1,v2,v3] (v0 trimmed)
    expect(state.past.length).toBe(3);
    expect(state.past[0].nodes[0].data.name).toBe("v1");
    expect(state.past[2].nodes[0].data.name).toBe("v3");
    expect(state.lastCommitted?.nodes[0].data.name).toBe("v4");
  });

  it("does not mutate the input state", () => {
    const state = createEmptyHistory<Domain>();
    const snapshot = { nodes: [node("n1", "A")], edges: [] };
    const next = commitHistory(state, snapshot, 50);
    expect(state.past).toEqual([]);
    expect(state.lastCommitted).toBeNull();
    expect(next).not.toBe(state);
  });
});

describe("undoHistory", () => {
  it("returns null target when past is empty", () => {
    const state = createEmptyHistory<Domain>();
    const result = undoHistory(state);
    expect(result.target).toBeNull();
    expect(result.state).toBe(state);
  });

  it("pops the last past entry as the new lastCommitted and pushes current lastCommitted to future", () => {
    let state = createEmptyHistory<Domain>();
    state = commitHistory(state, { nodes: [node("n1", "A")], edges: [] }, 50);
    state = commitHistory(state, { nodes: [node("n1", "B")], edges: [] }, 50);

    const result = undoHistory(state);
    expect(result.target?.nodes[0].data.name).toBe("A");
    expect(result.state.lastCommitted?.nodes[0].data.name).toBe("A");
    expect(result.state.future).toHaveLength(1);
    expect(result.state.future[0].nodes[0].data.name).toBe("B");
    expect(result.state.past).toEqual([]);
  });
});

describe("redoHistory", () => {
  it("returns null target when future is empty", () => {
    const state = createEmptyHistory<Domain>();
    const result = redoHistory(state);
    expect(result.target).toBeNull();
    expect(result.state).toBe(state);
  });

  it("pops the last future entry as the new lastCommitted and pushes current lastCommitted to past", () => {
    let state = createEmptyHistory<Domain>();
    state = commitHistory(state, { nodes: [node("n1", "A")], edges: [] }, 50);
    state = commitHistory(state, { nodes: [node("n1", "B")], edges: [] }, 50);
    const undone = undoHistory(state);

    const result = redoHistory(undone.state);
    expect(result.target?.nodes[0].data.name).toBe("B");
    expect(result.state.lastCommitted?.nodes[0].data.name).toBe("B");
    expect(result.state.future).toEqual([]);
    expect(result.state.past).toHaveLength(1);
    expect(result.state.past[0].nodes[0].data.name).toBe("A");
  });
});

describe("round-trip", () => {
  it("commit A → commit B → undo restores A → redo restores B", () => {
    let state = createEmptyHistory<Domain>();
    state = commitHistory(state, { nodes: [node("n1", "A")], edges: [] }, 50);
    state = commitHistory(state, { nodes: [node("n1", "B")], edges: [] }, 50);

    const undoResult = undoHistory(state);
    expect(undoResult.target?.nodes[0].data.name).toBe("A");
    state = undoResult.state;

    const redoResult = redoHistory(state);
    expect(redoResult.target?.nodes[0].data.name).toBe("B");
    state = redoResult.state;

    expect(state.past).toHaveLength(1);
    expect(state.future).toEqual([]);
    expect(state.lastCommitted?.nodes[0].data.name).toBe("B");
  });

  it("committing after undo clears the future branch", () => {
    let state = createEmptyHistory<Domain>();
    state = commitHistory(state, { nodes: [node("n1", "A")], edges: [] }, 50);
    state = commitHistory(state, { nodes: [node("n1", "B")], edges: [] }, 50);
    state = undoHistory(state).state;
    expect(state.future).toHaveLength(1);

    state = commitHistory(state, { nodes: [node("n1", "C")], edges: [] }, 50);
    expect(state.future).toEqual([]);
    expect(state.lastCommitted?.nodes[0].data.name).toBe("C");
  });
});
