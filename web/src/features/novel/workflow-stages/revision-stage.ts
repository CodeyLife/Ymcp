import { streamNovelModel } from "../ai";
import { formatReviewerContext } from "../context";
import { DEFAULT_CHAPTER_TARGET_WORDS } from "../db";
import { countNovelWords } from "../quality";
import { compileNovelStagePrompt, resolveNovelSkills } from "../skills";
import { asBlueprint } from "../workflow-shared";
import type { NovelContextPacket, QualityIssue } from "../types";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";
import { repairDraftStructureOnce } from "./draft-structure-repair";

/**
 * 局部修订上下文摘要上限（字符数）。
 *
 * 局部修订只需保证修订不破坏跨章连续性（人物/事实/前章已交付物件），
 * 不需要完整 contextPacket。用 formatReviewerContext 排除 skill 源后，
 * 截断到上限，避免 prompt 膨胀挤占 maxTokens 预算。
 *
 * 选 4000 字符：足够覆盖实体档案+前章摘要+剧情线/伏笔关键条目，
 * 同时为 mustHappen/forbidden/issue 列表/相邻段落/修订契约留出余量。
 */
const REVISION_CONTEXT_DIGEST_MAX_CHARS = 4000;

/**
 * 构造局部修订用的冻结上下文摘要。
 *
 * 设计依据：审计 Loop 1 问题 A——revision-stage.ts:482 局部修订未注入 contextPacket，
 * 导致 LLM 在修订涉及跨章连续性的 issue 时缺乏前章事实/实体档案/剧情线/伏笔参照。
 *
 * 复用 formatReviewerContext（与 review-stage 一致，排除 skill 源），
 * 然后按字符上限截断，保留头部高权威源（实体/前章摘要/剧情线等通常排在前面）。
 *
 * 返回 undefined 表示无 packet 或摘要为空——调用方不应在 prompt 中插入空段落。
 */
function buildRevisionContextDigest(packet: NovelContextPacket | undefined): string | undefined {
  if (!packet) return undefined;
  const full = formatReviewerContext(packet).trim();
  if (!full) return undefined;
  if (full.length <= REVISION_CONTEXT_DIGEST_MAX_CHARS) return full;
  // 头部优先：formatReviewerContext 输出的 source 顺序由 allocateContext 决定，
  // 高权威/强制层源（实体档案/前章摘要/剧情线）通常排在前面，截断尾部低权威源更安全。
  return `${full.slice(0, REVISION_CONTEXT_DIGEST_MAX_CHARS)}\n[冻结上下文已截断，仅保留高权威源摘要；如需完整背景请参考 review-stage 审校结论]`;
}

export function splitParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, "").replace(/[，。！？；：、""''《》【】（）()"'.,!?;:\-—…]/g, "");
}

function tokenize(text: string): string[] {
  return Array.from(text.replace(/\s+/g, "")).filter((ch) => ch.trim());
}

// R10 修复：post-revision 相似度检查——检测 LLM 是否返回了与原文实质相同的内容
// 使用字符二元组 Jaccard 相似度，O(n+m) 复杂度
export function computeTextSimilarity(a: string, b: string): number {
  const normA = normalizeText(a);
  const normB = normalizeText(b);
  if (normA.length === 0 && normB.length === 0) return 1;
  if (normA.length === 0 || normB.length === 0) return 0;
  const bigramsA = new Set<string>();
  for (let i = 0; i < normA.length - 1; i += 1) bigramsA.add(normA.slice(i, i + 2));
  const bigramsB = new Set<string>();
  for (let i = 0; i < normB.length - 1; i += 1) bigramsB.add(normB.slice(i, i + 2));
  let intersection = 0;
  for (const bg of bigramsA) if (bigramsB.has(bg)) intersection += 1;
  const union = bigramsA.size + bigramsB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

export const REVISION_LOCAL_UNCHANGED_THRESHOLD = 0.995;

export interface RevisionWindow {
  start: number;
  end: number;
  issues: QualityIssue[];
}

export function planRevisionWindows(
  issues: QualityIssue[],
  paragraphs: string[],
  excludedParagraphs: ReadonlySet<number> = new Set(),
): { windows: RevisionWindow[]; unlocated: QualityIssue[] } {
  const located: Array<{ index: number; issue: QualityIssue }> = [];
  const unlocated: QualityIssue[] = [];
  for (const issue of issues) {
    const targets = collectRevisionParagraphs(issue, paragraphs);
    if (targets.length === 0) {
      unlocated.push(issue);
      continue;
    }
    const eligibleTargets = targets.filter((index) => !excludedParagraphs.has(index));
    if (eligibleTargets.length === 0) continue;
    const locatedIssue = eligibleTargets.length === targets.length
      ? issue
      : { ...issue, paragraph: undefined, revisionRanges: eligibleTargets.map((index) => ({ start: index + 1, end: index + 1 })) };
    for (const index of eligibleTargets) located.push({ index, issue: locatedIssue });
  }
  located.sort((a, b) => a.index - b.index);
  const windows: RevisionWindow[] = [];
  for (const item of located) {
    const last = windows.at(-1);
    if (!last || item.index > last.end + 1) {
      windows.push({ start: item.index, end: item.index, issues: [item.issue] });
      continue;
    }
    last.end = Math.max(last.end, item.index);
    if (!last.issues.some((issue) => issue.id === item.issue.id)) last.issues.push(item.issue);
  }
  return { windows, unlocated };
}

export function applyRevisionWindows(
  paragraphs: string[],
  replacements: Array<RevisionWindow & { replacement: string[] }>,
  deleted: Set<number> = new Set(),
): string[] {
  const byStart = new Map(replacements.map((item) => [item.start, item]));
  const result: string[] = [];
  for (let index = 0; index < paragraphs.length; index += 1) {
    const replacement = byStart.get(index);
    if (replacement) {
      const overlapsDeletion = Array.from(
        { length: replacement.end - replacement.start + 1 },
        (_, offset) => replacement.start + offset,
      ).some((paragraphIndex) => deleted.has(paragraphIndex));
      if (overlapsDeletion) {
        for (let paragraphIndex = replacement.start; paragraphIndex <= replacement.end; paragraphIndex += 1) {
          if (!deleted.has(paragraphIndex)) result.push(paragraphs[paragraphIndex]);
        }
        index = replacement.end;
        continue;
      }
      result.push(...replacement.replacement);
      index = replacement.end;
      continue;
    }
    if (!deleted.has(index)) result.push(paragraphs[index]);
  }
  return result;
}

export function findIssueParagraph(issue: QualityIssue, paragraphs: string[]): number {
  if (typeof issue.paragraph === "number" && issue.paragraph >= 1 && issue.paragraph <= paragraphs.length) {
    return issue.paragraph - 1;
  }
  if (!issue.excerpt) return -1;

  const excerptNorm = normalizeText(issue.excerpt);
  if (excerptNorm.length >= 8) {
    const normParagraphs = paragraphs.map((p) => normalizeText(p));
    for (const len of [Math.min(60, excerptNorm.length), 40, 20]) {
      const prefix = excerptNorm.slice(0, len);
      const index = normParagraphs.findIndex((p) => p.includes(prefix));
      if (index >= 0) return index;
    }
  }

  const excerptTokens = tokenize(issue.excerpt);
  if (excerptTokens.length >= 4) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < paragraphs.length; i += 1) {
      const paraTokens = tokenize(paragraphs[i]);
      if (paraTokens.length === 0) continue;
      const setB = new Set(paraTokens);
      const overlap = excerptTokens.filter((t) => setB.has(t)).length;
      const score = overlap / Math.min(excerptTokens.length, paraTokens.length);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestScore >= 0.5) return bestIndex;
  }

  return -1;
}

/**
 * 从文本中解析段落引用——支持"第N段"、"第N-M段"、"【第N段】"等多种格式。
 * 导出供 review-stage 的 proseAuditIssueToReviewerFinding 复用，避免重复实现。
 */
export function paragraphRangesInText(text: string, paragraphCount: number): number[] {
  const indices = new Set<number>();
  const pattern = /第\s*(\d{1,5})\s*(?:[-—–~～至到]\s*(\d{1,5}))?\s*段/g;
  for (const match of text.matchAll(pattern)) {
    const first = Number(match[1]);
    const second = Number(match[2] ?? match[1]);
    const start = Math.max(1, Math.min(first, second));
    const end = Math.min(paragraphCount, Math.max(first, second));
    for (let paragraph = start; paragraph <= end; paragraph += 1) indices.add(paragraph - 1);
  }
  return [...indices];
}

export function collectRevisionParagraphs(issue: QualityIssue, paragraphs: string[]): number[] {
  if (issue.revisionRanges?.length) {
    const explicit = new Set<number>();
    for (const range of issue.revisionRanges) {
      const start = Math.max(1, Math.min(range.start, range.end));
      const end = Math.min(paragraphs.length, Math.max(range.start, range.end));
      for (let paragraph = start; paragraph <= end; paragraph += 1) explicit.add(paragraph - 1);
    }
    return [...explicit].sort((a, b) => a - b);
  }

  const legacy = new Set<number>();
  const located = findIssueParagraph(issue, paragraphs);
  if (located >= 0) legacy.add(located);
  const suggestionRanges = paragraphRangesInText(issue.suggestion, paragraphs.length);
  const citedRanges = suggestionRanges.length > 0
    ? suggestionRanges
    : paragraphRangesInText(`${issue.title}\n${issue.description}`, paragraphs.length);
  for (const index of citedRanges) legacy.add(index);
  return [...legacy].sort((a, b) => a - b);
}

export function isRevisionRefusal(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  // 原有模式：明确拒绝提交修订稿（放宽字符限制以匹配"无法...完成...整章定向修订"等长跨度表达）
  const rejectsRevision = /(?:无法|不能).{0,40}(?:提交|生成|完成|输出).{0,24}(?:有效|整章定向|完整)?(?:修订稿|修订|全文)/.test(compact);
  // 原有模式：请求解锁段落范围
  const requestsUnlock = /(?:解除|调整|修改|重新标注).{0,16}(?:保留|锁定|段落范围)/.test(compact);
  // 新增模式：长度超限拒绝——LLM 因输出长度限制要求分段（Loop 3 实测：章节1/2 都触发了此模式）
  // Loop 8 修复 #13：新增"回复长度无法完整容纳"模式（章节2实测拒绝消息）
  const lengthExceeded = /(?:长度|内容|正文|章节)超过.{0,16}(?:单次|一次|一条)(?:回复|消息)|超过单次回复(?:可承载|可容纳)?范围|无法在(?:一条消息|单次回复)内(?:完整)?(?:输出|完成|生成)|回复.{0,12}无法(?:完整)?容纳|无法(?:完整)?容纳整章/.test(compact);
  // 新增模式：请求分段发送（必须命中"请分X次发送"或"请将原文分成X次"等明确指令）
  const requestsChunking = /请分(?:两次|多次|2—4次|2-4次|2—3次).{0,8}发送|请将(?:原文|章节|文本)分成.{0,8}次发送|建议每次约\d{2,3}段/.test(compact);
  return rejectsRevision || (requestsUnlock && compact.includes("需要先确认")) || lengthExceeded || requestsChunking;
}

// R1: 风格类 warning 升级为 major——这些规则虽定为 warning，但直接造成"AI 味"，
// 若不送修订则永远残留。升级为 major 后进入 blockerAndMajor 列表，LLM 会收到并修订。
// 根因 F 新增 style.gesture-repetition：反套路手势词高频重复是新出现的 AI 腔，
// prose-prompts 教的具象手势被 LLM 机械套用形成新模板，不送修订则永远残留。
export const STYLE_RULES_TO_PROMOTE = new Set([
  "style.interpretive-summary-density",
  "style.emotion-direct",
  "style.emphasis-devaluation",
  "style.template-density",
  "style.aphorism-density",
  "style.gesture-repetition",
]);

// R12/R13: LLM reviewer 生成的 warning 常带自定义 rule 文本（非预定义 rule 名），
// 无法通过 STYLE_RULES_TO_PROMOTE 精确匹配。用关键词匹配识别意象机械重复（R12）
// 和对白功能同质化/节奏同构（R13），升级为 major 确保进入修订列表。
export const PROMOTABLE_WARNING_PATTERNS = /意象.{0,6}(重复|功能|机械|再现)|对白.{0,6}(功能|同质|试探.{0,4}重复)|试探.{0,6}(直接|确认式|偏向)|节奏.{0,6}(均匀|同构|平直|同质)|功能重复|同一.{0,4}(功能|说明|象征)|(?:视角|POV|限知|知识边界|感知范围).{0,18}(?:越界|超出|违反|冲突|他人心理|内心|心理解释)|(?:进入|直接呈现|直接解释).{0,18}(?:他人心理|内心判断|限知)/i;

export function shouldPromoteWarning(item: QualityIssue): boolean {
  if (item.severity !== "warning") return false;
  if (item.rule && STYLE_RULES_TO_PROMOTE.has(item.rule)) return true;
  const text = `${item.title} ${item.description}`;
  return PROMOTABLE_WARNING_PATTERNS.test(text);
}

const REVISION_FEEDBACK_CATEGORIES = [
  /视角|POV|限知|心理|感知边界/,
  /碎片|句式|段落/,
  /重复|收束|第二个结尾|事件链/,
  /意象|比喻|象征/,
  /对白|台词|声音辨识/,
  /人物|关系|动机|选择/,
  /连续|事实|物件|线索|因果/,
];

export function selectRevisionIssuesForFeedback(issues: QualityIssue[], feedback: string) {
  const categories = REVISION_FEEDBACK_CATEGORIES.filter((pattern) => pattern.test(feedback));
  if (categories.length === 0) return issues;
  const selected = issues.filter((issue) => {
    const text = `${issue.title} ${issue.description} ${issue.suggestion} ${issue.excerpt ?? ""}`;
    return categories.some((pattern) => pattern.test(text));
  });
  return selected.length > 0 ? selected : issues;
}

export function isBlueprintCoverageIssue(issue: QualityIssue) {
  return issue.rule === "chapter.incomplete-blueprint"
    || /(?:蓝图|末节拍|最后节拍|章尾|mustHappen).{0,18}(?:未完成|缺失|截断|没有完成)|(?:截断|未完成).{0,18}(?:章节|正文|对白|动作)/i.test(`${issue.title} ${issue.description}`);
}

export const revisionStageHandler: StageHandler = {
  stage: "revision",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project, document, db } = ctx;
    const [draft, blueprint, report, feedback, skills, contextPacket] = await Promise.all([
      db.workflowArtifacts.get(run.draftArtifactId!),
      db.workflowArtifacts.get(run.blueprintArtifactId!),
      db.qualityReports.get(run.qualityReportId!),
      ctx.latestArtifact(run.id, ["review"]),
      resolveNovelSkills({ projectId: run.projectId, stage: "revision", explicitSkillIds: ["embodied-prose", "style-specificity-audit", "imagery-aesthetics"], db: ctx.db }),
      // 审计 Loop 1 问题 A 修复：局部修订需注入冻结上下文摘要，保证跨章连续性修订有前章事实/实体档案/剧情线参照。
      // 与 review-stage 保持一致（review-stage 也读 run.contextPacketId），不重算 contextPacket，复用 draft-stage 已冻结的版本。
      run.contextPacketId ? db.contextPackets.get(run.contextPacketId) : undefined,
    ]);
    if (!draft || !report) throw new Error("修订输入不完整");
    const blueprintData = blueprint?.structuredData ? asBlueprint(blueprint.structuredData) : undefined;
    const targetWords = document.blueprint.targetWords || blueprintData?.targetWords || DEFAULT_CHAPTER_TARGET_WORDS;
    const revisionContextDigest = buildRevisionContextDigest(contextPacket);

    const originalParagraphs = splitParagraphs(draft.contentMarkdown);
    let workingText = draft.contentMarkdown;
    const revisableIssues = report.issues
      .map((item) => {
        // R1+R12+R13: 风格类 warning 升级为 major，使其进入修订列表
        if (shouldPromoteWarning(item)) {
          return { ...item, severity: "major" as const };
        }
        return item;
      });

    // 关键修复：对"重复段"类 issue（重复推进/段落完全重复/第二个结尾/重新开场）直接在代码层面删除对应段落，
    // 不交给 LLM 修订——LLM 经常不删除而是改写，导致重复段残留
    const redundantRules = new Set(["plot.repeated-progression", "plot.exact-paragraph-repeat"]);
    const isRedundantIssue = (item: QualityIssue) => {
      if (redundantRules.has(item.rule)) return true;
      // LLM reviewer 使用的规则名不固定，按标题/描述关键词匹配
      const text = `${item.title} ${item.description}`;
      return /重复(推进|事件|收束|补写|展开|段落|信息)|第二个(结尾|结束|开场)|重新开场|重新展开|重新补写/.test(text);
    };
    const redundantIssues = revisableIssues.filter(isRedundantIssue);
    const remainingIssues = revisableIssues.filter((item) => !isRedundantIssue(item));
    const paragraphsToDelete = new Set<number>();
    if (redundantIssues.length > 0) {
      for (const issue of redundantIssues) {
        const targets = collectRevisionParagraphs(issue, originalParagraphs);
        for (const index of targets) paragraphsToDelete.add(index);
      }
      workingText = applyRevisionWindows(originalParagraphs, [], paragraphsToDelete).join("\n\n");
    }

    // R12/R13 修复：上限从 8 提升到 12——promoted warnings 增加了修订列表条目数，
    // 8 条上限会截断意象重复/对白同质化类 issue，导致它们仍不被修订
    const allBlockerAndMajor = remainingIssues.filter((item) => item.severity === "blocker" || item.severity === "major").slice(0, 12);
    const blockerAndMajor = feedback?.stage === "manuscript-approval"
      ? selectRevisionIssuesForFeedback(allBlockerAndMajor, feedback.contentMarkdown)
      : allBlockerAndMajor;
    // Loop 6 修复 #10：skillPrompt 提前定义，供 Path A/B/拒绝路径调用 repairDraftStructureOnce
    const skillPrompt = compileNovelStagePrompt(skills.skills, "revision");

    const feedbackCoverageIssue = feedback?.stage === "manuscript-approval" && isBlueprintCoverageIssue({
      id: "manual-blueprint-coverage",
      dimension: "plot",
      severity: "blocker",
      title: "人工指出章节未完成",
      description: feedback.contentMarkdown,
      rule: "chapter.incomplete-blueprint",
      suggestion: "只续写蓝图中尚未完成的末节拍与章尾。",
      deterministic: false,
    }) ? {
        id: "manual-blueprint-coverage",
        dimension: "plot" as const,
        severity: "blocker" as const,
        title: "人工指出章节未完成",
        description: feedback.contentMarkdown,
        rule: "chapter.incomplete-blueprint",
        suggestion: "只续写蓝图中尚未完成的末节拍与章尾。",
        deterministic: false,
      } satisfies QualityIssue : undefined;
    const coverageIssue = blockerAndMajor.find(isBlueprintCoverageIssue) ?? feedbackCoverageIssue;
    if (coverageIssue) {
      const { agent } = await ctx.createAgentRecord({
        run,
        role: "revision-editor",
        goal: "补完缺失的蓝图末节拍",
        skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
      });
      try {
        const continuation = await streamNovelModel({
          model: project.settings.textModel,
          temperature: 0.25,
          role: "revision-editor",
          skillPrompt,
          timeoutMs: 90_000,
          maxTokens: 4096,
          prompt: `当前章节被审校判定为未完成，不要重写已有正文，只续写缺失的末节拍与章尾。

## 审校证据
${coverageIssue.title}：${coverageIssue.description}
建议：${coverageIssue.suggestion}

## 已批准蓝图
${blueprint?.contentMarkdown ?? ""}

## 已有正文末尾（只读，不得复述）
${draft.contentMarkdown.slice(-1600)}

## 补完契约
1. 只输出追加在原文之后的连续正文，不输出标题、解释或原文复述。
2. 只完成蓝图已经批准但正文缺失的内容，不新增蓝图外人物、物件、线索、关系或后续节点。
3. 保持原 POV、人称、时间、空间和中文文风；完成本章功能后自然收束，不按 ${targetWords} 字凑篇幅。`,
        });
        const continuationWords = countNovelWords(continuation.content);
        if (isRevisionRefusal(continuation.content) || continuationWords < 80 || continuationWords > 2200) throw new Error(`章节补完输出长度异常：${continuationWords} 字`);
        // 只清理续写片段。对合并后的整章再次执行“第二结尾”检测会把合法的末节拍误删。
        const repaired = await repairDraftStructureOnce({ content: continuation.content, model: project.settings.textModel, skillPrompt });
        const combined = `${draft.contentMarkdown.trim()}\n\n${repaired.content.trim()}`;
        const nextIteration = run.revisionIteration + 1;
        const artifact = await ctx.saveArtifact({ ...run, revisionIteration: nextIteration }, {
          projectId: run.projectId,
          workflowRunId: run.id,
          stage: "revision",
          kind: "revision",
          title: `${document.title}章节补完稿 ${nextIteration}`,
          contentMarkdown: combined,
          parentArtifactId: draft.id,
          model: project.settings.textModel,
          skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
          contextPacketId: run.contextPacketId,
        });
        await ctx.finishAgent(agent, { promptHash: repaired.promptHash ?? continuation.promptHash, artifactId: artifact.id });
        const nextRun = await ctx.transition(run, "review", "running", { draftArtifactId: artifact.id, revisionIteration: nextIteration });
        return { run: nextRun };
      } catch (error) {
        await ctx.failAgent(agent, error);
        await ctx.createApprovalProposal(run, draft, "workflow-manuscript", "章节末节拍未完成且自动补完失败，已保留原文转交人工处理");
        const nextRun = await ctx.transition(run, "manuscript-approval", "waiting-approval");
        return { run: nextRun, continueLoop: false };
      }
    }

    // 如果删除了重复段但没有其他需要 LLM 修订的问题，直接保存删除后的正文
    if (redundantIssues.length > 0 && blockerAndMajor.length === 0) {
      const repairedText = await repairDraftStructureOnce({ content: workingText, model: project.settings.textModel, skillPrompt });
      const nextIteration = run.revisionIteration + 1;
      const artifact = await ctx.saveArtifact({ ...run, revisionIteration: nextIteration }, {
        projectId: run.projectId,
        workflowRunId: run.id,
        stage: "revision",
        kind: "revision",
        title: `${document.title}删除重复段修订 ${nextIteration}`,
        contentMarkdown: repairedText.content,
        parentArtifactId: draft.id,
        model: project.settings.textModel,
        skillRefs: [],
        contextPacketId: run.contextPacketId,
      });
      const nextRun = await ctx.transition(run, "review", "running", { draftArtifactId: artifact.id, revisionIteration: nextIteration });
      return { run: nextRun };
    }

    // 没有需要 LLM 修订的问题，直接保留原文
    if (blockerAndMajor.length === 0) {
      const repairedDraft = await repairDraftStructureOnce({ content: draft.contentMarkdown, model: project.settings.textModel, skillPrompt });
      const nextIteration = run.revisionIteration + 1;
      const artifact = await ctx.saveArtifact({ ...run, revisionIteration: nextIteration }, {
        projectId: run.projectId,
        workflowRunId: run.id,
        stage: "revision",
        kind: "revision",
        title: `${document.title}无变更修订 ${nextIteration}`,
        contentMarkdown: repairedDraft.content,
        parentArtifactId: draft.id,
        model: project.settings.textModel,
        skillRefs: [],
        contextPacketId: run.contextPacketId,
      });
      await ctx.createApprovalProposal(run, artifact, "workflow-manuscript", "没有可安全自动修订的重大问题，已保留原文并转交人工审阅");
      const nextRun = await ctx.transition(run, "manuscript-approval", "waiting-approval", { draftArtifactId: artifact.id, revisionIteration: nextIteration });
      return { run: nextRun, continueLoop: false };
    }

    const mustHappenBlock = blueprintData?.mustHappen?.length
      ? `\n\n## 本章已批准的兑现项（整章只读防丢清单）\n${blueprintData.mustHappen.map((item) => `- ${item}`).join("\n")}\n这些条目只用于防止局部修订删除原窗口已经承载的整章内容，不是当前窗口的新增任务。若待替换原文没有承载某条兑现项，修订输出不得新增、概述或提前完成该条目；不得把其它段落或未来事件压缩进当前窗口。`
      : "";
    const forbiddenBlock = blueprintData?.forbidden?.length
      ? `\n\n## 禁止事项（硬约束，不可触犯）\n${blueprintData.forbidden.map((item) => `- ${item}`).join("\n")}`
      : "";

    const issueListFor = (issues: QualityIssue[]) => issues.map((item, index) => {
      const excerptInfo = item.excerpt ? `（原文："${item.excerpt.slice(0, 60)}${item.excerpt.length > 60 ? "..." : ""}"）` : "";
      const ranges = item.revisionRanges?.length
        ? `（段落 ${item.revisionRanges.map((r) => `${r.start}-${r.end}`).join(", ")}）`
        : (typeof item.paragraph === "number" ? `（段落 ${item.paragraph}）` : "");
      const rewriteBlock = item.rewriteExample
        ? `\n  【改写示例——必须参考】\n  ${item.rewriteExample.split("\n").map((line) => `  ${line}`).join("\n")}`
        : `\n  【无改写示例——你必须根据建议自行改写，不得保留原文】`;
      return `${index + 1}. [${item.severity}] ${item.title}${excerptInfo}${ranges}\n  问题：${item.description}\n  修订指令：${item.suggestion}${rewriteBlock}`;
    }).join("\n\n");

    const { windows, unlocated } = planRevisionWindows(blockerAndMajor, originalParagraphs, paragraphsToDelete);
    if (windows.length === 0) {
      const unchanged = await repairDraftStructureOnce({ content: workingText, model: project.settings.textModel, skillPrompt });
      const nextIteration = run.revisionIteration + 1;
      const artifact = await ctx.saveArtifact({ ...run, revisionIteration: nextIteration }, {
        projectId: run.projectId,
        workflowRunId: run.id,
        stage: "revision",
        kind: "revision",
        title: `${document.title}无法定位修订 ${nextIteration}`,
        contentMarkdown: unchanged.content,
        parentArtifactId: draft.id,
        model: project.settings.textModel,
        skillRefs: [],
        contextPacketId: run.contextPacketId,
      });
      await ctx.createApprovalProposal(run, artifact, "workflow-manuscript", `${unlocated.length} 个重大问题缺少可靠段落范围，已保留正文并转交人工审阅`);
      const nextRun = await ctx.transition(run, "manuscript-approval", "waiting-approval", { draftArtifactId: artifact.id, revisionIteration: nextIteration });
      return { run: nextRun, continueLoop: false };
    }

    const { agent } = await ctx.createAgentRecord({
      run,
      role: "revision-editor",
      goal: `局部修订 ${windows.length} 个段落窗口`,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
    });
    const replacements: Array<RevisionWindow & { replacement: string[] }> = [];
    const promptHashes: string[] = [];
    for (const window of windows) {
      const source = originalParagraphs.slice(window.start, window.end + 1).join("\n\n");
      const before = window.start > 0 ? originalParagraphs[window.start - 1] : "（无）";
      const after = window.end + 1 < originalParagraphs.length ? originalParagraphs[window.end + 1] : "（无）";
      const sourceWords = countNovelWords(source);
      let generated;
      try {
        generated = await streamNovelModel({
          model: project.settings.textModel,
          temperature: 0.25,
          role: "revision-editor",
          skillPrompt,
          timeoutMs: 90_000,
          maxTokens: Math.min(4096, Math.max(1024, Math.ceil(sourceWords * 3))),
          prompt: `只修订原章第 ${window.start + 1}-${window.end + 1} 段。相邻段落仅供衔接，不得重写；输出必须且只能是替换目标段落的连续正文。${mustHappenBlock}${forbiddenBlock}

## 冻结上下文（只读，用于跨章连续性核对）
${revisionContextDigest ?? "（本章无冻结上下文，按 issue 描述与相邻段落修订；不得新增原文与蓝图中都不存在的事实）"}

## 必须处理的问题
${issueListFor(window.issues)}

## 上一段（只读）
${before}

## 待替换段落
${source}

## 下一段（只读）
${after}

## 局部修订契约
1. 保留目标段落承担的事件、信息、人物声音与视角，只解决列出的问题。
2. 不得新增原文与已批准蓝图中都不存在的物件、行动、关系、线索或事实；修订涉及跨章事实时必须以"冻结上下文"为准，不得臆造前章已交付的物件、已确定的关系或已发生的事件。
3. 不得把局部问题扩写成新场景，不得复述相邻段落，不得解释修订过程。
4. ${targetWords} 字只是整章容量参考；本窗口以自然、准确、富有中文韵律为准，不凑字数。
5. 边界不复述硬约束：修订输出不得逐句复述"上一段"或"下一段"。若需要衔接，只用必要的动作、时间或场景状态自然承接，不得复制相邻段落的完整句子。

## 修订时声音与视角硬约束（违反即重写）
1. 单 POV 视角：修订不得引入全知判断或替视角人物总结他人心理。他人内在状态只能通过可见动作、神态、对白、呼吸、停顿外化呈现。禁止"他知道X不会无故Y""像是在提醒自己""他心中……"式越界——改写为视角人物可观察的具体动作或记录。判定标准：把描述他人状态的句子改写为"视角人物能看到/听到的具体动作"后若信息丢失，则该句子越界，必须改写。
2. 禁止作者式心理结论句：修订不得新增"她第一次知道/她忽然懂得/这意味着/不是……而是……"式心理总结，也不得新增脱离当下情境的格言式训诫。把心理结论改写为视角人物当下可观察的动作、环境感受或具体反应。
3. 对白声线区分：只从冻结上下文中的年龄、职业、关系距离、目标、知识边界和既有表达习惯推导声部，不得套用固定身份模板。修订不得让蓝图未安排开口的角色新增对白，也不得为了制造交锋改变角色立场。
4. 生成时自检：写到对白时立即检查——这句换成另一角色说是否一样？若一样，立即改写使其符合自身声部。写到他人心理时立即改为可观察动作。写到环境意象时检查它是否改变了人物判断或引发新行动——若只承担氛围，删除或改写为可驱动判断的细节。
5. 禁止作者把多个角色、事件或关系压缩成一句全知因果总结。需要表达汇合或影响时，只写视角人物能够观察、回忆或合理推断的具体变化，让读者自行建立联系。
6. 章尾必须服从已批准蓝图。可以落在信息、行动、关系、情感余波或状态变化上，不强制使用物证、命令或调度；只删除重复表达同一收束含义的句段，不得把蓝图要求的最后节拍一并删掉。蓝图若明确保留未回答、未决定或未完成的选择，修订不得替人物答应、拒绝或完成选择；只能通过原有行动被打断、可用选项收窄或外部关系继续施压来落实处境变化。
${feedback?.stage === "manuscript-approval" ? `\n## 用户意见\n${feedback.contentMarkdown}` : ""}`,
        });
      } catch {
        continue;
      }
      const replacementWords = countNovelWords(generated.content);
      const tooShort = replacementWords < Math.max(20, Math.floor(sourceWords * 0.45));
      const tooLong = replacementWords > sourceWords * 3 + 200;
      const unchanged = computeTextSimilarity(source, generated.content) > REVISION_LOCAL_UNCHANGED_THRESHOLD;
      if (isRevisionRefusal(generated.content) || tooShort || tooLong || unchanged) continue;
      replacements.push({ ...window, replacement: splitParagraphs(generated.content) });
      promptHashes.push(generated.promptHash);
    }

    const revisedText = applyRevisionWindows(originalParagraphs, replacements, paragraphsToDelete).join("\n\n");
    if (replacements.length === 0 && paragraphsToDelete.size === 0) {
      // 全窗口保真失败：failAgent 标记 agent 状态后必须终止控制流，否则后续 finishAgent 会覆盖 failed 状态、
      // saveArtifact 会保存与原文实质相同的修订稿并回环 review，浪费 1 轮 6 次 LLM 调用且丢失失败审计记录。
      // 与 <=1000 字分支一致的兜底：修复结构后转人工审批，不再回环自动复审。
      await ctx.failAgent(agent, new Error("所有局部修订窗口均未通过保真校验"));
      const fallbackRepaired = await repairDraftStructureOnce({ content: workingText, model: project.settings.textModel, skillPrompt });
      const fallbackIteration = run.revisionIteration + 1;
      const fallbackArtifact = await ctx.saveArtifact({ ...run, revisionIteration: fallbackIteration }, {
        projectId: run.projectId,
        workflowRunId: run.id,
        stage: "revision",
        kind: "revision",
        title: `${document.title}全窗口保真失败回退 ${fallbackIteration}`,
        contentMarkdown: fallbackRepaired.content,
        parentArtifactId: draft.id,
        model: project.settings.textModel,
        skillRefs: [],
        contextPacketId: run.contextPacketId ?? undefined,
      });
      await ctx.createApprovalProposal(run, fallbackArtifact, "workflow-manuscript", "所有局部修订窗口均未通过保真校验，已保留修订前正文并转交人工审阅");
      const fallbackRun = await ctx.transition(run, "manuscript-approval", "waiting-approval", { draftArtifactId: fallbackArtifact.id, revisionIteration: fallbackIteration });
      return { run: fallbackRun, continueLoop: false };
    }
    if (countNovelWords(revisedText) <= 1000) {
      await ctx.failAgent(agent, new Error(`局部修订后仅 ${countNovelWords(revisedText)} 字，未超过 1000 字最低篇幅`));
      const minimumRepaired = await repairDraftStructureOnce({ content: workingText, model: project.settings.textModel, skillPrompt });
      const minimumIteration = run.revisionIteration + 1;
      const fallbackArtifact = await ctx.saveArtifact({ ...run, revisionIteration: minimumIteration }, {
        projectId: run.projectId,
        workflowRunId: run.id,
        stage: "revision",
        kind: "revision",
        title: `${document.title}过短修订回退 ${minimumIteration}`,
        contentMarkdown: minimumRepaired.content,
        parentArtifactId: draft.id,
        model: project.settings.textModel,
        skillRefs: [],
        contextPacketId: run.contextPacketId ?? undefined,
      });
      await ctx.createApprovalProposal(run, fallbackArtifact, "workflow-manuscript", "局部修订后正文不足 1000 字，已保留修订前正文并转交人工审阅");
      const minimumRun = await ctx.transition(run, "manuscript-approval", "waiting-approval", { draftArtifactId: fallbackArtifact.id, revisionIteration: minimumIteration });
      return { run: minimumRun, continueLoop: false };
    }
    let repaired;
    try {
      repaired = await repairDraftStructureOnce({ content: revisedText, model: project.settings.textModel, skillPrompt });
    } catch (error) {
      await ctx.failAgent(agent, error);
      throw error;
    }
    const result = { content: repaired.content, promptHash: repaired.promptHash ?? promptHashes.join("+") };
    const nextIteration = run.revisionIteration + 1;
    const revisedRun = { ...run, revisionIteration: nextIteration };
    const artifact = await ctx.saveArtifact(revisedRun, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "revision",
      kind: "revision",
      title: `${document.title}局部修订稿 ${nextIteration}`,
      contentMarkdown: result.content,
      parentArtifactId: draft.id,
      model: project.settings.textModel,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
      contextPacketId: run.contextPacketId ?? undefined,
    });
    await ctx.finishAgent(agent, { ...result, artifactId: artifact.id });
    const nextRun = await ctx.transition(run, "review", "running", { draftArtifactId: artifact.id, revisionIteration: nextIteration });
    return { run: nextRun };
  },
};
