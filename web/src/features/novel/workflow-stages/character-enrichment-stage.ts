import { callStructuredNovelModel } from "../ai";
import { formatContextPacket } from "../context";
import { appendOperation, recordBase, type NovelDatabase } from "../db";
import { compileNovelStagePrompt, resolveNovelSkills } from "../skills";
import { novelMemoryService } from "../memory-service";
import type { FactAssertion, StoryEntity } from "../types";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

const CHARACTER_PROFILE_FIELDS = ["role", "appearance", "personality", "desire", "motivation", "weakness", "secret", "voice", "arc"] as const;

const enrichmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enrichments"],
  properties: {
    enrichments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["characterId", "fields"],
        properties: {
          characterId: { type: "string" },
          fields: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(CHARACTER_PROFILE_FIELDS.map((field) => [field, { type: "string" }])),
          },
        },
      },
    },
  },
};

function isProfileIncomplete(character: NonNullable<StoryEntity["character"]>): boolean {
  return CHARACTER_PROFILE_FIELDS.some((field) => !String(character[field] ?? "").trim());
}

/**
 * 收集本次 workflowRun 中涉及的、profile 不完整的 character 实体。
 * 来源：(1) 新建的 character 候选（通过 committedAssertion.projection.targetId 定位）；
 *       (2) 本次有字段更新的已有 character（通过 candidate.subject.id 定位）。
 */
async function collectCharactersToEnrich(runId: string, projectId: string, db: NovelDatabase): Promise<StoryEntity[]> {
  const candidates = await db.factCandidates
    .where("workflowRunId")
    .equals(runId)
    .and((c) => c.targetTable === "entities" && Boolean(c.committedAssertionId))
    .toArray();

  const characterIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.novelty === "new") {
      const payload = candidate.after as Record<string, unknown> | undefined;
      if (!payload || typeof payload !== "object" || payload.kind !== "character") continue;
      const assertion = await db.factAssertions.get(candidate.committedAssertionId!);
      const targetId = assertion?.projection?.targetId;
      if (targetId) characterIds.add(targetId);
    } else if (candidate.novelty === "update" && candidate.subject?.kind === "entity" && candidate.subject.id) {
      characterIds.add(candidate.subject.id);
    }
  }

  const result: StoryEntity[] = [];
  for (const id of characterIds) {
    const entity = await db.entities.get(id);
    if (entity && entity.projectId === projectId && entity.kind === "character" && entity.character && isProfileIncomplete(entity.character)) {
      result.push(entity);
    }
  }
  return result;
}

export const characterEnrichmentStageHandler: StageHandler = {
  stage: "character-enrichment",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project, document, db } = ctx;

    const charactersToEnrich = await collectCharactersToEnrich(run.id, run.projectId, db);
    if (!charactersToEnrich.length) {
      const nextRun = await ctx.transition(run, "character-enrichment", "completed", { finishedAt: Date.now() });
      return { run: nextRun };
    }

    const [draft, packet, skills] = await Promise.all([
      db.workflowArtifacts.get(run.draftArtifactId!),
      run.conversationThreadId
        ? novelMemoryService.compileStageContext({ threadId: run.conversationThreadId, stage: "character-enrichment", role: "character-enricher", instruction: "基于本章正式事实完善相关人物档案", workflowRunId: run.id, skillStage: "character-enrichment", db: ctx.db })
        : db.contextPackets.get(run.contextPacketId!),
      resolveNovelSkills({ projectId: run.projectId, stage: "character-enrichment", explicitSkillIds: ["character-desire-engine", "classic-character-ensemble"], db: ctx.db }),
    ]);
    if (!draft || !packet) throw new Error("人物完善输入不完整");

    const { agent } = await ctx.createAgentRecord({
      run,
      role: "character-enricher",
      goal: "基于既定事实完善人物形象",
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
    });

    // 获取每个 character 的相关既定事实
    const characterFacts = await Promise.all(
      charactersToEnrich.map(async (character) => {
        const facts = await db.factAssertions
          .where("projectId")
          .equals(run.projectId)
          .and((f) => f.status === "active" && f.subject?.id === character.id)
          .toArray();
        return { character, facts };
      }),
    );

    const characterSection = characterFacts.map(({ character, facts }) => {
      const profile = character.character!;
      const profileText = CHARACTER_PROFILE_FIELDS.map((field) => {
        const value = String(profile[field] ?? "").trim();
        return value ? `- ${field}：${value}` : `- ${field}：（空缺，需要补完）`;
      }).join("\n");
      const factsText = facts.length
        ? facts.map((f) => `- ${f.humanReadable}（证据：${f.evidence}）`).join("\n")
        : "- 无既定事实";
      return `## 人物：${character.name}（ID：${character.id}）\n\n### 当前 profile\n${profileText}\n\n### 摘要\n${character.summary}\n\n### 描述\n${character.description}\n\n### 相关既定事实\n${factsText}`;
    }).join("\n\n");

    const result = await callStructuredNovelModel<Record<string, unknown>>({
      model: project.settings.textModel,
      temperature: 0.3,
      role: "character-enricher",
      skillPrompt: compileNovelStagePrompt(skills.skills, "character-enrichment"),
      schema: enrichmentSchema,
      prompt: `基于已确认的事实与正文证据，为以下人物补完 profile 中的空缺字段。

规则：
- 只填写正文已建立或可合理推断的字段；不得发明与既定事实冲突的设定
- 只补完空缺字段，已有字段保持原样不输出
- 每个字段用中文填写，简洁有力，避免空泛描述
- desire/motivation/weakness/secret 必须基于正文行动与对话推断，不得泛泛而谈
- voice 必须基于正文对白归纳说话方式（词汇、句长、回避方式、潜台词特征）
- arc 基于正文已有的成长线索推断当前阶段弧光，不臆造未来剧情
- abilities 字段不在此任务范围内（由正文显式体现）

待完善人物：
${characterSection}

正文：
${draft.contentMarkdown}

事实库上下文：
${formatContextPacket(packet)}`,
    });

    const data = result.data as { enrichments: Array<{ characterId: string; fields: Record<string, string> }> };
    let enrichedCount = 0;
    const enrichmentLog: string[] = [];

    for (const item of data.enrichments) {
      const entity = charactersToEnrich.find((c) => c.id === item.characterId);
      if (!entity || !entity.character) continue;
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      const nextCharacter = { ...entity.character };
      for (const field of CHARACTER_PROFILE_FIELDS) {
        const newValue = String(item.fields[field] ?? "").trim();
        if (!newValue) continue;
        const oldValue = String(nextCharacter[field] ?? "").trim();
        if (oldValue) continue; // 只补完空字段，保留非空字段
        nextCharacter[field] = newValue;
        changes[`character.${field}`] = { before: oldValue, after: newValue };
      }
      if (!Object.keys(changes).length) continue;

      const now = Date.now();
      const assertionId = `fact:${run.id}:enrichment:${entity.id}`;
      const assertion: FactAssertion = {
        ...recordBase(run.projectId),
        id: assertionId,
        subject: { kind: "entity", id: entity.id },
        predicate: "character.enrichment",
        object: { kind: "json", value: changes },
        polarity: "affirmed",
        truthStatus: "objective",
        timeMode: "timeless",
        revealedAt: { chapterId: document.id, narrativeOrder: document.order, precision: "exact" },
        sourceRevisionId: document.approvedRevisionId ?? draft.id,
        sourceArtifactId: draft.id,
        provenance: "approved-revision",
        evidence: `character-enrichment 阶段基于既定事实补完空缺字段：${Object.keys(changes).join("、")}`,
        confidence: 0.85,
        humanReadable: `完善人物形象：${entity.name} 补完 ${Object.keys(changes).length} 个字段`,
        status: "active",
        derivedFromCandidateId: `enrichment:${run.id}:${entity.id}`,
        projection: { targetTable: "entities", targetId: entity.id, field: "character.enrichment" },
      };

      await db.transaction("rw", db.entities, db.operations, db.factAssertions, async () => {
        await db.entities.update(entity.id, { character: nextCharacter, updatedAt: now, updatedBy: "local-user", revision: Number(entity.revision ?? 0) + 1 });
        await appendOperation(run.projectId, "entities", entity.id, "update", changes, db);
        await db.factAssertions.put(assertion);
      });

      enrichedCount += 1;
      enrichmentLog.push(`- ${entity.name}：补完 ${Object.keys(changes).map((k) => k.replace("character.", "")).join("、")}`);
    }

    const artifact = await ctx.saveArtifact(run, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "character-enrichment",
      kind: "character-enrichment",
      title: "人物形象完善",
      contentMarkdown: `# 人物形象完善\n\n基于本章既定事实补完 ${enrichedCount} 个人物的空缺 profile 字段。\n\n${enrichmentLog.join("\n") || "无字段需要补完"}`,
      structuredData: { enrichedCount, characterIds: charactersToEnrich.map((c) => c.id) },
      model: project.settings.textModel,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
      contextPacketId: packet.id,
    });
    await ctx.finishAgent(agent, { ...result, artifactId: artifact.id });
    const nextRun = await ctx.transition(run, "character-enrichment", "completed", { finishedAt: Date.now() });
    return { run: nextRun };
  },
};
