import { novelDb } from "./db";
import { getEffectiveApiConfig } from "@/stores/ui";
import type { LegacyMigrationBundle } from "@/novel-runtime/contracts";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

export async function inspectLegacyProjects(runtimeProjectIds: Set<string>) {
  const projects = await novelDb.projects.toArray();
  const missing = projects.filter((project) => !runtimeProjectIds.has(project.id));
  return Promise.all(missing.map(async (project) => {
    let recordCount = 1;
    for (const table of novelDb.tables) {
      if (table.name !== "projects" && table.schema.indexes.some((index) => index.name === "projectId")) recordCount += await table.where("projectId").equals(project.id).count();
    }
    return { id: project.id, title: project.title, premise: project.premise, updatedAt: project.updatedAt, recordCount };
  }));
}

export async function buildLegacyMigrationBundle(projectIds: string[]): Promise<LegacyMigrationBundle> {
  const selected = new Set(projectIds);
  const records: Record<string, Array<Record<string, unknown>>> = {};
  for (const table of novelDb.tables) {
    let values: Array<Record<string, unknown>> = [];
    if (table.name === "projects") values = (await table.toArray() as Array<Record<string, unknown>>).filter((record) => selected.has(String(record.id)));
    else if (table.schema.indexes.some((index) => index.name === "projectId")) {
      values = (await table.toArray() as Array<Record<string, unknown>>).filter((record) => selected.has(String(record.projectId)) || record.projectId === "__user__");
    }
    if (values.length) records[table.name] = values;
  }
  const api = getEffectiveApiConfig();
  return {
    format: "ymcp-novel-runtime-migration",
    formatVersion: 1,
    exportedAt: Date.now(),
    records,
    integrity: { algorithm: "sha256", digest: await digest(records) },
    apiConfig: { baseUrl: api.baseUrl, modelContextWindow: api.modelContextWindow },
  };
}
