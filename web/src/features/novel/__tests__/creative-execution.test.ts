import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
  callStructuredNovelModel: vi.fn(async () => ({
    data: { summary: "审核完成", issues: [] },
    usage: { inputTokens: 1, outputTokens: 1 },
    promptHash: "audit",
  })),
}));

import { callStructuredNovelModel } from "../ai";
import { NovelDatabase } from "../db";
import type { StoryProject, NovelContextPacket, ContextSource } from "../types";
import {
  createCreativeRun,
  defaultReviewer,
  enqueueCreativeWork,
  evaluateCreativeReviewGate,
  executeCreativeCommand,
  inspectCreativeRun,
  startManualCreativeGeneration,
} from "../creative-execution";
import type { CreativeReview } from "../types";

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
    vi.mocked(callStructuredNovelModel).mockClear();
  });

  afterEach(async () => {
    await db.delete();
  });

  it("starts a new review generation when the same proposal ID has a newer revision", () => {
    const review = (id: string, subjectRevision: number, verdict: CreativeReview["verdict"], issues: CreativeReview["issues"], createdAt: number): CreativeReview => ({
      id, projectId: "project-1", schemaVersion: 8, revision: 1, createdAt, updatedAt: createdAt, createdBy: "test", updatedBy: "test",
      creativeRunId: "run-1", workItemId: "work-1", subjectArtifactId: "proposal-1", subjectRevision, reviewer: "internal", verdict, issues, summary: verdict,
    });
    const oldIssue = {
      issueId: "old-major", status: "open" as const, severity: "major" as const, dimension: "continuity" as const,
      title: "旧修订冲突", description: "旧候选存在时间线冲突", evidence: "旧修订的事件顺序相互矛盾", rule: "continuity.timeline", suggestion: "修订旧候选",
    };
    const gate = evaluateCreativeReviewGate([
      review("review-old", 1, "revise", [oldIssue], 1),
      review("review-new", 2, "passed", [], 2),
    ]);

    expect(gate.passed).toBe(true);
    expect(gate.openIssues).toEqual([]);
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

  it("lets a failed generation re-enter the revision queue", async () => {
    const run = await createCreativeRun({ projectId: "project-1", mode: "external", objective: "恢复生成失败", policy: { maxIterations: 2 } }, db);
    const work = await enqueueCreativeWork(run.id, { kind: "generation", taskKey: "characters", instruction: "生成完整群像" }, db);
    const executor = vi.fn().mockRejectedValue(new Error("候选数量不足"));

    await expect(executeCreativeCommand({ runId: run.id, type: "work.start", workItemId: work.id, idempotencyKey: "failed-start" }, { db, executor }))
      .rejects.toThrow("候选数量不足");
    expect(await db.creativeWorkItems.get(work.id)).toMatchObject({ status: "failed" });

    const failedSnapshot = await inspectCreativeRun(run.id, undefined, db);
    expect(failedSnapshot.nextActions).toContainEqual({ type: "work.retry", workItemId: work.id });
    const retried = await executeCreativeCommand({ runId: run.id, type: "work.retry", workItemId: work.id, instruction: "重新生成有效 JSON", idempotencyKey: "failed-retry" }, { db, executor });
    expect(retried).toMatchObject({ status: "running", workStatus: "queued" });
    expect(await db.creativeWorkItems.get(work.id)).toMatchObject({ status: "queued", iteration: 0, error: undefined });
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

  it("injects contextPacket digest into fallback audit prompt (audit Loop 1 问题 B 修复验证)", async () => {
    // 验证 defaultReviewer fallback 路径注入 proposal.contextPacketId 对应的冻结上下文。
    // 修复前：fallback 审核 prompt 不注入项目事实库，却要求"项目既有事实一致性"。
    // 修复后：通过 formatReviewerContext 注入冻结上下文摘要。
    const entitySource: ContextSource = {
      id: "entity-shen",
      kind: "entity",
      title: "角色档案-沈雁声",
      content: "沈雁声在第二章已得知密信内容，本章不得重新揭示。",
      weight: 1.0,
      pinned: true,
      estimatedTokens: 50,
      reason: "实体档案",
      contentHash: "shen",
      priorityClass: "invariant",
      layer: "mandatory",
      visibilityReason: "跨章连续性",
    };
    const packetRecord: NovelContextPacket = {
      id: "packet-b-fallback", projectId: "project-1", schemaVersion: 8, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test",
      task: "chapter-draft", instruction: "继续写作", sources: [entitySource], estimatedTokens: 50, omittedSourceIds: [], skillRefs: [], compiledAt: Date.now(),
    };
    await db.contextPackets.put(packetRecord);
    await db.proposals.put({
      id: "proposal-b-fallback", projectId: "project-1", schemaVersion: 8, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test",
      title: "剧情段候选", operation: "plot-segment", taskKey: "plot-threads", status: "pending", previewMarkdown: "沈雁声翻开密信，第一次得知陆无名已死。", patches: [], items: [], contextPacketId: "packet-b-fallback", model: "test",
    });
    const work = {
      id: "work-b-fallback", projectId: "project-1", schemaVersion: 8, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test",
      creativeRunId: "run-b-fallback", kind: "plot-segment" as const, status: "running" as const, instruction: "生成下一剧情段", parameters: {}, dependsOn: [], iteration: 0, artifactRefs: ["proposal-b-fallback"],
    };
    const run = {
      id: "run-b-fallback", projectId: "project-1", schemaVersion: 8, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test",
      mode: "segment-auto" as const, objective: "生成剧情段", status: "running" as const, policy: { auditTrigger: "automatic" as const, commitPolicy: "quality-gated-auto" as const, qualityThreshold: 3.7, maxIterations: 3 }, lastEventSequence: 0,
    };

    await defaultReviewer(work, run, db);

    expect(callStructuredNovelModel).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(callStructuredNovelModel).mock.calls[0][0] as { prompt: string };
    // 修复验证：prompt 必须包含冻结上下文段，且包含 contextPacket 中的实体档案内容
    expect(callArgs.prompt).toContain("项目冻结上下文");
    expect(callArgs.prompt).toContain("沈雁声在第二章已得知密信内容");
    // 输出要求必须约束 evidence 引用冻结上下文条目
    expect(callArgs.prompt).toContain("涉及项目既有事实的 issue 必须在 evidence 中引用");
  });

  it("falls back to explicit no-context hint when proposal has no contextPacket (audit Loop 1 问题 B 边界验证)", async () => {
    // 边界场景：proposal.contextPacketId 对应的 packet 不存在 → fallbackContextDigest 为空
    // 修复后：prompt 注入显式提示"本次候选无冻结上下文...不得臆造项目既有事实"
    await db.proposals.put({
      id: "proposal-b-no-ctx", projectId: "project-1", schemaVersion: 8, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test",
      title: "剧情段候选", operation: "plot-segment", taskKey: "plot-threads", status: "pending", previewMarkdown: "候选内容。", patches: [], items: [], contextPacketId: "nonexistent-packet", model: "test",
    });
    const work = {
      id: "work-b-no-ctx", projectId: "project-1", schemaVersion: 8, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test",
      creativeRunId: "run-b-no-ctx", kind: "plot-segment" as const, status: "running" as const, instruction: "生成剧情段", parameters: {}, dependsOn: [], iteration: 0, artifactRefs: ["proposal-b-no-ctx"],
    };
    const run = {
      id: "run-b-no-ctx", projectId: "project-1", schemaVersion: 8, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test",
      mode: "segment-auto" as const, objective: "生成剧情段", status: "running" as const, policy: { auditTrigger: "automatic" as const, commitPolicy: "quality-gated-auto" as const, qualityThreshold: 3.7, maxIterations: 3 }, lastEventSequence: 0,
    };

    await defaultReviewer(work, run, db);

    expect(callStructuredNovelModel).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(callStructuredNovelModel).mock.calls[0][0] as { prompt: string };
    // 边界验证：无 packet 时注入显式提示，不得臆造事实
    expect(callArgs.prompt).toContain("本次候选无冻结上下文");
    expect(callArgs.prompt).toContain("不得臆造项目既有事实");
  });
});
