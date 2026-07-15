import { describe, expect, it } from "vitest";
import { assertModelContextLimit, estimateNovelTokens, recordModelContextWindow, resolveModelContextWindow } from "../model-capabilities";

describe("novel model capabilities", () => {
  it("records context-window metadata returned by a provider", () => {
    recordModelContextWindow("novel-model", 32768);
    expect(resolveModelContextWindow("novel-model")).toBe(32768);
  });

  it("uses a CJK-aware estimate and rejects before exceeding the provider hard limit", () => {
    expect(estimateNovelTokens("中文正文")).toBeGreaterThan(4);
    expect(() => assertModelContextLimit({ model: "small", text: "长篇上下文".repeat(100), override: 200, outputReserve: 100 })).toThrow(/硬上限/);
  });

  it("does not impose a project budget when the provider limit is unknown", () => {
    expect(() => assertModelContextLimit({ model: "unknown", text: "正文".repeat(10000) })).not.toThrow();
  });
});
