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
  NovelSkillManifest,
  OutlineNode,
  PlotThread,
  PreferenceSignal,
  ProjectSkillBinding,
  ProjectTasteProfile,
  QualityReport,
  FactCandidate,
  StoryEntity,
  StoryProject,
  StoryScene,
  StorySnapshot,
  SyncConflict,
  TimelineEvent,
  WorkflowArtifact,
  WorkflowDefinition,
  WorkflowRun,
} from "./types";

const ACTOR_ID = "local-user";
const SCHEMA_VERSION = 2;

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
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: ACTOR_ID,
    updatedBy: ACTOR_ID,
  };
}

export class NovelDatabase extends Dexie {
  projects!: EntityTable<StoryProject, "id">;
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

  constructor() {
    super("ymcp-novel-db-v2");
    this.version(1).stores({
      projects: "id, updatedAt, status, *genre",
      entities: "id, projectId, kind, name, updatedAt, *tags",
      relations: "id, projectId, fromEntityId, toEntityId, relationType",
      outlineNodes: "id, projectId, parentId, kind, order, status",
      scenes: "id, projectId, chapterId, order",
      documents: "id, projectId, outlineNodeId, status, updatedAt, branch",
      revisions: "id, projectId, documentId, createdAt, branch",
      plotThreads: "id, projectId, kind, status, priority",
      foreshadowing: "id, projectId, status, urgency, targetNodeId",
      timelineEvents: "id, projectId, storyDate, narrativeOrder, *participantIds",
      snapshots: "id, projectId, createdAt",
      contextPackets: "id, projectId, createdAt, task",
      proposals: "id, projectId, status, createdAt, operation",
      agentRuns: "id, projectId, status, createdAt",
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
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: ACTOR_ID,
    updatedBy: ACTOR_ID,
    title: input.title,
    subtitle: "",
    logline: input.premise,
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

  const volume = { ...recordBase(id), kind: "volume" as const, title: "第一卷", summary: "故事从这里开始。", order: 0, status: "planned" as const, tension: 20, emotion: 20, information: 15, tags: [] };
  const chapter: OutlineNode = { ...recordBase(id), parentId: volume.id, kind: "chapter", title: "第一章", summary: "建立人物、环境与初始失衡。", order: 0, status: "planned", tension: 35, emotion: 30, information: 25, tags: [], blueprint: { objective: "让主角面对一个无法忽视的变化", locationIds: [], characterIds: [], conflict: "日常秩序被打破", informationRelease: [], turningPoint: "主角决定采取行动", hook: "行动带来新的未知代价", mustHappen: [], flexible: [], forbidden: [], targetWords: 3000 } };
  const document: ManuscriptDocument = { ...recordBase(id), outlineNodeId: chapter.id, title: chapter.title, contentHtml: "", plainText: "", summary: "", status: "outline", wordCount: 0, branch: "main", yjsDocumentId: crypto.randomUUID() };
  chapter.documentId = document.id;

  await novelDb.transaction("rw", novelDb.projects, novelDb.outlineNodes, novelDb.documents, novelDb.operations, async () => {
    await novelDb.projects.add(project);
    await novelDb.outlineNodes.bulkAdd([volume, chapter]);
    await novelDb.documents.add(document);
    await appendOperation(id, "projects", id, "create", { title: { before: null, after: project.title } });
  });
  return project;
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
}

export async function addOutlineNode(projectId: string, parentId: string | undefined, kind: OutlineNode["kind"], title: string, order: number) {
  const node: OutlineNode = { ...recordBase(projectId), parentId, kind, title, summary: "", order, status: "idea", tension: 30, emotion: 30, information: 30, tags: [] };
  await novelDb.outlineNodes.add(node);
  await appendOperation(projectId, "outlineNodes", node.id, "create", { title: { before: null, after: title } });
  return node;
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
