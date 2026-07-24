import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNovelRuntime } from "./novel-runtime.ts";
import { createCreativeMcpServer } from "./novel-mcp-server.mjs";
import { ensureNovelRuntime } from "./novel-runtime-client.mjs";
import { novelDb, recordBase } from "../src/features/novel/db.ts";
import { createCreativeRun, enqueueCreativeWork } from "../src/features/novel/creative-execution.ts";

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
    "novel_agent_guide_get", "novel_autopilot_get", "novel_change_get", "novel_change_patch", "novel_change_revalidate", "novel_change_review",
    "novel_improvement_evaluate", "novel_improvement_get", "novel_improvement_promote", "novel_improvement_propose", "novel_improvement_review", "novel_improvement_rollback",
    "novel_learning_target_get",
    "novel_operation_get", "novel_operation_retry", "novel_plan", "novel_project_create", "novel_project_list", "novel_project_select", "novel_revise", "novel_status", "novel_write",
  ]);
  const created = text(await client.callTool({ name: "novel_project_create", arguments: { title: "无浏览器项目", premise: "MCP 直接使用本地运行时", genre: ["现实"] } }));
  assert.equal(created.project.title, "无浏览器项目");
  const runtimeBase = `http://${runtime.address.host}:${runtime.address.port}`;
  const health = await fetch(`${runtimeBase}/v1/health`).then((response) => response.json());
  assert.equal(health.service, "ymcp-novel-runtime");
  assert.equal(typeof health.runtimeRoot, "string");
  assert.equal(health.protocolVersion, 2);
  assert.match(health.sourceVersion, /^[a-f0-9]{64}$/);
  const forbiddenRestart = await fetch(`${runtimeBase}/v1/admin/restart`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runtimeRoot: `${health.runtimeRoot}-other` }) });
  assert.equal(forbiddenRestart.status, 403);
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
  const guide = text(await client.callTool({ name: "novel_agent_guide_get", arguments: {} }));
  assert.equal(guide.project.id, created.project.id);
  assert.ok(guide.protocol.requiredOrder.includes("读取完整候选"));
  assert.ok(guide.protocol.invariants.some((rule) => /内部与外部审核/.test(rule)));
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
  assert.equal(operation.operation.reviewPolicy.maxIterations, null);
  assert.equal(operation.operation.improvementPolicy.autoPromote, true);
  assert.ok(["queued", "running", "failed"].includes(operation.operation.status));

  const gatedProject = text(await client.callTool({ name: "novel_project_create", arguments: { title: "双审核门禁项目", premise: "隔离验证内部审核拦截", genre: ["测试"] } })).project;
  const learningTarget = text(await client.callTool({ name: "novel_learning_target_get", arguments: { targetKind: "skill", targetId: "story-facts-invariant" } })).target;
  assert.match(learningTarget.targetContentFingerprint, /^[a-f0-9]{64}$/);

  const fingerprintRun = await createCreativeRun({ projectId: gatedProject.id, mode: "external", objective: "验证候选指纹" }, novelDb);
  const fingerprintWork = await enqueueCreativeWork(fingerprintRun.id, { kind: "generation", taskKey: "project-positioning", instruction: "生成定位候选" }, novelDb);
  const fingerprintProposal = {
    ...recordBase(gatedProject.id),
    id: "fingerprint-proposal",
    title: "定位候选",
    operation: "structured:project-positioning",
    taskKey: "project-positioning",
    status: "pending",
    previewMarkdown: "定位候选",
    patches: [],
    items: [{ id: "fingerprint-item", label: "定位", operation: "update", targetTable: "projects", targetId: gatedProject.id, payload: { audience: "长篇悬疑读者" }, rationale: "明确读者" }],
    contextPacketId: "fingerprint-context",
    model: "test-model",
  };
  await novelDb.proposals.put(fingerprintProposal);
  await novelDb.creativeWorkItems.update(fingerprintWork.id, { status: "waiting-review", artifactRefs: [fingerprintProposal.id] });
  const fingerprintOperation = {
    id: "fingerprint-operation", projectId: gatedProject.id, kind: "plan", driver: "external-mcp",
    reviewPolicy: { mode: "external-review", maxIterations: null }, improvementPolicy: { mode: "agent-proposable", requireCrossScenarioEvidence: true, autoPromote: true },
    status: "awaiting_review", input: {}, baseSnapshotHash: runtime.store.snapshotHash(gatedProject.id), attempt: 1, runId: fingerprintRun.id, currentWorkItemId: fingerprintWork.id, currentChangeId: "fingerprint-change", createdAt: 1, updatedAt: 1,
  };
  runtime.store.putOperation(fingerprintOperation);
  runtime.store.putChange({ id: "fingerprint-change", operationId: fingerprintOperation.id, projectId: gatedProject.id, workItemId: fingerprintWork.id, artifactRefs: [fingerprintProposal.id], title: "定位候选", summary: "定位候选", evidence: { complete: true, blockerCount: 0, majorCount: 0, openIssues: [], iteration: 0, maxIterations: null, internalGate: { passed: true, reason: "测试候选", checkedAt: 1 } }, status: "pending", baseSnapshotHash: fingerprintOperation.baseSnapshotHash, createdAt: 1, updatedAt: 1 });
  const fingerprintDetails = await runtime.service.getChangeDetails("fingerprint-change");
  assert.match(fingerprintDetails.itemPayloadFingerprints["fingerprint-item"], /^[a-f0-9]{64}$/);

  const blockedOperation = {
    id: "blocked-external-operation", projectId: gatedProject.id, kind: "write", driver: "external-mcp",
    reviewPolicy: { mode: "external-review", maxIterations: null }, improvementPolicy: { mode: "agent-proposable", requireCrossScenarioEvidence: true, autoPromote: true },
    status: "awaiting_review", input: {}, baseSnapshotHash: "blocked-base", attempt: 1, currentChangeId: "blocked-external-change", createdAt: 1, updatedAt: 1,
  };
  const blockedChange = {
    id: "blocked-external-change", operationId: blockedOperation.id, projectId: gatedProject.id, workItemId: "blocked-work", artifactRefs: [], title: "阻断候选", summary: "内部连续性冲突",
    evidence: { complete: true, blockerCount: 1, majorCount: 0, openIssues: ["连续性冲突"], iteration: 4, maxIterations: null, internalGate: { passed: false, reason: "项目内部质量证据仍有 blocker 或 major", checkedAt: 1 } },
    status: "pending", baseSnapshotHash: "blocked-base", createdAt: 1, updatedAt: 1,
  };
  runtime.store.putOperation(blockedOperation);
  runtime.store.putChange(blockedChange);
  const blockedDetails = await runtime.service.getChangeDetails(blockedChange.id);
  const contradictoryReview = await fetch(`${runtimeBase}/v1/changes/${blockedChange.id}/review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: gatedProject.id,
      decision: "accept",
      actor: { type: "external-llm", id: "reviewer-contradictory", model: "review-model" },
      review: {
        reviewRunId: "review-run-contradictory",
        verdict: "passed",
        summary: "结论与问题严重度矛盾",
        artifactFingerprint: blockedDetails.artifactFingerprint,
        issues: [{ id: "blocking-issue", severity: "blocker", dimension: "continuity", title: "时间线冲突", evidence: "候选违反既有顺序", suggestion: "修订时间线" }],
        learning: { conclusion: "no-shared-learning", summary: "当前仅能确认候选问题" },
      },
    }),
  });
  assert.equal(contradictoryReview.status, 400);

  const crossProjectPatch = await fetch(`${runtimeBase}/v1/changes/${blockedChange.id}/patch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: created.project.id,
      itemId: "missing-item",
      artifactFingerprint: blockedDetails.artifactFingerprint,
      expectedPayloadFingerprint: "0".repeat(64),
      payload: {},
      rationale: "验证项目边界",
      issueIds: ["scope-issue"],
      actor: { type: "external-llm", id: "reviewer-scope", model: "review-model" },
      review: {
        reviewRunId: "review-run-scope",
        verdict: "revise",
        summary: "候选需要局部修改",
        artifactFingerprint: blockedDetails.artifactFingerprint,
        issues: [{ id: "scope-issue", severity: "major", dimension: "continuity", title: "项目不匹配", evidence: "候选不属于所选项目", suggestion: "选择正确项目" }],
        learning: { conclusion: "no-shared-learning", summary: "这是调用作用域错误" },
      },
    }),
  });
  assert.equal(crossProjectPatch.status, 409);

  const crossProjectRevalidate = await fetch(`${runtimeBase}/v1/changes/${blockedChange.id}/revalidate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: created.project.id,
      artifactFingerprint: blockedDetails.artifactFingerprint,
      actor: { type: "external-llm", id: "reviewer-revalidate-scope", model: "review-model" },
    }),
  });
  assert.equal(crossProjectRevalidate.status, 409);

  const learningReview = {
      reviewRunId: "review-run-blocked", verdict: "passed", summary: "外部审核未发现问题", issues: [], artifactFingerprint: blockedDetails.artifactFingerprint,
      learning: {
        conclusion: "propose-improvement", summary: "事实状态分类缺少共享门禁", affectedInputClass: "所有引用既有项目事实的生成任务", underlyingMechanism: "生成规则没有统一区分已确认事实、角色认知与待审核建议",
        proposal: { targetKind: "skill", targetId: "story-facts-invariant", targetVersion: learningTarget.targetVersion, targetContentFingerprint: learningTarget.targetContentFingerprint, afterText: "所有创作阶段必须先区分已确认事实、角色认知、合理推测与尚待审核的创作建议。发生冲突时停止相关提交，并返回冲突来源、影响范围和可执行处理选项。该规则适用于所有引用项目事实的生成任务，不依据具体书名、人物名、章节序号或固定措辞判断；仅在证据状态冲突时阻断，不替代作者的审美选择。", rationale: "把事实分类缺失修复到共享门禁", observedSymptom: "候选可能把建议当成已确认事实", failingLayer: "共享事实门禁", intendedBenefits: ["阻止建议污染正式事实"], boundaries: ["只处理事实状态冲突"], nonGoals: ["不替代审美审核"], regressionRisks: ["过度阻断合理推断"] },
      },
    };
  const beforeLearningCandidates = await novelDb.craftRuleCandidates.where("projectId").equals(gatedProject.id).count();
  await assert.rejects(
    runtime.service.reviewChange(blockedChange.id, "accept", "外部审核通过", { type: "external-llm", id: "reviewer-a", model: "review-model" }, "blocked-accept", learningReview),
    /内部审核门禁未通过/,
  );
  await assert.rejects(
    runtime.service.reviewChange(blockedChange.id, "accept", "外部审核通过", { type: "external-llm", id: "reviewer-a", model: "review-model" }, "blocked-accept-retry", {
      ...learningReview,
      reviewRunId: "review-run-stale-learning",
      learning: { ...learningReview.learning, proposal: { ...learningReview.learning.proposal, targetVersion: "0.0.0" } },
    }),
    /内部审核门禁未通过/,
  );
  const learningCandidates = await novelDb.craftRuleCandidates.where("projectId").equals(gatedProject.id).toArray();
  assert.equal(learningCandidates.length, beforeLearningCandidates + 1);
  assert.equal(learningCandidates.at(-1).learningSource.reviewRunId, "review-run-blocked");
  const persistedBlockedChange = runtime.store.getChange(blockedChange.id);
  assert.equal(persistedBlockedChange?.status, "pending");
  assert.match(persistedBlockedChange?.externalReviews?.at(-1)?.learningError ?? "", /目标规则版本已变化/);
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

test("same-root restart releases the runtime listener", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ymcp-novel-restart-test-"));
  const runtime = await createNovelRuntime({ databasePath: join(directory, "runtime.sqlite"), port: 0 });
  context.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const runtimeBase = `http://${runtime.address.host}:${runtime.address.port}`;
  const health = await fetch(`${runtimeBase}/v1/health`).then((response) => response.json());

  const restart = await fetch(`${runtimeBase}/v1/admin/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runtimeRoot: health.runtimeRoot }),
  });
  assert.equal(restart.status, 202);

  const deadline = Date.now() + 2_000;
  let stopped = false;
  while (Date.now() < deadline && !stopped) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    stopped = await fetch(`${runtimeBase}/v1/health`).then(() => false, () => true);
  }
  assert.equal(stopped, true);
});

test("runtime client fails closed when an old health response omits root ownership", async () => {
  const legacy = createServer((request, response) => {
    response.writeHead(request.url === "/v1/health" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/v1/health"
      ? { service: "ymcp-novel-runtime", protocolVersion: 1 }
      : { error: "not found" }));
  });
  await new Promise((resolveListen, rejectListen) => {
    legacy.once("error", rejectListen);
    legacy.listen(0, "127.0.0.1", resolveListen);
  });
  const address = legacy.address();
  assert.notEqual(address, null);
  const previousUrl = process.env.YMCP_NOVEL_RUNTIME_URL;
  const previousNoSpawn = process.env.YMCP_NOVEL_RUNTIME_NO_SPAWN;
  process.env.YMCP_NOVEL_RUNTIME_URL = `http://127.0.0.1:${address.port}`;
  process.env.YMCP_NOVEL_RUNTIME_NO_SPAWN = "true";
  try {
    await assert.rejects(ensureNovelRuntime(), /旧版小说运行时协议/);
  } finally {
    await new Promise((resolveClose) => legacy.close(resolveClose));
    if (previousUrl === undefined) delete process.env.YMCP_NOVEL_RUNTIME_URL;
    else process.env.YMCP_NOVEL_RUNTIME_URL = previousUrl;
    if (previousNoSpawn === undefined) delete process.env.YMCP_NOVEL_RUNTIME_NO_SPAWN;
    else process.env.YMCP_NOVEL_RUNTIME_NO_SPAWN = previousNoSpawn;
  }
});
