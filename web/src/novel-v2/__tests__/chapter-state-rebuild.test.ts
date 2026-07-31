import { describe, expect, it, vi } from "vitest";
import { ChapterStateRebuildConflictError, ChapterStateRebuildService } from "../application/chapter-state-rebuild";

describe("ChapterStateRebuildService", () => {
  it("extracts from the current formal revision before replacing its derived state", async () => {
    const calls: string[] = [];
    const repository = {
      getFinalDocumentContentRef: vi.fn(async () => ({ title: "第一章", status: "final", narrativeOrder: 7, revision: 3, sourceRevisionId: "revision-3", artifactId: "draft-3", contentHash: "content-3", objectKey: "objects/content-3" })),
      assertChapterStateRebuildHead: vi.fn(async () => undefined),
      getFactExtractionContext: vi.fn(async () => ({ claimsDigest: "- prior", contentHashes: new Set<string>(), claimsIndex: new Map<string, string[]>() })),
      recordFactExtraction: vi.fn(async () => { calls.push("record-facts"); return []; }),
      recordFactApprovalPolicy: vi.fn(async () => { calls.push("approve-facts"); return {}; }),
      applyCommittedChapterStateRebuild: vi.fn(async () => { calls.push("apply-state"); return { removedClaimIds: ["old-claim"], activatedClaims: [], narrativeState: {} }; }),
      refreshChapterMemoryRollup: vi.fn(async () => ({ id: "rollup", projectId: "p1", kind: "hierarchical", title: "汇总", content: "汇总", subjectRefs: [], knowledgeScope: "author", authority: "derived", confidence: 1, sourceRevisionIds: [], contentHash: "rollup", supersedes: [] })),
      recordProjectionFailure: vi.fn(),
    };
    const output = {
      summary: "事实提取完成",
      facts: [{ subject: { kind: "entity", id: "hero" }, predicate: "所在", object: { kind: "string", value: "旧站台" }, polarity: "affirmed", truthStatus: "objective", humanReadable: "主角仍在旧站台", evidence: "主角停在旧站台的雨棚下面没有离开。", confidence: 0.95, novelty: "new", conflict: false }],
      narrativeElements: { foreshadowings: [], promises: [], payoffs: [] },
      payoffMoments: [],
      chapterMemory: { summary: "本章围绕旧站台上的等待展开，主角在雨声与迟迟未到的列车之间确认自己仍需留下，并保留了尚未解决的去向问题。这个状态为后续章节提供了明确的位置、行动边界与情绪连续性，也没有提前推断正文未呈现的结果。", keyEvents: ["主角留在旧站台等待"], characterStates: [{ characterId: "hero", stateSnapshot: "仍在旧站台，尚未决定离开" }], unresolvedThreads: ["列车何时抵达"], emotionalArc: "从焦躁转为克制等待" },
    };
    const service = new ChapterStateRebuildService({
      repository: repository as never,
      objects: { getText: vi.fn(async () => "主角停在旧站台的雨棚下面没有离开。"), putText: vi.fn() } as never,
      model: { generateStructured: vi.fn(async () => ({ value: output, usage: { inputTokens: 1, outputTokens: 1 }, provenance: { routeSnapshotId: "route", purpose: "facts.extract", candidateIndex: 0, executor: "api", model: "test" } })) } as never,
      skillProvider: { list: async () => [] },
    });

    const result = await service.rebuildCommittedChapterState("p1", "d1", "web-author");

    expect(repository.getFactExtractionContext).toHaveBeenCalledWith("p1", 6);
    expect(repository.recordFactExtraction).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", documentId: "d1", lifecycleStatus: "staged", narrativeOrder: 7 }));
    expect(repository.applyCommittedChapterStateRebuild).toHaveBeenCalledWith(expect.objectContaining({ revisionId: "revision-3", actorId: "web-author", chapterMemory: expect.objectContaining({ revisionId: "revision-3" }) }));
    expect(calls.indexOf("record-facts")).toBeLessThan(calls.indexOf("apply-state"));
    expect(result).toMatchObject({ projectId: "p1", documentId: "d1", revisionId: "revision-3", removedClaimIds: ["old-claim"] });
  });

  it("generates chapter memory through the existing fallback before replacing sources", async () => {
    const calls: string[] = [];
    const repository = {
      getFinalDocumentContentRef: vi.fn(async () => ({ title: "第一章", status: "final", narrativeOrder: 1, revision: 1, sourceRevisionId: "revision-1", artifactId: "draft-1", contentHash: "content-1", objectKey: "objects/content-1" })),
      assertChapterStateRebuildHead: vi.fn(async () => undefined),
      getFactExtractionContext: vi.fn(async () => ({ claimsDigest: "", contentHashes: new Set<string>(), claimsIndex: new Map<string, string[]>() })),
      getChapterMemories: vi.fn(async () => []),
      recordFactExtraction: vi.fn(async () => { calls.push("record-facts"); return []; }),
      recordFactApprovalPolicy: vi.fn(async () => ({})),
      applyCommittedChapterStateRebuild: vi.fn(async () => { calls.push("apply-state"); return { removedClaimIds: [], activatedClaims: [], narrativeState: {} }; }),
      refreshChapterMemoryRollup: vi.fn(async () => ({ id: "rollup", projectId: "p1", kind: "hierarchical", title: "汇总", content: "汇总", subjectRefs: [], knowledgeScope: "author", authority: "derived", confidence: 1, sourceRevisionIds: [], contentHash: "rollup", supersedes: [] })),
      recordProjectionFailure: vi.fn(),
    };
    const factsWithoutMemory = { summary: "完成", facts: [], narrativeElements: { foreshadowings: [], promises: [], payoffs: [] }, payoffMoments: [] };
    const fallbackMemory = { summary: "本章建立了主角在雨中等待的具体处境。他观察站台、确认列车仍未抵达，并在离开与继续停留之间选择等待。正文没有解决最终去向，只让人物从焦躁转为克制，同时保留列车何时抵达以及他之后前往何处两个连续问题，为下一章提供了可验证的位置、选择和情绪状态。", keyEvents: ["主角在雨中等待"], characterStates: [{ characterId: "hero", stateSnapshot: "仍在等待" }], unresolvedThreads: ["去向未定"], emotionalArc: "由焦躁转为克制" };
    const generateStructured = vi.fn()
      .mockResolvedValueOnce({ value: factsWithoutMemory, usage: { inputTokens: 1, outputTokens: 1 }, provenance: { routeSnapshotId: "route", purpose: "facts.extract", candidateIndex: 0, executor: "api", model: "test" } })
      .mockImplementationOnce(async () => { calls.push("fallback-generated"); return { value: fallbackMemory, usage: { inputTokens: 1, outputTokens: 1 }, provenance: { routeSnapshotId: "route", purpose: "facts.extract", candidateIndex: 0, executor: "api", model: "test" } }; });
    const service = new ChapterStateRebuildService({
      repository: repository as never,
      objects: { getText: vi.fn(async () => "主角在雨中等待。"), putText: vi.fn() } as never,
      model: { generateStructured } as never,
      skillProvider: { list: async () => [] },
    });

    await service.rebuildCommittedChapterState("p1", "d1", "web-author");

    expect(generateStructured).toHaveBeenCalledTimes(2);
    expect(calls.indexOf("fallback-generated")).toBeLessThan(calls.indexOf("record-facts"));
    expect(calls).toEqual(expect.arrayContaining(["apply-state"]));
  });

  it("rejects a historical final chapter before reading objects or invoking the model", async () => {
    const conflict = new ChapterStateRebuildConflictError({ targetNarrativeOrder: 1, laterFinalDocumentId: "d2", laterNarrativeOrder: 2 });
    const repository = {
      getFinalDocumentContentRef: vi.fn(async () => ({ title: "第一章", status: "final", narrativeOrder: 1, revision: 1, sourceRevisionId: "revision-1", artifactId: "draft-1", contentHash: "content-1", objectKey: "objects/content-1" })),
      assertChapterStateRebuildHead: vi.fn(async () => { throw conflict; }),
    };
    const getText = vi.fn();
    const generateStructured = vi.fn();
    const service = new ChapterStateRebuildService({
      repository: repository as never,
      objects: { getText, putText: vi.fn() } as never,
      model: { generateStructured } as never,
      skillProvider: { list: async () => [] },
    });

    await expect(service.rebuildCommittedChapterState("p1", "d1", "web-author")).rejects.toBe(conflict);
    expect(conflict).toMatchObject({
      code: "HISTORICAL_CHAPTER_REBUILD_REQUIRES_CASCADE",
      details: { targetNarrativeOrder: 1, laterFinalDocumentId: "d2", laterNarrativeOrder: 2 },
    });
    expect(getText).not.toHaveBeenCalled();
    expect(generateStructured).not.toHaveBeenCalled();
  });
});
