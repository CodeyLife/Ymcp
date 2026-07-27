import type { LearningAssessment } from "./types";

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`learning.${field} 不能为空`);
  return value.trim();
}

function requiredTextList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`learning.proposal.${field} 必须是非空字符串数组`);
  }
  return [...new Set(value.map((item) => String(item).trim()))];
}

export function parseRuntimeLearningAssessment(value: unknown, options: { requireTargetBaseline?: boolean } = {}): LearningAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("外部审核必须记录本轮经验判断");
  const raw = value as Record<string, unknown>;
  const summary = requiredText(raw.summary, "summary");
  if (raw.conclusion === "no-shared-learning") {
    if (raw.proposal !== undefined) throw new Error("无需沉淀经验时不能携带改进候选");
    return { conclusion: "no-shared-learning", summary };
  }
  if (raw.conclusion !== "propose-improvement") throw new Error("learning.conclusion 无效");
  const affectedInputClass = requiredText(raw.affectedInputClass, "affectedInputClass");
  const underlyingMechanism = requiredText(raw.underlyingMechanism, "underlyingMechanism");
  if (!raw.proposal || typeof raw.proposal !== "object" || Array.isArray(raw.proposal)) throw new Error("可沉淀经验必须携带完整改进候选");
  const proposal = raw.proposal as Record<string, unknown>;
  const targetKind = proposal.targetKind;
  if (targetKind !== "skill" && targetKind !== "system-prompt") throw new Error("learning.proposal.targetKind 无效");
  const afterText = requiredText(proposal.afterText, "proposal.afterText");
  if (afterText.length < 100) throw new Error("learning.proposal.afterText 过短");
  const targetVersion = typeof proposal.targetVersion === "string" && proposal.targetVersion.trim() ? proposal.targetVersion.trim() : undefined;
  const targetContentFingerprint = typeof proposal.targetContentFingerprint === "string" && /^[a-f0-9]{64}$/i.test(proposal.targetContentFingerprint) ? proposal.targetContentFingerprint.toLowerCase() : undefined;
  if (options.requireTargetBaseline && (!targetVersion || !targetContentFingerprint)) throw new Error("learning.proposal 必须携带审核时 targetVersion 与 targetContentFingerprint");
  if ((targetVersion && !targetContentFingerprint) || (!targetVersion && targetContentFingerprint)) throw new Error("learning.proposal 的 targetVersion 与 targetContentFingerprint 必须同时提供");
  return { conclusion: "propose-improvement", summary, affectedInputClass, underlyingMechanism, proposal: { targetKind, targetId: requiredText(proposal.targetId, "proposal.targetId"), targetVersion, targetContentFingerprint, afterText, rationale: requiredText(proposal.rationale, "proposal.rationale"), observedSymptom: requiredText(proposal.observedSymptom, "proposal.observedSymptom"), failingLayer: requiredText(proposal.failingLayer, "proposal.failingLayer"), intendedBenefits: requiredTextList(proposal.intendedBenefits, "intendedBenefits"), boundaries: requiredTextList(proposal.boundaries, "boundaries"), nonGoals: requiredTextList(proposal.nonGoals, "nonGoals"), regressionRisks: requiredTextList(proposal.regressionRisks, "regressionRisks") } };
}
