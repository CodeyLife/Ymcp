#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv } from "vite";
import { NovelRuntimeService } from "../src/novel-runtime/service";
import { RuntimeRecordConflictError, SqliteNovelStore } from "../src/novel-runtime/sqlite-store";
import type { LegacyMigrationBundle, RuntimeActor, RuntimeApiError, RuntimeDriver, RuntimeExternalReview, RuntimeProjectMutationCommand } from "../src/novel-runtime/contracts";
import type { CreativeToolName } from "../src/features/novel/creative-tool-gateway";

const DEFAULT_PORT = 4766;
const ALLOWED_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_PROTOCOL_VERSION = 2;
const RUNTIME_SOURCE_ROOTS = ["scripts/novel-runtime.ts", "src/novel-runtime", "src/features/novel", "package.json", "package-lock.json"];

function runtimeSourceEntries(path: string, entries: string[] = []): string[] {
  let stats;
  try { stats = statSync(path); } catch { return entries; }
  if (stats.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (name === "__tests__" || name === "node_modules" || name.startsWith(".")) continue;
      runtimeSourceEntries(resolve(path, name), entries);
    }
    return entries;
  }
  if (!/\.(?:ts|tsx|mjs|json)$/.test(path) || /(?:\.test|\.spec)\.[^.]+$/.test(path)) return entries;
  entries.push(`${path.slice(RUNTIME_ROOT.length + 1).replaceAll("\\", "/")}:${stats.size}:${stats.mtimeMs}`);
  return entries;
}

function runtimeSourceVersion() {
  const entries = RUNTIME_SOURCE_ROOTS.flatMap((rel) => runtimeSourceEntries(resolve(RUNTIME_ROOT, rel))).sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

const RUNTIME_SOURCE_VERSION = process.env.YMCP_NOVEL_RUNTIME_SOURCE_VERSION || runtimeSourceVersion();

export function applyRuntimeEnvDefaults(
  target: NodeJS.ProcessEnv = process.env,
  fileEnv: Record<string, string> = loadEnv(target.MODE || target.NODE_ENV || "development", process.cwd(), ""),
) {
  target.YMCP_API_KEY ||= fileEnv.YMCP_API_KEY?.trim() || fileEnv.VITE_DEFAULT_API_KEY?.trim();
  target.YMCP_API_BASE_URL ||= fileEnv.YMCP_API_BASE_URL?.trim() || fileEnv.VITE_DEFAULT_API_BASE_URL?.trim();
  target.YMCP_MODEL_CONTEXT_WINDOW ||= fileEnv.YMCP_MODEL_CONTEXT_WINDOW?.trim() || fileEnv.VITE_DEFAULT_MODEL_CONTEXT_WINDOW?.trim();
  return target;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false, readonly details?: unknown) {
    super(message);
  }
}

function dataRoot() {
  return process.env.YMCP_NOVEL_DATA_DIR || join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "Ymcp");
}

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGIN.test(origin)) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-headers", "content-type,x-ymcp-request-key");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
}

async function body(req: IncomingMessage, maxBytes = 128 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "请求内容超过运行时限制");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
  catch { throw new HttpError(400, "INVALID_JSON", "请求体不是有效 JSON"); }
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function routePattern(pathname: string, pattern: RegExp) {
  return pathname.match(pattern)?.groups;
}

function externalReview(input: Record<string, unknown>): Omit<RuntimeExternalReview, "actor" | "reviewedAt"> {
  const review = input.review;
  if (!review || typeof review !== "object" || Array.isArray(review)) throw new HttpError(400, "INVALID_REVIEW", "外部审核必须是结构化对象");
  const value = review as Record<string, unknown>;
  if (!(["passed", "revise"] as string[]).includes(String(value.verdict)) || typeof value.reviewRunId !== "string" || !value.reviewRunId.trim() || typeof value.summary !== "string" || !value.summary.trim() || typeof value.artifactFingerprint !== "string" || !value.artifactFingerprint.trim()) {
    throw new HttpError(400, "INVALID_REVIEW", "外部审核缺少 verdict、reviewRunId、summary 或 artifactFingerprint");
  }
  if (!Array.isArray(value.issues)) throw new HttpError(400, "INVALID_REVIEW", "外部审核 issues 必须为数组");
  const issues = value.issues.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "INVALID_REVIEW", `issues[${index}] 必须为对象`);
    const issue = raw as Record<string, unknown>;
    if (typeof issue.id !== "string" || !issue.id.trim() || !["blocker", "major", "warning"].includes(String(issue.severity)) || typeof issue.dimension !== "string" || typeof issue.title !== "string" || typeof issue.evidence !== "string" || typeof issue.suggestion !== "string") {
      throw new HttpError(400, "INVALID_REVIEW", `issues[${index}] 字段不完整`);
    }
    return { id: issue.id, severity: issue.severity as "blocker" | "major" | "warning", dimension: issue.dimension, title: issue.title, evidence: issue.evidence, suggestion: issue.suggestion, evidenceItemId: typeof issue.evidenceItemId === "string" ? issue.evidenceItemId : undefined, evidenceField: typeof issue.evidenceField === "string" ? issue.evidenceField : undefined, evidenceQuote: typeof issue.evidenceQuote === "string" ? issue.evidenceQuote : undefined };
  });
  if (value.verdict === "passed" && issues.some((issue) => issue.severity === "blocker" || issue.severity === "major")) {
    throw new HttpError(400, "INVALID_REVIEW", "passed 外部审核不能包含未解决的 blocker 或 major");
  }
  const learning = value.learning;
  if (!learning || typeof learning !== "object" || Array.isArray(learning)) throw new HttpError(400, "INVALID_REVIEW", "外部审核必须记录本轮经验判断");
  const learningValue = learning as Record<string, unknown>;
  if (!(["no-shared-learning", "propose-improvement"] as string[]).includes(String(learningValue.conclusion)) || typeof learningValue.summary !== "string" || !learningValue.summary.trim()) {
    throw new HttpError(400, "INVALID_REVIEW", "经验判断缺少 conclusion 或 summary");
  }
  if (learningValue.conclusion === "propose-improvement" && (!String(learningValue.affectedInputClass ?? "").trim() || !String(learningValue.underlyingMechanism ?? "").trim())) {
    throw new HttpError(400, "INVALID_REVIEW", "可沉淀经验必须说明影响输入类别和共享机制");
  }
  return { reviewRunId: value.reviewRunId, verdict: value.verdict as "passed" | "revise", summary: value.summary, artifactFingerprint: value.artifactFingerprint, issues, learning: { conclusion: learningValue.conclusion as "no-shared-learning" | "propose-improvement", summary: learningValue.summary, affectedInputClass: typeof learningValue.affectedInputClass === "string" ? learningValue.affectedInputClass : undefined, underlyingMechanism: typeof learningValue.underlyingMechanism === "string" ? learningValue.underlyingMechanism : undefined } };
}

const RUNTIME_STARTED_AT = Date.now();

export async function createNovelRuntime(options: { databasePath?: string; port?: number; host?: string; exitOnAdminRestart?: boolean } = {}) {
  const databasePath = options.databasePath || process.env.YMCP_NOVEL_DB_PATH || join(dataRoot(), "novel-runtime.sqlite");
  const store = new SqliteNovelStore(databasePath);
  const service = new NovelRuntimeService(store);
  await service.initialize();
  let closeRuntime: (() => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    try {
      if (req.method === "GET" && url.pathname === "/v1/health") return json(res, 200, { ok: true, service: "ymcp-novel-runtime", protocolVersion: RUNTIME_PROTOCOL_VERSION, sourceVersion: RUNTIME_SOURCE_VERSION, startedAt: RUNTIME_STARTED_AT, runtimeRoot: RUNTIME_ROOT });
      if (req.method === "POST" && url.pathname === "/v1/admin/restart") {
        const remoteAddress = req.socket.remoteAddress ?? "";
        const isLoopback = remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
        const input = await body(req);
        if (!isLoopback || input.runtimeRoot !== RUNTIME_ROOT) throw new HttpError(403, "RESTART_FORBIDDEN", "只允许同一源码根目录的本机客户端重启运行时");
        json(res, 202, { restarting: true });
        setTimeout(() => {
          void closeRuntime?.().finally(() => {
            if (options.exitOnAdminRestart) process.exit(0);
          });
        }, 25);
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/projects") return json(res, 200, { projects: await service.listProjects() });
      if (req.method === "POST" && url.pathname === "/v1/projects") {
        const input = await body(req);
        const genre = Array.isArray(input.genre) ? input.genre.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
        if (typeof input.title !== "string" || !input.title.trim() || typeof input.premise !== "string" || !input.premise.trim() || !genre.length) throw new HttpError(400, "INVALID_PROJECT", "title、premise 和 genre 不能为空");
        return json(res, 201, { project: await service.createProject({ title: input.title.trim(), premise: input.premise.trim(), genre }, req.headers["x-ymcp-request-key"] as string || crypto.randomUUID()) });
      }
      const projectRoute = routePattern(url.pathname, /^\/v1\/projects\/(?<projectId>[^/]+)$/);
      if (req.method === "GET" && projectRoute) {
        const projectId = decodeURIComponent(projectRoute.projectId);
        if (projectId !== "__user__" && !(await service.listProjects()).some((project) => project.id === projectId)) throw new HttpError(404, "PROJECT_NOT_FOUND", "项目不存在");
        return json(res, 200, await service.getProject(projectId));
      }
      const statusRoute = routePattern(url.pathname, /^\/v1\/projects\/(?<projectId>[^/]+)\/status$/);
      if (req.method === "GET" && statusRoute) return json(res, 200, service.getStatus(decodeURIComponent(statusRoute.projectId)));
      const recordsRoute = routePattern(url.pathname, /^\/v1\/projects\/(?<projectId>[^/]+)\/records$/);
      if (req.method === "GET" && recordsRoute) {
        const projectId = decodeURIComponent(recordsRoute.projectId);
        if (projectId !== "__user__" && !(await service.listProjects()).some((project) => project.id === projectId)) throw new HttpError(404, "PROJECT_NOT_FOUND", "项目不存在");
        return json(res, 200, service.getProjectSnapshot(projectId));
      }
      const mutationsRoute = routePattern(url.pathname, /^\/v1\/projects\/(?<projectId>[^/]+)\/mutations$/);
      if (req.method === "POST" && mutationsRoute) {
        const projectId = decodeURIComponent(mutationsRoute.projectId);
        if (!(await service.listProjects()).some((project) => project.id === projectId)) throw new HttpError(404, "PROJECT_NOT_FOUND", "项目不存在");
        const input = await body(req);
        const actor = input.actor as RuntimeActor | undefined;
        if (!actor || !["user", "external-llm"].includes(actor.type) || typeof actor.id !== "string" || !actor.id.trim()) throw new HttpError(400, "INVALID_ACTOR", "正式编辑必须携带有效 actor");
        if (!Array.isArray(input.mutations) || !input.mutations.length) throw new HttpError(400, "INVALID_MUTATIONS", "mutations 不能为空");
        return json(res, 200, await service.applyProjectMutation({ projectId, actor, mutations: input.mutations } as RuntimeProjectMutationCommand, req.headers["x-ymcp-request-key"] as string || crypto.randomUUID()));
      }
      const deleteProjectRoute = routePattern(url.pathname, /^\/v1\/projects\/(?<projectId>[^/]+)\/delete$/);
      if (req.method === "POST" && deleteProjectRoute) {
        const projectId = decodeURIComponent(deleteProjectRoute.projectId);
        if (!(await service.listProjects()).some((project) => project.id === projectId)) throw new HttpError(404, "PROJECT_NOT_FOUND", "项目不存在");
        const input = await body(req);
        const actor = input.actor as RuntimeActor | undefined;
        if (!actor || actor.type !== "user" || typeof actor.id !== "string" || !actor.id.trim()) throw new HttpError(400, "INVALID_ACTOR", "删除项目必须携带用户 actor");
        return json(res, 200, await service.deleteProject(projectId, actor, req.headers["x-ymcp-request-key"] as string || crypto.randomUUID()));
      }
      const deleteChapterRoute = routePattern(url.pathname, /^\/v1\/projects\/(?<projectId>[^/]+)\/chapters\/(?<documentId>[^/]+)\/delete$/);
      if (req.method === "POST" && deleteChapterRoute) {
        const projectId = decodeURIComponent(deleteChapterRoute.projectId);
        if (!(await service.listProjects()).some((project) => project.id === projectId)) throw new HttpError(404, "PROJECT_NOT_FOUND", "项目不存在");
        const input = await body(req);
        const actor = input.actor as RuntimeActor | undefined;
        if (!actor || actor.type !== "user" || typeof actor.id !== "string" || !actor.id.trim()) throw new HttpError(400, "INVALID_ACTOR", "删除章节必须携带用户 actor");
        return json(res, 200, await service.deleteChapter(projectId, decodeURIComponent(deleteChapterRoute.documentId), actor));
      }
      if (req.method === "POST" && url.pathname === "/v1/operations") {
        const input = await body(req);
        if (typeof input.projectId !== "string" || !["plan", "write", "revise"].includes(String(input.kind)) || typeof input.instruction !== "string" || !input.instruction.trim()) throw new HttpError(400, "INVALID_OPERATION", "projectId、kind 和 instruction 无效");
        if (!(await service.listProjects()).some((project) => project.id === input.projectId)) throw new HttpError(404, "PROJECT_NOT_FOUND", "项目不存在");
        const driver = input.driver === "external-mcp" ? "external-mcp" : input.driver === "human" ? "human" : undefined;
        if (!driver) throw new HttpError(400, "INVALID_DRIVER", "driver 必须是 human 或 external-mcp");
        return json(res, 202, { operation: service.enqueueIntent({ projectId: input.projectId, kind: input.kind as "plan" | "write" | "revise", instruction: input.instruction.trim(), target: typeof input.target === "string" ? input.target : undefined, taskKey: typeof input.taskKey === "string" ? input.taskKey : undefined, driver: driver as RuntimeDriver } as Parameters<typeof service.enqueueIntent>[0], req.headers["x-ymcp-request-key"] as string || crypto.randomUUID()) });
      }
      const operationRetryRoute = routePattern(url.pathname, /^\/v1\/operations\/(?<operationId>[^/]+)\/retry$/);
      if (req.method === "POST" && operationRetryRoute) {
        const input = await body(req);
        const actor = input.actor as RuntimeActor | undefined;
        if (!actor || !["user", "external-llm"].includes(actor.type) || typeof actor.id !== "string") throw new HttpError(400, "INVALID_ACTOR", "重试必须携带有效 actor");
        return json(res, 202, await service.retryOperation(decodeURIComponent(operationRetryRoute.operationId), typeof input.note === "string" ? input.note : "", actor, input.includePreviousCandidate !== false));
      }
      const operationRoute = routePattern(url.pathname, /^\/v1\/operations\/(?<operationId>[^/]+)$/);
      if (req.method === "GET" && operationRoute) return json(res, 200, service.getOperation(operationRoute.operationId, Number(url.searchParams.get("afterSequence") ?? 0)));
      const changeRoute = routePattern(url.pathname, /^\/v1\/changes\/(?<changeId>[^/]+)$/);
      if (req.method === "GET" && changeRoute) return json(res, 200, await service.getChangeDetails(changeRoute.changeId));
      const changeRevalidateRoute = routePattern(url.pathname, /^\/v1\/changes\/(?<changeId>[^/]+)\/revalidate$/);
      if (req.method === "POST" && changeRevalidateRoute) {
        const input = await body(req);
        const change = store.getChange(changeRevalidateRoute.changeId);
        if (!change) throw new HttpError(404, "CHANGE_NOT_FOUND", "候选变更不存在");
        if (typeof input.projectId !== "string" || input.projectId !== change.projectId) throw new HttpError(409, "PROJECT_SCOPE_MISMATCH", "候选变更不属于当前项目");
        const actor = input.actor as RuntimeActor | undefined;
        if (!actor || !["user", "external-llm"].includes(actor.type) || typeof actor.id !== "string" || typeof input.artifactFingerprint !== "string") throw new HttpError(400, "INVALID_REVALIDATION", "重新校验必须携带有效 actor 和 artifactFingerprint");
        return json(res, 200, await service.revalidateChange(decodeURIComponent(changeRevalidateRoute.changeId), actor, input.artifactFingerprint));
      }
      const changePatchRoute = routePattern(url.pathname, /^\/v1\/changes\/(?<changeId>[^/]+)\/patch$/);
      if (req.method === "POST" && changePatchRoute) {
        const input = await body(req);
        const change = store.getChange(changePatchRoute.changeId);
        if (!change) throw new HttpError(404, "CHANGE_NOT_FOUND", "候选变更不存在");
        if (typeof input.projectId !== "string" || input.projectId !== change.projectId) throw new HttpError(409, "PROJECT_SCOPE_MISMATCH", "候选变更不属于当前项目");
        const actor = input.actor as RuntimeActor | undefined;
        if (!actor || !["user", "external-llm"].includes(actor.type) || typeof actor.id !== "string" || typeof input.itemId !== "string" || typeof input.artifactFingerprint !== "string" || typeof input.expectedPayloadFingerprint !== "string" || typeof input.rationale !== "string" || !Array.isArray(input.issueIds) || !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
          throw new HttpError(400, "INVALID_PATCH", "候选补丁字段不完整");
        }
        return json(res, 200, await service.patchChangeItem({
          changeId: decodeURIComponent(changePatchRoute.changeId), itemId: input.itemId, payload: input.payload as Record<string, unknown>, actor,
          artifactFingerprint: input.artifactFingerprint, expectedPayloadFingerprint: input.expectedPayloadFingerprint, rationale: input.rationale,
          issueIds: input.issueIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())), review: externalReview(input),
        }));
      }
      const changeItemRoute = routePattern(url.pathname, /^\/v1\/changes\/(?<changeId>[^/]+)\/items\/(?<itemId>[^/]+)$/);
      if (req.method === "POST" && changeItemRoute) {
        const input = await body(req);
        const actor = input.actor as RuntimeActor | undefined;
        if (!actor || !["user", "external-llm"].includes(actor.type) || typeof actor.id !== "string") throw new HttpError(400, "INVALID_ACTOR", "候选编辑必须携带有效 actor");
        if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) throw new HttpError(400, "INVALID_PAYLOAD", "候选编辑必须提供对象 payload");
        return json(res, 200, await service.updateChangeItem(decodeURIComponent(changeItemRoute.changeId), decodeURIComponent(changeItemRoute.itemId), input.payload as Record<string, unknown>, actor));
      }
      const reviewRoute = routePattern(url.pathname, /^\/v1\/changes\/(?<changeId>[^/]+)\/review$/);
      if (req.method === "POST" && reviewRoute) {
        const input = await body(req);
        if (!["accept", "reject", "revise"].includes(String(input.decision))) throw new HttpError(400, "INVALID_DECISION", "decision 必须是 accept、reject 或 revise");
        const change = store.getChange(reviewRoute.changeId);
        if (!change) throw new HttpError(404, "CHANGE_NOT_FOUND", "候选变更不存在");
        if (typeof input.projectId !== "string" || input.projectId !== change.projectId) throw new HttpError(409, "PROJECT_SCOPE_MISMATCH", "候选变更不属于当前项目");
        const actor = input.actor as RuntimeActor | undefined;
        if (!actor || !["user", "external-llm"].includes(actor.type) || typeof actor.id !== "string") throw new HttpError(400, "INVALID_ACTOR", "审核必须携带有效 actor");
        return json(res, 200, await service.reviewChange(reviewRoute.changeId, input.decision as "accept" | "reject" | "revise", typeof input.note === "string" ? input.note : "", actor, req.headers["x-ymcp-request-key"] as string || crypto.randomUUID(), actor.type === "external-llm" ? externalReview(input) : undefined));
      }
      if (req.method === "POST" && url.pathname === "/v1/improvements") return json(res, 201, await service.proposeImprovement(await body(req)));
      const improvementRoute = routePattern(url.pathname, /^\/v1\/projects\/(?<projectId>[^/]+)\/improvements\/(?<candidateId>[^/]+)$/);
      if (req.method === "GET" && improvementRoute) return json(res, 200, await service.getImprovement(decodeURIComponent(improvementRoute.projectId), decodeURIComponent(improvementRoute.candidateId)));
      const improvementActionRoute = routePattern(url.pathname, /^\/v1\/improvements\/(?<candidateId>[^/]+)\/(?<action>evaluate|review|promote|rollback)$/);
      if (req.method === "POST" && improvementActionRoute) {
        const input = await body(req);
        const candidateId = decodeURIComponent(improvementActionRoute.candidateId);
        const args = { ...input, candidateId };
        if (improvementActionRoute.action === "evaluate") return json(res, 200, await service.evaluateImprovement(args as Parameters<typeof service.evaluateImprovement>[0]));
        if (improvementActionRoute.action === "review") return json(res, 200, await service.reviewImprovement(args));
        if (improvementActionRoute.action === "promote") return json(res, 200, await service.promoteImprovement(args));
        return json(res, 200, await service.rollbackImprovement(args));
      }
      if (req.method === "POST" && url.pathname === "/v1/settings/api") return json(res, 200, service.updateApiConfig(await body(req)));
      if (req.method === "POST" && url.pathname === "/v1/migrations/indexeddb") {
        const result = await store.importLegacyBundle(await body(req) as unknown as LegacyMigrationBundle, (await import("../src/features/novel/db")).novelDb);
        service.announceMigration(result);
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/v1/advanced") {
        const input = await body(req);
        if (typeof input.tool !== "string" || !input.args || typeof input.args !== "object") throw new HttpError(400, "INVALID_ADVANCED_CALL", "advanced 调用缺少 tool 或 args");
        return json(res, 200, await service.executeAdvanced(input.tool as CreativeToolName, input.args as Record<string, unknown>));
      }
      if (req.method === "GET" && url.pathname === "/v1/events") {
        const after = Number(url.searchParams.get("after") ?? 0);
        const projectId = url.searchParams.get("projectId") ?? undefined;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        for (const event of store.listEvents(after, projectId)) res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
        const unsubscribe = service.subscribe((event) => {
          if (!projectId || !event.projectId || event.projectId === projectId) res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
        req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
        return;
      }
      throw new HttpError(404, "NOT_FOUND", "运行时接口不存在");
    } catch (error) {
      const known = error instanceof HttpError;
      const conflict = error instanceof RuntimeRecordConflictError || (error instanceof Error && error.name === "SnapshotConflictError");
      const status = known ? error.status : conflict ? 409 : 500;
      const response: RuntimeApiError = { error: { code: known ? error.code : conflict ? "SNAPSHOT_CONFLICT" : "RUNTIME_ERROR", message: error instanceof Error ? error.message : String(error), retryable: known ? error.retryable : false, details: known ? error.details : undefined } };
      json(res, status, response);
    }
  });
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.YMCP_NOVEL_RUNTIME_PORT ?? DEFAULT_PORT);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    service.prepareForShutdown();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    store.close();
  };
  closeRuntime = close;
  return { server, service, store, address: { host, port: actualPort }, close };
}

async function main() {
  applyRuntimeEnvDefaults();
  const runtime = await createNovelRuntime({ exitOnAdminRestart: true });
  console.error(`[ymcp-novel-runtime] listening on http://${runtime.address.host}:${runtime.address.port}`);
  const shutdown = async () => { await runtime.close(); process.exit(0); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error("[ymcp-novel-runtime]", error); process.exit(1); });
