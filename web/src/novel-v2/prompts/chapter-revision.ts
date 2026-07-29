import type { MemoryBundle, ReviewIssue, SkillBundle } from "../protocol";
import type { ChapterPlanningContext } from "../application/story-arc";
import { renderChapterPlanningContext } from "./chapter-planning-context";

export interface RevisionWindow {
  start: number;
  end: number;
  issues: ReviewIssue[];
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

function formatIssues(issues: ReviewIssue[]): string {
  return issues.map((issue, index) => [
    `${index + 1}. [${issue.severity}] ${issue.title}`,
    `问题：${issue.description ?? issue.evidence}`,
    `原文证据：${issue.excerpt ?? issue.evidence}`,
    `修订要求：${issue.suggestion ?? "根据证据修复问题，同时保留原段承担的叙事功能。"}`,
    `改写参考：${issue.rewriteExample ?? "无；必须自行完成实际改写，不得原样返回。"}`,
  ].join("\n")).join("\n\n");
}

export function buildRevisionWindowPrompt(input: {
  text: string;
  window: RevisionWindow;
  memory: MemoryBundle;
  skills?: SkillBundle;
  planningContext?: ChapterPlanningContext;
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
      "1. 保留目标段落承担的事件、信息、人物声音、POV 和因果，只解决列出的问题。",
      "2. 必须实际改写问题证据，不得原样返回；rewriteExample 是方向参考，不得机械复制其中新增的事实。",
      "3. 不得新增原文、冻结事实和相邻段落中都不存在的人物、物件、关系、线索或事件。",
      "4. 不得重写或复述相邻段落，不得解释修订过程，不得输出标题、编号、Markdown 或评语。",
      "5. 用可观察动作、感官和对白承载体验，避免作者式结论；保持自然中文韵律和原有叙述距离。",
    ].join("\n"),
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
