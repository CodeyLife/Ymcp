import { callStructuredNovelModel } from "../ai";
import { formatReviewerContext } from "../context";
import { novelDb } from "../db";
import { runDeterministicQualityChecks, saveQualityReport, type ReviewerFinding } from "../quality";
import { compileNovelStagePrompt, resolveNovelSkills } from "../skills";
import { buildChapterReviewPrompt } from "../prose-prompts";
import { novelMemoryService } from "../memory-service";
import type { NovelAgentRole, QualityDimension, QualityIssue, QualityReport } from "../types";
import { asBlueprint, reviewerSchema, shouldAutoRevise } from "../workflow-shared";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";
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

export const reviewStageHandler: StageHandler = {
  stage: "review",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project } = ctx;
    const [draft, blueprint] = await Promise.all([
      novelDb.workflowArtifacts.get(run.draftArtifactId!),
      novelDb.workflowArtifacts.get(run.blueprintArtifactId!),
    ]);
    if (!draft || !blueprint) throw new Error("审校输入不完整");
    const blueprintData = blueprint.structuredData ? asBlueprint(blueprint.structuredData) : undefined;
    const deterministic = runDeterministicQualityChecks({ text: draft.contentMarkdown, blueprint: blueprintData });
    const numberedDraft = draft.contentMarkdown
      .split(/\n\s*\n/)
      .map((paragraph, index) => `【第${index + 1}段】\n${paragraph.trim()}`)
      .filter((paragraph) => paragraph.trim())
      .join("\n\n");
    const roles: Array<Parameters<typeof buildChapterReviewPrompt>[0]["role"]> = ["style-reviewer", "character-reviewer", "continuity-reviewer", "plot-reviewer"];
    const reviewPackets = new Map<NovelAgentRole, Awaited<ReturnType<typeof novelMemoryService.compileStageContext>>>();
    const reviewOne = async (role: typeof roles[number]) => {
      const [skills, packet] = await Promise.all([
        resolveNovelSkills({ projectId: run.projectId, stage: "review" }),
        run.conversationThreadId
          ? novelMemoryService.compileStageContext({ threadId: run.conversationThreadId, stage: "review", role, instruction: `${role} 独立审校当前章节`, workflowRunId: run.id, skillStage: "review" })
          : novelDb.contextPackets.get(run.contextPacketId!),
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
    const settled = await settleWithConcurrency(roles, 2, reviewOne);
    const failedIndexes = settled.flatMap((result, index) => result.status === "rejected" ? [index] : []);
    if (failedIndexes.length > 0) {
      const retries = await settleWithConcurrency(failedIndexes, 1, (index) => reviewOne(roles[index]));
      retries.forEach((result, retryIndex) => {
        settled[failedIndexes[retryIndex]] = result;
      });
    }
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
    // R11 修复：schema 已强制 rewriteExample 必填（minLength=1），此处仅做最终保险统计
    const majorIssues = reviewers.flatMap((r) => r.issues).filter((i) => i.severity === "major" || i.severity === "blocker");
    const missingRewrite = majorIssues.filter((i) => !i.rewriteExample?.trim());
    if (missingRewrite.length > 0) {
      console.warn(`[review-stage] ${missingRewrite.length}/${majorIssues.length} major+ issues missing rewriteExample after schema enforcement`);
    }
    const report = await saveQualityReport({
      projectId: run.projectId,
      workflowRunId: run.id,
      artifactId: draft.id,
      iteration: run.revisionIteration,
      deterministic,
      reviewers,
      threshold: project.settings.qualityThreshold,
    });
    // 保存质量报告产物到 artifact 账本（与原实现一致：创建但仅用于审计存档）
    const receiptPacket = reviewPackets.get("continuity-reviewer") ?? reviewPackets.values().next().value;
    await ctx.saveArtifact(run, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "review",
      kind: "review",
      title: `质量报告 · 第 ${run.revisionIteration + 1} 轮`,
      contentMarkdown: `# 质量报告\n\n总分：${report.weightedScore} / 5\n\n阻断：${report.blockerCount}\n\n${report.issues.map((item) => `- [${item.severity}] ${item.title}：${item.description}\n  - 建议：${item.suggestion}`).join("\n") || "未发现问题"}`,
      structuredData: { reportId: report.id },
      skillRefs: [],
      contextPacketId: receiptPacket?.id,
    });
    const previousReport = run.qualityReportId ? await novelDb.qualityReports.get(run.qualityReportId) : undefined;
    const comparablePreviousScore = previousReport
      && (previousReport.scoringVersion ?? 1) === (report.scoringVersion ?? 1)
      ? run.previousScore
      : undefined;
    if (isQualityRegression({ previous: previousReport, previousScore: run.previousScore, current: report }) && draft.parentArtifactId) {
      const previousDraft = await novelDb.workflowArtifacts.get(draft.parentArtifactId);
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
