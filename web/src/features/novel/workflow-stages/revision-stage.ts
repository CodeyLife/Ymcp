import { streamNovelModel } from "../ai";
import { novelDb } from "../db";
import { compileNovelStagePrompt, resolveNovelSkills } from "../skills";
import { asBlueprint } from "../workflow-shared";
import type { QualityIssue } from "../types";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";
import { repairDraftStructureOnce } from "./draft-structure-repair";

function splitParagraphs(text: string): string[] {
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
function computeTextSimilarity(a: string, b: string): number {
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

const REVISION_SIMILARITY_THRESHOLD = 0.92;

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

function paragraphRangesInText(text: string, paragraphCount: number): number[] {
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
const STYLE_RULES_TO_PROMOTE = new Set([
  "style.short-sentence-tic",
  "style.interpretive-summary-density",
  "style.emotion-direct",
  "style.emphasis-devaluation",
  "style.template-density",
  "style.aphorism-density",
]);

// R12/R13: LLM reviewer 生成的 warning 常带自定义 rule 文本（非预定义 rule 名），
// 无法通过 STYLE_RULES_TO_PROMOTE 精确匹配。用关键词匹配识别意象机械重复（R12）
// 和对白功能同质化/节奏同构（R13），升级为 major 确保进入修订列表。
const PROMOTABLE_WARNING_PATTERNS = /意象.{0,6}(重复|功能|机械|再现)|对白.{0,6}(功能|同质|试探.{0,4}重复)|试探.{0,6}(直接|确认式|偏向)|节奏.{0,6}(均匀|同构|平直|同质)|功能重复|同一.{0,4}(功能|说明|象征)/;

function shouldPromoteWarning(item: QualityIssue): boolean {
  if (item.severity !== "warning") return false;
  if (item.rule && STYLE_RULES_TO_PROMOTE.has(item.rule)) return true;
  const text = `${item.title} ${item.description}`;
  return PROMOTABLE_WARNING_PATTERNS.test(text);
}

export const revisionStageHandler: StageHandler = {
  stage: "revision",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project, document } = ctx;
    const [draft, blueprint, report, feedback, skills] = await Promise.all([
      novelDb.workflowArtifacts.get(run.draftArtifactId!),
      novelDb.workflowArtifacts.get(run.blueprintArtifactId!),
      novelDb.qualityReports.get(run.qualityReportId!),
      ctx.latestArtifact(run.id, ["review"]),
      resolveNovelSkills({ projectId: run.projectId, stage: "revision", explicitSkillIds: ["embodied-prose", "style-specificity-audit", "imagery-aesthetics"] }),
    ]);
    if (!draft || !report) throw new Error("修订输入不完整");
    const blueprintData = blueprint?.structuredData ? asBlueprint(blueprint.structuredData) : undefined;

    let workingText = draft.contentMarkdown;
    let paragraphs = splitParagraphs(workingText);
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
    if (redundantIssues.length > 0) {
      const paragraphsToDelete = new Set<number>();
      for (const issue of redundantIssues) {
        const targets = collectRevisionParagraphs(issue, paragraphs);
        for (const index of targets) paragraphsToDelete.add(index);
      }
      if (paragraphsToDelete.size > 0) {
        const survivingParagraphs = paragraphs.filter((_, index) => !paragraphsToDelete.has(index));
        workingText = survivingParagraphs.join("\n\n");
        paragraphs = survivingParagraphs;
      }
    }

    // R12/R13 修复：上限从 8 提升到 12——promoted warnings 增加了修订列表条目数，
    // 8 条上限会截断意象重复/对白同质化类 issue，导致它们仍不被修订
    const blockerAndMajor = remainingIssues.filter((item) => item.severity === "blocker" || item.severity === "major").slice(0, 12);
    // Loop 6 修复 #10：skillPrompt 提前定义，供 Path A/B/拒绝路径调用 repairDraftStructureOnce
    const skillPrompt = compileNovelStagePrompt(skills.skills, "revision");

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
      const nextRun = await ctx.transition(run, "deterministic-check", "running", { draftArtifactId: artifact.id, revisionIteration: nextIteration });
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
      ? `\n\n## 本章已批准的兑现项（硬约束，不可省略）\n${blueprintData.mustHappen.map((item) => `- ${item}`).join("\n")}\n修订后正文必须保留这些兑现项，但不得由此扩写或提前完成未列入此处的后续大纲节点。`
      : "";
    const forbiddenBlock = blueprintData?.forbidden?.length
      ? `\n\n## 禁止事项（硬约束，不可触犯）\n${blueprintData.forbidden.map((item) => `- ${item}`).join("\n")}`
      : "";

    // R10 修复：指令式 issue 列表——每个 major+ 问题必须有明确修订指令
    // 有 rewriteExample 的用"参考改写示例修订"，无 rewriteExample 的用"必须删除或重写对应段落"
    const issueList = blockerAndMajor.map((item, index) => {
      const excerptInfo = item.excerpt ? `（原文："${item.excerpt.slice(0, 60)}${item.excerpt.length > 60 ? "..." : ""}"）` : "";
      const ranges = item.revisionRanges?.length
        ? `（段落 ${item.revisionRanges.map((r) => `${r.start}-${r.end}`).join(", ")}）`
        : (typeof item.paragraph === "number" ? `（段落 ${item.paragraph}）` : "");
      const rewriteBlock = item.rewriteExample
        ? `\n  【改写示例——必须参考】\n  ${item.rewriteExample.split("\n").map((line) => `  ${line}`).join("\n")}`
        : `\n  【无改写示例——你必须根据建议自行改写，不得保留原文】`;
      return `${index + 1}. [${item.severity}] ${item.title}${excerptInfo}${ranges}\n  问题：${item.description}\n  修订指令：${item.suggestion}${rewriteBlock}`;
    }).join("\n\n");

    const { agent } = await ctx.createAgentRecord({
      run,
      role: "revision-editor",
      goal: `全文修订 ${blockerAndMajor.length} 个问题`,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
    });

    // R10 修复：移除上下文包——减少 prompt 体积，释放模型输出预算
    // 修订阶段只需正文 + issue 列表 + 蓝图约束，不需要完整上下文包
    const generated = await streamNovelModel({
      model: project.settings.textModel,
      temperature: 0.3,
      role: "revision-editor",
      skillPrompt,
      maxTokens: 8192,
      prompt: `对以下章节正文进行全文修订。你必须逐条处理下方列出的每个问题，每个问题都必须在输出中得到具体修订——不得跳过、不得保留原文不变。${mustHappenBlock}${forbiddenBlock}

## 必须处理的问题（共 ${blockerAndMajor.length} 个，每个都必须修订）
${issueList}

## 原文
${workingText}

## 修订要求（硬约束）
1. 上述每个问题都必须在输出中得到具体处理。有改写示例的必须参考改写示例进行修订；无改写示例的必须根据建议自行改写。
2. 把"替读者下结论"（如"她知道/她明白/她也知道"等心理判断句）改为"让行动、感官、对白或环境承载含义"。
3. 把"模板化表达"替换为只能属于该人物的细节。
4. 把"短句排比"融入完整句式（2-5句/段），仅在决断瞬间保留短句。
5. 保留原文的核心情节、人物关系和关键意象，不得偏离原意。
6. 保持第三人称限知视角和已有文风。
7. 只输出修订后的连续正文，不要解释，不要输出标题或标记。
8. 输出必须与原文有实质差异——如果某个问题涉及"第二个结尾"或"重复收束"，必须删除对应段落而非改写。
${feedback?.stage === "manuscript-approval" ? `\n## 用户意见\n${feedback.contentMarkdown}` : ""}`,
    });
    if (isRevisionRefusal(generated.content)) {
      // LLM 拒绝修订（长度超限/请求分段/约束冲突）——回退到 draft 原文，转交人工审阅
      // 不抛错以避免整个 workflow 失败；保留原始 draft 内容，让人工决定如何处理
      // Loop 3 实测：章节1正文因 LLM "请分多次发送" 拒绝而被替换为3行元消息，最终稿丢失全部叙事内容
      // Loop 6 修复 #10：拒绝路径也必须经过 repairDraftStructureOnce，确保截断第二个结尾、strip 格式标记
      await ctx.failAgent(agent, new Error(`修订模型拒绝任务：${generated.content.slice(0, 160)}`));
      const refusalRepaired = await repairDraftStructureOnce({ content: draft.contentMarkdown, model: project.settings.textModel, skillPrompt });
      const refusalIteration = run.revisionIteration + 1;
      const fallbackArtifact = await ctx.saveArtifact({ ...run, revisionIteration: refusalIteration }, {
        projectId: run.projectId,
        workflowRunId: run.id,
        stage: "revision",
        kind: "revision",
        title: `${document.title}模型拒绝回退 ${refusalIteration}`,
        contentMarkdown: refusalRepaired.content,
        parentArtifactId: draft.id,
        model: project.settings.textModel,
        skillRefs: [],
        contextPacketId: run.contextPacketId ?? undefined,
      });
      await ctx.createApprovalProposal(run, fallbackArtifact, "workflow-manuscript",
        "修订模型拒绝任务（输出长度超限或请求分段发送），已保留原文草稿转交人工审阅；建议人工拆分章节、调整蓝图节拍或缩短目标字数");
      const refusalRun = await ctx.transition(run, "manuscript-approval", "waiting-approval", { draftArtifactId: fallbackArtifact.id, revisionIteration: refusalIteration });
      return { run: refusalRun, continueLoop: false };
    }
    // R10 修复：post-revision 相似度检查——检测 LLM 是否返回了与原文实质相同的内容
    // 如果相似度 > 0.92，说明 LLM 没有进行有效修订，回退到确定性删除 + 原文
    const similarity = computeTextSimilarity(workingText, generated.content);
    if (similarity > REVISION_SIMILARITY_THRESHOLD) {
      await ctx.failAgent(agent, new Error(`修订输出与原文相似度 ${similarity.toFixed(3)} > ${REVISION_SIMILARITY_THRESHOLD}，LLM 未进行有效修订`));
      // 回退策略：在已删除重复段的基础上，额外删除 major+ issue 对应的段落，保留剩余原文
      const extraDeleteSet = new Set<number>();
      const currentParagraphs = splitParagraphs(workingText);
      for (const issue of blockerAndMajor) {
        const targets = collectRevisionParagraphs(issue, currentParagraphs);
        for (const index of targets) extraDeleteSet.add(index);
      }
      let fallbackText = workingText;
      if (extraDeleteSet.size > 0 && extraDeleteSet.size < currentParagraphs.length) {
        const surviving = currentParagraphs.filter((_, index) => !extraDeleteSet.has(index));
        fallbackText = surviving.join("\n\n");
      }
      const fallbackRepaired = await repairDraftStructureOnce({ content: fallbackText, model: project.settings.textModel, skillPrompt });
      const fallbackIteration = run.revisionIteration + 1;
      const fallbackArtifact = await ctx.saveArtifact({ ...run, revisionIteration: fallbackIteration }, {
        projectId: run.projectId,
        workflowRunId: run.id,
        stage: "revision",
        kind: "revision",
        title: `${document.title}相似度回退 ${fallbackIteration}`,
        contentMarkdown: fallbackRepaired.content,
        parentArtifactId: draft.id,
        model: project.settings.textModel,
        skillRefs: [],
        contextPacketId: run.contextPacketId ?? undefined,
      });
      await ctx.createApprovalProposal(run, fallbackArtifact, "workflow-manuscript",
        `LLM 修订输出与原文相似度过高（${similarity.toFixed(3)}），已回退到确定性删除并转交人工审阅`);
      const fallbackRun = await ctx.transition(run, "manuscript-approval", "waiting-approval", { draftArtifactId: fallbackArtifact.id, revisionIteration: fallbackIteration });
      return { run: fallbackRun, continueLoop: false };
    }
    let repaired;
    try {
      repaired = await repairDraftStructureOnce({ content: generated.content, model: project.settings.textModel, skillPrompt });
    } catch (error) {
      await ctx.failAgent(agent, error);
      throw error;
    }
    const result = { ...generated, content: repaired.content, promptHash: repaired.promptHash ?? generated.promptHash };
    const nextIteration = run.revisionIteration + 1;
    const revisedRun = { ...run, revisionIteration: nextIteration };
    const artifact = await ctx.saveArtifact(revisedRun, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "revision",
      kind: "revision",
      title: `${document.title}定向修订稿 ${nextIteration}`,
      contentMarkdown: result.content,
      parentArtifactId: draft.id,
      model: project.settings.textModel,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
      contextPacketId: run.contextPacketId ?? undefined,
    });
    await ctx.finishAgent(agent, { ...result, artifactId: artifact.id });
    const nextRun = await ctx.transition(run, "deterministic-check", "running", { draftArtifactId: artifact.id, revisionIteration: nextIteration });
    return { run: nextRun };
  },
};
