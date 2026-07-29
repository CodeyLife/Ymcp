/**
 * V2 CreativeRun 生命周期管理。
 *
 * 设计依据：AGENTS.md + Phase B-2 创意执行模块。
 *
 * 与 v1 的区别：v1 用 IndexedDB/Dexie 在客户端管理 run 状态，
 * v2 全部用 Postgres 表（creative_runs + creative_run_events），事件溯源。
 *
 * 职责：
 * - createCreativeRun：创建 run（pending）+ 写 run.created 事件
 * - getCreativeRun/listCreativeRuns：查询 run
 * - pause/resume/cancel：状态转换 + 写 run.status-changed 事件
 * - updateRunStatusFromWork：根据 work items 派生 run 状态
 *
 * 事件溯源：所有状态转换都写入 creative_run_events，payload 包含
 * from/to/actor/reason 等字段，便于审计与回放。
 */
import { randomUUID } from "node:crypto";
import type { CreativeRun, CreativeRunMode, CreativeRunPolicy, CreativeRunStatus } from "../protocol";
import type { NovelPostgresRepository } from "../postgres-repository";

// ===== 行类型映射 =====

type CreativeRunRow = {
  id: string;
  project_id: string;
  mode: string;
  status: string;
  policy: Record<string, unknown>;
  payload: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
};

// ===== 辅助 =====

const DEFAULT_POLICY: CreativeRunPolicy = {
  maxRetries: 2,
  reviewGate: "manual",
  autoAcceptThreshold: 3.7,
  progression: "automatic",
};

function mapRunRow(row: CreativeRunRow): CreativeRun {
  const policy = row.policy ?? {};
  return {
    id: row.id,
    projectId: row.project_id,
    mode: row.mode as CreativeRunMode,
    status: row.status as CreativeRunStatus,
    policy: {
      maxRetries: typeof policy.maxRetries === "number" ? policy.maxRetries : DEFAULT_POLICY.maxRetries,
      reviewGate: (policy.reviewGate as CreativeRunPolicy["reviewGate"]) ?? DEFAULT_POLICY.reviewGate,
      autoAcceptThreshold:
        typeof policy.autoAcceptThreshold === "number"
          ? policy.autoAcceptThreshold
          : DEFAULT_POLICY.autoAcceptThreshold,
      progression: policy.progression === "user-driven" ? "user-driven" : "automatic",
    },
    payload: row.payload ?? {},
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  };
}

/**
 * 写入 creative_run_events 事件。
 *
 * 所有 run 事件都通过此函数写入，确保 payload 结构一致。
 * 不返回事件 id（BIGSERIAL 由数据库生成，调用方一般不需要）。
 */
async function writeRunEvent(
  repository: NovelPostgresRepository,
  runId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await repository.pool.query(
    "INSERT INTO creative_run_events(run_id, event_type, payload) VALUES($1, $2, $3)",
    [runId, eventType, payload],
  );
}

// ===== 公共接口 =====

/**
 * 创建 CreativeRun。
 *
 * 初始 status="pending"，policy 缺失字段用默认值填充
 * （maxRetries=2, reviewGate="manual", autoAcceptThreshold=3.7）。
 *
 * 同步写入 run.created 事件，payload 包含初始 policy/mode/payload 快照。
 */
export async function createCreativeRun(
  repository: NovelPostgresRepository,
  input: {
    projectId: string;
    mode: CreativeRunMode;
    policy?: Partial<CreativeRunPolicy>;
    payload?: Record<string, unknown>;
  },
): Promise<CreativeRun> {
  // 1. 校验项目存在
  const projectCheck = await repository.pool.query<{ id: string }>(
    "SELECT id FROM novel_projects WHERE id = $1",
    [input.projectId],
  );
  if (!projectCheck.rowCount) {
    throw new Error(`项目不存在：${input.projectId}`);
  }

  // 2. 合并 policy
  const policy: CreativeRunPolicy = {
    maxRetries: input.policy?.maxRetries ?? DEFAULT_POLICY.maxRetries,
    reviewGate: input.policy?.reviewGate ?? DEFAULT_POLICY.reviewGate,
    autoAcceptThreshold: input.policy?.autoAcceptThreshold ?? DEFAULT_POLICY.autoAcceptThreshold,
    progression: input.policy?.progression ?? DEFAULT_POLICY.progression,
  };
  if (policy.maxRetries < 0) {
    throw new Error(`policy.maxRetries 不能为负数：${policy.maxRetries}`);
  }
  if (policy.reviewGate !== "manual" && policy.reviewGate !== "auto" && policy.reviewGate !== "none") {
    throw new Error(`policy.reviewGate 非法：${policy.reviewGate}`);
  }

  // 3. 插入 creative_runs
  const id = randomUUID();
  const result = await repository.pool.query<CreativeRunRow>(
    `INSERT INTO creative_runs(id, project_id, mode, status, policy, payload)
     VALUES($1, $2, $3, 'pending', $4, $5)
     RETURNING id, project_id, mode, status, policy, payload, created_at, updated_at`,
    [id, input.projectId, input.mode, policy, input.payload ?? {}],
  );
  const run = mapRunRow(result.rows[0]);

  // 4. 写 run.created 事件
  await writeRunEvent(repository, run.id, "run.created", {
    runId: run.id,
    projectId: run.projectId,
    mode: run.mode,
    policy: run.policy,
    payload: run.payload,
  });

  return run;
}

/**
 * 查询单个 CreativeRun。不存在返回 null。
 */
export async function getCreativeRun(
  repository: NovelPostgresRepository,
  runId: string,
): Promise<CreativeRun | null> {
  const result = await repository.pool.query<CreativeRunRow>(
    "SELECT id, project_id, mode, status, policy, payload, created_at, updated_at FROM creative_runs WHERE id = $1",
    [runId],
  );
  if (!result.rowCount) return null;
  return mapRunRow(result.rows[0]);
}

/**
 * 列出项目的所有 CreativeRun（按 created_at DESC）。
 */
export async function listCreativeRuns(
  repository: NovelPostgresRepository,
  projectId: string,
): Promise<CreativeRun[]> {
  const result = await repository.pool.query<CreativeRunRow>(
    "SELECT id, project_id, mode, status, policy, payload, created_at, updated_at FROM creative_runs WHERE project_id = $1 ORDER BY created_at DESC",
    [projectId],
  );
  return result.rows.map(mapRunRow);
}

/**
 * 暂停 run。仅 running 状态可 pause。
 *
 * 写入 run.status-changed 事件，payload 包含 from/to。
 */
export async function pauseCreativeRun(
  repository: NovelPostgresRepository,
  runId: string,
): Promise<CreativeRun> {
  const result = await repository.pool.query<CreativeRunRow>(
    `UPDATE creative_runs SET status = 'paused', updated_at = now()
     WHERE id = $1 AND status = 'running'
     RETURNING id, project_id, mode, status, policy, payload, created_at, updated_at`,
    [runId],
  );
  if (!result.rowCount) {
    const existing = await getCreativeRun(repository, runId);
    if (!existing) throw new Error(`CreativeRun 不存在：${runId}`);
    throw new Error(`CreativeRun 状态非法，无法暂停（当前状态：${existing.status}，要求 running）`);
  }
  const run = mapRunRow(result.rows[0]);
  await writeRunEvent(repository, run.id, "run.status-changed", {
    from: "running",
    to: "paused",
    runId: run.id,
  });
  return run;
}

/**
 * 恢复 run。仅 paused 状态可 resume。
 */
export async function resumeCreativeRun(
  repository: NovelPostgresRepository,
  runId: string,
): Promise<CreativeRun> {
  const result = await repository.pool.query<CreativeRunRow>(
    `UPDATE creative_runs SET status = 'running', updated_at = now()
     WHERE id = $1 AND status = 'paused'
     RETURNING id, project_id, mode, status, policy, payload, created_at, updated_at`,
    [runId],
  );
  if (!result.rowCount) {
    const existing = await getCreativeRun(repository, runId);
    if (!existing) throw new Error(`CreativeRun 不存在：${runId}`);
    throw new Error(`CreativeRun 状态非法，无法恢复（当前状态：${existing.status}，要求 paused）`);
  }
  const run = mapRunRow(result.rows[0]);
  await writeRunEvent(repository, run.id, "run.status-changed", {
    from: "paused",
    to: "running",
    runId: run.id,
  });
  return run;
}

/**
 * 取消 run。running/paused 状态可 cancel。
 *
 * 先 SELECT 取原状态，再 UPDATE，确保事件 from 字段精确。
 */
export async function cancelCreativeRun(
  repository: NovelPostgresRepository,
  runId: string,
): Promise<CreativeRun> {
  const before = await getCreativeRun(repository, runId);
  if (!before) throw new Error(`CreativeRun 不存在：${runId}`);
  if (before.status !== "running" && before.status !== "paused") {
    throw new Error(`CreativeRun 状态非法，无法取消（当前状态：${before.status}，要求 running 或 paused）`);
  }
  const result = await repository.pool.query<CreativeRunRow>(
    `UPDATE creative_runs SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND status IN ('running', 'paused')
     RETURNING id, project_id, mode, status, policy, payload, created_at, updated_at`,
    [runId],
  );
  if (!result.rowCount) {
    // 并发：在 SELECT 与 UPDATE 之间被其他事务改了状态
    throw new Error(`CreativeRun 状态并发变化，取消失败：${runId}`);
  }
  const run = mapRunRow(result.rows[0]);
  await writeRunEvent(repository, run.id, "run.status-changed", {
    from: before.status,
    to: "cancelled",
    runId: run.id,
  });
  return run;
}

/**
 * 根据 work items 状态派生 run 状态。
 *
 * 规则：
 * - 所有 work items 均为 accepted → run.completed
 * - 存在 failed work item → run.failed
 * - 否则 → running
 *
 * 注意：当 run 已 failed/cancelled/completed 时，不强制改回 running。
 */
export async function updateRunStatusFromWork(
  repository: NovelPostgresRepository,
  runId: string,
): Promise<CreativeRun> {
  const existing = await getCreativeRun(repository, runId);
  if (!existing) throw new Error(`CreativeRun 不存在：${runId}`);

  // 已终态的 run 不被 work item 状态反向修改
  if (existing.status === "completed" || existing.status === "failed" || existing.status === "cancelled") {
    return existing;
  }

  const workResult = await repository.pool.query<{ status: string }>(
    "SELECT status FROM creative_work_items WHERE run_id = $1",
    [runId],
  );
  const statuses = workResult.rows.map((r) => r.status);

  let nextStatus: CreativeRunStatus;
  if (statuses.length === 0) {
    // 无 work item：保持原状态（pending run 不应被派生为 running）
    return existing;
  } else if (statuses.every((s) => s === "accepted")) {
    nextStatus = "completed";
  } else if (statuses.some((s) => s === "failed")) {
    nextStatus = "failed";
  } else {
    nextStatus = "running";
  }

  if (nextStatus === existing.status) return existing;

  const result = await repository.pool.query<CreativeRunRow>(
    `UPDATE creative_runs SET status = $2, updated_at = now()
     WHERE id = $1
     RETURNING id, project_id, mode, status, policy, payload, created_at, updated_at`,
    [runId, nextStatus],
  );
  if (!result.rowCount) throw new Error(`CreativeRun 不存在：${runId}`);
  const run = mapRunRow(result.rows[0]);
  await writeRunEvent(repository, run.id, "run.status-changed", {
    from: existing.status,
    to: nextStatus,
    runId: run.id,
    derived: true,
    reason: "updateRunStatusFromWork",
  });
  return run;
}
