import { novelDb, recordBase } from "./db";
import { analyzeDraftStructure, isDialogueOnlyParagraph } from "./draft-structure";
import type { ChapterBlueprint, NovelAgentRole, QualityDimension, QualityIssue, QualityReport } from "./types";

const DIMENSIONS: QualityDimension[] = ["plot", "characterVoice", "sceneEmbodiment", "dialogue", "pacing", "specificity", "hookPayoff", "continuity"];
const WEIGHTS: Record<QualityDimension, number> = { plot: 0.17, characterVoice: 0.14, sceneEmbodiment: 0.12, dialogue: 0.1, pacing: 0.14, specificity: 0.1, hookPayoff: 0.1, continuity: 0.13 };
const TEMPLATE_EXPRESSIONS = ["眼中闪过", "瞳孔微缩", "嘴角微微上扬", "意味深长", "若有所思", "不由自主", "与此同时", "正因如此", "他很悲伤", "他很愤怒", "他很高兴", "他很害怕", "他很孤独", "他感到", "她感到", "第一次意识到", "第一次发现", "第一次明白", "第一次感到", "第一次看清", "心如刀割", "心漏跳", "倒吸一口凉气", "眼眶泛红"];
const EMPHASIS_WORDS = ["第一次", "突然", "忽然", "终于", "竟然", "不由得", "不禁"];
const EMOTION_DIRECT_WORDS = ["他很悲伤", "他很愤怒", "他很高兴", "他很害怕", "他很孤独", "她很悲伤", "她很愤怒", "她很高兴", "她很害怕", "她很孤独", "心如刀割", "心漏跳", "倒吸一口凉气", "眼眶泛红"];
const APHORISM_PATTERNS = [/不是.{1,12}而是/, /也许.{1,12}就是/, /所谓.{1,12}不过/, /这.{0,6}便是/, /或许.{1,12}才是/, /所谓.{1,12}无非/];
const IMAGERY_WORDS = ["风", "雪", "雨", "月", "灯", "剑", "路", "井", "烟", "尘", "云", "霜", "雾", "影", "光", "火", "水", "石", "树", "花"];
const INTERPRETIVE_SUMMARY_PATTERNS = [
  /(?:他|她)(?:自己)?(?:也)?(?:清楚|知道|明白)[，：]/g,
  /(?:他|她)(?:忽然|突然|终于)?意识到/g,
  /这(?:意味着|说明|代表着)/g,
  /(?:也就是说|换句话说|归根结底|说到底)/g,
  /这个动作.{0,16}(?:意味着|说明|像是)/g,
];
const STRUCTURAL_MAJOR_RULES = new Set(["style.fragmented-paragraphs", "plot.exact-paragraph-repeat", "plot.repeated-progression"]);

export interface ReviewerFinding {
  role: NovelAgentRole;
  scores: Partial<Record<QualityDimension, number>>;
  issues: Omit<QualityIssue, "id" | "deterministic">[];
}

function issue(input: Omit<QualityIssue, "id" | "deterministic">): QualityIssue {
  return { ...input, id: crypto.randomUUID(), deterministic: true };
}

function paragraphs(text: string) {
  return text.split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean);
}

function coefficientOfVariation(values: number[]) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (!mean) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function countOccurrences(text: string, needle: string) {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

function containsMeaning(text: string, requirement: string) {
  // 带标点的复合要求必须完整命中所有子句，不能只完成前半动作。
  const terms = requirement.split(/[，。；、\s]+/).filter((item) => item.length >= 2);
  if (terms.length > 0 && terms.every((term) => text.includes(term))) return true;

  // mustHappen / forbidden 常含"必须""禁止""或"等虚词，但不含标点；
  // 移除虚词后再做 bigram 匹配，避免"无名锈剑必须首次出现"被当作一个不可分割的长词条
  const STOP_WORDS = /必须|不得|需要|应当|应该|禁止|或|并|且|而|的|了|着|过|是|在|与|和/g;
  const compact = requirement.replace(/[，。；、\s]/g, "").replace(STOP_WORDS, "");
  if (compact.length < 2) return false;

  const pairs = Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) => compact.slice(index, index + 2));
  if (pairs.length < 2) return false;

  // 关键实体或单个子句出现不足以证明动作和结果已落实。
  const matchCount = pairs.filter((pair) => text.includes(pair)).length;
  return matchCount / pairs.length >= 0.6;
}

export function runDeterministicQualityChecks(params: { text: string; blueprint?: ChapterBlueprint }) {
  const text = params.text.trim();
  const blocks = paragraphs(text);
  const issues: QualityIssue[] = [];
  const structure = analyzeDraftStructure(text);
  for (const found of structure.issues) {
    const dimension: QualityDimension = found.rule.startsWith("plot.") ? "plot" : "pacing";
    issues.push(issue({
      dimension,
      severity: found.severity,
      title: found.title,
      description: found.description,
      paragraph: found.paragraph,
      revisionRanges: found.revisionRanges,
      rule: found.rule,
      suggestion: found.repairable
        ? "保持事件、措辞和顺序不变，仅移除回复包装并按常规叙事段落重新编排。"
        : "核对较早段落，只删除或合并后出现的重复推进。",
    }));
  }
  const totalChars = text.replace(/\s/g, "").length;
  const dialogueChars = (text.match(/[“「『][^”」』]+[”」』]/g) ?? []).join("").length;
  const templateHits = TEMPLATE_EXPRESSIONS.reduce((sum, word) => sum + countOccurrences(text, word), 0);
  const paragraphLengths = blocks.map((block) => block.length);
  const paragraphVariation = coefficientOfVariation(paragraphLengths);

  for (const forbidden of params.blueprint?.forbidden ?? []) {
    if (forbidden && containsMeaning(text, forbidden)) issues.push(issue({ dimension: "continuity", severity: "blocker", title: "触发章节禁止事项", description: forbidden, excerpt: forbidden, rule: "chapter-blueprint.forbidden", suggestion: "移除该情节，或先修改并重新批准章节蓝图。" }));
  }
  for (const required of params.blueprint?.mustHappen ?? []) {
    // R4: containsMeaning bigram 匹配对含标点的复合要求（如"听潮阁屠门夜必须呈现，但不提前揭示幕后真相"）
    // 有高误报率（措辞不同即判漏）。降级为 major 而非 blocker：
    // - blockerCount 只反映真实阻断（forbidden 触发等），使 qualityReport.passed 可信
    // - revision-stage 仍特判过滤 deterministic mustHappen，不影响 LLM 修订
    // - LLM reviewer (plot-reviewer) 独立检查节拍是否遗漏，可标 major/blocker
    if (required && !containsMeaning(text, required)) issues.push(issue({ dimension: "plot", severity: "major", title: "遗漏必须发生的节拍", description: required, rule: "chapter-blueprint.mustHappen", suggestion: "补写能明确落实该节拍的行动与结果。" }));
  }
  if (totalChars < 300) issues.push(issue({ dimension: "plot", severity: "major", title: "正文过短", description: "当前文本不足以形成完整章节推进。", rule: "chapter.minimum-substance", suggestion: "依据蓝图补齐场景行动、反应与结果。" }));
  if (blocks.length >= 6 && paragraphVariation < 0.18) issues.push(issue({ dimension: "pacing", severity: "warning", title: "段落节奏过于均匀", description: "段落长度变化很小，可能产生模型化节奏。", rule: "style.paragraph-variation", suggestion: "按动作速度和情绪停顿重新划分段落，而非机械打散。" }));
  if (totalChars > 0 && templateHits / totalChars * 1000 > 2) issues.push(issue({ dimension: "specificity", severity: "warning", title: "模板化表达偏多", description: `检测到 ${templateHits} 处常见模板表达。`, rule: "style.template-density", suggestion: "结合人物身体状态、环境和具体目标替换重复动作。" }));
  const openings = blocks.map((block) => block.slice(0, 8));
  for (let index = 2; index < openings.length; index += 1) {
    const starts = openings.slice(index - 2, index + 1).map((value) => value.match(/^[\u3400-\u9fff]{2,4}/)?.[0]);
    if (starts[0] && starts.every((value) => value === starts[0])) {
      issues.push(issue({ dimension: "specificity", severity: "warning", title: "连续段落使用相同起句", description: `连续段落都以“${starts[0]}”开头。`, paragraph: index + 1, rule: "style.repeated-openings", suggestion: "从环境变化、动作结果或对白反应切入其中一段。" }));
      break;
    }
  }
  const ending = blocks.at(-1) ?? "";
  if (ending && ending.length < 12) issues.push(issue({ dimension: "hookPayoff", severity: "warning", title: "章尾驱动力较弱", description: "最后一段过短且缺少可识别的决定、代价或认知变化。", excerpt: ending, paragraph: blocks.length, rule: "serial.ending-drive", suggestion: "让结尾留下新的行动方向、代价、危险或认知缺口。" }));

  for (const word of EMPHASIS_WORDS) {
    const hits = countOccurrences(text, word);
    if (hits > 2) issues.push(issue({ dimension: "specificity", severity: "warning", title: "强调词贬值", description: `“${word}”出现 ${hits} 次，超过单章 2 次上限，强调效果贬值。`, rule: "style.emphasis-devaluation", suggestion: "用具体事件呈现认知转变，或替换为不同表达，删除多余的强调。" }));
  }
  for (const phrase of EMOTION_DIRECT_WORDS) {
    if (text.includes(phrase)) issues.push(issue({ dimension: "sceneEmbodiment", severity: "warning", title: "情绪直说", description: `检测到“${phrase}”，情绪被直接宣告而非通过行动或意象承载。`, excerpt: phrase, rule: "style.emotion-direct", suggestion: "用一个反常动作、环境意象变化或没说完的话来承载该情绪。" }));
  }
  let shortSentenceStreaks = 0;
  let shortSentenceStreak = 0;
  for (const block of blocks) {
    if (isDialogueOnlyParagraph(block)) {
      shortSentenceStreak = 0;
      continue;
    }
    const sentences = block.split(/[。！？\n]/).map((s) => s.trim()).filter(Boolean);
    for (const s of sentences) {
      // R5: 阈值从 ≤6 放宽到 ≤10，覆盖"里面没有尸体。""也没有打斗痕迹。"等 7-10 字短句排比
      if (s.length > 0 && s.length <= 10) shortSentenceStreak += 1;
      else shortSentenceStreak = 0;
      if (shortSentenceStreak >= 3) { shortSentenceStreaks += 1; shortSentenceStreak = 0; }
    }
  }
  if (shortSentenceStreaks > 2) issues.push(issue({ dimension: "pacing", severity: "warning", title: "短句排比过多", description: `检测到 ${shortSentenceStreaks} 处连续短句排比，超过单章 2 处上限。`, rule: "style.short-sentence-tic", suggestion: "将部分排比融入完整句式，仅在极度紧张或决断瞬间保留短句。" }));
  let aphorismEndings = 0;
  for (const block of blocks) {
    const trimmedBlock = block.trim();
    if (APHORISM_PATTERNS.some((pattern) => pattern.test(trimmedBlock))) aphorismEndings += 1;
  }
  if (aphorismEndings > 3) issues.push(issue({ dimension: "specificity", severity: "warning", title: "金句收尾过密", description: `检测到 ${aphorismEndings} 处格言式收尾，超过单章 3 处上限。`, rule: "style.aphorism-density", suggestion: "将部分金句改为行动或沉默收尾，让行为本身承载主题。" }));
  const imageryHits = IMAGERY_WORDS.reduce((sum, word) => sum + countOccurrences(text, word), 0);
  const interpretiveSummaryHits = INTERPRETIVE_SUMMARY_PATTERNS.reduce((sum, pattern) => sum + (text.match(pattern) ?? []).length, 0);
  if (totalChars >= 600 && interpretiveSummaryHits >= 2 && interpretiveSummaryHits / totalChars * 1000 >= 0.75) {
    issues.push(issue({
      dimension: "specificity",
      severity: "warning",
      title: "解释性总结偏多",
      description: `检测到 ${interpretiveSummaryHits} 处替读者归纳人物认知或文本含义的表达。`,
      rule: "style.interpretive-summary-density",
      suggestion: "删除动作或对白之后的解释句，让人物后续选择、关系反应和具体后果承载含义。",
    }));
  }

  const scores = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 4.2])) as Record<QualityDimension, number>;
  for (const found of issues) {
    const penalty = found.severity === "blocker" ? 2 : found.severity === "major" ? 1 : 0.35;
    scores[found.dimension] = Math.max(0, scores[found.dimension] - penalty);
  }
  return {
    issues,
    scores,
    metrics: {
      characters: totalChars,
      paragraphs: blocks.length,
      dialogueRatio: totalChars ? Number((dialogueChars / totalChars).toFixed(3)) : 0,
      paragraphVariation: Number(paragraphVariation.toFixed(3)),
      singleSentenceNarrativeRatio: Number(structure.singleSentenceNarrativeRatio.toFixed(3)),
      maxConsecutiveSingleSentenceNarrative: structure.maxConsecutiveSingleSentenceNarrative,
      templateHits,
      imageryDensity: imageryHits,
      interpretiveSummaryHits,
    },
  };
}

function titleBigrams(title: string): Set<string> {
  const compact = title.replace(/[，。；、！？,.!?;:“”"'（）()\[\]\s]+/g, "");
  const bigrams = new Set<string>();
  for (let i = 0; i < compact.length - 1; i += 1) bigrams.add(compact.slice(i, i + 2));
  return bigrams;
}

function titleSimilarity(a: string, b: string): number {
  const setA = titleBigrams(a);
  const setB = titleBigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection += 1;
  return intersection / Math.min(setA.size, setB.size);
}

const SEVERITY_RANK: Record<QualityIssue["severity"], number> = { blocker: 3, major: 2, warning: 1 };

function isDuplicateIssue(existing: QualityIssue, candidate: Omit<QualityIssue, "id" | "deterministic">): boolean {
  if (existing.rule && candidate.rule && existing.rule === candidate.rule && existing.rule !== "reviewer.unavailable") return titleSimilarity(existing.title, candidate.title) >= 0.5;
  return titleSimilarity(existing.title, candidate.title) >= 0.75;
}

function mergeRevisionRanges(...groups: Array<QualityIssue["revisionRanges"]>): QualityIssue["revisionRanges"] {
  const ranges = groups.flatMap((group) => group ?? []);
  if (ranges.length === 0) return undefined;
  return Array.from(new Map(ranges.map((range) => [`${range.start}:${range.end}`, range])).values())
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function deduplicateReviewerIssues(existing: QualityIssue[], candidate: Omit<QualityIssue, "id" | "deterministic">): QualityIssue[] {
  const duplicateIndex = existing.findIndex((item) => !item.deterministic && isDuplicateIssue(item, candidate));
  if (duplicateIndex === -1) return [...existing, { ...candidate, id: crypto.randomUUID(), deterministic: false }];
  const duplicate = existing[duplicateIndex];
  if (SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[duplicate.severity]) {
    const merged: QualityIssue = { ...duplicate, ...candidate, id: duplicate.id, deterministic: false, revisionRanges: mergeRevisionRanges(duplicate.revisionRanges, candidate.revisionRanges), description: `${duplicate.description}\n\n[另一审校补充] ${candidate.description}` };
    return existing.map((item, index) => (index === duplicateIndex ? merged : item));
  }
  const merged: QualityIssue = { ...duplicate, revisionRanges: mergeRevisionRanges(duplicate.revisionRanges, candidate.revisionRanges), description: `${duplicate.description}\n\n[另一审校补充] ${candidate.description}` };
  return existing.map((item, index) => (index === duplicateIndex ? merged : item));
}

export function aggregateQuality(params: { deterministic: ReturnType<typeof runDeterministicQualityChecks>; reviewers?: ReviewerFinding[]; threshold: number }) {
  const scores = { ...params.deterministic.scores };
  let issues: QualityIssue[] = [...params.deterministic.issues];
  const reviewerRoles: NovelAgentRole[] = [];
  for (const reviewer of params.reviewers ?? []) {
    reviewerRoles.push(reviewer.role);
    for (const [dimension, score] of Object.entries(reviewer.scores) as Array<[QualityDimension, number]>) scores[dimension] = Number(((scores[dimension] + Math.max(0, Math.min(5, score))) / 2).toFixed(2));
    for (const found of reviewer.issues) issues = deduplicateReviewerIssues(issues, found);
  }
  const blockerCount = issues.filter((item) => item.severity === "blocker").length;
  const structuralMajorCount = issues.filter((item) => item.severity === "major" && STRUCTURAL_MAJOR_RULES.has(item.rule)).length;
  const weightedScore = Number(DIMENSIONS.reduce((sum, dimension) => sum + scores[dimension] * WEIGHTS[dimension], 0).toFixed(2));
  const coreFloorPassed = DIMENSIONS.every((dimension) => scores[dimension] >= 3);
  return { scores, issues, blockerCount, weightedScore, passed: blockerCount === 0 && structuralMajorCount === 0 && coreFloorPassed && weightedScore >= params.threshold, reviewerRoles };
}

export async function saveQualityReport(params: {
  projectId: string;
  workflowRunId: string;
  artifactId: string;
  iteration: number;
  deterministic: ReturnType<typeof runDeterministicQualityChecks>;
  reviewers?: ReviewerFinding[];
  threshold: number;
}) {
  const aggregated = aggregateQuality(params);
  const report: QualityReport = {
    ...recordBase(params.projectId),
    workflowRunId: params.workflowRunId,
    artifactId: params.artifactId,
    iteration: params.iteration,
    scores: aggregated.scores,
    weightedScore: aggregated.weightedScore,
    blockerCount: aggregated.blockerCount,
    passed: aggregated.passed,
    issues: aggregated.issues,
    metrics: params.deterministic.metrics,
    reviewerRoles: aggregated.reviewerRoles,
  };
  await novelDb.qualityReports.add(report);
  return report;
}

export const QUALITY_DIMENSION_LABELS: Record<QualityDimension, string> = {
  plot: "剧情推进", characterVoice: "人物声音", sceneEmbodiment: "场景具象", dialogue: "对白", pacing: "节奏", specificity: "语言具体性", hookPayoff: "钩子与回报", continuity: "连续性",
};
