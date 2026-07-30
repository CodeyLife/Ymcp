import type { Artifact, ExecutionBlueprint, MemoryBundle, NovelIntent, SkillBundle, StagePromptPackage } from "../protocol";
import { matchedFacetsOf } from "../cognition";
import type { ChapterPlanningContext } from "../application/story-arc";
import { renderChapterPlanningContext } from "./chapter-planning-context";
import { buildBlueprintSummary } from "./chapter-review";
import {
  WRITER_DIALOGUE_AND_DETAIL,
  WRITER_FINAL_CHECK,
  WRITER_GENERATION_SELF_CHECK,
  WRITER_HARD_CONSTRAINTS,
  WRITER_LANGUAGE_AND_LENGTH,
  WRITER_LONGFORM_AXIS,
  WRITER_PACING_AND_LONGFORM_RESERVE,
  WRITER_SCENE_AND_CHARACTER,
} from "./writer-rules";
import { compileStageContext } from "../stage-context";

/**
 * 章尾形态：与 WRITER_CHAPTER_ENDING_HOOKS 等价但精简为单一段落。
 * 完整十型参考见 writer-rules.ts。
 */
const WRITER_CHAPTER_ENDING_FORM = `章尾形态服从已批准蓝图、本章主导功能和连续章节节奏。悬疑、行动或转折章可以落在未解信息、行动方向、代价、关系裂痕或新压力上；关系、生活流、铺陈、余波或阶段闭合章也可以停在未尽交流、状态变化、哲思或有功能的情感与意象余韵。判断章尾是否成立，看它是否完成本章体验并让既有长线仍有真实动力，而不是看它是否包含问号、突发事件或固定钩子。不得为了立即翻页冲动新增蓝图之外的人物、危险、选择或信息，也不要连续多章重复同一种收束形态。`;

/**
 * V2 章节正文写作 prompt 构造器。
 *
 * 与 v1 [prose-prompts.ts] 的 buildChapterDraftPrompt 等价，但参数化为 v2 数据结构：
 * - blueprint: ExecutionBlueprint（替代 v1 ChapterBlueprint）
 * - memory: MemoryBundle（替代 v1 冻结上下文 contextMarkdown）
 * - skills: SkillBundle（替代 v1 skills prompt section）
 *
 * 写作硬约束常量从 [writer-rules.ts] 引入，跨场景复用。
 */

export interface DraftPromptInput {
  intent: NovelIntent;
  blueprint: ExecutionBlueprint;
  memory: MemoryBundle;
  skills: SkillBundle;
  /**
   * P0-B2 修复（2026-07-27）：前章爽点统计，用于事前预防干旱。
   *
   * 设计依据：迁移脚本 007 声明"用途 #1 蓝图编译时提示干旱"未实现，Phase 3.2 闭环未闭合。
   * 由 draft activity 调用 repository.getRecentPayoffStats 获取，注入 prompt 让 writer
   * 感知前章爽点分布，在章功能允许时主动安排爽点，而非只靠 reader-reviewer 事后检测。
   * 可选——首章或前 5 章无数据时省略。
   */
  payoffStats?: {
    recentChapters: Array<{ narrativeOrder: number; payoffCount: number; maxIntensity: number; totalIntensity: number; types: string[] }>;
    consecutiveNoPayoff: number;
    totalPayoffs: number;
    byType: Record<string, number>;
  };
  /**
   * P1-D1 修复（2026-07-27）：POV 角色信息，让 writer 知道具体视角角色。
   *
   * 设计依据：旧 prompt 只有抽象提示"视角知识边界"，但不知道具体是哪个角色，
   * 提示基本无效。povCharacterId 让 writer 能结合 MemoryBundle 中该角色的 knowledgeScope
   * claim 自觉约束信息流。
   */
  povCharacterId?: string;
  /**
   * 全书规划上下文:foundation artifacts(架构/人物/世界观/章节计划等)。
   *
   * 设计依据:AGENTS.md「root-cause analysis」——v2 重构后 foundation artifacts 未被章节生成
   * 消费,导致章节生成不基于全书规划。此字段把全书规划产出注入到章节生成 prompt,让 writer
   * 在写章节正文时遵守架构布局、人物档案、世界观规则、plot 设计与本章蓝图。
   *
   * 由 novelIntentWorkflow 调用 listFoundationArtifacts activity 加载,透传到 draft activity。
   * 可选——planning/foundation 任务本身不消费规划产出(它们是规划产出)。
   */
  foundationArtifacts?: Artifact[];
  planningContext?: ChapterPlanningContext;
  /** Build only the stable writing contract; dynamic sources are compiled as separate sections. */
  instructionsOnly?: boolean;
}

function bulletList(items: string[], empty: string): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
}

/**
 * 从 foundation artifact 的 taskId 中提取 taskKey。
 *
 * foundation artifact 的 taskId 格式为 `${workItemId}:foundation`,workItemId 中包含 taskKey
 * (来自 bootstrap_run 的 taskChain)。但 workItemId 本身可能是 UUID 或 taskKey 字符串,
 * 无法稳定解析。因此改用 structuredData 中的 taskKey 字段(由 generateFoundationWork 写入),
 * 若不存在则 fallback 到 taskId。
 */
function extractTaskKey(artifact: Artifact): string {
  const structured = artifact.structuredData as { taskKey?: string } | undefined;
  if (structured?.taskKey && typeof structured.taskKey === "string") return structured.taskKey;
  // fallback:尝试从 taskId 解析(格式可能是 `${taskKey}:foundation` 或 `${workItemId}:foundation`)
  const parts = artifact.taskId.split(":");
  return parts.length > 1 ? parts[0] : artifact.taskId;
}

/**
 * 把 foundation artifacts 转换为全书规划上下文 markdown。
 *
 * 设计依据:AGENTS.md「root-cause analysis」——v2 重构后 foundation artifacts 未被章节生成
 * 消费,导致章节生成不基于全书规划。此函数把全书规划产出(架构/人物/世界观/plot/章节计划)
 * 渲染为 markdown,注入章节生成 prompt,让 writer 遵守规划约束。
 *
 * 渲染策略:
 * - 必填 taskKey(architecture/characters/worldview/plot-design/chapter-plan)单独成段,标注必读
 * - 其余 taskKey(relations/plot-threads/foreshadowing/timeline/story-control/project-positioning)
 *   合并为"其他规划参考"段,作为软约束
 * - 每个 artifact 从 structuredData 提取关键信息做防御性解构,避免 schema 演进导致崩溃
 * - 若 structuredData 为空,fallback 到 artifact 的 summary 字段(若存在)
 *
 * AGENTS.md 合规:不内置题材/角色 fixture,只渲染通用结构化数据。
 */
function buildFoundationContextMarkdown(foundationArtifacts: Artifact[]): string {
  if (!foundationArtifacts.length) return "- 暂无全书规划产出(本项目可能未运行 novel_bootstrap_run)。";

  // 按 taskKey 分组(同 taskKey 可能有多条,取最新即最后一条——listFoundationArtifacts 按 created_at ASC 返回)
  const byTaskKey = new Map<string, Artifact>();
  for (const artifact of foundationArtifacts) {
    byTaskKey.set(extractTaskKey(artifact), artifact);
  }

  const requiredKeys = ["architecture", "characters", "worldview", "plot-design", "chapter-plan"];
  const referenceKeys = ["project-positioning", "relations", "plot-threads", "foreshadowing", "timeline", "story-control"];

  const sections: string[] = [];

  // 必填段:单独成段,标注必读
  for (const key of requiredKeys) {
    const artifact = byTaskKey.get(key);
    if (!artifact) continue; // 缺失项由 workflow 前置检查拦截,此处不重复警告
    const structured = artifact.structuredData as Record<string, unknown> | undefined;
    const summary = typeof structured?.summary === "string" ? structured.summary : undefined;
    const title = typeof structured?.title === "string" ? structured.title : key;
    // 提取该 taskKey 的核心字段(基于 foundation.ts 的 structuredDataHint)
    const fields = renderFoundationFields(key, structured);
    sections.push(`### [必读] ${key}：${title}`);
    if (summary) sections.push(summary);
    if (fields) sections.push(fields);
    if (structured?.origin === "web-author-edit" && Array.isArray(structured.sections)) {
      const authorSections = structured.sections.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const section = value as Record<string, unknown>;
        const heading = typeof section.heading === "string" ? section.heading : "";
        const content = typeof section.content === "string" ? section.content : "";
        return heading && content ? [`#### ${heading}\n${content}`] : [];
      });
      if (authorSections.length) {
        sections.push("#### 作者当前修订（优先于本产物中的旧结构化描述）");
        sections.push(authorSections.join("\n\n"));
      }
    }
    sections.push("");
  }

  // 参考段:合并为"其他规划参考"
  const referenceArtifacts = referenceKeys.map((key) => byTaskKey.get(key)).filter((a): a is Artifact => a !== undefined);
  if (referenceArtifacts.length) {
    sections.push("### 其他规划参考(软约束,遵守但可灵活处理)");
    for (const artifact of referenceArtifacts) {
      const key = extractTaskKey(artifact);
      const structured = artifact.structuredData as Record<string, unknown> | undefined;
      const summary = typeof structured?.summary === "string" ? structured.summary : undefined;
      const title = typeof structured?.title === "string" ? structured.title : key;
      sections.push(`- ${key}：${title}${summary ? ` —— ${summary}` : ""}`);
    }
  }

  return sections.length ? sections.join("\n") : "- 全书规划产出为空。";
}

/**
 * 按 taskKey 渲染 foundation artifact 的核心字段。
 *
 * 防御性解构:从 structuredData 提取关键字段并格式化为 markdown 列表。
 * 若字段缺失或类型不匹配,跳过该项(不报错),保证 prompt 不会因 schema 演进而崩溃。
 */
function renderFoundationFields(taskKey: string, structured: Record<string, unknown> | undefined): string {
  if (!structured) return "";
  const lines: string[] = [];

  const pushString = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) lines.push(`- ${label}：${value.trim()}`);
  };
  const pushArray = (label: string, value: unknown) => {
    if (Array.isArray(value) && value.length) {
      const items = value.map((item) => typeof item === "string" ? item : JSON.stringify(item));
      lines.push(`- ${label}：${items.join("、")}`);
    }
  };

  switch (taskKey) {
    case "architecture": {
      const arch = structured.architecture as Record<string, unknown> | undefined;
      pushString("叙事结构", arch?.structure);
      pushString("视角策略", arch?.povStrategy);
      pushString("时间跨度", arch?.timeSpan);
      if (Array.isArray(arch?.volumes) && arch.volumes.length) {
        const volumes = arch.volumes.map((v) => {
          const vol = v as Record<string, unknown>;
          return `${vol.name ?? "?"}(${vol.function ?? "?"})`;
        });
        lines.push(`- 卷划分：${volumes.join("、")}`);
      }
      break;
    }
    case "characters": {
      const chars = structured.characters as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(chars) && chars.length) {
        for (const char of chars) {
          const name = typeof char.name === "string" ? char.name : char.id ?? "?";
          const role = typeof char.role === "string" ? char.role : "";
          const motivation = typeof char.motivation === "string" ? char.motivation : "";
          lines.push(`- ${name}${role ? `(${role})` : ""}${motivation ? `：${motivation}` : ""}`);
        }
      }
      break;
    }
    case "worldview": {
      const world = structured.worldview as Record<string, unknown> | undefined;
      pushArray("规则与禁忌", world?.rules);
      if (Array.isArray(world?.factions) && world.factions.length) {
        const factions = world.factions.map((f) => {
          const fac = f as Record<string, unknown>;
          return fac.name ?? "?";
        });
        lines.push(`- 主要势力：${factions.join("、")}`);
      }
      break;
    }
    case "plot-design": {
      const plot = structured.plotDesign as Record<string, unknown> | undefined;
      const opening = plot?.opening as Record<string, unknown> | undefined;
      const climax = plot?.climax as Record<string, unknown> | undefined;
      const ending = plot?.ending as Record<string, unknown> | undefined;
      if (opening && typeof opening.function === "string") lines.push(`- 开篇：${opening.function}`);
      if (climax && typeof climax.position === "string") lines.push(`- 高潮：${climax.position}`);
      if (ending && typeof ending.type === "string") lines.push(`- 结局：${ending.type}`);
      break;
    }
    case "chapter-plan": {
      const chapters = structured.chapters as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(chapters) && chapters.length) {
        // 只渲染前 5 章,避免 prompt 过长;完整章节计划在 blueprint 中
        const top5 = chapters.slice(0, 5);
        for (const ch of top5) {
          const index = typeof ch.index === "number" ? ch.index : "?";
          const title = typeof ch.title === "string" ? ch.title : "";
          const summary = typeof ch.summary === "string" ? ch.summary : "";
          const func = typeof ch.function === "string" ? ch.function : "";
          lines.push(`- 第${index}章 ${title}${func ? `[${func}]` : ""}${summary ? `：${summary}` : ""}`);
        }
        if (chapters.length > 5) lines.push(`- ...(共 ${chapters.length} 章,此处只列前 5 章)`);
      }
      break;
    }
    default:
      break;
  }

  return lines.length ? lines.join("\n") : "";
}

/**
 * 把 MemoryBundle 转换为冻结上下文 markdown。
 *
 * claims 按 authority 排序：approved > author > derived > candidate。
 * 每个 claim 包含 title/content/subjectRefs/kind/reason。
 *
 * Phase 3.1: 未兑现伏笔/承诺（matchedFacet=foreshadowing 且 reason 含 injection）
 * 单独高亮在顶部，提醒 LLM 本章是否应兑现。
 *
 * P1-5: 已兑现伏笔（reason 含 `[resolved-at:N]` 标记，由 retrieveMemoryForReview 注入）
 * 单独渲染为"已兑现伏笔"段，加"【已兑现于第 N 章】"前缀，让 writer 知道该伏笔已回收，
 * 不再当作未兑现线索处理。
 */
function buildContextMarkdown(memory: MemoryBundle): string {
  if (!memory.claims.length) return "- 暂无冻结记忆。本章节为项目首批创作。";
  const authorityOrder: Record<string, number> = { approved: 0, author: 1, derived: 2, candidate: 3 };

  // P1-5: 识别已兑现伏笔（reason 含 [resolved-at:N] 标记）
  const resolvedMarkerRegex = /\[resolved-at:(\d+)\]/u;
  const isResolved = (reason: string | undefined): boolean => !!reason && resolvedMarkerRegex.test(reason);
  const extractResolvedAt = (reason: string | undefined): number | null => {
    const match = reason?.match(resolvedMarkerRegex);
    return match ? Number(match[1]) : null;
  };

  // Phase 3.1: 分离未兑现伏笔/承诺（由 retrieveMemory activity 注入，且未标记 resolved）
  const openNarratives = memory.claims.filter((claim) =>
    matchedFacetsOf(claim).includes("foreshadowing")
    && claim.reason?.includes("injection")
    && !isResolved(claim.reason),
  );
  // P1-5: 分离已兑现伏笔
  const resolvedNarratives = memory.claims.filter((claim) =>
    matchedFacetsOf(claim).includes("foreshadowing")
    && isResolved(claim.reason),
  );
  const otherClaims = memory.claims.filter((claim) =>
    !(matchedFacetsOf(claim).includes("foreshadowing") && claim.reason?.includes("injection"))
    && !isResolved(claim.reason),
  );

  const sections: string[] = [];

  // 未兑现伏笔/承诺高亮段
  if (openNarratives.length) {
    sections.push("### 未兑现伏笔与承诺（高优先级，本章可考虑兑现）");
    const narrativeLines = openNarratives.map((claim) => {
      const subjects = claim.subjectRefs.length ? `[${claim.subjectRefs.join(",")}]` : "[未绑定主体]";
      return `- [${claim.authority}/${claim.kind}] ${subjects} ${claim.title}：${claim.content}`;
    });
    sections.push(narrativeLines.join("\n"));
    sections.push(""); // 空行分隔
  }

  // P1-5: 已兑现伏笔段（让 writer 知道这些伏笔已回收，不再当作未兑现线索）
  if (resolvedNarratives.length) {
    sections.push("### 已兑现伏笔（参考，不要再兑现）");
    const resolvedLines = resolvedNarratives.map((claim) => {
      const subjects = claim.subjectRefs.length ? `[${claim.subjectRefs.join(",")}]` : "[未绑定主体]";
      const resolvedAt = extractResolvedAt(claim.reason);
      const prefix = resolvedAt !== null ? `【已兑现于第 ${resolvedAt} 章】` : "【已兑现】";
      return `- ${prefix} [${claim.authority}/${claim.kind}] ${subjects} ${claim.title}：${claim.content}`;
    });
    sections.push(resolvedLines.join("\n"));
    sections.push(""); // 空行分隔
  }

  // 常规 claims
  if (otherClaims.length) {
    const sorted = [...otherClaims].sort((a, b) => (authorityOrder[a.authority] ?? 99) - (authorityOrder[b.authority] ?? 99));
    const lines = sorted.map((claim) => {
      const subjects = claim.subjectRefs.length ? `[${claim.subjectRefs.join(",")}]` : "[未绑定主体]";
      return `- [${claim.authority}/${claim.kind}] ${subjects} ${claim.title}：${claim.content}`;
    });
    sections.push(lines.join("\n"));
  }

  return sections.length ? sections.join("\n") : "- 暂无冻结记忆。本章节为项目首批创作。";
}

/**
 * 从 intent.objective + blueprint.tasks 中提取必须发生与禁止事项。
 *
 * v2 没有 v1 的 mustHappen/forbidden 字段——从 intent.constraints 中提取。
 */
function extractMustHappenAndForbidden(intent: NovelIntent): { mustHappen: string[]; forbidden: string[] } {
  const constraints = intent.constraints ?? [];
  const mustHappen = constraints.filter((item) => /^(必须|需要|应当|要求)/u.test(item)).map((item) => item.replace(/^(必须|需要|应当|要求)[：:]?\s*/u, ""));
  const forbidden = constraints.filter((item) => /^(禁止|不得|不允许|切勿)/u.test(item)).map((item) => item.replace(/^(禁止|不得|不允许|切勿)[：:]?\s*/u, ""));
  return { mustHappen, forbidden };
}

/**
 * P1-4: 构建前章爽点干旱提示 markdown（相对信号 + 软提示）。
 *
 * 设计依据：AGENTS.md「Do not tune thresholds solely until one known sample passes」+
 * 「root-cause analysis」——原实现用硬阈值"连续 3 章无爽点""干旱不宜超过 5 章"，是 case-specific
 * rule：不同题材节奏下（仙侠慢热 vs 都市快节奏）同一阈值意义不同，且阈值本身无理论依据，
 * 只是调到某个失败样本通过。
 *
 * 根因：爽点干旱的严重性是相对信号，取决于该书历史爽点节奏，而非绝对章数。改为：
 *   1. 从 recentChapters 计算平均爽点间隔 M（有爽点章数 / 总章数的倒数）
 *   2. 用 consecutiveNoPayoff 作为当前连续无爽点章数 N
 *   3. 仅当 N > M 时注入"干旱提示"（相对信号，N ≤ M 时不注入，避免噪音）
 *   4. 提示文案是软提示（"若本章功能允许，考虑安排"），不是硬指令
 *
 * 平均间隔 M 的计算：
 * - recentChapters 中 payoffCount > 0 的章数 = 有爽点章数 P
 * - recentChapters 总章数 = W（通常 5）
 * - 平均间隔 M = W / P（每 P 章有一个爽点 → 间隔约 W/P 章）
 * - 若 P = 0（窗口内全无爽点），M = Infinity（极端干旱，必注入提示）
 *
 * 不内置任何题材阈值——"3 章/5 章"由该书自己的历史节奏决定。
 */
function buildPayoffDroughtMarkdown(stats: NonNullable<DraftPromptInput["payoffStats"]>): string {
  if (!stats.recentChapters.length && stats.consecutiveNoPayoff === 0) {
    return "- 暂无前章爽点数据（首章或前 5 章无记录），无需考虑干旱。";
  }
  const lines: string[] = [];
  lines.push(`- 最近 ${stats.recentChapters.length} 章爽点总数：${stats.totalPayoffs}`);
  lines.push(`- 当前连续无爽点章数：${stats.consecutiveNoPayoff}`);
  if (stats.recentChapters.length) {
    lines.push("- 前章爽点分布：");
    for (const ch of stats.recentChapters) {
      lines.push(`  - 第 ${ch.narrativeOrder} 章：${ch.payoffCount} 个爽点，最高强度 ${ch.maxIntensity}，类型 ${ch.types.join("/") || "无"}`);
    }
  }
  const allTypes = ["achievement", "recognition", "reversal", "emotional", "mystery"];
  const missing = allTypes.filter((t) => !stats.byType[t]);
  if (missing.length && stats.totalPayoffs > 0) {
    lines.push(`- 最近 ${stats.recentChapters.length} 章未出现的爽点类型：${missing.join("、")}（仅供参考，不要求每章机械出现）`);
  }

  // P1-4: 相对信号计算——平均爽点间隔 M vs 当前连续无爽点章数 N
  const windowSize = stats.recentChapters.length;
  const paidChapters = stats.recentChapters.filter((ch) => ch.payoffCount > 0).length;
  // 平均间隔 M：每有爽点章数对应多少章。P=0 时 M=Infinity（窗口内全无爽点，极端干旱）。
  const avgInterval = paidChapters > 0 ? windowSize / paidChapters : Infinity;
  const N = stats.consecutiveNoPayoff;

  // 仅当 N > M 时注入干旱提示（相对信号，避免在正常节奏下产生噪音）
  // 特例：M=Infinity（窗口内全无爽点）且 N >= 2 时也注入（说明该书近期完全无爽点反馈）
  const isExtremeDrought = !Number.isFinite(avgInterval);
  const shouldSignalDrought = N > avgInterval || (isExtremeDrought && N >= 2);
  if (shouldSignalDrought) {
    const intervalDesc = isExtremeDrought
      ? `最近 ${windowSize} 章完全无爽点记录`
      : `最近 ${windowSize} 章的平均爽点间隔约 ${avgInterval.toFixed(1)} 章`;
    lines.push(
      `- ⚠️ 当前已连续 ${N} 章未出现爽点（${intervalDesc}）。这是相对信号，非绝对阈值——若本章蓝图功能不要求爽点（如铺陈/相处/余波章），可忽略此信号；若本章功能允许（如行动/转折/阶段闭合/兑现章），考虑安排一次小体量爽点以维持读者追更动力。爽点可以是任意类型（成就/认可/反转/情感/悬疑），关键是读者是否获得正向反馈。`,
    );
  }
  return lines.join("\n");
}

/**
 * 构建 V2 章节正文写作 prompt。
 */
export function buildChapterDraftPrompt(input: DraftPromptInput): string {
  const { intent, blueprint, memory, skills, payoffStats, povCharacterId, foundationArtifacts, planningContext } = input;
  // P1-6: 使用公共 buildBlueprintSummary，与 review/reflection 对齐字段集
  // （含章节功能、章尾驱动力、情绪走向），让 writer 看到与 reviewer 相同的蓝图上下文。
  const blueprintMarkdown = buildBlueprintSummary(blueprint, planningContext);
  const contextMarkdown = buildContextMarkdown(memory);
  const { mustHappen, forbidden } = extractMustHappenAndForbidden(intent);
  const skillSections = skills.skills.length
    ? skills.skills.map((skill) => [`### ${skill.skillId}@${skill.version}`, `gates=${skill.qualityGates.join(",")}`, skill.promptSections.drafting ?? ""].filter(Boolean).join("\n")).join("\n\n")
    : "- 无激活技能。";

  const sections: string[] = [
    `只输出一份连续章节正文，不要解释，不要输出标题、代码围栏、指令包装或 Markdown 格式标记。`,
    "",
    WRITER_HARD_CONSTRAINTS,
    "",
    WRITER_LONGFORM_AXIS,
    "",
  ];

  // P1-D1: 注入 POV 角色信息，让 writer 知道具体视角角色
  if (povCharacterId) {
    sections.push(
      `## POV 视角角色\n本章以「${povCharacterId}」为视角人物。自觉约束信息流：该角色不应知道他不在场的事件、他人的内心想法、或他在当前时间点尚未获知的秘密。冻结上下文中 knowledgeScope 标记为该角色的 claim 是他已知晓的事；其他角色的 knowledgeScope claim 不得通过叙述泄露给视角角色，除非正文明确呈现告知场景。`,
      "",
    );
  }

  sections.push(
    `## 本章允许兑现且必须发生\n以下条目是正文完成后的验收条件，不是要在节拍之外再写一次的附加场景。同一结果若同时出现在条目、蓝图节拍和章尾落点中，只兑现一次；以时机和方式最具体的蓝图安排为准，其余位置只负责铺垫，不得提前完整演出。\n${bulletList(mustHappen, "无额外硬性节拍")}`,
    "",
    `## 禁止事项\n${bulletList(forbidden, "无额外禁止事项")}`,
    "",
    WRITER_SCENE_AND_CHARACTER,
    "",
    WRITER_DIALOGUE_AND_DETAIL,
    "",
    WRITER_PACING_AND_LONGFORM_RESERVE,
    "",
    `## 章尾形态\n${WRITER_CHAPTER_ENDING_FORM}`,
    "",
    WRITER_LANGUAGE_AND_LENGTH,
    "",
  );

  if (input.instructionsOnly) {
    sections.push(
      `## 本章意图\n- 目标：${intent.objective}\n- 来源：${intent.source}\n- 时间戳：${new Date(intent.createdAt).toISOString()}`,
      "",
      WRITER_GENERATION_SELF_CHECK,
      "",
      WRITER_FINAL_CHECK,
    );
    return sections.join("\n");
  }

  // P0-B2: 注入前章爽点干旱提示，事前预防干旱
  if (payoffStats) {
    sections.push(
      `## 前章爽点统计（事前预防干旱）\n爽点类型：achievement=成就型、recognition=认可型、reversal=反转型、emotional=情感型、mystery=悬疑型。爽点不依赖金手指/系统流特化，任何题材都可有爽点。\n${buildPayoffDroughtMarkdown(payoffStats)}`,
      "",
    );
  }

  // 全书规划上下文:在已批准蓝图之前注入,让 writer 先理解全书规划再看本章蓝图。
  // 设计依据:AGENTS.md「root-cause analysis」——v2 重构后 foundation artifacts 未被章节生成消费,
  // 导致章节生成不基于全书规划。此段把全书规划产出注入 prompt,让 writer 遵守架构/人物/世界观约束。
  if (foundationArtifacts?.length) {
    sections.push(
      `## 全书规划上下文(必读约束)\n本章基于以下全书规划产出。遵守架构布局、人物档案、世界观规则、plot 设计与章节计划;不得违背已确立的设定。\n\n${buildFoundationContextMarkdown(foundationArtifacts)}`,
      "",
    );
  }

  if (planningContext) {
    sections.push(renderChapterPlanningContext(planningContext), "");
  }

  sections.push(
    `## 工作流执行编排（不是内容蓝图）\n${blueprintMarkdown}`,
    "",
    `## 冻结上下文\n${contextMarkdown}`,
    "",
    `## 激活技能与质量门\n${skillSections}`,
    "",
    `## 本章意图\n- 目标：${intent.objective}\n- 来源：${intent.source}\n- 时间戳：${new Date(intent.createdAt).toISOString()}`,
    "",
    WRITER_GENERATION_SELF_CHECK,
    "",
    WRITER_FINAL_CHECK,
  );

  return sections.join("\n");
}

export function dedupeDraftMemory(input: DraftPromptInput): MemoryBundle {
  const directArtifactIds = new Set((input.foundationArtifacts ?? []).map((artifact) => artifact.id));
  if (!directArtifactIds.size) return input.memory;
  return {
    ...input.memory,
    id: `${input.memory.id}:without-direct-foundation`,
    claims: input.memory.claims.filter((claim) => !claim.sourceArtifactId || !directArtifactIds.has(claim.sourceArtifactId)),
  };
}

export function buildChapterDraftPromptPackage(input: DraftPromptInput & { workflowId: string; system: string }): StagePromptPackage {
  const memory = dedupeDraftMemory(input);
  const instruction = buildChapterDraftPrompt({ ...input, memory, foundationArtifacts: undefined, planningContext: undefined, payoffStats: undefined, instructionsOnly: true });
  const memoryPriority = (authority: MemoryBundle["claims"][number]["authority"]) => authority === "author" || authority === "approved" ? "required" as const : authority === "derived" ? "normal" as const : "soft" as const;
  return compileStageContext({
    projectId: input.intent.projectId,
    workflowId: input.workflowId,
    purpose: "writing.draft",
    stage: "drafting",
    system: input.system,
    maxInputTokens: input.blueprint.budget.maxInputTokens,
    reservedOutputTokens: input.blueprint.budget.maxOutputTokens,
    sections: [
      { id: "draft-instruction", kind: "goal", title: "章节创作目标与写作契约", text: instruction, priority: "critical", provenanceRefs: [input.intent.id] },
      ...((input.foundationArtifacts ?? []).map((artifact) => ({ id: `foundation:${artifact.id}`, kind: "planning" as const, title: `全书规划：${extractTaskKey(artifact)}`, text: buildFoundationContextMarkdown([artifact]), priority: "required" as const, provenanceRefs: [artifact.id], sourceArtifactId: artifact.id }))),
      ...(input.planningContext ? [{ id: "planning-context", kind: "planning" as const, title: "冻结章节规划上下文", text: renderChapterPlanningContext(input.planningContext), priority: "required" as const, provenanceRefs: [input.blueprint.id] }] : []),
      { id: "execution-blueprint", kind: "blueprint", title: "工作流执行编排", text: buildBlueprintSummary(input.blueprint, input.planningContext), priority: "required", provenanceRefs: [input.blueprint.id] },
      ...memory.claims.map((claim) => ({ id: `memory:${claim.id}`, kind: "fact" as const, title: `冻结事实：${claim.title}`, text: claim.content, priority: memoryPriority(claim.authority), provenanceRefs: [claim.id, ...(claim.sourceArtifactId ? [claim.sourceArtifactId] : []), ...claim.sourceRevisionIds] })),
      ...input.skills.skills.map((skill) => ({ id: `skill:${skill.skillId}`, kind: "skill" as const, title: `写作技能 ${skill.skillId}@${skill.version}`, text: [`gates=${skill.qualityGates.join(",")}`, skill.promptSections.drafting ?? ""].filter(Boolean).join("\n"), priority: "normal" as const, provenanceRefs: [`${skill.skillId}@${skill.version}`] })),
      ...(input.payoffStats ? [{ id: "payoff-stats", kind: "background" as const, title: "前章爽点统计", text: buildPayoffDroughtMarkdown(input.payoffStats), priority: "normal" as const, provenanceRefs: [input.intent.projectId] }] : []),
    ],
  });
}
