#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const base = process.env.NOVEL_V2_API_URL ?? "http://127.0.0.1:4770";
async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `V2 API ${response.status}`);
  return body;
}
function result(value, isError = false) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) }; }

export function createCreativeMcpServer() {
  const server = new McpServer({ name: "ymcp-novel-v2", version: "2.0.0" });
  const register = (name, config, handler) => server.registerTool(name, config, async (args) => { try { return result(await handler(args)); } catch (error) { return result({ error: error instanceof Error ? error.message : String(error), tool: name }, true); } });
  register("novel_intent_submit", { description: "提交创作意图，先执行 Preflight、记忆检索和 Skill 冻结。", inputSchema: { projectId: z.string().min(1), objective: z.string().min(1), idempotencyKey: z.string().min(1), projectTitle: z.string().optional(), target: z.record(z.string(), z.unknown()).optional(), requestedStage: z.string().optional(), requestedCapabilities: z.array(z.string()).optional() } }, (args) => request("/v2/intents", { method: "POST", body: JSON.stringify({ ...args, source: "mcp" }) }));
  register("novel_run_get", { description: "读取 V2 Temporal Workflow 状态。", inputSchema: { runId: z.string().min(1) } }, (args) => request(`/v2/runs/${encodeURIComponent(args.runId)}`));
  register("novel_run_events_get", { description: "读取运行事件流。", inputSchema: { runId: z.string().min(1), after: z.number().int().nonnegative().optional() } }, (args) => request(`/v2/runs/${encodeURIComponent(args.runId)}/events?after=${args.after ?? 0}`));
  register("novel_task_signal", { description: "向等待人工信号的任务发送信号。", inputSchema: { taskId: z.string().min(1), signal: z.string().min(1), payload: z.record(z.string(), z.unknown()).optional() } }, (args) => request(`/v2/tasks/${encodeURIComponent(args.taskId)}/signal`, { method: "POST", body: JSON.stringify(args) }));
  for (const [name, route] of [["novel_preflight_get", "preflight-plans"], ["novel_memory_bundle_get", "memory-bundles"], ["novel_skill_bundle_get", "skills"], ["novel_context_get", "memory-bundles"], ["novel_artifact_get", "artifacts"]]) register(name, { description: `读取 V2 ${name} 快照或产物。`, inputSchema: { id: z.string().min(1) } }, (args) => request(`/v2/${route}/${encodeURIComponent(args.id)}`));
  register("novel_work_claim", { description: "领取持久化任务；具体租约由 Temporal Worker 管理。", inputSchema: { taskId: z.string().min(1), attemptId: z.string().default(() => randomUUID()) } }, (args) => request(`/v2/tasks/${encodeURIComponent(args.taskId)}/signal`, { method: "POST", body: JSON.stringify({ signal: "claim", payload: args }) }));
  register("novel_work_heartbeat", { description: "报告外部 Agent 任务心跳。", inputSchema: { taskId: z.string().min(1), attemptId: z.string().min(1) } }, (args) => request(`/v2/tasks/${encodeURIComponent(args.taskId)}/signal`, { method: "POST", body: JSON.stringify({ signal: "heartbeat", payload: args }) }));
  register("novel_artifact_submit", { description: "提交外部 Agent 产物，必须绑定 baseRevision 和 fingerprint。", inputSchema: { taskId: z.string().min(1), artifact: z.record(z.string(), z.unknown()) } }, (args) => request(`/v2/tasks/${encodeURIComponent(args.taskId)}/signal`, { method: "POST", body: JSON.stringify({ signal: "artifact", payload: args }) }));
  register("novel_review_submit", { description: "提交独立或人工审核证据。", inputSchema: { taskId: z.string().min(1), review: z.record(z.string(), z.unknown()) } }, (args) => request(`/v2/tasks/${encodeURIComponent(args.taskId)}/signal`, { method: "POST", body: JSON.stringify({ signal: "review", payload: args }) }));
  register("novel_work_fail", { description: "报告任务失败并触发 Temporal 恢复策略。", inputSchema: { taskId: z.string().min(1), reason: z.string().min(1) } }, (args) => request(`/v2/tasks/${encodeURIComponent(args.taskId)}/signal`, { method: "POST", body: JSON.stringify({ signal: "fail", payload: args }) }));
  return server;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) { const server = createCreativeMcpServer(); await server.connect(new StdioServerTransport()); }
