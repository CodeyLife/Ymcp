/**
 * V2 结构化输出 JSON Schema 集中模块。
 *
 * 这些 schema 与 v1 [workflow-shared.ts] 的 reviewerSchema/factSchema/auditIssueSchema
 * 等价，但归 v2 独立维护——避免 v2 依赖 v1 的 workflow-shared（v1 模块混杂了大量
 * IndexedDB/WorkflowRun 依赖）。
 *
 * 所有 schema 都遵循 OpenAI strict-mode 要求：
 * - `additionalProperties: false`
 * - 所有字段都在 `required` 中（strict-mode 不支持 optional fields）
 */

/**
 * 审核 issue 维度枚举。
 *
 * 前 8 维度是"单章可读性"维度（v1 继承）；后 6 维度是长篇质量辅助维度，
 * 其中 worldbuilding/ensemble/romance/humor 对应 quality-standard.md 的 D1/D3/D4/D5，
 * subtext/narrativePacing 用于主题显隐与长篇节奏。
 *
 * 设计依据：AGENTS.md「Fix the problem at the lowest shared layer」+ pipeline-audit.md F9
 * ——REVIEW_DIMENSIONS 是全流程审核的共享契约层，原 8 维度完全不覆盖世界观/群像/感情线/幽默，
 * 导致 5 reviewer 即使审核认真也无法度量这些维度 → verdict=passed → 缺陷带病通过 commit gate。
 * 新增 4 维度让审核层能度量文学质量，驱动迭代。
 *
 * 维度与 quality-standard.md 映射：
 * - worldbuilding → D1 世界观（W1 规则可内化/W2 主题承载/W4 独立质地）
 * - ensemble → D3 群像（E1 配角独立欲望/E3 弧光/E4 关系网络/E5 日常质地）
 * - romance → D4 感情线（R1 行动承载/R2 阶段性/R4 女主独立/R5 复杂度）
 * - humor → D5 幽默（H1 贴合人物/H2 时代契合/H3 调节功能/H4 人物一致性）
 */
export const REVIEW_DIMENSIONS = [
  "plot",
  "characterVoice",
  "sceneEmbodiment",
  "dialogue",
  "specificity",
  "hookPayoff",
  "continuity",
  "readerRetention",
  // 长篇文学质量维度（对照 quality-standard.md D1/D3/D4/D5）
  "worldbuilding",
  "ensemble",
  "romance",
  "humor",
  "subtext",
  "narrativePacing",
] as const;

export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

/**
 * 章节 reviewer schema：与 v1 [workflow-shared.ts] reviewerSchema 等价。
 *
 * 用于 review activity，要求 LLM 返回 scores（每维度 0-5）+ issues 列表。
 */
export const reviewerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "scores", "issues"],
  properties: {
    verdict: { enum: ["passed", "revise", "blocked"] },
    scores: {
      type: "object",
      additionalProperties: false,
      required: REVIEW_DIMENSIONS,
      properties: Object.fromEntries(
        REVIEW_DIMENSIONS.map((dim) => [dim, { type: "number", minimum: 0, maximum: 5 }]),
      ),
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["dimension", "severity", "title", "description", "excerpt", "revisionRanges", "rule", "suggestion", "rewriteExample"],
        properties: {
          dimension: { enum: REVIEW_DIMENSIONS },
          severity: { enum: ["blocker", "major", "warning"] },
          title: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          excerpt: { type: "string" },
          paragraph: { type: "integer", minimum: 1 },
          revisionRanges: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["start", "end"],
              properties: {
                start: { type: "integer", minimum: 1 },
                end: { type: "integer", minimum: 1 },
              },
            },
          },
          rule: { type: "string", minLength: 1 },
          sourceId: { type: "string" },
          suggestion: { type: "string", minLength: 1 },
          rewriteExample: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

export function reviewerSchemaForDimensions(dimensions: readonly ReviewDimension[]): Record<string, unknown> {
  const allowed = [...new Set(dimensions)];
  return {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "scores", "issues"],
    properties: {
      verdict: { enum: ["passed", "revise", "blocked"] },
      scores: {
        type: "object",
        additionalProperties: false,
        required: allowed,
        properties: Object.fromEntries(allowed.map((dimension) => [dimension, { type: "number", minimum: 0, maximum: 5 }])),
      },
      issues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["dimension", "severity", "title", "description", "excerpt", "revisionRanges", "rule", "suggestion", "rewriteExample"],
          properties: {
            dimension: { enum: allowed },
            severity: { enum: ["blocker", "major", "warning"] },
            title: { type: "string", minLength: 1 },
            description: { type: "string", minLength: 1 },
            excerpt: { type: "string" },
            paragraph: { type: "integer", minimum: 1 },
            revisionRanges: { type: "array", items: { type: "object", additionalProperties: false, required: ["start", "end"], properties: { start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 } } } },
            rule: { type: "string", minLength: 1 },
            sourceId: { type: "string" },
            suggestion: { type: "string", minLength: 1 },
            rewriteExample: { type: "string", minLength: 1 },
          },
        },
      },
    },
  };
}

/**
 * V2 reviewer 输出类型（由 reviewerSchema 推断）。
 */
export interface ReviewerOutput {
  verdict: "passed" | "revise" | "blocked";
  scores: Partial<Record<ReviewDimension, number>>;
  issues: Array<{
    dimension: ReviewDimension;
    severity: "blocker" | "major" | "warning";
    title: string;
    description: string;
    excerpt?: string;
    paragraph?: number;
    revisionRanges: Array<{ start: number; end: number }>;
    rule: string;
    sourceId?: string;
    suggestion: string;
    rewriteExample: string;
  }>;
}

/**
 * 事实提取 schema：与 v1 [workflow-shared.ts] factSchema 等价。
 *
 * 用于 extractFacts activity，要求 LLM 从章节正文中提取结构化事实。
 */
export const factExtractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "facts"],
  properties: {
    summary: { type: "string", minLength: 1 },
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "subject",
          "predicate",
          "object",
          "polarity",
          "truthStatus",
          "humanReadable",
          "evidence",
          "confidence",
          "novelty",
          "conflict",
        ],
        properties: {
          subject: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "id"],
            properties: {
              kind: { enum: ["project", "entity", "relation", "outline", "scene", "thread", "foreshadowing", "timeline"] },
              id: { type: "string", minLength: 1 },
            },
          },
          predicate: { type: "string", minLength: 1 },
          object: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "value"],
            properties: {
              kind: { enum: ["entity-ref", "string", "number", "boolean", "json"] },
              value: {},
            },
          },
          polarity: { enum: ["affirmed", "negated"] },
          truthStatus: { enum: ["objective", "claim", "contested", "open-question"] },
          humanReadable: { type: "string", minLength: 1 },
          evidence: { type: "string", minLength: 1 },
          paragraph: { type: "integer", minimum: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          novelty: { enum: ["new", "update", "duplicate"] },
          conflict: { type: "boolean" },
        },
      },
    },
    /**
     * Phase 3.1 叙事元素：伏笔 / 承诺 / 兑现。
     *
     * 设计依据：Phase 3.1 计划——激活 foreshadowing/promises/payoffs 表。
     * 与 facts 互补：facts 是细粒度事实陈述，narrativeElements 是章节级叙事装置。
     *
     * 三类元素的语义：
     * - foreshadowing：本章埋设的伏笔（暗示未来事件，未兑现）
     * - promise：本章作出的承诺（谁对谁承诺什么，未兑现）
     * - payoff：本章兑现的伏笔/承诺（关联到对应的 foreshadowing/promise）
     */
    narrativeElements: {
      type: "object",
      additionalProperties: false,
      properties: {
        foreshadowings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["description", "triggerKeywords", "expectedPayoffWindow"],
            properties: {
              description: { type: "string", minLength: 1, description: "伏笔内容描述" },
              triggerKeywords: {
                type: "array",
                items: { type: "string", minLength: 1 },
                description: "触发关键词（后续章节兑现时应出现的关键词）",
              },
              expectedPayoffWindow: { type: "string", minLength: 1, description: "预期兑现窗口（如 5 章内、本卷末、长篇后期）" },
              evidence: { type: "string", minLength: 1, description: "正文逐字证据" },
            },
          },
        },
        promises: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["promiser", "promisee", "statement"],
            properties: {
              promiser: { type: "string", minLength: 1, description: "承诺者（角色名）" },
              promisee: { type: "string", minLength: 1, description: "被承诺者（角色名或‘自己’）" },
              statement: { type: "string", minLength: 1, description: "承诺内容" },
              evidence: { type: "string", minLength: 1, description: "正文逐字证据" },
            },
          },
        },
        payoffs: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["description", "payoffType"],
            properties: {
              description: { type: "string", minLength: 1, description: "兑现内容描述" },
              payoffType: { enum: ["foreshadowing", "promise"], description: "兑现类型：伏笔兑现或承诺兑现" },
              matchedTriggerKeywords: {
                type: "array",
                items: { type: "string", minLength: 1 },
                description: "匹配到的伏笔触发关键词（用于关联到对应 foreshadowing）",
              },
              matchedPromiser: { type: "string", description: "匹配到的承诺者（用于关联到对应 promise）" },
              intensity: { type: "integer", minimum: 1, maximum: 5, description: "兑现强度（1=轻描淡写，5=高潮爆发）" },
              evidence: { type: "string", minLength: 1, description: "正文逐字证据" },
            },
          },
        },
      },
    },
    /**
     * Phase 3.2 爽点曲线：本章的爽点时刻。
     *
     * 设计依据：Phase 3.2 计划 + 用户要求「爽感剧情还是要有」。
     * payoff_type 是通用爽感维度（非金手指/系统流特化），覆盖网文核心爽感类型：
     * - achievement：成就型（突破、获得、达成目标）
     * - recognition：认可型（被肯定、被敬畏、地位提升）
     * - reversal：反转型（逆境翻盘、真相揭露、打脸）
     * - emotional：情感型（羁绊深化、虐心释放、温情时刻）
     * - mystery：悬疑型（谜团揭开、伏笔兑现、真相浮现）
     *
     * 由 reader-reviewer 检查连续 N 章无爽点时报告 warning。
     */
    payoffMoments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["payoffType", "intensity", "description"],
        properties: {
          payoffType: {
            enum: ["achievement", "recognition", "reversal", "emotional", "mystery"],
            description: "爽点类型（通用爽感维度，非金手指特化）",
          },
          intensity: {
            type: "integer",
            minimum: 1,
            maximum: 5,
            description: "爽点强度（1=轻描淡写，3=明显推进，5=高潮爆发）",
          },
          description: { type: "string", minLength: 1, description: "爽点内容描述" },
          setupDescription: { type: "string", description: "铺垫描述（若有铺垫，简述哪一章哪些事件铺垫了这个爽点）" },
          evidence: { type: "string", minLength: 1, description: "正文逐字证据" },
        },
      },
    },
  },
} as const;

/**
 * V2 事实提取输出类型。
 */
export interface FactExtractionOutput {
  summary: string;
  facts: Array<{
    subject: { kind: string; id: string };
    predicate: string;
    object: { kind: string; value: unknown };
    polarity: "affirmed" | "negated";
    truthStatus: "objective" | "claim" | "contested" | "open-question";
    humanReadable: string;
    evidence: string;
    paragraph?: number;
    confidence: number;
    novelty: "new" | "update" | "duplicate";
    conflict: boolean;
  }>;
  /**
   * Phase 3.1 叙事元素（伏笔/承诺/兑现）。
   *
   * 可选字段——LLM 可能不返回（旧 schema 兼容），但建议返回。
   * 由 postgres-repository.recordNarrativeElements 写入对应表。
   */
  narrativeElements?: {
    foreshadowings: Array<{
      description: string;
      triggerKeywords: string[];
      expectedPayoffWindow: string;
      evidence: string;
    }>;
    promises: Array<{
      promiser: string;
      promisee: string;
      statement: string;
      evidence: string;
    }>;
    payoffs: Array<{
      description: string;
      payoffType: "foreshadowing" | "promise";
      matchedTriggerKeywords?: string[];
      matchedPromiser?: string;
      intensity?: number;
      evidence: string;
    }>;
  };
  /**
   * Phase 3.2 爽点时刻（本章的爽点列表）。
   *
   * 可选字段——LLM 可能不返回（旧 schema 兼容）。
   * 由 postgres-repository.recordPayoffCurve 写入 payoff_curve 表。
   * payoff_type 是通用爽感维度（非金手指/系统流特化）。
   */
  payoffMoments?: Array<{
    payoffType: "achievement" | "recognition" | "reversal" | "emotional" | "mystery";
    intensity: number;
    description: string;
    setupDescription?: string;
    evidence: string;
  }>;
}

/**
 * P1-F4 删除（2026-07-27）：learningAssessmentSchema 是死代码。
 *
 * 原因：实际使用的是 learning-assessment.ts 中的 runtimeLearningAssessmentSchema，
 * 该 schema 更完整（包含 anyOf 强制 mechanism 字段必填、applicableGenres 字段等）。
 * 保留 schemas.ts 中的旧 schema 会让维护者误以为它是有效的，违反 AGENTS.md
 * 「reusable contracts」原则——同一契约不应有两套定义。
 *
 * 历史信息：原 schema 是 assessLearning activity 的早期定义，后被
 * runtimeLearningAssessmentSchema（含 P0-B3 修复）取代但未清理。
 * 若需查找历史 schema，参考 git log 此 commit 之前的版本。
 */

/**
 * 章节记忆提取 schema：用于 chapter memory 创建。
 *
 * 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约。
 * 与 factExtractionSchema 互补：fact 提取细粒度事实，chapter memory 提取章节级高层摘要。
 *
 * LLM 输出 summary/keyEvents/characterStates/unresolvedThreads/emotionalArc 五类结构化字段，
 * 用于长篇跨章节一致性（前 N 章 summary 召回 + 角色状态快照 + 未解决线索追踪）。
 */
export const chapterMemorySchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "keyEvents", "characterStates", "unresolvedThreads", "emotionalArc"],
  properties: {
    summary: { type: "string", minLength: 80, maxLength: 800 },
    keyEvents: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
      maxItems: 20,
    },
    characterStates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["characterId", "stateSnapshot"],
        properties: {
          characterId: { type: "string", minLength: 1 },
          stateSnapshot: { type: "string", minLength: 1 },
        },
      },
    },
    unresolvedThreads: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    emotionalArc: { type: "string", minLength: 1 },
  },
} as const;

/**
 * V2 章节记忆提取输出类型。
 */
export interface ChapterMemoryOutput {
  summary: string;
  keyEvents: string[];
  characterStates: Array<{ characterId: string; stateSnapshot: string }>;
  unresolvedThreads: string[];
  emotionalArc: string;
}

/**
 * 角色富化（character enrichment）提取 schema：用于 characterEnrichmentStageHandler。
 *
 * 设计依据：AGENTS.md「commitStageHandler → characterEnrichmentStageHandler」契约。
 * 从定稿章节正文中提取角色声部锚点、动机变化、关系变化、知识边界变化，
 * 回写到 entities.payload / relations / memory_claims（knowledgeScope={characterId}），
 * 让 character-reviewer 审校结果能反哺角色档案，避免「只审不能改」的断裂。
 *
 * 设计原则（AGENTS.md「reusable contracts over case-specific examples」）：
 * - prompt 只描述通用提取规则，不嵌入任何题材/类型/角色名 fixture
 * - 不内置网文套路识别（走 craft rule 沉淀）
 */
export const characterEnrichmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["characters"],
  properties: {
    characters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["characterId", "voiceAnchor", "motivationDelta", "newKnowledge", "relationDeltas"],
        properties: {
          characterId: { type: "string", minLength: 1 },
          voiceAnchor: {
            type: "object",
            additionalProperties: false,
            required: ["sentenceLength", "vocabulary", "directness", "avoidance"],
            properties: {
              sentenceLength: { type: "string", minLength: 1 },
              vocabulary: { type: "string", minLength: 1 },
              directness: { type: "string", minLength: 1 },
              avoidance: { type: "string", minLength: 1 },
            },
          },
          motivationDelta: { type: "string", minLength: 1 },
          newKnowledge: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["description", "evidence"],
              properties: {
                description: { type: "string", minLength: 1 },
                evidence: { type: "string", minLength: 1 },
              },
            },
          },
          relationDeltas: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["targetCharacterId", "predicate", "delta"],
              properties: {
                targetCharacterId: { type: "string", minLength: 1 },
                predicate: { type: "string", minLength: 1 },
                delta: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * V2 角色富化提取输出类型。
 */
export interface CharacterEnrichmentOutput {
  characters: Array<{
    characterId: string;
    voiceAnchor: {
      sentenceLength: string;
      vocabulary: string;
      directness: string;
      avoidance: string;
    };
    motivationDelta: string;
    newKnowledge: Array<{ description: string; evidence: string }>;
    relationDeltas: Array<{ targetCharacterId: string; predicate: string; delta: string }>;
  }>;
}

/**
 * A single extraction result consumed by facts, commit, chapter-memory and
 * character-enrichment handlers. Optional derived fields preserve the
 * per-handler fallback path for older runs and incomplete model output.
 */
export interface ChapterStateDelta extends FactExtractionOutput {
  chapterMemory?: ChapterMemoryOutput;
  characterDeltas?: CharacterEnrichmentOutput["characters"];
}

export const chapterStateDeltaSchema = {
  ...factExtractionSchema,
  properties: {
    ...factExtractionSchema.properties,
    chapterMemory: chapterMemorySchema,
    characterDeltas: characterEnrichmentSchema.properties.characters,
  },
} as const;

/**
 * 章节反思维度枚举：14 维度，与 reviewerSchema 的 REVIEW_DIMENSIONS 区分。
 *
 * reflection 关注「读者体验层面的直觉批评」，维度是读者感受维度（节奏/情感/悬念/...），
 * 而非 reviewer 的技术维度（plot/characterVoice/...）。两者互补：reflection 做前置自检，
 * reviewer 做正式审核。
 */
export const REFLECTION_DIMENSIONS = [
  "pace",
  "emotion",
  "suspense",
  "dialogue",
  "density",
  "trope",
  "language",
  "blueprint",
  "subtext",
  "narrativePacing",
  "worldbuilding",
  "ensemble",
  "romance",
  "humor",
] as const;

export type ReflectionDimension = (typeof REFLECTION_DIMENSIONS)[number];

/**
 * V2 章节反思（reflection）schema。
 *
 * 设计依据：AGENTS.md「root-cause analysis」契约 + Phase 2.4 reflection 机制 +
 * 「Fix the problem at the lowest shared layer」——reflection issue schema 此前与
 * reviewerSchema 不一致（缺 dimension/rule/revisionRanges/rewriteExample），导致
 * reflection→revision 复用链用 suggestion 顶替 rewriteExample、rule 固定
 * "reflection-critique"，revise 阶段"按 issue.rule 命中 skill"机制失效。
 * 现对齐 reviewerSchema 字段集，但保留 reflection 特有的 14 维度枚举。
 *
 * 与 reviewerSchema 的区别：
 * - reviewerSchema 用于正式 5 reviewer 审核（产生 commit 证据），dimension 用 REVIEW_DIMENSIONS
 * - reflectionSchema 用于 draft 后的前置自我反思（不产生 commit 证据，只优化 draft），dimension 用 REFLECTION_DIMENSIONS
 * - reflection 的 rewriteExample 是必填（minLength=1），与 reviewerSchema 一致
 */
export const reflectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["critique"],
  properties: {
    critique: {
      type: "object",
      additionalProperties: false,
      required: ["overallImpression", "issues"],
      properties: {
        overallImpression: {
          type: "string",
          minLength: 1,
          description: "对草稿的整体印象（1-2 句话）",
        },
        issues: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["dimension", "severity", "title", "description", "revisionRanges", "rule", "suggestion", "rewriteExample"],
            properties: {
              dimension: { enum: REFLECTION_DIMENSIONS },
              severity: { enum: ["blocker", "major", "warning"] },
              title: { type: "string", minLength: 1 },
              description: { type: "string", minLength: 1 },
              excerpt: { type: "string", description: "草稿中对应的原文片段（可选）" },
              paragraph: { type: "integer", minimum: 1 },
              revisionRanges: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["start", "end"],
                  properties: {
                    start: { type: "integer", minimum: 1 },
                    end: { type: "integer", minimum: 1 },
                  },
                },
              },
              rule: { type: "string", minLength: 1, description: "问题对应的规则短标识（如 reflection.pace-drag）" },
              suggestion: { type: "string", minLength: 1, description: "改写建议（具体到段落或句子）" },
              rewriteExample: { type: "string", minLength: 1, description: "具体改写示例，格式：【原文】...【改写】..." },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * V2 章节反思输出类型。
 */
export interface ReflectionOutput {
  critique: {
    overallImpression: string;
    issues: Array<{
      dimension: ReflectionDimension;
      severity: "blocker" | "major" | "warning";
      title: string;
      description: string;
      excerpt?: string;
      paragraph?: number;
      revisionRanges: Array<{ start: number; end: number }>;
      rule: string;
      suggestion: string;
      rewriteExample: string;
    }>;
  };
}

/**
 * V2 架构生成（foundation）schema。
 *
 * 设计依据：AGENTS.md「reusable contracts over case-specific examples」+ 架构阶段原则。
 * 用于 generateFoundationWork activity，按 taskKey 生成全书架构产出的不同维度。
 *
 * 通用性原则：
 * - schema 不内置任何题材/类型/角色名 fixture（不识别"程序员穿越"等特定主题）
 * - structuredData 是开放对象，容纳各 taskKey 的差异化结构化数据（人物档案/关系图/时间线等）
 * - sections 提供可读的分节内容，summary 提供摘要，title 提供标题
 * - 各 taskKey 的具体内容由 prompt 指导，schema 只保证结构合法
 *
 * additionalProperties 决策（LLM 生成 schema 原则）：
 * - 顶层与 section/section-item 层均使用 additionalProperties: true
 * - 原因：LLM 在生成复杂结构化产出时，常会附加 metadata/notes/index 等辅助字段。
 *   additionalProperties: false 会把这些视为非法，导致 schema-validation 失败 →
 *   修复循环 3 次仍失败 → 回退到 external-mcp 候选（若无 worker 则永久卡住）。
 * - 允许额外字段不影响核心契约：required 字段（title/summary/sections/structuredData
 *   及 section 的 heading/content、item 的 label/detail）仍被强制校验，类型仍被校验。
 * - 不覆盖：LLM 缺失 required 字段或返回错误类型时仍会失败——这类是内容质量问题，
 *   应由 repair 循环或 prompt 改进解决，不应通过放宽 schema 掩盖。
 *
 * 与 chapterMemorySchema 的区别：
 * - chapterMemory 是章节级高层摘要（单章产出）
 * - foundation 是全书架构产出（project 级，按 taskKey 切分维度）
 */
export const foundationSchema = {
  type: "object",
  additionalProperties: true,
  required: ["title", "summary", "sections", "structuredData"],
  properties: {
    title: { type: "string", minLength: 1, description: "本次架构产出标题（如「主要人物档案」「世界观设定」）" },
    summary: { type: "string", minLength: 50, description: "本次架构产出摘要（200-800字，概括核心决策与设计意图）" },
    sections: {
      type: "array",
      description: "架构产出的分节内容（人类可读）",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["heading", "content"],
        properties: {
          heading: { type: "string", minLength: 1 },
          content: { type: "string", minLength: 1 },
          items: {
            type: "array",
            description: "分节下的结构化条目（如人物列表、势力列表、章节列表等）",
            items: {
              type: "object",
              additionalProperties: true,
              required: ["label", "detail"],
              properties: {
                label: { type: "string", minLength: 1 },
                detail: { type: "string", minLength: 1 },
                attributes: {
                  type: "object",
                  description: "可选的结构化属性（键值对，如 {alias, age, faction, role}）",
                  additionalProperties: true,
                },
              },
            },
          },
        },
      },
    },
    structuredData: {
      type: "object",
      description: "可机读的结构化数据，格式因 taskKey 而异（如 characters=人物数组, relations=关系数组, timeline=事件数组）",
      additionalProperties: true,
    },
  },
} as const;

/**
 * V2 架构生成输出类型。
 */
export interface FoundationOutput {
  title: string;
  summary: string;
  sections: Array<{
    heading: string;
    content: string;
    items?: Array<{
      label: string;
      detail: string;
      attributes?: Record<string, unknown>;
    }>;
  }>;
  structuredData: Record<string, unknown>;
}
