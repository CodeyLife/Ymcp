import { describe, expect, it } from "vitest";
import { CommitService } from "../commit-service";
import type { Artifact, CommitResult, Review } from "../protocol";
import type { ContentObjectStore } from "../object-store";
import type { NovelPostgresRepository } from "../postgres-repository";

const artifact: Artifact = { id: "artifact-1", projectId: "p1", taskId: "task-1", attemptId: "attempt-1", kind: "draft", contentHash: "old", objectKey: "old", baseRevision: 0, createdAt: 1, fingerprint: "fp-1" };
const internal: Review = { id: "review-1", projectId: "p1", artifactId: artifact.id, reviewerId: "internal", identity: "internal", verdict: "passed", issues: [], createdAt: 2, artifactFingerprint: artifact.fingerprint };
const independent: Review = { id: "review-2", projectId: "p1", artifactId: artifact.id, reviewerId: "independent", identity: "independent", verdict: "passed", issues: [], createdAt: 3, artifactFingerprint: artifact.fingerprint };

function createService() {
  const commits: Array<Record<string, unknown>> = [];
  const result: CommitResult = { revisionId: "revision-1", revision: 1, contentHash: "hash-1", outboxEventId: 7 };
  const repository = { commitRevision: async (input: Record<string, unknown>) => { commits.push(input); return result; } } as unknown as NovelPostgresRepository;
  const objects = { putText: async () => ({ hash: "hash-1", key: "objects/hash-1", bytes: 12 }), getText: async () => "正文" } as unknown as ContentObjectStore;
  return { service: new CommitService(repository, objects), commits, result };
}

describe("V2 CommitService", () => {
  it("rejects commits without both current internal and independent review gates", async () => {
    const { service } = createService();
    await expect(service.commit({ projectId: "p1", documentId: "doc-1", artifact, reviews: [internal], baseRevision: 0, idempotencyKey: "k1", text: "正文" })).rejects.toThrow(/内部门和独立门证据/);
    await expect(service.commit({ projectId: "p1", documentId: "doc-1", artifact, reviews: [{ ...independent, artifactFingerprint: "stale" }, internal], baseRevision: 0, idempotencyKey: "k1", text: "正文" })).rejects.toThrow(/内部门和独立门证据/);
  });

  it("persists through the repository only after dual gates pass", async () => {
    const { service, commits, result } = createService();
    await expect(service.commit({ projectId: "p1", documentId: "doc-1", artifact, reviews: [internal, independent], baseRevision: 0, idempotencyKey: "k1", text: "正文" })).resolves.toEqual(result);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ contentHash: "hash-1", objectKey: "objects/hash-1", revisionId: expect.any(String) });
  });
});
