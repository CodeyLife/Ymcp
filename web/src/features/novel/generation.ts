import Ajv, { type ValidateFunction } from "ajv";
import type { Table } from "dexie";
import { callStructuredNovelModel } from "./ai";
import { compileNovelContext, formatContextPacket } from "./context";
import { appendOperation, DEFAULT_CHAPTER_TARGET_WORDS, emptyChapterBlueprint, normalizeArchitecturePayload, normalizeChapterOrderByPlanning, novelDb, recordBase, retireChapterDependencies } from "./db";
import { sanitizeApprovalMetaInPlace } from "./db-schema";
import { resolveTaskEvidence } from "./memory-service";
import { assertProposalReferences, assertResolvedPayloadReferences, buildProjectReferenceCatalogs, catalogWithResolvedProposalItems, emptyReferenceCatalog, repairProposalCharacterReferences, repairUnresolvableTempRefs } from "./reference-integrity";
import { compileNovelStagePrompt, resolveNovelSkills } from "./skills";
import type {
  AIProposal,
  AgentRun,
  ArchitecturePhase,
  NovelAgentRole,
  NovelGenerationScope,
  NovelGenerationTaskKey,
  NovelSkillStage,
  ProposalItem,
  ProposalTargetTable,
  RefinementSnapshot,
  RefinementSnapshotInput,
} from "./types";
import { repairDraftStructureOnce } from "./workflow-stages/draft-structure-repair";

export interface GenerationTaskDefinition {
  key: NovelGenerationTaskKey;
  label: string;
  scope: NovelGenerationScope;
  role: NovelAgentRole;
  skillStage: NovelSkillStage;
  allowedTables: ProposalTargetTable[];
  defaultInstruction: string;
  refinable?: boolean;
}

const TASKS: GenerationTaskDefinition[] = [
  { key: "project-positioning", label: "完善项目定位", scope: "bible", role: "architect", skillStage: "foundation", allowedTables: ["projects"], defaultInstruction: "根据核心创意完善题材定位、目标读者、主题、卖点、叙事视角、基调和语言风格。", refinable: true },
  { key: "architecture", label: "生成全书架构", scope: "architecture", role: "architect", skillStage: "foundation", allowedTables: ["architectures"], defaultInstruction: "为长篇生成可支撑数十万字铺陈的全书架构。先勾勒人物处境、世态背景与情感底色，再由此自然引出贯穿全书的张力线与阶段流向；核心问题与冲突应藏在人物境遇与选择里，而非作为主题宣告直白写出。", refinable: true },
  { key: "plot-design", label: "设计剧情段与章节", scope: "plot-design", role: "architect", skillStage: "planning", allowedTables: ["outlineNodes", "documents"], defaultInstruction: "在选中的幕下设计一个剧情段及其章节。" },
  { key: "story-bible", label: "生成故事资料", scope: "bible", role: "architect", skillStage: "foundation", allowedTables: ["entities", "relations"], defaultInstruction: "生成故事所需的核心角色、地点、组织、物品与世界规则，并建立关键关系。", refinable: true },
  { key: "characters", label: "设计角色", scope: "characters", role: "architect", skillStage: "foundation", allowedTables: ["entities"], defaultInstruction: "设计有明确欲望、恐惧、错误信念、秘密、人物弧和差异化声音的角色。", refinable: true },
  { key: "relations", label: "设计人物关系", scope: "relations", role: "architect", skillStage: "foundation", allowedTables: ["relations"], defaultInstruction: "根据现有角色设计会推动选择和冲突的人物关系。", refinable: true },
  { key: "timeline", label: "规划时间线", scope: "timeline", role: "architect", skillStage: "planning", allowedTables: ["timelineEvents"], defaultInstruction: "生成有明确先后、持续时间、原因和后果的故事时间线。", refinable: true },
  { key: "worldview", label: "完善世界观", scope: "worldview", role: "architect", skillStage: "foundation", allowedTables: ["entities", "relations"], defaultInstruction: "完善地点、组织、阵营、物品、物种、规则、能力与术语，并保持世界设定之间的关系一致。", refinable: true },
  { key: "plot-threads", label: "规划剧情线", scope: "threads", role: "architect", skillStage: "planning", allowedTables: ["plotThreads"], defaultInstruction: "规划主线和支线，明确参与者、当前状态、优先级与下一步推进。", refinable: true },
  { key: "foreshadowing", label: "规划伏笔", scope: "foreshadowing", role: "architect", skillStage: "planning", allowedTables: ["foreshadowing"], defaultInstruction: "规划线索、真相、误导、提醒与回收节点。", refinable: true },
  { key: "story-control", label: "生成剧情控制资料", scope: "review", role: "architect", skillStage: "planning", allowedTables: ["plotThreads", "foreshadowing", "timelineEvents"], defaultInstruction: "根据已批准架构、大纲和资料库生成剧情线、伏笔和时间线控制资料。", refinable: true },
  { key: "chapter-plan", label: "规划当前章节", scope: "chapters", role: "architect", skillStage: "planning", allowedTables: ["documents"], defaultInstruction: "结合已批准架构、故事大纲和当前写作进度，为本章设计目标、冲突、信息释放、转折和钩子。", refinable: true },
  { key: "scene-design", label: "设计场景", scope: "scenes", role: "architect", skillStage: "planning", allowedTables: ["scenes"], defaultInstruction: "为当前章节规划场景顺序、功能、冲突、结果、角色和行动节拍。", refinable: true },
  { key: "chapter-draft", label: "生成章节正文", scope: "writing", role: "writer", skillStage: "drafting", allowedTables: ["documents"], defaultInstruction: "依据当前章节蓝图和场景计划生成完整正文。" },
  { key: "review", label: "审校并提出修订", scope: "review", role: "quality-editor", skillStage: "review", allowedTables: ["documents"], defaultInstruction: "检查故事与正文的因果、人物、连续性、节奏和文风，并提供可选择采纳的定向修订。" },
];

export const NOVEL_GENERATION_TASKS = TASKS;

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
- architectures: framework, status, centralQuestion, centralConflict, synopsis, phases[{id,title,purpose,turningPoint,order,locked}]；phases.purpose 用文学化叙事描述该阶段的人物处境与情感走向，不要用"建立X""让Y做Z"等编剧指令腔
- outlineNodes: phaseId, title, summary, order；每条记录只表示一个剧情段，phaseId 必须引用全书架构中的真实幕 ID
- documents: order, plotSegmentId(可用 ref:剧情段临时ID), title, summary, status, blueprint{objective,povCharacterId,locationIds,characterIds,plotThreadIds,foreshadowingIds,conflict,informationRelease,mustHappen,flexible,forbidden}；正文任务可额外给 plainText；章节目标字数由系统设置，不得返回 targetWords
- scenes: chapterId, title, order, status, povCharacterId, storyTime, locationId, characterIds, plotThreadIds, foreshadowingIds, purpose, conflict, outcome, wordTarget, beats[{id,text,order}]
- entities: kind, name, aliases, summary, description, tags, lockedFacts, attributes；角色需包含 character（role/appearance/personality/desire/motivation/weakness/secret/abilities/voice/arc/state）
- relations: fromEntityId/toEntityId 可用 ref:临时ID，另含 relationType, publicLabel, privateTruth, bond
- plotThreads: kind, title, summary, status, priority, participantIds, progress, nextMove
- foreshadowing: title, clue, truth, status, urgency, notes
- timelineEvents: title, storyDate, duration, narrativeOrder, participantIds, causeIds, consequenceIds, description`;

const stringArraySchema = { type: "array", items: { type: "string" } } as const;
const characterSchema = {
  type: "object", additionalProperties: false,
  required: ["role", "appearance", "personality", "desire", "motivation", "weakness", "secret", "abilities", "voice", "arc", "state"],
  properties: {
    role: { type: "string" }, appearance: { type: "string" }, personality: { type: "string" }, desire: { type: "string" }, motivation: { type: "string" }, weakness: { type: "string" }, secret: { type: "string" }, abilities: stringArraySchema, voice: { type: "string" }, arc: { type: "string" },
    state: { type: "object", additionalProperties: false, required: ["location", "physical", "emotional", "objective", "inventory"], properties: { location: { type: "string" }, physical: { type: "string" }, emotional: { type: "string" }, objective: { type: "string" }, inventory: stringArraySchema, relationshipNotes: stringArraySchema, lastChangedChapterId: { type: "string" } } },
  },
} as const;
const TABLE_PAYLOAD_SCHEMAS: Record<ProposalTargetTable, Record<string, unknown>> = {
  projects: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, subtitle: { type: "string" }, premise: { type: "string" }, genre: stringArraySchema, audience: { type: "string" }, themes: stringArraySchema, sellingPoints: stringArraySchema, pov: { type: "string" }, tense: { type: "string" }, tone: { type: "string" }, languageStyle: { type: "string" }, targetWords: { type: "number", minimum: 1 } } },
  architectures: { type: "object", additionalProperties: false, properties: { framework: { enum: ["free", "three-act", "four-part", "save-the-cat", "snowflake"] }, status: { enum: ["draft", "approved"] }, centralQuestion: { type: "string" }, centralConflict: { type: "string" }, synopsis: { type: "string" }, phases: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "title", "purpose", "turningPoint", "order", "locked"], properties: { id: { type: "string" }, title: { type: "string" }, purpose: { type: "string" }, turningPoint: { type: "string" }, order: { type: "integer", minimum: 0 }, locked: { type: "boolean" } } } } } },
  outlineNodes: { type: "object", additionalProperties: false, properties: { phaseId: { type: "string", minLength: 1 }, title: { type: "string" }, summary: { type: "string" }, order: { type: "integer", minimum: 0 } } },
  documents: { type: "object", additionalProperties: false, properties: { order: { type: "integer", minimum: 0 }, plotSegmentId: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, status: { enum: ["outline", "draft", "review", "final"] }, plainText: { type: "string" }, blueprint: { type: "object", additionalProperties: false, properties: { objective: { type: "string" }, povCharacterId: { type: "string" }, locationIds: stringArraySchema, characterIds: stringArraySchema, plotThreadIds: stringArraySchema, foreshadowingIds: stringArraySchema, conflict: { type: "string" }, informationRelease: stringArraySchema, mustHappen: stringArraySchema, flexible: stringArraySchema, forbidden: stringArraySchema, targetWords: { type: "number", minimum: 1 } } } } },
  scenes: { type: "object", additionalProperties: false, properties: { chapterId: { type: "string" }, title: { type: "string" }, order: { type: "integer", minimum: 0 }, status: { enum: ["idea", "planned", "drafting", "done"] }, povCharacterId: { type: "string" }, storyTime: { type: "string" }, locationId: { type: "string" }, characterIds: stringArraySchema, plotThreadIds: stringArraySchema, foreshadowingIds: stringArraySchema, purpose: { type: "string" }, conflict: { type: "string" }, outcome: { type: "string" }, wordTarget: { type: "number", minimum: 0 }, beats: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "text", "order"], properties: { id: { type: "string" }, text: { type: "string" }, order: { type: "integer", minimum: 0 } } } } } },
  entities: { type: "object", additionalProperties: false, properties: { kind: { enum: ["character", "location", "organization", "faction", "item", "species", "rule", "ability", "term"] }, name: { type: "string" }, aliases: stringArraySchema, summary: { type: "string" }, description: { type: "string" }, tags: stringArraySchema, lockedFacts: stringArraySchema, attributes: { type: "object" }, character: characterSchema }, allOf: [{ if: { properties: { kind: { const: "character" } }, required: ["kind"] }, then: { required: ["character"] } }] },
  relations: { type: "object", additionalProperties: false, properties: { fromEntityId: { type: "string" }, toEntityId: { type: "string" }, relationType: { type: "string" }, publicLabel: { type: "string" }, privateTruth: { type: "string" }, bond: { type: "string" } } },
  plotThreads: { type: "object", additionalProperties: false, properties: { kind: { enum: ["main", "subplot", "romance", "growth", "mystery", "antagonist"] }, title: { type: "string" }, summary: { type: "string" }, status: { enum: ["planned", "active", "paused", "resolved", "abandoned"] }, priority: { type: "number", minimum: 0, maximum: 100 }, participantIds: stringArraySchema, startNodeId: { type: "string" }, targetNodeId: { type: "string" }, progress: { type: "number", minimum: 0, maximum: 100 }, nextMove: { type: "string" } } },
  foreshadowing: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, clue: { type: "string" }, truth: { type: "string" }, status: { enum: ["seeded", "reminded", "misdirected", "advanced", "revealed", "resolved", "abandoned"] }, seededNodeId: { type: "string" }, targetNodeId: { type: "string" }, urgency: { type: "number", minimum: 0, maximum: 100 }, notes: { type: "string" } } },
  timelineEvents: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, storyDate: { type: "string" }, duration: { type: "string" }, narrativeOrder: { type: "number" }, locationId: { type: "string" }, participantIds: stringArraySchema, causeIds: stringArraySchema, consequenceIds: stringArraySchema, description: { type: "string" }, parallelGroup: { type: "string" } } },
};

function modelPayloadSchema(table: ProposalTargetTable) {
  const schema = TABLE_PAYLOAD_SCHEMAS[table];
  if (table !== "documents") return schema;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const blueprint = properties.blueprint;
  const blueprintProperties = blueprint.properties as Record<string, unknown>;
  return {
    ...schema,
    properties: {
      ...properties,
      blueprint: {
        ...blueprint,
        properties: Object.fromEntries(Object.entries(blueprintProperties).filter(([key]) => key !== "targetWords")),
      },
    },
  };
}

const MODEL_PAYLOAD_SCHEMAS = Object.fromEntries(
  (Object.keys(TABLE_PAYLOAD_SCHEMAS) as ProposalTargetTable[]).map((table) => [table, modelPayloadSchema(table)]),
) as Record<ProposalTargetTable, Record<string, unknown>>;

function partialObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const partial = { ...schema };
  delete partial.required;
  if (partial.properties && typeof partial.properties === "object" && !Array.isArray(partial.properties)) {
    partial.properties = Object.fromEntries(Object.entries(partial.properties as Record<string, unknown>).map(([key, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).type !== "object") return [key, value];
      return [key, partialObjectSchema(value as Record<string, unknown>)];
    }));
  }
  return partial;
}

const UPDATE_MODEL_PAYLOAD_SCHEMAS = Object.fromEntries(
  (Object.keys(MODEL_PAYLOAD_SCHEMAS) as ProposalTargetTable[]).map((table) => [table, partialObjectSchema(MODEL_PAYLOAD_SCHEMAS[table])]),
) as Record<ProposalTargetTable, Record<string, unknown>>;

const payloadAjv = new Ajv({ allErrors: true, strict: false });
const PAYLOAD_VALIDATORS = Object.fromEntries(Object.entries(TABLE_PAYLOAD_SCHEMAS).map(([table, schema]) => [table, payloadAjv.compile(schema)])) as Record<ProposalTargetTable, ValidateFunction>;
const CREATE_REQUIRED_FIELDS: Record<ProposalTargetTable, string[]> = {
  projects: ["title", "premise"],
  architectures: ["centralQuestion", "centralConflict", "synopsis", "phases"],
  outlineNodes: ["phaseId", "title", "summary", "order"],
  documents: ["order", "plotSegmentId", "title", "summary", "blueprint"],
  scenes: ["chapterId", "title", "order", "purpose", "conflict", "outcome"],
  entities: ["kind", "name", "summary", "description"],
  relations: ["fromEntityId", "toEntityId", "relationType", "publicLabel", "privateTruth"],
  plotThreads: ["kind", "title", "summary", "status", "nextMove"],
  foreshadowing: ["title", "clue", "truth", "status", "notes"],
  timelineEvents: ["title", "storyDate", "narrativeOrder", "description"],
};
const CREATE_PAYLOAD_VALIDATORS = Object.fromEntries(Object.entries(TABLE_PAYLOAD_SCHEMAS).map(([table, schema]) => [table, payloadAjv.compile({ ...schema, required: CREATE_REQUIRED_FIELDS[table as ProposalTargetTable] })])) as Record<ProposalTargetTable, ValidateFunction>;

function proposalSchema(
  allowedTables: ProposalTargetTable[],
  requiredPayloadFields?: Partial<Record<ProposalTargetTable, string[]>>,
) {
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
            ...allowedTables.map((table) => ({ if: { properties: { targetTable: { const: table } } }, then: { properties: { payload: MODEL_PAYLOAD_SCHEMAS[table] } } })),
            ...allowedTables.map((table) => ({ if: { properties: { targetTable: { const: table }, operation: { const: "create" } }, required: ["targetTable", "operation"] }, then: { properties: { payload: { ...MODEL_PAYLOAD_SCHEMAS[table], required: CREATE_REQUIRED_FIELDS[table] } } } })),
            ...allowedTables.flatMap((table) => requiredPayloadFields?.[table]?.length
              ? [{ if: { properties: { targetTable: { const: table } }, required: ["targetTable"] }, then: { properties: { payload: { ...MODEL_PAYLOAD_SCHEMAS[table], required: requiredPayloadFields[table] } } } }]
              : []),
            { if: { properties: { operation: { const: "update" } }, required: ["operation"] }, then: { required: ["targetId"], properties: { payload: { type: "object", minProperties: 1 } } } },
          ],
        },
      },
    },
  };
}

function refinementProposalSchema(allowedTables: ProposalTargetTable[]) {
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
          required: ["label", "operation", "targetTable", "rationale"],
          properties: {
            label: { type: "string", minLength: 1 },
            operation: { enum: ["create", "update", "delete"] },
            targetTable: { enum: allowedTables },
            targetId: { type: "string" },
            tempId: { type: "string" },
            payload: { type: "object" },
            rationale: { type: "string" },
            dependencies: { type: "array", items: { type: "string" } },
          },
          allOf: [
            ...allowedTables.map((table) => ({ if: { properties: { targetTable: { const: table }, operation: { const: "create" } }, required: ["targetTable", "operation"] }, then: { required: ["payload"], properties: { payload: { ...MODEL_PAYLOAD_SCHEMAS[table], required: CREATE_REQUIRED_FIELDS[table] } } } })),
            ...allowedTables.map((table) => ({ if: { properties: { targetTable: { const: table }, operation: { const: "update" } }, required: ["targetTable", "operation"] }, then: { required: ["targetId", "payload"], properties: { payload: { ...UPDATE_MODEL_PAYLOAD_SCHEMAS[table], minProperties: 1 } } } })),
            { if: { properties: { operation: { const: "delete" } }, required: ["operation"] }, then: { required: ["targetId"] } },
          ],
        },
      },
    },
  };
}

function proposalMarkdown(title: string, summary: string, items: ProposalItem[]) {
  const operationLabel = { create: "新增", update: "更新", delete: "删除" } as const;
  return [`# ${title}`, summary, ...items.map((item, index) => `## ${index + 1}. ${item.label}\n\n${item.rationale}\n\n- 操作：${operationLabel[item.operation]}\n- 类型：${item.targetTable}${item.impact?.length ? `\n- 影响：${item.impact.join("；")}` : ""}\n\n### 内容\n${formatProposalPayload(item.targetTable, item.payload)}`)].join("\n\n");
}

function formatProposalPayload(table: ProposalTargetTable, payload: Record<string, unknown>): string {
  const fields = PROPOSAL_PREVIEW_FIELDS[table];
  if (!fields?.length) return Object.entries(payload).map(([k, v]) => `- ${k}：${formatValue(v)}`).join("\n") || "（空）";
  return fields.map(([field, label]) => {
    const value = payload[field];
    if (value === undefined || value === null || value === "") return "";
    return `**${label}**：${formatValue(value)}`;
  }).filter(Boolean).join("\n") || "（无关键字段）";
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length ? value.map((item) => `- ${formatValue(item)}`).join("\n") : "（空）";
  if (typeof value === "object" && value !== null) return JSON.stringify(value, null, 2);
  return String(value ?? "");
}

// 每类实体在预览中重点展示的字段（payload 键 → 中文标签）
const PROPOSAL_PREVIEW_FIELDS: Partial<Record<ProposalTargetTable, Array<[string, string]>>> = {
  projects: [["premise", "前提"], ["genre", "题材"], ["themes", "主题"], ["audience", "受众"], ["pov", "视角"], ["tone", "基调"], ["languageStyle", "语言风格"]],
  architectures: [["framework", "结构方法"], ["centralQuestion", "核心问题"], ["centralConflict", "核心冲突"], ["synopsis", "梗概"], ["phases", "阶段"]],
  entities: [["kind", "类型"], ["name", "名称"], ["summary", "摘要"], ["description", "描述"], ["aliases", "别名"], ["tags", "标签"], ["character", "角色设定"]],
  relations: [["fromEntityId", "主体"], ["toEntityId", "客体"], ["relationType", "关系类型"], ["publicLabel", "公开标签"], ["privateTruth", "隐情"], ["bond", "羁绊"]],
  outlineNodes: [["phaseId", "所属幕"], ["title", "剧情段标题"], ["summary", "剧情段摘要"]],
  documents: [["plotSegmentId", "所属剧情段"], ["title", "章节标题"], ["summary", "章节摘要"], ["blueprint", "章节蓝图"]],
  plotThreads: [["kind", "类型"], ["title", "标题"], ["summary", "摘要"], ["status", "状态"], ["priority", "优先级"], ["nextMove", "下一步"]],
  foreshadowing: [["title", "标题"], ["clue", "线索"], ["truth", "真相"], ["status", "状态"], ["urgency", "紧迫度"], ["notes", "备注"]],
  timelineEvents: [["title", "标题"], ["storyDate", "故事日期"], ["duration", "持续时间"], ["narrativeOrder", "叙事顺序"], ["description", "描述"]],
  scenes: [["title", "标题"], ["purpose", "目的"], ["conflict", "冲突"], ["outcome", "结果"], ["wordTarget", "目标字数"]],
};

async function existingInventory(projectId: string, tables: ProposalTargetTable[]) {
  const lines: string[] = [];
  for (const tableName of tables) {
    const project = tableName === "projects" ? await novelDb.projects.get(projectId) : undefined;
    const records = tableName === "projects"
      ? project ? [project as unknown as Record<string, unknown>] : []
      : await novelDb.table(tableName).where("projectId").equals(projectId).limit(120).toArray() as Array<Record<string, unknown>>;
    for (const record of records) lines.push(`${tableName} | id=${record.id} | revision=${record.revision} | ${String(record.title || record.name || record.id)}`);
  }
  return lines.join("\n") || "当前没有同类正式资料。";
}

async function projectReferenceCatalog(projectId: string) {
  const [entities, threads, clues] = await Promise.all([
    novelDb.entities.where("projectId").equals(projectId).toArray(),
    novelDb.plotThreads.where("projectId").equals(projectId).toArray(),
    novelDb.foreshadowing.where("projectId").equals(projectId).toArray(),
  ]);
  return buildProjectReferenceCatalogs(entities, threads, clues).get(projectId) ?? emptyReferenceCatalog();
}

async function projectCharacterNameToIdMap(projectId: string): Promise<Map<string, string>> {
  const entities = await novelDb.entities.where("projectId").equals(projectId).toArray();
  const map = new Map<string, string>();
  for (const entity of entities) {
    if (entity.kind !== "character" || !entity.name) continue;
    map.set(entity.name, entity.id);
    // 同时注册别名（aliases）以提高匹配率
    if (entity.aliases?.length) {
      for (const alias of entity.aliases) {
        if (alias && !map.has(alias)) map.set(alias, entity.id);
      }
    }
  }
  return map;
}

// 所有实体（含角色/地点/组织/物品等）的名→ID 映射，用于修复 LLM 凭空发明的 ref:tempId_* 引用
async function projectEntityNameToIdMap(projectId: string): Promise<Map<string, string>> {
  const entities = await novelDb.entities.where("projectId").equals(projectId).toArray();
  const map = new Map<string, string>();
  for (const entity of entities) {
    if (!entity.name) continue;
    map.set(entity.name, entity.id);
    if (entity.aliases?.length) {
      for (const alias of entity.aliases) {
        if (alias && !map.has(alias)) map.set(alias, entity.id);
      }
    }
  }
  return map;
}

async function referenceInventory(projectId: string) {
  const [entities, threads, clues, outlineNodes] = await Promise.all([
    novelDb.entities.where("projectId").equals(projectId).toArray(),
    novelDb.plotThreads.where("projectId").equals(projectId).toArray(),
    novelDb.foreshadowing.where("projectId").equals(projectId).toArray(),
    novelDb.outlineNodes.where("projectId").equals(projectId).sortBy("order"),
  ]);
  const characters = entities.filter((item) => item.kind === "character");
  return [
    "角色（characterIds / povCharacterId）：",
    ...(characters.length ? characters.map((item) => `- id=${item.id} | ${item.name}`) : ["- 暂无，不得填写角色 ID"]),
    "参与实体（participantIds）：",
    ...(entities.length ? entities.map((item) => `- id=${item.id} | ${item.kind} | ${item.name}`) : ["- 暂无，不得填写参与实体 ID"]),
    "剧情线（plotThreadIds）：",
    ...(threads.length ? threads.map((item) => `- id=${item.id} | ${item.title}`) : ["- 暂无，不得填写剧情线 ID"]),
    "伏笔（foreshadowingIds）：",
    ...(clues.length ? clues.map((item) => `- id=${item.id} | ${item.title}`) : ["- 暂无，不得填写伏笔 ID"]),
    "剧情段（startNodeId / targetNodeId / seededNodeId）：",
    ...(outlineNodes.length ? outlineNodes.map((item) => `- id=${item.id} | phaseId=${item.phaseId} | ${item.title}`) : ["- 暂无剧情段"]),
  ].join("\n");
}

function editablePayload(table: ProposalTargetTable, record: Record<string, unknown>) {
  const properties = TABLE_PAYLOAD_SCHEMAS[table].properties as Record<string, unknown>;
  return Object.fromEntries(Object.keys(properties).filter((key) => record[key] !== undefined).map((key) => [key, structuredClone(record[key])]));
}

function deepMergeRecord(base: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
  const next = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    const current = next[key];
    next[key] = current && value && typeof current === "object" && typeof value === "object" && !Array.isArray(current) && !Array.isArray(value)
      ? deepMergeRecord(current as Record<string, unknown>, value as Record<string, unknown>)
      : structuredClone(value);
  }
  return next;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
}

export async function fingerprintRefinementSnapshot(snapshot: RefinementSnapshot) {
  const content = JSON.stringify(stableValue(snapshot));
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function refinementRecords(projectId: string, taskKey: NovelGenerationTaskKey, table: ProposalTargetTable, targetId?: string) {
  const project = table === "projects" ? await novelDb.projects.get(projectId) : undefined;
  let records = table === "projects"
    ? project ? [project as unknown as Record<string, unknown>] : []
    : await novelDb.table(table).where("projectId").equals(projectId).toArray() as Array<Record<string, unknown>>;
  if (taskKey === "characters" && table === "entities") records = records.filter((record) => record.kind === "character");
  if (taskKey === "worldview" && table === "entities") records = records.filter((record) => record.kind !== "character");
  if (taskKey === "worldview" && table === "relations") {
    const entityIds = new Set((await refinementRecords(projectId, taskKey, "entities")).map((record) => String(record.id)));
    records = records.filter((record) => entityIds.has(String(record.fromEntityId)) && entityIds.has(String(record.toEntityId)));
  }
  if (taskKey === "chapter-plan" && table === "documents") records = records.filter((record) => record.id === targetId);
  if (taskKey === "scene-design" && table === "scenes") records = records.filter((record) => record.chapterId === targetId);
  return records.sort((left, right) => Number(left.order ?? left.narrativeOrder ?? 0) - Number(right.order ?? right.narrativeOrder ?? 0));
}

export async function buildRefinementSnapshot(params: {
  projectId: string;
  taskKey: NovelGenerationTaskKey;
  targetId?: string;
  sourceOverrides?: RefinementSnapshotInput;
}): Promise<RefinementSnapshot> {
  const task = getGenerationTask(params.taskKey);
  if (!task.refinable) throw new Error("当前任务不支持结构化微调");
  const snapshot: RefinementSnapshot = {};
  for (const table of task.allowedTables) {
    const persisted = await refinementRecords(params.projectId, params.taskKey, table, params.targetId);
    const byId = new Map(persisted.map((record) => [String(record.id), record]));
    for (const override of params.sourceOverrides?.[table] ?? []) {
      if (override.id) byId.set(String(override.id), { ...byId.get(String(override.id)), ...structuredClone(override) });
    }
    const records = [...byId.values()].map((record) => {
      const data = editablePayload(table, record);
      if (table === "documents") delete data.plainText;
      return { id: String(record.id), revision: Number(record.revision ?? 0), data };
    });
    if (records.length) snapshot[table] = records;
  }
  return snapshot;
}

async function attachExpectedRevisions(items: ProposalItem[]) {
  for (const item of items) {
    if (item.operation !== "update" || !item.targetId) continue;
    const current = await novelDb.table(item.targetTable).get(item.targetId) as (Record<string, unknown> & { revision?: number }) | undefined;
    item.expectedRevision = current?.revision;
    if (current) item.before = sanitizePayload(current);
  }
}

function parseProposalItems(data: Record<string, unknown>): ProposalItem[] {
  const rawItems = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
  return rawItems.map((raw) => ({
    id: crypto.randomUUID(),
    label: String(raw.label || "未命名候选"),
    operation: raw.operation === "update" ? "update" : "create",
    targetTable: raw.targetTable as ProposalTargetTable,
    targetId: typeof raw.targetId === "string" ? raw.targetId : undefined,
    tempId: typeof raw.tempId === "string" ? raw.tempId : undefined,
    status: "pending",
    payload: sanitizeModelPayload(raw.targetTable as ProposalTargetTable, (raw.payload ?? {}) as Record<string, unknown>),
    after: sanitizeModelPayload(raw.targetTable as ProposalTargetTable, (raw.payload ?? {}) as Record<string, unknown>),
    rationale: String(raw.rationale || ""),
    dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String) : [],
  }));
}

function namespaceTempIds(items: ProposalItem[], prefix: string): ProposalItem[] {
  const tempIdMap = new Map<string, string>();
  for (const item of items) {
    if (item.tempId) {
      const newTempId = `${prefix}${item.tempId}`;
      tempIdMap.set(item.tempId, newTempId);
      item.tempId = newTempId;
    }
  }
  const remap = (value: unknown): unknown => {
    if (typeof value === "string" && value.startsWith("ref:")) return `ref:${tempIdMap.get(value.slice(4)) ?? value.slice(4)}`;
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, remap(entry)]));
    return value;
  };
  for (const item of items) {
    item.payload = remap(item.payload) as Record<string, unknown>;
    item.after = { ...item.payload };
  }
  return items;
}
export function validatePlotDesignItems(items: ProposalItem[], phaseId: string, segmentOrder: number, chapterOrder: number) {
  if (items.some((item) => item.operation !== "create")) throw new Error("剧情设计只能创建新资料，不能更新已有资料");
  if (items.some((item) => item.targetTable !== "outlineNodes" && item.targetTable !== "documents")) throw new Error("剧情设计只能创建剧情段和章节");
  const segments = items.filter((item) => item.targetTable === "outlineNodes");
  const chapters = items.filter((item) => item.targetTable === "documents");
  if (segments.length !== 1) throw new Error(`剧情设计必须且只能创建 1 个剧情段，当前为 ${segments.length} 个`);
  if (chapters.length < 2 || chapters.length > 4) throw new Error(`剧情设计必须创建 2-4 个章节，当前为 ${chapters.length} 个`);
  const segment = segments[0];
  if (!segment.tempId) throw new Error("剧情段缺少 tempId");
  if (segment.payload.phaseId !== phaseId) throw new Error("剧情段必须归属于当前选中的幕");
  if (Number(segment.payload.order) !== segmentOrder) throw new Error(`剧情段顺序应为 ${segmentOrder}`);
  if (String(segment.payload.summary ?? "").length > 300) throw new Error("剧情段概要超过 300 字");
  const expectedSegment = `ref:${segment.tempId}`;
  for (const [index, chapter] of chapters.sort((left, right) => Number(left.payload.order) - Number(right.payload.order)).entries()) {
    if (chapter.payload.plotSegmentId !== expectedSegment) throw new Error("章节必须归属于本次新建的剧情段");
    if (Number(chapter.payload.order) !== chapterOrder + index) throw new Error(`章节顺序应从 ${chapterOrder} 连续排列`);
    if (!String(chapter.payload.title ?? "").trim()) throw new Error("章节必须提供章节标题");
    if (!String(chapter.payload.summary ?? "").trim()) throw new Error(`章节“${chapter.label}”必须提供章节摘要`);
    if (!chapter.payload.blueprint || typeof chapter.payload.blueprint !== "object") throw new Error(`章节“${chapter.label}”必须提供章节蓝图`);
  }
  return { segment, chapters };
}

function plotDesignContext(phase: ArchitecturePhase, segments: Array<{ id: string; title: string; summary: string; order: number }>, chapters: Array<{ title: string; summary: string; plotSegmentId?: string; order: number }>) {
  return [
    `当前幕：${phase.title}\n叙事使命：${phase.purpose || "暂无"}\n不可逆转折：${phase.turningPoint || "暂无"}`,
    `已有剧情段：\n${segments.map((segment) => `- ${segment.title}：${segment.summary || "暂无概要"}`).join("\n") || "暂无"}`,
    `最近章节：\n${chapters.slice(-6).map((chapter) => `- ${chapter.title}：${chapter.summary || "暂无摘要"}`).join("\n") || "暂无"}`,
  ].join("\n\n");
}

export async function runPlotDesignTask(params: { projectId: string; phaseId: string; instruction?: string; signal?: AbortSignal }) {
  const project = await novelDb.projects.get(params.projectId);
  if (!project) throw new Error("项目不存在");
  const pending = await novelDb.proposals.where("projectId").equals(params.projectId).and((proposal) => proposal.status === "pending" && proposal.taskKey === "plot-design").first();
  if (pending) return { proposal: pending, packet: await novelDb.contextPackets.get(pending.contextPacketId), agent: pending.agentRunId ? await novelDb.agentRuns.get(pending.agentRunId) : undefined };
  const [architecture, nodes, documents] = await Promise.all([
    novelDb.architectures.where("projectId").equals(params.projectId).first(),
    novelDb.outlineNodes.where("projectId").equals(params.projectId).toArray(),
    novelDb.documents.where("projectId").equals(params.projectId).sortBy("order"),
  ]);
  const phase = architecture?.phases.find((item) => item.id === params.phaseId);
  if (!phase) throw new Error("目标幕不存在，请先保存全书架构");
  const segments = nodes.filter((node) => node.phaseId === phase.id).sort((left, right) => left.order - right.order);
  const segmentOrder = segments.reduce((max, node) => Math.max(max, node.order), -1) + 1;
  const chapterOrder = documents.reduce((max, document) => Math.max(max, document.order), -1) + 1;
  const instruction = params.instruction?.trim() || "承接当前幕已有内容，设计下一个剧情段及其章节";
  const evidence = await resolveTaskEvidence({
    projectId: params.projectId,
    target: { kind: "architecture-phase", id: phase.id },
    task: "剧情设计",
    query: `${instruction}\n${phase.title}\n${phase.purpose}\n${phase.turningPoint}`,
    model: project.settings.textModel,
    role: "architect",
    allowedSourceKinds: ["architecture", "document", "entity", "relation", "outline", "thread", "foreshadowing", "fact", "memory", "conversation-memory"],
    gapPolicy: "creative-by-default",
    signal: params.signal,
  });
  const skills = await resolveNovelSkills({ projectId: params.projectId, stage: "planning" });
  if (skills.conflicts.length) throw new Error(`Skill 冲突：${skills.conflicts.map((item) => `${item.skillId} ↔ ${item.conflictsWith}`).join("；")}`);
  const packet = await compileNovelContext({
    projectId: params.projectId,
    task: "plot-design",
    instruction,
    stage: "planning",
    resolvedSkills: skills.skills,
    retrievalRunId: evidence.run.id,
    retrievalSourceIds: evidence.run.selectedSourceIds,
    retrievalHits: evidence.selectedHits,
    consumer: { role: "architect" },
  });
  const task = getGenerationTask("plot-design");
  const inventory = await existingInventory(params.projectId, task.allowedTables);
  const availableReferences = await referenceInventory(params.projectId);
  const acceptedRefs = await acceptedProjectReferences(params.projectId);
  const referenceAliases = [...acceptedRefs.entries()].map(([alias, id]) => `ref:${alias} -> ${id}`).join("\n") || "暂无已采纳临时引用。";
  const agent: AgentRun = { ...recordBase(params.projectId), goal: instruction, status: "running", model: project.settings.textModel, promptVersion: "novel-plot-design-v2", contextPacketId: packet.id, role: "architect", skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`), artifactRefs: [], attempt: 1, startedAt: Date.now(), steps: [{ id: crypto.randomUUID(), title: "设计剧情段与章节", tool: "model.structured", status: "running" }] };
  await novelDb.agentRuns.add(agent);
  const basePrompt = `# 任务\n在幕“${phase.title}”下设计下一个剧情段，并把剧情段拆成可直接进入创作流程的章节。\n\n# 作者要求\n${instruction}\n\n# 当前规划上下文\n${plotDesignContext(phase, segments, documents)}\n\n# 结构要求\n1. 只创建 1 个 outlineNodes 剧情段，phaseId 必须为 ${phase.id}，order 必须为 ${segmentOrder}，并提供 tempId。\n2. 剧情段 summary 使用 100-200 字连贯说明人物处境、局部矛盾和结束时的局面变化。\n3. 创建 2-4 个 documents 章节，plotSegmentId 必须使用 ref:剧情段tempId，order 从 ${chapterOrder} 连续排列。\n4. documents.title 就是正式章节标题；summary 交代本章推进与结尾变化；blueprint 写入目标、冲突、必须发生项，以及相关 characterIds、plotThreadIds、foreshadowingIds。\n5. 每章只承担清晰的一步因果推进，章节之间必须可连续写作，不得把章节再拆成事件。\n6. 不得创建幕、场景、时间线事件或其它资料表，也不得更新已有资料。\n7. 每章目标字数由系统统一设为 ${DEFAULT_CHAPTER_TARGET_WORDS} 字，不得返回 targetWords。\n\n# 证据边界\n既有事实只能来自冻结上下文；以下创作空白允许设计为新候选：${evidence.creativeGaps.join("；") || "无特别标记"}\n\n# 允许生成的资料表\n${task.allowedTables.join("、")}\n\n${payloadContract}\n\n# 现有对象索引\n${inventory}\n\n# 可引用对象索引\n${availableReferences}\n\n# 已采纳引用别名\n${referenceAliases}\n\n# 输出要求\n所有项必须为 create。内容中禁止出现候选、待审核等审批元信息。\n\n# 冻结上下文\n${formatContextPacket(packet)}`;
  try {
    const skillPrompt = compileNovelStagePrompt(skills.skills, "planning");
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await callStructuredNovelModel<Record<string, unknown>>({ model: project.settings.textModel, temperature: attempt ? 0.3 : 0.55, role: "architect", skillPrompt, schema: proposalSchema(task.allowedTables), prompt: attempt ? `${basePrompt}\n\n# 上次结构校验失败\n${lastError}\n请只修复结构和长度问题。` : basePrompt, signal: params.signal, maxTokens: 8192 });
      const items = namespaceTempIds(parseProposalItems(result.data), `plot_${phase.order}_${segmentOrder}_`);
      try {
        const segment = items.find((item) => item.targetTable === "outlineNodes");
        if (!segment) throw new Error("缺少剧情段候选");
        segment.payload = { ...segment.payload, phaseId: phase.id, order: segmentOrder };
        segment.after = { ...segment.payload };
        const chapters = items.filter((item) => item.targetTable === "documents").sort((left, right) => Number(left.payload.order) - Number(right.payload.order));
        for (const [index, chapter] of chapters.entries()) {
          chapter.payload = { ...chapter.payload, plotSegmentId: `ref:${segment.tempId}`, order: chapterOrder + index, status: "outline" };
          chapter.after = { ...chapter.payload };
        }
        validatePlotDesignItems(items, phase.id, segmentOrder, chapterOrder);
        const catalog = await projectReferenceCatalog(params.projectId);
        repairProposalCharacterReferences(items, catalog, await projectCharacterNameToIdMap(params.projectId));
        repairUnresolvableTempRefs(items, acceptedRefs, await projectEntityNameToIdMap(params.projectId));
        assertProposalReferences(items, catalog, acceptedRefs);
        const proposal: AIProposal = { ...recordBase(params.projectId), title: "剧情段与章节设计", operation: "structured:plot-design", taskKey: "plot-design", scope: "plot-design", targetId: phase.id, status: "pending", previewMarkdown: proposalMarkdown("剧情段与章节设计", String(result.data.summary || "新的剧情段与章节"), items), patches: [], items, contextPacketId: packet.id, agentRunId: agent.id, model: project.settings.textModel, outlineGenerationMode: "plot-segment-append", architecturePhaseId: phase.id, architecturePhaseOrder: phase.order };
        agent.status = "completed";
        agent.finishedAt = Date.now();
        agent.promptHash = result.promptHash;
        agent.usage = result.usage;
        agent.steps[0].status = "completed";
        agent.steps[0].output = `${items.length} 个候选项`;
        await novelDb.transaction("rw", novelDb.proposals, novelDb.agentRuns, async () => { await novelDb.proposals.add(proposal); await novelDb.agentRuns.put({ ...agent, revision: agent.revision + 1, updatedAt: Date.now() }); });
        return { proposal, packet, agent };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`AI 返回的剧情段与章节结构无效：${lastError}`);
  } catch (error) {
    agent.status = "failed";
    agent.finishedAt = Date.now();
    agent.steps[0].status = "failed";
    agent.steps[0].error = error instanceof Error ? error.message : String(error);
    await novelDb.agentRuns.put({ ...agent, revision: agent.revision + 1, updatedAt: Date.now() });
    throw error;
  }
}

export async function runGenerationTask(params: {
  projectId: string;
  taskKey: NovelGenerationTaskKey;
  instruction: string;
  targetId?: string;
  targetField?: string;
  signal?: AbortSignal;
  requiredPayloadFields?: Partial<Record<ProposalTargetTable, string[]>>;
}) {
  const task = getGenerationTask(params.taskKey);
  const project = await novelDb.projects.get(params.projectId);
  if (!project) throw new Error("项目不存在");
  const skills = await resolveNovelSkills({ projectId: params.projectId, stage: task.skillStage });
  if (skills.conflicts.length) throw new Error(`Skill 冲突：${skills.conflicts.map((item) => `${item.skillId} ↔ ${item.conflictsWith}`).join("；")}`);
  const packet = await compileNovelContext({
    projectId: params.projectId,
    task: params.taskKey,
    instruction: params.instruction,
    targetDocumentId: params.targetId,
    stage: task.skillStage,
    resolvedSkills: skills.skills,
  });
  const inventory = await existingInventory(params.projectId, task.allowedTables);
  const availableReferences = await referenceInventory(params.projectId);
  const acceptedRefs = await acceptedProjectReferences(params.projectId);
  const referenceAliases = [...acceptedRefs.entries()].map(([alias, id]) => `ref:${alias} -> ${id}`).join("\n") || "暂无已采纳临时引用。";

  const effectiveInstruction = params.instruction;
  let sectionContextBlock = "";
  if (params.taskKey === "chapter-plan") {
    sectionContextBlock += `\n# 章节字数规则\n每章目标字数由系统统一设置为 ${DEFAULT_CHAPTER_TARGET_WORDS} 字。请按该篇幅规划章节，但不要在 payload 中返回 targetWords。\n`;
  }
  if (params.taskKey === "plot-threads") {
    sectionContextBlock += `\n# 剧情线与规划关联\n- 每条剧情线的 startNodeId 和 targetNodeId 应引用"可引用对象索引"中的剧情段真实 ID。\n- startNodeId 标记剧情线起始剧情段，targetNodeId 标记剧情线目标达成剧情段。\n- 如剧情线贯穿全卷，可只填 startNodeId，targetNodeId 留空。\n`;
  }
  if (params.taskKey === "foreshadowing") {
    sectionContextBlock += `\n# 伏笔与规划关联\n- 每条伏笔的 seededNodeId 应引用"可引用对象索引"中埋设伏笔的剧情段真实 ID。\n- targetNodeId 应引用伏笔回收的剧情段真实 ID。\n- 如回收剧情段尚未规划，targetNodeId 可留空。\n`;
  }

  const agent: AgentRun = { ...recordBase(params.projectId), goal: effectiveInstruction, status: "running", model: project.settings.textModel, promptVersion: "novel-structured-v4", contextPacketId: packet.id, role: task.role, skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`), artifactRefs: [], attempt: 1, startedAt: Date.now(), steps: [{ id: crypto.randomUUID(), title: task.label, tool: "model.structured", status: "running" }] };
  await novelDb.agentRuns.add(agent);
  try {
    const skillPrompt = compileNovelStagePrompt(skills.skills, task.skillStage);
    const basePrompt = `# 任务\n${effectiveInstruction}\n${params.targetId ? `\n# 当前目标 ID\n${params.targetId}\n` : ""}${sectionContextBlock}\n# 允许生成的资料表\n${task.allowedTables.join("、")}\n\n${payloadContract}\n\n# 现有对象索引\n${inventory}\n\n# 可引用对象索引\n${availableReferences}\n\n# 已采纳引用别名\n${referenceAliases}\n\n# 输出要求\n本次生成的候选项由系统统一标记为待审核状态，你无需在内容里自行声明。payload 各字段（title、summary、description、rationale 等）只写故事内容本身，禁止出现“候选”“待审核”“待确认”“未批准”“仅供参考”等审批元信息，这些状态由系统管理。创建的对象如需互相引用，为每个对象提供 tempId，并使用 ref:tempId 引用。引用现有角色、剧情线和伏笔时，只能复制“可引用对象索引”中的真实 ID，不得把名称、英文别名或规则名当成 ID；没有可用对象时对应数组必须为空。也可使用上方已明确列出的 ref:别名；不得自行发明 ref: 标识。更新必须使用现有对象索引中的真实 targetId。\n\n# 冻结上下文\n${formatContextPacket(packet)}`;
    const result = await callStructuredNovelModel<Record<string, unknown>>({
        model: project.settings.textModel,
        temperature: task.role === "writer" ? project.settings.temperature : 0.55,
        role: task.role,
        skillPrompt,
        schema: proposalSchema(task.allowedTables, params.requiredPayloadFields),
        prompt: basePrompt,
        signal: params.signal,
        // Loop 7 修复 #11：角色生成需输出 5 个角色完整字段（appearance/personality/desire/motivation/weakness/secret/abilities/voice/arc/state），180s 默认超时不足
        timeoutMs: params.taskKey === "characters" ? 300_000 : undefined,
      });
    const items = parseProposalItems(result.data);
    if (params.taskKey === "chapter-draft") {
      for (const item of items) {
        if (item.targetTable !== "documents" || typeof item.payload.plainText !== "string") continue;
        const repaired = await repairDraftStructureOnce({ content: item.payload.plainText, model: project.settings.textModel, skillPrompt });
        item.payload = { ...item.payload, plainText: repaired.content };
        item.after = { ...item.after, plainText: repaired.content };
      }
    }
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
    {
      const [catalog, nameMap, entityNameMap] = await Promise.all([
        projectReferenceCatalog(params.projectId),
        projectCharacterNameToIdMap(params.projectId),
        projectEntityNameToIdMap(params.projectId),
      ]);
      repairProposalCharacterReferences(items, catalog, nameMap);
      repairUnresolvableTempRefs(items, acceptedRefs, entityNameMap);
      assertProposalReferences(items, catalog, acceptedRefs);
    }
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
    agent.status = "failed";
    agent.finishedAt = Date.now();
    agent.steps[0].status = "failed";
    agent.steps[0].error = error instanceof Error ? error.message : "生成失败";
    await novelDb.agentRuns.put({ ...agent, revision: agent.revision + 1, updatedAt: Date.now() });
    throw error;
  }
}

async function analyzeDeleteImpact(projectId: string, table: ProposalTargetTable, targetId: string) {
  const impact: string[] = [];
  if (table === "outlineNodes") {
    const chapters = await novelDb.documents.where("projectId").equals(projectId).filter((document) => document.plotSegmentId === targetId).count();
    if (chapters) impact.push(`将 ${chapters} 个章节移入待整理章节`);
  }
  if (table === "documents") {
    const [scenes, revisions, workflows] = await Promise.all([
      novelDb.scenes.where("chapterId").equals(targetId).count(),
      novelDb.revisions.where("documentId").equals(targetId).count(),
      novelDb.workflowRuns.where("targetDocumentId").equals(targetId).count(),
    ]);
    if (scenes) impact.push(`同时删除 ${scenes} 个场景`);
    if (revisions) impact.push(`同时删除 ${revisions} 个正文版本`);
    if (workflows) impact.push(`同时清理 ${workflows} 个章节流程`);
  }
  if (table === "entities") {
    const [relations, documents, scenes, threads, timeline] = await Promise.all([
      novelDb.relations.where("projectId").equals(projectId).filter((item) => item.fromEntityId === targetId || item.toEntityId === targetId).count(),
      novelDb.documents.where("projectId").equals(projectId).filter((item) => item.blueprint.characterIds.includes(targetId) || item.blueprint.locationIds.includes(targetId) || item.blueprint.povCharacterId === targetId).count(),
      novelDb.scenes.where("projectId").equals(projectId).filter((item) => item.characterIds.includes(targetId) || item.povCharacterId === targetId || item.locationId === targetId).count(),
      novelDb.plotThreads.where("projectId").equals(projectId).filter((item) => item.participantIds.includes(targetId)).count(),
      novelDb.timelineEvents.where("projectId").equals(projectId).filter((item) => item.participantIds.includes(targetId) || item.locationId === targetId).count(),
    ]);
    if (relations) impact.push(`同时删除 ${relations} 条关联关系`);
    const references = documents + scenes + threads + timeline;
    if (references) impact.push(`解除 ${references} 处结构化引用`);
  }
  if (table === "plotThreads") {
    const [documents, scenes] = await Promise.all([
      novelDb.documents.where("projectId").equals(projectId).filter((item) => item.blueprint.plotThreadIds.includes(targetId)).count(),
      novelDb.scenes.where("projectId").equals(projectId).filter((item) => item.plotThreadIds?.includes(targetId) ?? false).count(),
    ]);
    if (documents + scenes) impact.push(`解除 ${documents + scenes} 处剧情线引用`);
  }
  if (table === "foreshadowing") {
    const [documents, scenes] = await Promise.all([
      novelDb.documents.where("projectId").equals(projectId).filter((item) => item.blueprint.foreshadowingIds.includes(targetId)).count(),
      novelDb.scenes.where("projectId").equals(projectId).filter((item) => item.foreshadowingIds?.includes(targetId) ?? false).count(),
    ]);
    if (documents + scenes) impact.push(`解除 ${documents + scenes} 处伏笔引用`);
  }
  if (table === "timelineEvents") {
    const references = await novelDb.timelineEvents.where("projectId").equals(projectId).filter((item) => item.causeIds.includes(targetId) || item.consequenceIds.includes(targetId)).count();
    if (references) impact.push(`解除 ${references} 处时间因果引用`);
  }
  return impact;
}

function assertLockedArchitecturePreserved(before: Record<string, unknown>, after: Record<string, unknown>) {
  const locked = Array.isArray(before.phases) ? before.phases.filter((phase) => Boolean((phase as Record<string, unknown>).locked)) as Array<Record<string, unknown>> : [];
  const afterPhases = Array.isArray(after.phases) ? after.phases as Array<Record<string, unknown>> : [];
  for (const phase of locked) {
    const next = afterPhases.find((candidate) => candidate.id === phase.id);
    if (!next || JSON.stringify(stableValue(next)) !== JSON.stringify(stableValue(phase))) throw new Error(`锁定阶段“${String(phase.title || phase.id)}”不能被微调`);
  }
}

export async function runRefinementTask(params: {
  projectId: string;
  taskKey: NovelGenerationTaskKey;
  instruction: string;
  targetId?: string;
  sourceOverrides?: RefinementSnapshotInput;
}) {
  const instruction = params.instruction.trim();
  if (!instruction) throw new Error("请输入具体的微调要求");
  const task = getGenerationTask(params.taskKey);
  if (!task.refinable) throw new Error("当前任务不支持结构化微调");
  const project = await novelDb.projects.get(params.projectId);
  if (!project) throw new Error("项目不存在");
  const snapshot = await buildRefinementSnapshot(params);
  const sourceJson = JSON.stringify(snapshot, null, 2);
  if (!Object.keys(snapshot).length) throw new Error("当前板块还没有可微调的原数据");
  const sourceFingerprint = await fingerprintRefinementSnapshot(snapshot);
  const skills = await resolveNovelSkills({ projectId: params.projectId, stage: task.skillStage });
  if (skills.conflicts.length) throw new Error(`Skill 冲突：${skills.conflicts.map((item) => `${item.skillId} ↔ ${item.conflictsWith}`).join("；")}`);
  const packet = await compileNovelContext({ projectId: params.projectId, task: params.taskKey, instruction, targetDocumentId: params.targetId, stage: task.skillStage, resolvedSkills: skills.skills });
  const availableReferences = await referenceInventory(params.projectId);
  const acceptedRefs = await acceptedProjectReferences(params.projectId);
  const agent: AgentRun = { ...recordBase(params.projectId), goal: instruction, status: "running", model: project.settings.textModel, promptVersion: "novel-refinement-v1", contextPacketId: packet.id, role: task.role, skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`), artifactRefs: [], attempt: 1, startedAt: Date.now(), steps: [{ id: crypto.randomUUID(), title: `微调：${task.label}`, tool: "model.structured", status: "running" }] };
  await novelDb.agentRuns.add(agent);
  try {
    const result = await callStructuredNovelModel<Record<string, unknown>>({
      model: project.settings.textModel,
      temperature: 0.35,
      role: task.role,
      skillPrompt: compileNovelStagePrompt(skills.skills, task.skillStage),
      schema: refinementProposalSchema(task.allowedTables),
      // Loop 7 修复 #11：角色微调也可能涉及多角色完整字段重写
      timeoutMs: params.taskKey === "characters" ? 300_000 : undefined,
      prompt: `# 微调任务\n${instruction}\n\n# 原始结构化数据\n${sourceJson}\n\n${payloadContract}\n\n# 可引用对象索引\n${availableReferences}\n\n# 输出要求\n只返回提示词实际要求发生变化的候选项，未提及的数据必须保持不变。update 和 delete 只能使用原始数据中存在的真实 targetId；create 必须提供 tempId。update 的 payload 只放需要变化的字段，系统会与原数据合并。角色、剧情线和伏笔引用只能使用索引中的真实 ID 或同一候选中的有效 ref:tempId，不得自行发明。delete 不要输出 payload。不得删除 projects 或 architectures。用户本次微调指令授权提出候选变更，但锁定内容仍不可更改。审批状态由系统统一管理，payload 各字段只写故事内容本身，禁止出现“候选”“待审核”“待确认”“未批准”“仅供参考”等元信息。\n\n# 冻结上下文\n${formatContextPacket(packet)}`,
    });
    const rawItems = Array.isArray(result.data.items) ? result.data.items as Array<Record<string, unknown>> : [];
    const seenTargets = new Set<string>();
    const items: ProposalItem[] = [];
    for (const raw of rawItems) {
      const targetTable = raw.targetTable as ProposalTargetTable;
      if (!task.allowedTables.includes(targetTable)) throw new Error(`AI 返回了不允许修改的资料表：${String(raw.targetTable)}`);
      const operation = raw.operation === "delete" ? "delete" : raw.operation === "update" ? "update" : "create";
      const targetId = typeof raw.targetId === "string" ? raw.targetId : undefined;
      const sourceRecord = targetId ? snapshot[targetTable]?.find((record) => record.id === targetId) : undefined;
      if ((operation === "update" || operation === "delete") && !sourceRecord) throw new Error(`AI 尝试修改未提供的对象：${targetTable}/${targetId || "未指定"}`);
      if (operation === "delete" && (targetTable === "projects" || targetTable === "architectures")) throw new Error("项目定位和全书架构不能由微调整体删除");
      if (targetId && operation !== "create") {
        const key = `${targetTable}:${targetId}`;
        if (seenTargets.has(key)) throw new Error(`AI 对同一对象返回了多项冲突操作：${key}`);
        seenTargets.add(key);
      }
      const payload = operation === "delete" ? {} : sanitizeModelPayload(targetTable, (raw.payload ?? {}) as Record<string, unknown>);
      const after = operation === "update" && sourceRecord ? deepMergeRecord(sourceRecord.data, payload) : operation === "create" ? payload : undefined;
      if (after) {
        const validate = CREATE_PAYLOAD_VALIDATORS[targetTable];
        if (!validate(after)) throw new Error(`“${String(raw.label || "未命名候选")}”字段无效：${validate.errors?.map((error) => `${error.instancePath || "root"} ${error.message}`).join("；")}`);
        if (targetTable === "architectures" && sourceRecord) assertLockedArchitecturePreserved(sourceRecord.data, after);
        if (operation === "update" && sourceRecord && JSON.stringify(stableValue(after)) === JSON.stringify(stableValue(sourceRecord.data))) continue;
      }
      items.push({
        id: crypto.randomUUID(),
        label: String(raw.label || "未命名候选"),
        operation,
        targetTable,
        targetId,
        tempId: operation === "create" ? String(raw.tempId || `refine_${crypto.randomUUID()}`) : undefined,
        expectedRevision: sourceRecord?.revision,
        before: sourceRecord?.data,
        status: "pending",
        payload: after ?? {},
        after,
        rationale: String(raw.rationale || "按微调要求调整"),
        dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String) : [],
        impact: operation === "delete" && targetId ? await analyzeDeleteImpact(params.projectId, targetTable, targetId) : undefined,
      });
    }
    if (!items.length) throw new Error("AI 返回的微调结果没有产生实际变化，请换一种更明确的描述后重试");
    {
      const [catalog, nameMap, entityNameMap] = await Promise.all([
        projectReferenceCatalog(params.projectId),
        projectCharacterNameToIdMap(params.projectId),
        projectEntityNameToIdMap(params.projectId),
      ]);
      repairProposalCharacterReferences(items, catalog, nameMap);
      repairUnresolvableTempRefs(items, acceptedRefs, entityNameMap);
      assertProposalReferences(items, catalog, acceptedRefs);
    }
    const summary = String(result.data.summary || instruction);
    const proposal: AIProposal = {
      ...recordBase(params.projectId),
      title: `微调：${task.label}`,
      operation: `structured-refine:${params.taskKey}`,
      taskKey: params.taskKey,
      scope: task.scope,
      targetId: params.targetId,
      status: "pending",
      previewMarkdown: proposalMarkdown(`微调：${task.label}`, summary, items),
      patches: [],
      items,
      contextPacketId: packet.id,
      agentRunId: agent.id,
      model: project.settings.textModel,
      generationMode: "refine",
      sourceFingerprint,
    };
    agent.status = "completed";
    agent.finishedAt = Date.now();
    agent.promptHash = result.promptHash;
    agent.usage = result.usage;
    agent.steps[0].status = "completed";
    agent.steps[0].output = `${items.length} 个微调候选项`;
    await novelDb.transaction("rw", novelDb.proposals, novelDb.agentRuns, async () => {
      await novelDb.proposals.add(proposal);
      await novelDb.agentRuns.put({ ...agent, revision: agent.revision + 1, updatedAt: Date.now() });
    });
    return { proposal, packet, agent, snapshot };
  } catch (error) {
    agent.status = "failed";
    agent.finishedAt = Date.now();
    agent.steps[0].status = "failed";
    agent.steps[0].error = error instanceof Error ? error.message : "微调失败";
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

function sanitizeModelPayload(table: ProposalTargetTable, payload: Record<string, unknown>) {
  const sanitized = sanitizePayload(payload);
  // 剥离 LLM 在内容字段里添加的"候选/待审核"等审批元信息（状态应由系统管理）
  sanitizeApprovalMetaInPlace(sanitized);
  if (table === "architectures") return normalizeArchitecturePayload(sanitized);
  if (table === "outlineNodes") {
    for (const retiredField of ["parentId", "kind", "status", "storyTime", "tags", "characterIds", "plotThreadIds", "foreshadowingIds"]) delete sanitized[retiredField];
    return sanitized;
  }
  if (table !== "documents" || !sanitized.blueprint || typeof sanitized.blueprint !== "object" || Array.isArray(sanitized.blueprint)) return sanitized;
  const blueprint = { ...sanitized.blueprint as Record<string, unknown> };
  delete blueprint.targetWords;
  return { ...sanitized, blueprint };
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

export function normalizedCreate(table: ProposalTargetTable, projectId: string, id: string, payload: Record<string, unknown>) {
  const base = { ...recordBase(projectId), id };
  if (table === "architectures") return normalizeArchitecturePayload({ ...base, framework: "free", status: "draft", centralQuestion: "", centralConflict: "", synopsis: "", phases: [], ...payload });
  if (table === "outlineNodes") {
    return { ...base, phaseId: "", title: "未命名剧情段", summary: "", order: 0, ...payload };
  }
  if (table === "documents") {
    const { blueprint, ...rest } = payload;
    return { ...base, order: 0, title: "未命名章节", contentHtml: "", plainText: "", summary: "", status: "outline", wordCount: 0, branch: "main", yjsDocumentId: crypto.randomUUID(), ...rest, blueprint: { ...emptyChapterBlueprint(), ...(blueprint as Record<string, unknown> | undefined) } };
  }
  if (table === "scenes") return { ...base, chapterId: "", title: "未命名场景", order: 0, status: "idea", characterIds: [], plotThreadIds: [], foreshadowingIds: [], purpose: "", conflict: "", outcome: "", wordTarget: 800, beats: [], ...payload };
  if (table === "entities") {
    const characterDefaults = { role: "", appearance: "", personality: "", desire: "", motivation: "", weakness: "", secret: "", abilities: [], voice: "", arc: "", state: { location: "", physical: "", emotional: "", objective: "", inventory: [], relationshipNotes: [] } };
    const record = { ...base, kind: "term", name: "未命名资料", aliases: [], summary: "", description: "", tags: [], lockedFacts: [], attributes: {}, ...payload } as Record<string, unknown>;
    if (record.kind === "character") {
      const character = (payload.character ?? {}) as Record<string, unknown>;
      record.character = { ...characterDefaults, ...character, state: { ...characterDefaults.state, ...(character.state as Record<string, unknown> | undefined) } };
    }
    return record;
  }
  if (table === "relations") return { ...base, fromEntityId: "", toEntityId: "", relationType: "关联", publicLabel: "", privateTruth: "", bond: "", ...payload };
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

export async function regenerateProposalItem(proposalId: string, itemId: string, instruction: string, sourceOverrides?: RefinementSnapshotInput) {
  const proposal = await novelDb.proposals.get(proposalId);
  const current = proposal?.items.find((item) => item.id === itemId);
  if (!proposal?.taskKey || !current || proposal.status !== "pending") throw new Error("候选项已不可重新生成");
  const replacementInstruction = `${instruction}\n\n只返回 1 个候选项，用于替换“${current.label}”。目标表必须是 ${current.targetTable}，操作类型保持 ${current.operation}。`;
  const result = proposal.generationMode === "refine"
    ? await runRefinementTask({ projectId: proposal.projectId, taskKey: proposal.taskKey, targetId: proposal.targetId, instruction: replacementInstruction, sourceOverrides })
    : await runGenerationTask({ projectId: proposal.projectId, taskKey: proposal.taskKey, targetId: proposal.targetId, instruction: replacementInstruction });
  const replacement = result.proposal.items[0];
  if (!replacement) throw new Error("AI 没有返回替换候选项");
  const lockedReplacement: ProposalItem = { ...replacement, id: current.id, operation: current.operation, targetTable: current.targetTable, targetId: current.targetId, tempId: current.tempId, dependencies: current.dependencies };
  if (proposal.generationMode !== "refine") await attachExpectedRevisions([lockedReplacement]);
  let updatedItem: ProposalItem | undefined;
  await novelDb.transaction("rw", novelDb.proposals, async () => {
    const latest = await novelDb.proposals.get(proposalId);
    await novelDb.proposals.delete(result.proposal.id);
    if (!latest || latest.status !== "pending" || latest.revision !== proposal.revision || !latest.items.some((item) => item.id === itemId)) return;
    const items = latest.items.map((item) => item.id === itemId ? lockedReplacement : item);
    await novelDb.proposals.put({ ...latest, items, sourceFingerprint: result.proposal.sourceFingerprint ?? latest.sourceFingerprint, previewMarkdown: proposalMarkdown(latest.title, "已重新生成指定候选项。", items), revision: latest.revision + 1, updatedAt: Date.now() });
    updatedItem = lockedReplacement;
  });
  if (!updatedItem) throw new Error("提案在重新生成期间已被其他操作处理");
  return updatedItem;
}

function withoutId(values: string[] | undefined, id: string) {
  return (values ?? []).filter((value) => value !== id);
}

async function putCascadeUpdate(tableName: ProposalTargetTable, projectId: string, record: Record<string, unknown>, changes: Record<string, unknown>) {
  const table = novelDb.table(tableName) as Table<Record<string, unknown>, string>;
  const next = { ...record, ...changes, revision: Number(record.revision ?? 0) + 1, updatedAt: Date.now(), updatedBy: "local-user" };
  await table.put(next);
  await appendOperation(projectId, tableName, String(record.id), "update", { value: { before: record, after: next } });
}

async function applyDeleteCandidate(params: {
  proposalId: string;
  projectId: string;
  item: ProposalItem;
  collaborativeDeletes: Array<{ projectId: string; documentId: string }>;
}) {
  const { item, projectId } = params;
  if (!item.targetId || item.targetTable === "projects" || item.targetTable === "architectures") throw new Error(`“${item.label}”不是可删除的结构化条目`);
  const targetId = item.targetId;
  const table = novelDb.table(item.targetTable) as Table<Record<string, unknown>, string>;
  const before = await table.get(targetId);
  if (!before) return;

  if (item.targetTable === "outlineNodes") {
    const removed = new Set([targetId]);
    const documents = await novelDb.documents.where("projectId").equals(projectId).filter((document) => document.plotSegmentId === targetId).toArray();
    for (const document of documents) await putCascadeUpdate("documents", projectId, document as unknown as Record<string, unknown>, { plotSegmentId: undefined });
    await novelDb.outlineNodes.delete(targetId);
    await novelDb.outlineRealizations.where("projectId").equals(projectId).filter((realization) => realization.outlineNodeId === targetId).delete();
    await novelDb.embeddings.where("targetId").equals(targetId).delete();
    const threads = await novelDb.plotThreads.where("projectId").equals(projectId).toArray();
    for (const thread of threads) {
      const changes: Record<string, unknown> = {};
      if (thread.startNodeId && removed.has(thread.startNodeId)) changes.startNodeId = undefined;
      if (thread.targetNodeId && removed.has(thread.targetNodeId)) changes.targetNodeId = undefined;
      if (Object.keys(changes).length) await putCascadeUpdate("plotThreads", projectId, thread as unknown as Record<string, unknown>, changes);
    }
    const clues = await novelDb.foreshadowing.where("projectId").equals(projectId).toArray();
    for (const clue of clues) {
      const changes: Record<string, unknown> = {};
      if (clue.seededNodeId && removed.has(clue.seededNodeId)) changes.seededNodeId = undefined;
      if (clue.targetNodeId && removed.has(clue.targetNodeId)) changes.targetNodeId = undefined;
      if (Object.keys(changes).length) await putCascadeUpdate("foreshadowing", projectId, clue as unknown as Record<string, unknown>, changes);
    }
  } else if (item.targetTable === "documents") {
    const document = before;
    const runs = await novelDb.workflowRuns.where("targetDocumentId").equals(targetId).toArray();
    const runIds = runs.map((run) => run.id);
    const proposalIds = (await novelDb.proposals.where("targetId").equals(targetId).primaryKeys() as string[]).filter((id) => id !== params.proposalId);
    const sceneIds = await novelDb.scenes.where("chapterId").equals(targetId).primaryKeys() as string[];
    const revisionIds = await novelDb.revisions.where("documentId").equals(targetId).primaryKeys() as string[];
    const workflowAgentIds = runIds.length ? await novelDb.agentRuns.where("projectId").equals(projectId).filter((run) => Boolean(run.workflowRunId && runIds.includes(run.workflowRunId))).primaryKeys() as string[] : [];
    const contextIds = runs.map((run) => run.contextPacketId).filter((id): id is string => Boolean(id));
    await retireChapterDependencies(projectId, targetId, revisionIds);
    await novelDb.documents.delete(targetId);
    await novelDb.scenes.where("chapterId").equals(targetId).delete();
    await novelDb.revisions.where("documentId").equals(targetId).delete();
    await novelDb.manuscriptChanges.where("documentId").equals(targetId).delete();
    if (runIds.length) {
      await novelDb.workflowArtifacts.where("workflowRunId").anyOf(runIds).delete();
      await novelDb.qualityReports.where("workflowRunId").anyOf(runIds).delete();
      await novelDb.factCandidates.where("workflowRunId").anyOf(runIds).delete();
      await novelDb.workflowRuns.bulkDelete(runIds);
    }
    if (proposalIds.length) await novelDb.proposals.bulkDelete(proposalIds);
    if (workflowAgentIds.length) await novelDb.agentRuns.bulkDelete(workflowAgentIds);
    if (contextIds.length) await novelDb.contextPackets.bulkDelete(contextIds);
    await novelDb.embeddings.where("targetId").anyOf([targetId, ...sceneIds]).delete();
    if (typeof document.yjsDocumentId === "string") params.collaborativeDeletes.push({ projectId, documentId: document.yjsDocumentId });
  } else if (item.targetTable === "entities") {
    const relations = await novelDb.relations.where("projectId").equals(projectId).filter((relation) => relation.fromEntityId === targetId || relation.toEntityId === targetId).toArray();
    for (const relation of relations) {
      await novelDb.relations.delete(relation.id);
      await appendOperation(projectId, "relations", relation.id, "delete", { value: { before: relation, after: null } });
    }
    const scenes = await novelDb.scenes.where("projectId").equals(projectId).filter((scene) => scene.characterIds.includes(targetId) || scene.povCharacterId === targetId || scene.locationId === targetId).toArray();
    for (const scene of scenes) await putCascadeUpdate("scenes", projectId, scene as unknown as Record<string, unknown>, { characterIds: withoutId(scene.characterIds, targetId), ...(scene.povCharacterId === targetId ? { povCharacterId: undefined } : {}), ...(scene.locationId === targetId ? { locationId: undefined } : {}) });
    const documents = await novelDb.documents.where("projectId").equals(projectId).filter((document) => document.blueprint.characterIds.includes(targetId) || document.blueprint.locationIds.includes(targetId) || document.blueprint.povCharacterId === targetId).toArray();
    for (const document of documents) await putCascadeUpdate("documents", projectId, document as unknown as Record<string, unknown>, { blueprint: { ...document.blueprint, characterIds: withoutId(document.blueprint.characterIds, targetId), locationIds: withoutId(document.blueprint.locationIds, targetId), ...(document.blueprint.povCharacterId === targetId ? { povCharacterId: undefined } : {}) } });
    const threads = await novelDb.plotThreads.where("projectId").equals(projectId).filter((thread) => thread.participantIds.includes(targetId)).toArray();
    for (const thread of threads) await putCascadeUpdate("plotThreads", projectId, thread as unknown as Record<string, unknown>, { participantIds: withoutId(thread.participantIds, targetId) });
    const events = await novelDb.timelineEvents.where("projectId").equals(projectId).filter((event) => event.participantIds.includes(targetId) || event.locationId === targetId).toArray();
    for (const event of events) await putCascadeUpdate("timelineEvents", projectId, event as unknown as Record<string, unknown>, { participantIds: withoutId(event.participantIds, targetId), ...(event.locationId === targetId ? { locationId: undefined } : {}) });
  } else if (item.targetTable === "plotThreads") {
    const documents = await novelDb.documents.where("projectId").equals(projectId).filter((document) => document.blueprint.plotThreadIds.includes(targetId)).toArray();
    for (const document of documents) await putCascadeUpdate("documents", projectId, document as unknown as Record<string, unknown>, { blueprint: { ...document.blueprint, plotThreadIds: withoutId(document.blueprint.plotThreadIds, targetId) } });
    const scenes = await novelDb.scenes.where("projectId").equals(projectId).filter((scene) => scene.plotThreadIds?.includes(targetId) ?? false).toArray();
    for (const scene of scenes) await putCascadeUpdate("scenes", projectId, scene as unknown as Record<string, unknown>, { plotThreadIds: withoutId(scene.plotThreadIds, targetId) });
  } else if (item.targetTable === "foreshadowing") {
    const documents = await novelDb.documents.where("projectId").equals(projectId).filter((document) => document.blueprint.foreshadowingIds.includes(targetId)).toArray();
    for (const document of documents) await putCascadeUpdate("documents", projectId, document as unknown as Record<string, unknown>, { blueprint: { ...document.blueprint, foreshadowingIds: withoutId(document.blueprint.foreshadowingIds, targetId) } });
    const scenes = await novelDb.scenes.where("projectId").equals(projectId).filter((scene) => scene.foreshadowingIds?.includes(targetId) ?? false).toArray();
    for (const scene of scenes) await putCascadeUpdate("scenes", projectId, scene as unknown as Record<string, unknown>, { foreshadowingIds: withoutId(scene.foreshadowingIds, targetId) });
  } else if (item.targetTable === "timelineEvents") {
    const events = await novelDb.timelineEvents.where("projectId").equals(projectId).filter((event) => event.causeIds.includes(targetId) || event.consequenceIds.includes(targetId)).toArray();
    for (const event of events) await putCascadeUpdate("timelineEvents", projectId, event as unknown as Record<string, unknown>, { causeIds: withoutId(event.causeIds, targetId), consequenceIds: withoutId(event.consequenceIds, targetId) });
  }

  await table.delete(targetId);
  await novelDb.embeddings.where("targetId").equals(targetId).delete();
  await appendOperation(projectId, item.targetTable, targetId, "delete", { value: { before, after: null } });
}

export async function applyProposalItems(proposalId: string, selectedItemIds: string[], options?: { sourceFingerprint?: string; selectedFields?: Record<string, string[]> }) {
  const initialProposal = await novelDb.proposals.get(proposalId);
  if (!initialProposal || initialProposal.status !== "pending") throw new Error("提案不存在或已经处理");
  if (initialProposal.sourceFingerprint && options?.sourceFingerprint && initialProposal.sourceFingerprint !== options.sourceFingerprint) throw new Error("原数据已在微调后发生变化，请退回候选并重新微调");
  const initialSelected = initialProposal.items.filter((item) => selectedItemIds.includes(item.id) && (item.operation !== "update" || options?.selectedFields?.[item.id] === undefined || options.selectedFields[item.id].length > 0));
  if (!initialSelected.length) throw new Error("请至少选择一个候选项");
  const appendPlotSegment = initialProposal.taskKey === "plot-design" && initialProposal.outlineGenerationMode === "plot-segment-append";
  if (appendPlotSegment) {
    if (initialSelected.length !== initialProposal.items.length) throw new Error("剧情设计必须整体采纳");
    if (!initialProposal.targetId) throw new Error("剧情设计缺少目标幕");
    const segment = initialSelected.find((item) => item.targetTable === "outlineNodes");
    const chapters = initialSelected.filter((item) => item.targetTable === "documents").sort((left, right) => Number(left.payload.order) - Number(right.payload.order));
    validatePlotDesignItems(initialSelected, initialProposal.targetId, Number(segment?.payload.order), Number(chapters[0]?.payload.order));
  }
  const acceptedRefs = await acceptedProjectReferences(initialProposal.projectId);
  const entityNameToIdMap = await projectEntityNameToIdMap(initialProposal.projectId);
  const tables = initialSelected.some((item) => item.operation === "delete")
    ? novelDb.tables
    : [...new Set([
      ...initialSelected.map((item) => novelDb.table(item.targetTable)),
      novelDb.architectures, novelDb.documents, novelDb.outlineNodes, novelDb.entities, novelDb.plotThreads, novelDb.foreshadowing, novelDb.operations, novelDb.proposals, novelDb.embeddings,
    ])];
  const embeddings: Array<{ table: ProposalTargetTable; id: string; record: Record<string, unknown> }> = [];
  const collaborativeDeletes: Array<{ projectId: string; documentId: string }> = [];
  let appliedCount = 0;
  let conflictCount = 0;
  await novelDb.transaction("rw", tables, async () => {
    const proposal = await novelDb.proposals.get(proposalId);
    if (!proposal || proposal.status !== "pending") throw new Error("提案已由其他操作处理");
    const selected = proposal.items.filter((item) => selectedItemIds.includes(item.id) && (item.operation !== "update" || options?.selectedFields?.[item.id] === undefined || options.selectedFields[item.id].length > 0));
    if (proposal.taskKey === "plot-design" && proposal.outlineGenerationMode === "plot-segment-append") {
      if (!proposal.targetId || selected.length !== proposal.items.length) throw new Error("剧情设计必须整体采纳");
      const [architecture, allNodes, documents] = await Promise.all([
        novelDb.architectures.where("projectId").equals(proposal.projectId).first(),
        novelDb.outlineNodes.where("projectId").equals(proposal.projectId).toArray(),
        novelDb.documents.where("projectId").equals(proposal.projectId).toArray(),
      ]);
      if (!architecture?.phases.some((phase) => phase.id === proposal.targetId)) throw new Error("目标幕已发生变化，请退回后重新生成剧情设计");
      const nextSegmentOrder = allNodes.filter((node) => node.phaseId === proposal.targetId).reduce((max, node) => Math.max(max, node.order), -1) + 1;
      const nextChapterOrder = documents.reduce((max, document) => Math.max(max, document.order), -1) + 1;
      validatePlotDesignItems(selected, proposal.targetId, nextSegmentOrder, nextChapterOrder);
    }
    const selectedTempIds = new Set(selected.map((item) => item.tempId).filter((id): id is string => Boolean(id)));
    const generatedTempIds = new Set(proposal.items.map((item) => item.tempId).filter((id): id is string => Boolean(id)));
    const missingDependencies = selected.flatMap((item) => item.dependencies.filter((dependency) => generatedTempIds.has(dependency) && !selectedTempIds.has(dependency)));
    if (missingDependencies.length) throw new Error(`请同时选择依赖项：${[...new Set(missingDependencies)].join("、")}`);
    const refs = new Map(acceptedRefs);
    for (const item of selected) if (item.tempId) refs.set(item.tempId, item.targetId || crypto.randomUUID());
    const conflicts: string[] = [];
    for (const item of selected) {
      if ((item.operation !== "update" && item.operation !== "delete") || !item.targetId) continue;
      const current = await novelDb.table(item.targetTable).get(item.targetId) as { revision?: number } | undefined;
      if (!current || current.revision !== item.expectedRevision) conflicts.push(item.id);
    }
    const applicable = selected.filter((item) => !conflicts.includes(item.id));
    // 安全网：修复历史提案中可能残留的 ref:tempId_* 引用（问题 #13）
    repairUnresolvableTempRefs(applicable, refs, entityNameToIdMap);
    const catalog = catalogWithResolvedProposalItems(await projectReferenceCatalog(proposal.projectId), applicable, refs);
    const preparedPayloads = new Map<string, Record<string, unknown>>();
    for (const item of applicable) {
      if (item.operation === "delete") continue;
      const rawResolved = sanitizePayload(resolveReferences(item.after ?? item.payload, refs) as Record<string, unknown>);
      const resolved = item.targetTable === "outlineNodes" ? sanitizeModelPayload("outlineNodes", rawResolved) : rawResolved;
      const acceptedFields = item.operation === "update" ? options?.selectedFields?.[item.id] : undefined;
      const filtered = acceptedFields ? Object.fromEntries(Object.entries(resolved).filter(([key]) => acceptedFields.includes(key))) : resolved;
      const validate = item.operation === "create" ? CREATE_PAYLOAD_VALIDATORS[item.targetTable] : PAYLOAD_VALIDATORS[item.targetTable];
      if (!validate(filtered)) throw new Error(`“${item.label}”字段无效：${validate.errors?.map((error) => `${error.instancePath || "root"} ${error.message}`).join("；")}`);
      const payload = item.targetTable === "documents" ? normalizeDocumentPayload(filtered) : item.targetTable === "architectures" ? normalizeArchitecturePayload(filtered) : filtered;
      if (item.targetTable === "outlineNodes" && typeof payload.phaseId === "string") {
        const architecture = await novelDb.architectures.where("projectId").equals(proposal.projectId).first();
        if (!architecture?.phases.some((phase) => phase.id === payload.phaseId)) throw new Error(`“${item.label}”引用了不存在的幕`);
      }
      if (item.targetTable === "documents" && typeof payload.plotSegmentId === "string") {
        const existingSegment = await novelDb.outlineNodes.get(payload.plotSegmentId);
        const selectedSegment = applicable.some((candidate) => candidate.targetTable === "outlineNodes" && candidate.operation === "create" && candidate.tempId && refs.get(candidate.tempId) === payload.plotSegmentId);
        if (!existingSegment && !selectedSegment) throw new Error(`“${item.label}”引用了不存在的剧情段`);
      }
      assertResolvedPayloadReferences(item, payload, catalog);
      preparedPayloads.set(item.id, payload);
    }
    for (const item of applicable) {
      if (item.operation === "delete") {
        await applyDeleteCandidate({ proposalId, projectId: proposal.projectId, item, collaborativeDeletes });
        continue;
      }
      const table = novelDb.table(item.targetTable) as Table<Record<string, unknown>, string>;
      const payload = preparedPayloads.get(item.id)!;
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
    const selectedIds = new Set(selected.map((item) => item.id));
    const nextItems = proposal.items.map((item) => conflicts.includes(item.id)
      ? { ...item, status: "conflict" as const }
      : selectedIds.has(item.id)
        ? { ...item, targetId: item.targetId ?? (item.tempId ? refs.get(item.tempId) : undefined), status: "accepted" as const, acceptedFields: item.operation === "update" ? options?.selectedFields?.[item.id] : undefined }
        : item.status === "pending" ? { ...item, status: "rejected" as const } : item);
    const accepted = nextItems.filter((item) => item.status === "accepted").length;
    const status = conflicts.length ? "pending" : accepted === nextItems.length ? "accepted" : accepted > 0 ? "partially_accepted" : "rejected";
    await novelDb.proposals.put({ ...proposal, items: nextItems, status, revision: proposal.revision + 1, updatedAt: Date.now() });
    appliedCount = applicable.length;
    conflictCount = conflicts.length;
  });
  if (appendPlotSegment) await normalizeChapterOrderByPlanning(initialProposal.projectId);
  if (collaborativeDeletes.length) {
    const { deleteCollaborativeDocument } = await import("./collaboration");
    const cleanup = await Promise.allSettled(collaborativeDeletes.map((item) => deleteCollaborativeDocument(item.projectId, item.documentId)));
    const failed = cleanup.filter((result) => result.status === "rejected").length;
    if (failed) throw new Error(`结构化数据已写入，但有 ${failed} 个协作文档缓存清理失败`);
  }
  const { upsertEmbedding } = await import("./retrieval");
  const embeddingResults = await Promise.allSettled(embeddings.map(({ table, id, record }) => {
    const content = embeddingText(table, record);
    return content ? upsertEmbedding({ projectId: initialProposal.projectId, targetTable: table as "entities", targetId: id, content }) : Promise.resolve();
  }));
  return { applied: appliedCount, conflicts: conflictCount, embeddingFailures: embeddingResults.filter((result) => result.status === "rejected").length };
}
