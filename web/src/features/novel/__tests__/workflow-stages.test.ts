import { describe, expect, it } from "vitest";
import "../workflow"; // 触发 handler 注册（副作用：import "./workflow-stages" → registerAllHandlers）
import { APPROVAL_HANDLERS, STAGE_HANDLERS } from "../workflow-stages";

describe("workflow stage handler registry", () => {
  it("registers all 9 execution stage handlers", () => {
    const expectedStages = [
      "context",
      "blueprint",
      "draft",
      "deterministic-check",
      "review",
      "revision",
      "fact-extraction",
      "commit",
      "character-enrichment",
    ] as const;
    for (const stage of expectedStages) {
      expect(STAGE_HANDLERS.has(stage)).toBe(true);
      expect(STAGE_HANDLERS.get(stage)?.stage).toBe(stage);
    }
    expect(STAGE_HANDLERS.size).toBeGreaterThanOrEqual(9);
  });

  it("registers all 3 approval stage handlers", () => {
    const expectedStages = ["blueprint-approval", "manuscript-approval", "fact-approval"] as const;
    for (const stage of expectedStages) {
      expect(APPROVAL_HANDLERS.has(stage)).toBe(true);
      expect(APPROVAL_HANDLERS.get(stage)?.stage).toBe(stage);
    }
    expect(APPROVAL_HANDLERS.size).toBeGreaterThanOrEqual(3);
  });

  it("does not register approval stages in STAGE_HANDLERS", () => {
    expect(STAGE_HANDLERS.has("blueprint-approval")).toBe(false);
    expect(STAGE_HANDLERS.has("manuscript-approval")).toBe(false);
    expect(STAGE_HANDLERS.has("fact-approval")).toBe(false);
  });

  it("does not register execution stages in APPROVAL_HANDLERS", () => {
    expect(APPROVAL_HANDLERS.has("context")).toBe(false);
    expect(APPROVAL_HANDLERS.has("blueprint")).toBe(false);
    expect(APPROVAL_HANDLERS.has("draft")).toBe(false);
    expect(APPROVAL_HANDLERS.has("commit")).toBe(false);
  });
});
