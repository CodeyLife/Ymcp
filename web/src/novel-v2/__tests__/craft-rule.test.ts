/**
 * V2 Craft-Rule 候选演进模块测试。
 *
 * 覆盖范围（C-2.8 + C-3.1 合并）：
 * - 纯函数：nextPatchVersion 版本号递增逻辑
 * - 集成测试（需 Postgres）：
 *   - skill target happy path：create → inspect → recordEvidence → submitReview → promote → rollback
 *   - system-prompt target happy path（C-2.7 新增）：create → promote → rollback
 *   - 错误路径：afterText 太短、scope 必填字段缺失、状态转换非法、stale-target-version
 *
 * AGENTS.md 合规：
 * - 测试跨场景 counterexample：system-prompt vs skill target 对照
 * - 回归验证失败时自动 rollback
 * - 不依赖 IndexedDB，纯 Postgres
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { NovelPostgresRepository } from "../postgres-repository";
import { InMemoryModelGateway } from "../model-gateway";
import {
  createCraftRuleCandidate,
  inspectCraftRuleCandidate,
  evaluateCraftRuleOnFoundation,
  submitCraftRuleReview,
  promoteCraftRuleCandidate,
  rollbackCraftRuleCandidate,
  nextPatchVersion,
  type CraftRuleScopeAnalysis,
} from "../craft-rule";

/**
 * 基础任务评估结果类型（与 craft-rule/index.ts 内部 FoundationEvaluationResult 一致）。
 * runFoundationTaskWithPrompt 期望返回该结构。
 */
interface FoundationEvaluationResult {
  qualityScore: number;
  blockerCount: number;
  majorCount: number;
  summary: string;
  output: string;
}

// ===== 测试夹具 =====

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

function makeScope(overrides: Partial<CraftRuleScopeAnalysis> = {}): CraftRuleScopeAnalysis {
  return {
    observedSymptom: "节奏拖沓：第二段描写过长",
    failingLayer: "skill-prompt：缺少段落长度约束",
    underlyingMechanism: "skill prompt 未声明段落长度上限，LLM 默认倾向冗长描写",
    affectedInputClass: "drafting-stage 的所有章节生成",
    intendedBenefits: ["增加段落长度约束", "减少节奏拖沓问题"],
    boundaries: ["仅适用于 drafting", "不适用于 revision"],
    nonGoals: ["不解决角色塑造问题"],
    regressionRisks: ["段落过短可能影响细节描写"],
    ...overrides,
  };
}

/**
 * 构造 InMemoryModelGateway：runFoundationTaskWithPrompt 期望返回符合 FoundationEvaluationResult schema 的对象。
 * baselineScore < candidateScore，确保 promote 的回归验证通过。
 */
function makeModelWithScoreDelta(baselineScore = 70, candidateScore = 85): InMemoryModelGateway {
  return new InMemoryModelGateway((input) => {
    const candidatePrompt = input.system?.includes("优化") ?? false;
    const score = candidatePrompt ? candidateScore : baselineScore;
    const result: FoundationEvaluationResult = {
      qualityScore: score,
      blockerCount: 0,
      majorCount: candidatePrompt ? 1 : 2,
      summary: `${candidatePrompt ? "candidate" : "baseline"} score=${score}`,
      output: "示例基础任务产出",
    };
    return result;
  });
}

/** 构造回归验证失败的 model：candidateScore 显著高于 newScore（重跑结果） */
function makeModelWithRegressionFailure(): InMemoryModelGateway {
  let candidateCalls = 0;
  return new InMemoryModelGateway((input) => {
    const candidatePrompt = (input.system?.length ?? 0) >= 100;
    if (candidatePrompt) candidateCalls += 1;
    const score = !candidatePrompt ? 70 : candidateCalls <= 2 ? 85 : 60;
    const result: FoundationEvaluationResult = {
      qualityScore: score,
      blockerCount: 0,
      majorCount: 1,
      summary: `${candidatePrompt ? "candidate" : "baseline"}#${candidateCalls} score=${score}`,
      output: "示例基础任务产出",
    };
    return result;
  });
}

// ===== 纯函数测试 =====

describe("craft-rule pure functions", () => {
  describe("nextPatchVersion", () => {
    it("递增标准 semver patch 号", () => {
      expect(nextPatchVersion("1.0.0")).toBe("1.0.1");
      expect(nextPatchVersion("2.3.4")).toBe("2.3.5");
      expect(nextPatchVersion("0.0.0")).toBe("0.0.1");
    });

    it("保留 v 前缀风格", () => {
      expect(nextPatchVersion("v1.0.0")).toBe("v1.0.1");
      expect(nextPatchVersion("v2.3.4")).toBe("v2.3.5");
    });

    it("空值/空白回退为 0.0.1", () => {
      expect(nextPatchVersion(null)).toBe("0.0.1");
      expect(nextPatchVersion(undefined)).toBe("0.0.1");
      expect(nextPatchVersion("")).toBe("0.0.1");
      expect(nextPatchVersion("   ")).toBe("0.0.1");
    });

    it("非数字 patch 段回退为 0", () => {
      expect(nextPatchVersion("1.0.x")).toBe("1.0.1");
      expect(nextPatchVersion("v1.2.abc")).toBe("v1.2.1");
    });

    it("AGENTS.md 契约：跨格式一致性（相同逻辑，不同前缀）", () => {
      const noPrefix = nextPatchVersion("1.5.3");
      const withPrefix = nextPatchVersion("v1.5.3");
      expect(noPrefix).toBe("1.5.4");
      expect(withPrefix).toBe("v1.5.4");
    });
  });
});

// ===== 集成测试（需 Postgres）=====

describe("craft-rule integration", () => {
  let repository: NovelPostgresRepository;
  let postgresAvailable = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.pool.query("SELECT 1");
      await repository.migrate();
      postgresAvailable = true;
    } catch (error) {
      console.warn(`[craft-rule.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30000);

  afterAll(async () => {
    if (postgresAvailable && repository) {
      await repository.close();
    }
  });

  beforeEach(async () => {
    if (!postgresAvailable) return;
    // 清理测试数据，避免污染
    await repository.pool.query("DELETE FROM craft_rule_candidates WHERE project_id LIKE 'test-craft-%'");
    await repository.pool.query("DELETE FROM prompt_templates WHERE project_id LIKE 'test-craft-%'");
  });

  // ===== skill target happy path =====

  it("skill target happy path: create → inspect → recordEvidence → evaluate → review → promote → rollback", async () => {
    if (!postgresAvailable) return;

    // 准备：创建项目 + skill_definition
    const projectId = `test-craft-skill-${randomUUID().slice(0, 8)}`;
    await repository.ensureProject(projectId, "Craft Rule Skill Test");
    const skillId = "test-craft-skill";
    const beforeText = JSON.stringify({ drafting: "原始 skill prompt" });
    await repository.pool.query(
      `INSERT INTO skill_definitions(skill_id, version, prompt_sections)
       VALUES($1, '1.0.0', $2::jsonb)
       ON CONFLICT(skill_id) DO UPDATE SET version = EXCLUDED.version, prompt_sections = EXCLUDED.prompt_sections`,
      [skillId, beforeText],
    );

    const afterText = JSON.stringify({ drafting: `优化后的 skill prompt：${"按场景节奏控制段落长度并保留必要细节；".repeat(8)}` });

    // 1. createCraftRuleCandidate
    const candidate = await createCraftRuleCandidate(repository, {
      projectId,
      targetKind: "skill",
      targetId: skillId,
      afterText,
      rationale: "解决节奏拖沓问题",
      scope: makeScope(),
    });
    expect(candidate.status).toBe("proposed");
    expect(candidate.beforeVersion).toBe("1.0.0");
    expect(candidate.proposedVersion).toBe("1.0.1");
    expect(candidate.beforeText).toBe(beforeText);
    expect(candidate.afterText).toBe(afterText);

    // 2. inspectCraftRuleCandidate
    const inspected = await inspectCraftRuleCandidate(repository, projectId, candidate.id);
    expect(inspected?.id).toBe(candidate.id);

    // 3. evaluateCraftRuleOnFoundation（替代 recordCraftRuleEvidence，直接构造 evidenceCase）
    const model = makeModelWithScoreDelta(70, 85);
    const { evidence, observations } = await evaluateCraftRuleOnFoundation(repository, model, {
      projectId,
      candidateId: candidate.id,
      taskKey: "project-positioning",
      scenarioClass: "现代都市小说",
      scenarioRole: "source-failure",
    });
    expect(evidence.baselineScore).toBe(70);
    expect(evidence.candidateScore).toBe(85);
    expect(evidence.taskKey).toBe("project-positioning");
    expect(observations.scoreDelta).toBe(15);
    await evaluateCraftRuleOnFoundation(repository, model, {
      projectId,
      candidateId: candidate.id,
      taskKey: "worldview",
      scenarioClass: "古代权谋小说",
      scenarioRole: "cross-scenario",
    });

    // 4. submitCraftRuleReview
    const reviewed = await submitCraftRuleReview(repository, {
      projectId,
      candidateId: candidate.id,
      role: "internal-reviewer",
      reviewerId: "test-reviewer",
      reviewRunId: `run-${randomUUID().slice(0, 8)}`,
      model: "in-memory",
      verdict: "passed",
      summary: "候选改进有效",
      concerns: [],
    });
    expect(reviewed.status).toBe("reviewing");
    expect(reviewed.reviews).toHaveLength(1);
    expect(reviewed.reviews[0].verdict).toBe("passed");

    // 5. promoteCraftRuleCandidate（含回归验证）
    const promoted = await promoteCraftRuleCandidate(repository, model, {
      projectId,
      candidateId: candidate.id,
    });
    expect(promoted.candidate.status).toBe("promoted");
    expect(promoted.receipt.status).toBe("promoted");
    expect(promoted.regressionVerified).toBe(true);
    expect(promoted.receipt.result.skillUpdates).toEqual([skillId]);

    // 验证 skill_definitions 已被更新
    const skillAfter = await repository.pool.query<{ version: string; prompt_sections: unknown }>(
      "SELECT version, prompt_sections FROM skill_definitions WHERE skill_id = $1",
      [skillId],
    );
    expect(skillAfter.rows[0].version).toBe("1.0.1");
    expect(skillAfter.rows[0].prompt_sections).toEqual(JSON.parse(afterText));

    // 6. rollbackCraftRuleCandidate
    const rolledBack = await rollbackCraftRuleCandidate(repository, model, {
      projectId,
      candidateId: candidate.id,
    });
    expect(rolledBack.candidate.status).toBe("rolled-back");

    // 验证 skill_definitions 已回滚
    const skillRolledBack = await repository.pool.query<{ version: string; prompt_sections: unknown }>(
      "SELECT version, prompt_sections FROM skill_definitions WHERE skill_id = $1",
      [skillId],
    );
    expect(skillRolledBack.rows[0].version).toBe("1.0.0");
    expect(skillRolledBack.rows[0].prompt_sections).toEqual(JSON.parse(beforeText));
  });

  it("learning assessment replay creates exactly one candidate under concurrency", async () => {
    if (!postgresAvailable) return;

    const suffix = randomUUID().slice(0, 8);
    const projectId = `test-craft-learning-${suffix}`;
    const skillId = `test-craft-learning-skill-${suffix}`;
    const assessmentId = `assessment-${suffix}`;
    await repository.ensureProject(projectId, "Craft Rule Learning Idempotency Test");
    await repository.pool.query(
      `INSERT INTO skill_definitions(skill_id, version, prompt_sections)
       VALUES($1, '1.0.0', $2::jsonb)`,
      [skillId, JSON.stringify({ drafting: "原始通用章节生成约束" })],
    );

    const input = {
      projectId,
      targetKind: "skill" as const,
      targetId: skillId,
      afterText: JSON.stringify({ drafting: `根据章节功能动态分配叙事空间，并保留必要的背景、心理和意象层次。${"通用约束；".repeat(20)}` }),
      rationale: "让章节节奏约束适用于不同章节功能",
      scope: makeScope(),
      learningSource: {
        assessmentId,
        conclusion: "propose-improvement",
        mechanism: "固定推进密度忽略了章节功能差异",
      },
    };

    const [first, second] = await Promise.all([
      createCraftRuleCandidate(repository, input),
      createCraftRuleCandidate(repository, input),
    ]);
    expect(second.id).toBe(first.id);
    const count = await repository.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM craft_rule_candidates WHERE project_id=$1 AND learning_source->>'assessmentId'=$2",
      [projectId, assessmentId],
    );
    expect(count.rows[0].count).toBe("1");
  });

  // ===== system-prompt target happy path（C-2.7 新增）=====

  it("system-prompt target happy path: create → promote → rollback", async () => {
    if (!postgresAvailable) return;

    // 准备：创建项目 + prompt_template
    const projectId = `test-craft-prompt-${randomUUID().slice(0, 8)}`;
    await repository.ensureProject(projectId, "Craft Rule Prompt Test");
    const templateId = "chapter-draft-system";
    const beforeText = "原始 system prompt，用于章节生成。";
    // afterText 长度需 >= 100
    const afterText = `优化后的 system prompt（v1.0.1）：${"详细约束：" + "段落不超过400字，节奏紧凑；".repeat(8)}`;

    await repository.pool.query(
      `INSERT INTO prompt_templates(id, project_id, template_id, version, content, stages, content_fingerprint, enabled)
       VALUES($1, $2, $3, '1.0.0', $4, ARRAY['drafting'], md5($4), TRUE)
       ON CONFLICT(project_id, template_id) DO UPDATE SET version = EXCLUDED.version, content = EXCLUDED.content`,
      [`pt-${projectId}-${templateId}`, projectId, templateId, beforeText],
    );

    // 1. createCraftRuleCandidate（targetId 仅传 templateId，fallback 到 projectId）
    const candidate = await createCraftRuleCandidate(repository, {
      projectId,
      targetKind: "system-prompt",
      targetId: templateId,
      afterText,
      rationale: "优化章节生成 prompt",
      scope: makeScope({
        observedSymptom: "system prompt 缺少段落长度约束",
        failingLayer: "system-prompt：缺少节奏约束",
      }),
    });
    expect(candidate.status).toBe("proposed");
    expect(candidate.beforeVersion).toBe("1.0.0");
    expect(candidate.proposedVersion).toBe("1.0.1");
    expect(candidate.beforeText).toBe(beforeText);
    expect(candidate.afterText).toBe(afterText);

    // 2. 提交 review + promote
    const model = makeModelWithScoreDelta(70, 85);
    await evaluateCraftRuleOnFoundation(repository, model, {
      projectId,
      candidateId: candidate.id,
      taskKey: "project-positioning",
      scenarioClass: "现代都市小说",
      scenarioRole: "source-failure",
    });
    await evaluateCraftRuleOnFoundation(repository, model, {
      projectId,
      candidateId: candidate.id,
      taskKey: "worldview",
      scenarioClass: "科幻生存小说",
      scenarioRole: "cross-scenario",
    });
    await submitCraftRuleReview(repository, {
      projectId,
      candidateId: candidate.id,
      role: "internal-reviewer",
      reviewerId: "test-reviewer",
      reviewRunId: `run-${randomUUID().slice(0, 8)}`,
      model: "in-memory",
      verdict: "passed",
      summary: "system-prompt 候选改进有效",
      concerns: [],
    });

    const promoted = await promoteCraftRuleCandidate(repository, model, {
      projectId,
      candidateId: candidate.id,
    });
    expect(promoted.candidate.status).toBe("promoted");
    expect(promoted.receipt.status).toBe("promoted");
    expect(promoted.receipt.result.promptTemplateUpdates).toEqual([templateId]);
    expect(promoted.receipt.result.skillUpdates).toBeUndefined();

    // 验证 prompt_templates 已更新
    const ptAfter = await repository.pool.query<{ version: string; content: string }>(
      "SELECT version, content FROM prompt_templates WHERE project_id = $1 AND template_id = $2",
      [projectId, templateId],
    );
    expect(ptAfter.rows[0].version).toBe("1.0.1");
    expect(ptAfter.rows[0].content).toBe(afterText);

    // 3. rollback
    const rolledBack = await rollbackCraftRuleCandidate(repository, model, {
      projectId,
      candidateId: candidate.id,
    });
    expect(rolledBack.candidate.status).toBe("rolled-back");

    const ptRolledBack = await repository.pool.query<{ version: string; content: string }>(
      "SELECT version, content FROM prompt_templates WHERE project_id = $1 AND template_id = $2",
      [projectId, templateId],
    );
    expect(ptRolledBack.rows[0].version).toBe("1.0.0");
    expect(ptRolledBack.rows[0].content).toBe(beforeText);
  });

  // ===== 错误路径 =====

  it("错误路径：afterText 太短抛错", async () => {
    if (!postgresAvailable) return;

    const projectId = `test-craft-err-${randomUUID().slice(0, 8)}`;
    await repository.ensureProject(projectId, "Craft Rule Error Test");
    const skillId = "test-craft-skill";
    await repository.pool.query(
      `INSERT INTO skill_definitions(skill_id, version, prompt_sections)
       VALUES($1, '1.0.0', '{"drafting":"x"}'::jsonb)
       ON CONFLICT(skill_id) DO NOTHING`,
      [skillId],
    );

    await expect(createCraftRuleCandidate(repository, {
      projectId,
      targetKind: "skill",
      targetId: skillId,
      afterText: "短",
      rationale: "测试",
      scope: makeScope(),
    })).rejects.toThrow(/afterText 必填且长度 >= 100/);
  });

  it("错误路径：scope 必填字段缺失抛错", async () => {
    if (!postgresAvailable) return;

    const projectId = `test-craft-scope-${randomUUID().slice(0, 8)}`;
    await repository.ensureProject(projectId, "Craft Rule Scope Test");
    const skillId = "test-craft-skill";
    await repository.pool.query(
      `INSERT INTO skill_definitions(skill_id, version, prompt_sections)
       VALUES($1, '1.0.0', '{"drafting":"x"}'::jsonb)
       ON CONFLICT(skill_id) DO NOTHING`,
      [skillId],
    );

    await expect(createCraftRuleCandidate(repository, {
      projectId,
      targetKind: "skill",
      targetId: skillId,
      afterText: "x".repeat(150),
      rationale: "测试",
      scope: makeScope({ observedSymptom: "" }), // 缺失必填字段
    })).rejects.toThrow(/scope\.observedSymptom 必填且非空/);
  });

  it("错误路径：promote 时状态非法抛错", async () => {
    if (!postgresAvailable) return;

    const projectId = `test-craft-state-${randomUUID().slice(0, 8)}`;
    await repository.ensureProject(projectId, "Craft Rule State Test");
    const skillId = "test-craft-skill";
    await repository.pool.query(
      `INSERT INTO skill_definitions(skill_id, version, prompt_sections)
       VALUES($1, '1.0.0', '{"drafting":"x"}'::jsonb)
       ON CONFLICT(skill_id) DO NOTHING`,
      [skillId],
    );

    const candidate = await createCraftRuleCandidate(repository, {
      projectId,
      targetKind: "skill",
      targetId: skillId,
      afterText: "x".repeat(150),
      rationale: "测试状态转换",
      scope: makeScope(),
    });
    // 候选刚创建状态为 proposed，直接 promote 应抛错（需要先 review）
    const model = makeModelWithScoreDelta();
    await expect(promoteCraftRuleCandidate(repository, model, {
      projectId,
      candidateId: candidate.id,
    })).rejects.toThrow(/候选状态必须为 reviewing/);
  });

  it("错误路径：system-prompt target 不存在抛错", async () => {
    if (!postgresAvailable) return;

    const projectId = `test-craft-missing-${randomUUID().slice(0, 8)}`;
    await repository.ensureProject(projectId, "Craft Rule Missing Test");

    await expect(createCraftRuleCandidate(repository, {
      projectId,
      targetKind: "system-prompt",
      targetId: "nonexistent-template",
      afterText: "x".repeat(150),
      rationale: "测试不存在的 target",
      scope: makeScope(),
    })).rejects.toThrow(/PromptTemplate 不存在/);
  });

  it("错误路径：stale-target-version 漂移时 promote 返回 failed receipt", async () => {
    if (!postgresAvailable) return;

    const projectId = `test-craft-stale-${randomUUID().slice(0, 8)}`;
    await repository.ensureProject(projectId, "Craft Rule Stale Test");
    const skillId = "test-craft-stale-skill";
    await repository.pool.query(
      `INSERT INTO skill_definitions(skill_id, version, prompt_sections)
       VALUES($1, '1.0.0', '{"drafting":"x"}'::jsonb)
       ON CONFLICT(skill_id) DO UPDATE SET version = EXCLUDED.version`,
      [skillId],
    );

    const candidate = await createCraftRuleCandidate(repository, {
      projectId,
      targetKind: "skill",
      targetId: skillId,
      afterText: "x".repeat(150),
      rationale: "测试 stale target",
      scope: makeScope(),
    });
    // 模拟并发：在 promote 前手动修改 skill_definitions.version
    await repository.pool.query("UPDATE skill_definitions SET version = '2.0.0' WHERE skill_id = $1", [skillId]);

    const model = makeModelWithScoreDelta();
    // 完整流程到 promote 失败
    await evaluateCraftRuleOnFoundation(repository, model, {
      projectId, candidateId: candidate.id,
      taskKey: "project-positioning", scenarioClass: "test-source", scenarioRole: "source-failure",
    });
    await evaluateCraftRuleOnFoundation(repository, model, {
      projectId, candidateId: candidate.id,
      taskKey: "worldview", scenarioClass: "test-cross", scenarioRole: "cross-scenario",
    });
    await submitCraftRuleReview(repository, {
      projectId, candidateId: candidate.id,
      role: "internal", reviewerId: "test", reviewRunId: "r1",
      model: "in-memory", verdict: "passed", summary: "ok", concerns: [],
    });
    await expect(promoteCraftRuleCandidate(repository, model, {
      projectId, candidateId: candidate.id,
    })).rejects.toThrow(/promote 失败/);
  });

  // ===== AGENTS.md 合规：回归验证失败自动 rollback =====

  it("AGENTS.md 契约：回归验证失败时自动 rollback（promote 成功但回归 newScore < candidateScore - 容忍阈值）", async () => {
    if (!postgresAvailable) return;

    const projectId = `test-craft-regression-${randomUUID().slice(0, 8)}`;
    await repository.ensureProject(projectId, "Craft Rule Regression Test");
    const skillId = "test-craft-regression-skill";
    await repository.pool.query(
      `INSERT INTO skill_definitions(skill_id, version, prompt_sections)
       VALUES($1, '1.0.0', '{"drafting":"x"}'::jsonb)
       ON CONFLICT(skill_id) DO UPDATE SET version = EXCLUDED.version, prompt_sections = EXCLUDED.prompt_sections`,
      [skillId],
    );

    const candidate = await createCraftRuleCandidate(repository, {
      projectId,
      targetKind: "skill",
      targetId: skillId,
      afterText: "x".repeat(150),
      rationale: "测试回归失败",
      scope: makeScope(),
    });

    const model = makeModelWithRegressionFailure(); // baseline=70, candidate=85, regression=60
    await evaluateCraftRuleOnFoundation(repository, model, {
      projectId, candidateId: candidate.id,
      taskKey: "project-positioning", scenarioClass: "test-source", scenarioRole: "source-failure",
    });
    await evaluateCraftRuleOnFoundation(repository, model, {
      projectId, candidateId: candidate.id,
      taskKey: "worldview", scenarioClass: "test-cross", scenarioRole: "cross-scenario",
    });
    await submitCraftRuleReview(repository, {
      projectId, candidateId: candidate.id,
      role: "internal", reviewerId: "test", reviewRunId: "r1",
      model: "in-memory", verdict: "passed", summary: "ok", concerns: [],
    });

    await expect(promoteCraftRuleCandidate(repository, model, {
      projectId, candidateId: candidate.id,
    })).rejects.toThrow(/回归验证失败.*已自动 rollback/);

    // 验证 skill_definitions 已被 rollback（version 仍是 1.0.0，prompt_sections 不变）
    const skillAfter = await repository.pool.query<{ version: string }>(
      "SELECT version FROM skill_definitions WHERE skill_id = $1",
      [skillId],
    );
    expect(skillAfter.rows[0].version).toBe("1.0.0");

    // 验证 candidate 状态已回滚为 rolled-back
    const finalCandidate = await inspectCraftRuleCandidate(repository, projectId, candidate.id);
    expect(finalCandidate?.status).toBe("rolled-back");
  });
});
