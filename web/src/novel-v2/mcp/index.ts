/**
 * V2 MCP 工具网关统一入口。
 *
 * 设计依据：AGENTS.md 架构阶段 + Phase B-2 MCP 工具网关。
 *
 * 职责：
 * - executeTool：工具调用统一入口（校验 → 路由 → 响应包装）
 * - 导出 TOOL_DEFINITIONS/TOOL_NAMES/validateToolArgs 供外部使用
 * - 导出类型定义供 handler 与 server 使用
 *
 * MCP 协议响应格式（McpToolResponse）：
 * - content: [{ type: "text", text: JSON.stringify(result) }]
 * - isError: true 表示工具执行失败（参数校验失败/handler 抛错/未知工具）
 *
 * 与 v1 的区别：v1 用 IndexedDB + CreativeToolEnvelope，v2 全部基于
 * NovelPostgresRepository + creative/evaluation 模块，遵循 MCP 协议。
 */
import { TOOL_NAMES } from "./tool-definitions";
import type { ToolName } from "./tool-definitions";
import { validateToolArgs } from "./validator";
import { TOOL_HANDLERS } from "./handlers";
import type { McpToolResponse, ToolContext } from "./types";

// ===== 启动期契约校验：TOOL_NAMES 与 TOOL_HANDLERS 必须一一对应 =====
// 模块加载时立即校验，MCP server 启动时若 handler 缺失或多余会立即失败，
// 而非等到运行时工具调用才发现。AGENTS.md 要求"启动期契约校验"。
const _missingHandlers = TOOL_NAMES.filter((name) => !TOOL_HANDLERS[name]);
if (_missingHandlers.length > 0) {
  throw new Error(`TOOL_HANDLERS 缺失: ${_missingHandlers.join(", ")}`);
}
const _extraHandlers = Object.keys(TOOL_HANDLERS).filter(
  (name) => !TOOL_NAMES.includes(name as ToolName),
);
if (_extraHandlers.length > 0) {
  throw new Error(`TOOL_HANDLERS 多余: ${_extraHandlers.join(", ")}`);
}

/**
 * 执行 MCP 工具调用。
 *
 * 流程：
 * 1. 校验 toolName 是否在 TOOL_NAMES 中（未知工具返回 isError=true）
 * 2. 用 ajv 校验 args 是否符合工具的 inputSchema（校验失败返回 isError=true）
 * 3. 调用 TOOL_HANDLERS[toolName] 执行业务逻辑
 * 4. 成功：返回 { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
 * 5. 失败：返回 { content: [...], isError: true }，text 包含 error.message + toolName
 *
 * @param toolName 工具名（必须在 TOOL_NAMES 中）
 * @param args 参数对象（必须符合工具的 inputSchema）
 * @param ctx 执行上下文（repository 必填，model 可选）
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<McpToolResponse> {
  // 1. 校验工具存在
  if (!TOOL_NAMES.includes(toolName as (typeof TOOL_NAMES)[number])) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: `未知工具: ${toolName}`, availableTools: TOOL_NAMES }),
        },
      ],
      isError: true,
    };
  }

  // 2. 校验参数
  const validation = validateToolArgs(toolName, args);
  if (!validation.valid) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: `参数校验失败: ${validation.errors?.join("; ")}`,
            tool: toolName,
            receivedArgs: args,
          }),
        },
      ],
      isError: true,
    };
  }

  // 3. 调用 handler
  try {
    const handler = TOOL_HANDLERS[toolName];
    if (!handler) {
      // 启动期契约校验已确保 TOOL_NAMES 与 TOOL_HANDLERS 一一对应，此处仅作运行时兜底
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `工具 ${toolName} 未注册 handler`, tool: toolName }),
          },
        ],
        isError: true,
      };
    }
    const result = await handler(args, ctx);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            tool: toolName,
            errorName: error instanceof Error ? error.name : "Unknown",
          }),
        },
      ],
      isError: true,
    };
  }
}

// ===== 导出 =====

export { TOOL_DEFINITIONS, TOOL_NAMES } from "./tool-definitions";
export type { ToolName } from "./tool-definitions";
export { validateToolArgs, createValidator } from "./validator";
export { TOOL_HANDLERS } from "./handlers";
export type { ToolDefinition, ToolHandler, ToolContext, McpToolResponse } from "./types";
