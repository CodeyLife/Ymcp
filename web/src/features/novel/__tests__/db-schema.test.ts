import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";
import "./setup";

import { createNovelProject, getCanvasLayout, novelDb, recordBase, saveCanvasLayout, saveStoryArchitecture } from "../db";
import { DB_VERSION, RECORD_SCHEMA_VERSION, V17_STORES, V18_STORES } from "../db-schema";
import { importNovel, verifyProjectArchive } from "../export";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
});

describe("db-schema v18", () => {
  it("uses the phase/plot-segment/chapter indexes", () => {
    expect(DB_VERSION).toBe(18);
    expect(RECORD_SCHEMA_VERSION).toBe(8);
    expect(V18_STORES.outlineNodes).toContain("phaseId");
    expect(V18_STORES.outlineNodes).toContain("[projectId+phaseId]");
    expect(V18_STORES.outlineNodes).not.toContain("kind");
    expect(V18_STORES.outlineNodes).not.toContain("parentId");
    expect(V18_STORES.documents).toContain("plotSegmentId");
    expect(V18_STORES.documents).toContain("[projectId+plotSegmentId]");
  });

  it("discards legacy outline data and pending planning proposals while preserving chapters", async () => {
    novelDb.close();
    await novelDb.delete();
    const legacy = new Dexie(novelDb.name);
    legacy.version(17).stores(V17_STORES);
    await legacy.open();
    await legacy.table("outlineNodes").bulkPut([
      { id: "legacy-act", projectId: "p18", schemaVersion: 7, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test", kind: "act", title: "旧幕", summary: "", order: 0 },
      { id: "legacy-event", projectId: "p18", schemaVersion: 7, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test", parentId: "legacy-act", kind: "event", title: "旧事件", summary: "", order: 0, characterIds: [], plotThreadIds: [], foreshadowingIds: [] },
    ]);
    await legacy.table("outlineRealizations").put({ id: "realization", projectId: "p18", outlineNodeId: "legacy-event", documentId: "chapter", status: "planned" });
    await legacy.table("documents").put({ id: "chapter", projectId: "p18", schemaVersion: 7, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test", order: 0, title: "保留章节", summary: "", status: "outline", branch: "main", contentHtml: "", plainText: "", wordCount: 0, yjsDocumentId: "y", blueprint: { objective: "", locationIds: [], characterIds: [], conflict: "", informationRelease: [], mustHappen: [], flexible: [], forbidden: [], targetWords: 5000 } });
    await legacy.table("proposals").bulkPut([
      { id: "pending-outline", projectId: "p18", status: "pending", taskKey: "outline", createdAt: 1 },
      { id: "pending-plot", projectId: "p18", status: "pending", taskKey: "plot-design", createdAt: 1 },
      { id: "pending-character", projectId: "p18", status: "pending", taskKey: "characters", createdAt: 1 },
      { id: "accepted-outline", projectId: "p18", status: "accepted", taskKey: "outline", createdAt: 1 },
    ]);
    legacy.close();

    await novelDb.open();

    expect(await novelDb.outlineNodes.count()).toBe(0);
    expect(await novelDb.outlineRealizations.count()).toBe(0);
    expect(await novelDb.proposals.get("pending-outline")).toBeUndefined();
    expect(await novelDb.proposals.get("pending-plot")).toBeUndefined();
    expect(await novelDb.proposals.get("pending-character")).toBeDefined();
    expect(await novelDb.proposals.get("accepted-outline")).toBeDefined();
    const chapter = await novelDb.documents.get("chapter");
    expect(chapter?.title).toBe("保留章节");
    expect(chapter?.schemaVersion).toBe(8);
    expect(chapter?.blueprint.plotThreadIds).toEqual([]);
    expect(chapter?.blueprint.foreshadowingIds).toEqual([]);
  });

  it("opens with all current tables", () => {
    expect(novelDb.isOpen()).toBe(true);
    expect(novelDb.verno).toBe(DB_VERSION);
    expect(novelDb.tables.some((table) => table.name === "outlineNodes")).toBe(true);
    expect(novelDb.tables.some((table) => table.name === "documents")).toBe(true);
    expect(novelDb.tables.some((table) => table.name === "outlineRealizations")).toBe(true);
  });
});

describe("current archive and records", () => {
  it("rejects legacy project archives", async () => {
    const file = { text: async () => JSON.stringify({ manifest: { format: "ymcp-novel", schemaVersion: 12 }, project: { id: "legacy" } }) } as File;
    await expect(importNovel(file)).rejects.toThrow(/v13/);
  });

  it("verifies current archive integrity", () => {
    const value = [{ id: "one" }];
    let hash = 2166136261;
    const serialized = JSON.stringify(value);
    for (let index = 0; index < serialized.length; index += 1) hash = Math.imul(hash ^ serialized.charCodeAt(index), 16777619);
    expect(verifyProjectArchive({ documents: value, manifest: { integrity: { algorithm: "fnv1a-32", tables: { documents: { count: 1, hash: (hash >>> 0).toString(16).padStart(8, "0") } } } } })).toBe(true);
  });

  it("creates and saves architecture phases as the only acts", async () => {
    const project = await createNovelProject({ title: "架构", genre: ["悬疑"], premise: "记忆会说谎。" });
    const architecture = (await novelDb.architectures.where("projectId").equals(project.id).first())!;
    await saveStoryArchitecture({ ...architecture, status: "approved", phases: [{ id: "phase", title: "第一幕", purpose: "建立困境", turningPoint: "离开故乡", order: 7, locked: false }] });
    const saved = await novelDb.architectures.get(architecture.id);
    expect(saved?.phases).toEqual([{ id: "phase", title: "第一幕", purpose: "建立困境", turningPoint: "离开故乡", order: 0, locked: false }]);
    expect(await novelDb.outlineNodes.where("projectId").equals(project.id).count()).toBe(0);
  });

  it("queries plot segments by project and phase", async () => {
    const project = await createNovelProject({ title: "索引", genre: ["都市"], premise: "城市分层。" });
    await novelDb.outlineNodes.bulkAdd([
      { ...recordBase(project.id), phaseId: "phase-a", title: "A", summary: "", order: 0 },
      { ...recordBase(project.id), phaseId: "phase-b", title: "B", summary: "", order: 0 },
    ]);
    expect((await novelDb.outlineNodes.where("[projectId+phaseId]").equals([project.id, "phase-a"]).toArray()).map((item) => item.title)).toEqual(["A"]);
  });

  it("recordBase writes the current record schema version", () => {
    expect(recordBase("project").schemaVersion).toBe(RECORD_SCHEMA_VERSION);
  });

  it("persists canvas layouts independently", async () => {
    const project = await createNovelProject({ title: "画布", genre: ["科幻"], premise: "节点必须可恢复。" });
    await saveCanvasLayout(project.id, "character-canvas", { nodes: [], edges: [], viewport: { x: 3, y: 4, k: 1.2 } });
    expect(await getCanvasLayout(project.id, "character-canvas")).toMatchObject({ panelKey: "character-canvas", viewport: { x: 3, y: 4, k: 1.2 } });
  });
});
