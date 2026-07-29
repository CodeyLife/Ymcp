import { describe, expect, it, vi } from "vitest";
import { runChapterLifecycle } from "../application/chapter-lifecycle";
import type { Artifact, Review } from "../protocol";

const artifact: Artifact = {
  id: "artifact-1",
  projectId: "project-1",
  taskId: "draft-1",
  attemptId: "attempt-1",
  kind: "draft",
  contentHash: "content-1",
  baseRevision: 1,
  fingerprint: "fingerprint-1",
  structuredData: {},
  createdAt: 1,
};

function review(id: string, identity: Review["identity"], verdict: Review["verdict"], warning = false): Review {
  return {
    id,
    projectId: artifact.projectId,
    artifactId: artifact.id,
    reviewerId: id,
    identity,
    verdict,
    issues: warning ? [{ severity: "warning", title: "可微调", evidence: "段落 1" }] : [],
    score: verdict === "passed" ? 5 : 4,
    artifactFingerprint: artifact.fingerprint,
    createdAt: 2,
  };
}

function baseParams(reviews: Review[], events: string[]) {
  return {
    projectId: artifact.projectId,
    initialDraft: { artifact, text: "正文" },
    review: vi.fn(async () => reviews),
    revise: vi.fn(async (current: { artifact: Artifact; text: string }) => current),
    assessLearning: vi.fn(async () => {
      events.push("learning");
      return {
        id: "learning-1",
        projectId: artifact.projectId,
        source: { workflowId: "workflow-1", artifactId: artifact.id, reviewIds: reviews.map((item) => item.id), fingerprint: artifact.fingerprint },
        conclusion: "no-shared-learning" as const,
        symptom: "none",
        failingLayer: "review",
        createdAt: 3,
      };
    }),
    extractFacts: vi.fn(async () => { events.push("facts"); return artifact; }),
    approveFacts: vi.fn(async () => { events.push("fact-approval"); }),
    commit: vi.fn(async () => { events.push("commit"); return { revisionId: "revision-2", revision: 2, contentHash: "content-2", projectRevision: 2, outboxEventId: 2 }; }),
    enrich: vi.fn(async () => { events.push("enrich"); }),
    progress: vi.fn(async () => undefined),
  };
}

describe("runChapterLifecycle", () => {
  it("records learning evidence but never extracts facts or commits when the dual gate fails", async () => {
    const events: string[] = [];
    const params = baseParams([
      review("internal", "internal", "revise", true),
      review("independent", "independent", "passed"),
    ], events);

    const result = await runChapterLifecycle(params);

    expect(result.commitGate.passed).toBe(false);
    expect(result.commitResult).toBeUndefined();
    expect(params.commit).not.toHaveBeenCalled();
    expect(params.enrich).not.toHaveBeenCalled();
    expect(events).toEqual(["learning"]);
  });

  it("commits and enriches only after current-artifact internal and independent reviews pass", async () => {
    const events: string[] = [];
    const params = baseParams([
      review("internal", "internal", "passed"),
      review("independent", "independent", "passed"),
    ], events);

    const result = await runChapterLifecycle(params);

    expect(result.commitGate.passed).toBe(true);
    expect(result.commitResult?.revisionId).toBe("revision-2");
    expect(events).toEqual(["learning", "facts", "fact-approval", "commit", "enrich", "learning"]);
  });
});
