/**
 * V2 MCP 工具网关共享类型。
 *
 * 设计依据：AGENTS.md 架构阶段 + Phase B-2 MCP 工具网关。
 *
 * 类型契约：
 * - ToolContext：工具执行上下文（repository + 可选 model）
 * - ToolDefinition：工具定义（name + description + inputSchema）
 * - ToolHandler：工具处理函数签名
 * - McpToolResponse：MCP 协议响应格式
 *
 * 与 v1 的区别：v1 用 IndexedDB + CreativeToolEnvelope，v2 全部基于
 * NovelPostgresRepository + creative/evaluation 模块，响应遵循 MCP 协议格式。
 */
import type { ModelGateway } from "../model-gateway";
import type { NovelPostgresRepository } from "../postgres-repository";
import type { Client } from "@temporalio/client";

/**
 * 工具执行上下文。
 *
 * repository 是必选的 Postgres 仓库实例；
 * model 是可选的 LLM 网关，仅在需要 LLM 调用的工具（如 closed-loop）中必填。
 */
export interface ToolContext {
  repository: NovelPostgresRepository;
  model?: ModelGateway;
  temporal?: Client;
  taskQueue?: string;
}

/**
 * 工具定义。
 *
 * inputSchema 是 JSON Schema draft-07 对象，用于 ajv 参数校验。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * 工具处理函数签名。
 *
 * args 是经 ajv 校验后的参数（但类型仍为 Record<string, unknown>，
 * handler 内部需自行提取具体字段）。
 */
export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<unknown>;

/**
 * MCP 协议响应格式。
 *
 * content 是文本块数组；isError=true 表示工具执行失败。
 */
export interface McpToolResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
