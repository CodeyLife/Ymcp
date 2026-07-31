import { describe, expect, it, vi } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";

function makeRepository(query: ReturnType<typeof vi.fn>) {
  const repository = Object.create(NovelPostgresRepository.prototype) as NovelPostgresRepository;
  Object.defineProperty(repository, "pool", { value: { query } });
  return repository;
}

describe("knowledge workbench canonical records", () => {
  it("projects the current plan instead of historical foundation artifacts", async () => {
    const repository = makeRepository(vi.fn());
    Object.defineProperty(repository, "listProjectPlanSections", {
      value: vi.fn(async () => [{
        projectId: "p1",
        taskKey: "worldview",
        sourceArtifactId: "artifact-current",
        status: "approved",
        payload: { title: "世界观设定", summary: "当前已确认的世界规则" },
        editRevision: 2,
        approvedAt: "2026-07-31T00:00:00.000Z",
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }]),
    });
    Object.defineProperty(repository, "listFoundationArtifacts", {
      value: vi.fn(async () => { throw new Error("不应读取历史 artifact 列表"); }),
    });

    const records = await repository.listKnowledgeRecords("p1", "foundation");

    expect(records).toEqual([expect.objectContaining({
      id: "plan:worldview",
      taskKey: "worldview",
      name: "世界观设定",
      summary: "当前已确认的世界规则",
      status: "approved",
      source: "project-plan",
      readOnly: true,
    })]);
  });

  it("reads narrative claims from memory_claims instead of the unused facts table", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("FROM memory_claims");
      expect(sql).not.toContain("FROM facts");
      expect(sql).toContain("fact-extraction");
      expect(sql).toContain("supersedes");
      return {
        rows: [{
          id: "claim-1",
          kind: "episodic",
          title: "沈郁持有符纸",
          content: "沈郁在客栈中取出一张旧符纸。",
          subject_refs: ["沈郁"],
          narrative_start: 3,
          narrative_end: null,
          knowledge_scope: "author",
          authority: "derived",
          confidence: "0.92",
          source_revision_ids: ["revision-3"],
          predicate: "持有",
          source_kind: "fact-extraction",
          created_at: "2026-07-31T00:00:00.000Z",
        }],
      };
    });
    const repository = makeRepository(query);

    const records = await repository.listKnowledgeRecords("p1", "claims" as never);

    expect(records).toEqual([expect.objectContaining({
      id: "claim-1",
      title: "沈郁持有符纸",
      content: "沈郁在客栈中取出一张旧符纸。",
      subjectRefs: ["沈郁"],
      authority: "derived",
      confidence: 0.92,
      source: "fact-extraction",
      readOnly: false,
    })]);
  });

  it("shows the latest project SkillBundle separately from global skill definitions", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("FROM skill_bundles");
      expect(sql).toContain("ORDER BY created_at DESC");
      return {
        rows: [{
          id: "bundle-2",
          payload: {
            missingCapabilities: [],
            skills: [{
              skillId: "reader-audit",
              version: "2.1.0",
              capabilities: ["review"],
              applicableTasks: ["review"],
              qualityGates: ["reader"],
              promptSections: { review: "从严苛读者视角审校。" },
              enabled: true,
            }],
          },
          created_at: "2026-07-31T00:00:00.000Z",
        }],
      };
    });
    const repository = makeRepository(query);

    const records = await repository.listKnowledgeRecords("p1", "project-skills" as never);

    expect(records).toEqual([expect.objectContaining({
      id: "reader-audit",
      skillId: "reader-audit",
      bundleId: "bundle-2",
      source: "skill-bundle",
      readOnly: true,
    })]);
  });

  it("uses the latest memory per chapter for the project memory view", async () => {
    const repository = makeRepository(vi.fn());
    Object.defineProperty(repository, "getChapterMemories", {
      value: vi.fn(async () => [{
        id: "memory-1",
        projectId: "p1",
        documentId: "chapter-3",
        revisionId: "revision-3",
        narrativeRange: { start: 3, end: 3 },
        summary: "沈郁发现符纸上的逻辑断点。",
        keyEvents: ["发现旧符纸"],
        characterStates: [],
        unresolvedThreads: ["符纸来源"],
        fingerprint: "fp-1",
        createdAt: 1,
      }]),
    });

    const records = await repository.listKnowledgeRecords("p1", "chapter-memories" as never);

    expect(records).toEqual([expect.objectContaining({
      id: "memory-1",
      documentId: "chapter-3",
      summary: "沈郁发现符纸上的逻辑断点。",
      source: "chapter-memory",
      readOnly: true,
    })]);
  });
});
