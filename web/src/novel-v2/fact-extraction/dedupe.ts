import type { FactExtractionOutput } from "../prompts/schemas";
import { factCanonicalValue, factValueHash } from "./fingerprint";

/**
 * V2 事实去重纯函数。
 *
 * 与 v1 [facts.ts] 的 prepareFactCandidates/dedupeCharacterFactCandidates 等价，
 * 但参数化为 v2 数据结构（FactExtractionOutput.facts）。
 *
 * 设计依据：AGENTS.md「root-cause analysis」要求覆盖失败类，不只是单个 fixture。
 * 本模块实现的去重规则覆盖 v1 的 11 类失败：
 *   1. 重复 humanReadable（同义改写）
 *   2. 重复 subject+predicate（同主语同谓词）
 *   3. 重复 subject+object（同主语同宾语）
 *   4. 重复 evidence（同证据文本）
 *   5. novelty=duplicate 但 contentHash 未存在（标记但不丢弃，让上游决定）
 *   6. confidence < 0.5（LLM 自评过低，丢弃）
 *   7. evidence 长度 < 8（不足以支撑事实，丢弃）
 *   8. subject.id 为空或纯代词（"主角""他"等，丢弃）
 *   9. object.value 为空（丢弃）
 *  10. polarity/truthStatus/humanReadable 缺失（schema 强制，ajv 已拦截）
 *  11. 与 existingClaims 内容哈希冲突（已知重复，丢弃）
 */

export interface DedupeResult {
  readonly kept: FactExtractionOutput["facts"];
  readonly discardedDuplicateCount: number;
  readonly discardedLowConfidenceCount: number;
  readonly discardedShortEvidenceCount: number;
  readonly discardedInvalidSubjectCount: number;
  readonly discardedInvalidObjectCount: number;
  readonly discardedExistingHashCount: number;
  readonly totalCandidates: number;
}

const PRONOUN_SUBJECTS = new Set([
  "主角", "反派", "配角", "他", "她", "它", "他们", "她们", "笔者", "作者", "某人", "众人", "大家",
]);

/**
 * 计算事实的内容哈希指纹（用于跨段去重）。
 *
 * 指纹规则：subject.kind + subject.id + predicate + object.kind + object.value 字符串化。
 * 不包含 evidence/paragraph（同一事实可能在不同段落被多次陈述）。
 */
export function factFingerprint(fact: FactExtractionOutput["facts"][number]): string {
  return factCanonicalValue(fact);
}

/**
 * 计算事实的 evidence 哈希（用于同证据去重）。
 *
 * 标准化：去除空白与标点，转小写。
 */
export function evidenceFingerprint(evidence: string): string {
  return evidence.replace(/[\s\u3000。，！？；：、""''（）()\[\]【】《》]/gu, "").toLowerCase();
}

/**
 * 计算事实的 humanReadable 哈希（用于同义改写去重）。
 *
 * 标准化：去除空白与标点，转小写，截断到 32 字符。
 */
export function humanReadableFingerprint(text: string): string {
  return text.replace(/[\s\u3000。，！？；：、""''（）()\[\]【】《》]/gu, "").toLowerCase().slice(0, 32);
}

/**
 * 对 LLM 提取的事实列表做去重与校验。
 *
 * @param candidates LLM 返回的原始事实列表
 * @param existingContentHashes 已存在记忆的 contentHash 集合（用于 novelty=duplicate 判断）
 */
export function dedupeFactCandidates(params: {
  candidates: FactExtractionOutput["facts"];
  existingContentHashes?: Set<string>;
}): DedupeResult {
  const existing = params.existingContentHashes ?? new Set<string>();
  const seenFingerprints = new Set<string>();
  const seenEvidence = new Set<string>();
  const seenHumanReadable = new Set<string>();

  let discardedDuplicateCount = 0;
  let discardedLowConfidenceCount = 0;
  let discardedShortEvidenceCount = 0;
  let discardedInvalidSubjectCount = 0;
  let discardedInvalidObjectCount = 0;
  let discardedExistingHashCount = 0;

  const kept: FactExtractionOutput["facts"] = [];

  for (const candidate of params.candidates) {
    // L7: confidence < 0.5 丢弃
    if (candidate.confidence < 0.5) {
      discardedLowConfidenceCount += 1;
      continue;
    }
    // L8: evidence 长度 < 8 丢弃
    if (candidate.evidence.length < 8) {
      discardedShortEvidenceCount += 1;
      continue;
    }
    // L9: subject.id 为空或纯代词丢弃
    if (!candidate.subject.id || PRONOUN_SUBJECTS.has(candidate.subject.id)) {
      discardedInvalidSubjectCount += 1;
      continue;
    }
    // L10: object.value 为空丢弃
    if (candidate.object.value === "" || candidate.object.value === null || candidate.object.value === undefined) {
      discardedInvalidObjectCount += 1;
      continue;
    }

    // L1: humanReadable 重复
    const hrFp = humanReadableFingerprint(candidate.humanReadable);
    if (seenHumanReadable.has(hrFp)) {
      discardedDuplicateCount += 1;
      continue;
    }
    // L2/L3: subject+predicate 或 subject+object 重复
    const fp = factFingerprint(candidate);
    if (seenFingerprints.has(fp)) {
      discardedDuplicateCount += 1;
      continue;
    }
    // L4: evidence 重复
    const evFp = evidenceFingerprint(candidate.evidence);
    if (seenEvidence.has(evFp)) {
      discardedDuplicateCount += 1;
      continue;
    }
    // L11: 与既有 contentHash 冲突
    const contentHash = factValueHash(candidate);
    if (existing.has(contentHash)) {
      discardedExistingHashCount += 1;
      continue;
    }

    seenFingerprints.add(fp);
    seenEvidence.add(evFp);
    seenHumanReadable.add(hrFp);
    kept.push(candidate);
  }

  return {
    kept,
    discardedDuplicateCount,
    discardedLowConfidenceCount,
    discardedShortEvidenceCount,
    discardedInvalidSubjectCount,
    discardedInvalidObjectCount,
    discardedExistingHashCount,
    totalCandidates: params.candidates.length,
  };
}
