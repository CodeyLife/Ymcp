import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NovelDatabase } from "../features/novel/db";
import type { LegacyMigrationBundle, RuntimeChange, RuntimeEvent, RuntimeOperation, RuntimeProjectMutationCommand, RuntimeProjectMutationResult, RuntimeProjectSnapshot } from "./contracts";

const FORMAL_TABLES = new Set([
  "projects", "architectures", "entities", "relations", "outlineNodes", "scenes", "documents", "revisions",
  "manuscriptChanges", "plotThreads", "foreshadowing", "timelineEvents", "snapshots", "factAssertions",
  "knowledgeAssertions", "narrativeUnits", "outlineRealizations", "derivedMemories", "tasteProfiles", "skills",
  "projectSkills", "workflowDefinitions", "promptTemplateVersions", "craftRuleCandidates",
]);

const MUTABLE_TABLES = new Set([
  ...FORMAL_TABLES,
  "operations", "canvasLayouts", "preferenceSignals", "iteratedSkills", "embeddings",
]);

export class RuntimeRecordConflictError extends Error {
  override readonly name = "RuntimeRecordConflictError";
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export interface NovelStore {
  hydrate(db: NovelDatabase): Promise<void>;
  restoreProject(db: NovelDatabase, projectId: string): Promise<void>;
  flushProject(db: NovelDatabase, projectId: string): Promise<void>;
  snapshotHash(projectId: string): string;
  getProjectSnapshot(projectId: string): RuntimeProjectSnapshot;
  applyProjectMutation(command: RuntimeProjectMutationCommand, commandId: string): RuntimeProjectMutationResult;
  deleteProject(projectId: string, commandId: string): void;
  listOperations(projectId?: string): RuntimeOperation[];
  getOperation(id: string): RuntimeOperation | undefined;
  putOperation(operation: RuntimeOperation): void;
  getChange(id: string): RuntimeChange | undefined;
  listChanges(projectId?: string, status?: RuntimeChange["status"]): RuntimeChange[];
  putChange(change: RuntimeChange): void;
  appendEvent(event: Omit<RuntimeEvent, "sequence">): RuntimeEvent;
  listEvents(afterSequence: number, projectId?: string): RuntimeEvent[];
  getSetting<T>(key: string): T | undefined;
  setSetting(key: string, value: unknown): void;
  commitChangeState(db: NovelDatabase, change: RuntimeChange, operation?: RuntimeOperation): Promise<void>;
  commitAcceptedChange(db: NovelDatabase, change: RuntimeChange, operation: RuntimeOperation): Promise<void>;
  importLegacyBundle(bundle: LegacyMigrationBundle, db: NovelDatabase): Promise<{ projectIds: string[]; backupPath: string }>;
  close(): void;
}

export class SqliteNovelStore implements NovelStore {
  private readonly sqlite: DatabaseSync;
  private readonly backupDir: string;
  private readonly secretPath: string;

  constructor(readonly databasePath: string, backupDir = join(dirname(databasePath), "backups")) {
    mkdirSync(dirname(databasePath), { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    this.backupDir = backupDir;
    this.secretPath = join(dirname(databasePath), "novel-runtime.secrets.json");
    this.sqlite = new DatabaseSync(databasePath);
    this.sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS novel_records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      );
      CREATE INDEX IF NOT EXISTS novel_records_project ON novel_records(project_id, collection, updated_at);
      CREATE TABLE IF NOT EXISTS runtime_operations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_operations_project ON runtime_operations(project_id, status, updated_at);
      CREATE TABLE IF NOT EXISTS runtime_changes (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_changes_project ON runtime_changes(project_id, status, updated_at);
      CREATE TABLE IF NOT EXISTS runtime_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, operation_id TEXT, type TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_command_receipts (
        command_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, command_hash TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS migration_receipts (digest TEXT PRIMARY KEY, backup_path TEXT NOT NULL, imported_at INTEGER NOT NULL);
    `);
  }

  async hydrate(db: NovelDatabase): Promise<void> {
    await db.open();
    const rows = this.sqlite.prepare("SELECT collection, payload FROM novel_records ORDER BY collection, id").all() as Array<{ collection: string; payload: string }>;
    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const records = grouped.get(row.collection) ?? [];
      records.push(JSON.parse(row.payload) as Record<string, unknown>);
      grouped.set(row.collection, records);
    }
    await db.transaction("rw", db.tables, async () => {
      for (const [collection, records] of grouped) {
        const table = db.tables.find((candidate) => candidate.name === collection);
        if (table && records.length) await table.bulkPut(records);
      }
    });
  }

  async restoreProject(db: NovelDatabase, projectId: string): Promise<void> {
    const rows = this.sqlite.prepare("SELECT collection, payload FROM novel_records WHERE project_id = ? ORDER BY collection, id").all(projectId) as Array<{ collection: string; payload: string }>;
    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const records = grouped.get(row.collection) ?? [];
      records.push(JSON.parse(row.payload) as Record<string, unknown>);
      grouped.set(row.collection, records);
    }
    await db.transaction("rw", db.tables, async () => {
      for (const table of db.tables) {
        if (table.name === "projects") await table.delete(projectId);
        else if (table.schema.indexes.some((index) => index.name === "projectId")) await table.where("projectId").equals(projectId).delete();
      }
      for (const [collection, records] of grouped) {
        const table = db.tables.find((candidate) => candidate.name === collection);
        if (table && records.length) await table.bulkPut(records);
      }
    });
  }

  async flushProject(db: NovelDatabase, projectId: string): Promise<void> {
    const records = await this.collectProjectRecords(db, projectId);
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.replaceProjectRecords(projectId, records);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  private async collectProjectRecords(db: NovelDatabase, projectId: string) {
    const records: Array<{ collection: string; id: string; projectId: string; updatedAt: number; payload: string }> = [];
    for (const table of db.tables) {
      let values: Array<Record<string, unknown>> = [];
      if (table.name === "projects") {
        const project = await table.get(projectId) as Record<string, unknown> | undefined;
        if (project) values = [project];
      } else if (table.schema.indexes.some((index) => index.name === "projectId")) {
        values = await table.where("projectId").equals(projectId).toArray() as Array<Record<string, unknown>>;
      }
      for (const value of values) {
        if (typeof value.id !== "string") continue;
        records.push({ collection: table.name, id: value.id, projectId, updatedAt: Number(value.updatedAt ?? Date.now()), payload: JSON.stringify(value) });
      }
    }
    return records;
  }

  private replaceProjectRecords(projectId: string, records: Awaited<ReturnType<SqliteNovelStore["collectProjectRecords"]>>) {
    this.sqlite.prepare("DELETE FROM novel_records WHERE project_id = ?").run(projectId);
    const insert = this.sqlite.prepare("INSERT INTO novel_records(collection,id,project_id,updated_at,payload) VALUES(?,?,?,?,?)");
    for (const record of records) insert.run(record.collection, record.id, record.projectId, record.updatedAt, record.payload);
  }

  async commitChangeState(db: NovelDatabase, change: RuntimeChange, operation?: RuntimeOperation): Promise<void> {
    const records = await this.collectProjectRecords(db, change.projectId);
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.replaceProjectRecords(change.projectId, records);
      this.putChange(change);
      if (operation) this.putOperation(operation);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async commitAcceptedChange(db: NovelDatabase, change: RuntimeChange, operation: RuntimeOperation): Promise<void> {
    const records = await this.collectProjectRecords(db, change.projectId);
    operation.baseSnapshotHash = sha256(records
      .filter((record) => FORMAL_TABLES.has(record.collection))
      .sort((left, right) => left.collection.localeCompare(right.collection) || left.id.localeCompare(right.id))
      .map((record) => [record.collection, record.id, JSON.parse(record.payload)]));
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.replaceProjectRecords(change.projectId, records);
      this.putChange(change);
      this.putOperation(operation);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  snapshotHash(projectId: string): string {
    const rows = this.sqlite.prepare("SELECT collection, id, payload FROM novel_records WHERE project_id = ? ORDER BY collection, id").all(projectId) as Array<{ collection: string; id: string; payload: string }>;
    return sha256(rows.filter((row) => FORMAL_TABLES.has(row.collection)).map((row) => [row.collection, row.id, JSON.parse(row.payload)]));
  }

  getProjectSnapshot(projectId: string): RuntimeProjectSnapshot {
    const rows = this.sqlite.prepare("SELECT collection, payload FROM novel_records WHERE project_id = ? ORDER BY collection, id").all(projectId) as Array<{ collection: string; payload: string }>;
    const records: RuntimeProjectSnapshot["records"] = {};
    for (const row of rows) (records[row.collection] ??= []).push(JSON.parse(row.payload) as Record<string, unknown>);
    return { projectId, snapshotHash: this.snapshotHash(projectId), records };
  }

  applyProjectMutation(command: RuntimeProjectMutationCommand, commandId: string): RuntimeProjectMutationResult {
    if (!command.mutations.length) throw new Error("正式记录命令至少需要一项 mutation");
    const commandHash = sha256(command);
    const receipt = this.sqlite.prepare("SELECT command_hash, payload FROM runtime_command_receipts WHERE command_id = ?").get(commandId) as { command_hash: string; payload: string } | undefined;
    if (receipt) {
      if (receipt.command_hash !== commandHash) throw new Error("同一 commandId 不能用于不同的正式编辑命令");
      return JSON.parse(receipt.payload) as RuntimeProjectMutationResult;
    }
    const seen = new Set<string>();
    const changed: RuntimeProjectMutationResult["changed"] = [];
    const select = this.sqlite.prepare("SELECT payload FROM novel_records WHERE collection = ? AND id = ?");
    const put = this.sqlite.prepare(`INSERT INTO novel_records(collection,id,project_id,updated_at,payload) VALUES(?,?,?,?,?)
      ON CONFLICT(collection,id) DO UPDATE SET project_id=excluded.project_id,updated_at=excluded.updated_at,payload=excluded.payload`);
    const remove = this.sqlite.prepare("DELETE FROM novel_records WHERE collection = ? AND id = ?");
    const now = Date.now();
    let result: RuntimeProjectMutationResult | undefined;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const mutation of command.mutations) {
        if (!MUTABLE_TABLES.has(mutation.collection)) throw new Error(`集合 ${mutation.collection} 不允许通过正式编辑命令修改`);
        const key = `${mutation.collection}\u0000${mutation.id}`;
        if (seen.has(key)) throw new Error(`同一命令不能重复修改 ${mutation.collection}/${mutation.id}`);
        seen.add(key);
        const row = select.get(mutation.collection, mutation.id) as { payload: string } | undefined;
        const current = row ? JSON.parse(row.payload) as Record<string, unknown> : undefined;
        const currentProjectId = mutation.collection === "projects" ? current?.id : current?.projectId;
        if (current && currentProjectId !== command.projectId) throw new Error("记录不属于当前项目");
        const revision = current ? Number(current.revision ?? 0) : null;
        if (revision !== mutation.expectedRevision) {
          throw new RuntimeRecordConflictError(`${mutation.collection}/${mutation.id} revision 已从 ${mutation.expectedRevision} 变为 ${revision}`);
        }
        if (mutation.type === "delete") {
          if (!current) throw new RuntimeRecordConflictError(`${mutation.collection}/${mutation.id} 已不存在`);
          remove.run(mutation.collection, mutation.id);
          changed.push({ collection: mutation.collection, id: mutation.id, type: "delete" });
          continue;
        }
        if (mutation.value.id !== mutation.id) throw new Error("mutation id 与记录 id 不一致");
        const valueProjectId = mutation.collection === "projects" ? mutation.value.id : mutation.value.projectId;
        if (valueProjectId !== command.projectId) throw new Error("写入记录不属于当前项目");
        const nextRevision = (revision ?? 0) + 1;
        const value = {
          ...mutation.value,
          revision: nextRevision,
          updatedAt: now,
          updatedBy: command.actor.id,
          ...(current ? {} : { createdAt: Number(mutation.value.createdAt ?? now), createdBy: String(mutation.value.createdBy ?? command.actor.id) }),
        };
        put.run(mutation.collection, mutation.id, command.projectId, now, JSON.stringify(value));
        changed.push({ collection: mutation.collection, id: mutation.id, type: "put", revision: nextRevision });
      }
      result = { ...this.getProjectSnapshot(command.projectId), commandId, changed };
      this.sqlite.prepare("INSERT INTO runtime_command_receipts(command_id,project_id,command_hash,created_at,payload) VALUES(?,?,?,?,?)")
        .run(commandId, command.projectId, commandHash, now, JSON.stringify(result));
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return result!;
  }

  deleteProject(projectId: string, commandId: string): void {
    const receipt = this.sqlite.prepare("SELECT command_hash FROM runtime_command_receipts WHERE command_id = ?").get(commandId) as { command_hash: string } | undefined;
    const commandHash = sha256({ type: "delete-project", projectId });
    if (receipt) {
      if (receipt.command_hash !== commandHash) throw new Error("同一 commandId 不能用于不同命令");
      return;
    }
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("DELETE FROM novel_records WHERE project_id = ?").run(projectId);
      this.sqlite.prepare("DELETE FROM runtime_operations WHERE project_id = ?").run(projectId);
      this.sqlite.prepare("DELETE FROM runtime_changes WHERE project_id = ?").run(projectId);
      this.sqlite.prepare("DELETE FROM runtime_events WHERE project_id = ?").run(projectId);
      this.sqlite.prepare("INSERT INTO runtime_command_receipts(command_id,project_id,command_hash,created_at,payload) VALUES(?,?,?,?,?)")
        .run(commandId, projectId, commandHash, Date.now(), JSON.stringify({ projectId, deleted: true }));
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  listOperations(projectId?: string): RuntimeOperation[] {
    const rows = (projectId
      ? this.sqlite.prepare("SELECT payload FROM runtime_operations WHERE project_id = ? ORDER BY updated_at DESC").all(projectId)
      : this.sqlite.prepare("SELECT payload FROM runtime_operations ORDER BY updated_at DESC").all()) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as RuntimeOperation);
  }

  getOperation(id: string): RuntimeOperation | undefined {
    const row = this.sqlite.prepare("SELECT payload FROM runtime_operations WHERE id = ?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as RuntimeOperation : undefined;
  }

  putOperation(operation: RuntimeOperation): void {
    this.sqlite.prepare(`INSERT INTO runtime_operations(id,project_id,status,updated_at,payload) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,status=excluded.status,updated_at=excluded.updated_at,payload=excluded.payload`)
      .run(operation.id, operation.projectId, operation.status, operation.updatedAt, JSON.stringify(operation));
  }

  getChange(id: string): RuntimeChange | undefined {
    const row = this.sqlite.prepare("SELECT payload FROM runtime_changes WHERE id = ?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as RuntimeChange : undefined;
  }

  listChanges(projectId?: string, status?: RuntimeChange["status"]): RuntimeChange[] {
    let rows: Array<{ payload: string }>;
    if (projectId && status) rows = this.sqlite.prepare("SELECT payload FROM runtime_changes WHERE project_id = ? AND status = ? ORDER BY updated_at DESC").all(projectId, status) as Array<{ payload: string }>;
    else if (projectId) rows = this.sqlite.prepare("SELECT payload FROM runtime_changes WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Array<{ payload: string }>;
    else rows = this.sqlite.prepare("SELECT payload FROM runtime_changes ORDER BY updated_at DESC").all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as RuntimeChange);
  }

  putChange(change: RuntimeChange): void {
    this.sqlite.prepare(`INSERT INTO runtime_changes(id,operation_id,project_id,status,updated_at,payload) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET operation_id=excluded.operation_id,project_id=excluded.project_id,status=excluded.status,updated_at=excluded.updated_at,payload=excluded.payload`)
      .run(change.id, change.operationId, change.projectId, change.status, change.updatedAt, JSON.stringify(change));
  }

  appendEvent(input: Omit<RuntimeEvent, "sequence">): RuntimeEvent {
    const result = this.sqlite.prepare("INSERT INTO runtime_events(project_id,operation_id,type,created_at,payload) VALUES(?,?,?,?,?)")
      .run(input.projectId ?? null, input.operationId ?? null, input.type, input.createdAt, JSON.stringify(input.payload));
    return { ...input, sequence: Number(result.lastInsertRowid) };
  }

  listEvents(afterSequence: number, projectId?: string): RuntimeEvent[] {
    const rows = (projectId
      ? this.sqlite.prepare("SELECT * FROM runtime_events WHERE sequence > ? AND (project_id = ? OR project_id IS NULL) ORDER BY sequence").all(afterSequence, projectId)
      : this.sqlite.prepare("SELECT * FROM runtime_events WHERE sequence > ? ORDER BY sequence").all(afterSequence)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ sequence: Number(row.sequence), projectId: row.project_id as string | undefined, operationId: row.operation_id as string | undefined, type: String(row.type), createdAt: Number(row.created_at), payload: JSON.parse(String(row.payload)) as Record<string, unknown> }));
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.sqlite.prepare("SELECT payload FROM runtime_settings WHERE key = ?").get(key) as { payload: string } | undefined;
    if (!row) return undefined;
    const value = JSON.parse(row.payload) as Record<string, unknown>;
    if (key === "apiConfig") {
      const secret = this.readSecrets().apiKey;
      if (secret) value.apiKey = secret;
    }
    return value as T;
  }

  setSetting(key: string, value: unknown): void {
    let persisted = value;
    if (key === "apiConfig" && value && typeof value === "object" && !Array.isArray(value)) {
      const { apiKey, ...publicConfig } = value as Record<string, unknown>;
      persisted = publicConfig;
      if (typeof apiKey === "string") this.writeSecrets({ ...this.readSecrets(), apiKey });
    }
    this.sqlite.prepare(`INSERT INTO runtime_settings(key,payload,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`).run(key, JSON.stringify(persisted), Date.now());
  }

  private readSecrets(): { apiKey?: string } {
    try { return JSON.parse(readFileSync(this.secretPath, "utf8")) as { apiKey?: string }; }
    catch { return {}; }
  }

  private writeSecrets(value: { apiKey?: string }) {
    const temporary = `${this.secretPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.secretPath);
    try { chmodSync(this.secretPath, 0o600); } catch { /* Windows ACLs remain user-profile scoped. */ }
  }

  async importLegacyBundle(bundle: LegacyMigrationBundle, db: NovelDatabase): Promise<{ projectIds: string[]; backupPath: string }> {
    if (bundle.format !== "ymcp-novel-runtime-migration" || bundle.formatVersion !== 1) throw new Error("不支持的迁移包格式");
    const digest = sha256(bundle.records);
    if (bundle.integrity.algorithm !== "sha256" || digest !== bundle.integrity.digest) throw new Error("迁移包 SHA-256 校验失败");
    const existing = this.sqlite.prepare("SELECT backup_path FROM migration_receipts WHERE digest = ?").get(digest) as { backup_path: string } | undefined;
    const projectIds = (bundle.records.projects ?? []).map((record) => String(record.id));
    if (existing) return { projectIds, backupPath: existing.backup_path };
    const backupPath = join(this.backupDir, `pre-runtime-${new Date().toISOString().replace(/[:.]/g, "-")}-${digest.slice(0, 8)}.json`);
    const { apiKey: _apiKey, ...publicApiConfig } = bundle.apiConfig ?? {};
    const backupBundle = { ...bundle, ...(bundle.apiConfig ? { apiConfig: publicApiConfig } : {}) };
    writeFileSync(backupPath, JSON.stringify(backupBundle, null, 2), { encoding: "utf8", flag: "wx" });
    await db.transaction("rw", db.tables, async () => {
      for (const [name, values] of Object.entries(bundle.records)) {
        const table = db.tables.find((candidate) => candidate.name === name);
        if (table && values.length) await table.bulkPut(values);
      }
    });
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const scopes = [...new Set([...projectIds, "__user__"])];
      const remove = this.sqlite.prepare("DELETE FROM novel_records WHERE project_id = ?");
      for (const scope of scopes) remove.run(scope);
      const insert = this.sqlite.prepare("INSERT OR REPLACE INTO novel_records(collection,id,project_id,updated_at,payload) VALUES(?,?,?,?,?)");
      for (const [collection, values] of Object.entries(bundle.records)) {
        for (const value of values) {
          if (typeof value.id !== "string") continue;
          const projectId = collection === "projects" ? value.id : String(value.projectId ?? "");
          if (!scopes.includes(projectId)) continue;
          insert.run(collection, value.id, projectId, Number(value.updatedAt ?? Date.now()), JSON.stringify(value));
        }
      }
      if (bundle.apiConfig) {
        const { apiKey: _secretApiKey, ...publicConfig } = bundle.apiConfig;
        this.sqlite.prepare(`INSERT INTO runtime_settings(key,payload,updated_at) VALUES('apiConfig',?,?)
          ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`).run(JSON.stringify(publicConfig), Date.now());
      }
      this.sqlite.prepare("INSERT INTO migration_receipts(digest,backup_path,imported_at) VALUES(?,?,?)").run(digest, backupPath, Date.now());
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    if (typeof bundle.apiConfig?.apiKey === "string") this.writeSecrets({ ...this.readSecrets(), apiKey: bundle.apiConfig.apiKey });
    return { projectIds, backupPath };
  }

  close(): void {
    this.sqlite.close();
  }
}
