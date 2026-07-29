/**
 * V2 MCP 工具处理函数（23 个工具的 handler 实现）。
 *
 * 设计依据：AGENTS.md 架构阶段 + Phase B-2 MCP 工具网关。
 *
 * 职责：
 * - 实现 23 个工具的具体调用逻辑
 * - 路由到 creative/ + evaluation/ + postgres-repository 模块
 * - 返回标准 JSON-serializable 结果（executeTool 包装为 McpToolResponse）
 *
 * 工具分组（与 tool-definitions.ts 对齐）：
 * - Run / Action 主体（7）
 * - Catalog / Receipt（3）
 * - Craft Rule 候选演进（7）—— 基于 craft-rule 模块（Postgres）
 * - 项目生命周期（3）
 * - 一键流程（2）—— foundation bootstrap 与章节审校 workflow
 * - 评估闭环（1，v2 新增）
 *
 * 与 v1 的区别：v1 用 IndexedDB + CreativeToolEnvelope，v2 全部基于
 * NovelPostgresRepository + creative/evaluation 模块。
 */
import { randomUUID } from "node:crypto";
import type { ToolHandler, ToolContext } from "./types";
import type {
  CreativeCommand,
  CreativeReviewInput,
  CreativeRunMode,
  CreativeRunPolicy,
  CreativeWorkKind,
  NovelIntent,
} from "../protocol";
import { startNovelBootstrap } from "../application/bootstrap";
import { provisionalTitle } from "../application/provisional-title";
import { startStoryArcPlanning } from "../application/story-arc-workflow";
import {
  createCreativeRun,
  executeCreativeCommand,
  getRunSnapshot,
  listCreativeRuns,
  updateRunStatusFromWork,
  enqueueCreativeWork,
  listWorkItems,
  submitReview,
} from "../creative";
import { runClosedLoop } from "../evaluation/closed-loop";
import {
  createCraftRuleCandidate,
  inspectCraftRuleCandidate,
  recordCraftRuleEvidence,
  evaluateCraftRuleOnFoundation,
  submitCraftRuleReview,
  promoteCraftRuleCandidate,
  rollbackCraftRuleCandidate,
  type CraftRuleScopeAnalysis,
} from "../craft-rule";

// ===== 辅助：类型断言 =====

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * 解析可选的 reviewGate / progression 入参为 bootstrap 可用的强类型值。
 *
 * 设计依据：tool-definitions.ts 中 novel_project_create / novel_bootstrap_run
 * 已暴露 reviewGate(manual|auto|none) 与 progression(automatic|user-driven)。
 * 非法值统一回退 undefined,由 startNovelBootstrap 兜底为 "none" / "automatic",
 * 避免 MCP 调用方传错枚举值时直接抛错。
 */
function parseBootstrapPolicy(args: Record<string, unknown>): {
  reviewGate?: "manual" | "auto" | "none";
  progression?: "automatic" | "user-driven";
} {
  const reviewGateRaw = asString(args.reviewGate);
  const progressionRaw = asString(args.progression);
  return {
    reviewGate:
      reviewGateRaw === "manual" || reviewGateRaw === "auto" || reviewGateRaw === "none"
        ? reviewGateRaw
        : undefined,
    progression:
      progressionRaw === "automatic" || progressionRaw === "user-driven"
        ? (progressionRaw as "automatic" | "user-driven")
        : undefined,
  };
}

/**
 * 向 creativeRunWorkflow 发 reviewSubmitted 信号,唤醒 manual-gate 等待循环。
 *
 * 设计依据(根因修复):
 * - review-gate.ts evaluateReviewGate 的 manual 分支要求 reviewer=human 且 verdict=passed 才放行;
 * - workflows.ts processWorkItem 在 manual gate 下持久等待 reviewSubmittedSignal(defineSignal<[string]>),
 *   信号 payload 是单个 workItemId 字符串;
 * - 但 submitReview(review-gate.ts)只写 creative_reviews 表,不发 Temporal 信号,
 *   导致 reviewGate=manual 的 bootstrap run 在每阶段生成后死锁——
 *   这正是"架构 10 阶段没有审核"的底层机制(MCP 层未暴露 reviewGate + 信号通道断裂)。
 *
 * 本 helper 在 review 落库后补发信号,接通 manual-gate 闭环。
 *
 * 容错:workflow 可能已 completed/cancelled(如 reviewGate=none 的旧 run),
 * getHandle().signal() 会抛 WorkflowNotFoundError 类异常;review 落库已成功,
 * 信号失败不阻塞主流程,静默吞掉即可。
 */
async function signalReviewSubmitted(ctx: ToolContext, workItemId: string): Promise<void> {
  if (!ctx.temporal) return;
  try {
    const result = await ctx.repository.pool.query<{ run_id: string }>(
      "SELECT run_id FROM creative_work_items WHERE id = $1",
      [workItemId],
    );
    const runId = result.rows[0]?.run_id;
    if (!runId) return;
    const handle = ctx.temporal.workflow.getHandle(runId);
    // 信号名 "reviewSubmitted" 与 workflows.ts reviewSubmittedSignal 定义对齐;
    // payload 为单个 workItemId 字符串(defineSignal<[string]>)。
    await handle.signal("reviewSubmitted", workItemId);
  } catch {
    // workflow 已结束/不可达,或 work item 不存在——review 落库已成功,信号失败不阻塞。
    // TODO P2: 结构化日志记录 signal 失败,便于排查 manual-gate 死锁。
  }
}

// ===== Run / Action 主体（7）=====

const novel_run_create: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const mode = asString(args.mode) as CreativeRunMode;
  const idempotencyKey = asString(args.idempotencyKey);
  if (!projectId || !mode || !idempotencyKey) {
    throw new Error("projectId/mode/idempotencyKey 必填且非空");
  }

  const policyInput = asRecord(args.policy);
  const policy: Partial<CreativeRunPolicy> | undefined = policyInput
    ? (() => {
        const result: Partial<CreativeRunPolicy> = {};
        const maxRetries = asNumber(policyInput.maxRetries);
        if (maxRetries !== undefined) result.maxRetries = maxRetries;
        if (
          policyInput.reviewGate === "manual" ||
          policyInput.reviewGate === "auto" ||
          policyInput.reviewGate === "none"
        ) {
          result.reviewGate = policyInput.reviewGate;
        }
        const autoAcceptThreshold = asNumber(policyInput.autoAcceptThreshold);
        if (autoAcceptThreshold !== undefined) result.autoAcceptThreshold = autoAcceptThreshold;
        return Object.keys(result).length > 0 ? result : undefined;
      })()
    : undefined;

  // TODO P2: payload 用于存储 objective/章节计划等业务参数，当前透传
  const payload = asRecord(args.payload) ?? {};

  const run = await createCreativeRun(ctx.repository, {
    projectId,
    mode,
    policy,
    payload,
  });

  return { run };
};

const novel_run_get: ToolHandler = async (args, ctx) => {
  const runId = asString(args.runId);
  if (!runId) throw new Error("runId 必填");
  const afterSequence = asNumber(args.afterSequence);
  const snapshot = await getRunSnapshot(ctx.repository, runId, afterSequence);
  if (!snapshot) throw new Error(`CreativeRun 不存在：${runId}`);
  return snapshot;
};

const novel_action_list: ToolHandler = async (args, ctx) => {
  const runId = asString(args.runId);
  if (!runId) throw new Error("runId 必填");
  const workItems = await listWorkItems(ctx.repository, runId);
  return { workItems };
};

const novel_action_execute: ToolHandler = async (args, ctx) => {
  const runId = asString(args.runId);
  const action = asString(args.action);
  const idempotencyKey = asString(args.idempotencyKey);
  if (!runId || !action || !idempotencyKey) {
    throw new Error("runId/action/idempotencyKey 必填且非空");
  }

  // work.enqueue 不在 CreativeCommand 类型中，单独处理
  if (action === "work.enqueue") {
    const workInput = asRecord(args.work);
    if (!workInput) throw new Error("work.enqueue 需要 work 参数");
    const kind = asString(workInput.kind) as CreativeWorkKind;
    const instruction = asString(workInput.instruction);
    if (!kind || !instruction) throw new Error("work.kind 与 work.instruction 必填");

    const workItem = await enqueueCreativeWork(ctx.repository, runId, {
      kind,
      taskKey: asString(workInput.taskKey) || undefined,
      targetId: asString(workInput.targetId) || undefined,
      instruction,
      dependsOn: asStringArray(workInput.dependsOn) ?? [],
      parameters: asRecord(workInput.parameters) ?? {},
    });
    return { workItem };
  }

  // 其他 action 走 executeCreativeCommand（已含幂等检查）
  const command = buildCreativeCommand(args, runId, action, idempotencyKey);
  const result = await executeCreativeCommand(ctx.repository, command, ctx.model);

  // review.submit / review.request / work.accept 落库后向 creativeRunWorkflow 发 reviewSubmitted 信号,
  // 唤醒 manual-gate 等待循环(与 novel_review_submit 对齐,补齐信号通道)。
  // reviewGate=none/auto 的 run 信号会被静默忽略。workItemId 从 command 提取;
  // review.request 的 workItemId 在 command 上,review.submit 同理。
  // work.accept 也需要发信号:外部 accept 命令绕过 gate 直接改状态后,
  // workflow 仍阻塞在 manual-gate while 循环;信号唤醒后 processWorkItem 检查
  // status===accepted 短路返回,让 loop 推进下游 work items。
  if (action === "review.submit" || action === "review.request" || action === "work.accept") {
    const workItemId = asString(args.workItemId);
    if (workItemId) await signalReviewSubmitted(ctx, workItemId);
  }

  return { result };
};

/**
 * 从 args 构造 CreativeCommand。
 *
 * action 已校验非空，idempotencyKey 已校验非空。
 * 根据 action 类型提取 workItemId/instruction/force/review 等字段。
 */
function buildCreativeCommand(
  args: Record<string, unknown>,
  runId: string,
  action: string,
  idempotencyKey: string,
): CreativeCommand & { runId: string } {
  const base = { runId, idempotencyKey };

  switch (action) {
    case "work.start":
    case "work.accept":
    case "work.retry": {
      const workItemId = asString(args.workItemId);
      if (!workItemId) throw new Error(`${action} 需要 workItemId`);
      return { type: action, workItemId, ...base } as CreativeCommand & { runId: string };
    }

    case "work.revise": {
      const workItemId = asString(args.workItemId);
      if (!workItemId) throw new Error("work.revise 需要 workItemId");
      const instruction = asString(args.instruction) || undefined;
      return { type: "work.revise", workItemId, instruction, ...base };
    }

    case "work.recover": {
      const workItemId = asString(args.workItemId);
      if (!workItemId) throw new Error("work.recover 需要 workItemId");
      const force = asBoolean(args.force);
      return { type: "work.recover", workItemId, force, ...base };
    }

    case "review.request": {
      const workItemId = asString(args.workItemId);
      if (!workItemId) throw new Error("review.request 需要 workItemId");
      return { type: "review.request", workItemId, ...base };
    }

    case "review.submit": {
      const workItemId = asString(args.workItemId);
      if (!workItemId) throw new Error("review.submit 需要 workItemId");
      const reviewInput = asRecord(args.review);
      if (!reviewInput) throw new Error("review.submit 需要 review 参数");
      const review = parseReviewInput(reviewInput);
      return { type: "review.submit", workItemId, review, ...base };
    }

    case "run.pause":
      return { type: "run.pause", ...base };
    case "run.resume":
      return { type: "run.resume", ...base };
    case "run.cancel":
      return { type: "run.cancel", ...base };

    default:
      throw new Error(`未知的 action 类型：${action}`);
  }
}

/**
 * 解析 review input（从 args.record 转 CreativeReviewInput）。
 *
 * 校验 reviewer/verdict 在合法枚举内，issues 是数组。
 */
function parseReviewInput(input: Record<string, unknown>): CreativeReviewInput {
  const subjectArtifactId = asString(input.subjectArtifactId);
  const reviewer = asString(input.reviewer);
  const verdict = asString(input.verdict);
  const summary = asString(input.summary);

  if (!subjectArtifactId) throw new Error("review.subjectArtifactId 必填");
  if (reviewer !== "internal" && reviewer !== "independent" && reviewer !== "human") {
    throw new Error(`review.reviewer 非法：${reviewer}`);
  }
  if (verdict !== "passed" && verdict !== "revise" && verdict !== "blocked") {
    throw new Error(`review.verdict 非法：${verdict}`);
  }
  if (!Array.isArray(input.issues)) throw new Error("review.issues 必须是数组");
  if (typeof summary !== "string") throw new Error("review.summary 必须是字符串");

  return {
    subjectArtifactId,
    reviewer,
    verdict,
    issues: input.issues as CreativeReviewInput["issues"],
    summary,
  };
}

const novel_artifact_get: ToolHandler = async (args, ctx) => {
  const artifactId = asString(args.artifactId);
  if (!artifactId) throw new Error("artifactId 必填");

  const artifact = await ctx.repository.getArtifact(artifactId);
  if (!artifact) throw new Error(`Artifact 不存在：${artifactId}`);
  return { artifact };
};

const novel_review_submit: ToolHandler = async (args, ctx) => {
  const workItemId = asString(args.workItemId);
  const reviewInput = asRecord(args.review);
  if (!workItemId) throw new Error("workItemId 必填");
  if (!reviewInput) throw new Error("review 必填");

  const review = parseReviewInput(reviewInput);
  const created = await submitReview(ctx.repository, workItemId, review);

  // 接通 manual-gate 闭环:review 落库后向 creativeRunWorkflow 发 reviewSubmitted 信号,
  // 唤醒 processWorkItem 中等待信号的 manual gate(reviewGate=manual 时必备)。
  // reviewGate=none/auto 的 run 信号会被静默忽略(workflow 已结束或不在等待态)。
  await signalReviewSubmitted(ctx, workItemId);

  // 若 run.policy.reviewGate=auto，检查 gate 并自动 accept
  // 注意：本工具不直接触发自动 accept，由调用方根据返回的 review 决定后续动作。
  // 若需自动 accept，应使用 novel_action_execute 的 review.submit action（带自动 gate）。
  return { review: created };
};

const novel_run_complete: ToolHandler = async (args, ctx) => {
  const runId = asString(args.runId);
  if (!runId) throw new Error("runId 必填");

  // updateRunStatusFromWork 会根据所有 work items 的状态决定 run 是否完成
  await updateRunStatusFromWork(ctx.repository, runId);

  // 取最新状态返回
  const snapshot = await getRunSnapshot(ctx.repository, runId);
  if (!snapshot) throw new Error(`CreativeRun 不存在：${runId}`);

  // 校验所有 work items 必须为 accepted 且无 blocker issue
  const hasUnfinished = snapshot.workItems.some(
    (w) => w.status !== "accepted" && w.status !== "recovered",
  );
  const hasBlocker = snapshot.reviews.some((r) =>
    r.issues.some((i) => i.severity === "blocker"),
  );

  if (hasUnfinished) {
    return {
      completed: false,
      reason: "存在未完成的 work items",
      run: snapshot.run,
    };
  }
  if (hasBlocker) {
    return {
      completed: false,
      reason: "存在 blocker issue 未解决",
      run: snapshot.run,
    };
  }

  return {
    completed: true,
    run: snapshot.run,
  };
};

// ===== Catalog / Receipt（3）=====

const novel_catalog_get: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填");

  // 并行查询项目详情 + creative runs
  const [project, runs] = await Promise.all([
    ctx.repository.getProjectDetail(projectId),
    listCreativeRuns(ctx.repository, projectId),
  ]);

  return {
    project,
    creativeRuns: runs,
  };
};

const novel_receipt_get: ToolHandler = async (args, ctx) => {
  const receiptId = asString(args.receiptId);
  if (!receiptId) throw new Error("receiptId 必填");

  const receipt = await ctx.repository.getPromotionReceiptById(receiptId);
  if (!receipt) throw new Error(`PromotionReceipt 不存在：${receiptId}`);
  return { receipt };
};

const novel_rule_target_get: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const targetKind = asString(args.targetKind);
  const targetId = asString(args.targetId);
  if (!projectId || !targetKind || !targetId) throw new Error("projectId/targetKind/targetId 必填");

  if (targetKind === "system-prompt") {
    const separator = targetId.indexOf(":");
    const promptProjectId = separator >= 0 ? targetId.slice(0, separator) : projectId;
    const templateId = separator >= 0 ? targetId.slice(separator + 1) : targetId;
    if (!promptProjectId || !templateId) throw new Error("system-prompt targetId 格式非法");
    const promptTemplate = await ctx.repository.getCraftRuleTarget({ kind: "system-prompt", projectId: promptProjectId, targetId: templateId });
    if (!promptTemplate) throw new Error(`PromptTemplate 不存在：${promptProjectId}:${templateId}`);
    return { promptTemplate };
  }
  if (targetKind !== "skill") throw new Error(`targetKind 非法：${targetKind}`);

  const skill = await ctx.repository.getCraftRuleTarget({ kind: "skill", projectId, targetId });
  if (!skill) throw new Error(`SkillDefinition 不存在：${targetId}`);
  return { skill };
};

// ===== Craft Rule 候选演进（7）=====

const novel_rule_candidate_create: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const targetKind = asString(args.targetKind) as "skill" | "system-prompt";
  const targetId = asString(args.targetId);
  const afterText = asString(args.afterText);
  const rationale = asString(args.rationale);
  if (!projectId || !targetKind || !targetId || !afterText || !rationale) {
    throw new Error("projectId/targetKind/targetId/afterText/rationale 必填且非空");
  }
  const scopeInput = asRecord(args.scope) ?? {};
  const scope: CraftRuleScopeAnalysis = {
    observedSymptom: asString(scopeInput.observedSymptom) ?? "",
    failingLayer: asString(scopeInput.failingLayer) ?? "",
    underlyingMechanism: asString(scopeInput.underlyingMechanism) ?? "",
    affectedInputClass: asString(scopeInput.affectedInputClass) ?? "",
    intendedBenefits: Array.isArray(scopeInput.intendedBenefits) ? scopeInput.intendedBenefits as string[] : [],
    boundaries: Array.isArray(scopeInput.boundaries) ? scopeInput.boundaries as string[] : [],
    nonGoals: Array.isArray(scopeInput.nonGoals) ? scopeInput.nonGoals as string[] : [],
    regressionRisks: Array.isArray(scopeInput.regressionRisks) ? scopeInput.regressionRisks as string[] : [],
  };
  const candidate = await createCraftRuleCandidate(ctx.repository, {
    projectId, targetKind, targetId, afterText, rationale, scope,
  });
  return { candidate };
};

const novel_rule_candidate_get: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const candidateId = asString(args.candidateId);
  if (!projectId || !candidateId) throw new Error("projectId/candidateId 必填且非空");
  const candidate = await inspectCraftRuleCandidate(ctx.repository, projectId, candidateId);
  if (!candidate) throw new Error(`CraftRuleCandidate 不存在：${candidateId}`);
  return { candidate };
};

const novel_rule_evidence_submit: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const candidateId = asString(args.candidateId);
  const scenarioClass = asString(args.scenarioClass);
  const scenarioRole = asString(args.scenarioRole) as "source-failure" | "cross-scenario";
  const baselineWorkItemId = asString(args.baselineWorkItemId);
  const candidateWorkItemId = asString(args.candidateWorkItemId);
  if (!projectId || !candidateId || !scenarioClass || !scenarioRole || !baselineWorkItemId || !candidateWorkItemId) {
    throw new Error("projectId/candidateId/scenarioClass/scenarioRole/baselineWorkItemId/candidateWorkItemId 必填且非空");
  }
  const candidate = await recordCraftRuleEvidence(ctx.repository, {
    projectId, candidateId, scenarioClass, scenarioRole, baselineWorkItemId, candidateWorkItemId,
  });
  return { candidate };
};

const novel_rule_foundation_evaluate: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const candidateId = asString(args.candidateId);
  const taskKey = asString(args.taskKey) as
    | "project-positioning" | "architecture" | "story-bible"
    | "characters" | "relations" | "worldview";
  const scenarioClass = asString(args.scenarioClass);
  const scenarioRole = asString(args.scenarioRole) as "source-failure" | "cross-scenario";
  const instruction = asString(args.instruction) || undefined;
  if (!projectId || !candidateId || !taskKey || !scenarioClass || !scenarioRole) {
    throw new Error("projectId/candidateId/taskKey/scenarioClass/scenarioRole 必填且非空");
  }
  if (!ctx.model) throw new Error("novel_rule_foundation_evaluate 需要 ctx.model");
  const result = await evaluateCraftRuleOnFoundation(ctx.repository, ctx.model, {
    projectId, candidateId, taskKey, scenarioClass, scenarioRole, instruction,
  });
  return result;
};

const novel_rule_review_submit: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const candidateId = asString(args.candidateId);
  const role = asString(args.role);
  const reviewerId = asString(args.reviewerId);
  const reviewRunId = asString(args.reviewRunId);
  const model = asString(args.model);
  const provider = asString(args.provider) || undefined;
  const promptFingerprint = asString(args.promptFingerprint) || undefined;
  const verdict = asString(args.verdict) as "passed" | "revise" | "rejected";
  const summary = asString(args.summary);
  const concerns = asStringArray(args.concerns) ?? [];
  if (!projectId || !candidateId || !role || !reviewerId || !reviewRunId || !model || !verdict || !summary) {
    throw new Error("projectId/candidateId/role/reviewerId/reviewRunId/model/verdict/summary 必填且非空");
  }
  const candidate = await submitCraftRuleReview(ctx.repository, {
    projectId, candidateId, role, reviewerId, reviewRunId, model, provider, promptFingerprint,
    verdict, summary, concerns,
  });
  return { candidate };
};

const novel_rule_promote: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const candidateId = asString(args.candidateId);
  if (!projectId || !candidateId) throw new Error("projectId/candidateId 必填且非空");
  if (!ctx.model) throw new Error("novel_rule_promote 需要 ctx.model（用于回归验证 LLM 调用）");
  const { candidate, receipt, regressionVerified, regressionDetails } = await promoteCraftRuleCandidate(
    ctx.repository,
    ctx.model,
    { projectId, candidateId },
  );
  return { candidate, receipt, regressionVerified, regressionDetails };
};

const novel_rule_rollback: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const candidateId = asString(args.candidateId);
  if (!projectId || !candidateId) throw new Error("projectId/candidateId 必填且非空");
  if (!ctx.model) throw new Error("novel_rule_rollback 需要 ctx.model（保持接口对称，便于未来扩展）");
  const { candidate, receiptId } = await rollbackCraftRuleCandidate(
    ctx.repository,
    ctx.model,
    { projectId, candidateId },
  );
  return { candidate, receiptId };
};

// ===== 项目生命周期（3）=====

const novel_project_create: ToolHandler = async (args, ctx) => {
  const premise = asString(args.premise);
  const idempotencyKey = asString(args.idempotencyKey);
  if (!premise || !idempotencyKey) throw new Error("premise/idempotencyKey 必填且非空");

  // 一句话创意:premise 必填,title 可选(未提供则从 premise 自动派生)
  // 设计依据:v1 bootstrapNovelFromCoreIdea 的 provisionalTitle 函数——
  // 取 premise 第一句前 24 字作为临时标题,project-positioning task 会润色生成正式书名。
  const title = asString(args.title) || provisionalTitle(premise);
  const genre = asString(args.genre) || undefined;
  const autoBootstrap = asBoolean(args.autoBootstrap) ?? true;
  const includeChapterPlan = asBoolean(args.includeChapterPlan) ?? true;
  const objective = asString(args.objective) || premise;
  // 解析 reviewGate/progression,使 foundation 10 阶段支持人工审核门禁(架构阶段必备)。
  // 未提供时为 undefined,由 startNovelBootstrap 兜底为 "none" / "automatic"(向后兼容)。
  const { reviewGate, progression } = parseBootstrapPolicy(args);

  // 使用 idempotencyKey 作为 projectId(与 v1 行为一致)
  const projectId = idempotencyKey;

  // premise/genre 写入 metadata(题材通用差异化,不内置金手指/系统流特化)
  // genre 用于 resolveSkillBundle 匹配 applicableGenres;
  // premise 作为创作上下文提示,由 craft rule 决定如何使用。
  const metadata: Record<string, unknown> = { premise };
  if (genre) metadata.genre = genre;
  await ctx.repository.ensureProject(projectId, title, metadata);

  const project = await ctx.repository.getProjectDetail(projectId);

  // 自动启动全书规划(默认 true):创建项目后立即调用 startNovelBootstrap
  // 设计依据:用户需求"一句话创意创建项目"——一站式完成项目创建+全书规划。
  // premise 作为 objective 传给 bootstrap,让每个 foundation task 都知道创意核心。
  // includeChapterPlan 默认 true:chapter-plan 是 REQUIRED_FOUNDATION_TASK_KEYS 的必填项,
  // 默认生成避免后续 novel_chapter_generate 被前置检查拒绝。
  if (autoBootstrap) {
    if (!ctx.temporal) throw new Error("novel_project_create(autoBootstrap=true) 需要 ToolContext.temporal 才能启动 Temporal 工作流");
    const bootstrapRun = await startNovelBootstrap(ctx.repository, ctx.temporal, {
      projectId,
      objective,
      idempotencyKey,
      includeChapterPlan,
      reviewGate,
      progression,
      taskQueue: ctx.taskQueue,
    });
    return { project, bootstrapRun };
  }

  return { project };
};

const novel_project_list: ToolHandler = async (_args, ctx) => {
  const projects = await ctx.repository.listProjects();
  return { projects };
};

const novel_project_delete: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填");

  await ctx.repository.deleteProject(projectId);
  return { deleted: true, projectId };
};

// ===== 一键流程（2）—— TODO P2 =====

const novel_bootstrap_run: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const idempotencyKey = asString(args.idempotencyKey);
  if (!projectId || !idempotencyKey) throw new Error("projectId/idempotencyKey 必填且非空");

  const objective = asString(args.objective) || "完成基础+规划阶段";
  // includeChapterPlan 默认 true:章节计划(chapter-plan)是章节生成的必填 foundation artifact
  // (见 REQUIRED_FOUNDATION_TASK_KEYS)。若用户未显式禁用,默认生成章节计划,
  // 避免后续 novel_chapter_generate 被前置检查拒绝。
  const includeChapterPlan = asBoolean(args.includeChapterPlan) ?? true;
  // 解析 reviewGate/progression,使 foundation 10 阶段支持人工审核门禁(架构阶段必备)。
  // 未提供时为 undefined,由 startNovelBootstrap 兜底为 "none" / "automatic"(向后兼容)。
  const { reviewGate, progression } = parseBootstrapPolicy(args);

  if (!ctx.temporal) throw new Error("novel_bootstrap_run 需要 ToolContext.temporal 才能启动 Temporal 工作流");
  return startNovelBootstrap(ctx.repository, ctx.temporal, {
    projectId,
    objective,
    idempotencyKey,
    includeChapterPlan,
    reviewGate,
    progression,
    taskQueue: ctx.taskQueue,
  });
};

const novel_story_arc_start: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填");
  if (!ctx.temporal) throw new Error("novel_story_arc_start 需要 Temporal");
  return startStoryArcPlanning(ctx.repository, ctx.temporal, { projectId, mode: "mcp", authorIntent: asString(args.authorIntent) || undefined, taskQueue: ctx.taskQueue });
};

const novel_story_arc_get: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const arcId = asString(args.arcId);
  if (!projectId) throw new Error("projectId 必填");
  return arcId ? { arc: await ctx.repository.getStoryArc(projectId, arcId) } : { arcs: await ctx.repository.listStoryArcs(projectId) };
};

const novel_chapter_generate: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const idempotencyKey = asString(args.idempotencyKey);
  if (!projectId || !idempotencyKey) throw new Error("projectId/idempotencyKey 必填且非空");
  if (!ctx.temporal) throw new Error("novel_chapter_generate 需要 ToolContext.temporal 才能启动 Temporal 工作流");

  const documentId = asString(args.documentId) || undefined;
  const instruction = asString(args.instruction) || undefined;

  // 1. 前置检查:校验 foundation artifacts 包含必填 taskKey。
  // 设计依据:AGENTS.md「root-cause analysis」——v2 重构后章节生成不基于全书规划,
  // 此处在 MCP 入口层强制"先规划再写章节"。workflow 层也有同样的检查(双保险)。
  await ctx.repository.assertRequiredPlanApproved(projectId);

  // 2. 未指定章节时，从当前已批准故事弧中选择下一个 planned 文档。
  let targetDocumentId = documentId;
  if (!targetDocumentId) {
    const document = await ctx.repository.findNextPlannedArcDocument(projectId);
    if (!document) throw new Error("没有已批准故事弧中的待创作章节，请先完成故事弧规划和审核");
    targetDocumentId = document.id;
  } else {
    // 校验 document 存在且非 final
    const status = await ctx.repository.getDocumentStatus(projectId, targetDocumentId);
    if (!status) throw new Error(`章节不存在:${targetDocumentId}`);
    if (status === "final") throw new Error("章节已定稿,如需重审请使用 novel_chapter_review");
  }
  await ctx.repository.getChapterPlanningContext(projectId, targetDocumentId);

  // 3. 创建 NovelIntent:target.kind="chapter" 触发 classify 返回 drafting
  const intent: NovelIntent = {
    id: randomUUID(),
    projectId,
    source: "mcp",
    objective: instruction || `生成章节正文(${targetDocumentId})`,
    target: { kind: "chapter", id: targetDocumentId },
    constraints: instruction ? [instruction] : undefined,
    createdAt: Date.now(),
    idempotencyKey,
  };
  const stored = await ctx.repository.putIntent(intent);

  // 4. 落库 WorkflowRun + 启动 Temporal workflow
  // 与 novel_chapter_review / HTTP /v2/intents 入口对齐:workflow_runs.id = workflowId
  const workflowId = `novel-intent-${stored.id}`;
  await ctx.repository.putWorkflowRun({
    id: workflowId,
    workflowType: "novel-intent",
    projectId: stored.projectId,
    temporalWorkflowId: workflowId,
    status: "accepted",
    payload: { intent: stored, intentId: stored.id, documentId: targetDocumentId, source: "novel_chapter_generate" },
  });
  const handle = await ctx.temporal.workflow.start("novelIntentWorkflow", {
    args: [stored, workflowId],
    taskQueue: ctx.taskQueue ?? "novel-v2",
    workflowId,
  });

  return {
    workflowId,
    runId: handle.firstExecutionRunId,
    documentId: targetDocumentId,
    intentId: stored.id,
    status: "accepted",
  };
};

const novel_chapter_review: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const documentId = asString(args.documentId);
  if (!projectId || !documentId) throw new Error("projectId/documentId 必填且非空");
  if (!ctx.temporal) throw new Error("novel_chapter_review 需要 ToolContext.temporal 才能启动 Temporal 工作流");

  const instruction = asString(args.instruction) || undefined;
  const idempotencyKey = asString(args.idempotencyKey) ?? `${projectId}:${documentId}:review:${Date.now()}`;

  // 校验 document 存在 + status="final"（AGENTS.md 契约：仅对已定稿章节开放重审）
  const preflight = await ctx.repository.getChapterReviewPreflight(projectId, documentId);
  if (!preflight) throw new Error(`章节不存在：${documentId}`);
  if (preflight.status !== "final") throw new Error("章节审校仅对已定稿章节开放");
  if (preflight.activeWorkflowId) throw new Error(`该章节已有活跃审校工作流：${preflight.activeWorkflowId}`);
  if (!preflight.hasBlueprint) throw new Error("找不到该章节的历史 blueprint artifact，无法启动章节审校");

  const workflowId = `chapter-review-${documentId}-${idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`.slice(0, 200);
  const params = { projectId, documentId, instruction, workflowId };
  // workflow_runs.id 必须等于 workflowId：chapterReviewWorkflow 全程用 workflowId 作 workflowRunId
  // （updateTaskAttempt / draft / review / revise / externalTask），task_attempts.workflow_run_id 有 FK→workflow_runs.id。
  // 若 id=randomUUID() 而 workflow 用 workflowId，FK 会失败。与 novelIntentWorkflow 对齐。
  await ctx.repository.putWorkflowRun({ id: workflowId, workflowType: "chapter-review", projectId, temporalWorkflowId: workflowId, status: "accepted", payload: { documentId, instruction, idempotencyKey } });
  const handle = await ctx.temporal.workflow.start("chapterReviewWorkflow", { args: [params], taskQueue: ctx.taskQueue ?? "novel-v2", workflowId });
  return { workflowId, runId: handle.firstExecutionRunId, documentId, instruction, status: "accepted" };
};

// ===== 评估闭环（1，v2 新增）=====

const novel_closed_loop_run: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const documentId = asString(args.documentId);
  if (!projectId || !documentId) throw new Error("projectId/documentId 必填且非空");

  const dryRun = asBoolean(args.dryRun) ?? false;
  const instruction = asString(args.instruction) || undefined;

  if (!ctx.model) {
    throw new Error("novel_closed_loop_run 需要 ToolContext.model（LLM 网关）");
  }

  const result = await runClosedLoop({
    repository: ctx.repository,
    model: ctx.model,
    projectId,
    documentId,
    instruction,
    dryRun,
    // TODO P2: authorId/codeRevision 由调用方传入
  });

  return result;
};

// ===== Handler 注册表 =====

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // Run / Action 主体（7）
  novel_run_create,
  novel_run_get,
  novel_action_list,
  novel_action_execute,
  novel_artifact_get,
  novel_review_submit,
  novel_run_complete,

  // Catalog / Receipt（3）
  novel_catalog_get,
  novel_receipt_get,
  novel_rule_target_get,

  // Craft Rule 候选演进（7）
  novel_rule_candidate_create,
  novel_rule_candidate_get,
  novel_rule_evidence_submit,
  novel_rule_foundation_evaluate,
  novel_rule_review_submit,
  novel_rule_promote,
  novel_rule_rollback,

  // 项目生命周期（3）
  novel_project_create,
  novel_project_list,
  novel_project_delete,

  // 一键流程（3）
  novel_bootstrap_run,
  novel_chapter_review,
  novel_chapter_generate,
  novel_story_arc_start,
  novel_story_arc_get,

  // 评估闭环（1）
  novel_closed_loop_run,
};
