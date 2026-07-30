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

export function buildAuthorRevisionBrief(authorInstruction?: string): string {
  const instruction = authorInstruction?.trim();
  if (!instruction) return "（无作者补充取舍）";
  const notes: string[] = [
    "先把作者意见视为本轮场景策略，而不是附加润色建议；审核问题负责指出局部缺陷，作者意见负责决定改写方向。",
  ];
  if (/对白|对话|尬聊|聊天|只留一句|话.*少|少.*话|太多对话/u.test(instruction)) {
    notes.push("对白策略：重新分配信息承载方式；删减解释性、寒暄性、概念说明性对白，把信息更多交给动作、停顿、物件、环境反应和主角观察。若必须保留对白，只保留能改变关系、制造悬念或推动行动的一句关键话。");
  }
  if (/高冷|冷淡|克制|疏离|少说/u.test(instruction)) {
    notes.push("人物姿态：高冷不是用平淡语气讲更多道理，而是少回应、少解释、用不回头、停顿、收拾物件、离开等行为制造距离感。女主的神秘感应来自信息缺口，而不是直接讲清规则。");
  }
  if (/道和理|道理|直接描述|不能直接|解释|说明/u.test(instruction)) {
    notes.push("信息呈现：避免把体系规则和抽象判断直接说出口；用可见事实、灵气变化、符纹异状、主角误解与迟疑来暗示，让读者先感到不寻常，再逐步理解原因。");
  }
  if (/好奇|第一印象|悬念|引发/u.test(instruction)) {
    notes.push("读者效果：本轮目标是建立第一印象和好奇心；保留未解释的异常、人物的不可接近感和主角的追索动机，不急于给出完整答案。");
  }
  if (/重新考量|不合适|偏向错误|太烂/u.test(instruction)) {
    notes.push("修订幅度：这类反馈表示当前场景选择本身不成立，应允许重排相关段落的信息顺序、对白数量和人物反应，而不是只替换几个形容词。未被作者意见影响的核心事件仍需保留。");
  }
  notes.push("作者原话：" + instruction);
  return notes.map((note, index) => `${index + 1}. ${note}`).join("\n");
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
