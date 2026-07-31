import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";
import type { Artifact, MemoryClaim } from "../protocol";

const EXPLICIT_TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_DB_URL = EXPLICIT_TEST_DB_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("chapter rewrite fact boundary", () => {
  const suffix = randomUUID().slice(0, 8);
  const projectId = `test-rewrite-facts-${suffix}`;
  let repository: NovelPostgresRepository;
  let available = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Rewrite fact boundary test");
      for (const order of [10, 11, 12, 13]) {
        await repository.pool.query(
          "INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,$3,$4,'final')",
          [`doc-${suffix}-${order}`, projectId, `chapter ${order}`, order],
        );
      }
      await writeClaim(11, "prior", "active");
      await writeClaim(12, "current", "active");
      await writeClaim(13, "future", "active");
      await writeClaim(10, "staged", "staged");
      available = true;
    } catch (error) {
      if (EXPLICIT_TEST_DB_URL) throw error;
      console.warn(`[fact-rewrite-memory-boundary.test] Postgres unavailable: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!repository) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("persists chapter order and excludes current, future, and staged facts when rewriting", async () => {
    if (!available) return;
    const hits = await repository.searchMemory({
      projectId,
      narrativeCutoff: 11,
      facets: [{ kind: "fact", query: "边界测试", required: true }],
    });
    expect(hits.map((hit) => hit.id)).toEqual([`claim-${suffix}-prior`]);

    const context = await repository.getFactExtractionContext(projectId, 11);
    expect(context.claimsDigest).toContain("prior");
    expect(context.claimsDigest).not.toContain("current");
    expect(context.claimsDigest).not.toContain("future");
    expect(context.claimsDigest).not.toContain("staged");
  });

  async function writeClaim(order: number, label: string, lifecycleStatus: "staged" | "active") {
    const artifact: Artifact = {
      id: `artifact-${suffix}-${label}`,
      projectId,
      taskId: `task-${label}`,
      attemptId: `attempt-${label}`,
      kind: "fact-extraction",
      contentHash: `artifact-hash-${suffix}-${label}`,
      baseRevision: 0,
      fingerprint: `artifact-fingerprint-${suffix}-${label}`,
      createdAt: Date.now(),
    };
    const claim: MemoryClaim = {
      id: `claim-${suffix}-${label}`,
      projectId,
      kind: "episodic",
      title: `边界测试 ${label}`,
      content: `边界测试 ${label}`,
      subjectRefs: ["hero"],
      knowledgeScope: "author",
      authority: "derived",
      confidence: 1,
      sourceRevisionIds: [],
      contentHash: `claim-hash-${suffix}-${label}`,
      supersedes: [],
      predicate: "边界测试",
    };
    await repository.recordFactExtraction({
      projectId,
      artifact,
      claims: [claim],
      lifecycleStatus,
      documentId: `doc-${suffix}-${order}`,
      narrativeOrder: order,
    });
  }
});
