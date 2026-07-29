import type { StoryArcBundle } from "../application/story-arc";

export const storyArcBundleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["arc", "chapters"],
  properties: {
    arc: {
      type: "object",
      additionalProperties: false,
      required: ["title", "objective", "entryState", "centralConflict", "development", "resolution", "exitState", "plotThreadRefs", "foreshadowingRefs", "expectedChapterCount"],
      properties: {
        title: { type: "string", minLength: 1 }, objective: { type: "string", minLength: 1 }, entryState: { type: "string" }, centralConflict: { type: "string" },
        development: { type: "array", items: { type: "string" } }, resolution: { type: "string" }, exitState: { type: "string" },
        plotThreadRefs: { type: "array", items: { type: "string" } }, foreshadowingRefs: { type: "array", items: { type: "string" } },
        expectedChapterCount: { type: "integer", minimum: 1 }, authorIntent: { type: "string" },
      },
    },
    chapters: {
      type: "array", minItems: 1, items: {
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
    "规划下一个顺序故事弧，并一次生成该小故事覆盖的全部章节蓝图。只输出 JSON。",
    "故事弧必须从已经发生的状态出发，形成局部完整的小故事，同时为全书长期剧情保留空间。章数由内容需要决定，不按固定模板凑数。",
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
