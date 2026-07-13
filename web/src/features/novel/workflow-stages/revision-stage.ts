import { streamNovelModel } from "../ai";
import { novelDb } from "../db";
import { formatSkillPrompt, resolveNovelSkills } from "../skills";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

export const revisionStageHandler: StageHandler = {
  stage: "revision",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project, document } = ctx;
    const [draft, report, feedback, skills] = await Promise.all([
      novelDb.workflowArtifacts.get(run.draftArtifactId!),
      novelDb.qualityReports.get(run.qualityReportId!),
      ctx.latestArtifact(run.id, ["review"]),
      resolveNovelSkills({ projectId: run.projectId, stage: "revision", explicitSkillIds: ["embodied-prose", "style-specificity-audit"] }),
    ]);
    if (!draft || !report) throw new Error("修订输入不完整");
    const { agent } = await ctx.createAgentRecord({
      run,
      role: "revision-editor",
      goal: "按质量报告定向修订",
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
    });
    const result = await streamNovelModel({
      model: project.settings.textModel,
      temperature: Math.min(project.settings.temperature, 0.55),
      role: "revision-editor",
      skillPrompt: formatSkillPrompt(skills.skills),
      prompt: `只输出修订后的完整正文。仅处理报告中的有效问题，保留已通过内容。\n\n质量问题：\n${report.issues.map((item) => `[${item.severity}] ${item.title}：${item.description}；建议：${item.suggestion}`).join("\n")}\n${feedback?.stage === "manuscript-approval" ? `\n用户意见：${feedback.contentMarkdown}` : ""}\n\n原正文：\n${draft.contentMarkdown}`,
    });
    const nextIteration = run.revisionIteration + 1;
    // saveArtifact 内部使用 run.revisionIteration 生成稳定 ID，需传入更新后的 run
    const revisedRun = { ...run, revisionIteration: nextIteration };
    const artifact = await ctx.saveArtifact(revisedRun, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "revision",
      kind: "revision",
      title: `${document.title}修订稿 ${nextIteration}`,
      contentMarkdown: result.content,
      parentArtifactId: draft.id,
      model: project.settings.textModel,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
      contextPacketId: run.contextPacketId,
    });
    await ctx.finishAgent(agent, { ...result, artifactId: artifact.id });
    const nextRun = await ctx.transition(run, "deterministic-check", "running", { draftArtifactId: artifact.id, revisionIteration: nextIteration });
    return { run: nextRun };
  },
};
