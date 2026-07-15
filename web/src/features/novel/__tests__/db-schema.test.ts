import { beforeEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import "./setup";
import { createNovelProject, getCanvasLayout, novelDb, recordBase, saveCanvasLayout, saveStoryArchitecture } from "../db";
import { DB_VERSION, RECORD_SCHEMA_VERSION, V4_STORES, V5_STORES, V6_STORES, V7_STORES, V8_STORES, V9_STORES, V10_STORES, V11_STORES, V16_STORES } from "../db-schema";
import { exportNovel, importNovel, verifyProjectArchive } from "../export";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
});

describe("db-schema constants", () => {
  it("DB_VERSION is 16", () => {
    expect(DB_VERSION).toBe(16);
  });

  it("RECORD_SCHEMA_VERSION is 6", () => {
    expect(RECORD_SCHEMA_VERSION).toBe(6);
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

  it("V7_STORES keeps the v6 indexes while migrating architecture data", () => {
    expect(V7_STORES).toEqual(V6_STORES);
  });

  it("V8_STORES adds the append-only truth and character-knowledge ledgers", () => {
    expect(V8_STORES.factAssertions).toContain("[projectId+status]");
    expect(V8_STORES.factAssertions).toContain("sourceRevisionId");
    expect(V8_STORES.knowledgeAssertions).toContain("[projectId+characterId]");
  });

  it("V9_STORES adds narrative ownership and hierarchical derived memory", () => {
    expect(V9_STORES.narrativeUnits).toContain("[projectId+kind]");
    expect(V9_STORES.outlineRealizations).toContain("[projectId+documentId]");
    expect(V9_STORES.derivedMemories).toContain("[projectId+level]");
    expect(V9_STORES.derivedMemories).toContain("sourceRevisionId");
  });

  it("V10_STORES adds revision-bound manuscript changes", () => {
    expect(V10_STORES.manuscriptChanges).toContain("[documentId+status]");
    expect(V10_STORES.manuscriptChanges).toContain("[workflowRunId+status]");
  });

  it("V11_STORES keeps the v10 indexes for the data-cleanup migration", () => {
    expect(V11_STORES).toEqual(V10_STORES);
  });

  it("V16_STORES retains durable conversation and memory-job indexes", () => {
    expect(V16_STORES.conversationThreads).toContain("[projectId+targetId]");
    expect(V16_STORES.memoryJobs).toContain("[status+availableAt]");
  });
});

describe("database v9 schema", () => {
  it("opens successfully at v9 with truth and memory tables and without the retired table", () => {
    expect(novelDb.isOpen()).toBe(true);
    expect(novelDb.verno).toBe(DB_VERSION);
    expect(novelDb.name).toBe("ymcp-novel-db-v4");
    expect(novelDb.tables.some((table) => table.name === "projectGenerationRuns")).toBe(false);
    expect(novelDb.tables.some((table) => table.name === "canvasLayouts")).toBe(true);
    expect(novelDb.tables.some((table) => table.name === "factAssertions")).toBe(true);
    expect(novelDb.tables.some((table) => table.name === "knowledgeAssertions")).toBe(true);
    expect(novelDb.tables.some((table) => table.name === "narrativeUnits")).toBe(true);
    expect(novelDb.tables.some((table) => table.name === "outlineRealizations")).toBe(true);
    expect(novelDb.tables.some((table) => table.name === "derivedMemories")).toBe(true);
  });

  it("rejects project imports older than v4", async () => {
    const file = { text: async () => JSON.stringify({ manifest: { format: "ymcp-novel", schemaVersion: 3 }, project: { id: "legacy" } }) } as File;
    await expect(importNovel(file)).rejects.toThrow(/v4-v11/);
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

  it("removes reader promises from imported architectures and proposals", async () => {
    const project = await createNovelProject({ title: "旧架构导入", genre: ["悬疑"], premise: "旧字段不再使用。" });
    const currentArchitecture = await novelDb.architectures.where("projectId").equals(project.id).first();
    expect(currentArchitecture).toBeDefined();
    const architecture = { ...currentArchitecture!, readerPromise: "旧读者承诺" };
    const proposal = {
      ...recordBase(project.id),
      id: "legacy-architecture-proposal",
      title: "旧架构候选",
      operation: "structured:architecture",
      taskKey: "architecture",
      scope: "architecture",
      status: "pending",
      previewMarkdown: "",
      patches: [],
      contextPacketId: "context",
      model: "test",
      items: [{ id: "item-1", label: "架构", operation: "update", targetTable: "architectures", targetId: architecture.id, status: "pending", dependencies: [], payload: { centralConflict: "新冲突", readerPromise: "旧读者承诺" }, after: { centralConflict: "新冲突", readerPromise: "旧读者承诺" } }],
    };
    const file = { text: async () => JSON.stringify({ manifest: { format: "ymcp-novel", schemaVersion: 5 }, project, architectures: [architecture], proposals: [proposal] }) } as File;
    await importNovel(file);
    expect(await novelDb.architectures.get(architecture.id) as unknown as Record<string, unknown>).not.toHaveProperty("readerPromise");
    const importedProposal = await novelDb.proposals.get(proposal.id) as unknown as Record<string, unknown>;
    expect(((importedProposal.items as Array<Record<string, unknown>>)[0].payload as Record<string, unknown>)).not.toHaveProperty("readerPromise");
  });

  it("normalizes removed fields and orphaned references from older imports", async () => {
    const project = await createNovelProject({ title: "旧引用导入", genre: ["悬疑"], premise: "旧数据需要清理。" });
    const character = { ...recordBase(project.id), id: "import-character", kind: "character", name: "导入角色", aliases: [], summary: "", description: "", tags: [], lockedFacts: [], attributes: {} };
    const thread = { ...recordBase(project.id), id: "import-thread", kind: "main", title: "导入主线", summary: "", status: "planned", priority: 50, participantIds: [character.id, "missing-entity"], progress: 0, nextMove: "" };
    const clue = { ...recordBase(project.id), id: "import-clue", title: "导入伏笔", clue: "", truth: "", status: "seeded", urgency: 50, notes: "" };
    const outline = { ...recordBase(project.id), id: "import-outline", kind: "event", title: "导入事件", summary: "", order: 0, status: "planned", characterIds: [character.id, "missing-character"], plotThreadIds: [thread.id, "missing-thread"], foreshadowingIds: [clue.id, "human_rule_foreshadowing"], tension: 70, emotion: 60, information: 50, tags: [] };
    const file = { text: async () => JSON.stringify({ manifest: { format: "ymcp-novel", schemaVersion: 8 }, project, entities: [character], plotThreads: [thread], foreshadowing: [clue], outlineNodes: [outline] }) } as File;

    await importNovel(file);

    const imported = await novelDb.outlineNodes.get(outline.id) as unknown as Record<string, unknown>;
    expect(imported).not.toHaveProperty("tension");
    expect(imported.characterIds).toEqual([character.id]);
    expect(imported.plotThreadIds).toEqual([thread.id]);
    expect(imported.foreshadowingIds).toEqual([clue.id]);
    expect((await novelDb.plotThreads.get(thread.id))?.participantIds).toEqual([character.id]);
  });

  it("removes reader promises when upgrading v6 data", async () => {
    novelDb.close();
    await novelDb.delete();
    const legacy = new Dexie(novelDb.name);
    legacy.version(6).stores(V6_STORES);
    await legacy.open();
    await legacy.table("architectures").put({ id: "legacy-architecture", projectId: "legacy-project", status: "draft", updatedAt: Date.now(), centralQuestion: "问题", centralConflict: "冲突", readerPromise: "旧读者承诺", synopsis: "梗概", phases: [] });
    await legacy.table("proposals").put({ id: "legacy-proposal", projectId: "legacy-project", status: "pending", createdAt: Date.now(), items: [{ id: "item-1", payload: { readerPromise: "旧读者承诺" }, before: { readerPromise: "旧值" }, after: { readerPromise: "新值" } }] });
    legacy.close();

    await novelDb.open();
    expect(await novelDb.architectures.get("legacy-architecture") as unknown as Record<string, unknown>).not.toHaveProperty("readerPromise");
    const proposal = await novelDb.proposals.get("legacy-proposal") as unknown as Record<string, unknown>;
    const item = (proposal.items as Array<Record<string, unknown>>)[0];
    expect(item.payload).not.toHaveProperty("readerPromise");
    expect(item.before).not.toHaveProperty("readerPromise");
    expect(item.after).not.toHaveProperty("readerPromise");
  });

  it("upgrades v10 data by removing outline intensity fields and orphaned references", async () => {
    novelDb.close();
    await novelDb.delete();
    const legacy = new Dexie(novelDb.name);
    legacy.version(10).stores(V10_STORES);
    await legacy.open();
    const projectId = "reference-project";
    const otherProjectId = "other-project";
    await legacy.table("entities").bulkPut([
      { id: "character-valid", projectId, kind: "character", name: "有效角色" },
      { id: "location-valid", projectId, kind: "location", name: "有效地点" },
      { id: "character-cross-project", projectId: otherProjectId, kind: "character", name: "其他项目角色" },
    ]);
    await legacy.table("plotThreads").put({ id: "thread-valid", projectId, kind: "main", status: "active", priority: 80, participantIds: ["character-valid", "location-valid", "character-cross-project", "missing-entity"] });
    await legacy.table("foreshadowing").put({ id: "clue-valid", projectId, status: "seeded", urgency: 50 });
    await legacy.table("outlineNodes").put({
      id: "outline-legacy", projectId, kind: "event", order: 0, status: "planned",
      characterIds: ["character-valid", "location-valid", "character-cross-project", "missing-character", "character-valid"],
      plotThreadIds: ["thread-valid", "survival_thread"],
      foreshadowingIds: ["clue-valid", "human_rule_foreshadowing"],
      tension: 70, emotion: 65, information: 60,
    });
    await legacy.table("scenes").put({
      id: "scene-legacy", projectId, chapterId: "chapter-legacy", order: 0, status: "planned",
      characterIds: ["character-valid", "missing-character"], plotThreadIds: ["thread-valid", "missing-thread"],
      foreshadowingIds: ["clue-valid", "missing-clue"], povCharacterId: "missing-character",
    });
    await legacy.table("documents").put({
      id: "chapter-legacy", projectId, order: 0, status: "outline", branch: "main", updatedAt: Date.now(),
      blueprint: { characterIds: ["character-valid", "missing-character"], povCharacterId: "missing-character" },
    });
    await legacy.table("timelineEvents").put({ id: "timeline-legacy", projectId, narrativeOrder: 0, participantIds: ["character-valid", "location-valid", "missing-entity"] });
    await legacy.table("proposals").put({
      id: "proposal-legacy", projectId, status: "pending", createdAt: Date.now(), items: [{
        id: "outline-item", targetTable: "outlineNodes", payload: {
          characterIds: ["character-valid", "missing-character", "ref:new-character"],
          plotThreadIds: ["thread-valid", "survival_thread"],
          foreshadowingIds: ["clue-valid", "human_rule_foreshadowing"],
          tension: 80, emotion: 70, information: 60,
        },
      }],
    });
    legacy.close();

    await novelDb.open();

    const outline = await novelDb.outlineNodes.get("outline-legacy") as unknown as Record<string, unknown>;
    expect(outline).not.toHaveProperty("tension");
    expect(outline).not.toHaveProperty("emotion");
    expect(outline).not.toHaveProperty("information");
    expect(outline.characterIds).toEqual(["character-valid"]);
    expect(outline.plotThreadIds).toEqual(["thread-valid"]);
    expect(outline.foreshadowingIds).toEqual(["clue-valid"]);
    expect(await novelDb.scenes.get("scene-legacy")).toMatchObject({ characterIds: ["character-valid"], plotThreadIds: ["thread-valid"], foreshadowingIds: ["clue-valid"], povCharacterId: undefined });
    expect((await novelDb.documents.get("chapter-legacy"))?.blueprint).toMatchObject({ characterIds: ["character-valid"], povCharacterId: undefined });
    expect((await novelDb.plotThreads.get("thread-valid"))?.participantIds).toEqual(["character-valid", "location-valid"]);
    expect((await novelDb.timelineEvents.get("timeline-legacy"))?.participantIds).toEqual(["character-valid", "location-valid"]);
    const proposal = await novelDb.proposals.get("proposal-legacy") as unknown as Record<string, unknown>;
    const payload = ((proposal.items as Array<Record<string, unknown>>)[0].payload as Record<string, unknown>);
    expect(payload).not.toHaveProperty("tension");
    expect(payload.characterIds).toEqual(["character-valid", "ref:new-character"]);
    expect(payload.plotThreadIds).toEqual(["thread-valid"]);
    expect(payload.foreshadowingIds).toEqual(["clue-valid"]);
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

  it("exports v9 integrity-checked archives with all formal ledgers", async () => {
    const project = await createNovelProject({ title: "v7 导出", genre: ["悬疑"], premise: "总览只展示当前状态。" });
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
      expect(backup.manifest.schemaVersion).toBe(11);
      expect(backup).toHaveProperty("factAssertions");
      expect(backup).toHaveProperty("knowledgeAssertions");
      expect(backup).toHaveProperty("narrativeUnits");
      expect(backup).toHaveProperty("outlineRealizations");
      expect(backup).toHaveProperty("derivedMemories");
      expect(backup).toHaveProperty("manuscriptChanges");
      expect(backup.manifest).toHaveProperty("integrity");
      expect(verifyProjectArchive(backup)).toBe(true);
      backup.project = { ...(backup.project as Record<string, unknown>), title: "被篡改" };
      expect(() => verifyProjectArchive(backup)).toThrow(/校验失败：project/);
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
      characterIds: [],
      plotThreadIds: [],
      foreshadowingIds: [],
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
      characterIds: [],
      plotThreadIds: [],
      foreshadowingIds: [],
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
