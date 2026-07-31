import { describe, expect, it } from "vitest";
import { CommitService } from "../commit-service";
import type { Artifact, CommitResult, Review } from "../protocol";
import type { ContentObjectStore } from "../object-store";
import type { NovelPostgresRepository } from "../postgres-repository";
import { inspectManuscript } from "../application/manuscript-structure";

const artifact: Artifact = { id: "artifact-1", projectId: "p1", taskId: "task-1", attemptId: "attempt-1", kind: "draft", contentHash: "old", objectKey: "old", baseRevision: 0, createdAt: 1, fingerprint: "fp-1" };
function review(role: string, identity: Review["identity"]): Review {
  return { id: `review-${role}`, projectId: "p1", artifactId: artifact.id, reviewerId: `${identity}-${role}`, role, identity, verdict: "passed", issues: [], createdAt: 2, artifactFingerprint: artifact.fingerprint };
}
const reviews = [
  review("plot-reviewer", "internal"),
  review("continuity-reviewer", "internal"),
  review("style-reviewer", "independent"),
  review("character-reviewer", "independent"),
  review("reader-reviewer", "independent"),
];
const structuralReport = inspectManuscript({ text: "正文" });

function createService() {
  const commits: Array<Record<string, unknown>> = [];
  const payoffWrites: Array<Record<string, unknown>> = [];
  const narrativeWrites: Array<Record<string, unknown>> = [];
  const result: CommitResult = { revisionId: "revision-1", revision: 1, contentHash: "hash-1", outboxEventId: 7 };
  const repository = {
    commitRevision: async (input: Record<string, unknown>) => { commits.push(input); return result; },
    recordPayoffCurve: async (input: Record<string, unknown>) => { payoffWrites.push(input); return 1; },
    recordNarrativeElements: async (input: Record<string, unknown>) => { narrativeWrites.push(input); return { foreshadowings: 1, promises: 0, payoffs: 0 }; },
  } as unknown as NovelPostgresRepository;
  const objects = { putText: async () => ({ hash: "hash-1", key: "objects/hash-1", bytes: 12 }), getText: async () => "正文" } as unknown as ContentObjectStore;
  return { service: new CommitService(repository, objects), commits, payoffWrites, narrativeWrites, result };
}

describe("V2 CommitService", () => {
  it("rejects commits without all five current reviewer roles", async () => {
    const { service } = createService();
    await expect(service.commit({ projectId: "p1", documentId: "doc-1", artifact, reviews: [reviews[0], reviews[2]], structuralReport, baseRevision: 0, idempotencyKey: "k1", text: "正文" })).rejects.toThrow(/完整五角色/);
    await expect(service.commit({ projectId: "p1", documentId: "doc-1", artifact, reviews: reviews.map((item, index) => index === 4 ? { ...item, artifactFingerprint: "stale" } : item), structuralReport, baseRevision: 0, idempotencyKey: "k1", text: "正文" })).rejects.toThrow(/reader-reviewer/);
  });

  it("rejects a structurally blocked manuscript even when all reviewers pass", async () => {
    const { service } = createService();
    const repeated = "这是一段用于验证提交结构门的长正文，任何评分都不能覆盖确定性重复问题。".repeat(5);
    const text = `${repeated}\n\n${repeated}`;
    await expect(service.commit({ projectId: "p1", documentId: "doc-1", artifact, reviews, structuralReport: inspectManuscript({ text }), baseRevision: 0, idempotencyKey: "k-structural", text })).rejects.toThrow(/完整五角色|结构/);
  });

  it("persists through the repository only after all five roles pass", async () => {
    const { service, commits, result } = createService();
    await expect(service.commit({ projectId: "p1", documentId: "doc-1", artifact, reviews, structuralReport, baseRevision: 0, idempotencyKey: "k1", text: "正文" })).resolves.toEqual(result);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ contentHash: "hash-1", objectKey: "objects/hash-1", revisionId: expect.any(String) });
  });

  it("records payoff provenance with the committed manuscript revision id", async () => {
    const { service, payoffWrites } = createService();
    await service.commit({
      projectId: "p1",
      documentId: "doc-1",
      artifact,
      reviews,
      structuralReport,
      baseRevision: 0,
      idempotencyKey: "k-payoff",
      text: "正文",
      narrativeOrder: 3,
      payoffMoments: [{ payoffType: "emotional", intensity: 4, description: "关系得到回应", evidence: "她终于点了头。" }],
    });
    expect(payoffWrites).toEqual([expect.objectContaining({ revisionId: "revision-1", narrativeOrder: 3 })]);
    expect(payoffWrites[0]?.revisionId).not.toBe(artifact.id);
  });

  it("records narrative elements with the same committed revision provenance", async () => {
    const { service, narrativeWrites } = createService();
    await service.commit({
      projectId: "p1",
      documentId: "doc-1",
      artifact,
      reviews,
      structuralReport,
      baseRevision: 0,
      idempotencyKey: "k-narrative",
      text: "正文",
      narrativeOrder: 3,
      narrativeElements: {
        foreshadowings: [{ description: "门后有脚步声", triggerKeywords: ["脚步"], expectedPayoffWindow: "后续故事单元", evidence: "门板后响了一声。" }],
        promises: [],
        payoffs: [],
      },
    });
    expect(narrativeWrites).toEqual([expect.objectContaining({ revisionId: "revision-1", narrativeOrder: 3 })]);
  });
});
