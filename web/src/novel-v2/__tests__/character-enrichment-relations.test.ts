import { describe, expect, it } from "vitest";
import { persistCharacterEnrichment, type CharacterEnrichmentDelta } from "../character-enrichment";
import { buildCharacterEnrichmentPrompt } from "../character-enrichment/prompt";
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
    deps: { repository: { pool, recordFactExtraction: async (input: { claims: unknown[] }) => input.claims } as unknown as NovelPostgresRepository, objects: {} as never },
  };
}

describe("character enrichment relation integrity", () => {
  it("asks extraction to preserve epistemic status instead of promoting interpretation to fact", () => {
    const prompt = buildCharacterEnrichmentPrompt({ artifact, text: "来客说北门已经封了，主角没有回答。" });
    expect(prompt).toContain("观察、听闻、阅读或推断");
    expect(prompt).toContain("写明“怀疑/推测”，不得升级为客观事实");
    expect(prompt).toContain("不把能力原理、价值判断、主题解释、因果寓意或人物评价当作知识事实");
  });

  it("stores knowledge without copying evidence prose into future prompt material", async () => {
    const { deps } = createDeps();
    const knowledgeDelta = delta("主角", "门卫");
    knowledgeDelta.newKnowledge = [{ description: "听闻北门已经封闭", evidence: "来客说北门已经封了，主角没有回答。" }];
    const result = await persistCharacterEnrichment({ projectId: "p1", documentId: "d1", revisionId: "r3", narrativeOrder: 3, artifact }, deps, [knowledgeDelta]);
    expect(result.knowledgeClaims[0]).toMatchObject({
      title: "主角 的信息边界（第3章）",
      content: "听闻北门已经封闭",
      predicate: "character-knows",
    });
    expect(result.knowledgeClaims[0].content).not.toContain("来客说北门");
  });

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
