import { describe, expect, it } from "vitest";
import { FusionMemoryProvider } from "../fusion-memory";
import type { MemoryHit, MemoryProvider, RetrievalFacet } from "../protocol";

function hit(matchedFacet: string, score: number): MemoryHit {
  return {
    id: "shared-claim",
    projectId: "project-1",
    kind: "canonical",
    title: "世界观与主线规划",
    content: "世界观设定、人物档案和主线剧情",
    subjectRefs: [],
    knowledgeScope: "author",
    authority: "derived",
    confidence: 0.8,
    sourceRevisionIds: [],
    contentHash: "hash",
    supersedes: [],
    score,
    matchedFacet,
    matchedFacets: [matchedFacet],
    reason: "test",
  };
}

describe("FusionMemoryProvider", () => {
  it("preserves every facet satisfied by the same claim across tracks", async () => {
    const semantic: MemoryProvider = { search: async () => [hit("fact", 0.7)] };
    const lexical = {
      search: async (_input: { projectId: string; facets: RetrievalFacet[] }) => [
        { ...hit("thread", 0.9), matchedFacets: ["fact", "thread", "foreshadowing"] },
      ],
    };
    const provider = new FusionMemoryProvider({ semantic, lexical });

    const results = await provider.search({
      projectId: "project-1",
      facets: [
        { kind: "fact", query: "世界观", required: true },
        { kind: "thread", query: "主线", required: false },
        { kind: "foreshadowing", query: "承诺", required: false },
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0].matchedFacets).toEqual(["fact", "thread", "foreshadowing"]);
  });
});
