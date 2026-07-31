import { describe, expect, it, vi } from "vitest";
import type { ExecutionBlueprint, MemoryBundle, SkillBundle, SkillProvider } from "../protocol";
import type { ModelGateway } from "../model-gateway";
import type { ContentObjectStore } from "../object-store";
import type { CommitService } from "../commit-service";
import { NovelPostgresRepository } from "../postgres-repository";
import { createNovelWorkflowActivities } from "../temporal/activities";

describe("chapter review stage bundles", () => {
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
  });
});
