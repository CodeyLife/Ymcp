import { randomUUID } from "node:crypto";
import type { Artifact, Review, RuntimeLearningAssessmentV2 } from "./protocol";
import type { ModelGateway, ModelUsage } from "./model-gateway";
import { ExternalMcpRequiredError, type ModelRoutingSnapshot } from "./model-routing";

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

/**
 * P0-B3 修复（2026-07-27）：learning 通路改为汇总所有 issue（含 warning），
 * 不再只过滤 blocker/major。
 *
 * 设计依据：AGENTS.md「review-stage → learning 通路：review/commit 后必须汇总 issue 模式为
 * RuntimeLearningAssessment，不允许审核结果只写入 qualityReport 而不反馈到 learning」——
 * warning 只写入 qualityReport 而被 severity 过滤挡在 learning 门外，违反契约。
 *
 * 典型场景：reader-reviewer 报 chapter.payoff-drought（warning），表示连续多章无爽点。
 * 旧逻辑：blocking.length === 0 → 直接返回 no-shared-learning，不调 LLM，craft rule candidate
 * 永远不会为爽点干旱创建。新逻辑：warning 进入 evidence，LLM 可判断是否暴露可迁移的共享缺陷。
 *
 * 保留 severity 标记让 LLM 区分严重度，但不做硬过滤。
 * LLM 仍应优先关注 blocker/major，warning 只有在形成持续模式时才 propose-improvement。
 */
export function reviewIssuesForLearning(reviews: Review[]) {
  return reviews.flatMap((review) => review.issues
    .map((issue) => ({ ...issue, reviewId: review.id, reviewer: review.identity, verdict: review.verdict })));
}

/**
 * 兼容旧调用方：保留 blockingReviewIssues 名称，但内部改为返回所有 issue。
 * 新代码应直接调用 reviewIssuesForLearning。
 */
export function blockingReviewIssues(reviews: Review[]) {
  return reviewIssuesForLearning(reviews);
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
  if (targetKind !== "skill" && targetKind !== "system-prompt") throw new Error("learning.candidate.targetKind 无效");
  const afterText = requiredText(candidate.afterText, "candidate.afterText");
  if (afterText.length < 100) throw new Error("learning.candidate.afterText 过短，必须是完整规则文本而非一句补丁");
  // P0-C1: 解析 applicableGenres（可选，仅 targetKind="skill" 时有意义）
  let applicableGenres: string[] | undefined;
  if (Array.isArray(candidate.applicableGenres)) {
    applicableGenres = candidate.applicableGenres
      .filter((g): g is string => typeof g === "string" && g.trim().length > 0)
      .map((g) => g.trim());
    if (applicableGenres.length === 0) applicableGenres = undefined;
  }
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
      applicableGenres,
    },
    createdAt: base.createdAt ?? Date.now(),
  };
}

/**
 * P1-F1 修复（2026-07-27）：schema 强制 propose-improvement 时 mechanism 字段必填。
 *
 * 设计依据：AGENTS.md「learning.underlyingMechanism/affectedInputClass 在
 * conclusion=propose-improvement 时必填」——旧 schema 的 required 只有 ["conclusion"]，
 * LLM 可能返回不完整结构触发 parser 抛错 → fallback 到 no-shared-learning，丢失有效的
 * propose-improvement 信号。JSON Schema 的 anyOf 让 conclusion=no-shared-learning 时
 * mechanism 字段可选，conclusion=propose-improvement 时必填。
 */
export const runtimeLearningAssessmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["conclusion"],
  properties: {
    conclusion: { enum: ["no-shared-learning", "propose-improvement"] },
    symptom: { type: "string" },
    failingLayer: { type: "string" },
    underlyingMechanism: { type: "string", minLength: 10 },
    affectedInputClass: { type: "string", minLength: 5 },
    boundaries: { type: "string", minLength: 10 },
    regressionRisks: { type: "array", items: { type: "string", minLength: 5 }, minItems: 1 },
    candidate: {
      type: "object",
      additionalProperties: false,
      required: ["targetKind", "targetId", "rationale", "afterText"],
      properties: {
        targetKind: { enum: ["skill", "system-prompt"] },
        targetId: { type: "string" },
        rationale: { type: "string", minLength: 10 },
        afterText: { type: "string", minLength: 100 },
        // P0-C1: 题材适用性（可选，仅 targetKind="skill" 时有意义）
        applicableGenres: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "题材适用性（仅 targetKind=skill 时有意义）。留空数组表示题材无关；非空数组表示仅适用于列出的 genre（如 ['玄幻','仙侠']）。不内置固定题材枚举。",
        },
      },
    },
  },
  anyOf: [
    {
      properties: { conclusion: { const: "no-shared-learning" } },
      required: ["conclusion"],
    },
    {
      properties: { conclusion: { const: "propose-improvement" } },
      required: ["conclusion", "symptom", "failingLayer", "underlyingMechanism", "affectedInputClass", "boundaries", "regressionRisks", "candidate"],
    },
  ],
} as const;

export function buildRuntimeLearningPrompt(input: {
  artifact: Artifact;
  reviews: Review[];
  /**
   * 数据库中实际存在的 skill 列表，注入 prompt 让 LLM 使用真实 skill ID。
   * 设计依据：AGENTS.md「root-cause analysis」——原 prompt 未提供可用 skill 列表，
   * LLM 自行编造 skill ID（如 "drafting"），导致 createCraftRuleCandidate 找不到
   * skill definition 而抛错。注入实际列表从源头消除 ID 不匹配。
   */
  availableSkills?: Array<{ skillId: string; capabilities: string[] }>;
}): string {
  // P0-B3: 汇总所有 issue（含 warning），让 LLM 判断是否形成可迁移的共享缺陷模式
  const issues = reviewIssuesForLearning(input.reviews)
    .map((issue, index) => `${index + 1}. [${issue.reviewer}/${issue.reviewId}] severity=${issue.severity} verdict=${issue.verdict}
标题：${issue.title}
证据：${issue.evidence}`)
    .join("\n\n");
  const skillList = input.availableSkills?.length
    ? input.availableSkills.map((s) => `- ${s.skillId} (capabilities: ${s.capabilities.join(", ")})`).join("\n")
    : "- （skill_definitions 表为空，targetKind=skill 时无法创建 candidate，请改用 system-prompt 或返回 no-shared-learning）";
  return `# V2 Runtime Learning Assessment

你要判断审核发现的问题（含 blocker/major/warning）是否暴露了可迁移到一类输入的共享缺陷。

## 证据
${issues || "无审核问题"}

## 可用改进目标
targetKind=skill 时，targetId 必须从以下 skill_definitions 中选择（不可自行编造 ID）：
${skillList}

targetKind=system-prompt 时，targetId 格式为 "<projectId>:<templateId>"，需对应 prompt_templates 表中的记录。

## 决策规则
- blocker/major 优先评估：如果是单次正文执行偏差、项目特有事实、审稿误判，返回 no-shared-learning。
- warning 只有在形成持续模式时才 propose-improvement（如多个 warning 指向同一底层机制）。
  典型场景：reader-reviewer 报 chapter.payoff-drought（warning），表示连续多章无爽点——
  这可能是 skill/prompt 未引导 drafting 安排爽点的共享缺陷，值得 propose-improvement。
- 只有当问题来自可复用的 skill、system-prompt 或 workflow 规则缺陷时，返回 propose-improvement。
- propose-improvement 必须填写 symptom、failingLayer、underlyingMechanism、affectedInputClass、boundaries、regressionRisks。
  - underlyingMechanism：底层机制（如"drafting prompt 未注入前章爽点统计，writer 无法感知干旱"），不要只复述症状。
  - affectedInputClass：受影响的输入类别（如"长篇中后段章节，铺陈/相处章连续出现时"）。
- candidate.afterText 必须是完整规则文本，先写通用原则与决策边界，再写验证方式；不得只写一句补丁。
- candidate.applicableGenres（仅 targetKind=skill 时有意义）：若改进只适用于特定题材，填写题材标签数组（如 ["玄幻","仙侠"]）；若题材无关则留空数组。不内置固定题材枚举，由你根据 affectedInputClass 推断。
- 不要把具体书名、人物名、章节号、固定句子或本次样例当成规则。

输出 JSON，必须匹配 schema。conclusion=propose-improvement 时所有 mechanism 字段必填。`;
}

export async function assessRuntimeLearningWithModel(input: {
  projectId: string;
  workflowId: string;
  artifact: Artifact;
  reviews: Review[];
  /** 模型网关；未配置时走 fallback 返回 no-shared-learning 并附 validationError。 */
  model?: ModelGateway;
  routingSnapshot?: ModelRoutingSnapshot;
  candidateStartIndex?: number;
  now?: number;
  /** 透传到 buildRuntimeLearningPrompt，让 LLM 使用真实 skill ID */
  availableSkills?: Array<{ skillId: string; capabilities: string[] }>;
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

  const issues = reviewIssuesForLearning(input.reviews);
  // P0-B3: 不再因无 blocker/major 直接短路；只有完全无 issue 时才返回 no-shared-learning。
  // warning-only 模式也调用 LLM，让其判断是否形成可迁移的共享缺陷模式。
  if (issues.length === 0) return { assessment: fallback() };
  try {
    if (!input.model) throw new Error("模型网关未配置");
    const result = await input.model.generateStructured<Record<string, unknown>>({
      purpose: "learning.assess",
      system: "你是长篇小说 Runtime 的学习闭环审计员，只在能说明底层机制和影响输入类时提出可复用规则改进。",
      prompt: buildRuntimeLearningPrompt({ artifact: input.artifact, reviews: input.reviews, availableSkills: input.availableSkills }),
      schema: runtimeLearningAssessmentSchema,
      routingSnapshot: input.routingSnapshot,
      candidateStartIndex: input.candidateStartIndex,
      workflowRunId: input.workflowId,
      taskId: `${input.artifact.taskId}:learning`,
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
    if (error instanceof ExternalMcpRequiredError) throw error;
    return {
      assessment: fallback({
        symptom: issues.map((issue) => issue.title).join("；").slice(0, 500),
        failingLayer: "learning-assessment",
      }),
      validationError: error instanceof Error ? error.message : "learning assessment 校验失败",
    };
  }
}
