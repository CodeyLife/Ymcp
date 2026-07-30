import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPERIMENT_RUNTIME_TABLES } from "../evaluation/experiment-workspace";

describe("experiment schema ownership", () => {
  it("classifies every migrated V2 table as runtime data or explicit control data", () => {
    const migrationDir = join(process.cwd(), "deploy", "postgres");
    const migratedTables = readdirSync(migrationDir)
      .filter((name) => /^\d{3}_.+\.sql$/u.test(name))
      .flatMap((name) => [...readFileSync(join(migrationDir, name), "utf8").matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/giu)].map((match) => match[1]));
    const controlTables = new Set(["candidate_bundles", "experiment_workspaces", "iterated_skills", "project_snapshots", "promotion_receipts", "runtime_configuration", "runtime_services"]);
    const expectedRuntime = [...new Set(migratedTables.filter((table) => !controlTables.has(table)))].sort();

    expect([...EXPERIMENT_RUNTIME_TABLES].sort()).toEqual(expectedRuntime);
  });
});
