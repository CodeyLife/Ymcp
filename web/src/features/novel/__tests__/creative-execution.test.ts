import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NovelDatabase } from "../db";
import type { StoryProject } from "../types";
import {
  createCreativeRun,
  enqueueCreativeWork,
  executeCreativeCommand,
  inspectCreativeRun,
  startManualCreativeGeneration,
} from "../creative-execution";

describe("CreativeExecutionEngine", () => {
  let db: NovelDatabase;

  beforeEach(async () => {
    db = new NovelDatabase(`ymcp-creative-execution-${crypto.randomUUID()}`);
    await db.open();
    await db.projects.put({
      id: "project-1", schemaVersion: 8, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test",
      title: "测试项目", subtitle: "", premise: "测试", genre: ["测试"], audience: "读者", themes: [], sellingPoints: [], pov: "第三人称限知", tense: "过去时", tone: "克制", languageStyle: "具象", targetWords: 100000, dailyGoal: 3000, status: "planning", coverColor: "#000000",
      settings: { textModel: "test", temperature: 0.7, recentChapterCount: 5, encrypted: false, contentProfile: "general-serial", maxAutoRevisions: 2, qualityThreshold: 3.7, approvalMode: "blueprint-and-manuscript" },
    } satisfies StoryProject);
  });

  afterEach(async () => {
    await db.delete();
  });

  it.each(["manual", "segment-auto", "external"] as const)("persists an auditable %s run", async (mode) => {
    const run = await createCreativeRun({ projectId: "project-1", mode, objective: "继续推进创作" }, db);
    const work = await enqueueCreativeWork(run.id, { kind: "generation", taskKey: "characters", instruction: "补齐角色" }, db);
    const snapshot = await inspectCreativeRun(run.id, undefined, db);

    expect(snapshot.run.mode).toBe(mode);
    expect(snapshot.workItems.map((item) => item.id)).toContain(work.id);
    expect(snapshot.events.map((event) => event.type)).toEqual(["run.created", "work.enqueued"]);
    expect(snapshot.nextActions).toContainEqual(expect.objectContaining({ type: "work.start", workItemId: work.id }));
  });

  it("deduplicates retried commands by idempotency key", async () => {
    const run = await createCreativeRun({ projectId: "project-1", mode: "manual", objective: "生成角色" }, db);
    const work = await enqueueCreativeWork(run.id, { kind: "generation", taskKey: "characters", instruction: "补齐角色" }, db);
    const executor = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "候选已生成" });

    const first = await executeCreativeCommand({ runId: run.id, type: "work.start", workItemId: work.id, idempotencyKey: "cmd-1" }, { db, executor });
    const second = await executeCreativeCommand({ runId: run.id, type: "work.start", workItemId: work.id, idempotencyKey: "cmd-1" }, { db, executor });

    expect(executor).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect((await db.creativeRunEvents.where("creativeRunId").equals(run.id).toArray()).filter((event) => event.type === "work.result-ready")).toHaveLength(1);
  });

  it("recovers an interrupted running work item after its execution lease expires", async () => {
    const run = await createCreativeRun({ projectId: "project-1", mode: "external", objective: "恢复长任务" }, db);
    const work = await enqueueCreativeWork(run.id, { kind: "generation", taskKey: "characters", instruction: "补齐角色" }, db);
    await db.creativeWorkItems.update(work.id, { status: "running", leaseExpiresAt: Date.now() - 1, activeIdempotencyKey: "lost-start" });

    const recovered = await executeCreativeCommand({ runId: run.id, type: "work.recover", workItemId: work.id, idempotencyKey: "recover-1" }, { db });
    expect(recovered).toMatchObject({ status: "running", workStatus: "queued" });
    expect(recovered.nextActions).toContainEqual({ type: "work.start", workItemId: work.id });
  });

  it("keeps manual generation, AI review, and acceptance as separate actions", async () => {
    const run = await createCreativeRun({ projectId: "project-1", mode: "manual", objective: "生成并审核角色" }, db);
    const work = await enqueueCreativeWork(run.id, { kind: "generation", taskKey: "characters", instruction: "补齐角色" }, db);
    const executor = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "候选已生成" });
    const reviewer = vi.fn().mockResolvedValue({
      subjectArtifactId: "proposal-1",
      reviewer: "internal",
      verdict: "passed",
      summary: "审核通过",
      issues: [],
    });
    const accepter = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "候选已采纳" });

    await executeCreativeCommand({ runId: run.id, type: "work.start", workItemId: work.id, idempotencyKey: "start-1" }, { db, executor, reviewer, accepter });
    let snapshot = await inspectCreativeRun(run.id, undefined, db);
    expect(snapshot.run.status).toBe("waiting-review");
    expect(snapshot.nextActions).toContainEqual({ type: "review.request", workItemId: work.id });
    expect(accepter).not.toHaveBeenCalled();

    await executeCreativeCommand({ runId: run.id, type: "review.request", workItemId: work.id, idempotencyKey: "review-1" }, { db, executor, reviewer, accepter });
    snapshot = await inspectCreativeRun(run.id, undefined, db);
    expect(snapshot.reviews).toHaveLength(1);
    expect(snapshot.reviews[0].verdict).toBe("passed");
    expect(snapshot.nextActions).toContainEqual({ type: "work.accept", workItemId: work.id });
    expect(accepter).not.toHaveBeenCalled();

    const accepted = await executeCreativeCommand({ runId: run.id, type: "work.accept", workItemId: work.id, idempotencyKey: "accept-1" }, { db, executor, reviewer, accepter });
    expect(accepted.status).toBe("completed");
    expect(accepter).toHaveBeenCalledTimes(1);
  });

  it("keeps custom manual generation paths inside the same auditable workflow", async () => {
    const executor = vi.fn().mockResolvedValue({ artifactRefs: ["refinement-proposal-1"], summary: "微调候选已生成" });
    const result = await startManualCreativeGeneration({ projectId: "project-1", taskKey: "characters", instruction: "微调角色" }, db, { executor });
    const snapshot = await inspectCreativeRun(result.runId, undefined, db);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(snapshot.run.mode).toBe("manual");
    expect(snapshot.workItems[0]).toMatchObject({ status: "waiting-review", artifactRefs: ["refinement-proposal-1"] });
    expect(snapshot.nextActions).toContainEqual({ type: "review.request", workItemId: snapshot.workItems[0].id });
  });

  it("requires an effective passed review and auto-accepts external work after it passes", async () => {
    const run = await createCreativeRun({ projectId: "project-1", mode: "external", objective: "由外部 LLM 推进角色" }, db);
    const work = await enqueueCreativeWork(run.id, { kind: "generation", taskKey: "characters", instruction: "补齐角色" }, db);
    const executor = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "候选已生成" });
    const accepter = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "候选已采纳" });

    await executeCreativeCommand({ runId: run.id, type: "work.start", workItemId: work.id, idempotencyKey: "start-1" }, { db, executor, accepter });
    await expect(executeCreativeCommand({ runId: run.id, type: "work.accept", workItemId: work.id, idempotencyKey: "accept-before-review" }, { db, executor, accepter }))
      .rejects.toThrow(/审核门禁/);

    const accepted = await executeCreativeCommand({
      runId: run.id,
      type: "review.submit",
      workItemId: work.id,
      idempotencyKey: "external-review-1",
      review: { subjectArtifactId: "proposal-1", reviewer: "external-llm", verdict: "passed", summary: "外部审核通过", issues: [] },
    }, { db, executor, accepter });

    expect(accepted.status).toBe("completed");
    expect(accepter).toHaveBeenCalledTimes(1);
  });

  it("does not let an internal review unlock an external run", async () => {
    const run = await createCreativeRun({ projectId: "project-1", mode: "external", objective: "外部复核" }, db);
    const work = await enqueueCreativeWork(run.id, { kind: "generation", taskKey: "characters", instruction: "补齐角色" }, db);
    const executor = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "候选已生成" });
    const accepter = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "候选已采纳" });
    await executeCreativeCommand({ runId: run.id, type: "work.start", workItemId: work.id, idempotencyKey: "internal-gate-start" }, { db, executor, accepter });
    const reviewed = await executeCreativeCommand({
      runId: run.id,
      type: "review.submit",
      workItemId: work.id,
      idempotencyKey: "internal-gate-review",
      review: { subjectArtifactId: "proposal-1", reviewer: "internal", verdict: "passed", summary: "内部审核通过", issues: [] },
    }, { db, executor, accepter });

    expect(reviewed.status).toBe("waiting-review");
    expect(reviewed.nextActions).not.toContainEqual({ type: "work.accept", workItemId: work.id });
    expect(accepter).not.toHaveBeenCalled();
    await expect(executeCreativeCommand({ runId: run.id, type: "work.accept", workItemId: work.id, idempotencyKey: "internal-gate-accept" }, { db, executor, accepter }))
      .rejects.toThrow("需要 external-llm 或用户审核结论");
  });

  it("lets an external controller revise a rejected work item within the iteration policy", async () => {
    const run = await createCreativeRun({ projectId: "project-1", mode: "external", objective: "迭代正文", policy: { maxIterations: 1 } }, db);
    const work = await enqueueCreativeWork(run.id, { kind: "generation", taskKey: "chapter-draft", instruction: "生成正文" }, db);
    const executor = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "正文候选" });
    await executeCreativeCommand({ runId: run.id, type: "work.start", workItemId: work.id, idempotencyKey: "revise-start-1" }, { db, executor });
    await executeCreativeCommand({
      runId: run.id,
      type: "review.submit",
      workItemId: work.id,
      idempotencyKey: "revise-review-1",
      review: {
        subjectArtifactId: "proposal-1",
        reviewer: "external-llm",
        verdict: "revise",
        summary: "动机不足",
        issues: [{ issueId: "motivation-1", severity: "major", dimension: "characterVoice", title: "动机不足", evidence: "转折处", suggestion: "补充选择压力" }],
      },
    }, { db, executor });

    const revised = await executeCreativeCommand({
      runId: run.id,
      type: "work.revise",
      workItemId: work.id,
      instruction: "补充选择压力后重写正文",
      idempotencyKey: "revise-1",
    }, { db, executor });
    expect(revised).toMatchObject({ status: "running", workStatus: "queued" });
    expect(revised.nextActions).toContainEqual({ type: "work.start", workItemId: work.id });
    await expect(executeCreativeCommand({ runId: run.id, type: "work.revise", workItemId: work.id, idempotencyKey: "revise-2" }, { db, executor }))
      .rejects.toThrow("当前不能进入下一轮修订");
  });

  it("lets a later review supersede an earlier blocker without rewriting history", async () => {
    const run = await createCreativeRun({ projectId: "project-1", mode: "external", objective: "复核正文问题" }, db);
    const work = await enqueueCreativeWork(run.id, { kind: "generation", taskKey: "chapter-draft", targetId: "chapter-1", instruction: "生成正文" }, db);
    const executor = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "正文候选" });
    const accepter = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "正文已采纳" });
    await executeCreativeCommand({ runId: run.id, type: "work.start", workItemId: work.id, idempotencyKey: "start-1" }, { db, executor });

    await executeCreativeCommand({
      runId: run.id,
      type: "review.submit",
      workItemId: work.id,
      idempotencyKey: "review-blocked",
      review: {
        subjectArtifactId: "proposal-1",
        reviewer: "internal",
        verdict: "blocked",
        summary: "存在连续性冲突",
        issues: [{ issueId: "continuity-1", severity: "blocker", dimension: "continuity", title: "时间冲突", evidence: "第一段", suggestion: "修订时间" }],
      },
    }, { db, executor, accepter });
    await executeCreativeCommand({
      runId: run.id,
      type: "review.submit",
      workItemId: work.id,
      idempotencyKey: "review-supersede",
      review: {
        subjectArtifactId: "proposal-1",
        reviewer: "external-llm",
        verdict: "passed",
        summary: "复核后确认并非冲突",
        issues: [{ issueId: "continuity-1-downgraded", supersedesIssueId: "continuity-1", severity: "warning", dimension: "continuity", title: "时间表达可更清楚", evidence: "第一段", suggestion: "可选优化" }],
      },
    }, { db, executor, accepter });

    const snapshot = await inspectCreativeRun(run.id, undefined, db);
    expect(snapshot.reviews).toHaveLength(2);
    expect(snapshot.reviewGates[work.id]).toMatchObject({ passed: true, verdict: "passed" });
    expect(snapshot.reviewGates[work.id].openIssues.map((issue) => issue.issueId)).toEqual(["continuity-1-downgraded"]);
  });

  it("evaluates a revised artifact independently from rejected earlier generations", async () => {
    const run = await createCreativeRun({ projectId: "project-1", mode: "external", objective: "修订正文" }, db);
    const work = await enqueueCreativeWork(run.id, { kind: "generation", taskKey: "chapter-draft", instruction: "生成正文" }, db);
    const executor = vi.fn()
      .mockResolvedValueOnce({ artifactRefs: ["proposal-v1"], summary: "初稿" })
      .mockResolvedValueOnce({ artifactRefs: ["proposal-v2"], summary: "修订稿" });
    await executeCreativeCommand({ runId: run.id, type: "work.start", workItemId: work.id, idempotencyKey: "generation-v1" }, { db, executor });
    await executeCreativeCommand({
      runId: run.id,
      type: "review.submit",
      workItemId: work.id,
      idempotencyKey: "review-v1",
      review: {
        subjectArtifactId: "proposal-v1", reviewer: "external-llm", verdict: "revise", summary: "动机断裂",
        issues: [{ issueId: "motivation-v1", severity: "major", dimension: "characterVoice", title: "动机断裂", evidence: "转折处", suggestion: "补足压力" }],
      },
    }, { db, executor });
    await executeCreativeCommand({ runId: run.id, type: "work.revise", workItemId: work.id, idempotencyKey: "revise-v2" }, { db, executor });
    await executeCreativeCommand({ runId: run.id, type: "work.start", workItemId: work.id, idempotencyKey: "generation-v2" }, { db, executor });
    await executeCreativeCommand({
      runId: run.id,
      type: "review.submit",
      workItemId: work.id,
      idempotencyKey: "review-v2",
      review: { subjectArtifactId: "proposal-v2", reviewer: "external-llm", verdict: "passed", summary: "修订通过", issues: [] },
    }, { db, executor, accepter: vi.fn().mockResolvedValue({ artifactRefs: ["proposal-v2"], summary: "已采纳" }) });

    const snapshot = await inspectCreativeRun(run.id, undefined, db);
    expect(snapshot.reviewGates[work.id]).toMatchObject({ passed: true, verdict: "passed", openIssues: [] });
  });

  it("keeps mode authority fields immutable while allowing bounded quality controls", async () => {
    await expect(createCreativeRun({
      projectId: "project-1",
      mode: "external",
      objective: "绕过外部审核",
      policy: { auditTrigger: "automatic" },
    }, db)).rejects.toThrow("auditTrigger 不可覆盖");
    const run = await createCreativeRun({
      projectId: "project-1",
      mode: "external",
      objective: "合法调节迭代预算",
      policy: { qualityThreshold: 4.2, maxIterations: 5 },
    }, db);
    expect(run.policy).toEqual({ auditTrigger: "external", commitPolicy: "external-auto", qualityThreshold: 4.2, maxIterations: 5 });
  });

  it("rejects replacements that do not reference an existing review issue", async () => {
    const run = await createCreativeRun({ projectId: "project-1", mode: "external", objective: "外部审核" }, db);
    const work = await enqueueCreativeWork(run.id, { kind: "generation", taskKey: "characters", instruction: "补齐角色" }, db);
    const executor = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "候选已生成" });
    await executeCreativeCommand({ runId: run.id, type: "work.start", workItemId: work.id, idempotencyKey: "start-invalid-replacement" }, { db, executor });

    await expect(executeCreativeCommand({
      runId: run.id,
      type: "review.submit",
      workItemId: work.id,
      idempotencyKey: "review-invalid-replacement",
      review: {
        subjectArtifactId: "proposal-1",
        reviewer: "external-llm",
        verdict: "passed",
        summary: "错误地声称旧问题已解决",
        issues: [{ issueId: "replacement-1", supersedesIssueId: "missing-issue", severity: "warning", dimension: "continuity", title: "已解决", evidence: "无", suggestion: "无" }],
      },
    }, { db, executor })).rejects.toThrow("被取代的审核问题不存在");
  });

  it("auto-accepts a quality-gated segment work item only after a passed review", async () => {
    const run = await createCreativeRun({ projectId: "project-1", mode: "segment-auto", objective: "生成剧情段" }, db);
    const work = await enqueueCreativeWork(run.id, { kind: "plot-segment", targetId: "phase-1", instruction: "生成下一剧情段" }, db);
    const executor = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "剧情段候选" });
    const reviewer = vi.fn().mockResolvedValue({ subjectArtifactId: "proposal-1", reviewer: "internal", verdict: "passed", summary: "审核通过", issues: [] });
    const accepter = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "剧情段已采纳" });

    const result = await executeCreativeCommand({ runId: run.id, type: "work.start", workItemId: work.id, idempotencyKey: "start-1" }, { db, executor, reviewer, accepter });
    expect(result.workStatus).toBe("completed");
    expect(result.status).toBe("completed");
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(accepter).toHaveBeenCalledTimes(1);
  });

  it("blocks automatic progress when its audit is inconclusive", async () => {
    const run = await createCreativeRun({ projectId: "project-1", mode: "segment-auto", objective: "生成剧情段" }, db);
    const work = await enqueueCreativeWork(run.id, { kind: "plot-segment", targetId: "phase-1", instruction: "生成下一剧情段" }, db);
    const executor = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "剧情段候选" });
    const reviewer = vi.fn().mockResolvedValue({ subjectArtifactId: "proposal-1", reviewer: "internal", verdict: "inconclusive", summary: "审核服务不可用", issues: [] });
    const accepter = vi.fn();

    const result = await executeCreativeCommand({ runId: run.id, type: "work.start", workItemId: work.id, idempotencyKey: "start-1" }, { db, executor, reviewer, accepter });
    expect(result.workStatus).toBe("blocked");
    expect(result.status).toBe("paused");
    expect(accepter).not.toHaveBeenCalled();
  });
});
