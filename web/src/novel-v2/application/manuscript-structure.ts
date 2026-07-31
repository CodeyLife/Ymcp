import { createHash } from "node:crypto";
import type { Artifact, Review, ReviewIssue } from "../protocol";

const RETIRED_STRUCTURAL_RULES = new Set(["manuscript.length"]);

export interface ManuscriptStructuralMetrics {
  characterCount: number;
  paragraphCount: number;
  medianParagraphCharacters: number;
  shortParagraphRatio: number;
  repeatedParagraphCount: number;
  repeatedBlockCount: number;
}

export interface ManuscriptStructuralReport {
  passed: boolean;
  fingerprint: string;
  blockers: ReviewIssue[];
  warnings: ReviewIssue[];
  metrics: ManuscriptStructuralMetrics;
}

export interface InspectManuscriptInput {
  text: string;
  stopReason?: string;
}

function activeStructuralIssues(issues: ReviewIssue[]): ReviewIssue[] {
  return issues.filter((item) => !item.rule || !RETIRED_STRUCTURAL_RULES.has(item.rule));
}

/** Keep persisted reviews from retired validators from affecting current workflows. */
export function normalizeManuscriptStructuralReview(review: Review): Review {
  if (review.role !== "structural-validator") return review;
  const issues = activeStructuralIssues(review.issues);
  if (issues.length === review.issues.length) return review;
  return {
    ...review,
    issues,
    verdict: issues.some((item) => item.severity === "blocker") ? "blocked" : "passed",
  };
}

function novelCharacterCount(value: string): number {
  return [...value].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
}

function normalizeParagraph(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function splitParagraphs(value: string): string[] {
  return value.split(/\n\s*\n/gu).map(normalizeParagraph).filter(Boolean);
}

function issue(severity: ReviewIssue["severity"], title: string, evidence: string, rule: string, paragraph?: number): ReviewIssue {
  return { severity, title, evidence, rule, ...(paragraph ? { paragraph } : {}) };
}

function repeatedBlocks(paragraphs: string[]): Array<{ start: number; duplicateStart: number; length: number; characters: number }> {
  const blocks: Array<{ start: number; duplicateStart: number; length: number; characters: number }> = [];
  for (let left = 0; left < paragraphs.length; left += 1) {
    for (let right = left + 1; right < paragraphs.length; right += 1) {
      let length = 0;
      let characters = 0;
      while (left + length < right && right + length < paragraphs.length && paragraphs[left + length] === paragraphs[right + length]) {
        characters += novelCharacterCount(paragraphs[left + length]);
        length += 1;
      }
      if (length >= 2 && characters >= 120) blocks.push({ start: left, duplicateStart: right, length, characters });
    }
  }
  return blocks.filter((block, index, all) => !all.some((candidate, candidateIndex) => candidateIndex < index
    && candidate.start <= block.start
    && candidate.duplicateStart <= block.duplicateStart
    && candidate.start + candidate.length >= block.start + block.length
    && candidate.duplicateStart + candidate.length >= block.duplicateStart + block.length));
}

export function inspectManuscript(input: InspectManuscriptInput): ManuscriptStructuralReport {
  const text = input.text.trim();
  const paragraphs = splitParagraphs(text);
  const paragraphLengths = paragraphs.map(novelCharacterCount).sort((left, right) => left - right);
  const characterCount = novelCharacterCount(text);
  const blockers: ReviewIssue[] = [];
  const warnings: ReviewIssue[] = [];

  if (!text) blockers.push(issue("blocker", "正文为空", "正文没有任何有效内容", "manuscript.empty"));
  if (/^```|```\s*$/u.test(text) || /^(?:#\s*)?(?:章节正文|输出结果|以下是)/u.test(text)) {
    blockers.push(issue("blocker", "正文包含输出包装", text.slice(0, 120), "manuscript.wrapper"));
  }
  if (input.stopReason && /(?:length|max[_ -]?tokens?|token[_ -]?limit)/iu.test(input.stopReason)) {
    blockers.push(issue("blocker", "正文因输出上限截断", input.stopReason, "manuscript.truncated"));
  }

  const paragraphOccurrences = new Map<string, number[]>();
  paragraphs.forEach((paragraph, index) => {
    const locations = paragraphOccurrences.get(paragraph) ?? [];
    locations.push(index);
    paragraphOccurrences.set(paragraph, locations);
  });
  const longRepeatedParagraphs = [...paragraphOccurrences.entries()].filter(([paragraph, locations]) => novelCharacterCount(paragraph) >= 80 && locations.length > 1);
  for (const [paragraph, locations] of longRepeatedParagraphs) {
    blockers.push(issue("blocker", "长段落重复", `第 ${locations.map((index) => index + 1).join("、")} 段重复：${paragraph.slice(0, 120)}`, "manuscript.repeated-paragraph", locations[1] + 1));
  }

  const blocks = repeatedBlocks(paragraphs);
  for (const block of blocks) {
    blockers.push(issue("blocker", "连续段落块重复", `第 ${block.start + 1}-${block.start + block.length} 段与第 ${block.duplicateStart + 1}-${block.duplicateStart + block.length} 段重复，共 ${block.characters} 个有效字符`, "manuscript.repeated-block", block.duplicateStart + 1));
  }

  const shortParagraphCount = paragraphLengths.filter((length) => length <= 20).length;
  const shortParagraphRatio = paragraphs.length ? shortParagraphCount / paragraphs.length : 0;
  const medianParagraphCharacters = paragraphLengths.length ? paragraphLengths[Math.floor((paragraphLengths.length - 1) / 2)] : 0;
  if (paragraphs.length >= 100 && shortParagraphRatio >= 0.85) {
    warnings.push(issue("warning", "段落结构高度碎片化", `${paragraphs.length} 段中 ${(shortParagraphRatio * 100).toFixed(1)}% 不超过 20 个有效字符，中位数 ${medianParagraphCharacters}`, "manuscript.fragmentation"));
  }

  const metrics: ManuscriptStructuralMetrics = {
    characterCount,
    paragraphCount: paragraphs.length,
    medianParagraphCharacters,
    shortParagraphRatio,
    repeatedParagraphCount: longRepeatedParagraphs.length,
    repeatedBlockCount: blocks.length,
  };
  const fingerprint = createHash("sha256").update(JSON.stringify({ text, blockers, warnings, metrics })).digest("hex");
  return { passed: blockers.length === 0, fingerprint, blockers, warnings, metrics };
}

export function structuralReviewFromReport(projectId: string, artifact: Artifact, report: ManuscriptStructuralReport, createdAt = Date.now()): Review {
  return normalizeManuscriptStructuralReview({
    id: `structural:${artifact.id}:${report.fingerprint.slice(0, 16)}`,
    projectId,
    artifactId: artifact.id,
    reviewerId: "deterministic-manuscript-inspector",
    identity: "internal",
    role: "structural-validator",
    verdict: report.passed ? "passed" : "blocked",
    issues: [...report.blockers, ...report.warnings],
    artifactFingerprint: artifact.fingerprint,
    createdAt,
  });
}
