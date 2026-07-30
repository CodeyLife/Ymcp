import { describe, expect, it } from "vitest";
import { buildContextManifest, buildMemoryBundle, compileExecutionBlueprint, createPreflightPlan, resolveSkillBundle } from "../cognition";
import type { MemoryProvider, NovelIntent, SkillProvider } from "../protocol";

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
    const manifest = buildContextManifest(plan, memory, { retrievalRunId: "retrieval-1" });
    const skills = await resolveSkillBundle(plan, memory, { projectId: "p1", provider: { list: async () => [] } satisfies SkillProvider });
    const blueprint = compileExecutionBlueprint(intent, plan, memory, skills, { projectId: "p1", currentRevision: 7 }, manifest);
    expect(memory.claims.map((claim) => claim.id)).toEqual(["candidate", "approved", "foreshadowing", "thread"]);
    expect(manifest).toMatchObject({ memoryBundleId: memory.id, includedClaimIds: ["candidate", "approved", "foreshadowing", "thread"], excludedClaimIds: [], truncationReason: "none" });
    expect(blueprint.contextManifestId).toBe(manifest.id);
    expect(blueprint.factApprovalMode).toBe("auto");
  });

  it("preserves an explicit manual fact approval policy in the execution blueprint", async () => {
    const manualIntent: NovelIntent = { ...intent, factApprovalMode: "manual" };
    const plan = createPreflightPlan(manualIntent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });
    const memory = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [{ id: "known-fact", projectId: "p1", kind: "canonical", title: "已知事实", content: "当前章节可见", subjectRefs: [], narrativeRange: { start: 1 }, knowledgeScope: "author", authority: "approved", confidence: 1, sourceRevisionIds: ["r1"], contentHash: "known-fact", supersedes: [], score: 1, matchedFacet: "fact", reason: "exact" }] } });
    const skills = await resolveSkillBundle(plan, memory, { projectId: "p1", provider: { list: async () => [] } satisfies SkillProvider });

    const blueprint = compileExecutionBlueprint(manualIntent, plan, memory, skills, { projectId: "p1", currentRevision: 7 });

    expect(blueprint.factApprovalMode).toBe("manual");
  });

  it("marks high-risk execution for manual review when required memory is missing", async () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12, povCharacterId: "hero" });
    const memory = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [] } });
    const skills = await resolveSkillBundle(plan, memory, { projectId: "p1", provider: { list: async () => [] } satisfies SkillProvider });
    const blueprint = compileExecutionBlueprint(intent, plan, memory, skills, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });
    expect(blueprint.memoryGate).toMatchObject({
      status: "manual-review",
      manualReviewFacets: expect.arrayContaining(["fact", "chapter-memory"]),
    });
  });

  it("selects pinned narratives and required facets before ranked fill and records exclusions", async () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });
    const claim = (id: string, facet: string, content: string, score: number) => ({ id, projectId: "p1", kind: "canonical" as const, title: id, content, subjectRefs: [], knowledgeScope: "author" as const, authority: "approved" as const, confidence: 1, sourceRevisionIds: [`r-${id}`], contentHash: id, supersedes: [], score, matchedFacet: facet, reason: "test" });
    const provider: MemoryProvider = { search: async () => [
      claim("high-score", "style", "x".repeat(60), 1),
      claim("fact", "fact", "fact", 0.5),
      claim("future", "fact", "future", 1),
    ].map((item) => item.id === "future" ? { ...item, narrativeRange: { start: 20 } } : item) };
    const pinned = claim("promise", "foreshadowing", "promise", 1);
    const memory = await buildMemoryBundle(plan, { projectId: "p1", provider, tokenBudget: 20, pinnedClaims: [pinned] }, 1);
    const manifest = buildContextManifest(plan, memory, { retrievalRunId: "r" }, 2);

    expect(memory.claims.map((item) => item.id)).toEqual(["promise", "fact"]);
    expect(memory.sourceRevisionIds).toEqual(["r-promise", "r-fact"]);
    expect(manifest.includedClaimIds).toEqual(["promise", "fact"]);
    expect(manifest.excludedClaimIds).toEqual(expect.arrayContaining(["future", "high-score"]));
    expect(manifest.selectionReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimId: "promise", status: "included", reason: "pinned-narrative" }),
      expect.objectContaining({ claimId: "fact", status: "included", reason: "required-facet" }),
      expect.objectContaining({ claimId: "future", status: "excluded", reason: "future-cutoff" }),
      expect.objectContaining({ claimId: "high-score", status: "excluded", reason: "budget" }),
    ]));
  });

  it("fingerprints the selected claim and pinned narrative content without depending on creation time", async () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 }, 1);
    const makeClaim = (content: string) => ({ id: "fact", projectId: "p1", kind: "canonical" as const, title: "事实", content, subjectRefs: [], knowledgeScope: "author" as const, authority: "approved" as const, confidence: 1, sourceRevisionIds: ["r1"], contentHash: content, supersedes: [], score: 1, matchedFacet: "fact", reason: "test" });
    const makePinned = (content: string) => ({ ...makeClaim(content), id: "promise", title: "承诺", matchedFacet: "foreshadowing", sourceRevisionIds: ["r2"] });
    const first = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [makeClaim("原事实")] }, pinnedClaims: [makePinned("原承诺")] }, 1);
    const same = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [makeClaim("原事实")] }, pinnedClaims: [makePinned("原承诺")] }, 2);
    const changedClaim = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [makeClaim("变更事实")] }, pinnedClaims: [makePinned("原承诺")] }, 1);
    const changedPinned = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [makeClaim("原事实")] }, pinnedClaims: [makePinned("变更承诺")] }, 1);

    expect(same.fingerprint).toBe(first.fingerprint);
    expect(changedClaim.fingerprint).not.toBe(first.fingerprint);
    expect(changedPinned.fingerprint).not.toBe(first.fingerprint);
  });
});
