import { CHAPTER_NARRATIVE_FUNCTIONS, PLAN_APPLICABILITY, STAKE_KNOWLEDGE_BASES, THEME_CARRIERS, THEME_TREATMENT_MODES, type StoryArcBundle, type StoryArcRebaseTarget } from "../application/story-arc";
import { ARC_PLAN_CHECK_DIMENSIONS, CHAPTER_PLAN_CHECK_DIMENSIONS, storyArcAuthorityPaths, type StoryArcReviewOutput } from "../application/story-arc-review-policy";
import { CHAPTER_NARRATIVE_SCALE_LEVELS } from "../application/chapter-narrative-scale";
import type { NarrativeStateSnapshot } from "../protocol";

export { validateStoryArcReview } from "../application/story-arc-review-policy";
export type { StoryArcReviewOutput } from "../application/story-arc-review-policy";

export const storyArcBundleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["arc", "batch", "chapters"],
  properties: {
    arc: {
      type: "object",
      additionalProperties: false,
      required: ["title", "objective", "entryState", "centralConflict", "development", "resolution", "exitState", "plotThreadRefs", "foreshadowingRefs", "expectedChapterCount", "phases", "thematicQuestions"],
      properties: {
        title: { type: "string", minLength: 1 }, objective: { type: "string", minLength: 1 }, entryState: { type: "string" }, centralConflict: { type: "string" },
        development: { type: "array", items: { type: "string" } }, resolution: { type: "string" }, exitState: { type: "string" },
        plotThreadRefs: { type: "array", items: { type: "string" } }, foreshadowingRefs: { type: "array", items: { type: "string" } },
        expectedChapterCount: { type: "integer", minimum: 1, maximum: 80 }, authorIntent: { type: "string" },
        phases: { type: "array", minItems: 2, items: { type: "object", additionalProperties: false, required: ["title", "objective", "exitCondition"], properties: { title: { type: "string", minLength: 1 }, objective: { type: "string", minLength: 1 }, exitCondition: { type: "string", minLength: 1 } } } },
        thematicQuestions: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "question", "opposingPressures", "resolutionWindow"], properties: { id: { type: "string", minLength: 1 }, question: { type: "string", minLength: 1 }, opposingPressures: { type: "string", minLength: 1 }, resolutionWindow: { type: "string", minLength: 1 } } } },
      },
    },
    batch: { type: "object", additionalProperties: false, required: ["batchIndex", "startChapterIndex", "complete"], properties: { batchIndex: { type: "integer", minimum: 1 }, startChapterIndex: { type: "integer", minimum: 1 }, complete: { type: "boolean" } } },
    chapters: {
      type: "array", minItems: 1, maxItems: 16, items: {
        type: "object", additionalProperties: false,
        required: ["index", "title", "summary", "chapterPurpose", "stateTransition", "narrativeFunction", "readerExperience", "thematicTreatment", "worldRuleRefs", "characterFocus", "romanceTreatment", "humorTreatment", "dramaticQuestion", "emotionalMovement", "stateDeltaBudget", "narrativeScale", "optionalBeats", "scenes", "continuityConstraints", "setupRefs", "payoffRefs", "unresolvedAtClose", "closingForce", "freedom"],
        properties: {
          index: { type: "integer", minimum: 1 }, title: { type: "string", minLength: 1 }, summary: { type: "string", minLength: 1 }, chapterPurpose: { type: "string" }, dramaticQuestion: { type: "string" }, povCharacterId: { type: "string" }, emotionalMovement: { type: "string" }, stateDeltaBudget: { type: "string" },
          narrativeScale: { type: "object", additionalProperties: false, required: ["level", "reason", "developmentAxes", "stoppingCondition"], properties: { level: { enum: CHAPTER_NARRATIVE_SCALE_LEVELS }, reason: { type: "string", minLength: 1 }, developmentAxes: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, stoppingCondition: { type: "string", minLength: 1 } } },
          stateTransition: { type: "object", additionalProperties: false, required: ["before", "after", "evidence"], properties: { before: { type: "string", minLength: 1 }, after: { type: "string", minLength: 1 }, evidence: { type: "string", minLength: 1 } } },
          narrativeFunction: { enum: CHAPTER_NARRATIVE_FUNCTIONS }, readerExperience: { type: "string", minLength: 1 },
          thematicTreatment: { type: "object", additionalProperties: false, required: ["mode", "questionRefs", "carrier", "evidenceChange", "expositionBoundary"], properties: { mode: { enum: THEME_TREATMENT_MODES }, questionRefs: { type: "array", items: { type: "string" } }, carrier: { enum: THEME_CARRIERS }, evidenceChange: { type: "string" }, expositionBoundary: { type: "string" } } },
          worldRuleRefs: { type: "array", items: { type: "string" } },
          characterFocus: { type: "array", items: { type: "object", additionalProperties: false, required: ["characterRef", "function", "desire", "action", "cost"], properties: { characterRef: { type: "string", minLength: 1 }, function: { type: "string", minLength: 1 }, desire: { type: "string", minLength: 1 }, action: { type: "string", minLength: 1 }, cost: { type: "string", minLength: 1 } } } },
          romanceTreatment: { type: "object", additionalProperties: false, required: ["status", "stage", "actionEvidence", "boundary"], properties: { status: { enum: PLAN_APPLICABILITY }, stage: { type: "string" }, actionEvidence: { type: "string" }, boundary: { type: "string", minLength: 1 } } },
          humorTreatment: { type: "object", additionalProperties: false, required: ["status", "opportunity", "evidence", "boundary"], properties: { status: { enum: PLAN_APPLICABILITY }, opportunity: { type: "string" }, evidence: { type: "string" }, boundary: { type: "string", minLength: 1 } } },
          optionalBeats: { type: "array", items: { type: "string" } }, continuityConstraints: { type: "array", items: { type: "string" } }, setupRefs: { type: "array", items: { type: "string" } }, payoffRefs: { type: "array", items: { type: "string" } }, unresolvedAtClose: { type: "array", items: { type: "string" } }, closingForce: { type: "string" }, freedom: { type: "string" },
          scenes: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "summary", "goal", "opposition", "participants", "participantStakes", "turn", "outcome", "cost"],
              properties: {
                title: { type: "string" },
                summary: { type: "string" },
                goal: { type: "string", minLength: 1 },
                opposition: { type: "string", minLength: 1 },
                participants: { type: "array", items: { type: "string" } },
                participantStakes: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["participant", "want", "leverage", "withholding", "failureCost", "knowledgeBasis"],
                    properties: {
                      participant: { type: "string", minLength: 1 },
                      want: { type: "string" },
                      leverage: { type: "string" },
                      withholding: { type: "string" },
                      failureCost: { type: "string" },
                      knowledgeBasis: {
                        type: "object",
                        additionalProperties: false,
                        required: ["want", "leverage", "withholding", "failureCost"],
                        properties: {
                          want: { enum: STAKE_KNOWLEDGE_BASES },
                          leverage: { enum: STAKE_KNOWLEDGE_BASES },
                          withholding: { enum: STAKE_KNOWLEDGE_BASES },
                          failureCost: { enum: STAKE_KNOWLEDGE_BASES },
                        },
                      },
                    },
                  },
                },
                turn: { type: "string", minLength: 1 },
                outcome: { type: "string", minLength: 1 },
                cost: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
  },
} as const;

export const storyArcReviewSchema = {
  type: "object", additionalProperties: false, required: ["verdict", "summary", "issues", "chapterChecks", "arcChecks", "authorityChecks"],
  properties: {
    verdict: { enum: ["passed", "revise", "blocked"] }, summary: { type: "string" },
    issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["severity", "title", "evidence", "suggestion"], properties: { severity: { enum: ["blocker", "major", "warning"] }, title: { type: "string" }, evidence: { type: "string" }, suggestion: { type: "string" } } } },
    chapterChecks: { type: "array", items: { type: "object", additionalProperties: false, required: ["chapterIndex", "dimension", "verdict", "evidence", "reason"], properties: { chapterIndex: { type: "integer", minimum: 1 }, dimension: { enum: CHAPTER_PLAN_CHECK_DIMENSIONS }, verdict: { enum: ["passed", "revise", "blocked"] }, evidence: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 } } } },
    arcChecks: { type: "array", items: { type: "object", additionalProperties: false, required: ["dimension", "verdict", "evidence", "reason"], properties: { dimension: { enum: ARC_PLAN_CHECK_DIMENSIONS }, verdict: { enum: ["passed", "revise", "blocked"] }, evidence: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 } } } },
    authorityChecks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["chapterIndex", "verdict", "unresolvedAtClose", "checkedPaths", "candidateClaims", "frozenEvidence", "certaintyUpgrades", "reason"],
        properties: {
          chapterIndex: { type: "integer", minimum: 1 },
          verdict: { enum: ["passed", "revise", "blocked"] },
          unresolvedAtClose: { type: "array", items: { type: "string" } },
          checkedPaths: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          candidateClaims: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          frozenEvidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          certaintyUpgrades: { type: "array", items: { type: "object", additionalProperties: false, required: ["candidateClaim", "frozenBoundary", "reason"], properties: { candidateClaim: { type: "string", minLength: 1 }, frozenBoundary: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 } } } },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

/**
 * 故事弧审核维度清单（5 维度 × 1-5 分锚点）。
 *
 * 设计依据：AGENTS.md「reusable contracts over case-specific rules」——原 review prompt 只用
 * 抽象指令（"检查局部因果是否闭合…"），LLM 无判定锚点。这里给出题材无关的通用维度锚点，
 * 让审核有可对照的判定标准，同时不识别特定题材/类型/角色（保持通用性）。
 */
const STORY_ARC_REVIEW_DIMENSIONS = [
  {
    name: "因果闭合",
    rule: "弧内每个章节的冲突都应有起因—发展—收束的完整链条；冲突不得无源而起、不得无故消失。",
    anchors: "5=所有冲突有清晰因果链；3=个别冲突起因或收束模糊；1=多处冲突无因果关联。",
  },
  {
    name: "状态连续",
    rule: "前章人物状态（位置、情绪、资源、关系、知识）被后续章节尊重；不得出现状态回退或矛盾。",
    anchors: "5=状态全程连续；3=个别状态未交代去向但不影响理解；1=明显状态矛盾。",
  },
  {
    name: "提前消费检测",
    rule: "后续大节点（高潮、反转、关系跃迁、伏笔回收）不在当前故事弧或当前批次提前触发；弧内只兑现该弧应有的进度。",
    anchors: "5=节奏克制；3=个别节点略早但不破坏后续；1=重大节点或卷级节点被提前消费。",
 },
 {
    name: "长篇层级与局部功能",
    rule: "全书命题、卷级矛盾、故事弧、批次和章节各有职责；局部蓝图只承担当前层级应承担的功能。章节可以是推进、停顿、余波、日常、气氛、误判、恢复或关系沉淀，但不得把卷级目标压缩成一批章节，也不得把作者侧分析词当作正文世界规则。",
    anchors: "5=层级边界清楚，局部功能合法且留有长篇余地；3=局部略拥挤或层级说明偏混，但未提前消耗关键节点；1=首批像卷级摘要，或连续章节把同一作者侧主题词当成正文任务。",
 },
  {
    name: "机械逐项检测",
    rule: "章节不是对大纲点的生硬罗列；章节可以安静、停顿或反复，但必须有符合当前位置的阅读功能、人物行动或情感空间，而非仅完成信息交代。",
    anchors: "5=各章功能成立且窗口节奏有呼吸；3=个别章节偏报表式但不破坏弧功能；1=整弧像事件流水账或任务清单。",
  },
  {
    name: "人物空间",
    rule: "主角在本弧有欲望—行动—情感的弧线；配角有承担功能而非工具人。",
    anchors: "5=主角弧线清晰且配角有质地；3=主角有行动但情感模糊；1=人物纯功能化。",
  },
  {
    name: "叙事驱动力",
    rule: "弧/批次窗口内需要有可辨识的外部压力或张力形态变化，但不要求每章新增或加剧压力。压力可以是追杀、时间限制、资源争夺、社会地位威胁、道德困境、关系危机、等待成本或恢复代价；铺陈/余波章可以低压，只要它服务长篇节奏。连续窗口完全无压力变化、无等待成本、无关系张力或无信息角度变化，才视为驱动力不足。",
    anchors: "5=弧内压力或张力形态随窗口自然变化；3=压力源存在但窗口变化偏弱；1=整弧无外部压力/等待成本/关系张力，或只来自主角自身 curiosity。",
  },
  {
    name: "母题入戏",
    rule: "核心设定、职业特质、金手指或主题隐喻必须进入具体事件、感官压力、人物选择和递进意象；不得让连续标题、场景名或行动描述退化为同一概念词库的表层标签。偶发点题可以成立，但删除母题词后仍应保留可读的场景事件和冲突。",
    anchors: "5=母题自然改变行动、代价或意象信息；3=局部命名偏概念化但场景仍有可读事件；1=连续章节像概念展示，标题/场景/转折依赖同一套标签而非叙事事件。",
  },
];

/**
 * 输出格式强约束尾注（对齐 foundation.ts 风格）。
 * 防止 LLM 输出 Markdown 代码块或解释性文字导致 schema 校验失败。
 */
const STORY_ARC_OUTPUT_FORMAT_GUARD =
  "只输出符合 schema 的 JSON，不使用 Markdown 代码块，不输出解释性文字，不输出 JSON 前后的任何字符。";

export function buildStoryArcPrompt(input: { projectTitle: string; authorIntent?: string; macro: Array<{ taskKey: string; title: string; summary: string }>; recentChapters: Array<{ order: number; summary: string; unresolvedThreads: string[]; emotionalArc?: string }>; openThreads: Array<{ id: string; title: string; payload: Record<string, unknown> }>; narrativeState?: NarrativeStateSnapshot }): string {
  return [
    "依据当前叙事状态账本和长程叙事战略，规划下一个顺序故事弧的边界，并只展开第一批连续章节蓝图。",
    "先建立长篇层级关系：全书层回答终局命题和长期承诺；卷/篇章层安排阶段性文明、势力、人物关系和情绪气候；故事弧层处理一个可阶段闭合的矛盾；批次层只展开当前进入窗口；章节层只承担一个合法阅读功能。不要让局部蓝图反向吞掉上层规划。",
    "卷/篇章分区不是故事弧：如果作者意图提到「卷一/卷二/卷三」或类似分卷目标，只把它当作长篇位置与主题背景，不要把完整一卷压缩成一个故事弧，也不要把故事弧标题伪装成卷标题。",
    "故事弧 expectedChapterCount 由当前叙事状态、长程战略、题材密度、人物关系和冲突复杂度共同估计；第一批章节数也由叙事需要决定，只展开足以自然进入本弧的连续章节，不固定五章，不为了凑节点压缩铺陈、相处、内省和过渡。",
    "章节不设置字数、字符数或段落数硬约束，但必须为每章填写 narrativeScale：compact 只用于确有短章职责的转场、余波或局部停顿；standard 是普通网文的完整章节体量参考，通常需要把当前功能充分展开到约 3000 字上下的阅读感受，但不是最低字数；extended 用于高潮、复杂冲突、多阶段行动或重要关系转折。narrativeScale 只描述叙事展开规模，不得输出固定字数目标；reason 说明为什么本章需要该规模，developmentAxes 写同一主导功能需要经历的连续体验阶段，stoppingCondition 写何时自然收束。",
    "batchIndex=1；batch.startChapterIndex 表示全书叙事序号起点，需承接最近已定稿/已规划章节。后续批次将基于新定稿状态滚动生成。",
    "章节蓝图是创作边界，不是待办清单。推进、停顿、余波、等待、恢复、相处、内省、气氛、误判、文学意象和日常过程都可以成为章节主体；optionalBeats 允许作者在正文中灵活取舍。不要要求每章都有新信息、新压力、新爽点或主线推进。",
    "重复是长篇的节奏资源，不是默认缺陷：可以反复写寒冷、饥饿、修行、仪式、等待、羞辱或同一地形，但连续窗口中的重复应改变读者理解、人物关系、社会质地、信息角度、情绪重量或行动代价。若只是同一关键词、同一反应逻辑和同一表层母题复用，才是需要修订的机械重复。",
    "核心卖点、职业特质、金手指和主题隐喻必须先转写成可见事件、感官压力、人物选择、观察顺序和递进意象，再进入标题或场景；章节标题优先指向本章可见事件/冲突/意象。作者侧分析词、职业类比和主题关键词只能影响人物如何观察和取舍，不能直接变成正文世界规则或连续章节标题词库。",
    "先把宏观主题转写成 thematicQuestions 中尚未回答的问题，不写口号或预设结论。每章用 narrativeFunction 指定唯一主导体验；stateTransition.before/after/evidence 记录本章前后可观察状态与正文可展开的证据；narrativeScale 决定这个功能需要多充分地被读者经历，不是额外事件配额。developmentAxes 必须是同一功能内部的连续阶段，例如感知变化、试错、选择、代价、余波或关系温度变化，不得为了拉长章节凭空增加第二套主线。chapterPurpose 只概括状态变化，不得写确立人设、展示能力、引入世界观或证明立意。unresolvedAtClose 逐项列出章末仍未得到确定答案的问题，后续正文不得把它们当作已证实结论。运行时将以 stateTransition 归一化 chapterPurpose。",
    "每章必须显式填写 worldRuleRefs、characterFocus、romanceTreatment、humorTreatment。worldRuleRefs 可以为空但要确认本章没有调用新的世界规则；characterFocus 只列真正影响本章的配角，逐项写自己的欲望、行动和代价，不要求每章强行加入配角；感情线和幽默使用 not-applicable/background/active 状态，不能为了填字段虚构关系或笑料。",
    "每个场景必须形成 goal（人物现在想得到什么以及为何此刻行动）→ opposition（具体阻力或利益冲突）→ turn（人物改变策略或作出选择）→ outcome（可观察结果）→ cost（已经付出、失去、暴露或加剧的风险）链。participantStakes 为场景中每个参与者（participants 数组中的每个元素）分别写一条独立记录，包含 want、leverage、withholding、failureCost，并为每一项标 knowledgeBasis。participants 有多少人，participantStakes 就必须有多少条——不能合并、不能遗漏、不能只给主角写。新故事弧中由本规划创设的内容用 planned，已有事实用 committed，只从可见行动推出的当场战术意图用 observable-inference，无法确立则用 unknown 且对应文本必须为空。failureCost 必须由该 participant 本人承担，不能只写任务失败、第三人受害或主角受影响。",
    "thematicTreatment 是权限和边界，不是逐章主题任务：absent 不承担主题；subtext 只让读者从行动、关系或后果自行推断；foreground 才允许人物围绕具体处境争执价值，但仍不得由作者或角色宣布标准答案。不得为了填满 questionRefs 而让每章都碰主题。",
    "权威优先级：已定稿事实与叙事状态账本 > 当前开放剧情线和最近定稿章节 > 已批准故事弧边界 > 全书长程战略。若实际创作改变了旧假设，保留叙事承诺和终局边界，但重新选择抵达路径；不得为了复现旧规划而覆盖已发生的故事。",
    STORY_ARC_OUTPUT_FORMAT_GUARD,
    buildStoryArcContext(input),
  ].join("\n\n");
}

export function buildStoryArcRebasePrompt(input: Parameters<typeof buildStoryArcPrompt>[0] & { target: StoryArcRebaseTarget }): string {
  const frozenTarget = {
    arcId: input.target.arcId,
    executionStatus: input.target.executionStatus,
    directionalRefs: {
      title: input.target.approvedArc.title,
      plotThreadRefs: input.target.approvedArc.plotThreadRefs,
      foreshadowingRefs: input.target.approvedArc.foreshadowingRefs,
    },
    batchIndex: input.target.batchIndex,
    startChapterIndex: input.target.startChapterIndex,
    chapters: input.target.chapters.map((chapter) => ({
      ...chapter,
      approvedPlan: chapter.committedMemory ? {
        continuityConstraints: chapter.approvedPlan.continuityConstraints,
        setupRefs: chapter.approvedPlan.setupRefs,
        payoffRefs: chapter.approvedPlan.payoffRefs,
      } : chapter.approvedPlan,
    })),
  };
  return [
    "重建一个已有故事弧及其已关联章节的执行契约。这不是续写、下一批规划或新故事弧规划。",
    `输出必须逐一对应冻结映射中的 ${input.target.chapters.length} 个文档：batchIndex=${input.target.batchIndex}，batch.startChapterIndex=${input.target.startChapterIndex}，chapters 数量不得增减或换位。已完成故事弧的 expectedChapterCount 必须等于已定稿章节数，batch.complete=true。`,
    "冻结映射中的 documentId、revisionId、关键事件、章末人物状态、未解线索和作者级事实是不可改写的已发生事实。新蓝图可以重写摘要、章内组织、主题显隐和场景表达，但不得把已发生事件替换成后续事件，也不得新增尚未发生的离开、抵达、关系跃迁或真相揭示。",
    "冻结映射中没有 revisionId 且没有 committedMemory 的章节是尚未创作的未来章节，不是缺失的历史事实。它们必须沿用 plannedBlueprint 这个最近一次批准的前向执行契约；可以补齐缺失的 narrativeScale，但不得凭空替换其事件、状态变化、未解问题或场景因果。若没有 plannedBlueprint，必须保持字段未知并让审核阻止该重基线，不得自行续写。",
    "approvedPlan 是旧规划的定位材料，不是正文任务。其中抽象主题宣言、世界观口号、人物标签和说教式 goal 不具备事实权威；只保留能被 committedMemory 或 authoritativeFacts 支持的事件身份、连续性引用与章序。",
    "每章 narrativeFunction 指定唯一主导阅读体验；readerExperience 写读者实际跟随的过程；stateTransition.before/after/evidence 记录本章前后可观察状态与正文可展开的证据，chapterPurpose 只概括该变化，不能写确立人设、展示能力、引入世界观、营造基调或证明主题。unresolvedAtClose 将由运行时强制回填为已提交章节记忆中的未解问题；summary、stateTransition、scene 与 stakes 都不得给这些问题补出更确定的因果、意图、身份、来源或危局性质。运行时将以 stateTransition 归一化 chapterPurpose。",
    "每个场景必须形成 goal（人物现在想得到什么以及为何此刻行动）→ opposition（具体阻力或利益冲突）→ turn（人物改变策略或作出选择）→ outcome（可观察结果）→ cost（已经付出、失去、暴露或加剧的风险）链。participantStakes 为场景中每个参与者（participants 数组中的每个元素）分别写一条独立记录，包含 want、leverage、withholding、failureCost，并逐项标 knowledgeBasis。participants 有多少人，participantStakes 就必须有多少条——不能合并、不能遗漏、不能只给主角写。重基线不得使用 planned：只有冻结映射逐字支持才是 committed；只从候选场景可见动作推出、且不回答 unresolvedThreads 的当场战术意图才是 observable-inference；否则标 unknown 并把对应文本留空。神秘人物不需要为了字段完整而拥有幕后使命、所属势力、主顾或场外任务。failureCost 只写本人在本场已经承担或可由可见行动直接推出的失败后果；未知就留空。",
    "主题只转写为 arc.thematicQuestions 中未预设答案的问题。thematicTreatment=absent 时 questionRefs 为空、carrier=none、evidenceChange 为空；subtext 只能依靠选择、关系、世界反应或后果；foreground 必须是两种具体选择真正冲突的 dialogue-conflict，发现机制、能力反应、导师传授和人物感慨都不构成 foreground。历史重基线只有在 committedMemory.keyEvents 明确记录双方因价值选择发生冲突时才可使用 foreground；不得从旧标题、旧 chapterPurpose 或对话内容事后升级主题显隐度。若删除主题字段不改变场景行动与后果，本章应使用 absent。不得逐章重复同一证据或答案。",
    "承担拜访、试探、传递消息或提供线索的配角必须有自己的即时目标、信息取舍、策略和离场代价；不能只作为主角的提示器。铺陈、相处、余波、日常与过渡可以独立成立。",
    STORY_ARC_OUTPUT_FORMAT_GUARD,
    "## 已定稿章节冻结映射（最高权威）",
    JSON.stringify(frozenTarget, null, 2),
    "## 长程索引（只用于引用稳定剧情线，不注入宏观结论）",
    `项目：${input.projectTitle}`,
    `作者本次意图：${input.authorIntent || "仅升级已有执行契约"}`,
    ...input.macro.map((item) => `- [${item.taskKey}] ${item.title}`),
    ...input.openThreads.map((item) => `- ${item.id} ${item.title}`),
  ].join("\n\n");
}

function buildStoryArcContext(input: Parameters<typeof buildStoryArcPrompt>[0]): string {
  return [
    `项目：${input.projectTitle}`,
    `作者本次意图：${input.authorIntent || "无额外指定，由当前状态和宏观规划推导"}`,
    "## 当前叙事状态账本（权威进入状态）",
    input.narrativeState ? JSON.stringify(input.narrativeState, null, 2) : "- 尚无叙事状态快照，这是第一段故事弧。",
    "## 当前长程叙事战略（方向与护栏，不是事件清单）",
    ...input.macro.map((item) => `- [${item.taskKey}] ${item.title}：${item.summary}`),
    "## 最近定稿章节",
    ...(input.recentChapters.length ? input.recentChapters.map((item) => `- 第${item.order}章：${item.summary}；未解决：${item.unresolvedThreads.join("、") || "无"}；情绪：${item.emotionalArc || "未记录"}`) : ["- 尚无定稿章节，这是第一个故事弧。"]),
    "## 当前开放剧情线",
    ...(input.openThreads.length ? input.openThreads.map((item) => `- ${item.id} ${item.title}：${JSON.stringify(item.payload)}`) : ["- 暂无正式剧情线记录，可引用宏观 plot-threads 中的稳定标识。"]),
  ].join("\n\n");
}

export function buildStoryArcBatchPrompt(input: Parameters<typeof buildStoryArcPrompt>[0] & { arc: StoryArcBundle["arc"]; batchIndex: number; startChapterIndex: number }): string {
  return [
    "依据最新定稿状态，为已批准故事弧生成下一批连续章节蓝图。",
    "先复核长篇层级：全书/卷级战略是方向，已批准故事弧是阶段边界，本批只负责当前进入窗口。不要因为最近章节反复出现某个场景、母题或生存压力，就把后续批次继续机械扩写同一套关键词。",
    `本次 batchIndex=${input.batchIndex}、startChapterIndex=${input.startChapterIndex}。章节数由叙事密度和当前阶段需要决定，不固定五章；chapter.index 从 1 重新编号，batch.startChapterIndex 表示全书叙事序号起点。`,
    "本批每章都必须填写 narrativeScale，但它是非硬性的叙事体量信号，不是字数下限。standard 作为普通完整章节的默认参考；compact 必须有明确的短章职责，extended 必须有足够高的因果、情感或场景负载。developmentAxes 应把同一主导功能拆成连续可经历的阶段，stoppingCondition 应说明完成哪些体验后可以收束；不得用新事件、强行反转或重复意象填充规模。",
    "arc 必须原样保留既定的 title、objective、entryState、exitState 和 expectedChapterCount，不得借滚动规划改写已经批准的故事弧边界。",
    "本批章节可以是停顿、余波、恢复、误判、日常或气氛章，不必每章制造新压力；但连续窗口必须避免无变化地复用同一情绪、同一地形、同一行动逻辑和同一作者侧关键词。",
    "以叙事状态账本、最近定稿状态、开放剧情线和未兑现伏笔为进入状态；旧批次中的未发生设想不是事实，不得改写前序已批准批次。只有确实抵达既定 exitState 且覆盖 expectedChapterCount 所需阶段时 batch.complete=true。",
    STORY_ARC_OUTPUT_FORMAT_GUARD,
    "## 已批准故事弧边界",
    JSON.stringify(input.arc, null, 2),
    "## 最新运行上下文",
    buildStoryArcContext(input),
  ].join("\n\n");
}

export function buildStoryArcReviewPrompt(bundle: StoryArcBundle, context: string, rebaseTarget?: StoryArcRebaseTarget): string {
  const dimensionLines = STORY_ARC_REVIEW_DIMENSIONS.map(
    (dim) => `- **${dim.name}**：${dim.rule}\n  锚点：${dim.anchors}`,
  );
  return [
    "以独立长篇策划编辑身份审核这个故事弧及整弧章节蓝图。",
    STORY_ARC_OUTPUT_FORMAT_GUARD,
    "## 审核维度与锚点",
    "逐维度对照下列锚点评分，找到真正破坏本弧功能或连续性的问题；不要因安静章、铺陈章、关系章没有明显推进主线而判错。",
    "重点检查当前批次是否把卷级目标、高潮、重大身份变化、关键情感跃迁或主线真相过早压缩；如果首批章节像卷级剧情摘要，必须报告 blocker/major。",
    "逐章检查 worldRuleRefs 是否引用真实的已批准规则、characterFocus 是否给配角独立欲望/行动/代价、romanceTreatment 是否有阶段与行动证据、humorTreatment 是否与人物和情境相容。not-applicable 是合法状态，不得因没有感情线或幽默就扣分；active 状态缺少证据时必须报告 major。",
    ...dimensionLines,
    "## issue 证据要求",
    "每个 issue 的 evidence 必须引用 arc 内的章节编号（如「第 3 章」）+ 蓝图逐字片段或 JSON 路径，格式：`第 X 章：<逐字片段或字段路径>`。evidence 不得仅写概括性描述，必须有可定位的原文依据。找不到具体证据时不要报告该 issue。",
    "severity 判定：blocker=整弧功能或连续性被破坏；major=局部因果断裂或状态矛盾，必须修订；warning=可优化但不影响弧功能。",
    "存在任一 blocker/major 时 verdict=revise；只有 warning 或无问题时 verdict=passed。",
    "## 事实权威强制预检",
    "在任何节奏、主题或结构评价之前，必须为每章输出且只输出一条 authorityChecks。unresolvedAtClose 必须逐项原样抄录待审候选的同名字段；checkedPaths 必须严格复制下方运行时清单且顺序一致，candidateClaims 与 checkedPaths 等长并按同一顺序逐字摘录字段内容；frozenEvidence 必须逐字摘录冻结记忆/作者事实中对应依据。判定采用蕴含而非相容：只要存在一个满足全部冻结事实、但该候选断言仍可能为假的世界，该断言就不是已证实，必须写入 certaintyUpgrades。观察变原因、可能危险变求助/救援、决定行动变已经行动、身份或来意未知变幕后关系/任务、或回答 unresolvedAtClose 均属于确定性升级。不得用剧情合理、符合氛围或后续可能成立替代证据。",
    "authorityChecks 有任一 certaintyUpgrades 或 verdict 非 passed 时，总 verdict 不得为 passed，issues 必须包含对应 major/blocker；即使七维检查全部通过也不能覆盖事实权威失败。",
    "## 逐章强制校验矩阵",
    `对每一章都必须输出 chapterChecks 的 ${CHAPTER_PLAN_CHECK_DIMENSIONS.length} 条记录，不得省略：alignment=标题/摘要/场景是否指向同一核心事件；choice-cost=主要人物是否存在符合章节功能的选择及代价；relationship-stage=关系变化是否有前置行动积累且没有跳阶；earned-outcome=场景结果是否由正文可展开的因果链挣得；function-fit=narrativeFunction、readerExperience 与场景过程是否一致且不是主题证明任务；theme-restraint=主题模式、承载方式与解释边界是否一致；longform-function=本章作为推进、停顿、余波、日常、气氛、误判、恢复或关系沉淀等长篇功能是否在当前位置成立。安静章允许选择与代价非常细微，关系无变化也可通过，但必须说明其停留阶段；不得因本章没有新压力、新信息、新爽点或主线推进而判错。若章节填写了 narrativeScale，还要检查 level、reason、developmentAxes、stoppingCondition 是否彼此一致：standard/extended 不能只用一个场景结果草草收束，compact 也不能借规模名义跳过本章已声明的必要体验；这不是字数检查。若连续窗口无变化地复用同一压力、地形、情绪或关键词，应在 arcChecks 的 window-variation / pressure-trajectory 中报告。`,
    "function-fit 判定：chapterPurpose 若仍写确立人设、展示能力、引入世界观、营造基调或证明立意，必须 revise；它必须描述章末可观察状态。readerExperience 若写成读者被告知设定、理解世界观或见证能力展示，而非具体过程，也必须 revise。choice-cost 判定：离开舒适区、引起注意、未来可能危险等泛化风险不能代替本场景已付出的具体代价。多人物场景必须逐项核对 participantStakes 与 knowledgeBasis；unknown 对应文本必须为空，且空值本身是正确的知识边界，不得报告为动机/赌注缺失，更不得建议补写身份、目的、传承、测试、任务或失败代价。observable-inference 只能描述候选场景中可见行动所支持的当场策略，不能回答 unresolvedAtClose，committed 必须能在冻结事实中定位。历史神秘人物只需通过可观察行动在场景中产生作用，不要求规划其内心。failureCost 必须由对应 participant 本人承担，写成抽象任务失败、第三人受害或主角受影响均不通过。",
    "theme-restraint 判定：foreground 仅适用于双方想要互斥结果、各自有可执行选择且冲突实际改变结果的 dialogue-conflict；导师讲授/测试、学生接受信息、机制发现、能力反应和单方感慨都不是 foreground。若主题字段删除后场景行动与后果不变，应改为 absent；evidenceChange 必须直接回应 questionRefs 的 opposingPressures，不能用不相干的行动硬贴主题；若只是重述宏观卖点而非新增、反驳或复杂化证据，必须 revise。",
    "chapterChecks 中任一 verdict=revise/blocked 时，总 verdict 不得为 passed，并在 issues 中给出对应 blocker/major。",
    "## 整弧强制校验矩阵",
    "arcChecks 必须各输出一条：function-rhythm=相邻章节的主导体验是否自然衔接且没有退化为同一种说明；theme-distribution=主题是否只在合适窗口增加新证据或复杂度，而非连续复述答案；motif-evolution=重复意象是否改变信息、人物关系或行动功能；motif-integration=核心设定/职业/金手指/主题隐喻是否进入具体事件、感官压力、人物选择和递进意象，而非连续标题、场景名或转折描述的表层标签；longform-hierarchy=全书/卷级战略、故事弧、批次和章节之间职责是否分层清楚，局部蓝图是否越权消耗上层目标或把作者侧分析词变成正文规则；window-variation=连续章节窗口是否允许重复但产生理解、关系、社会质地、信息角度、情绪重量或行动代价的变化，是否避免同一关键词/同一场景压力/同一反应逻辑的机械复用；pressure-trajectory=弧/批次窗口内是否存在可辨识的外部压力或张力形态变化，但不得要求每章都新增或加剧压力。不得使用固定章数、关键词次数或机械配额判断。",
    ...(rebaseTarget ? [
      "## 重基线专用门禁",
      "这是已有定稿章节的规划重基线，不是续写。先做事实确定性对照，再做七维检查：逐项把候选 summary、stateTransition、scenes、participantStakes 中的断言与 committedMemory.keyEvents/characterStates/unresolvedThreads 及 authoritativeFacts 对照。冻结映射只记录异常、可能、感应、试探或未知时，候选不得升级为已证实的求助、幕后指令、所属关系、因果解释、危局性质或任务；任何回答 unresolvedAtClose、增加具体幕后实体或提高确定性的内容都是 major，verdict=revise。逐章核对文档位置、关键事件、章末人物状态、未解线索和作者级事实；若改写成后续章节、遗漏已发生事件、提前新增事件或无法逐章对应，必须报告 blocker。旧规划中的主题宣言不属于必须保留的事实。chapterChecks 的 evidence 必须先引用待审候选的精确字段；冻结映射只能作为对照证据，不能替候选补足缺失的行动、代价或主题边界。候选只有在 committedMemory.keyEvents 明确记录双方因价值选择发生冲突时才可标 foreground。",
      "没有 revisionId 且拥有 plannedBlueprint 的未来章节不适用 committedMemory 的历史事实审查；应检查候选是否逐项保留 plannedBlueprint 的事件边界、stateTransition、unresolvedAtClose 和不提前消费后续节点，只允许补足叙事规模或表达层字段。未来章节若没有 plannedBlueprint，必须列 blocker。",
      JSON.stringify(rebaseTarget, null, 2),
    ] : []),
    "## 规划上下文",
    context,
    "## 待审故事弧",
    JSON.stringify(bundle, null, 2),
    "## 运行时指定的事实核对路径（必须原样复制到各章 checkedPaths）",
    bundle.chapters.map((chapter) => `第 ${chapter.index} 章：${JSON.stringify(storyArcAuthorityPaths(chapter))}`).join("\n"),
    "现在先按 checkedPaths 逐项执行可能世界蕴含测试，再进行七维与整弧检查。不得跳过、合并或用其他安全字段替代指定路径。",
  ].join("\n\n");
}

export function buildStoryArcRevisionPrompt(bundle: StoryArcBundle, review: StoryArcReviewOutput, context: string, rebaseTarget?: StoryArcRebaseTarget): string {
  return [
    "修订整个故事弧章节蓝图，修复审核中的 blocker/major，并输出完整 JSON。不要删去未被问题触及的有效设计。",
    "不得用增加突发危险、强行反转、加快大纲兑现或给每章塞入新贡献来机械修复安静章节。若问题是连续窗口机械复用，应改变功能分布、视角信息、人物关系、社会质地、情绪重量或行动代价，而不是简单替换关键词。",
    "每个修订点必须对应一个审核 issue；不得借修订改写未被问题触及的有效设计。",
    STORY_ARC_OUTPUT_FORMAT_GUARD,
    "## 规划上下文",
    context,
    ...(rebaseTarget ? ["## 重基线冻结映射", JSON.stringify(rebaseTarget, null, 2)] : []),
    "## 原蓝图",
    JSON.stringify(bundle, null, 2),
    "## 审核",
    JSON.stringify(review, null, 2),
  ].join("\n\n");
}
