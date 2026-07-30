import { describe, expect, it } from "vitest";
import { persistCharacterEnrichment, type CharacterEnrichmentDelta } from "../character-enrichment";
import type { NovelPostgresRepository } from "../postgres-repository";
import type { Artifact } from "../protocol";

const artifact: Artifact = { id: "a1", projectId: "p1", taskId: "t1", attemptId: "x1", kind: "revision", contentHash: "h", baseRevision: 1, createdAt: 1, fingerprint: "fp" };

function delta(characterId: string, targetCharacterId: string): CharacterEnrichmentDelta {
  return {
    characterId,
    voiceAnchor: { sentenceLength: "短句", vocabulary: "克制", directness: "含蓄", avoidance: "先观察" },
    motivationDelta: "本章无明显动机变化",
    newKnowledge: [],
    relationDeltas: [{ targetCharacterId, predicate: "首次相遇", delta: "在门厅相遇" }],
  };
}

function createDeps() {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      writes.push({ sql, params });
      return sql.startsWith("SELECT payload") ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 };
    },
  };
  return {
    writes,
    deps: { repository: { pool } as unknown as NovelPostgresRepository, objects: {} as never },
  };
}

describe("character enrichment relation integrity", () => {
  it("creates a stub when a supporting character first appears only as a relation target", async () => {
    const { deps, writes } = createDeps();
    await persistCharacterEnrichment({ projectId: "p1", documentId: "d1", revisionId: "r1", narrativeOrder: 1, artifact }, deps, [delta("主角", "门卫")]);
    const target = writes.find((write) => write.sql.includes("ON CONFLICT(id) DO NOTHING") && write.params[0] === "entity:p1:character:门卫");
    expect(target?.params[3]).toMatchObject({ pendingEnrichment: true, sourceRevisionId: "r1" });
    expect(writes.some((write) => write.sql.includes("INSERT INTO relations") && write.params[4] === "entity:p1:character:门卫")).toBe(true);
  });

  it("is idempotent when the same enrichment is replayed", async () => {
    const { deps, writes } = createDeps();
    const input = { projectId: "p1", documentId: "d1", revisionId: "r1", narrativeOrder: 1, artifact };
    await persistCharacterEnrichment(input, deps, [delta("主角", "门卫")]);
    await persistCharacterEnrichment(input, deps, [delta("主角", "门卫")]);
    const relationWrites = writes.filter((write) => write.sql.includes("INSERT INTO relations"));
    expect(relationWrites).toHaveLength(2);
    expect(relationWrites[0].params[0]).toBe(relationWrites[1].params[0]);
    expect(relationWrites.every((write) => write.sql.includes("ON CONFLICT(id) DO NOTHING"))).toBe(true);
  });

  it("creates both endpoints when both characters are new", async () => {
    const { deps, writes } = createDeps();
    await persistCharacterEnrichment({ projectId: "p1", documentId: "d1", revisionId: "r2", narrativeOrder: 2, artifact }, deps, [delta("旅人", "船夫")]);
    const entityIds = writes.filter((write) => write.sql.includes("INSERT INTO entities")).map((write) => write.params[0]);
    expect(entityIds).toEqual(expect.arrayContaining(["entity:p1:character:旅人", "entity:p1:character:船夫"]));
  });
});
