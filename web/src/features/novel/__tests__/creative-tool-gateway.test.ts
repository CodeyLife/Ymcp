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

  it("novel_project_create creates a project that novel_project_list can see and novel_project_delete can remove", async () => {
    const created = await executeCreativeTool("novel_project_create", {
      idempotencyKey: "create-wuxia",
      title: "剑啸江湖",
      premise: "少年剑客入江湖复仇，与各方势力周旋",
      genre: ["武侠", "江湖"],
    }, { db });
    const projectId = (created.result as { id: string }).id;
    expect(projectId).toBeTruthy();

    const list = await executeCreativeTool("novel_project_list", {}, { db });
    const projects = (list.result as { projects: Array<{ id: string; title: string }> }).projects;
    expect(projects.some((project) => project.id === projectId && project.title === "剑啸江湖")).toBe(true);

    // 幂等：相同 idempotencyKey+title+premise+genre 重复调用返回同一 projectId
    const second = await executeCreativeTool("novel_project_create", {
      idempotencyKey: "create-wuxia",
      title: "剑啸江湖",
      premise: "少年剑客入江湖复仇，与各方势力周旋",
      genre: ["武侠", "江湖"],
    }, { db });
    expect((second.result as { id: string }).id).toBe(projectId);

    // novel_receipt_get 对 GLOBAL_SCOPE 工具使用 "__global__" 作为 projectId
    const receipt = await executeCreativeTool("novel_receipt_get", { targetTool: "novel_project_create", idempotencyKey: "create-wuxia" }, { db });
    expect(receipt.result).toMatchObject({ tool: "novel_project_create", status: "completed" });

    // 删除
    const deleted = await executeCreativeTool("novel_project_delete", { projectId, idempotencyKey: "delete-wuxia" }, { db });
    expect((deleted.result as { deleted: boolean }).deleted).toBe(true);
    const listAfterDelete = await executeCreativeTool("novel_project_list", {}, { db });
    const projectsAfterDelete = (listAfterDelete.result as { projects: Array<{ id: string }> }).projects;
    expect(projectsAfterDelete.some((project) => project.id === projectId)).toBe(false);
  });

  it("novel_project_create rejects invalid genre input", async () => {
    await expect(executeCreativeTool("novel_project_create", {
      idempotencyKey: "create-bad",
      title: "无效",
      premise: "测试",
      genre: "武侠" as unknown as string[],
    }, { db })).rejects.toThrow("genre 必须是字符串数组");
    await expect(executeCreativeTool("novel_project_create", {
      idempotencyKey: "create-bad-empty",
      title: "无效",
      premise: "测试",
      genre: [],
    }, { db })).rejects.toThrow("genre 不能为空");
  });

  it("novel_bootstrap_run enqueues foundation+planning work items with proper dependency chain", async () => {
    const created = await executeCreativeTool("novel_project_create", {
      idempotencyKey: "create-bootstrap",
      title: "测试 bootstrap",
      premise: "测试用",
      genre: ["测试"],
    }, { db });
    const projectId = (created.result as { id: string }).id;

    const bootstrap = await executeCreativeTool("novel_bootstrap_run", {
      projectId,
      idempotencyKey: "bootstrap-1",
      objective: "构建跨阶段保持一致的群像悬疑，并将总篇幅规划为长篇体量",
    }, { db });
    const snapshot = bootstrap.result as { run: { id: string; status: string }; workItems: Array<{ id: string; taskKey: string; status: string; dependsOn: string[]; instruction: string }> };
    expect(snapshot.run.status).toBe("running");
    // 默认 chain 是 10 个任务（不含 chapter-plan）
    expect(snapshot.workItems).toHaveLength(10);
    const taskKeySet = new Set(snapshot.workItems.map((work) => work.taskKey));
    expect(taskKeySet).toEqual(new Set([
      "project-positioning", "architecture", "characters", "relations", "worldview",
      "plot-threads", "foreshadowing", "timeline", "story-control", "plot-design",
    ]));
    // 验证依赖链：architecture 依赖 project-positioning
    const workByTask = Object.fromEntries(snapshot.workItems.map((work) => [work.taskKey, work])) as Record<string, { id: string; dependsOn: string[] }>;
    expect(workByTask["architecture"].dependsOn).toEqual([workByTask["project-positioning"].id]);
    expect(workByTask["plot-threads"].dependsOn).toEqual(expect.arrayContaining([
      workByTask["architecture"].id, workByTask["characters"].id, workByTask["relations"].id,
    ]));
    expect(workByTask["plot-design"].dependsOn).toEqual(expect.arrayContaining([
      workByTask["plot-threads"].id, workByTask["foreshadowing"].id, workByTask["timeline"].id,
    ]));
    // 全部任务初始为 queued
    expect(snapshot.workItems.every((work) => work.status === "queued")).toBe(true);
    expect(snapshot.workItems.every((work) => work.instruction.includes("构建跨阶段保持一致的群像悬疑，并将总篇幅规划为长篇体量"))).toBe(true);
    expect(snapshot.workItems.every((work) => work.instruction.includes("不得用阶段默认值覆盖明确的项目目标"))).toBe(true);
  });

  it("novel_bootstrap_run with includeChapterPlan enqueues 11 tasks and chapter-plan depends on plot-design", async () => {
    const created = await executeCreativeTool("novel_project_create", {
      idempotencyKey: "create-bootstrap-cp",
      title: "测试 bootstrap + chapter-plan",
      premise: "测试用",
      genre: ["测试"],
    }, { db });
    const projectId = (created.result as { id: string }).id;

    const bootstrap = await executeCreativeTool("novel_bootstrap_run", {
      projectId,
      idempotencyKey: "bootstrap-cp-1",
      includeChapterPlan: true,
    }, { db });
    const snapshot = bootstrap.result as { workItems: Array<{ id: string; taskKey: string; dependsOn: string[] }> };
    expect(snapshot.workItems).toHaveLength(11);
    const workByTask = Object.fromEntries(snapshot.workItems.map((work) => [work.taskKey, work])) as Record<string, { id: string; dependsOn: string[] }>;
    expect(workByTask["chapter-plan"].dependsOn).toEqual([workByTask["plot-design"].id]);
  });

  it("novel_foundation_export returns structured foundation snapshot with all 9 sections", async () => {
    const created = await executeCreativeTool("novel_project_create", {
      idempotencyKey: "create-export",
      title: "测试导出",
      premise: "测试用",
      genre: ["测试"],
    }, { db });
    const projectId = (created.result as { id: string }).id;

    const exportResult = await executeCreativeTool("novel_foundation_export", { projectId }, { db });
    const exported = exportResult.result as {
      project: { id: string; title: string; premise: string };
      architecture: { framework: string; status: string; centralQuestion: string } | null;
      characters: unknown[];
      relations: unknown[];
      plotThreads: unknown[];
      foreshadowing: unknown[];
      outlineNodes: unknown[];
      documents: unknown[];
      timelineEvents: unknown[];
      entityIndex: unknown[];
    };
    expect(exported.project.id).toBe(projectId);
    expect(exported.project.title).toBe("测试导出");
    // createNovelProject 会自动创建一个 architecture 记录
    expect(exported.architecture).not.toBeNull();
    expect(exported.architecture?.framework).toBe("free");
    expect(exported.architecture?.centralQuestion).toBe("测试用");
    // 空项目其它字段应该是空数组
    expect(exported.characters).toEqual([]);
    expect(exported.relations).toEqual([]);
    expect(exported.plotThreads).toEqual([]);
    expect(exported.foreshadowing).toEqual([]);
    expect(exported.outlineNodes).toEqual([]);
    expect(exported.documents).toEqual([]);
    expect(exported.timelineEvents).toEqual([]);
    expect(exported.entityIndex).toEqual([]);
  });

  it("novel_foundation_export rejects for nonexistent project", async () => {
    await expect(executeCreativeTool("novel_foundation_export", { projectId: "does-not-exist" }, { db }))
      .rejects.toThrow("项目不存在");
  });

  it("novel_chapter_review rejects for nonexistent project", async () => {
    await expect(executeCreativeTool("novel_chapter_review", { projectId: "does-not-exist", documentId: "doc-1", idempotencyKey: "review-missing" }, { db }))
      .rejects.toThrow("章节或项目不存在");
  });

  it("novel_chapter_review rejects non-final chapters and surfaces startChapterReviewWorkflow precondition errors", async () => {
    // 使用 beforeEach 中已创建的 project-1，新建一个 outline 状态的章节
    const documentId = `doc-${crypto.randomUUID()}`;
    await db.documents.put({
      id: documentId, projectId: "project-1", schemaVersion: 8, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test",
      plotSegmentId: undefined, title: "未定稿章节", summary: "", order: 1, status: "outline", contentHtml: "", plainText: "", blueprint: null as never, wordCount: 0, branch: "main", yjsDocumentId: `yjs-${documentId}`,
    });
    // startChapterReviewWorkflow 对非 final 章节抛错
    await expect(executeCreativeTool("novel_chapter_review", { projectId: "project-1", documentId, idempotencyKey: "review-non-final" }, { db }))
      .rejects.toThrow(/仅对已定稿章节开放/);
  });
});
