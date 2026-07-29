/* ============================================================
 * WorkflowShowcase — 11 阶段元数据
 * 把章节工作流的 11 个 WorkflowStage
 * 映射为 UI 友好的语义分类、配色、span class、描述
 * 严格对齐 Plan 中 5 类阶段语义分类
 * ============================================================ */

import type { WorkflowStage } from "@/novel-v2/protocol";

/** 5 类阶段语义分类 — 对应 Plan 5.2 节 */
export type StageCategory = "context" | "creation" | "gate" | "quality" | "sediment";

export interface StageMeta {
  /** 阶段 id,对齐 WorkflowStage 枚举 */
  stage: WorkflowStage;
  /** 中文标签 */
  label: string;
  /** 1-11 序号 */
  index: number;
  /** 语义分类 */
  category: StageCategory;
  /** 分类中文名 */
  categoryLabel: string;
  /** 一句话描述该阶段做什么 */
  description: string;
  /** Bento span class(对应 showcase.css) */
  spanClass: string;
  /** 卡片状态 tag class(对应 .ws-card-tag.is-{category}) */
  tagClass: string;
  /** 强调色 CSS variable */
  accentVar: string;
}

/** 11 阶段完整元数据表 — 顺序与 WorkflowStage 枚举严格一致 */
export const STAGE_META: StageMeta[] = [
  {
    stage: "context",
    label: "冻结上下文",
    index: 1,
    category: "context",
    categoryLabel: "上下文冻结",
    description: "从对话线程或历史包编译阶段上下文,解析所需 skill 集合,冻结输入边界。",
    spanClass: "ws-span-context",
    tagClass: "is-context",
    accentVar: "--ws-accent-context",
  },
  {
    stage: "blueprint",
    label: "生成蓝图",
    index: 2,
    category: "creation",
    categoryLabel: "创作生成",
    description: "生成章节蓝图,含 blueprint-audit 内迭代(最多 3 轮),产出结构化 ChapterBlueprint。",
    spanClass: "ws-span-blueprint",
    tagClass: "is-creation",
    accentVar: "--ws-accent-creation",
  },
  {
    stage: "blueprint-approval",
    label: "蓝图审批",
    index: 3,
    category: "gate",
    categoryLabel: "人工门禁",
    description: "人工审批蓝图。批准时合并 brief 到 blueprint 写入 document;退回则重生成。",
    spanClass: "ws-span-blueprint-approval",
    tagClass: "is-gate",
    accentVar: "--ws-accent-gate",
  },
  {
    stage: "draft",
    label: "正文草稿",
    index: 4,
    category: "creation",
    categoryLabel: "创作生成",
    description: "依据批准蓝图分段流式生成整章正文,机械预审不阻塞,自动结构修复。",
    spanClass: "ws-span-draft",
    tagClass: "is-creation",
    accentVar: "--ws-accent-creation",
  },
  {
    stage: "review",
    label: "专业审校",
    index: 5,
    category: "quality",
    categoryLabel: "质量保障",
    description: "五个 reviewer 并行审校(风格/人物/连续性/情节/读者)+ prose-audit 元审核,产出 QualityReport。",
    spanClass: "ws-span-review",
    tagClass: "is-quality",
    accentVar: "--ws-accent-quality",
  },
  {
    stage: "revision",
    label: "定向修订",
    index: 6,
    category: "quality",
    categoryLabel: "质量保障",
    description: "按 issue 定位段落窗口,流式生成替换片段。支持重复段删除、未完成续写。",
    spanClass: "ws-span-revision",
    tagClass: "is-quality",
    accentVar: "--ws-accent-quality",
  },
  {
    stage: "manuscript-approval",
    label: "正文审批",
    index: 7,
    category: "gate",
    categoryLabel: "人工门禁",
    description: "逐段审批正文变更。批准时进入事实提取,退回则回到修订阶段。",
    spanClass: "ws-span-manuscript-approval",
    tagClass: "is-gate",
    accentVar: "--ws-accent-gate",
  },
  {
    stage: "fact-extraction",
    label: "事实提取",
    index: 8,
    category: "sediment",
    categoryLabel: "知识沉淀",
    description: "从已批准正文提取结构化事实差异,安全项自动采纳,产出 FactCandidate 集合。",
    spanClass: "ws-span-fact-extraction",
    tagClass: "is-sediment",
    accentVar: "--ws-accent-sediment",
  },
  {
    stage: "fact-approval",
    label: "事实审批",
    index: 9,
    category: "gate",
    categoryLabel: "人工门禁",
    description: "人工审批待审事实。每项需明确决定,批准后进入正式提交阶段。",
    spanClass: "ws-span-fact-approval",
    tagClass: "is-gate",
    accentVar: "--ws-accent-gate",
  },
  {
    stage: "commit",
    label: "正式提交",
    index: 10,
    category: "sediment",
    categoryLabel: "知识沉淀",
    description: "提交采纳事实、创建 chapter memory、同步 document plainText/contentHtml 并标记 final。",
    spanClass: "ws-span-commit",
    tagClass: "is-sediment",
    accentVar: "--ws-accent-sediment",
  },
  {
    stage: "character-enrichment",
    label: "人物完善",
    index: 11,
    category: "sediment",
    categoryLabel: "知识沉淀",
    description: "基于本章既定事实补完人物档案空缺字段(role/appearance/personality 等 9 个字段)。",
    spanClass: "ws-span-character-enrichment",
    tagClass: "is-sediment",
    accentVar: "--ws-accent-sediment",
  },
];

/** 按 stage id 索引 */
export const STAGE_META_MAP: Record<string, StageMeta> = Object.fromEntries(
  STAGE_META.map((item) => [item.stage, item]),
);

/** 阶段状态(用于 Bento 卡片状态展示) */
export type StageStatus = "done" | "active" | "pending" | "gate-waiting" | "failed";

/** 8 个质量维度(对齐 reviewerSchema.scores) */
export interface QualityDimensionMeta {
  key: string;
  label: string;
  description: string;
}

export const QUALITY_DIMENSIONS: QualityDimensionMeta[] = [
  { key: "plot", label: "情节推进", description: "节拍落地、因果链、悬念与回收" },
  { key: "characterVoice", label: "人物声口", description: "语气、用词、行为是否符合人设" },
  { key: "sceneEmbodiment", label: "场景具身", description: "感官细节、空间感、动作落地" },
  { key: "dialogue", label: "对话张力", description: "信息密度、潜台词、节奏" },
  { key: "specificity", label: "细节特异性", description: "避免套话,具体到唯一对象" },
  { key: "hookPayoff", label: "钩子回收", description: "章尾驱动力与长线承诺" },
  { key: "continuity", label: "连续性", description: "与既有事实、时间线、人物状态一致" },
  { key: "readerRetention", label: "读者留存", description: "可读性、节奏、翻页欲" },
];
