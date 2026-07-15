import { callStructuredNovelModel } from "../ai";
import { formatReviewerContext } from "../context";
import { novelDb } from "../db";
import { runDeterministicQualityChecks, saveQualityReport, type ReviewerFinding } from "../quality";
import { compileNovelStagePrompt, resolveNovelSkills } from "../skills";
import { buildChapterReviewPrompt } from "../prose-prompts";
import { novelMemoryService } from "../memory-service";
import type { NovelAgentRole, QualityDimension, QualityIssue } from "../types";
import { asBlueprint, reviewerSchema, shouldAutoRevise } from "../workflow-shared";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

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
    const roles: Array<Parameters<typeof buildChapterReviewPrompt>[0]["role"]> = ["style-reviewer", "character-reviewer", "continuity-reviewer", "plot-reviewer", "pacing-reviewer"];
    const reviewPackets = new Map<NovelAgentRole, Awaited<ReturnType<typeof novelMemoryService.compileStageContext>>>();
    const settled = await Promise.allSettled(
      roles.map(async (role) => {
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
      }),
    );
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
        }],
      } satisfies ReviewerFinding;
    });
    // R11 修复：检查 major+ issue 的 rewriteExample 覆盖率，记录警告供调试
    const majorIssues = reviewers.flatMap((r) => r.issues).filter((i) => i.severity === "major" || i.severity === "blocker");
    const missingRewrite = majorIssues.filter((i) => !i.rewriteExample?.trim());
    if (missingRewrite.length > 0) {
      console.warn(`[review-stage] ${missingRewrite.length}/${majorIssues.length} major+ issues missing rewriteExample (prompt requires it for major+)`);
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
    if (run.previousScore !== undefined && report.weightedScore < run.previousScore && draft.parentArtifactId) {
      const previousDraft = await novelDb.workflowArtifacts.get(draft.parentArtifactId);
      if (previousDraft) {
        await ctx.createApprovalProposal(run, previousDraft, "workflow-manuscript", `修订分数由 ${run.previousScore} 降至 ${report.weightedScore}，已恢复上一版本`);
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
      previousScore: run.previousScore,
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
