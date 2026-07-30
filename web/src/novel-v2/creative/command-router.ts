/**
 * V2 创意执行命令路由。
 *
 * 设计依据：AGENTS.md + Phase B-2 创意执行模块。
 *
 * 职责：
 * - executeCreativeCommand：统一命令入口，幂等检查 + 路由 + 事件记录
 *
 * 幂等性：
 * - 入口检查 creative_run_events WHERE payload->>'idempotencyKey' = $1 AND payload->>'result' IS NOT NULL
 * - 命令执行成功后写入 command.executed 事件，payload 含 idempotencyKey + result
 * - 重复提交返回缓存结果
 *
 * 命令路由：
 * - run.pause/resume/cancel → run-manager 对应函数
 * - work.start → work-item.startWork
 * - work.accept → review-gate.checkGate（manual 跳过）→ work-item.acceptWork
 * - work.revise → work-item.reviseWork
 * - work.retry → work-item.retryWork
 * - work.recover → work-item.recoverWork
 * - review.request → defaultReviewer 生成内部审核（调用 ModelGateway.generateStructured）
 * - review.submit → review-gate.submitReview；若 reviewGate="auto" 且 gate.passed → 自动 acceptWork
 */
import type {
  Artifact,
  CreativeActionResult,
  CreativeCommand,
  CreativeReviewInput,
  CreativeWorkItem,
  ExecutionBlueprint,
  MemoryBundle,
} from "../protocol";
import type { ModelGateway } from "../model-gateway";
import type { NovelPostgresRepository } from "../postgres-repository";
import { compileStageContext } from "../stage-context";
import {
  cancelCreativeRun,
  getCreativeRun,
  pauseCreativeRun,
  resumeCreativeRun,
} from "./run-manager";
import {
  acceptWork,
  recoverWork,
  reviseWork,
  retryWork,
  startWork,
} from "./work-item";
import { checkGate, submitReview } from "./review-gate";
import { buildChapterReviewPrompt } from "../prompts/chapter-review";
import { reviewerSchema, type ReviewerOutput } from "../prompts/schemas";

// ===== 幂等检查 =====

type CachedEventRow = {
  id: string;
  payload: Record<string, unknown>;
};

/**
 * 查询 idempotencyKey 是否已有缓存结果。
 *
 * 查询 creative_run_events WHERE payload->>'idempotencyKey' = $1 AND payload->>'result' IS NOT NULL。
 * 返回缓存的 CreativeActionResult（若存在）。
 */
async function findCachedResult(
  repository: NovelPostgresRepository,
  runId: string,
  idempotencyKey: string,
): Promise<CreativeActionResult | null> {
  const result = await repository.pool.query<CachedEventRow>(
    `SELECT id, payload FROM creative_run_events
     WHERE run_id = $1
       AND payload->>'idempotencyKey' = $2
       AND payload->>'result' IS NOT NULL
     ORDER BY id DESC
     LIMIT 1`,
    [runId, idempotencyKey],
  );
  if (!result.rowCount) return null;
  const payload = result.rows[0].payload;
  const rawResult = payload.result;
  if (!rawResult || typeof rawResult !== "object") return null;
  return rawResult as CreativeActionResult;
}

/**
 * 写入 command.executed 事件，payload 含 idempotencyKey + result。
 *
 * 这是幂等性的关键：后续相同 idempotencyKey 的命令会从 payload.result 取缓存结果。
 */
async function writeCommandEvent(
  repository: NovelPostgresRepository,
  runId: string,
  command: CreativeCommand,
  result: CreativeActionResult,
): Promise<void> {
  await repository.pool.query(
    "INSERT INTO creative_run_events(run_id, event_type, payload) VALUES($1, $2, $3)",
    [
      runId,
      "command.executed",
      {
        idempotencyKey: command.idempotencyKey,
        commandType: command.type,
        workItemId: "workItemId" in command ? command.workItemId : undefined,
        result,
      },
    ],
  );
}

// ===== 默认 reviewer =====

/**
 * 从 artifact.task_id 提取 blueprintId。
 *
 * artifact.task_id 格式：
 * - `${blueprintId}:draft` / `${blueprintId}:review` / `${blueprintId}:revise` 等
 * - 或纯 blueprintId（无冒号）
 */
function extractBlueprintId(taskId: string): string {
  return taskId.includes(":") ? taskId.split(":")[0] : taskId;
}

/**
 * 加载与 artifact 关联的 ExecutionBlueprint。
 *
 * 从 artifact.task_id 提取 blueprintId，查 execution_blueprints 表。
 * 失败时返回 null（不阻塞 review，prompt 退化为无 blueprint 上下文）。
 */
async function loadBlueprintForArtifact(
  repository: NovelPostgresRepository,
  artifact: { taskId: string },
): Promise<ExecutionBlueprint | null> {
  const blueprintId = extractBlueprintId(artifact.taskId);
  const payload = await repository.getRecord("execution_blueprints", blueprintId);
  if (!payload) return null;
  return payload as ExecutionBlueprint;
}

/**
 * 加载项目最近的 MemoryBundle。
 *
 * 与 temporal/activities.ts retrieveMemoryForReview 一致：查 memory_bundles 表，
 * 按 project_id + created_at DESC 取最新。无历史返回空 bundle。
 */
async function loadLatestMemoryBundle(
  repository: NovelPostgresRepository,
  projectId: string,
  preflightId: string,
): Promise<MemoryBundle> {
  const result = await repository.pool.query<{ payload: MemoryBundle }>(
    "SELECT payload FROM memory_bundles WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
    [projectId],
  );
  if (!result.rowCount) {
    return {
      id: `empty-memory:${projectId}:${Date.now()}`,
      projectId,
      preflightId,
      claims: [],
      conflicts: [],
      missingFacets: [],
      tokenBudget: 0,
      sourceRevisionIds: [],
      fingerprint: "empty",
      createdAt: Date.now(),
    };
  }
  return result.rows[0].payload;
}

/**
 * 把 ReviewerOutput（v2 reviewer schema）转换为 CreativeReviewInput。
 *
 * ReviewerOutput.issues 字段比 ReviewIssue 更丰富（含 dimension/revisionRanges/rule/suggestion/rewriteExample），
 * 转换时保留 ReviewIssue 接口所需的 severity/title/description/evidence/dimension/excerpt/revisionRanges/rule/sourceId。
 */
function reviewerOutputToCreativeInput(
  output: ReviewerOutput,
  artifactId: string,
): CreativeReviewInput {
  return {
    subjectArtifactId: artifactId,
    reviewer: "internal",
    verdict: output.verdict,
    issues: output.issues.map((issue) => ({
      severity: issue.severity,
      title: issue.title,
      description: issue.description,
      evidence: issue.excerpt ?? issue.description,
      dimension: issue.dimension,
      excerpt: issue.excerpt,
      paragraph: issue.paragraph,
      revisionRanges: issue.revisionRanges,
      rule: issue.rule,
      sourceId: issue.sourceId,
    })),
    summary: output.issues.length === 0
      ? `verdict=${output.verdict}，scores=${JSON.stringify(output.scores)}`
      : `${output.issues.length} 个问题，verdict=${output.verdict}`,
  };
}

/**
 * 默认内部 reviewer：调用 LLM 生成内部审核（reader-reviewer 角色）。
 *
 * 流程：
 * 1. 查询 work item 的 artifact_refs，取最新 artifact
 * 2. 从 artifact.payload 取 draft text
 * 3. 加载 blueprint（从 artifact.task_id 反查 execution_blueprints）
 * 4. 加载 memory bundle（查 memory_bundles 表）
 * 5. 用 buildChapterReviewPrompt 构造完整 prompt（reader-reviewer 角色，注入 blueprint + memory）
 * 6. 调用 model.generateStructured 生成 ReviewerOutput
 * 7. 转换为 CreativeReviewInput 返回
 *
 * 失败时不抛错，降级返回 verdict="revise" + issue="LLM 审核失败"（保持现有降级逻辑）。
 *
 * AGENTS.md 契约：reviewer identity = "internal"。
 */
export async function defaultReviewer(
  repository: NovelPostgresRepository,
  workItemId: string,
  model: ModelGateway,
): Promise<CreativeReviewInput> {
  const workResult = await repository.pool.query<{ artifact_refs: string[] | null; run_id: string }>(
    "SELECT artifact_refs, run_id FROM creative_work_items WHERE id = $1",
    [workItemId],
  );
  if (!workResult.rowCount) throw new Error(`Work item 不存在：${workItemId}`);
  const artifactRefs = workResult.rows[0].artifact_refs ?? [];
  if (!artifactRefs.length) throw new Error(`Work item ${workItemId} 无关联 artifact`);
  const latestArtifactId = artifactRefs[artifactRefs.length - 1];

  const artifactResult = await repository.pool.query<{
    project_id: string;
    task_id: string;
    payload: Record<string, unknown>;
  }>(
    "SELECT project_id, task_id, payload FROM artifacts WHERE id = $1",
    [latestArtifactId],
  );
  if (!artifactResult.rowCount) throw new Error(`Artifact 不存在：${latestArtifactId}`);
  const artifactRow = artifactResult.rows[0];
  const structuredData = artifactRow.payload ?? {};
  const draftText = typeof structuredData.text === "string" ? structuredData.text
    : typeof structuredData.draft === "string" ? structuredData.draft
    : typeof structuredData.content === "string" ? structuredData.content
    : JSON.stringify(structuredData);

  // 加载 blueprint（失败不阻塞）
  const blueprint = await loadBlueprintForArtifact(repository, { taskId: artifactRow.task_id });

  // 加载 memory bundle（失败不阻塞）
  let memoryBundle: MemoryBundle | null = null;
  try {
    memoryBundle = await loadLatestMemoryBundle(
      repository,
      artifactRow.project_id,
      blueprint?.preflightId ?? "no-preflight",
    );
  } catch {
    memoryBundle = null;
  }

  // 构造完整 review prompt（注入 blueprint + memory）
  // 若 blueprint 缺失，降级为简化 prompt（保持向后兼容）
  let reviewPrompt: string;
  if (blueprint && memoryBundle) {
    const artifactForPrompt: Artifact = {
      id: latestArtifactId,
      projectId: artifactRow.project_id,
      taskId: artifactRow.task_id,
      attemptId: "default-reviewer",
      kind: "draft",
      contentHash: "default-reviewer",
      structuredData,
      baseRevision: 0,
      createdAt: Date.now(),
      fingerprint: "default-reviewer",
    };
    reviewPrompt = buildChapterReviewPrompt({
      role: "reader-reviewer",
      artifact: artifactForPrompt,
      text: draftText,
      blueprint,
      memory: memoryBundle,
    });
  } else {
    // 降级：blueprint 或 memory 缺失，用简化 prompt
    reviewPrompt = `你是严苛的读者视角审校者。请审核以下章节内容，输出 JSON：
{
  "verdict": "passed" | "revise" | "blocked",
  "scores": { "style": 0-5, "character": 0-5, "continuity": 0-5, "plot": 0-5, "reader": 0-5 },
  "issues": [{ "severity": "blocker"|"major"|"warning", "title": "...", "description": "...", "excerpt": "...", "revisionRanges": [], "rule": "...", "suggestion": "...", "rewriteExample": "...", "dimension": "reader" }]
}

章节内容：
${draftText}`;
  }

  try {
    const system = "你是严苛的内部 reader-reviewer，只依据提供的正文和冻结上下文给出结构化审核。";
    const workflowId = workResult.rows[0].run_id;
    const promptPackage = compileStageContext({
      projectId: artifactRow.project_id,
      workflowId,
      purpose: "review.reader",
      stage: "review",
      system,
      schema: reviewerSchema as unknown as Record<string, unknown>,
      maxInputTokens: 128_000,
      reservedOutputTokens: 4_096,
      sections: [{ id: "creative-default-review", kind: "review", title: "默认读者审校任务与正文", text: reviewPrompt, priority: "critical", provenanceRefs: [latestArtifactId, workItemId], sourceArtifactId: latestArtifactId }],
    });
    const result = await model.generateStructured<ReviewerOutput>({
      purpose: "review.reader",
      schema: reviewerSchema,
      system,
      prompt: promptPackage.instruction,
      workflowRunId: workflowId,
      taskId: `${workItemId}:default-reviewer`,
      promptContext: promptPackage.manifest,
    });
    return reviewerOutputToCreativeInput(result.value, latestArtifactId);
  } catch (error) {
    // 失败时不抛错，返回 verdict="revise" + issue="LLM 审核失败"
    const message = error instanceof Error ? error.message : String(error);
    return {
      subjectArtifactId: latestArtifactId,
      reviewer: "internal",
      verdict: "revise",
      issues: [{ severity: "major", title: "LLM 审核失败", evidence: `error: ${message}` }],
      summary: `内部审核 LLM 调用失败，降级为 revise：${message}`,
    };
  }
}

// ===== 辅助：构造 CreativeActionResult =====

function buildResult(params: {
  runId: string;
  commandType: CreativeCommand["type"];
  status: CreativeActionResult["status"];
  workItemId?: string;
  workStatus?: CreativeActionResult["workStatus"];
  artifactRefs?: string[];
  reviewId?: string;
  reviewGate?: CreativeActionResult["reviewGate"];
  summary: string;
}): CreativeActionResult {
  return {
    runId: params.runId,
    commandType: params.commandType,
    workItemId: params.workItemId,
    status: params.status,
    workStatus: params.workStatus,
    artifactRefs: params.artifactRefs ?? [],
    reviewId: params.reviewId,
    reviewGate: params.reviewGate,
    summary: params.summary,
  };
}

// ===== 主入口 =====

/**
 * 执行创意命令。
 *
 * 流程：
 * 1. 幂等检查：查询 idempotencyKey 是否已有缓存结果，有则返回
 * 2. 路由命令到对应处理函数
 * 3. 写入 command.executed 事件（含 idempotencyKey + result）
 * 4. 返回 CreativeActionResult
 *
 * @param model 可选 LLM 网关；review.request 命令必填，其他命令忽略
 * @throws 若 run 不存在、work item 不存在、状态转换非法、review.request 缺少 model 等
 */
export async function executeCreativeCommand(
  repository: NovelPostgresRepository,
  command: CreativeCommand & { runId: string },
  model?: ModelGateway,
): Promise<CreativeActionResult> {
  const runId = command.runId;

  // 1. 校验 run 存在
  const run = await getCreativeRun(repository, runId);
  if (!run) {
    throw new Error(`CreativeRun 不存在：${runId}`);
  }

  // 2. 幂等检查
  const cached = await findCachedResult(repository, runId, command.idempotencyKey);
  if (cached) {
    return cached;
  }

  // 3. 路由命令
  let result: CreativeActionResult;

  switch (command.type) {
    case "run.pause": {
      const updated = await pauseCreativeRun(repository, runId);
      result = buildResult({
        runId,
        commandType: command.type,
        status: updated.status,
        summary: `Run paused (idempotencyKey=${command.idempotencyKey})`,
      });
      break;
    }

    case "run.resume": {
      const updated = await resumeCreativeRun(repository, runId);
      result = buildResult({
        runId,
        commandType: command.type,
        status: updated.status,
        summary: `Run resumed (idempotencyKey=${command.idempotencyKey})`,
      });
      break;
    }

    case "run.cancel": {
      const updated = await cancelCreativeRun(repository, runId);
      result = buildResult({
        runId,
        commandType: command.type,
        status: updated.status,
        summary: `Run cancelled (idempotencyKey=${command.idempotencyKey})`,
      });
      break;
    }

    case "work.start": {
      const workItem = await startWork(repository, command.workItemId);
      result = buildResult({
        runId,
        commandType: command.type,
        status: run.status,
        workItemId: workItem.id,
        workStatus: workItem.status,
        artifactRefs: workItem.artifactRefs,
        summary: `Work item ${workItem.id} started`,
      });
      break;
    }

    case "work.accept": {
      // manual gate 跳过 checkGate，直接 acceptWork（人工显式 accept）
      // auto/none gate 需先 checkGate，通过后才 acceptWork
      if (run.policy.reviewGate !== "manual") {
        const gate = await checkGate(repository, command.workItemId, run.policy);
        if (!gate.passed) {
          result = buildResult({
            runId,
            commandType: command.type,
            status: run.status,
            workItemId: command.workItemId,
            reviewGate: gate,
            summary: `Work accept blocked by gate: ${gate.reason}`,
          });
          break;
        }
      }
      const workItem = await acceptWork(repository, command.workItemId);
      // acceptWork 触发 updateRunStatusFromWork，重新查询 run 取最新 status
      const updatedRun = await getCreativeRun(repository, runId);
      result = buildResult({
        runId,
        commandType: command.type,
        status: updatedRun?.status ?? run.status,
        workItemId: workItem.id,
        workStatus: workItem.status,
        artifactRefs: workItem.artifactRefs,
        summary: `Work item ${workItem.id} accepted`,
      });
      break;
    }

    case "work.revise": {
      const workItem = await reviseWork(repository, command.workItemId, command.instruction);
      result = buildResult({
        runId,
        commandType: command.type,
        status: run.status,
        workItemId: workItem.id,
        workStatus: workItem.status,
        artifactRefs: workItem.artifactRefs,
        summary: `Work item ${workItem.id} revised (iteration=${workItem.parameters.iteration ?? 1})`,
      });
      break;
    }

    case "work.retry": {
      const workItem = await retryWork(repository, command.workItemId);
      result = buildResult({
        runId,
        commandType: command.type,
        status: run.status,
        workItemId: workItem.id,
        workStatus: workItem.status,
        artifactRefs: workItem.artifactRefs,
        summary: `Work item ${workItem.id} retried`,
      });
      break;
    }

    case "work.recover": {
      const workItem = await recoverWork(repository, command.workItemId, command.force);
      result = buildResult({
        runId,
        commandType: command.type,
        status: run.status,
        workItemId: workItem.id,
        workStatus: workItem.status,
        artifactRefs: workItem.artifactRefs,
        summary: `Work item ${workItem.id} recovered (force=${Boolean(command.force)})`,
      });
      break;
    }

    case "review.request": {
      if (!model) {
        throw new Error("review.request 需要 model（LLM 网关），但 executeCreativeCommand 未传入");
      }
      const reviewInput = await defaultReviewer(repository, command.workItemId, model);
      const review = await submitReview(repository, command.workItemId, reviewInput);
      // 若 reviewGate="auto"，检查 gate 是否通过，通过则自动 acceptWork
      let workItem: CreativeWorkItem | undefined;
      let gate = undefined;
      if (run.policy.reviewGate === "auto") {
        gate = await checkGate(repository, command.workItemId, run.policy);
        if (gate.passed) {
          workItem = await acceptWork(repository, command.workItemId);
        }
      }
      result = buildResult({
        runId,
        commandType: command.type,
        status: run.status,
        workItemId: command.workItemId,
        workStatus: workItem?.status,
        artifactRefs: workItem?.artifactRefs ?? [],
        reviewId: review.id,
        reviewGate: gate,
        summary: `Review ${review.id} requested (verdict=${review.verdict})`,
      });
      break;
    }

    case "review.submit": {
      const review = await submitReview(repository, command.workItemId, command.review);
      // 若 reviewGate="auto" 且 gate.passed → 自动 acceptWork
      let workItem: CreativeWorkItem | undefined;
      let gate = undefined;
      if (run.policy.reviewGate === "auto") {
        gate = await checkGate(repository, command.workItemId, run.policy);
        if (gate.passed) {
          workItem = await acceptWork(repository, command.workItemId);
        }
      }
      const updatedRun = workItem ? (await getCreativeRun(repository, runId)) ?? run : run;
      result = buildResult({
        runId,
        commandType: command.type,
        status: updatedRun.status,
        workItemId: command.workItemId,
        workStatus: workItem?.status,
        artifactRefs: workItem?.artifactRefs ?? [],
        reviewId: review.id,
        reviewGate: gate,
        summary: `Review ${review.id} submitted (verdict=${review.verdict})`,
      });
      break;
    }

    default: {
      // 穷尽性检查：TypeScript 会在 command.type 新增分支时报错
      const exhaustive: never = command;
      throw new Error(`未知的 CreativeCommand 类型：${JSON.stringify(exhaustive)}`);
    }
  }

  // 4. 写 command.executed 事件（含 idempotencyKey + result）
  await writeCommandEvent(repository, runId, command, result);

  return result;
}
