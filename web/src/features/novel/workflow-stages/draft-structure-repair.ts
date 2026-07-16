import { streamNovelModel } from "../ai";
import { analyzeDraftStructure, bigramSimilarity, isDialogueOnlyParagraph, normalizedParagraph, type DraftStructureIssue, type DraftStructureReport } from "../draft-structure";

export interface DraftStructureRepairResult {
  content: string;
  repaired: boolean;
  report: DraftStructureReport;
  promptHash?: string;
}

function repairableIssues(report: DraftStructureReport): DraftStructureIssue[] {
  return report.issues.filter((item) => item.repairable);
}

function issueList(issues: DraftStructureIssue[]) {
  return issues.map((item) => `- ${item.title}：${item.description}`).join("\n");
}

function isFormattingLine(line: string): boolean {
  const trimmed = line.trim();
  return !trimmed
    || /^(?:以下是|下面是|这是).{0,12}(?:正文|章节|草稿)[：:]?$/i.test(trimmed)
    || /^#{1,6}\s+\S/.test(trimmed)
    || /^```/.test(trimmed)
    || /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)
    || /^:::[a-zA-Z][\w-]*(?:\{[^}]*\})?\s*$/.test(trimmed)
    || /^:::\s*$/.test(trimmed);
}

function manuscriptCharacters(text: string) {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !isFormattingLine(line))
    .join("")
    .replace(/\s/g, "");
}

function stripFormattingMarkers(text: string): string {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !isFormattingLine(line))
    .join("\n\n");
}

/**
 * 修复对白结束后多余句号（#18 标点断裂）。
 *
 * LLM 系统性产出 `"xxx。"。后续叙事` 模式：
 * 闭合引号内已有句末标点（。！？），引号外又跟一个句号。
 * 规范中文排版：句末标点应放在引号内，引号外不再重复。
 *
 * 修复模式（闭合引号 U+201D / U+0022 / U+300D / U+300F）：
 * - 句末标点 + 闭合引号 + 多余句号 → 句末标点 + 闭合引号
 * - 例：`。"。` → `。"`、`？"。` → `？"`、`！"。` → `！"`
 *
 * 只修复"引号内已有句末标点 + 引号外句号"的重复，
 * 不影响 `xxx"。`（引号内无句末标点、引号外有句号）的正常用法。
 */
export function repairPunctuationBreaks(text: string): string {
  // 句末标点（。！？）+ 闭合引号 + 多余句号（。）
  // 闭合引号覆盖：中文弯引号 U+201D、英文直引号 U+0022、直角引号 U+300D、双直角引号 U+300F
  return text.replace(
    /([。！？])([\u201D\u0022\u300D\u300F])\u3002/g,
    "$1$2",
  );
}

// 判断是否为对白段（包含中文引号）
function isDialogueParagraph(text: string): boolean {
  return /[“”"「」『』]/.test(text);
}

// 判断是否为短叙事段（非对白，非格式标记，≤1 个句号/问号/感叹号，<120 字符）
function isShortNarrativeParagraph(text: string): boolean {
  if (isDialogueParagraph(text)) return false;
  if (isFormattingLine(text)) return false;
  const sentenceEndings = (text.match(/[。！？]/g) || []).length;
  return sentenceEndings <= 1 && text.length < 120;
}

// 确定性段落合并：检测连续 2+ 个短叙事段并直接拼接（不加空格）
// 中文段落内句子应直接连贯，不能像英文那样用空格分隔
// manuscriptCharacters 检查不受影响（只移除空行，不改字符）
// 仅在段落总数 ≥4 时触发（碎片化在短文本也会损害阅读体验）
function mergeFragmentedParagraphs(text: string): string {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length < 4) return text;

  const merged: string[] = [];
  let buffer = "";
  let consecutiveShort = 0;

  for (const para of paragraphs) {
    if (isShortNarrativeParagraph(para)) {
      if (buffer) {
        // 中文不用空格分隔句子：直接拼接
        // 若前句未以标点结尾，补一个句号
        buffer += /[。！？…]$/.test(buffer) ? para : "。" + para;
      } else {
        buffer = para;
      }
      consecutiveShort += 1;
      // 合并 3-4 个短段后输出，形成有节拍的叙事段
      if (consecutiveShort >= 3) {
        merged.push(buffer);
        buffer = "";
        consecutiveShort = 0;
      }
    } else {
      if (buffer) {
        merged.push(buffer);
        buffer = "";
      }
      merged.push(para);
      consecutiveShort = 0;
    }
  }
  if (buffer) merged.push(buffer);

  const stitched: string[] = [];
  for (let index = 0; index < merged.length; index += 1) {
    const current = merged[index];
    const next = merged[index + 1];
    if (next && isShortNarrativeParagraph(current) && isDialogueOnlyParagraph(next)) {
      stitched.push(`${current}${next}`);
      index += 1;
      continue;
    }
    if (next && isDialogueOnlyParagraph(current) && isShortNarrativeParagraph(next)) {
      stitched.push(`${current}${next}`);
      index += 1;
      continue;
    }
    stitched.push(current);
  }

  return stitched.join("\n\n");
}

function characterNgrams(text: string, size = 3): Set<string> {
  const normalized = normalizedParagraph(text);
  const grams = new Set<string>();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }
  return grams;
}

function ngramDiceSimilarity(left: string, right: string): number {
  const leftGrams = characterNgrams(left);
  const rightGrams = characterNgrams(right);
  if (leftGrams.size === 0 || rightGrams.size === 0) return 0;
  let overlap = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) overlap += 1;
  return (2 * overlap) / (leftGrams.size + rightGrams.size);
}

/** A replay repeats concrete phrasing from several earlier paragraphs, not merely topic words. */
function isTrailingParagraphReplay(earlier: string[], trailing: string[]): boolean {
  const replayed = trailing.filter((paragraph) => {
    if (normalizedParagraph(paragraph).length < 8) return false;
    return earlier.some((candidate) => ngramDiceSimilarity(candidate, paragraph) >= 0.5);
  }).length;
  return replayed >= 2 && replayed * 2 > trailing.length;
}

/**
 * 检测并截断"第二个结尾"重复。
 *
 * LLM 在长文本生成末尾系统性重述前文场景，形成"第二个结尾"。两种检测模式：
 *
 * 模式一（长段序列）：在章尾驱动力（短段序列）形成后，又展开 3+ 个长叙事段重新推进事件链。
 * 检测：从末尾向前扫描，找到连续长段序列（≥100 字符/段，≥3 段，总 ≥300 字符），
 * 与前文同长度窗口的二元组相似度 ≥0.55 则截断。
 *
 * 模式二（短段序列，R8+R14）：章尾以 4+ 短段（<100 字符）重述已解决的主题。
 * R8 仅检测纯短叙事段；R14 扩展到包含短对白段的混合序列——第二个结尾常含
 * "原来线索在这里。"等短对白，打断纯叙事序列导致 R8 漏检。
 * 检测：保留前 2 个短段，从第 3 个开始检查尾部多数段落是否分别复演了前文的
 * 具体措辞。共享题材词、人物名或场景物件不足以证明重演。
 *
 * 截断策略：只删除已确认重复的尾部序列。
 */
export function truncateTrailingSecondEnding(text: string): { truncated: boolean; content: string; removedChars: number } {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length < 8) return { truncated: false, content: text, removedChars: 0 };

  const isLong = (p: string) => !isDialogueParagraph(p) && p.length >= 100;
  // R14：短段序列检测扩展到包含短对白段——第二个结尾常含"原来线索在这里。"等短对白
  const isShortAny = (p: string) => !isFormattingLine(p) && p.length < 100;

  // ===== 模式一：长段序列第二个结尾 =====
  let longSeqEnd = -1;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    if (isLong(paragraphs[i])) {
      longSeqEnd = i;
      break;
    }
  }

  if (longSeqEnd !== -1) {
    let longSeqStart = longSeqEnd;
    for (let i = longSeqEnd - 1; i >= 0; i--) {
      if (isLong(paragraphs[i])) {
        longSeqStart = i;
      } else {
        break;
      }
    }

    const longSeqLength = longSeqEnd - longSeqStart + 1;
    if (longSeqLength >= 3) {
      const longSeqChars = paragraphs.slice(longSeqStart, longSeqEnd + 1).reduce((sum, p) => sum + p.length, 0);
      if (longSeqChars >= 300) {
        const trailingText = normalizedParagraph(paragraphs.slice(longSeqStart, longSeqEnd + 1).join(""));
        for (let start = 0; start + longSeqLength <= longSeqStart; start += 1) {
          const earlierText = normalizedParagraph(paragraphs.slice(start, start + longSeqLength).join(""));
          if (earlierText.length >= 80 && bigramSimilarity(earlierText, trailingText) >= 0.55) {
            const totalChars = paragraphs.reduce((sum, p) => sum + p.length, 0);
            const surviving = paragraphs.slice(0, longSeqStart);
            const removedChars = totalChars - surviving.reduce((sum, p) => sum + p.length, 0);
            return { truncated: true, content: surviving.join("\n\n"), removedChars };
          }
        }
      }
    }
  }

  // ===== 模式二：短段序列第二个结尾（R8+R14） =====
  // R8：纯短叙事段序列；R14：扩展到包含短对白段的混合序列
  // 第二个结尾常含"原来线索在这里。"等短对白，打断纯叙事序列导致 R8 漏检
  let shortSeqStart = paragraphs.length;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    if (isShortAny(paragraphs[i])) {
      shortSeqStart = i;
    } else {
      break;
    }
  }

  const shortSeqLength = paragraphs.length - shortSeqStart;
  if (shortSeqLength >= 4 && shortSeqStart >= 4) {
    for (let splitOffset = 2; splitOffset < shortSeqLength; splitOffset++) {
      const splitAt = shortSeqStart + splitOffset;
      const tailParas = paragraphs.slice(splitAt);

      if (tailParas.length >= 3 && isTrailingParagraphReplay(paragraphs.slice(0, splitAt), tailParas)) {
        const totalChars = paragraphs.reduce((sum, p) => sum + p.length, 0);
        const surviving = paragraphs.slice(0, splitAt);
        const removedChars = totalChars - surviving.reduce((sum, p) => sum + p.length, 0);
        return { truncated: true, content: surviving.join("\n\n"), removedChars };
      }
    }
  }

  return { truncated: false, content: text, removedChars: 0 };
}

export async function repairDraftStructureOnce(params: {
  content: string;
  model: string;
  skillPrompt: string;
}): Promise<DraftStructureRepairResult> {
  let workingContent = params.content;

  // #18 标点断裂修复：对白结束后多余句号（。"。 → 。"）
  // 尽早修复，避免影响后续段落切分与重复检测
  workingContent = repairPunctuationBreaks(workingContent);

  // 确定性去重：在格式修复之前，先移除 LLM 常见的"末尾重述前文"重复段落
  const dedupReport = analyzeDraftStructure(workingContent);
  const dedupIssues = dedupReport.issues.filter(
    (item) => item.rule === "plot.repeated-progression" || item.rule === "plot.exact-paragraph-repeat",
  );
  if (dedupIssues.length > 0) {
    const paragraphs = workingContent.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const toDelete = new Set<number>();
    for (const issue of dedupIssues) {
      if (issue.revisionRanges) {
        for (const range of issue.revisionRanges) {
          const start = Math.max(1, range.start);
          const end = Math.min(paragraphs.length, range.end);
          for (let i = start - 1; i < end; i++) toDelete.add(i);
        }
      }
    }
    if (toDelete.size > 0 && toDelete.size < paragraphs.length) {
      const surviving = paragraphs.filter((_, index) => !toDelete.has(index));
      workingContent = surviving.join("\n\n");
    }
  }

  // 确定性截断"第二个结尾"：在章尾驱动力（短段）形成后，又展开 3+ 长叙事段重新推进事件链
  // 检测模式：短段 → 3+ 长段序列（≥100 字符/段，总 ≥300 字符）
  const tailResult = truncateTrailingSecondEnding(workingContent);
  if (tailResult.truncated) {
    workingContent = tailResult.content;
  }

  // Loop 6 修复 #10：即使没有 repairable issues，也必须 strip 格式标记（Markdown heading/code fence 等）
  // 否则 draft-stage 调用 repairDraftStructureOnce 后，正文仍可能残留 "# 第一章：xxx" 等格式标记
  const initialReport = analyzeDraftStructure(workingContent);
  const initialRepairable = repairableIssues(initialReport);
  if (initialRepairable.length === 0) {
    const stripped = stripFormattingMarkers(workingContent);
    const strippedReport = analyzeDraftStructure(stripped);
    return {
      content: stripped,
      repaired: dedupIssues.length > 0 || tailResult.truncated || stripped !== workingContent,
      report: strippedReport,
    };
  }

  // 确定性段落合并：在格式修复之前，先合并连续短叙事段以降低碎片化率
  // 只改变段落分隔符（\n\n → 空格），不改变任何字符
  const afterMerge = mergeFragmentedParagraphs(workingContent);
  const mergeReport = analyzeDraftStructure(afterMerge);
  const mergeRepairable = repairableIssues(mergeReport);
  if (mergeRepairable.length === 0) {
    return { content: afterMerge, repaired: true, report: mergeReport };
  }

  const deterministicallyCleaned = stripFormattingMarkers(afterMerge);
  const afterDetReport = analyzeDraftStructure(deterministicallyCleaned);
  const afterDetRepairable = repairableIssues(afterDetReport);
  if (afterDetRepairable.length === 0) {
    return { content: deterministicallyCleaned, repaired: true, report: afterDetReport };
  }

  const result = await streamNovelModel({
    model: params.model,
    temperature: 0.2,
    role: "revision-editor",
    skillPrompt: params.skillPrompt,
    prompt: `只修复下面正文的回复包装和段落结构。除删除回复包装和格式标记外，正文中的每个字符及其先后顺序都必须保持不变；只能调整空行，不增加、删除或改写正文内容。

## 需要修复
${issueList(afterDetRepairable)}

## 修复规则
- 删除“以下是正文”等回复说明、Markdown 标题、代码围栏和水平分隔线
- 普通叙事段落合并为每段 2 至 5 句
- 对白、明确转折和强冲击可以单句成段，但单句叙事段不得连续出现 3 个，且占比不得超过 30%
- 只输出一份修复后的连续正文，不要解释，不要输出标题或标记

## 原正文
${deterministicallyCleaned}`,
  });

  if (manuscriptCharacters(result.content) !== manuscriptCharacters(deterministicallyCleaned)) {
    return { content: deterministicallyCleaned, repaired: true, report: afterDetReport };
  }

  const repairedReport = analyzeDraftStructure(result.content);
  const remaining = repairableIssues(repairedReport);
  if (remaining.length > 0) {
    return { content: deterministicallyCleaned, repaired: true, report: afterDetReport };
  }
  return { content: result.content, repaired: true, report: repairedReport, promptHash: result.promptHash };
}
