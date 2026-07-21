import Dexie, { type Table } from "dexie";
import type { NovelDatabase } from "../db";
import type { CreativeBrief, NovelConversationThread } from "../types";
import {
  captureProjectSnapshot,
  migrateProjectSnapshot,
  PROJECT_SNAPSHOT_TABLES,
  verifyProjectSnapshot,
  type ProjectSnapshotBundle,
  type SnapshotReason,
} from "./project-snapshot";

export const CLOSED_LOOP_FIXTURE_FORMAT_VERSION = 1;

export interface ClosedLoopFixtureBundle {
  format: "ymcp-novel-closed-loop";
  formatVersion: 1;
  snapshot: ProjectSnapshotBundle;
  conversationThreads: NovelConversationThread[];
  creativeBriefs: CreativeBrief[];
}

export interface ClosedLoopFixtureVerification {
  valid: boolean;
  issues: string[];
}

export async function captureClosedLoopFixture(
  db: NovelDatabase,
  projectId: string,
  reason: SnapshotReason = "manual",
): Promise<ClosedLoopFixtureBundle> {
  const tables = [
    ...PROJECT_SNAPSHOT_TABLES.map((tableName) => db.table(tableName)),
    db.conversationThreads,
    db.creativeBriefs,
  ];
  return db.transaction("r", tables, async () => {
    const snapshot = await Dexie.waitFor(captureProjectSnapshot(db, projectId, reason));
    const [conversationThreads, creativeBriefs] = await Promise.all([
      db.conversationThreads.where("projectId").equals(projectId).toArray(),
      db.creativeBriefs.where("projectId").equals(projectId).toArray(),
    ]);
    return {
      format: "ymcp-novel-closed-loop",
      formatVersion: CLOSED_LOOP_FIXTURE_FORMAT_VERSION,
      snapshot,
      conversationThreads,
      creativeBriefs,
    };
  });
}

export async function verifyClosedLoopFixture(
  fixture: unknown,
): Promise<ClosedLoopFixtureVerification> {
  const issues: string[] = [];
  if (!fixture || typeof fixture !== "object") {
    return { valid: false, issues: ["闭环 fixture 必须为对象"] };
  }
  const candidate = fixture as Partial<ClosedLoopFixtureBundle>;
  if (candidate.format !== "ymcp-novel-closed-loop") issues.push("闭环 fixture 格式标识不受支持");
  if (candidate.formatVersion !== CLOSED_LOOP_FIXTURE_FORMAT_VERSION) issues.push("闭环 fixture 格式版本不受支持");
  if (!Array.isArray(candidate.conversationThreads)) issues.push("conversationThreads 缺失");
  if (!Array.isArray(candidate.creativeBriefs)) issues.push("creativeBriefs 缺失");
  if (!candidate.snapshot) {
    issues.push("项目快照缺失");
    return { valid: false, issues };
  }

  const snapshotVerification = await verifyProjectSnapshot(candidate.snapshot);
  issues.push(...snapshotVerification.issues);
  const projectId = candidate.snapshot.sourceProjectId;
  if (Array.isArray(candidate.conversationThreads)
    && candidate.conversationThreads.some((record) => record.projectId !== projectId)) {
    issues.push("conversationThreads 包含其他项目的数据");
  }
  if (Array.isArray(candidate.creativeBriefs)
    && candidate.creativeBriefs.some((record) => record.projectId !== projectId)) {
    issues.push("creativeBriefs 包含其他项目的数据");
  }
  return { valid: issues.length === 0, issues };
}

/** Replace a process-local canonical database from a verified CLI fixture. */
export async function replaceCanonicalDatabaseFromFixture(
  fixture: ClosedLoopFixtureBundle,
  target: NovelDatabase,
): Promise<void> {
  const verification = await verifyClosedLoopFixture(fixture);
  if (!verification.valid) throw new Error(`闭环 fixture 校验失败：${verification.issues.join("；")}`);
  const snapshot = await migrateProjectSnapshot(fixture.snapshot);

  await target.transaction("rw", target.tables, async () => {
    for (const table of target.tables) await table.clear();
    for (const tableName of PROJECT_SNAPSHOT_TABLES) {
      const records = snapshot.records[tableName];
      if (records.length) {
        await (target.table(tableName) as Table<Record<string, unknown>, string>)
          .bulkPut(structuredClone(records));
      }
    }
    if (fixture.conversationThreads.length) {
      await target.conversationThreads.bulkPut(structuredClone(fixture.conversationThreads));
    }
    if (fixture.creativeBriefs.length) {
      await target.creativeBriefs.bulkPut(structuredClone(fixture.creativeBriefs));
    }
  });
}

/**
 * 非破坏性导入闭环 fixture 到目标库（用户正式 novelDb 或实验库）。
 *
 * 与 `replaceCanonicalDatabaseFromFixture` 的区别：
 * - 只清理 fixture 对应 projectId 的旧记录（保留其他项目与 __user__ skill）
 * - 再 bulkPut fixture 中的记录，使目标项目与快照保持一致
 * - 用单事务确保原子性（任一表写入失败则全部回滚）
 *
 * 适用场景：
 * - UI 导入：把 CLI 产出的 final-snapshot.json 合并到用户浏览器 novelDb
 * - 跨项目库迁移：把项目快照从一个 Dexie 实例搬到另一个
 *
 * @param fixture 已校验的 ClosedLoopFixtureBundle
 * @param target  目标 NovelDatabase 实例（不限定前缀）
 * @returns 写入的记录数明细，用于 UI 反馈
 */
export async function importClosedLoopFixture(
  fixture: ClosedLoopFixtureBundle,
  target: NovelDatabase,
): Promise<{ importedCounts: Record<string, number>; projectId: string }> {
  const verification = await verifyClosedLoopFixture(fixture);
  if (!verification.valid) throw new Error(`闭环 fixture 校验失败：${verification.issues.join("；")}`);
  const snapshot = await migrateProjectSnapshot(fixture.snapshot);

  const importedCounts: Record<string, number> = {};
  const tableNames = [...PROJECT_SNAPSHOT_TABLES, "conversationThreads", "creativeBriefs"] as const;
  const projectId = snapshot.sourceProjectId;
  const fixtureUserSkills = snapshot.records.skills.filter((record) => record.projectId === "__user__");
  const existingUserSkills = fixtureUserSkills.length
    ? await target.skills.bulkGet(fixtureUserSkills.map((record) => String(record.id)))
    : [];
  const skillConflicts = fixtureUserSkills.flatMap((record, index) => {
    const existing = existingUserSkills[index];
    if (!existing) return [];
    const incomingVersion = String(record.version ?? "");
    const incomingPrompt = String(record.prompt ?? "");
    return existing.version === incomingVersion && existing.prompt === incomingPrompt
      ? []
      : [String(record.skillId ?? record.id)];
  });
  if (skillConflicts.length) {
    throw new Error(`用户 Skill 冲突：${skillConflicts.join("、")}。目标库与同步包包含同 ID 的不同版本或 prompt，请先显式选择保留版本。`);
  }
  const missingUserSkillIds = new Set(fixtureUserSkills
    .filter((_, index) => !existingUserSkills[index])
    .map((record) => String(record.id)));

  await target.transaction("rw", tableNames.map((name) => target.table(name)), async () => {
    for (const tableName of PROJECT_SNAPSHOT_TABLES) {
      const table = target.table(tableName) as Table<Record<string, unknown>, string>;
      if (tableName === "projects") {
        await table.delete(projectId);
      } else {
        await table.where("projectId").equals(projectId).delete();
      }
      const records = tableName === "skills"
        ? snapshot.records[tableName].filter((record) => record.projectId === projectId || missingUserSkillIds.has(String(record.id)))
        : snapshot.records[tableName];
      if (records.length) {
        await table.bulkPut(structuredClone(records));
      }
      importedCounts[tableName] = records.length;
    }
    await target.conversationThreads.where("projectId").equals(projectId).delete();
    if (fixture.conversationThreads.length) {
      await target.conversationThreads.bulkPut(structuredClone(fixture.conversationThreads));
    }
    importedCounts.conversationThreads = fixture.conversationThreads.length;
    await target.creativeBriefs.where("projectId").equals(projectId).delete();
    if (fixture.creativeBriefs.length) {
      await target.creativeBriefs.bulkPut(structuredClone(fixture.creativeBriefs));
    }
    importedCounts.creativeBriefs = fixture.creativeBriefs.length;
  });

  return { importedCounts, projectId };
}
