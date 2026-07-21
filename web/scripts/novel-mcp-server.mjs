#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CreativeBridgeBroker } from "./novel-mcp-bridge.mjs";

const workSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("generation"), taskKey: z.string().min(1), instruction: z.string().min(1), targetId: z.string().optional(), dependsOn: z.array(z.string()).optional(), parameters: z.record(z.string(), z.unknown()).optional() }),
  z.object({ kind: z.literal("plot-segment"), targetId: z.string().min(1), instruction: z.string().min(1), dependsOn: z.array(z.string()).optional(), parameters: z.record(z.string(), z.unknown()).optional() }),
  z.object({ kind: z.literal("chapter-workflow"), targetId: z.string().min(1), instruction: z.string().min(1), dependsOn: z.array(z.string()).optional(), parameters: z.record(z.string(), z.unknown()).optional() }),
]);
const scopeSchema = z.object({
  observedSymptom: z.string().min(1),
  failingLayer: z.string().min(1),
  underlyingMechanism: z.string().min(1),
  affectedInputClass: z.string().min(1),
  intendedBenefits: z.array(z.string().min(1)).min(1),
  boundaries: z.array(z.string().min(1)).min(1),
  nonGoals: z.array(z.string().min(1)).min(1),
  regressionRisks: z.array(z.string().min(1)).min(1),
});

const TOOL_DEFINITIONS = [
  ["novel_run_create", "创建一个由外部 LLM 控制的创作运行。", { projectId: z.string().min(1), objective: z.string().min(1), idempotencyKey: z.string().min(1), policy: z.object({ qualityThreshold: z.number().min(0).max(5).optional(), maxIterations: z.number().int().min(0).max(20).optional() }).strict().optional(), baseSnapshotHash: z.string().optional() }],
  ["novel_run_get", "读取创作运行、工作项、审核门禁和增量事件。", { projectId: z.string().min(1), runId: z.string().min(1), afterSequence: z.number().int().nonnegative().optional() }],
  ["novel_action_list", "列出当前运行允许执行的下一步动作。", { projectId: z.string().min(1), runId: z.string().min(1) }],
  ["novel_action_execute", "添加或执行创作动作，包括生成、修订、采纳、暂停和恢复。", {
    projectId: z.string().min(1), runId: z.string().min(1), action: z.enum(["work.enqueue", "work.start", "work.revise", "work.recover", "work.accept", "review.request", "run.pause", "run.resume", "run.cancel"]),
    workItemId: z.string().optional(), idempotencyKey: z.string().min(1), instruction: z.string().optional(), force: z.boolean().optional(), work: workSchema.optional(),
  }],
  ["novel_artifact_get", "读取某一步产生的 Proposal、工作流产物、章节、修订或审核。", { projectId: z.string().min(1), runId: z.string().min(1), artifactId: z.string().min(1) }],
  ["novel_review_submit", "提交外部 LLM 审核；通过门禁时会自动采纳产物。", { projectId: z.string().min(1), runId: z.string().min(1), workItemId: z.string().min(1), idempotencyKey: z.string().min(1), review: z.record(z.string(), z.unknown()) }],
  ["novel_run_complete", "确认运行的全部工作项和审核问题均已完成。", { projectId: z.string().min(1), runId: z.string().min(1) }],
  ["novel_catalog_get", "读取项目结构、合法任务、章节、Skill/System Prompt 版本和规则候选目录。", { projectId: z.string().min(1) }],
  ["novel_receipt_get", "查询可变更工具的幂等收据状态与已保存结果。", { projectId: z.string().min(1), targetTool: z.string().min(1), idempotencyKey: z.string().min(1) }],
  ["novel_rule_target_get", "按目标和可选版本读取完整 Skill/System Prompt 正文。", { projectId: z.string().min(1), targetKind: z.enum(["skill", "system-prompt"]), targetId: z.string().min(1), version: z.string().optional() }],
  ["novel_rule_candidate_create", "创建不会立即生效的 Skill 或系统 Prompt 版本候选。", { projectId: z.string().min(1), idempotencyKey: z.string().min(1), targetKind: z.enum(["skill", "system-prompt"]), targetId: z.string().min(1), afterText: z.string().min(100), rationale: z.string().min(1), scope: scopeSchema }],
  ["novel_rule_candidate_get", "读取规则候选、真实对照证据和多审核门禁。", { projectId: z.string().min(1), candidateId: z.string().min(1) }],
  ["novel_rule_evidence_submit", "用两个已完成的隔离 chapter-workflow 工作项登记基线/候选对照证据。", { projectId: z.string().min(1), idempotencyKey: z.string().min(1), candidateId: z.string().min(1), scenarioClass: z.string().min(1), baselineWorkItemId: z.string().min(1), candidateWorkItemId: z.string().min(1) }],
  ["novel_rule_foundation_evaluate", "对基础设定阶段规则运行隔离 A/B 生成与盲审。", { projectId: z.string().min(1), idempotencyKey: z.string().min(1), candidateId: z.string().min(1), taskKey: z.enum(["project-positioning", "architecture", "story-bible", "characters", "relations", "worldview"]), scenarioClass: z.string().min(1), instruction: z.string().optional() }],
  ["novel_rule_review_submit", "提交剧情、人物、文笔或长篇编辑的独立规则审核。", { projectId: z.string().min(1), idempotencyKey: z.string().min(1), candidateId: z.string().min(1), role: z.enum(["plot-editor", "character-editor", "prose-editor", "long-form-editor"]), reviewerId: z.string().min(1), reviewRunId: z.string().min(1), model: z.string().min(1), verdict: z.enum(["passed", "revise", "rejected"]), summary: z.string().min(1), concerns: z.array(z.string()).optional() }],
  ["novel_rule_promote", "仅在多场景证据和四类审核全部通过后晋升规则候选。", { projectId: z.string().min(1), idempotencyKey: z.string().min(1), candidateId: z.string().min(1) }],
  ["novel_rule_rollback", "将已晋升规则切回候选修改前的不可变版本。", { projectId: z.string().min(1), idempotencyKey: z.string().min(1), candidateId: z.string().min(1) }],
];

function resultContent(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

export function registerCreativeMcpTools(server, broker) {
  server.registerTool("novel_bridge_status", { description: "列出当前已打开并连接到 MCP Server 的小说项目。", inputSchema: {} }, async () => resultContent({ projects: broker.listProjects() }));
  for (const [name, description, inputSchema] of TOOL_DEFINITIONS) {
    server.registerTool(name, { description, inputSchema }, async (args, extra) => {
      try {
        return resultContent(await broker.request(args.projectId, name, args, { signal: extra.signal }));
      } catch (error) {
        return resultContent({ error: error instanceof Error ? error.message : String(error), tool: name, projectId: args.projectId }, true);
      }
    });
  }
}

export function createCreativeMcpServer(broker) {
  const server = new McpServer({ name: "ymcp-novel-workflow", version: "0.1.0" });
  registerCreativeMcpTools(server, broker);
  return server;
}

async function main() {
  const port = Number.parseInt(process.env.YMCP_MCP_BRIDGE_PORT ?? "4765", 10);
  const timeout = Number.parseInt(process.env.YMCP_MCP_REQUEST_TIMEOUT_MS ?? "900000", 10);
  const broker = new CreativeBridgeBroker({ port, token: process.env.YMCP_MCP_TOKEN ?? "", requestTimeoutMs: timeout });
  const address = await broker.start();
  const server = createCreativeMcpServer(broker);
  const shutdown = async () => { await broker.close(); process.exit(0); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.error(`[ymcp-novel-mcp] browser bridge listening on ws://${address.host}:${address.port}`);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error("[ymcp-novel-mcp]", error); process.exit(1); });
}
