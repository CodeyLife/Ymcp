import { callStructuredNovelModel } from "../ai";
import { formatContextPacket, formatReviewerContext } from "../context";
import { runDeterministicQualityChecks, saveQualityReport, type ReviewerFinding } from "../quality";
import { compileNovelStagePrompt, resolveNovelSkills } from "../skills";
import { buildChapterReviewPrompt } from "../prose-prompts";
import { novelMemoryService } from "../memory-service";
import { novelDb } from "../db";
import { assessQualityReportLearning, getWorkflowReplayInstruction } from "../learning";
import { captureChapterRuleReplay } from "../craft-rule-evolution";
import type { GenerationAuditIssue, GenerationAuditReport, GenerationAuditRound, NovelAgentRole, QualityDimension, QualityIssue, QualityReport } from "../types";
import { asBlueprint, auditIssueSchema, hasMajorOrBlocker, reviewerSchema, shouldAutoRevise } from "../workflow-shared";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";
import { paragraphRangesInText } from "./revision-stage";
import { settleWithConcurrency } from "./settled-pool";

function majorCount(report: QualityReport) {
  return report.issues.filter((issue) => issue.severity === "major").length;
}

export function isQualityRegression(params: { previous?: QualityReport; previousScore?: number; current: QualityReport }) {
  if (!params.previous) return params.previousScore !== undefined && params.current.weightedScore < params.previousScore;
  if ((params.previous.scoringVersion ?? 1) !== (params.current.scoringVersion ?? 1)) return false;
  if (params.current.blockerCount !== params.previous.blockerCount) return params.current.blockerCount > params.previous.blockerCount;
  const previousMajors = majorCount(params.previous);
  const currentMajors = majorCount(params.current);
  if (currentMajors !== previousMajors) return currentMajors > previousMajors;
  return params.current.weightedScore < params.previous.weightedScore;
}

/**
 * 读取 prose-audit 是否启用及迭代次数。
 *
 * C 板块与 A/B 板块的迭代机制不同：
 * - A 板块（generation.ts runPlotDesignTask）：在生成阶段内部做 audit+iterate 循环，maxIterations 控制重新生成次数
 * - B 板块（blueprint-stage.ts）：同 A 板块，在生成阶段内部做 audit+iterate 循环
 * - C 板块（review-stage.ts）：利用现有 revision-stage 作为迭代机制，prose-audit 只在 review-stage 调用一次，
 *   issues 注入 quality report 后参与 shouldAutoRevise 决策与 revision-stage 修订列表
 *
 * 因此本环境变量控制的是"是否启用 prose-audit"：
 * - 未设置：默认 1（启用 1 次 prose-audit，与 blueprint-audit 默认行为一致）
 * - "0"：关闭（向后兼容场景）
 * - "1"：启用（每次 review 跑 1 次 prose-audit）
 * - "2" / "3"：启用且未来可扩展为内部 audit+iterate 循环（当前实现只跑 1 次）
 *
 * 上限 3 次，与 A/B 板块保持一致。
 */
export function getProseAuditMaxIterations(): number {
  const raw = process.env.NOVEL_PROSE_AUDIT_MAX_ITER;
  if (raw === undefined || raw === "") return 1;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 1;
  return Math.min(3, parsed);
}

/**
 * 把 prose-audit 的 issues 转换为 ReviewerFinding，注入到 reviewers 数组。
 *
 * 转换规则：
 * - role: "quality-editor"（prose-audit 作为元审核维度，与 4 个 reviewer 并列聚合）
 * - scores: 空（prose-audit 不打分，避免污染 weightedScore）
 * - dimension: 直接使用 LLM 输出的 issue.dimension（schema 已要求），不再机械词匹配
 * - rule: "prose-audit.<slugified-title>"
 * - description: audit issue 的 evidence（原文证据），若 origin 非 new 则附加来源标注
 * - excerpt: audit issue 的 evidence（用于 findIssueParagraph 模糊匹配定位段落）
 * - paragraph: 复用 revision-stage 的 paragraphRangesInText 解析段落引用
 *   （支持"【第N段】"、"第N段"、"第N-M段"等多种格式），取首个段落作为定位锚点
 * - revisionRanges: 由 paragraphRangesInText 解析的范围（若有）
 * - rewriteExample: suggestion（reviewerSchema 要求 minLength=1）
 *
 * 注意：prose-audit 的 issues 进入 quality report 后，会参与 shouldAutoRevise 决策（major+ 数量增加 → 触发 revision），
 * 并在 revision-stage 的 issues 列表中提供修订建议。若 evidence 包含段落引用，revision-stage 可定位段落；
 * 否则该 issue 会被 planRevisionWindows 归类为 unlocated，不进入自动修订列表，但仍影响 shouldAutoRevise 决策。
 */
export function proseAuditIssueToReviewerFinding(issue: GenerationAuditIssue, index: number, paragraphCount = 9999): Omit<QualityIssue, "id" | "deterministic"> {
  const title = issue.title?.trim() || `prose-audit issue ${index + 1}`;
  const evidence = issue.evidence?.trim() || "";
  const suggestion = issue.suggestion?.trim() || "请基于审核证据修订。";
  // 复用 revision-stage 的段落解析逻辑，支持多种格式
  const paragraphIndices = paragraphRangesInText(evidence, paragraphCount);
  const paragraph = paragraphIndices.length > 0 ? paragraphIndices[0] + 1 : undefined;
  const revisionRanges = paragraphIndices.length > 0
    ? paragraphIndices.map((p) => ({ start: p + 1, end: p + 1 }))
    : undefined;
  // dimension 直接用 LLM 输出，schema 已强制要求
  const dimension = issue.dimension;
  // origin 非 new 时在 description 附加来源标注，便于人工审计追溯
  const originTag = issue.origin && issue.origin !== "new" ? `[${issue.origin === "upgrade" ? "升级 reviewer 判断" : "降级 reviewer 判断"}] ` : "";
  const slug = title.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || `issue-${index + 1}`;
  return {
    dimension,
    severity: issue.severity,
    title,
    description: originTag + (evidence || title),
    excerpt: evidence || undefined,
    paragraph,
    revisionRanges,
    rule: `prose-audit.${slug}`,
    suggestion,
    rewriteExample: suggestion,
  };
}

/** Coordinate meta-review conclusions with the reviewer issues they reference. */
export function reconcileProseAuditIssues(
  reviewers: ReviewerFinding[],
  auditIssues: GenerationAuditIssue[],
  paragraphCount: number,
): ReviewerFinding[] {
  const reconciled: ReviewerFinding[] = reviewers.map((reviewer) => ({
    ...reviewer,
    scores: { ...reviewer.scores },
    issues: reviewer.issues.map((issue) => ({
      ...issue,
      ...(issue.revisionRanges ? { revisionRanges: issue.revisionRanges.map((range) => ({ ...range })) } : {}),
    })),
  }));
  const newIssues: Array<Omit<QualityIssue, "id" | "deterministic">> = [];

  for (const [index, auditIssue] of auditIssues.entries()) {
    if ((auditIssue.origin === "upgrade" || auditIssue.origin === "downgrade") && auditIssue.sourceIssueId) {
      let matched = false;
      for (const reviewer of reconciled) {
        const issueIndex = reviewer.issues.findIndex((issue) => issue.sourceId === auditIssue.sourceIssueId);
        if (issueIndex < 0) continue;
        const current = reviewer.issues[issueIndex];
        const auditFinding = proseAuditIssueToReviewerFinding(auditIssue, index, paragraphCount);
        reviewer.issues[issueIndex] = {
          ...current,
          dimension: auditIssue.dimension,
          severity: auditIssue.severity,
          description: `${current.description}\n\n[元审核${auditIssue.origin === "upgrade" ? "升级" : "降级"}] ${auditIssue.evidence}`,
          excerpt: auditFinding.excerpt ?? current.excerpt,
          paragraph: auditFinding.paragraph ?? current.paragraph,
          revisionRanges: auditFinding.revisionRanges ?? current.revisionRanges,
          suggestion: auditIssue.suggestion,
          rewriteExample: auditIssue.suggestion,
        };
        matched = true;
        break;
      }
      if (matched) continue;
    }
    newIssues.push(proseAuditIssueToReviewerFinding({ ...auditIssue, origin: "new" }, index, paragraphCount));
  }

  reconciled.push({ role: "quality-editor", scores: {}, issues: newIssues });
  return reconciled;
}

/**
 * 调用 prose-audit skill 对章节正文（draft）做独立 LLM 元审核。
 *
 * 通过 explicitSkillIds 显式启用 prose-audit，避免污染 PROFILE_SKILLS 默认集合
 * （PROFILE_SKILLS 中的 4 个 reviewer 不应拿到 audit skill 的 prompt）。
 *
 * builtin skill 的 prompt 不会被 compileNovelStagePrompt 拼接（review stage 只拼 custom skill），
 * 因此用 formatSkillPrompt 显式拼接 prose-audit 的完整 prompt，让 LLM 拿到具体审核指导。
 *
 * 与 A/B 板块的 runBlueprintAudit / runPlotSegmentAudit 不同，本函数还把 4 个 reviewer 的 findings
 * 作为上下文传入，让 prose-audit 做元审核（报告一致性、遗漏检测、误判检测）。
 */
export async function runProseAudit(params: {
  projectId: string;
  documentId?: string;
  documentTitle: string;
  draftContent: string;
  blueprintMarkdown: string;
  reviewerFindings: ReviewerFinding[];
  contextPacketId: string;
  db?: typeof novelDb;
  signal?: AbortSignal;
}): Promise<GenerationAuditRound> {
  const db = params.db ?? novelDb;
  const project = await db.projects.get(params.projectId);
  if (!project) throw new Error("项目不存在");
  const auditSkills = await resolveNovelSkills({ projectId: params.projectId, stage: "review", explicitSkillIds: ["prose-audit"], db });
  if (!auditSkills.skills.some((skill) => skill.skillId === "prose-audit")) {
    throw new Error("prose-audit skill 未在 BUILTIN_NOVEL_SKILLS 中找到");
  }
  const packet = await db.contextPackets.get(params.contextPacketId);
  const contextMarkdown = packet ? formatContextPacket(packet) : "（无冻结上下文）";
  const currentDocument = params.documentId ? await db.documents.get(params.documentId) : undefined;
  const neighboringDocuments = currentDocument
    ? (await db.documents.where("projectId").equals(params.projectId)
      .and((item) => !item.deletedAt && item.id !== currentDocument.id && item.order < currentDocument.order && Boolean(item.plainText.trim()))
      .sortBy("order"))
      .slice(-3)
    : [];
  const neighboringChapterExcerpts = neighboringDocuments.length
    ? neighboringDocuments.map((item) => {
      const compact = item.plainText.replace(/\s+/g, " ").trim();
      return `### ${item.title}\n开头：${compact.slice(0, 500)}\n结尾：${compact.slice(Math.max(0, compact.length - 300))}`;
    }).join("\n\n")
    : "（没有可比较的前序章节）";
  // 把 draft 正文按段落编号，便于 prose-audit 在 evidence 中引用【第N段】
  const numberedDraft = params.draftContent
    .split(/\n\s*\n/)
    .map((paragraph, index) => `【第${index + 1}段】\n${paragraph.trim()}`)
    .filter((paragraph) => paragraph.trim())
    .join("\n\n");
  // 把 4 个 reviewer 的 findings 摘要传入，供 prose-audit 做元审核
  const reviewerSummaries = params.reviewerFindings.length
    ? params.reviewerFindings.map((r) => {
      const issues = r.issues.map((i, idx) => `  ${idx + 1}. [sourceIssueId=${i.sourceId ?? `${r.role}:${idx}`}] [${i.severity}] ${i.title}：${i.description}${i.suggestion ? `\n     建议：${i.suggestion}` : ""}`).join("\n");
      return `### ${r.role}\n分数：${Object.entries(r.scores).map(([k, v]) => `${k}=${v}`).join(", ") || "未打分"}\n问题：\n${issues || "  无"}`;
    }).join("\n\n")
    : "（reviewer 未产出 findings）";
  const prompt = `# 审核任务\n对章节正文做元审核与综合审核：直接审 draft 正文，同时参考 reviewer 的报告，做综合判断、遗漏检测、误判检测、报告一致性检查。\n\n## 章节标题\n${params.documentTitle}\n\n## 章节蓝图（Markdown）\n${params.blueprintMarkdown}\n\n## 正文（按段落编号）\n${numberedDraft}\n\n## reviewer 的审核发现\n${reviewerSummaries}\n\n## 最近前序章节对照\n${neighboringChapterExcerpts}\n\n比较当前章与前序章节的状态承接、开场框架、核心动作、意象与章尾功能。相同母题若获得新的信息、关系或情绪功能可以保留；若只是换词复用同一时间标记、天气、地点巡看、整理物件、说明顺序或收束方式，应报告跨章模板化，并指出当前章的具体证据。不得因题材共有物件或作者稳定语体本身报错。\n\n# 冻结上下文摘要\n${contextMarkdown}\n\n# 审核输出要求\n- 基于 prose-audit skill 的弹性判断风格：网文经验（烽火/猫腻/超级大坦克科比）+ 项目语境\n- severity 由你基于问题影响和具体语境判断\n- dimension 由你判断该 issue 属于哪个质量维度（plot/characterVoice/sceneEmbodiment/dialogue/specificity/hookPayoff/continuity/readerRetention）\n- 没问题的方面不必报告，避免凑数\n- 每个 issue 必须引用具体段落编号（如【第N段】）或原文片段作为证据\n- 必须给出具体修订建议\n- origin 字段标注来源：new（本审核新增）/ upgrade（升级 reviewer 判断）/ downgrade（降级 reviewer 判断）；默认 new\n- origin 为 upgrade 或 downgrade 时，sourceIssueId 必须填写 reviewer 报告中的稳定 sourceIssueId\n- 不要重复 reader-reviewer 已报告的读者留存问题，只在发现遗漏或与 reader-reviewer 矛盾时报告 readerRetention 维度\n\n按 schema 输出 summary 和 issues 数组。`;
  const auditSkillPrompt = `${compileNovelStagePrompt(auditSkills.skills, "review")}\n\n## 正文元审核与综合审核职责\n综合核对局部审核报告与正文证据，检查遗漏、误判和互相冲突的建议。剧情因果、人物主体性与声音、现场体验、语言准确性、意象功能、章节主导功能及长篇余量需要整体权衡；不得把固定句式、作者风格、章尾类型或所谓通用质感公式当作合格标准。修订建议必须说明局部改动对其他维度的风险。`;
  const result = await callStructuredNovelModel<{ summary: string; issues: GenerationAuditIssue[] }>({
    model: project.settings.textModel,
    temperature: 0.15,
    role: "quality-editor",
    skillPrompt: auditSkillPrompt,
    schema: auditIssueSchema,
    prompt: prompt.replace("基于 prose-audit skill 的弹性判断风格：网文经验（烽火/猫腻/超级大坦克科比）+ 项目语境", "基于版本化审校规则、当前项目目标与正文证据进行跨题材判断，不套用特定作者或作品风格"),
    signal: params.signal,
    maxTokens: 4096,
  });
  return {
    iteration: 0,
    summary: String(result.data.summary ?? ""),
    issues: Array.isArray(result.data.issues) ? result.data.issues : [],
    triggeredIteration: false,
  };
}

export const reviewStageHandler: StageHandler = {
  stage: "review",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project, db } = ctx;
    const [draft, blueprint] = await Promise.all([
      db.workflowArtifacts.get(run.draftArtifactId!),
      db.workflowArtifacts.get(run.blueprintArtifactId!),
    ]);
    if (!draft || !blueprint) throw new Error("审校输入不完整");
    const blueprintData = blueprint.structuredData ? asBlueprint(blueprint.structuredData) : undefined;
    const deterministic = runDeterministicQualityChecks({ text: draft.contentMarkdown, blueprint: blueprintData });
    const numberedDraft = draft.contentMarkdown
      .split(/\n\s*\n/)
      .map((paragraph, index) => `【第${index + 1}段】\n${paragraph.trim()}`)
      .filter((paragraph) => paragraph.trim())
      .join("\n\n");
    const roles: Array<Parameters<typeof buildChapterReviewPrompt>[0]["role"]> = ["style-reviewer", "character-reviewer", "continuity-reviewer", "plot-reviewer", "reader-reviewer"];
    const reviewPackets = new Map<NovelAgentRole, Awaited<ReturnType<typeof novelMemoryService.compileStageContext>>>();
    const reviewOne = async (role: typeof roles[number]) => {
      const [skills, packet] = await Promise.all([
        resolveNovelSkills({ projectId: run.projectId, stage: "review", db: ctx.db }),
        run.conversationThreadId
          ? novelMemoryService.compileStageContext({ threadId: run.conversationThreadId, stage: "review", role, instruction: `${role} 独立审校当前章节`, workflowRunId: run.id, skillStage: "review", db: ctx.db })
          : db.contextPackets.get(run.contextPacketId!),
      ]);
      if (!packet) throw new Error("审校上下文不存在");
      reviewPackets.set(role, packet);
      const { agent } = await ctx.createAgentRecord({
        run,
        role,
        goal: `${role} 独立审校`,
        skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
      });
      try {
        const result = await callStructuredNovelModel<Record<string, unknown>>({
          model: project.settings.textModel,
          temperature: 0.15,
          role,
          skillPrompt: compileNovelStagePrompt(skills.skills, "review"),
          schema: reviewerSchema,
          prompt: buildChapterReviewPrompt({
            role,
            blueprintMarkdown: blueprint.contentMarkdown,
            numberedDraft,
            reviewerContext: formatReviewerContext(packet),
          }),
        });
        await ctx.finishAgent(agent, result);
        const data = result.data as { scores: Partial<Record<QualityDimension, number>>; issues: Array<Omit<QualityIssue, "id" | "deterministic">> };
        return { role, scores: data.scores, issues: data.issues } satisfies ReviewerFinding;
      } catch (error) {
        await ctx.failAgent(agent, error);
        throw error;
      }
    };
    // ai.ts 内部已对限流/空内容等可重试错误做了 3-5 次重试 + 短退避（3s/5s/8s/12s/15s），
    // 外层再补一次重试属冗余，只会放大 HTTP 请求量。
    // 失败的 reviewer 直接走 reviewer.unavailable 降级路径（见下方 map 分支），不阻塞 review-stage 主流程。
    const settled = await settleWithConcurrency(roles, 2, reviewOne);
    const reviewers: ReviewerFinding[] = settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const role = roles[index];
      const message = result.reason instanceof Error ? result.reason.message : "未知错误";
      return {
        role,
        scores: {},
        issues: [{
          dimension: "continuity",
          severity: "warning",
          title: `${role} 审校不可用`,
          description: `该审校维度因调用失败而降级：${message}`,
          rule: "reviewer.unavailable",
          suggestion: "可重试该维度或进行人工审阅。其它维度的审校结果仍然有效。",
          rewriteExample: "结构问题，审校调用失败需人工复核后再决定改写方向。",
        }],
      } satisfies ReviewerFinding;
    });
    for (const reviewer of reviewers) {
      reviewer.issues.forEach((issue, issueIndex) => {
        issue.sourceId ||= `${reviewer.role}:${issueIndex}`;
      });
    }
    // R11 修复：schema 已强制 rewriteExample 必填（minLength=1），此处仅做最终保险统计
    const majorIssues = reviewers.flatMap((r) => r.issues).filter((i) => i.severity === "major" || i.severity === "blocker");
    const missingRewrite = majorIssues.filter((i) => !i.rewriteExample?.trim());
    if (missingRewrite.length > 0) {
      console.warn(`[review-stage] ${missingRewrite.length}/${majorIssues.length} major+ issues missing rewriteExample after schema enforcement`);
    }

    // Loop 4：C 板块闭环——在 4 个 reviewer 完成后、saveQualityReport 之前调用 prose-audit
    // prose-audit 作为元审核维度：直接审 draft 正文 + 参考 4 个 reviewer 报告，做综合判断、遗漏检测、误判检测、报告一致性检查
    // audit issues 转换为 ReviewerFinding（role="quality-editor"，scores=空）注入 reviewers 数组，
    // 与 4 个 reviewer 的 issues 一起聚合到 quality report，参与 shouldAutoRevise 决策与 revision-stage 修订列表
    // 迭代机制：C 板块利用现有 revision-stage 作为"按审核意见迭代"，revision 后回到 review 再次跑 prose-audit 形成再审
    // M3 修复：prose-audit 失败时降级（与 reviewer.unavailable 模式一致），不阻塞 review-stage 主流程
    const proseAuditMaxIter = getProseAuditMaxIterations();
    let proseAuditReport: GenerationAuditReport | undefined;
    const draftParagraphCount = draft.contentMarkdown.split(/\n\s*\n/).filter((p) => p.trim()).length;
    if (proseAuditMaxIter > 0) {
      try {
        const auditRound = await runProseAudit({
          projectId: run.projectId,
          documentId: ctx.document.id,
          documentTitle: ctx.document.title,
          draftContent: draft.contentMarkdown,
          blueprintMarkdown: blueprint.contentMarkdown,
          reviewerFindings: reviewers,
          contextPacketId: run.contextPacketId!,
          db: ctx.db,
        });
        auditRound.iteration = 1;
        auditRound.triggeredIteration = hasMajorOrBlocker(auditRound.issues);
        const reconciledReviewers = reconcileProseAuditIssues(reviewers, auditRound.issues, draftParagraphCount);
        reviewers.splice(0, reviewers.length, ...reconciledReviewers);
        proseAuditReport = {
          auditSkillId: "prose-audit",
          mechanism: "external-revision",
          rounds: [auditRound],
          improved: !hasMajorOrBlocker(auditRound.issues),
          remainingMajorCount: auditRound.issues.filter((issue) => issue.severity === "blocker" || issue.severity === "major").length,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知错误";
        console.warn(`[review-stage] prose-audit 调用失败，降级跳过：${message}`);
        proseAuditReport = {
          auditSkillId: "prose-audit",
          mechanism: "external-revision",
          rounds: [],
          improved: false,
          remainingMajorCount: 0,
          error: message,
        };
      }
    }

    const report = await saveQualityReport({
      projectId: run.projectId,
      workflowRunId: run.id,
      artifactId: draft.id,
      iteration: run.revisionIteration,
      deterministic,
      reviewers,
      threshold: project.settings.qualityThreshold,
      db: ctx.db,
    });
    try {
      report.learning = await assessQualityReportLearning({
        projectId: run.projectId,
        workflowRunId: run.id,
        report,
        draftExcerpt: draft.contentMarkdown,
        db: ctx.db,
      });
      report.learningReplay = report.learning.conclusion === "propose-improvement"
        ? await captureChapterRuleReplay({ projectId: run.projectId, documentId: run.targetDocumentId, instruction: await getWorkflowReplayInstruction(run.id, ctx.db), scenarioClass: "正式章节审校失败场景" }, ctx.db)
        : undefined;
      report.learningStatus = "completed";
      report.learningError = undefined;
    } catch (error) {
      report.learningStatus = "failed";
      report.learningError = error instanceof Error ? error.message : "审校经验评估失败";
    }
    report.updatedAt = Date.now();
    report.revision += 1;
    await db.qualityReports.put(report);
    // 保存质量报告产物到 artifact 账本（与原实现一致：创建但仅用于审计存档）
    // Loop 4：若启用 prose-audit，把 auditReport 写入 review artifact 的 structuredData，便于审计追溯
    const receiptPacket = reviewPackets.get("continuity-reviewer") ?? reviewPackets.values().next().value;
    await ctx.saveArtifact(run, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "review",
      kind: "review",
      title: `质量报告 · 第 ${run.revisionIteration + 1} 轮`,
      contentMarkdown: `# 质量报告\n\n总分：${report.weightedScore} / 5\n\n阻断：${report.blockerCount}\n\n${report.issues.map((item) => `- [${item.severity}] ${item.title}：${item.description}\n  - 建议：${item.suggestion}`).join("\n") || "未发现问题"}`,
      structuredData: proseAuditReport
        ? { reportId: report.id, auditReport: proseAuditReport, learning: report.learning, learningStatus: report.learningStatus, learningError: report.learningError }
        : { reportId: report.id, learning: report.learning, learningStatus: report.learningStatus, learningError: report.learningError },
      skillRefs: [],
      contextPacketId: receiptPacket?.id,
    });
    const previousReport = run.qualityReportId ? await db.qualityReports.get(run.qualityReportId) : undefined;
    const comparablePreviousScore = previousReport
      && (previousReport.scoringVersion ?? 1) === (report.scoringVersion ?? 1)
      ? run.previousScore
      : undefined;
    if (isQualityRegression({ previous: previousReport, previousScore: run.previousScore, current: report }) && draft.parentArtifactId) {
      const previousDraft = await db.workflowArtifacts.get(draft.parentArtifactId);
      if (previousDraft) {
        await ctx.createApprovalProposal(run, previousDraft, "workflow-manuscript", `修订版本的 blocker/major/分数综合质量退步，已恢复上一版本（${run.previousScore ?? previousReport?.weightedScore} → ${report.weightedScore}）`);
        const nextRun = await ctx.transition(run, "manuscript-approval", "waiting-approval", {
          qualityReportId: run.qualityReportId,
          draftArtifactId: previousDraft.id,
        });
        return { run: nextRun, continueLoop: false };
      }
    }
    const shouldRevise = shouldAutoRevise({
      passed: report.passed,
      iteration: run.revisionIteration,
      maxIterations: project.settings.maxAutoRevisions,
      previousScore: comparablePreviousScore,
      currentScore: report.weightedScore,
    });
    if (shouldRevise) {
      const nextRun = await ctx.transition(run, "revision", "running", { qualityReportId: report.id, previousScore: report.weightedScore });
      return { run: nextRun };
    }
    await ctx.createApprovalProposal(run, draft, "workflow-manuscript", report.passed ? "章节正文已通过审校" : "章节正文需人工决策");
    const nextRun = await ctx.transition(run, "manuscript-approval", "waiting-approval", { qualityReportId: report.id, draftArtifactId: draft.id });
    return { run: nextRun, continueLoop: false };
  },
};
