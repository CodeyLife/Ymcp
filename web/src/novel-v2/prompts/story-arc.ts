import type { StoryArcBundle } from "../application/story-arc";
import { CHAPTER_PLAN_CHECK_DIMENSIONS, type StoryArcReviewOutput } from "../application/story-arc-review-policy";
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
      required: ["title", "objective", "entryState", "centralConflict", "development", "resolution", "exitState", "plotThreadRefs", "foreshadowingRefs", "expectedChapterCount", "phases"],
      properties: {
        title: { type: "string", minLength: 1 }, objective: { type: "string", minLength: 1 }, entryState: { type: "string" }, centralConflict: { type: "string" },
        development: { type: "array", items: { type: "string" } }, resolution: { type: "string" }, exitState: { type: "string" },
        plotThreadRefs: { type: "array", items: { type: "string" } }, foreshadowingRefs: { type: "array", items: { type: "string" } },
        expectedChapterCount: { type: "integer", minimum: 8, maximum: 80 }, authorIntent: { type: "string" },
        phases: { type: "array", minItems: 2, items: { type: "object", additionalProperties: false, required: ["title", "objective", "exitCondition"], properties: { title: { type: "string", minLength: 1 }, objective: { type: "string", minLength: 1 }, exitCondition: { type: "string", minLength: 1 } } } },
      },
    },
    batch: { type: "object", additionalProperties: false, required: ["batchIndex", "startChapterIndex", "complete"], properties: { batchIndex: { type: "integer", minimum: 1 }, startChapterIndex: { type: "integer", minimum: 1 }, complete: { type: "boolean" } } },
    chapters: {
      type: "array", minItems: 1, maxItems: 16, items: {
        type: "object", additionalProperties: false,
        required: ["index", "title", "summary", "chapterPurpose", "dramaticQuestion", "emotionalMovement", "stateDeltaBudget", "optionalBeats", "scenes", "continuityConstraints", "setupRefs", "payoffRefs", "closingForce", "freedom"],
        properties: {
          index: { type: "integer", minimum: 1 }, title: { type: "string", minLength: 1 }, summary: { type: "string", minLength: 1 }, chapterPurpose: { type: "string" }, dramaticQuestion: { type: "string" }, povCharacterId: { type: "string" }, emotionalMovement: { type: "string" }, stateDeltaBudget: { type: "string" },
          optionalBeats: { type: "array", items: { type: "string" } }, continuityConstraints: { type: "array", items: { type: "string" } }, setupRefs: { type: "array", items: { type: "string" } }, payoffRefs: { type: "array", items: { type: "string" } }, closingForce: { type: "string" }, freedom: { type: "string" },
          scenes: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "summary", "participants"], properties: { title: { type: "string" }, summary: { type: "string" }, goal: { type: "string" }, participants: { type: "array", items: { type: "string" } }, turn: { type: "string" }, outcome: { type: "string" } } } },
        },
      },
    },
  },
} as const;

export const storyArcReviewSchema = {
  type: "object", additionalProperties: false, required: ["verdict", "summary", "issues", "chapterChecks"],
  properties: {
    verdict: { enum: ["passed", "revise", "blocked"] }, summary: { type: "string" },
    issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["severity", "title", "evidence", "suggestion"], properties: { severity: { enum: ["blocker", "major", "warning"] }, title: { type: "string" }, evidence: { type: "string" }, suggestion: { type: "string" } } } },
    chapterChecks: { type: "array", items: { type: "object", additionalProperties: false, required: ["chapterIndex", "dimension", "verdict", "evidence", "reason"], properties: { chapterIndex: { type: "integer", minimum: 1 }, dimension: { enum: CHAPTER_PLAN_CHECK_DIMENSIONS }, verdict: { enum: ["passed", "revise", "blocked"] }, evidence: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 } } } },
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
    name: "长篇节奏与批次边界",
    rule: "卷/篇章分区只是展示和长篇结构层，故事弧是阶段性推进层；不得把完整一卷、卷级高潮、关键关系跃迁或重大权力身份变化压缩进首批章节。",
    anchors: "5=批次只承担自然起步或阶段推进；3=批次略拥挤但仍留有铺陈余地；1=首批像卷级摘要，多个重大节点被连续兑现。",
  },
  {
    name: "机械逐项检测",
    rule: "章节不是对大纲点的生硬罗列；每章有人物行动与情感空间，而非仅完成信息交代。",
    anchors: "5=每章有独立生命力；3=个别章节偏报表式；1=整弧像事件流水账。",
  },
  {
    name: "人物空间",
    rule: "主角在本弧有欲望—行动—情感的弧线；配角有承担功能而非工具人。",
    anchors: "5=主角弧线清晰且配角有质地；3=主角有行动但情感模糊；1=人物纯功能化。",
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
    "卷/篇章分区不是故事弧：如果作者意图提到「卷一/卷二/卷三」或类似分卷目标，只把它当作长篇位置与主题背景，不要把完整一卷压缩成一个故事弧，也不要把故事弧标题伪装成卷标题。",
    "故事弧 expectedChapterCount 由当前叙事状态、长程战略、题材密度、人物关系和冲突复杂度共同估计；第一批章节数也由叙事需要决定，只展开足以自然进入本弧的连续章节，不固定五章，不为了凑节点压缩铺陈、相处、内省和过渡。",
    "章节没有字数、字符数或段落数约束；只按章节功能和叙事需要自然展开与收束，不输出长度目标或区间。",
    "batchIndex=1；batch.startChapterIndex 表示全书叙事序号起点，需承接最近已定稿/已规划章节。后续批次将基于新定稿状态滚动生成。",
    "章节蓝图是创作边界，不是待办清单。铺陈、相处、内省、情绪积累、文学意象和日常过程可以成为章节主体；optionalBeats 允许作者在正文中灵活取舍。",
    "权威优先级：已定稿事实与叙事状态账本 > 当前开放剧情线和最近定稿章节 > 已批准故事弧边界 > 全书长程战略。若实际创作改变了旧假设，保留叙事承诺和终局边界，但重新选择抵达路径；不得为了复现旧规划而覆盖已发生的故事。",
    STORY_ARC_OUTPUT_FORMAT_GUARD,
    buildStoryArcContext(input),
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
    `本次 batchIndex=${input.batchIndex}、startChapterIndex=${input.startChapterIndex}。章节数由叙事密度和当前阶段需要决定，不固定五章；chapter.index 从 1 重新编号，batch.startChapterIndex 表示全书叙事序号起点。`,
    "章节没有字数、字符数或段落数约束；只按章节功能和叙事需要自然展开与收束，不输出长度目标或区间。",
    "arc 必须原样保留既定的 title、objective、entryState、exitState 和 expectedChapterCount，不得借滚动规划改写已经批准的故事弧边界。",
    "以叙事状态账本、最近定稿状态、开放剧情线和未兑现伏笔为进入状态；旧批次中的未发生设想不是事实，不得改写前序已批准批次。只有确实抵达既定 exitState 且覆盖 expectedChapterCount 所需阶段时 batch.complete=true。",
    STORY_ARC_OUTPUT_FORMAT_GUARD,
    "## 已批准故事弧边界",
    JSON.stringify(input.arc, null, 2),
    "## 最新运行上下文",
    buildStoryArcContext(input),
  ].join("\n\n");
}

export function buildStoryArcReviewPrompt(bundle: StoryArcBundle, context: string): string {
  const dimensionLines = STORY_ARC_REVIEW_DIMENSIONS.map(
    (dim) => `- **${dim.name}**：${dim.rule}\n  锚点：${dim.anchors}`,
  );
  return [
    "以独立长篇策划编辑身份审核这个故事弧及整弧章节蓝图。",
    STORY_ARC_OUTPUT_FORMAT_GUARD,
    "## 审核维度与锚点",
    "逐维度对照下列锚点评分，找到真正破坏本弧功能或连续性的问题；不要因安静章、铺陈章、关系章没有明显推进主线而判错。",
    "重点检查当前批次是否把卷级目标、高潮、重大身份变化、关键情感跃迁或主线真相过早压缩；如果首批章节像卷级剧情摘要，必须报告 blocker/major。",
    ...dimensionLines,
    "## issue 证据要求",
    "每个 issue 的 evidence 必须引用 arc 内的章节编号（如「第 3 章」）+ 蓝图逐字片段或 JSON 路径，格式：`第 X 章：<逐字片段或字段路径>`。evidence 不得仅写概括性描述，必须有可定位的原文依据。找不到具体证据时不要报告该 issue。",
    "severity 判定：blocker=整弧功能或连续性被破坏；major=局部因果断裂或状态矛盾，必须修订；warning=可优化但不影响弧功能。",
    "存在任一 blocker/major 时 verdict=revise；只有 warning 或无问题时 verdict=passed。",
    "## 逐章强制校验矩阵",
    "对每一章都必须输出 chapterChecks 的四条记录，不得省略：alignment=标题/摘要/场景是否指向同一核心事件；choice-cost=主要人物是否存在符合章节功能的选择及代价；relationship-stage=关系变化是否有前置行动积累且没有跳阶；earned-outcome=场景结果是否由正文可展开的因果链挣得。安静章允许选择与代价非常细微，关系无变化也可通过，但必须说明其停留阶段。",
    "chapterChecks 中任一 verdict=revise/blocked 时，总 verdict 不得为 passed，并在 issues 中给出对应 blocker/major。",
    "## 规划上下文",
    context,
    "## 待审故事弧",
    JSON.stringify(bundle, null, 2),
  ].join("\n\n");
}

export function buildStoryArcRevisionPrompt(bundle: StoryArcBundle, review: StoryArcReviewOutput, context: string): string {
  return [
    "修订整个故事弧章节蓝图，修复审核中的 blocker/major，并输出完整 JSON。不要删去未被问题触及的有效设计。",
    "不得用增加突发危险、强行反转或加快大纲兑现来机械修复安静章节。",
    "每个修订点必须对应一个审核 issue；不得借修订改写未被问题触及的有效设计。",
    STORY_ARC_OUTPUT_FORMAT_GUARD,
    "## 规划上下文",
    context,
    "## 原蓝图",
    JSON.stringify(bundle, null, 2),
    "## 审核",
    JSON.stringify(review, null, 2),
  ].join("\n\n");
}
