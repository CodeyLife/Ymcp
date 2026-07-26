import { callStructuredNovelModel } from "../ai";
import { formatContextPacket } from "../context";
import { DEFAULT_CHAPTER_TARGET_WORDS, novelDb } from "../db";
import { compileNovelStagePrompt, resolveNovelSkills } from "../skills";
import { auditIssueSchema, blueprintMarkdown, blueprintSchema, formatAuditFindingsForRerun, hasMajorOrBlocker } from "../workflow-shared";
import { formatCreativeBriefContract } from "../workflow-brief";
import { readNovelBuildEnv } from "../build-env";
import type { GenerationAuditIssue, GenerationAuditReport, GenerationAuditRound, StoryEntity } from "../types";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

const ENDING_HOOK_UNIQUENESS_CONTRACT = `章尾驱动力是最后一个节拍结果的具体呈现，不是额外追加的一场戏。若同一个邀约、警告、发现、决定或关系变化同时出现在 mustHappen 与 endingHook，mustHappen 必须明确它只在 endingHook 指定的时机和形式下兑现；最后一个节拍只能铺垫该结果，不得改换时间、地点、传话人或场景再提前兑现一次。`;

/**
 * 读取 blueprint audit 最大迭代次数。
 *
 * StageHandler 没有 params 入口（由 workflow scheduler 直接调度），通过环境变量控制：
 * - 未设置：默认 1（启用 1 次 audit+iterate 循环）
 * - "0"：关闭 audit（向后兼容场景）
 * - "2" / "3"：增加迭代次数
 *
 * 上限 3 次，避免长循环消耗 LLM 配额。
 */
export function getBlueprintAuditMaxIterations(): number {
  const raw = readNovelBuildEnv("NOVEL_BLUEPRINT_AUDIT_MAX_ITER");
  if (raw === undefined || raw === "") return 1;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 1;
  return Math.min(3, parsed);
}

/**
 * 调用 blueprint-audit skill 对章节蓝图（ChapterBlueprint）做独立 LLM 审核。
 *
 * 通过 explicitSkillIds 显式启用 blueprint-audit，避免污染 PROFILE_SKILLS 默认集合
 * （PROFILE_SKILLS 中的 4 个 reviewer 不应拿到 audit skill 的 prompt）。
 *
 * builtin 审核 Skill 只负责声明职责；实际判断原则由版本化审校指导和此阶段契约组成。
 */
export async function runBlueprintAudit(params: {
  projectId: string;
  documentTitle: string;
  documentObjective: string;
  blueprintData: Record<string, unknown>;
  povName?: string;
  otherCharacterNames: string[];
  briefContract: string;
  contextPacketId: string;
  db?: typeof novelDb;
  signal?: AbortSignal;
}): Promise<GenerationAuditRound> {
  const db = params.db ?? novelDb;
  const project = await db.projects.get(params.projectId);
  if (!project) throw new Error("项目不存在");
  const auditSkills = await resolveNovelSkills({ projectId: params.projectId, stage: "review", explicitSkillIds: ["blueprint-audit"], db });
  if (!auditSkills.skills.some((skill) => skill.skillId === "blueprint-audit")) {
    throw new Error("blueprint-audit skill 未在 BUILTIN_NOVEL_SKILLS 中找到");
  }
  const packet = await db.contextPackets.get(params.contextPacketId);
  const contextMarkdown = packet ? formatContextPacket(packet) : "（无冻结上下文）";
  const beats = Array.isArray(params.blueprintData.beats) ? params.blueprintData.beats as Array<Record<string, string>> : [];
  const beatsBrief = beats.length
    ? beats.map((beat, index) => `### 节拍 ${index + 1}\n- 行动：${beat.action ?? "无"}\n- 情绪：${beat.emotion ?? "无"}\n- 结果：${beat.outcome ?? "无"}`).join("\n\n")
    : "（无节拍）";
  const mustHappen = Array.isArray(params.blueprintData.mustHappen) ? (params.blueprintData.mustHappen as string[]).map((item, index) => `${index + 1}. ${item}`).join("\n") || "（无）" : "（无）";
  const forbidden = Array.isArray(params.blueprintData.forbidden) ? (params.blueprintData.forbidden as string[]).map((item, index) => `${index + 1}. ${item}`).join("\n") || "（无）" : "（无）";
  const informationRelease = Array.isArray(params.blueprintData.informationRelease) ? (params.blueprintData.informationRelease as string[]).map((item, index) => `${index + 1}. ${item}`).join("\n") || "（无）" : "（无）";
  const judgmentStyle = project.settings.contentProfile === "general-serial" || project.settings.contentProfile === "progression"
    ? "基于版本化审校规则、网文类型叙事经验（当代长篇网文通用的悬念/节奏/人物/支线布局机制）与当前项目目标进行弹性判断"
    : "基于版本化审校规则、当前项目目标与蓝图证据进行跨题材判断，不套用特定作者或作品风格";
  const prompt = `# 审核任务\n审核以下章节蓝图（ChapterBlueprint）的设计质量。\n\n## 章节标题\n${params.documentTitle}\n\n## 章节目标\n${params.blueprintData.objective ?? "无"}\n\n## 当前章节要求\n${params.documentObjective || "尚未规划"}\n\n## 起点\n${params.blueprintData.startingState ?? "无"}\n\n## 节拍\n${beatsBrief}\n\n## 章尾驱动力\n${params.blueprintData.endingHook ?? "无"}\n\n## 必须发生\n${mustHappen}\n\n## 禁止事项\n${forbidden}\n\n## 信息释放\n${informationRelease}\n\n## POV\n${params.povName ?? "未指定（多视角切片或未设置）"}\n\n## 其他在场角色\n${params.otherCharacterNames.join("、") || "无"}\n\n## 创作简报契约\n${params.briefContract}\n\n# 冻结上下文摘要\n${contextMarkdown}\n\n# 审核输出要求\n- ${judgmentStyle}\n- severity 由你基于问题影响和具体语境判断\n- 没问题的方面不必报告，避免凑数\n- 每个 issue 必须引用具体字段（objective / beats[N] / mustHappen[N] / endingHook / forbidden[N] 等）作为证据\n- 必须给出具体修订建议\n\n按 schema 输出 summary 和 issues 数组。`;
  const auditSkillPrompt = `${compileNovelStagePrompt(auditSkills.skills, "review")}\n\n## 章节蓝图审核职责\n根据本章实际功能、项目风格、前后因果、人物主体性和长篇材料余量审核。单 POV 蓝图若直接声明非 POV 角色内心，应要求架构师在保持原事件、人物主动性、信息释放时机和后果不变的前提下，重新设计 POV 可观察的证据；禁止建议做同义词或动词替换。节拍数量、信息密度、冲突强度和章尾形态没有固定合格公式；关系、生活流、余波或阶段闭合章可以用未尽交流、状态变化或有功能的情感与意象余韵收束，不得只因缺少强钩子判错。只有当具体字段造成因果断裂、人物失真、体验不足、提前透支或后续驱动力缺失时才报告问题。不同题材、视角、章节功能和叙事风格必须分别判断。`;
  const result = await callStructuredNovelModel<{ summary: string; issues: GenerationAuditIssue[] }>({
    model: project.settings.textModel,
    temperature: 0.15,
    role: "quality-editor",
    skillPrompt: auditSkillPrompt,
    schema: auditIssueSchema,
    prompt,
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

    // 收集章节内角色，供 blueprint-audit 判断 POV 设计质量。
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

    const skillPrompt = compileNovelStagePrompt(skills.skills, "planning");

    const governedBasePrompt = `# 章节蓝图任务\n为“${document.title}”生成可审批章节蓝图。章节目标字数由系统设置为 ${brief.targetWords || DEFAULT_CHAPTER_TARGET_WORDS} 字，不要返回或改写字数。\n\n## 已确认创作简报\n${briefContract}\n\n## 当前章节要求\n${document.blueprint.objective || "尚未规划，请依据冻结材料判断本章在长线中的必要功能"}\n\n## 架构师职责\n先确定每个事件、选择、发现及其因果语义，再设计当前 POV 能观察、听见、获知或合理推断的呈现证据。若需要外化非 POV 角色内心，必须保持原事件、人物主动性、信息释放时机和后果，重新设计动作、对白或环境反馈；禁止用同义词或动词替换把“发现”机械改成“指出”、把“决定”机械改成“宣布”。章尾形态服从本章功能：悬疑与行动章可留下未解压力，关系、生活流、余波或阶段闭合章可以停在未尽交流、状态变化或有功能的情感与意象余韵，不得为强钩子添加蓝图之外的新危险、选择或信息。\n\n创作结构、节拍数量、信息密度、人物与章尾形态以已注入的版本化 planning 指导和项目证据为准。不得使用固定章节公式补齐字段，也不得提前消费尚未到兑现窗口的材料。${feedback ? `\n\n## 用户退回意见\n${feedback.contentMarkdown}` : ""}\n\n## 冻结上下文\n${formatContextPacket(packet)}`;

    /**
     * 调用 LLM 生成 ChapterBlueprint。
     * 当传入 auditFindings 时，prompt 末尾追加审核意见，引导 LLM 修正问题。
     * 返回 result 包含 data/promptHash/usage，由调用方决定是否进入下一轮 audit。
     */
    const generateBlueprint = async (auditFindings?: string) => {
      const auditBlock = auditFindings ? `\n\n# 上一轮 LLM 审核意见\n请基于以下审核问题重新生成章节蓝图，针对每个 major/blocker 问题在生成时落实修订；不要直接复述审核意见，而是把它转化为保持事件语义的 POV 呈现重构、具体节拍调整、与章节功能相称的 endingHook 重构或信息密度调整。\n${auditFindings}` : "";
      return callStructuredNovelModel<Record<string, unknown>>({
        model: project.settings.textModel,
        temperature: auditFindings ? 0.35 : 0.55,
        role: "architect",
        skillPrompt,
        schema: blueprintSchema,
        prompt: `${governedBasePrompt}${auditBlock}`,
        signal: undefined,
      });
    };

    // 初次生成。产物保持模型原样，POV 问题由 audit 反馈后交给架构师完整重生，禁止机械改字段。
    let result = await generateBlueprint();

    // audit+iterate 循环（Loop 3：B 板块闭环）
    // 默认 maxIterations=1（可通过环境变量 NOVEL_BLUEPRINT_AUDIT_MAX_ITER 控制）
    // maxIterations=N 表示最多重新生成 N 次（共 N+1 轮 audit：1 次初始 + N 次再审）
    const maxAuditIterations = getBlueprintAuditMaxIterations();
    let auditReport: GenerationAuditReport | undefined;
    if (maxAuditIterations > 0) {
      const rounds: GenerationAuditRound[] = [];
      try {
        // 审核是生成后的独立质量证据。审核服务不可用时保留已经生成的蓝图，
        // 由审批者决定是否重试，不能把可用产物降格为工作流失败。
        let round = await runBlueprintAudit({
          projectId: run.projectId,
          documentTitle: document.title,
          documentObjective: document.blueprint.objective ?? "",
          blueprintData: result.data,
          povName: pov?.name,
          otherCharacterNames,
          briefContract,
          contextPacketId: packet.id,
          db: ctx.db,
        });
        round.iteration = 1;
        round.triggeredIteration = hasMajorOrBlocker(round.issues);
        rounds.push(round);

        let iterationsDone = 0;
        while (hasMajorOrBlocker(round.issues) && iterationsDone < maxAuditIterations) {
          iterationsDone += 1;
          result = await generateBlueprint(formatAuditFindingsForRerun(round));
          round = await runBlueprintAudit({
            projectId: run.projectId,
            documentTitle: document.title,
            documentObjective: document.blueprint.objective ?? "",
            blueprintData: result.data,
            povName: pov?.name,
            otherCharacterNames,
            briefContract,
            contextPacketId: packet.id,
            db: ctx.db,
          });
          round.iteration = iterationsDone + 1;
          round.triggeredIteration = hasMajorOrBlocker(round.issues) && iterationsDone < maxAuditIterations;
          rounds.push(round);
        }

        const lastRound = rounds[rounds.length - 1];
        auditReport = {
          auditSkillId: "blueprint-audit",
          mechanism: "internal-iterate",
          rounds,
          improved: !hasMajorOrBlocker(lastRound.issues),
          remainingMajorCount: lastRound.issues.filter((issue) => issue.severity === "blocker" || issue.severity === "major").length,
        };
      } catch (error) {
        auditReport = {
          auditSkillId: "blueprint-audit",
          mechanism: "internal-iterate",
          rounds,
          improved: false,
          remainingMajorCount: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const targetWords = brief.targetWords || DEFAULT_CHAPTER_TARGET_WORDS;
    const structuredData = { ...result.data, targetWords, povCharacterId: brief.povCharacterId, auditReport };
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
    await ctx.finishAgent(agent, { promptHash: result.promptHash, usage: result.usage, artifactId: artifact.id });
    await ctx.createApprovalProposal(run, artifact, "workflow-blueprint", "章节蓝图待批准");
    const nextRun = await ctx.transition(run, "blueprint-approval", "waiting-approval", { blueprintArtifactId: artifact.id });
    return { run: nextRun, continueLoop: false };
  },
};
