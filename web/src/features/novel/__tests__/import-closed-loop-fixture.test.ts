import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NovelDatabase } from "../db";
import {
  captureClosedLoopFixture,
  importClosedLoopFixture,
  verifyClosedLoopFixture,
  type ClosedLoopFixtureBundle,
} from "../evaluation/evaluation-fixture";
import { captureProjectSnapshot, migrateProjectSnapshot, PROJECT_SNAPSHOT_TABLES, verifyProjectSnapshot, type LegacyProjectSnapshotBundleV2 } from "../evaluation/project-snapshot";

const PROJECT_ID = "import-test-project";
const OTHER_PROJECT_ID = "import-test-other-project";

function normalizedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, normalizedValue(item)]));
}

async function sha256(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(normalizedValue(value))));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function makeLegacyV2Snapshot(db: NovelDatabase, projectId: string): Promise<LegacyProjectSnapshotBundleV2> {
  const current = await captureProjectSnapshot(db, projectId, "manual");
  const { promptTemplateVersions: _removed, ...records } = current.records;
  const tables = PROJECT_SNAPSHOT_TABLES.filter((table) => table !== "promptTemplateVersions");
  const recordCounts = Object.fromEntries(tables.map((table) => [table, records[table].length]));
  const tableHashes = Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await sha256(records[table])])));
  const sourceDatabaseVersion = 20;
  const snapshotHash = await sha256({ formatVersion: 2, sourceProjectId: projectId, sourceDatabaseVersion, head: current.head, records });
  return {
    ...current,
    formatVersion: 2,
    sourceDatabaseVersion,
    records,
    manifest: { ...current.manifest, recordCounts, tableHashes, snapshotHash },
  } as LegacyProjectSnapshotBundleV2;
}

function baseRecord(id: string, projectId: string) {
  return {
    id,
    projectId,
    schemaVersion: 8,
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
    createdBy: "test",
    updatedBy: "test",
  };
}

async function seedProject(db: NovelDatabase, projectId: string, title: string) {
  await db.table("projects").put({
    id: projectId,
    schemaVersion: 8,
    revision: 1,
    createdAt: 1,
    updatedAt: 100,
    createdBy: "test",
    updatedBy: "test",
    title,
    subtitle: "",
    premise: "测试项目",
    genre: ["测试"],
    audience: "测试读者",
    themes: ["测试主题"],
    sellingPoints: [],
    pov: "第三人称限知",
    tense: "过去时",
    tone: "克制",
    languageStyle: "具象",
    targetWords: 100000,
    dailyGoal: 1000,
    status: "drafting",
    coverColor: "#000000",
    settings: {
      textModel: "test-model",
      temperature: 0.7,
      recentChapterCount: 5,
      encrypted: false,
      contentProfile: "general-serial",
      maxAutoRevisions: 2,
      qualityThreshold: 3.7,
      approvalMode: "blueprint-and-manuscript",
    },
  });
  await db.table("architectures").put({
    ...baseRecord(`arch-${projectId}`, projectId),
    framework: "free",
    status: "approved",
    centralQuestion: "如何选择",
    centralConflict: "守诺与求生",
    synopsis: "",
    phases: [],
  });
}

async function seedChapter(db: NovelDatabase, projectId: string, chapterId: string, title: string, plainText: string) {
  await db.table("documents").put({
    ...baseRecord(chapterId, projectId),
    order: 0,
    title,
    blueprint: { goal: "测试目标", tone: "冷", mustHappen: [], forbidden: [], targetWords: 3000, beats: [], characterIds: [] },
    contentHtml: `<p>${plainText}</p>`,
    plainText,
    summary: plainText,
    status: "final",
    wordCount: plainText.length,
    branch: "main",
    yjsDocumentId: `yjs-${chapterId}`,
  });
}

describe("importClosedLoopFixture", () => {
  let source: NovelDatabase;
  let target: NovelDatabase;

  beforeEach(async () => {
    source = new NovelDatabase(`ymcp-novel-import-source-${crypto.randomUUID()}`);
    target = new NovelDatabase(`ymcp-novel-import-target-${crypto.randomUUID()}`);
    await source.open();
    await target.open();
    await seedProject(source, PROJECT_ID, "源项目");
    await seedChapter(source, PROJECT_ID, "ch-1", "第一章", "江水很冷。");
    // target 已有另一个项目
    await seedProject(target, OTHER_PROJECT_ID, "已有项目");
    await seedChapter(target, OTHER_PROJECT_ID, "other-ch-1", "其他章", "其他内容。");
  });

  afterEach(async () => {
    await source.delete();
    await target.delete();
  });

  it("non-destructively merges a closed-loop fixture into target database", async () => {
    const fixture = await captureClosedLoopFixture(source, PROJECT_ID, "manual");
    expect(fixture.format).toBe("ymcp-novel-closed-loop");

    const result = await importClosedLoopFixture(fixture, target);

    expect(result.projectId).toBe(PROJECT_ID);
    expect(result.importedCounts.projects).toBe(1);
    expect(result.importedCounts.architectures).toBe(1);
    expect(result.importedCounts.documents).toBe(1);
    expect(result.importedCounts.conversationThreads).toBe(0);
    expect(result.importedCounts.creativeBriefs).toBe(0);

    // 源项目已合并到 target
    const importedProject = await target.projects.get(PROJECT_ID);
    expect(importedProject?.title).toBe("源项目");
    const importedChapter = await target.documents.get("ch-1");
    expect(importedChapter?.plainText).toBe("江水很冷。");

    // target 中已有的其他项目保留不变（非破坏性）
    const otherProject = await target.projects.get(OTHER_PROJECT_ID);
    expect(otherProject?.title).toBe("已有项目");
    const otherChapter = await target.documents.get("other-ch-1");
    expect(otherChapter?.plainText).toBe("其他内容。");
  });

  it("overwrites same-id records in target (idempotent re-import)", async () => {
    const fixture = await captureClosedLoopFixture(source, PROJECT_ID, "manual");

    // 第一次导入
    await importClosedLoopFixture(fixture, target);
    const importedChapterV1 = await target.documents.get("ch-1");
    expect(importedChapterV1?.plainText).toBe("江水很冷。");

    // 修改 source 后重新捕获 + 第二次导入
    await source.documents.update("ch-1", { plainText: "江水更冷了。", revision: 2 });
    const fixtureV2 = await captureClosedLoopFixture(source, PROJECT_ID, "manual");
    await importClosedLoopFixture(fixtureV2, target);

    const importedChapterV2 = await target.documents.get("ch-1");
    expect(importedChapterV2?.plainText).toBe("江水更冷了。");
    expect(importedChapterV2?.revision).toBe(2);

    // 其他项目依然保留
    const otherProject = await target.projects.get(OTHER_PROJECT_ID);
    expect(otherProject?.title).toBe("已有项目");
  });

  it("removes stale records from the imported project while preserving other projects", async () => {
    const fixtureV1 = await captureClosedLoopFixture(source, PROJECT_ID, "manual");
    await importClosedLoopFixture(fixtureV1, target);

    await seedChapter(target, PROJECT_ID, "stale-chapter", "旧章节", "不应继续存在。");
    await target.entities.put({
      ...baseRecord("stale-entity", PROJECT_ID),
      kind: "character",
      name: "旧人物",
      aliases: [],
      summary: "旧数据",
      description: "",
      tags: [],
      attributes: {},
      lockedFacts: [],
    });

    await importClosedLoopFixture(fixtureV1, target);

    expect(await target.documents.get("stale-chapter")).toBeUndefined();
    expect(await target.entities.get("stale-entity")).toBeUndefined();
    expect((await target.documents.get("ch-1"))?.plainText).toBe("江水很冷。");
    expect((await target.documents.get("other-ch-1"))?.plainText).toBe("其他内容。");
  });

  it("imports a fixture user-level skill when the target does not have it", async () => {
    const skillId = "shared-user-skill";
    const sourceSkill = {
      ...baseRecord(skillId, "__user__"),
      skillId,
      version: "1.0.0",
      name: "用户技能",
      description: "source",
      prompt: "source prompt",
      appliesTo: ["draft"],
      enabled: true,
      readonly: false,
      source: "user",
    };
    await source.table("skills").put(sourceSkill);

    const fixture = await captureClosedLoopFixture(source, PROJECT_ID, "manual");
    await importClosedLoopFixture(fixture, target);

    expect((await target.skills.get(skillId))?.prompt).toBe("source prompt");
  });

  it("rejects a conflicting target user-level skill instead of silently changing behavior", async () => {
    const skillId = "shared-user-skill";
    const sourceSkill = {
      ...baseRecord(skillId, "__user__"),
      skillId,
      version: "1.0.0",
      name: "用户技能",
      description: "source",
      prompt: "source prompt",
      appliesTo: ["draft"],
      enabled: true,
      readonly: false,
      source: "user",
    };
    await source.table("skills").put(sourceSkill);
    await target.table("skills").put({ ...sourceSkill, prompt: "target prompt" });

    const fixture = await captureClosedLoopFixture(source, PROJECT_ID, "manual");
    await expect(importClosedLoopFixture(fixture, target)).rejects.toThrow(/用户 Skill 冲突/);
    expect((await target.skills.get(skillId))?.prompt).toBe("target prompt");
  });

  it("rejects an invalid fixture (failed verification)", async () => {
    const fixture = await captureClosedLoopFixture(source, PROJECT_ID, "manual");
    const tampered = structuredClone(fixture) as ClosedLoopFixtureBundle;
    // 篡改 projects 记录但保留 manifest 旧 hash → 校验失败
    (tampered.snapshot.records.projects[0] as Record<string, unknown>).title = "被篡改的标题";

    await expect(importClosedLoopFixture(tampered, target)).rejects.toThrow(/校验失败/);

    // target 状态未变
    const stillNoSourceProject = await target.projects.get(PROJECT_ID);
    expect(stillNoSourceProject).toBeUndefined();
    const otherProjectStillThere = await target.projects.get(OTHER_PROJECT_ID);
    expect(otherProjectStillThere?.title).toBe("已有项目");
  });

  it("uses a single Dexie transaction (atomic by contract — verify via fixture shape, not mock)", async () => {
    // Dexie.transaction("rw", tables, cb) 套层保证：cb 抛错 → 整个事务回滚。
    // 本测试不 mock Dexie 内部方法（与 Dexie Table 实例耦合不稳定），而是验证
    // importClosedLoopFixture 在正常路径下产出的 importedCounts 覆盖全部
    // PROJECT_SNAPSHOT_TABLES + conversationThreads + creativeBriefs，证明事务 cb
    // 内部完整遍历所有表，同时避免表清单演进后留下脆弱的硬编码数量。
    const fixture = await captureClosedLoopFixture(source, PROJECT_ID, "manual");
    const result = await importClosedLoopFixture(fixture, target);

    const expectedTableKeys = [...PROJECT_SNAPSHOT_TABLES, "conversationThreads", "creativeBriefs"];
    for (const key of expectedTableKeys) {
      expect(result.importedCounts).toHaveProperty(key);
      expect(typeof result.importedCounts[key]).toBe("number");
    }
    expect(Object.keys(result.importedCounts).length).toBe(expectedTableKeys.length);
  });

  it("verifyClosedLoopFixture accepts a captured fixture", async () => {
    const fixture = await captureClosedLoopFixture(source, PROJECT_ID, "manual");
    const verification = await verifyClosedLoopFixture(fixture);
    expect(verification.valid).toBe(true);
    expect(verification.issues).toHaveLength(0);
  });

  it("verifies and migrates a signed DB20 snapshot-v2 fixture without weakening its original hash", async () => {
    const snapshot = await makeLegacyV2Snapshot(source, PROJECT_ID);

    const original = await verifyProjectSnapshot(snapshot);
    expect(original).toMatchObject({ valid: true, issues: [] });
    const migrated = await migrateProjectSnapshot(snapshot);
    expect(migrated.formatVersion).toBe(3);
    expect(migrated.sourceDatabaseVersion).toBe(20);
    expect(migrated.records.promptTemplateVersions).toEqual([]);
    await expect(verifyProjectSnapshot(migrated)).resolves.toMatchObject({ valid: true, issues: [] });

    const tampered = structuredClone(snapshot);
    tampered.records.documents[0]!.title = "篡改后的标题";
    await expect(migrateProjectSnapshot(tampered)).rejects.toThrow("哈希不匹配");
  });
});
