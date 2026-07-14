/** IndexedDB 结构版本；历史 schema 会保留用于原地升级。 */
import type { Transaction } from "dexie";
import { buildProjectReferenceCatalogs, emptyReferenceCatalog, sanitizeProposalReferencesInPlace, sanitizeReferenceRecordInPlace } from "./reference-integrity";

export const DB_VERSION = 11;

/**
 * 数据记录版本（写入 recordBase.schemaVersion）。
 * 与 DB_VERSION 解耦：记录版本跟踪单条数据的字段语义，数据库版本跟踪表结构。
 */
export const RECORD_SCHEMA_VERSION = 6;

export const V4_STORES: Record<string, string> = {
  projects: "id, updatedAt, status, *genre",
  architectures: "id, projectId, status, updatedAt",
  entities: "id, projectId, kind, name, updatedAt, *tags, [projectId+kind]",
  relations: "id, projectId, fromEntityId, toEntityId, relationType",
  outlineNodes: "id, projectId, parentId, kind, order, status, [projectId+status]",
  scenes: "id, projectId, chapterId, order, status, [projectId+chapterId]",
  documents: "id, projectId, order, status, updatedAt, branch, [projectId+status]",
  revisions: "id, projectId, documentId, createdAt, branch",
  plotThreads: "id, projectId, kind, status, priority",
  foreshadowing: "id, projectId, status, urgency, targetNodeId",
  timelineEvents: "id, projectId, storyDate, narrativeOrder, *participantIds",
  snapshots: "id, projectId, createdAt",
  contextPackets: "id, projectId, createdAt, task",
  proposals: "id, projectId, targetId, projectGenerationRunId, status, createdAt, operation",
  agentRuns: "id, projectId, status, createdAt",
  projectGenerationRuns: "id, projectId, status, currentStage, updatedAt, [projectId+status]",
  operations: "id, projectId, operationId, logicalClock, syncStatus, idempotencyKey",
  conflicts: "id, projectId, status, entityId, [projectId+status]",
  skills: "id, skillId, projectId, source, category, enabled, [projectId+skillId]",
  projectSkills: "id, projectId, skillId, enabled, [projectId+skillId]",
  workflowDefinitions: "id, workflowId, projectId, builtin",
  workflowRuns: "id, projectId, workflowId, targetDocumentId, status, currentStage, updatedAt",
  workflowArtifacts: "id, projectId, workflowRunId, stage, kind, createdAt",
  qualityReports: "id, projectId, workflowRunId, artifactId, iteration, passed, createdAt",
  factCandidates: "id, projectId, workflowRunId, status, targetTable, targetId",
  preferenceSignals: "id, projectId, sourceType, category, createdAt",
  tasteProfiles: "id, projectId, status, updatedAt",
  embeddings: "id, projectId, targetTable, targetId, model, updatedAt, [projectId+targetTable]",
};

export const V5_STORES: Record<string, string | null> = {
  ...V4_STORES,
  proposals: "id, projectId, targetId, status, createdAt, operation",
  projectGenerationRuns: null,
};

export const V6_STORES: Record<string, string | null> = {
  ...V5_STORES,
  canvasLayouts: "id, projectId, panelKey, updatedAt, [projectId+panelKey]",
};

export const V7_STORES: Record<string, string | null> = {
  ...V6_STORES,
};

export const V8_STORES: Record<string, string | null> = {
  ...V7_STORES,
  factAssertions: "id, projectId, subject.id, predicate, truthStatus, status, sourceRevisionId, derivedFromCandidateId, [projectId+status]",
  knowledgeAssertions: "id, projectId, characterId, factAssertionId, stance, status, sourceRevisionId, [projectId+characterId]",
};

export const V9_STORES: Record<string, string | null> = {
  ...V8_STORES,
  narrativeUnits: "id, projectId, parentId, kind, order, status, [projectId+kind]",
  outlineRealizations: "id, projectId, outlineNodeId, documentId, sceneId, status, [projectId+documentId]",
  derivedMemories: "id, projectId, level, documentId, narrativeUnitId, sourceRevisionId, status, generatedAt, [projectId+status], [projectId+level]",
};

export const V10_STORES: Record<string, string | null> = {
  ...V9_STORES,
  manuscriptChanges: "id, projectId, documentId, workflowRunId, sourceArtifactId, baseRevisionId, status, [documentId+status], [workflowRunId+status]",
};

export const V11_STORES: Record<string, string | null> = {
  ...V10_STORES,
};

export async function cleanupReferenceIntegrity(transaction: Transaction) {
  const [entities, threads, clues] = await Promise.all([
    transaction.table("entities").toArray(),
    transaction.table("plotThreads").toArray(),
    transaction.table("foreshadowing").toArray(),
  ]);
  const catalogs = buildProjectReferenceCatalogs(entities, threads, clues);
  const catalogFor = (record: Record<string, unknown>) => catalogs.get(String(record.projectId ?? "")) ?? emptyReferenceCatalog();
  await Promise.all([
    transaction.table("outlineNodes").toCollection().modify((record) => sanitizeReferenceRecordInPlace("outlineNodes", record, catalogFor(record))),
    transaction.table("scenes").toCollection().modify((record) => sanitizeReferenceRecordInPlace("scenes", record, catalogFor(record))),
    transaction.table("documents").toCollection().modify((record) => sanitizeReferenceRecordInPlace("documents", record, catalogFor(record))),
    transaction.table("plotThreads").toCollection().modify((record) => sanitizeReferenceRecordInPlace("plotThreads", record, catalogFor(record))),
    transaction.table("timelineEvents").toCollection().modify((record) => sanitizeReferenceRecordInPlace("timelineEvents", record, catalogFor(record))),
    transaction.table("proposals").toCollection().modify((record) => sanitizeProposalReferencesInPlace(record, catalogFor(record))),
  ]);
}

export function migrateLegacyProposal(proposal: Record<string, unknown>) {
  delete proposal.projectGenerationRunId;
  if (proposal.taskKey === "project-positioning" && proposal.scope === "dashboard") proposal.scope = "bible";
  return proposal;
}

export function removeReaderPromise(record: Record<string, unknown>) {
  delete record.readerPromise;
  return record;
}

export function removeReaderPromiseFromProposal(proposal: Record<string, unknown>) {
  if (!Array.isArray(proposal.items)) return proposal;
  proposal.items = proposal.items.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const item = { ...(entry as Record<string, unknown>) };
    for (const key of ["payload", "before", "after"] as const) {
      const value = item[key];
      if (value && typeof value === "object" && !Array.isArray(value)) item[key] = removeReaderPromise({ ...(value as Record<string, unknown>) });
    }
    return item;
  });
  return proposal;
}
