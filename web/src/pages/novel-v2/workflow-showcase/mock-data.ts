/* ============================================================
 * WorkflowShowcase — Mock 数据
 * 让展示页可独立运行展示完整 AIDA 流程
 * 后续可替换为 v2 API 真实数据(数据结构保持兼容)
 * 严格遵循 gpt-taste: 无 emojis,专业文案,无工程码暴露
 * ============================================================ */

import type { StageStatus } from "./stage-meta";

/** 章节信息(Hero 用) */
export interface ShowcaseChapter {
  title: string;
  subtitle: string;
  stageLabel: string;
  stageIndex: number;
  totalStages: number;
  revision: number;
  status: "running" | "waiting-approval" | "completed" | "failed";
}

/** 阶段状态(Bento 全景用) */
export interface ShowcaseStageState {
  stage: string;
  status: StageStatus;
  artifactCount: number;
  durationLabel?: string;
}

/** 质量报告(8 维光谱用) */
export interface ShowcaseQualityReport {
  weightedScore: number;
  passed: boolean;
  threshold: number;
  scores: Record<string, number>;
  issues: ShowcaseQualityIssue[];
}

export interface ShowcaseQualityIssue {
  id: string;
  severity: "blocker" | "major" | "warning";
  dimension: string;
  dimensionLabel: string;
  title: string;
  description: string;
  excerpt?: string;
  rule?: string;
  suggestion?: string;
  rewriteExample?: string;
}

/** 审批门禁(三种门禁差异化展示) */
export type GateKind = "blueprint-approval" | "manuscript-approval" | "fact-approval";

export interface ShowcaseApprovalGate {
  kind: GateKind;
  title: string;
  badge: string;
  bodyMarkdown: string;
  stats?: { label: string; value: string }[];
  factList?: { id: string; field: string; value: string; risk: "safe" | "high"; status: "pending" | "accepted" | "rejected"; conflict: boolean }[];
}

/** 阶段化事件(事件流聚合用) */
export interface ShowcaseStageEvent {
  stage: string;
  stageLabel: string;
  categoryColor: string;
  eventCount: number;
  artifactCount: number;
  durationLabel: string;
  events: { id: string; icon: string; label: string; summary: string; timeLabel: string }[];
}

/** 学习闭环(Learning Marquee + Skill 卡片用) */
export interface ShowcaseLearning {
  id: string;
  status: "completed" | "pending" | "failed";
  conclusion: "propose-improvement" | "no-action" | "regression-required";
  skillName: string;
  skillVersion: string;
  underlyingMechanism: string;
  affectedInputClass: string;
}

/* ============================================================
 * Mock 数据实例 — 模拟一个正在 manuscript-approval 阶段的章节
 * ============================================================ */

export const MOCK_CHAPTER: ShowcaseChapter = {
  title: "第七章 · 暗潮与回声",
  subtitle: "主角在港口仓库发现密信,被迫在揭穿与隐忍之间做出选择。本章聚焦人物内心张力与场景具身。",
  stageLabel: "正文审批",
  stageIndex: 7,
  totalStages: 11,
  revision: 2,
  status: "waiting-approval",
};

/** 11 阶段状态(模拟跑到第 7 阶段 manuscript-approval) */
export const MOCK_STAGE_STATES: ShowcaseStageState[] = [
  { stage: "context", status: "done", artifactCount: 1, durationLabel: "12 秒" },
  { stage: "blueprint", status: "done", artifactCount: 1, durationLabel: "1 分 48 秒" },
  { stage: "blueprint-approval", status: "done", artifactCount: 1, durationLabel: "人工审批" },
  { stage: "draft", status: "done", artifactCount: 1, durationLabel: "3 分 24 秒" },
  { stage: "review", status: "done", artifactCount: 1, durationLabel: "2 分 11 秒" },
  { stage: "revision", status: "done", artifactCount: 1, durationLabel: "1 分 36 秒" },
  { stage: "manuscript-approval", status: "gate-waiting", artifactCount: 1, durationLabel: "等待审批" },
  { stage: "fact-extraction", status: "pending", artifactCount: 0 },
  { stage: "fact-approval", status: "pending", artifactCount: 0 },
  { stage: "commit", status: "pending", artifactCount: 0 },
  { stage: "character-enrichment", status: "pending", artifactCount: 0 },
];

/** 质量报告(模拟 8 维分数 + 4 个 issue) */
export const MOCK_QUALITY_REPORT: ShowcaseQualityReport = {
  weightedScore: 3.85,
  passed: true,
  threshold: 3.7,
  scores: {
    plot: 4.2,
    characterVoice: 3.6,
    sceneEmbodiment: 4.0,
    dialogue: 3.4,
    specificity: 3.8,
    hookPayoff: 4.4,
    continuity: 3.9,
    readerRetention: 3.7,
  },
  issues: [
    {
      id: "iss-001",
      severity: "major",
      dimension: "dialogue",
      dimensionLabel: "对话张力",
      title: "港口对峙段对话信息密度偏低",
      description: "主角与走私者交涉时,三句连续对话均为直接陈述,缺少潜台词与节奏变化。",
      excerpt: "「这是你要的东西。」「我不确定。」「那就别怪我。」",
      rule: "serial-rhythm: 对话应承载至少两层信息(表层交流 + 深层博弈)",
      suggestion: "将第二句改为反问或动作穿插,让主角的犹豫通过肢体语言外化。",
      rewriteExample: "「这是你要的东西。」他把布包推过桌面。她的手指没有松开。「你确定是全部?」",
    },
    {
      id: "iss-002",
      severity: "warning",
      dimension: "specificity",
      dimensionLabel: "细节特异性",
      title: "仓库气味描写过于通用",
      description: "「潮湿的气味」这一表达在既有章节中已出现 4 次,缺乏唯一性。",
      excerpt: "仓库里弥漫着潮湿的气味,混着木箱的霉味。",
      rule: "style-specificity-audit: 感官描写应锚定到唯一对象",
      suggestion: "替换为更具特异性的嗅觉锚点,如「腌鱼咸腥」「松脂焦苦」。",
    },
    {
      id: "iss-003",
      severity: "warning",
      dimension: "characterVoice",
      dimensionLabel: "人物声口",
      title: "配角语气与第二人设偏差",
      description: "走私者在第三章建立的「老练克制」形象,本章对话略显急躁。",
      excerpt: "「快点决定,我没那么多时间。」",
      rule: "character-voice: 配角语气应跨章节一致",
      suggestion: "将「快点决定」改为更符合老练人设的含蓄催促,如「天快亮了」。",
    },
    {
      id: "iss-004",
      severity: "blocker",
      dimension: "continuity",
      dimensionLabel: "连续性",
      title: "密信封蜡颜色与第五章矛盾",
      description: "第五章明确密信用「黑蜡封口」,本章描写为「朱红色封蜡」,构成硬伤。",
      excerpt: "信封上的朱红色封蜡还印着半枚家徽。",
      rule: "story-facts-invariant: 实体属性跨章节不可矛盾",
      suggestion: "统一为黑蜡,或解释为另一封信(需在情节中铺垫)。",
    },
  ],
};

/** 当前门禁 — manuscript-approval */
export const MOCK_APPROVAL_GATE: ShowcaseApprovalGate = {
  kind: "manuscript-approval",
  title: "正文审批 · 第七章",
  badge: "人工门禁",
  bodyMarkdown: `本章节已完成专业审校与定向修订,进入正文审批环节。审校共发现 4 项问题(1 阻断 / 1 主要 / 2 警告),其中阻断项「密信封蜡颜色矛盾」已在修订阶段修复。

剩余警告项(气味通用化、配角语气偏差)经评估可在后续章节统一处理,不阻断本章定稿。

请逐段确认正文变更,或退回修订阶段重写。`,
  stats: [
    { label: "段落总数", value: "23" },
    { label: "字符数", value: "4,827" },
    { label: "待应用变更", value: "5" },
    { label: "修订轮次", value: "2" },
  ],
};

/** 蓝图审批 mock(展示三种门禁差异化,可在切换时使用) */
export const MOCK_BLUEPRINT_GATE: ShowcaseApprovalGate = {
  kind: "blueprint-approval",
  title: "蓝图审批 · 第七章",
  badge: "人工门禁",
  bodyMarkdown: `## 章节目标

主角在港口仓库发现密信,被迫在揭穿与隐忍之间做出选择。

## 节拍

1. **行动**:主角潜入仓库取货 — **情绪**:紧张 — **结果**:发现额外密信
2. **行动**:走私者突袭 — **情绪**:惊愕 — **结果**:被迫对峙
3. **行动**:主角选择隐忍 — **情绪**:屈辱 — **结果**:密信留存,埋下伏笔

## 章尾驱动力

密信上的家徽半印,指向主角家族旧案。

## 禁止事项

- 不可让主角直接揭穿(破坏长线悬念)
- 不可引入新 POV 角色`,
};

/** 事实审批 mock */
export const MOCK_FACT_GATE: ShowcaseApprovalGate = {
  kind: "fact-approval",
  title: "事实审批 · 第七章",
  badge: "人工门禁",
  bodyMarkdown: `本章正文已提取 6 项事实变更,其中 2 项安全项已自动采纳,4 项待人工审批。冲突项(密信封蜡颜色)需特别处理。`,
  factList: [
    { id: "f1", field: "entities.character[走私者].location", value: "港口仓库", risk: "safe", status: "accepted", conflict: false },
    { id: "f2", field: "entities.item[密信].sealColor", value: "黑色(修订后)", risk: "safe", status: "accepted", conflict: false },
    { id: "f3", field: "relations[主角-家族旧案].stance", value: "suspected", risk: "high", status: "pending", conflict: false },
    { id: "f4", field: "timelineEvents[第七章].narrativeOrder", value: "7", risk: "safe", status: "pending", conflict: false },
    { id: "f5", field: "entities.character[走私者].demeanor", value: "急躁(本章)→ 待统一", risk: "high", status: "pending", conflict: false },
    { id: "f6", field: "foreshadowing[家徽半印].payoffChapter", value: "未设定", risk: "safe", status: "pending", conflict: false },
  ],
};

/** 阶段化事件(mock — 已完成阶段的事件聚合) */
export const MOCK_STAGE_EVENTS: ShowcaseStageEvent[] = [
  {
    stage: "context",
    stageLabel: "冻结上下文",
    categoryColor: "var(--ws-accent-context)",
    eventCount: 3,
    artifactCount: 1,
    durationLabel: "12 秒",
    events: [
      { id: "e1", icon: "›", label: "上下文包已编译", summary: "从对话线程编译历史 context packet,冻结 5 个 skill 引用。", timeLabel: "00:00:03" },
      { id: "e2", icon: "›", label: "skill 解析完成", summary: "本章启用 style-specificity-audit / continuity-audit 等 5 项 skill。", timeLabel: "00:00:08" },
      { id: "e3", icon: "»", label: "上下文产物就绪", summary: "context-packet 产物已写入,可进入蓝图生成。", timeLabel: "00:00:12" },
    ],
  },
  {
    stage: "blueprint",
    stageLabel: "生成蓝图",
    categoryColor: "var(--ws-accent-creation)",
    eventCount: 5,
    artifactCount: 1,
    durationLabel: "1 分 48 秒",
    events: [
      { id: "e4", icon: "›", label: "蓝图初稿生成", summary: "基于上下文生成 ChapterBlueprint,含 3 节拍 + 章尾驱动力。", timeLabel: "00:00:45" },
      { id: "e5", icon: "!", label: "blueprint-audit 发现 1 项主要问题", summary: "节拍 2 缺少情绪转折,需迭代重生成。", timeLabel: "00:01:02" },
      { id: "e6", icon: "›", label: "蓝图第 2 轮迭代", summary: "补充节拍 2 情绪转折:惊愕 → 屈辱。", timeLabel: "00:01:30" },
      { id: "e7", icon: "✓", label: "blueprint-audit 通过", summary: "本轮 audit 无 blocker / major,蓝图可进入审批。", timeLabel: "00:01:48" },
    ],
  },
  {
    stage: "review",
    stageLabel: "专业审校",
    categoryColor: "var(--ws-accent-quality)",
    eventCount: 7,
    artifactCount: 1,
    durationLabel: "2 分 11 秒",
    events: [
      { id: "e8", icon: "›", label: "5 个 reviewer 并行启动", summary: "风格 / 人物 / 连续性 / 情节 / 读者审校任务全部派发。", timeLabel: "00:05:12" },
      { id: "e9", icon: "✓", label: "风格审校完成", summary: "得分 3.8,发现 2 项 warning(气味通用化、声口偏差)。", timeLabel: "00:06:20" },
      { id: "e10", icon: "!", label: "连续性审校发现阻断项", summary: "密信封蜡颜色与第五章矛盾,标记为 blocker。", timeLabel: "00:06:45" },
      { id: "e11", icon: "✓", label: "prose-audit 元审核完成", summary: "汇总 4 项 issue(1 blocker / 1 major / 2 warning),加权分 3.85。", timeLabel: "00:07:23" },
    ],
  },
  {
    stage: "revision",
    stageLabel: "定向修订",
    categoryColor: "var(--ws-accent-quality)",
    eventCount: 4,
    artifactCount: 1,
    durationLabel: "1 分 36 秒",
    events: [
      { id: "e12", icon: "›", label: "修订窗口规划", summary: "为 4 项 issue 定位 3 个段落窗口,排除 blocker 外的轻量项。", timeLabel: "00:08:00" },
      { id: "e13", icon: "✓", label: "阻断项已修复", summary: "密信封蜡颜色统一为黑色,与第五章一致。", timeLabel: "00:08:42" },
      { id: "e14", icon: "✓", label: "修订稿生成", summary: "替换 3 个窗口片段,字数变化 +24 / -18。", timeLabel: "00:09:36" },
    ],
  },
];

/** 学习闭环 mock — Craft Rule 候选与 skill 迭代 */
export const MOCK_LEARNING: ShowcaseLearning[] = [
  {
    id: "l1",
    status: "completed",
    conclusion: "propose-improvement",
    skillName: "style-specificity-audit",
    skillVersion: "v2.3 → v2.4",
    underlyingMechanism: "审校 skill 对「通用感官描写」的判定阈值偏高,导致已重复 4 次的「潮湿气味」未被标为 blocker。机制:相似度比对窗口只看相邻 3 章,应扩展到全本。",
    affectedInputClass: "跨章节重复的感官锚点描写(气味/触感/光线)",
  },
  {
    id: "l2",
    status: "pending",
    conclusion: "regression-required",
    skillName: "continuity-audit",
    skillVersion: "v1.8 → v1.9",
    underlyingMechanism: "实体属性矛盾检测依赖 fact-delta 表的 subject.id 匹配,当描写用代词指代实体时(「信」而非「密信」)会漏检。机制:指代消融未接入 continuity-audit 的实体绑定流程。",
    affectedInputClass: "使用代词或简称指代已建立实体的属性描写",
  },
  {
    id: "l3",
    status: "completed",
    conclusion: "propose-improvement",
    skillName: "serial-rhythm",
    skillVersion: "v3.1 → v3.2",
    underlyingMechanism: "对话节奏检测对「连续三句直接陈述」的判定规则只看句型,未考虑对话间的动作穿插。机制:节奏判定应允许「对话 + 动作 + 对话」结构视为有变化。",
    affectedInputClass: "含动作穿插的连续对话段落",
  },
  {
    id: "l4",
    status: "failed",
    conclusion: "no-action",
    skillName: "character-voice",
    skillVersion: "v2.0(保持)",
    underlyingMechanism: "配角语气偏差未达到 skill 迭代阈值,本次审校经验已写入 chapter memory,不触发 skill 改进。",
    affectedInputClass: "单次出现的配角语气轻微偏差",
  },
];
