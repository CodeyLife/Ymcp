import { streamNovelModel } from "../ai";
import { formatContextPacket } from "../context";
import { novelDb } from "../db";
import { novelMemoryService } from "../memory-service";
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

function formatParagraphSelection(indices: number[]): string {
  if (indices.length === 0) return "";
  const ranges: string[] = [];
  let start = indices[0] + 1;
  let end = start;
  for (const index of indices.slice(1)) {
    const paragraph = index + 1;
    if (paragraph === end + 1) {
      end = paragraph;
      continue;
    }
    ranges.push(start === end ? `${start}` : `${start}—${end}`);
    start = paragraph;
    end = paragraph;
  }
  ranges.push(start === end ? `${start}` : `${start}—${end}`);
  return ranges.join("、");
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
    const revisableIssues = report.issues.filter(
      (item) => !(item.deterministic && item.rule === "chapter-blueprint.mustHappen"),
    );

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

    const blockerAndMajor = remainingIssues.filter((item) => item.severity === "blocker" || item.severity === "major").slice(0, 8);
    // Loop 6 修复 #10：skillPrompt 提前定义，供 Path A/B/拒绝路径调用 repairDraftStructureOnce
    const skillPrompt = compileNovelStagePrompt(skills.skills, "revision");

    const issueParagraphs = new Set<number>();
    const issueTargets = new Map<string, number[]>();
    for (const issue of blockerAndMajor) {
      const targets = collectRevisionParagraphs(issue, paragraphs);
      issueTargets.set(issue.id, targets);
      for (const index of targets) issueParagraphs.add(index);
    }

    // 如果删除了重复段但没有其他需要 LLM 修订的段落，直接保存删除后的正文
    // Loop 6 修复 #10：Path A 也必须经过 repairDraftStructureOnce，确保截断第二个结尾、strip 格式标记
    if (redundantIssues.length > 0 && issueParagraphs.size === 0) {
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

    // Loop 6 修复 #10：Path B 也必须经过 repairDraftStructureOnce，确保截断第二个结尾、strip 格式标记
    if (issueParagraphs.size === 0) {
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
      await ctx.createApprovalProposal(run, artifact, "workflow-manuscript", blockerAndMajor.length
        ? "重大质量问题无法安全定位到具体段落，已保留原文并转交人工审阅"
        : "没有可安全自动修订的重大问题，已保留原文并转交人工审阅");
      const nextRun = await ctx.transition(run, "manuscript-approval", "waiting-approval", { draftArtifactId: artifact.id, revisionIteration: nextIteration });
      return { run: nextRun, continueLoop: false };
    }

    const mustHappenBlock = blueprintData?.mustHappen?.length
      ? `\n\n## 必须落实的节拍（硬约束，不可省略）\n${blueprintData.mustHappen.map((item) => `- ${item}`).join("\n")}\n修订后正文必须让以下每个节拍在文中以具体行动和可识别结果呈现。`
      : "";
    const forbiddenBlock = blueprintData?.forbidden?.length
      ? `\n\n## 禁止事项（硬约束，不可触犯）\n${blueprintData.forbidden.map((item) => `- ${item}`).join("\n")}`
      : "";

    const numberedText = paragraphs.map((p, i) => {
      const needsRevision = issueParagraphs.has(i);
      const marker = needsRevision ? `【第${i + 1}段·需修订】` : `【第${i + 1}段·保留】`;
      return `${marker}\n${p}`;
    }).join("\n\n");

    const issueList = blockerAndMajor.map((item) => {
      const targets = formatParagraphSelection(issueTargets.get(item.id) ?? []);
      const paraInfo = targets ? `（可修改第${targets}段）` : item.excerpt ? `（涉及："${item.excerpt.slice(0, 30)}..."）` : "";
      return `- [${item.severity}] ${item.title}${paraInfo}：${item.description}；建议：${item.suggestion}`;
    }).join("\n");

    const preserveList = paragraphs.map((_, i) => i + 1).filter((i) => !issueParagraphs.has(i - 1)).join("、");
    const preserveInstruction = preserveList
      ? `- 标注为「保留」的段落（第${preserveList}段）必须原样输出，不改一字`
      : "- 每个段落都有明确的问题定位，只能按各段对应问题进行定向修改";

    const packet = run.conversationThreadId
      ? await novelMemoryService.compileStageContext({ threadId: run.conversationThreadId, stage: "revision", role: "revision-editor", instruction: "依据质量报告定向修订当前章节", workflowRunId: run.id, skillStage: "revision" })
      : await novelDb.contextPackets.get(run.contextPacketId!);
    if (!packet) throw new Error("修订上下文不存在");

    const { agent } = await ctx.createAgentRecord({
      run,
      role: "revision-editor",
      goal: `定向修订 ${blockerAndMajor.length} 个问题（保留 ${paragraphs.length - issueParagraphs.size} 段不变）`,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
    });
    const generated = await streamNovelModel({
      model: project.settings.textModel,
      temperature: 0.3,
      role: "revision-editor",
      skillPrompt,
      maxTokens: 8192,
      prompt: `定向修订以下章节正文。只修改标注为「需修订」的段落，标注为「保留」的段落必须原样输出，不得改动任何文字。${mustHappenBlock}${forbiddenBlock}

## 需要处理的问题
${issueList}

## 原文（带段落标注）
${numberedText}

## 修订要求
${preserveInstruction}
- 标注为「需修订」的段落，根据对应问题进行修改
- 可以删除、合并或重写标注为「需修订」的段落，也可以在这些段落相邻位置插入必要的新段落
- “需修订”表示允许修改的边界，不要求为了改动而改动；只做解决问题所必需的调整
- 不要输出段落标注标记（【第N段·xxx】），只输出正文
- 保持第三人称限知视角和已有文风
${feedback?.stage === "manuscript-approval" ? `\n## 用户意见\n${feedback.contentMarkdown}` : ""}

## 修订上下文
${formatContextPacket(packet)}`,
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
        contextPacketId: packet.id,
      });
      await ctx.createApprovalProposal(run, fallbackArtifact, "workflow-manuscript",
        "修订模型拒绝任务（输出长度超限或请求分段发送），已保留原文草稿转交人工审阅；建议人工拆分章节、调整蓝图节拍或缩短目标字数");
      const refusalRun = await ctx.transition(run, "manuscript-approval", "waiting-approval", { draftArtifactId: fallbackArtifact.id, revisionIteration: refusalIteration });
      return { run: refusalRun, continueLoop: false };
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
      contextPacketId: packet.id,
    });
    await ctx.finishAgent(agent, { ...result, artifactId: artifact.id });
    const nextRun = await ctx.transition(run, "deterministic-check", "running", { draftArtifactId: artifact.id, revisionIteration: nextIteration, contextPacketId: packet.id });
    return { run: nextRun };
  },
};
