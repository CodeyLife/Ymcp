#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureNovelRuntime, runtimeRequest } from "./novel-runtime-client.mjs";

const projectRefSchema = z.string().min(1).optional().describe("项目 ID 或完整标题；省略时使用当前 MCP 会话已选择的项目");
const reviewIssueSchema = z.object({
  id: z.string().min(1), severity: z.enum(["blocker", "major", "warning"]), dimension: z.string().min(1), title: z.string().min(1), evidence: z.string().min(1), suggestion: z.string().min(1),
  evidenceItemId: z.string().min(1).optional(), evidenceField: z.string().min(1).optional(), evidenceQuote: z.string().min(1).optional(),
});
const externalReviewSchema = z.object({
  reviewRunId: z.string().min(1), verdict: z.enum(["passed", "revise"]), summary: z.string().min(1), artifactFingerprint: z.string().length(64), issues: z.array(reviewIssueSchema),
  learning: z.object({ conclusion: z.enum(["no-shared-learning", "propose-improvement"]), summary: z.string().min(1), affectedInputClass: z.string().min(1).optional(), underlyingMechanism: z.string().min(1).optional() }).superRefine((value, context) => {
    if (value.conclusion === "propose-improvement" && (!value.affectedInputClass || !value.underlyingMechanism)) context.addIssue({ code: "custom", message: "可沉淀经验必须说明影响输入类别和共享机制" });
  }),
});

function resultContent(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function normalizedTitle(value) {
  return value.trim().normalize("NFC").toLocaleLowerCase("zh-CN");
}

function requestKey(sessionId, extra, suffix) {
  return `${sessionId}:${String(extra?.requestId ?? randomUUID())}:${suffix}`;
}

const ADVANCED_TOOL_DEFINITIONS = [
  ["novel_run_create", { projectId: z.string().min(1), objective: z.string().min(1), idempotencyKey: z.string().min(1), policy: z.record(z.string(), z.unknown()).optional(), baseSnapshotHash: z.string().optional() }],
  ["novel_run_get", { projectId: z.string().min(1), runId: z.string().min(1), afterSequence: z.number().int().nonnegative().optional() }],
  ["novel_action_list", { projectId: z.string().min(1), runId: z.string().min(1) }],
  ["novel_action_execute", { projectId: z.string().min(1), runId: z.string().min(1), action: z.string().min(1), workItemId: z.string().optional(), idempotencyKey: z.string().min(1), instruction: z.string().optional(), force: z.boolean().optional(), work: z.record(z.string(), z.unknown()).optional() }],
  ["novel_artifact_get", { projectId: z.string().min(1), runId: z.string().min(1), artifactId: z.string().min(1) }],
  ["novel_review_submit", { projectId: z.string().min(1), runId: z.string().min(1), workItemId: z.string().min(1), idempotencyKey: z.string().min(1), review: z.record(z.string(), z.unknown()) }],
  ["novel_run_complete", { projectId: z.string().min(1), runId: z.string().min(1) }],
  ["novel_catalog_get", { projectId: z.string().min(1) }],
  ["novel_receipt_get", { projectId: z.string().optional(), targetTool: z.string().min(1), idempotencyKey: z.string().min(1) }],
  ["novel_rule_target_get", { projectId: z.string().min(1), targetKind: z.enum(["skill", "system-prompt"]), targetId: z.string().min(1), version: z.string().optional() }],
  ["novel_rule_candidate_create", { projectId: z.string().min(1), idempotencyKey: z.string().min(1), targetKind: z.enum(["skill", "system-prompt"]), targetId: z.string().min(1), afterText: z.string().min(100), rationale: z.string().min(1), scope: z.record(z.string(), z.unknown()) }],
  ["novel_rule_candidate_get", { projectId: z.string().min(1), candidateId: z.string().min(1) }],
  ["novel_rule_evidence_submit", { projectId: z.string().min(1), idempotencyKey: z.string().min(1), candidateId: z.string().min(1), scenarioClass: z.string().min(1), baselineWorkItemId: z.string().min(1), candidateWorkItemId: z.string().min(1) }],
  ["novel_rule_foundation_evaluate", { projectId: z.string().min(1), idempotencyKey: z.string().min(1), candidateId: z.string().min(1), taskKey: z.string().min(1), scenarioClass: z.string().min(1), instruction: z.string().optional() }],
  ["novel_rule_review_submit", { projectId: z.string().min(1), idempotencyKey: z.string().min(1), candidateId: z.string().min(1), role: z.string().min(1), reviewerId: z.string().min(1), reviewRunId: z.string().min(1), model: z.string().min(1), verdict: z.string().min(1), summary: z.string().min(1), concerns: z.array(z.string()).optional() }],
  ["novel_rule_promote", { projectId: z.string().min(1), idempotencyKey: z.string().min(1), candidateId: z.string().min(1) }],
  ["novel_rule_rollback", { projectId: z.string().min(1), idempotencyKey: z.string().min(1), candidateId: z.string().min(1) }],
  ["novel_project_delete", { projectId: z.string().min(1), idempotencyKey: z.string().min(1) }],
  ["novel_bootstrap_run", { projectId: z.string().min(1), idempotencyKey: z.string().min(1), objective: z.string().optional(), includeChapterPlan: z.boolean().optional() }],
  ["novel_foundation_export", { projectId: z.string().min(1) }],
];

export function createCreativeMcpServer(options = {}) {
  const server = new McpServer({ name: "ymcp-novel-runtime", version: "1.0.0" });
  const sessionId = options.sessionId ?? randomUUID();
  let activeProjectId;

  const projects = async (signal) => (await runtimeRequest("/v1/projects", { signal })).projects;
  const resolveProject = async (reference, signal) => {
    const all = await projects(signal);
    const candidate = reference?.trim();
    if (!candidate) {
      if (!activeProjectId) throw new Error("尚未选择小说项目，请先调用 novel_project_select 或 novel_project_create");
      const selected = all.find((project) => project.id === activeProjectId);
      if (!selected) { activeProjectId = undefined; throw new Error("此前选择的项目已不存在，请重新选择"); }
      return selected;
    }
    const byId = all.find((project) => project.id === candidate);
    if (byId) return byId;
    const byTitle = all.filter((project) => normalizedTitle(project.title) === normalizedTitle(candidate));
    if (byTitle.length === 1) return byTitle[0];
    if (byTitle.length > 1) throw new Error(`标题“${candidate}”对应多个项目，请改用项目 ID：${byTitle.map((project) => project.id).join("、")}`);
    throw new Error(`找不到小说项目：${candidate}`);
  };
  const register = (name, config, handler) => server.registerTool(name, config, async (args, extra) => {
    try { return resultContent(await handler(args, extra)); }
    catch (error) { return resultContent({ error: error instanceof Error ? error.message : String(error), code: error?.code, retryable: error?.retryable ?? false, tool: name }, true); }
  });

  register("novel_project_list", { description: "列出本地小说运行时中的全部项目；不需要打开网页。", inputSchema: {} }, async (_args, extra) => ({ projects: await projects(extra.signal), activeProjectId }));
  register("novel_project_create", { description: "创建小说项目并自动设为当前 MCP 会话项目。", inputSchema: { title: z.string().min(1), premise: z.string().min(1), genre: z.array(z.string().min(1)).min(1) } }, async (args, extra) => {
    const payload = await runtimeRequest("/v1/projects", { body: args, requestKey: requestKey(sessionId, extra, "project-create"), signal: extra.signal });
    activeProjectId = payload.project.id;
    return { project: payload.project, activeProjectId };
  });
  register("novel_project_select", { description: "按项目 ID 或完整标题选择一次当前项目，后续工具自动继承。", inputSchema: { project: z.string().min(1) } }, async (args, extra) => {
    const project = await resolveProject(args.project, extra.signal);
    activeProjectId = project.id;
    return { project, activeProjectId };
  });
  register("novel_agent_guide_get", { description: "读取小说 MCP 自迭代协议。每次开始或恢复 operation，以及候选审核前都必须先读取；它只返回运行时允许的推进方式。", inputSchema: { projectRef: projectRefSchema, operationId: z.string().min(1).optional() } }, async (args, extra) => {
    const project = await resolveProject(args.projectRef, extra.signal);
    const status = await runtimeRequest(`/v1/projects/${encodeURIComponent(project.id)}/status`, { signal: extra.signal });
    let operation;
    if (args.operationId) {
      operation = await runtimeRequest(`/v1/operations/${encodeURIComponent(args.operationId)}`, { signal: extra.signal });
      if (operation.operation.projectId !== project.id) throw new Error("operation 不属于当前 MCP 项目");
    }
    return {
      project,
      protocol: {
        requiredOrder: ["读取状态与 nextActions", "读取完整候选", "检查项目内部质量证据", "以独立外部审核记录结论", "只选择 accept、patch 或 regenerate", "每轮总结是否存在可跨场景验证的流程经验"],
        invariants: ["不得仅凭摘要接受候选", "内部与外部审核都通过才可提交", "patch 只能编辑 pending proposal item，且须在补丁后重新校验并重新外审", "不可用单个样例、书名、角色或措辞提炼规则", "失败只可在修复根因后 retry；质量问题应继续 patch 或 regenerate"],
        learning: "仅当证据指向共享 Skill、系统 Prompt 或流程机制时创建改进候选；满足跨场景证据和独立审核门后会自动晋升项目规则。",
      },
      status,
      operation,
      nextActions: operation?.nextActions ?? status.nextActions,
    };
  });
  register("novel_autopilot_get", { description: "读取一个 operation 的实时自动推进状态、候选和允许动作；不要自行猜测下一步。", inputSchema: { operationId: z.string().min(1) } }, async (args, extra) => {
    const payload = await runtimeRequest(`/v1/operations/${encodeURIComponent(args.operationId)}`, { signal: extra.signal });
    if (activeProjectId && payload.operation.projectId !== activeProjectId) throw new Error("operation 不属于当前 MCP 项目");
    return { ...payload, loop: { internalGateRequired: true, externalReviewRequired: payload.operation.driver === "external-mcp", unlimitedQualityIterations: payload.operation.reviewPolicy.maxIterations === null, automaticProjectRulePromotion: payload.operation.improvementPolicy.autoPromote } };
  });
  register("novel_status", { description: "查看当前项目、异步创作进度、待确认候选、失败原因和下一步。", inputSchema: { projectRef: projectRefSchema } }, async (args, extra) => {
    const project = await resolveProject(args.projectRef, extra.signal);
    const status = await runtimeRequest(`/v1/projects/${encodeURIComponent(project.id)}/status`, { signal: extra.signal });
    return { project, ...status };
  });
  for (const [name, kind, description] of [
    ["novel_plan", "plan", "按目标规划小说；运行在后台，每一步形成待确认候选。"],
    ["novel_write", "write", "写作指定章节或下一章；返回持久化 operation，断开 MCP 后仍继续。"],
    ["novel_revise", "revise", "根据要求修订指定章节；先生成候选，不直接覆盖正式稿。"],
  ]) {
    register(name, { description, inputSchema: { projectRef: projectRefSchema, instruction: z.string().min(1), target: kind === "plan" ? z.string().optional() : z.string().default("next") } }, async (args, extra) => {
      const project = await resolveProject(args.projectRef, extra.signal);
      const payload = await runtimeRequest("/v1/operations", { body: { projectId: project.id, kind, instruction: args.instruction, target: args.target, driver: "external-mcp" }, requestKey: requestKey(sessionId, extra, name), signal: extra.signal });
      return { project, ...payload };
    });
  }
  register("novel_operation_get", { description: "读取 operation、当前候选和增量事件。", inputSchema: { operationId: z.string().min(1), afterSequence: z.number().int().nonnegative().optional() } }, async (args, extra) => {
    const payload = await runtimeRequest(`/v1/operations/${encodeURIComponent(args.operationId)}?afterSequence=${args.afterSequence ?? 0}`, { signal: extra.signal });
    if (activeProjectId && payload.operation.projectId !== activeProjectId) throw new Error("operation 不属于当前 MCP 项目");
    return payload;
  });
  register("novel_operation_retry", { description: "修正失败原因后从原工作项重试 operation；多项候选默认携带上一版完整集合，过大时可显式关闭。", inputSchema: { operationId: z.string().min(1), note: z.string().optional(), includePreviousCandidate: z.boolean().optional(), reviewerId: z.string().min(1), model: z.string().min(1) } }, async (args, extra) => {
    const payload = await runtimeRequest(`/v1/operations/${encodeURIComponent(args.operationId)}`, { signal: extra.signal });
    if (activeProjectId && payload.operation.projectId !== activeProjectId) throw new Error("operation 不属于当前 MCP 项目");
    return runtimeRequest(`/v1/operations/${encodeURIComponent(args.operationId)}/retry`, { body: { note: args.note, includePreviousCandidate: args.includePreviousCandidate, actor: { type: "external-llm", id: args.reviewerId, model: args.model } }, requestKey: requestKey(sessionId, extra, "operation-retry"), signal: extra.signal });
  });
  register("novel_change_get", { description: "读取待审核候选的完整产物、artifactFingerprint 和逐 item 的 itemPayloadFingerprints；审核或补丁前必须先调用。", inputSchema: { changeId: z.string().min(1) } }, async (args, extra) => {
    const payload = await runtimeRequest(`/v1/changes/${encodeURIComponent(args.changeId)}`, { signal: extra.signal });
    if (activeProjectId && payload.change.projectId !== activeProjectId) throw new Error("候选变更不属于当前 MCP 项目");
    return payload;
  });
  register("novel_change_revalidate", { description: "局部补丁后重新运行项目内部候选校验；必须使用刚刚读取的完整候选 fingerprint。", inputSchema: { projectRef: projectRefSchema, changeId: z.string().min(1), artifactFingerprint: z.string().length(64), reviewerId: z.string().min(1), model: z.string().min(1) } }, async (args, extra) => {
    const project = await resolveProject(args.projectRef, extra.signal);
    const payload = await runtimeRequest(`/v1/changes/${encodeURIComponent(args.changeId)}`, { signal: extra.signal });
    if (payload.change.projectId !== project.id) throw new Error("候选变更不属于当前 MCP 项目");
    return runtimeRequest(`/v1/changes/${encodeURIComponent(args.changeId)}/revalidate`, { body: { projectId: project.id, artifactFingerprint: args.artifactFingerprint, actor: { type: "external-llm", id: args.reviewerId, model: args.model } }, requestKey: requestKey(sessionId, extra, "change-revalidate"), signal: extra.signal });
  });
  register("novel_change_patch", { description: "对定位明确的小问题修改 pending proposal item。expectedPayloadFingerprint 必须取自 change_get.itemPayloadFingerprints[itemId]；补丁后必须重新校验并外审。", inputSchema: { projectRef: projectRefSchema, changeId: z.string().min(1), itemId: z.string().min(1), artifactFingerprint: z.string().length(64), expectedPayloadFingerprint: z.string().length(64), payload: z.record(z.string(), z.unknown()), rationale: z.string().min(1), issueIds: z.array(z.string().min(1)).min(1), review: externalReviewSchema, reviewerId: z.string().min(1), model: z.string().min(1) } }, async (args, extra) => {
    const project = await resolveProject(args.projectRef, extra.signal);
    return runtimeRequest(`/v1/changes/${encodeURIComponent(args.changeId)}/patch`, { body: { projectId: project.id, itemId: args.itemId, artifactFingerprint: args.artifactFingerprint, expectedPayloadFingerprint: args.expectedPayloadFingerprint, payload: args.payload, rationale: args.rationale, issueIds: args.issueIds, review: args.review, actor: { type: "external-llm", id: args.reviewerId, model: args.model } }, requestKey: requestKey(sessionId, extra, "change-patch"), signal: extra.signal });
  });
  register("novel_change_review", { description: "提交当前完整候选的独立外部审核，并选择 accept 或 regenerate。accept 同时要求项目内部审核通过；不得用此工具跳过补丁后的重新校验。", inputSchema: { projectRef: projectRefSchema, changeId: z.string().min(1), decision: z.enum(["accept", "revise"]), note: z.string().optional(), review: externalReviewSchema, reviewerId: z.string().min(1), model: z.string().min(1) } }, async (args, extra) => {
    const project = await resolveProject(args.projectRef, extra.signal);
    return runtimeRequest(`/v1/changes/${encodeURIComponent(args.changeId)}/review`, { body: { projectId: project.id, decision: args.decision, note: args.note, review: args.review, actor: { type: "external-llm", id: args.reviewerId, model: args.model } }, requestKey: requestKey(sessionId, extra, "change-review"), signal: extra.signal });
  });

  register("novel_improvement_propose", {
    description: "仅在证据指向共享提示词或流程机制时创建不可变改进候选；不得直接覆盖正式规则。",
    inputSchema: {
      projectRef: projectRefSchema,
      targetKind: z.enum(["skill", "system-prompt"]), targetId: z.string().min(1), afterText: z.string().min(100), rationale: z.string().min(1),
      observedSymptom: z.string().min(1), failingLayer: z.string().min(1), underlyingMechanism: z.string().min(1), affectedInputClass: z.string().min(1),
      intendedBenefits: z.array(z.string().min(1)).min(1), boundaries: z.array(z.string().min(1)).min(1), nonGoals: z.array(z.string().min(1)).min(1), regressionRisks: z.array(z.string().min(1)).min(1),
    },
  }, async (args, extra) => {
    const project = await resolveProject(args.projectRef, extra.signal);
    const scope = Object.fromEntries(["observedSymptom", "failingLayer", "underlyingMechanism", "affectedInputClass", "intendedBenefits", "boundaries", "nonGoals", "regressionRisks"].map((key) => [key, args[key]]));
    return runtimeRequest("/v1/improvements", { body: { projectId: project.id, targetKind: args.targetKind, targetId: args.targetId, afterText: args.afterText, rationale: args.rationale, scope, idempotencyKey: requestKey(sessionId, extra, "improvement-propose") }, requestKey: requestKey(sessionId, extra, "improvement-propose-http"), signal: extra.signal });
  });
  register("novel_improvement_get", { description: "读取改进候选、跨场景证据、审核门和尚未满足的晋升条件。", inputSchema: { projectRef: projectRefSchema, candidateId: z.string().min(1) } }, async (args, extra) => {
    const project = await resolveProject(args.projectRef, extra.signal);
    return runtimeRequest(`/v1/projects/${encodeURIComponent(project.id)}/improvements/${encodeURIComponent(args.candidateId)}`, { signal: extra.signal });
  });
  register("novel_improvement_evaluate", {
    description: "在隔离工作区运行一次基线/候选 A/B；必须用不同章节或基础任务重复调用以形成跨场景证据。",
    inputSchema: { projectRef: projectRefSchema, candidateId: z.string().min(1), scenarioClass: z.string().min(1), documentId: z.string().min(1).optional(), taskKey: z.enum(["project-positioning", "architecture", "story-bible", "characters", "relations", "worldview"]).optional(), instruction: z.string().optional() },
  }, async (args, extra) => {
    const project = await resolveProject(args.projectRef, extra.signal);
    if (!args.documentId && !args.taskKey) throw new Error("评测必须提供 documentId 或 taskKey");
    return runtimeRequest(`/v1/improvements/${encodeURIComponent(args.candidateId)}/evaluate`, { body: { projectId: project.id, scenarioClass: args.scenarioClass, documentId: args.documentId, taskKey: args.taskKey, instruction: args.instruction }, requestKey: requestKey(sessionId, extra, "improvement-evaluate"), signal: extra.signal });
  });
  register("novel_improvement_review", {
    description: "提交一项独立角色审核；晋升需要四类角色审核且审核主体相互独立。",
    inputSchema: { projectRef: projectRefSchema, candidateId: z.string().min(1), role: z.enum(["plot-editor", "character-editor", "prose-editor", "long-form-editor"]), reviewerId: z.string().min(1), reviewRunId: z.string().min(1), model: z.string().min(1), verdict: z.enum(["passed", "revise", "rejected"]), summary: z.string().min(1), concerns: z.array(z.string()).optional() },
  }, async (args, extra) => {
    const project = await resolveProject(args.projectRef, extra.signal);
    return runtimeRequest(`/v1/improvements/${encodeURIComponent(args.candidateId)}/review`, { body: { projectId: project.id, role: args.role, reviewerId: args.reviewerId, reviewRunId: args.reviewRunId, model: args.model, verdict: args.verdict, summary: args.summary, concerns: args.concerns, idempotencyKey: requestKey(sessionId, extra, "improvement-review") }, requestKey: requestKey(sessionId, extra, "improvement-review-http"), signal: extra.signal });
  });
  for (const [name, action, description] of [
    ["novel_improvement_promote", "promote", "仅在跨场景证据和独立审核门全部通过后晋升改进候选。"],
    ["novel_improvement_rollback", "rollback", "回滚已晋升的提示词或 Skill 版本。"],
  ]) register(name, { description, inputSchema: { projectRef: projectRefSchema, candidateId: z.string().min(1) } }, async (args, extra) => {
    const project = await resolveProject(args.projectRef, extra.signal);
    return runtimeRequest(`/v1/improvements/${encodeURIComponent(args.candidateId)}/${action}`, { body: { projectId: project.id, idempotencyKey: requestKey(sessionId, extra, name) }, requestKey: requestKey(sessionId, extra, `${name}-http`), signal: extra.signal });
  });

  if ((options.profile ?? process.env.YMCP_NOVEL_MCP_PROFILE) === "advanced") {
    for (const [name, inputSchema] of ADVANCED_TOOL_DEFINITIONS) register(name, { description: `高级兼容工具：${name}`, inputSchema }, (args, extra) => runtimeRequest("/v1/advanced", { body: { tool: name, args }, requestKey: requestKey(sessionId, extra, name), signal: extra.signal }));
  }
  return server;
}

async function main() {
  await ensureNovelRuntime();
  await createCreativeMcpServer().connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error("[ymcp-novel-mcp]", error); process.exit(1); });
