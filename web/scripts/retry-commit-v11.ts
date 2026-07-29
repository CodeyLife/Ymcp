/**
 * 一次性脚本：重试 v11 章节工作流的 commit 阶段。
 *
 * 背景：v11 workflow 在 commit 阶段因 postgres-repository.commitRevision 的 review.issues
 * JSON 序列化错误失败。已修复（显式 JSON.stringify），但 workflow 已 failed 无法自动重试。
 * 本脚本从 DB + objectStore 加载 v11 已生成的 artifact + reviews，直接调用 CommitService.commit()。
 *
 * 运行：node --import tsx scripts/retry-commit-v11.ts
 */
import { randomUUID } from "node:crypto";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";
import { ContentObjectStore } from "../src/novel-v2/object-store";
import { CommitService } from "../src/novel-v2/commit-service";
import { ModelConfigStore } from "../src/novel-v2/model-config-store";
import { RoutedModelGateway } from "../src/novel-v2/model-gateway";
import type { Artifact, Review } from "../src/novel-v2/protocol";

const PROJECT_ID = "prog-isekai-2026";
const DOCUMENT_ID = "add2ee7a-9e74-4827-b66d-124346f46550";
const ARTIFACT_ID = "9d03d09b-dc5a-45d8-b2de-0e31ea916942";
const OBJECT_KEY = "7b/2969ef5965345926c8f375286fa9b2d3f96ab44f442dd3a1a92c7b0bb74d1c";
const CONTENT_HASH = "7b2969ef5965345926c8f375286fa9b2d3f96ab44f442dd3a1a92c7b0bb74d1c";
const FINGERPRINT = "ed9bd920ef3c40f61d3605d2ad96a02b140715092998d7c325d07ac6f89e413a";
const BASE_REVISION = 0;
const TASK_ID = "blueprint:9895ef4f-b251-4566-9313-99aed63f40b9:draft:revise:revise";

async function main() {
  console.log("[retry-commit] 初始化 repository + objectStore...");
  const repository = new NovelPostgresRepository();
  await repository.pool.query("SELECT 1");
  const objects = new ContentObjectStore();

  console.log("[retry-commit] 从 objectStore 读取正文...");
  const text = await objects.getText(OBJECT_KEY);
  console.log(`[retry-commit] 正文长度：${text.length} 字符`);

  console.log("[retry-commit] 从 DB 加载 reviews...");
  const reviewResult = await repository.pool.query<{
    id: string;
    reviewer_id: string;
    identity: string;
    verdict: string;
    artifact_fingerprint: string;
    issues: unknown;
    model_provenance: unknown;
  }>(
    "SELECT id, reviewer_id, identity, verdict, artifact_fingerprint, issues, model_provenance FROM reviews WHERE artifact_id = $1 ORDER BY created_at",
    [ARTIFACT_ID],
  );
  console.log(`[retry-commit] 加载到 ${reviewResult.rowCount} 条 review`);

  const reviews: Review[] = reviewResult.rows.map((row) => ({
    id: row.id,
    projectId: PROJECT_ID,
    artifactId: ARTIFACT_ID,
    reviewerId: row.reviewer_id,
    identity: row.identity as "internal" | "independent",
    verdict: row.verdict as "passed" | "revise" | "blocked",
    issues: Array.isArray(row.issues) ? row.issues as Review["issues"] : [],
    createdAt: Date.now(),
    artifactFingerprint: row.artifact_fingerprint,
    modelProvenance: row.model_provenance as Review["modelProvenance"],
  }));

  // 双门检查
  const internalPassed = reviews.some((r) => r.identity === "internal" && r.verdict === "passed" && r.artifactFingerprint === FINGERPRINT);
  const independentPassed = reviews.some((r) => r.identity === "independent" && r.verdict === "passed" && r.artifactFingerprint === FINGERPRINT);
  console.log(`[retry-commit] 双门检查：internal=${internalPassed}, independent=${independentPassed}`);
  if (!internalPassed || !independentPassed) {
    throw new Error("双门未通过，无法 commit");
  }

  // 加载 artifact payload（structuredData）
  const artifactResult = await repository.pool.query<{
    task_id: string;
    kind: string;
    base_revision: number;
    fingerprint: string;
    payload: Record<string, unknown>;
  }>(
    "SELECT task_id, kind, base_revision, fingerprint, payload FROM artifacts WHERE id = $1",
    [ARTIFACT_ID],
  );
  if (!artifactResult.rowCount) throw new Error(`Artifact 不存在：${ARTIFACT_ID}`);

  const artifact: Artifact = {
    id: ARTIFACT_ID,
    projectId: PROJECT_ID,
    taskId: artifactResult.rows[0].task_id,
    attemptId: "retry-commit",
    kind: artifactResult.rows[0].kind as Artifact["kind"],
    contentHash: CONTENT_HASH,
    structuredData: artifactResult.rows[0].payload,
    baseRevision: Number(artifactResult.rows[0].base_revision),
    createdAt: Date.now(),
    fingerprint: artifactResult.rows[0].fingerprint,
  };

  console.log("[retry-commit] 初始化 CommitService（含 chapter memory 依赖）...");
  const configStore = new ModelConfigStore();
  await configStore.load();
  const modelGateway = new RoutedModelGateway(configStore);
  const routingSnapshot = modelGateway.getRoutingSnapshot();

  const commitService = new CommitService(repository, objects, {
    model: modelGateway,
    defaultRoutingSnapshot: routingSnapshot,
    workflowRunId: "retry-commit-v11",
    narrativeOrder: 1,
  });

  console.log("[retry-commit] 调用 commitService.commit()...");
  const result = await commitService.commit({
    projectId: PROJECT_ID,
    documentId: DOCUMENT_ID,
    artifact,
    text,
    reviews,
    baseRevision: BASE_REVISION,
    idempotencyKey: `ch1-commit-retry-${randomUUID()}`,
  });

  console.log("[retry-commit] 提交成功！");
  console.log(JSON.stringify(result, null, 2));

  await repository.close();
  process.exit(0);
}

main().catch((error) => {
  console.error("[retry-commit] 失败：", error);
  process.exit(1);
});
