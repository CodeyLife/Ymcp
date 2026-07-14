import Dexie, { type EntityTable } from "dexie";
import type {
  AgentRun,
  AIProposal,
  CanvasLayout,
  CanvasPanelKey,
  ChangeOperation,
  DocumentRevision,
  EntityRelation,
  FactAssertion,
  KnowledgeAssertion,
  DerivedMemory,
  NarrativeUnit,
  OutlineRealization,
  Foreshadowing,
  ManuscriptDocument,
  ManuscriptChange,
  NovelContextPacket,
  NovelEmbedding,
  NovelSkillManifest,
  OutlineNode,
  PlotThread,
  PreferenceSignal,
  ProjectSkillBinding,
  ProjectTasteProfile,
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
import { cleanupReferenceIntegrity, migrateLegacyProposal, RECORD_SCHEMA_VERSION, removeReaderPromise, removeReaderPromiseFromProposal, V4_STORES, V5_STORES, V6_STORES, V7_STORES, V8_STORES, V9_STORES, V10_STORES, V11_STORES } from "./db-schema";
import { upsertEmbedding } from "./retrieval";

const ACTOR_ID = "local-user";

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

  constructor() {
    super("ymcp-novel-db-v4");
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
  }
}

export const novelDb = new NovelDatabase();

async function markDerivedMemoriesStale(projectId: string, seedIds: string[], reason: string, now: number) {
  if (!seedIds.length) return [];
  const memories = await novelDb.derivedMemories.where("projectId").equals(projectId).toArray();
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
    await novelDb.derivedMemories.bulkPut(affected.map((memory) => ({
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

async function invalidateRevisionDependentsInCurrentTransaction(projectId: string, sourceRevisionIds: string[], reason: string) {
  if (!sourceRevisionIds.length) return [];
  const revisionIds = new Set(sourceRevisionIds);
  const now = Date.now();
  const assertions = await novelDb.factAssertions.where("projectId").equals(projectId)
    .and((assertion) => assertion.status === "active" && revisionIds.has(assertion.sourceRevisionId))
    .toArray();
  const assertionIds = new Set(assertions.map((assertion) => assertion.id));
  const knowledge = await novelDb.knowledgeAssertions.where("projectId").equals(projectId)
    .and((entry) => entry.status === "active" && (revisionIds.has(entry.sourceRevisionId) || assertionIds.has(entry.factAssertionId)))
    .toArray();
  const memorySeeds = await novelDb.derivedMemories.where("projectId").equals(projectId)
    .and((memory) => Boolean(memory.sourceRevisionId && revisionIds.has(memory.sourceRevisionId)))
    .toArray();
  if (assertions.length) await novelDb.factAssertions.bulkPut(assertions.map((assertion) => ({ ...assertion, status: "stale" as const, revision: assertion.revision + 1, updatedAt: now, updatedBy: ACTOR_ID })));
  if (knowledge.length) await novelDb.knowledgeAssertions.bulkPut(knowledge.map((entry) => ({ ...entry, status: "stale" as const, revision: entry.revision + 1, updatedAt: now, updatedBy: ACTOR_ID })));
  return markDerivedMemoriesStale(projectId, memorySeeds.map((memory) => memory.id), reason, now);
}

export async function invalidateRevisionDependents(projectId: string, sourceRevisionIds: string[], reason = "来源正文修订已被取代") {
  return novelDb.transaction("rw", novelDb.factAssertions, novelDb.knowledgeAssertions, novelDb.derivedMemories, () =>
    invalidateRevisionDependentsInCurrentTransaction(projectId, sourceRevisionIds, reason));
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
  await markDerivedMemoriesStale(projectId, memorySeeds.map((memory) => memory.id), "来源章节已删除，需要重新整合", now);
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
) {
  const base = recordBase(projectId);
  const clock = Date.now();
  await novelDb.operations.add({
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
  });
}

export async function createNovelProject(input: Pick<StoryProject, "title" | "genre" | "premise">) {
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
      textModel: "auto",
      temperature: 0.75,
      autoCommitFacts: false,
      contextBudget: 24000,
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
    phases: [],
  };

  await novelDb.transaction("rw", novelDb.projects, novelDb.architectures, novelDb.operations, async () => {
    await novelDb.projects.add(project);
    await novelDb.architectures.add(architecture);
    await appendOperation(id, "projects", id, "create", { title: { before: null, after: project.title } });
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
    phases: [],
  };
  await novelDb.architectures.add(architecture);
  return architecture;
}

export async function saveStoryArchitecture(architecture: StoryArchitecture) {
  const before = await novelDb.architectures.get(architecture.id);
  const next = { ...architecture, revision: (before?.revision ?? 0) + 1, updatedAt: Date.now(), updatedBy: ACTOR_ID };
  await novelDb.transaction("rw", novelDb.architectures, novelDb.operations, async () => {
    await novelDb.architectures.put(next);
    await appendOperation(architecture.projectId, "architectures", architecture.id, before ? "update" : "create", {
      value: { before, after: next },
    });
  });
  return next;
}

export async function updateProject(projectId: string, changes: Partial<StoryProject>) {
  const before = await novelDb.projects.get(projectId);
  if (!before) throw new Error("项目不存在");
  const next = { ...changes, updatedAt: Date.now(), updatedBy: ACTOR_ID, revision: before.revision + 1 };
  await novelDb.transaction("rw", novelDb.projects, novelDb.operations, async () => {
    await novelDb.projects.update(projectId, next);
    const fieldChanges = Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, { before: before[key as keyof StoryProject], after: value }]));
    await appendOperation(projectId, "projects", projectId, "update", fieldChanges);
  });
}

export async function saveDocument(document: ManuscriptDocument, label?: string) {
  const before = await novelDb.documents.get(document.id);
  await novelDb.transaction("rw", novelDb.documents, novelDb.revisions, novelDb.operations, async () => {
    if (before && label) {
      await novelDb.revisions.add({
        ...recordBase(document.projectId),
        documentId: document.id,
        label,
        contentHtml: before.contentHtml,
        plainText: before.plainText,
        source: "checkpoint",
        branch: before.branch,
      });
    }
    await novelDb.documents.put({ ...document, updatedAt: Date.now(), revision: (before?.revision ?? 0) + 1 });
    await appendOperation(document.projectId, "documents", document.id, before ? "update" : "create", {
      contentHtml: { before: before?.contentHtml, after: document.contentHtml },
    });
  });
  // 异步触发 embedding 更新：不阻塞主流程，失败静默（降级为纯关键词检索）
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
  let saved: ManuscriptDocument | undefined;
  await novelDb.transaction("rw", novelDb.documents, novelDb.revisions, novelDb.operations, async () => {
    const before = await novelDb.documents.get(params.documentId);
    if (!before) throw new Error("章节不存在");
    if (params.checkpointLabel) {
      await novelDb.revisions.add({
        ...recordBase(before.projectId),
        documentId: before.id,
        label: params.checkpointLabel,
        contentHtml: before.contentHtml,
        plainText: before.plainText,
        source: "checkpoint",
        branch: before.branch,
        approvalStatus: "checkpoint",
        contentHash: documentContentHash(before),
      });
    }
    const next: ManuscriptDocument = {
      ...before,
      contentHtml: params.contentHtml,
      plainText: params.plainText,
      wordCount: params.wordCount,
      status: params.status ?? before.status,
      revision: before.revision + 1,
      updatedAt: Date.now(),
      updatedBy: ACTOR_ID,
    };
    await novelDb.documents.put(next);
    await appendOperation(before.projectId, "documents", before.id, "update", {
      contentHtml: { before: before.contentHtml, after: next.contentHtml },
      plainText: { before: before.plainText, after: next.plainText },
    });
    saved = next;
  });
  if (!saved) throw new Error("正文保存失败");
  void upsertEmbedding({
    projectId: saved.projectId,
    targetTable: "documents",
    targetId: saved.id,
    content: [saved.title, saved.summary, saved.plainText].filter(Boolean).join("\n"),
  }).catch(() => { /* semantic indexing degrades to keyword retrieval */ });
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
) {
  const before = await novelDb.documents.get(document.id);
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

  await novelDb.transaction("rw", [novelDb.documents, novelDb.revisions, novelDb.operations, novelDb.manuscriptChanges, novelDb.factAssertions, novelDb.knowledgeAssertions, novelDb.derivedMemories], async () => {
    const latest = await novelDb.documents.get(document.id);
    if (options?.expected && (!latest
      || latest.revision !== options.expected.documentRevision
      || documentContentHash(latest) !== options.expected.contentHash
      || latest.approvedRevisionId !== options.expected.approvedRevisionId)) {
      throw new Error("正文基线已发生变化，请重新生成逐段审阅");
    }
    const supersededRevisionId = latest?.approvedRevisionId;
    if (supersededRevisionId) {
      await novelDb.revisions.update(supersededRevisionId, { approvalStatus: "superseded", updatedAt: now, updatedBy: ACTOR_ID });
      await invalidateRevisionDependentsInCurrentTransaction(document.projectId, [supersededRevisionId], "来源正文修订已被取代");
    } else if (before && (before.contentHtml || before.plainText) && documentContentHash(before) !== approvedRevision.contentHash) {
      await novelDb.revisions.add({
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
    await novelDb.revisions.add(approvedRevision);
    await novelDb.documents.put(next);
    const decidedAt = Date.now();
    if (options?.acceptedChangeIds?.length) await novelDb.manuscriptChanges.where("id").anyOf(options.acceptedChangeIds).modify({ status: "accepted", decidedAt, updatedAt: decidedAt, updatedBy: ACTOR_ID });
    if (options?.rejectedChangeIds?.length) await novelDb.manuscriptChanges.where("id").anyOf(options.rejectedChangeIds).modify({ status: "rejected", decidedAt, updatedAt: decidedAt, updatedBy: ACTOR_ID });
    await appendOperation(document.projectId, "documents", document.id, before ? "update" : "create", {
      contentHtml: { before: before?.contentHtml, after: document.contentHtml },
      approvedRevisionId: { before: before?.approvedRevisionId, after: approvedRevision.id },
    });
  });

  void upsertEmbedding({
    projectId: document.projectId,
    targetTable: "documents",
    targetId: document.id,
    content: [document.title, document.summary, document.plainText].filter(Boolean).join("\n"),
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
    ...(kind === "character" ? { character: { role: "配角", appearance: "", personality: "", desire: "", motivation: "", weakness: "", secret: "", abilities: [], voice: "", arc: "", knowledge: { known: [], suspected: [], mistaken: [], unknown: [] }, state: { location: "", physical: "正常", emotional: "平静", objective: "", inventory: [], relationshipNotes: [] } } } : {}),
  };
  await novelDb.transaction("rw", novelDb.entities, novelDb.operations, async () => {
    await novelDb.entities.add(entity);
    await appendOperation(projectId, "entities", entity.id, "create", { name: { before: null, after: name } });
  });
  triggerEntityEmbedding(entity);
  return entity;
}

export async function updateEntity(entity: StoryEntity) {
  const before = await novelDb.entities.get(entity.id);
  await novelDb.transaction("rw", novelDb.entities, novelDb.operations, async () => {
    await novelDb.entities.put({ ...entity, revision: (before?.revision ?? 0) + 1, updatedAt: Date.now() });
    await appendOperation(entity.projectId, "entities", entity.id, before ? "update" : "create", {
      value: { before, after: entity },
    });
  });
  triggerEntityEmbedding(entity);
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

export async function addOutlineNode(projectId: string, parentId: string | undefined, kind: OutlineNode["kind"], title: string, order: number) {
  const node: OutlineNode = { ...recordBase(projectId), parentId, kind, title, summary: "", order, status: "idea", causality: "", outcome: "", characterIds: [], plotThreadIds: [], foreshadowingIds: [], tags: [] };
  await novelDb.outlineNodes.add(node);
  await appendOperation(projectId, "outlineNodes", node.id, "create", { title: { before: null, after: title } });
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
  const ids = new Set<string>([nodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) { ids.add(node.id); changed = true; }
  }
  const removed = [...ids];
  await novelDb.transaction("rw", novelDb.outlineNodes, novelDb.outlineRealizations, novelDb.embeddings, novelDb.operations, async () => {
    await novelDb.outlineNodes.bulkDelete(removed);
    await deleteOutlineRealizations(projectId, removed);
    await novelDb.embeddings.where("targetId").anyOf(removed).delete();
    await appendOperation(projectId, "outlineNodes", nodeId, "delete", { title: { before: selected.title, after: null } });
  });
  return removed;
}

export function emptyChapterBlueprint(targetWords = 3000) {
  return { objective: "", locationIds: [], characterIds: [], conflict: "", informationRelease: [], turningPoint: "", hook: "", mustHappen: [], flexible: [], forbidden: [], targetWords };
}

export async function createChapter(projectId: string, title?: string) {
  return novelDb.transaction("rw", novelDb.documents, novelDb.operations, async () => {
    const documents = await novelDb.documents.where("projectId").equals(projectId).toArray();
    const order = documents.length ? Math.max(...documents.map((item) => item.order)) + 1 : 0;
    const document: ManuscriptDocument = {
      ...recordBase(projectId),
      order,
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
    await novelDb.documents.add(document);
    await appendOperation(projectId, "documents", document.id, "create", { title: { before: null, after: document.title } });
    return document;
  });
}

export async function deleteChapter(documentId: string) {
  const document = await novelDb.documents.get(documentId);
  if (!document) return;
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
  await novelDb.transaction("rw", [novelDb.documents, novelDb.scenes, novelDb.revisions, novelDb.manuscriptChanges, novelDb.workflowRuns, novelDb.workflowArtifacts, novelDb.qualityReports, novelDb.factCandidates, novelDb.factAssertions, novelDb.knowledgeAssertions, novelDb.derivedMemories, novelDb.outlineRealizations, novelDb.proposals, novelDb.agentRuns, novelDb.contextPackets, novelDb.embeddings, novelDb.operations], async () => {
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
    await appendOperation(document.projectId, "documents", documentId, "delete", { title: { before: document.title, after: null } });
  });
  const { deleteCollaborativeDocument } = await import("./collaboration");
  await deleteCollaborativeDocument(document.projectId, document.yjsDocumentId);
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
  await novelDb.revisions.bulkAdd(documents.map((doc) => ({
    ...recordBase(projectId), documentId: doc.id, label, contentHtml: doc.contentHtml, plainText: doc.plainText, source: "checkpoint" as const, branch: doc.branch,
  })));
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
