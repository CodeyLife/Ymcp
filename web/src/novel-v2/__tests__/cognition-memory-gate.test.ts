import { describe, expect, it } from "vitest";
import { compileExecutionBlueprint } from "../cognition";
import type { MemoryBundle, NovelIntent, PreflightPlan, SkillBundle } from "../protocol";

const intent: NovelIntent = { id: "intent-gate", projectId: "p1", source: "web", objective: "修订第十章", requestedStage: "revision", createdAt: 1, idempotencyKey: "gate" };
const plan: PreflightPlan = {
  id: "preflight-gate", intentId: intent.id, projectId: "p1", taskClass: "revision", stage: "revision", targetDocumentId: "doc-10", narrativeCutoff: 9,
  facets: ["fact", "entity", "thread", "foreshadowing", "chapter-memory"].map((kind) => ({ kind: kind as "fact" | "entity" | "thread" | "foreshadowing" | "chapter-memory", query: kind, required: kind === "fact" || kind === "chapter-memory" })),
  risk: "high", requiresIndependentReview: true, createdAt: 1, sourceFingerprint: "plan",
};
const skills: SkillBundle = { id: "skills", projectId: "p1", preflightId: plan.id, skills: [], conflicts: [], missingCapabilities: [], fingerprint: "skills", createdAt: 1 };

function memory(facets: Array<"fact" | "entity" | "thread" | "foreshadowing" | "chapter-memory">): MemoryBundle {
  return {
    id: "memory", projectId: "p1", preflightId: plan.id, conflicts: [], missingFacets: [], tokenBudget: 24000, sourceRevisionIds: ["r1"], narrativeCutoff: 9, fingerprint: "memory", createdAt: 1,
    claims: facets.map((facet) => ({ id: facet, projectId: "p1", kind: "canonical", title: facet, content: facet, subjectRefs: [], knowledgeScope: "author", authority: "approved", confidence: 1, sourceRevisionIds: ["r1"], contentHash: facet, supersedes: [], score: 1, matchedFacet: facet, reason: "test" })),
  };
}

describe("V2 memory coverage gate", () => {
  it("blocks revision when fact or prior chapter memory is unavailable", () => {
    expect(() => compileExecutionBlueprint(intent, plan, memory(["entity"]), skills, { projectId: "p1", currentRevision: 2, targetDocumentOrder: 10 })).toThrow(/缺少记忆维度/);
  });

  it("routes incomplete secondary context to manual review instead of silent degradation", () => {
    const blueprint = compileExecutionBlueprint(intent, plan, memory(["fact", "chapter-memory"]), skills, { projectId: "p1", currentRevision: 2, targetDocumentOrder: 10 });
    expect(blueprint.memoryGate).toEqual({ status: "manual-review", missingFacets: ["entity", "thread", "foreshadowing"], manualReviewFacets: ["entity", "thread", "foreshadowing"] });
  });
});
