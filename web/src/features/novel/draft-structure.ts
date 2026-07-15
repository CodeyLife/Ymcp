export interface DraftStructureIssue {
  rule: string;
  severity: "blocker" | "major" | "warning";
  title: string;
  description: string;
  paragraph?: number;
  revisionRanges?: Array<{ start: number; end: number }>;
  repairable: boolean;
}

export interface DraftStructureReport {
  paragraphCount: number;
  narrativeParagraphCount: number;
  singleSentenceNarrativeCount: number;
  singleSentenceNarrativeRatio: number;
  maxConsecutiveSingleSentenceNarrative: number;
  issues: DraftStructureIssue[];
}

export function splitDraftParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean);
}

export function isDialogueOnlyParagraph(paragraph: string): boolean {
  return /^(?:[“「『][\s\S]*[”」』][。！？!?]?|["'][\s\S]*["'][。！？!?]?)$/.test(paragraph.trim());
}

function sentenceCount(paragraph: string): number {
  return paragraph.split(/[。！？!?]+/).map((value) => value.trim()).filter(Boolean).length;
}

function formattingIssue(paragraph: string, index: number): DraftStructureIssue | undefined {
  const trimmed = paragraph.trim();
  const base = { severity: "blocker" as const, paragraph: index + 1, revisionRanges: [{ start: index + 1, end: index + 1 }], repairable: true };
  if (/^(?:以下是|下面是|这是).{0,12}(?:正文|章节|草稿)[：:]?$/i.test(trimmed)) {
    return { ...base, rule: "format.response-wrapper", title: "包含回复包装", description: "正文前出现了模型回复说明。" };
  }
  if (/^#{1,6}\s+\S/.test(trimmed)) {
    return { ...base, rule: "format.markdown-heading", title: "包含 Markdown 标题", description: "章节标题由编辑器管理，正文不得再次输出标题。" };
  }
  if (/^```/.test(trimmed)) {
    return { ...base, rule: "format.code-fence", title: "包含代码围栏", description: "正文不得包裹在 Markdown 代码围栏中。" };
  }
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
    return { ...base, rule: "format.horizontal-rule", title: "包含水平分隔线", description: "章节内部应使用叙事过渡换场，不得输出 Markdown 水平分隔线。" };
  }
  // :::directive{...} 或 ::: 包装（markdown directive / container），LLM 经常自行加在正文首尾
  if (/^:::[a-zA-Z][\w-]*(?:\{[^}]*\})?\s*$/.test(trimmed) || /^:::\s*$/.test(trimmed)) {
    return { ...base, rule: "format.markdown-directive", title: "包含 Markdown directive 包装", description: "正文不得包裹在 :::directive{...} 或 ::: 容器中。" };
  }
  return undefined;
}

export function normalizedParagraph(paragraph: string): string {
  return paragraph.replace(/[\s，。；、！？,.!?;:“”"'「」『』（）()《》]/g, "");
}

function bigrams(text: string): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) result.add(text.slice(index, index + 2));
  return result;
}

export function bigramSimilarity(left: string, right: string): number {
  const leftPairs = bigrams(left);
  const rightPairs = bigrams(right);
  if (leftPairs.size === 0 || rightPairs.size === 0) return 0;
  let overlap = 0;
  for (const pair of leftPairs) if (rightPairs.has(pair)) overlap += 1;
  return overlap / Math.min(leftPairs.size, rightPairs.size);
}

export function analyzeDraftStructure(text: string): DraftStructureReport {
  const paragraphs = splitDraftParagraphs(text);
  const formattingIssues = paragraphs.map(formattingIssue).filter((item): item is DraftStructureIssue => Boolean(item));
  const formattingParagraphs = new Set(formattingIssues.map((item) => item.paragraph! - 1));
  const classifiedParagraphs = paragraphs.map((paragraph, index) => ({
    index,
    singleSentence: !isDialogueOnlyParagraph(paragraph) && sentenceCount(paragraph) === 1,
    dialogueOnly: isDialogueOnlyParagraph(paragraph),
    formatting: formattingParagraphs.has(index),
  }));
  const narrative = classifiedParagraphs.filter((item) => !item.dialogueOnly && !item.formatting);
  const singleSentenceNarrativeCount = narrative.filter((item) => item.singleSentence).length;
  const singleSentenceNarrativeRatio = narrative.length > 0
    ? singleSentenceNarrativeCount / narrative.length
    : 0;
  let currentStreak = 0;
  let maxConsecutiveSingleSentenceNarrative = 0;
  for (const item of classifiedParagraphs) {
    currentStreak = !item.dialogueOnly && !item.formatting && item.singleSentence ? currentStreak + 1 : 0;
    maxConsecutiveSingleSentenceNarrative = Math.max(maxConsecutiveSingleSentenceNarrative, currentStreak);
  }

  const issues: DraftStructureIssue[] = [...formattingIssues];
  if (narrative.length >= 3 && (singleSentenceNarrativeRatio > 0.3 || maxConsecutiveSingleSentenceNarrative >= 3)) {
    issues.push({
      rule: "style.fragmented-paragraphs",
      severity: "major",
      title: "叙事段落过度碎片化",
      description: `单句叙事段占 ${(singleSentenceNarrativeRatio * 100).toFixed(0)}%，最长连续 ${maxConsecutiveSingleSentenceNarrative} 段。`,
      revisionRanges: paragraphs.length > 0 ? [{ start: 1, end: paragraphs.length }] : undefined,
      repairable: true,
    });
  }

  const firstParagraphByContent = new Map<string, number>();
  paragraphs.forEach((paragraph, index) => {
    const normalized = normalizedParagraph(paragraph);
    if (normalized.length < 12 || isDialogueOnlyParagraph(paragraph) || formattingParagraphs.has(index)) return;
    const firstIndex = firstParagraphByContent.get(normalized);
    if (firstIndex === undefined) {
      firstParagraphByContent.set(normalized, index);
      return;
    }
    issues.push({
      rule: "plot.exact-paragraph-repeat",
      severity: "major",
      title: "正文段落完全重复",
      description: `第 ${index + 1} 段与第 ${firstIndex + 1} 段内容重复。`,
      paragraph: index + 1,
      revisionRanges: [{ start: index + 1, end: index + 1 }],
      repairable: false,
    });
  });

  const windowSize = 4;
  let strongestRepeatedWindow: { earlierStart: number; laterStart: number; similarity: number } | undefined;
  for (let earlierStart = 0; earlierStart <= paragraphs.length - windowSize; earlierStart += 1) {
    const earlierText = normalizedParagraph(paragraphs.slice(earlierStart, earlierStart + windowSize).join(""));
    if (earlierText.length < 80) continue;
    for (let laterStart = earlierStart + windowSize + 6; laterStart <= paragraphs.length - windowSize; laterStart += 1) {
      const laterText = normalizedParagraph(paragraphs.slice(laterStart, laterStart + windowSize).join(""));
      if (laterText.length < 80) continue;
      const similarity = bigramSimilarity(earlierText, laterText);
      if (similarity < 0.55 || (strongestRepeatedWindow && similarity <= strongestRepeatedWindow.similarity)) continue;
      strongestRepeatedWindow = { earlierStart, laterStart, similarity };
    }
  }
  if (strongestRepeatedWindow) {
    const { earlierStart, laterStart, similarity } = strongestRepeatedWindow;
    issues.push({
      rule: "plot.repeated-progression",
      severity: "major",
      title: "疑似重复推进",
      description: `第 ${laterStart + 1}—${laterStart + windowSize} 段与第 ${earlierStart + 1}—${earlierStart + windowSize} 段结构相似度为 ${(similarity * 100).toFixed(0)}%。`,
      paragraph: laterStart + 1,
      revisionRanges: [{ start: laterStart + 1, end: laterStart + windowSize }],
      repairable: false,
    });
  }

  return {
    paragraphCount: paragraphs.length,
    narrativeParagraphCount: narrative.length,
    singleSentenceNarrativeCount,
    singleSentenceNarrativeRatio,
    maxConsecutiveSingleSentenceNarrative,
    issues,
  };
}
