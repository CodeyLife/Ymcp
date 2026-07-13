import { beforeEach, describe, expect, it } from "vitest";
import "./setup";
import { createNovelProject, novelDb, recordBase, saveStoryArchitecture } from "../db";
import { DB_VERSION, RECORD_SCHEMA_VERSION, V4_STORES } from "../db-schema";
import { importNovel } from "../export";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
});

describe("db-schema constants", () => {
  it("DB_VERSION is 4", () => {
    expect(DB_VERSION).toBe(4);
  });

  it("RECORD_SCHEMA_VERSION is 4", () => {
    expect(RECORD_SCHEMA_VERSION).toBe(4);
  });

  it("V4_STORES includes architecture, automation, and embeddings tables", () => {
    expect(V4_STORES.architectures).toBeDefined();
    expect(V4_STORES.projectGenerationRuns).toBeDefined();
    expect(V4_STORES.embeddings).toContain("[projectId+targetTable]");
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
});

describe("database v4 schema", () => {
  it("opens successfully at v4", () => {
    expect(novelDb.isOpen()).toBe(true);
    expect(novelDb.verno).toBe(DB_VERSION);
    expect(novelDb.name).toBe("ymcp-novel-db-v4");
  });

  it("rejects v3 project imports", async () => {
    const file = { text: async () => JSON.stringify({ manifest: { format: "ymcp-novel", schemaVersion: 3 }, project: { id: "legacy" } }) } as File;
    await expect(importNovel(file)).rejects.toThrow(/v4/);
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
});
