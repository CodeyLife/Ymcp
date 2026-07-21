/** IndexedDB 结构版本；历史 schema 会保留用于原地升级。 */
import type { Transaction } from "dexie";
import { buildProjectReferenceCatalogs, emptyReferenceCatalog, sanitizeProposalReferencesInPlace, sanitizeReferenceRecordInPlace } from "./reference-integrity";

export const DB_VERSION = 25;

/**
 * 数据记录版本（写入 recordBase.schemaVersion）。
 * 与 DB_VERSION 解耦：记录版本跟踪单条数据的字段语义，数据库版本跟踪表结构。
 */
export const RECORD_SCHEMA_VERSION = 8;

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

export const V12_STORES: Record<string, string | null> = {
  ...V11_STORES,
};

export const V13_STORES: Record<string, string | null> = {
  ...V12_STORES,
};

export const V14_STORES: Record<string, string | null> = {
  ...V13_STORES,
};

export const V15_STORES: Record<string, string | null> = {
  ...V14_STORES,
  conversationThreads: "id, projectId, taskKey, targetId, status, lastMessageAt, [projectId+taskKey], [projectId+targetId]",
  conversationMessages: "id, projectId, threadId, role, createdAt, [threadId+createdAt]",
  conversationMemories: "id, projectId, threadId, targetId, scope, scopeKey, kind, status, updatedAt, [projectId+status], [projectId+scopeKey]",
  creativeBriefs: "id, projectId, threadId, targetDocumentId, status, updatedAt, [threadId+status], [projectId+targetDocumentId]",
  retrievalRuns: "id, projectId, threadId, messageId, targetDocumentId, status, createdAt, [threadId+createdAt]",
  memoryJobs: "id, projectId, jobType, idempotencyKey, status, availableAt, [projectId+status], [status+availableAt]",
};

export const V16_STORES: Record<string, string | null> = {
  ...V15_STORES,
};

export const V17_STORES: Record<string, string | null> = {
  ...V16_STORES,
  outlineNodes: "id, projectId, parentId, kind, order, [projectId+kind]",
  retrievalRuns: "id, projectId, threadId, messageId, targetKind, targetId, targetDocumentId, purpose, status, createdAt, [threadId+createdAt], [projectId+purpose]",
};

export const V18_STORES: Record<string, string | null> = {
  ...V17_STORES,
  outlineNodes: "id, projectId, phaseId, order, [projectId+phaseId]",
  documents: "id, projectId, order, plotSegmentId, status, updatedAt, branch, [projectId+status], [projectId+plotSegmentId]",
};

export const V19_STORES: Record<string, string | null> = {
  ...V18_STORES,
  iteratedSkills: "id, projectId, skillId, sourceWorkflowRunId, createdAt, [projectId+sourceWorkflowRunId], [projectId+skillId]",
};

export const V20_STORES: Record<string, string | null> = {
  ...V19_STORES,
  operationReceipts: "id, projectId, candidateId, operationId, action, status, createdAt, [candidateId+status], [operationId+status]",
};

export const V21_STORES: Record<string, string | null> = {
  ...V20_STORES,
  creativeRuns: "id, projectId, mode, status, updatedAt, [projectId+status]",
  creativeWorkItems: "id, projectId, creativeRunId, kind, status, updatedAt, [creativeRunId+status]",
  creativeReviews: "id, projectId, creativeRunId, workItemId, subjectArtifactId, verdict, createdAt",
  creativeRunEvents: "id, projectId, creativeRunId, sequence, type, idempotencyKey, [creativeRunId+sequence], [creativeRunId+idempotencyKey]",
};

export const V22_STORES: Record<string, string | null> = {
  ...V21_STORES,
  craftRuleCandidates: "id, projectId, targetKind, targetId, status, updatedAt, [projectId+status], [projectId+targetId]",
  promptTemplateVersions: "id, projectId, templateId, version, active, updatedAt, [projectId+templateId], [projectId+active]",
};

export const V23_STORES: Record<string, string | null> = {
  ...V22_STORES,
  creativeToolReceipts: "id, projectId, tool, idempotencyKey, createdAt, [projectId+tool+idempotencyKey]",
};

export const V24_STORES: Record<string, string | null> = {
  ...V23_STORES,
  creativeToolReceipts: "id, projectId, tool, idempotencyKey, status, createdAt, [projectId+tool+idempotencyKey]",
};

export const V25_STORES: Record<string, string | null> = {
  ...V24_STORES,
  creativeToolReceipts: "id, projectId, tool, idempotencyKey, status, createdAt, &[projectId+tool+idempotencyKey]",
};

const RETIRED_PLANNING_TASKS = new Set([
  "outline",
  "plot-design",
  "outline-section-update",
  "outline-field-revise",
  "chapter-arrangement",
]);

/** V18: discard the retired act/sequence/event outline and its pending review state. */
export async function resetNovelPlanningHierarchy(transaction: Transaction) {
  await Promise.all([
    transaction.table("outlineNodes").clear(),
    transaction.table("outlineRealizations").clear(),
    transaction.table("embeddings").where("targetTable").equals("outlineNodes").delete(),
    transaction.table("proposals").where("status").equals("pending")
      .filter((proposal: Record<string, unknown>) => RETIRED_PLANNING_TASKS.has(String(proposal.taskKey ?? "")))
      .delete(),
  ]);
  await transaction.table("documents").toCollection().modify((document: Record<string, unknown>) => {
    const blueprint = document.blueprint && typeof document.blueprint === "object" && !Array.isArray(document.blueprint)
      ? document.blueprint as Record<string, unknown>
      : {};
    document.blueprint = {
      ...blueprint,
      plotThreadIds: Array.isArray(blueprint.plotThreadIds) ? blueprint.plotThreadIds : [],
      foreshadowingIds: Array.isArray(blueprint.foreshadowingIds) ? blueprint.foreshadowingIds : [],
    };
    document.schemaVersion = RECORD_SCHEMA_VERSION;
  });
}

function cleanOutlineRecord(record: Record<string, unknown>) {
  const kind = record.kind;
  delete record.status;
  delete record.storyTime;
  delete record.tags;
  if (kind === "event") {
    if (!Array.isArray(record.characterIds)) record.characterIds = [];
    if (!Array.isArray(record.plotThreadIds)) record.plotThreadIds = [];
    if (!Array.isArray(record.foreshadowingIds)) record.foreshadowingIds = [];
  } else {
    delete record.characterIds;
    delete record.plotThreadIds;
    delete record.foreshadowingIds;
  }
  record.schemaVersion = RECORD_SCHEMA_VERSION;
  return record;
}

function migratedTimelineEvent(record: Record<string, unknown>) {
  const storyTime = typeof record.storyTime === "string" ? record.storyTime.trim() : "";
  if (!storyTime) return undefined;
  const now = Date.now();
  return {
    id: `outline-time:${String(record.id)}`,
    projectId: String(record.projectId ?? ""),
    schemaVersion: RECORD_SCHEMA_VERSION,
    revision: 1,
    createdAt: Number(record.createdAt ?? now),
    updatedAt: now,
    createdBy: String(record.createdBy ?? "migration-v17"),
    updatedBy: "migration-v17",
    title: `大纲时间：${String(record.title ?? "未命名节点")}`,
    storyDate: storyTime,
    duration: "",
    narrativeOrder: Number(record.order ?? 0),
    participantIds: record.kind === "event" && Array.isArray(record.characterIds) ? [...record.characterIds] : [],
    causeIds: [],
    consequenceIds: [],
    description: ["由旧大纲节点迁移。", String(record.summary ?? "")].filter(Boolean).join("\n"),
  };
}

function cleanOutlineProposal(proposal: Record<string, unknown>) {
  if (!Array.isArray(proposal.items)) return;
  for (const entry of proposal.items) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    if (item.targetTable !== "outlineNodes") continue;
    for (const key of ["payload", "before", "after"] as const) {
      const value = item[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      delete record.status;
      delete record.storyTime;
      delete record.tags;
      if (record.kind && record.kind !== "event") {
        delete record.characterIds;
        delete record.plotThreadIds;
        delete record.foreshadowingIds;
      }
    }
  }
}

/** V17: simplify outline nodes and preserve legacy story times in the timeline. */
export async function migrateOutlineNodeModel(transaction: Transaction) {
  const nodes = await transaction.table("outlineNodes").toArray() as Record<string, unknown>[];
  const timelineEvents = nodes.map(migratedTimelineEvent).filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (nodes.length) await transaction.table("outlineNodes").bulkPut(nodes.map((record) => cleanOutlineRecord(record)));
  if (timelineEvents.length) await transaction.table("timelineEvents").bulkPut(timelineEvents);
  await transaction.table("proposals").toCollection().modify((proposal: Record<string, unknown>) => cleanOutlineProposal(proposal));
}

export async function migrateNovelMemoryReliability(transaction: Transaction) {
  await transaction.table("conversationMemories").toCollection().modify((memory: Record<string, unknown>) => {
    if (!Array.isArray(memory.evidenceQuotes)) memory.evidenceQuotes = [];
    if (typeof memory.extractorVersion !== "string") memory.extractorVersion = "legacy-unverified";
  });
  await transaction.table("retrievalRuns").toCollection().modify((run: Record<string, unknown>) => {
    if (run.purpose !== "conversation" && run.purpose !== "workflow-stage") run.purpose = run.messageId ? "conversation" : "workflow-stage";
  });
  await transaction.table("memoryJobs").toCollection().modify((job: Record<string, unknown>) => {
    if (job.status === "running") {
      job.status = "pending";
      job.availableAt = Date.now();
      delete job.leaseOwner;
      delete job.leaseExpiresAt;
    }
  });
}

/**
 * 审批元信息污染模式：LLM 在内容字段里添加的"候选/待审核"等状态标记。
 * 这些状态应由系统通过 ProposalItem.status 管理，不应出现在内容字段值里。
 * 只剥离明确的尾部审批标记，避免误伤正常内容。
 */
const APPROVAL_META_PATTERNS = [
  /[\s]*[（(]\s*(?:候选设定|候选内容|候选|待审核|待确认|未批准|未经批准|仅供参考|待用户审核)[，,；;]?\s*(?:候选设定|候选内容|候选|待审核|待确认|未批准|未经批准|仅供参考|待用户审核)?\s*[)）][\s]*$/,
  /[\s]*[【[]\s*(?:候选设定|候选内容|候选|待审核|待确认|未批准|未经批准|仅供参考|待用户审核)[，,；;]?\s*(?:候选设定|候选内容|候选|待审核|待确认|未批准|未经批准|仅供参考|待用户审核)?\s*[】\]][\s]*$/,
  /[\s]*[-—–]\s*(?:候选设定|候选内容|候选|待审核|待确认|未批准|未经批准|仅供参考|待用户审核)\s*$/,
];

/** 剥离字符串值尾部的审批元信息标记。 */
export function stripApprovalMeta(value: string): string {
  let result = value;
  for (const pattern of APPROVAL_META_PATTERNS) result = result.replace(pattern, "");
  return result.trim();
}

/** 递归清洗记录中所有字符串字段的审批元信息污染（原地修改）。 */
export function sanitizeApprovalMetaInPlace(record: unknown): void {
  if (!record || typeof record !== "object") return;
  for (const key of Object.keys(record as Record<string, unknown>)) {
    const value = (record as Record<string, unknown>)[key];
    if (typeof value === "string") {
      const cleaned = stripApprovalMeta(value);
      if (cleaned !== value) (record as Record<string, unknown>)[key] = cleaned;
    } else if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === "object") sanitizeApprovalMetaInPlace(item);
    } else if (value && typeof value === "object") {
      sanitizeApprovalMetaInPlace(value);
    }
  }
}

/** V14 迁移：清洗历史数据中混入内容字段的审批元信息。 */
export async function cleanupApprovalMetaPollution(transaction: Transaction) {
  const TABLES = ["entities", "outlineNodes", "documents", "scenes", "plotThreads", "foreshadowing", "architectures", "timelineEvents", "relations"];
  await Promise.all(TABLES.map((table) => transaction.table(table).toCollection().modify((record) => sanitizeApprovalMetaInPlace(record))));
}

export async function cleanupPollutedMemorySummaries(transaction: Transaction) {
  const PATTERN = /^(已将原输出|原输出包含|原输出|已将)|Schema[\s\S]{0,16}(修复|JSON|字段|校验|映射|移除|超出)|修复为[\s\S]{0,16}Schema/i;
  await transaction.table("derivedMemories").toCollection().modify((record) => {
    const summary = typeof record.summary === "string" ? record.summary.trim() : "";
    if (!summary || !PATTERN.test(summary)) return;
    const content = (record.content ?? {}) as Record<string, unknown>;
    const details = [
      ...(Array.isArray(content.sceneOutcomes) ? content.sceneOutcomes : []),
      ...(Array.isArray(content.stateChanges) ? content.stateChanges : []),
      ...(Array.isArray(content.knowledgeChanges) ? content.knowledgeChanges : []),
      ...(Array.isArray(content.relationshipChanges) ? content.relationshipChanges : []),
      ...(Array.isArray(content.threadProgress) ? content.threadProgress : []),
      ...(Array.isArray(content.foreshadowingProgress) ? content.foreshadowingProgress : []),
      ...((Array.isArray(content.inheritedPressures) ? content.inheritedPressures : []).map((item: unknown) => `继承压力：${item}`)),
    ].filter((item) => typeof item === "string" && item.trim());
    record.summary = details[0] ? String(details[0]).slice(0, 200) : "(记忆摘要已清洗)";
    record.revision = (record.revision ?? 0) + 1;
    record.updatedAt = Date.now();
  });
}

export async function migrateOutlineBeatFields(transaction: Transaction) {
  await transaction.table("outlineNodes").toCollection().modify((record) => {
    const causality = typeof record.causality === "string" ? record.causality.trim() : "";
    const outcome = typeof record.outcome === "string" ? record.outcome.trim() : "";
    if (!causality && !outcome) {
      delete record.causality;
      delete record.outcome;
      return;
    }
    const summary = typeof record.summary === "string" ? record.summary : "";
    const parts = [summary, causality ? `因果：${causality}` : "", outcome ? `结果：${outcome}` : ""].filter(Boolean);
    record.summary = parts.join("\n");
    delete record.causality;
    delete record.outcome;
  });
}

export async function cleanupReferenceIntegrity(transaction: Transaction) {
  const [entities, threads, clues, timelineEvents, outlineNodes] = await Promise.all([
    transaction.table("entities").toArray(),
    transaction.table("plotThreads").toArray(),
    transaction.table("foreshadowing").toArray(),
    transaction.table("timelineEvents").toArray(),
    transaction.table("outlineNodes").toArray(),
  ]);
  const catalogs = buildProjectReferenceCatalogs(entities, threads, clues, timelineEvents, outlineNodes);
  const catalogFor = (record: Record<string, unknown>) => catalogs.get(String(record.projectId ?? "")) ?? emptyReferenceCatalog();
  await Promise.all([
    transaction.table("outlineNodes").toCollection().modify((record) => sanitizeReferenceRecordInPlace("outlineNodes", record, catalogFor(record))),
    transaction.table("scenes").toCollection().modify((record) => sanitizeReferenceRecordInPlace("scenes", record, catalogFor(record))),
    transaction.table("documents").toCollection().modify((record) => sanitizeReferenceRecordInPlace("documents", record, catalogFor(record))),
    transaction.table("plotThreads").toCollection().modify((record) => sanitizeReferenceRecordInPlace("plotThreads", record, catalogFor(record))),
    transaction.table("timelineEvents").toCollection().modify((record) => sanitizeReferenceRecordInPlace("timelineEvents", record, catalogFor(record))),
    transaction.table("foreshadowing").toCollection().modify((record) => sanitizeReferenceRecordInPlace("foreshadowing", record, catalogFor(record))),
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
