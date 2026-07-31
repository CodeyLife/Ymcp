import { TOOL_DEFINITIONS, type ToolName } from "./tool-definitions";

export interface ToolInfo {
  short: string;
  full: string;
}

export interface ToolGroup {
  key: string;
  title: string;
  tools: ToolName[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  { key: "run-action", title: "Run / Action 主体", tools: ["novel_run_create", "novel_run_get", "novel_action_list", "novel_action_execute", "novel_artifact_get", "novel_review_submit", "novel_run_complete"] },
  { key: "catalog", title: "Catalog / Receipt", tools: ["novel_catalog_get", "novel_receipt_get", "novel_rule_target_get"] },
  { key: "craft-rule", title: "Craft Rule 候选演进", tools: ["novel_rule_candidate_create", "novel_rule_candidate_get", "novel_rule_evidence_submit", "novel_rule_foundation_evaluate", "novel_rule_review_submit", "novel_rule_promote", "novel_rule_rollback"] },
  { key: "project", title: "项目生命周期", tools: ["novel_project_create", "novel_project_list", "novel_project_delete"] },
  { key: "bootstrap", title: "规划与创作", tools: ["novel_bootstrap_run", "novel_story_arc_start", "novel_story_arc_get", "novel_chapter_review", "novel_chapter_generate"] },
  { key: "closed-loop", title: "评估闭环", tools: ["novel_closed_loop_run"] },
  { key: "workflow", title: "Workflow 查询", tools: ["novel_workflow_get", "novel_workflow_list"] },
];

const SHORT_LABELS: Partial<Record<ToolName, string>> = {
  novel_run_create: "创建 CreativeRun",
  novel_run_get: "获取 Run 快照",
  novel_action_list: "列出可执行 action",
  novel_action_execute: "执行 action",
  novel_artifact_get: "获取产物",
  novel_review_submit: "提交审核",
  novel_run_complete: "完成 Run",
  novel_catalog_get: "获取项目目录",
  novel_receipt_get: "获取晋升收据",
  novel_rule_target_get: "获取规则目标",
  novel_rule_candidate_create: "创建规则候选",
  novel_rule_candidate_get: "获取规则候选",
  novel_rule_evidence_submit: "提交规则证据",
  novel_rule_foundation_evaluate: "基础阶段评估",
  novel_rule_review_submit: "提交规则审核",
  novel_rule_promote: "晋升规则候选",
  novel_rule_rollback: "回滚规则晋升",
  novel_project_create: "创建项目",
  novel_project_list: "列出项目",
  novel_project_delete: "删除项目",
  novel_bootstrap_run: "启动基础+规划",
  novel_chapter_review: "章节审校工作流",
  novel_chapter_generate: "生成章节",
  novel_story_arc_start: "规划下一故事弧",
  novel_story_arc_get: "查询故事弧",
  novel_closed_loop_run: "执行评估闭环",
  novel_workflow_get: "查询 Workflow 状态",
  novel_workflow_list: "列出 Workflow Runs",
};

export const TOOL_DESCRIPTIONS: Record<string, ToolInfo> = Object.fromEntries(
  TOOL_DEFINITIONS.map((definition) => [
    definition.name,
    {
      short: SHORT_LABELS[definition.name as ToolName] ?? definition.name,
      full: definition.description,
    },
  ]),
) as Record<string, ToolInfo>;

export const DIRECT_EXEC_TOOLS = new Set<string>([
  "novel_project_create",
  "novel_project_list",
  "novel_run_create",
  "novel_chapter_review",
  "novel_chapter_generate",
  "novel_story_arc_start",
  "novel_story_arc_get",
  "novel_closed_loop_run",
]);

export const TOOL_COUNT = TOOL_DEFINITIONS.length;
export const TOOL_GROUP_COUNT = TOOL_GROUPS.length;

function defaultSchemaValue(schema: Record<string, unknown>): unknown {
  if ("default" in schema) return schema.default;
  const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
  if (enumValues.length > 0) return enumValues[0];
  if (schema.type === "array") return [];
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "object") {
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties as Record<string, Record<string, unknown>>
      : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [];
    return Object.fromEntries(required.map((key) => [key, defaultSchemaValue(properties[key] ?? {})]));
  }
  return "";
}

export function buildToolArgumentSkeleton(toolName: string): Record<string, unknown> {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === toolName);
  if (!definition) return {};
  const skeleton = defaultSchemaValue(definition.inputSchema);
  return skeleton && typeof skeleton === "object" && !Array.isArray(skeleton)
    ? skeleton as Record<string, unknown>
    : {};
}
