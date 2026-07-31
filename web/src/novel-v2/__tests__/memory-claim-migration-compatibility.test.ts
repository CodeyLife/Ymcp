import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const EXPLICIT_TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_DB_URL = EXPLICIT_TEST_DB_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("memory claim revision lifecycle migration", () => {
  const schemaName = `migration_claim_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const migrationsDir = join(process.cwd(), "deploy", "postgres");
  const admin = new Pool({ connectionString: TEST_DB_URL });
  const isolated = new Pool({ connectionString: TEST_DB_URL, options: `-c search_path=${schemaName},pg_catalog` });
  let available = false;

  beforeAll(async () => {
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`);
      const legacyMigrations = readdirSync(migrationsDir)
        .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && file < "030_memory_claim_revision_lifecycle.sql")
        .sort();
      for (const file of legacyMigrations) await isolated.query(readFileSync(join(migrationsDir, file), "utf8"));
      available = true;
    } catch (error) {
      if (EXPLICIT_TEST_DB_URL) throw error;
      console.warn(`[memory-claim-migration-compatibility.test] Postgres unavailable: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    await isolated.end().catch(() => undefined);
    if (/^migration_claim_[a-f0-9]{12}$/u.test(schemaName)) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
  });

  it("upgrades duplicate legacy hashes while constraining canonical claims", async () => {
    if (!available) return;
    const projectId = `project-${randomUUID()}`;
    const contentHash = `legacy-${randomUUID()}`;
    await isolated.query("INSERT INTO novel_projects(id,title) VALUES($1,'Legacy claims')", [projectId]);
    for (const id of [`legacy-a-${randomUUID()}`, `legacy-b-${randomUUID()}`]) {
      await isolated.query(
        `INSERT INTO memory_claims(id,project_id,kind,title,content,knowledge_scope,authority,confidence,content_hash)
         VALUES($1,$2,'episodic','Legacy','Legacy content',$3,'derived',1,$4)`,
        [id, projectId, { visibility: "author" }, contentHash],
      );
    }

    await expect(isolated.query(readFileSync(join(migrationsDir, "030_memory_claim_revision_lifecycle.sql"), "utf8"))).resolves.toBeDefined();

    const insertCanonical = (id: string) => isolated.query(
      `INSERT INTO memory_claims(id,project_id,kind,title,content,knowledge_scope,authority,confidence,content_hash,identity_hash,value_hash)
       VALUES($1,$2,'episodic','Canonical','Canonical content',$3,'derived',1,$4,'canonical-identity','canonical-value')`,
      [id, projectId, { visibility: "author" }, contentHash],
    );
    await expect(insertCanonical(`canonical-a-${randomUUID()}`)).resolves.toBeDefined();
    await expect(insertCanonical(`canonical-b-${randomUUID()}`)).rejects.toMatchObject({ code: "23505" });
  });
});
