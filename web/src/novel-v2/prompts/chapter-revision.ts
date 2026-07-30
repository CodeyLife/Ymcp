import type { MemoryBundle, ReviewIssue, SkillBundle } from "../protocol";
import type { ChapterPlanningContext } from "../application/story-arc";
import { renderChapterPlanningContext } from "./chapter-planning-context";

export interface RevisionWindow {
  start: number;
  end: number;
  issues: ReviewIssue[];
}

export interface TargetedRevisionReplacement {
  start: number;
  end: number;
  text: string;
}

export function splitChapterParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/u).map((paragraph) => paragraph.trim()).filter(Boolean);
}

function locatedRanges(issue: ReviewIssue, paragraphs: string[]): Array<{ start: number; end: number }> {
  if (issue.revisionRanges?.length) {
    return issue.revisionRanges
      .map((range) => ({ start: Math.max(0, range.start - 1), end: Math.min(paragraphs.length - 1, range.end - 1) }))
      .filter((range) => range.start <= range.end);
  }
  if (typeof issue.paragraph === "number" && issue.paragraph >= 1 && issue.paragraph <= paragraphs.length) {
    return [{ start: issue.paragraph - 1, end: issue.paragraph - 1 }];
  }
  const excerpt = issue.excerpt?.trim() || issue.evidence.trim();
  if (!excerpt) return [];
  const exact = paragraphs.findIndex((paragraph) => paragraph.includes(excerpt) || excerpt.includes(paragraph));
  if (exact >= 0) return [{ start: exact, end: exact }];
  const anchor = excerpt.slice(0, 32);
  const partial = paragraphs.findIndex((paragraph) => paragraph.includes(anchor));
  return partial >= 0 ? [{ start: partial, end: partial }] : [];
}

export function planRevisionWindows(text: string, issues: ReviewIssue[]): RevisionWindow[] {
  const paragraphs = splitChapterParagraphs(text);
  const candidates = issues.flatMap((issue) => locatedRanges(issue, paragraphs).map((range) => ({ ...range, issue })));
  candidates.sort((left, right) => left.start - right.start || left.end - right.end);
  const windows: RevisionWindow[] = [];
  for (const candidate of candidates) {
    const previous = windows.at(-1);
    if (previous && candidate.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, candidate.end);
      if (!previous.issues.includes(candidate.issue)) previous.issues.push(candidate.issue);
    } else {
      windows.push({ start: candidate.start, end: candidate.end, issues: [candidate.issue] });
    }
  }
  return windows;
}

export function revisionWindowsCoverAllIssues(windows: RevisionWindow[], issues: ReviewIssue[]): boolean {
  const covered = new Set(windows.flatMap((window) => window.issues));
  return issues.every((issue) => covered.has(issue));
}

function formatIssues(issues: ReviewIssue[]): string {
  return issues.map((issue, index) => [
    `${index + 1}. [${issue.severity}] ${issue.title}`,
    `问题：${issue.description ?? issue.evidence}`,
    `原文证据：${issue.excerpt ?? issue.evidence}`,
    `修订要求：${issue.suggestion ?? "根据证据修复问题，同时保留原段承担的叙事功能。"}`,
    `改写参考：${issue.rewriteExample ?? "无；必须自行完成实际改写，不得原样返回。"}`,
  ].join("\n")).join("\n\n");
}

/**
 * 构建作者反馈的结构化 brief，作为本轮修订的场景策略指引。
 *
 * 设计依据：AGENTS.md「reusable contracts over case-specific rules」+「root-cause analysis」——
 * 原实现用正则匹配 5 类关键词（对白/高冷/道理/好奇/重新考量）生成场景策略 notes，是 case-specific
 * rule：作者用任何新词（如"散文化""节奏慢""太压抑""太干巴巴"）都无法触发任何 note，反馈被静默丢弃。
 *
 * 根因：作者反馈是自然语言意图表达，关键词集合不可枚举。把"意图识别"放在 prompt 拼装层（用正则）
 * 是错误的层次——应交给 LLM 在修订时自识别，prompt 层只提供：
 *   1. 作者原文（透传，无关键词过滤）
 *   2. 通用意图分类契约（6 类意图，覆盖所有可能的作者反馈）
 *   3. 意图→修订方向的映射规则（让 LLM 主动识别并响应）
 *   4. 一个跨题材正例（让 LLM 看到如何从模糊反馈中提取意图）
 *
 * 不内置任何题材词（如"灵气""符纹""女主"），意图分类题材无关。
 *
 * 6 类意图（覆盖作者反馈的完整空间，互不重叠）：
 * - 叙事节奏：反馈涉及"快/慢/拖/赶/散文化/流水账/跳读"等
 * - 对白风格：反馈涉及"对白/对话/尬聊/话多话少/口语/书面"等
 * - 情感基调：反馈涉及"压抑/清淡/浓烈/冷/暖/高冷/克制/疏离"等
 * - 信息密度：反馈涉及"干巴巴/堆砌/信息量/解释/说明/留白"等
 * - 视角处理：反馈涉及"POV/视角/代入感/距离/上帝视角"等
 * - 场景策略：反馈涉及"重新考量/不合适/方向错/太烂/推倒重来"等（场景选择本身不成立）
 */
export function buildAuthorRevisionBrief(authorInstruction?: string): string {
  const instruction = authorInstruction?.trim();
  if (!instruction) return "（无作者补充取舍；按审核问题逐项修订即可。）";

  // 作者原文透传：不做任何关键词过滤，让 LLM 看到完整反馈。
  // 反馈可能是一句话或多句，按句号/换行拆分为条目，便于 LLM 逐条识别意图。
  const feedbackLines = splitAuthorFeedback(instruction);

  return [
    "先把作者意见视为本轮场景策略，而不是附加润色建议；审核问题负责指出局部缺陷，作者意见负责决定改写方向。",
    "",
    "## 作者反馈（原文透传，按句拆分）",
    ...feedbackLines.map((line, index) => `${index + 1}. ${line}`),
    "",
    "## 意图识别契约（修订 Worker 必须主动识别并响应）",
    "作者反馈可能使用任何自然语言词汇，不限于下方列举的示例词。修订 Worker 必须从反馈中识别以下 6 类意图之一或多个，并在 rewriteExample 与实际改写中体现对该意图的响应：",
    "",
    "1. **叙事节奏**（示例词：快/慢/拖/赶/散文化/流水账/跳读/冗长/仓促）",
    "   响应方向：调整段落长度配比、信息抵达节奏、场景切换密度；增删铺垫与延展。",
    "2. **对白风格**（示例词：对白/对话/尬聊/话多话少/口语/书面/只留一句）",
    "   响应方向：重新分配信息承载方式（对白↔动作↔物象↔环境反应↔主角观察）；删减解释性/寒暄性对白，保留能改变关系、制造悬念或推动行动的关键句。",
    "3. **情感基调**（示例词：压抑/清淡/浓烈/冷/暖/高冷/克制/疏离/温情/虐心）",
    "   响应方向：用行为制造距离感或亲近感（少回应/少解释/停顿/离开/收拾物件），而非用语气词讲道理；神秘感/疏离感应来自信息缺口而非直接宣告规则。",
    "4. **信息密度**（示例词：干巴巴/堆砌/信息量/解释/说明/留白/直白/暗示）",
    "   响应方向：把抽象判断和体系规则改为可见事实、物件异状、主角误解与迟疑来暗示；让读者先感到不寻常再逐步理解，避免直接说出口。",
    "5. **视角处理**（示例词：POV/视角/代入感/距离/上帝视角/越界）",
    "   响应方向：删除替视角人物总结他人心理的句子；把「观察+判断」改为「视角人物能看到/听到的具体动作」。",
    "6. **场景策略**（示例词：重新考量/不合适/方向错/太烂/推倒重来）",
    "   响应方向：这类反馈表示当前场景选择本身不成立，允许重排信息顺序、对白数量、人物反应，而非只替换形容词；未被作者意见影响的核心事件仍需保留。",
    "",
    "## 跨题材正例（模糊反馈→意图识别→响应）",
    "作者反馈：「这段太干巴巴。」",
    "意图识别：信息密度过高（「干巴巴」= 缺乏感官与情绪承载）+ 情感基调过冷（缺情绪内化）。",
    "响应：在 rewriteExample 中补充感官细节（光影/温度/物件触感）与角色情绪内化（不直接命名情绪，用动作/观察承载），但不新增冻结事实之外的信息。",
    "",
    "## 反例（应避免）",
    "- 仅因反馈未命中某关键词就忽略作者意见（原实现的 bug）。",
    "- 把作者反馈机械拆成「删除所有对白」等绝对规则——意图是方向，不是禁令。",
    "- 借作者反馈越过目标段落或新增未建立事实。",
  ].join("\n");
}

/**
 * 把作者反馈按句号/换行拆分为条目。
 *
 * 拆分目的：作者反馈常是多句话混合（如"对白太烂。女主高冷点。别讲道理。"），
 * 按句拆分让 LLM 逐句识别意图，避免整段反馈被笼统归为某一类。
 *
 * 不做任何语义过滤——拆分是纯结构化操作，意图识别交给 LLM。
 */
function splitAuthorFeedback(instruction: string): string[] {
  return instruction
    .split(/[。！？\n]+/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function buildFullChapterRevisionPrompt(input: {
  text: string;
  issues: ReviewIssue[];
  memory: MemoryBundle;
  skills?: SkillBundle;
  planningContext?: ChapterPlanningContext;
  authorInstruction?: string;
}): string {
  const skills = input.skills?.skills.map((skill) => [`### ${skill.skillId}@${skill.version}`, skill.promptSections.revision ?? ""].filter(Boolean).join("\n")).join("\n\n") || "（无）";
  return [
    "修订下面整章正文，修复所有列出的审核问题，并按作者反馈重定本轮场景取舍。输出必须且只能是完整修订后正文，不使用 Markdown，不解释过程。",
    "## 作者反馈转译为本轮修订策略（最高优先级）",
    buildAuthorRevisionBrief(input.authorInstruction),
    "作者要求可以扩大本轮需要检查的正文范围，但不得违反冻结事实、章节规划、人物既定关系与已发生事件。",
    "## 原文",
    input.text,
    "## 审核问题",
    formatIssues(input.issues) || "（无结构化审核问题）",
    "## 冻结记忆",
    input.memory.claims.map((claim) => `- [${claim.authority}/${claim.kind}] ${claim.title}: ${claim.content}`).join("\n") || "（无）",
    input.planningContext ? renderChapterPlanningContext(input.planningContext) : "## 冻结章节规划上下文\n（历史章节无规划快照。）",
    "## 已激活修订技能",
    skills,
    "## 整章修订契约",
    [
      "1. 逐项落实作者策略和审核问题，不得仅做近义改写或只处理其中一类意见。",
      "2. 保留原章事件、关键信息、POV 和因果；信息可以从对白转移到动作、物象、环境反应或主角观察中。",
      "3. 不得新增冻结事实和原文都未建立的人物、关系、线索或事件。",
      "4. 用可观察动作、感官和必要对白承载体验；当作者指出对白或解释有问题时，优先用非对白方式完成同一叙事功能。",
    ].join("\n"),
  ].join("\n\n");
}

export function buildRevisionWindowPrompt(input: {
  text: string;
  window: RevisionWindow;
  memory: MemoryBundle;
  skills?: SkillBundle;
  planningContext?: ChapterPlanningContext;
  authorInstruction?: string;
}): string {
  const paragraphs = splitChapterParagraphs(input.text);
  const source = paragraphs.slice(input.window.start, input.window.end + 1).join("\n\n");
  const before = input.window.start > 0 ? paragraphs[input.window.start - 1] : "（无）";
  const after = input.window.end + 1 < paragraphs.length ? paragraphs[input.window.end + 1] : "（无）";
  const memory = input.memory.claims.map((claim) => `- [${claim.authority}/${claim.kind}] ${claim.title}: ${claim.content}`).join("\n") || "（无冻结事实）";
  const skills = input.skills?.skills.map((skill) => [`### ${skill.skillId}@${skill.version}`, skill.promptSections.revision ?? ""].filter(Boolean).join("\n")).join("\n\n") || "（无额外修订技能）";
  return [
    `只修订原章第 ${input.window.start + 1}-${input.window.end + 1} 段。输出必须且只能是替换这些目标段落的连续小说正文。`,
    "## 必须处理的问题",
    formatIssues(input.window.issues),
    "## 作者补充修改要求",
    buildAuthorRevisionBrief(input.authorInstruction),
    "## 冻结事实（只读）",
    memory,
    input.planningContext ? renderChapterPlanningContext(input.planningContext) : "## 冻结章节规划上下文\n（历史章节无规划快照。）",
    "## 已激活修订技能",
    skills,
    "## 上一段（只读，不得复述）",
    before,
    "## 待替换段落",
    source,
    "## 下一段（只读，不得复述）",
    after,
    "## 局部修订契约",
    [
      "1. 保留目标段落承担的事件、信息、POV 和因果；若作者反馈要求减少对白或解释，可把信息改由动作、物象、环境反应或主角观察承载。",
      "2. 必须实际改写问题证据，不得原样返回；rewriteExample 是方向参考，不得机械复制其中新增的事实。",
      "3. 不得新增原文、冻结事实和相邻段落中都不存在的人物、物件、关系、线索或事件。",
      "4. 不得重写或复述相邻段落，不得解释修订过程，不得输出标题、编号、Markdown 或评语。",
      "5. 用可观察动作、感官和必要对白承载体验，避免作者式结论；保持自然中文韵律和原有叙述距离。",
      "6. 作者反馈用于明确本轮取舍；不得借反馈越过目标段落或新增未建立事实。",
    ].join("\n"),
  ].join("\n\n");
}

export const targetedRevisionBatchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["replacements"],
  properties: {
    replacements: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "text"],
        properties: {
          start: { type: "integer", minimum: 1 },
          end: { type: "integer", minimum: 1 },
          text: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

export function buildTargetedRevisionBatchPrompt(input: { text: string; windows: RevisionWindow[]; memory: MemoryBundle; skills?: SkillBundle; planningContext?: ChapterPlanningContext; authorInstruction?: string }): string {
  const outputExample = {
    replacements: input.windows.map((window) => ({
      start: window.start + 1,
      end: window.end + 1,
      text: "该原章范围的替换正文",
    })),
  };
  return [
    "只返回 JSON。逐个修订下列目标窗口，不得合并、扩展或修改原章段号。每项 text 只包含该窗口的替换正文。",
    ...input.windows.map((window, index) => `## 窗口 ${index + 1}\n${buildRevisionWindowPrompt({ ...input, window })}`),
    "## 输出格式",
    `start/end 必须使用上文标明的原章段号，并完整返回以下所有范围：${input.windows.map((window) => `${window.start + 1}-${window.end + 1}`).join("、")}。`,
    JSON.stringify(outputExample),
  ].join("\n\n");
}

export function applyRevisionWindows(text: string, replacements: Array<{ window: RevisionWindow; text: string }>): string {
  const paragraphs = splitChapterParagraphs(text);
  for (const replacement of [...replacements].sort((left, right) => right.window.start - left.window.start)) {
    const replacementParagraphs = splitChapterParagraphs(replacement.text.replace(/^```(?:\w+)?\s*/u, "").replace(/\s*```$/u, ""));
    if (!replacementParagraphs.length) continue;
    paragraphs.splice(replacement.window.start, replacement.window.end - replacement.window.start + 1, ...replacementParagraphs);
  }
  return paragraphs.join("\n\n");
}

export function applyTargetedRevisionReplacements(text: string, windows: RevisionWindow[], replacements: TargetedRevisionReplacement[]): string {
  if (!windows.length) throw new Error("目标意见无法解析出安全修订窗口");
  const allowed = new Map(windows.map((window) => [`${window.start + 1}:${window.end + 1}`, window]));
  const seen = new Set<string>();
  const accepted: Array<{ window: RevisionWindow; text: string }> = [];
  for (const replacement of replacements) {
    const key = `${replacement.start}:${replacement.end}`;
    const window = allowed.get(key);
    if (!window || seen.has(key)) throw new Error(`返回内容不属于目标修订窗口：${replacement.start}-${replacement.end}`);
    seen.add(key);
    if (replacement.text.trim()) accepted.push({ window, text: replacement.text });
  }
  if (seen.size !== allowed.size) throw new Error("AI 未返回全部目标修订窗口");
  if (!accepted.length) throw new Error("AI 未返回有效的目标段落修改");
  const revised = applyRevisionWindows(text, accepted);
  if (revised === text) throw new Error("AI 未实际修改目标段落");
  return revised;
}
