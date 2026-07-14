import { beforeEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import "./setup";
import { createNovelProject, getCanvasLayout, novelDb, recordBase, saveCanvasLayout, saveStoryArchitecture } from "../db";
import { DB_VERSION, RECORD_SCHEMA_VERSION, V4_STORES, V5_STORES, V6_STORES } from "../db-schema";
import { exportNovel, importNovel } from "../export";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
});

describe("db-schema constants", () => {
  it("DB_VERSION is 6", () => {
    expect(DB_VERSION).toBe(6);
  });

  it("RECORD_SCHEMA_VERSION is 4", () => {
    expect(RECORD_SCHEMA_VERSION).toBe(4);
  });

  it("keeps the v4 schema for migration and removes project generation runs in v5", () => {
    expect(V4_STORES.architectures).toBeDefined();
    expect(V4_STORES.projectGenerationRuns).toBeDefined();
    expect(V5_STORES.projectGenerationRuns).toBeNull();
    expect(V5_STORES.proposals).not.toContain("projectGenerationRunId");
    expect(V5_STORES.embeddings).toContain("[projectId+targetTable]");
  });

  it("V4_STORES adds composite index to entities", () => {
    expect(V4_STORES.entities).toContain("[projectId+kind]");
  });

  it("V4_STORES adds composite index to outlineNodes", () => {
    expect(V4_STORES.outlineNodes).toContain("[projectId+status]");
  });

  it("V4_STORES indexes independent chapter order", () => {
    expect(V4_STORES.documents).toContain("order");
  });

  it("V6_STORES adds canvasLayouts with composite [projectId+panelKey] index", () => {
    expect(V6_STORES.canvasLayouts).toBeDefined();
    expect(V6_STORES.canvasLayouts).toContain("[projectId+panelKey]");
    expect(V6_STORES.canvasLayouts).toContain("panelKey");
  });
});

describe("database v6 schema", () => {
  it("opens successfully at v6 with canvasLayouts table and without the retired table", () => {
    expect(novelDb.isOpen()).toBe(true);
    expect(novelDb.verno).toBe(DB_VERSION);
    expect(novelDb.name).toBe("ymcp-novel-db-v4");
    expect(novelDb.tables.some((table) => table.name === "projectGenerationRuns")).toBe(false);
    expect(novelDb.tables.some((table) => table.name === "canvasLayouts")).toBe(true);
  });

  it("rejects project imports older than v4", async () => {
    const file = { text: async () => JSON.stringify({ manifest: { format: "ymcp-novel", schemaVersion: 3 }, project: { id: "legacy" } }) } as File;
    await expect(importNovel(file)).rejects.toThrow(/v4\/v5/);
  });

  it("imports v4 backups without retired run data or proposal links", async () => {
    const project = await createNovelProject({ title: "v4 导入", genre: ["悬疑"], premise: "旧流程已经结束。" });
    const document = { ...recordBase(project.id), id: "v4-document", order: 0, status: "draft", branch: "main", title: "保留正文", plainText: "旧正文" };
    const agent = { ...recordBase(project.id), id: "v4-agent", status: "completed", goal: "保留模型历史", model: "test", promptVersion: "test", steps: [] };
    const proposal = {
      ...recordBase(project.id),
      title: "旧候选",
      operation: "structured:story-bible",
      taskKey: "project-positioning",
      scope: "dashboard",
      targetId: undefined,
      status: "pending",
      previewMarkdown: "# 旧候选",
      patches: [],
      items: [],
      contextPacketId: "context",
      model: "test",
      projectGenerationRunId: "legacy-run",
    };
    const file = { text: async () => JSON.stringify({ manifest: { format: "ymcp-novel", schemaVersion: 4 }, project, documents: [document], proposals: [proposal], agentRuns: [agent], projectGenerationRuns: [{ id: "legacy-run", projectId: project.id }] }) } as File;
    await importNovel(file);
    const imported = await novelDb.proposals.get(proposal.id) as Record<string, unknown> | undefined;
    expect(imported?.title).toBe("旧候选");
    expect(imported).not.toHaveProperty("projectGenerationRunId");
    expect(imported?.scope).toBe("bible");
    expect((await novelDb.documents.get(document.id))?.plainText).toBe("旧正文");
    expect((await novelDb.agentRuns.get(agent.id))?.goal).toBe("保留模型历史");
    expect(novelDb.tables.some((table) => table.name === "projectGenerationRuns")).toBe(false);
  });

  it("imports v5 backups with ordinary candidates and agent history", async () => {
    const project = await createNovelProject({ title: "v5 导入", genre: ["科幻"], premise: "任务按页面归属。" });
    const document = { ...recordBase(project.id), id: "v5-document", order: 0, status: "draft", branch: "main", title: "当前正文", plainText: "新正文" };
    const proposal = { ...recordBase(project.id), id: "v5-proposal", title: "资料候选", operation: "structured:story-bible", taskKey: "story-bible", scope: "bible", status: "pending", previewMarkdown: "# 资料候选", patches: [], items: [], contextPacketId: "context", model: "test" };
    const agent = { ...recordBase(project.id), id: "v5-agent", status: "completed", goal: "生成故事资料", model: "test", promptVersion: "test", steps: [] };
    const file = { text: async () => JSON.stringify({ manifest: { format: "ymcp-novel", schemaVersion: 5 }, project, documents: [document], proposals: [proposal], agentRuns: [agent] }) } as File;
    await expect(importNovel(file)).resolves.toBe(project.id);
    expect((await novelDb.documents.get(document.id))?.plainText).toBe("新正文");
    expect((await novelDb.proposals.get(proposal.id))?.title).toBe("资料候选");
    expect((await novelDb.agentRuns.get(agent.id))?.goal).toBe("生成故事资料");
  });

  it("upgrades v4 data in place and removes only retired workflow state", async () => {
    novelDb.close();
    await novelDb.delete();
    const legacy = new Dexie(novelDb.name);
    legacy.version(4).stores(V4_STORES);
    await legacy.open();
    const projectId = "legacy-project";
    const proposalId = "legacy-proposal";
    await legacy.table("projects").put({ id: projectId, title: "保留项目", status: "planning", updatedAt: Date.now(), genre: ["悬疑"] });
    await legacy.table("documents").put({ id: "chapter-1", projectId, order: 0, status: "draft", updatedAt: Date.now(), branch: "main", title: "保留正文", plainText: "正文" });
    await legacy.table("proposals").put({ id: proposalId, projectId, status: "pending", createdAt: Date.now(), operation: "structured:project-positioning", taskKey: "project-positioning", scope: "dashboard", projectGenerationRunId: "legacy-run", title: "保留候选" });
    await legacy.table("projectGenerationRuns").put({ id: "legacy-run", projectId, status: "waiting-approval", currentStage: "story-bible", updatedAt: Date.now() });
    legacy.close();

    await novelDb.open();
    expect((await novelDb.projects.get(projectId))?.title).toBe("保留项目");
    expect((await novelDb.documents.get("chapter-1"))?.plainText).toBe("正文");
    const proposal = await novelDb.proposals.get(proposalId) as Record<string, unknown> | undefined;
    expect(proposal?.title).toBe("保留候选");
    expect(proposal).not.toHaveProperty("projectGenerationRunId");
    expect(proposal?.scope).toBe("bible");
    expect(novelDb.tables.some((table) => table.name === "projectGenerationRuns")).toBe(false);
  });

  it("exports v5 backups without retired workflow data", async () => {
    const project = await createNovelProject({ title: "v5 导出", genre: ["悬疑"], premise: "总览只展示当前状态。" });
    let exportedBlob: Blob | undefined;
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ click: () => undefined, href: "", download: "" }) } });
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      exportedBlob = blob as Blob;
      return "blob:test";
    });
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      await exportNovel(project.id, "json");
      expect(exportedBlob).toBeDefined();
      const backup = JSON.parse(await exportedBlob!.text()) as Record<string, unknown> & { manifest: { schemaVersion: number } };
      expect(backup.manifest.schemaVersion).toBe(5);
      expect(backup).not.toHaveProperty("projectGenerationRuns");
    } finally {
      createObjectUrl.mockRestore();
      revokeObjectUrl.mockRestore();
      if (previousDocument) Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

  it("has embeddings table", () => {
    expect(novelDb.embeddings).toBeDefined();
  });

  it("creates a project-level story architecture", async () => {
    const project = await createNovelProject({ title: "Test Story", genre: ["悬疑"], premise: "A locked room opens from the inside." });
    const architecture = await novelDb.architectures.where("projectId").equals(project.id).first();
    expect(architecture).toBeDefined();
    expect(architecture?.centralQuestion).toBe(project.premise);
    expect(architecture?.framework).toBe("free");
    expect(await novelDb.outlineNodes.where("projectId").equals(project.id).count()).toBe(0);
    expect(await novelDb.documents.where("projectId").equals(project.id).count()).toBe(0);
  });

  it("persists architecture phases and approval status", async () => {
    const project = await createNovelProject({ title: "Test Story", genre: ["奇幻"], premise: "A promise outlives a kingdom." });
    const architecture = await novelDb.architectures.where("projectId").equals(project.id).first();
    expect(architecture).toBeDefined();
    const saved = await saveStoryArchitecture({
      ...architecture!,
      status: "approved",
      phases: [{ id: "phase-1", title: "不可逆变化", purpose: "主角公开背叛王国。", turningPoint: "王国宣布追捕主角。", order: 0, locked: true }],
    });
    expect(saved.status).toBe("approved");
    expect((await novelDb.architectures.get(saved.id))?.phases).toHaveLength(1);
  });

  it("can read and write embeddings", async () => {
    const id = crypto.randomUUID();
    await novelDb.embeddings.put({
      id,
      projectId: "p1",
      schemaVersion: RECORD_SCHEMA_VERSION,
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: "test",
      updatedBy: "test",
      targetTable: "entities",
      targetId: "e1",
      model: "test-model",
      dimension: 4,
      vector: [1, 0, 0, 0],
      contentHash: "abcd1234",
    });
    const retrieved = await novelDb.embeddings.get(id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.targetId).toBe("e1");
    expect(retrieved?.vector).toEqual([1, 0, 0, 0]);
  });

  it("supports composite index [projectId+targetTable] on embeddings", async () => {
    await novelDb.embeddings.put({
      id: crypto.randomUUID(),
      projectId: "p1",
      schemaVersion: RECORD_SCHEMA_VERSION,
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: "test",
      updatedBy: "test",
      targetTable: "entities",
      targetId: "e1",
      model: "test",
      dimension: 4,
      vector: [1, 0, 0, 0],
      contentHash: "aaa",
    });
    await novelDb.embeddings.put({
      id: crypto.randomUUID(),
      projectId: "p1",
      schemaVersion: RECORD_SCHEMA_VERSION,
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: "test",
      updatedBy: "test",
      targetTable: "documents",
      targetId: "d1",
      model: "test",
      dimension: 4,
      vector: [0, 1, 0, 0],
      contentHash: "bbb",
    });

    const results = await novelDb.embeddings
      .where("[projectId+targetTable]")
      .equals(["p1", "entities"])
      .toArray();
    expect(results).toHaveLength(1);
    expect(results[0].targetTable).toBe("entities");
  });

  it("supports composite index [projectId+kind] on entities", async () => {
    await novelDb.entities.put({
      ...recordBase("p1"),
      kind: "character",
      name: "Hero",
      aliases: [],
      summary: "",
      description: "",
      tags: [],
      lockedFacts: [],
      attributes: {},
    });
    await novelDb.entities.put({
      ...recordBase("p1"),
      kind: "location",
      name: "Castle",
      aliases: [],
      summary: "",
      description: "",
      tags: [],
      lockedFacts: [],
      attributes: {},
    });

    const characters = await novelDb.entities
      .where("[projectId+kind]")
      .equals(["p1", "character"])
      .toArray();
    expect(characters).toHaveLength(1);
    expect(characters[0].name).toBe("Hero");
  });

  it("supports composite index [projectId+status] on outlineNodes", async () => {
    await novelDb.outlineNodes.put({
      ...recordBase("p1"),
      parentId: undefined,
      kind: "event",
      title: "Event 1",
      summary: "",
      order: 0,
      status: "planned",
      causality: "",
      outcome: "",
      characterIds: [],
      plotThreadIds: [],
      foreshadowingIds: [],
      tension: 30,
      emotion: 30,
      information: 30,
      tags: [],
    });
    await novelDb.outlineNodes.put({
      ...recordBase("p1"),
      parentId: undefined,
      kind: "event",
      title: "Event 2",
      summary: "",
      order: 1,
      status: "resolved",
      causality: "",
      outcome: "",
      characterIds: [],
      plotThreadIds: [],
      foreshadowingIds: [],
      tension: 30,
      emotion: 30,
      information: 30,
      tags: [],
    });

    const planned = await novelDb.outlineNodes
      .where("[projectId+status]")
      .equals(["p1", "planned"])
      .toArray();
    expect(planned).toHaveLength(1);
    expect(planned[0].title).toBe("Event 1");
  });

  it("recordBase writes RECORD_SCHEMA_VERSION", () => {
    const base = recordBase("p1");
    expect(base.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(base.projectId).toBe("p1");
    expect(base.id).toBeDefined();
  });

  it("canvas layout save → reload → restore round-trip", async () => {
    const project = await createNovelProject({ title: "画布项目", genre: ["悬疑"], premise: "画布持久化测试。" });
    const viewport = { x: 120, y: 80, k: 1.5 };
    const nodes = [
      { id: "char-1", kind: "character", position: { x: 200, y: 100 }, width: 240, height: 160 },
      { id: "char-2", kind: "character", position: { x: 600, y: 100 }, width: 240, height: 160 },
    ];
    const edges = [
      { id: "edge-1", fromNodeId: "char-1", toNodeId: "char-2", label: "盟友", kind: "relation" },
    ];

    const saved = await saveCanvasLayout(project.id, "character-canvas", { viewport, nodes, edges });
    expect(saved.panelKey).toBe("character-canvas");
    expect(saved.projectId).toBe(project.id);
    expect(saved.revision).toBe(1);
    expect(saved.viewport).toEqual(viewport);
    expect(saved.nodes).toHaveLength(2);
    expect(saved.edges).toHaveLength(1);

    const reloaded = await getCanvasLayout(project.id, "character-canvas");
    expect(reloaded).toBeDefined();
    expect(reloaded?.viewport).toEqual(viewport);
    expect(reloaded?.nodes[0].position).toEqual({ x: 200, y: 100 });
    expect(reloaded?.edges[0].label).toBe("盟友");

    const updated = await saveCanvasLayout(project.id, "character-canvas", {
      viewport: { x: 0, y: 0, k: 1 },
      nodes: [{ id: "char-1", kind: "character", position: { x: 0, y: 0 }, width: 200, height: 120 }],
      edges: [],
    });
    expect(updated.revision).toBe(2);
    expect(updated.viewport.k).toBe(1);
    expect(updated.nodes).toHaveLength(1);
    expect(updated.edges).toHaveLength(0);

    const afterUpdate = await getCanvasLayout(project.id, "character-canvas");
    expect(afterUpdate?.revision).toBe(2);
    expect(afterUpdate?.nodes).toHaveLength(1);
  });

  it("canvas layout isolates by panelKey via [projectId+panelKey] composite index", async () => {
    const project = await createNovelProject({ title: "多面板", genre: ["奇幻"], premise: "隔离测试。" });
    await saveCanvasLayout(project.id, "character-canvas", {
      viewport: { x: 0, y: 0, k: 1 },
      nodes: [{ id: "n1", kind: "character", position: { x: 0, y: 0 }, width: 200, height: 120 }],
      edges: [],
    });
    await saveCanvasLayout(project.id, "timeline-canvas", {
      viewport: { x: 50, y: 50, k: 2 },
      nodes: [{ id: "t1", kind: "event", position: { x: 100, y: 100 }, width: 180, height: 100 }],
      edges: [],
    });

    const character = await getCanvasLayout(project.id, "character-canvas");
    const timeline = await getCanvasLayout(project.id, "timeline-canvas");
    expect(character?.nodes[0].id).toBe("n1");
    expect(timeline?.nodes[0].id).toBe("t1");
    expect(character?.viewport.k).toBe(1);
    expect(timeline?.viewport.k).toBe(2);

    const all = await novelDb.canvasLayouts.where("projectId").equals(project.id).toArray();
    expect(all).toHaveLength(2);
  });
});
