/**
 * 闭环评测模块的类型契约。
 *
 * 本文件只定义类型,不含实现逻辑。后续 loop 会逐步在
 * candidate-bundle.ts / promotion.ts / dependency-head.ts 中填充实现。
 *
 * 设计依据:docs/novel-real-data-evaluation-architecture.md §3.4 / §4.4 / §5.3
 */
import type { ProjectHead } from "./project-snapshot";
import type { FactAssertion, FactCandidate, NovelSkillManifest, ProjectSkillBinding } from "../types";

// ===== 候选包 (CandidateBundle) =====

/**
 * 实验产物归一化为可晋升的候选包。
 *
 * 候选包不携带实验库生成的 revision ID、fact assertion ID、memory ID 或 operation ID。
 * 正式库在晋升事务中重新生成这些 ID 和来源关系。
 *
 * architecture §3.4。本目标扩展:增加 iteratedSkills / iteratedBindings 字段,
 * 因为用户要求"自动推进技能和提示词"作为闭环的一部分。
 */
export interface CandidateBundle {
  formatVersion: 2;
  id: string;
  experimentId: string;
  variantId: string;
  sourceProjectId: string;
  baseSnapshotId: string;
  baseSnapshotHash: string;
  /** 实验创建时捕获的依赖头,用于晋升时与正式库重算的依赖头比对 */
  dependencyHead: ProjectHead;
  targetDocument: CandidateTargetDocument;
  workflowInput: CandidateWorkflowInput;
  manuscript: CandidateManuscript;
  acceptedFacts: PromotableFact[];
  /** 实验期间 LLM 自动迭代后的 skill prompt 变更 */
  iteratedSkills: IteratedSkill[];
  /** 实验期间基于 review 反馈调整的项目-技能绑定变更 */
  iteratedBindings: IteratedBinding[];
  qualityEvidence: QualityEvidence;
  provenance: CandidateProvenance;
}

export interface CandidateWorkflowInput {
  conversationThreadId: string;
  conversationThreadHash: string;
  creativeBriefId: string;
  creativeBriefHash: string;
}

export interface CandidateTargetDocument {
  documentId: string;
  baseRevision: number;
  baseApprovedRevisionId?: string;
  baseContentHash: string;
}

export interface CandidateManuscript {
  title: string;
  summary: string;
  plainText: string;
  contentHtml: string;
  wordCount: number;
  contentHash: string;
  /** 实验库中生成该稿件的 workflowRunId,仅作 provenance 用途,不写入正式库 */
  sourceWorkflowRunId?: string;
  /** 实验库中生成该稿件的 artifactId,仅作 provenance 用途 */
  sourceArtifactId?: string;
}

/**
 * 可晋升的事实。从实验库的 FactAssertion 投影而来,但去除实验库生成的 ID。
 * 正式库晋升时以新批准的 revision 为来源重新生成 FactAssertion。
 */
export interface PromotableFact {
  /** 实验库中的 FactAssertion ID,仅作 provenance 用途 */
  sourceFactAssertionId: string;
  /** 实验库中产生该事实的 factCandidateId,仅作 provenance 用途 */
  sourceCandidateId: string;
  /** 投影到正式库时使用的字段(与 FactAssertion 字段对齐,但 id/sourceRevisionId 留空) */
  payload: Omit<FactAssertion, "id" | "projectId" | "sourceRevisionId" | "derivedFromCandidateId" | "createdAt" | "updatedAt" | "createdBy" | "updatedBy" | "revision" | "schemaVersion">;
  /** 重放到正式库所需的领域投影输入，避免只写事实账本而遗漏实体/关系/认知更新。 */
  projectionInput: Pick<FactCandidate,
    "targetTable" | "targetId" | "field" | "before" | "after" | "novelty" | "knowledgeDeltas" | "riskReason"
  >;
}

/**
 * 实验期间 LLM 迭代后的 skill prompt。
 *
 * 一个 IteratedSkill 表示"将 skillId 的 prompt 从 before 改为 after"。
 * 晋升时在正式库中找到该 skillId 的当前记录,更新其 prompt 字段并递增 revision。
 */
export interface IteratedSkill {
  skillId: string;
  /** 实验前(基线快照中)的 prompt 文本,用于晋升时校验未被人工修改 */
  beforePrompt: string;
  /** 实验后(迭代后)的 prompt 文本 */
  afterPrompt: string;
  /** LLM 迭代理由,通常引用 review 报告中的 issue id */
  rationale: string;
  /** 触发本次迭代的 review issue 摘要 */
  triggeredByIssues: string[];
  /** 迭代发生的实验库 workflowRunId,仅作 provenance 用途 */
  sourceWorkflowRunId?: string;
}

/**
 * 实验期间调整的项目-技能绑定。
 *
 * 表示"将 skillId 在项目中的绑定状态从 before 改为 after"。
 * 晋升时在正式库中 upsert projectSkills 记录。
 */
export interface IteratedBinding {
  skillId: string;
  before: { enabled: boolean; priorityOverride?: number } | null;
  after: { enabled: boolean; priorityOverride?: number };
  rationale: string;
  triggeredByIssues: string[];
}

export interface QualityEvidence {
  /** 实验库中的 qualityReportId,仅作 provenance 用途 */
  sourceQualityReportId?: string;
  weightedScore: number;
  avgScore: number;
  blockerCount: number;
  majorCount: number;
  warningCount: number;
  issueCount: number;
  /** 各维度评分 */
  dimensionScores: Record<string, number>;
  /** 关键 issue 摘要(前 10 条) */
  topIssues: Array<{ severity: string; dimension: string; summary: string }>;
}

export interface CandidateProvenance {
  model: string;
  /** 整个工作流实际解析到的 Skill/System Prompt 版本引用。 */
  skillRefs?: string[];
  /** 每个工作流产物所属阶段使用的规则引用及其独立指纹。 */
  stagePromptEvidence?: Array<{
    stage: string;
    artifactId: string;
    skillRefs: string[];
    promptFingerprint: string;
  }>;
  promptFingerprint: string;
  configFingerprint: string;
  codeRevision: string;
  /** 实验库中产生的 workflowArtifactIds,仅作 provenance 用途 */
  workflowArtifactIds: string[];
  /** 实验开始时间戳 */
  experimentStartedAt: number;
  /** 候选导出时间戳 */
  exportedAt: number;
}

// ===== 晋升服务 (PromotionService) =====

/**
 * 候选包回到正式项目的唯一入口。
 *
 * architecture §4.4 / §5.3。
 * 其他代码不得从实验库向正式表执行 bulkPut。
 */
export interface PromotionService {
  inspect(candidate: CandidateBundle): Promise<PromotionCheck>;
  promote(candidate: CandidateBundle, decision: AuthorDecision): Promise<PromotionReceipt>;
}

export interface PromotionCheck {
  status: "ready" | "stale-baseline" | "conflict" | "rejected";
  issues: string[];
  /** 从正式库当前状态重算的依赖头 */
  recomputedDependencyHead: ProjectHead;
  /** 候选包中的 dependencyHead 与重算结果是否一致 */
  baselineMatches: boolean;
  /** 确定性质量检查中的 blocker(如正文 hash 不匹配、必填字段缺失) */
  deterministicBlockers: string[];
}

export interface AuthorDecision {
  accepted: true;
  authorId: string;
  rationale?: string;
  /** 决定接受的 fact 子集(对应 candidate.acceptedFacts 的 sourceFactAssertionId) */
  acceptedFactIds: string[];
  /** 决定接受的 skill 迭代子集(对应 candidate.iteratedSkills 的 skillId) */
  acceptedSkillIds: string[];
  /** 决定接受的绑定调整子集(对应 candidate.iteratedBindings 的 skillId) */
  acceptedBindingKeys: string[];
  decidedAt: number;
}

export interface PromotionReceipt {
  candidateId: string;
  /** 幂等键:同一 candidateId 多次晋升只产生一个 receipt */
  operationId: string;
  status: "promoted" | "already-promoted" | "rejected";
  promotedAt: number;
  /** 晋升创建的正式库 revision ID */
  createdRevisionId?: string;
  /** 晋升创建的正式库 FactAssertion IDs */
  createdFactAssertionIds: string[];
  /** 晋升创建的正式库 DerivedMemory IDs */
  createdMemoryIds: string[];
  /** 晋升创建的正式库 StorySnapshot ID */
  createdSnapshotId?: string;
  /** 晋升写入的 operations 表记录 IDs */
  createdOperationIds: string[];
  /** 失败原因(status=rejected 时) */
  error?: string;
}

// ===== 操作记录 (用于幂等性 + 审计) =====

/**
 * 闭环晋升操作的幂等记录。
 *
 * 与 CRDT/sync 用的 ChangeOperation 区分:本类型用于领域层晋升审计,
 * 以 candidateId 为幂等键,确保同一候选包重复晋升只产生一次副作用。
 *
 * projectId 来自 candidate.sourceProjectId,允许按项目查询 receipt。
 */
export interface OperationReceipt {
  id: string;
  /** 项目 ID(取自 candidate.sourceProjectId),便于按项目清理查询 */
  projectId: string;
  /** 幂等键:基于 candidateId 派生 */
  operationId: string;
  candidateId: string;
  action: "promote-candidate";
  status: "completed" | "failed" | "rolled-back";
  createdAt: number;
  completedAt?: number;
  receipts: {
    revisionId?: string;
    factAssertionIds: string[];
    memoryIds: string[];
    snapshotId?: string;
    operationIds?: string[];
  };
  error?: string;
}

// ===== 错误码 =====

export type PromotionErrorCode =
  | "stale-baseline"
  | "content-hash-mismatch"
  | "deterministic-blocker"
  | "idempotent-rejection"
  | "transaction-failure";

// ===== 便利类型 =====

/** 实验库中读取的 skill + binding 快照,用于 exportCandidate 时构造 IteratedSkill/IteratedBinding */
export interface ExperimentSkillSnapshot {
  manifest: NovelSkillManifest;
  binding: ProjectSkillBinding | null;
}
