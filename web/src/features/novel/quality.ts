import { novelDb, recordBase } from "./db";
import { analyzeDraftStructure, isDialogueOnlyParagraph } from "./draft-structure";
import type { ChapterBlueprint, NovelAgentRole, QualityDimension, QualityIssue, QualityReport } from "./types";

const DIMENSIONS: QualityDimension[] = ["plot", "characterVoice", "sceneEmbodiment", "dialogue", "specificity", "hookPayoff", "continuity"];
const WEIGHTS: Record<QualityDimension, number> = { plot: 0.19, characterVoice: 0.16, sceneEmbodiment: 0.14, dialogue: 0.11, specificity: 0.14, hookPayoff: 0.11, continuity: 0.15 };
export const QUALITY_SCORING_VERSION = 2;
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
  // 回顾式心理总结句：替人物宣告处世原则或制度规矩（Loop 4 新增）
  /(?:他|她)这(?:些年|些日子|半生|一生|辈子)[^。，；]{0,24}(?:靠的便是|靠的就是|凭的便是|凭的就是|都是因为|只凭|全凭)/g,
  /(?:他|她)从来(?:都是|便是|就是)[^。，；]{0,12}(?:的|人)/g,
  /(?:内廷|宫里|宫廷|朝廷|江湖|规矩)(?:最忌讳|最忌|最怕|最讲究)[^。，；]{0,18}(?:替|把|让|是)/g,
];
// 隐式 POV 越界：用"像/仿佛/宛如+心理动词"替视角人物判断他人内心状态。
// 这类句子表面是比喻，实质是作者借视角人物之口宣告对他人心理的总结。
const IMPLICIT_POV_BREACH_PATTERNS = [
  /像(?:是)?(?:在)?(?:提醒自己|回忆|思考|权衡|盘算|犹豫|压抑|掩饰|强压|下定决心|换了一个人|变了一个人)/g,
  /仿佛(?:在)?(?:提醒自己|回忆|思考|权衡|盘算|犹豫|压抑|掩饰|强压|下定决心|换了一个人|变了一个人)/g,
  /宛如(?:在)?(?:提醒自己|回忆|思考|权衡|盘算|犹豫|压抑|掩饰|强压)/g,
  /(?:却|似|恍)像(?:忽然)?换了一个人/g,
];
// 场景后追加总结：段落以具体动作/对白开始，却以抽象结论收尾。
const SCENE_SUMMARY_TAIL_PATTERNS = [
  /(?:说明|意味着|代表着|也就是说|换句话说)[，。]/,
  /(?:已经)?(?:不止|不再|无法|未必|终究|毕竟)[^。，；]{0,20}(?:能够|可以|解释|涵盖|承担|挽回)/,
  /(?:此刻|此时|这一切|这些)[^。，；]{0,12}(?:都|皆|已)[^。，；]{0,16}(?:落在|指向|汇聚|归于|超过)/,
];
const ACTION_MARKER_RE = /[“「『][^”」』]{2,}[”」』]|(?:他|她|它|那人|此人|[\u3400-\u9fff]{2,4})(?:走|抬|放|握|转|看|听|停|推|拉|翻|查|封|记|写|说|问|答|低头|垂手|攥紧|松开)/;
const REVIEW_WARNING_MAJOR_PATTERN = /(?:视角|POV|限知|知识边界|感知范围).{0,18}(?:越界|超出|违反|冲突|他人心理|内心|心理解释)|(?:越过|超出|违反|进入|直接呈现|直接解释).{0,18}(?:视角|POV|限知|知识边界|感知范围|他人心理|内心判断)|第二个(?:结尾|开场)|重复(?:推进|事件链|收束)/i;
const CONDITIONAL_INTERPRETATION_RE = /(?:若|如果|假如|倘若|一旦).{0,24}(?:理解|解读|推断|视为|意味着)/;
const INTERNAL_STATE_EVIDENCE_RE = /(?:意识到|知道|明白|觉得|认为|想到|想起|决定|判断|确信|察觉|盘算|权衡|内心|心想)/;

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

export function countNovelWords(text: string) {
  return (text.match(/[\u3400-\u9fff]|[a-zA-Z0-9]+/g) ?? []).length;
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
    const dimension: QualityDimension = found.rule.startsWith("plot.") ? "plot" : "specificity";
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
  const wordCount = countNovelWords(text);
  const dialogueChars = (text.match(/[“「『][^”」』]+[”」』]/g) ?? []).join("").length;
  const templateHits = TEMPLATE_EXPRESSIONS.reduce((sum, word) => sum + countOccurrences(text, word), 0);
  const paragraphLengths = blocks.map((block) => block.length);
  const paragraphVariation = coefficientOfVariation(paragraphLengths);

  for (const forbidden of params.blueprint?.forbidden ?? []) {
    if (forbidden && containsMeaning(text, forbidden)) issues.push(issue({ dimension: "continuity", severity: "blocker", title: "触发章节禁止事项", description: forbidden, excerpt: forbidden, rule: "chapter-blueprint.forbidden", suggestion: "移除该情节，或先修改并重新批准章节蓝图。" }));
  }
  // mustHappen 节拍检查已移除：containsMeaning bigram 匹配对文学化措辞（同义词/改写）误报率过高。
  // 第3章 E2E 验证：5 个 mustHappen major issue 全部为误报（节拍已在文中落地，仅措辞不同）。
  // LLM plot-reviewer 独立检查节拍遗漏，比确定性 bigram 匹配更准确，且能识别文学化表达。
  // forbidden 检查保留（blocker 级，forbidden 触发是真实阻断）。
  const targetWords = params.blueprint?.targetWords ?? 0;
  const targetRatio = targetWords > 0 ? wordCount / targetWords : 1;
  if (wordCount <= 1000) {
    issues.push(issue({
      dimension: "plot",
      severity: "blocker",
      title: "正文不足最低篇幅",
      description: `当前约 ${wordCount} 字；完整章节须超过 1000 字。参考目标 ${targetWords || "未设置"} 字不参与通过判定。`,
      rule: "chapter.minimum-length",
      suggestion: "只补足完成本章叙事功能所必需的场景、人物体验、关系过程或行动后果，不得为接近参考目标而凑篇幅。",
    }));
  }
  if (blocks.length >= 6 && paragraphVariation < 0.18) issues.push(issue({ dimension: "specificity", severity: "warning", title: "段落节奏过于均匀", description: "段落长度变化很小，可能产生模型化节奏。", rule: "style.paragraph-variation", suggestion: "按动作速度和情绪停顿重新划分段落，而非机械打散。" }));
  if (totalChars > 0 && templateHits / totalChars * 1000 > 2) issues.push(issue({ dimension: "specificity", severity: "warning", title: "模板化表达偏多", description: `检测到 ${templateHits} 处常见模板表达。`, rule: "style.template-density", suggestion: "结合人物身体状态、环境和具体目标替换重复动作。" }));
  const openings = blocks.map((block) => block.slice(0, 8));
  for (let index = 2; index < openings.length; index += 1) {
    const starts = openings.slice(index - 2, index + 1).map((value) => value.match(/^[\u3400-\u9fff]{2,4}/)?.[0]);
    if (starts[0] && starts.every((value) => value === starts[0])) {
      issues.push(issue({ dimension: "specificity", severity: "warning", title: "连续段落使用相同起句", description: `连续段落都以“${starts[0]}”开头。`, paragraph: index + 1, rule: "style.repeated-openings", suggestion: "从环境变化、动作结果或对白反应切入其中一段。" }));
      break;
    }
  }

  for (const word of EMPHASIS_WORDS) {
    const hits = countOccurrences(text, word);
    if (hits > 2) issues.push(issue({ dimension: "specificity", severity: "warning", title: "强调词贬值", description: `“${word}”出现 ${hits} 次，超过单章 2 次上限，强调效果贬值。`, rule: "style.emphasis-devaluation", suggestion: "用具体事件呈现认知转变，或替换为不同表达，删除多余的强调。" }));
  }
  for (const phrase of EMOTION_DIRECT_WORDS) {
    if (text.includes(phrase)) issues.push(issue({ dimension: "sceneEmbodiment", severity: "warning", title: "情绪直说", description: `检测到“${phrase}”，情绪被直接宣告而非通过行动或意象承载。`, excerpt: phrase, rule: "style.emotion-direct", suggestion: "用一个反常动作、环境意象变化或没说完的话来承载该情绪。" }));
  }
  let shortSentenceStreaks = 0;
  let shortSentenceParagraphs: number[] = [];
  const shortSentenceRanges: Array<{ start: number; end: number }> = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    // 对白的短促轮次是人物交流节奏，不属于叙事短句 tic；带说话标签的混合段也应隔断序列。
    if (isDialogueOnlyParagraph(block) || /[“「『][^”」』]+[”」』]/.test(block)) {
      shortSentenceParagraphs = [];
      continue;
    }
    const sentences = block.split(/[。！？\n]/).map((s) => s.trim()).filter(Boolean);
    for (const s of sentences) {
      // R5: 阈值从 ≤6 放宽到 ≤10，覆盖"里面没有尸体。""也没有打斗痕迹。"等 7-10 字短句排比
      if (s.length > 0 && s.length <= 10) shortSentenceParagraphs.push(blockIndex + 1);
      else shortSentenceParagraphs = [];
      if (shortSentenceParagraphs.length >= 3) {
        shortSentenceStreaks += 1;
        shortSentenceRanges.push({ start: Math.min(...shortSentenceParagraphs), end: Math.max(...shortSentenceParagraphs) });
        shortSentenceParagraphs = [];
      }
    }
  }
  if (shortSentenceStreaks > 2) issues.push(issue({ dimension: "specificity", severity: shortSentenceStreaks > 5 ? "major" : "warning", title: "短句排比过多", description: `检测到 ${shortSentenceStreaks} 处连续短句排比，超过单章 2 处上限。`, revisionRanges: shortSentenceRanges, rule: "style.short-sentence-tic", suggestion: "将部分排比融入完整句式，仅在极度紧张或决断瞬间保留短句。" }));
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

  // 隐式 POV 越界检测：用"像/仿佛+心理动词"替视角人物判断他人内心。
  // 这类句子表面是比喻，实质是作者借视角人物之口宣告对他人心理的总结。
  const implicitPovBreachHits: string[] = [];
  for (const pattern of IMPLICIT_POV_BREACH_PATTERNS) {
    const matches = text.match(pattern) ?? [];
    matches.forEach((m) => implicitPovBreachHits.push(m));
  }
  if (implicitPovBreachHits.length > 0) {
    // 定位首次出现的段落用于 revisionRanges
    const firstHit = implicitPovBreachHits[0];
    let hitParagraph = 0;
    for (let i = 0; i < blocks.length; i += 1) {
      if (IMPLICIT_POV_BREACH_PATTERNS.some((p) => p.test(blocks[i]))) { hitParagraph = i + 1; break; }
    }
    issues.push(issue({
      dimension: "continuity",
      severity: implicitPovBreachHits.length >= 2 ? "major" : "warning",
      title: "隐式 POV 越界",
      description: `检测到 ${implicitPovBreachHits.length} 处用比喻句替视角人物判断他人心理（如"${firstHit}"）。这类句子表面是意象，实质是作者借视角人物之口宣告对他人内心的总结。`,
      excerpt: firstHit,
      paragraph: hitParagraph || undefined,
      revisionRanges: hitParagraph ? [{ start: hitParagraph, end: hitParagraph }] : undefined,
      rule: "pov.implicit-breach",
      suggestion: `把他人心理判断改写为视角人物可观察的具体动作——如把"像忽然换了一个人"改为"入殿后他只是低头净手，指节未曾发颤"。`,
    }));
  }

  // 场景后追加总结检测：段落以具体动作/对白开始，却以抽象结论收尾。
  // 这类段落前半是现场，后半是作者旁白，破坏第三人称限知的观察距离。
  const sceneSummaryTails: number[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!ACTION_MARKER_RE.test(block)) continue;
    // 检查段落最后一句是否以抽象总结收尾
    const lastSentence = block.split(/[。！？]/).filter(Boolean).slice(-1)[0] ?? "";
    if (SCENE_SUMMARY_TAIL_PATTERNS.some((p) => p.test(lastSentence))) {
      sceneSummaryTails.push(i + 1);
    }
  }
  if (sceneSummaryTails.length >= 1) {
    issues.push(issue({
      dimension: "sceneEmbodiment",
      severity: sceneSummaryTails.length >= 2 ? "major" : "warning",
      title: "场景后追加总结",
      description: `检测到 ${sceneSummaryTails.length} 处段落在具体场景之后追加抽象总结（段 ${sceneSummaryTails.join("、")}）。场景已通过动作呈现人物状态，又追加结论形成二次解释，降低现场感。`,
      revisionRanges: sceneSummaryTails.map((p) => ({ start: p, end: p })),
      rule: "style.scene-summary-tail",
      suggestion: "删除段尾的抽象评价，让具体检查、记录或观察动作本身表现人物状态。参考雪中范式：徐骁屠城从不正面总结，通过他人反应呈现。",
    }));
  }

  // 章尾钩子常由“压力出现 -> 人物暂不回应 -> 意象收束”跨段完成，不能只检查最后一个意象段。
  const OPEN_HOOK_MARKERS = ["？", "……", "然而", "可是", "只是", "尚未", "还没", "且看", "即将", "将要", "忽然", "突然", "蓦地", "陡然", "倏地", "身影", "转身", "停步", "回头", "没说", "没动", "没走", "但", "却", "竟"];
  const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : "";
  const endingWindow = blocks.slice(-3).join("\n").slice(-800);
  const pendingDecisionSignal = /(?:没有|未|尚未|还没)[^。！？]{0,16}(?:回答|答应|拒绝|决定|选择|行动|动身|离开|交出|打开|喝下)|(?:等着|等待|等候)[^。！？]{0,12}(?:回答|回话|决定|选择)|(?:是否|可愿|要不要|去不去)/.test(endingWindow);
  const lastBlockHasOpenSignal = OPEN_HOOK_MARKERS.some((marker) => endingWindow.includes(marker)) || pendingDecisionSignal;
  if (totalChars >= 600 && lastBlock.length > 0 && !lastBlockHasOpenSignal) {
    issues.push(issue({
      dimension: "hookPayoff",
      severity: "warning",
      title: "章尾可能缺乏开放压力",
      description: "末段未出现问号、转折词、未行动信号或新信息压力，可能停留在情感余韵的封闭画面。",
      rule: "style.chapter-ending-hook",
      suggestion: "在末段加入指向未解信息、未行动方向或新压力的细节，让读者产生“接下来会发生什么”的期待。可参考章尾钩子十型：信息遮断/关键信息凸显/倒计时/抉择时刻/立场反转/危险前置/目标失效/关系破裂/动机揭露/认知反转。",
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
      wordCount,
      targetWords,
      targetRatio: Number(targetRatio.toFixed(3)),
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
  const rangesOverlap = (existing.revisionRanges ?? []).some((left) =>
    (candidate.revisionRanges ?? []).some((right) => left.start <= right.end && right.start <= left.end));
  if (existing.dimension === candidate.dimension && rangesOverlap) return true;
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
    for (const found of reviewer.issues) {
      const claim = `${found.title} ${found.description}`;
      const conditionalClaimWithoutEvidence = Boolean(found.excerpt)
        && CONDITIONAL_INTERPRETATION_RE.test(claim)
        && !INTERNAL_STATE_EVIDENCE_RE.test(found.excerpt ?? "");
      const normalized = conditionalClaimWithoutEvidence
        ? { ...found, severity: "warning" as const }
        : found.severity === "warning" && REVIEW_WARNING_MAJOR_PATTERN.test(claim)
        ? { ...found, severity: "major" as const }
        : found;
      issues = deduplicateReviewerIssues(issues, normalized);
    }
  }
  const blockerCount = issues.filter((item) => item.severity === "blocker").length;
  const majorCount = issues.filter((item) => item.severity === "major").length;
  const reviewerCoveragePassed = !issues.some((item) => item.rule === "reviewer.unavailable");
  const weightedScore = Number(DIMENSIONS.reduce((sum, dimension) => sum + scores[dimension] * WEIGHTS[dimension], 0).toFixed(2));
  const coreFloorPassed = DIMENSIONS.every((dimension) => scores[dimension] >= 3);
  return { scores, issues, blockerCount, weightedScore, passed: blockerCount === 0 && majorCount === 0 && reviewerCoveragePassed && coreFloorPassed && weightedScore >= params.threshold, reviewerRoles };
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
    scoringVersion: QUALITY_SCORING_VERSION,
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
  plot: "叙事组织", characterVoice: "人物声音", sceneEmbodiment: "场景具象", dialogue: "对白", specificity: "语言具体性", hookPayoff: "悬念与余韵", continuity: "连续性",
};

export function qualityDimensionLabel(dimension: string) {
  if (dimension === "pacing") return "节奏";
  return QUALITY_DIMENSION_LABELS[dimension as QualityDimension] ?? dimension;
}
