import { describe, expect, it, vi } from "vitest";
import { finalizeChapterLifecycle, runChapterLifecycle } from "../application/chapter-lifecycle";
import type { Artifact, FactApprovalSummary, Review, ReviewIssue } from "../protocol";

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

function review(id: string, identity: Review["identity"], verdict: Review["verdict"], warning = false, role?: string): Review {
  return {
    id,
    projectId: artifact.projectId,
    artifactId: artifact.id,
    reviewerId: id,
    identity,
    role,
    verdict,
    issues: warning ? [{ severity: "warning", title: "可微调", evidence: "段落 1" }] : [],
    score: verdict === "passed" ? 5 : 4,
    artifactFingerprint: artifact.fingerprint,
    createdAt: 2,
  };
}

function fivePassedReviews(): Review[] {
  return [
    review("plot", "internal", "passed", false, "plot-reviewer"),
    review("continuity", "internal", "passed", false, "continuity-reviewer"),
    review("style", "independent", "passed", false, "style-reviewer"),
    review("character", "independent", "passed", false, "character-reviewer"),
    review("reader", "independent", "passed", false, "reader-reviewer"),
  ];
}

function baseParams(reviews: Review[], events: string[]) {
  return {
    projectId: artifact.projectId,
    initialDraft: { artifact, text: "正文" },
    review: vi.fn(async (_current?: { artifact: Artifact; text: string }) => reviews),
    revise: vi.fn(async (current: { artifact: Artifact; text: string }, _reviews: Review[], _iteration: number, _directedIssues?: ReviewIssue[]) => current),
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
    approveFacts: vi.fn(async (): Promise<FactApprovalSummary> => { events.push("fact-approval"); return { autoApproved: 0, pending: 0, pendingIds: [] }; }),
    commit: vi.fn(async () => { events.push("commit"); return { revisionId: "revision-2", revision: 2, contentHash: "content-2", projectRevision: 2, outboxEventId: 2 }; }),
    enrich: vi.fn(async () => { events.push("enrich"); }),
    progress: vi.fn(async () => undefined),
    requireManualFactApproval: false,
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
    const params = baseParams(fivePassedReviews(), events);

    const result = await runChapterLifecycle(params);

    expect(result.commitGate.passed).toBe(true);
    expect(result.commitResult?.revisionId).toBe("revision-2");
    expect(events).toEqual(["learning", "facts", "fact-approval", "commit", "enrich", "learning"]);
  });

  it("returns factApprovalBlocked without committing when manual mode has pending facts", async () => {
    const events: string[] = [];
    const params = baseParams(fivePassedReviews(), events);
    // manual 模式 + pending>0：应提前返回 factApprovalBlocked，不进入 commit/enrich
    params.approveFacts = vi.fn(async (): Promise<FactApprovalSummary> => {
      events.push("fact-approval");
      return { autoApproved: 2, pending: 1, pendingIds: ["claim-pending-1"] };
    });
    params.requireManualFactApproval = true;

    const result = await runChapterLifecycle(params);

    expect(result.factApprovalBlocked).toEqual({ pendingIds: ["claim-pending-1"], factArtifact: artifact });
    expect(result.commitResult).toBeUndefined();
    expect(params.commit).not.toHaveBeenCalled();
    expect(params.enrich).not.toHaveBeenCalled();
    // 仍应执行 facts 提取与 fact-approval，但不应进入 commit/enrich/末尾 learning
    expect(events).toEqual(["learning", "facts", "fact-approval"]);
  });

  it("commits normally in manual mode when no pending facts exist", async () => {
    const events: string[] = [];
    const params = baseParams(fivePassedReviews(), events);
    // manual 模式但 pending=0：应正常走 commit/enrich，与默认模式行为一致
    params.requireManualFactApproval = true;

    const result = await runChapterLifecycle(params);

    expect(result.factApprovalBlocked).toBeUndefined();
    expect(result.commitGate.passed).toBe(true);
    expect(result.commitResult?.revisionId).toBe("revision-2");
    expect(events).toEqual(["learning", "facts", "fact-approval", "commit", "enrich", "learning"]);
  });

  it("runs post-commit learning when a manually approved fact gate resumes", async () => {
    const events: string[] = [];
    const params = baseParams(fivePassedReviews(), events);

    const result = await finalizeChapterLifecycle({
      projectId: params.projectId,
      draft: params.initialDraft,
      reviews: await params.review(),
      commit: params.commit,
      enrich: params.enrich,
      assessLearning: params.assessLearning,
      progress: params.progress,
    });

    expect(result.commitResult.revisionId).toBe("revision-2");
    expect(events).toEqual(["commit", "enrich", "learning"]);
  });

  it("runs a directed revision from selected issues before reviewing the revised draft", async () => {
    const events: string[] = [];
    const initialReviews = fivePassedReviews();
    const revisedArtifact = { ...artifact, id: "artifact-targeted", fingerprint: "fingerprint-targeted", contentHash: "content-targeted", kind: "revision" as const };
    const targetIssue = { severity: "warning" as const, title: "意象不够贴合人物", evidence: "像困兽撞笼", paragraph: 2, revisionRanges: [{ start: 2, end: 2 }], suggestion: "改用结构性意象" };
    const params = baseParams(initialReviews, events);
    params.review = vi.fn(async (current?: { artifact: Artifact; text: string }) => {
      events.push("professional-review");
      expect(current?.artifact.id).toBe(revisedArtifact.id);
      return fivePassedReviews().map((item) => ({ ...item, artifactId: revisedArtifact.id, artifactFingerprint: revisedArtifact.fingerprint }));
    });
    params.revise = vi.fn(async (_current: { artifact: Artifact; text: string }, revisionReviews: Review[], _iteration: number, directedIssues?: ReviewIssue[]) => {
      events.push("targeted-revision");
      expect(revisionReviews).toMatchObject([{ identity: "human", reviewerId: "author-selected-review-issues", verdict: "revise", issues: [targetIssue] }]);
      expect(directedIssues).toEqual([targetIssue]);
      return { artifact: revisedArtifact, text: "正文\n\n结构如断齿般卡住" };
    });

    const result = await runChapterLifecycle({
      ...params,
      directedRevision: { issues: [targetIssue], requireManuscriptApproval: true },
    });

    expect(params.review).toHaveBeenCalledTimes(1);
    expect(params.revise).toHaveBeenCalledTimes(1);
    expect(result.draft.artifact.id).toBe(revisedArtifact.id);
    expect(result.iteration).toBe(1);
    expect(result.commitBlocked).toEqual({ reasonCode: "targeted-manuscript-approval", targetIssueCount: 1 });
    expect(params.extractFacts).not.toHaveBeenCalled();
    expect(params.commit).not.toHaveBeenCalled();
    expect(events).toEqual(["learning", "targeted-revision", "professional-review", "learning"]);
  });
});
