/**
 * V2 创意执行审核门禁。
 *
 * 设计依据：AGENTS.md + Phase B-2 创意执行模块。
 *
 * 职责：
 * - submitReview：写入 creative_reviews + creative_run_events（review.recorded）
 * - listReviews：查询 work item 的所有审核
 * - evaluateReviewGate：纯函数，根据 reviews + policy 判定门禁是否通过
 * - checkGate：查询 work item 的 reviews，调用 evaluateReviewGate
 *
 * 门禁规则（evaluateReviewGate）：
 * - policy.reviewGate === "none" → 始终 passed=true（无门禁）
 * - policy.reviewGate === "manual" → 必须有外部签收(reviewer=human 或 independent)且
 *   verdict==="passed" 才放行；internal 自审不算外部签收。等待 reviewSubmittedSignal 唤醒后重判。
 * - policy.reviewGate === "auto" → 取最新 review，verdict==="passed" 且
 *   无 blocker/major open issue 且 score>=autoAcceptThreshold → passed=true
 *
 * score 计算：复用 revision-policy.scoreReviews 算法（基于 issue severity 反推）。
 * CreativeReviewInput 协议不含 score 字段，由本模块从 issues 派生。
 *
 * openIssues：所有 review 的 issues 投影为 status="open"（协议未定义 issue status，
 * 默认全部 open；未来若有 resolution 机制，需扩展 ReviewIssue）。
 */
import { randomUUID } from "node:crypto";
import type {
  CreativeReview,
  CreativeReviewGate,
  CreativeReviewInput,
  CreativeRunPolicy,
  ReviewIssue,
} from "../protocol";
import type { NovelPostgresRepository } from "../postgres-repository";

// ===== 行类型映射 =====

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

/**
 * 从 reviews 的 issues 计算 score（0-5）。
 *
 * 算法与 revision-policy.scoreReviews 一致：
 * - 无 issue = 5 分
 * - 每个 major 扣 0.5 分
 * - 每个 blocker 扣 1.5 分
 * - 最低 0 分
 *
 * 不直接 import revision-policy 以避免 creative 模块对 temporal 模块的依赖。
 */
function computeScore(reviews: CreativeReview[]): number {
  if (!reviews.length) return 0;
  const issues = reviews.flatMap((r) => r.issues);
  if (!issues.length) return 5;
  let score = 5;
  for (const issue of issues) {
    if (issue.severity === "blocker") score -= 1.5;
    else if (issue.severity === "major") score -= 0.5;
  }
  return Math.max(0, score);
}

/**
 * 收集所有 reviews 的 issues，标记为 status="open"。
 *
 * 协议 ReviewIssue 不含 status 字段，CreativeReviewGate.openIssues 要求 status，
 * 此处统一投影为 "open"。未来若协议扩展 issue resolution，需更新此函数。
 */
function collectOpenIssues(reviews: CreativeReview[]): Array<ReviewIssue & { status: "open" | "resolved" }> {
  const seen = new Set<string>();
  const result: Array<ReviewIssue & { status: "open" | "resolved" }> = [];
  for (const review of reviews) {
    for (const issue of review.issues) {
      // 用 title+evidence 做简单去重键，避免同一 issue 被多个 reviewer 重复计入
      const key = `${issue.title}|${issue.evidence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...issue, status: "open" });
    }
  }
  return result;
}

function hasBlockerOrMajor(issues: Array<ReviewIssue & { status: "open" | "resolved" }>): boolean {
  return issues.some((i) => i.status === "open" && (i.severity === "blocker" || i.severity === "major"));
}

// ===== 公共接口 =====

/**
 * 提交审核。写入 creative_reviews + creative_run_events（review.recorded）。
 *
 * 校验：
 * - work item 存在
 * - verdict/reviewer 合法
 * - subjectArtifactId 非空
 */
export async function submitReview(
  repository: NovelPostgresRepository,
  workItemId: string,
  review: CreativeReviewInput,
): Promise<CreativeReview> {
  // 1. 校验 work item 存在并取 runId
  const workResult = await repository.pool.query<{ id: string; run_id: string }>(
    "SELECT id, run_id FROM creative_work_items WHERE id = $1",
    [workItemId],
  );
  if (!workResult.rowCount) {
    throw new Error(`CreativeWorkItem 不存在：${workItemId}`);
  }
  const runId = workResult.rows[0].run_id;

  // 2. 校验 review 字段
  if (!review.subjectArtifactId || !review.subjectArtifactId.trim()) {
    throw new Error("review.subjectArtifactId 不能为空");
  }
  const validReviewers = ["internal", "independent", "human"];
  if (!validReviewers.includes(review.reviewer)) {
    throw new Error(`review.reviewer 非法：${review.reviewer}`);
  }
  const validVerdicts = ["passed", "revise", "blocked"];
  if (!validVerdicts.includes(review.verdict)) {
    throw new Error(`review.verdict 非法：${review.verdict}`);
  }
  if (!Array.isArray(review.issues)) {
    throw new Error("review.issues 必须是数组");
  }
  if (typeof review.summary !== "string") {
    throw new Error("review.summary 必须是字符串");
  }

  // 3. 插入 creative_reviews
  const id = randomUUID();
  // pg v8 对 JS 数组使用 PostgreSQL array literal 序列化（{elem1,elem2}）而非 JSON,
  // 直接传 review.issues 数组到 JSONB 列会触发 "invalid input syntax for type json"。
  // 显式 JSON.stringify,让 pg 以字符串发送,PostgreSQL 再解析为 jsonb。
  // 约定同 postgres-repository.ts putReview、craft-rule/index.ts、experiment-workspace.ts。
  // 注意 creative_run_events.payload 是普通对象 {…},pg 会正确序列化为 JSON,无需 stringify。
  const insertResult = await repository.pool.query<ReviewRow>(
    `INSERT INTO creative_reviews(id, work_item_id, subject_artifact_id, reviewer, verdict, issues, summary)
     VALUES($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, work_item_id, subject_artifact_id, reviewer, verdict, issues, summary, created_at`,
    [id, workItemId, review.subjectArtifactId, review.reviewer, review.verdict, JSON.stringify(review.issues), review.summary],
  );
  const created = mapReviewRow(insertResult.rows[0]);

  // 4. 写 review.recorded 事件
  await writeRunEvent(repository, runId, "review.recorded", {
    reviewId: created.id,
    workItemId,
    reviewer: created.reviewer,
    verdict: created.verdict,
    issueCount: created.issues.length,
    summary: created.summary,
  });

  return created;
}

/**
 * 查询 work item 的所有审核（按 created_at ASC）。
 */
export async function listReviews(
  repository: NovelPostgresRepository,
  workItemId: string,
): Promise<CreativeReview[]> {
  const result = await repository.pool.query<ReviewRow>(
    "SELECT id, work_item_id, subject_artifact_id, reviewer, verdict, issues, summary, created_at FROM creative_reviews WHERE work_item_id = $1 ORDER BY created_at ASC",
    [workItemId],
  );
  return result.rows.map(mapReviewRow);
}

/** A Foundation artifact needs an independent dedicated review before author sign-off can accept it. */
export function hasPassedIndependentReviewForArtifact(reviews: CreativeReview[], subjectArtifactId: string): boolean {
  const relevant = reviews.filter((review) => review.reviewer === "independent" && review.subjectArtifactId === subjectArtifactId);
  const latest = relevant.reduce<CreativeReview | undefined>((selected, review) =>
    !selected || review.createdAt >= selected.createdAt ? review : selected, undefined);
  return latest?.verdict === "passed";
}

/**
 * 纯函数：判定门禁是否通过。
 *
 * 规则：
 * - policy.reviewGate === "none" → 始终 passed=true，reason="gate disabled"
 * - policy.reviewGate === "manual" → 必须有外部签收(reviewer=human 或 independent)且
 *   verdict="passed" 才放行。无外部签收或最新外部 verdict≠passed → passed=false，
 *   reason="manual gate requires human or independent accept"。workflows.ts 用 reason.includes("manual gate")
 *   判定是否等待 reviewSubmittedSignal；故 reason 必须保留 "manual gate" 子串。
 *   internal 自审不算外部签收(保留 manual gate 的"须外部认可"语义)。
 * - policy.reviewGate === "auto"：
 *   - 无 review → passed=false，reason="no reviews"
 *   - 最新 review.verdict !== "passed" → passed=false，reason="latest verdict is X"
 *   - 存在 open blocker/major issue → passed=false，reason="has open blocker/major"
 *   - score < autoAcceptThreshold → passed=false，reason="score X < threshold Y"
 *   - 否则 → passed=true，reason="auto gate passed"
 *
 * score 从所有 reviews 的 issues 派生（computeScore），openIssues 聚合所有 reviews 的 issues。
 */
export function evaluateReviewGate(
  reviews: CreativeReview[],
  policy: CreativeRunPolicy,
  subjectArtifactId?: string,
): CreativeReviewGate {
  // A revised artifact must receive a fresh review. Older reviews remain audit history,
  // but cannot satisfy the current artifact's gate.
  const relevantReviews = subjectArtifactId
    ? reviews.filter((review) => review.subjectArtifactId === subjectArtifactId)
    : reviews;
  const openIssues = collectOpenIssues(relevantReviews);

  if (policy.reviewGate === "none") {
    return {
      passed: true,
      openIssues,
      reason: "gate disabled (reviewGate=none)",
    };
  }

  if (policy.reviewGate === "manual") {
    // manual gate 要求"外部签收":reviewer=human(人工)或 independent(外部 LLM/异构审核)。
    // internal 自审不算外部签收——保留 manual gate "须外部认可才放行" 的语义。
    // 设计依据:用户要求"外部 LLM 也要参与架构产物的审核";此前仅认 human 导致
    // external-LLM verdict=passed 仍被无视 → 触发 reviseWork 重生(即便已通过)。
    // reason 必须保留 "manual gate" 子串,workflows.ts:829 用 includes("manual gate")
    // 判定进入 reviewSubmittedSignal 等待循环。
    const latestExternalReview = [...relevantReviews]
      .reverse()
      .find(
        (review) =>
          (review.reviewer === "human" || review.reviewer === "independent") &&
          (!subjectArtifactId || review.subjectArtifactId === subjectArtifactId),
      );
    if (latestExternalReview?.verdict === "passed") {
      return {
        passed: true,
        verdict: latestExternalReview.verdict,
        reviewer: latestExternalReview.reviewer,
        openIssues: latestExternalReview.issues.map((issue) => ({ ...issue, status: "open" as const })),
        reason: `manual gate passed by ${latestExternalReview.reviewer} review`,
      };
    }
    return {
      passed: false,
      openIssues,
      reason: "manual gate requires human or independent accept",
    };
  }

  // auto gate
  if (relevantReviews.length === 0) {
    return {
      passed: false,
      openIssues,
      reason: "no reviews",
    };
  }

  // 取最新 review（按 createdAt DESC）
  const sorted = [...relevantReviews].sort((a, b) => b.createdAt - a.createdAt);
  const latest = sorted[0];

  if (latest.verdict !== "passed") {
    return {
      passed: false,
      verdict: latest.verdict,
      reviewer: latest.reviewer,
      openIssues,
      reason: `latest verdict is ${latest.verdict}`,
    };
  }

  if (hasBlockerOrMajor(openIssues)) {
    return {
      passed: false,
      verdict: latest.verdict,
      reviewer: latest.reviewer,
      openIssues,
      reason: "has open blocker/major issue",
    };
  }

  const score = computeScore(relevantReviews);
  const threshold = policy.autoAcceptThreshold ?? 0;
  if (score < threshold) {
    return {
      passed: false,
      verdict: latest.verdict,
      reviewer: latest.reviewer,
      openIssues,
      reason: `score ${score.toFixed(2)} < threshold ${threshold}`,
    };
  }

  return {
    passed: true,
    verdict: latest.verdict,
    reviewer: latest.reviewer,
    openIssues,
    reason: `auto gate passed (score=${score.toFixed(2)}, threshold=${threshold})`,
  };
}

/**
 * 查询 work item 的 reviews，调用 evaluateReviewGate。
 *
 * 自动从 work item 反查 runId → run.policy。
 */
export async function checkGate(
  repository: NovelPostgresRepository,
  workItemId: string,
  policy: CreativeRunPolicy,
): Promise<CreativeReviewGate> {
  const [reviews, work] = await Promise.all([
    listReviews(repository, workItemId),
    repository.pool.query<{ artifact_refs: string[] }>("SELECT artifact_refs FROM creative_work_items WHERE id=$1", [workItemId]),
  ]);
  const refs = work.rows[0]?.artifact_refs ?? [];
  return evaluateReviewGate(reviews, policy, refs.at(-1));
}
