import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSocket } from "ws";
import { CreativeBridgeBroker } from "./novel-mcp-bridge.mjs";
import { createCreativeMcpServer } from "./novel-mcp-server.mjs";

function connectProject(address, { token = "secret", projectId = "project-1" } = {}) {
  const socket = new WebSocket(`ws://${address.host}:${address.port}`, { headers: { Origin: "http://127.0.0.1:5174" } });
  socket.once("open", () => socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, projectId, projectTitle: "测试项目", sessionId: "session-1", token })));
  return socket;
}

async function nextJson(socket) {
  const [raw] = await once(socket, "message");
  return JSON.parse(raw.toString("utf8"));
}

test("exposes MCP tools and forwards a call to the matching live project", async (context) => {
  const broker = new CreativeBridgeBroker({ port: 0, token: "secret", requestTimeoutMs: 2_000 });
  const address = await broker.start();
  const socket = connectProject(address);
  context.after(async () => { socket.close(); await broker.close(); });
  assert.deepEqual(await nextJson(socket), { type: "hello.ack", protocolVersion: 1, projectId: "project-1" });

  socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString("utf8"));
    if (request.type !== "request") return;
    socket.send(JSON.stringify({
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: { ok: true, tool: request.tool, result: { run: { id: "run-1", projectId: request.projectId } } },
    }));
  });

  const server = createCreativeMcpServer(broker);
  const client = new Client({ name: "novel-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => { await client.close(); await server.close(); });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = await client.listTools();
  assert.equal(listed.tools.length, 18);
  assert.ok(listed.tools.some((tool) => tool.name === "novel_review_submit"));
  assert.ok(listed.tools.some((tool) => tool.name === "novel_rule_promote"));
  assert.ok(listed.tools.some((tool) => tool.name === "novel_rule_target_get"));
  assert.ok(listed.tools.some((tool) => tool.name === "novel_rule_foundation_evaluate"));
  assert.ok(listed.tools.some((tool) => tool.name === "novel_receipt_get"));
  const status = await client.callTool({ name: "novel_bridge_status", arguments: {} });
  assert.match(status.content[0].text, /project-1/);
  const created = await client.callTool({ name: "novel_run_create", arguments: { projectId: "project-1", objective: "推进剧情", idempotencyKey: "create-run-1" } });
  assert.equal(created.isError, undefined);
  assert.match(created.content[0].text, /run-1/);
});

test("rejects a browser project that presents the wrong shared token", async (context) => {
  const broker = new CreativeBridgeBroker({ port: 0, token: "correct-token" });
  const address = await broker.start();
  const socket = connectProject(address, { token: "wrong-token" });
  context.after(async () => { socket.close(); await broker.close(); });
  const [code] = await once(socket, "close");
  assert.equal(code, 4004);
  assert.deepEqual(broker.listProjects(), []);
});

test("does not route a tool call to a different open project", async (context) => {
  const broker = new CreativeBridgeBroker({ port: 0, token: "secret", requestTimeoutMs: 200 });
  const address = await broker.start();
  const socket = connectProject(address, { projectId: "project-a" });
  context.after(async () => { socket.close(); await broker.close(); });
  await nextJson(socket);
  await assert.rejects(() => broker.request("project-b", "novel_run_get", { projectId: "project-b", runId: "run-1" }), /没有打开并连接/);
});
