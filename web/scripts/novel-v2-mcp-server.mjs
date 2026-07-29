#!/usr/bin/env node
/**
 * V2 MCP Server：stdio JSON-RPC 2.0 协议。
 *
 * 设计依据：AGENTS.md 架构阶段 + Phase C-1.1 MCP server 入口统一。
 *
 * V2 MCP 直接调用模式：MCP → executeTool → repository/Temporal。
 *
 * 本文件是 v2 mcp 模块（src/novel-v2/mcp/）的生产入口，让 executeTool 从"仅测试引用"变为"生产接入"。
 *
 * 协议规范：
 * - stdio 传输：每行一个 JSON-RPC 2.0 消息
 * - 支持 initialize / tools/list / tools/call 三个方法
 * - 不支持 resources/prompts（v2 当前未实现）
 *
 * 启动：node --import tsx scripts/novel-v2-mcp-server.mjs
 */
import { createInterface } from "node:readline";
import { Client, Connection } from "@temporalio/client";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository.ts";
import { createRuntimeModelGateway } from "../src/novel-v2/model-runtime.ts";
import { TOOL_DEFINITIONS, executeTool } from "../src/novel-v2/mcp/index.ts";

// ===== 初始化 repository + model =====
// 复用 createRuntimeModelGateway（与 novel-v2-api/worker 一致），
// 构造 RoutedModelGateway 并接好 ModelConfigStore + audit recorder。
const repository = new NovelPostgresRepository();
await repository.migrate();
const { gateway: model } = await createRuntimeModelGateway(repository);
const temporalConnection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" });
const temporal = new Client({ connection: temporalConnection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "novel-v2";
const ctx = { repository, model, temporal, taskQueue };

// ===== JSON-RPC 2.0 协议 =====

function sendResult(id, result) {
  if (id === null || id === undefined) return; // notification，不响应
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
  if (id === null || id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handleRequest(id, method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "novel-v2-mcp", version: "2.0.0" },
        capabilities: { tools: {} },
      };

    case "tools/list":
      return {
        tools: TOOL_DEFINITIONS.map((d) => ({
          name: d.name,
          description: d.description,
          inputSchema: d.inputSchema,
        })),
      };

    case "tools/call": {
      if (!params || typeof params.name !== "string") {
        throw Object.assign(new Error("params.name 必须为字符串"), { code: -32602 });
      }
      const args = (params.arguments && typeof params.arguments === "object") ? params.arguments : {};
      return await executeTool(params.name, args, ctx);
    }

    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

// ===== stdio 读取循环 =====

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let id = null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    sendError(null, -32700, `Parse error: ${error.message}`);
    return;
  }

  id = parsed.id ?? null;
  try {
    const result = await handleRequest(id, parsed.method, parsed.params);
    sendResult(id, result);
  } catch (error) {
    const code = error.code ?? -32603;
    sendError(id, code, error.message ?? String(error));
  }
});

// ===== 信号处理 =====

async function shutdown() {
  try {
    await repository.close();
    await temporalConnection.close();
  } catch (error) {
    // TODO P2: shutdown 错误处理策略（目前只记录不阻塞）
    console.error(`[novel-v2-mcp] shutdown error: ${error.message}`);
  }
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.error(`[novel-v2-mcp] ready, ${TOOL_DEFINITIONS.length} tools loaded`);
