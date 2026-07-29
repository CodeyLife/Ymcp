import { describe, expect, it, vi } from "vitest";
import { CommitService } from "../commit-service";
import type { Artifact, CommitResult, Review } from "../protocol";

const artifact: Artifact = { id: "artifact-1", projectId: "p1", taskId: "task-1", attemptId: "attempt-1", kind: "revision", contentHash: "old", baseRevision: 1, fingerprint: "fp-1", createdAt: 1 };
const result: CommitResult = { revisionId: "revision-2", revision: 2, contentHash: "new", outboxEventId: 2 };

function humanReview(overrides: Partial<Review> = {}): Review {
  return { id: "human-1", projectId: "p1", artifactId: artifact.id, reviewerId: "author", identity: "human", verdict: "passed", issues: [], artifactFingerprint: artifact.fingerprint, createdAt: 2, ...overrides };
}

describe("CommitService author approval", () => {
  it("rejects author-approved commit without current-artifact human evidence", async () => {
    const repository = { commitRevision: vi.fn() };
    const objects = { putText: vi.fn(), getText: vi.fn() };
    const service = new CommitService(repository as never, objects);

    await expect(service.commitAuthorApproved({ projectId: "p1", documentId: "d1", artifact, reviews: [humanReview({ artifactFingerprint: "stale" })], baseRevision: 1, idempotencyKey: "approve-1", text: "正文" })).rejects.toThrow(/human passed/);
    expect(objects.putText).not.toHaveBeenCalled();
    expect(repository.commitRevision).not.toHaveBeenCalled();
  });

  it("stores text and commits when the author approval matches the current artifact", async () => {
    const repository = { commitRevision: vi.fn(async () => result) };
    const objects = { putText: vi.fn(async () => ({ hash: "new", key: "ne/w", bytes: 6 })), getText: vi.fn() };
    const service = new CommitService(repository as never, objects);

    await expect(service.commitAuthorApproved({ projectId: "p1", documentId: "d1", artifact, reviews: [humanReview()], baseRevision: 1, idempotencyKey: "approve-1", text: "正文" })).resolves.toEqual(result);
    expect(repository.commitRevision).toHaveBeenCalledWith(expect.objectContaining({ contentHash: "new", objectKey: "ne/w", text: "正文" }));
  });
});
