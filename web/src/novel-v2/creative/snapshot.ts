/**
 * V2 创意执行 run 快照查询。
 *
 * 设计依据：AGENTS.md + Phase B-2 创意执行模块。
 *
 * 职责：
 * - getRunSnapshot：并行查询 run + work items + reviews + events，组装为 CreativeRunSnapshot
 *
 * 增量拉取：events 支持 afterSequence 参数（WHERE id > afterSequence），
 * 用于客户端轮询新事件而不重复拉取历史。
 *
 * 性能：4 个查询并行执行（Promise.all），单次快照查询延迟 ≈ 最慢的子查询。
 * reviews 通过 JOIN creative_work_items 过滤 run_id，避免 N+1 查询。
 */
import type {
  CreativeReview,
  CreativeReviewInput,
  CreativeRun,
  CreativeRunSnapshot,
  CreativeWorkItem,
  CreativeWorkKind,
  CreativeWorkStatus,
  ReviewIssue,
} from "../protocol";
import type { NovelPostgresRepository } from "../postgres-repository";
import { getCreativeRun } from "./run-manager";

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

type ReviewRow = {
  id: string;
  work_item_id: string;
  subject_artifact_id: string;
  reviewer: string;
  verdict: string;
  issues: unknown;
  summary: string;
  created_at: Date | string;
};

type EventRow = {
  id: string | number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date | string;
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

function mapReviewRow(row: ReviewRow): CreativeReview {
  const issues = Array.isArray(row.issues) ? (row.issues as ReviewIssue[]) : [];
  return {
    id: row.id,
    workItemId: row.work_item_id,
    subjectArtifactId: row.subject_artifact_id,
    reviewer: row.reviewer as CreativeReviewInput["reviewer"],
    verdict: row.verdict as CreativeReviewInput["verdict"],
    issues,
    summary: row.summary,
    createdAt: new Date(row.created_at).getTime(),
  };
}

function mapEventRow(row: EventRow): CreativeRunSnapshot["events"][number] {
  return {
    id: String(row.id),
    eventType: row.event_type,
    payload: row.payload ?? {},
    createdAt: new Date(row.created_at).getTime(),
  };
}

// ===== 公共接口 =====

/**
 * 查询 run 快照。
 *
 * 并行查询 creative_runs + creative_work_items + creative_reviews + creative_run_events，
 * 组装为 CreativeRunSnapshot。
 *
 * events 支持 afterSequence 增量拉取（WHERE id > afterSequence）。
 * 注意：afterSequence 是 creative_run_events.id（BIGSERIAL），不是 createdAt。
 *
 * run 不存在时返回 null。
 */
export async function getRunSnapshot(
  repository: NovelPostgresRepository,
  runId: string,
  afterSequence?: number,
): Promise<CreativeRunSnapshot | null> {
  // 1. 查询 run（若不存在直接返回 null，避免无意义的并行查询）
  const run: CreativeRun | null = await getCreativeRun(repository, runId);
  if (!run) return null;

  // 2. 并行查询 work items + reviews + events
  const [workItemsResult, reviewsResult, eventsResult] = await Promise.all([
    repository.pool.query<WorkItemRow>(
      "SELECT id, run_id, kind, task_key, target_id, instruction, depends_on, status, artifact_refs, parameters, created_at, updated_at FROM creative_work_items WHERE run_id = $1 ORDER BY created_at ASC",
      [runId],
    ),
    repository.pool.query<ReviewRow>(
      `SELECT r.id, r.work_item_id, r.subject_artifact_id, r.reviewer, r.verdict, r.issues, r.summary, r.created_at
       FROM creative_reviews r
       INNER JOIN creative_work_items w ON w.id = r.work_item_id
       WHERE w.run_id = $1
       ORDER BY r.created_at ASC`,
      [runId],
    ),
    repository.pool.query<EventRow>(
      afterSequence !== undefined
        ? "SELECT id, event_type, payload, created_at FROM creative_run_events WHERE run_id = $1 AND id > $2 ORDER BY id ASC"
        : "SELECT id, event_type, payload, created_at FROM creative_run_events WHERE run_id = $1 ORDER BY id ASC",
      afterSequence !== undefined ? [runId, afterSequence] : [runId],
    ),
  ]);

  return {
    run,
    workItems: workItemsResult.rows.map(mapWorkItemRow),
    reviews: reviewsResult.rows.map(mapReviewRow),
    events: eventsResult.rows.map(mapEventRow),
  };
}
