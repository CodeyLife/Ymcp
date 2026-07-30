import type { MemoryBundle, ReviewIssue, SkillBundle, StageGoalContract, StagePromptPackage } from "../protocol";
import type { ChapterPlanningContext } from "../application/story-arc";
import { renderChapterPlanningContext } from "./chapter-planning-context";
import { compileStageContext } from "../stage-context";

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

export function shouldUseRevisionWindows(input: { requiresFullRevision: boolean; authorInstruction?: string }): boolean {
  return !input.requiresFullRevision && !input.authorInstruction?.trim();
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

function renderRevisionSkills(skills: SkillBundle | undefined, authorInstruction?: string): string {
  if (!skills?.skills.length) return "（无）";
  if (authorInstruction?.trim()) {
    return `（本轮由作者明确指定修订方向，不重复注入全量技能正文。已激活技能仅作为不冲突时的背景参考：${skills.skills.map((skill) => `${skill.skillId}@${skill.version}`).join("、")}。）`;
  }
  return skills.skills
    .map((skill) => [`### ${skill.skillId}@${skill.version}`, skill.promptSections.revision ?? ""].filter(Boolean).join("\n"))
    .join("\n\n");
}

function renderAuthorDirectedMemory(memory: MemoryBundle): string {
  const factual = memory.claims.filter((claim) => claim.authority === "approved" || claim.kind === "episodic");
  const background = memory.claims.filter((claim) => !factual.includes(claim));
  return [
    "### 必须保持的已发生事实",
    factual.map((claim) => `- [${claim.authority}/${claim.kind}] ${claim.title}: ${claim.content}`).join("\n") || "- 无额外事实约束",
    "### 宏观背景索引（软参考）",
    background.map((claim) => `- ${claim.title}`).join("\n") || "- 无",
    "宏观背景只用于避免方向冲突，不要求保留原文的具体表达、对白、场景组织或修辞。",
  ].join("\n");
}

function renderAuthorDirectedPlanningContext(context: ChapterPlanningContext): string {
  const chapter = context.chapter;
  const scenes = chapter.scenes.map((scene) => [
    `- ${scene.title}：${scene.summary}`,
    `  目标：${scene.goal || "未限定"}；结果：${scene.outcome || "未限定"}`,
  ].join("\n")).join("\n") || "- 未预设场景";
  return [
    "## 当前章修订边界",
    `- 故事弧：${context.arc.title}`,
    `- 目标章：第 ${chapter.globalOrder} 章《${chapter.title}》`,
    `- 章节功能：${chapter.chapterPurpose}`,
    `- 摘要：${chapter.summary}`,
    `- POV：${chapter.povCharacterId || "未限定"}`,
    `- 状态变化预算：${chapter.stateDeltaBudget}`,
    `- 章尾驱动力：${chapter.closingForce}`,
    "### 连续性硬约束",
    chapter.continuityConstraints.map((item) => `- ${item}`).join("\n") || "- 无",
    "### 场景功能",
    scenes,
    "其他宏观规划和可选节拍是软参考；本轮不要求复述或保留其具体措辞。",
  ].join("\n");
}

function renderRevisionMemory(memory: MemoryBundle, authorInstruction?: string): string {
  if (authorInstruction?.trim()) return renderAuthorDirectedMemory(memory);
  return memory.claims.map((claim) => `- [${claim.authority}/${claim.kind}] ${claim.title}: ${claim.content}`).join("\n") || "（无）";
}

function renderRevisionPlanningContext(context: ChapterPlanningContext | undefined, authorInstruction?: string): string {
  if (!context) return "## 冻结章节规划上下文\n（历史章节无规划快照。）";
  return authorInstruction?.trim() ? renderAuthorDirectedPlanningContext(context) : renderChapterPlanningContext(context);
}

export interface AuthorRevisionAlignment {
  satisfied: boolean;
  summary: string;
  unmetRequirements: string[];
  evidence: string[];
}

export const authorRevisionAlignmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["satisfied", "summary", "unmetRequirements", "evidence"],
  properties: {
    satisfied: { type: "boolean" },
    summary: { type: "string", minLength: 1 },
    unmetRequirements: { type: "array", items: { type: "string", minLength: 1 } },
    evidence: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

export function buildAuthorRevisionAlignmentPrompt(input: { original: string; candidate: string; authorInstruction: string }): string {
  return [
    "判断候选正文是否实质响应了作者本轮修改要求。作者要求是自然语言目标，需要结合原文和候选的实际阅读效果判断，不做关键词匹配，也不把意见机械解释成绝对禁令。",
    "只有候选在相关叙事选择、人物呈现或表达效果上出现可感知变化，才可判定 satisfied=true；仅修复无关审校问题、删除一处重复或做同义替换不算完成。",
    "若未满足，unmetRequirements 要说明仍未落实的目标及其在候选中的具体表现；evidence 引用或概括可核对的文本证据。",
    "## 作者要求",
    input.authorInstruction.trim(),
    "## 修订前正文",
    input.original,
    "## 候选正文",
    input.candidate,
  ].join("\n\n");
}

export function buildAuthorRevisionRepairPrompt(input: {
  original: string;
  candidate: string;
  authorInstruction: string;
  alignment: AuthorRevisionAlignment;
  memory: MemoryBundle;
  planningContext?: ChapterPlanningContext;
}): string {
  return [
    "候选正文未充分响应作者要求。根据独立对齐检查继续修订，输出必须且只能是完整修订后正文。不要解释过程。",
    "## 作者要求",
    input.authorInstruction.trim(),
    "## 未满足项",
    input.alignment.unmetRequirements.map((item, index) => `${index + 1}. ${item}`).join("\n") || input.alignment.summary,
    "## 检查证据",
    input.alignment.evidence.map((item) => `- ${item}`).join("\n") || "- 参照作者要求重新比较原文与候选",
    "## 原始正文（用于确认本轮需要发生的变化）",
    input.original,
    "## 当前候选（在此基础上继续修订）",
    input.candidate,
    "## 事实边界",
    renderAuthorDirectedMemory(input.memory),
    renderRevisionPlanningContext(input.planningContext, input.authorInstruction),
    "完成后自行重新核对作者要求；不要用修复其他问题代替本轮目标。",
  ].join("\n\n");
}

/** Preserve author feedback as natural-language intent; interpretation belongs to the revision model. */
export function buildAuthorRevisionBrief(authorInstruction?: string): string {
  const instruction = authorInstruction?.trim();
  if (!instruction) return "（无作者补充取舍；按审核问题逐项修订即可。）";

  return [
    "## 作者原话（最高优先级）",
    instruction,
    "",
    "## 执行决策",
    "1. 先理解作者想改变的阅读效果、叙事选择和保留边界，不要用关键词表替作者归类，也不要把意见机械改写成绝对禁令。",
    "2. 将作者要求与审校证据合并判断：审校意见指出已知缺陷，作者要求决定本轮方向；两者冲突时以作者明确取舍为准。",
    "3. 自行判断受影响范围。若达到作者目标需要联动多个段落，可以调整所有必要段落，但必须保持冻结事实、章节规划、人物关系、POV 和既定因果。",
    "4. 生成前先形成内部修改计划，生成后逐项核对作者原话；正文必须出现可感知的实质变化，不能只做同义替换。不要输出分析、计划或核对过程。",
  ].join("\n");
}

export function buildFullChapterRevisionPrompt(input: {
  text: string;
  issues: ReviewIssue[];
  memory: MemoryBundle;
  skills?: SkillBundle;
  planningContext?: ChapterPlanningContext;
  authorInstruction?: string;
}): string {
  const skills = renderRevisionSkills(input.skills, input.authorInstruction);
  return [
    "修订下面整章正文，修复所有列出的审核问题，并按作者反馈重定本轮场景取舍。输出必须且只能是完整修订后正文，不使用 Markdown，不解释过程。",
    "## 作者反馈转译为本轮修订策略（最高优先级）",
    buildAuthorRevisionBrief(input.authorInstruction),
    "作者要求可以扩大本轮需要检查的正文范围，但不得违反冻结事实、章节规划、人物既定关系与已发生事件。",
    "## 原文",
    input.text,
    "## 审核问题",
    formatIssues(input.issues) || "（无结构化审核问题）",
    "## 事实与背景边界",
    renderRevisionMemory(input.memory, input.authorInstruction),
    renderRevisionPlanningContext(input.planningContext, input.authorInstruction),
    "## 已激活修订技能",
    skills,
    "## 整章修订契约",
    [
      "1. 逐项落实作者策略和审核问题，不得仅做近义改写或只处理其中一类意见。",
      "2. 保留原章事件、关键信息、POV 和因果；根据作者要求重新选择承载信息与情绪的表达方式。",
      "3. 不得新增冻结事实和原文都未建立的人物、关系、线索或事件。",
      "4. 修改幅度由作者目标决定；既不能用局部同义替换敷衍结构性要求，也不能无依据重写与目标无关的内容。",
    ].join("\n"),
    ...(input.authorInstruction?.trim() ? [
      "## 输出前最后核对",
      `再次逐字核对作者原话：${input.authorInstruction.trim()}`,
      "如果当前候选还只是完成审校问题、但没有让作者要求产生可感知的正文变化，继续在内部修订；最终只输出完成后的正文。",
    ] : []),
  ].join("\n\n");
}

export function buildFullChapterRevisionPromptPackage(input: {
  projectId: string;
  workflowId: string;
  system: string;
  sourceArtifactId: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  goal?: StageGoalContract;
  text: string;
  issues: ReviewIssue[];
  memory: MemoryBundle;
  skills?: SkillBundle;
  planningContext?: ChapterPlanningContext;
  authorInstruction?: string;
}): StagePromptPackage {
  const contract = [
    "修订下面整章正文，输出必须且只能是完整修订后正文，不使用 Markdown，不解释过程。",
    "逐项落实作者目标和审核问题；根据目标决定必要改动范围，不得用无关润色或同义替换冒充完成。",
    "保留未被目标触及的已发生事实、人物关系、POV、章节功能与既定因果，不新增冻结来源没有依据的事实。",
    "输出前按实际阅读效果核对目标；不要输出分析、计划或核对过程。",
  ].join("\n");
  return compileStageContext({
    projectId: input.projectId,
    workflowId: input.workflowId,
    purpose: "writing.revision",
    stage: "revision",
    system: input.system,
    goal: input.goal,
    maxInputTokens: input.maxInputTokens,
    reservedOutputTokens: input.maxOutputTokens,
    sections: [
      { id: "revision-contract", kind: "goal", title: "整章修订契约", text: contract, priority: "critical", provenanceRefs: [input.goal?.id ?? input.sourceArtifactId] },
      ...(input.authorInstruction?.trim() ? [{ id: "author-instruction", kind: "goal" as const, title: "作者原始修改要求", text: input.authorInstruction.trim(), priority: "critical" as const, provenanceRefs: [input.goal?.id ?? input.sourceArtifactId] }] : []),
      { id: "source-manuscript", kind: "manuscript", title: "修订前正文", text: input.text, priority: "critical", provenanceRefs: [input.sourceArtifactId], sourceArtifactId: input.sourceArtifactId },
      { id: "review-issues", kind: "review", title: "本轮审核问题", text: formatIssues(input.issues) || "（无结构化审核问题）", priority: input.issues.length ? "required" : "soft", provenanceRefs: input.issues.map((_, index) => `issue:${index}`) },
      { id: "revision-facts", kind: "fact", title: "事实与背景边界", text: renderRevisionMemory(input.memory, input.authorInstruction), priority: "required", provenanceRefs: [input.memory.id] },
      ...(input.planningContext ? [{ id: "revision-planning", kind: "planning" as const, title: "冻结章节规划边界", text: renderRevisionPlanningContext(input.planningContext, input.authorInstruction), priority: "required" as const, provenanceRefs: [input.planningContext.fingerprint] }] : []),
      { id: "revision-skills", kind: "skill", title: "已激活修订技能", text: renderRevisionSkills(input.skills, input.authorInstruction), priority: "normal", provenanceRefs: [input.skills?.id ?? "no-skills"] },
    ],
  });
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
  const skills = renderRevisionSkills(input.skills, input.authorInstruction);
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
