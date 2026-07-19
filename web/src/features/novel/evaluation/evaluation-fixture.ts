import Dexie, { type Table } from "dexie";
import type { NovelDatabase } from "../db";
import type { CreativeBrief, NovelConversationThread } from "../types";
import {
  captureProjectSnapshot,
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

  await target.transaction("rw", target.tables, async () => {
    for (const table of target.tables) await table.clear();
    for (const tableName of PROJECT_SNAPSHOT_TABLES) {
      const records = fixture.snapshot.records[tableName];
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
