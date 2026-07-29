/**
 * V2 创意执行模块测试套件（Phase B-2）。
 *
 * 策略：
 * - 纯函数测试（evaluateReviewGate）直接运行，无外部依赖。
 * - 集成测试（run-manager/work-item/review-gate/command-router/snapshot）
 *   需要真实 Postgres；beforeAll 尝试连接，失败则 skip 整个集成套件。
 *
 * AGENTS.md 合规：
 * - boundary condition：score 恰好等于 threshold 时 passed=true（因为 `<` 而非 `<=`）
 * - 跨场景 counterexample：幂等键命中返回 cached result；policy 切换（manual→none）边界
 * - 根因分析：测试失败时先识别 failingLayer，不修改 fixture 让单 sample 通过
 *
 * 实现注记：
 * - evaluateReviewGate 的 score 检查仅在无 blocker/major issue 时可达，
 *   此时 score 恒为 5（warnings 不扣分）。因此 boundary 测试使用 score=5/threshold=5.0，
 *   而非任务示例中的 score=4.0/threshold=4.0（该组合需要 major issue，会先触发
 *   hasBlockerOrMajor 分支，永远到不了 score 检查）。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { NovelPostgresRepository } from "../postgres-repository";
import { evaluateReviewGate } from "../creative/review-gate";
import {
  createCreativeRun,
  getCreativeRun,
  listCreativeRuns,
  pauseCreativeRun,
  resumeCreativeRun,
  updateRunStatusFromWork,
} from "../creative/run-manager";
import {
  enqueueCreativeWork,
  startWork,
  acceptWork,
  failWork,
  reviseWork,
} from "../creative/work-item";
import { submitReview, checkGate } from "../creative/review-gate";
import { executeCreativeCommand } from "../creative/command-router";
import { getRunSnapshot } from "../creative/snapshot";
import type { CreativeReview, CreativeRunPolicy } from "../protocol";

// ===== 测试夹具 =====

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

function makeReview(overrides: Partial<CreativeReview> = {}): CreativeReview {
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    workItemId: "w-1",
    subjectArtifactId: "a-1",
    reviewer: "internal",
    verdict: "passed",
    issues: [],
    summary: "ok",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeIssue(severity: "blocker" | "major" | "warning" = "major") {
  return {
    severity,
    title: `test-${severity}`,
    evidence: `evidence-${severity}`,
  };
}

// ===== A. 纯函数：evaluateReviewGate（无 Postgres 依赖）=====

describe("evaluateReviewGate pure function", () => {
  const basePolicy: CreativeRunPolicy = {
    maxRetries: 2,
    reviewGate: "auto",
    autoAcceptThreshold: 3.7,
    progression: "automatic",
  };

  it("none gate → passed=true, reason contains 'gate disabled'", () => {
    const result = evaluateReviewGate([makeReview()], { ...basePolicy, reviewGate: "none" });
    expect(result.passed).toBe(true);
    expect(result.reason).toContain("gate disabled");
  });

  it("manual gate → human passed review accepts the current artifact", () => {
    const result = evaluateReviewGate([makeReview({ reviewer: "human", verdict: "passed" })], {
      ...basePolicy,
      reviewGate: "manual",
    });
    expect(result.passed).toBe(true);
    expect(result.reason).toContain("passed by human");
  });

  it("manual gate rejects a human approval for a superseded artifact", () => {
    const result = evaluateReviewGate(
      [makeReview({ reviewer: "human", subjectArtifactId: "old-artifact", verdict: "passed" })],
      { ...basePolicy, reviewGate: "manual" },
      "current-artifact",
    );
    expect(result.passed).toBe(false);
  });

  // 修复:外部 LLM(independent)审核必须能驱动 manual gate 放行。
  // 根因:此前 manual 分支仅认 reviewer==="human",导致 independent verdict=passed 被无视,
  // 触发 reviseWork 重生——"架构 10 阶段外部 LLM 审核无法放行"的底层机制。
  // 验证原失败场景(independent passed → 放行)+ counterexample(independent revise → 不放行)。
  it("manual gate → independent passed review accepts the current artifact (external-LLM sign-off)", () => {
    const result = evaluateReviewGate(
      [makeReview({ reviewer: "independent", verdict: "passed", issues: [] })],
      { ...basePolicy, reviewGate: "manual" },
    );
    expect(result.passed).toBe(true);
    expect(result.reason).toContain("passed by independent");
  });

  it("manual gate → independent revise review does not pass (drives regeneration)", () => {
    const result = evaluateReviewGate(
      [makeReview({ reviewer: "independent", verdict: "revise", issues: [makeIssue("major")] })],
      { ...basePolicy, reviewGate: "manual" },
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("manual gate");
  });

  it("auto gate + no reviews → passed=false, reason contains 'no reviews'", () => {
    const result = evaluateReviewGate([], basePolicy);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("no reviews");
  });

  it("auto gate + latest verdict=revise → passed=false, reason contains 'latest verdict is revise'", () => {
    const result = evaluateReviewGate([makeReview({ verdict: "revise" })], basePolicy);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("latest verdict is revise");
  });

  it("auto gate + verdict=passed + blocker issue → passed=false, reason contains 'open blocker/major'", () => {
    const result = evaluateReviewGate(
      [makeReview({ verdict: "passed", issues: [makeIssue("blocker")] })],
      basePolicy,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("open blocker/major");
  });

  it("auto gate + verdict=passed + no blocker/major + score < threshold → passed=false, reason contains 'score'", () => {
    // 无 blocker/major issue 时 score=5（warnings 不扣分）；threshold=5.5 使 5 < 5.5
    const result = evaluateReviewGate([makeReview({ verdict: "passed", issues: [] })], {
      ...basePolicy,
      autoAcceptThreshold: 5.5,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("score");
  });

  it("boundary: auto gate + score exactly equals threshold → passed=true (uses < not <=)", () => {
    // 无 issue → score=5；threshold=5.0；5 < 5.0 为 false → passed=true
    const result = evaluateReviewGate([makeReview({ verdict: "passed", issues: [] })], {
      ...basePolicy,
      autoAcceptThreshold: 5.0,
    });
    expect(result.passed).toBe(true);
  });

  it("counterexample: an internal pass does not satisfy the manual author gate", () => {
    const reviews = [makeReview({ verdict: "passed", issues: [] })];
    const manualResult = evaluateReviewGate(reviews, { ...basePolicy, reviewGate: "manual" });
    const noneResult = evaluateReviewGate(reviews, { ...basePolicy, reviewGate: "none" });
    expect(manualResult.passed).toBe(false);
    expect(noneResult.passed).toBe(true);
  });
});

// ===== B. 集成测试（需要真实 Postgres）=====

describe("creative-execution integration", () => {
  let repository: NovelPostgresRepository;
  let postgresAvailable = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.pool.query("SELECT 1");
      await repository.migrate();
      postgresAvailable = true;
    } catch (error) {
      console.warn(`[creative-execution.test] Postgres 不可用: ${(error as Error).message}`);
    }
  }, 30000);

  afterAll(async () => {
    if (repository) await repository.close();
  });

  (postgresAvailable ? describe : describe.skip)("with postgres", () => {
    // 辅助：创建项目 + run
    async function setupProjectAndRun(mode: "chapter" | "segment-auto" = "chapter", policy?: Partial<CreativeRunPolicy>) {
      const projectId = `ce-${randomUUID().slice(0, 8)}`;
      await repository.ensureProject(projectId, `Test ${projectId}`);
      const run = await createCreativeRun(repository, { projectId, mode, policy });
      return { projectId, run };
    }

    // 辅助：直接设置 run 状态（绕过状态机，用于测试前置条件）
    async function setRunStatus(runId: string, status: string) {
      await repository.pool.query("UPDATE creative_runs SET status=$2, updated_at=now() WHERE id=$1", [
        runId,
        status,
      ]);
    }

    // ===== B.1 run-manager =====

    describe("run-manager", () => {
      it("creates run with pending status and default policy", async () => {
        const { run } = await setupProjectAndRun();
        expect(run.status).toBe("pending");
        expect(run.policy.maxRetries).toBe(2);
        expect(run.policy.reviewGate).toBe("manual");
        expect(run.policy.autoAcceptThreshold).toBe(3.7);
      });

      it("getCreativeRun returns run for existing id", async () => {
        const { run } = await setupProjectAndRun();
        const fetched = await getCreativeRun(repository, run.id);
        expect(fetched?.id).toBe(run.id);
      });

      it("getCreativeRun returns null for non-existent id", async () => {
        const fetched = await getCreativeRun(repository, "nonexistent-run-id");
        expect(fetched).toBeNull();
      });

      it("listCreativeRuns filters by project", async () => {
        const { projectId, run } = await setupProjectAndRun();
        // 创建另一个项目的 run 避免污染
        const otherProjectId = `ce-${randomUUID().slice(0, 8)}`;
        await repository.ensureProject(otherProjectId, "Other");
        await createCreativeRun(repository, { projectId: otherProjectId, mode: "chapter" });

        const runs = await listCreativeRuns(repository, projectId);
        expect(runs).toHaveLength(1);
        expect(runs[0].id).toBe(run.id);
      });

      it("pending → pause throws (requires running)", async () => {
        const { run } = await setupProjectAndRun();
        await expect(pauseCreativeRun(repository, run.id)).rejects.toThrow(/无法暂停/);
      });

      it("pending → resume throws (requires paused)", async () => {
        const { run } = await setupProjectAndRun();
        await expect(resumeCreativeRun(repository, run.id)).rejects.toThrow(/无法恢复/);
      });

      it("moves a running run with failed work into the failed terminal state", async () => {
        const { run } = await setupProjectAndRun();
        await setRunStatus(run.id, "running");
        const work = await enqueueCreativeWork(repository, run.id, { kind: "generation", instruction: "生成章节" });
        await startWork(repository, work.id);
        await failWork(repository, work.id, "maxRetriesExceeded:test");

        const updated = await updateRunStatusFromWork(repository, run.id);

        expect(updated.status).toBe("failed");
      });
    });

    // ===== B.2 work-item =====

    describe("work-item", () => {
      it("enqueue → status=pending, parameters.iteration=1", async () => {
        const { run } = await setupProjectAndRun();
        const work = await enqueueCreativeWork(repository, run.id, {
          kind: "generation",
          instruction: "写第一章",
        });
        expect(work.status).toBe("pending");
        expect(work.parameters.iteration).toBe(1);
      });

      it("instruction empty throws (boundary)", async () => {
        const { run } = await setupProjectAndRun();
        await expect(
          enqueueCreativeWork(repository, run.id, { kind: "generation", instruction: "" }),
        ).rejects.toThrow(/instruction/);
        await expect(
          enqueueCreativeWork(repository, run.id, { kind: "generation", instruction: "   " }),
        ).rejects.toThrow(/instruction/);
      });

      it("start → status=running", async () => {
        const { run } = await setupProjectAndRun();
        const work = await enqueueCreativeWork(repository, run.id, {
          kind: "generation",
          instruction: "写第一章",
        });
        const started = await startWork(repository, work.id);
        expect(started.status).toBe("running");
      });

      it("accept → status=accepted", async () => {
        const { run } = await setupProjectAndRun();
        const work = await enqueueCreativeWork(repository, run.id, {
          kind: "generation",
          instruction: "写第一章",
        });
        await startWork(repository, work.id);
        const accepted = await acceptWork(repository, work.id);
        expect(accepted.status).toBe("accepted");
      });

      it("revise → status=pending, iteration=2", async () => {
        const { run } = await setupProjectAndRun();
        const work = await enqueueCreativeWork(repository, run.id, {
          kind: "generation",
          instruction: "写第一章",
        });
        await startWork(repository, work.id);
        await acceptWork(repository, work.id);
        const revised = await reviseWork(repository, work.id);
        expect(revised.status).toBe("pending");
        expect(revised.parameters.iteration).toBe(2);
      });

      it("accepted → start throws (illegal transition)", async () => {
        const { run } = await setupProjectAndRun();
        const work = await enqueueCreativeWork(repository, run.id, {
          kind: "generation",
          instruction: "写第一章",
        });
        await startWork(repository, work.id);
        await acceptWork(repository, work.id);
        await expect(startWork(repository, work.id)).rejects.toThrow(/无法启动/);
      });

      it("dependsOn cross-run throws", async () => {
        const { run: run1 } = await setupProjectAndRun();
        const { run: run2 } = await setupProjectAndRun();
        const workA = await enqueueCreativeWork(repository, run1.id, {
          kind: "generation",
          instruction: "任务 A",
        });
        await expect(
          enqueueCreativeWork(repository, run2.id, {
            kind: "revision",
            instruction: "任务 B 依赖 A",
            dependsOn: [workA.id],
          }),
        ).rejects.toThrow(/跨 run/);
      });
    });

    // ===== B.3 review-gate =====

    describe("review-gate", () => {
      it("manual gate: checkGate always passed=false", async () => {
        const { run } = await setupProjectAndRun();
        const work = await enqueueCreativeWork(repository, run.id, {
          kind: "generation",
          instruction: "写第一章",
        });
        await submitReview(repository, work.id, {
          subjectArtifactId: "a-1",
          reviewer: "internal",
          verdict: "passed",
          issues: [],
          summary: "ok",
        });
        const gate = await checkGate(repository, work.id, {
          maxRetries: 2,
          reviewGate: "manual",
          progression: "automatic",
        });
        expect(gate.passed).toBe(false);
      });

      it("none gate: checkGate always passed=true", async () => {
        const { run } = await setupProjectAndRun();
        const work = await enqueueCreativeWork(repository, run.id, {
          kind: "generation",
          instruction: "写第一章",
        });
        const gate = await checkGate(repository, work.id, {
          maxRetries: 2,
          reviewGate: "none",
          progression: "automatic",
        });
        expect(gate.passed).toBe(true);
      });

      it("auto gate + no review → passed=false", async () => {
        const { run } = await setupProjectAndRun();
        const work = await enqueueCreativeWork(repository, run.id, {
          kind: "generation",
          instruction: "写第一章",
        });
        const gate = await checkGate(repository, work.id, {
          maxRetries: 2,
          reviewGate: "auto",
          autoAcceptThreshold: 3.7,
          progression: "automatic",
        });
        expect(gate.passed).toBe(false);
      });

      it("auto gate + passed review + score >= threshold → passed=true", async () => {
        const { run } = await setupProjectAndRun();
        const work = await enqueueCreativeWork(repository, run.id, {
          kind: "generation",
          instruction: "写第一章",
        });
        await submitReview(repository, work.id, {
          subjectArtifactId: "a-1",
          reviewer: "internal",
          verdict: "passed",
          issues: [],
          summary: "ok",
        });
        const gate = await checkGate(repository, work.id, {
          maxRetries: 2,
          reviewGate: "auto",
          autoAcceptThreshold: 3.7,
          progression: "automatic",
        });
        expect(gate.passed).toBe(true);
      });

      it("boundary: auto gate + score exactly equals threshold → passed=true", async () => {
        const { run } = await setupProjectAndRun();
        const work = await enqueueCreativeWork(repository, run.id, {
          kind: "generation",
          instruction: "写第一章",
        });
        // 无 issue → score=5；threshold=5.0；5 < 5.0 为 false → passed=true
        await submitReview(repository, work.id, {
          subjectArtifactId: "a-1",
          reviewer: "internal",
          verdict: "passed",
          issues: [],
          summary: "ok",
        });
        const gate = await checkGate(repository, work.id, {
          maxRetries: 2,
          reviewGate: "auto",
          autoAcceptThreshold: 5.0,
          progression: "automatic",
        });
        expect(gate.passed).toBe(true);
      });
    });

    // ===== B.4 command-router =====

    describe("command-router", () => {
      it("idempotency: same idempotencyKey returns cached result (counterexample)", async () => {
        const { run } = await setupProjectAndRun();
        const work = await enqueueCreativeWork(repository, run.id, {
          kind: "generation",
          instruction: "写第一章",
        });
        const idempotencyKey = `idem-${randomUUID().slice(0, 8)}`;

        const result1 = await executeCreativeCommand(repository, {
          type: "work.start",
          workItemId: work.id,
          idempotencyKey,
          runId: run.id,
        });
        expect(result1.workStatus).toBe("running");

        // 第二次提交相同 idempotencyKey → 返回 cached result，不重复执行
        const result2 = await executeCreativeCommand(repository, {
          type: "work.start",
          workItemId: work.id,
          idempotencyKey,
          runId: run.id,
        });
        expect(result2.workStatus).toBe(result1.workStatus);
        expect(result2.artifactRefs).toEqual(result1.artifactRefs);
        expect(result2.summary).toBe(result1.summary);
      });

      it("run.pause command → run.status=paused", async () => {
        const { run } = await setupProjectAndRun();
        await setRunStatus(run.id, "running");
        const result = await executeCreativeCommand(repository, {
          type: "run.pause",
          idempotencyKey: `k-${randomUUID().slice(0, 8)}`,
          runId: run.id,
        });
        expect(result.status).toBe("paused");
      });

      it("run.cancel command → run.status=cancelled", async () => {
        const { run } = await setupProjectAndRun();
        await setRunStatus(run.id, "running");
        const result = await executeCreativeCommand(repository, {
          type: "run.cancel",
          idempotencyKey: `k-${randomUUID().slice(0, 8)}`,
          runId: run.id,
        });
        expect(result.status).toBe("cancelled");
      });

      it("unknown command type throws (route fallback)", async () => {
        const { run } = await setupProjectAndRun();
        await expect(
          executeCreativeCommand(repository, {
            runId: run.id,
            type: "unknown.command" as never,
            idempotencyKey: `k-${randomUUID().slice(0, 8)}`,
          } as never),
        ).rejects.toThrow(/未知/);
      });
    });

    // ===== B.5 snapshot =====

    describe("snapshot", () => {
      it("non-existent run → null", async () => {
        const snapshot = await getRunSnapshot(repository, "nonexistent-run-id");
        expect(snapshot).toBeNull();
      });

      it("existing run → run + workItems + reviews + events", async () => {
        const { run } = await setupProjectAndRun();
        const work = await enqueueCreativeWork(repository, run.id, {
          kind: "generation",
          instruction: "写第一章",
        });
        await submitReview(repository, work.id, {
          subjectArtifactId: "a-1",
          reviewer: "internal",
          verdict: "passed",
          issues: [],
          summary: "ok",
        });

        const snapshot = await getRunSnapshot(repository, run.id);
        expect(snapshot).not.toBeNull();
        expect(snapshot!.run.id).toBe(run.id);
        expect(snapshot!.workItems).toHaveLength(1);
        expect(snapshot!.reviews).toHaveLength(1);
        // run.created + work.enqueued + review.recorded ≥ 3 events
        expect(snapshot!.events.length).toBeGreaterThanOrEqual(3);
      });

      it("afterSequence incremental: no new events → empty; new event → returned", async () => {
        const { run } = await setupProjectAndRun();
        // 初始快照：至少有 run.created 事件
        const initial = await getRunSnapshot(repository, run.id);
        expect(initial).not.toBeNull();
        expect(initial!.events.length).toBeGreaterThanOrEqual(1);

        const lastEventId = Number(initial!.events[initial!.events.length - 1].id);

        // 用 lastEventId 作为 afterSequence → 无新事件
        const noNew = await getRunSnapshot(repository, run.id, lastEventId);
        expect(noNew!.events).toHaveLength(0);

        // 触发新事件（enqueue work item → work.enqueued）
        await enqueueCreativeWork(repository, run.id, {
          kind: "generation",
          instruction: "新任务",
        });

        // 再次用 lastEventId 查询 → 应返回新事件
        const withNew = await getRunSnapshot(repository, run.id, lastEventId);
        expect(withNew!.events.length).toBeGreaterThanOrEqual(1);
        expect(withNew!.events.some((e) => e.eventType === "work.enqueued")).toBe(true);
      });
    });
  });
});
