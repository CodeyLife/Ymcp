import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNovelRuntime } from "./novel-runtime.ts";
import { createCreativeMcpServer } from "./novel-mcp-server.mjs";

async function harness(context, { profile, sessionId = crypto.randomUUID() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ymcp-novel-runtime-test-"));
  const runtime = await createNovelRuntime({ databasePath: join(directory, "runtime.sqlite"), port: 0 });
  process.env.YMCP_NOVEL_RUNTIME_URL = `http://${runtime.address.host}:${runtime.address.port}`;
  process.env.YMCP_NOVEL_RUNTIME_NO_SPAWN = "true";
  const server = createCreativeMcpServer({ profile, sessionId });
  const client = new Client({ name: `novel-mcp-test-${sessionId}`, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  context.after(async () => {
    await client.close();
    await server.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
    delete process.env.YMCP_NOVEL_RUNTIME_URL;
    delete process.env.YMCP_NOVEL_RUNTIME_NO_SPAWN;
  });
  return { client, runtime };
}

function text(result) {
  return JSON.parse(result.content[0].text);
}

test("default MCP exposes only intent-level tools and works without a browser", async (context) => {
  const { client, runtime } = await harness(context);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    "novel_change_get", "novel_change_review",
    "novel_improvement_evaluate", "novel_improvement_get", "novel_improvement_promote", "novel_improvement_propose", "novel_improvement_review", "novel_improvement_rollback",
    "novel_operation_get", "novel_operation_retry", "novel_plan", "novel_project_create", "novel_project_list", "novel_project_select", "novel_revise", "novel_status", "novel_write",
  ]);
  const created = text(await client.callTool({ name: "novel_project_create", arguments: { title: "无浏览器项目", premise: "MCP 直接使用本地运行时", genre: ["现实"] } }));
  assert.equal(created.project.title, "无浏览器项目");
  const runtimeBase = `http://${runtime.address.host}:${runtime.address.port}`;
  const snapshot = await fetch(`${runtimeBase}/v1/projects/${created.project.id}/records`).then((response) => response.json());
  const projectRecord = snapshot.records.projects[0];
  const commandBody = { actor: { type: "user", id: "ui-test" }, mutations: [{ type: "put", collection: "projects", id: projectRecord.id, expectedRevision: projectRecord.revision, value: { ...projectRecord, title: "统一命令项目" } }] };
  const firstMutation = await fetch(`${runtimeBase}/v1/projects/${created.project.id}/mutations`, { method: "POST", headers: { "content-type": "application/json", "x-ymcp-request-key": "ui-command-1" }, body: JSON.stringify(commandBody) });
  assert.equal(firstMutation.status, 200);
  assert.equal((await firstMutation.json()).records.projects[0].title, "统一命令项目");
  const repeatedMutation = await fetch(`${runtimeBase}/v1/projects/${created.project.id}/mutations`, { method: "POST", headers: { "content-type": "application/json", "x-ymcp-request-key": "ui-command-1" }, body: JSON.stringify(commandBody) });
  assert.equal(repeatedMutation.status, 200);
  const staleMutation = await fetch(`${runtimeBase}/v1/projects/${created.project.id}/mutations`, { method: "POST", headers: { "content-type": "application/json", "x-ymcp-request-key": "ui-command-stale" }, body: JSON.stringify(commandBody) });
  assert.equal(staleMutation.status, 409);
  const status = text(await client.callTool({ name: "novel_status", arguments: {} }));
  assert.equal(status.project.id, created.project.id);
  const missingChange = text(await client.callTool({ name: "novel_change_get", arguments: { changeId: "missing-change" } }));
  assert.equal(missingChange.tool, "novel_change_get");
  assert.match(missingChange.error, /候选变更不存在/);
  const proposed = text(await client.callTool({ name: "novel_improvement_propose", arguments: {
    targetKind: "skill", targetId: "story-facts-invariant",
    afterText: "所有创作阶段都必须先区分已确认事实、角色认知、合理推测与尚待审核的创作建议。发生冲突时停止相关提交，并返回冲突来源、影响范围和可执行的处理选项；该规则适用于所有题材，不依据具体书名、人物名、章节序号或固定措辞判断。",
    rationale: "让事实冲突处理成为共享工作流契约",
    observedSymptom: "候选可能把建议当成已确认事实", failingLayer: "共享事实门禁", underlyingMechanism: "产物状态缺少统一分类和阻断契约", affectedInputClass: "所有引用既有项目事实的生成任务",
    intendedBenefits: ["阻止未经审核的建议进入正式事实"], boundaries: ["不替代作者的审美判断"], nonGoals: ["不针对单一章节修辞"], regressionRisks: ["过度阻断合理推断"],
  } }));
  assert.equal(proposed.result.candidate.status, "proposed");
  const inspected = text(await client.callTool({ name: "novel_improvement_get", arguments: { candidateId: proposed.result.candidate.id } }));
  assert.equal(inspected.candidate.scope.failingLayer, "共享事实门禁");
  assert.ok(inspected.gate.reasons.some((reason) => /真实基线/.test(reason)));

  const operation = text(await client.callTool({ name: "novel_plan", arguments: { instruction: "建立完整故事规划" } }));
  assert.equal(operation.operation.projectId, created.project.id);
  assert.equal(operation.operation.driver, "external-mcp");
  assert.equal(operation.operation.reviewPolicy.mode, "external-review");
  assert.equal(operation.operation.improvementPolicy.mode, "agent-proposable");
  assert.ok(["queued", "running", "failed"].includes(operation.operation.status));
});

test("project selection is isolated between MCP sessions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ymcp-novel-session-test-"));
  const runtime = await createNovelRuntime({ databasePath: join(directory, "runtime.sqlite"), port: 0 });
  process.env.YMCP_NOVEL_RUNTIME_URL = `http://${runtime.address.host}:${runtime.address.port}`;
  process.env.YMCP_NOVEL_RUNTIME_NO_SPAWN = "true";
  context.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); delete process.env.YMCP_NOVEL_RUNTIME_URL; delete process.env.YMCP_NOVEL_RUNTIME_NO_SPAWN; });
  const connect = async (sessionId) => {
    const server = createCreativeMcpServer({ sessionId });
    const client = new Client({ name: sessionId, version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(right), client.connect(left)]);
    context.after(async () => { await client.close(); await server.close(); });
    return client;
  };
  const first = await connect("first");
  const second = await connect("second");
  const a = text(await first.callTool({ name: "novel_project_create", arguments: { title: "项目甲", premise: "甲的故事", genre: ["悬疑"] } })).project;
  const b = text(await second.callTool({ name: "novel_project_create", arguments: { title: "项目乙", premise: "乙的故事", genre: ["科幻"] } })).project;
  assert.equal(text(await first.callTool({ name: "novel_status", arguments: {} })).project.id, a.id);
  assert.equal(text(await second.callTool({ name: "novel_status", arguments: {} })).project.id, b.id);
  await second.callTool({ name: "novel_project_select", arguments: { project: "项目甲" } });
  assert.equal(text(await second.callTool({ name: "novel_status", arguments: {} })).project.id, a.id);
  assert.equal(text(await first.callTool({ name: "novel_status", arguments: {} })).project.id, a.id);
});

test("advanced tools are opt-in and still use the local runtime", async (context) => {
  const { client } = await harness(context, { profile: "advanced" });
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "novel_run_create"));
  assert.ok(tools.tools.some((tool) => tool.name === "novel_rule_promote"));
  assert.ok(tools.tools.some((tool) => tool.name === "novel_plan"));
});
