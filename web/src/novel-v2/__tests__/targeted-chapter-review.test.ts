import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";
import type { Artifact, Review } from "../protocol";

const EXPLICIT_TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_DB_URL = EXPLICIT_TEST_DB_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("targeted chapter review issues", () => {
  const suffix = randomUUID().slice(0, 8);
  const projectId = `targeted-review-${suffix}`;
  const documentId = `document-${suffix}`;
  const revisionId = `revision-${suffix}`;
  const snapshotId = `snapshot-${suffix}`;
  const pendingIssueId = `issue-pending-${suffix}`;
  const ignoredIssueId = `issue-ignored-${suffix}`;
  const contentHash = `content-${suffix}`;
  let repository: NovelPostgresRepository;
  let available = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Targeted review test");
      await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,'第一章',1,'final')", [documentId, projectId]);
      await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,10)", [contentHash, `test/${contentHash}`]);
      await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)", [revisionId, projectId, documentId, contentHash]);
      await repository.pool.query("UPDATE manuscript_documents SET current_revision_id=$1 WHERE id=$2", [revisionId, documentId]);
      await repository.pool.query(`INSERT INTO chapter_review_snapshots(id,document_id,project_id,revision_id,reviewed_content_hash,artifact_fingerprint,verdict,complete,overall_score,reviewed_at)
        VALUES($1,$2,$3,$4,$5,'artifact-fingerprint','revise',TRUE,4.2,now())`, [snapshotId, documentId, projectId, revisionId, contentHash]);
      await repository.pool.query(`INSERT INTO chapter_review_snapshot_issues(id,snapshot_id,issue_fingerprint,severity,title,evidence_quote,paragraph,revision_ranges,suggestion,status)
        VALUES($1,$2,'fingerprint-pending','warning','意象失配','像齿轮一样精确',2,'[{"start":2,"end":2}]','改用世界内意象','pending'),
              ($3,$2,'fingerprint-ignored','major','重复解释','他知道自己明白了',3,'[{"start":3,"end":3}]','改为行动','ignored')`, [pendingIssueId, snapshotId, ignoredIssueId]);
      available = true;
    } catch (error) {
      if (EXPLICIT_TEST_DB_URL) throw error;
      console.warn(`[targeted-chapter-review.test] Postgres unavailable: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!repository) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("loads final manuscript content when a manual revision has no artifact", async () => {
    if (!available) return;
    await expect(repository.getFinalDocumentContentRef(projectId, documentId)).resolves.toMatchObject({
      status: "final",
      revision: 1,
      contentHash,
      objectKey: `test/${contentHash}`,
    });
  });

  it("loads only pending issues from the current non-stale snapshot", async () => {
    if (!available) return;
    const result = await repository.getTargetedChapterReviewIssues({ projectId, documentId, issueIds: [pendingIssueId] });
    expect(result).toMatchObject({ snapshotId, reviewedContentHash: contentHash, fingerprints: ["fingerprint-pending"] });
    expect(result.issues[0]).toMatchObject({ severity: "warning", paragraph: 2, revisionRanges: [{ start: 2, end: 2 }] });
    await expect(repository.getTargetedChapterReviewIssues({ projectId, documentId, issueIds: [pendingIssueId, pendingIssueId] })).rejects.toThrow(/不能重复/);
    await expect(repository.getTargetedChapterReviewIssues({ projectId, documentId, issueIds: [ignoredIssueId] })).rejects.toThrow(/待处理/);
  });

  it("changes triage status without changing manuscript or review score", async () => {
    if (!available) return;
    const before = await repository.getChapterWorkspace(projectId, documentId);
    await repository.updateChapterReviewIssueStatus({ projectId, documentId, issueId: pendingIssueId, status: "resolved" });
    const after = await repository.getChapterWorkspace(projectId, documentId);
    expect(after?.content?.contentHash).toBe(before?.content?.contentHash);
    expect(after?.content?.revision).toBe(before?.content?.revision);
    expect(after?.review?.overallScore).toBe(before?.review?.overallScore);
    expect(after?.review?.issues.find((issue) => issue.id === pendingIssueId)?.status).toBe("resolved");
    await repository.updateChapterReviewIssueStatus({ projectId, documentId, issueId: pendingIssueId, status: "pending" });
  });

  it("adds author review notes to the same snapshot and keeps them targetable", async () => {
    if (!available) return;
    const created = await repository.addChapterReviewIssue({
      projectId,
      documentId,
      severity: "major",
      title: "人物反应太直白",
      paragraph: 2,
      suggestion: "改为动作和环境反馈",
    });
    expect(created).toMatchObject({ severity: "major", title: "人物反应太直白", sourceRoles: ["author"], status: "pending", revisionRanges: [{ start: 2, end: 2 }] });

    const workspace = await repository.getChapterWorkspace(projectId, documentId);
    expect(workspace?.review?.issues.find((issue) => issue.id === created.id)).toMatchObject({ title: "人物反应太直白", status: "pending" });

    const targeted = await repository.getTargetedChapterReviewIssues({ projectId, documentId, issueIds: [created.id] });
    expect(targeted.issues[0]).toMatchObject({ title: "人物反应太直白", paragraph: 2, revisionRanges: [{ start: 2, end: 2 }], suggestion: "改为动作和环境反馈" });
  });

  it("records targeted diagnostic reviews without promoting the chapter snapshot", async () => {
    if (!available) return;
    const workflowId = `targeted-diagnostic-${suffix}`;
    const artifact: Artifact = {
      id: `artifact-${suffix}`,
      projectId,
      taskId: `targeted-review-${suffix}`,
      attemptId: `attempt-${suffix}`,
      kind: "draft",
      contentHash,
      objectKey: `test/${contentHash}`,
      structuredData: { workflowId },
      baseRevision: 1,
      createdAt: Date.now(),
      fingerprint: `diagnostic-artifact-${suffix}`,
    };
    await repository.putWorkflowRun({ id: workflowId, workflowType: "chapter-review", projectId, temporalWorkflowId: workflowId, status: "running", payload: { documentId, mode: "targeted" } });
    await repository.recordArtifact(artifact);
    const roles = ["plot-reviewer", "continuity-reviewer", "style-reviewer", "character-reviewer", "reader-reviewer"];
    for (const [index, role] of roles.entries()) {
      const review: Review = {
        id: `diagnostic-review-${index}-${suffix}`,
        projectId,
        artifactId: artifact.id,
        reviewerId: role,
        identity: index < 2 ? "internal" : "independent",
        verdict: "passed",
        issues: [],
        score: 5,
        dimensionScores: { plot: 5, continuity: 5, specificity: 5, characterVoice: 5, readerRetention: 5 },
        role,
        createdAt: Date.now() + index,
        artifactFingerprint: artifact.fingerprint,
      };
      await repository.putReview(review, { refreshChapterSnapshot: false });
    }

    const workspace = await repository.getChapterWorkspace(projectId, documentId);
    expect(workspace?.review).toMatchObject({ id: snapshotId, overallScore: 4.2 });
    expect(workspace?.review?.issues.map((issue) => issue.id)).toContain(pendingIssueId);
  });

  it("accepts only one human decision for the current candidate artifact", async () => {
    if (!available) return;
    const workflowId = `human-decision-${suffix}`;
    const artifactId = `candidate-${suffix}`;
    await repository.putWorkflowRun({
      id: workflowId,
      workflowType: "chapter-review",
      projectId,
      temporalWorkflowId: workflowId,
      status: "manual-review-required",
      payload: { documentId, artifactId, reasonCode: "targeted-manuscript-approval" },
    });

    await expect(repository.claimHumanDecision({ workflowId, artifactId, decision: "approve", authorId: "author-1" })).resolves.toMatchObject({
      status: "manual-review-required",
      payload: { pendingHumanDecision: { artifactId, decision: "approve", authorId: "author-1" } },
    });
    await expect(repository.claimHumanDecision({ workflowId, artifactId, decision: "approve", authorId: "author-1" })).resolves.toBeUndefined();
    await expect(repository.claimHumanDecision({ workflowId, artifactId: `${artifactId}-stale`, decision: "reject", authorId: "author-1" })).resolves.toBeUndefined();

    await repository.releaseHumanDecisionClaim(workflowId, artifactId);
    await expect(repository.claimHumanDecision({ workflowId, artifactId, decision: "reject", authorId: "author-2", feedback: "继续修改" })).resolves.toMatchObject({
      payload: { pendingHumanDecision: { artifactId, decision: "reject", authorId: "author-2", feedback: "继续修改" } },
    });
  });

  it("rejects a snapshot after the current manuscript hash changes", async () => {
    if (!available) return;
    const nextHash = `next-${contentHash}`;
    const nextRevisionId = `next-${revisionId}`;
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,10)", [nextHash, `test/${nextHash}`]);
    await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,2,1,$4)", [nextRevisionId, projectId, documentId, nextHash]);
    await repository.pool.query("UPDATE manuscript_documents SET current_revision_id=$1 WHERE id=$2", [nextRevisionId, documentId]);
    await expect(repository.getTargetedChapterReviewIssues({ projectId, documentId, issueIds: [pendingIssueId] })).rejects.toThrow(/已过期/);
  });
});
