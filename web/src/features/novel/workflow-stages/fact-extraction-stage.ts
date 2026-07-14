import { callStructuredNovelModel } from "../ai";
import { formatContextPacket } from "../context";
import { novelDb } from "../db";
import { autoAcceptSafeFactCandidates, storeFactCandidates, type ExtractedFact } from "../facts";
import { formatSkillPrompt, resolveNovelSkills } from "../skills";
import { factSchema } from "../workflow-shared";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

export const factExtractionStageHandler: StageHandler = {
  stage: "fact-extraction",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project } = ctx;
    const [draft, packet, skills] = await Promise.all([
      novelDb.workflowArtifacts.get(run.draftArtifactId!),
      novelDb.contextPackets.get(run.contextPacketId!),
      resolveNovelSkills({ projectId: run.projectId, stage: "fact-extraction", explicitSkillIds: ["fact-delta-extraction"] }),
    ]);
    if (!draft || !packet) throw new Error("事实提取输入不完整");
    const { agent } = await ctx.createAgentRecord({
      run,
      role: "fact-extractor",
      goal: "提取正文事实差异",
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
    });
    const result = await callStructuredNovelModel<Record<string, unknown>>({
      model: project.settings.textModel,
      temperature: 0,
      role: "fact-extractor",
      skillPrompt: formatSkillPrompt(skills.skills),
      schema: factSchema,
      prompt: `从已批准正文提取结构化事实与状态投影。每项必须同时表达领域事实（subject/predicate/object）和兼容投影（targetTable/targetId/field/after）。
- objective 仅用于正文明确建立的客观事实；角色说法使用 claim，冲突证据使用 contested，作者有意未决使用 open-question
- 没有发生时间时必须区分 timeless 与 unknown，不得擅自填写当前时间
- 角色知道、怀疑、误解或不知道某事实时写入 knowledgeDeltas
- targetId、subject.id、characterId 只能使用上下文中真实存在的 ID；无法定位投影目标时省略 targetId
- 不得根据未来大纲补充正文没有建立的事实

正文：
${draft.contentMarkdown}

事实库：
${formatContextPacket(packet)}`,
    });
    const data = result.data as { summary: string; facts: ExtractedFact[] };
    const facts = await storeFactCandidates({
      projectId: run.projectId,
      workflowRunId: run.id,
      sourceArtifactId: draft.id,
      sourceRevisionId: ctx.document.approvedRevisionId,
      defaultRevealedAt: { chapterId: ctx.document.id, narrativeOrder: ctx.document.order, precision: "exact" },
      facts: data.facts,
    });
    const autoAcceptedIds = await autoAcceptSafeFactCandidates(facts, project.settings.autoCommitFacts);
    const pendingCount = facts.length - autoAcceptedIds.length;
    const artifact = await ctx.saveArtifact(run, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "fact-extraction",
      kind: "fact-delta",
      title: "事实与状态差异",
      contentMarkdown: `# 事实差异\n\n${data.summary}\n\n${facts.map((item) => `- ${item.targetTable}.${item.field}：${String(item.after)}\n  - 证据：${item.evidence}\n  - 置信度：${Math.round(item.confidence * 100)}%${item.conflict ? " · 存在冲突" : ""}`).join("\n") || "未提取到变化"}`,
      structuredData: { summary: data.summary, factCount: facts.length, autoAcceptedCount: autoAcceptedIds.length, pendingCount },
      model: project.settings.textModel,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
      contextPacketId: packet.id,
    });
    await ctx.finishAgent(agent, { ...result, artifactId: artifact.id });
    const nextRun = pendingCount > 0
      ? await ctx.transition(run, "fact-approval", "waiting-approval", { factCandidateIds: facts.map((item) => item.id) })
      : await ctx.transition(run, "commit", "running", { factCandidateIds: facts.map((item) => item.id) });
    return { run: nextRun, continueLoop: pendingCount === 0 };
  },
};
