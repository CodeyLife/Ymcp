import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExecutionBlueprint, MemoryBundle, SkillBundle, SkillProvider } from "../protocol";
import type { ModelGateway } from "../model-gateway";
import type { ContentObjectStore } from "../object-store";
import type { CommitService } from "../commit-service";
import { NovelPostgresRepository } from "../postgres-repository";
import { createNovelWorkflowActivities } from "../temporal/activities";

describe("chapter review stage bundles", () => {
  it("loads review planning context from the historical blueprint snapshot instead of current arc status", () => {
    const source = readFileSync(fileURLToPath(new URL("../temporal/workflows.ts", import.meta.url)), "utf8");
    const start = source.indexOf("export async function chapterReviewWorkflow");
    const end = source.indexOf("// 局部辅助函数", start);
    const body = source.slice(start, end);

    expect(body).toContain("loadHistoricalBlueprint");
    expect(body).toContain("loadChapterPlanningContextSnapshot({ blueprintId: blueprintArtifact.blueprint.id })");
    expect(body).not.toContain("loadChapterPlanningContext({ projectId: params.projectId, documentId: params.documentId })");
  });

  it("persists the resolved review skill bundle before reference-based reviewers load it", async () => {
    const putSkillBundle = vi.fn(async (bundle: SkillBundle) => bundle);
    const skillProvider: SkillProvider = {
      list: async () => [{
        skillId: "chapter-review-craft",
        version: "1",
        capabilities: ["review"],
        applicableTasks: ["review"],
        requiredMemoryKinds: [],
        conflicts: [],
        qualityGates: [],
        promptSections: { review: "根据正文证据审查章节功能。" },
        enabled: true,
      }],
    };
    const activities = createNovelWorkflowActivities({
      repository: { putSkillBundle } as unknown as NovelPostgresRepository,
      memoryProvider: { search: async () => [] },
      skillProvider,
      modelGateway: {} as ModelGateway,
      objectStore: {} as ContentObjectStore,
      commitService: {} as CommitService,
      enableChapterMemory: false,
    });

    const bundle = await activities.resolveReviewSkills({ projectId: "p1", preflightId: "preflight-1" });

    expect(bundle.skills.map((skill) => skill.skillId)).toEqual(["chapter-review-craft"]);
    expect(putSkillBundle).toHaveBeenCalledOnce();
    expect(putSkillBundle).toHaveBeenCalledWith(expect.objectContaining({ id: bundle.id, fingerprint: bundle.fingerprint }));
  });

  it("uses only pre-chapter memory and rejects aggregates that cross the review cutoff", async () => {
    const claim = (id: string, range?: { start?: number; end?: number }, predicate?: string) => ({
      id,
      projectId: "p1",
      kind: "hierarchical" as const,
      title: id,
      content: id,
      subjectRefs: [],
      narrativeRange: range,
      knowledgeScope: "author" as const,
      authority: "derived" as const,
      confidence: 1,
      sourceRevisionIds: [`revision-${id}`],
      contentHash: id,
      supersedes: [],
      predicate,
      score: 1,
      matchedFacet: "chapter-memory",
      reason: "test",
    });
    const latestBundle = {
      id: "memory-latest",
      projectId: "p1",
      preflightId: "preflight-1",
      claims: [
        claim("chapter-4", { start: 4, end: 4 }),
        claim("old-chapter-5", { start: 5, end: 5 }),
        claim("rollup-1-10", { start: 1, end: 10 }, "chapter-memory-rollup"),
        claim("durable-world-rule", { start: 1 }),
      ],
      conflicts: [],
      missingFacets: [],
      tokenBudget: 1_000,
      sourceRevisionIds: [],
      fingerprint: "memory-latest",
      createdAt: 1,
    } satisfies MemoryBundle;
    const repository = {
      getDocumentNarrativeOrder: vi.fn(async () => 5),
      getLatestMemoryBundle: vi.fn(async () => latestBundle),
      putMemoryBundle: vi.fn(async (bundle: MemoryBundle) => bundle),
    };
    const activities = createNovelWorkflowActivities({
      repository: repository as unknown as NovelPostgresRepository,
      memoryProvider: { search: async () => [] },
      skillProvider: { list: async () => [] },
      modelGateway: {} as ModelGateway,
      objectStore: {} as ContentObjectStore,
      commitService: {} as CommitService,
      enableChapterMemory: false,
    });

    const result = await activities.retrieveMemoryForReview({
      projectId: "p1",
      documentId: "chapter-5",
      blueprint: { preflightId: "preflight-1" } as ExecutionBlueprint,
    });

    expect(result.claims.map((item) => item.id)).toEqual(["chapter-4", "durable-world-rule"]);
    expect(result.sourceRevisionIds).toEqual(["revision-chapter-4", "revision-durable-world-rule"]);
    expect(result.id).not.toBe(latestBundle.id);
    expect(result.narrativeCutoff).toBe(4);
    expect(repository.putMemoryBundle).toHaveBeenCalledOnce();
    expect(repository.putMemoryBundle).toHaveBeenCalledWith(result);
    expect(result.selectionReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimId: "old-chapter-5", status: "excluded", reason: "future-cutoff" }),
      expect.objectContaining({ claimId: "rollup-1-10", status: "excluded", reason: "future-cutoff" }),
    ]));
  });

  it("persists an empty immutable review bundle so reference-based activities can reload it", async () => {
    const repository = {
      getDocumentNarrativeOrder: vi.fn(async () => 1),
      getLatestMemoryBundle: vi.fn(async () => undefined),
      putMemoryBundle: vi.fn(async (bundle: MemoryBundle) => bundle),
    };
    const activities = createNovelWorkflowActivities({
      repository: repository as unknown as NovelPostgresRepository,
      memoryProvider: { search: async () => [] },
      skillProvider: { list: async () => [] },
      modelGateway: {} as ModelGateway,
      objectStore: {} as ContentObjectStore,
      commitService: {} as CommitService,
      enableChapterMemory: false,
    });

    const result = await activities.retrieveMemoryForReview({
      projectId: "p1",
      documentId: "chapter-1",
      blueprint: { preflightId: "preflight-1" } as ExecutionBlueprint,
    });

    expect(result).toMatchObject({ claims: [], narrativeCutoff: 0 });
    expect(repository.putMemoryBundle).toHaveBeenCalledWith(result);
  });

  it("rejects a reference-based reviewer when a persisted snapshot still contains future claims", async () => {
    const futureMemory: MemoryBundle = {
      id: "review-memory-bad",
      projectId: "p1",
      preflightId: "preflight-1",
      claims: [{
        id: "chapter-5",
        projectId: "p1",
        kind: "episodic",
        title: "未来章节",
        content: "未来内容",
        subjectRefs: [],
        narrativeRange: { start: 5, end: 5 },
        knowledgeScope: "author",
        authority: "derived",
        confidence: 1,
        sourceRevisionIds: [],
        contentHash: "chapter-5",
        supersedes: [],
        score: 1,
        matchedFacet: "chapter-memory",
        reason: "test",
      }],
      conflicts: [],
      missingFacets: [],
      tokenBudget: 100,
      sourceRevisionIds: [],
      narrativeCutoff: 4,
      fingerprint: "bad",
      createdAt: 1,
    };
    const repository = {
      getArtifact: vi.fn(async () => ({ id: "artifact", projectId: "p1", taskId: "task", attemptId: "attempt", kind: "draft", contentHash: "hash", objectKey: "object", baseRevision: 1, createdAt: 1, fingerprint: "fp" })),
      getRecord: vi.fn(async (table: string) => table === "memory_bundles" ? futureMemory : table === "execution_blueprints" ? { id: "blueprint", preflightId: "preflight-1" } : { id: "skills", skills: [] }),
      getChapterPlanningContextSnapshot: vi.fn(async () => undefined),
    };
    const activities = createNovelWorkflowActivities({
      repository: repository as unknown as NovelPostgresRepository,
      memoryProvider: { search: async () => [] },
      skillProvider: { list: async () => [] },
      modelGateway: {} as ModelGateway,
      objectStore: { getText: async () => "正文" } as unknown as ContentObjectStore,
      commitService: {} as CommitService,
      enableChapterMemory: false,
    });

    await expect(activities.reviewByRefs({
      workflowId: "workflow",
      artifactId: "artifact",
      blueprintId: "blueprint",
      memoryBundleId: futureMemory.id,
      skillBundleId: "skills",
      role: "continuity-reviewer",
      identity: "internal",
      routingSnapshot: {} as never,
    })).rejects.toThrow(/review-memory-cutoff-violation/);
  });
});
