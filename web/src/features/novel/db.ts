import Dexie, { type EntityTable, type Table } from "dexie";
import type {
  AgentRun,
  AIProposal,
  ArchitecturePhase,
  CanvasLayout,
  CanvasPanelKey,
  ChangeOperation,
  ConversationMemory,
  CreativeBrief,
  CreativeReview,
  CreativeRun,
  CreativeRunEvent,
  CreativeWorkItem,
  CreativeToolReceipt,
  CraftRuleCandidate,
  DocumentRevision,
  EntityRelation,
  FactAssertion,
  KnowledgeAssertion,
  DerivedMemory,
  IteratedSkillRecord,
  NarrativeUnit,
  OutlineRealization,
  Foreshadowing,
  ManuscriptDocument,
  ManuscriptChange,
  NovelContextPacket,
  NovelEmbedding,
  NovelConversationMessage,
  NovelConversationThread,
  NovelMemoryJob,
  NovelRetrievalRun,
  NovelSkillManifest,
  OutlineNode,
  PlotThread,
  PreferenceSignal,
  ProjectSkillBinding,
  ProjectTasteProfile,
  PromptTemplateVersion,
  QualityReport,
  FactCandidate,
  StoryEntity,
  StoryArchitecture,
  StoryProject,
  StoryScene,
  StorySnapshot,
  SyncConflict,
  TimelineEvent,
  WorkflowArtifact,
  WorkflowDefinition,
  WorkflowRun,
} from "./types";
import type { CanvasEdge, CanvasNodeLayout, ViewportTransform } from "@/shared/canvas";
import type { OperationReceipt } from "./evaluation/types";
import { cleanupApprovalMetaPollution, cleanupPollutedMemorySummaries, cleanupReferenceIntegrity, migrateLegacyProposal, migrateNovelMemoryReliability, migrateOutlineBeatFields, migrateOutlineNodeModel, RECORD_SCHEMA_VERSION, removeReaderPromise, removeReaderPromiseFromProposal, resetNovelPlanningHierarchy, V4_STORES, V5_STORES, V6_STORES, V7_STORES, V8_STORES, V9_STORES, V10_STORES, V11_STORES, V12_STORES, V13_STORES, V14_STORES, V15_STORES, V16_STORES, V17_STORES, V18_STORES, V19_STORES, V20_STORES, V21_STORES, V22_STORES, V23_STORES, V24_STORES, V25_STORES, V26_STORES } from "./db-schema";
import { upsertEmbedding } from "./retrieval";

const ACTOR_ID = "local-user";
export type RuntimeRecordMutation = { type: "put" | "delete"; collection: string; id: string; expectedRevision: number | null; value?: Record<string, unknown> };
type FormalMutationCommitter = (projectId: string, mutations: RuntimeRecordMutation[]) => Promise<unknown>;
let formalMutationCommitter: FormalMutationCommitter | undefined;
type FormalChapterDeleteCommitter = (projectId: string, documentId: string) => Promise<unknown>;
let formalChapterDeleteCommitter: FormalChapterDeleteCommitter | undefined;

export function setFormalMutationCommitter(committer: FormalMutationCommitter | undefined) {
  formalMutationCommitter = committer;
}

export function setFormalChapterDeleteCommitter(committer: FormalChapterDeleteCommitter | undefined) {
  formalChapterDeleteCommitter = committer;
}

export function isFormalMutationRuntimeEnabled() {
  return Boolean(formalMutationCommitter);
}

async function commitThroughRuntime(projectId: string, mutations: RuntimeRecordMutation[]) {
  if (!formalMutationCommitter) return false;
  await formalMutationCommitter(projectId, mutations);
  return true;
}

function deviceId(): string {
  const key = "ymcp-novel-device-id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}

export function recordBase(projectId: string) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    projectId,
    schemaVersion: RECORD_SCHEMA_VERSION,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: ACTOR_ID,
    updatedBy: ACTOR_ID,
  };
}

export class NovelDatabase extends Dexie {
  projects!: EntityTable<StoryProject, "id">;
  architectures!: EntityTable<StoryArchitecture, "id">;
  entities!: EntityTable<StoryEntity, "id">;
  relations!: EntityTable<EntityRelation, "id">;
  outlineNodes!: EntityTable<OutlineNode, "id">;
  scenes!: EntityTable<StoryScene, "id">;
  documents!: EntityTable<ManuscriptDocument, "id">;
  revisions!: EntityTable<DocumentRevision, "id">;
  manuscriptChanges!: EntityTable<ManuscriptChange, "id">;
  plotThreads!: EntityTable<PlotThread, "id">;
  foreshadowing!: EntityTable<Foreshadowing, "id">;
  timelineEvents!: EntityTable<TimelineEvent, "id">;
  snapshots!: EntityTable<StorySnapshot, "id">;
  contextPackets!: EntityTable<NovelContextPacket, "id">;
  proposals!: EntityTable<AIProposal, "id">;
  agentRuns!: EntityTable<AgentRun, "id">;
  operations!: EntityTable<ChangeOperation, "id">;
  conflicts!: EntityTable<SyncConflict, "id">;
  skills!: EntityTable<NovelSkillManifest, "id">;
  projectSkills!: EntityTable<ProjectSkillBinding, "id">;
  iteratedSkills!: EntityTable<IteratedSkillRecord, "id">;
  operationReceipts!: EntityTable<OperationReceipt, "id">;
  workflowDefinitions!: EntityTable<WorkflowDefinition, "id">;
  workflowRuns!: EntityTable<WorkflowRun, "id">;
  workflowArtifacts!: EntityTable<WorkflowArtifact, "id">;
  qualityReports!: EntityTable<QualityReport, "id">;
  factCandidates!: EntityTable<FactCandidate, "id">;
  factAssertions!: EntityTable<FactAssertion, "id">;
  knowledgeAssertions!: EntityTable<KnowledgeAssertion, "id">;
  narrativeUnits!: EntityTable<NarrativeUnit, "id">;
  outlineRealizations!: EntityTable<OutlineRealization, "id">;
  derivedMemories!: EntityTable<DerivedMemory, "id">;
  preferenceSignals!: EntityTable<PreferenceSignal, "id">;
  tasteProfiles!: EntityTable<ProjectTasteProfile, "id">;
  embeddings!: EntityTable<NovelEmbedding, "id">;
  canvasLayouts!: EntityTable<CanvasLayout, "id">;
  conversationThreads!: EntityTable<NovelConversationThread, "id">;
  conversationMessages!: EntityTable<NovelConversationMessage, "id">;
  conversationMemories!: EntityTable<ConversationMemory, "id">;
  creativeBriefs!: EntityTable<CreativeBrief, "id">;
  retrievalRuns!: EntityTable<NovelRetrievalRun, "id">;
  memoryJobs!: EntityTable<NovelMemoryJob, "id">;
  creativeRuns!: EntityTable<CreativeRun, "id">;
  creativeWorkItems!: EntityTable<CreativeWorkItem, "id">;
  creativeReviews!: EntityTable<CreativeReview, "id">;
  creativeRunEvents!: EntityTable<CreativeRunEvent, "id">;
  craftRuleCandidates!: EntityTable<CraftRuleCandidate, "id">;
  promptTemplateVersions!: EntityTable<PromptTemplateVersion, "id">;
  creativeToolReceipts!: EntityTable<CreativeToolReceipt, "id">;

  constructor(databaseName = "ymcp-novel-db-v4") {
    super(databaseName);
    this.version(4).stores(V4_STORES);
    this.version(5).stores(V5_STORES).upgrade(async (transaction) => {
      await transaction.table("proposals").toCollection().modify(migrateLegacyProposal);
    });
    this.version(6).stores(V6_STORES);
    this.version(7).stores(V7_STORES).upgrade(async (transaction) => {
      await Promise.all([
        transaction.table("architectures").toCollection().modify(removeReaderPromise),
        transaction.table("proposals").toCollection().modify(removeReaderPromiseFromProposal),
      ]);
    });
    this.version(8).stores(V8_STORES);
    this.version(9).stores(V9_STORES);
    this.version(10).stores(V10_STORES);
    this.version(11).stores(V11_STORES).upgrade(cleanupReferenceIntegrity);
    this.version(12).stores(V12_STORES).upgrade(migrateOutlineBeatFields);
    this.version(13).stores(V13_STORES).upgrade(cleanupPollutedMemorySummaries);
    this.version(14).stores(V14_STORES).upgrade(cleanupApprovalMetaPollution);
    this.version(15).stores(V15_STORES);
    this.version(16).stores(V16_STORES).upgrade(migrateNovelMemoryReliability);
    this.version(17).stores(V17_STORES).upgrade(migrateOutlineNodeModel);
    this.version(18).stores(V18_STORES).upgrade(resetNovelPlanningHierarchy);
    this.version(19).stores(V19_STORES);
    this.version(20).stores(V20_STORES);
    this.version(21).stores(V21_STORES);
    this.version(22).stores(V22_STORES);
    this.version(23).stores(V23_STORES);
    this.version(24).stores(V24_STORES).upgrade(async (transaction) => {
      const table = transaction.table("creativeToolReceipts");
      const receipts = await table.toArray() as Array<Record<string, unknown>>;
      const keepByKey = new Map<string, Record<string, unknown>>();
      for (const receipt of receipts.sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))) {
        const key = `${receipt.projectId}\u0000${receipt.tool}\u0000${receipt.idempotencyKey}`;
        if (!keepByKey.has(key)) keepByKey.set(key, receipt);
      }
      const keepIds = new Set([...keepByKey.values()].map((receipt) => String(receipt.id)));
      await table.bulkDelete(receipts.filter((receipt) => !keepIds.has(String(receipt.id))).map((receipt) => receipt.id));
      await table.toCollection().modify((receipt: Record<string, unknown>) => {
        receipt.status = "completed";
        receipt.startedAt = typeof receipt.createdAt === "number" ? receipt.createdAt : Date.now();
        receipt.completedAt = typeof receipt.updatedAt === "number" ? receipt.updatedAt : Date.now();
      });
    });
    this.version(25).stores(V25_STORES);
    this.version(26).stores(V26_STORES);
  }
}

export const novelDb = new NovelDatabase();

async function markDerivedMemoriesStale(db: NovelDatabase, projectId: string, seedIds: string[], reason: string, now: number) {
  if (!seedIds.length) return [];
  const memories = await db.derivedMemories.where("projectId").equals(projectId).toArray();
  const staleIds = new Set(seedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const memory of memories) {
      if (!staleIds.has(memory.id) && memory.sourceMemoryIds.some((sourceId) => staleIds.has(sourceId))) {
        staleIds.add(memory.id);
        changed = true;
      }
    }
  }
  const affected = memories.filter((memory) => staleIds.has(memory.id) && memory.status !== "stale" && memory.status !== "superseded");
  if (affected.length) {
    await db.derivedMemories.bulkPut(affected.map((memory) => ({
      ...memory,
      status: "stale" as const,
      validation: { passed: false, issues: [reason], checkedAt: now },
      revision: memory.revision + 1,
      updatedAt: now,
      updatedBy: ACTOR_ID,
    })));
  }
  return [...staleIds];
}

export async function invalidateRevisionDependentsInCurrentTransaction(db: NovelDatabase, projectId: string, sourceRevisionIds: string[], reason: string) {
  if (!sourceRevisionIds.length) return [];
  const revisionIds = new Set(sourceRevisionIds);
  const now = Date.now();
  const assertions = await db.factAssertions.where("projectId").equals(projectId)
    .and((assertion) => assertion.status === "active" && revisionIds.has(assertion.sourceRevisionId))
    .toArray();
  const assertionIds = new Set(assertions.map((assertion) => assertion.id));
  const knowledge = await db.knowledgeAssertions.where("projectId").equals(projectId)
    .and((entry) => entry.status === "active" && (revisionIds.has(entry.sourceRevisionId) || assertionIds.has(entry.factAssertionId)))
    .toArray();
  const memorySeeds = await db.derivedMemories.where("projectId").equals(projectId)
    .and((memory) => Boolean(memory.sourceRevisionId && revisionIds.has(memory.sourceRevisionId)))
    .toArray();
  if (assertions.length) await db.factAssertions.bulkPut(assertions.map((assertion) => ({ ...assertion, status: "stale" as const, revision: assertion.revision + 1, updatedAt: now, updatedBy: ACTOR_ID })));
  if (knowledge.length) await db.knowledgeAssertions.bulkPut(knowledge.map((entry) => ({ ...entry, status: "stale" as const, revision: entry.revision + 1, updatedAt: now, updatedBy: ACTOR_ID })));
  return markDerivedMemoriesStale(db, projectId, memorySeeds.map((memory) => memory.id), reason, now);
}

export async function invalidateRevisionDependents(projectId: string, sourceRevisionIds: string[], reason = "来源正文修订已被取代", db: NovelDatabase = novelDb) {
  return db.transaction("rw", db.factAssertions, db.knowledgeAssertions, db.derivedMemories, () =>
    invalidateRevisionDependentsInCurrentTransaction(db, projectId, sourceRevisionIds, reason));
}

export async function retireChapterDependencies(projectId: string, documentId: string, sourceRevisionIds: string[]) {
  const revisionIds = new Set(sourceRevisionIds);
  const now = Date.now();
  const assertions = await novelDb.factAssertions.where("projectId").equals(projectId)
    .and((assertion) => assertion.status === "active" && (revisionIds.has(assertion.sourceRevisionId) || assertion.revealedAt?.chapterId === documentId))
    .toArray();
  const assertionIds = new Set(assertions.map((assertion) => assertion.id));
  const knowledge = await novelDb.knowledgeAssertions.where("projectId").equals(projectId)
    .and((entry) => entry.status === "active" && (revisionIds.has(entry.sourceRevisionId) || assertionIds.has(entry.factAssertionId)))
    .toArray();
  const memorySeeds = await novelDb.derivedMemories.where("projectId").equals(projectId)
    .and((memory) => memory.documentId === documentId
      || Boolean(memory.sourceRevisionId && revisionIds.has(memory.sourceRevisionId))
      || memory.coverage.chapterIds.includes(documentId))
    .toArray();
  if (assertions.length) await novelDb.factAssertions.bulkPut(assertions.map((assertion) => ({ ...assertion, status: "retracted" as const, revision: assertion.revision + 1, updatedAt: now, updatedBy: ACTOR_ID })));
  if (knowledge.length) await novelDb.knowledgeAssertions.bulkPut(knowledge.map((entry) => ({ ...entry, status: "retracted" as const, revision: entry.revision + 1, updatedAt: now, updatedBy: ACTOR_ID })));
  await markDerivedMemoriesStale(novelDb, projectId, memorySeeds.map((memory) => memory.id), "来源章节已删除，需要重新整合", now);
  const realizations = await novelDb.outlineRealizations.where("[projectId+documentId]").equals([projectId, documentId]).primaryKeys();
  if (realizations.length) await novelDb.outlineRealizations.bulkDelete(realizations as string[]);
}

export async function deleteOutlineRealizations(projectId: string, outlineNodeIds: string[]) {
  if (!outlineNodeIds.length) return;
  const removed = new Set(outlineNodeIds);
  const realizationIds = await novelDb.outlineRealizations.where("projectId").equals(projectId)
    .and((item) => removed.has(item.outlineNodeId))
    .primaryKeys();
  if (realizationIds.length) await novelDb.outlineRealizations.bulkDelete(realizationIds as string[]);
}

export async function appendOperation(
  projectId: string,
  table: string,
  entityId: string,
  action: ChangeOperation["action"],
  fieldChanges: ChangeOperation["fieldChanges"],
  db: NovelDatabase = novelDb,
) {
  await db.operations.add(createOperation(projectId, table, entityId, action, fieldChanges));
}

function createOperation(
  projectId: string,
  table: string,
  entityId: string,
  action: ChangeOperation["action"],
  fieldChanges: ChangeOperation["fieldChanges"],
): ChangeOperation {
  const base = recordBase(projectId);
  const clock = Date.now();
  return {
    ...base,
    operationId: base.id,
    deviceId: deviceId(),
    actorId: ACTOR_ID,
    logicalClock: clock,
    entityTable: table,
    entityId,
    action,
    fieldChanges,
    syncStatus: "local",
    idempotencyKey: `${deviceId()}:${clock}:${entityId}`,
  };
}

export async function commitFormalRecordChanges(projectId: string, changes: Array<{
  collection: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  fieldChanges?: ChangeOperation["fieldChanges"];
}>) {
  if (!changes.length) return;
  const mutations: RuntimeRecordMutation[] = [];
  const operations: ChangeOperation[] = [];
  for (const change of changes) {
    const record = change.after ?? change.before;
    if (!record || typeof record.id !== "string") throw new Error("正式记录变更缺少 id");
    const action: ChangeOperation["action"] = change.after ? change.before ? "update" : "create" : "delete";
    const operation = createOperation(projectId, change.collection, record.id, action, change.fieldChanges ?? { value: { before: change.before, after: change.after } });
    operations.push(operation);
    if (change.after) mutations.push({
      type: "put",
      collection: change.collection,
      id: record.id,
      expectedRevision: change.before ? Number(change.before.revision ?? 0) : null,
      value: change.after,
    });
    else mutations.push({ type: "delete", collection: change.collection, id: record.id, expectedRevision: Number(change.before?.revision ?? 0) });
    mutations.push({ type: "put", collection: "operations", id: operation.id, expectedRevision: null, value: operation as unknown as Record<string, unknown> });
  }
  if (await commitThroughRuntime(projectId, mutations)) return;
  const tables = [...new Set(changes.map((change) => novelDb.tables.find((table) => table.name === change.collection)).filter((table): table is Table => Boolean(table)))];
  await novelDb.transaction("rw", [...tables, novelDb.operations], async () => {
    for (const change of changes) {
      const table = novelDb.tables.find((candidate) => candidate.name === change.collection);
      const record = change.after ?? change.before;
      if (!table || !record || typeof record.id !== "string") continue;
      if (change.after) await table.put(change.after);
      else await table.delete(record.id);
    }
    await novelDb.operations.bulkAdd(operations);
  });
}

export async function createNovelProject(input: Pick<StoryProject, "title" | "genre" | "premise">, db: NovelDatabase = novelDb) {
  const now = Date.now();
  const id = crypto.randomUUID();
  const project: StoryProject = {
    id,
    schemaVersion: RECORD_SCHEMA_VERSION,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: ACTOR_ID,
    updatedBy: ACTOR_ID,
    title: input.title,
    subtitle: "",
    premise: input.premise,
    genre: input.genre,
    audience: "成年类型文学读者",
    themes: [],
    sellingPoints: [],
    pov: "第三人称限知",
    tense: "过去时",
    tone: "克制、清晰、有张力",
    languageStyle: "重视场景行动与人物选择，避免空泛总结。",
    targetWords: 300000,
    dailyGoal: 3000,
    status: "planning",
    coverColor: "#b5483a",
    settings: {
      textModel: "gpt-5-5",
      temperature: 0.75,
      recentChapterCount: 5,
      encrypted: false,
      contentProfile: "general-serial",
      maxAutoRevisions: 2,
      qualityThreshold: 3.7,
      approvalMode: "blueprint-and-manuscript",
    },
  };

  const architecture: StoryArchitecture = {
    ...recordBase(id),
    framework: "free",
    status: "draft",
    centralQuestion: input.premise,
    centralConflict: "",
    synopsis: "",
    powerCenters: [],
    feedbackLoops: [],
    longHorizonHooks: [],
    phases: [],
    growthCurves: [],
  };

  await db.transaction("rw", db.projects, db.architectures, db.operations, async () => {
    await db.projects.add(project);
    await db.architectures.add(architecture);
    await appendOperation(id, "projects", id, "create", { title: { before: null, after: project.title } }, db);
  });
  return project;
}

export async function ensureStoryArchitecture(projectId: string) {
  const existing = await novelDb.architectures.where("projectId").equals(projectId).first();
  if (existing) return existing;
  const project = await novelDb.projects.get(projectId);
  if (!project) throw new Error("项目不存在");
  const architecture: StoryArchitecture = {
    ...recordBase(projectId),
    framework: "free",
    status: "draft",
    centralQuestion: project.premise,
    centralConflict: "",
    synopsis: "",
    powerCenters: [],
    feedbackLoops: [],
    longHorizonHooks: [],
    phases: [],
    growthCurves: [],
  };
  await commitFormalRecordChanges(projectId, [{ collection: "architectures", after: architecture as unknown as Record<string, unknown> }]);
  return architecture;
}

export function normalizeArchitecturePhases(phases: ArchitecturePhase[]) {
  return phases.map((phase, order) => phase.order === order ? phase : { ...phase, order });
}

export function normalizeArchitecturePayload(payload: Record<string, unknown>) {
  const normalized: Record<string, unknown> = { ...payload };

  // Loop 26: 修复 LLM 输出的类型违规，使 payload 通过 JSON schema 校验。
  // 根因：LLM 倾向于把数组字段输出为字符串、遗漏 required 字段、使用非 enum 值。
  // validateArchitectureHardConstraints 只检查结构约束（引用完整性、计数），
  // 不检查 JSON schema 类型约束；accept 路径的 CREATE_PAYLOAD_VALIDATORS/PAYLOAD_VALIDATORS
  // 才检查类型。本函数在 validation 之前调用，把 LLM 输出规范化为 schema 合法形态。
  // 判定信号：accept 时报 "字段无效：/framework must be equal to one of the allowed values" 等
  // 类型错误，但 internalGate.passed=true（因 validateArchitectureHardConstraints 未检查类型）。

  // 1. framework enum：非合法值回退为 "free"（自定义结构的通用兜底）
  const FRAMEWORK_ENUM = ["free", "three-act", "four-part", "save-the-cat", "snowflake"];
  if (typeof normalized.framework === "string" && !FRAMEWORK_ENUM.includes(normalized.framework)) {
    normalized.framework = "free";
  }

  // 2. status enum：非合法值回退为 "draft"
  const STATUS_ENUM = ["draft", "approved"];
  if (typeof normalized.status === "string" && !STATUS_ENUM.includes(normalized.status)) {
    normalized.status = "draft";
  }

  // 3. powerCenters[].resources：字符串→数组（LLM 常用顿号/逗号分隔）
  if (Array.isArray(normalized.powerCenters)) {
    normalized.powerCenters = normalized.powerCenters.map((center) => {
      if (!center || typeof center !== "object" || Array.isArray(center)) return center;
      const c = { ...(center as Record<string, unknown>) };
      if (typeof c.resources === "string") {
        c.resources = c.resources.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
      }
      return c;
    });
  }

  // 4. feedbackLoops[].transmission：字符串→数组（LLM 常用 → 分隔步骤）
  if (Array.isArray(normalized.feedbackLoops)) {
    normalized.feedbackLoops = normalized.feedbackLoops.map((loop) => {
      if (!loop || typeof loop !== "object" || Array.isArray(loop)) return loop;
      const l = { ...(loop as Record<string, unknown>) };
      if (typeof l.transmission === "string") {
        l.transmission = l.transmission.split(/→|->|=>/).map((s) => s.trim()).filter(Boolean);
      }
      return l;
    });
  }

  // 5. longHorizonHooks[].payoffWindow：缺失时补默认值
  if (Array.isArray(normalized.longHorizonHooks)) {
    normalized.longHorizonHooks = normalized.longHorizonHooks.map((hook) => {
      if (!hook || typeof hook !== "object" || Array.isArray(hook)) return hook;
      const h = { ...(hook as Record<string, unknown>) };
      if (!h.payoffWindow || typeof h.payoffWindow !== "string") {
        h.payoffWindow = "百章后";
      }
      return h;
    });
  }

  // 6. growthCurves[].stageGoals：数组→字符串（schema 要求 string，LLM 常输出数组）
  if (Array.isArray(normalized.growthCurves)) {
    normalized.growthCurves = normalized.growthCurves.map((curve, index) => {
      if (!curve || typeof curve !== "object" || Array.isArray(curve)) return curve;
      const c = { ...(curve as Record<string, unknown>) };
      if (!c.id || typeof c.id !== "string") c.id = `curve-${index + 1}`;
      if (Array.isArray(c.stageGoals)) {
        c.stageGoals = c.stageGoals.join("；");
      }
      return c;
    });
  }

  if (Array.isArray(normalized.phases)) {
    normalized.phases = normalized.phases.map((phase, order) => phase && typeof phase === "object" && !Array.isArray(phase)
      ? { ...phase as Record<string, unknown>, order }
      : phase);
  }
  return normalized;
}

export async function saveStoryArchitecture(architecture: StoryArchitecture) {
  const before = await novelDb.architectures.get(architecture.id);
  const next = { ...architecture, phases: normalizeArchitecturePhases(architecture.phases), revision: (before?.revision ?? 0) + 1, updatedAt: Date.now(), updatedBy: ACTOR_ID };
  if (formalMutationCommitter) {
    const phaseIds = new Set(next.phases.map((phase) => phase.id));
    const removedSegments = await novelDb.outlineNodes.where("projectId").equals(architecture.projectId).and((segment) => !phaseIds.has(segment.phaseId)).toArray();
    const removedSegmentIds = removedSegments.map((segment) => segment.id);
    const [linkedDocuments, realizations, embeddings] = removedSegmentIds.length ? await Promise.all([
      novelDb.documents.where("projectId").equals(architecture.projectId).and((document) => Boolean(document.plotSegmentId && removedSegmentIds.includes(document.plotSegmentId))).toArray(),
      novelDb.outlineRealizations.where("projectId").equals(architecture.projectId).and((item) => removedSegmentIds.includes(item.outlineNodeId)).toArray(),
      novelDb.embeddings.where("targetId").anyOf(removedSegmentIds).toArray(),
    ]) : [[], [], []];
    await commitFormalRecordChanges(architecture.projectId, [
      { collection: "architectures", before: before as unknown as Record<string, unknown> | undefined, after: next as unknown as Record<string, unknown> },
      ...linkedDocuments.map((document) => ({ collection: "documents", before: document as unknown as Record<string, unknown>, after: { ...document, plotSegmentId: undefined, revision: document.revision + 1, updatedAt: Date.now() } as unknown as Record<string, unknown> })),
      ...removedSegments.map((segment) => ({ collection: "outlineNodes", before: segment as unknown as Record<string, unknown> })),
      ...realizations.map((item) => ({ collection: "outlineRealizations", before: item as unknown as Record<string, unknown> })),
      ...embeddings.map((item) => ({ collection: "embeddings", before: item as unknown as Record<string, unknown> })),
    ]);
    await normalizeChapterOrderByPlanning(architecture.projectId);
    return next;
  }
  await novelDb.transaction("rw", [novelDb.architectures, novelDb.outlineNodes, novelDb.documents, novelDb.outlineRealizations, novelDb.embeddings, novelDb.operations], async () => {
    const phaseIds = new Set(next.phases.map((phase) => phase.id));
    const removedSegments = await novelDb.outlineNodes.where("projectId").equals(architecture.projectId)
      .and((segment) => !phaseIds.has(segment.phaseId))
      .toArray();
    const removedSegmentIds = removedSegments.map((segment) => segment.id);
    if (removedSegmentIds.length) {
      const linkedDocuments = await novelDb.documents.where("projectId").equals(architecture.projectId)
        .and((document) => Boolean(document.plotSegmentId && removedSegmentIds.includes(document.plotSegmentId)))
        .toArray();
      if (linkedDocuments.length) {
        await novelDb.documents.bulkPut(linkedDocuments.map((document) => ({
          ...document,
          plotSegmentId: undefined,
          revision: document.revision + 1,
          updatedAt: Date.now(),
        })));
      }
      await novelDb.outlineNodes.bulkDelete(removedSegmentIds);
      await deleteOutlineRealizations(architecture.projectId, removedSegmentIds);
      await novelDb.embeddings.where("targetId").anyOf(removedSegmentIds).delete();
    }
    await novelDb.architectures.put(next);
    await appendOperation(architecture.projectId, "architectures", architecture.id, before ? "update" : "create", {
      value: { before, after: next },
    });
  });
  await normalizeChapterOrderByPlanning(architecture.projectId);
  return next;
}

export async function normalizeChapterOrderByPlanning(projectId: string) {
  const [architecture, segments, documents] = await Promise.all([
    novelDb.architectures.where("projectId").equals(projectId).first(),
    novelDb.outlineNodes.where("projectId").equals(projectId).toArray(),
    novelDb.documents.where("projectId").equals(projectId).toArray(),
  ]);
  const phaseOrder = new Map((architecture?.phases ?? []).map((phase) => [phase.id, phase.order]));
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const sorted = [...documents].sort((left, right) => {
    const leftSegment = left.plotSegmentId ? segmentById.get(left.plotSegmentId) : undefined;
    const rightSegment = right.plotSegmentId ? segmentById.get(right.plotSegmentId) : undefined;
    if (Boolean(leftSegment) !== Boolean(rightSegment)) return leftSegment ? -1 : 1;
    if (leftSegment && rightSegment) {
      const phaseDelta = (phaseOrder.get(leftSegment.phaseId) ?? Number.MAX_SAFE_INTEGER) - (phaseOrder.get(rightSegment.phaseId) ?? Number.MAX_SAFE_INTEGER);
      if (phaseDelta) return phaseDelta;
      const segmentDelta = leftSegment.order - rightSegment.order;
      if (segmentDelta) return segmentDelta;
    }
    return left.order - right.order || left.createdAt - right.createdAt;
  });
  const changed = sorted.filter((document, order) => document.order !== order);
  if (!changed.length) return sorted;
  const now = Date.now();
  if (formalMutationCommitter) {
    await commitFormalRecordChanges(projectId, changed.map((document) => {
      const order = sorted.indexOf(document);
      return { collection: "documents", before: document as unknown as Record<string, unknown>, after: { ...document, order, revision: document.revision + 1, updatedAt: now } as unknown as Record<string, unknown> };
    }));
  } else {
    await novelDb.documents.bulkPut(sorted.map((document, order) => document.order === order ? document : {
      ...document,
      order,
      revision: document.revision + 1,
      updatedAt: now,
    }));
  }
  return sorted.map((document, order) => ({ ...document, order }));
}

export async function updateProject(projectId: string, changes: Partial<StoryProject>) {
  const before = await novelDb.projects.get(projectId);
  if (!before) throw new Error("项目不存在");
  const next = { ...changes, updatedAt: Date.now(), updatedBy: ACTOR_ID, revision: before.revision + 1 };
  const fieldChanges = Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, { before: before[key as keyof StoryProject], after: value }]));
  const operation = createOperation(projectId, "projects", projectId, "update", fieldChanges);
  if (await commitThroughRuntime(projectId, [
    { type: "put", collection: "projects", id: projectId, expectedRevision: before.revision, value: { ...before, ...next } },
    { type: "put", collection: "operations", id: operation.id, expectedRevision: null, value: operation as unknown as Record<string, unknown> },
  ])) return;
  await novelDb.transaction("rw", novelDb.projects, novelDb.operations, async () => {
    await novelDb.projects.update(projectId, next);
    await novelDb.operations.add(operation);
  });
}

export async function saveDocument(document: ManuscriptDocument, label?: string) {
  const before = await novelDb.documents.get(document.id);
  const revision = before && label ? {
    ...recordBase(document.projectId),
    documentId: document.id,
    label,
    contentHtml: before.contentHtml,
    plainText: before.plainText,
    source: "checkpoint" as const,
    branch: before.branch,
  } : undefined;
  const next = { ...document, updatedAt: Date.now(), revision: (before?.revision ?? 0) + 1 };
  const operation = createOperation(document.projectId, "documents", document.id, before ? "update" : "create", {
    contentHtml: { before: before?.contentHtml, after: document.contentHtml },
  });
  if (await commitThroughRuntime(document.projectId, [
    ...(revision ? [{ type: "put" as const, collection: "revisions", id: revision.id, expectedRevision: null, value: revision as unknown as Record<string, unknown> }] : []),
    { type: "put", collection: "documents", id: document.id, expectedRevision: before?.revision ?? null, value: next as unknown as Record<string, unknown> },
    { type: "put", collection: "operations", id: operation.id, expectedRevision: null, value: operation as unknown as Record<string, unknown> },
  ])) {
    triggerDocumentEmbedding(next);
    return;
  }
  await novelDb.transaction("rw", novelDb.documents, novelDb.revisions, novelDb.operations, async () => {
    if (revision) await novelDb.revisions.add(revision);
    await novelDb.documents.put(next);
    await novelDb.operations.add(operation);
  });
  triggerDocumentEmbedding(next);
}

function triggerDocumentEmbedding(document: ManuscriptDocument) {
  void upsertEmbedding({
    projectId: document.projectId,
    targetTable: "documents",
    targetId: document.id,
    content: [document.title, document.summary, document.plainText].filter(Boolean).join("\n"),
  }).catch(() => { /* TODO P3: embedding 更新失败应记录日志而非静默 */ });
}

export async function saveDocumentContent(params: {
  documentId: string;
  contentHtml: string;
  plainText: string;
  wordCount: number;
  status?: ManuscriptDocument["status"];
  checkpointLabel?: string;
}) {
  const before = await novelDb.documents.get(params.documentId);
  if (!before) throw new Error("章节不存在");
  const checkpoint = params.checkpointLabel ? {
    ...recordBase(before.projectId),
    documentId: before.id,
    label: params.checkpointLabel,
    contentHtml: before.contentHtml,
    plainText: before.plainText,
    source: "checkpoint" as const,
    branch: before.branch,
    approvalStatus: "checkpoint" as const,
    contentHash: documentContentHash(before),
  } : undefined;
  const saved: ManuscriptDocument = {
    ...before,
    contentHtml: params.contentHtml,
    plainText: params.plainText,
    wordCount: params.wordCount,
    status: params.status ?? before.status,
    revision: before.revision + 1,
    updatedAt: Date.now(),
    updatedBy: ACTOR_ID,
  };
  const operation = createOperation(before.projectId, "documents", before.id, "update", {
    contentHtml: { before: before.contentHtml, after: saved.contentHtml },
    plainText: { before: before.plainText, after: saved.plainText },
  });
  if (await commitThroughRuntime(before.projectId, [
    ...(checkpoint ? [{ type: "put" as const, collection: "revisions", id: checkpoint.id, expectedRevision: null, value: checkpoint as unknown as Record<string, unknown> }] : []),
    { type: "put", collection: "documents", id: before.id, expectedRevision: before.revision, value: saved as unknown as Record<string, unknown> },
    { type: "put", collection: "operations", id: operation.id, expectedRevision: null, value: operation as unknown as Record<string, unknown> },
  ])) {
    triggerDocumentEmbedding(saved);
    return saved;
  }
  await novelDb.transaction("rw", novelDb.documents, novelDb.revisions, novelDb.operations, async () => {
    if (checkpoint) await novelDb.revisions.add(checkpoint);
    await novelDb.documents.put(saved);
    await novelDb.operations.add(operation);
  });
  triggerDocumentEmbedding(saved);
  return saved;
}

export function documentContentHash(document: Pick<ManuscriptDocument, "contentHtml" | "plainText">) {
  const content = `${document.contentHtml}\n${document.plainText}`;
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) hash = Math.imul(hash ^ content.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function saveApprovedDocumentRevision(
  document: ManuscriptDocument,
  label: string,
  source: DocumentRevision["source"] = "ai",
  options?: {
    blocks?: DocumentRevision["blocks"];
    expected?: { documentRevision: number; contentHash: string; approvedRevisionId?: string };
    acceptedChangeIds?: string[];
    rejectedChangeIds?: string[];
  },
  db: NovelDatabase = novelDb,
) {
  const before = await db.documents.get(document.id);
  const now = Date.now();
  const approvedRevision: DocumentRevision = {
    ...recordBase(document.projectId),
    documentId: document.id,
    label,
    contentHtml: document.contentHtml,
    plainText: document.plainText,
    source,
    parentRevisionId: before?.approvedRevisionId,
    branch: document.branch,
    approvalStatus: "approved",
    approvedAt: now,
    contentHash: documentContentHash(document),
    blocks: options?.blocks,
  };
  const next: ManuscriptDocument = {
    ...document,
    approvedRevisionId: approvedRevision.id,
    updatedAt: now,
    updatedBy: ACTOR_ID,
    revision: (before?.revision ?? 0) + 1,
  };

  await db.transaction("rw", [db.documents, db.revisions, db.operations, db.manuscriptChanges, db.factAssertions, db.knowledgeAssertions, db.derivedMemories], async () => {
    const latest = await db.documents.get(document.id);
    if (options?.expected && (!latest
      || latest.revision !== options.expected.documentRevision
      || documentContentHash(latest) !== options.expected.contentHash
      || latest.approvedRevisionId !== options.expected.approvedRevisionId)) {
      throw new Error("正文基线已发生变化，请重新生成逐段审阅");
    }
    const supersededRevisionId = latest?.approvedRevisionId;
    if (supersededRevisionId) {
      await db.revisions.update(supersededRevisionId, { approvalStatus: "superseded", updatedAt: now, updatedBy: ACTOR_ID });
      await invalidateRevisionDependentsInCurrentTransaction(db, document.projectId, [supersededRevisionId], "来源正文修订已被取代");
    } else if (before && (before.contentHtml || before.plainText) && documentContentHash(before) !== approvedRevision.contentHash) {
      await db.revisions.add({
        ...recordBase(document.projectId),
        documentId: document.id,
        label: `${label}前`,
        contentHtml: before.contentHtml,
        plainText: before.plainText,
        source: "checkpoint",
        branch: before.branch,
        approvalStatus: "checkpoint",
        contentHash: documentContentHash(before),
      });
    }
    await db.revisions.add(approvedRevision);
    await db.documents.put(next);
    const decidedAt = Date.now();
    if (options?.acceptedChangeIds?.length) await db.manuscriptChanges.where("id").anyOf(options.acceptedChangeIds).modify({ status: "accepted", decidedAt, updatedAt: decidedAt, updatedBy: ACTOR_ID });
    if (options?.rejectedChangeIds?.length) await db.manuscriptChanges.where("id").anyOf(options.rejectedChangeIds).modify({ status: "rejected", decidedAt, updatedAt: decidedAt, updatedBy: ACTOR_ID });
    await appendOperation(document.projectId, "documents", document.id, before ? "update" : "create", {
      contentHtml: { before: before?.contentHtml, after: document.contentHtml },
      approvedRevisionId: { before: before?.approvedRevisionId, after: approvedRevision.id },
    }, db);
  });

  void upsertEmbedding({
    projectId: document.projectId,
    targetTable: "documents",
    targetId: document.id,
    content: [document.title, document.summary, document.plainText].filter(Boolean).join("\n"),
    db,
  }).catch(() => { /* semantic indexing degrades to keyword retrieval */ });
  return { document: next, revision: approvedRevision };
}

export async function addEntity(projectId: string, kind: StoryEntity["kind"], name: string) {
  const entity: StoryEntity = {
    ...recordBase(projectId),
    kind,
    name,
    aliases: [],
    summary: "",
    description: "",
    tags: [],
    lockedFacts: [],
    attributes: {},
    ...(kind === "character" ? { character: { role: "配角", appearance: "", personality: "", desire: "", motivation: "", weakness: "", secret: "", abilities: [], voice: "", arc: "", state: { location: "", physical: "正常", emotional: "平静", objective: "", inventory: [], relationshipNotes: [] } } } : {}),
  };
  const operation = createOperation(projectId, "entities", entity.id, "create", { name: { before: null, after: name } });
  if (await commitThroughRuntime(projectId, [
    { type: "put", collection: "entities", id: entity.id, expectedRevision: null, value: entity as unknown as Record<string, unknown> },
    { type: "put", collection: "operations", id: operation.id, expectedRevision: null, value: operation as unknown as Record<string, unknown> },
  ])) {
    triggerEntityEmbedding(entity);
    return entity;
  }
  await novelDb.transaction("rw", novelDb.entities, novelDb.operations, async () => {
    await novelDb.entities.add(entity);
    await novelDb.operations.add(operation);
  });
  triggerEntityEmbedding(entity);
  return entity;
}

export async function updateEntity(entity: StoryEntity) {
  const before = await novelDb.entities.get(entity.id);
  const next = { ...entity, revision: (before?.revision ?? 0) + 1, updatedAt: Date.now() };
  const operation = createOperation(entity.projectId, "entities", entity.id, before ? "update" : "create", {
    value: { before, after: entity },
  });
  if (await commitThroughRuntime(entity.projectId, [
    { type: "put", collection: "entities", id: entity.id, expectedRevision: before?.revision ?? null, value: next as unknown as Record<string, unknown> },
    { type: "put", collection: "operations", id: operation.id, expectedRevision: null, value: operation as unknown as Record<string, unknown> },
  ])) {
    triggerEntityEmbedding(next);
    return;
  }
  await novelDb.transaction("rw", novelDb.entities, novelDb.operations, async () => {
    await novelDb.entities.put(next);
    await novelDb.operations.add(operation);
  });
  triggerEntityEmbedding(next);
}

// 实体 embedding 内容构建：与 context.ts 候选源内容保持一致，确保向量检索语义对齐
function triggerEntityEmbedding(entity: StoryEntity): void {
  const content = [entity.name, entity.summary, entity.description, ...entity.lockedFacts, entity.character ? JSON.stringify(entity.character) : ""].filter(Boolean).join("\n");
  void upsertEmbedding({
    projectId: entity.projectId,
    targetTable: "entities",
    targetId: entity.id,
    content,
  }).catch(() => { /* TODO P3: embedding 更新失败应记录日志而非静默 */ });
}

export async function addOutlineNode(projectId: string, phaseId: string, title: string, order: number) {
  const node: OutlineNode = {
    ...recordBase(projectId),
    phaseId,
    title,
    summary: "",
    order,
  };
  const operation = createOperation(projectId, "outlineNodes", node.id, "create", { title: { before: null, after: title } });
  if (!(await commitThroughRuntime(projectId, [
    { type: "put", collection: "outlineNodes", id: node.id, expectedRevision: null, value: node as unknown as Record<string, unknown> },
    { type: "put", collection: "operations", id: operation.id, expectedRevision: null, value: operation as unknown as Record<string, unknown> },
  ]))) {
    await novelDb.outlineNodes.add(node);
    await novelDb.operations.add(operation);
  }
  // 异步触发 embedding 更新
  void upsertEmbedding({
    projectId,
    targetTable: "outlineNodes",
    targetId: node.id,
    content: [node.title, node.summary].filter(Boolean).join("\n"),
  }).catch(() => { /* TODO P3: embedding 更新失败应记录日志而非静默 */ });
  return node;
}

export async function deleteOutlineBranch(projectId: string, nodeId: string) {
  const nodes = await novelDb.outlineNodes.where("projectId").equals(projectId).toArray();
  const selected = nodes.find((node) => node.id === nodeId);
  if (!selected) return [];
  const removed = [nodeId];
  if (formalMutationCommitter) {
    const [linkedDocuments, realizations, embeddings] = await Promise.all([
      novelDb.documents.where("projectId").equals(projectId).and((document) => document.plotSegmentId === nodeId).toArray(),
      novelDb.outlineRealizations.where("projectId").equals(projectId).and((item) => removed.includes(item.outlineNodeId)).toArray(),
      novelDb.embeddings.where("targetId").anyOf(removed).toArray(),
    ]);
    await commitFormalRecordChanges(projectId, [
      ...linkedDocuments.map((document) => ({ collection: "documents", before: document as unknown as Record<string, unknown>, after: { ...document, plotSegmentId: undefined, revision: document.revision + 1, updatedAt: Date.now() } as unknown as Record<string, unknown> })),
      { collection: "outlineNodes", before: selected as unknown as Record<string, unknown>, fieldChanges: { title: { before: selected.title, after: null } } },
      ...realizations.map((item) => ({ collection: "outlineRealizations", before: item as unknown as Record<string, unknown> })),
      ...embeddings.map((item) => ({ collection: "embeddings", before: item as unknown as Record<string, unknown> })),
    ]);
    await normalizeChapterOrderByPlanning(projectId);
    return removed;
  }
  await novelDb.transaction("rw", novelDb.outlineNodes, novelDb.documents, novelDb.outlineRealizations, novelDb.embeddings, novelDb.operations, async () => {
    const linkedDocuments = await novelDb.documents.where("projectId").equals(projectId)
      .and((document) => document.plotSegmentId === nodeId)
      .toArray();
    if (linkedDocuments.length) {
      await novelDb.documents.bulkPut(linkedDocuments.map((document) => ({
        ...document,
        plotSegmentId: undefined,
        revision: document.revision + 1,
        updatedAt: Date.now(),
      })));
    }
    await novelDb.outlineNodes.bulkDelete(removed);
    await deleteOutlineRealizations(projectId, removed);
    await novelDb.embeddings.where("targetId").anyOf(removed).delete();
    await appendOperation(projectId, "outlineNodes", nodeId, "delete", { title: { before: selected.title, after: null } });
  });
  await normalizeChapterOrderByPlanning(projectId);
  return removed;
}

export const DEFAULT_CHAPTER_TARGET_WORDS = 5000;

export function emptyChapterBlueprint(targetWords = DEFAULT_CHAPTER_TARGET_WORDS) {
  return { objective: "", locationIds: [], characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "", informationRelease: [], mustHappen: [], flexible: [], forbidden: [], targetWords };
}

export async function createChapter(projectId: string, title?: string, plotSegmentId?: string) {
  const documents = await novelDb.documents.where("projectId").equals(projectId).toArray();
  const order = documents.length ? Math.max(...documents.map((item) => item.order)) + 1 : 0;
  const document: ManuscriptDocument = {
    ...recordBase(projectId),
    order,
    plotSegmentId,
    title: title || `第${order + 1}章`,
    blueprint: emptyChapterBlueprint(),
    contentHtml: "",
    plainText: "",
    summary: "",
    status: "outline",
    wordCount: 0,
    branch: "main",
    yjsDocumentId: crypto.randomUUID(),
  };
  const operation = createOperation(projectId, "documents", document.id, "create", { title: { before: null, after: document.title } });
  if (!(await commitThroughRuntime(projectId, [
    { type: "put", collection: "documents", id: document.id, expectedRevision: null, value: document as unknown as Record<string, unknown> },
    { type: "put", collection: "operations", id: operation.id, expectedRevision: null, value: operation as unknown as Record<string, unknown> },
  ]))) {
    await novelDb.transaction("rw", novelDb.documents, novelDb.operations, async () => {
      await novelDb.documents.add(document);
      await novelDb.operations.add(operation);
    });
  }
  await normalizeChapterOrderByPlanning(projectId);
  return (await novelDb.documents.get(document.id))!;
}

export async function deleteChapter(documentId: string) {
  const document = await novelDb.documents.get(documentId);
  if (!document) return;
  if (formalChapterDeleteCommitter) {
    await formalChapterDeleteCommitter(document.projectId, documentId);
    return;
  }
  const runs = await novelDb.workflowRuns.where("targetDocumentId").equals(documentId).toArray();
  const runIds = runs.map((run) => run.id);
  const chapterProposals = await novelDb.proposals.where("targetId").equals(documentId).toArray();
  const contextPacketIds = [...new Set([
    ...runs.map((run) => run.contextPacketId),
    ...chapterProposals.map((proposal) => proposal.contextPacketId),
  ].filter((id): id is string => Boolean(id)))];
  const workflowAgentRunIds = (await novelDb.agentRuns.where("projectId").equals(document.projectId).and((run) => Boolean(run.workflowRunId && runIds.includes(run.workflowRunId))).primaryKeys()) as string[];
  const agentRunIds = [...new Set([
    ...workflowAgentRunIds,
    ...chapterProposals.map((proposal) => proposal.agentRunId).filter((id): id is string => Boolean(id)),
  ])];
  const sceneIds = (await novelDb.scenes.where("chapterId").equals(documentId).primaryKeys()) as string[];
  const revisionIds = (await novelDb.revisions.where("documentId").equals(documentId).primaryKeys()) as string[];
  const embeddingIds = [documentId, ...sceneIds];
  const conversationThreads = await novelDb.conversationThreads.where("targetId").equals(documentId).toArray();
  const conversationThreadIds = conversationThreads.map((thread) => thread.id);
  const threadMemories = conversationThreadIds.length
    ? await novelDb.conversationMemories.where("threadId").anyOf(conversationThreadIds).toArray()
    : [];
  const retainedProjectMemories = threadMemories.filter((memory) => memory.scope === "project").map((memory): ConversationMemory => {
    const { threadId: _threadId, targetId: _targetId, ...retained } = memory;
    return { ...retained, sourceMessageIds: [], revision: memory.revision + 1, updatedAt: Date.now() };
  });
  const removedConversationMemoryIds = threadMemories.filter((memory) => memory.scope !== "project").map((memory) => memory.id);
  await novelDb.transaction("rw", [novelDb.documents, novelDb.scenes, novelDb.revisions, novelDb.manuscriptChanges, novelDb.workflowRuns, novelDb.workflowArtifacts, novelDb.qualityReports, novelDb.factCandidates, novelDb.factAssertions, novelDb.knowledgeAssertions, novelDb.derivedMemories, novelDb.outlineRealizations, novelDb.proposals, novelDb.agentRuns, novelDb.contextPackets, novelDb.embeddings, novelDb.operations, novelDb.conversationThreads, novelDb.conversationMessages, novelDb.conversationMemories, novelDb.creativeBriefs, novelDb.retrievalRuns, novelDb.memoryJobs], async () => {
    await retireChapterDependencies(document.projectId, documentId, revisionIds);
    await novelDb.documents.delete(documentId);
    await novelDb.scenes.where("chapterId").equals(documentId).delete();
    await novelDb.revisions.where("documentId").equals(documentId).delete();
    await novelDb.manuscriptChanges.where("documentId").equals(documentId).delete();
    if (runIds.length) {
      await novelDb.workflowArtifacts.where("workflowRunId").anyOf(runIds).delete();
      await novelDb.qualityReports.where("workflowRunId").anyOf(runIds).delete();
      await novelDb.factCandidates.where("workflowRunId").anyOf(runIds).delete();
      await novelDb.workflowRuns.bulkDelete(runIds);
      await novelDb.proposals.where("targetId").anyOf(runIds).delete();
      if (agentRunIds.length) await novelDb.agentRuns.bulkDelete(agentRunIds);
      if (contextPacketIds.length) await novelDb.contextPackets.bulkDelete(contextPacketIds);
    }
    await novelDb.proposals.where("targetId").equals(documentId).delete();
    await novelDb.embeddings.where("targetId").anyOf(embeddingIds).delete();
    if (conversationThreadIds.length) {
      await novelDb.conversationMessages.where("threadId").anyOf(conversationThreadIds).delete();
      if (removedConversationMemoryIds.length) {
        await novelDb.conversationMemories.bulkDelete(removedConversationMemoryIds);
        await novelDb.embeddings.where("targetId").anyOf(removedConversationMemoryIds).delete();
      }
      if (retainedProjectMemories.length) await novelDb.conversationMemories.bulkPut(retainedProjectMemories);
      await novelDb.creativeBriefs.where("threadId").anyOf(conversationThreadIds).delete();
      await novelDb.retrievalRuns.where("threadId").anyOf(conversationThreadIds).delete();
      await novelDb.conversationThreads.bulkDelete(conversationThreadIds);
    }
    await novelDb.memoryJobs.where("projectId").equals(document.projectId).and((job) => (
      job.payload.targetDocumentId === documentId
      || (typeof job.payload.threadId === "string" && conversationThreadIds.includes(job.payload.threadId))
      || (typeof job.payload.targetId === "string" && removedConversationMemoryIds.includes(job.payload.targetId))
    )).delete();
    await appendOperation(document.projectId, "documents", documentId, "delete", { title: { before: document.title, after: null } });
  });
  const { deleteCollaborativeDocument } = await import("./collaboration");
  await deleteCollaborativeDocument(document.projectId, document.yjsDocumentId);
}

export async function deletePlotThread(threadId: string) {
  const thread = await novelDb.plotThreads.get(threadId);
  if (!thread) return;
  const [documents, scenes] = await Promise.all([
    novelDb.documents.where("projectId").equals(thread.projectId).filter((document) => document.blueprint.plotThreadIds.includes(threadId)).toArray(),
    novelDb.scenes.where("projectId").equals(thread.projectId).filter((scene) => scene.plotThreadIds?.includes(threadId) ?? false).toArray(),
  ]);
  const now = Date.now();
  await commitFormalRecordChanges(thread.projectId, [
    ...documents.map((document) => ({
      collection: "documents",
      before: document as unknown as Record<string, unknown>,
      after: {
        ...document,
        blueprint: { ...document.blueprint, plotThreadIds: document.blueprint.plotThreadIds.filter((id) => id !== threadId) },
        revision: document.revision + 1,
        updatedAt: now,
        updatedBy: ACTOR_ID,
      } as unknown as Record<string, unknown>,
      fieldChanges: { plotThreadIds: { before: document.blueprint.plotThreadIds, after: document.blueprint.plotThreadIds.filter((id) => id !== threadId) } },
    })),
    ...scenes.map((scene) => ({
      collection: "scenes",
      before: scene as unknown as Record<string, unknown>,
      after: {
        ...scene,
        plotThreadIds: (scene.plotThreadIds ?? []).filter((id) => id !== threadId),
        revision: scene.revision + 1,
        updatedAt: now,
        updatedBy: ACTOR_ID,
      } as unknown as Record<string, unknown>,
      fieldChanges: { plotThreadIds: { before: scene.plotThreadIds ?? [], after: (scene.plotThreadIds ?? []).filter((id) => id !== threadId) } },
    })),
    { collection: "plotThreads", before: thread as unknown as Record<string, unknown>, fieldChanges: { title: { before: thread.title, after: null } } },
  ]);
}

export async function deleteProject(projectId: string) {
  await novelDb.transaction("rw", novelDb.tables, async () => {
    for (const table of novelDb.tables) {
      if (table.name === "projects") await table.delete(projectId);
      else if (table.schema.indexes.some((index) => index.name === "projectId")) await table.where("projectId").equals(projectId).delete();
    }
  });
}

export async function createCheckpoint(projectId: string, label: string) {
  const documents = await novelDb.documents.where("projectId").equals(projectId).toArray();
  const revisions = documents.map((doc) => ({
    ...recordBase(projectId), documentId: doc.id, label, contentHtml: doc.contentHtml, plainText: doc.plainText, source: "checkpoint" as const, branch: doc.branch,
  }));
  await commitFormalRecordChanges(projectId, revisions.map((revision) => ({ collection: "revisions", after: revision as unknown as Record<string, unknown> })));
}

export async function resolveConflict(conflict: SyncConflict, value: unknown, resolution: SyncConflict["status"]) {
  await novelDb.conflicts.update(conflict.id, { status: resolution, localValue: value, updatedAt: Date.now(), revision: conflict.revision + 1 });
}

export async function getCanvasLayout(projectId: string, panelKey: CanvasPanelKey): Promise<CanvasLayout | undefined> {
  return novelDb.canvasLayouts.where("[projectId+panelKey]").equals([projectId, panelKey]).first();
}

export async function saveCanvasLayout(
  projectId: string,
  panelKey: CanvasPanelKey,
  data: { viewport: ViewportTransform; nodes: CanvasNodeLayout[]; edges: CanvasEdge[] },
): Promise<CanvasLayout> {
  const existing = await getCanvasLayout(projectId, panelKey);
  const now = Date.now();
  if (existing) {
    const next: CanvasLayout = {
      ...existing,
      ...data,
      revision: existing.revision + 1,
      updatedAt: now,
      updatedBy: ACTOR_ID,
    };
    await novelDb.canvasLayouts.put(next);
    return next;
  }
  const layout: CanvasLayout = {
    ...recordBase(projectId),
    panelKey,
    ...data,
  };
  await novelDb.canvasLayouts.add(layout);
  return layout;
}
