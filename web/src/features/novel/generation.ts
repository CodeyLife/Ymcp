import Ajv, { type ValidateFunction } from "ajv";
import type { Table } from "dexie";
import { callStructuredNovelModel } from "./ai";
import { compileNovelContext, formatContextPacket } from "./context";
import { appendOperation, emptyChapterBlueprint, novelDb, recordBase } from "./db";
import { formatSkillPrompt, resolveNovelSkills } from "./skills";
import type {
  AIProposal,
  AgentRun,
  NovelAgentRole,
  NovelGenerationScope,
  NovelGenerationTaskKey,
  NovelSkillStage,
  ProjectGenerationRun,
  ProjectGenerationStage,
  ProposalItem,
  ProposalTargetTable,
} from "./types";

export interface GenerationTaskDefinition {
  key: NovelGenerationTaskKey;
  label: string;
  scope: NovelGenerationScope;
  role: NovelAgentRole;
  skillStage: NovelSkillStage;
  allowedTables: ProposalTargetTable[];
  defaultInstruction: string;
}

const TASKS: GenerationTaskDefinition[] = [
  { key: "project-positioning", label: "完善项目定位", scope: "dashboard", role: "architect", skillStage: "foundation", allowedTables: ["projects"], defaultInstruction: "根据核心创意完善题材定位、目标读者、主题、卖点、叙事视角、基调和语言风格。" },
  { key: "architecture", label: "生成全书架构", scope: "architecture", role: "architect", skillStage: "foundation", allowedTables: ["architectures"], defaultInstruction: "生成可支撑长篇的全书架构，明确核心冲突、失败代价、读者承诺、结局承诺与宏观阶段。" },
  { key: "outline", label: "规划故事大纲", scope: "outline", role: "architect", skillStage: "planning", allowedTables: ["outlineNodes"], defaultInstruction: "按幕、序列、事件建立层级故事大纲，强调因果、人物选择、转折和结果，不使用章节编号。" },
  { key: "story-bible", label: "生成故事资料", scope: "bible", role: "architect", skillStage: "foundation", allowedTables: ["entities", "relations"], defaultInstruction: "生成故事所需的核心角色、地点、组织、物品与世界规则，并建立关键关系。" },
  { key: "characters", label: "设计角色", scope: "characters", role: "architect", skillStage: "foundation", allowedTables: ["entities"], defaultInstruction: "设计有明确欲望、恐惧、错误信念、秘密、人物弧和差异化声音的角色。" },
  { key: "relations", label: "设计人物关系", scope: "relations", role: "architect", skillStage: "foundation", allowedTables: ["relations"], defaultInstruction: "根据现有角色设计会推动选择和冲突的人物关系。" },
  { key: "timeline", label: "规划时间线", scope: "timeline", role: "architect", skillStage: "planning", allowedTables: ["timelineEvents"], defaultInstruction: "生成有明确先后、持续时间、原因和后果的故事时间线。" },
  { key: "plot-threads", label: "规划剧情线", scope: "threads", role: "architect", skillStage: "planning", allowedTables: ["plotThreads"], defaultInstruction: "规划主线和支线，明确参与者、当前状态、优先级与下一步推进。" },
  { key: "foreshadowing", label: "规划伏笔", scope: "foreshadowing", role: "architect", skillStage: "planning", allowedTables: ["foreshadowing"], defaultInstruction: "规划线索、真相、误导、提醒与回收节点。" },
  { key: "story-control", label: "生成剧情控制资料", scope: "review", role: "architect", skillStage: "planning", allowedTables: ["plotThreads", "foreshadowing", "timelineEvents"], defaultInstruction: "根据已批准架构、大纲和资料库生成剧情线、伏笔和时间线控制资料。" },
  { key: "chapter-arrangement", label: "编排章节", scope: "chapters", role: "architect", skillStage: "planning", allowedTables: ["documents"], defaultInstruction: "根据全书目标字数、架构和故事大纲编排章节，为每章生成标题、顺序、目标、冲突、转折、钩子和目标字数。" },
  { key: "chapter-plan", label: "规划当前章节", scope: "chapters", role: "architect", skillStage: "planning", allowedTables: ["documents"], defaultInstruction: "结合已批准架构、故事大纲和当前写作进度，为本章设计目标、冲突、信息释放、转折、钩子和目标字数。" },
  { key: "scene-design", label: "设计场景", scope: "scenes", role: "architect", skillStage: "planning", allowedTables: ["scenes"], defaultInstruction: "为当前章节规划场景顺序、功能、冲突、结果、角色和行动节拍。" },
  { key: "chapter-draft", label: "生成章节正文", scope: "writing", role: "writer", skillStage: "drafting", allowedTables: ["documents"], defaultInstruction: "依据当前章节蓝图和场景计划生成完整正文。" },
  { key: "review", label: "审校并提出修订", scope: "review", role: "quality-editor", skillStage: "review", allowedTables: ["documents"], defaultInstruction: "检查故事与正文的因果、人物、连续性、节奏和文风，并提供可选择采纳的定向修订。" },
];

export const NOVEL_GENERATION_TASKS = TASKS;
const PROJECT_RUN_ABORTS = new Map<string, AbortController>();

export function getGenerationTask(key: NovelGenerationTaskKey) {
  const task = TASKS.find((item) => item.key === key);
  if (!task) throw new Error(`未知生成任务：${key}`);
  return task;
}

export function tasksForScope(scope: NovelGenerationScope) {
  return TASKS.filter((item) => item.scope === scope);
}

const payloadContract = `字段契约：
- projects: title, subtitle, premise, genre, audience, themes, sellingPoints, pov, tense, tone, languageStyle, targetWords
- architectures: framework, status, centralQuestion, readerPromise, centralConflict, stakes, endingPromise, synopsis, phases[{id,title,purpose,turningPoint,order,locked}]
- outlineNodes: parentId(可用 ref:临时ID), kind(act|sequence|event), title, summary, order, status, storyTime, causality, outcome, characterIds, plotThreadIds, foreshadowingIds, tension, emotion, information, tags
- documents: order, title, summary, status, blueprint{objective,povCharacterId,locationIds,characterIds,conflict,informationRelease,turningPoint,hook,mustHappen,flexible,forbidden,targetWords}；正文任务可额外给 plainText
- scenes: chapterId, title, order, status, povCharacterId, storyTime, locationId, characterIds, plotThreadIds, foreshadowingIds, purpose, conflict, entryState, outcome, wordTarget, beats[{id,text,order}]
- entities: kind, name, aliases, summary, description, tags, lockedFacts, attributes；角色需包含 character
- relations: fromEntityId/toEntityId 可用 ref:临时ID，另含 relationType, publicLabel, privateTruth, affinity, trust, conflict, history
- plotThreads: kind, title, summary, status, priority, participantIds, progress, nextMove
- foreshadowing: title, clue, truth, status, urgency, notes
- timelineEvents: title, storyDate, duration, narrativeOrder, participantIds, causeIds, consequenceIds, description`;

const stringArraySchema = { type: "array", items: { type: "string" } } as const;
const characterSchema = {
  type: "object", additionalProperties: false,
  required: ["role", "appearance", "personality", "desire", "motivation", "weakness", "secret", "abilities", "voice", "arc", "knowledge", "state"],
  properties: {
    role: { type: "string" }, appearance: { type: "string" }, personality: { type: "string" }, desire: { type: "string" }, motivation: { type: "string" }, weakness: { type: "string" }, secret: { type: "string" }, abilities: stringArraySchema, voice: { type: "string" }, arc: { type: "string" },
    knowledge: { type: "object", additionalProperties: false, required: ["known", "suspected", "mistaken", "unknown"], properties: { known: stringArraySchema, suspected: stringArraySchema, mistaken: stringArraySchema, unknown: stringArraySchema } },
    state: { type: "object", additionalProperties: false, required: ["location", "physical", "emotional", "objective", "inventory", "relationshipNotes"], properties: { location: { type: "string" }, physical: { type: "string" }, emotional: { type: "string" }, objective: { type: "string" }, inventory: stringArraySchema, relationshipNotes: stringArraySchema, lastChangedChapterId: { type: "string" } } },
  },
} as const;
const TABLE_PAYLOAD_SCHEMAS: Record<ProposalTargetTable, Record<string, unknown>> = {
  projects: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, subtitle: { type: "string" }, premise: { type: "string" }, genre: stringArraySchema, audience: { type: "string" }, themes: stringArraySchema, sellingPoints: stringArraySchema, pov: { type: "string" }, tense: { type: "string" }, tone: { type: "string" }, languageStyle: { type: "string" }, targetWords: { type: "number", minimum: 1 } } },
  architectures: { type: "object", additionalProperties: false, properties: { framework: { enum: ["free", "three-act", "four-part", "save-the-cat", "snowflake"] }, status: { enum: ["draft", "approved"] }, centralQuestion: { type: "string" }, readerPromise: { type: "string" }, centralConflict: { type: "string" }, stakes: { type: "string" }, endingPromise: { type: "string" }, synopsis: { type: "string" }, phases: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "title", "purpose", "turningPoint", "order", "locked"], properties: { id: { type: "string" }, title: { type: "string" }, purpose: { type: "string" }, turningPoint: { type: "string" }, order: { type: "integer", minimum: 0 }, locked: { type: "boolean" } } } } } },
  outlineNodes: { type: "object", additionalProperties: false, properties: { parentId: { type: "string" }, kind: { enum: ["act", "sequence", "event"] }, title: { type: "string" }, summary: { type: "string" }, order: { type: "integer", minimum: 0 }, status: { enum: ["idea", "planned", "resolved"] }, storyTime: { type: "string" }, causality: { type: "string" }, outcome: { type: "string" }, characterIds: stringArraySchema, plotThreadIds: stringArraySchema, foreshadowingIds: stringArraySchema, tension: { type: "number", minimum: 0, maximum: 100 }, emotion: { type: "number", minimum: 0, maximum: 100 }, information: { type: "number", minimum: 0, maximum: 100 }, tags: stringArraySchema } },
  documents: { type: "object", additionalProperties: false, properties: { order: { type: "integer", minimum: 0 }, title: { type: "string" }, summary: { type: "string" }, status: { enum: ["outline", "draft", "review", "final"] }, plainText: { type: "string" }, blueprint: { type: "object", additionalProperties: false, properties: { objective: { type: "string" }, povCharacterId: { type: "string" }, locationIds: stringArraySchema, characterIds: stringArraySchema, conflict: { type: "string" }, informationRelease: stringArraySchema, turningPoint: { type: "string" }, hook: { type: "string" }, mustHappen: stringArraySchema, flexible: stringArraySchema, forbidden: stringArraySchema, targetWords: { type: "number", minimum: 1 } } } } },
  scenes: { type: "object", additionalProperties: false, properties: { chapterId: { type: "string" }, title: { type: "string" }, order: { type: "integer", minimum: 0 }, status: { enum: ["idea", "planned", "drafting", "done"] }, povCharacterId: { type: "string" }, storyTime: { type: "string" }, locationId: { type: "string" }, characterIds: stringArraySchema, plotThreadIds: stringArraySchema, foreshadowingIds: stringArraySchema, purpose: { type: "string" }, conflict: { type: "string" }, entryState: { type: "string" }, outcome: { type: "string" }, wordTarget: { type: "number", minimum: 0 }, beats: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "text", "order"], properties: { id: { type: "string" }, text: { type: "string" }, order: { type: "integer", minimum: 0 } } } } } },
  entities: { type: "object", additionalProperties: false, properties: { kind: { enum: ["character", "location", "organization", "faction", "item", "species", "rule", "ability", "term"] }, name: { type: "string" }, aliases: stringArraySchema, summary: { type: "string" }, description: { type: "string" }, tags: stringArraySchema, lockedFacts: stringArraySchema, attributes: { type: "object" }, character: characterSchema }, allOf: [{ if: { properties: { kind: { const: "character" } }, required: ["kind"] }, then: { required: ["character"] } }] },
  relations: { type: "object", additionalProperties: false, properties: { fromEntityId: { type: "string" }, toEntityId: { type: "string" }, relationType: { type: "string" }, publicLabel: { type: "string" }, privateTruth: { type: "string" }, affinity: { type: "number", minimum: -100, maximum: 100 }, trust: { type: "number", minimum: -100, maximum: 100 }, conflict: { type: "number", minimum: 0, maximum: 100 }, history: { type: "array", items: { type: "object", additionalProperties: false, required: ["at", "note"], properties: { at: { type: "number" }, chapterId: { type: "string" }, note: { type: "string" } } } } } },
  plotThreads: { type: "object", additionalProperties: false, properties: { kind: { enum: ["main", "subplot", "romance", "growth", "mystery", "antagonist"] }, title: { type: "string" }, summary: { type: "string" }, status: { enum: ["planned", "active", "paused", "resolved", "abandoned"] }, priority: { type: "number", minimum: 0, maximum: 100 }, participantIds: stringArraySchema, startNodeId: { type: "string" }, targetNodeId: { type: "string" }, progress: { type: "number", minimum: 0, maximum: 100 }, nextMove: { type: "string" } } },
  foreshadowing: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, clue: { type: "string" }, truth: { type: "string" }, status: { enum: ["seeded", "reminded", "misdirected", "advanced", "revealed", "resolved", "abandoned"] }, seededNodeId: { type: "string" }, targetNodeId: { type: "string" }, urgency: { type: "number", minimum: 0, maximum: 100 }, notes: { type: "string" } } },
  timelineEvents: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, storyDate: { type: "string" }, duration: { type: "string" }, narrativeOrder: { type: "number" }, locationId: { type: "string" }, participantIds: stringArraySchema, causeIds: stringArraySchema, consequenceIds: stringArraySchema, description: { type: "string" }, parallelGroup: { type: "string" } } },
};

const payloadAjv = new Ajv({ allErrors: true, strict: false });
const PAYLOAD_VALIDATORS = Object.fromEntries(Object.entries(TABLE_PAYLOAD_SCHEMAS).map(([table, schema]) => [table, payloadAjv.compile(schema)])) as Record<ProposalTargetTable, ValidateFunction>;
const CREATE_REQUIRED_FIELDS: Record<ProposalTargetTable, string[]> = {
  projects: ["title", "premise"],
  architectures: ["centralQuestion", "centralConflict", "stakes", "readerPromise", "endingPromise", "synopsis", "phases"],
  outlineNodes: ["kind", "title", "summary", "order", "causality", "outcome"],
  documents: ["order", "title", "blueprint"],
  scenes: ["chapterId", "title", "order", "purpose", "conflict", "outcome"],
  entities: ["kind", "name", "summary", "description"],
  relations: ["fromEntityId", "toEntityId", "relationType", "publicLabel", "privateTruth"],
  plotThreads: ["kind", "title", "summary", "status", "nextMove"],
  foreshadowing: ["title", "clue", "truth", "status", "notes"],
  timelineEvents: ["title", "storyDate", "narrativeOrder", "description"],
};
const CREATE_PAYLOAD_VALIDATORS = Object.fromEntries(Object.entries(TABLE_PAYLOAD_SCHEMAS).map(([table, schema]) => [table, payloadAjv.compile({ ...schema, required: CREATE_REQUIRED_FIELDS[table as ProposalTargetTable] })])) as Record<ProposalTargetTable, ValidateFunction>;

function proposalSchema(allowedTables: ProposalTargetTable[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "items"],
    properties: {
      summary: { type: "string" },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 120,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "operation", "targetTable", "payload", "rationale"],
          properties: {
            label: { type: "string", minLength: 1 },
            operation: { enum: ["create", "update"] },
            targetTable: { enum: allowedTables },
            targetId: { type: "string" },
            tempId: { type: "string" },
            payload: { type: "object" },
            rationale: { type: "string" },
            dependencies: { type: "array", items: { type: "string" } },
          },
          allOf: [
            ...allowedTables.map((table) => ({ if: { properties: { targetTable: { const: table } } }, then: { properties: { payload: TABLE_PAYLOAD_SCHEMAS[table] } } })),
            ...allowedTables.map((table) => ({ if: { properties: { targetTable: { const: table }, operation: { const: "create" } }, required: ["targetTable", "operation"] }, then: { properties: { payload: { ...TABLE_PAYLOAD_SCHEMAS[table], required: CREATE_REQUIRED_FIELDS[table] } } } })),
            { if: { properties: { operation: { const: "update" } }, required: ["operation"] }, then: { required: ["targetId"], properties: { payload: { type: "object", minProperties: 1 } } } },
          ],
        },
      },
    },
  };
}

function proposalMarkdown(title: string, summary: string, items: ProposalItem[]) {
  return [`# ${title}`, summary, ...items.map((item, index) => `## ${index + 1}. ${item.label}\n\n${item.rationale}\n\n- 操作：${item.operation === "create" ? "新增" : "更新"}\n- 类型：${item.targetTable}`)].join("\n\n");
}

async function existingInventory(projectId: string, tables: ProposalTargetTable[]) {
  const lines: string[] = [];
  for (const tableName of tables) {
    const records = await novelDb.table(tableName).where("projectId").equals(projectId).limit(120).toArray() as Array<Record<string, unknown>>;
    for (const record of records) lines.push(`${tableName} | id=${record.id} | revision=${record.revision} | ${String(record.title || record.name || record.id)}`);
  }
  return lines.join("\n") || "当前没有同类正式资料。";
}

async function attachExpectedRevisions(items: ProposalItem[]) {
  for (const item of items) {
    if (item.operation !== "update" || !item.targetId) continue;
    const current = await novelDb.table(item.targetTable).get(item.targetId) as (Record<string, unknown> & { revision?: number }) | undefined;
    item.expectedRevision = current?.revision;
    if (current) item.before = sanitizePayload(current);
  }
}

export async function runGenerationTask(params: {
  projectId: string;
  taskKey: NovelGenerationTaskKey;
  instruction: string;
  targetId?: string;
  projectGenerationRunId?: string;
  signal?: AbortSignal;
}) {
  const task = getGenerationTask(params.taskKey);
  const project = await novelDb.projects.get(params.projectId);
  if (!project) throw new Error("项目不存在");
  const skills = await resolveNovelSkills({ projectId: params.projectId, stage: task.skillStage });
  if (skills.conflicts.length) throw new Error(`Skill 冲突：${skills.conflicts.map((item) => `${item.skillId} ↔ ${item.conflictsWith}`).join("；")}`);
  const packet = await compileNovelContext({ projectId: params.projectId, task: params.taskKey, instruction: params.instruction, targetDocumentId: params.targetId, stage: task.skillStage, resolvedSkills: skills.skills });
  const inventory = await existingInventory(params.projectId, task.allowedTables);
  const acceptedRefs = await acceptedProjectReferences(params.projectId);
  const referenceAliases = [...acceptedRefs.entries()].map(([alias, id]) => `ref:${alias} -> ${id}`).join("\n") || "暂无已采纳临时引用。";
  const agent: AgentRun = { ...recordBase(params.projectId), goal: params.instruction, status: "running", model: project.settings.textModel, promptVersion: "novel-structured-v4", contextPacketId: packet.id, role: task.role, skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`), artifactRefs: [], attempt: 1, startedAt: Date.now(), steps: [{ id: crypto.randomUUID(), title: task.label, tool: "model.structured", status: "running" }] };
  await novelDb.agentRuns.add(agent);
  try {
    const result = await callStructuredNovelModel<Record<string, unknown>>({
      model: project.settings.textModel,
      temperature: task.role === "writer" ? project.settings.temperature : 0.55,
      role: task.role,
      skillPrompt: formatSkillPrompt(skills.skills),
      schema: proposalSchema(task.allowedTables),
      signal: params.signal,
      prompt: `# 任务\n${params.instruction}\n${params.targetId ? `\n# 当前目标 ID\n${params.targetId}\n` : ""}\n# 允许生成的资料表\n${task.allowedTables.join("、")}\n\n${payloadContract}\n\n# 现有对象索引\n${inventory}\n\n# 已采纳引用别名\n${referenceAliases}\n\n# 输出要求\n只生成待用户审核的候选项，不得声称已修改项目。创建的对象如需互相引用，为每个对象提供 tempId，并使用 ref:tempId 引用。引用现有对象时必须使用对象索引中的真实 ID，或使用上方已明确列出的 ref:别名；不得自行发明 ref: 标识。更新必须使用现有对象索引中的真实 targetId。\n\n# 冻结上下文\n${formatContextPacket(packet)}`,
    });
    const rawItems = Array.isArray(result.data.items) ? result.data.items as Array<Record<string, unknown>> : [];
    const items: ProposalItem[] = rawItems.map((raw) => ({
      id: crypto.randomUUID(),
      label: String(raw.label || "未命名候选"),
      operation: raw.operation === "update" ? "update" : "create",
      targetTable: raw.targetTable as ProposalTargetTable,
      targetId: typeof raw.targetId === "string" ? raw.targetId : undefined,
      tempId: typeof raw.tempId === "string" ? raw.tempId : undefined,
      status: "pending",
      payload: (raw.payload ?? {}) as Record<string, unknown>,
      after: (raw.payload ?? {}) as Record<string, unknown>,
      rationale: String(raw.rationale || ""),
      dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String) : [],
    }));
    if (["project-positioning", "architecture", "chapter-plan", "chapter-draft"].includes(params.taskKey)) items.splice(1);
    if (params.taskKey === "project-positioning") for (const item of items) { item.operation = "update"; item.targetId = project.id; item.targetTable = "projects"; }
    if (params.taskKey === "architecture") {
      const architecture = await novelDb.architectures.where("projectId").equals(params.projectId).first();
      for (const item of items) { item.operation = architecture ? "update" : "create"; item.targetId = architecture?.id; item.targetTable = "architectures"; }
    }
    if (params.taskKey === "scene-design" && params.targetId) for (const item of items) item.payload = { ...item.payload, chapterId: params.targetId };
    if (params.taskKey === "chapter-plan" && params.targetId) for (const item of items) { item.operation = "update"; item.targetTable = "documents"; item.targetId = params.targetId; }
    if (params.taskKey === "chapter-draft" && params.targetId) for (const item of items) { item.operation = "update"; item.targetTable = "documents"; item.targetId = params.targetId; }
    if (params.taskKey === "review") {
      const documents = await novelDb.documents.where("projectId").equals(params.projectId).sortBy("order");
      if (!documents.length) throw new Error("请先建立至少一个章节，再执行审校");
      for (const [index, item] of items.entries()) {
        const target = item.targetId ? documents.find((document) => document.id === item.targetId) : documents[index % documents.length];
        item.operation = "update";
        item.targetTable = "documents";
        item.targetId = target?.id ?? documents[0].id;
      }
    }
    if (!items.length) throw new Error("AI 没有返回可审核的候选项");
    await attachExpectedRevisions(items);
    const summary = String(result.data.summary || task.defaultInstruction);
    const proposal: AIProposal = {
      ...recordBase(params.projectId),
      title: task.label,
      operation: `structured:${params.taskKey}`,
      taskKey: params.taskKey,
      scope: task.scope,
      targetId: params.targetId,
      status: "pending",
      previewMarkdown: proposalMarkdown(task.label, summary, items),
      patches: [],
      items,
      contextPacketId: packet.id,
      agentRunId: agent.id,
      projectGenerationRunId: params.projectGenerationRunId,
      model: project.settings.textModel,
    };
    agent.status = "completed";
    agent.finishedAt = Date.now();
    agent.promptHash = result.promptHash;
    agent.usage = result.usage;
    agent.steps[0].status = "completed";
    agent.steps[0].output = `${items.length} 个候选项`;
    await novelDb.transaction("rw", novelDb.proposals, novelDb.agentRuns, async () => {
      await novelDb.proposals.add(proposal);
      await novelDb.agentRuns.put({ ...agent, revision: agent.revision + 1, updatedAt: Date.now() });
    });
    return { proposal, packet, agent };
  } catch (error) {
    agent.status = params.signal?.aborted ? "cancelled" : "failed";
    agent.finishedAt = Date.now();
    agent.steps[0].status = "failed";
    agent.steps[0].error = error instanceof Error ? error.message : "生成失败";
    await novelDb.agentRuns.put({ ...agent, revision: agent.revision + 1, updatedAt: Date.now() });
    throw error;
  }
}

function resolveReferences(value: unknown, refs: Map<string, string>): unknown {
  if (typeof value === "string" && value.startsWith("ref:")) {
    const resolved = refs.get(value.slice(4));
    if (!resolved) throw new Error(`候选项引用了未选择或不存在的临时对象：${value}`);
    return resolved;
  }
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, refs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReferences(item, refs)]));
  return value;
}

async function acceptedProjectReferences(projectId: string) {
  const refs = new Map<string, string>();
  const proposals = await novelDb.proposals.where("projectId").equals(projectId).toArray();
  const acceptedItems = proposals.flatMap((proposal) => proposal.items.filter((item) => item.status === "accepted" && item.tempId));
  for (const item of acceptedItems) {
    if (item.targetId) {
      refs.set(item.tempId!, item.targetId);
      continue;
    }
    const payload = (item.after ?? item.payload) as Record<string, unknown>;
    const identity = String(payload.name ?? payload.title ?? "").trim();
    if (!identity) continue;
    const matches = await novelDb.table(item.targetTable).where("projectId").equals(projectId).filter((record: Record<string, unknown>) => record.name === identity || record.title === identity).primaryKeys();
    if (matches.length === 1) refs.set(item.tempId!, String(matches[0]));
  }
  return refs;
}

function sanitizePayload(payload: Record<string, unknown>) {
  const protectedFields = new Set(["id", "projectId", "schemaVersion", "revision", "createdAt", "updatedAt", "createdBy", "updatedBy", "deletedAt"]);
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !protectedFields.has(key)));
}

function textToHtml(text: string) {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text.split(/\n{2,}/).map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, "<br>")}</p>`).join("");
}

function normalizeDocumentPayload(payload: Record<string, unknown>) {
  if (typeof payload.plainText !== "string") return payload;
  const wordCount = (payload.plainText.match(/[\u3400-\u9fff]|[a-zA-Z0-9]+/g) ?? []).length;
  return { ...payload, contentHtml: textToHtml(payload.plainText), wordCount, status: payload.status ?? "draft" };
}

function normalizedCreate(table: ProposalTargetTable, projectId: string, id: string, payload: Record<string, unknown>) {
  const base = { ...recordBase(projectId), id };
  if (table === "architectures") return { ...base, framework: "free", status: "draft", centralQuestion: "", readerPromise: "", centralConflict: "", stakes: "", endingPromise: "", synopsis: "", phases: [], ...payload };
  if (table === "outlineNodes") return { ...base, parentId: undefined, kind: "event", title: "未命名事件", summary: "", order: 0, status: "idea", causality: "", outcome: "", characterIds: [], plotThreadIds: [], foreshadowingIds: [], tension: 30, emotion: 30, information: 30, tags: [], ...payload };
  if (table === "documents") {
    const { blueprint, ...rest } = payload;
    return { ...base, order: 0, title: "未命名章节", contentHtml: "", plainText: "", summary: "", status: "outline", wordCount: 0, branch: "main", yjsDocumentId: crypto.randomUUID(), ...rest, blueprint: { ...emptyChapterBlueprint(), ...(blueprint as Record<string, unknown> | undefined) } };
  }
  if (table === "scenes") return { ...base, chapterId: "", title: "未命名场景", order: 0, status: "idea", characterIds: [], plotThreadIds: [], foreshadowingIds: [], purpose: "", conflict: "", outcome: "", wordTarget: 800, beats: [], ...payload };
  if (table === "entities") {
    const characterDefaults = { role: "", appearance: "", personality: "", desire: "", motivation: "", weakness: "", secret: "", abilities: [], voice: "", arc: "", knowledge: { known: [], suspected: [], mistaken: [], unknown: [] }, state: { location: "", physical: "", emotional: "", objective: "", inventory: [], relationshipNotes: [] } };
    const record = { ...base, kind: "term", name: "未命名资料", aliases: [], summary: "", description: "", tags: [], lockedFacts: [], attributes: {}, ...payload } as Record<string, unknown>;
    if (record.kind === "character") {
      const character = (payload.character ?? {}) as Record<string, unknown>;
      record.character = { ...characterDefaults, ...character, knowledge: { ...characterDefaults.knowledge, ...(character.knowledge as Record<string, unknown> | undefined) }, state: { ...characterDefaults.state, ...(character.state as Record<string, unknown> | undefined) } };
    }
    return record;
  }
  if (table === "relations") return { ...base, fromEntityId: "", toEntityId: "", relationType: "关联", publicLabel: "", privateTruth: "", affinity: 0, trust: 0, conflict: 0, history: [], ...payload };
  if (table === "plotThreads") return { ...base, kind: "subplot", title: "未命名剧情线", summary: "", status: "planned", priority: 50, participantIds: [], progress: 0, nextMove: "", ...payload };
  if (table === "foreshadowing") return { ...base, title: "未命名伏笔", clue: "", truth: "", status: "seeded", urgency: 30, notes: "", ...payload };
  if (table === "timelineEvents") return { ...base, title: "未命名事件", storyDate: "", duration: "", narrativeOrder: 0, participantIds: [], causeIds: [], consequenceIds: [], description: "", ...payload };
  return { ...base, ...payload };
}

function embeddingText(table: ProposalTargetTable, record: Record<string, unknown>) {
  if (!(["entities", "outlineNodes", "documents", "scenes", "plotThreads", "foreshadowing"] as string[]).includes(table)) return "";
  return [record.title, record.name, record.summary, record.description, record.plainText, record.causality, record.outcome, record.clue, record.truth, record.nextMove].filter(Boolean).join("\n");
}

export async function updateProposalItemPayload(proposalId: string, itemId: string, payload: Record<string, unknown>) {
  const proposal = await novelDb.proposals.get(proposalId);
  if (!proposal || proposal.status !== "pending") throw new Error("提案已不可编辑");
  proposal.items = proposal.items.map((item) => item.id === itemId ? { ...item, payload, after: payload } : item);
  await novelDb.proposals.put({ ...proposal, revision: proposal.revision + 1, updatedAt: Date.now() });
}

export async function rejectProposal(proposalId: string) {
  const proposal = await novelDb.proposals.get(proposalId);
  if (!proposal || proposal.status !== "pending") return proposal;
  const next = { ...proposal, status: "rejected" as const, items: proposal.items.map((item) => ({ ...item, status: "rejected" as const })), revision: proposal.revision + 1, updatedAt: Date.now() };
  await novelDb.proposals.put(next);
  return next;
}

export async function regenerateProposalItem(proposalId: string, itemId: string, instruction: string) {
  const proposal = await novelDb.proposals.get(proposalId);
  const current = proposal?.items.find((item) => item.id === itemId);
  if (!proposal?.taskKey || !current || proposal.status !== "pending") throw new Error("候选项已不可重新生成");
  const result = await runGenerationTask({
    projectId: proposal.projectId,
    taskKey: proposal.taskKey,
    targetId: proposal.targetId,
    instruction: `${instruction}\n\n只返回 1 个候选项，用于替换“${current.label}”。目标表必须是 ${current.targetTable}，操作类型保持 ${current.operation}。`,
  });
  const replacement = result.proposal.items[0];
  if (!replacement) throw new Error("AI 没有返回替换候选项");
  const lockedReplacement: ProposalItem = { ...replacement, id: current.id, operation: current.operation, targetTable: current.targetTable, targetId: current.targetId, tempId: current.tempId, dependencies: current.dependencies };
  await attachExpectedRevisions([lockedReplacement]);
  let updatedItem: ProposalItem | undefined;
  await novelDb.transaction("rw", novelDb.proposals, async () => {
    const latest = await novelDb.proposals.get(proposalId);
    await novelDb.proposals.delete(result.proposal.id);
    if (!latest || latest.status !== "pending" || latest.revision !== proposal.revision || !latest.items.some((item) => item.id === itemId)) return;
    const items = latest.items.map((item) => item.id === itemId ? lockedReplacement : item);
    await novelDb.proposals.put({ ...latest, items, previewMarkdown: proposalMarkdown(latest.title, "已重新生成指定候选项。", items), revision: latest.revision + 1, updatedAt: Date.now() });
    updatedItem = lockedReplacement;
  });
  if (!updatedItem) throw new Error("提案在重新生成期间已被其他操作处理");
  return updatedItem;
}

export async function applyProposalItems(proposalId: string, selectedItemIds: string[]) {
  const initialProposal = await novelDb.proposals.get(proposalId);
  if (!initialProposal || initialProposal.status !== "pending") throw new Error("提案不存在或已经处理");
  const initialSelected = initialProposal.items.filter((item) => selectedItemIds.includes(item.id));
  if (!initialSelected.length) throw new Error("请至少选择一个候选项");
  const acceptedRefs = await acceptedProjectReferences(initialProposal.projectId);
  const tables = [...new Set(initialSelected.map((item) => novelDb.table(item.targetTable))), novelDb.operations, novelDb.proposals, novelDb.embeddings];
  const embeddings: Array<{ table: ProposalTargetTable; id: string; record: Record<string, unknown> }> = [];
  let appliedCount = 0;
  let conflictCount = 0;
  let generationRunId: string | undefined;
  await novelDb.transaction("rw", tables, async () => {
    const proposal = await novelDb.proposals.get(proposalId);
    if (!proposal || proposal.status !== "pending") throw new Error("提案已由其他操作处理");
    const selected = proposal.items.filter((item) => selectedItemIds.includes(item.id));
    const selectedTempIds = new Set(selected.map((item) => item.tempId).filter((id): id is string => Boolean(id)));
    const generatedTempIds = new Set(proposal.items.map((item) => item.tempId).filter((id): id is string => Boolean(id)));
    const missingDependencies = selected.flatMap((item) => item.dependencies.filter((dependency) => generatedTempIds.has(dependency) && !selectedTempIds.has(dependency)));
    if (missingDependencies.length) throw new Error(`请同时选择依赖项：${[...new Set(missingDependencies)].join("、")}`);
    const refs = new Map(acceptedRefs);
    for (const item of selected) if (item.tempId) refs.set(item.tempId, item.targetId || crypto.randomUUID());
    const conflicts: string[] = [];
    for (const item of selected) {
      if (item.operation !== "update" || !item.targetId) continue;
      const current = await novelDb.table(item.targetTable).get(item.targetId) as { revision?: number } | undefined;
      if (!current || current.revision !== item.expectedRevision) conflicts.push(item.id);
    }
    const applicable = selected.filter((item) => !conflicts.includes(item.id));
    for (const item of applicable) {
      const table = novelDb.table(item.targetTable) as Table<Record<string, unknown>, string>;
      const resolved = sanitizePayload(resolveReferences(item.after ?? item.payload, refs) as Record<string, unknown>);
      const validate = item.operation === "create" ? CREATE_PAYLOAD_VALIDATORS[item.targetTable] : PAYLOAD_VALIDATORS[item.targetTable];
      if (!validate(resolved)) throw new Error(`“${item.label}”字段无效：${validate.errors?.map((error) => `${error.instancePath || "root"} ${error.message}`).join("；")}`);
      const payload = item.targetTable === "documents" ? normalizeDocumentPayload(resolved) : resolved;
      if (item.operation === "create") {
        const id = item.targetId || (item.tempId ? refs.get(item.tempId) : undefined) || crypto.randomUUID();
        if (await table.get(id)) throw new Error(`“${item.label}”目标 ID 已存在`);
        const record = normalizedCreate(item.targetTable, proposal.projectId, id, payload) as Record<string, unknown>;
        await table.put(record);
        await appendOperation(proposal.projectId, item.targetTable, id, "create", { value: { before: null, after: record } });
        await novelDb.embeddings.where("targetId").equals(id).delete();
        embeddings.push({ table: item.targetTable, id, record });
      } else if (item.targetId) {
        const before = await table.get(item.targetId);
        const mergedPayload = item.targetTable === "documents" && payload.blueprint && (before as Record<string, unknown>)?.blueprint ? { ...payload, blueprint: { ...((before as Record<string, unknown>).blueprint as Record<string, unknown>), ...(payload.blueprint as Record<string, unknown>) } } : payload;
        const record = { ...before, ...mergedPayload, revision: Number((before as { revision?: number })?.revision ?? 0) + 1, updatedAt: Date.now(), updatedBy: "local-user" } as Record<string, unknown>;
        await table.put(record);
        await appendOperation(proposal.projectId, item.targetTable, item.targetId, "update", { value: { before, after: record } });
        await novelDb.embeddings.where("targetId").equals(item.targetId).delete();
        embeddings.push({ table: item.targetTable, id: item.targetId, record });
      }
    }
    const nextItems = proposal.items.map((item) => conflicts.includes(item.id)
      ? { ...item, status: "conflict" as const }
      : selectedItemIds.includes(item.id)
        ? { ...item, targetId: item.targetId ?? (item.tempId ? refs.get(item.tempId) : undefined), status: "accepted" as const }
        : item.status === "pending" ? { ...item, status: "rejected" as const } : item);
    const accepted = nextItems.filter((item) => item.status === "accepted").length;
    const status = conflicts.length ? "pending" : accepted === nextItems.length ? "accepted" : accepted > 0 ? "partially_accepted" : "rejected";
    await novelDb.proposals.put({ ...proposal, items: nextItems, status, revision: proposal.revision + 1, updatedAt: Date.now() });
    appliedCount = applicable.length;
    conflictCount = conflicts.length;
    generationRunId = applicable.length && conflicts.length === 0 ? proposal.projectGenerationRunId : undefined;
  });
  const { upsertEmbedding } = await import("./retrieval");
  const embeddingResults = await Promise.allSettled(embeddings.map(({ table, id, record }) => {
    const content = embeddingText(table, record);
    return content ? upsertEmbedding({ projectId: initialProposal.projectId, targetTable: table as "entities", targetId: id, content }) : Promise.resolve();
  }));
  if (generationRunId) await completeProjectGenerationTask(generationRunId, proposalId);
  return { applied: appliedCount, conflicts: conflictCount, embeddingFailures: embeddingResults.filter((result) => result.status === "rejected").length };
}

async function completeProjectGenerationTask(runId: string, proposalId: string) {
  return novelDb.transaction("rw", novelDb.projectGenerationRuns, async () => {
    const run = await novelDb.projectGenerationRuns.get(runId);
    if (!run || run.status !== "waiting-approval" || run.activeProposalId !== proposalId) return run;
    const completed = { ...run, status: "completed" as const, activeProposalId: undefined, finishedAt: Date.now(), revision: run.revision + 1, updatedAt: Date.now() };
    await novelDb.projectGenerationRuns.put(completed);
    return completed;
  });
}

export const PROJECT_GENERATION_STAGES: ProjectGenerationStage[] = ["architecture", "story-bible", "outline", "story-control", "chapters", "review"];
const STAGE_TASK: Record<ProjectGenerationStage, NovelGenerationTaskKey> = {
  architecture: "architecture",
  "story-bible": "story-bible",
  outline: "outline",
  "story-control": "story-control",
  chapters: "chapter-arrangement",
  review: "review",
};

async function generateCurrentProjectStage(run: ProjectGenerationRun): Promise<ProjectGenerationRun> {
  const task = getGenerationTask(STAGE_TASK[run.currentStage]);
  const controller = new AbortController();
  PROJECT_RUN_ABORTS.set(run.id, controller);
  let result: Awaited<ReturnType<typeof runGenerationTask>>;
  try {
    result = await runGenerationTask({ projectId: run.projectId, taskKey: task.key, instruction: `${task.defaultInstruction}\n\n用户全案要求：${run.instruction}`, projectGenerationRunId: run.id, signal: controller.signal });
  } finally {
    if (PROJECT_RUN_ABORTS.get(run.id) === controller) PROJECT_RUN_ABORTS.delete(run.id);
  }
  return novelDb.transaction("rw", novelDb.projectGenerationRuns, novelDb.proposals, async () => {
    const current = await novelDb.projectGenerationRuns.get(run.id);
    if (!current || current.status !== "running" || current.currentStage !== run.currentStage || current.revision !== run.revision) {
      await rejectProposal(result.proposal.id);
      return current ?? { ...run, status: "cancelled", finishedAt: Date.now() };
    }
    const next = { ...current, status: "waiting-approval" as const, activeProposalId: result.proposal.id, proposalIds: [...current.proposalIds, result.proposal.id], revision: current.revision + 1, updatedAt: Date.now(), error: undefined };
    await novelDb.projectGenerationRuns.put(next);
    return next;
  });
}

async function failProjectGenerationStage(run: ProjectGenerationRun, error: unknown): Promise<ProjectGenerationRun> {
  return novelDb.transaction("rw", novelDb.projectGenerationRuns, async () => {
    const current = await novelDb.projectGenerationRuns.get(run.id);
    if (!current || current.status !== "running" || current.currentStage !== run.currentStage || current.revision !== run.revision) return current ?? run;
    const failed = { ...current, status: "failed" as const, error: error instanceof Error ? error.message : "生成失败", revision: current.revision + 1, updatedAt: Date.now() };
    await novelDb.projectGenerationRuns.put(failed);
    return failed;
  });
}

export async function startProjectGeneration(projectId: string, instruction: string): Promise<ProjectGenerationRun> {
  const result = await novelDb.transaction("rw", novelDb.projectGenerationRuns, async () => {
    const active = await novelDb.projectGenerationRuns.where("projectId").equals(projectId).and((item) => ["running", "waiting-approval"].includes(item.status)).first();
    if (active) return { run: active, created: false };
    const created: ProjectGenerationRun = { ...recordBase(projectId), instruction, status: "running", currentStage: PROJECT_GENERATION_STAGES[0], stageIndex: 0, proposalIds: [], startedAt: Date.now() };
    await novelDb.projectGenerationRuns.add(created);
    return { run: created, created: true };
  });
  if (!result.created) return result.run;
  try { return await generateCurrentProjectStage(result.run); }
  catch (error) { return failProjectGenerationStage(result.run, error); }
}

export async function advanceProjectGeneration(runId: string, expectedProposalId?: string, expectedRevision?: number) {
  const transition = await novelDb.transaction("rw", novelDb.projectGenerationRuns, async () => {
    const run = await novelDb.projectGenerationRuns.get(runId);
    if (!run || ["cancelled", "completed"].includes(run.status)) return { run, generate: false };
    if (expectedProposalId && (run.status !== "waiting-approval" || run.activeProposalId !== expectedProposalId)) return { run, generate: false };
    if (expectedRevision !== undefined && run.revision !== expectedRevision) return { run, generate: false };
    const stageIndex = run.stageIndex + 1;
    if (stageIndex >= PROJECT_GENERATION_STAGES.length) {
      const completed = { ...run, status: "completed" as const, activeProposalId: undefined, finishedAt: Date.now(), revision: run.revision + 1, updatedAt: Date.now() };
      await novelDb.projectGenerationRuns.put(completed);
      return { run: completed, generate: false };
    }
    const next = { ...run, status: "running" as const, stageIndex, currentStage: PROJECT_GENERATION_STAGES[stageIndex], activeProposalId: undefined, revision: run.revision + 1, updatedAt: Date.now() };
    await novelDb.projectGenerationRuns.put(next);
    return { run: next, generate: true };
  });
  if (!transition.run || !transition.generate) return transition.run;
  try { return await generateCurrentProjectStage(transition.run); }
  catch (error) { return failProjectGenerationStage(transition.run, error); }
}

export async function skipProjectGenerationStage(runId: string) {
  PROJECT_RUN_ABORTS.get(runId)?.abort();
  const run = await novelDb.projectGenerationRuns.get(runId);
  if (!run) return run;
  if (run.activeProposalId) await rejectProposal(run.activeProposalId);
  return advanceProjectGeneration(runId, run.activeProposalId, run.revision);
}

export async function retryProjectGeneration(runId: string) {
  const next = await novelDb.transaction("rw", novelDb.projectGenerationRuns, async () => {
    const run = await novelDb.projectGenerationRuns.get(runId);
    if (!run || !["failed", "waiting-approval"].includes(run.status)) return run;
    const resumed = { ...run, status: "running" as const, activeProposalId: undefined, error: undefined, revision: run.revision + 1, updatedAt: Date.now() };
    await novelDb.projectGenerationRuns.put(resumed);
    return resumed;
  });
  if (!next || next.status !== "running") return next;
  try { return await generateCurrentProjectStage(next); }
  catch (error) { return failProjectGenerationStage(next, error); }
}

export async function cancelProjectGeneration(runId: string) {
  PROJECT_RUN_ABORTS.get(runId)?.abort();
  return novelDb.transaction("rw", novelDb.projectGenerationRuns, novelDb.proposals, async () => {
    const run = await novelDb.projectGenerationRuns.get(runId);
    if (!run || ["completed", "cancelled"].includes(run.status)) return run;
    if (run.activeProposalId) {
      const proposal = await novelDb.proposals.get(run.activeProposalId);
      if (proposal?.status === "pending") await novelDb.proposals.put({ ...proposal, status: "rejected", items: proposal.items.map((item) => ({ ...item, status: "rejected" as const })), revision: proposal.revision + 1, updatedAt: Date.now() });
    }
    const next = { ...run, status: "cancelled" as const, finishedAt: Date.now(), revision: run.revision + 1, updatedAt: Date.now() };
    await novelDb.projectGenerationRuns.put(next);
    return next;
  });
}
