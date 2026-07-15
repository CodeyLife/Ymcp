import { callStructuredNovelModel } from "../ai";
import { formatReviewerContext } from "../context";
import { novelDb } from "../db";
import { runDeterministicQualityChecks, saveQualityReport, type ReviewerFinding } from "../quality";
import { compileNovelStagePrompt, resolveNovelSkills } from "../skills";
import type { NovelAgentRole, QualityDimension, QualityIssue } from "../types";
import { asBlueprint, reviewerSchema, shouldAutoRevise } from "../workflow-shared";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

export const reviewStageHandler: StageHandler = {
  stage: "review",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project } = ctx;
    const [draft, blueprint, packet] = await Promise.all([
      novelDb.workflowArtifacts.get(run.draftArtifactId!),
      novelDb.workflowArtifacts.get(run.blueprintArtifactId!),
      novelDb.contextPackets.get(run.contextPacketId!),
    ]);
    if (!draft || !blueprint || !packet) throw new Error("审校输入不完整");
    const blueprintData = blueprint.structuredData ? asBlueprint(blueprint.structuredData) : undefined;
    const deterministic = runDeterministicQualityChecks({ text: draft.contentMarkdown, blueprint: blueprintData });
    const numberedDraft = draft.contentMarkdown
      .split(/\n\s*\n/)
      .map((paragraph, index) => `【第${index + 1}段】\n${paragraph.trim()}`)
      .filter((paragraph) => paragraph.trim())
      .join("\n\n");
    const roles: NovelAgentRole[] = ["style-reviewer", "character-reviewer", "continuity-reviewer", "plot-reviewer", "pacing-reviewer"];
    const settled = await Promise.allSettled(
      roles.map(async (role) => {
        const skills = await resolveNovelSkills({ projectId: run.projectId, stage: "review" });
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
            prompt: `独立审校下面正文。不要读取或猜测写作者解释。只报告职责范围内且有证据的问题。

每个问题都必须填写 revisionRanges，表示为解决该问题实际允许修订的最小段落范围。结构性问题可以填写多个范围；只用于对照的早期段落不要列入 revisionRanges。无法安全定位时返回空数组，不要猜测段号。
plot-reviewer 与 pacing-reviewer 必须额外检查：正文是否在中后段重新开场，是否用第二套求生、冲突或获得资源流程重复已经完成的推进，是否出现第二个结尾。发现时只标记后出现的重复范围。

蓝图：
${blueprint.contentMarkdown}

正文（段落编号仅用于定位）：
${numberedDraft}

相关事实：
${formatReviewerContext(packet)}`,
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
    await ctx.saveArtifact(run, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "review",
      kind: "review",
      title: `质量报告 · 第 ${run.revisionIteration + 1} 轮`,
      contentMarkdown: `# 质量报告\n\n总分：${report.weightedScore} / 5\n\n阻断：${report.blockerCount}\n\n${report.issues.map((item) => `- [${item.severity}] ${item.title}：${item.description}\n  - 建议：${item.suggestion}`).join("\n") || "未发现问题"}`,
      structuredData: { reportId: report.id },
      skillRefs: [],
      contextPacketId: packet.id,
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
