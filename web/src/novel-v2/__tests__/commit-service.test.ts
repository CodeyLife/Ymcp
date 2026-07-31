import { describe, expect, it, vi } from "vitest";
import { CommitService } from "../commit-service";
import type { ApprovalEvidence, Artifact, CommitResult } from "../protocol";
import { inspectManuscript } from "../application/manuscript-structure";

const artifact: Artifact = { id: "artifact-1", projectId: "p1", taskId: "task-1", attemptId: "attempt-1", kind: "revision", contentHash: "old", baseRevision: 1, fingerprint: "fp-1", createdAt: 1 };
const result: CommitResult = { revisionId: "revision-2", revision: 2, contentHash: "new", outboxEventId: 2 };

const evidence: ApprovalEvidence = { id: "approval-1", projectId: "p1", workflowId: "workflow-1", artifactId: artifact.id, decision: "approve", actorSource: "interactive-web", actorId: "web-author", unresolvedIssueFingerprints: [], createdAt: new Date(2).toISOString() };
const structuralReport = inspectManuscript({ text: "正文" });

describe("CommitService author approval", () => {
  it("rejects author-approved commit without trusted current-artifact evidence", async () => {
    const repository = { commitRevision: vi.fn(), getApprovalEvidenceById: vi.fn(async () => ({ ...evidence, actorSource: "automation" })) };
    const objects = { putText: vi.fn(), getText: vi.fn() };
    const service = new CommitService(repository as never, objects);

    await expect(service.commitAuthorApproved({ projectId: "p1", documentId: "d1", artifact, reviews: [], structuralReport, baseRevision: 1, idempotencyKey: "approve-1", text: "正文", approvalEvidenceId: evidence.id })).rejects.toThrow(/interactive-web/);
    expect(objects.putText).not.toHaveBeenCalled();
    expect(repository.commitRevision).not.toHaveBeenCalled();
  });

  it("stores text without fabricating a passed review when trusted evidence matches", async () => {
    const repository = { commitRevision: vi.fn(async () => result), getApprovalEvidenceById: vi.fn(async () => evidence) };
    const objects = { putText: vi.fn(async () => ({ hash: "new", key: "ne/w", bytes: 6 })), getText: vi.fn() };
    const service = new CommitService(repository as never, objects);

    await expect(service.commitAuthorApproved({ projectId: "p1", documentId: "d1", artifact, reviews: [], structuralReport, baseRevision: 1, idempotencyKey: "approve-1", text: "正文", approvalEvidenceId: evidence.id })).resolves.toEqual(result);
    expect(repository.commitRevision).toHaveBeenCalledWith(expect.objectContaining({ contentHash: "new", objectKey: "ne/w", text: "正文" }));
  });
});
