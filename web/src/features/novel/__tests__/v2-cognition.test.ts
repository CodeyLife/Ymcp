import { describe, expect, it } from "vitest";
import { buildContextManifest, buildMemoryBundle, compileExecutionBlueprint, createPreflightPlan, resolveSkillBundle } from "../../../novel-v2/cognition";
import type { MemoryProvider, NovelIntent, SkillProvider } from "../../../novel-v2/protocol";

const intent: NovelIntent = { id: "intent-1", projectId: "p1", source: "web", objective: "续写第 12 章，保持主角对秘密尚未知情", target: { kind: "chapter", id: "doc-12", order: 12 }, requestedStage: "drafting", createdAt: 1, idempotencyKey: "k1" };

describe("V2 cognition compiler", () => {
  it("creates retrieval facets before an execution blueprint", () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentId: "doc-12", targetDocumentOrder: 12, povCharacterId: "hero" });
    expect(plan.stage).toBe("drafting");
    expect(plan.facets.some((facet) => facet.kind === "relation" && facet.knowledgeCharacterId === "hero")).toBe(true);
    expect(plan.narrativeCutoff).toBe(11);
  });

  it("filters future claims before the frozen bundle", async () => {
    const provider: MemoryProvider = { search: async () => [
      { id: "past", projectId: "p1", kind: "canonical", title: "过去", content: "已知", subjectRefs: ["hero"], narrativeRange: { start: 4 }, knowledgeScope: { characterId: "hero" }, authority: "approved", confidence: 1, sourceRevisionIds: ["r4"], contentHash: "a", supersedes: [], score: 0.9, matchedFacet: "fact", reason: "exact" },
      { id: "future", projectId: "p1", kind: "canonical", title: "未来", content: "不应泄漏", subjectRefs: ["hero"], narrativeRange: { start: 20 }, knowledgeScope: "author", authority: "approved", confidence: 1, sourceRevisionIds: ["r20"], contentHash: "b", supersedes: [], score: 1, matchedFacet: "fact", reason: "vector" },
    ] };
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12, povCharacterId: "hero" });
    const bundle = await buildMemoryBundle(plan, { projectId: "p1", provider });
    expect(bundle.claims.map((claim) => claim.id)).toEqual(["past"]);
    expect(bundle.sourceRevisionIds).toEqual(["r4"]);
  });

  it("orders authoritative memories and freezes a ContextManifest before blueprint compilation", async () => {
    const provider: MemoryProvider = { search: async () => [
      { id: "candidate", projectId: "p1", kind: "episodic", title: "候选", content: "候选记忆", subjectRefs: ["hero"], narrativeRange: { start: 4 }, knowledgeScope: "author", authority: "candidate", confidence: 0.9, sourceRevisionIds: ["r-c"], contentHash: "c", supersedes: [], score: 0.99, matchedFacet: "fact", reason: "semantic" },
      { id: "approved", projectId: "p1", kind: "canonical", title: "核准", content: "正式事实", subjectRefs: ["hero"], narrativeRange: { start: 4 }, knowledgeScope: "author", authority: "approved", confidence: 0.7, sourceRevisionIds: ["r-a"], contentHash: "a", supersedes: [], score: 0.5, matchedFacet: "entity", reason: "lexical" },
      { id: "thread", projectId: "p1", kind: "hierarchical", title: "线索", content: "主线仍在推进", subjectRefs: ["thread"], narrativeRange: { start: 5 }, knowledgeScope: "author", authority: "approved", confidence: 0.7, sourceRevisionIds: ["r-t"], contentHash: "t", supersedes: [], score: 0.4, matchedFacet: "thread", reason: "lexical" },
      { id: "foreshadowing", projectId: "p1", kind: "hierarchical", title: "伏笔", content: "秘密尚未揭开", subjectRefs: ["thread"], narrativeRange: { start: 5 }, knowledgeScope: "author", authority: "approved", confidence: 0.7, sourceRevisionIds: ["r-f"], contentHash: "f", supersedes: [], score: 0.4, matchedFacet: "foreshadowing", reason: "lexical" },
    ] };
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });
    const memory = await buildMemoryBundle(plan, { projectId: "p1", provider });
    const manifest = buildContextManifest(plan, memory, { retrievalRunId: "retrieval-1", allClaimIds: ["approved", "candidate", "excluded"] });
    const skills = await resolveSkillBundle(plan, memory, { projectId: "p1", provider: { list: async () => [] } satisfies SkillProvider });
    const blueprint = compileExecutionBlueprint(intent, plan, memory, skills, { projectId: "p1", currentRevision: 7 }, manifest);
    expect(memory.claims.map((claim) => claim.id)).toEqual(["approved", "thread", "foreshadowing", "candidate"]);
    expect(manifest).toMatchObject({ memoryBundleId: memory.id, includedClaimIds: ["approved", "thread", "foreshadowing", "candidate"], excludedClaimIds: ["excluded"], truncationReason: "budget" });
    expect(blueprint.contextManifestId).toBe(manifest.id);
  });

  it("rejects high-risk execution when required memory is missing", async () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12, povCharacterId: "hero" });
    const memory = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [] } });
    const skills = await resolveSkillBundle(plan, memory, { projectId: "p1", provider: { list: async () => [] } satisfies SkillProvider });
    expect(() => compileExecutionBlueprint(intent, plan, memory, skills, { projectId: "p1", currentRevision: 7 })).toThrow(/缺少记忆维度/);
  });
});
