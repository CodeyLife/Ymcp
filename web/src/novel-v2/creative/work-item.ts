/**
 * V2 CreativeWorkItem 状态机。
 *
 * 设计依据：AGENTS.md + Phase B-2 创意执行模块。
 *
 * 状态机：
 *   pending → running → accepted（终态）
 *                   ↘ failed（终态）
 *   running/accepted → pending（revised 过渡，iteration+1）
 *   failed → pending（retried 过渡，iteration 不变）
 *   running → pending（recovered 过渡）
 *
 * 事件：所有状态转换写 creative_run_events（work.enqueued/started/completed/revised/retried/recovered/failed）。
 *
 * 校验：
 * - enqueue：instruction 非空、dependsOn 存在且属于同 run
 * - start：所有 dependsOn 均为 accepted
 * - 状态转换非法时抛具体错误
 *
 * TODO P2: 实际执行器由 temporal workflow 调用，本模块仅做状态转换与事件记录。
 */
import { randomUUID } from "node:crypto";
import type { CreativeWorkItem, CreativeWorkKind, CreativeWorkStatus } from "../protocol";
import type { NovelPostgresRepository } from "../postgres-repository";
import { getCreativeRun, updateRunStatusFromWork } from "./run-manager";

// ===== 行类型映射 =====

type WorkItemRow = {
  id: string;
  run_id: string;
  kind: string;
  task_key: string | null;
  target_id: string | null;
  instruction: string;
  depends_on: string[] | null;
  status: string;
  artifact_refs: string[] | null;
  parameters: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
};

function mapWorkItemRow(row: WorkItemRow): CreativeWorkItem {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind as CreativeWorkKind,
    taskKey: row.task_key ?? undefined,
    targetId: row.target_id ?? undefined,
    instruction: row.instruction,
    dependsOn: row.depends_on ?? [],
    status: row.status as CreativeWorkStatus,
    artifactRefs: row.artifact_refs ?? [],
    parameters: row.parameters ?? {},
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  };
}

// ===== 辅助 =====

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

function assertKind(kind: string): asserts kind is CreativeWorkKind {
  if (kind !== "generation" && kind !== "revision" && kind !== "review") {
    throw new Error(`CreativeWorkKind 非法：${kind}`);
  }
}

// ===== 公共接口 =====

/**
 * 入队 work item。
 *
 * 校验：
 * - instruction 非空
 * - run 存在
 * - dependsOn 中的 work item 存在且属于同一 run
 *
 * 初始 status="pending"。写 work.enqueued 事件。
 */
export async function enqueueCreativeWork(
  repository: NovelPostgresRepository,
  runId: string,
  input: {
    kind: CreativeWorkKind;
    taskKey?: string;
    targetId?: string;
    instruction: string;
    dependsOn?: string[];
    parameters?: Record<string, unknown>;
  },
): Promise<CreativeWorkItem> {
  if (!input.instruction || !input.instruction.trim()) {
    throw new Error("instruction 不能为空");
  }
  assertKind(input.kind);

  const run = await getCreativeRun(repository, runId);
  if (!run) throw new Error(`CreativeRun 不存在：${runId}`);

  // 校验 dependsOn：存在且属于同 run
  const dependsOn = input.dependsOn ?? [];
  if (dependsOn.length > 0) {
    const depsResult = await repository.pool.query<{ id: string; run_id: string }>(
      "SELECT id, run_id FROM creative_work_items WHERE id = ANY($1::text[])",
      [dependsOn],
    );
    const found = new Map(depsResult.rows.map((r) => [r.id, r.run_id]));
    for (const depId of dependsOn) {
      const depRunId = found.get(depId);
      if (!depRunId) {
        throw new Error(`dependsOn 引用不存在的 work item：${depId}`);
      }
      if (depRunId !== runId) {
        throw new Error(`dependsOn 引用跨 run 的 work item：${depId}（属于 run ${depRunId}）`);
      }
    }
  }

  const id = randomUUID();
  const parameters: Record<string, unknown> = { ...(input.parameters ?? {}), iteration: 1 };
  const result = await repository.pool.query<WorkItemRow>(
    `INSERT INTO creative_work_items(id, run_id, project_id, kind, task_key, target_id, instruction, depends_on, status, artifact_refs, parameters)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, 'pending', '{}', $9)
     RETURNING id, run_id, kind, task_key, target_id, instruction, depends_on, status, artifact_refs, parameters, created_at, updated_at`,
    [id, runId, run.projectId, input.kind, input.taskKey ?? null, input.targetId ?? null, input.instruction, dependsOn, parameters],
  );
  const workItem = mapWorkItemRow(result.rows[0]);

  await writeRunEvent(repository, runId, "work.enqueued", {
    workItemId: workItem.id,
    kind: workItem.kind,
    taskKey: workItem.taskKey,
    targetId: workItem.targetId,
    dependsOn: workItem.dependsOn,
    iteration: 1,
  });

  return workItem;
}

/**
 * 查询单个 work item。不存在返回 null。
 */
export async function getWorkItem(
  repository: NovelPostgresRepository,
  workItemId: string,
): Promise<CreativeWorkItem | null> {
  const result = await repository.pool.query<WorkItemRow>(
    "SELECT id, run_id, kind, task_key, target_id, instruction, depends_on, status, artifact_refs, parameters, created_at, updated_at FROM creative_work_items WHERE id = $1",
    [workItemId],
  );
  if (!result.rowCount) return null;
  return mapWorkItemRow(result.rows[0]);
}

/**
 * 列出 run 的所有 work item（按 created_at ASC）。
 */
export async function listWorkItems(
  repository: NovelPostgresRepository,
  runId: string,
): Promise<CreativeWorkItem[]> {
  const result = await repository.pool.query<WorkItemRow>(
    "SELECT id, run_id, kind, task_key, target_id, instruction, depends_on, status, artifact_refs, parameters, created_at, updated_at FROM creative_work_items WHERE run_id = $1 ORDER BY created_at ASC",
    [runId],
  );
  return result.rows.map(mapWorkItemRow);
}

/**
 * 启动 work item。pending → running。
 *
 * 校验：所有 dependsOn 均为 accepted。
 *
 * TODO P2: 实际执行器由 temporal workflow 调用，本函数仅做状态转换。
 */
export async function startWork(
  repository: NovelPostgresRepository,
  workItemId: string,
): Promise<CreativeWorkItem> {
  const before = await getWorkItem(repository, workItemId);
  if (!before) throw new Error(`CreativeWorkItem 不存在：${workItemId}`);
  if (before.status !== "pending") {
    throw new Error(`CreativeWorkItem 状态非法，无法启动（当前状态：${before.status}，要求 pending）`);
  }

  // 校验 dependsOn 均 accepted
  if (before.dependsOn.length > 0) {
    const depsResult = await repository.pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM creative_work_items WHERE id = ANY($1::text[])",
      [before.dependsOn],
    );
    const notAccepted = depsResult.rows.filter((r) => r.status !== "accepted");
    if (notAccepted.length > 0) {
      throw new Error(
        `CreativeWorkItem 依赖未完成：${notAccepted.map((r) => `${r.id}=${r.status}`).join(", ")}`,
      );
    }
  }

  const result = await repository.pool.query<WorkItemRow>(
    `UPDATE creative_work_items SET status = 'running', updated_at = now()
     WHERE id = $1 AND status = 'pending'
     RETURNING id, run_id, kind, task_key, target_id, instruction, depends_on, status, artifact_refs, parameters, created_at, updated_at`,
    [workItemId],
  );
  if (!result.rowCount) {
    throw new Error(`CreativeWorkItem 状态并发变化，启动失败：${workItemId}`);
  }
  const workItem = mapWorkItemRow(result.rows[0]);
  await writeRunEvent(repository, workItem.runId, "work.started", {
    workItemId: workItem.id,
    from: "pending",
    to: "running",
  });
  return workItem;
}

/**
 * 接受 work item。running → accepted（终态）。
 *
 * 写 work.completed 事件。触发 updateRunStatusFromWork 派生 run 状态。
 */
export async function acceptWork(
  repository: NovelPostgresRepository,
  workItemId: string,
): Promise<CreativeWorkItem> {
  const before = await getWorkItem(repository, workItemId);
  if (!before) throw new Error(`CreativeWorkItem 不存在：${workItemId}`);
  // 幂等：已 accepted 的 work item 直接返回，不重复写事件。
  // 场景：外部 work.accept 命令已将状态改为 accepted，
  // workflow 从 manual gate 唤醒后再次调 acceptWork 不会崩溃。
  if (before.status === "accepted") {
    return before;
  }
  if (before.status !== "running") {
    throw new Error(`CreativeWorkItem 状态非法，无法接受（当前状态：${before.status}，要求 running）`);
  }

  const result = await repository.pool.query<WorkItemRow>(
    `UPDATE creative_work_items SET status = 'accepted', updated_at = now()
     WHERE id = $1 AND status = 'running'
     RETURNING id, run_id, kind, task_key, target_id, instruction, depends_on, status, artifact_refs, parameters, created_at, updated_at`,
    [workItemId],
  );
  if (!result.rowCount) {
    // 并发场景：可能在查询后被外部 accept，幂等返回当前状态
    const current = await getWorkItem(repository, workItemId);
    if (current?.status === "accepted") return current;
    throw new Error(`CreativeWorkItem 状态并发变化，接受失败：${workItemId}`);
  }
  const workItem = mapWorkItemRow(result.rows[0]);
  await writeRunEvent(repository, workItem.runId, "work.completed", {
    workItemId: workItem.id,
    from: "running",
    to: "accepted",
    artifactRefs: workItem.artifactRefs,
  });

  // 派生 run 状态
  await updateRunStatusFromWork(repository, workItem.runId);

  return workItem;
}

/**
 * 修订 work item。running/accepted → pending（revised 过渡），iteration+1。
 *
 * 写 work.revised 事件。若提供 instruction，更新 instruction 字段。
 */
export async function reviseWork(
  repository: NovelPostgresRepository,
  workItemId: string,
  instruction?: string,
): Promise<CreativeWorkItem> {
  const before = await getWorkItem(repository, workItemId);
  if (!before) throw new Error(`CreativeWorkItem 不存在：${workItemId}`);
  if (before.status !== "running" && before.status !== "accepted") {
    throw new Error(
      `CreativeWorkItem 状态非法，无法修订（当前状态：${before.status}，要求 running 或 accepted）`,
    );
  }
  if (instruction !== undefined && !instruction.trim()) {
    throw new Error("instruction 不能为空字符串");
  }

  const currentIteration = Number(before.parameters.iteration ?? 1);
  const nextIteration = currentIteration + 1;
  const nextParameters = { ...before.parameters, iteration: nextIteration };

  const result = await repository.pool.query<WorkItemRow>(
    `UPDATE creative_work_items
     SET status = 'pending', parameters = $2, instruction = COALESCE(NULLIF($3, ''), instruction), updated_at = now()
     WHERE id = $1 AND status IN ('running', 'accepted')
     RETURNING id, run_id, kind, task_key, target_id, instruction, depends_on, status, artifact_refs, parameters, created_at, updated_at`,
    [workItemId, nextParameters, instruction ?? null],
  );
  if (!result.rowCount) {
    throw new Error(`CreativeWorkItem 状态并发变化，修订失败：${workItemId}`);
  }
  const workItem = mapWorkItemRow(result.rows[0]);
  await writeRunEvent(repository, workItem.runId, "work.revised", {
    workItemId: workItem.id,
    from: before.status,
    to: "pending",
    iteration: nextIteration,
    instructionUpdated: instruction !== undefined,
  });
  return workItem;
}

/**
 * 重试 work item。failed → pending（retried 过渡），iteration 不变。
 *
 * 写 work.retried 事件。
 */
export async function retryWork(
  repository: NovelPostgresRepository,
  workItemId: string,
): Promise<CreativeWorkItem> {
  const before = await getWorkItem(repository, workItemId);
  if (!before) throw new Error(`CreativeWorkItem 不存在：${workItemId}`);
  if (before.status !== "failed") {
    throw new Error(`CreativeWorkItem 状态非法，无法重试（当前状态：${before.status}，要求 failed）`);
  }

  const result = await repository.pool.query<WorkItemRow>(
    `UPDATE creative_work_items SET status = 'pending', updated_at = now()
     WHERE id = $1 AND status = 'failed'
     RETURNING id, run_id, kind, task_key, target_id, instruction, depends_on, status, artifact_refs, parameters, created_at, updated_at`,
    [workItemId],
  );
  if (!result.rowCount) {
    throw new Error(`CreativeWorkItem 状态并发变化，重试失败：${workItemId}`);
  }
  const workItem = mapWorkItemRow(result.rows[0]);
  await writeRunEvent(repository, workItem.runId, "work.retried", {
    workItemId: workItem.id,
    from: "failed",
    to: "pending",
    iteration: Number(workItem.parameters.iteration ?? 1),
  });
  return workItem;
}

/**
 * 恢复 work item。running → pending（recovered 过渡）。
 *
 * 用于长时间无心跳的 work item 回收。force=true 时跳过状态校验（管理员恢复）。
 *
 * 写 work.recovered 事件。
 */
export async function recoverWork(
  repository: NovelPostgresRepository,
  workItemId: string,
  force?: boolean,
): Promise<CreativeWorkItem> {
  const before = await getWorkItem(repository, workItemId);
  if (!before) throw new Error(`CreativeWorkItem 不存在：${workItemId}`);
  if (!force) {
    if (before.status !== "running") {
      throw new Error(`CreativeWorkItem 状态非法，无法恢复（当前状态：${before.status}，要求 running 或 force=true）`);
    }
  } else if (before.status === "accepted" || before.status === "pending") {
    // 已终态/未启动的 work item 无需恢复
    throw new Error(`CreativeWorkItem 无需恢复（当前状态：${before.status}）`);
  }

  const allowedStatuses = force ? ("'running','failed','recovered','revised','retried'") : "'running'";
  const result = await repository.pool.query<WorkItemRow>(
    `UPDATE creative_work_items SET status = 'pending', updated_at = now()
     WHERE id = $1 AND status IN (${allowedStatuses})
     RETURNING id, run_id, kind, task_key, target_id, instruction, depends_on, status, artifact_refs, parameters, created_at, updated_at`,
    [workItemId],
  );
  if (!result.rowCount) {
    throw new Error(`CreativeWorkItem 状态并发变化，恢复失败：${workItemId}`);
  }
  const workItem = mapWorkItemRow(result.rows[0]);
  await writeRunEvent(repository, workItem.runId, "work.recovered", {
    workItemId: workItem.id,
    from: before.status,
    to: "pending",
    force: Boolean(force),
    iteration: Number(workItem.parameters.iteration ?? 1),
  });
  return workItem;
}

/**
 * 标记 work item 失败。→ failed（终态）。
 *
 * 写 work.failed 事件，payload 包含 error 信息。
 */
export async function failWork(
  repository: NovelPostgresRepository,
  workItemId: string,
  error: string,
): Promise<CreativeWorkItem> {
  const before = await getWorkItem(repository, workItemId);
  if (!before) throw new Error(`CreativeWorkItem 不存在：${workItemId}`);
  if (before.status === "accepted") {
    throw new Error(`CreativeWorkItem 已 accepted，无法标记失败：${workItemId}`);
  }
  if (before.status === "failed") {
    // 幂等：已 failed 直接返回当前状态
    return before;
  }

  const result = await repository.pool.query<WorkItemRow>(
    `UPDATE creative_work_items SET status = 'failed', updated_at = now()
     WHERE id = $1 AND status != 'accepted' AND status != 'failed'
     RETURNING id, run_id, kind, task_key, target_id, instruction, depends_on, status, artifact_refs, parameters, created_at, updated_at`,
    [workItemId],
  );
  if (!result.rowCount) {
    // 并发变化：重新查询返回当前状态
    const current = await getWorkItem(repository, workItemId);
    if (current) return current;
    throw new Error(`CreativeWorkItem 状态并发变化，标记失败失败：${workItemId}`);
  }
  const workItem = mapWorkItemRow(result.rows[0]);
  await writeRunEvent(repository, workItem.runId, "work.failed", {
    workItemId: workItem.id,
    from: before.status,
    to: "failed",
    error,
    iteration: Number(workItem.parameters.iteration ?? 1),
  });
  return workItem;
}

/**
 * 追加 artifact 引用到 work item。
 *
 * 不改变 status，仅更新 artifact_refs 数组。写 work.artifact-attached 事件。
 *
 * 这个函数不在协议契约的必选列表中，但 command-router 在 review.request 后可能需要追加 artifact。
 * 提供为公共工具函数。
 */
export async function attachArtifact(
  repository: NovelPostgresRepository,
  workItemId: string,
  artifactId: string,
): Promise<CreativeWorkItem> {
  const before = await getWorkItem(repository, workItemId);
  if (!before) throw new Error(`CreativeWorkItem 不存在：${workItemId}`);
  if (before.artifactRefs.includes(artifactId)) {
    return before; // 幂等
  }
  const nextRefs = [...before.artifactRefs, artifactId];
  const result = await repository.pool.query<WorkItemRow>(
    `UPDATE creative_work_items SET artifact_refs = $2, updated_at = now()
     WHERE id = $1
     RETURNING id, run_id, kind, task_key, target_id, instruction, depends_on, status, artifact_refs, parameters, created_at, updated_at`,
    [workItemId, nextRefs],
  );
  if (!result.rowCount) throw new Error(`CreativeWorkItem 不存在：${workItemId}`);
  const workItem = mapWorkItemRow(result.rows[0]);
  await writeRunEvent(repository, workItem.runId, "work.artifact-attached", {
    workItemId: workItem.id,
    artifactId,
    artifactRefs: workItem.artifactRefs,
  });
  return workItem;
}
