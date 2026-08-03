import type { MemoryBundle, ReviewIssue, SkillBundle, StageGoalContract, StagePromptPackage } from "../protocol";
import type { ChapterPlanningContext } from "../application/story-arc";
import { dedupeNarrativeRhythmMemory, renderChapterPlanningContext, renderExecutionMemoryClaim, renderNarrativeRhythm } from "./chapter-planning-context";
import { compileStageContext } from "../stage-context";

export interface RevisionWindow {
  start: number;
  end: number;
  issues: ReviewIssue[];
}

export interface TargetedRevisionReplacement {
  start: number;
  end: number;
  text: string;
}

/**
 * 前序修订尝试记录。用于打破修订循环：当同一章节经过多轮修订仍未改善时，
 * 将历史尝试注入提示词，让 LLM 知道哪些策略已经失败，避免重复。
 *
 * 根因：修订 LLM 每轮只看到当前稿 + 当前 issues，不知道前序尝试了什么、
 * 为什么失败。当质量回退导致 draft 和 issues 与上一轮完全相同时，
 * 提示词哈希相同 → LLM 返回相同响应 → 死循环。
 *
 * 修复：注入修订历史改变提示词内容（打破缓存循环），同时引导 LLM
 * 尝试不同策略（打破策略重复）。
 */
export interface RevisionAttempt {
  /** 修订轮次（1-based） */
  iteration: number;
  /** 修订结果 */
  outcome: "accepted" | "reverted-degradation" | "reverted-no-improvement";
  /** 本轮修订针对的 issue 标题列表 */
  targetedIssueTitles: string[];
  /** 基线综合分数（首轮修订时可能为 undefined，因为原始定稿未在本工作流中评分） */
  baselineScore?: number;
  /** 修订后综合分数（回退时为修订稿的分数，非基线分数） */
  revisedScore: number;
  /** 修订尝试的方向摘要（从 authorInstruction / issues 推导） */
  approachSummary: string;
}

export function splitChapterParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/u).map((paragraph) => paragraph.trim()).filter(Boolean);
}

/**
 * 清理修订 LLM 输出中的指令文本泄漏。
 *
 * 根因：部分修订模型在生成时会将 system prompt 或 instruction 中的
 * 指令结构回显到正文开头，例如短角色前缀、指令说明和冒号组成的非叙事行。
 * 这些前缀不是小说正文，必须剥离，否则会污染提交的章节文本。
 *
 * 清理策略（按顺序应用）：
 * 1. 剥离 Markdown 代码围栏（```...```）
 * 2. 逐行扫描开头：用结构化启发式判断是否为元注释/指令回显（而非精确短语匹配），
 *    跳过所有被判定为非正文的行，直到遇到第一个正文行
 * 3. 剥离残留的行内指令前缀
 * 4. 再次剥离可能因前缀清理暴露的 Markdown 围栏
 *
 * 设计原则：基于行的结构特征（长度、标点模式、冒号位置）判断是否为元注释，
 * 而非匹配特定短语。这样可跨 prompt、genre、指令措辞通用。
 * 如果无法确定前缀边界，保守地保留原文，避免误删正文。
 */

/**
 * 基于结构特征判断一行是否为元注释/指令回显，而非正文。
 *
 * 启发式规则（按优先级）：
 * - Markdown 标题行（# 开头）
 * - 短行以冒号结尾（元注释标题模式）
 * - 冒号分隔的短前缀且前缀不含叙事标点（指令回显模式）
 * - 极短行以句号结尾且不含叙事内容（角色确认模式）
 *
 * 这些规则基于元注释的通用结构形态，不依赖特定短语，
 * 因此可跨 prompt 版本、genre 和指令措辞复用。
 *
 * TODO P3: 阈值（30/18/10/5）基于经验校准，未来可提取为可配置参数。
 */
function isLikelyMetaAnnotation(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // Markdown 标题
  if (/^#{1,3}\s+\S/.test(trimmed)) return true;

  // 短行以冒号结尾（元注释标题：≤30 字符）
  if (trimmed.length <= 30 && /[:：]\s*$/.test(trimmed)) return true;

  // 冒号分隔的指令回显：前缀短且不含叙事标点（句号/感叹号/省略号/破折号）
  const colonMatch = trimmed.match(/^([^\n:：]{2,24})[:：]\s*(.*)$/);
  if (colonMatch) {
    const prefix = colonMatch[1];
    if (prefix.length <= 18 && !/[。！？…—]/.test(prefix)) return true;
  }

  // 极短确认行（≤10 字符，以句号结尾，无其他标点）
  if (trimmed.length <= 10 && /^[^\n。]{1,8}[。]$/.test(trimmed)) return true;

  return false;
}

export function sanitizeRevisionOutput(text: string): string {
  let cleaned = text;

  // 1. 剥离 Markdown 代码围栏
  cleaned = cleaned.replace(/^```[^\n]*\n?/u, "").replace(/\n?```\s*$/u, "");

  // 2. 逐行检查：用结构化启发式判断开头若干行是否为元注释
  const lines = cleaned.split("\n");
  let firstContentLineIndex = 0;
  const maxPrefixLines = Math.min(5, lines.length);
  for (let index = 0; index < maxPrefixLines; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      firstContentLineIndex = index + 1;
      continue;
    }
    if (isLikelyMetaAnnotation(line)) {
      firstContentLineIndex = index + 1;
      continue;
    }
    // 遇到第一个正文行，停止扫描
    break;
  }

  if (firstContentLineIndex > 0) {
    cleaned = lines.slice(firstContentLineIndex).join("\n").trimStart();
  }

  // 3. 剥离残留的行内指令前缀（冒号分隔的短前缀 + 空行/换行）
  cleaned = cleaned.replace(/^[^\n:：]{2,18}[:：]\s*\n?/u, "");

  // 4. 再次剥离可能因前缀清理暴露的 Markdown 围栏
  cleaned = cleaned.replace(/^```[^\n]*\n?/u, "").replace(/\n?```\s*$/u, "");

  return cleaned.trim();
}

function locatedRanges(issue: ReviewIssue, paragraphs: string[]): Array<{ start: number; end: number }> {
  if (issue.revisionRanges?.length) {
    return issue.revisionRanges
      .map((range) => ({ start: Math.max(0, range.start - 1), end: Math.min(paragraphs.length - 1, range.end - 1) }))
      .filter((range) => range.start <= range.end);
  }
  if (typeof issue.paragraph === "number" && issue.paragraph >= 1 && issue.paragraph <= paragraphs.length) {
    return [{ start: issue.paragraph - 1, end: issue.paragraph - 1 }];
  }
  const excerpt = issue.excerpt?.trim() || issue.evidence.trim();
  if (!excerpt) return [];
  const exact = paragraphs.findIndex((paragraph) => paragraph.includes(excerpt) || excerpt.includes(paragraph));
  if (exact >= 0) return [{ start: exact, end: exact }];
  const anchor = excerpt.slice(0, 32);
  const partial = paragraphs.findIndex((paragraph) => paragraph.includes(anchor));
  return partial >= 0 ? [{ start: partial, end: partial }] : [];
}

export function planRevisionWindows(text: string, issues: ReviewIssue[]): RevisionWindow[] {
  const paragraphs = splitChapterParagraphs(text);
  const candidates = issues.flatMap((issue) => locatedRanges(issue, paragraphs).map((range) => ({ ...range, issue })));
  candidates.sort((left, right) => left.start - right.start || left.end - right.end);
  const windows: RevisionWindow[] = [];
  for (const candidate of candidates) {
    const previous = windows.at(-1);
    if (previous && candidate.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, candidate.end);
      if (!previous.issues.includes(candidate.issue)) previous.issues.push(candidate.issue);
    } else {
      windows.push({ start: candidate.start, end: candidate.end, issues: [candidate.issue] });
    }
  }
  return windows;
}

export function revisionWindowsCoverAllIssues(windows: RevisionWindow[], issues: ReviewIssue[]): boolean {
  const covered = new Set(windows.flatMap((window) => window.issues));
  return issues.every((issue) => covered.has(issue));
}

export function shouldUseRevisionWindows(input: { requiresFullRevision: boolean; authorInstruction?: string }): boolean {
  return !input.requiresFullRevision;
}

function isContinuityIssue(issue: ReviewIssue): boolean {
  const haystack = [issue.dimension, issue.rule, issue.title].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes("continuity") || haystack.includes("连续性") || haystack.includes("一致性");
}

function formatIssues(issues: ReviewIssue[]): string {
  return issues.map((issue, index) => {
    const continuity = isContinuityIssue(issue);
    const typeLabel = continuity ? "一致性约束" : "待修复";
    const lines = [`${index + 1}. [${issue.severity}][${typeLabel}] ${issue.title}`];
    if (issue.dimension || issue.rule) {
      const labels = [issue.dimension && `维度=${issue.dimension}`, issue.rule && `规则=${issue.rule}`].filter(Boolean);
      lines.push(`结构标记：${labels.join("，")}`);
    }
    lines.push(
      `问题说明：${issue.description ?? issue.evidence}`,
      `原文证据：${issue.excerpt ?? issue.evidence}`,
      `修订要求：${issue.suggestion ?? "根据证据修复问题，同时保留原段承担的叙事功能。"}`,
    );
    if (issue.rewriteExample?.trim()) {
      lines.push(`审核者参考改写（仅供理解问题方向，不得直接搬用）：${issue.rewriteExample.trim()}`);
    }
    if (continuity) {
      lines.push(
        "⚠️ 一致性约束修订方向：此问题要求文本与已建立设定保持一致，不是更换为新值。",
        "真值确认流程（按优先级）：",
        "  1. 先从「事实与背景边界」中查找已冻结的设定值；",
        "  2. 再从规划上下文、前序章节摘要和记忆库中交叉验证；",
        "  3. 从原文本身的线索（如隐语、角色台词、刻字描写）推断最原始的值；",
        "  4. 若以上均无法确认，保持原文中当前使用的值不变，而非替换为审核者建议的值。",
        "⚠️ 重要警告：审核者描述的'已建立设定值'本身可能是错误的（审核者也可能幻觉）。",
        "  不得直接信任审核者给出的值——必须通过上述真值确认流程独立验证。",
        "  如果审核者说'恢复为X'，但你在事实边界和规划上下文中找不到X的任何记录，X可能是审核者的误判。",
        "不得创造新名称、新事实或新设定来「修复」一致性问题。",
      );
    }
    lines.push("执行边界：必须自行完成实际改写；审核者示例仅供审计，不作为候选正文输入。");
    return lines.join("\n");
  }).join("\n\n");
}

/**
 * 审核问题解读指引：桥接文学批评语言到具体修订动作。
 *
 * 根因：reviewer 用"POV越界""工具化""行动质地"等文学批评术语描述问题，
 * 但修订 LLM 需要从抽象批评推导出具体改法。尤其在窗口修订模式下，
 * LLM 只看到局部文本，更难理解批评背后的文本机制。
 *
 * 解决方案：在提示词中注入解读指引，帮助 LLM 将抽象批评翻译为具体文本机制，
 * 并根据 dimension 字段判断是局部措辞问题还是需要调整叙事策略。
 */
function renderRevisionInterpretationGuide(strictWindows: boolean): string {
  return [
    "审核者用文学批评术语（如「POV越界」「工具化」「行动质地」「叙事节奏」等）描述问题。",
    "修订时不要停留在术语层面，必须先将其翻译为具体的文本机制，再决定改法：",
    "1. 识别问题在原文中的具体表现：哪句话、哪个叙事选择、哪种信息承载方式导致了审核者的批评。",
    "2. 确定修复方向：不是消除批评标签，而是改变产生批评的文本机制。",
    "3. 结构标记中的维度(dimensions)标明问题类别，规则(rule)标明触发的具体规则——两者合在一起帮助你判断这是局部措辞问题还是需要调整叙事策略。",
    "",
    "常见维度→修订方向参考（非穷举，需结合原文判断）：",
    "- pov：检查叙事视角是否在不该切换处切换，或叙述距离是否与场景需要不匹配。",
    "- ensemble：检查次要角色是否只作为功能工具出现，缺少作为人的反应和存在感。",
    "- narrativePacing：检查信息密度、场景跳跃或情绪铺垫是否导致节奏失衡。",
    "- romance：检查关系变化是否有足够的过程和细节支撑，而非突然转折。",
    "- specificity：检查是否用了抽象概括替代具体可感的细节。",
    "- continuity/连续性：一致性约束问题。审核者给出的'已建立设定值'可能不准确（审核者也可能幻觉）。修订方向是独立验证正确值后统一文本，不是盲目采用审核者的值或创造新值。真值确认优先级：事实边界 > 规划上下文 > 原文线索 > 保持原值不变。",
    ...(strictWindows ? [
      "",
      "窗口修订特别注意：如果某个问题的根因不在当前窗口范围内（如 POV 越界可能是前文建立的叙述距离导致的），",
      "在窗口内做最大程度改善即可，不要强行在窗口内引入与前文矛盾的内容来「修复」问题。",
    ] : []),
  ].join("\n");
}

/**
 * 主题模式约束：桥接审核者修订建议与章节主题显隐模式。
 *
 * 根因：reviewer（尤其 plot-reviewer）在 suggestion 字段中可能使用"增加内心权衡"
 * "展示心理活动""内心戏"等直接心理叙述的表达。当章节主题模式为 subtext 时，
 * 这些建议与"只允许读者从行动、关系、世界反应和后果推断"的约束冲突，
 * 导致修订 LLM 写出解释性心理总结（如"这并非单纯的警告，而是一份可供他修正判断的参照"），
 * 被 style-reviewer 标记为"解释性心理总结剥夺推演空间"。
 *
 * 这是一个跨 reviewer 的语义冲突：plot-reviewer 要求状态变化证据，
 * style-reviewer 要求 subtext。两者本身不矛盾——状态变化可以通过可观察行为承载——
 * 但 reviewer 的 suggestion 用了"增加内心权衡"这样的心理叙述措辞，
 * 修订 LLM 照字面执行就违反了 subtext 约束。
 *
 * 解决方案：在 issues 之后注入主题模式约束，明确告诉 LLM 如何将涉及心理叙述的建议
 * 翻译为符合主题模式的可观察表达。这不是禁止解决原问题（状态变化仍需证据），
 * 而是改变承载方式（从心理叙述改为可观察行为）。
 *
 * 适用边界：仅在 thematicTreatment.mode 为 subtext 或 absent 时注入。
 * foreground 模式允许价值争执，不需要额外约束。
 */
function renderThemeModeConstraint(planningContext: ChapterPlanningContext | undefined): string {
  if (!planningContext) return "";
  const mode = planningContext.chapter.thematicTreatment?.mode;
  if (mode !== "subtext" && mode !== "absent") return "";

  const lines = [
    "## 主题模式约束（覆盖审核者建议中的冲突指令）",
    "",
    `本章主题显隐模式为 ${mode}。审核者的修订要求中可能包含"增加内心戏""展示心理活动""内心权衡"等直接心理叙述的表达。`,
    "这些表达与本章主题模式冲突时，按以下规则处理：",
  ];

  if (mode === "subtext") {
    lines.push(
      "- 不得通过作者式心理总结、内心独白或叙述者结论来展示人物认知变化。",
      `- 将「增加内心权衡/心理活动」的修订要求翻译为：通过动作停顿、姿态变化、感官细节、环境反应或必要对白来暗示人物内在转变，让读者自行推断。`,
      `- 将「展示状态变化」的修订要求翻译为：用一个可观察的行为选择或反应来承载变化，而非直接陈述「他接受了/他认可了/他决定了」。`,
      "- 章节的解释边界明确禁止直接总结主题或人物成长——审核者建议不得越过此边界。",
    );
  } else {
    // absent: 不得主动讨论或呼应主题
    lines.push(
      "- 不得通过任何形式（包括心理叙述、对白或意象）主动讨论或呼应主题。",
      `- 将「增加内心权衡」的修订要求翻译为：通过纯粹的行为选择和动作细节来暗示人物态度，不附加任何主题性解读。`,
    );
  }

  lines.push(
    "",
    "当审核者的修订要求与本约束冲突时，以本约束为准。保持修订要解决的问题本质（如状态变化需要证据），但改变承载方式（从心理叙述改为可观察行为）。",
  );

  return lines.join("\n");
}

/**
 * POV-群像冲突调解约束：桥接「配角独立性」与「视角边界」两类审核要求。
 *
 * 根因：character-reviewer 和 continuity-reviewer 常同时要求「增加配角独立性/群像深度」
 * 和「不得越过视角人物的知识边界」。这两者本身不矛盾——配角的独立性可以通过视角人物
 * 能观察到的外在行为来展示——但修订 LLM 不知道如何 reconcile，导致：
 *
 * 1. 为满足 ensemble 要求，LLM 用全知视角直接描述配角心理（如「各怀心思地散开」
 *    「似乎...成了他在同僚面前炫耀的谈资」）→ continuity-reviewer 标记 POV 违规
 * 2. 为修复 POV 违规，LLM 删除群像内容或改为心理总结 → style-reviewer 标记 subtext 违规
 * 3. 每轮修订在一个维度改善但在另一个维度退化，形成振荡
 *
 * 冲突链：ensemble issue → LLM 用全知视角写配角心理 → POV 违规 → 修复 POV 时引入 style 违规
 *
 * 解决方案：当 issues 中存在 ensemble 维度的问题时，注入具体的技术指引，
 * 教 LLM 如何通过可观察行为（而非心理总结）来创造群像深度。
 *
 * 适用边界：当 issues 包含 dimension="ensemble" 的问题时注入。
 * 不依赖特定章节、角色名或 genre——ensemble 是通用叙事维度。
 */
function renderPovEnsembleConstraint(issues: ReviewIssue[]): string {
  const hasEnsembleIssue = issues.some((issue) => issue.dimension === "ensemble");
  if (!hasEnsembleIssue) return "";

  // 检测是否存在 POV 相关的连续性问题（视角越界）
  const hasPovContinuityIssue = issues.some((issue) => {
    if (issue.dimension !== "continuity") return false;
    const text = [issue.title, issue.description ?? "", issue.evidence, issue.suggestion ?? ""].join(" ");
    return text.includes("视角") || text.includes("POV") || (text.includes("替") && (text.includes("宣告") || text.includes("判断")));
  });

  const lines = [
    "## POV-群像冲突调解约束",
    "",
    "当前审核问题中存在「群像/配角独立性」要求。当章节有明确视角人物时，配角的独立性必须通过视角人物能观察到的外在行为来展示，不得使用全知视角直接描述他人心理。",
    "",
    "### 禁止模式（POV 违规 → continuity 扣分）",
    "- 叙述者直接总结他人心理：用概括性词语替配角宣示情绪（如「各怀心思」「不情愿地」「暗自窃喜」），读者无法从行为中自行推断",
    "- 替配角宣告内在动机：把配角的行动原因直接写出（如「为了证明自己」「出于嫉妒」），而非通过行为让读者推断",
    "- 全知式群体心理描写：用一句话概括一群人的心理状态（如「众人面面相觑」「人群中弥漫着不安」），缺乏个体可观察行为",
    "",
    "### 允许模式（通过观察展示独立性）",
    "- 配角之间的对话/博弈（视角人物可旁听）：两名配角在视角人物经过时正在争论，其中一人用物品或承诺作为交换条件——视角人物只能听到片段",
    "- 配角自身的动作选择（展示欲望和处境）：配角做了一个暴露其处境或倾向的小动作（如反复确认时间、把重要物品从一只手换到另一只手、犹豫后才回应）",
    "- 配角对事件的物理反应（展示态度）：配角对某事件有可观察的物理反应（如手中动作停顿一拍、加快/放慢当前活动、目光短暂移向某处）",
    "- 视角人物从可观察细节中推断（明确标注为推断而非事实）：视角人物注意到配角说话时压低声音、目光瞟向某处——视角人物推测消息已传开，但不确定",
    "",
    "### 修订操作规则",
    "1. 当审核者要求「增加配角独立性/群像深度」时：为配角设计一个不依赖主角的微型互动，写为视角人物能观察到的外在行为（对话内容、动作细节、物理反应），不得用叙述者心理总结代替。",
    "2. 当审核者同时要求「修复 POV 越界」时：找到叙述者直接总结他人心理的句子，将心理状态转换为可观察的外在行为，保留原句传达的信息量（读者仍能从行为中推断心理）。",
    "3. 不得在修复 POV 违规时删除群像内容——这会让 ensemble 问题恶化。只改变承载方式（从心理总结改为可观察行为）。",
  ];

  if (hasPovContinuityIssue) {
    lines.push(
      "",
      "⚠️ 当前审核问题中同时存在 POV 越界和群像缺失——两者是同一枚硬币的两面。修复 POV 时不得删除群像内容，只将心理叙述翻译为可观察行为；增加群像深度时不得使用全知视角，只通过视角人物的观察来展示配角独立性。",
    );
  }

  return lines.join("\n");
}

/**
 * 渲染前序修订历史，帮助 LLM 避免重复失败策略。
 *
 * 设计原则：
 * - 只记录关键信息（轮次、结果、分数变化、尝试方向），不注入完整正文
 * - 明确告知 LLM "必须尝试不同策略"，打破策略重复
 * - 历史为空时返回空字符串，不影响首次修订
 */
function renderRevisionHistory(history: RevisionAttempt[]): string {
  if (!history.length) return "";
  const lines: string[] = [
    "## 前序修订记录（避免重复策略）",
    "",
    "以下前序修订尝试均未成功改善质量。本轮修订必须尝试与前序轮次根本不同的策略。",
    "如果前序修订因「质量退化」回退，说明修订引入了新问题或丢失了原文有效内容——",
    "本轮应缩小改动范围或改变改动方向，而非重复同样的修改逻辑。",
    "",
  ];
  for (const attempt of history) {
    const outcomeLabel = attempt.outcome === "accepted"
      ? "已采纳"
      : attempt.outcome === "reverted-degradation"
        ? "因质量退化回退"
        : "因无改善回退";
    lines.push(`### 第 ${attempt.iteration} 轮修订 — 结果：${outcomeLabel}`);
    const scoreLine = attempt.baselineScore !== undefined
      ? `- 分数变化：${attempt.baselineScore.toFixed(2)} → ${attempt.revisedScore.toFixed(2)}`
      : `- 修订后分数：${attempt.revisedScore.toFixed(2)}（基线分数未知：原始定稿未在本工作流中评分）`;
    lines.push(scoreLine);
    if (attempt.targetedIssueTitles.length) {
      lines.push(`- 针对的问题：${attempt.targetedIssueTitles.join("、")}`);
    }
    if (attempt.approachSummary) {
      lines.push(`- 尝试方向：${attempt.approachSummary}`);
    }
    lines.push("");
  }
  lines.push("**本轮策略要求**：分析前序回退的原因，选择不同的修订路径。例如：");
  lines.push("- 若前序做了大范围重写导致退化 → 本轮尝试局部精准修改");
  lines.push("- 若前序只做了局部修改无法解决结构性问题 → 本轮调整叙事策略");
  lines.push("- 若前序添加了新内容导致新问题 → 本轮不新增内容，只重组现有信息");
  return lines.join("\n");
}

function renderRevisionSkills(skills: SkillBundle | undefined, authorInstruction?: string): string {
  if (!skills?.skills.length) return "（无）";
  if (authorInstruction?.trim()) {
    return `（本轮由作者明确指定修订方向，不重复注入全量技能正文。已激活技能仅作为不冲突时的背景参考：${skills.skills.map((skill) => `${skill.skillId}@${skill.version}`).join("、")}。）`;
  }
  return skills.skills
    .map((skill) => [`### ${skill.skillId}@${skill.version}`, skill.promptSections.revision ?? ""].filter(Boolean).join("\n"))
    .join("\n\n");
}

function renderAuthorDirectedMemory(memory: MemoryBundle): string {
  const projected = dedupeNarrativeRhythmMemory(memory);
  const factual = projected.claims.filter((claim) => claim.authority === "approved" || claim.kind === "episodic");
  const background = projected.claims.filter((claim) => !factual.includes(claim));
  return [
    "### 必须保持的已发生事实",
    factual.map((claim) => {
      const projected = renderExecutionMemoryClaim(claim);
      return `- [${claim.authority}/${claim.kind}] ${projected.title}: ${projected.text}`;
    }).join("\n") || "- 无额外事实约束",
    "### 宏观背景索引（软参考）",
    background.map((claim) => `- ${claim.title}`).join("\n") || "- 无",
    "宏观背景只用于避免方向冲突，不要求保留原文的具体表达、对白、场景组织或修辞。",
  ].join("\n");
}

function renderAuthorDirectedPlanningContext(context: ChapterPlanningContext): string {
  return renderChapterPlanningContext(context, { includeMacro: false });
}

function renderRevisionMemory(memory: MemoryBundle, authorInstruction?: string): string {
  if (authorInstruction?.trim()) return renderAuthorDirectedMemory(memory);
  return dedupeNarrativeRhythmMemory(memory).claims.map((claim) => {
    const projected = renderExecutionMemoryClaim(claim);
    return `- [${claim.authority}/${claim.kind}] ${projected.title}: ${projected.text}`;
  }).join("\n") || "（无）";
}

function renderRevisionPlanningContext(context: ChapterPlanningContext | undefined, authorInstruction?: string): string {
  if (!context) return "## 冻结章节规划上下文\n（历史章节无规划快照。）";
  return authorInstruction?.trim() ? renderAuthorDirectedPlanningContext(context) : renderChapterPlanningContext(context, { includeMacro: false });
}

function renderRevisionRhythm(memory: MemoryBundle): string {
  return [
    "## 连续章节叙事节奏",
    renderNarrativeRhythm(memory.narrativeRhythm, { execution: true }),
  ].join("\n");
}

export interface AuthorRevisionAlignment {
  satisfied: boolean;
  summary: string;
  unmetRequirements: string[];
  evidence: string[];
}

export const authorRevisionAlignmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["satisfied", "summary", "unmetRequirements", "evidence"],
  properties: {
    satisfied: { type: "boolean" },
    summary: { type: "string", minLength: 1 },
    unmetRequirements: { type: "array", items: { type: "string", minLength: 1 } },
    evidence: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

export function buildAuthorRevisionAlignmentPrompt(input: { original: string; candidate: string; authorInstruction: string }): string {
  return [
    "判断候选正文是否实质响应了作者本轮修改要求。作者要求是自然语言目标，需要结合原文和候选的实际阅读效果判断，不做关键词匹配，也不把意见机械解释成绝对禁令。",
    "只有候选在相关叙事选择、人物呈现或表达效果上出现可感知变化，才可判定 satisfied=true；仅修复无关审校问题、删除一处重复或做同义替换不算完成。",
    "若未满足，unmetRequirements 要说明仍未落实的目标及其在候选中的具体表现；evidence 引用或概括可核对的文本证据。",
    "## 作者要求",
    input.authorInstruction.trim(),
    "## 修订前正文",
    input.original,
    "## 候选正文",
    input.candidate,
  ].join("\n\n");
}

export function buildAuthorRevisionRepairPrompt(input: {
  original: string;
  candidate: string;
  authorInstruction: string;
  alignment: AuthorRevisionAlignment;
  memory: MemoryBundle;
  planningContext?: ChapterPlanningContext;
}): string {
  return [
    "候选正文未充分响应作者要求。根据独立对齐检查继续修订，输出必须且只能是完整修订后正文。不要解释过程。",
    "## 作者要求",
    input.authorInstruction.trim(),
    "## 未满足项",
    input.alignment.unmetRequirements.map((item, index) => `${index + 1}. ${item}`).join("\n") || input.alignment.summary,
    "## 检查证据",
    input.alignment.evidence.map((item) => `- ${item}`).join("\n") || "- 参照作者要求重新比较原文与候选",
    "## 原始正文（用于确认本轮需要发生的变化）",
    input.original,
    "## 当前候选（在此基础上继续修订）",
    input.candidate,
    "## 事实边界",
    renderAuthorDirectedMemory(input.memory),
    renderRevisionPlanningContext(input.planningContext, input.authorInstruction),
    renderRevisionRhythm(input.memory),
    "完成后自行重新核对作者要求；不要用修复其他问题代替本轮目标。",
  ].join("\n\n");
}

/** Preserve author feedback as natural-language intent; interpretation belongs to the revision model. */
export function buildAuthorRevisionBrief(authorInstruction?: string): string {
  const instruction = authorInstruction?.trim();
  if (!instruction) return "（无作者补充取舍；按审核问题逐项修订即可。）";

  return [
    "## 作者原话（最高优先级）",
    instruction,
    "",
    "## 执行决策",
    "1. 先理解作者想改变的阅读效果、叙事选择和保留边界，不要用关键词表替作者归类，也不要把意见机械改写成绝对禁令。",
    "2. 将作者要求与审校证据合并判断：审校意见指出已知缺陷，作者要求决定本轮方向；两者冲突时以作者明确取舍为准。",
    "3. 自行判断受影响范围。若达到作者目标需要联动多个段落，可以调整所有必要段落，但必须保持冻结事实、章节规划、人物关系、POV 和既定因果。",
    "4. 生成前先形成内部修改计划，生成后逐项核对作者原话；正文必须出现可感知的实质变化，不能只做同义替换。不要输出分析、计划或核对过程。",
  ].join("\n");
}

export function buildFullChapterRevisionPrompt(input: {
  text: string;
  issues: ReviewIssue[];
  memory: MemoryBundle;
  skills?: SkillBundle;
  planningContext?: ChapterPlanningContext;
  authorInstruction?: string;
  revisionHistory?: RevisionAttempt[];
}): string {
  const skills = renderRevisionSkills(input.skills, input.authorInstruction);
  const historySection = renderRevisionHistory(input.revisionHistory ?? []);
  return [
    "修订下面整章正文，修复所有列出的审核问题，并按作者反馈重定本轮场景取舍。输出必须且只能是完整修订后正文，不使用 Markdown，不解释过程。",
    "## 作者反馈转译为本轮修订策略（最高优先级）",
    buildAuthorRevisionBrief(input.authorInstruction),
    "作者要求可以扩大本轮需要检查的正文范围，但不得违反冻结事实、章节规划、人物既定关系与已发生事件。",
    "## 审核问题解读指引",
    renderRevisionInterpretationGuide(false),
    "## 原文",
    input.text,
    "## 审核问题",
    formatIssues(input.issues) || "（无结构化审核问题）",
    renderThemeModeConstraint(input.planningContext),
    renderPovEnsembleConstraint(input.issues),
    ...(historySection ? [historySection] : []),
    "## 事实与背景边界",
    renderRevisionMemory(input.memory, input.authorInstruction),
    renderRevisionPlanningContext(input.planningContext, input.authorInstruction),
    renderRevisionRhythm(input.memory),
    "## 已激活修订技能",
    skills,
    "## 整章修订契约",
    [
      "1. 逐项落实作者策略和审核问题，不得仅做近义改写或只处理其中一类意见。",
      "2. 保留原章事件、关键信息、POV 和因果；根据作者要求重新选择承载信息与情绪的表达方式。",
      "3. 不得新增冻结事实和原文都未建立的人物、关系、线索或事件。",
      "4. 修改幅度由作者目标决定；既不能用局部同义替换敷衍结构性要求，也不能无依据重写与目标无关的内容。",
      "5. 最小改动原则：只改动与审核问题直接相关的句子，不重写未触及的段落。修复一个问题时不得引入新问题。",
      "6. 一致性约束处理：标注为[一致性约束]的审核问题，修订方向是统一为已建立设定值，不是创造新值或更换名称。审核者给出的值可能不准确，必须通过真值确认流程独立验证后再统一。无法确认时保持原值不变。",
    ].join("\n"),
  ].join("\n\n");
}

export function buildFullChapterRevisionPromptPackage(input: {
  projectId: string;
  workflowId: string;
  system: string;
  sourceArtifactId: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  goal?: StageGoalContract;
  text: string;
  issues: ReviewIssue[];
  memory: MemoryBundle;
  skills?: SkillBundle;
  planningContext?: ChapterPlanningContext;
  authorInstruction?: string;
  revisionHistory?: RevisionAttempt[];
}): StagePromptPackage {
  const contract = [
    "修订下面整章正文，输出必须且只能是完整修订后正文，不使用 Markdown，不解释过程。",
    "逐项落实审核问题；根据问题决定必要改动范围，不得用无关润色或同义替换冒充完成。",
    "保持原文已有的文学品质、文风节奏和有效细节；修订是改善而非重写，未被问题触及的段落应保持原貌。",
    "保留已发生事实、人物关系、POV、章节功能与既定因果，不新增冻结来源没有依据的事实。",
    "最小改动原则：只改动与审核问题直接相关的句子，不重写未触及的段落。修复一个问题时不得引入新问题。",
    "一致性约束处理：审核问题中标注为[一致性约束]的问题，修订方向是确保文本与已建立设定一致（统一为正确值），不是创造新值或更换名称。审核者给出的值可能不准确，必须通过真值确认流程独立验证（事实边界 > 规划上下文 > 原文线索 > 保持原值不变）。",
    "输出前按实际阅读效果核对修订是否实质改善了问题；不要输出分析、计划或核对过程。",
  ].join("\n");
  const historyText = renderRevisionHistory(input.revisionHistory ?? []);
  const themeModeConstraintText = renderThemeModeConstraint(input.planningContext);
  const povEnsembleConstraintText = renderPovEnsembleConstraint(input.issues);
  return compileStageContext({
    projectId: input.projectId,
    workflowId: input.workflowId,
    purpose: "writing.revision",
    stage: "revision",
    system: input.system,
    goal: input.goal,
    maxInputTokens: input.maxInputTokens,
    reservedOutputTokens: input.maxOutputTokens,
    sections: [
      { id: "revision-contract", kind: "goal", title: "整章修订契约", text: contract, priority: "critical", provenanceRefs: [input.goal?.id ?? input.sourceArtifactId] },
      ...(input.authorInstruction?.trim() ? [{ id: "author-instruction", kind: "goal" as const, title: "作者原始修改要求", text: input.authorInstruction.trim(), priority: "critical" as const, provenanceRefs: [input.goal?.id ?? input.sourceArtifactId] }] : []),
      { id: "source-manuscript", kind: "manuscript", title: "修订前正文", text: input.text, priority: "critical", provenanceRefs: [input.sourceArtifactId], sourceArtifactId: input.sourceArtifactId },
      { id: "revision-interpretation-guide", kind: "review", title: "审核问题解读指引", text: renderRevisionInterpretationGuide(false), priority: "required", provenanceRefs: ["interpretation-guide"] },
      { id: "review-issues", kind: "review", title: "本轮审核问题", text: formatIssues(input.issues) || "（无结构化审核问题）", priority: input.issues.length ? "required" : "soft", provenanceRefs: input.issues.map((_, index) => `issue:${index}`) },
      ...(themeModeConstraintText ? [{ id: "theme-mode-constraint", kind: "goal" as const, title: "主题模式约束", text: themeModeConstraintText, priority: "critical" as const, provenanceRefs: [input.planningContext!.fingerprint] }] : []),
      ...(povEnsembleConstraintText ? [{ id: "pov-ensemble-constraint", kind: "goal" as const, title: "POV-群像冲突调解约束", text: povEnsembleConstraintText, priority: "critical" as const, provenanceRefs: input.issues.filter((issue) => issue.dimension === "ensemble").map((_, index) => `ensemble-issue:${index}`) }] : []),
      ...(historyText ? [{ id: "revision-history", kind: "review" as const, title: "前序修订记录", text: historyText, priority: "required" as const, provenanceRefs: input.revisionHistory!.map((_, index) => `revision-attempt:${index}`) }] : []),
      { id: "revision-facts", kind: "fact", title: "事实与背景边界", text: renderRevisionMemory(input.memory, input.authorInstruction), priority: "required", provenanceRefs: [input.memory.id] },
      ...(input.planningContext ? [{ id: "revision-planning", kind: "planning" as const, title: "冻结章节规划边界", text: renderRevisionPlanningContext(input.planningContext, input.authorInstruction), priority: "required" as const, provenanceRefs: [input.planningContext.fingerprint] }] : []),
      { id: "revision-rhythm", kind: "planning", title: "连续章节叙事节奏", text: renderNarrativeRhythm(input.memory.narrativeRhythm, { execution: true }), priority: "required", provenanceRefs: [input.memory.narrativeRhythm?.fingerprint ?? input.memory.id] },
      { id: "revision-skills", kind: "skill", title: "已激活修订技能", text: renderRevisionSkills(input.skills, input.authorInstruction), priority: "normal", provenanceRefs: [input.skills?.id ?? "no-skills"] },
    ],
  });
}

export function buildRevisionWindowPrompt(input: {
  text: string;
  window: RevisionWindow;
  memory: MemoryBundle;
  skills?: SkillBundle;
  planningContext?: ChapterPlanningContext;
  authorInstruction?: string;
  revisionHistory?: RevisionAttempt[];
}): string {
  const paragraphs = splitChapterParagraphs(input.text);
  const source = paragraphs.slice(input.window.start, input.window.end + 1).join("\n\n");
  const before = input.window.start > 0 ? paragraphs[input.window.start - 1] : "（无）";
  const after = input.window.end + 1 < paragraphs.length ? paragraphs[input.window.end + 1] : "（无）";
  const memory = dedupeNarrativeRhythmMemory(input.memory).claims.map((claim) => {
    const projected = renderExecutionMemoryClaim(claim);
    return `- [${claim.authority}/${claim.kind}] ${projected.title}: ${projected.text}`;
  }).join("\n") || "（无冻结事实）";
  const skills = renderRevisionSkills(input.skills, input.authorInstruction);
  const historySection = renderRevisionHistory(input.revisionHistory ?? []);
  return [
    `修订目标：原章第 ${input.window.start + 1}-${input.window.end + 1} 段。你的输出将直接替换这些段落。`,
    "## 审核问题解读指引",
    renderRevisionInterpretationGuide(true),
    "## 必须处理的问题",
    formatIssues(input.window.issues),
    renderThemeModeConstraint(input.planningContext),
    renderPovEnsembleConstraint(input.window.issues),
    ...(historySection ? [historySection] : []),
    "## 作者补充修改要求",
    buildAuthorRevisionBrief(input.authorInstruction),
    "## 冻结事实（只读）",
    memory,
    input.planningContext ? renderChapterPlanningContext(input.planningContext, { includeMacro: false }) : "## 冻结章节规划上下文\n（历史章节无规划快照；主题模式按 subtext 兼容。）",
    renderRevisionRhythm(input.memory),
    "## 已激活修订技能",
    skills,
    "## 上一段（只读，不得复述）",
    before,
    "## 待替换段落",
    source,
    "## 下一段（只读，不得复述）",
    after,
    "## 局部修订契约",
    [
      "1. 保留目标段落承担的事件、信息、POV 和因果；若作者反馈要求减少对白或解释，可把信息改由动作、物象、环境反应或主角观察承载。",
      "2. 必须实际改写问题证据，不得原样返回；根据问题机制自行组织文字，不得套用审核者拟写的句子。",
      "3. 不得新增原文、冻结事实和相邻段落中都不存在的人物、物件、关系、线索或事件。",
      "4. 不得重写或复述相邻段落，不得解释修订过程，不得输出标题、编号、Markdown 或评语。",
      "5. 用可观察动作、感官和必要对白承载体验，避免作者式结论；保持自然中文韵律和原有叙述距离。",
      "6. 作者反馈用于明确本轮取舍；不得借反馈越过目标段落或新增未建立事实。",
      "7. 最小改动原则：只改动与审核问题直接相关的句子。标注为[一致性约束]的问题，修订方向是统一为已建立设定值，不是创造新值或更换名称。审核者给出的值可能不准确，必须通过真值确认流程独立验证（事实边界 > 规划上下文 > 原文线索 > 保持原值不变）。",
    ].join("\n"),
  ].join("\n\n");
}

export const targetedRevisionBatchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["replacements"],
  properties: {
    replacements: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "text"],
        properties: {
          start: { type: "integer", minimum: 1 },
          end: { type: "integer", minimum: 1 },
          text: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

export function buildTargetedRevisionBatchPrompt(input: { text: string; windows: RevisionWindow[]; memory: MemoryBundle; skills?: SkillBundle; planningContext?: ChapterPlanningContext; authorInstruction?: string; revisionHistory?: RevisionAttempt[] }): string {
  const outputExample = {
    replacements: input.windows.map((window) => ({
      start: window.start + 1,
      end: window.end + 1,
      text: "该原章范围的替换正文",
    })),
  };
  return [
    "只返回 JSON。逐个修订下列目标窗口，不得合并、扩展或修改原章段号。每项 text 只包含该窗口的替换正文。",
    ...input.windows.map((window, index) => `## 窗口 ${index + 1}\n${buildRevisionWindowPrompt({ ...input, window })}`),
    "## 输出格式",
    `start/end 必须使用上文标明的原章段号，并完整返回以下所有范围：${input.windows.map((window) => `${window.start + 1}-${window.end + 1}`).join("、")}。`,
    JSON.stringify(outputExample),
  ].join("\n\n");
}

export function applyRevisionWindows(text: string, replacements: Array<{ window: RevisionWindow; text: string }>): string {
  const paragraphs = splitChapterParagraphs(text);
  for (const replacement of [...replacements].sort((left, right) => right.window.start - left.window.start)) {
    const replacementParagraphs = splitChapterParagraphs(sanitizeRevisionOutput(replacement.text));
    if (!replacementParagraphs.length) continue;
    paragraphs.splice(replacement.window.start, replacement.window.end - replacement.window.start + 1, ...replacementParagraphs);
  }
  return paragraphs.join("\n\n");
}

export function applyTargetedRevisionReplacements(text: string, windows: RevisionWindow[], replacements: TargetedRevisionReplacement[]): string {
  if (!windows.length) throw new Error("目标意见无法解析出安全修订窗口");
  const allowed = new Map(windows.map((window) => [`${window.start + 1}:${window.end + 1}`, window]));
  const seen = new Set<string>();
  const accepted: Array<{ window: RevisionWindow; text: string }> = [];
  for (const replacement of replacements) {
    const key = `${replacement.start}:${replacement.end}`;
    const window = allowed.get(key);
    if (!window || seen.has(key)) throw new Error(`返回内容不属于目标修订窗口：${replacement.start}-${replacement.end}`);
    seen.add(key);
    if (replacement.text.trim()) accepted.push({ window, text: replacement.text });
  }
  if (seen.size !== allowed.size) throw new Error("AI 未返回全部目标修订窗口");
  if (!accepted.length) throw new Error("AI 未返回有效的目标段落修改");
  const revised = applyRevisionWindows(text, accepted);
  if (revised === text) throw new Error("AI 未实际修改目标段落");
  return revised;
}
