import type { Artifact, ExecutionBlueprint, MemoryBundle, Review, ReviewIssue, SkillBundle } from "../protocol";
import { WRITER_CHAPTER_ENDING_HOOKS } from "./writer-rules";
import type { ReviewerOutput } from "./schemas";
import type { ChapterPlanningContext } from "../application/story-arc";
import { renderChapterPlanningContext } from "./chapter-planning-context";

/**
 * V2 章节 reviewer prompt 构造器。
 *
 * 与 v1 [prose-prompts.ts] buildChapterReviewPrompt 等价，但参数化为 v2 数据结构。
 *
 * reviewer 角色与 v1 一致：5 种 ProseReviewerRole。
 * - style-reviewer: 解释性心理总结、意象替人物说理、通用细节、模板化表达
 * - character-reviewer: 人物欲望、对白声部、知识边界、器物参与
 * - continuity-reviewer: 事实/时间/位置/POV 越界连续性
 * - plot-reviewer: 主导功能与兑现边界、mustHappen 完成度、章尾驱动力
 * - reader-reviewer: 严苛追更读者视角，体验与卖点兑现
 */

export type ReviewerRole = "style-reviewer" | "character-reviewer" | "continuity-reviewer" | "plot-reviewer" | "reader-reviewer";

export const REVIEWER_DIMENSIONS: Record<ReviewerRole, ReadonlyArray<keyof ReviewerOutput["scores"]>> = {
  "style-reviewer": ["sceneEmbodiment", "specificity"],
  "character-reviewer": ["characterVoice", "dialogue"],
  "continuity-reviewer": ["continuity"],
  "plot-reviewer": ["plot", "hookPayoff"],
  "reader-reviewer": ["readerRetention"],
};

/**
 * Reviewer 职责焦点：与 v1 [prose-prompts.ts] REVIEW_FOCUS 等价。
 */
const REVIEW_FOCUS: Record<ReviewerRole, string> = {
  "style-reviewer": "重点检查解释性心理总结、意象替人物说理、可替换的通用细节、段落碎片化、匀速句段和模板化表达。核对语言是否符合项目文风、时代和叙述距离；不要因为全文保持同一种语体就自动降分。环境可以承担氛围、情绪余波、信息或行动功能，只在重复且没有深化体验时报告问题。关键情绪和转折应有足够具体的现场承载，但不要要求固定的动作公式或句式配比。",
  "character-reviewer": "重点检查人物是否有符合本章功能的欲望、注意力、选择或情感变化；对白和行为是否符合冻结上下文中的年龄、职业、关系距离、知识边界与既有声音。配角可以承担陪伴、见证、阻力或日常质地，不强制每人拥有独立抉择。重要器物若被蓝图赋予意义，应参与行动、关系或记忆；普通场景物件无需强行象征化。不要套用固定身份声部，也不要要求蓝图未安排的角色亲自到场或开口。",
  "continuity-reviewer": "重点检查事实、时间、位置、物品、人物知识边界与选择后果是否连续；不要把审美偏好误报为事实矛盾。检查 POV 越界——叙述是否替视角人物总结他人心理意图（如'各自守着一处不肯越过的距离''谁也不肯先开口''都带着各自的盘算'），这类句子表面是观察，实质是作者借视角人物之口宣告对他人内在状态的判断——若把描述他人状态的句子改写为'视角人物能看到/听到的具体动作'后信息丢失，则该句子越界，标为 major。",
  "plot-reviewer": "重点检查正文是否尊重目标章功能、状态变化预算、连续性约束与故事弧边界，是否把大纲压缩成当章任务清单，是否提前完成后续秘密、关系跃迁、重大转折或伏笔回收。可选节拍允许调整、合并或省略，不得逐项核对；只有章节功能或蓝图明确规定的结果整体缺失，才报告 chapter.incomplete-blueprint。铺陈、相处、内省和余波章不要求不可逆结果。章尾按目标章的 closingForce 判断，不得强制添加危险、反转或行动命令。",
  "reader-reviewer": "你是严苛的追更读者，不是编辑。先识别本章承担的是悬疑、行动、关系、生活流、铺陈、余波还是阶段闭合功能，再判断正文是否持续兑现作品承诺，不做文风或事实的技术分析。检查开篇是否建立与本章功能相称的注意力中心，中段是否通过新信息、关系温度、人物认识、状态变化或行动后果深化体验，信息是否在读者需要时抵达，以及正文是否出现真实的跳读区。章尾驱动力不等于强钩子：悬疑与行动章可以依靠未解压力，关系、生活流、余波或阶段闭合章也可以停在未尽交流、状态变化或有功能的情感与意象余韵。不得仅因没有问号、突发事件、强制选择或立即翻页冲动就判为 major；只有章尾没有完成本章功能、重复已知信息、切断既有长线动力或用空泛意象代替实际变化时才报告。项目卖点只在合适兑现窗口检查，不要求每章机械出现。每个问题必须引用正文证据，并说明它如何损害当前章节功能和后续阅读，而不是套用固定字数、钩子密度或章尾公式。",
};

export interface ReviewPromptInput {
  role: ReviewerRole;
  artifact: Artifact;
  text: string;
  blueprint: ExecutionBlueprint;
  memory: MemoryBundle;
  skills?: SkillBundle;
  /**
   * Phase 3.2 爽点曲线统计，仅 reader-reviewer 使用。
   *
   * 由 review activity 调用 repository.getRecentPayoffStats 获取，
   * 注入 prompt 让 reader-reviewer 基于事实判断「连续 N 章无爽点」，
   * 不允许 LLM 凭感觉判断。
   * 可选——首章或前 5 章无数据时省略。
   */
  payoffStats?: {
    recentChapters: Array<{ narrativeOrder: number; payoffCount: number; maxIntensity: number; totalIntensity: number; types: string[] }>;
    consecutiveNoPayoff: number;
    totalPayoffs: number;
    byType: Record<string, number>;
  };
  planningContext?: ChapterPlanningContext;
}

function buildNumberedDraft(text: string): string {
  const paragraphs = text.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean);
  return paragraphs.map((paragraph, index) => `### 段落 ${index + 1}\n${paragraph}`).join("\n\n");
}

function buildReviewerContext(memory: MemoryBundle): string {
  if (!memory.claims.length) return "- 暂无冻结事实。";
  const lines = memory.claims.map((claim) => `- [${claim.authority}/${claim.kind}] ${claim.subjectRefs.join(",")}: ${claim.title} — ${claim.content}`);
  return lines.join("\n");
}

function buildBlueprintSummary(blueprint: ExecutionBlueprint): string {
  const tasks = blueprint.tasks.map((task) => `- [${task.kind}] ${task.role} (queue: ${task.queue})`).join("\n");
  return [
    `Blueprint ID: ${blueprint.id}`,
    `Base revision: ${blueprint.baseRevision}`,
    `Commit policy: ${blueprint.commitPolicy}`,
    `Tasks:`,
    tasks,
  ].join("\n");
}

/**
 * Phase 3.2 构建爽点曲线统计 markdown，仅注入 reader-reviewer。
 *
 * 设计依据：Phase 3.2 计划 + AGENTS.md「reusable contracts over case-specific rules」——
 * 不在 prompt 里写死「连续 3 章无爽点则警告」的硬阈值（那是 case-specific rule），
 * 而是把结构化事实给 reader-reviewer，由它结合本章功能和长线节奏判断。
 *
 * 连续无爽点的阈值随章节功能而变：铺陈/相处/余波章允许较长无爽点区间，
 * 行动/转折/阶段闭合章则需要更密集的爽点。reader-reviewer 自行判断。
 */
function buildPayoffStatsMarkdown(stats: NonNullable<ReviewPromptInput["payoffStats"]>): string {
  if (!stats.recentChapters.length && stats.consecutiveNoPayoff === 0) {
    return "- 暂无前章爽点数据（首章或前 5 章无记录）。";
  }
  const lines: string[] = [];
  lines.push(`- 最近 5 章爽点总数：${stats.totalPayoffs}`);
  lines.push(`- 连续无爽点章数：${stats.consecutiveNoPayoff}`);
  if (stats.recentChapters.length) {
    lines.push("- 按章分布：");
    for (const ch of stats.recentChapters) {
      lines.push(`  - 第 ${ch.narrativeOrder} 章：${ch.payoffCount} 个爽点，最高强度 ${ch.maxIntensity}，类型 ${ch.types.join("/") || "无"}`);
    }
  }
  const typeEntries = Object.entries(stats.byType);
  if (typeEntries.length) {
    lines.push("- 按类型分布：");
    for (const [type, count] of typeEntries) {
      lines.push(`  - ${type}: ${count}`);
    }
    // 提示长期缺失的类型（非硬规则，仅参考）
    const allTypes = ["achievement", "recognition", "reversal", "emotional", "mystery"];
    const missing = allTypes.filter((t) => !stats.byType[t]);
    if (missing.length) {
      lines.push(`- 最近 5 章未出现的爽点类型：${missing.join("、")}（仅供参考，不要求每章机械出现）`);
    }
  }
  return lines.join("\n");
}

/**
 * 构建 V2 章节 reviewer prompt。
 */
export function buildChapterReviewPrompt(input: ReviewPromptInput): string {
  const { role, artifact, text, blueprint, memory, skills, payoffStats, planningContext } = input;
  const numberedDraft = buildNumberedDraft(text);
  const reviewerContext = buildReviewerContext(memory);
  const blueprintMarkdown = buildBlueprintSummary(blueprint);
  const isReaderReviewer = role === "reader-reviewer";
  const payoffMarkdown = isReaderReviewer && payoffStats ? buildPayoffStatsMarkdown(payoffStats) : "";

  const sections = [
    `独立审校下面正文。不要读取或猜测写作者解释，只按读者在正文中实际得到的体验评分。`,
    "",
    `## 评分锚点`,
    `- 5：可直接进入生产，只有不影响阅读的微调。`,
    `- 4：整体成立，有少量可明确定位的修订。`,
    `- 3：结构可读，但机械感、人物能动性、场景或语言存在持续性问题，必须修订。`,
    `- 2：明显按蓝图交差、解释多于呈现，或人物与因果不成立。`,
    `- 1：无法作为连续小说正文使用。`,
    `形式完整、情节都写到了，不等于 4 分以上。若正文像事件报表、心理分析或漂亮句子拼贴，相关维度不得高于 3 分。`,
    "",
    `## 机械报表识别`,
    `检查是否逐条复述蓝图、用"他知道/意识到/这意味着"替读者下结论、让对白传递作者观点、依赖新线索而非人物选择推进、反复用同一意象解释心理、使用可替换的天气与光影、每段承担同样长度和功能。只有形成持续模式才报告，不因单个词机械判错。`,
    "",
    `## 长篇耐心`,
    `先判断本章是在铺陈、相处、蓄势、行动、余波还是兑现。背景展开、人物内省、情感抒发、文学意象和日常过程可以是章节主体，不得因为主线没有明显前进而降分。反过来，若正文过早揭示秘密、完成关系转变、回收伏笔，或把多个后续大纲节点压入本章，应报告为 major。不要建议用突发危险、强行选择或新钩子修复安静章节。`,
    "",
    `## 当前职责`,
    REVIEW_FOCUS[role],
    `你只能把 ${REVIEWER_DIMENSIONS[role].join("、")} 维度的问题写入 issues；其他维度即使有改进空间，也交给对应 reviewer，不得重复报告。scores 仍需填写全部维度，但当前 verdict 只由你的职责维度决定。`,
    "",
    "## 已激活审校技能",
    skills?.skills.map((skill) => [`### ${skill.skillId}@${skill.version}`, skill.promptSections.review ?? ""].filter(Boolean).join("\n")).join("\n\n") || "（无额外审校技能）",
    "",
    `每个问题都必须提供正文实际存在的逐字证据，并填写解决问题实际允许修订的最小 revisionRanges。blocker/major 的 excerpt 必须引用触发判断的原文，description 必须断言正文已经发生的问题；禁止用"如果后续这样写""若这里直接判断"等假设风险充当问题。找不到实际原文证据时不要报告。持续破坏读者体验且需要重写多个段落的问题标为 major；局部润色才标 warning。结构性问题可以填写多个范围，只用于对照的早期段落不得列入修改范围。无法安全定位时返回空数组，不猜测段号。`,
    "",
    `违反已确认 POV、人物知识边界或事实连续性，以及中后段重新开场、重复推进、第二个结尾，至少标为 major，不得降为 warning。这些问题即使文句通顺也会破坏长篇可信度。`,
    "",
    `## 改写示例（所有 issue 必填，schema 强制）`,
    `注意：JSON schema 已将 rewriteExample 设为必填字段（minLength=1）。任何 issue 缺少 rewriteExample 或填空字符串都会被 schema 拒绝，整个审校调用将失败。`,
    "",
    `- 对 blocker / major 问题：rewriteExample 必须给出具体改写文本，格式为「【原文】...（截取关键句）【改写】...（建议文本）」。改写应把"替读者下结论"改为"让行动/感官/对白/环境承载"，把"模板表达"改为"只能属于该人物的细节"。若问题段落需要整段重写，给出重写后的完整段落。禁止只说"删除该句"——必须给出改写后的实际文本。`,
    `- 对 warning 问题：rewriteExample 给出 1-2 句精简改写示例或方向性示意即可，但仍不得为空。`,
    "",
    `若某问题确实无改写示例（如纯结构问题），rewriteExample 填写说明性短语如「结构问题，需在 X 段增加 Y 元素」，不可留空。`,
    "",
    `plot-reviewer 还必须检查正文是否在中后段重新开场、用第二套事件重复已完成的推进，或出现第二个结尾；发现时只标记后出现的重复范围。`,
    `plot-reviewer 必须明确报告章节功能与故事弧边界结论。不得把可选节拍当作验收清单；仅当目标章功能、明确结果或章尾驱动力整体缺失时，返回 blocker "chapter.incomplete-blueprint"，并定位真正需要修改的最小范围。`,
  ];

  // Phase 3.2: reader-reviewer 爽点曲线检查指引（基于事实，非硬阈值）
  if (isReaderReviewer) {
    sections.push(
      "",
      `## 爽点曲线检查（reader-reviewer 专属）`,
      `爽点类型定义（通用爽感维度，适用于任何题材，不依赖金手指/系统流）：achievement=成就型（突破、获得、达成目标）、recognition=认可型（被肯定、被敬畏、地位提升）、reversal=反转型（逆境翻盘、真相揭露、打脸）、emotional=情感型（羁绊深化、虐心释放、温情时刻）、mystery=悬疑型（谜团揭开、伏笔兑现、真相浮现）。`,
      `判断规则：先识别本章承担的功能，再结合下方前章爽点统计判断本章爽点是否合理。铺陈、相处、余波、生活流章允许无爽点或低强度爽点，不强制每章机械出现；行动、转折、阶段闭合、兑现章若连续多章无爽点且本章也无爽点，应报告为 warning（rule: chapter.payoff-drought），description 必须引用正文证据并说明追更体验如何受损。不得仅因"本章没有打脸/逆袭"就判 major——爽点可以是情感深化、悬疑揭露、关系推进等任何类型，关键是读者是否获得正向反馈。`,
    );
    if (payoffMarkdown) {
      sections.push("", `### 前章爽点统计`, payoffMarkdown);
    } else {
      sections.push("", `### 前章爽点统计`, "- 暂无前章爽点数据（首章或前 5 章无记录），无需检查连续无爽点。");
    }
  }

  sections.push(
    "",
    `## 章尾钩子参考`,
    WRITER_CHAPTER_ENDING_HOOKS,
    "",
    planningContext ? renderChapterPlanningContext(planningContext) : `## 冻结章节规划上下文\n（历史章节未保存该快照，仅按旧执行编排与冻结事实审核。）`,
    "",
    `## 工作流执行编排（不是内容蓝图）`,
    blueprintMarkdown,
    "",
    `## 正文（段落编号仅用于定位）`,
    numberedDraft,
    "",
    `## 相关事实`,
    reviewerContext,
    "",
    `## 草稿元数据`,
    `- artifactId: ${artifact.id}`,
    `- kind: ${artifact.kind}`,
    `- baseRevision: ${artifact.baseRevision}`,
    `- fingerprint: ${artifact.fingerprint}`,
    `- createdAt: ${new Date(artifact.createdAt).toISOString()}`,
  );

  return sections.join("\n");
}

/**
 * 把 reviewer 输出转换为 v2 Review 对象。
 *
 * ReviewerOutput 的完整字段（dimension/description/revisionRanges/rule/suggestion/rewriteExample）
 * 都写入 Review.issues（ReviewIssue 类型），便于下游 revision-stage 与 learning-assessment 复用。
 */
export function toReview(params: { artifact: Artifact; identity: "internal" | "independent"; role: ReviewerRole; output: ReviewerOutput }): Review {
  const issues: ReviewIssue[] = params.output.issues.map((issue) => ({
    severity: issue.severity,
    title: issue.title,
    description: issue.description,
    evidence: issue.excerpt ?? issue.description,
    dimension: issue.dimension,
    excerpt: issue.excerpt,
    paragraph: issue.paragraph,
    revisionRanges: issue.revisionRanges,
    rule: issue.rule,
    sourceId: issue.sourceId,
    suggestion: issue.suggestion,
    rewriteExample: issue.rewriteExample,
  }));
  const roleScores = REVIEWER_DIMENSIONS[params.role].map((dimension) => params.output.scores[dimension]);
  return {
    id: crypto.randomUUID(),
    projectId: params.artifact.projectId,
    artifactId: params.artifact.id,
    reviewerId: `${params.identity}-${params.role}`,
    identity: params.identity,
    role: params.role,
    verdict: params.output.verdict,
    issues,
    score: roleScores.reduce((sum, score) => sum + score, 0) / roleScores.length,
    dimensionScores: params.output.scores,
    createdAt: Date.now(),
    artifactFingerprint: params.artifact.fingerprint,
  };
}
