import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNovelProject, NovelDatabase, recordBase } from "../db";
import { RuntimeRecordConflictError, SqliteNovelStore, sha256 } from "@/novel-runtime/sqlite-store";
import { assertRuntimeActor, runtimeNextActions, runtimePolicies, type LegacyMigrationBundle, type RuntimeChange, type RuntimeOperation } from "@/novel-runtime/contracts";
import { buildRuntimeRevisionInstruction, recoverInterruptedOperation, selectNextPlanWork } from "@/novel-runtime/service";

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
    expect(buildRuntimeRevisionInstruction("修订单项", { kind: "proposal", value: { items: [{ label: "架构" }] } })).toBe("修订单项");
  });

  it("persists all project records and hydrates a new isolated database", async () => {
    const path = paths();
    const source = new NovelDatabase(`runtime-source-${crypto.randomUUID()}`);
    const target = new NovelDatabase(`runtime-target-${crypto.randomUUID()}`);
    cleanup.push(async () => { await source.delete(); await target.delete(); });
    await source.open();
    const project = await createNovelProject({ title: "持久化项目", premise: "跨重启保持", genre: ["测试"] }, source);
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

  it("locks review authority to the operation driver and exposes structured next actions", () => {
    const human: RuntimeOperation = { id: "human-op", projectId: "project", kind: "plan", driver: "human", ...runtimePolicies("human"), status: "awaiting_review", input: {}, baseSnapshotHash: "hash", attempt: 1, currentChangeId: "change", createdAt: 1, updatedAt: 2 };
    const change: RuntimeChange = { id: "change", operationId: human.id, projectId: human.projectId, workItemId: "work", artifactRefs: ["artifact"], title: "候选", summary: "候选", evidence: { complete: true, openIssues: [], iteration: 0, maxIterations: 2 }, status: "pending", baseSnapshotHash: "hash", createdAt: 1, updatedAt: 2 };
    expect(() => assertRuntimeActor(human, { type: "external-llm", id: "agent", model: "model" })).toThrow(/不接受/);
    expect(() => assertRuntimeActor(human, { type: "user", id: "author" })).not.toThrow();
    expect(runtimeNextActions(human, change).map((action) => action.type)).toEqual(["inspect-change", "review-change"]);
    const external = { ...human, driver: "external-mcp" as const, ...runtimePolicies("external-mcp") };
    expect(() => assertRuntimeActor(external, { type: "external-llm", id: "agent" })).toThrow(/模型身份/);
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
});
