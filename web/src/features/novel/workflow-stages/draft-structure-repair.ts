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

/**
 * 检测并截断"第二个结尾"重复。
 *
 * LLM 在长文本生成末尾系统性重述前文场景，形成"第二个结尾"：
 * 在章尾驱动力（短段序列）形成后，又展开 3+ 个长叙事段重新推进事件链。
 *
 * 检测模式（从末尾向前扫描）：
 * 1. 找到最后一个长段（≥100 字符，非对白）的位置 longSeqEnd
 * 2. 从 longSeqEnd 向前找到连续长段序列起始位置 longSeqStart
 * 3. 长段序列长度 ≥3 且总字符数 ≥300
 * 4. 长段序列与前文同长度窗口的二元组相似度至少为 55%
 *
 * 截断策略：只删除已确认重复的尾部长段序列及其后的尾声。
 */
export function truncateTrailingSecondEnding(text: string): { truncated: boolean; content: string; removedChars: number } {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length < 8) return { truncated: false, content: text, removedChars: 0 };

  const isLong = (p: string) => !isDialogueParagraph(p) && p.length >= 100;

  // 从末尾向前扫描，找到最后一个长段
  let longSeqEnd = -1;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    if (isLong(paragraphs[i])) {
      longSeqEnd = i;
      break;
    }
  }
  if (longSeqEnd === -1) return { truncated: false, content: text, removedChars: 0 };

  // 从 longSeqEnd 向前扫描，找到连续长段序列起始位置
  let longSeqStart = longSeqEnd;
  for (let i = longSeqEnd - 1; i >= 0; i--) {
    if (isLong(paragraphs[i])) {
      longSeqStart = i;
    } else {
      break;
    }
  }

  const longSeqLength = longSeqEnd - longSeqStart + 1;
  if (longSeqLength < 3) return { truncated: false, content: text, removedChars: 0 };

  // 长段序列总字符数
  const longSeqChars = paragraphs.slice(longSeqStart, longSeqEnd + 1).reduce((sum, p) => sum + p.length, 0);
  if (longSeqChars < 300) return { truncated: false, content: text, removedChars: 0 };

  const trailingText = normalizedParagraph(paragraphs.slice(longSeqStart, longSeqEnd + 1).join(""));
  let repeated = false;
  for (let start = 0; start + longSeqLength <= longSeqStart; start += 1) {
    const earlierText = normalizedParagraph(paragraphs.slice(start, start + longSeqLength).join(""));
    if (earlierText.length >= 80 && bigramSimilarity(earlierText, trailingText) >= 0.55) {
      repeated = true;
      break;
    }
  }
  if (!repeated) return { truncated: false, content: text, removedChars: 0 };

  const totalChars = paragraphs.reduce((sum, p) => sum + p.length, 0);
  const surviving = paragraphs.slice(0, longSeqStart);
  const removedChars = totalChars - surviving.reduce((sum, p) => sum + p.length, 0);
  return {
    truncated: true,
    content: surviving.join("\n\n"),
    removedChars,
  };
}

/**
 * 确定性删除作者式心理结论句。
 *
 * LLM 系统性在行动之后插入替读者总结人物认知或章节意义的句子，
 * 如"她第一次知道，离开一座山门，不一定需要有人赶"。
 * 这类句子打破有限第三人称视角，把"成长"直接宣告给读者，
 * 是中文小说 AI 味最典型的表现之一。
 *
 * 检测模式（仅在非对白叙事段中匹配）：
 * - "她第一次知道/明白/意识到/看清/感到/懂得……"
 * - "她忽然/突然/终于/这才 懂得/明白/看清/意识到/知道……"
 * - "这意味着/这说明/这代表着……"
 * - "也就是说/换句话说/归根结底/说到底……"
 * - "她知道，……若/如果/一旦/只要……"（替读者解释动机）
 *
 * 修复策略：删除匹配的整句（含句末标点）。若段落删除后为空，移除该段。
 * 只删除明确匹配的句子，不改动其他内容。
 */
const INTERPRETIVE_SENTENCE_PATTERNS: RegExp[] = [
  /(?:他|她)(?:第一次)(?:知道|明白|意识到|看清|感到|懂得|领悟|觉得)/,
  /(?:他|她)(?:忽然|突然|终于|这才|这才)(?:懂得|明白|看清|意识到|知道|领悟)/,
  /这(?:意味着|说明|代表着)/,
  /(?:也就是说|换句话说|归根结底|说到底)[，：]/,
  /(?:他|她)知道，.{0,24}(?:若|如果|一旦|只要|不然|否则)/,
];

function splitSentences(paragraph: string): string[] {
  // 按中文句末标点切分，保留标点
  const parts = paragraph.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean);
  return parts;
}

function isInterpretiveSentence(sentence: string): boolean {
  return INTERPRETIVE_SENTENCE_PATTERNS.some((pattern) => pattern.test(sentence));
}

export function repairInterpretiveSummaries(text: string): { repaired: boolean; content: string; removedCount: number } {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return { repaired: false, content: text, removedCount: 0 };

  let removedCount = 0;
  const repaired: string[] = [];

  for (const para of paragraphs) {
    // 跳过对白段（含引号的段落）——对白中的总结性表达由审校处理，不在此确定性删除
    if (isDialogueParagraph(para)) {
      repaired.push(para);
      continue;
    }

    const sentences = splitSentences(para);
    if (sentences.length <= 1) {
      // 单句段：若匹配则删除整段，否则保留
      if (sentences.length === 1 && isInterpretiveSentence(sentences[0])) {
        removedCount += 1;
        // 跳过该段（不 push）
      } else {
        repaired.push(para);
      }
      continue;
    }

    // 多句段：删除匹配的句子，保留其余
    const kept = sentences.filter((s) => {
      if (isInterpretiveSentence(s)) {
        removedCount += 1;
        return false;
      }
      return true;
    });

    if (kept.length === 0) {
      // 整段都被删除——跳过
      continue;
    }
    if (kept.length === sentences.length) {
      // 没有删除——保留原段（避免不必要的拼接变化）
      repaired.push(para);
    } else {
      repaired.push(kept.join(""));
    }
  }

  if (removedCount === 0) return { repaired: false, content: text, removedCount: 0 };
  return { repaired: true, content: repaired.join("\n\n"), removedCount };
}

/**
 * 确定性修复强调词贬值。
 *
 * LLM 系统性过度使用"忽然/突然/终于"等强调词，全章超过 2 次后强调效果贬值。
 * 当 revision-stage 把 style.emphasis-devaluation warning 升级为 major 送 LLM 修订后，
 * LLM 仍可能不彻底执行删除指令。
 *
 * 修复策略：对每个强调词，保留前 2 次出现，从第 3 次开始删除。
 * - "忽然，" → 删除"忽然，"（连同逗号）
 * - "忽然" → 只删除"忽然"两字（保持句意通顺）
 * 只处理非对白段（对白中的强调词可能是人物语气，不删除）。
 */
const EMPHASIS_WORDS = ["忽然", "突然", "终于"];
const EMPHASIS_MAX = 2;

export function repairEmphasisDevaluation(text: string): { repaired: boolean; content: string; removedCount: number } {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return { repaired: false, content: text, removedCount: 0 };

  const globalCount: Record<string, number> = {};
  for (const word of EMPHASIS_WORDS) globalCount[word] = 0;

  let removedCount = 0;
  const repaired = paragraphs.map((para) => {
    // 跳过对白段
    if (isDialogueParagraph(para)) return para;

    let result = para;
    for (const word of EMPHASIS_WORDS) {
      let pos = 0;
      while (true) {
        pos = result.indexOf(word, pos);
        if (pos === -1) break;
        globalCount[word] += 1;
        if (globalCount[word] > EMPHASIS_MAX) {
          // 检查后面是否紧跟逗号
          const afterComma = result[pos + word.length] === "，";
          const removeLen = afterComma ? word.length + 1 : word.length;
          result = result.slice(0, pos) + result.slice(pos + removeLen);
          removedCount += 1;
          // 不移动 pos，因为删除后新内容在原位置
        } else {
          pos += word.length;
        }
      }
    }
    return result;
  });

  if (removedCount === 0) return { repaired: false, content: text, removedCount: 0 };
  return { repaired: true, content: repaired.join("\n\n"), removedCount };
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

  // 确定性删除作者式心理结论句：在段落合并之前删除"她第一次知道..."等范式
  // 这类句子打破有限第三人称，是 AI 味最典型的表现
  const summaryResult = repairInterpretiveSummaries(workingContent);
  if (summaryResult.repaired) {
    workingContent = summaryResult.content;
  }

  // 确定性修复强调词贬值：LLM 修订不彻底时，兜底删除超限的"忽然/突然/终于"
  const emphasisResult = repairEmphasisDevaluation(workingContent);
  if (emphasisResult.repaired) {
    workingContent = emphasisResult.content;
  }

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
