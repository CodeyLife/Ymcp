import { createServer } from "node:http";
import { Client, Connection } from "@temporalio/client";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";
import type { NovelIntent } from "../src/novel-v2/protocol";
import { CommitService } from "../src/novel-v2/commit-service";

const repository = new NovelPostgresRepository();
await repository.migrate();
const commitService = new CommitService(repository);
const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" });
const temporal = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
const port = Number(process.env.NOVEL_V2_API_PORT ?? 4770);

async function readJson(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function send(response: import("node:http").ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" });
  response.end(status === 204 ? undefined : JSON.stringify(value));
}

function asString(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function asNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") return send(response, 204, {});
    if (request.method === "GET" && request.url === "/health") {
      await repository.health();
      return send(response, 200, { service: "ymcp-novel-v2", temporal: true, postgres: true });
    }
    if (request.method === "POST" && request.url === "/v2/intents") {
      const input = await readJson(request);
      if (typeof input.projectId !== "string" || typeof input.objective !== "string" || typeof input.idempotencyKey !== "string") return send(response, 400, { error: "projectId、objective、idempotencyKey 必填" });
      const intent: NovelIntent = { id: crypto.randomUUID(), projectId: input.projectId, source: input.source === "mcp" ? "mcp" : input.source === "cli" ? "cli" : input.source === "web" ? "web" : "api", objective: input.objective.trim(), target: input.target as NovelIntent["target"], requestedStage: input.requestedStage as NovelIntent["requestedStage"], constraints: Array.isArray(input.constraints) ? input.constraints.filter((value): value is string => typeof value === "string") : undefined, requestedCapabilities: Array.isArray(input.requestedCapabilities) ? input.requestedCapabilities.filter((value): value is string => typeof value === "string") : undefined, createdAt: Date.now(), idempotencyKey: input.idempotencyKey };
      await repository.ensureProject(intent.projectId, typeof input.projectTitle === "string" ? input.projectTitle : intent.projectId);
      const stored = await repository.putIntent(intent);
      const workflowId = `novel-intent-${stored.id}`;
      await repository.putWorkflowRun({ id: stored.id, workflowType: "novel-intent", projectId: stored.projectId, temporalWorkflowId: workflowId, status: "accepted", payload: { intent: stored } });
      const handle = await temporal.workflow.start("novelIntentWorkflow", { args: [stored, workflowId], taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "novel-v2", workflowId });
      return send(response, 202, { intent: stored, workflowId, runId: handle.firstExecutionRunId });
    }
    if (request.method === "GET" && request.url === "/v2/projects") return send(response, 200, { projects: await repository.listProjects() });
    if (request.method === "POST" && request.url === "/v2/projects") {
      const input = await readJson(request);
      if (typeof input.projectId !== "string") return send(response, 400, { error: "projectId 必填" });
      await repository.ensureProject(input.projectId, typeof input.title === "string" ? input.title : input.projectId);
      return send(response, 201, { project: await repository.getProjectDetail(input.projectId) });
    }
    const projectMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)$/);
    if (request.method === "GET" && projectMatch) return send(response, 200, { project: await repository.getProjectDetail(decodeURIComponent(projectMatch[1])) });
    const documentMatch = request.url?.match(/^\/v2\/projects\/([^/?]+)\/documents$/);
    if (request.method === "POST" && documentMatch) {
      const input = await readJson(request);
      const projectId = decodeURIComponent(documentMatch[1]);
      const title = asString(input.title);
      if (!title) return send(response, 400, { error: "title 必填" });
      const document = await repository.ensureDocument({ projectId, documentId: asString(input.documentId), title, narrativeOrder: asNumber(input.narrativeOrder), povCharacterId: asString(input.povCharacterId), status: asString(input.status) });
      return send(response, 201, { document });
    }
    const recordMatch = request.url?.match(/^\/v2\/(preflight-plans|memory-bundles|skills|blueprints|artifacts)\/([^/]+)$/);
    if (request.method === "GET" && recordMatch) {
      const table = ({ "preflight-plans": "preflight_plans", "memory-bundles": "memory_bundles", skills: "skill_bundles", blueprints: "execution_blueprints", artifacts: "artifacts" } as const)[recordMatch[1] as "preflight-plans" | "memory-bundles" | "skills" | "blueprints" | "artifacts"];
      return send(response, 200, { record: await repository.getRecord(table, decodeURIComponent(recordMatch[2])) });
    }
    const eventsMatch = request.url?.match(/^\/v2\/runs\/([^/?]+)\/events(?:\?after=(\d+))?$/);
    if (request.method === "GET" && eventsMatch) {
      const workflowId = decodeURIComponent(eventsMatch[1]);
      const run = await repository.getWorkflowRunByTemporalId(workflowId);
      const events = await repository.listOutbox(run?.projectId, Number(eventsMatch[2] ?? 0));
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
    const signalMatch = request.url?.match(/^\/v2\/tasks\/([^/]+)\/signal$/);
    if (request.method === "POST" && signalMatch) { const input = await readJson(request); const handle = temporal.workflow.getHandle(decodeURIComponent(signalMatch[1])); await handle.signal(String(input.signal ?? "humanSignal"), input.payload); return send(response, 202, { accepted: true }); }
    if (request.method === "GET" && request.url === "/v2/usage") return send(response, 200, { usage: [] });
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
