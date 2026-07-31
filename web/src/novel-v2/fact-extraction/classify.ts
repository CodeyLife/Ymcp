import type { FactExtractionOutput } from "../prompts/schemas";
import type { MemoryClaim, MemoryKind, MemoryAuthority } from "../protocol";
import { canonicalizeFactPredicate, factIdentityHash, factValueHash, normalizeFactToken } from "./fingerprint";

/**
 * V2 事实风险分类与 MemoryClaim 投影。
 *
 * 与 v1 [facts.ts] 的 classifyFactRisk 等价，但投影到 v2 的 MemoryClaim 结构
 * （而非 v1 FactAssertion/KnowledgeAssertion 双表）。
 *
 * 风险分类规则（与 v1 一致）：
 * - conflict=true → high risk（事实与现有资料冲突）
 * - truthStatus !== objective → high risk（声明、争议或开放谜题必须人工确认）
 * - novelty=update → medium risk（更新既有事实，需审核影响范围）
 * - novelty=duplicate → low risk（重复，仅记录）
 * - 其他 → low risk
 *
 * P0-A1 修复（2026-07-27）：supersedes 字段在 novelty=update 时填充被覆盖的旧 claim id。
 *   由 classifyFactCandidates 接收 existingClaimsDigest 解析出的 supersededIds 映射，
 *   按 subject.id + predicate 匹配旧 claim id，让 retrieval 层能屏蔽被覆盖的旧版本。
 *   设计依据：AGENTS.md「root-cause analysis」——supersedes 是长程一致性的核心契约，
 *   旧 claim 必须被屏蔽，否则 LLM 会看到自相矛盾的事实。
 *
 * P0-A3 修复（2026-07-27）：narrativeRange 不再用 fact.paragraph（段落号）填充，
 *   改为 undefined（由 recordFactExtraction 用 artifact 的 narrativeOrder 填充）。
 *   设计依据：narrativeRange 语义是章节序号（与 manuscript_documents.narrative_order 对齐），
 *   而非段落号；用段落号会导致第10段事实被当作"第10章"参与 narrativeCutoff 过滤，
 *   在第5章生成时本章事实被错误屏蔽。
 */

export type FactRisk = "low" | "medium" | "high";

export interface ClassifiedFact {
  readonly claim: MemoryClaim;
  readonly risk: FactRisk;
  readonly riskReason: string;
}

export interface ClassifyFactCandidatesInput {
  facts: FactExtractionOutput["facts"];
  projectId: string;
  artifactId: string;
  baseRevision: number;
  /**
   * P0-A1: 按 `${subject.id}|${predicate}` 映射到旧 claim id 列表。
   * 由上游从 existingClaimsDigest 构建，用于 novelty=update 时填充 supersedes。
   * 若未提供，supersedes 始终为空数组（与旧行为一致，但不满足长程一致性契约）。
   */
  existingClaimIndex?: Map<string, string[]>;
}

const CONTINUITY_PREDICATE_PATTERN = /身份|姓名|年龄|生死|死亡|存活|状态|位置|所在地|持有|拥有|失去|获得|知道|得知|隐瞒|关系|亲属|敌友|承诺|约定|时间|日期|先后|能力|限制|伤势|阵营|职位/u;

/** Facts that can alter later causal/state decisions need stronger evidence. */
export function isContinuitySensitiveFact(fact: FactExtractionOutput["facts"][number]): boolean {
  return fact.subject.kind === "relation"
    || fact.subject.kind === "timeline"
    || fact.subject.kind === "thread"
    || fact.subject.kind === "foreshadowing"
    || CONTINUITY_PREDICATE_PATTERN.test(fact.predicate);
}

/**
 * 把 LLM 提取的事实投影为 MemoryClaim + 风险等级。
 */
export function classifyFactRisk(params: {
  fact: FactExtractionOutput["facts"][number];
  projectId: string;
  artifactId: string;
  baseRevision: number;
  existingClaimIndex?: Map<string, string[]>;
}): ClassifiedFact {
  const { fact, projectId } = params;

  let risk: FactRisk = "low";
  let riskReason = "新增客观事实，自动入库";

  if (fact.conflict) {
    risk = "high";
    riskReason = "事实与现有资料冲突，必须人工确认";
  } else if (fact.truthStatus !== "objective") {
    risk = "high";
    riskReason = `${fact.truthStatus} 陈述必须人工确认`;
  } else if (fact.novelty === "update") {
    risk = "medium";
    riskReason = "更新既有事实，需审核影响范围";
  } else if (fact.confidence < 0.75 && isContinuitySensitiveFact(fact)) {
    risk = "medium";
    riskReason = "低置信连续性事实可能改变角色、关系、时间线或承诺状态，需人工确认";
  } else if (fact.novelty === "duplicate") {
    risk = "low";
    riskReason = "重复事实，仅记录";
  }

  // kind 推断：承诺/约定/誓言/伏笔/线索 → hierarchical；其他 → episodic
  const hierarchicalPattern = /承诺|约定|誓言|伏笔|线索|秘密|谜题|预言|禁忌/u;
  const kind: MemoryKind = hierarchicalPattern.test(fact.humanReadable) || hierarchicalPattern.test(fact.predicate)
    ? "hierarchical"
    : "episodic";

  // Only low-risk objective facts may enter retrieval automatically. Updates,
  // conflicts and non-objective statements remain candidates until an explicit
  // fact-approval path promotes them.
  const authority: MemoryAuthority = risk === "low" && fact.truthStatus === "objective" && fact.polarity === "affirmed"
    ? "derived"
    : "candidate";

  // P0-A1: novelty=update 时按 subject.id+predicate 查 existingClaimIndex 填充 supersedes
  let supersedes: string[] = [];
  if (fact.novelty === "update" && params.existingClaimIndex) {
    const key = `${normalizeFactToken(fact.subject.id)}|${canonicalizeFactPredicate(fact.predicate)}`;
    supersedes = params.existingClaimIndex.get(key) ?? [];
  }

  const identityHash = factIdentityHash(fact);
  const valueHash = factValueHash(fact);

  const claim: MemoryClaim = {
    id: `claim:${projectId}:${valueHash.slice(0, 24)}`,
    projectId,
    kind,
    title: fact.humanReadable.slice(0, 32),
    content: fact.humanReadable,
    subjectRefs: [fact.subject.id],
    // P0-A3: narrativeRange 不再用段落号；由 recordFactExtraction 用 narrativeOrder 填充
    narrativeRange: undefined,
    knowledgeScope: "author",
    authority,
    confidence: fact.confidence,
    sourceRevisionIds: [],
    contentHash: valueHash,
    supersedes,
    predicate: fact.predicate,
    identityHash,
    valueHash,
  };

  return { claim, risk, riskReason };
}

/**
 * 批量分类：把 LLM 输出转换为 MemoryClaim 列表。
 *
 * 返回 (claim, risk) 元组列表——上游 recordFactExtraction 根据 risk 决定写入路径：
 * - low: 直接写入 memory_claims（authority=derived）
 * - medium: 写入 memory_claims 但 authority=candidate（需人工审核）
 * - high: 写入 memory_claims 且标记 conflict=true（需人工审核）
 */
export function classifyFactCandidates(params: ClassifyFactCandidatesInput): ClassifiedFact[] {
  return params.facts.map((fact) => classifyFactRisk({
    fact,
    projectId: params.projectId,
    artifactId: params.artifactId,
    baseRevision: params.baseRevision,
    existingClaimIndex: params.existingClaimIndex,
  }));
}
