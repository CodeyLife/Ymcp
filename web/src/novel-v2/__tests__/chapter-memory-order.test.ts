import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";
import type { ChapterMemory } from "../protocol";

const EXPLICIT_TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_DB_URL = EXPLICIT_TEST_DB_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("chapter memory recency", () => {
  const projectId = `test-memory-order-${randomUUID().slice(0, 8)}`;
  let repository: NovelPostgresRepository;
  let available = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Memory order test");
      for (let order = 1; order <= 7; order += 1) {
        const documentId = `doc-${String.fromCharCode(123 - order)}-${order}`;
        const revisionId = `revision-${order}-1`;
        const contentHash = `content-${projectId}-${order}`;
        await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,$3,$4,'final')", [documentId, projectId, `chapter ${order}`, order]);
        await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,1)", [contentHash, `test/${contentHash}`]);
        await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)", [revisionId, projectId, documentId, contentHash]);
        await repository.createChapterMemory(memory({ id: `memory-${order}-1`, projectId, documentId, revisionId, order, summary: `chapter-${order}-old`, createdAt: order }));
        if (order === 7) {
          const latestRevisionId = `revision-${order}-2`;
          const latestContentHash = `content-${projectId}-${order}-2`;
          await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,1)", [latestContentHash, `test/${latestContentHash}`]);
          await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,2,1,$4)", [latestRevisionId, projectId, documentId, latestContentHash]);
          await repository.createChapterMemory(memory({ id: `memory-${order}-2`, projectId, documentId, revisionId: latestRevisionId, order, summary: `chapter-${order}-latest`, createdAt: 100 }));
        }
      }
      available = true;
    } catch (error) {
      if (EXPLICIT_TEST_DB_URL) throw error;
      console.warn(`[chapter-memory-order.test] Postgres unavailable: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!repository) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("returns the latest revision for the most recent narrative chapters", async () => {
    if (!available) return;
    const memories = await repository.getChapterMemories({ projectId, narrativeCutoff: 7, limit: 5 });
    expect(memories.map((item) => item.narrativeRange.start)).toEqual([3, 4, 5, 6, 7]);
    expect(memories.at(-1)).toMatchObject({ revisionId: "revision-7-2", summary: "chapter-7-latest" });
  });

  it("maintains a bounded hierarchical rollup for the chapter window", async () => {
    if (!available) return;
    const rollup = await repository.refreshChapterMemoryRollup(projectId, 7);
    expect(rollup).toMatchObject({
      id: `chapter-memory:rollup:${projectId}:1-20`,
      kind: "hierarchical",
      narrativeRange: { start: 1, end: 7 },
      predicate: "chapter-memory-rollup",
    });
    expect(rollup.content).toContain("第7章：chapter-7-latest");
    expect(rollup.sourceRevisionIds).toContain("revision-7-2");
  });

  it("blocks the third consecutive critical miss and resets only after a completed rebuild", async () => {
    if (!available) return;
    await expect(repository.recordMemoryGateCheck({ projectId, workflowId: "wf-1", criticalMissingFacets: ["fact"] })).resolves.toMatchObject({ consecutiveCriticalMisses: 1, blocked: false });
    await expect(repository.recordMemoryGateCheck({ projectId, workflowId: "wf-2", criticalMissingFacets: ["chapter-memory"] })).resolves.toMatchObject({ consecutiveCriticalMisses: 2, blocked: false });
    await expect(repository.recordMemoryGateCheck({ projectId, workflowId: "wf-3", criticalMissingFacets: ["fact", "chapter-memory"] })).resolves.toMatchObject({ consecutiveCriticalMisses: 3, blocked: true });
    await repository.completeMemoryRebuild(projectId, 8);
    await expect(repository.recordMemoryGateCheck({ projectId, workflowId: "wf-4", criticalMissingFacets: ["fact"] })).resolves.toMatchObject({ consecutiveCriticalMisses: 1, blocked: false });
  });
});

function memory(input: { id: string; projectId: string; documentId: string; revisionId: string; order: number; summary: string; createdAt: number }): ChapterMemory {
  return {
    id: input.id,
    projectId: input.projectId,
    documentId: input.documentId,
    revisionId: input.revisionId,
    narrativeRange: { start: input.order, end: input.order },
    summary: input.summary,
    keyEvents: [],
    characterStates: [],
    unresolvedThreads: [],
    fingerprint: input.id,
    createdAt: input.createdAt,
  };
}
