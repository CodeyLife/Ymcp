import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalSha256 } from "../canonical-json";
import { createPreflightPlan } from "../cognition";
import type { NovelIntent, PreflightProjectSnapshot } from "../protocol";

describe("canonical JSON fingerprints", () => {
  it("is stable when only nested object key order changes", () => {
    const left = { outer: { beta: 2, alpha: 1 }, list: [{ delta: 4, gamma: 3 }] };
    const right = { list: [{ gamma: 3, delta: 4 }], outer: { alpha: 1, beta: 2 } };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalSha256(left)).toBe(canonicalSha256(right));
  });

  it("changes for nested values and array order", () => {
    expect(canonicalSha256({ nested: { value: "a" } })).not.toBe(canonicalSha256({ nested: { value: "b" } }));
    expect(canonicalSha256({ values: ["a", "b"] })).not.toBe(canonicalSha256({ values: ["b", "a"] }));
  });

  it("changes the preflight source fingerprint when intent or snapshot content changes", () => {
    const intent: NovelIntent = { id: "i", projectId: "p", source: "web", objective: "写第一章", createdAt: 1, idempotencyKey: "k" };
    const snapshot: PreflightProjectSnapshot = { projectId: "p", currentRevision: 1 };
    const baseline = createPreflightPlan(intent, snapshot, 1).sourceFingerprint;
    expect(createPreflightPlan({ ...intent, objective: "写第二章" }, snapshot, 1).sourceFingerprint).not.toBe(baseline);
    expect(createPreflightPlan(intent, { ...snapshot, currentRevision: 2 }, 1).sourceFingerprint).not.toBe(baseline);
  });
});
