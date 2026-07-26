import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNovelProject, NovelDatabase, recordBase } from "../db";
import { RuntimeRecordConflictError, SqliteNovelStore, sha256 } from "@/novel-runtime/sqlite-store";
import { assertRuntimeActor, internalEvidencePasses, parseRuntimeLearningAssessment, runtimeNextActions, runtimePolicies, type LegacyMigrationBundle, type RuntimeChange, type RuntimeOperation } from "@/novel-runtime/contracts";
import { buildRuntimeRevisionInstruction, formatReviewIssuesForInstruction, NovelRuntimeService, recoverInterruptedOperation, selectNextPlanWork } from "@/novel-runtime/service";
import { buildIterationPrompt } from "../evaluation/skill-iteration";

describe("SQLite novel runtime store", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });

  function paths() {
    const directory = mkdtempSync(join(tmpdir(), "ymcp-runtime-store-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    return { directory, database: join(directory, "runtime.sqlite"), backups: join(directory, "backups") };
  }

  it("makes multi-item proposal revisions return a complete replacement set", () => {
    const instruction = buildRuntimeRevisionInstruction("新增一位反方角色", {
      kind: "proposal",
      value: { items: [
        { label: "甲", targetTable: "entities", payload: { kind: "character", name: "甲" }, rationale: "主角" },
        { label: "乙", targetTable: "entities", payload: { kind: "character", name: "乙" }, rationale: "同伴" },
      ] },
    });
    expect(instruction).toContain("完整替代上一版候选");
    expect(instruction).toContain("不得只返回新增项");
    expect(instruction).toContain('"name": "甲"');
    // 单项候选无 payload 时仍只返回 note（保持向后兼容）
    expect(buildRuntimeRevisionInstruction("修订单项", { kind: "proposal", value: { items: [{ label: "架构" }] } })).toBe("修订单项");
  });

  // 根因修复（iter14 非确定性退步）回归测试：
  // 单项候选（如 architecture）此前 revise/retry 时不包含前一候选结构信息，
  // LLM 看不到 powerCenters/growthCurves/phases，重生成时丢失已通过审核的结构强项。
  // 修复：buildRuntimeRevisionInstruction 为含 payload 的单项候选生成"上一版结构摘要"。
  it("buildRuntimeRevisionInstruction 为单项 architecture 候选生成结构摘要防止非确定性退步", () => {
    const instruction = buildRuntimeRevisionInstruction("根据审核意见深化技术代际与真相层级", {
      kind: "proposal",
      value: { items: [
        {
          label: "architecture",
          targetTable: "architectures",
          payload: {
            framework: "four-part",
            powerCenters: [
              { id: "pc_shen", name: "沈家" },
              { id: "pc_lingqi_origin", name: "灵气本源意识体" },
            ],
            growthCurves: [
              { id: "gc_main", kind: "main", subject: "主角命运" },
              { id: "gc_eco", kind: "ecological", subject: "灵气生态" },
            ],
            phases: [
              {
                id: "p1", title: "觉醒", primaryCurveId: "gc_main",
                romanceProgress: [{ romanceLineId: "rl_shen", relationshipStage: "相识", irreversibleEvent: "首次共闯禁地" }],
                techGeneration: { generation: "G1", name: "灵气感知", unlockCondition: "筑基期", narrativeFunction: "开启主线" },
                originTruthLayer: { layer: "1", revelation: "灵气有意识", revealerCenterId: "pc_lingqi_origin", consequence: "主角认知颠覆" },
              },
              { id: "p2", title: "裂变", primaryCurveId: "gc_eco" },
            ],
            feedbackLoops: [
              { id: "fl1", affectedCenters: ["pc_shen", "pc_lingqi_origin"] },
            ],
          },
        },
      ] },
    });
    // 必须包含结构摘要头
    expect(instruction).toContain("# 上一版已通过审核的结构强项");
    // 必须列出 powerCenters 的 id 和 name（被 feedbackLoops.affectedCenters 引用）
    expect(instruction).toContain("pc_shen（沈家）");
    expect(instruction).toContain("pc_lingqi_origin（灵气本源意识体）");
    // 必须列出 growthCurves 的 id/kind/subject（被 phases.primaryCurveId 引用）
    expect(instruction).toContain("gc_main（kind=main, subject=主角命运）");
    expect(instruction).toContain("gc_eco（kind=ecological, subject=灵气生态）");
    // 必须列出 phases 的 id/title/primaryCurveId
    expect(instruction).toContain("p1（觉醒, primaryCurveId=gc_main");
    expect(instruction).toContain("p2（裂变, primaryCurveId=gc_eco）");
    // 必须列出已填充的结构化字段（romanceProgress/techGeneration/originTruthLayer）
    expect(instruction).toContain("romanceProgress[rl_shen(相识)]");
    expect(instruction).toContain("techGeneration(G1:灵气感知)");
    expect(instruction).toContain("originTruthLayer(L1:灵气有意识)");
    // p2 无结构化字段时不应有"已填充"标记
    expect(instruction).toContain("p2（裂变, primaryCurveId=gc_eco）");
    // 必须包含"已填充"字段必须保留的指令
    expect(instruction).toContain("标注\"已填充\"的 romanceProgress/techGeneration/originTruthLayer 是前序已通过审核的结构化字段");
    expect(instruction).toContain("不得清零");
    // 必须包含"必须保留"指令
    expect(instruction).toContain("必须保留这些结构元素的 id/name 与引用关系");
    expect(instruction).toContain("不得以\"不得保留上一版\"为由丢弃");
  });

  it("buildRuntimeRevisionInstruction 单项候选无 powerCenters/growthCurves/phases 时不生成结构摘要", () => {
    // payload 存在但无结构化字段 → 不生成摘要，只返回 note
    const instruction = buildRuntimeRevisionInstruction("修订定位", {
      kind: "proposal",
      value: { items: [
        { label: "positioning", targetTable: "projects", payload: { title: "新标题", premise: "新前提" } },
      ] },
    });
    expect(instruction).not.toContain("# 上一版已通过审核的结构强项");
    expect(instruction).toBe("修订定位");
  });

  it("persists all project records and hydrates a new isolated database", async () => {
    const path = paths();
    const source = new NovelDatabase(`runtime-source-${crypto.randomUUID()}`);
    const target = new NovelDatabase(`runtime-target-${crypto.randomUUID()}`);
    cleanup.push(async () => { await source.delete(); await target.delete(); });
    await source.open();
    const project = await createNovelProject({ title: "持久化项目", premise: "跨重启保持", genre: ["测试"] }, source);
    expect(project.settings.textModel).toBe("gpt-5-5");
    await source.entities.put({ ...recordBase(project.id), kind: "character", name: "林舟", aliases: [], summary: "主角", description: "", tags: [], attributes: {}, lockedFacts: [] });
    const first = new SqliteNovelStore(path.database, path.backups);
    await first.flushProject(source, project.id);
    const beforeHash = first.snapshotHash(project.id);
    first.close();

    const reopened = new SqliteNovelStore(path.database, path.backups);
    await reopened.hydrate(target);
    expect((await target.projects.get(project.id))?.title).toBe("持久化项目");
    expect((await target.entities.where("projectId").equals(project.id).first())?.name).toBe("林舟");
    expect(reopened.snapshotHash(project.id)).toBe(beforeHash);
    reopened.close();
  });

  it("applies a project edit batch atomically with revision checks and durable idempotency", async () => {
    const path = paths();
    const db = new NovelDatabase(`runtime-command-${crypto.randomUUID()}`);
    cleanup.push(() => db.delete());
    await db.open();
    const project = await createNovelProject({ title: "命令前", premise: "批量提交", genre: ["测试"] }, db);
    const store = new SqliteNovelStore(path.database, path.backups);
    cleanup.push(() => store.close());
    await store.flushProject(db, project.id);
    const entity = { ...recordBase(project.id), kind: "character", name: "新人物", aliases: [], summary: "", description: "", tags: [], attributes: {}, lockedFacts: [] };
    const command = {
      projectId: project.id,
      actor: { type: "user" as const, id: "author" },
      mutations: [
        { type: "put" as const, collection: "projects", id: project.id, expectedRevision: project.revision, value: { ...project, title: "命令后" } },
        { type: "put" as const, collection: "entities", id: entity.id, expectedRevision: null, value: entity },
      ],
    };

    const first = store.applyProjectMutation(command, "command-1");
    const repeated = store.applyProjectMutation(command, "command-1");

    expect(repeated).toEqual(first);
    expect(first.changed).toEqual(expect.arrayContaining([
      expect.objectContaining({ collection: "projects", revision: 2 }),
      expect.objectContaining({ collection: "entities", revision: 1 }),
    ]));
    expect(first.records.projects[0].title).toBe("命令后");
    expect(first.records.entities[0].updatedBy).toBe("author");
    expect(() => store.applyProjectMutation({ ...command, mutations: [command.mutations[0]] }, "command-stale"))
      .toThrow(RuntimeRecordConflictError);
  });

  it("rolls back every record when one mutation crosses the project boundary", async () => {
    const path = paths();
    const db = new NovelDatabase(`runtime-command-scope-${crypto.randomUUID()}`);
    cleanup.push(() => db.delete());
    await db.open();
    const first = await createNovelProject({ title: "甲", premise: "甲", genre: ["测试"] }, db);
    const second = await createNovelProject({ title: "乙", premise: "乙", genre: ["测试"] }, db);
    const store = new SqliteNovelStore(path.database, path.backups);
    cleanup.push(() => store.close());
    await store.flushProject(db, first.id);
    await store.flushProject(db, second.id);

    expect(() => store.applyProjectMutation({
      projectId: first.id,
      actor: { type: "user", id: "author" },
      mutations: [
        { type: "put", collection: "projects", id: first.id, expectedRevision: first.revision, value: { ...first, title: "不应保留" } },
        { type: "put", collection: "projects", id: second.id, expectedRevision: second.revision, value: { ...second, title: "越界" } },
      ],
    }, "scope-command")).toThrow(/不属于当前项目/);

    expect(store.getProjectSnapshot(first.id).records.projects[0].title).toBe("甲");
    expect(store.getProjectSnapshot(second.id).records.projects[0].title).toBe("乙");
  });

  it("deletes a project and its runtime state as one idempotent command", async () => {
    const path = paths();
    const db = new NovelDatabase(`runtime-delete-${crypto.randomUUID()}`);
    cleanup.push(() => db.delete());
    await db.open();
    const project = await createNovelProject({ title: "待删除", premise: "删除事务", genre: ["测试"] }, db);
    const store = new SqliteNovelStore(path.database, path.backups);
    cleanup.push(() => store.close());
    await store.flushProject(db, project.id);
    store.putOperation({ id: "delete-op", projectId: project.id, kind: "plan", driver: "human", ...runtimePolicies("human"), status: "completed", input: {}, baseSnapshotHash: store.snapshotHash(project.id), attempt: 1, createdAt: 1, updatedAt: 2 });

    store.deleteProject(project.id, "delete-command");
    store.deleteProject(project.id, "delete-command");

    expect(store.getProjectSnapshot(project.id).records).toEqual({});
    expect(store.listOperations(project.id)).toEqual([]);
    expect(() => store.deleteProject("another-project", "delete-command")).toThrow(/commandId/);
  });

  it("excludes transient proposals from the formal snapshot but detects formal edits", async () => {
    const path = paths();
    const db = new NovelDatabase(`runtime-hash-${crypto.randomUUID()}`);
    cleanup.push(() => db.delete());
    await db.open();
    const project = await createNovelProject({ title: "快照项目", premise: "检测正式修改", genre: ["测试"] }, db);
    const store = new SqliteNovelStore(path.database, path.backups);
    cleanup.push(() => store.close());
    await store.flushProject(db, project.id);
    const baseline = store.snapshotHash(project.id);
    await db.proposals.put({ ...recordBase(project.id), title: "临时候选", operation: "structured:test", taskKey: "characters", scope: "characters", status: "pending", previewMarkdown: "候选", patches: [], items: [], contextPacketId: "ctx", model: "test" });
    await store.flushProject(db, project.id);
    expect(store.snapshotHash(project.id)).toBe(baseline);
    await db.projects.update(project.id, { title: "正式标题已修改", updatedAt: Date.now() });
    await store.flushProject(db, project.id);
    expect(store.snapshotHash(project.id)).not.toBe(baseline);
  });

  it("backs up and imports a complete legacy bundle idempotently", async () => {
    const path = paths();
    const db = new NovelDatabase(`runtime-migration-${crypto.randomUUID()}`);
    cleanup.push(() => db.delete());
    await db.open();
    const project = await createNovelProject({ title: "旧项目", premise: "迁移", genre: ["历史"] }, db);
    const records = {
      projects: [(await db.projects.get(project.id))!] as unknown as Array<Record<string, unknown>>,
      architectures: await db.architectures.where("projectId").equals(project.id).toArray() as unknown as Array<Record<string, unknown>>,
    };
    const bundle: LegacyMigrationBundle = { format: "ymcp-novel-runtime-migration", formatVersion: 1, exportedAt: Date.now(), records, integrity: { algorithm: "sha256", digest: sha256(records) } };
    const store = new SqliteNovelStore(path.database, path.backups);
    cleanup.push(() => store.close());
    const first = await store.importLegacyBundle(bundle, db);
    expect(existsSync(first.backupPath)).toBe(true);
    expect(JSON.parse(readFileSync(first.backupPath, "utf8")).integrity.digest).toBe(bundle.integrity.digest);
    const second = await store.importLegacyBundle(bundle, db);
    expect(second.backupPath).toBe(first.backupPath);
    expect(store.snapshotHash(project.id)).not.toBe(sha256([]));
  });

  it("keeps migrated API credentials out of the archive and public SQLite settings", async () => {
    const path = paths();
    const db = new NovelDatabase(`runtime-secret-${crypto.randomUUID()}`);
    cleanup.push(() => db.delete());
    await db.open();
    const project = await createNovelProject({ title: "密钥迁移", premise: "保护凭据", genre: ["测试"] }, db);
    const records = { projects: [(await db.projects.get(project.id))!] as unknown as Array<Record<string, unknown>> };
    const bundle: LegacyMigrationBundle = {
      format: "ymcp-novel-runtime-migration", formatVersion: 1, exportedAt: Date.now(), records,
      integrity: { algorithm: "sha256", digest: sha256(records) },
      apiConfig: { baseUrl: "https://example.test/v1", apiKey: "secret-runtime-key", modelContextWindow: 128000 },
    };
    const store = new SqliteNovelStore(path.database, path.backups);
    cleanup.push(() => store.close());

    const result = await store.importLegacyBundle(bundle, db);
    const backup = JSON.parse(readFileSync(result.backupPath, "utf8")) as LegacyMigrationBundle;

    expect(backup.apiConfig).toEqual({ baseUrl: "https://example.test/v1", modelContextWindow: 128000 });
    expect(store.getSetting<{ apiKey?: string }>("apiConfig")?.apiKey).toBe("secret-runtime-key");
    expect(existsSync(join(path.directory, "novel-runtime.secrets.json"))).toBe(true);
  });

  it("commits the accepted project snapshot and runtime state together", async () => {
    const path = paths();
    const db = new NovelDatabase(`runtime-accept-${crypto.randomUUID()}`);
    cleanup.push(() => db.delete());
    await db.open();
    const project = await createNovelProject({ title: "接受前", premise: "原子提交", genre: ["测试"] }, db);
    const store = new SqliteNovelStore(path.database, path.backups);
    cleanup.push(() => store.close());
    await store.flushProject(db, project.id);
    const operation: RuntimeOperation = { id: "accept-op", projectId: project.id, kind: "plan", driver: "human", ...runtimePolicies("human"), status: "queued", input: {}, baseSnapshotHash: store.snapshotHash(project.id), attempt: 1, createdAt: 1, updatedAt: 2 };
    const change = { id: "accept-change", operationId: operation.id, projectId: project.id, workItemId: "work-1", artifactRefs: ["artifact-1"], title: "标题候选", summary: "更新标题", evidence: { complete: true, openIssues: [], iteration: 0, maxIterations: 2 }, status: "accepted" as const, baseSnapshotHash: operation.baseSnapshotHash, createdAt: 1, updatedAt: 2 };
    await db.projects.update(project.id, { title: "接受后", updatedAt: Date.now() });

    await store.commitAcceptedChange(db, change, operation);

    expect(store.getChange(change.id)?.status).toBe("accepted");
    expect(store.getOperation(operation.id)?.baseSnapshotHash).toBe(store.snapshotHash(project.id));
    const rehydrated = new NovelDatabase(`runtime-accept-target-${crypto.randomUUID()}`);
    cleanup.push(() => rehydrated.delete());
    await store.hydrate(rehydrated);
    expect((await rehydrated.projects.get(project.id))?.title).toBe("接受后");
  });

  it("rolls back project records, change, and operation when accepted-state persistence fails", async () => {
    const path = paths();
    const db = new NovelDatabase(`runtime-rollback-${crypto.randomUUID()}`);
    cleanup.push(() => db.delete());
    await db.open();
    const project = await createNovelProject({ title: "事务前", premise: "故障回滚", genre: ["测试"] }, db);
    const store = new SqliteNovelStore(path.database, path.backups);
    cleanup.push(() => store.close());
    await store.flushProject(db, project.id);
    const beforeHash = store.snapshotHash(project.id);
    const operation: RuntimeOperation = { id: "rollback-op", projectId: project.id, kind: "plan", driver: "human", ...runtimePolicies("human"), status: "queued", input: {}, baseSnapshotHash: beforeHash, attempt: 1, createdAt: 1, updatedAt: 2 };
    const change: RuntimeChange = { id: "rollback-change", operationId: operation.id, projectId: project.id, workItemId: "work-1", artifactRefs: ["artifact-1"], title: "候选", summary: "候选", evidence: { complete: true, openIssues: [], iteration: 0, maxIterations: 2 }, status: "accepted", baseSnapshotHash: beforeHash, createdAt: 1, updatedAt: 2 };
    await db.projects.update(project.id, { title: "不应提交", updatedAt: Date.now() });
    const blocker = new DatabaseSync(path.database);
    blocker.exec("CREATE TRIGGER reject_runtime_change BEFORE INSERT ON runtime_changes BEGIN SELECT RAISE(ABORT, 'forced failure'); END;");
    blocker.close();

    await expect(store.commitAcceptedChange(db, change, operation)).rejects.toThrow(/forced failure/);

    expect(store.snapshotHash(project.id)).toBe(beforeHash);
    expect(store.getChange(change.id)).toBeUndefined();
    expect(store.getOperation(operation.id)).toBeUndefined();
    await store.restoreProject(db, project.id);
    expect((await db.projects.get(project.id))?.title).toBe("事务前");
  });

  it("commits a patched candidate and its invalidated evidence atomically", async () => {
    const path = paths();
    const db = new NovelDatabase(`runtime-candidate-rollback-${crypto.randomUUID()}`);
    cleanup.push(() => db.delete());
    await db.open();
    const project = await createNovelProject({ title: "候选事务", premise: "补丁原子性", genre: ["测试"] }, db);
    const proposal = {
      ...recordBase(project.id), id: "candidate-proposal", title: "候选", operation: "structured:project-positioning", taskKey: "project-positioning" as const,
      status: "pending" as const, previewMarkdown: "原候选", patches: [], items: [], contextPacketId: "context", model: "test",
    };
    await db.proposals.put(proposal);
    const store = new SqliteNovelStore(path.database, path.backups);
    cleanup.push(() => store.close());
    await store.flushProject(db, project.id);
    await db.proposals.update(proposal.id, { previewMarkdown: "补丁后的候选", revision: 2, updatedAt: Date.now() });
    const change: RuntimeChange = {
      id: "candidate-change", operationId: "candidate-operation", projectId: project.id, workItemId: "candidate-work", artifactRefs: [proposal.id], title: "候选", summary: "补丁后的候选",
      evidence: { complete: true, artifactFingerprint: "a".repeat(64), blockerCount: 0, majorCount: 0, openIssues: [], iteration: 0, maxIterations: null, internalGate: { passed: false, reason: "候选已被补丁修改", checkedAt: 2 } },
      status: "pending", baseSnapshotHash: store.snapshotHash(project.id), createdAt: 1, updatedAt: 2,
    };
    const blocker = new DatabaseSync(path.database);
    blocker.exec("CREATE TRIGGER reject_candidate_change BEFORE INSERT ON runtime_changes BEGIN SELECT RAISE(ABORT, 'forced candidate failure'); END;");
    blocker.close();

    await expect(store.commitChangeState(db, change)).rejects.toThrow(/forced candidate failure/);

    expect(store.getChange(change.id)).toBeUndefined();
    expect(store.getProjectSnapshot(project.id).records.proposals?.[0]?.previewMarkdown).toBe("原候选");
  });

  it("locks review authority to the operation driver and exposes structured next actions", () => {
    const human: RuntimeOperation = { id: "human-op", projectId: "project", kind: "plan", driver: "human", ...runtimePolicies("human"), status: "awaiting_review", input: {}, baseSnapshotHash: "hash", attempt: 1, currentChangeId: "change", createdAt: 1, updatedAt: 2 };
    const change: RuntimeChange = { id: "change", operationId: human.id, projectId: human.projectId, workItemId: "work", artifactRefs: ["artifact"], title: "候选", summary: "候选", evidence: { complete: true, openIssues: [], iteration: 0, maxIterations: 2 }, status: "pending", baseSnapshotHash: "hash", createdAt: 1, updatedAt: 2 };
    expect(() => assertRuntimeActor(human, { type: "external-llm", id: "agent", model: "model" })).toThrow(/不接受/);
    expect(() => assertRuntimeActor(human, { type: "user", id: "author" })).not.toThrow();
    expect(runtimeNextActions(human, change).map((action) => action.type)).toEqual(["read-agent-guide", "inspect-change", "review-change", "patch-change", "regenerate-change"]);
    const external = { ...human, driver: "external-mcp" as const, ...runtimePolicies("external-mcp") };
    expect(() => assertRuntimeActor(external, { type: "external-llm", id: "agent" })).toThrow(/模型身份/);
    expect(external.reviewPolicy.maxIterations).toBeNull();
    expect(external.improvementPolicy.autoPromote).toBe(true);
  });

  it("does not offer acceptance while the internal candidate gate reports blockers", () => {
    const operation: RuntimeOperation = { id: "blocked-op", projectId: "project", kind: "write", driver: "external-mcp", ...runtimePolicies("external-mcp"), status: "awaiting_review", input: {}, baseSnapshotHash: "hash", attempt: 1, currentChangeId: "blocked-change", createdAt: 1, updatedAt: 2 };
    const change: RuntimeChange = {
      id: "blocked-change", operationId: operation.id, projectId: operation.projectId, workItemId: "work", artifactRefs: ["artifact"], title: "正文候选", summary: "存在连续性问题",
      evidence: { complete: true, blockerCount: 1, majorCount: 0, openIssues: ["时间线冲突"], iteration: 4, maxIterations: null, internalGate: { passed: false, reason: "项目内部质量证据仍有 blocker 或 major", checkedAt: 3 } },
      status: "pending", baseSnapshotHash: "hash", createdAt: 1, updatedAt: 2,
    };
    const review = runtimeNextActions(operation, change).find((action) => action.type === "review-change");
    expect(review?.allowedDecisions).toEqual(["revise"]);
    expect(runtimeNextActions(operation, change).some((action) => action.type === "patch-change")).toBe(true);
  });

  it("fails closed when internal evidence is missing or explicitly invalidated", () => {
    const artifactFingerprint = "a".repeat(64);
    const missing = { complete: true, openIssues: [], iteration: 0, maxIterations: null };
    const invalidated = { ...missing, blockerCount: 0, majorCount: 0, internalGate: { passed: false, reason: "候选已被补丁修改", checkedAt: 1 } };
    const passed = { ...missing, artifactFingerprint, blockerCount: 0, majorCount: 0, internalGate: { passed: true, reason: "审核通过", checkedAt: 2 } };

    expect(internalEvidencePasses(missing)).toBe(false);
    expect(internalEvidencePasses(invalidated)).toBe(false);
    expect(internalEvidencePasses(passed)).toBe(true);
    expect(internalEvidencePasses(passed, "b".repeat(64))).toBe(false);
  });

  it("recovers running operations before closing the runtime store", () => {
    const path = paths();
    const store = new SqliteNovelStore(path.database, path.backups);
    const service = new NovelRuntimeService(store);
    const operation: RuntimeOperation = { id: "shutdown-op", projectId: "project-1", kind: "write", driver: "external-mcp", ...runtimePolicies("external-mcp"), status: "running", input: {}, baseSnapshotHash: "hash", attempt: 1, leaseExpiresAt: Date.now() + 600_000, createdAt: 1, updatedAt: 2 };
    store.putOperation(operation);

    service.prepareForShutdown();

    expect(store.getOperation(operation.id)).toMatchObject({ status: "queued", input: { runtimeRecovery: true } });
    store.close();
  });

  it("persists operation leases and idempotency request keys across reopen", () => {
    const path = paths();
    const operation: RuntimeOperation = { id: "op-1", projectId: "project-1", kind: "write", driver: "external-mcp", ...runtimePolicies("external-mcp"), status: "running", input: { requestKey: "session:request" }, baseSnapshotHash: "hash", attempt: 1, leaseExpiresAt: Date.now() + 1000, createdAt: 1, updatedAt: 2 };
    const first = new SqliteNovelStore(path.database, path.backups);
    first.putOperation(operation);
    first.close();
    const reopened = new SqliteNovelStore(path.database, path.backups);
    expect(reopened.getOperation("op-1")).toEqual(operation);
    expect(reopened.listOperations("project-1")).toHaveLength(1);
    reopened.close();
  });

  it("recovers a running operation after restart even before its old lease expires", () => {
    const operation: RuntimeOperation = { id: "op-future-lease", projectId: "project-1", kind: "plan", driver: "external-mcp", ...runtimePolicies("external-mcp"), status: "running", input: {}, baseSnapshotHash: "hash", attempt: 1, leaseExpiresAt: Date.now() + 600_000, createdAt: 1, updatedAt: 2 };

    const recovered = recoverInterruptedOperation(operation, 100);

    expect(recovered).toMatchObject({ status: "queued", updatedAt: 100, input: { runtimeRecovery: true } });
    expect(recovered.leaseExpiresAt).toBeUndefined();
  });

  it("rebuilds review state before starting later queued planning work", () => {
    const waiting = { id: "work-waiting", status: "waiting-review", taskKey: "architecture", dependsOn: [] };
    const queued = { id: "work-next", status: "queued", taskKey: "characters", dependsOn: [waiting.id] };

    expect(selectNextPlanWork([waiting, queued])).toBe(waiting);
  });

  it("supersedes obsolete queued/awaiting_review operations when a same-kind same-taskKey operation is enqueued", () => {
    const path = paths();
    const store = new SqliteNovelStore(path.database, path.backups);
    const service = new NovelRuntimeService(store);
    // 阻止 schedule 异步触发 process，避免新 operation 在测试环境调用 LLM
    service.prepareForShutdown();

    const now = Date.now();
    // 旧的全书架构候选：awaiting_review + pending change
    const staleOperation: RuntimeOperation = {
      id: "stale-arch-op", projectId: "project-arch", kind: "plan", driver: "external-mcp", ...runtimePolicies("external-mcp"),
      status: "awaiting_review", input: { instruction: "旧的全书架构指令", taskKey: "architecture", target: undefined, requestKey: "req-stale" },
      baseSnapshotHash: "hash-stale", currentChangeId: "stale-change", attempt: 1, createdAt: now - 1000, updatedAt: now - 1000,
    };
    const staleChange: RuntimeChange = {
      id: "stale-change", operationId: staleOperation.id, projectId: staleOperation.projectId, workItemId: "work-stale",
      artifactRefs: ["artifact-stale"], title: "旧架构候选", summary: "已被新指令取代", status: "pending",
      evidence: { complete: true, openIssues: [], iteration: 0, maxIterations: null, internalGate: { passed: true, reason: "通过", checkedAt: now } },
      baseSnapshotHash: "hash-stale", createdAt: now - 1000, updatedAt: now - 1000,
    };
    store.putOperation(staleOperation);
    store.putChange(staleChange);

    // 同类 queued 旧 operation（也应被 supersede）
    const queuedOperation: RuntimeOperation = {
      ...staleOperation, id: "queued-arch-op", status: "queued", input: { instruction: "排队中的旧架构指令", taskKey: "architecture", target: undefined, requestKey: "req-queued" },
      currentChangeId: undefined, createdAt: now - 500, updatedAt: now - 500,
    };
    store.putOperation(queuedOperation);

    // 不同 taskKey 的旧 operation（不应被 supersede）
    const otherTaskOperation: RuntimeOperation = {
      ...staleOperation, id: "other-task-op", status: "awaiting_review", input: { instruction: "角色设定指令", taskKey: "characters", target: undefined, requestKey: "req-other" },
      currentChangeId: "other-change", createdAt: now - 800, updatedAt: now - 800,
    };
    store.putOperation(otherTaskOperation);
    store.putChange({ ...staleChange, id: "other-change", operationId: otherTaskOperation.id, workItemId: "work-other", title: "角色候选" });

    // 不同 target 的旧 operation（章节场景，不应被 supersede）
    const otherTargetOperation: RuntimeOperation = {
      ...staleOperation, id: "other-target-op", kind: "write", status: "awaiting_review", input: { instruction: "章节写作指令", taskKey: undefined, target: "chapter-1", requestKey: "req-target" },
      currentChangeId: "target-change", createdAt: now - 700, updatedAt: now - 700,
    };
    store.putOperation(otherTargetOperation);
    store.putChange({ ...staleChange, id: "target-change", operationId: otherTargetOperation.id, workItemId: "work-target", title: "章节候选" });

    // running 状态的同类旧 operation（不应被 supersede——设计权衡，避免与正在执行的 LLM 调用竞态）
    const runningOperation: RuntimeOperation = {
      ...staleOperation, id: "running-arch-op", status: "running", input: { instruction: "运行中的旧架构指令", taskKey: "architecture", target: undefined, requestKey: "req-running" },
      currentChangeId: undefined, leaseExpiresAt: now + 600_000, createdAt: now - 600, updatedAt: now - 600,
    };
    store.putOperation(runningOperation);

    // 重新发起同类 operation（不同 instruction 文本，避免 instructionHash 去重）
    const newOperation = service.enqueueIntent(
      { projectId: "project-arch", kind: "plan", instruction: "新的全书架构指令，重点扩展权力纵深", taskKey: "architecture", driver: "external-mcp" },
      "req-new",
    );

    // 断言：旧 awaiting_review + queued operation 被 cancelled，其 pending change 被 superseded
    const staleAfter = store.getOperation("stale-arch-op");
    expect(staleAfter?.status).toBe("cancelled");
    expect(staleAfter?.currentChangeId).toBeUndefined();
    expect(staleAfter?.result?.superseded).toBe(true);
    const staleChangeAfter = store.getChange("stale-change");
    expect(staleChangeAfter?.status).toBe("superseded");
    expect(staleChangeAfter?.review?.decision).toBe("superseded");

    const queuedAfter = store.getOperation("queued-arch-op");
    expect(queuedAfter?.status).toBe("cancelled");

    // 断言：不同 taskKey 的旧 operation 不受影响
    expect(store.getOperation("other-task-op")?.status).toBe("awaiting_review");
    expect(store.getChange("other-change")?.status).toBe("pending");

    // 断言：不同 target 的旧 operation 不受影响
    expect(store.getOperation("other-target-op")?.status).toBe("awaiting_review");
    expect(store.getChange("target-change")?.status).toBe("pending");

    // 断言：running 状态的旧 operation 不受影响（设计权衡）
    expect(store.getOperation("running-arch-op")?.status).toBe("running");

    // 断言：新 operation 被创建为 queued
    expect(newOperation.status).toBe("queued");
    expect(newOperation.kind).toBe("plan");
    expect(newOperation.input.taskKey).toBe("architecture");

    store.close();
  });

  it("supersedes legacy operations that used target as taskKey when new operation uses taskKey", () => {
    // 兼容历史数据：旧 MCP 入口未传 taskKey，而是把类别标识塞进 target（如 target="architecture"）。
    // 新 MCP 入口标准化后用 taskKey（如 taskKey="architecture", target=undefined）。
    // 两者应匹配为同类，触发 supersede 避免孤儿堆积。
    const path = paths();
    const store = new SqliteNovelStore(path.database, path.backups);
    const service = new NovelRuntimeService(store);
    service.prepareForShutdown();

    const now = Date.now();
    // 历史旧 op：taskKey=undefined, target="architecture"（旧 MCP 入口遗留）
    const legacyOperation: RuntimeOperation = {
      id: "legacy-arch-op", projectId: "project-legacy", kind: "plan", driver: "external-mcp", ...runtimePolicies("external-mcp"),
      status: "awaiting_review", input: { instruction: "旧架构指令", taskKey: undefined, target: "architecture", requestKey: "req-legacy" },
      baseSnapshotHash: "hash-legacy", currentChangeId: "legacy-change", attempt: 1, createdAt: now - 1000, updatedAt: now - 1000,
    };
    const legacyChange: RuntimeChange = {
      id: "legacy-change", operationId: legacyOperation.id, projectId: legacyOperation.projectId, workItemId: "work-legacy",
      artifactRefs: ["artifact-legacy"], title: "旧架构候选", summary: "历史遗留", status: "pending",
      evidence: { complete: true, openIssues: [], iteration: 0, maxIterations: null, internalGate: { passed: true, reason: "通过", checkedAt: now } },
      baseSnapshotHash: "hash-legacy", createdAt: now - 1000, updatedAt: now - 1000,
    };
    store.putOperation(legacyOperation);
    store.putChange(legacyChange);

    // 新 op：taskKey="architecture", target=undefined（标准化后的 MCP 入口）
    const newOperation = service.enqueueIntent(
      { projectId: "project-legacy", kind: "plan", instruction: "新架构指令，扩展权力纵深", taskKey: "architecture", driver: "external-mcp" },
      "req-new",
    );

    // 断言：历史旧 op 被 cancelled，其 pending change 被 superseded
    expect(store.getOperation("legacy-arch-op")?.status).toBe("cancelled");
    expect(store.getChange("legacy-change")?.status).toBe("superseded");
    expect(newOperation.status).toBe("queued");

    store.close();
  });

  it("requires a complete executable proposal for shared learning", () => {
    expect(() => parseRuntimeLearningAssessment({ conclusion: "propose-improvement", summary: "共享缺陷", affectedInputClass: "所有章节", underlyingMechanism: "职责缺失" })).toThrow(/完整改进候选/);
    expect(parseRuntimeLearningAssessment({ conclusion: "no-shared-learning", summary: "仅为单次执行偏差" })).toEqual({ conclusion: "no-shared-learning", summary: "仅为单次执行偏差" });
  });

  it("feeds the underlying learning mechanism into skill iteration", () => {
    const prompt = buildIterationPrompt({
      skills: [],
      issues: [{ id: "issue-1", dimension: "plot", severity: "major", title: "选择没有代价", description: "人物决定后局面没有变化", rule: "character-choice", suggestion: "让选择改变后续空间", deterministic: false }],
      draftExcerpt: "人物答应之后，一切照旧。",
      learning: {
        conclusion: "propose-improvement",
        summary: "高压选择缺少后果约束。",
        affectedInputClass: "人物作出不可逆选择的章节",
        underlyingMechanism: "生成职责只要求完成动作，没有要求动作收窄后续选项",
        proposal: { targetKind: "skill", targetId: "embodied-prose", afterText: "完整候选文本".repeat(20), rationale: "补齐选择后果", observedSymptom: "选择没有代价", failingLayer: "drafting skill", intendedBenefits: ["增强人物主体性"], boundaries: ["不强制日常章制造选择"], nonGoals: ["不统一题材文风"], regressionRisks: ["可能压缩安静章节"] },
      },
    });
    expect(prompt).toContain("底层机制：生成职责只要求完成动作，没有要求动作收窄后续选项");
    expect(prompt).toContain("影响输入类别：人物作出不可逆选择的章节");
    expect(prompt).toContain("issue 只作为证据");
  });

  it("formatReviewIssuesForInstruction 把字段级证据与修复建议格式化为 LLM 可执行清单", () => {
    const formatted = formatReviewIssuesForInstruction([
      {
        id: "arch-001",
        severity: "blocker",
        dimension: "romance-binding",
        title: "5个turningPoint无一含关系不可逆变化",
        evidence: "phase1-4 turningPoint 全关于组织裂变，无感情线关系承诺/裂变/公开。",
        suggestion: "每个 phase turningPoint 必须包含至少1个关系承诺/裂变/公开的不可逆情感事件。",
        evidenceField: "phases[1].turningPoint",
        evidenceQuote: "朝廷、商会和自由盟永久进入同一规则谈判结构。",
      },
      {
        id: "arch-002",
        severity: "major",
        dimension: "structure-scale",
        title: "stage summaries 过浅",
        evidence: "phase5.stages[0].summary 仅9字。",
        suggestion: "每个 stage summary 须写出谁面对什么阻力、付出什么代价、做出什么选择，至少30字。",
        evidenceField: "phases[4].stages[0].summary",
        evidenceQuote: "各中心调整自身位置。",
      },
    ]);
    // 必须包含标题头
    expect(formatted).toContain("# 外部审核具体意见（必须逐条修复）");
    // 必须包含 severity 标签
    expect(formatted).toContain("[blocker]");
    expect(formatted).toContain("[major]");
    // 必须包含字段路径
    expect(formatted).toContain("(phases[1].turningPoint)");
    expect(formatted).toContain("(phases[4].stages[0].summary)");
    // 必须包含当前值（evidenceQuote）
    expect(formatted).toContain('当前值: "朝廷、商会和自由盟永久进入同一规则谈判结构。"');
    expect(formatted).toContain('当前值: "各中心调整自身位置。"');
    // 必须包含证据
    expect(formatted).toContain("证据:");
    // 必须包含修复建议
    expect(formatted).toContain("修复:");
    expect(formatted).toContain("每个 phase turningPoint 必须包含至少1个关系承诺");
  });

  it("formatReviewIssuesForInstruction 截断过长的 evidence/suggestion 防止指令膨胀", () => {
    const longEvidence = "E".repeat(300);
    const longSuggestion = "S".repeat(400);
    const formatted = formatReviewIssuesForInstruction([
      { id: "x", severity: "warning", dimension: "d", title: "t", evidence: longEvidence, suggestion: longSuggestion },
    ]);
    // evidence 截断到 200 字符 + 省略号
    expect(formatted).toContain("E".repeat(200) + "…");
    expect(formatted).not.toContain("E".repeat(201));
    // suggestion 截断到 300 字符 + 省略号
    expect(formatted).toContain("S".repeat(300) + "…");
    expect(formatted).not.toContain("S".repeat(301));
  });

  it("formatReviewIssuesForInstruction 处理无 evidenceField/evidenceQuote 的最小 issue", () => {
    const formatted = formatReviewIssuesForInstruction([
      { id: "x", severity: "warning", dimension: "d", title: "t", evidence: "e", suggestion: "s" },
    ]);
    expect(formatted).toContain("[warning] d: t");
    expect(formatted).toContain("证据: e");
    expect(formatted).toContain("修复: s");
    // 无 evidenceField 时不应有空括号
    expect(formatted).not.toContain("()");
    // 无 evidenceQuote 时不应有"当前值"
    expect(formatted).not.toContain("当前值");
  });

  // 根因修复 2（矛盾指令覆盖，iter13 发现）的回归测试：
  // work.revise/work.retry 把 baseInstruction prepend 到 revisionInstruction，
  // 若 base 含"不得保留上一版"而 issues 含"恢复/保留/填充"，LLM 因 primacy effect
  // 倾向遵循 base → 非确定性退步。formatReviewIssuesForInstruction 必须在 issues 前
  // 注入"优先级覆盖指令"明确 issues 优先于 base 中的推倒重写指令。
  it("formatReviewIssuesForInstruction 注入优先级覆盖指令以化解 base 与 issues 的矛盾", () => {
    const formatted = formatReviewIssuesForInstruction([
      {
        id: "arch-regress-001",
        severity: "major",
        dimension: "non-deterministic-regression",
        title: "powerCenter 第8个丢失（前序已建模，本轮未要求删除）",
        evidence: "iter12 已建模 8 个 powerCenter，iter13 仅剩 7 个，review 未要求删除第8个。",
        suggestion: "恢复 powerCenter 第8个（沈青璃线），不得以'不得保留上一版'为由丢弃已通过审核的结构强项。",
        evidenceField: "powerCenters",
        evidenceQuote: "7 个 powerCenter",
      },
    ]);
    // 必须包含优先级覆盖指令头
    expect(formatted).toContain("# 优先级覆盖指令");
    // 必须明确 issues 优先于 base 中的推倒重写指令
    expect(formatted).toContain("不得保留上一版");
    expect(formatted).toContain("优先级高于基础指令");
    // 必须区分"审核意见提及"与"未提及"两类字段的处置
    expect(formatted).toContain("审核意见未提及的内容可以重新生成");
    expect(formatted).toContain("审核意见明确要求保留/恢复的内容必须保留/恢复");
    // 优先级覆盖指令必须出现在 issues 清单之前（primacy effect 防御）
    const overrideIdx = formatted.indexOf("# 优先级覆盖指令");
    const issuesIdx = formatted.indexOf("# 外部审核具体意见");
    expect(overrideIdx).toBeGreaterThanOrEqual(0);
    expect(issuesIdx).toBeGreaterThan(overrideIdx);
  });
});
