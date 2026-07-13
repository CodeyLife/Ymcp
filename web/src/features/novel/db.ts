import Dexie, { type EntityTable } from "dexie";
import type {
  AgentRun,
  AIProposal,
  ChangeOperation,
  DocumentRevision,
  EntityRelation,
  Foreshadowing,
  ManuscriptDocument,
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
import { migrateLegacyProposal, RECORD_SCHEMA_VERSION, V4_STORES, V5_STORES } from "./db-schema";
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
  preferenceSignals!: EntityTable<PreferenceSignal, "id">;
  tasteProfiles!: EntityTable<ProjectTasteProfile, "id">;
  embeddings!: EntityTable<NovelEmbedding, "id">;

  constructor() {
    super("ymcp-novel-db-v4");
    this.version(4).stores(V4_STORES);
    this.version(5).stores(V5_STORES).upgrade(async (transaction) => {
      await transaction.table("proposals").toCollection().modify(migrateLegacyProposal);
    });
  }
}

export const novelDb = new NovelDatabase();

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
    readerPromise: "",
    centralConflict: "",
    stakes: "",
    endingPromise: "",
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
    readerPromise: "",
    centralConflict: "",
    stakes: "",
    endingPromise: "",
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
  const node: OutlineNode = { ...recordBase(projectId), parentId, kind, title, summary: "", order, status: "idea", causality: "", outcome: "", characterIds: [], plotThreadIds: [], foreshadowingIds: [], tension: 30, emotion: 30, information: 30, tags: [] };
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
  await novelDb.transaction("rw", novelDb.outlineNodes, novelDb.embeddings, novelDb.operations, async () => {
    await novelDb.outlineNodes.bulkDelete(removed);
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
  const embeddingIds = [documentId, ...sceneIds];
  await novelDb.transaction("rw", [novelDb.documents, novelDb.scenes, novelDb.revisions, novelDb.workflowRuns, novelDb.workflowArtifacts, novelDb.qualityReports, novelDb.factCandidates, novelDb.proposals, novelDb.agentRuns, novelDb.contextPackets, novelDb.embeddings, novelDb.operations], async () => {
    await novelDb.documents.delete(documentId);
    await novelDb.scenes.where("chapterId").equals(documentId).delete();
    await novelDb.revisions.where("documentId").equals(documentId).delete();
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
