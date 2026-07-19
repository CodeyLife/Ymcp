import { callStructuredNovelModel } from "../ai";
import { formatContextPacket } from "../context";
import { DEFAULT_CHAPTER_TARGET_WORDS } from "../db";
import { compileNovelStagePrompt, resolveNovelSkills } from "../skills";
import { blueprintMarkdown, blueprintSchema } from "../workflow-shared";
import { formatCreativeBriefContract } from "../workflow-brief";
import type { StoryEntity } from "../types";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

// 改进 #7：POV 一致性机械后校验
// Loop 3 发现 reviewer 报告 3 处 POV 越界（mustHappen 包含"萧承渊意识到..."等非 POV 角色内心活动）。
// 通过 schema 与 prompt 措辞约束 LLM 的效果有限，本函数在 LLM 返回后做机械检测：
// 扫描 mustHappen 中"非 POV 角色名 + 内心动词"模式，若发现违规，
// 不修改 mustHappen 原条目（保留 LLM 的节拍语义），但在 forbidden 中追加一条约束，
// 强制 draft 阶段不得直接描写非 POV 角色内心，必须通过 POV 可观察的外部行为呈现。
const INTERNAL_VERBS = ["发现", "察觉", "意识到", "判断", "明白", "懂得", "看穿", "看透", "领悟", "惊觉", "想到", "看清", "感到", "觉得", "理解", "醒悟", "省悟", "察觉到", "意识到"];
const MAX_NAME_TAIL_SCAN = 10;
const ENDING_HOOK_UNIQUENESS_CONTRACT = `章尾驱动力是最后一个节拍结果的具体呈现，不是额外追加的一场戏。若同一个邀约、警告、发现、决定或关系变化同时出现在 mustHappen 与 endingHook，mustHappen 必须明确它只在 endingHook 指定的时机和形式下兑现；最后一个节拍只能铺垫该结果，不得改换时间、地点、传话人或场景再提前兑现一次。`;

function sanitizePovConsistencyInPlace(data: Record<string, unknown>, povName: string | undefined, otherCharacterNames: string[]): { violations: string[] } {
  if (!povName || otherCharacterNames.length === 0) return { violations: [] };
  const mustHappen = Array.isArray(data.mustHappen) ? data.mustHappen as unknown[] : [];
  const violations: string[] = [];
  for (const item of mustHappen) {
    if (typeof item !== "string") continue;
    for (const name of otherCharacterNames) {
      if (!name || name === povName || !item.includes(name)) continue;
      const nameIdx = item.indexOf(name);
      const tail = item.slice(nameIdx + name.length, nameIdx + name.length + MAX_NAME_TAIL_SCAN);
      if (INTERNAL_VERBS.some((verb) => tail.includes(verb))) {
        violations.push(`mustHappen 条目「${item}」中「${name}」作为非 POV 角色使用了内心动词「${tail.slice(0, 6)}」`);
        break;
      }
    }
  }
  if (violations.length === 0) return { violations: [] };
  const forbidden = Array.isArray(data.forbidden) ? data.forbidden as string[] : [];
  const distinctNames = Array.from(new Set(violations.map((v) => v.match(/「(.*?)」作为非 POV/)?.[1] ?? "").filter(Boolean))).slice(0, 5);
  const addition = `不得在正文直接描写 ${distinctNames.join("、")} 等非 POV 角色的内心活动、想法或认知（如"意识到/察觉/明白/判断/领悟"等）；上述内容出现在 mustHappen 节拍中时，必须改写为 POV 可观察的外部行为（动作、神态、对白、环境）呈现。`;
  if (!forbidden.some((rule) => rule.includes("不得在正文直接描写") && rule.includes("非 POV 角色的内心活动"))) {
    forbidden.push(addition);
    data.forbidden = forbidden;
  }
  return { violations };
}

export const blueprintStageHandler: StageHandler = {
  stage: "blueprint",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, project, document, db } = ctx;
    const [packet, feedback, skills, brief] = await Promise.all([
      db.contextPackets.get(run.contextPacketId!),
      ctx.latestArtifact(run.id, ["review"]),
      resolveNovelSkills({ projectId: run.projectId, stage: "planning", explicitSkillIds: ["chapter-blueprint"], db: ctx.db }),
      run.creativeBriefId ? db.creativeBriefs.get(run.creativeBriefId) : undefined,
    ]);
    if (!packet) throw new Error("章节上下文不存在");
    if (!brief || brief.status !== "confirmed" || brief.targetDocumentId !== document.id) throw new Error("已确认创作简报不存在或与章节不匹配");
    const pov = brief.povCharacterId ? await db.entities.get(brief.povCharacterId) : undefined;
    const briefContract = `${formatCreativeBriefContract(brief, pov?.name)}\n\n${ENDING_HOOK_UNIQUENESS_CONTRACT}`;
    const { agent } = await ctx.createAgentRecord({
      run,
      role: "architect",
      goal: "生成可审批章节蓝图",
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
    });
    const result = await callStructuredNovelModel<Record<string, unknown>>({
      model: project.settings.textModel,
      temperature: 0.55,
      role: "architect",
      skillPrompt: compileNovelStagePrompt(skills.skills, "planning"),
      schema: blueprintSchema,
      prompt: `为“${document.title}”生成章节蓝图。章节目标字数由系统设置为 ${brief.targetWords || DEFAULT_CHAPTER_TARGET_WORDS} 字，你只需按该篇幅规划，不要生成字数。\n\n${briefContract}\n\n当前章节要求：${document.blueprint.objective || "尚未规划，请结合全书架构、故事大纲与当前长线位置设计"}\n\n先选择本章唯一的主导叙事功能：建立故事背景与日常秩序、深化人物内心与关系、积累情绪和压力、埋设或提醒线索、承担行动推进、消化既有后果，或兑现阶段节点。不要默认选择行动推进或阶段兑现；相邻章节应有张弛和功能差异。\n\n大纲是跨章节分配材料的上限，不是本章待办清单。只把本章确实到达兑现窗口、删去就会破坏连续性的内容写入 mustHappen；把尚需铺垫的秘密、关系跃迁、重大转折、伏笔回收和后续节点写入 forbidden。informationRelease 允许为空，也允许只让人物误读或局部感知。endingHook 必须制造一个让读者想知道“接下来会发生什么”的开放问题或新信息压力，不能只停在情感余韵的封闭画面。可以是未完成动作指向尚未到达的地点、关系裂痕露出尚未摊牌的张力、未说出口的话让读者知道它存在却不知道内容、日常细节让读者察觉反常、环境变化暗示新力量或威胁已进入场景，也可以用意象收束但意象必须携带未解信息（反例：停在楼梯不回头+只有雨声无新信息是封闭画面，读者无须翻下一章；正例：停在楼梯不回头+听到楼下哼出自己从未教过的半阕歌，留下“她从哪里听来”的开放问题）。禁止为钩子在中后段突然另起新场景作为章尾，但通过既有线索的细微反常或状态转变引出新压力是被鼓励的。\n\n使用 2 至 8 个必要节拍。相邻节拍保持时间、注意力或因果连续，但不是每个节拍都必须改变局势。允许用完整节拍承载环境与社会背景、人物独处、生活过程、回忆触发、关系相处、情感发酵和文学意象；这些内容应深化读者体验，而不是重复已知信息。对手只有实际在场或施加影响时才需要反制。禁止为凑结构强造选择、代价、转折或钩子。\n\n## 信息密度约束（改进 #10）\n根据章节功能区分信息密度上限：\n- **引子章 / 铺陈章 / 余波章**（建立故事背景、深化人物内心与关系、消化既有后果）：每章至多埋设 2-3 个新信息节点（包括新线索、新人物、新关系、新设定）。其余应当作为后续章节的发现空间保留，不得一次性兑现。引子章尤其要克制——读者需要建立对世界与人物的初步认知，信息密度过高会让读者来不及消化。\n- **行动章 / 蓄势章**（承担行动推进、积累情绪和压力）：可以承载 3-4 个新信息节点，但必须让每个节点都有充分展开的现场过程，不得连续抛出多个发现而不给读者停留空间。\n- **兑现章**（兑现阶段节点）：可以承载较多回收（伏笔回收、真相揭示），但每个回收必须有前文铺陈支撑，不得空降。\n\nmustHappen 中标记的每个"发现 / 察觉 / 意识到"类节点都算一个新信息节点。如果 mustHappen 中此类节点超过本章功能允许的上限，必须把超出部分移入 forbidden 或 flexible。\n${feedback ? `\n用户退回意见：${feedback.contentMarkdown}` : ""}\n\n冻结上下文：\n${formatContextPacket(packet)}`,
    });
    // 改进 #7：POV 一致性机械后校验（在 LLM 返回后扫描 mustHappen 中"非 POV 角色名 + 内心动词"）
    const chapterCharacterIds = Array.from(new Set([
      ...(document.blueprint.characterIds ?? []),
      ...(brief.povCharacterId ? [brief.povCharacterId] : []),
    ]));
    const chapterCharacters = chapterCharacterIds.length > 0
      ? (await db.entities.bulkGet(chapterCharacterIds)).filter((e): e is StoryEntity => e?.kind === "character")
      : [];
    const otherCharacterNames = chapterCharacters
      .filter((e) => e.id !== brief.povCharacterId)
      .flatMap((e) => [e.name, ...(e.aliases ?? [])])
      .filter((name) => typeof name === "string" && name.length >= 2);
    const povConsistency = sanitizePovConsistencyInPlace(result.data, pov?.name, otherCharacterNames);
    if (povConsistency.violations.length > 0) {
      console.warn(`[blueprint-stage] POV 一致性后校验发现 ${povConsistency.violations.length} 处非 POV 角色内心活动（POV=${pov?.name ?? "?"}），已自动追加 forbidden 约束：\n${povConsistency.violations.join("\n")}`);
    }
    const targetWords = brief.targetWords || DEFAULT_CHAPTER_TARGET_WORDS;
    const structuredData = { ...result.data, targetWords, povCharacterId: brief.povCharacterId };
    const artifact = await ctx.saveArtifact(run, {
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "blueprint",
      kind: "blueprint",
      title: `${document.title}蓝图`,
      contentMarkdown: `${blueprintMarkdown(result.data, targetWords)}\n\n${briefContract}`,
      structuredData,
      model: project.settings.textModel,
      skillRefs: skills.skills.map((item) => `${item.skillId}@${item.version}`),
      contextPacketId: packet.id,
    });
    await ctx.finishAgent(agent, { ...result, artifactId: artifact.id });
    await ctx.createApprovalProposal(run, artifact, "workflow-blueprint", "章节蓝图待批准");
    const nextRun = await ctx.transition(run, "blueprint-approval", "waiting-approval", { blueprintArtifactId: artifact.id });
    return { run: nextRun, continueLoop: false };
  },
};
