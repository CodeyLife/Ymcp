import { foundationSchema, type FoundationOutput } from "../prompts/schemas";

export const FOUNDATION_TASK_CONTRACTS: Record<string, {
  dataRoot: string;
  requiredPaths: string[];
  qualityFocus: string[];
}> = {
  "project-positioning": {
    dataRoot: "positioning",
    requiredPaths: [
      "positioning.bookTitle",
      "positioning.sellingPoints",
      "positioning.targetReader",
      "positioning.coreConflict",
      "positioning.activePressureSource",
      "positioning.corePromise",
      "positioning.protagonistNeed",
      "positioning.centralOpposition",
      "positioning.emotionalContract",
      "positioning.themeQuestion",
    ],
    qualityFocus: ["读者承诺与目标读者", "主角核心矛盾与中央对抗", "情感契约", "主题问题或明确待确认边界"],
  },
  architecture: {
    dataRoot: "architecture",
    requiredPaths: ["architecture.structure", "architecture.volumes", "architecture.povStrategy", "architecture.timeSpan"],
    qualityFocus: ["长程层级", "卷级职责", "视角一致性", "节奏与信息释放边界"],
  },
  characters: {
    dataRoot: "characters",
    requiredPaths: ["characters"],
    qualityFocus: ["人物独立欲望", "变化弧", "声部锚点", "人物之间的直接关系"],
  },
  worldview: {
    dataRoot: "worldview",
    requiredPaths: ["worldview.geography", "worldview.politics", "worldview.factions", "worldview.rules"],
    qualityFocus: ["规则与代价", "社会纹理", "世界独立运行", "不可违背事实"],
  },
  relations: {
    dataRoot: "relations",
    requiredPaths: ["relations"],
    qualityFocus: ["方向性关系", "关系变化条件", "人物不经过主角的直接关系", "选择后果"],
  },
  "plot-threads": {
    dataRoot: "plotThreads",
    requiredPaths: ["plotThreads.main", "plotThreads.subplots"],
    qualityFocus: ["主线因果", "支线独立价值", "人物与剧情线交叉", "情感线适用性"],
  },
  foreshadowing: {
    dataRoot: "foreshadowings",
    requiredPaths: ["foreshadowings"],
    qualityFocus: ["埋设与触发", "回收窗口", "回收后的意义变化", "不提前消费"],
  },
  timeline: {
    dataRoot: "timeline",
    requiredPaths: ["timeline.storyEvents"],
    qualityFocus: ["故事时间与叙事顺序", "硬约束", "事件因果", "时间密度变化"],
  },
  "story-control": {
    dataRoot: "storyControl",
    requiredPaths: ["storyControl.paceCurve", "storyControl.payoffDistribution"],
    qualityFocus: ["信息释放", "高潮与缓冲", "读者回报类型", "避免固定节拍"],
  },
  "plot-design": {
    dataRoot: "plotStrategy",
    requiredPaths: [
      "plotStrategy.narrativePromises",
      "plotStrategy.characterDestinations",
      "plotStrategy.endingEnvelope",
      "plotStrategy.nonNegotiables",
    ],
    qualityFocus: ["长期承诺", "人物终点区间", "终局边界", "适应性修订触发器"],
  },
};

type JsonSchema = Record<string, unknown>;

const stringSchema: JsonSchema = { type: "string", minLength: 1 };
const stringOrObjectSchema: JsonSchema = { anyOf: [{ type: "string", minLength: 1 }, { type: "object" }] };
const nonEmptyArraySchema = (items: JsonSchema = { type: "object" }): JsonSchema => ({ type: "array", minItems: 1, items });
const objectSchema = (required: string[], properties: Record<string, JsonSchema> = {}): JsonSchema => ({
  type: "object",
  additionalProperties: true,
  required,
  properties,
});

const foundationDataSchemas: Record<string, JsonSchema> = {
  "project-positioning": objectSchema(
    ["bookTitle", "sellingPoints", "targetReader", "coreConflict", "activePressureSource", "corePromise", "protagonistNeed", "centralOpposition", "emotionalContract", "themeQuestion"],
    {
      bookTitle: stringSchema,
      sellingPoints: nonEmptyArraySchema({ type: "string", minLength: 1 }),
      targetReader: stringOrObjectSchema,
      coreConflict: stringSchema,
      activePressureSource: stringSchema,
      corePromise: stringOrObjectSchema,
      protagonistNeed: stringSchema,
      centralOpposition: stringSchema,
      emotionalContract: stringOrObjectSchema,
      themeQuestion: stringOrObjectSchema,
    },
  ),
  architecture: objectSchema(["structure", "volumes", "povStrategy", "timeSpan"], {
    structure: stringSchema,
    volumes: nonEmptyArraySchema(),
    povStrategy: stringSchema,
    timeSpan: stringSchema,
  }),
  characters: nonEmptyArraySchema(objectSchema(["id", "name", "role", "motivation", "fear", "voiceAnchor", "arc", "independentAction"], {
    id: stringSchema,
    name: stringSchema,
    role: stringSchema,
    motivation: stringSchema,
    fear: stringSchema,
    voiceAnchor: { type: "object" },
    arc: { type: "object" },
    independentAction: { type: "object" },
  })),
  worldview: objectSchema(["geography", "politics", "factions", "rules"], {
    geography: { type: "object" },
    politics: { type: "object" },
    factions: nonEmptyArraySchema(),
    rules: nonEmptyArraySchema(objectSchema(["statement", "cost", "boundary"], {
      statement: stringSchema,
      cost: stringSchema,
      boundary: stringSchema,
    })),
  }),
  relations: nonEmptyArraySchema(objectSchema(["from", "to", "type", "strength", "evolution", "choiceConsequence"], {
    from: stringSchema,
    to: stringSchema,
    type: stringSchema,
    evolution: { type: "object" },
    choiceConsequence: stringSchema,
  })),
  plotThreads: objectSchema(["main", "subplots"], { main: { type: "object" }, subplots: nonEmptyArraySchema() }),
  foreshadowings: nonEmptyArraySchema(objectSchema(["id", "description", "expectedPayoffWindow"], { id: stringSchema, description: stringSchema, expectedPayoffWindow: stringSchema })),
  timeline: objectSchema(["storyEvents"], { storyEvents: nonEmptyArraySchema() }),
  storyControl: objectSchema(["paceCurve", "payoffDistribution"], { paceCurve: nonEmptyArraySchema(), payoffDistribution: nonEmptyArraySchema() }),
  plotStrategy: objectSchema(["narrativePromises", "characterDestinations", "endingEnvelope", "nonNegotiables"], {
    narrativePromises: nonEmptyArraySchema({ type: "string", minLength: 1 }),
    characterDestinations: nonEmptyArraySchema(),
    endingEnvelope: { type: "object" },
    nonNegotiables: nonEmptyArraySchema({ type: "string", minLength: 1 }),
  }),
};

/**
 * Add task-specific shape constraints to the shared Foundation envelope.
 * The semantic validator remains authoritative for cross-field rules; this
 * schema makes the model repair loop see the expected data root early.
 */
export function foundationSchemaForTask(taskKey: string): JsonSchema {
  const contract = FOUNDATION_TASK_CONTRACTS[taskKey];
  const taskDataSchema = foundationDataSchemas[taskKey];
  if (!contract || !taskDataSchema) return foundationSchema as unknown as JsonSchema;
  const structuredData = foundationSchema.properties?.structuredData as JsonSchema;
  return {
    ...foundationSchema,
    properties: {
      ...foundationSchema.properties,
      structuredData: {
        ...structuredData,
        required: [contract.dataRoot],
        properties: { ...(structuredData.properties as Record<string, unknown> | undefined), [contract.dataRoot]: taskDataSchema },
      },
    },
  };
}

function valueAt(root: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, root);
}

function meaningful(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

function validateNotApplicableAnnotation(value: unknown, path: string, errors: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (record.notApplicable !== true || !meaningful(record.rationale)) {
    errors.push(`${path} 的不适用标记必须包含 notApplicable=true 和 rationale`);
  }
}

function validateRepeatedEntries(taskKey: string, structuredData: Record<string, unknown>, errors: string[]): void {
  const collectionKey = taskKey === "characters" ? "characters"
    : taskKey === "relations" ? "relations"
      : taskKey === "foreshadowing" ? "foreshadowings"
        : undefined;
  if (!collectionKey) return;
  const collection = structuredData[collectionKey];
  if (!Array.isArray(collection) || collection.length === 0) return;
  const requiredByTask: Record<string, string[]> = {
    characters: ["id", "name", "role", "motivation", "fear", "voiceAnchor", "arc", "independentAction"],
    relations: ["from", "to", "type", "strength", "evolution", "choiceConsequence"],
    foreshadowing: ["id", "description", "expectedPayoffWindow"],
  };
  for (const [index, entry] of collection.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${collectionKey}[${index}] 必须是对象`);
      continue;
    }
    for (const key of requiredByTask[taskKey] ?? []) {
      if (!meaningful((entry as Record<string, unknown>)[key])) errors.push(`${collectionKey}[${index}].${key} 不能为空`);
    }
  }
}

function validateWorldviewRules(structuredData: Record<string, unknown>, errors: string[]): void {
  const worldview = structuredData.worldview;
  if (!worldview || typeof worldview !== "object" || Array.isArray(worldview)) return;
  const rules = (worldview as Record<string, unknown>).rules;
  if (!Array.isArray(rules)) return;
  for (const [index, rule] of rules.entries()) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      errors.push(`worldview.rules[${index}] 必须包含 statement、cost 和 boundary`);
      continue;
    }
    const record = rule as Record<string, unknown>;
    for (const key of ["statement", "cost", "boundary"]) {
      if (!meaningful(record[key])) errors.push(`worldview.rules[${index}].${key} 不能为空`);
    }
  }
}

/** Validate semantic fields that generic foundationSchema cannot express. */
export function validateFoundationTaskContract(value: FoundationOutput, taskKey: string): string[] {
  const contract = FOUNDATION_TASK_CONTRACTS[taskKey];
  if (!contract) return [];
  const errors: string[] = [];
  const structuredData = value.structuredData ?? {};
  for (const path of contract.requiredPaths) {
    if (!meaningful(valueAt(structuredData, path))) errors.push(`${path} 不能为空`);
  }
  if (taskKey === "project-positioning") {
    validateNotApplicableAnnotation(valueAt(structuredData, "positioning.themeQuestion"), "positioning.themeQuestion", errors);
    validateNotApplicableAnnotation(valueAt(structuredData, "positioning.emotionalContract"), "positioning.emotionalContract", errors);
  }
  validateRepeatedEntries(taskKey, structuredData, errors);
  if (taskKey === "worldview") validateWorldviewRules(structuredData, errors);
  return errors;
}

export function assertFoundationTaskContract(value: FoundationOutput, taskKey: string): void {
  const errors = validateFoundationTaskContract(value, taskKey);
  if (errors.length) throw new Error(`${taskKey} foundation 结构契约不完整：${errors.join("；")}`);
}
