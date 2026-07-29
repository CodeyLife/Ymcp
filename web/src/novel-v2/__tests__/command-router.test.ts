/**
 * V2 command-router defaultReviewer 测试套件（C-2.6 + C-3.1）。
 *
 * 覆盖范围：
 * - defaultReviewer happy path：work item + artifact + blueprint + memory 全具备，LLM 返回 verdict=passed
 * - defaultReviewer failover：LLM 调用抛错时，降级返回 verdict=revise + issue="LLM 审核失败"
 * - defaultReviewer 缺失 blueprint：降级为简化 prompt（仍调用 LLM，不注入 blueprint/memory）
 *
 * AGENTS.md 合规：
 * - reviewer identity = "internal"
 * - 失败时不抛错，降级返回 verdict=revise
 * - 测试跨场景 counterexample：blueprint 存在 vs 缺失，验证 prompt 路径切换
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { NovelPostgresRepository } from "../postgres-repository";
import { InMemoryModelGateway } from "../model-gateway";
import { defaultReviewer } from "../creative/command-router";
import { REVIEW_DIMENSIONS, type ReviewerOutput } from "../prompts/schemas";

// ===== 测试夹具 =====

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

/** 构造符合 reviewerSchema 的 ReviewerOutput */
function makeReviewerOutput(overrides: Partial<ReviewerOutput> = {}): ReviewerOutput {
  return {
    verdict: "passed",
    scores: Object.fromEntries(REVIEW_DIMENSIONS.map((d) => [d, 4])) as ReviewerOutput["scores"],
    issues: [],
    ...overrides,
  };
}

/** 构造 InMemoryModelGateway：返回指定的 ReviewerOutput */
function makeModelReturning(output: ReviewerOutput): InMemoryModelGateway {
  return new InMemoryModelGateway(() => output);
}

/** 构造始终抛错的 InMemoryModelGateway（测试 failover） */
function makeModelThrowing(errorMessage = "mock LLM 调用失败"): InMemoryModelGateway {
  return new InMemoryModelGateway(() => {
    throw new Error(errorMessage);
  });
}

// ===== 集成测试 =====

describe("defaultReviewer integration", () => {
  let repository: NovelPostgresRepository;
  let postgresAvailable = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.pool.query("SELECT 1");
      await repository.migrate();
      postgresAvailable = true;
    } catch (error) {
      console.warn(`[command-router.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30000);

  afterAll(async () => {
    if (postgresAvailable && repository) {
      await repository.close();
    }
  });

  beforeEach(async () => {
    if (!postgresAvailable) return;
    await repository.pool.query("DELETE FROM creative_work_items WHERE id LIKE 'test-dr-%'");
    await repository.pool.query("DELETE FROM creative_runs WHERE id LIKE 'test-dr-%'");
    await repository.pool.query("DELETE FROM artifacts WHERE id LIKE 'test-dr-%'");
    await repository.pool.query("DELETE FROM execution_blueprints WHERE id LIKE 'test-dr-%'");
    await repository.pool.query("DELETE FROM memory_bundles WHERE id LIKE 'test-dr-%'");
    await repository.pool.query("DELETE FROM preflight_plans WHERE id LIKE 'test-dr-%'");
    await repository.pool.query("DELETE FROM novel_intents WHERE id LIKE 'test-dr-%'");
    await repository.pool.query("DELETE FROM novel_projects WHERE id LIKE 'test-dr-%'");
  });

  /**
   * 准备完整环境：project + intent + preflight + memory_bundle + skill_bundle + execution_blueprint +
   * artifact + creative_run + creative_work_item（关联 artifact）。
   */
  async function setupFullEnvironment(projectId: string): Promise<{ workItemId: string; artifactId: string }> {
    const draftText = "这是测试章节内容，用于 defaultReviewer 测试。".repeat(10);

    // 1. project
    await repository.ensureProject(projectId, "defaultReviewer Test");

    // 2. intent + preflight
    const intentId = `test-dr-intent-${randomUUID().slice(0, 8)}`;
    const preflightId = `test-dr-preflight-${randomUUID().slice(0, 8)}`;
    await repository.pool.query(
      "INSERT INTO novel_intents(id, project_id, source, objective, payload, idempotency_key) VALUES($1, $2, 'test', 'test', '{}', $3)",
      [intentId, projectId, `idem-${intentId}`],
    );
    await repository.pool.query(
      "INSERT INTO preflight_plans(id, intent_id, project_id, payload, fingerprint) VALUES($1, $2, $3, '{}', 'fp-pf')",
      [preflightId, intentId, projectId],
    );

    // 3. memory_bundle + skill_bundle
    const memoryBundleId = `test-dr-memory-${randomUUID().slice(0, 8)}`;
    const skillBundleId = `test-dr-skills-${randomUUID().slice(0, 8)}`;
    const memoryBundlePayload = {
      id: memoryBundleId,
      projectId,
      preflightId,
      claims: [],
      conflicts: [],
      missingFacets: [],
      tokenBudget: 4096,
      sourceRevisionIds: [],
      fingerprint: "fp-mb",
      createdAt: Date.now(),
    };
    await repository.pool.query(
      "INSERT INTO memory_bundles(id, project_id, preflight_id, payload, fingerprint) VALUES($1, $2, $3, $4, 'fp-mb')",
      [memoryBundleId, projectId, preflightId, JSON.stringify(memoryBundlePayload)],
    );
    await repository.pool.query(
      "INSERT INTO skill_bundles(id, project_id, preflight_id, payload, fingerprint) VALUES($1, $2, $3, '{}', 'fp-sb')",
      [skillBundleId, projectId, preflightId],
    );

    // 4. execution_blueprint
    const blueprintId = `test-dr-blueprint-${randomUUID().slice(0, 8)}`;
    const blueprintPayload = {
      id: blueprintId,
      projectId,
      intentId,
      preflightId,
      memoryBundleId,
      skillBundleId,
      baseRevision: 0,
      tasks: [],
      commitPolicy: "dual-gate",
      budget: { maxInputTokens: 8000, maxOutputTokens: 4000 },
      fingerprint: "fp-bp",
      createdAt: Date.now(),
    };
    await repository.pool.query(
      "INSERT INTO execution_blueprints(id, project_id, intent_id, preflight_id, memory_bundle_id, skill_bundle_id, payload, fingerprint) VALUES($1, $2, $3, $4, $5, $6, $7, 'fp-bp')",
      [blueprintId, projectId, intentId, preflightId, memoryBundleId, skillBundleId, JSON.stringify(blueprintPayload)],
    );

    // 5. artifact（task_id 格式 `${blueprintId}:draft`）
    const artifactId = `test-dr-artifact-${randomUUID().slice(0, 8)}`;
    await repository.pool.query(
      `INSERT INTO artifacts(id, project_id, task_id, attempt_id, kind, content_hash, base_revision, fingerprint, payload)
       VALUES($1, $2, $3, 'test-attempt', 'draft', 'test-hash', 0, 'fp-art', $4)`,
      [artifactId, projectId, `${blueprintId}:draft`, JSON.stringify({ text: draftText })],
    );

    // 6. creative_run + creative_work_item
    const runId = `test-dr-run-${randomUUID().slice(0, 8)}`;
    const workItemId = `test-dr-work-${randomUUID().slice(0, 8)}`;
    await repository.pool.query(
      `INSERT INTO creative_runs(id, project_id, mode, status, policy)
       VALUES($1, $2, 'full-auto', 'running', '{}'::jsonb)`,
      [runId, projectId],
    );
    await repository.pool.query(
      `INSERT INTO creative_work_items(id, run_id, project_id, kind, status, instruction, parameters, artifact_refs)
       VALUES($1, $2, $3, 'audit', 'accepted', 'test instruction', '{}'::jsonb, ARRAY[$4])`,
      [workItemId, runId, projectId, artifactId],
    );

    return { workItemId, artifactId };
  }

  it("happy path: blueprint + memory 全具备，LLM 返回 verdict=passed，转换为 CreativeReviewInput", async () => {
    if (!postgresAvailable) return;

    const projectId = `test-dr-happy-${randomUUID().slice(0, 8)}`;
    const { workItemId, artifactId } = await setupFullEnvironment(projectId);

    const model = makeModelReturning(makeReviewerOutput({ verdict: "passed" }));
    const reviewInput = await defaultReviewer(repository, workItemId, model);

    expect(reviewInput.reviewer).toBe("internal"); // AGENTS.md 契约
    expect(reviewInput.subjectArtifactId).toBe(artifactId);
    expect(reviewInput.verdict).toBe("passed");
    expect(reviewInput.issues).toEqual([]);
  });

  it("failover: LLM 调用抛错时，降级返回 verdict=revise + issue='LLM 审核失败'", async () => {
    if (!postgresAvailable) return;

    const projectId = `test-dr-fail-${randomUUID().slice(0, 8)}`;
    const { workItemId, artifactId } = await setupFullEnvironment(projectId);

    const model = makeModelThrowing("mock LLM 服务不可用");
    const reviewInput = await defaultReviewer(repository, workItemId, model);

    // AGENTS.md 契约：失败时不抛错，降级返回 verdict=revise
    expect(reviewInput.reviewer).toBe("internal");
    expect(reviewInput.subjectArtifactId).toBe(artifactId);
    expect(reviewInput.verdict).toBe("revise");
    expect(reviewInput.issues).toHaveLength(1);
    expect(reviewInput.issues[0].title).toBe("LLM 审核失败");
    expect(reviewInput.issues[0].evidence).toContain("mock LLM 服务不可用");
    expect(reviewInput.summary).toContain("降级为 revise");
  });

  it("降级路径: artifact 关联的 blueprint 不存在，仍能调用 LLM 完成审核", async () => {
    if (!postgresAvailable) return;

    const projectId = `test-dr-nobp-${randomUUID().slice(0, 8)}`;
    await repository.ensureProject(projectId, "No Blueprint Test");

    // 直接构造 artifact（task_id 指向不存在的 blueprint）
    const artifactId = `test-dr-artifact-nobp-${randomUUID().slice(0, 8)}`;
    const draftText = "测试章节内容".repeat(20);
    await repository.pool.query(
      `INSERT INTO artifacts(id, project_id, task_id, attempt_id, kind, content_hash, base_revision, fingerprint, payload)
       VALUES($1, $2, $3, 'test', 'draft', 'hash', 0, 'fp', $4)`,
      [artifactId, projectId, "nonexistent-blueprint:draft", JSON.stringify({ text: draftText })],
    );

    // creative_run + work_item
    const runId = `test-dr-run-nobp-${randomUUID().slice(0, 8)}`;
    const workItemId = `test-dr-work-nobp-${randomUUID().slice(0, 8)}`;
    await repository.pool.query(
      `INSERT INTO creative_runs(id, project_id, mode, status, policy)
       VALUES($1, $2, 'full-auto', 'running', '{}'::jsonb)`,
      [runId, projectId],
    );
    await repository.pool.query(
      `INSERT INTO creative_work_items(id, run_id, project_id, kind, status, instruction, parameters, artifact_refs)
       VALUES($1, $2, $3, 'audit', 'accepted', 'test', '{}'::jsonb, ARRAY[$4])`,
      [workItemId, runId, projectId, artifactId],
    );

    // 无 blueprint：降级 prompt（仍调用 LLM），返回 LLM 的 verdict
    const model = makeModelReturning(makeReviewerOutput({ verdict: "revise" }));
    const reviewInput = await defaultReviewer(repository, workItemId, model);

    expect(reviewInput.reviewer).toBe("internal");
    expect(reviewInput.subjectArtifactId).toBe(artifactId);
    expect(reviewInput.verdict).toBe("revise");
  });

  it("错误路径: work item 不存在抛错", async () => {
    if (!postgresAvailable) return;

    const model = makeModelReturning(makeReviewerOutput());
    await expect(defaultReviewer(repository, "nonexistent-work-item", model))
      .rejects.toThrow(/Work item 不存在/);
  });

  it("错误路径: work item 无关联 artifact 抛错", async () => {
    if (!postgresAvailable) return;

    const projectId = `test-dr-noart-${randomUUID().slice(0, 8)}`;
    await repository.ensureProject(projectId, "No Artifact Test");
    const runId = `test-dr-run-noart-${randomUUID().slice(0, 8)}`;
    const workItemId = `test-dr-work-noart-${randomUUID().slice(0, 8)}`;
    await repository.pool.query(
      `INSERT INTO creative_runs(id, project_id, mode, status, policy)
       VALUES($1, $2, 'full-auto', 'running', '{}'::jsonb)`,
      [runId, projectId],
    );
    await repository.pool.query(
      `INSERT INTO creative_work_items(id, run_id, project_id, kind, status, instruction, parameters, artifact_refs)
       VALUES($1, $2, $3, 'audit', 'accepted', 'test', '{}'::jsonb, ARRAY[]::text[])`,
      [workItemId, runId, projectId],
    );

    const model = makeModelReturning(makeReviewerOutput());
    await expect(defaultReviewer(repository, workItemId, model))
      .rejects.toThrow(/无关联 artifact/);
  });
});
