import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NovelDatabase } from "../db";
import { executeCreativeTool } from "../creative-tool-gateway";
import type { StoryProject } from "../types";

describe("creative tool gateway", () => {
  let db: NovelDatabase;

  beforeEach(async () => {
    db = new NovelDatabase(`ymcp-creative-tools-${crypto.randomUUID()}`);
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

  it("lets an external controller create, enqueue, inspect, review, and auto-accept through stable tools", async () => {
    const created = await executeCreativeTool("novel_run_create", { projectId: "project-1", objective: "补齐角色并继续推进", idempotencyKey: "create-main" }, { db });
    const runId = (created.result as { run: { id: string } }).run.id;
    const enqueued = await executeCreativeTool("novel_action_execute", {
      projectId: "project-1",
      runId,
      action: "work.enqueue",
      idempotencyKey: "enqueue-characters",
      work: { kind: "generation", taskKey: "characters", instruction: "补齐角色" },
    }, { db });
    const workId = (enqueued.result as { work: { id: string } }).work.id;
    const executor = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "候选已生成" });
    const accepter = vi.fn().mockResolvedValue({ artifactRefs: ["proposal-1"], summary: "候选已采纳" });

    await executeCreativeTool("novel_action_execute", { projectId: "project-1", runId, action: "work.start", workItemId: workId, idempotencyKey: "start-1" }, { db, executor, accepter });
    const accepted = await executeCreativeTool("novel_review_submit", {
      projectId: "project-1",
      runId,
      workItemId: workId,
      idempotencyKey: "review-1",
      review: { subjectArtifactId: "proposal-1", reviewer: "external-llm", verdict: "passed", summary: "审核通过", issues: [] },
    }, { db, executor, accepter });
    expect((accepted.result as { status: string }).status).toBe("completed");

    const completed = await executeCreativeTool("novel_run_complete", { projectId: "project-1", runId }, { db, executor, accepter });
    expect((completed.result as { run: { status: string } }).run.status).toBe("completed");
  });

  it("rejects a scoped MCP request for a run owned by another project", async () => {
    const source = (await db.projects.get("project-1"))!;
    await db.projects.put({ ...structuredClone(source), id: "project-2", title: "另一个项目" });
    const created = await executeCreativeTool("novel_run_create", { projectId: "project-2", objective: "推进另一个项目", idempotencyKey: "create-other" }, { db });
    const runId = (created.result as { run: { id: string } }).run.id;

    await expect(executeCreativeTool("novel_run_get", { projectId: "project-1", runId }, { db }))
      .rejects.toThrow("不属于当前 MCP 项目作用域");
  });

  it("rejects unsupported work kinds at the MCP boundary", async () => {
    const created = await executeCreativeTool("novel_run_create", { projectId: "project-1", objective: "严格任务输入", idempotencyKey: "create-strict" }, { db });
    const runId = (created.result as { run: { id: string } }).run.id;
    await expect(executeCreativeTool("novel_action_execute", { projectId: "project-1", runId, action: "work.enqueue", idempotencyKey: "enqueue-invalid", work: { kind: "promotion", instruction: "直接晋升" } }, { db }))
      .rejects.toThrow("当前执行器不支持 work.kind");
  });

  it("deduplicates every gateway mutation and rejects idempotency-key reuse with different input", async () => {
    const args = { projectId: "project-1", objective: "幂等运行", idempotencyKey: "stable-run-key" };
    const first = await executeCreativeTool("novel_run_create", args, { db });
    const second = await executeCreativeTool("novel_run_create", args, { db });
    expect(second).toEqual(first);
    expect(await db.creativeRuns.count()).toBe(1);
    await expect(executeCreativeTool("novel_run_create", { ...args, objective: "不同运行" }, { db }))
      .rejects.toThrow("已用于不同请求");
  });

  it("allows only one concurrent mutation to claim an idempotency key", async () => {
    const args = { projectId: "project-1", objective: "并发幂等运行", idempotencyKey: "concurrent-run-key" };
    const attempts = await Promise.allSettled([
      executeCreativeTool("novel_run_create", args, { db }),
      executeCreativeTool("novel_run_create", args, { db }),
    ]);
    const completed = attempts.find((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof executeCreativeTool>>> => attempt.status === "fulfilled")?.value;
    expect(completed).toBeDefined();
    expect(await executeCreativeTool("novel_run_create", args, { db })).toEqual(completed);
    expect(await db.creativeRuns.count()).toBe(1);
    expect(await db.creativeToolReceipts.count()).toBe(1);
    const receipt = await executeCreativeTool("novel_receipt_get", { projectId: "project-1", targetTool: "novel_run_create", idempotencyKey: args.idempotencyKey }, { db });
    expect(receipt.result).toMatchObject({ status: "completed", result: completed });
  });

  it("reads complete rule text by version and resolves closed-loop candidate artifacts", async () => {
    const target = await executeCreativeTool("novel_rule_target_get", { projectId: "project-1", targetKind: "system-prompt", targetId: "drafting-craft-guidance", version: "1.0.0" }, { db });
    expect((target.result as { text: string }).text).toContain("本章主导叙事功能");

    const created = await executeCreativeTool("novel_run_create", { projectId: "project-1", objective: "读取候选", idempotencyKey: "create-artifact-run" }, { db });
    const runId = (created.result as { run: { id: string } }).run.id;
    const candidate = { id: "candidate-bundle-1", manuscript: { title: "候选章节" }, qualityEvidence: { weightedScore: 4 } };
    await db.creativeWorkItems.put({
      id: "candidate-work", projectId: "project-1", schemaVersion: 8, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test",
      creativeRunId: runId, kind: "chapter-workflow", status: "completed", targetId: "chapter-1", instruction: "评测", parameters: { closedLoopCandidate: candidate }, dependsOn: [], iteration: 0, artifactRefs: [candidate.id],
    });
    const artifact = await executeCreativeTool("novel_artifact_get", { projectId: "project-1", runId, artifactId: candidate.id }, { db });
    expect(artifact.result).toEqual({ kind: "closed-loop-candidate", value: candidate });
  });
});
