import { createHash } from "node:crypto";
import type { Artifact, MemoryClaim } from "../protocol";
import type { ModelGateway } from "../model-gateway";
import type { ModelRoutingSnapshot } from "../model-routing";
import { factExtractionSchema, type FactExtractionOutput } from "../prompts/schemas";
import { buildFactExtractionPrompt } from "./prompt";
import { dedupeFactCandidates } from "./dedupe";
import { classifyFactCandidates } from "./classify";

/**
 * V2 事实提取编排函数。
 *
 * 流程：
 * 1. 用 model.generateStructured 让 LLM 从正文中提取结构化事实
 * 2. 用 dedupeFactCandidates 做去重与校验（11 类失败覆盖）
 * 3. 用 classifyFactCandidates 投影为 MemoryClaim + 风险等级
 * 4. 返回 MemoryClaim 列表（不含 risk，由 recordFactExtraction 决定写入路径）
 *
 * 设计依据：AGENTS.md「reusable contracts over case-specific examples」——
 * 本模块只做编排，去重/分类规则在 dedupe.ts/classify.ts 中独立维护。
 */

export interface ExtractFactsInput {
  projectId: string;
  artifact: Artifact;
  text: string;
  model: ModelGateway;
  existingClaimsDigest?: string;
  /** 已存在记忆的 contentHash 集合（用于 novelty=duplicate 判断） */
  existingContentHashes?: Set<string>;
  /**
   * P0-A1: 按 `${subject.id}|${predicate}` 映射到旧 claim id 列表。
   * 由上游从数据库查询构建，用于 novelty=update 时填充 supersedes 字段。
   * 让 retrieval 层屏蔽被覆盖的旧版本，避免 LLM 看到自相矛盾的事实。
   */
  existingClaimsIndex?: Map<string, string[]>;
  routingSnapshot?: ModelRoutingSnapshot;
  candidateStartIndex?: number;
  workflowRunId?: string;
  taskId?: string;
  /**
   * 可选,激活的 skill bundle(注入到 fact-extraction prompt)。
   *
   * 设计依据:让 v1 迁移的 fact-delta-extraction skill 的 promptSections
   * 真正进入 LLM,而非死载荷。对齐 foundation/draft/review/revise 的 skill 注入。
   */
  skills?: Array<{ skillId: string; promptSections: Partial<Record<string, string>> }>;
}

export interface ExtractFactsResult {
  claims: MemoryClaim[];
  /**
   * Phase 3.1 叙事元素（伏笔/承诺/兑现）。
   *
   * 由 LLM 在 fact-extraction 阶段一并提取，由 activity 层调用
   * repository.recordNarrativeElements 写入对应表。
   * 可能为 undefined（LLM 未返回 narrativeElements 字段时）。
   */
  narrativeElements?: FactExtractionOutput["narrativeElements"];
  /**
   * Phase 3.2 爽点时刻（本章的爽点列表）。
   *
   * 由 activity 层调用 repository.recordPayoffCurve 写入 payoff_curve 表。
   * payoff_type 是通用爽感维度（非金手指/系统流特化）。
   */
  payoffMoments?: FactExtractionOutput["payoffMoments"];
  stats: {
    totalCandidates: number;
    kept: number;
    discardedDuplicate: number;
    discardedLowConfidence: number;
    discardedShortEvidence: number;
    discardedInvalidSubject: number;
    discardedInvalidObject: number;
    discardedExistingHash: number;
  };
}

/**
 * 从章节正文中提取结构化事实并投影为 MemoryClaim 列表。
 *
 * 不写入数据库——数据库写入由 postgres-repository.recordFactExtraction 负责。
 * 本函数只做"提取 + 去重 + 分类"，返回 MemoryClaim 列表给上游。
 */
export async function extractFactsFromText(input: ExtractFactsInput): Promise<MemoryClaim[]> {
  const result = await extractFactsWithStats(input);
  return result.claims;
}

/**
 * 与 extractFactsFromText 等价，但返回详细统计信息（用于日志与监控）。
 */
export async function extractFactsWithStats(input: ExtractFactsInput): Promise<ExtractFactsResult> {
  const prompt = buildFactExtractionPrompt({
    artifact: input.artifact,
    text: input.text,
    existingClaimsDigest: input.existingClaimsDigest,
    skills: input.skills,
  });

  const generated = await input.model.generateStructured<FactExtractionOutput>({
    purpose: "facts.extract",
    system: "你是事实提取 Worker。只输出符合 JSON Schema 的 JSON。只提取正文实际呈现的事实，不提取隐喻、修辞或读者推断。",
    prompt,
    schema: factExtractionSchema as unknown as Record<string, unknown>,
    schemaName: "fact-extraction",
    routingSnapshot: input.routingSnapshot,
    candidateStartIndex: input.candidateStartIndex,
    workflowRunId: input.workflowRunId,
    taskId: input.taskId,
  });

  return projectFactExtractionOutput(input, generated.value);
}

export function projectFactExtractionOutput(input: Omit<ExtractFactsInput, "model">, output: FactExtractionOutput): ExtractFactsResult {
  const deduped = dedupeFactCandidates({
    candidates: output.facts,
    existingContentHashes: input.existingContentHashes,
  });

  // P0-A1: 构建 existingClaimIndex 让 classifyFactCandidates 在 novelty=update 时填充 supersedes
  // 设计依据：AGENTS.md「root-cause analysis」——supersedes 必须按 subject.id+predicate 匹配旧 claim id，
  // 让 retrieval 层屏蔽被覆盖的旧版本，避免 LLM 看到自相矛盾的事实。
  const existingClaimIndex = input.existingClaimsIndex ?? new Map<string, string[]>();

  const classified = classifyFactCandidates({
    facts: deduped.kept,
    projectId: input.projectId,
    artifactId: input.artifact.id,
    baseRevision: input.artifact.baseRevision,
    existingClaimIndex,
  });

  const claims = classified.map((item) => item.claim);

  return {
    claims,
    // Phase 3.1: 透传 narrativeElements 给 activity 层，由其调用 recordNarrativeElements
    narrativeElements: output.narrativeElements,
    // Phase 3.2: 透传 payoffMoments 给 activity 层，由其调用 recordPayoffCurve
    payoffMoments: output.payoffMoments,
    stats: {
      totalCandidates: deduped.totalCandidates,
      kept: deduped.kept.length,
      discardedDuplicate: deduped.discardedDuplicateCount,
      discardedLowConfidence: deduped.discardedLowConfidenceCount,
      discardedShortEvidence: deduped.discardedShortEvidenceCount,
      discardedInvalidSubject: deduped.discardedInvalidSubjectCount,
      discardedInvalidObject: deduped.discardedInvalidObjectCount,
      discardedExistingHash: deduped.discardedExistingHashCount,
    },
  };
}

/**
 * 重新计算 contentHash（用于上游 recordFactExtraction 二次校验）。
 *
 * 与 classify.ts 中的 hashContent 算法一致，但用 node:crypto sha256，
 * 确保与 postgres-repository 的 contentHash 列长度匹配。
 */
export function computeClaimContentHash(claim: MemoryClaim): string {
  return createHash("sha256").update(`${claim.subjectRefs.join(",")}:${claim.title}:${claim.content}`).digest("hex");
}
