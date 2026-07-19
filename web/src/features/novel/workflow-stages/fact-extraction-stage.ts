import { callStructuredNovelModel } from "../ai";
import { formatContextPacket } from "../context";
import { autoAcceptSafeFactCandidates, formatFactCandidateValue, prepareFactCandidates, storeFactCandidates, type ExtractedFact } from "../facts";
import { formatSkillPrompt, resolveNovelSkills } from "../skills";
import { novelMemoryService } from "../memory-service";
import { factSchema } from "../workflow-shared";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

export const factExtractionStageHandler: StageHandler = {
  stage: "fact-extraction",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project, db } = ctx;
    const [draft, packet, skills] = await Promise.all([
      db.workflowArtifacts.get(run.draftArtifactId!),
      run.conversationThreadId
        ? novelMemoryService.compileStageContext({ threadId: run.conversationThreadId, stage: "fact-extraction", role: "fact-extractor", instruction: "从本次已批准正文提取事实差异", workflowRunId: run.id, skillStage: "fact-extraction", db: ctx.db })
        : db.contextPackets.get(run.contextPacketId!),
      resolveNovelSkills({ projectId: run.projectId, stage: "fact-extraction", explicitSkillIds: ["fact-delta-extraction"], db: ctx.db }),
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
- 新人物新建时 targetId 与 subject.id 省略（由系统生成），但 after.name 必须填写；上下文事实库中已存在同名或同别名 character 时不得提取为 new，应改为 update
- 只提取正文肯定建立或明确否定的故事世界事实；“正文未说明、尚未建立、没有交代”是分析备注，不是事实，不得输出
- 同一主体、字段和值只输出一次；无法定位 targetId 的普通字段变化无法投影，不得伪装成 new，只有完整 record 可以创建新对象
- 不得根据未来大纲补充正文没有建立的事实

正文：
${draft.contentMarkdown}

事实库：
${formatContextPacket(packet)}`,
    });
    const data = result.data as { summary: string; facts: ExtractedFact[] };
    const prepared = await prepareFactCandidates(run.projectId, data.facts, db);
    const facts = await storeFactCandidates({
      projectId: run.projectId,
      workflowRunId: run.id,
      sourceArtifactId: draft.id,
      sourceRevisionId: ctx.document.approvedRevisionId,
      defaultRevealedAt: { chapterId: ctx.document.id, narrativeOrder: ctx.document.order, precision: "exact" },
      facts: prepared.facts,
    }, db);
    const autoAcceptedIds = await autoAcceptSafeFactCandidates(facts, db);
    const pendingCount = facts.length - autoAcceptedIds.length;
    const artifact = await ctx.saveArtifact(run, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "fact-extraction",
      kind: "fact-delta",
      title: "事实与状态差异",
      contentMarkdown: `# 事实差异\n\n${data.summary}\n\n${facts.map((item) => `- ${item.targetTable}.${item.field}：${formatFactCandidateValue(item)}\n  - 证据：${item.evidence}\n  - 置信度：${Math.round(item.confidence * 100)}%${item.conflict ? " · 存在冲突" : ""}`).join("\n") || "未提取到变化"}${Object.values(prepared).slice(1).some((count) => typeof count === "number" && count > 0) ? `\n\n# 提取清理\n\n已过滤：重复人物 ${prepared.discardedDuplicateCharacterCount} 项、元叙事空事实 ${prepared.discardedMetaAbsenceCount} 项、无法投影 ${prepared.discardedUnprojectableCount} 项、批内重复 ${prepared.discardedDuplicateFactCount} 项。` : ""}`,
      structuredData: {
        summary: data.summary,
        factCount: facts.length,
        autoAcceptedCount: autoAcceptedIds.length,
        pendingCount,
        discardedDuplicateCharacterCount: prepared.discardedDuplicateCharacterCount,
        discardedMetaAbsenceCount: prepared.discardedMetaAbsenceCount,
        discardedUnprojectableCount: prepared.discardedUnprojectableCount,
        discardedDuplicateFactCount: prepared.discardedDuplicateFactCount,
      },
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
