import { novelDb, recordBase } from "./db";
import type { ChapterBlueprint, NovelAgentRole, QualityDimension, QualityIssue, QualityReport } from "./types";

const DIMENSIONS: QualityDimension[] = ["plot", "characterVoice", "sceneEmbodiment", "dialogue", "pacing", "specificity", "hookPayoff", "continuity"];
const WEIGHTS: Record<QualityDimension, number> = { plot: 0.17, characterVoice: 0.14, sceneEmbodiment: 0.12, dialogue: 0.1, pacing: 0.14, specificity: 0.1, hookPayoff: 0.1, continuity: 0.13 };
const TEMPLATE_EXPRESSIONS = ["眼中闪过", "瞳孔微缩", "嘴角微微上扬", "意味深长", "若有所思", "不由自主", "与此同时", "正因如此"];

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
  const terms = requirement.split(/[，。；、\s]+/).filter((item) => item.length >= 2);
  if (terms.length === 0 || terms.some((term) => text.includes(term))) return true;
  const compact = requirement.replace(/[，。；、\s]/g, "");
  const pairs = Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) => compact.slice(index, index + 2));
  return pairs.length >= 2 && pairs.filter((pair) => text.includes(pair)).length / pairs.length >= 0.65;
}

export function runDeterministicQualityChecks(params: { text: string; blueprint?: ChapterBlueprint }) {
  const text = params.text.trim();
  const blocks = paragraphs(text);
  const issues: QualityIssue[] = [];
  const totalChars = text.replace(/\s/g, "").length;
  const dialogueChars = (text.match(/[“「『][^”」』]+[”」』]/g) ?? []).join("").length;
  const templateHits = TEMPLATE_EXPRESSIONS.reduce((sum, word) => sum + countOccurrences(text, word), 0);
  const paragraphLengths = blocks.map((block) => block.length);
  const paragraphVariation = coefficientOfVariation(paragraphLengths);

  for (const forbidden of params.blueprint?.forbidden ?? []) {
    if (forbidden && containsMeaning(text, forbidden)) issues.push(issue({ dimension: "continuity", severity: "blocker", title: "触发章节禁止事项", description: forbidden, excerpt: forbidden, rule: "chapter-blueprint.forbidden", suggestion: "移除该情节，或先修改并重新批准章节蓝图。" }));
  }
  for (const required of params.blueprint?.mustHappen ?? []) {
    if (required && !containsMeaning(text, required)) issues.push(issue({ dimension: "plot", severity: "blocker", title: "遗漏必须发生的节拍", description: required, rule: "chapter-blueprint.mustHappen", suggestion: "补写能明确落实该节拍的行动与结果。" }));
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
      templateHits,
    },
  };
}

export function aggregateQuality(params: { deterministic: ReturnType<typeof runDeterministicQualityChecks>; reviewers?: ReviewerFinding[]; threshold: number }) {
  const scores = { ...params.deterministic.scores };
  const issues = [...params.deterministic.issues];
  const reviewerRoles: NovelAgentRole[] = [];
  for (const reviewer of params.reviewers ?? []) {
    reviewerRoles.push(reviewer.role);
    for (const [dimension, score] of Object.entries(reviewer.scores) as Array<[QualityDimension, number]>) scores[dimension] = Number(((scores[dimension] + Math.max(0, Math.min(5, score))) / 2).toFixed(2));
    for (const found of reviewer.issues) issues.push({ ...found, id: crypto.randomUUID(), deterministic: false });
  }
  const blockerCount = issues.filter((item) => item.severity === "blocker").length;
  const weightedScore = Number(DIMENSIONS.reduce((sum, dimension) => sum + scores[dimension] * WEIGHTS[dimension], 0).toFixed(2));
  const coreFloorPassed = DIMENSIONS.every((dimension) => scores[dimension] >= 3);
  return { scores, issues, blockerCount, weightedScore, passed: blockerCount === 0 && coreFloorPassed && weightedScore >= params.threshold, reviewerRoles };
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
