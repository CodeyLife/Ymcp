import { describe, expect, it, vi } from "vitest";
import type { QdrantClient } from "@qdrant/js-client-rest";
import type { ModelGateway } from "../model-gateway";
import type { MemoryClaim } from "../protocol";
import { QdrantMemoryProvider, qdrantPointId } from "../qdrant-memory";

describe("Qdrant collection identity", () => {
  it("maps arbitrary business ids to stable project-scoped UUID point ids", () => {
    const first = qdrantPointId("project-a", "foundation:character:主角");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(qdrantPointId("project-a", "foundation:character:主角")).toBe(first);
    expect(qdrantPointId("project-b", "foundation:character:主角")).not.toBe(first);
  });

  it("keeps the original claim id in payload while upserting with a UUID", async () => {
    const upsert = vi.fn();
    const client = {
      getCollection: vi.fn(async () => ({ config: { params: { vectors: { size: 3 } } } })),
      upsert,
    } as unknown as QdrantClient;
    const gateway = { embed: vi.fn(async () => ({ vectors: [[0.1, 0.2, 0.3]] })) } as unknown as ModelGateway;
    const claim: MemoryClaim = {
      id: "foundation:character:配角",
      projectId: "project-a",
      kind: "canonical",
      title: "配角",
      content: "首次登场",
      subjectRefs: ["character:配角"],
      knowledgeScope: "author",
      authority: "approved",
      confidence: 1,
      sourceRevisionIds: [],
      contentHash: "content-hash",
      supersedes: [],
    };

    await new QdrantMemoryProvider(client, gateway, "memory", 3).upsertClaims("project-a", [claim]);

    expect(upsert).toHaveBeenCalledWith("memory", expect.objectContaining({
      points: [expect.objectContaining({
        id: qdrantPointId("project-a", claim.id),
        payload: expect.objectContaining({ claim }),
      })],
    }));
  });

  it("resolves an alias without trying to create a same-name physical collection", async () => {
    const createCollection = vi.fn();
    const client = { getCollection: vi.fn(async () => ({ config: { params: { vectors: { size: 1024 } } } })), createCollection } as unknown as QdrantClient;
    await new QdrantMemoryProvider(client, {} as ModelGateway, "novel-memory-current", 1024).ensureCollection();
    expect(client.getCollection).toHaveBeenCalledWith("novel-memory-current");
    expect(createCollection).not.toHaveBeenCalled();
  });

  it("rejects an alias or collection backed by vectors with another dimension", async () => {
    const client = { getCollection: vi.fn(async () => ({ config: { params: { vectors: { size: 1536 } } } })) } as unknown as QdrantClient;
    await expect(new QdrantMemoryProvider(client, {} as ModelGateway, "novel-memory-current", 1024).ensureCollection()).rejects.toThrow(/1536.*1024/);
  });
});
