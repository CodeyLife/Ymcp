/**
 * V2 MCP 工具参数校验器。
 *
 * 设计依据：AGENTS.md 架构阶段 + 复用 model-gateway.ts 的 ajv 实例模式。
 *
 * 职责：
 * - validateToolArgs：用 ajv 校验 args 是否符合 toolName 的 inputSchema
 * - createValidator：创建独立的 ajv 实例（隔离 schema 编译状态）
 *
 * ajv 配置与 model-gateway.ts 保持一致：{ allErrors: true, strict: false }。
 * - allErrors: true：收集所有校验错误，而非首个即返回
 * - strict: false：允许非标准 JSON Schema 关键字（如 enum 在 draft-07 中合法但 strict 模式可能警告）
 */
import Ajv, { type ValidateFunction } from "ajv";
import { TOOL_DEFINITIONS } from "./tool-definitions";

// ===== 模块级共享校验器（预编译所有工具 schema）=====

const sharedAjv = new Ajv({ allErrors: true, strict: false });
const sharedValidators = new Map<string, ValidateFunction>();
for (const def of TOOL_DEFINITIONS) {
  sharedValidators.set(def.name, sharedAjv.compile(def.inputSchema));
}

/**
 * 校验工具参数。
 *
 * @param toolName 工具名
 * @param args 参数对象
 * @returns valid=true 表示校验通过；valid=false 时 errors 包含错误描述数组
 */
export function validateToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): { valid: boolean; errors?: string[] } {
  const validate = sharedValidators.get(toolName);
  if (!validate) {
    return { valid: false, errors: [`未知工具：${toolName}`] };
  }
  const valid = validate(args);
  if (valid) return { valid: true };
  const errors = (validate.errors ?? []).map(
    (e) => `${e.instancePath || "root"} ${e.message ?? ""}`.trim(),
  );
  return { valid: false, errors };
}

/**
 * 创建独立的校验器实例。
 *
 * 与模块级 validateToolArgs 的区别：拥有独立的 ajv 实例与编译缓存，
 * 适用于需要隔离 schema 状态或在测试中重置编译缓存的场景。
 */
export function createValidator(): {
  validate: (
    toolName: string,
    args: Record<string, unknown>,
  ) => { valid: boolean; errors?: string[] };
} {
  const ajvInstance = new Ajv({ allErrors: true, strict: false });
  const localValidators = new Map<string, ValidateFunction>();
  for (const def of TOOL_DEFINITIONS) {
    localValidators.set(def.name, ajvInstance.compile(def.inputSchema));
  }
  return {
    validate: (
      toolName: string,
      args: Record<string, unknown>,
    ): { valid: boolean; errors?: string[] } => {
      const validate = localValidators.get(toolName);
      if (!validate) {
        return { valid: false, errors: [`未知工具：${toolName}`] };
      }
      const valid = validate(args);
      if (valid) return { valid: true };
      const errors = (validate.errors ?? []).map(
        (e) => `${e.instancePath || "root"} ${e.message ?? ""}`.trim(),
      );
      return { valid: false, errors };
    },
  };
}
