/**
 * V2 MCP 工具网关测试套件（Phase B-2）。
 *
 * 策略：
 * - 纯函数测试（validateToolArgs）直接运行，无外部依赖。
 * - executeTool 错误路径测试（未知工具/参数校验/handler 抛错）使用 mock ctx，无 Postgres。
 * - 集成测试（happy path）需要真实 Postgres；beforeAll 尝试连接，失败则 skip。
 *
 * AGENTS.md 合规：
 * - 跨场景 counterexample：未知工具 vs 已知工具、参数校验通过 vs 失败
 * - 根因分析：测试失败时先识别 failingLayer（路由/校验/handler），不修改 fixture 让单 sample 通过
 *
 * 实现注记：
 * - novel_project_create 的 handler 使用 idempotencyKey 作为 projectId（非 args.projectId），
 *   且 schema 设置 additionalProperties: false，因此不能在 args 中传 projectId。
 * - novel_closed_loop_run 需要 idempotencyKey 通过 ajv 校验后才能到达 handler 的 model 检查，
 *   任务示例中省略 idempotencyKey 会导致参数校验先失败，无法测到 handler 抛错。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NovelPostgresRepository } from "../postgres-repository";
import { validateToolArgs } from "../mcp/validator";
import { TOOL_NAMES, TOOL_DEFINITIONS } from "../mcp/tool-definitions";
import { buildToolArgumentSkeleton, TOOL_COUNT, TOOL_DESCRIPTIONS, TOOL_GROUPS } from "../mcp/tool-metadata";
import { executeTool } from "../mcp/index";

// ===== 测试夹具 =====

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

// mock ctx：repository.pool.query 返回空行，model=undefined
const mockCtx = {
  repository: { pool: { query: async () => ({ rows: [] }) } } as never,
  model: undefined,
};

// ===== A. 纯函数：validateToolArgs（无 Postgres 依赖）=====

describe("validateToolArgs pure function", () => {
  it("TOOL_NAMES has exactly 28 tools", () => {
    expect(TOOL_NAMES).toHaveLength(28);
  });

  it("TOOL_DEFINITIONS has 28 defs, each with name/description/inputSchema", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(28);
    for (const def of TOOL_DEFINITIONS) {
      expect(typeof def.name).toBe("string");
      expect(def.name.length).toBeGreaterThan(0);
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(typeof def.inputSchema).toBe("object");
      expect(def.inputSchema).not.toBeNull();
    }
  });

  it("shared Web metadata covers every MCP tool exactly once", () => {
    const grouped = TOOL_GROUPS.flatMap((group) => group.tools);
    expect(TOOL_COUNT).toBe(TOOL_NAMES.length);
    expect(new Set(grouped)).toEqual(new Set(TOOL_NAMES));
    expect(grouped).toHaveLength(TOOL_NAMES.length);
    for (const name of TOOL_NAMES) expect(TOOL_DESCRIPTIONS[name].full).toBe(TOOL_DEFINITIONS.find((definition) => definition.name === name)?.description);
  });

  it("derives required argument skeletons from shared JSON schemas", () => {
    expect(buildToolArgumentSkeleton("novel_chapter_review")).toEqual({
      projectId: "",
      documentId: "",
      idempotencyKey: "",
    });
    expect(buildToolArgumentSkeleton("novel_rule_evidence_submit")).toMatchObject({
      projectId: "",
      candidateId: "",
      scenarioClass: "",
      scenarioRole: "source-failure",
    });
  });

  it("unknown tool → valid=false", () => {
    const result = validateToolArgs("nonexistent_tool", {});
    expect(result.valid).toBe(false);
  });

  describe("novel_project_create", () => {
    it("valid args → valid=true", () => {
      const result = validateToolArgs("novel_project_create", {
        premise: "一个失去记忆的法医发现每具尸体都认识自己",
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(true);
    });

    it("missing premise → valid=false", () => {
      const result = validateToolArgs("novel_project_create", {
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(false);
    });

    it("empty premise → valid=false", () => {
      const result = validateToolArgs("novel_project_create", {
        premise: "",
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("novel_run_create", () => {
    it("valid args → valid=true", () => {
      const result = validateToolArgs("novel_run_create", {
        projectId: "p-1",
        mode: "chapter",
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(true);
    });

    it("invalid mode → valid=false", () => {
      const result = validateToolArgs("novel_run_create", {
        projectId: "p-1",
        mode: "invalid",
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("novel_closed_loop_run", () => {
    it("valid args → valid=true", () => {
      const result = validateToolArgs("novel_closed_loop_run", {
        projectId: "p-1",
        documentId: "d-1",
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(true);
    });

    it("missing documentId → valid=false", () => {
      const result = validateToolArgs("novel_closed_loop_run", {
        projectId: "p-1",
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("novel_review_submit", () => {
    it("valid args → valid=true", () => {
      const result = validateToolArgs("novel_review_submit", {
        runId: "r-1",
        workItemId: "w-1",
        review: {
          subjectArtifactId: "a-1",
          reviewer: "internal",
          verdict: "passed",
          issues: [],
          summary: "ok",
        },
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(true);
    });

    it("invalid verdict → valid=false", () => {
      const result = validateToolArgs("novel_review_submit", {
        runId: "r-1",
        workItemId: "w-1",
        review: {
          subjectArtifactId: "a-1",
          reviewer: "internal",
          verdict: "invalid",
          issues: [],
          summary: "ok",
        },
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(false);
    });
  });
});

// ===== B. executeTool 路由（无 Postgres 依赖，测错误路径）=====

describe("executeTool error paths", () => {
  it("unknown tool → isError=true, content contains '未知工具'", async () => {
    const result = await executeTool("nonexistent", {}, mockCtx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("未知工具");
  });

  it("invalid args → isError=true, content contains '参数校验失败'", async () => {
    // novel_project_create 需要 title + idempotencyKey，传空对象
    const result = await executeTool("novel_project_create", {}, mockCtx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("参数校验失败");
  });

  it("handler throws (novel_closed_loop_run without model) → isError=true, content contains 'model'", async () => {
    // 需要 idempotencyKey 通过 ajv 校验后才能到达 handler 的 model 检查
    const result = await executeTool(
      "novel_closed_loop_run",
      { projectId: "p1", documentId: "d1", idempotencyKey: "k1" },
      mockCtx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("model");
  });

  it("novel_chapter_review persists and starts one Temporal workflow with the same id", async () => {
    const putWorkflowRun = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockResolvedValue({ firstExecutionRunId: "temporal-run-1" });
    const result = await executeTool(
      "novel_chapter_review",
      { projectId: "p1", documentId: "d1", idempotencyKey: "review-1" },
      {
        repository: { getChapterReviewPreflight: vi.fn().mockResolvedValue({ status: "final", baseRevision: 1, hasBlueprint: true }), putWorkflowRun } as never,
        temporal: { workflow: { start } } as never,
        taskQueue: "novel-v2",
      },
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("accepted");
    expect(putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ temporalWorkflowId: payload.workflowId, workflowType: "chapter-review" }));
    expect(start).toHaveBeenCalledWith("chapterReviewWorkflow", expect.objectContaining({
      workflowId: payload.workflowId,
      args: [expect.objectContaining({ projectId: "p1", documentId: "d1", workflowId: payload.workflowId })],
    }));
  });
});

// ===== C. 集成测试：executeTool happy path（需 Postgres）=====

describe("mcp-tool-gateway integration", () => {
  let repository: NovelPostgresRepository;
  let postgresAvailable = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.pool.query("SELECT 1");
      await repository.migrate();
      postgresAvailable = true;
    } catch (error) {
      console.warn(`[mcp-tool-gateway.test] Postgres 不可用: ${(error as Error).message}`);
    }
  }, 30000);

  afterAll(async () => {
    if (repository) await repository.close();
  });

  (postgresAvailable ? describe : describe.skip)("with postgres", () => {
    it("novel_project_create happy path", async () => {
      // handler 使用 idempotencyKey 作为 projectId（schema additionalProperties: false 禁止传 projectId）
      const projectId = `mcp-test-${randomUUID().slice(0, 8)}`;
      const result = await executeTool(
        "novel_project_create",
        { title: "MCP 测试项目", idempotencyKey: projectId },
        { repository },
      );
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text);
      expect(payload.project.id).toBe(projectId);
    });

    it("novel_run_create happy path", async () => {
      const projectId = `mcp-run-${randomUUID().slice(0, 8)}`;
      await repository.ensureProject(projectId, "Run Test");
      const result = await executeTool(
        "novel_run_create",
        { projectId, mode: "chapter", idempotencyKey: `k-${Date.now()}` },
        { repository },
      );
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text);
      expect(payload.run.projectId).toBe(projectId);
      expect(payload.run.status).toBe("pending");
    });

    it("novel_project_list happy path", async () => {
      // 先创建一个项目保证列表非空
      const projectId = `mcp-list-${randomUUID().slice(0, 8)}`;
      await repository.ensureProject(projectId, "List Test");
      const result = await executeTool("novel_project_list", {}, { repository });
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text);
      expect(Array.isArray(payload.projects)).toBe(true);
      expect(payload.projects.some((p: { id: string }) => p.id === projectId)).toBe(true);
    });

    it("novel_artifact_get non-existent → isError=true", async () => {
      const result = await executeTool(
        "novel_artifact_get",
        { artifactId: "nonexistent" },
        { repository },
      );
      expect(result.isError).toBe(true);
    });
  });
});
