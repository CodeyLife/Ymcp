import { randomUUID } from "node:crypto";
import type { Artifact, Review, RuntimeLearningAssessmentV2 } from "./protocol";
import type { ModelGateway, ModelUsage } from "./model-gateway";

type LearningSource = RuntimeLearningAssessmentV2["source"];

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`learning.${field} 不能为空`);
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredTextList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`learning.${field} 必须是非空字符串数组`);
  }
  return [...new Set(value.map((item) => String(item).trim()))];
}

export function blockingReviewIssues(reviews: Review[]) {
  return reviews.flatMap((review) => review.issues
    .filter((issue) => issue.severity === "blocker" || issue.severity === "major")
    .map((issue) => ({ ...issue, reviewId: review.id, reviewer: review.identity, verdict: review.verdict })));
}

export function parseRuntimeLearningAssessmentV2(value: unknown, base: {
  id?: string;
  projectId: string;
  source: LearningSource;
  createdAt?: number;
}): RuntimeLearningAssessmentV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("learning assessment 必须是对象");
  const raw = value as Record<string, unknown>;
  if (raw.conclusion === "no-shared-learning") {
    if (raw.candidate !== undefined) throw new Error("no-shared-learning 不能携带 candidate");
    return {
      id: base.id ?? `learning:${randomUUID()}`,
      projectId: base.projectId,
      source: base.source,
      conclusion: "no-shared-learning",
      symptom: optionalText(raw.symptom),
      failingLayer: optionalText(raw.failingLayer),
      createdAt: base.createdAt ?? Date.now(),
    };
  }

  if (raw.conclusion !== "propose-improvement") throw new Error("learning.conclusion 无效");
  const underlyingMechanism = requiredText(raw.underlyingMechanism, "underlyingMechanism");
  const affectedInputClass = requiredText(raw.affectedInputClass, "affectedInputClass");
  const symptom = requiredText(raw.symptom, "symptom");
  const failingLayer = requiredText(raw.failingLayer, "failingLayer");
  const boundaries = requiredText(raw.boundaries, "boundaries");
  const regressionRisks = requiredTextList(raw.regressionRisks, "regressionRisks");
  if (!raw.candidate || typeof raw.candidate !== "object" || Array.isArray(raw.candidate)) throw new Error("propose-improvement 必须携带 candidate");
  const candidate = raw.candidate as Record<string, unknown>;
  const targetKind = candidate.targetKind;
  if (targetKind !== "skill" && targetKind !== "system-prompt" && targetKind !== "workflow") throw new Error("learning.candidate.targetKind 无效");
  const afterText = requiredText(candidate.afterText, "candidate.afterText");
  if (afterText.length < 100) throw new Error("learning.candidate.afterText 过短，必须是完整规则文本而非一句补丁");
  return {
    id: base.id ?? `learning:${randomUUID()}`,
    projectId: base.projectId,
    source: base.source,
    conclusion: "propose-improvement",
    symptom,
    failingLayer,
    underlyingMechanism,
    affectedInputClass,
    boundaries,
    regressionRisks,
    candidate: {
      targetKind,
      targetId: requiredText(candidate.targetId, "candidate.targetId"),
      rationale: requiredText(candidate.rationale, "candidate.rationale"),
      afterText,
    },
    createdAt: base.createdAt ?? Date.now(),
  };
}

export const runtimeLearningAssessmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["conclusion"],
  properties: {
    conclusion: { enum: ["no-shared-learning", "propose-improvement"] },
    symptom: { type: "string" },
    failingLayer: { type: "string" },
    underlyingMechanism: { type: "string" },
    affectedInputClass: { type: "string" },
    boundaries: { type: "string" },
    regressionRisks: { type: "array", items: { type: "string" } },
    candidate: {
      type: "object",
      additionalProperties: false,
      required: ["targetKind", "targetId", "rationale", "afterText"],
      properties: {
        targetKind: { enum: ["skill", "system-prompt", "workflow"] },
        targetId: { type: "string" },
        rationale: { type: "string" },
        afterText: { type: "string" },
      },
    },
  },
} as const;

export function buildRuntimeLearningPrompt(input: {
  artifact: Artifact;
  reviews: Review[];
}): string {
  const issues = blockingReviewIssues(input.reviews)
    .map((issue, index) => `${index + 1}. [${issue.reviewer}/${issue.reviewId}] severity=${issue.severity} verdict=${issue.verdict}
标题：${issue.title}
证据：${issue.evidence}`)
    .join("\n\n");
  return `# V2 Runtime Learning Assessment

你要判断审核发现的 blocker/major 是否暴露了可迁移到一类输入的共享缺陷。

## 证据
${issues || "无 blocker/major"}

## 决策规则
- 没有 blocker/major，或只是单次正文执行偏差、项目特有事实、审稿误判，返回 no-shared-learning。
- 只有当问题来自可复用的 skill、system-prompt 或 workflow 规则缺陷时，返回 propose-improvement。
- propose-improvement 必须填写 symptom、failingLayer、underlyingMechanism、affectedInputClass、boundaries、regressionRisks。
- candidate.afterText 必须是完整规则文本，先写通用原则与决策边界，再写验证方式；不得只写一句补丁。
- 不要把具体书名、人物名、章节号、固定句子或本次样例当成规则。

输出 JSON，必须匹配 schema。`;
}

export async function assessRuntimeLearningWithModel(input: {
  projectId: string;
  workflowId: string;
  artifact: Artifact;
  reviews: Review[];
  model?: ModelGateway;
  now?: number;
}): Promise<{ assessment: RuntimeLearningAssessmentV2; usage?: ModelUsage; validationError?: string }> {
  const source: LearningSource = {
    workflowId: input.workflowId,
    artifactId: input.artifact.id,
    reviewIds: input.reviews.map((review) => review.id),
    fingerprint: input.artifact.fingerprint,
  };
  const createdAt = input.now ?? Date.now();
  const fallback = (extra?: Partial<RuntimeLearningAssessmentV2>): RuntimeLearningAssessmentV2 => ({
    id: `learning:${input.artifact.id}`,
    projectId: input.projectId,
    source,
    conclusion: "no-shared-learning",
    createdAt,
    ...extra,
  });

  const blocking = blockingReviewIssues(input.reviews);
  if (blocking.length === 0) return { assessment: fallback() };
  if (!input.model) {
    return {
      assessment: fallback({
        symptom: blocking.map((issue) => issue.title).join("；").slice(0, 500),
        failingLayer: "learning-assessment",
      }),
      validationError: "模型网关未配置，不能把 blocker/major 硬编码为 propose-improvement",
    };
  }

  try {
    const result = await input.model.generateStructured<Record<string, unknown>>({
      model: "novel-learning-assessor",
      system: "你是长篇小说 Runtime 的学习闭环审计员，只在能说明底层机制和影响输入类时提出可复用规则改进。",
      prompt: buildRuntimeLearningPrompt({ artifact: input.artifact, reviews: input.reviews }),
      schema: runtimeLearningAssessmentSchema,
    });
    return {
      assessment: parseRuntimeLearningAssessmentV2(result.value, {
        id: `learning:${input.artifact.id}`,
        projectId: input.projectId,
        source,
        createdAt,
      }),
      usage: result.usage,
    };
  } catch (error) {
    return {
      assessment: fallback({
        symptom: blocking.map((issue) => issue.title).join("；").slice(0, 500),
        failingLayer: "learning-assessment",
      }),
      validationError: error instanceof Error ? error.message : "learning assessment 校验失败",
    };
  }
}
