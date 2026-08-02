import type { Artifact, ExecutionBlueprint, MemoryBundle, Review, ReviewIssue, SkillBundle, StageGoalContract, StagePromptPackage } from "../protocol";
import { WRITER_CHAPTER_ENDING_HOOKS } from "./writer-rules";
import type { ReviewerOutput } from "./schemas";
import type { ChapterPlanningContext } from "../application/story-arc";
import { dedupeNarrativeRhythmMemory, renderChapterPlanningContext, renderNarrativeRhythm } from "./chapter-planning-context";
import { compileStageContext } from "../stage-context";
import { reviewerSchemaForDimensions } from "./schemas";

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

function normalizeReviewText(value: string): string {
  return value.replace(/\s+/gu, "").replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'");
}

/**
 * 只让正文中确实存在的证据进入修订与质量门。
 *
 * reviewer 偶尔会把蓝图或上一版正文中的句子误当成当前候选证据；
 * 这类问题若直接进入 revision brief，会把有效修订稿错误回退。证据契约
 * 要求逐字片段，因此这里按当前文本校验，允许模型用省略号拼接多个原文片段。
 */
export function groundReviewerIssues<T extends { excerpt?: string; evidence?: string }>(issues: T[], text: string): { issues: T[]; discardedCount: number } {
  const normalizedText = normalizeReviewText(text);
  const grounded = issues.filter((issue) => {
    const evidence = (issue.excerpt ?? issue.evidence ?? "").trim();
    if (normalizeReviewText(evidence).length < 4) return false;
    const fragments = evidence
      .split(/(?:…{2,}|\.{3,})/gu)
      .map((fragment) => normalizeReviewText(fragment))
      .filter((fragment) => fragment.length >= 4);
    return fragments.length > 0 && fragments.every((fragment) => normalizedText.includes(fragment));
  });
  return { issues: grounded, discardedCount: issues.length - grounded.length };
}

export function groundReviewForText(review: Review, text: string): Review {
  const grounded = groundReviewerIssues(review.issues, text);
  if (grounded.discardedCount === 0) return review;
  return {
    ...review,
    issues: grounded.issues,
    // A verdict based only on discarded evidence cannot block the current text.
    ...(grounded.issues.length === 0 ? { verdict: "passed" as const, score: undefined } : {}),
  };
}

/**
 * 5 reviewer × 评分维度映射。
 *
 * 设计依据：AGENTS.md「Fix the problem at the lowest shared layer」+ pipeline-audit.md F9
 * ——REVIEW_DIMENSIONS 已扩展为 14 维度（8 单章可读性 + 4 个 D1/D3/D4/D5 维度 +
 * subtext/narrativePacing），但若不分配给
 * 具体 reviewer，维度边界约束（buildChapterReviewPrompt）会阻止任何 reviewer 报告
 * 这些维度的问题 → 新维度形同虚设。本映射把新增维度分配给职责最匹配的 reviewer。
 *
 * 分配依据（对照 docs/novel-v2/quality-standard.md D1/D3/D4/D5）：
 * - worldbuilding → continuity-reviewer：W1 规则可内化（规则间无逻辑冲突）是 continuity 的自然延伸；
 *   continuity-reviewer 已持有 world/rule 术语与 fact/timeline/foreshadowing 记忆 facet。
 * - ensemble → character-reviewer：E1/E3/E4/E5（配角独立欲望/弧光/关系网络/日常质地）是人物审核的延伸；
 *   character-reviewer 已持有 entity/relation 记忆 facet 与 character/voice 术语。
 * - romance → reader-reviewer：R2 阶段性/R5 复杂度直接影响追更体验（《我在风花雪月里等你》靠感情线驱动追更）；
 *   reader-reviewer 的追更视角最适合判断"感情线是否有进展、是否兑现读者期待"。
 *   R1 行动承载/R3 留白/R4 女主独立的技法问题由 character/style 的现有维度间接覆盖。
 * - humor → style-reviewer：H1 贴合人物声部/H2 时代契合/H3 调节功能是语言风格的延伸；
 *   style-reviewer 已负责"模板化表达、语言质感、时代与叙述距离"。
 *
 * 负载平衡：style(4) / character(3) / continuity(2) / plot(2) / reader(3)，避免单 reviewer 过重。
 * plot-reviewer 不新增维度：D2 故事性已由 plot/hookPayoff 覆盖（章节功能/章尾驱动力/因果推进）。
 */
export const REVIEWER_DIMENSIONS: Record<ReviewerRole, ReadonlyArray<keyof ReviewerOutput["scores"]>> = {
  "style-reviewer": ["sceneEmbodiment", "specificity", "humor", "subtext"],
  "character-reviewer": ["characterVoice", "dialogue", "ensemble"],
  "continuity-reviewer": ["continuity", "worldbuilding"],
  "plot-reviewer": ["plot", "hookPayoff"],
  "reader-reviewer": ["readerRetention", "romance", "narrativePacing"],
};

/**
 * Reviewer 职责焦点（默认）：与 v1 [prose-prompts.ts] REVIEW_FOCUS 等价。
 *
 * 设计依据：AGENTS.md「reusable contracts over case-specific rules」——默认职责题材无关，
 * 题材特化覆盖通过 `getReviewFocus(role, skills)` 注入（skill.promptSections.review 段）。
 * craft rule 通过 learning 闭环沉淀后，会以 skill 形式注入，覆盖/补充默认职责。
 */
const DEFAULT_REVIEW_FOCUS: Record<ReviewerRole, string> = {
  "style-reviewer": "重点检查解释性心理总结、意象替人物说理、可替换的通用细节、段落碎片化、匀速句段和模板化表达。核对语言是否符合项目文风、时代和叙述距离；不要因为全文保持同一种语体就自动降分。环境可以承担氛围、情绪余波、信息或行动功能，只在重复且没有深化体验时报告问题。关键情绪和转折应有足够具体的现场承载，但不要要求固定的动作公式或句式配比。\n\n## 幽默维度（humor）\n检查幽默是否贴合人物声部与时代（不得用现代网络梗冒充古风幽默，不得让严肃角色突然插科打诨破坏声部）、是否承担调节节奏、释放压力或深化人物关系的功能。幽默不是每章必须——铺陈、悲剧、高潮章可以无幽默；但若出现，应服务于人物或情境，不得是无关插科打诨或作者强行抖机灵。若幽默与角色既有声部冲突（如沉默寡言者突然妙语连珠），标为 major。\n\n## 潜台词维度（subtext）\n依据章节 thematicTreatment 检查主题权限。absent 章不得为了呼应卖点主动讲题；subtext 章只允许读者从行动、关系、世界反应和后果推断；foreground 章可以有价值争执，但台词必须来自当下欲望、风险和私人经验。作者式总结、配角充当主题传声筒、把设定或能力直接解释成抽象立意，均应按其对阅读的损害报告。不得以关键词出现次数判断，也不得把所有哲理对白一律视为问题。",
  "character-reviewer": "重点检查人物是否有符合本章功能的欲望、注意力、选择或情感变化；对白和行为是否符合冻结上下文中的年龄、职业、关系距离、知识边界与既有声音。重要配角应有自己的欲望、抉择与弧光，不应只是主角的陪伴、见证或阻力工具；次要配角可承担日常质地，但不应在关键场景消失或仅作背景。检查配角之间是否形成关系网络（敌友、师徒、恩怨），而非只与主角单线联系。重要器物若被蓝图赋予意义，应参与行动、关系或记忆；普通场景物件无需强行象征化。不要套用固定身份声部，也不要要求蓝图未安排的角色亲自到场或开口。\n\n## 群像维度（ensemble）\n以跨章视角审视群像结构：本章出场的配角是否有独立于主角的欲望与处境（E1）；重要配角是否在多章中呈现可识别的弧光而非固定功能符号（E3）；配角之间是否存在直接关系（E4），而非全部经由主角中转；日常场景是否有配角独立质地（E5）。若本章把配角写成纯工具（无欲望、无抉择、无关系），或群像仅围绕主角单点运转，标为 major。判断需依据冻结上下文与记忆中的角色档案，不得仅凭本章臆断。",
  "continuity-reviewer": "重点检查事实、时间、位置、物品、人物知识边界与选择后果是否连续；不要把审美偏好误报为事实矛盾。检查 POV 越界——叙述是否替视角人物总结他人心理意图（如'各自守着一处不肯越过的距离''谁也不肯先开口''都带着各自的盘算'），这类句子表面是观察，实质是作者借视角人物之口宣告对他人内在状态的判断——若把描述他人状态的句子改写为'视角人物能看到/听到的具体动作'后信息丢失，则该句子越界，标为 major。\n\n## 世界观维度（worldbuilding）\n检查世界观规则是否自洽：已确立的规则（修炼体系/势力结构/关键技术/社会制度）在后续章节是否被违反或临时编造（W1）；随机抽取设定，问「若主角在 X 情境下做 Y，世界规则会如何反应」，答案能否从已确立规则推导。检查核心设定是否承载主题或哲思（W2），而非纯力量体系堆砌。检查世界质地是否有独立于主角的文化、思想、生活细节（W4）——若全书场景只为主角服务、无独立运转的世界纹理，标为 major。规则冲突或设定空洞会破坏长篇可信度，即使文句通顺也不得通过。",
  "plot-reviewer": "重点检查正文是否尊重目标章功能、状态变化预算、连续性约束与故事弧边界，是否把大纲压缩成当章任务清单，是否提前完成后续秘密、关系跃迁、重大转折或伏笔回收。可选节拍允许调整、合并或省略，不得逐项核对；只有章节功能或蓝图明确规定的结果整体缺失，才报告 chapter.incomplete-blueprint。替换式生成若提供既有事件结果边界，必须逐项核对候选是否保留事件身份、章末状态与未解线索；不得把只有气氛或主题方向相近判为完成。铺陈、相处、内省和余波章不要求不可逆结果。章尾按目标章的 closingForce 判断，不得强制添加危险、反转或行动命令。",
  "reader-reviewer": "你是严苛的追更读者，不是编辑。先识别本章承担的是悬疑、行动、关系、生活流、铺陈、余波还是阶段闭合功能，再判断正文是否持续兑现作品承诺，不做文风或事实的技术分析。检查开篇是否建立与本章功能相称的注意力中心，中段是否通过新信息、关系温度、人物认识、状态变化或行动后果深化体验，信息是否在读者需要时抵达，以及正文是否出现真实的跳读区。章尾驱动力不等于强钩子：悬疑与行动章可以依靠未解压力，关系、生活流、余波或阶段闭合章也可以停在未尽交流、状态变化或有功能的情感与意象余韵。不得仅因没有问号、突发事件、强制选择或立即翻页冲动就判为 major；只有章尾没有完成本章功能、重复已知信息、切断既有长线动力或用空泛意象代替实际变化时才报告。项目卖点只在合适兑现窗口检查，不要求每章机械出现。每个问题必须引用正文证据，并说明它如何损害当前章节功能和后续阅读，而不是套用固定字数、钩子密度或章尾公式。\n\n## 叙事节奏维度（narrativePacing）\n节奏不是快慢分数。检查 readerExperience 是否通过可经历的场景过程成立：关键接触、选择、误判、反应与后果是否获得与其因果重量相称的篇幅；转折是否由此前动作挣得；正文是否用连续分析、设定说明或结论跳过本应发生的生活过程。铺陈、相处、内省和余波可以很慢且得高分，前提是体验持续变化；行动章可以很快，前提是因果不被摘要代替。结合 narrativeRhythm 判断相邻章节是否重复同一种说明功能。\n\n## 感情线维度（romance）\n若作品含感情线，从追更视角检查感情发展是否靠行动累积（R1）——告白、心理宣言、突然亲密若没有前置行动铺垫，读者会感到廉价；是否有清晰的阶段感（R2）——相遇/试探/深化/危机/确认，本章的感情进展是否符合当前阶段，不得跳阶；感情对象（女主或对应角色）是否有独立人格与欲望（R4），而非主角附属或工具；感情线是否有复杂度（R5）——阻碍、误会、牺牲、代价，而非一帆风顺。若本章感情线无进展、靠宣言跳进、或感情对象沦为工具人，标为 major。判断需结合前章感情线记忆与冻结上下文，不得仅凭本章臆断阶段。",
};

/**
 * 获取 reviewer 职责焦点，支持题材/项目特化覆盖。
 *
 * 设计依据：AGENTS.md「reusable contracts over case-specific rules」——默认职责题材无关，
 * 题材特化通过 skill.promptSections.review 注入（craft rule 沉淀后以 skill 形式激活）。
 * 多个 skill 的 review 段按顺序拼接为"题材/项目特化补充"，追加在默认职责之后。
 *
 * 注入位置：调用方应把返回值注入 system prompt（角色定义层），避免 system/user 角色割裂。
 * user prompt 中只保留维度约束（"你只能把 X 维度的问题写入 issues"），不再重复职责定义。
 *
 * 返回值结构：
 * - 默认：返回 DEFAULT_REVIEW_FOCUS[role]
 * - 含 skills：返回 `${默认职责}\n\n## 题材/项目特化补充\n${review 段拼接}`
 */
export function getReviewFocus(role: ReviewerRole, skills?: SkillBundle): string {
  const base = DEFAULT_REVIEW_FOCUS[role];
  if (!skills?.skills.length) return base;
  const reviewSections = skills.skills
    .map((skill) => skill.promptSections.review)
    .filter((section): section is string => typeof section === "string" && section.trim().length > 0);
  if (!reviewSections.length) return base;
  return `${base}\n\n## 题材/项目特化补充\n${reviewSections.join("\n\n")}`;
}

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
  stageGoal?: StageGoalContract;
  instructionsOnly?: boolean;
}

const REVIEW_ROLE_TERMS: Record<ReviewerRole, string[]> = {
  "style-reviewer": ["style", "prose", "language", "specificity", "scene", "humor", "文体", "文风", "语言", "具体", "场景", "呈现", "叙述", "意象", "幽默", "诙谐", "趣味"],
  "character-reviewer": ["character", "voice", "dialogue", "relation", "romance", "desire", "ensemble", "人物", "角色", "对白", "声音", "关系", "欲望", "动机", "群像", "配角", "弧光"],
  "continuity-reviewer": ["continuity", "fact", "knowledge", "foreshadow", "world", "rule", "worldbuilding", "连续", "事实", "知识", "伏笔", "世界", "规则", "状态", "设定"],
  "plot-reviewer": ["plot", "blueprint", "causal", "pacing", "tension", "rhythm", "arc", "因果", "情节", "章节", "功能", "节奏", "主线", "支线"],
  "reader-reviewer": ["reader", "hook", "payoff", "retention", "serial", "tension", "romance", "读者", "钩子", "爽点", "追更", "回报", "疲劳", "卖点", "期待", "感情", "情感"],
};

export function selectReviewerSkills(skills: SkillBundle | undefined, role: ReviewerRole, limit = 6): SkillBundle | undefined {
  if (!skills) return undefined;
  const terms = REVIEW_ROLE_TERMS[role];
  const ranked = skills.skills.map((skill, index) => {
    const searchable = [skill.skillId, ...(skill.capabilities ?? []), ...skill.qualityGates, skill.promptSections.review ?? ""].join(" ").toLowerCase();
    const score = terms.reduce((sum, term) => sum + (searchable.includes(term.toLowerCase()) ? 1 : 0), 0);
    return { skill, score, index };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((item) => item.skill);
  return { ...skills, id: `${skills.id}:${role}`, skills: ranked };
}

export function selectReviewerMemory(memory: MemoryBundle, role: ReviewerRole): MemoryBundle {
  const claims = memory.claims.filter((claim) => {
    const facets = new Set([claim.matchedFacet, ...(claim.matchedFacets ?? [])]);
    if (role === "style-reviewer") return facets.has("style") || facets.has("author-preference") || claim.kind === "author";
    if (role === "character-reviewer") return facets.has("entity") || facets.has("relation") || facets.has("fact") || claim.subjectRefs.length > 0;
    if (role === "continuity-reviewer") return facets.has("fact") || facets.has("timeline") || facets.has("foreshadowing") || facets.has("thread") || claim.authority === "approved" || claim.authority === "author";
    if (role === "plot-reviewer") return facets.has("thread") || facets.has("foreshadowing") || facets.has("chapter-memory") || claim.kind === "hierarchical";
    return facets.has("chapter-memory") || facets.has("author-preference") || facets.has("style") || claim.kind === "author";
  });
  return { ...memory, id: `${memory.id}:${role}`, claims };
}

function buildNumberedDraft(text: string): string {
  const paragraphs = text.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean);
  return paragraphs.map((paragraph, index) => `### 段落 ${index + 1}\n${paragraph}`).join("\n\n");
}

function buildReviewerContext(memory: MemoryBundle): string {
  if (!memory.claims.length) return "- 暂无冻结事实。";
  // P1-5: 识别已兑现伏笔（reason 含 [resolved-at:N] 标记，由 retrieveMemoryForReview 注入）
  const resolvedMarkerRegex = /\[resolved-at:(\d+)\]/u;
  const lines = memory.claims.map((claim) => {
    const subjects = claim.subjectRefs.length ? claim.subjectRefs.join(",") : "未绑定主体";
    const match = claim.reason?.match(resolvedMarkerRegex);
    const prefix = match ? `【已兑现于第 ${match[1]} 章】` : "";
    return `- ${prefix}[${claim.authority}/${claim.kind}] ${subjects}: ${claim.title} — ${claim.content}`;
  });
  return lines.join("\n");
}

/**
 * 构建蓝图摘要 markdown（公共函数，供 draft/review/revise/reflection 复用）。
 *
 * 设计依据：AGENTS.md「Fix the problem at the lowest shared layer」——三处 stage 此前各自
 * 构建摘要且字段缺失（review 只列 kind/role/queue、draft 只列 beats、reflection 只列 role），
 * 导致 reviewer/reflection 看不到章节功能与章尾驱动力，无法判断"章功能是否完成"。
 * 统一在此渲染：blueprint 元信息 + 章节功能 + 章尾驱动力 + 任务清单。
 *
 * mustHappen/forbidden 来自 intent.constraints，仅 chapter-draft 能拿到，由调用方额外拼接。
 */
export function buildBlueprintSummary(blueprint: ExecutionBlueprint, planningContext?: ChapterPlanningContext): string {
  const tasks = blueprint.tasks.map((task) => `- [${task.kind}] ${task.role} (queue: ${task.queue})`).join("\n");
  const lines: string[] = [
    `Blueprint ID: ${blueprint.id}`,
    `Base revision: ${blueprint.baseRevision}`,
    `Commit policy: ${blueprint.commitPolicy}`,
  ];
  if (planningContext) lines.push(`Chapter planning context: ${planningContext.fingerprint}`);
  lines.push(`Tasks:`);
  lines.push(tasks || "（无任务）");
  return lines.join("\n");
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
  const { role, artifact, text, blueprint, payoffStats, planningContext, stageGoal } = input;
  const memory = selectReviewerMemory(dedupeNarrativeRhythmMemory(input.memory), role);
  const skills = selectReviewerSkills(input.skills, role);
  const numberedDraft = buildNumberedDraft(text);
  const reviewerContext = buildReviewerContext(memory);
  const blueprintMarkdown = buildBlueprintSummary(blueprint, planningContext);
  const isReaderReviewer = role === "reader-reviewer";
  const payoffMarkdown = isReaderReviewer && payoffStats ? buildPayoffStatsMarkdown(payoffStats) : "";

  // 长篇文学质量维度（对照 quality-standard.md D1/D3/D4/D5）——仅负责这些维度的 reviewer
  // 会收到额外的跨章视角审核提示。
  const roleLongFormDims = REVIEWER_DIMENSIONS[role].filter((d): d is typeof d =>
    d === "worldbuilding" || d === "ensemble" || d === "romance" || d === "humor",
  );

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
    `## 篇幅边界`,
    `字数、字符数、段落数量或是否达到某个目标篇幅，不是审校目标，也不能单独触发降分、verdict=revise/blocked 或 blocker/major issue。只能审查可被正文证据证明的阅读机制：章节功能是否完成、信息是否抵达、情绪/关系/因果是否有承载、是否重复空转或提前消费后续节点。若你认为篇幅相关，必须把问题改写为具体机制（例如"关键转折缺少可观察承载""三段重复同一信息""章尾在结果出现前收束"），并引用正文证据；找不到机制证据时不得报告。`,
    `若冻结章节规划含 narrativeScale，先按 level 理解本章应有的展开深度：compact 可以短而完整，standard 需要成为完整的普通章节，extended 需要承载更高负载；再检查 developmentAxes 是否在正文中被实际经历，stoppingCondition 是否成立。若正文在首个状态变化或单一场景结果出现后立即收束，且仍有规划中的展开轴没有获得可观察承载，使用通用 rule=chapter.premature-closure 报告具体机制；不得把该规则退化为字符数阈值，也不得因为安静章没有新事件而判错。`,
    "",
    `## 当前职责`,
    `你的完整职责定义见 system prompt（默认职责 + 题材/项目特化补充）。下面仅强调维度边界。`,
    `你只能把 ${REVIEWER_DIMENSIONS[role].join("、")} 维度的问题写入 issues；其他维度即使有改进空间，也交给对应 reviewer，不得重复报告。scores 只填写你的职责维度，当前 verdict 只由这些维度决定。`,
    ...(roleLongFormDims.length ? [
      "",
      `## 长篇文学质量维度审核提示`,
      `你负责的长篇文学质量维度（${roleLongFormDims.join("、")}）需要跨章视角：结合下方"冻结章节规划上下文""工作流执行编排"与"相关事实"判断，而非仅看本章正文。这些维度度量全书质量耐久度——世界观规则自洽、群像独立弧光、感情线阶段感、幽默贴合人物——缺陷会在百章尺度上累积放大。若本章在这些维度存在结构性缺陷（规则冲突/配角工具化/感情线跳阶/幽默破坏声部），即使单章可读性成立，也应标为 major。具体判据见 system prompt 中对应维度的职责定义。`,
    ] : []),
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

  if (stageGoal) {
    sections.push(
      "",
      "## 本轮阶段目标",
      stageGoal.authorInstruction ? `作者原始要求：${stageGoal.authorInstruction}` : "本轮没有额外作者要求。",
      `语义验收点：${stageGoal.acceptanceCriteria.join("；") || "按本角色职责审核当前候选"}`,
      `允许变化范围：${stageGoal.allowedChangeScope}`,
      `只在该目标与 ${REVIEWER_DIMENSIONS[role].join("、")} 的职责有关时判断是否兑现；必须依据正文实际阅读效果，不得用关键词出现与否代替判断。未兑现时使用 rule=author-goal.unmet，并引用正文证据。`,
    );
  }

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

  if (input.instructionsOnly) return sections.join("\n");

  sections.push(
    "",
    `## 章尾钩子参考`,
    WRITER_CHAPTER_ENDING_HOOKS,
    "",
    planningContext ? renderChapterPlanningContext(planningContext, { includeMacro: false }) : `## 冻结章节规划上下文\n（历史章节未保存该快照，仅按旧执行编排与冻结事实审核；主题模式按 subtext 兼容。）`,
    "",
    `## 连续章节叙事节奏\n${renderNarrativeRhythm(memory.narrativeRhythm)}`,
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

export function buildChapterReviewPromptPackage(input: ReviewPromptInput & { workflowId: string; system: string }): StagePromptPackage {
  const memory = selectReviewerMemory(dedupeNarrativeRhythmMemory(input.memory), input.role);
  const skills = selectReviewerSkills(input.skills, input.role);
  const instruction = buildChapterReviewPrompt({ ...input, memory, skills: undefined, payoffStats: undefined, stageGoal: undefined, instructionsOnly: true });
  const goalText = input.stageGoal ? [
    input.stageGoal.authorInstruction ? `作者原始要求：${input.stageGoal.authorInstruction}` : "本轮没有额外作者要求。",
    `语义验收点：${input.stageGoal.acceptanceCriteria.join("；") || "按本角色职责审核当前候选"}`,
    `允许变化范围：${input.stageGoal.allowedChangeScope}`,
    `只在目标与 ${REVIEWER_DIMENSIONS[input.role].join("、")} 职责相关时判断兑现情况；依据实际阅读效果，不做关键词匹配。`,
  ].join("\n") : "";
  const sections = [
    { id: "review-instruction", kind: "review" as const, title: "审校方法与职责边界", text: instruction, priority: "required" as const, provenanceRefs: [`reviewer:${input.role}`] },
    ...(input.stageGoal ? [{ id: "stage-goal", kind: "goal" as const, title: "本轮阶段目标", text: goalText, priority: "critical" as const, provenanceRefs: [input.stageGoal.id] }] : []),
    { id: "manuscript", kind: "manuscript" as const, title: "正文（段落编号仅用于定位）", text: buildNumberedDraft(input.text), priority: "critical" as const, provenanceRefs: [input.artifact.id], sourceArtifactId: input.artifact.id },
    ...(input.planningContext ? [{ id: "planning", kind: "planning" as const, title: "冻结章节规划上下文", text: renderChapterPlanningContext(input.planningContext, { includeMacro: false }), priority: input.role === "plot-reviewer" ? "required" as const : "normal" as const, provenanceRefs: [input.blueprint.id] }] : []),
    ...(memory.narrativeRhythm ? [{ id: "narrative-rhythm", kind: "planning" as const, title: "连续章节叙事节奏", text: renderNarrativeRhythm(memory.narrativeRhythm), priority: input.role === "reader-reviewer" || input.role === "style-reviewer" ? "required" as const : "normal" as const, provenanceRefs: [memory.narrativeRhythm.fingerprint] }] : []),
    { id: "blueprint", kind: "blueprint" as const, title: "工作流执行编排", text: buildBlueprintSummary(input.blueprint, input.planningContext), priority: input.role === "plot-reviewer" ? "required" as const : "soft" as const, provenanceRefs: [input.blueprint.id] },
    ...memory.claims.map((claim) => {
      const replacementBoundary = claim.reason === "replacement-boundary";
      return {
        id: `memory:${claim.id}`,
        kind: "fact" as const,
        title: replacementBoundary ? "替换式生成验收边界" : `相关事实：${claim.title}`,
        text: claim.content,
        priority: replacementBoundary || input.role === "continuity-reviewer" || input.role === "character-reviewer" ? "required" as const : "normal" as const,
        provenanceRefs: [claim.id, ...(claim.sourceArtifactId ? [claim.sourceArtifactId] : []), ...claim.sourceRevisionIds],
      };
    }),
    ...((skills?.skills ?? []).map((skill) => ({ id: `skill:${skill.skillId}`, kind: "skill" as const, title: `审校技能 ${skill.skillId}@${skill.version}`, text: skill.promptSections.review ?? "", priority: "normal" as const, provenanceRefs: [`${skill.skillId}@${skill.version}`] }))),
    ...(input.role === "reader-reviewer" && input.payoffStats ? [{ id: "payoff-stats", kind: "background" as const, title: "前章爽点统计", text: buildPayoffStatsMarkdown(input.payoffStats), priority: "normal" as const, provenanceRefs: [input.artifact.projectId] }] : []),
    { id: "artifact-metadata", kind: "background" as const, title: "草稿元数据", text: `artifactId=${input.artifact.id}\nkind=${input.artifact.kind}\nbaseRevision=${input.artifact.baseRevision}\nfingerprint=${input.artifact.fingerprint}`, priority: "soft" as const, provenanceRefs: [input.artifact.id] },
  ];
  return compileStageContext({
    projectId: input.artifact.projectId,
    workflowId: input.workflowId,
    purpose: ({ "style-reviewer": "review.style", "character-reviewer": "review.character", "continuity-reviewer": "review.continuity", "plot-reviewer": "review.plot", "reader-reviewer": "review.reader" } as const)[input.role],
    stage: "review",
    system: input.system,
    schema: reviewerSchemaForDimensions(REVIEWER_DIMENSIONS[input.role]),
    maxInputTokens: input.blueprint.budget.maxInputTokens,
    reservedOutputTokens: input.blueprint.budget.maxOutputTokens,
    goal: input.stageGoal,
    sections,
  });
}

/**
 * 把 reviewer 输出转换为 v2 Review 对象。
 *
 * ReviewerOutput 的完整字段（dimension/description/revisionRanges/rule/suggestion/rewriteExample）
 * 都写入 Review.issues（ReviewIssue 类型），便于下游 revision-stage 与 learning-assessment 复用。
 */
export function toReview(params: { artifact: Artifact; identity: "internal" | "independent"; role: ReviewerRole; output: ReviewerOutput; text?: string }): Review {
  const grounded = params.text === undefined
    ? { issues: params.output.issues, discardedCount: 0 }
    : groundReviewerIssues(params.output.issues, params.text);
  const issues: ReviewIssue[] = grounded.issues.map((issue) => ({
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
  const roleScores = REVIEWER_DIMENSIONS[params.role].map((dimension) => params.output.scores[dimension]).filter((score): score is number => typeof score === "number");
  return {
    id: crypto.randomUUID(),
    projectId: params.artifact.projectId,
    artifactId: params.artifact.id,
    reviewerId: `${params.identity}-${params.role}`,
    identity: params.identity,
    role: params.role,
    verdict: grounded.discardedCount > 0 && issues.length === 0 ? "passed" : params.output.verdict,
    issues,
    score: grounded.discardedCount > 0 && issues.length === 0
      ? undefined
      : roleScores.length ? roleScores.reduce((sum, score) => sum + score, 0) / roleScores.length : undefined,
    dimensionScores: params.output.scores,
    createdAt: Date.now(),
    artifactFingerprint: params.artifact.fingerprint,
  };
}
