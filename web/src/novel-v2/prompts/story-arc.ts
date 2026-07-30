import type { StoryArcBundle } from "../application/story-arc";

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
        expectedChapterCount: { type: "integer", minimum: 12, maximum: 30 }, authorIntent: { type: "string" },
        phases: { type: "array", minItems: 2, items: { type: "object", additionalProperties: false, required: ["title", "objective", "exitCondition"], properties: { title: { type: "string", minLength: 1 }, objective: { type: "string", minLength: 1 }, exitCondition: { type: "string", minLength: 1 } } } },
      },
    },
    batch: { type: "object", additionalProperties: false, required: ["batchIndex", "startChapterIndex", "complete"], properties: { batchIndex: { type: "integer", minimum: 1 }, startChapterIndex: { type: "integer", minimum: 1 }, complete: { type: "boolean" } } },
    chapters: {
      type: "array", minItems: 5, maxItems: 8, items: {
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
  type: "object", additionalProperties: false, required: ["verdict", "summary", "issues"],
  properties: {
    verdict: { enum: ["passed", "revise", "blocked"] }, summary: { type: "string" },
    issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["severity", "title", "evidence", "suggestion"], properties: { severity: { enum: ["blocker", "major", "warning"] }, title: { type: "string" }, evidence: { type: "string" }, suggestion: { type: "string" } } } },
  },
} as const;

export interface StoryArcReviewOutput {
  verdict: "passed" | "revise" | "blocked";
  summary: string;
  issues: Array<{ severity: "blocker" | "major" | "warning"; title: string; evidence: string; suggestion: string }>;
}

export function buildStoryArcPrompt(input: { projectTitle: string; authorIntent?: string; macro: Array<{ taskKey: string; title: string; summary: string }>; recentChapters: Array<{ order: number; summary: string; unresolvedThreads: string[]; emotionalArc?: string }>; openThreads: Array<{ id: string; title: string; payload: Record<string, unknown> }> }): string {
  return [
    "规划下一个顺序故事弧的宏观边界，并只展开第一批连续章节蓝图。只输出 JSON。",
    "故事弧默认容纳 12–30 章，必须从已经发生的状态出发形成局部完整的小故事；本次 batchIndex=1、startChapterIndex=1，只展开 5–8 章，后续批次将基于新定稿状态滚动生成。",
    "章节蓝图是创作边界，不是待办清单。铺陈、相处、内省、情绪积累、文学意象和日常过程可以成为章节主体；optionalBeats 允许作者在正文中灵活取舍。",
    `项目：${input.projectTitle}`,
    `作者本次意图：${input.authorIntent || "无额外指定，由当前状态和宏观规划推导"}`,
    "## 当前宏观规划",
    ...input.macro.map((item) => `- [${item.taskKey}] ${item.title}：${item.summary}`),
    "## 最近定稿章节",
    ...(input.recentChapters.length ? input.recentChapters.map((item) => `- 第${item.order}章：${item.summary}；未解决：${item.unresolvedThreads.join("、") || "无"}；情绪：${item.emotionalArc || "未记录"}`) : ["- 尚无定稿章节，这是第一个故事弧。"]),
    "## 当前开放剧情线",
    ...(input.openThreads.length ? input.openThreads.map((item) => `- ${item.id} ${item.title}：${JSON.stringify(item.payload)}`) : ["- 暂无正式剧情线记录，可引用宏观 plot-threads 中的稳定标识。"]),
  ].join("\n\n");
}

export function buildStoryArcBatchPrompt(input: Parameters<typeof buildStoryArcPrompt>[0] & { arc: StoryArcBundle["arc"]; batchIndex: number; startChapterIndex: number }): string {
  return [
    "为已批准故事弧生成下一批连续章节蓝图。只输出符合相同 schema 的完整 JSON。",
    `本次 batchIndex=${input.batchIndex}、startChapterIndex=${input.startChapterIndex}，只展开 5–8 章。chapter.index 从 1 重新编号；batch.startChapterIndex 才是整弧位置。`,
    "arc 必须原样保留既定的 title、objective、entryState、exitState 和 expectedChapterCount，不得借滚动规划改写已经批准的故事弧边界。",
    "以最近定稿状态、开放剧情线和未兑现伏笔为进入状态；不得改写前序已批准批次。只有确实抵达既定 exitState 时 batch.complete=true。",
    "## 已批准故事弧边界",
    JSON.stringify(input.arc, null, 2),
    "## 最新运行上下文",
    buildStoryArcPrompt(input),
  ].join("\n\n");
}

export function buildStoryArcReviewPrompt(bundle: StoryArcBundle, context: string): string {
  return [
    "以独立长篇策划编辑身份审核这个故事弧及整弧章节蓝图。只输出结构化 JSON。",
    "检查局部因果是否闭合、章节之间状态是否连续、是否提前消费后续大节点、是否机械逐项完成大纲、人物是否有行动与情感空间。",
    "不得因为安静章、铺陈章、关系章没有明显推进主线而判错；只有持续破坏本故事弧功能或连续性的事实问题才是 blocker/major。",
    "存在任一 blocker/major 时 verdict=revise；只有 warning 或无问题时 verdict=passed。",
    "## 规划上下文", context,
    "## 待审故事弧", JSON.stringify(bundle, null, 2),
  ].join("\n\n");
}

export function buildStoryArcRevisionPrompt(bundle: StoryArcBundle, review: StoryArcReviewOutput, context: string): string {
  return [
    "修订整个故事弧章节蓝图，修复审核中的 blocker/major，并输出完整 JSON。不要删去未被问题触及的有效设计。",
    "不得用增加突发危险、强行反转或加快大纲兑现来机械修复安静章节。",
    "## 规划上下文", context,
    "## 原蓝图", JSON.stringify(bundle, null, 2),
    "## 审核", JSON.stringify(review, null, 2),
  ].join("\n\n");
}
