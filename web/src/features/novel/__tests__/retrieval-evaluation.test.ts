import { describe, expect, it } from "vitest";
import { rankLexicalUnits, retrievalRecallAtK } from "../retrieval-evaluation";
import { longNovelCases, longNovelUnits } from "./fixtures/long-novel-retrieval";

describe("long-form novel retrieval evaluation", () => {
  it("covers at least 30 cross-chapter, alias, temporal, knowledge, and correction queries", () => {
    expect(longNovelCases).toHaveLength(30);
    expect(longNovelUnits).toHaveLength(30);
  });

  it("matches natural Chinese keyword queries inside longer sentences", () => {
    expect(rankLexicalUnits("密钥在哪里", [{
      id: "fact-key",
      title: "旧案线索",
      content: "林默知道密钥，但没有向同伴说明来源。",
      aliases: [],
    }])).toContain("fact-key");
  });

  it("keeps Recall@10 at or above 90% without embeddings", () => {
    expect(retrievalRecallAtK({ cases: longNovelCases, units: longNovelUnits, k: 10 })).toBeGreaterThanOrEqual(0.9);
  });

  it("returns only traceable source identifiers", () => {
    const known = new Set(longNovelUnits.map((item) => item.id));
    for (const testCase of longNovelCases) {
      expect(rankLexicalUnits(testCase.query, longNovelUnits).slice(0, 10).every((id) => known.has(id))).toBe(true);
    }
  });
});
