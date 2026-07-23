import type { RuntimeProjectMutationResult, RuntimeProjectSnapshot, RuntimeRecordMutation } from "@/novel-runtime/contracts";
import { novelDb } from "./db";
import { buildLegacyMigrationBundle } from "./legacy-runtime-migration";
import { NovelRuntimeHttpError, novelRuntimeClient } from "./runtime-client";
import { getEffectiveApiConfig } from "@/stores/ui";

const projectReadiness = new Map<string, Promise<void>>();
const projectQueues = new Map<string, Promise<unknown>>();

export async function syncNovelRuntimeApiConfig() {
  const api = getEffectiveApiConfig();
  return novelRuntimeClient.updateApiConfig({
    baseUrl: api.baseUrl,
    apiKey: api.apiKey,
    modelContextWindow: api.modelContextWindow,
  });
}

async function replaceProjectProjection(snapshot: RuntimeProjectSnapshot) {
  await novelDb.transaction("rw", novelDb.tables, async () => {
    for (const table of novelDb.tables) {
      if (table.name === "projects") await table.delete(snapshot.projectId);
      else if (table.schema.indexes.some((index) => index.name === "projectId")) await table.where("projectId").equals(snapshot.projectId).delete();
    }
    for (const [collection, records] of Object.entries(snapshot.records)) {
      const table = novelDb.tables.find((candidate) => candidate.name === collection);
      if (table && records.length) await table.bulkPut(records);
    }
  });
}

async function applyMutationProjection(result: RuntimeProjectMutationResult) {
  const touched = [...new Set(result.changed.map((item) => item.collection))]
    .map((name) => novelDb.tables.find((table) => table.name === name))
    .filter((table): table is NonNullable<typeof table> => Boolean(table));
  if (!touched.length) return;
  await novelDb.transaction("rw", touched, async () => {
    for (const change of result.changed) {
      const table = novelDb.tables.find((candidate) => candidate.name === change.collection);
      if (!table) continue;
      if (change.type === "delete") await table.delete(change.id);
      else {
        const record = result.records[change.collection]?.find((candidate) => candidate.id === change.id);
        if (!record) throw new Error(`runtime 响应缺少 ${change.collection}/${change.id}`);
        await table.put(record);
      }
    }
  });
}

export async function ensureRuntimeProject(projectId: string) {
  const existing = projectReadiness.get(projectId);
  if (existing) return existing;
  const readiness = (async () => {
    if (projectId === "__user__") {
      await novelRuntimeClient.migrate(await buildLegacyMigrationBundle([projectId]));
      return;
    }
    try {
      await novelRuntimeClient.projectRecords(projectId);
    } catch (error) {
      if (!(error instanceof NovelRuntimeHttpError) || error.code !== "RUNTIME_ERROR" && error.code !== "PROJECT_NOT_FOUND") throw error;
      await novelRuntimeClient.migrate(await buildLegacyMigrationBundle([projectId]));
    }
  })().catch((error) => {
    projectReadiness.delete(projectId);
    throw error;
  });
  projectReadiness.set(projectId, readiness);
  return readiness;
}

export async function refreshRuntimeProjection(projectId: string) {
  await ensureRuntimeProject(projectId);
  const snapshot = await novelRuntimeClient.projectRecords(projectId);
  await replaceProjectProjection(snapshot);
  return snapshot;
}

export async function refreshRuntimeProjectListProjection() {
  const { projects } = await novelRuntimeClient.listProjects();
  for (const project of projects) {
    await replaceProjectProjection(await novelRuntimeClient.projectRecords(project.id));
  }
  return projects;
}

export async function deleteRuntimeChapter(projectId: string, documentId: string) {
  await ensureRuntimeProject(projectId);
  await novelRuntimeClient.deleteChapter(projectId, documentId);
  await refreshRuntimeProjection(projectId);
}

export async function commitRuntimeRecords(projectId: string, mutations: RuntimeRecordMutation[], requestKey = crypto.randomUUID()) {
  const previous = projectQueues.get(projectId) ?? Promise.resolve();
  const result = previous.then(async () => {
    await ensureRuntimeProject(projectId);
    try {
      const committed = await novelRuntimeClient.mutateProject(projectId, mutations, { type: "user", id: "local-user" }, requestKey);
      await applyMutationProjection(committed);
      return committed;
    } catch (error) {
      await refreshRuntimeProjection(projectId).catch(() => undefined);
      throw error;
    }
  });
  projectQueues.set(projectId, result);
  void result.finally(() => {
    if (projectQueues.get(projectId) === result) projectQueues.delete(projectId);
  }).catch(() => undefined);
  return result;
}

export function putRuntimeRecord(collection: string, value: Record<string, unknown>, expectedRevision: number | null): RuntimeRecordMutation {
  return { type: "put", collection, id: String(value.id), expectedRevision, value };
}

export function deleteRuntimeRecord(collection: string, id: string, expectedRevision: number): RuntimeRecordMutation {
  return { type: "delete", collection, id, expectedRevision };
}
