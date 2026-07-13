import { beforeEach, describe, expect, it } from "vitest";
import "./setup";
import { novelDb } from "../db";
import { cosineSimilarity, setEmbeddingProvider, type EmbeddingProvider } from "../embedding";
import { contentHash, hybridScore, upsertEmbedding, vectorSearch } from "../retrieval";

let embedCallCount = 0;

function createMockProvider(vectors: Map<string, number[]>): EmbeddingProvider {
  return {
    name: "mock-embedding",
    dimension: 4,
    embed(text: string): Promise<number[]> {
      embedCallCount += 1;
      const vec = vectors.get(text);
      if (!vec) throw new Error(`mock provider: no vector for "${text}"`);
      return Promise.resolve(vec);
    },
    embedBatch(texts: string[]): Promise<number[][]> {
      embedCallCount += texts.length;
      return Promise.all(texts.map((t) => {
        const vec = vectors.get(t);
        if (!vec) throw new Error(`mock provider: no vector for "${t}"`);
        return vec;
      }));
    },
  };
}

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
  embedCallCount = 0;
});

describe("contentHash", () => {
  it("returns consistent hash for same content", () => {
    expect(contentHash("hello world")).toBe(contentHash("hello world"));
  });

  it("returns different hash for different content", () => {
    expect(contentHash("hello world")).not.toBe(contentHash("hello earth"));
  });

  it("returns 8-char hex string", () => {
    const hash = contentHash("test");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for different-length vectors", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe("hybridScore", () => {
  it("uses default weights 0.4/0.6", () => {
    expect(hybridScore(10, 10)).toBeCloseTo(10, 5);
  });

  it("applies keyword weight 0.4", () => {
    expect(hybridScore(10, 0)).toBeCloseTo(4, 5);
  });

  it("applies vector weight 0.6", () => {
    expect(hybridScore(0, 10)).toBeCloseTo(6, 5);
  });

  it("accepts custom weights", () => {
    expect(hybridScore(10, 10, { keyword: 0.5, vector: 0.5 })).toBeCloseTo(10, 5);
  });
});

describe("upsertEmbedding", () => {
  it("generates embedding on first call", async () => {
    const provider = createMockProvider(new Map([["test content", [1, 0, 0, 0]]]));
    setEmbeddingProvider(provider);
    await upsertEmbedding({ projectId: "p1", targetTable: "entities", targetId: "e1", content: "test content" });
    expect(embedCallCount).toBe(1);
    const stored = await novelDb.embeddings.where("projectId").equals("p1").toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0].targetId).toBe("e1");
    expect(stored[0].vector).toEqual([1, 0, 0, 0]);
  });

  it("skips embedding generation when content unchanged", async () => {
    const provider = createMockProvider(new Map([["test content", [1, 0, 0, 0]]]));
    setEmbeddingProvider(provider);
    await upsertEmbedding({ projectId: "p1", targetTable: "entities", targetId: "e1", content: "test content" });
    await upsertEmbedding({ projectId: "p1", targetTable: "entities", targetId: "e1", content: "test content" });
    expect(embedCallCount).toBe(1);
  });

  it("regenerates embedding when content changes", async () => {
    const provider = createMockProvider(new Map([
      ["old content", [1, 0, 0, 0]],
      ["new content", [0, 1, 0, 0]],
    ]));
    setEmbeddingProvider(provider);
    await upsertEmbedding({ projectId: "p1", targetTable: "entities", targetId: "e1", content: "old content" });
    await upsertEmbedding({ projectId: "p1", targetTable: "entities", targetId: "e1", content: "new content" });
    expect(embedCallCount).toBe(2);
    const stored = await novelDb.embeddings.where("targetId").equals("e1").toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0].vector).toEqual([0, 1, 0, 0]);
  });
});

describe("vectorSearch", () => {
  it("returns results sorted by similarity descending", async () => {
    const provider = createMockProvider(new Map([
      ["query", [1, 0, 0, 0]],
      ["doc-a", [1, 0, 0, 0]],
      ["doc-b", [0, 1, 0, 0]],
      ["doc-c", [0.7, 0.7, 0, 0]],
    ]));
    setEmbeddingProvider(provider);
    await upsertEmbedding({ projectId: "p1", targetTable: "documents", targetId: "a", content: "doc-a" });
    await upsertEmbedding({ projectId: "p1", targetTable: "documents", targetId: "b", content: "doc-b" });
    await upsertEmbedding({ projectId: "p1", targetTable: "documents", targetId: "c", content: "doc-c" });

    const results = await vectorSearch({ projectId: "p1", query: "query" });
    expect(results).toHaveLength(3);
    expect(results[0].targetId).toBe("a");
    expect(results[0].score).toBeCloseTo(1, 5);
    expect(results[1].targetId).toBe("c");
    expect(results[2].targetId).toBe("b");
    expect(results[1].score).toBeGreaterThan(results[2].score);
  });

  it("filters by targetTables", async () => {
    const provider = createMockProvider(new Map([
      ["query", [1, 0, 0, 0]],
      ["entity-text", [1, 0, 0, 0]],
      ["doc-text", [1, 0, 0, 0]],
    ]));
    setEmbeddingProvider(provider);
    await upsertEmbedding({ projectId: "p1", targetTable: "entities", targetId: "e1", content: "entity-text" });
    await upsertEmbedding({ projectId: "p1", targetTable: "documents", targetId: "d1", content: "doc-text" });

    const results = await vectorSearch({ projectId: "p1", query: "query", targetTables: ["entities"] });
    expect(results).toHaveLength(1);
    expect(results[0].targetTable).toBe("entities");
  });

  it("respects topK limit", async () => {
    const provider = createMockProvider(new Map([
      ["query", [1, 0, 0, 0]],
      ["d1", [1, 0, 0, 0]],
      ["d2", [1, 0, 0, 0]],
      ["d3", [1, 0, 0, 0]],
    ]));
    setEmbeddingProvider(provider);
    await upsertEmbedding({ projectId: "p1", targetTable: "documents", targetId: "a", content: "d1" });
    await upsertEmbedding({ projectId: "p1", targetTable: "documents", targetId: "b", content: "d2" });
    await upsertEmbedding({ projectId: "p1", targetTable: "documents", targetId: "c", content: "d3" });

    const results = await vectorSearch({ projectId: "p1", query: "query", topK: 2 });
    expect(results).toHaveLength(2);
  });

  it("returns empty for project with no embeddings", async () => {
    const provider = createMockProvider(new Map([["query", [1, 0, 0, 0]]]));
    setEmbeddingProvider(provider);
    const results = await vectorSearch({ projectId: "empty-project", query: "query" });
    expect(results).toHaveLength(0);
  });
});
