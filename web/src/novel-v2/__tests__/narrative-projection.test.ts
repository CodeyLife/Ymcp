import { describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";
import type { Artifact } from "../protocol";

const artifact: Artifact = { id: "a1", projectId: "p1", taskId: "t1", attemptId: "x1", kind: "fact-extraction", contentHash: "h", baseRevision: 1, createdAt: 1, fingerprint: "fp" };

describe("narrative projection revision ownership", () => {
  it("fails explicitly before projection when revision is absent or belongs to another document", async () => {
    const queries: string[] = [];
    const repository = Object.create(NovelPostgresRepository.prototype) as NovelPostgresRepository;
    Object.defineProperty(repository, "pool", { value: { query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; } } });
    await expect(repository.recordNarrativeElements({
      projectId: "p1", documentId: "d1", revisionId: "r-other", artifact, narrativeElements: { foreshadowings: [], promises: [], payoffs: [] },
    })).rejects.toThrow(/已提交且归属匹配/);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("project_id=$2 AND document_id=$3");
  });
});
