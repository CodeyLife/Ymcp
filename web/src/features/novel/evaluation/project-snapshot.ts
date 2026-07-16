import type { Table } from "dexie";
import { documentContentHash, NovelDatabase } from "../db";
import { DB_VERSION, RECORD_SCHEMA_VERSION } from "../db-schema";
import type { ManuscriptDocument, StoryProject } from "../types";

export const PROJECT_SNAPSHOT_FORMAT_VERSION = 1;
export const EXPERIMENT_DATABASE_PREFIX = "ymcp-novel-eval-v1-";

export const PROJECT_SNAPSHOT_TABLES = [
  "projects",
  "architectures",
  "entities",
  "relations",
  "outlineNodes",
  "scenes",
  "documents",
  "revisions",
  "plotThreads",
  "foreshadowing",
  "timelineEvents",
  "snapshots",
  "skills",
  "projectSkills",
  "factAssertions",
  "knowledgeAssertions",
  "narrativeUnits",
  "outlineRealizations",
  "derivedMemories",
  "preferenceSignals",
  "tasteProfiles",
] as const;

export type ProjectSnapshotTable = (typeof PROJECT_SNAPSHOT_TABLES)[number];
export type SnapshotReason = "manual" | "chapter-baseline" | "post-promotion" | "replay";
export type SnapshotRecord = Record<string, unknown>;
export type ProjectSnapshotRecords = Record<ProjectSnapshotTable, SnapshotRecord[]>;

export interface ProjectHead {
  projectRevision: number;
  currentSnapshotId?: string;
  latestFinalDocumentId?: string;
  latestFinalDocumentOrder?: number;
  finalDocumentHeads: Array<{
    documentId: string;
    documentRevision: number;
    approvedRevisionId?: string;
    contentHash: string;
  }>;
}

export interface ProjectSnapshotManifest {
  recordCounts: Record<ProjectSnapshotTable, number>;
  tableHashes: Record<ProjectSnapshotTable, string>;
  snapshotHash: string;
  schemaVersion: number;
  algorithm: "sha-256";
}

export interface ProjectSnapshotBundle {
  formatVersion: 1;
  snapshotId: string;
  sourceProjectId: string;
  sourceDatabaseVersion: number;
  createdAt: number;
  reason: SnapshotReason;
  head: ProjectHead;
  records: ProjectSnapshotRecords;
  manifest: ProjectSnapshotManifest;
}

export interface SnapshotVerification {
  valid: boolean;
  issues: string[];
  computedHash: string;
}

function snapshotTable(db: NovelDatabase, tableName: ProjectSnapshotTable) {
  return db.table(tableName) as Table<SnapshotRecord, string>;
}

function normalizedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedValue);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries.map(([key, item]) => [key, normalizedValue(item)]));
}

function stableJson(value: unknown) {
  return JSON.stringify(normalizedValue(value));
}

async function sha256(value: unknown) {
  if (!globalThis.crypto?.subtle) throw new Error("当前环境不支持 SHA-256 快照校验");
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sortRecords(records: SnapshotRecord[]) {
  return records
    .map((record) => structuredClone(record))
    .sort((left, right) => {
      const idOrder = String(left.id ?? "").localeCompare(String(right.id ?? ""));
      return idOrder || stableJson(left).localeCompare(stableJson(right));
    });
}

async function readProjectTable(db: NovelDatabase, tableName: ProjectSnapshotTable, projectId: string) {
  if (tableName === "projects") {
    const project = await db.projects.get(projectId);
    return project ? [project as unknown as SnapshotRecord] : [];
  }
  if (tableName === "skills") {
    const skills = await db.skills.where("projectId").anyOf("__user__", projectId).toArray();
    return skills as unknown as SnapshotRecord[];
  }
  return snapshotTable(db, tableName).where("projectId").equals(projectId).toArray();
}

function buildProjectHead(project: StoryProject, documents: SnapshotRecord[]): ProjectHead {
  const finalDocuments = (documents as unknown as ManuscriptDocument[])
    .filter((document) => document.status === "final" && !document.deletedAt)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const latest = finalDocuments.at(-1);
  return {
    projectRevision: project.revision,
    currentSnapshotId: project.currentSnapshotId,
    latestFinalDocumentId: latest?.id,
    latestFinalDocumentOrder: latest?.order,
    finalDocumentHeads: finalDocuments.map((document) => ({
      documentId: document.id,
      documentRevision: document.revision,
      approvedRevisionId: document.approvedRevisionId,
      contentHash: documentContentHash(document),
    })),
  };
}

async function buildManifest(input: {
  sourceProjectId: string;
  sourceDatabaseVersion: number;
  head: ProjectHead;
  records: ProjectSnapshotRecords;
}): Promise<ProjectSnapshotManifest> {
  const recordCounts = {} as Record<ProjectSnapshotTable, number>;
  const tableHashes = {} as Record<ProjectSnapshotTable, string>;
  for (const tableName of PROJECT_SNAPSHOT_TABLES) {
    recordCounts[tableName] = input.records[tableName].length;
    tableHashes[tableName] = await sha256(input.records[tableName]);
  }
  const snapshotHash = await sha256({
    formatVersion: PROJECT_SNAPSHOT_FORMAT_VERSION,
    sourceProjectId: input.sourceProjectId,
    sourceDatabaseVersion: input.sourceDatabaseVersion,
    head: input.head,
    records: input.records,
  });
  return { recordCounts, tableHashes, snapshotHash, schemaVersion: RECORD_SCHEMA_VERSION, algorithm: "sha-256" };
}

export async function captureProjectSnapshot(
  db: NovelDatabase,
  projectId: string,
  reason: SnapshotReason,
): Promise<ProjectSnapshotBundle> {
  const transactionTables = PROJECT_SNAPSHOT_TABLES.map((tableName) => snapshotTable(db, tableName));
  const captured = await db.transaction("r", transactionTables, async () => {
    const project = await db.projects.get(projectId);
    if (!project) throw new Error("项目不存在");
    const records = {} as ProjectSnapshotRecords;
    for (const tableName of PROJECT_SNAPSHOT_TABLES) {
      records[tableName] = sortRecords(await readProjectTable(db, tableName, projectId));
    }
    return { project, records };
  });
  const head = buildProjectHead(captured.project, captured.records.documents);
  const sourceDatabaseVersion = db.verno || DB_VERSION;
  const manifest = await buildManifest({ sourceProjectId: projectId, sourceDatabaseVersion, head, records: captured.records });
  return {
    formatVersion: PROJECT_SNAPSHOT_FORMAT_VERSION,
    snapshotId: crypto.randomUUID(),
    sourceProjectId: projectId,
    sourceDatabaseVersion,
    createdAt: Date.now(),
    reason,
    head,
    records: captured.records,
    manifest,
  };
}

export async function verifyProjectSnapshot(bundle: ProjectSnapshotBundle): Promise<SnapshotVerification> {
  const issues: string[] = [];
  if (bundle.formatVersion !== PROJECT_SNAPSHOT_FORMAT_VERSION) issues.push("快照格式版本不受支持");
  if (bundle.manifest.algorithm !== "sha-256") issues.push("快照哈希算法不受支持");
  if (bundle.manifest.schemaVersion !== RECORD_SCHEMA_VERSION) issues.push("快照记录版本与当前版本不一致");
  if (bundle.sourceDatabaseVersion !== DB_VERSION) issues.push("快照数据库版本与当前版本不一致");
  for (const tableName of PROJECT_SNAPSHOT_TABLES) {
    const records = bundle.records[tableName];
    if (!Array.isArray(records)) {
      issues.push(`${tableName} 表缺失`);
      continue;
    }
    if (records.length !== bundle.manifest.recordCounts[tableName]) issues.push(`${tableName} 表记录数不匹配`);
    if (await sha256(records) !== bundle.manifest.tableHashes[tableName]) issues.push(`${tableName} 表哈希不匹配`);
  }
  const projects = bundle.records.projects;
  if (projects.length !== 1 || projects[0]?.id !== bundle.sourceProjectId) issues.push("快照项目记录与来源项目不一致");
  for (const tableName of PROJECT_SNAPSHOT_TABLES) {
    if (tableName === "projects") continue;
    const invalidScope = bundle.records[tableName].some((record) => (
      record.projectId !== bundle.sourceProjectId
      && !(tableName === "skills" && record.projectId === "__user__")
    ));
    if (invalidScope) issues.push(`${tableName} 表包含其他项目的数据`);
  }
  const computedHash = await sha256({
    formatVersion: bundle.formatVersion,
    sourceProjectId: bundle.sourceProjectId,
    sourceDatabaseVersion: bundle.sourceDatabaseVersion,
    head: bundle.head,
    records: bundle.records,
  });
  if (computedHash !== bundle.manifest.snapshotHash) issues.push("项目快照总哈希不匹配");
  return { valid: issues.length === 0, issues, computedHash };
}

export function createExperimentDatabase(experimentId: string) {
  const safeId = experimentId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safeId) throw new Error("实验 ID 不能为空");
  return new NovelDatabase(`${EXPERIMENT_DATABASE_PREFIX}${safeId}`);
}

export async function restoreProjectSnapshot(bundle: ProjectSnapshotBundle, target: NovelDatabase) {
  if (!target.name.startsWith(EXPERIMENT_DATABASE_PREFIX)) throw new Error("项目快照只能恢复到物理隔离的实验数据库");
  const verification = await verifyProjectSnapshot(bundle);
  if (!verification.valid) throw new Error(`项目快照校验失败：${verification.issues.join("；")}`);
  await target.transaction("rw", target.tables, async () => {
    for (const table of target.tables) await table.clear();
    for (const tableName of PROJECT_SNAPSHOT_TABLES) {
      const records = bundle.records[tableName];
      if (records.length) await snapshotTable(target, tableName).bulkPut(structuredClone(records));
    }
  });
}
