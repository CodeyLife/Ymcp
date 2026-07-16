import { describe, expect, it } from "vitest";
import { settleWithConcurrency } from "../workflow-stages/settled-pool";

describe("settled reviewer pool", () => {
  it("preserves result order and never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const results = await settleWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (value === 3) throw new Error("temporary failure");
      return value * 10;
    });

    expect(peak).toBe(2);
    expect(results.map((item) => item.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled"]);
    expect(results[4]).toEqual({ status: "fulfilled", value: 50 });
  });
});
