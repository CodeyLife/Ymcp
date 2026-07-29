import { createServer } from "node:http";
import { Client, Connection } from "@temporalio/client";
import { createHash, randomUUID } from "node:crypto";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";
import type { Artifact, AuthorDecision, NovelIntent } from "../src/novel-v2/protocol";
import { CommitService } from "../src/novel-v2/commit-service";
import { createRuntimeModelGateway } from "../src/novel-v2/model-runtime";
import type { ModelRoutingConfig, ModelTaskRecord } from "../src/novel-v2/model-routing";
import { captureProjectSnapshot, computeProjectHead } from "../src/novel-v2/evaluation/project-snapshot";
import { createExperimentWorkspace, getExperimentWorkspace, listExperimentWorkspaces } from "../src/novel-v2/evaluation/experiment-workspace";
import { extractCandidateBundle } from "../src/novel-v2/evaluation/candidate-bundle";
import { createPromotionService } from "../src/novel-v2/evaluation/promotion";
import { runClosedLoop } from "../src/novel-v2/evaluation/closed-loop";
import {
  createCreativeRun,
  enqueueCreativeWork,
  listCreativeRuns,
  getRunSnapshot,
  executeCreativeCommand,
  attachArtifact,
  submitReview,
} from "../src/novel-v2/creative";
import type { CreativeCommand, CreativeRunMode, CreativeRunPolicy } from "../src/novel-v2/protocol";
import { startNovelBootstrap } from "../src/novel-v2/application/bootstrap";
import { provisionalTitle } from "../src/novel-v2/application/provisional-title";
import { ContentObjectStore } from "../src/novel-v2/object-store";
import { bindRuntimeObjectStore } from "../src/novel-v2/runtime-object-store";
import { PROJECT_PLAN_STAGES, isProjectPlanTaskKey } from "../src/novel-v2/application/project-plan";
import { parseStoryArcBundle } from "../src/novel-v2/application/story-arc";
import { startStoryArcPlanning } from "../src/novel-v2/application/story-arc-workflow";

// 通过 Extract 从 CreativeCommand 联合类型中派生 review.submit 的 review 字段类型，
// 避免新增 CreativeReviewInput / ReviewIssue 的直接导入。
type ReviewSubmitCommand = Extract<CreativeCommand, { type: "review.submit" }>;
type ReviewSubmitInput = ReviewSubmitCommand["review"];
type ReviewIssueShape = ReviewSubmitInput["issues"][number];

const repository = new NovelPostgresRepository();
await repository.migrate();
const { configStore: modelConfigStore, gateway: model } = await createRuntimeModelGateway(repository);
const objectStore = new ContentObjectStore();
await bindRuntimeObjectStore(repository, objectStore, "api");
// API 入口的 commitService 也启用 chapter memory 创建（与 worker 保持一致）
// 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约
const commitService = new CommitService(repository, objectStore, { model });
const promotionService = createPromotionService(repository, objectStore);
const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" });
const temporal = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
const port = Number(process.env.NOVEL_V2_API_PORT ?? 4770);
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "novel-v2";

async function readJson(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function send(response: import("node:http").ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type,authorization" });
  response.end(status === 204 ? undefined : JSON.stringify(value));
}

function asString(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function asNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function asRecord(value: unknown) { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

// ===== 创意执行路由（Phase B-2）辅助：从 unknown 构造强类型 CreativeCommand =====

function buildCreativePolicy(value: unknown): Partial<CreativeRunPolicy> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const policy: Partial<CreativeRunPolicy> = {};
  if (typeof record.maxRetries === "number" && Number.isFinite(record.maxRetries)) policy.maxRetries = record.maxRetries;
  if (record.reviewGate === "manual" || record.reviewGate === "auto" || record.reviewGate === "none") policy.reviewGate = record.reviewGate;
  if (typeof record.autoAcceptThreshold === "number" && Number.isFinite(record.autoAcceptThreshold)) policy.autoAcceptThreshold = record.autoAcceptThreshold;
  if (record.progression === "automatic" || record.progression === "user-driven") policy.progression = record.progression;
  return policy;
}

async function createEditedPlanArtifact(input: {
  projectId: string;
  taskKey: import("../src/novel-v2/application/project-plan").ProjectPlanTaskKey;
  workItemId: string;
  runId: string;
  payload: Record<string, unknown>;
}): Promise<Artifact> {
  const text = JSON.stringify(input.payload, null, 2);
  const object = await objectStore.putText(text);
  const taskId = `${input.workItemId}:foundation:user-edit`;
  const artifact: Artifact = {
    id: randomUUID(),
    projectId: input.projectId,
    taskId,
    attemptId: randomUUID(),
    kind: "foundation",
    contentHash: object.hash,
    objectKey: object.key,
    baseRevision: 0,
    fingerprint: createHash("sha256").update(`${object.hash}:${taskId}`).digest("hex"),
    structuredData: {
      ...input.payload,
      taskKey: input.taskKey,
      workItemId: input.workItemId,
      runId: input.runId,
      origin: "web-author-edit",
    },
    createdAt: Date.now(),
  };
  await repository.recordArtifact(artifact);
  await attachArtifact(repository, input.workItemId, artifact.id);
  return artifact;
}

async function createEditedStoryArcArtifact(input: { projectId: string; arcId: string; payload: Record<string, unknown> }): Promise<Artifact> {
  const bundle = parseStoryArcBundle(input.payload);
  const text = JSON.stringify(bundle, null, 2);
  const object = await objectStore.putText(text);
  const taskId = `${input.arcId}:story-arc:web-edit`;
  const artifact: Artifact = {
    id: randomUUID(), projectId: input.projectId, taskId, attemptId: randomUUID(), kind: "chapter-blueprint",
    contentHash: object.hash, objectKey: object.key, baseRevision: 0,
    fingerprint: createHash("sha256").update(`${object.hash}:${taskId}`).digest("hex"),
    structuredData: { ...bundle, arcId: input.arcId, origin: "web-author-edit" }, createdAt: Date.now(),
  };
  await repository.recordArtifact(artifact);
  return artifact;
}

function buildCreativeReviewInput(value: unknown): ReviewSubmitInput | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const subjectArtifactId = asString(record.subjectArtifactId);
  if (!subjectArtifactId) return undefined;
  const reviewer = record.reviewer;
  if (reviewer !== "internal" && reviewer !== "independent" && reviewer !== "human") return undefined;
  const verdict = record.verdict;
  if (verdict !== "passed" && verdict !== "revise" && verdict !== "blocked") return undefined;
  const summary = asString(record.summary);
  if (!summary) return undefined;
  if (!Array.isArray(record.issues)) return undefined;
  const issues: ReviewIssueShape[] = [];
  for (const item of record.issues) {
    const issueRecord = asRecord(item);
    if (!issueRecord) return undefined;
    const severity = issueRecord.severity;
    if (severity !== "blocker" && severity !== "major" && severity !== "warning") return undefined;
    const title = asString(issueRecord.title);
    if (!title) return undefined;
    const evidence = asString(issueRecord.evidence);
    if (!evidence) return undefined;
    const issue: ReviewIssueShape = { severity, title, evidence };
    if (typeof issueRecord.description === "string") issue.description = issueRecord.description;
    if (typeof issueRecord.dimension === "string") issue.dimension = issueRecord.dimension;
    if (typeof issueRecord.excerpt === "string") issue.excerpt = issueRecord.excerpt;
    if (typeof issueRecord.paragraph === "number") issue.paragraph = issueRecord.paragraph;
    if (typeof issueRecord.rule === "string") issue.rule = issueRecord.rule;
    if (typeof issueRecord.sourceId === "string") issue.sourceId = issueRecord.sourceId;
    if (typeof issueRecord.suggestion === "string") issue.suggestion = issueRecord.suggestion;
    if (typeof issueRecord.rewriteExample === "string") issue.rewriteExample = issueRecord.rewriteExample;
    // TODO P3: revisionRanges 内部结构（{start:number,end:number}）的逐项校验，目前 storage 层负责
    issues.push(issue);
  }
  return { subjectArtifactId, reviewer, verdict, summary, issues };
}

function buildCreativeCommand(input: Record<string, unknown>): CreativeCommand | undefined {
  const type = asString(input.type);
  const idempotencyKey = asString(input.idempotencyKey);
  if (!type || !idempotencyKey) return undefined;
  if (type === "run.pause" || type === "run.resume" || type === "run.cancel") {
    return { type, idempotencyKey };
  }
  const workItemId = asString(input.workItemId);
  if (!workItemId) return undefined;
  switch (type) {
    case "work.start":
      return { type: "work.start", workItemId, idempotencyKey };
    case "work.revise": {
      const instruction = asString(input.instruction);
      return instruction
        ? { type: "work.revise", workItemId, instruction, idempotencyKey }
        : { type: "work.revise", workItemId, idempotencyKey };
    }
    case "work.retry":
      return { type: "work.retry", workItemId, idempotencyKey };
    case "work.recover":
      return input.force === true
        ? { type: "work.recover", workItemId, force: true, idempotencyKey }
        : { type: "work.recover", workItemId, idempotencyKey };
    case "work.accept":
      return { type: "work.accept", workItemId, idempotencyKey };
    case "review.request":
      return { type: "review.request", workItemId, idempotencyKey };
    case "review.submit": {
      const review = buildCreativeReviewInput(input.review);
      if (!review) return undefined;
      return { type: "review.submit", workItemId, review, idempotencyKey };
    }
    default:
      return undefined;
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") return send(response, 204, {});
    if (request.method === "GET" && request.url === "/health") {
      await repository.health();
      return send(response, 200, { service: "ymcp-novel-v2", temporal: true, postgres: true });
    }
    if (request.method === "GET" && request.url === "/v2/model-config") return send(response, 200, { config: modelConfigStore.getMaskedConfig() });
    if (request.method === "PUT" && request.url === "/v2/model-config") {
      const input = await readJson(request);
      const candidate = asRecord(input.config) as unknown as ModelRoutingConfig | undefined;
      if (!candidate) return send(response, 400, { error: "config 必填" });
      const previous = modelConfigStore.getConfig();
      const clearSecretIds = new Set(Array.isArray(input.clearSecretProfileIds) ? input.clearSecretProfileIds.filter((value): value is string => typeof value === "string") : []);
      candidate.profiles = candidate.profiles.map((profile) => {
        if (clearSecretIds.has(profile.id)) return { ...profile, secret: undefined };
        if (profile.secret) return profile;
        const existing = previous.profiles.find((item) => item.id === profile.id);
        return existing?.secret ? { ...profile, secret: existing.secret } : profile;
      });
      try {
        await modelConfigStore.save(candidate);
        await repository.projectModelRoutingConfig(candidate, modelConfigStore.getSnapshot());
      } catch (error) {
        await modelConfigStore.save(previous).catch(() => undefined);
        throw error;
      }
      return send(response, 200, { config: modelConfigStore.getMaskedConfig() });
    }
    const profileProbeMatch = request.url?.match(/^\/v2\/model-config\/profiles\/([^/?]+)\/probe$/);
    if (request.method === "POST" && profileProbeMatch) {
      const profileId = decodeURIComponent(profileProbeMatch[1]);
      const current = modelConfigStore.getConfig();
      const profile = current.profiles.find((item) => item.id === profileId);
      if (!profile) return send(response, 404, { error: "provider profile 不存在" });
      const purpose = profile.capabilities.includes("text") ? "writing.draft" : profile.capabilities.includes("embedding") ? "memory.embed" : undefined;
      if (!purpose) return send(response, 400, { error: "当前 profile 没有可探测的 text 或 embedding 能力" });
      const snapshot = modelConfigStore.getSnapshot();
      snapshot.routes = { "*": { candidates: [{ executor: "api", profileId }] } };
      const started = Date.now();
      if (purpose === "writing.draft") await model.generateText({ purpose, prompt: "Reply with exactly: OK", maxTokens: 8, routingSnapshot: snapshot });
      else await model.embed({ purpose, texts: ["health check"], routingSnapshot: snapshot });
      return send(response, 200, { ok: true, latencyMs: Date.now() - started, profileId });
    }
    if (request.method === "POST" && request.url === "/v2/model-config/models") {
      // 通过标准 OpenAI 兼容 GET {baseUrl}/models 拉取模型列表
      // 支持两种入参：
      //   1) profileId：复用已保存 profile 的 baseUrl + secret
      //   2) baseUrl + secret：用于新增 profile 时表单内即时拉取
      const input = await readJson(request);
      let baseUrl = asString(input.baseUrl);
      let secretValue = "";
      const profileId = asString(input.profileId);
      if (profileId) {
        const profile = modelConfigStore.getProfile(profileId);
        if (!profile) return send(response, 404, { error: "provider profile 不存在" });
        baseUrl = profile.baseUrl;
        secretValue = profile.secret?.source === "inline" ? profile.secret.value : profile.secret?.source === "env" ? (process.env[profile.secret.name] ?? "") : "";
      } else {
        const secret = asRecord(input.secret);
        if (secret) {
          if (secret.source === "inline" && typeof secret.value === "string") secretValue = secret.value;
          else if (secret.source === "env" && typeof secret.name === "string") secretValue = process.env[secret.name] ?? "";
        }
      }
      if (!baseUrl) return send(response, 400, { error: "baseUrl 必填" });
      const url = `${baseUrl.replace(/\/+$/, "")}/models`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (secretValue) headers.authorization = `Bearer ${secretValue}`;
      let resp: Response;
      try {
        resp = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        return send(response, 502, { error: `拉取模型列表失败：${error instanceof Error ? error.message : String(error)}` });
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return send(response, resp.status, { error: `模型服务 HTTP ${resp.status}${text ? `: ${text.slice(0, 500)}` : ""}` });
      }
      const data = await resp.json() as Record<string, unknown>;
      const rawModels = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
      const models: { id: string; ownedBy?: string }[] = [];
      for (const item of rawModels) {
        const record = asRecord(item);
        if (!record) continue;
        const id = typeof record.id === "string" ? record.id : undefined;
        if (!id) continue;
        const ownedBy = typeof record.owned_by === "string" ? record.owned_by : typeof record.ownedBy === "string" ? record.ownedBy : undefined;
        models.push({ id, ownedBy });
      }
      return send(response, 200, { models });
    }
    const taskListMatch = request.url?.match(/^\/v2\/model-tasks(?:\?status=([^&]+))?$/);
    if (request.method === "GET" && taskListMatch) {
      const status = decodeURIComponent(taskListMatch[1] ?? "pending") as ModelTaskRecord["status"];
      return send(response, 200, { tasks: await repository.listModelTasks(status) });
    }
    const taskItemMatch = request.url?.match(/^\/v2\/model-tasks\/([^/?]+)$/);
    if (request.method === "GET" && taskItemMatch) {
      const task = await repository.getModelTask(decodeURIComponent(taskItemMatch[1]));
      return task ? send(response, 200, { task }) : send(response, 404, { error: "外部模型任务不存在" });
    }
    const taskActionMatch = request.url?.match(/^\/v2\/model-tasks\/([^/?]+)\/(claim|heartbeat|submit|fail)$/);
    if (request.method === "POST" && taskActionMatch) {
      const taskId = decodeURIComponent(taskActionMatch[1]);
      const action = taskActionMatch[2];
      const input = await readJson(request);
      const attemptId = asString(input.attemptId);
      const leaseOwner = asString(input.leaseOwner);
      if (!attemptId || !leaseOwner) return send(response, 400, { error: "attemptId、leaseOwner 必填" });
      if (action === "claim") return send(response, 200, { task: await repository.claimModelTask({ taskId, attemptId, leaseOwner, leaseMs: Math.max(30_000, Math.min(asNumber(input.leaseMs) ?? 600_000, 3_600_000)) }) });
      if (action === "heartbeat") {
        await repository.heartbeatModelTask({ taskId, attemptId, leaseOwner, leaseMs: Math.max(30_000, Math.min(asNumber(input.leaseMs) ?? 600_000, 3_600_000)) });
        return send(response, 200, { ok: true });
      }
      if (action === "submit") {
        const inputFingerprint = asString(input.inputFingerprint);
        const result = asRecord(input.result) as ModelTaskRecord["result"] | undefined;
        if (!inputFingerprint || !result) return send(response, 400, { error: "inputFingerprint、result 必填" });
        const task = await repository.submitModelTask({ taskId, attemptId, leaseOwner, inputFingerprint, result });
        await temporal.workflow.getHandle(task.workflowRunId).signal("artifact", { taskId, modelTaskId: task.id, attemptId, inputFingerprint, result: task.result });
        return send(response, 200, { task });
      }
      const reason = asString(input.reason);
      if (!reason) return send(response, 400, { error: "reason 必填" });
      const task = await repository.failModelTask({ taskId, attemptId, leaseOwner, reason });
      await temporal.workflow.getHandle(task.workflowRunId).signal("fail", { taskId, modelTaskId: task.id, attemptId, reason });
      return send(response, 200, { task });
    }
    if (request.method === "POST" && request.url === "/v2/intents") {
      const input = await readJson(request);
      if (typeof input.projectId !== "string" || typeof input.objective !== "string" || typeof input.idempotencyKey !== "string") return send(response, 400, { error: "projectId、objective、idempotencyKey 必填" });
      if (input.factApprovalMode !== undefined && input.factApprovalMode !== "auto" && input.factApprovalMode !== "manual") return send(response, 400, { error: "factApprovalMode 必须为 auto 或 manual" });
      const intent: NovelIntent = { id: crypto.randomUUID(), projectId: input.projectId, source: input.source === "mcp" ? "mcp" : input.source === "cli" ? "cli" : input.source === "web" ? "web" : "api", objective: input.objective.trim(), target: input.target as NovelIntent["target"], requestedStage: input.requestedStage as NovelIntent["requestedStage"], constraints: Array.isArray(input.constraints) ? input.constraints.filter((value): value is string => typeof value === "string") : undefined, requestedCapabilities: Array.isArray(input.requestedCapabilities) ? input.requestedCapabilities.filter((value): value is string => typeof value === "string") : undefined, factApprovalMode: input.factApprovalMode as NovelIntent["factApprovalMode"], createdAt: Date.now(), idempotencyKey: input.idempotencyKey };
      await repository.ensureProject(intent.projectId, typeof input.projectTitle === "string" ? input.projectTitle : intent.projectId);
      const stored = await repository.putIntent(intent);
      const workflowId = `novel-intent-${stored.id}`;
      // workflow_runs.id 必须等于 workflowId：novelIntentWorkflow 全程用 workflowId 作 workflowRunId
      // （updateTaskAttempt / model gateway / externalTask），task_attempts.workflow_run_id 有 FK→workflow_runs.id。
      // 若 id=stored.id（intent.id）而 workflow 用 workflowId，FK 会失败。
      // 对齐方式：id=workflowId，与 creativeRunWorkflow（id=runId=workflow 实参）保持同一约定。
      await repository.putWorkflowRun({ id: workflowId, workflowType: "novel-intent", projectId: stored.projectId, temporalWorkflowId: workflowId, status: "accepted", payload: { intent: stored, intentId: stored.id } });
      const handle = await temporal.workflow.start("novelIntentWorkflow", { args: [stored, workflowId], taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "novel-v2", workflowId });
      return send(response, 202, { intent: stored, workflowId, runId: handle.firstExecutionRunId });
    }
    if (request.method === "GET" && request.url === "/v2/projects") return send(response, 200, { projects: await repository.listProjects() });
    if (request.method === "POST" && request.url === "/v2/projects") {
      // 一句话创意创建小说项目入口(对齐 v1 bootstrapNovelFromCoreIdea 与 MCP novel_project_create)
      // premise 必填 → 自动派生 title → 默认 autoBootstrap=true 一站式启动全书规划
      // 设计依据:用户需求"创建小说入口改为 v1 版本的一句话创意,MCP 与 HTTP 同一入口"
      const input = await readJson(request);
      const premise = asString(input.premise);
      const idempotencyKey = asString(input.idempotencyKey);
      if (!premise || !idempotencyKey) {
        return send(response, 400, { error: "premise 与 idempotencyKey 必填且非空" });
      }

      const title = asString(input.title) || provisionalTitle(premise);
      const genre = asString(input.genre) || undefined;
      const autoBootstrap = typeof input.autoBootstrap === "boolean" ? input.autoBootstrap : true;
      const includeChapterPlan = typeof input.includeChapterPlan === "boolean" ? input.includeChapterPlan : true;
      const objective = asString(input.objective) || premise;

      // 使用 idempotencyKey 作为 projectId(与 MCP novel_project_create 行为一致)
      const projectId = idempotencyKey;

      // premise/genre 写入 metadata,与 MCP handler 保持同构
      const metadata: Record<string, unknown> = { premise };
      if (genre) metadata.genre = genre;
      await repository.ensureProject(projectId, title, metadata);

      const project = await repository.getProjectDetail(projectId);

      // 自动启动全书规划:premise 作为 objective,让每个 foundation task 都知道创意核心
      // includeChapterPlan 默认 true,避免后续章节生成被 REQUIRED_FOUNDATION_TASK_KEYS 拒绝
      if (autoBootstrap) {
        const bootstrapRun = await startNovelBootstrap(repository, temporal, {
          projectId,
          objective,
          idempotencyKey,
          includeChapterPlan,
          taskQueue,
        });
        return send(response, 201, { project, bootstrapRun });
      }

      return send(response, 201, { project });
    }
    const projectMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)$/);
    if (projectMatch) {
      const projectId = decodeURIComponent(projectMatch[1]);
      if (request.method === "GET") return send(response, 200, { project: await repository.getProjectDetail(projectId) });
      if (request.method === "PATCH") {
        const input = await readJson(request);
        const title = input.title === undefined ? undefined : asString(input.title);
        if (input.title !== undefined && !title) return send(response, 400, { error: "title 不能为空" });
        return send(response, 200, { project: await repository.updateProject({ projectId, title, metadata: asRecord(input.metadata) }) });
      }
      if (request.method === "DELETE") return send(response, 200, await repository.deleteProject(projectId));
    }
    const projectRunsMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/runs$/);
    if (request.method === "GET" && projectRunsMatch) return send(response, 200, { runs: await repository.listProjectRuns(decodeURIComponent(projectRunsMatch[1])) });
    const documentMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/documents$/);
    if (request.method === "POST" && documentMatch) {
      const input = await readJson(request);
      const projectId = decodeURIComponent(documentMatch[1]);
      const title = asString(input.title);
      if (!title) return send(response, 400, { error: "title 必填" });
      const document = await repository.ensureDocument({ projectId, documentId: asString(input.documentId), title, narrativeOrder: asNumber(input.narrativeOrder), povCharacterId: asString(input.povCharacterId), status: asString(input.status) });
      return send(response, 201, { document });
    }
    const documentItemMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/documents\/([^/?]+)$/);
    if (documentItemMatch) {
      const projectId = decodeURIComponent(documentItemMatch[1]);
      const documentId = decodeURIComponent(documentItemMatch[2]);
      if (request.method === "PATCH") {
        const input = await readJson(request);
        const title = input.title === undefined ? undefined : asString(input.title);
        if (input.title !== undefined && !title) return send(response, 400, { error: "title 不能为空" });
        const clearPov = input.povCharacterId === null;
        const povCharacterId = clearPov ? null : asString(input.povCharacterId);
        const document = await repository.updateDocument({ projectId, documentId, title, narrativeOrder: asNumber(input.narrativeOrder), povCharacterId: input.povCharacterId === undefined ? undefined : povCharacterId, status: asString(input.status) });
        return send(response, 200, { document });
      }
      if (request.method === "DELETE") return send(response, 200, await repository.deleteDocument(projectId, documentId));
    }
    const documentContentMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/documents\/([^/?]+)\/content$/);
    if (request.method === "GET" && documentContentMatch) {
      const projectId = decodeURIComponent(documentContentMatch[1]);
      const documentId = decodeURIComponent(documentContentMatch[2]);
      const content = await repository.getFinalDocumentContentRef(projectId, documentId);
      if (!content?.objectKey) return send(response, 404, { error: "章节尚无定稿正文" });
      try {
        const plainText = await objectStore.getText(content.objectKey);
        return send(response, 200, { documentId, title: content.title, status: content.status, revision: content.revision, contentHash: content.contentHash, plainText });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "NoSuchKey") {
          return send(response, 503, { code: "CONTENT_OBJECT_MISSING", error: "定稿正文对象暂时不可用，请检查 Runtime 对象存储配置" });
        }
        throw error;
      }
    }
    const bootstrapMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/bootstrap$/);
    if (request.method === "POST" && bootstrapMatch) {
      const projectId = decodeURIComponent(bootstrapMatch[1]);
      const input = await readJson(request);
      const idempotencyKey = asString(input.idempotencyKey);
      if (!idempotencyKey) return send(response, 400, { error: "idempotencyKey 必填" });
      const objective = asString(input.objective) ?? "完成项目基础设定与全书规划";
      const result = await startNovelBootstrap(repository, temporal, {
        projectId,
        objective,
        idempotencyKey,
        includeChapterPlan: typeof input.includeChapterPlan === "boolean" ? input.includeChapterPlan : true,
        taskQueue,
      });
      return send(response, result.reused ? 200 : 202, result);
    }
    const projectPlanMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/plan$/);
    if (request.method === "GET" && projectPlanMatch) {
      const projectId = decodeURIComponent(projectPlanMatch[1]);
      const [sections, run] = await Promise.all([
        repository.listProjectPlanSections(projectId),
        repository.getProjectPlanRun(projectId),
      ]);
      return send(response, 200, {
        stages: PROJECT_PLAN_STAGES,
        sections,
        run,
        progress: {
          approved: sections.filter((section) => section.status === "approved").length,
          total: sections.length || PROJECT_PLAN_STAGES.length,
        },
      });
    }
    const projectPlanStartMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/plan\/start$/);
    if (request.method === "POST" && projectPlanStartMatch) {
      const projectId = decodeURIComponent(projectPlanStartMatch[1]);
      const input = await readJson(request);
      const idempotencyKey = asString(input.idempotencyKey);
      if (!idempotencyKey) return send(response, 400, { error: "idempotencyKey 必填" });
      const result = await startNovelBootstrap(repository, temporal, {
        projectId,
        objective: asString(input.objective) ?? "建立可执行、可审阅的全书规划",
        idempotencyKey,
        includeChapterPlan: true,
        progression: "user-driven",
        reviewGate: "manual",
        taskQueue,
      });
      return send(response, result.reused ? 200 : 202, result);
    }
    const projectPlanSectionMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/plan\/sections\/([^/?]+)$/);
    if (request.method === "PATCH" && projectPlanSectionMatch) {
      const projectId = decodeURIComponent(projectPlanSectionMatch[1]);
      const taskKeyValue = decodeURIComponent(projectPlanSectionMatch[2]);
      if (!isProjectPlanTaskKey(taskKeyValue)) return send(response, 404, { error: "未知规划阶段" });
      const current = await repository.getProjectPlanSection(projectId, taskKeyValue);
      if (!current?.workItemId || !current.sourceArtifactId) return send(response, 409, { error: "该阶段尚无可编辑产物" });
      const input = await readJson(request);
      const payload = asRecord(input.payload) ?? input;
      if (!asString(payload.title) || !asString(payload.summary) || !Array.isArray(payload.sections) || !asRecord(payload.structuredData)) {
        return send(response, 400, { error: "规划内容必须包含 title、summary、sections 和 structuredData" });
      }
      const run = await repository.getProjectPlanRun(projectId);
      if (!run) return send(response, 409, { error: "项目没有规划运行" });
      const artifact = await createEditedPlanArtifact({ projectId, taskKey: taskKeyValue, workItemId: current.workItemId, runId: run.runId, payload });
      const section = await repository.replaceProjectPlanSection({ projectId, taskKey: taskKeyValue, artifact, actor: "web-author" });
      await repository.ensureFoundationMemoryClaims(projectId);
      return send(response, 200, { section, artifactId: artifact.id });
    }
    const projectPlanGenerateMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/plan\/sections\/([^/?]+)\/generate$/);
    if (request.method === "POST" && projectPlanGenerateMatch) {
      const projectId = decodeURIComponent(projectPlanGenerateMatch[1]);
      const taskKeyValue = decodeURIComponent(projectPlanGenerateMatch[2]);
      if (!isProjectPlanTaskKey(taskKeyValue)) return send(response, 404, { error: "未知规划阶段" });
      const section = await repository.getProjectPlanSection(projectId, taskKeyValue);
      if (!section?.workItemId) return send(response, 409, { error: "请先启动全书规划" });
      const input = await readJson(request);
      const instruction = asString(input.instruction);
      const run = await repository.getProjectPlanRun(projectId);
      if (!run) return send(response, 409, { error: "规划运行不存在" });
      const runIsActive = run.status === "pending" || run.status === "running" || run.status === "paused";
      if (runIsActive && section.status === "awaiting-confirmation" && section.sourceArtifactId) {
        if (instruction) {
          await repository.pool.query("UPDATE creative_work_items SET instruction=$2,updated_at=now() WHERE id=$1", [section.workItemId, `${PROJECT_PLAN_STAGES.find((stage) => stage.taskKey === taskKeyValue)?.instruction ?? taskKeyValue}。作者修订意见：${instruction}`]);
        }
        await submitReview(repository, section.workItemId, {
          subjectArtifactId: section.sourceArtifactId,
          reviewer: "human",
          verdict: "revise",
          issues: [],
          summary: instruction ?? "作者要求重新生成",
        });
        await temporal.workflow.getHandle(run.runId).signal("reviewSubmitted", section.workItemId);
        await temporal.workflow.getHandle(run.runId).signal("generatePlanWork", section.workItemId);
        return send(response, 202, { section: { ...section, status: "generating" }, regenerating: true });
      }
      if (runIsActive && ["ready", "stale", "failed"].includes(section.status)) {
        const generating = await repository.markProjectPlanGenerating(projectId, taskKeyValue);
        await temporal.workflow.getHandle(run.runId).signal("generatePlanWork", section.workItemId);
        return send(response, 202, { section: generating });
      }

      const stage = PROJECT_PLAN_STAGES.find((candidate) => candidate.taskKey === taskKeyValue)!;
      const focusedRun = await createCreativeRun(repository, {
        projectId,
        mode: "chapter",
        policy: { reviewGate: "manual", progression: "user-driven" },
        payload: {
          objective: `重新生成全书规划阶段：${stage.label}`,
          bootstrap: true,
          focusedPlanTaskKey: taskKeyValue,
        },
      });
      const work = await enqueueCreativeWork(repository, focusedRun.id, {
        kind: "generation",
        taskKey: taskKeyValue,
        instruction: `${stage.instruction}${instruction ? `。作者修订意见：${instruction}` : ""}`,
        parameters: { bootstrap: true, focusedPlanRegeneration: true },
      });
      const generating = await repository.prepareProjectPlanRegeneration({
        projectId,
        taskKey: taskKeyValue,
        workItemId: work.id,
        actor: "web-author",
      });
      await repository.putWorkflowRun({
        id: focusedRun.id,
        workflowType: "creative-run",
        projectId,
        temporalWorkflowId: focusedRun.id,
        status: "accepted",
        payload: { runId: focusedRun.id, focusedPlanTaskKey: taskKeyValue },
      });
      await temporal.workflow.start("creativeRunWorkflow", { args: [focusedRun.id], taskQueue, workflowId: focusedRun.id });
      await temporal.workflow.getHandle(focusedRun.id).signal("generatePlanWork", work.id);
      return send(response, 202, { section: generating, regenerating: true, runId: focusedRun.id });
    }
    const projectPlanApproveMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/plan\/sections\/([^/?]+)\/approve$/);
    if (request.method === "POST" && projectPlanApproveMatch) {
      const projectId = decodeURIComponent(projectPlanApproveMatch[1]);
      const taskKeyValue = decodeURIComponent(projectPlanApproveMatch[2]);
      if (!isProjectPlanTaskKey(taskKeyValue)) return send(response, 404, { error: "未知规划阶段" });
      const section = await repository.getProjectPlanSection(projectId, taskKeyValue);
      if (!section?.workItemId || !section.sourceArtifactId || section.status !== "awaiting-confirmation") {
        return send(response, 409, { error: "该规划阶段当前不可确认" });
      }
      await submitReview(repository, section.workItemId, {
        subjectArtifactId: section.sourceArtifactId,
        reviewer: "human",
        verdict: "passed",
        issues: [],
        summary: "作者已在 Web 全书规划工作台确认当前内容",
      });
      const sections = await repository.approveProjectPlanSection(projectId, taskKeyValue, section.sourceArtifactId, "web-author");
      const run = await repository.getProjectPlanRun(projectId);
      if (run && (run.status === "pending" || run.status === "running" || run.status === "paused")) {
        await temporal.workflow.getHandle(run.runId).signal("reviewSubmitted", section.workItemId);
      }
      return send(response, 200, { sections });
    }
    const applyChapterPlanMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/plan\/apply-chapters$/);
    if (request.method === "POST" && applyChapterPlanMatch) {
      const projectId = decodeURIComponent(applyChapterPlanMatch[1]);
      const input = await readJson(request);
      if (input.confirm !== true) return send(response, 200, { preview: await repository.previewChapterPlanApplication(projectId) });
      return send(response, 200, { result: await repository.applyChapterPlan(projectId) });
    }
    const storyArcListMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/story-arcs$/);
    if (request.method === "GET" && storyArcListMatch) {
      const projectId = decodeURIComponent(storyArcListMatch[1]);
      return send(response, 200, { arcs: await repository.listStoryArcs(projectId) });
    }
    const storyArcNextMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/story-arcs\/next$/);
    if (request.method === "POST" && storyArcNextMatch) {
      const projectId = decodeURIComponent(storyArcNextMatch[1]);
      const input = await readJson(request);
      const result = await startStoryArcPlanning(repository, temporal, { projectId, mode: "web", authorIntent: asString(input.authorIntent), taskQueue });
      return send(response, 202, result);
    }
    const storyArcItemMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/story-arcs\/([^/?]+)$/);
    if (request.method === "GET" && storyArcItemMatch) {
      const projectId = decodeURIComponent(storyArcItemMatch[1]);
      const arcId = decodeURIComponent(storyArcItemMatch[2]);
      const arc = await repository.getStoryArc(projectId, arcId);
      return arc ? send(response, 200, { arc }) : send(response, 404, { error: "故事弧不存在" });
    }
    if (request.method === "PATCH" && storyArcItemMatch) {
      const projectId = decodeURIComponent(storyArcItemMatch[1]);
      const arcId = decodeURIComponent(storyArcItemMatch[2]);
      const input = await readJson(request);
      const artifact = await createEditedStoryArcArtifact({ projectId, arcId, payload: asRecord(input.bundle) ?? input });
      const bundle = parseStoryArcBundle(artifact.structuredData);
      return send(response, 200, { arc: await repository.projectStoryArcBundle({ projectId, arcId, bundle, artifact, actor: "web-author", edited: true }) });
    }
    const storyArcActionMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/story-arcs\/([^/?]+)\/(approve|rebase|abandon)$/);
    if (request.method === "POST" && storyArcActionMatch) {
      const projectId = decodeURIComponent(storyArcActionMatch[1]);
      const arcId = decodeURIComponent(storyArcActionMatch[2]);
      const action = storyArcActionMatch[3];
      const input = await readJson(request);
      if (action === "rebase") {
        return send(response, 202, await startStoryArcPlanning(repository, temporal, { projectId, arcId, mode: "web", authorIntent: asString(input.authorIntent), taskQueue }));
      }
      if (action === "abandon") {
        const reason = asString(input.reason);
        if (!reason) return send(response, 400, { error: "放弃故事弧必须填写原因" });
        return send(response, 200, { arc: await repository.abandonStoryArc(projectId, arcId, reason, "web-author") });
      }
      const preview = await repository.previewStoryArcApproval(projectId, arcId);
      if (input.confirm !== true) return send(response, 200, { preview });
      const result = await repository.approveStoryArc(projectId, arcId, preview.artifactId, "web-author");
      const workflow = await repository.getStoryArcWorkflow(projectId, arcId);
      if (workflow && ["accepted", "running", "manual-review-required"].includes(workflow.status)) {
        await temporal.workflow.getHandle(workflow.temporalWorkflowId).signal("storyArcApproved", { arcId, artifactId: preview.artifactId });
      }
      return send(response, 200, result);
    }
    const knowledgeMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/knowledge\/(planning|worldview|characters|relations|timeline|facts|skills|foundation)$/);
    if (knowledgeMatch) {
      const projectId = decodeURIComponent(knowledgeMatch[1]);
      const kind = knowledgeMatch[2] as "planning" | "worldview" | "characters" | "relations" | "timeline" | "facts" | "skills" | "foundation";
      if (request.method === "GET") return send(response, 200, { records: await repository.listKnowledgeRecords(projectId, kind) });
      if (request.method === "POST") {
        if (kind === "foundation") return send(response, 405, { error: "foundation artifact 不可原地修改，请重新运行 bootstrap 生成新版本" });
        const input = await readJson(request);
        return send(response, 201, await repository.upsertKnowledgeRecord(projectId, kind, input));
      }
    }
    const knowledgeItemMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/knowledge\/(planning|worldview|characters|relations|timeline|facts|skills)\/([^/?]+)$/);
    if (knowledgeItemMatch) {
      const projectId = decodeURIComponent(knowledgeItemMatch[1]);
      const kind = knowledgeItemMatch[2] as "planning" | "worldview" | "characters" | "relations" | "timeline" | "facts" | "skills";
      const recordId = decodeURIComponent(knowledgeItemMatch[3]);
      if (request.method === "PATCH") {
        const input = await readJson(request);
        return send(response, 200, await repository.upsertKnowledgeRecord(projectId, kind, { ...input, id: recordId }));
      }
      if (request.method === "DELETE") return send(response, 200, await repository.deleteKnowledgeRecord(projectId, kind, recordId));
    }
    const recordMatch = request.url?.match(/^\/v2\/(preflight-plans|memory-bundles|skills|blueprints|artifacts|context-manifests|learning-assessments)\/([^/]+)$/);
    if (request.method === "GET" && recordMatch) {
      const table = ({ "preflight-plans": "preflight_plans", "memory-bundles": "memory_bundles", skills: "skill_bundles", blueprints: "execution_blueprints", artifacts: "artifacts", "context-manifests": "context_manifests", "learning-assessments": "learning_assessments" } as const)[recordMatch[1] as "preflight-plans" | "memory-bundles" | "skills" | "blueprints" | "artifacts" | "context-manifests" | "learning-assessments"];
      return send(response, 200, { record: await repository.getRecord(table, decodeURIComponent(recordMatch[2])) });
    }
    const runArtifactsMatch = request.url?.match(/^\/v2\/runs\/([^/?]+)\/artifacts$/);
    if (request.method === "GET" && runArtifactsMatch) return send(response, 200, { artifacts: await repository.listRunArtifacts(decodeURIComponent(runArtifactsMatch[1])) });
    const runReviewsMatch = request.url?.match(/^\/v2\/runs\/([^/?]+)\/reviews$/);
    if (request.method === "GET" && runReviewsMatch) return send(response, 200, { reviews: await repository.listRunReviews(decodeURIComponent(runReviewsMatch[1])) });
    // 产物文本内容：从 object store 读取 draft/revision/summary 等产物的实际文本
    const artifactContentMatch = request.url?.match(/^\/v2\/artifacts\/([^/?]+)\/content$/);
    if (request.method === "GET" && artifactContentMatch) {
      const artifactId = decodeURIComponent(artifactContentMatch[1]);
      const artifact = await repository.getArtifact(artifactId);
      if (!artifact) return send(response, 404, { error: "产物不存在" });
      if (!artifact.objectKey) return send(response, 404, { error: "该产物无文本内容" });
      try {
        const text = await objectStore.getText(artifact.objectKey);
        return send(response, 200, { text, kind: artifact.kind, artifactId, wordCount: text.length });
      } catch {
        return send(response, 404, { error: "产物内容读取失败（object store 中不存在）" });
      }
    }
    const eventsMatch = request.url?.match(/^\/v2\/runs\/([^/?]+)\/events(?:\?after=(\d+))?$/);
    if (request.method === "GET" && eventsMatch) {
      const workflowId = decodeURIComponent(eventsMatch[1]);
      const events = await repository.listRunOutbox(workflowId, Number(eventsMatch[2] ?? 0));
      if (request.headers.accept?.includes("text/event-stream")) {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
        for (const event of events) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        const timer = setInterval(() => response.write(`: heartbeat ${Date.now()}\n\n`), 15000);
        request.on("close", () => clearInterval(timer));
        return;
      }
      return send(response, 200, { events });
    }
    if (request.method === "POST" && request.url === "/v2/reviews") { const input = await readJson(request); return send(response, 201, { review: await repository.putReview(input as any) }); }
    if (request.method === "POST" && request.url === "/v2/commits") {
      const input = await readJson(request);
      if (typeof input.projectId !== "string" || typeof input.documentId !== "string" || typeof input.baseRevision !== "number" || typeof input.idempotencyKey !== "string" || !input.artifact) return send(response, 400, { error: "projectId、documentId、baseRevision、artifact、idempotencyKey 必填" });
      const result = await commitService.commit({ projectId: input.projectId, documentId: input.documentId, artifact: input.artifact as any, reviews: Array.isArray(input.reviews) ? input.reviews as any[] : [], baseRevision: input.baseRevision, idempotencyKey: input.idempotencyKey, text: typeof input.text === "string" ? input.text : "" });
      return send(response, 201, { result });
    }
    const workflowTaskSignalMatch = request.url?.match(/^\/v2\/workflows\/([^/]+)\/tasks\/([^/]+)\/signal$/);
    if (request.method === "POST" && workflowTaskSignalMatch) {
      const input = await readJson(request);
      const workflowId = decodeURIComponent(workflowTaskSignalMatch[1]);
      const taskId = decodeURIComponent(workflowTaskSignalMatch[2]);
      const signal = String(input.signal ?? "humanSignal");
      const payload = { ...(typeof input.payload === "object" && input.payload ? input.payload as Record<string, unknown> : {}), taskId };
      await repository.recordTaskSignal({ workflowId, taskId, signal, payload });
      const handle = temporal.workflow.getHandle(workflowId);
      await handle.signal(signal, payload);
      return send(response, 202, { accepted: true, workflowId, taskId });
    }
    const signalMatch = request.url?.match(/^\/v2\/tasks\/([^/]+)\/signal$/);
    if (request.method === "POST" && signalMatch) {
      const input = await readJson(request);
      const taskId = decodeURIComponent(signalMatch[1]);
      const workflowId = asString(input.workflowId);
      if (!workflowId) return send(response, 400, { error: "workflowId 必填；任务信号必须绑定 Temporal workflow，不能把 taskId 当作 workflowId" });
      const signal = String(input.signal ?? "humanSignal");
      const payload = { ...(typeof input.payload === "object" && input.payload ? input.payload as Record<string, unknown> : {}), taskId };
      await repository.recordTaskSignal({ workflowId, taskId, signal, payload });
      const handle = temporal.workflow.getHandle(workflowId);
      await handle.signal(signal, payload);
      return send(response, 202, { accepted: true, workflowId, taskId });
    }
    const learningPromoteMatch = request.url?.match(/^\/v2\/learning\/([^/?]+)\/promote$/);
    if (request.method === "POST" && learningPromoteMatch) return send(response, 202, { promotion: await repository.requestLearningPromotion(decodeURIComponent(learningPromoteMatch[1])) });

    // ===== 评估闭环路由（B-1.5）=====
    const snapshotsMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/snapshots$/);
    if (snapshotsMatch) {
      const projectId = decodeURIComponent(snapshotsMatch[1]);
      if (request.method === "POST") {
        const snapshot = await captureProjectSnapshot(repository, projectId);
        return send(response, 201, { snapshot });
      }
      if (request.method === "GET") {
        return send(response, 200, { snapshots: await repository.listCapturedSnapshots(projectId) });
      }
    }
    const snapshotMatch = request.url?.match(/^\/v2\/snapshots\/([^/?]+)$/);
    if (request.method === "GET" && snapshotMatch) {
      const snapshot = await repository.getCapturedSnapshot(decodeURIComponent(snapshotMatch[1]));
      if (!snapshot) return send(response, 404, { error: "快照不存在" });
      return send(response, 200, { snapshot });
    }

    const experimentsMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/experiments$/);
    if (experimentsMatch) {
      const projectId = decodeURIComponent(experimentsMatch[1]);
      if (request.method === "GET") {
        const experiments = await listExperimentWorkspaces(repository, projectId);
        return send(response, 200, { experiments });
      }
      if (request.method === "POST") {
        const input = await readJson(request);
        const snapshotId = asString(input.snapshotId);
        if (!snapshotId) return send(response, 400, { error: "snapshotId 必填" });
        const bundle = await repository.getCapturedSnapshot(snapshotId, projectId);
        if (!bundle) return send(response, 404, { error: "快照不存在或不属于该项目" });
        const experimentId = asString(input.experimentId);
        const workspace = await createExperimentWorkspace(repository, bundle, experimentId);
        return send(response, 201, { experiment: { id: workspace.id, projectId: workspace.projectId, schemaName: workspace.schemaName, baseSnapshotId: workspace.baseSnapshotId, baseSnapshotHash: workspace.baseSnapshotHash, status: workspace.status, createdAt: workspace.createdAt } });
      }
    }
    const projectCandidatesMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/candidates$/);
    if (request.method === "GET" && projectCandidatesMatch) {
      const projectId = decodeURIComponent(projectCandidatesMatch[1]);
      return send(response, 200, { candidates: await repository.listCandidateBundles(projectId) });
    }
    const projectReceiptsMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/receipts$/);
    if (request.method === "GET" && projectReceiptsMatch) {
      const projectId = decodeURIComponent(projectReceiptsMatch[1]);
      return send(response, 200, { receipts: await repository.listPromotionReceipts(projectId) });
    }
    const experimentCloseMatch = request.url?.match(/^\/v2\/experiments\/([^/?]+)\/close$/);
    if (request.method === "POST" && experimentCloseMatch) {
      const experimentId = decodeURIComponent(experimentCloseMatch[1]);
      const workspace = await getExperimentWorkspace(repository, experimentId);
      if (!workspace) return send(response, 404, { error: "实验工作区不存在" });
      await workspace.close();
      return send(response, 200, { closed: true, experimentId });
    }
    const experimentMatch = request.url?.match(/^\/v2\/experiments\/([^/?]+)$/);
    if (experimentMatch) {
      const experimentId = decodeURIComponent(experimentMatch[1]);
      if (request.method === "GET") {
        const workspace = await getExperimentWorkspace(repository, experimentId);
        if (!workspace) return send(response, 404, { error: "实验工作区不存在或已删除" });
        return send(response, 200, { experiment: { id: workspace.id, projectId: workspace.projectId, schemaName: workspace.schemaName, baseSnapshotId: workspace.baseSnapshotId, baseSnapshotHash: workspace.baseSnapshotHash, status: workspace.status, createdAt: workspace.createdAt } });
      }
      if (request.method === "DELETE") {
        const workspace = await getExperimentWorkspace(repository, experimentId);
        if (!workspace) return send(response, 404, { error: "实验工作区不存在" });
        await workspace.delete();
        return send(response, 200, { deleted: true, experimentId });
      }
    }
    const experimentCandidateMatch = request.url?.match(/^\/v2\/experiments\/([^/?]+)\/candidate$/);
    if (request.method === "POST" && experimentCandidateMatch) {
      const experimentId = decodeURIComponent(experimentCandidateMatch[1]);
      const workspace = await getExperimentWorkspace(repository, experimentId);
      if (!workspace) return send(response, 404, { error: "实验工作区不存在" });
      const input = await readJson(request);
      const documentId = asString(input.documentId);
      if (!documentId) return send(response, 400, { error: "documentId 必填" });
      // 查询正式库的 document 基线
      const documentStatus = await repository.getDocumentStatus(workspace.projectId, documentId);
      if (!documentStatus) return send(response, 404, { error: "文档不存在" });
      const baseRevisionRow = await repository.getDocumentRevisionBaseline(workspace.projectId, documentId) ?? { revision: 0, contentHash: "" };
      const dependencyHead = await computeProjectHead(repository, workspace.projectId);
      const candidate = await extractCandidateBundle(workspace, {
        sourceProjectId: workspace.projectId,
        baseSnapshotId: workspace.baseSnapshotId,
        baseSnapshotHash: workspace.baseSnapshotHash,
        dependencyHead,
        documentId,
        baseRevision: baseRevisionRow.revision,
        baseContentHash: baseRevisionRow.contentHash,
        workflowRunId: asString(input.workflowRunId) ?? `api-${Date.now()}`,
        codeRevision: asString(input.codeRevision),
      });
      // 持久化到 candidate_bundles 表
      await repository.saveCandidateBundle(candidate);
      return send(response, 201, { candidate });
    }
    const candidateMatch = request.url?.match(/^\/v2\/candidates\/([^/?]+)$/);
    if (request.method === "GET" && candidateMatch) {
      const candidate = await repository.getCandidateBundle(decodeURIComponent(candidateMatch[1]));
      if (!candidate) return send(response, 404, { error: "候选包不存在" });
      return send(response, 200, { candidate });
    }
    const promoteMatch = request.url?.match(/^\/v2\/candidates\/([^/?]+)\/promote$/);
    if (request.method === "POST" && promoteMatch) {
      const candidateId = decodeURIComponent(promoteMatch[1]);
      const candidate = await repository.getCandidateBundle(candidateId);
      if (!candidate) return send(response, 404, { error: "候选包不存在" });
      const input = await readJson(request);
      const decision: AuthorDecision = {
        authorId: asString(input.authorId) ?? "anonymous",
        decision: input.decision === "reject" ? "reject" : "accept",
        reason: asString(input.reason),
        decidedAt: Date.now(),
      };
      const receipt = await promotionService.promote(candidate, decision);
      return send(response, 200, { receipt });
    }
    const rollbackMatch = request.url?.match(/^\/v2\/candidates\/([^/?]+)\/rollback$/);
    if (request.method === "POST" && rollbackMatch) {
      const candidateId = decodeURIComponent(rollbackMatch[1]);
      const existingReceipt = await promotionService.getReceipt(candidateId);
      if (!existingReceipt) return send(response, 404, { error: "候选包未晋升，无法回滚" });
      await promotionService.rollback(existingReceipt.id);
      return send(response, 200, { rolledBack: true, candidateId });
    }
    const receiptMatch = request.url?.match(/^\/v2\/receipts\/([^/?]+)$/);
    if (request.method === "GET" && receiptMatch) {
      const receiptId = decodeURIComponent(receiptMatch[1]);
      const receipt = await repository.getPromotionReceiptById(receiptId);
      if (!receipt) return send(response, 404, { error: "收据不存在" });
      return send(response, 200, { receipt });
    }
    const closedLoopMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/closed-loop$/);
    if (request.method === "POST" && closedLoopMatch) {
      const projectId = decodeURIComponent(closedLoopMatch[1]);
      const input = await readJson(request);
      const documentId = asString(input.documentId);
      if (!documentId) return send(response, 400, { error: "documentId 必填" });
      const result = await runClosedLoop({
        repository,
        model,
        projectId,
        documentId,
        instruction: asString(input.instruction),
        experimentId: asString(input.experimentId),
        codeRevision: asString(input.codeRevision),
        authorId: asString(input.authorId),
        dryRun: input.dryRun === true,
      });
      return send(response, 200, { result });
    }

    // ===== 创意执行路由（Phase B-2）=====

    // 1. POST /v2/projects/:projectId/creative-runs —— 创建 CreativeRun
    //    GET /v2/projects/:projectId/creative-runs —— 列出项目的 CreativeRun
    const projectCreativeRunsMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/creative-runs$/);
    if (projectCreativeRunsMatch) {
      const projectId = decodeURIComponent(projectCreativeRunsMatch[1]);
      if (request.method === "GET") {
        const runs = await listCreativeRuns(repository, projectId);
        return send(response, 200, { runs });
      }
      if (request.method === "POST") {
        const input = await readJson(request);
        const modeRaw = asString(input.mode);
        if (modeRaw !== "chapter" && modeRaw !== "segment-auto") return send(response, 400, { error: "mode 必填，且必须为 \"chapter\" 或 \"segment-auto\"" });
        const mode: CreativeRunMode = modeRaw;
        const policy = buildCreativePolicy(input.policy);
        const payload = asRecord(input.payload);
        try {
          const run = await createCreativeRun(repository, { projectId, mode, ...(policy ? { policy } : {}), ...(payload ? { payload } : {}) });
          return send(response, 201, { run });
        } catch (error) {
          return send(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    // 2. GET /v2/creative-runs/:runId —— 获取 run 详情（含 work items + reviews + events）
    //    POST /v2/creative-runs/:runId/commands —— 提交命令到 run
    //    GET /v2/creative-runs/:runId/events?afterSequence=N —— 增量事件流
    const creativeRunMatch = request.url?.match(/^\/v2\/creative-runs\/([^/?]+)$/);
    if (request.method === "GET" && creativeRunMatch) {
      const runId = decodeURIComponent(creativeRunMatch[1]);
      const snapshot = await getRunSnapshot(repository, runId);
      if (!snapshot) return send(response, 404, { error: "CreativeRun 不存在" });
      return send(response, 200, { snapshot });
    }
    const creativeRunCommandsMatch = request.url?.match(/^\/v2\/creative-runs\/([^/?]+)\/commands$/);
    if (request.method === "POST" && creativeRunCommandsMatch) {
      const runId = decodeURIComponent(creativeRunCommandsMatch[1]);
      const input = await readJson(request);
      const command = buildCreativeCommand(input);
      if (!command) return send(response, 400, { error: "命令构造失败：type/idempotencyKey 必填，work.* / review.* 命令需 workItemId，review.submit 需 review" });
      try {
        const result = await executeCreativeCommand(repository, { ...command, runId }, model);
        return send(response, 202, { result });
      } catch (error) {
        // run 不存在 / work item 不存在 / 状态转换非法 等
        return send(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const creativeRunEventsMatch = request.url?.match(/^\/v2\/creative-runs\/([^/?]+)\/events(?:\?afterSequence=(\d+))?$/);
    if (request.method === "GET" && creativeRunEventsMatch) {
      const runId = decodeURIComponent(creativeRunEventsMatch[1]);
      const afterSequenceRaw = creativeRunEventsMatch[2];
      const afterSequence = afterSequenceRaw !== undefined ? Number(afterSequenceRaw) : undefined;
      if (afterSequence !== undefined && (!Number.isFinite(afterSequence) || afterSequence < 0)) return send(response, 400, { error: "afterSequence 必须为非负整数" });
      const snapshot = await getRunSnapshot(repository, runId, afterSequence);
      if (!snapshot) return send(response, 404, { error: "CreativeRun 不存在" });
      // 注意：snapshot.events 已按 id > afterSequence 增量返回
      return send(response, 200, { events: snapshot.events });
    }

    // POST /v2/projects/:projectId/documents/:documentId/review —— 章节审校工作流
    const chapterReviewMatch = request.url?.match(/^\/v2\/projects\/([^/]+)\/documents\/([^/]+)\/review$/);
    if (request.method === "POST" && chapterReviewMatch) {
      try {
        const projectId = decodeURIComponent(chapterReviewMatch[1]);
        const documentId = decodeURIComponent(chapterReviewMatch[2]);
        const input = await readJson(request);
        const instruction = asString(input.instruction);
        const idempotencyKey = asString(input.idempotencyKey) ?? `${projectId}:${documentId}:review:${Date.now()}`;

        // 校验 document 存在 + status="final"（AGENTS.md 契约：仅对已定稿章节开放重审）
        const preflight = await repository.getChapterReviewPreflight(projectId, documentId);
        if (!preflight) return send(response, 404, { error: "章节不存在" });
        if (preflight.status !== "final") return send(response, 400, { error: "章节审校仅对已定稿章节开放" });
        if (preflight.activeWorkflowId) return send(response, 409, { error: "该章节已有活跃审校工作流", workflowId: preflight.activeWorkflowId });
        if (!preflight.hasBlueprint) return send(response, 400, { error: "找不到该章节的历史 blueprint artifact，无法启动章节审校" });

        const workflowId = `chapter-review-${documentId}-${idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`.slice(0, 200);
        const proposedText = typeof input.proposedText === "string" ? input.proposedText.trim() : undefined;
        if (input.proposedText !== undefined && !proposedText) return send(response, 400, { error: "作者修订正文不能为空" });
        let proposedArtifactId: string | undefined;
        if (proposedText) {
          const object = await objectStore.putText(proposedText);
          proposedArtifactId = randomUUID();
          const proposal: Artifact = { id: proposedArtifactId, projectId, taskId: `${workflowId}:author-proposal`, attemptId: `${workflowId}:author-proposal:1`, kind: "revision", contentHash: object.hash, objectKey: object.key, baseRevision: preflight.baseRevision, fingerprint: object.hash, structuredData: { workflowId, origin: "author-proposal", documentId }, createdAt: Date.now() };
          await repository.recordArtifact(proposal);
        }
        const params = { projectId, documentId, instruction, workflowId, proposedArtifactId };
        // workflowId is also the workflow_run primary key: all Temporal
        // activities use it as workflowRunId and task_attempts reference it.
        await repository.putWorkflowRun({ id: workflowId, workflowType: "chapter-review", projectId, temporalWorkflowId: workflowId, status: "accepted", payload: { documentId, instruction, idempotencyKey, proposedArtifactId } });
        const handle = await temporal.workflow.start("chapterReviewWorkflow", { args: [params], taskQueue, workflowId });
        return send(response, 202, { workflowId, runId: handle.firstExecutionRunId, documentId, instruction, status: "accepted" });
      } catch (error) {
        return send(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    const factCandidatesMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/fact-candidates(?:\?(.+))?$/);
    if (request.method === "GET" && factCandidatesMatch) {
      const projectId = decodeURIComponent(factCandidatesMatch[1]);
      const query = new URL(request.url ?? "", `http://${request.headers.host ?? "127.0.0.1"}`).searchParams;
      const documentId = query.get("documentId")?.trim() || undefined;
      return send(response, 200, { candidates: await repository.listFactCandidates(projectId, documentId) });
    }

    const factDecisionMatch = request.url?.match(/^\/v2\/projects\/([^/]+)\/fact-candidates\/([^/]+)\/decision$/);
    if (request.method === "POST" && factDecisionMatch) {
      try {
        const projectId = decodeURIComponent(factDecisionMatch[1]);
        const claimId = decodeURIComponent(factDecisionMatch[2]);
        const input = await readJson(request);
        const decision = input.decision === "approve" || input.decision === "reject" ? input.decision : undefined;
        const actorId = asString(input.actorId);
        if (!decision || !actorId) return send(response, 400, { error: "decision(approve/reject) 和 actorId 必填" });
        const result = await repository.decideFactCandidate({ projectId, claimId, actorId, decision, reason: asString(input.reason) });
        return send(response, 200, { result });
      } catch (error) {
        return send(response, 409, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (request.method === "GET" && request.url === "/v2/usage") return send(response, 200, { usage: await repository.listModelUsage() });
    const runMatch = request.url?.match(/^\/v2\/runs\/([^/]+)$/);
    if (request.method === "GET" && runMatch) {
      const workflowId = decodeURIComponent(runMatch[1]);
      const [description, record] = await Promise.all([temporal.workflow.getHandle(workflowId).describe(), repository.getWorkflowRunByTemporalId(workflowId)]);
      return send(response, 200, { workflowId, status: record?.status ?? description.status.name, runId: description.runId, record });
    }
    return send(response, 404, { error: "NOT_FOUND" });
  } catch (error) { return send(response, 500, { error: error instanceof Error ? error.message : String(error) }); }
});

server.listen(port, "127.0.0.1", () => console.log(`ymcp novel v2 api listening on http://127.0.0.1:${port}`));
process.once("SIGINT", () => { server.close(); void repository.close(); void connection.close(); });
process.once("SIGTERM", () => { server.close(); void repository.close(); void connection.close(); });
