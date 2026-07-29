/**
 * V2 protocol shared by Web, MCP, CLI and durable workflow adapters.
 * This module intentionally has no database or provider dependency.
 */
import type { ModelExecutionProvenance } from "./model-routing";

export const NOVEL_V2_PROTOCOL_VERSION = "2.0" as const;

export type IntentSource = "web" | "mcp" | "cli" | "api" | "chapter-review";
export type NovelStage = "foundation" | "planning" | "drafting" | "review" | "revision" | "fact-extraction";

/**
 * 章节工作流内部的细粒度阶段标识。
 *
 * 与 NovelStage 互补：NovelStage 是 intent 级别的粗粒度阶段，
 * WorkflowStage 是章节生成 workflow 内部的 11 个细粒度阶段
 * (context → blueprint → blueprint-approval → draft → review → revision
 *  → manuscript-approval → fact-extraction → fact-approval → commit
 *  → character-enrichment)。
 *
 * 从 v1 types.ts 迁移而来，用于 workflow-showcase UI 的阶段元数据映射。
 * 注：v2 章节生成走 Temporal durable execution，阶段语义等价但实现不同。
 */
export type WorkflowStage =
  | "context"
  | "blueprint"
  | "blueprint-approval"
  | "draft"
  | "deterministic-check"
  | "review"
  | "revision"
  | "manuscript-approval"
  | "fact-extraction"
  | "fact-approval"
  | "commit"
  | "character-enrichment";
export type MemoryKind = "canonical" | "episodic" | "hierarchical" | "author" | "working";
export type MemoryAuthority = "approved" | "author" | "derived" | "candidate" | "rejected";

export interface NovelIntent {
  id: string;
  projectId: string;
  source: IntentSource;
  objective: string;
  target?: { kind: "book" | "volume" | "arc" | "chapter" | "scene"; id?: string; order?: number };
  requestedStage?: NovelStage;
  constraints?: string[];
  requestedCapabilities?: string[];
  createdAt: number;
  idempotencyKey: string;
}

export interface RetrievalFacet {
  kind: "entity" | "relation" | "thread" | "foreshadowing" | "timeline" | "document" | "style" | "author-preference" | "fact" | "chapter-memory";
  query: string;
  required: boolean;
  narrativeCutoff?: number;
  knowledgeCharacterId?: string;
}

export interface PreflightPlan {
  id: string;
  intentId: string;
  projectId: string;
  taskClass: "foundation" | "planning" | "drafting" | "review" | "revision" | "memory-maintenance";
  stage: NovelStage;
  targetDocumentId?: string;
  narrativeCutoff?: number;
  povCharacterId?: string;
  facets: RetrievalFacet[];
  risk: "low" | "medium" | "high";
  requiresIndependentReview: boolean;
  createdAt: number;
  sourceFingerprint: string;
}

export interface MemoryClaim {
  id: string;
  projectId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  subjectRefs: string[];
  narrativeRange?: { start?: number; end?: number };
  knowledgeScope: "author" | { characterId: string };
  authority: MemoryAuthority;
  confidence: number;
  sourceRevisionIds: string[];
  contentHash: string;
  supersedes: string[];
  predicate?: string;
  sourceArtifactId?: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface MemoryHit extends MemoryClaim {
  score: number;
  matchedFacet: string;
  /** All retrieval dimensions satisfied by this claim; matchedFacet is the primary one. */
  matchedFacets?: string[];
  reason: string;
  lexicalRank?: number;
  semanticRank?: number;
  graphRank?: number;
}

export interface MemoryConflict {
  claimIds: string[];
  subjectRefs: string[];
  reason: string;
  blocking: boolean;
}

export interface MemoryBundle {
  id: string;
  projectId: string;
  preflightId: string;
  claims: MemoryHit[];
  conflicts: MemoryConflict[];
  missingFacets: string[];
  tokenBudget: number;
  sourceRevisionIds: string[];
  narrativeCutoff?: number;
  fingerprint: string;
  createdAt: number;
}

export interface ContextManifest {
  id: string;
  projectId: string;
  preflightId: string;
  memoryBundleId: string;
  retrievalRunId?: string;
  sourceRevisionIds: string[];
  includedClaimIds: string[];
  excludedClaimIds: string[];
  narrativeCutoff?: number;
  tokenBudget: number;
  estimatedTokens: number;
  truncationReason?: "budget" | "future-cutoff" | "authority-conflict" | "none";
  fingerprint: string;
  createdAt: number;
}

/**
 * 章节记忆：定稿章节的结构化摘要，用于长篇跨章节一致性。
 *
 * 与 MemoryClaim（细粒度事实）互补：ChapterMemory 是章节级的高层摘要，
 * 包含关键事件、角色状态快照、未解决线索、情绪弧光，
 * 让后续章节生成时能快速召回前章"发生了什么"而不必重新检索所有事实。
 *
 * 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约。
 * 参考：AI_NovelGenerator 的 global_summary.txt 三件套，但升级为结构化 + 向量检索。
 */
export interface ChapterMemory {
  id: string;
  projectId: string;
  documentId: string;
  revisionId: string;
  /** 章节顺序号（与 manuscript_documents.narrative_order 对齐）。 */
  narrativeRange: { start: number; end: number };
  /** 章节级摘要（200-400 字），描述本章核心进展。 */
  summary: string;
  /** 关键事件列表（按出现顺序）。 */
  keyEvents: string[];
  /** 角色状态快照：本章结束时各主要角色的处境。 */
  characterStates: Array<{ characterId: string; stateSnapshot: string }>;
  /** 未解决的线索/伏笔（本章埋设或仍悬置的）。 */
  unresolvedThreads: string[];
  /** 情绪弧光简述（用于节奏曲线追踪）。 */
  emotionalArc?: string;
  fingerprint: string;
  createdAt: number;
}

export interface SkillDescriptor {
  skillId: string;
  version: string;
  capabilities: string[];
  applicableTasks: PreflightPlan["taskClass"][];
  requiredMemoryKinds: MemoryKind[];
  conflicts: string[];
  qualityGates: string[];
  promptSections: Partial<Record<NovelStage, string>>;
  enabled: boolean;
  /**
   * Phase 3.3 题材适用性（可选）。
   *
   * 设计依据：AGENTS.md「reusable contracts over case-specific rules」——
   * 题材特化走 craft rule 沉淀，骨架只提供 genre 匹配机制。
   * 留空表示题材无关（任何 genre 都适用）。
   * 不内置金手指/系统流特化枚举——genre 字符串由调用方定义，
   * craft rule 通过 learning 闭环沉淀题材相关规则。
   */
  applicableGenres?: string[];
}

export interface SkillBundle {
  id: string;
  projectId: string;
  preflightId: string;
  skills: Array<Pick<SkillDescriptor, "skillId" | "version" | "qualityGates" | "promptSections">>;
  conflicts: Array<{ skillId: string; conflictsWith: string }>;
  missingCapabilities: string[];
  fingerprint: string;
  createdAt: number;
}

export interface BlueprintTask {
  id: string;
  kind: "retrieve" | "draft" | "review" | "revise" | "fact-extract" | "memory-update";
  role: string;
  dependsOn: string[];
  readSet: string[];
  writeSet: string[];
  queue: "planner" | "writer" | "reviewer" | "memory" | "external-agent";
  independentReviewRequired: boolean;
}

export interface ExecutionBlueprint {
  id: string;
  projectId: string;
  intentId: string;
  preflightId: string;
  memoryBundleId: string;
  skillBundleId: string;
  contextManifestId?: string;
  baseRevision: number;
  tasks: BlueprintTask[];
  commitPolicy: "dual-gate" | "human-only";
  budget: { maxInputTokens: number; maxOutputTokens: number; maxCostUsd?: number };
  memoryGate?: {
    status: "passed" | "manual-review";
    missingFacets: RetrievalFacet["kind"][];
    manualReviewFacets: RetrievalFacet["kind"][];
  };
  /**
   * 章节生成消费的全书规划 artifact 引用。
   *
   * 设计依据:AGENTS.md「root-cause analysis」——v2 重构后 foundation artifacts 未被
   * 章节生成消费,导致章节生成不基于全书规划。此字段记录章节生成时注入了哪些规划产出,
   * 供审计/learning 闭环感知上下文质量。仅 drafting/revision 任务填充,planning/foundation
   * 任务(本身产出规划)不填充。
   */
  foundationArtifactIds?: string[];
  arcId?: string;
  chapterBlueprintId?: string;
  planningContextFingerprint?: string;
  fingerprint: string;
  createdAt: number;
}

/**
 * 全书规划必填 taskKey 清单。
 *
 * 设计依据:AGENTS.md「root-cause analysis」——v2 重构后 novel_bootstrap_run 产出 foundation
 * artifacts 但未被章节生成消费,导致章节生成不基于全书规划。此清单是章节生成的前置硬约束:
 * 缺失任何一项,novel_chapter_generate handler 与 novelIntentWorkflow 均拒绝启动章节生成。
 *
 * 选择这 5 个 taskKey 的理由(对应 v1 全书规划的核心维度):
 * - architecture:叙事结构/章节布局,章节生成必须知道章节在全书中的位置
 * - characters:人物档案/动机,章节生成必须知道人物声部与动机
 * - worldview:世界观规则,章节生成必须遵守设定约束
 * - plot-design:plot 设计与章节规划,章节生成必须知道本章在主线/支线中的角色
 * - 单章直接蓝图由当前已批准 NarrativeArc 的 ChapterBlueprint 提供
 *
 * 其余 taskKey(project-positioning/relations/plot-threads/foreshadowing/timeline/story-control)
 * 不在必填清单:它们是重要参考但非阻塞——例如 foreshadowing 可能在章节生成过程中逐步建立,
 * timeline 可由 plot-design 推导。仍会作为上下文注入,只是不阻塞章节生成启动。
 */
export const REQUIRED_FOUNDATION_TASK_KEYS = [
  "architecture",
  "characters",
  "worldview",
  "plot-design",
] as const;

export interface Artifact {
  id: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  kind: "draft" | "review" | "revision" | "fact-extraction" | "summary" | "foundation" | "arc-plan" | "chapter-blueprint";
  contentHash: string;
  objectKey?: string;
  structuredData?: Record<string, unknown>;
  baseRevision: number;
  createdAt: number;
  fingerprint: string;
}

export interface ReviewIssue {
  severity: "blocker" | "major" | "warning";
  title: string;
  description?: string;
  evidence: string;
  dimension?: string;
  excerpt?: string;
  paragraph?: number;
  revisionRanges?: Array<{ start: number; end: number }>;
  rule?: string;
  sourceId?: string;
  suggestion?: string;
  rewriteExample?: string;
}

export interface Review {
  id: string;
  projectId: string;
  artifactId: string;
  reviewerId: string;
  identity: "internal" | "independent" | "human";
  verdict: "passed" | "revise" | "blocked";
  issues: ReviewIssue[];
  /** 综合质量分数（0-5），由 revision-policy.scoreReviews 计算。 */
  score?: number;
  /** reviewer 角色（style/character/continuity/plot/reader）。 */
  role?: string;
  createdAt: number;
  artifactFingerprint: string;
  modelProvenance?: ModelExecutionProvenance;
}

export interface CommitRequest {
  projectId: string;
  documentId: string;
  artifact: Artifact;
  reviews: Review[];
  baseRevision: number;
  idempotencyKey: string;
}

export interface CommitResult {
  revisionId: string;
  revision: number;
  contentHash: string;
  outboxEventId: number;
}

export interface MemoryProvider {
  search(input: { projectId: string; facets: RetrievalFacet[]; narrativeCutoff?: number; povCharacterId?: string }): Promise<MemoryHit[]>;
}

export interface SkillProvider {
  list(projectId: string): Promise<SkillDescriptor[]>;
}

export interface PreflightProjectSnapshot {
  projectId: string;
  currentRevision: number;
  targetDocumentId?: string;
  targetDocumentOrder?: number;
  povCharacterId?: string;
  /**
   * Phase 3.3 题材与前提（可选）。
   *
   * 从 novel_projects.metadata 读取，由项目创建时指定。
   * genre 用于 resolveSkillBundle 匹配 applicableGenres；
   * premise 作为创作上下文提示（不强制约束，由 craft rule 决定如何使用）。
   * 不内置固定题材枚举——任何字符串都可作为 genre（玄幻/都市/言情/科幻/悬疑等）。
   */
  genre?: string;
  premise?: string;
}

export interface ManuscriptDocumentSummary {
  id: string;
  projectId: string;
  title: string;
  narrativeOrder: number;
  povCharacterId?: string;
  currentRevisionId?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  wordCount?: number;
  latestRevision?: number;
  blockingIssueCount?: number;
  arcId?: string;
  arcTitle?: string;
  arcPlanningStatus?: string;
}

export interface NovelProjectDetail {
  id: string;
  title: string;
  currentRevision: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  documents: ManuscriptDocumentSummary[];
  latestRuns?: WorkflowRunRecord[];
}

export interface WorkflowRunRecord {
  id: string;
  workflowType: string;
  projectId: string;
  temporalWorkflowId: string;
  status: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TaskAttemptRecord {
  id: string;
  workflowRunId?: string;
  taskId: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  status: "pending" | "claimed" | "running" | "submitted" | "reviewed" | "failed" | "completed";
  payload: Record<string, unknown>;
}

export interface RuntimeLearningAssessmentV2 {
  id: string;
  projectId: string;
  source: { workflowId: string; artifactId?: string; reviewIds: string[]; fingerprint: string };
  conclusion: "no-shared-learning" | "propose-improvement";
  symptom?: string;
  failingLayer?: string;
  underlyingMechanism?: string;
  affectedInputClass?: string;
  boundaries?: string;
  regressionRisks?: string[];
  validationError?: string;
  candidate?: {
    targetKind: "skill" | "system-prompt";
    targetId: string;
    rationale: string;
    afterText: string;
    /**
     * P0-C1 修复（2026-07-27）：题材适用性（仅 targetKind="skill" 时有意义）。
     * 留空数组表示题材无关；非空数组表示仅适用于列出的 genre。
     * 由 LLM 在 learning-assessment prompt 中根据 affectedInputClass 推断，
     * recordLearning 透传给 createCraftRuleCandidate，promote 写入 skill_definitions.applicable_genres。
     */
    applicableGenres?: string[];
  };
  createdAt: number;
}

// ===== 评估闭环（Phase B-1）=====

/**
 * 项目依赖头：用于晋升时校验正式库是否在实验期间前进。
 *
 * projectRevision 是 novel_projects.current_revision；
 * finalDocumentHashes 是按 narrativeOrder 排序的 final 状态章节 contentHash 列表。
 * 任一字段变化都意味着正式库已前进，晋升应被拒绝（stale-baseline）。
 */
export interface ProjectHead {
  projectRevision: number;
  finalDocumentHashes: string[];
}

/**
 * 项目快照：完整捕获正式库的地基数据，用于恢复实验 schema。
 *
 * payload 包含 documents + memory_claims + skill_definitions + entities + relations +
 * manuscript_revisions + artifacts + reviews 的序列化数据。
 * hash 是 payload 的稳定哈希，用于校验快照完整性。
 */
export interface ProjectSnapshotBundle {
  id: string;
  projectId: string;
  hash: string;
  payload: {
    documents: ManuscriptDocumentSummary[];
    memoryClaims: MemoryClaim[];
    skillDefinitions: SkillDescriptor[];
    entities: Array<{ id: string; kind: string; name: string; payload: Record<string, unknown> }>;
    relations: Array<{ id: string; subjectId: string; predicate: string; objectId: string }>;
    revisions: Array<{ id: string; documentId: string; revision: number; contentHash: string; baseRevision: number }>;
    artifacts: Artifact[];
    reviews: Review[];
    novelIntents: NovelIntent[];
    contentBlobs: Array<{ contentHash: string; objectKey: string; byteLength: number }>;
    executionBlueprints: Array<{ id: string; intentId: string; preflightId: string; memoryBundleId: string; skillBundleId: string; payload: ExecutionBlueprint; fingerprint: string }>;
    memoryBundles: Array<{ id: string; preflightId: string; narrativeCutoff?: number; sourceRevisionIds: string[]; tokenBudget: number; payload: MemoryBundle; fingerprint: string }>;
  };
  head: ProjectHead;
  createdAt: number;
}

/**
 * 实验工作区：基于 Postgres schema 隔离的实验环境。
 *
 * schemaName 是 `experiment_<id>`，在 Postgres 中创建独立 schema，
 * 内含 novel_projects/manuscript_documents/memory_claims 等影子表。
 * 实验期间的写入只影响实验 schema，不污染正式库。
 * 实验结束后可 close（保留数据）或 delete（DROP SCHEMA CASCADE）。
 */
export interface ExperimentWorkspace {
  id: string;
  projectId: string;
  schemaName: string;
  baseSnapshotId: string;
  baseSnapshotHash: string;
  status: "active" | "closed" | "deleted";
  createdAt: number;
  closedAt?: number;
}

/**
 * 实验期间 LLM 迭代后的 skill prompt 变更。
 *
 * beforePrompt/afterPrompt 是 skill_definitions.prompt_sections 的 JSON 序列化文本。
 * learningMechanism 来自 RuntimeLearningAssessmentV2.underlyingMechanism，
 * AGENTS.md 要求 buildIterationPrompt 追加 learning 段落而非仅 issue 症状。
 */
export interface IteratedSkill {
  id: string;
  experimentId: string;
  skillId: string;
  beforePrompt: string;
  afterPrompt: string;
  rationale: string;
  triggeredByIssueIds: string[];
  learningMechanism?: string;
  createdAt: number;
}

/**
 * 可晋升的事实：从实验 schema 的 MemoryClaim 投影而来。
 *
 * 正式库晋升时以新 revision 为来源重新生成 MemoryClaim，
 * sourceClaimId 仅作 provenance 用途，不写入正式库。
 */
export interface PromotableFact {
  sourceClaimId: string;
  payload: Omit<MemoryClaim, "id" | "projectId" | "sourceRevisionIds" | "supersedes" | "contentHash">;
}

/**
 * 候选包：实验产物归一化为可晋升的 bundle。
 *
 * 候选包不携带实验 schema 生成的 ID，正式库在晋升事务中重新生成所有 ID。
 * dependencyHead 是实验创建时捕获的正式库状态，晋升时与重算结果比对。
 * qualityEvidence 汇总实验期间的 review scores 和 issue 分布。
 */
export interface CandidateBundle {
  formatVersion: 2;
  id: string;
  experimentId: string;
  sourceProjectId: string;
  baseSnapshotId: string;
  baseSnapshotHash: string;
  dependencyHead: ProjectHead;
  target: {
    documentId: string;
    baseRevision: number;
    baseContentHash: string;
  };
  manuscript: {
    title: string;
    plainText: string;
    contentHtml: string;
    wordCount: number;
    contentHash: string;
    sourceArtifactId?: string;
  };
  acceptedFacts: PromotableFact[];
  iteratedSkills: IteratedSkill[];
  qualityEvidence: {
    reviewIds: string[];
    scores: Record<string, number>;
    issueSummary: Record<string, number>;
  };
  provenance: {
    codeRevision: string;
    createdAt: number;
    workflowRunId: string;
  };
}

/**
 * 晋升幂等 receipt。
 *
 * id 格式 `promote:<candidateId>`，同一 candidateId 重复 promote 返回同一 receipt。
 * status 表示晋升结果：promoted（成功）/ rolled-back（已回滚）/ failed（失败）。
 * result 包含晋升产生的 revisionId/skillUpdates/factIds，用于回滚时定位。
 */
export interface PromotionReceipt {
  id: string;
  candidateId: string;
  projectId: string;
  status: "promoted" | "rolled-back" | "failed";
  result: {
    revisionId?: string;
    skillUpdates?: string[];
    promptTemplateUpdates?: string[];
    factIds?: string[];
  };
  failureReason?: string;
  createdAt: number;
}

/**
 * 作者审批决策：晋升前的人工确认。
 */
export interface AuthorDecision {
  authorId: string;
  decision: "accept" | "reject";
  reason?: string;
  decidedAt: number;
}

// ===== 创意执行（Phase B-2）=====

export type CreativeRunMode = "chapter" | "segment-auto";
export type CreativeRunStatus = "pending" | "running" | "paused" | "completed" | "cancelled";
export type CreativeWorkKind = "generation" | "revision" | "review";
export type CreativeWorkStatus = "pending" | "running" | "accepted" | "revised" | "retried" | "recovered" | "failed";

/**
 * CreativeRun 执行策略。
 *
 * maxRetries 是单 work item 最大重试次数；
 * reviewGate 控制是否必须人工审批才能 accept；
 * autoAcceptThreshold 是 review score 高于此值时自动 accept。
 */
export interface CreativeRunPolicy {
  maxRetries: number;
  reviewGate: "manual" | "auto" | "none";
  autoAcceptThreshold?: number;
  progression: "automatic" | "user-driven";
}

export interface CreativeRun {
  id: string;
  projectId: string;
  mode: CreativeRunMode;
  status: CreativeRunStatus;
  policy: CreativeRunPolicy;
  payload: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CreativeWorkItem {
  id: string;
  runId: string;
  kind: CreativeWorkKind;
  taskKey?: string;
  targetId?: string;
  instruction: string;
  dependsOn: string[];
  status: CreativeWorkStatus;
  artifactRefs: string[];
  parameters: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CreativeReviewInput {
  subjectArtifactId: string;
  reviewer: "internal" | "independent" | "human";
  verdict: "passed" | "revise" | "blocked";
  issues: ReviewIssue[];
  summary: string;
}

export interface CreativeReview extends CreativeReviewInput {
  id: string;
  workItemId: string;
  createdAt: number;
}

export type CreativeCommand =
  | { type: "work.start"; workItemId: string; idempotencyKey: string }
  | { type: "work.revise"; workItemId: string; instruction?: string; idempotencyKey: string }
  | { type: "work.retry"; workItemId: string; idempotencyKey: string }
  | { type: "work.recover"; workItemId: string; force?: boolean; idempotencyKey: string }
  | { type: "work.accept"; workItemId: string; idempotencyKey: string }
  | { type: "review.request"; workItemId: string; idempotencyKey: string }
  | { type: "review.submit"; workItemId: string; review: CreativeReviewInput; idempotencyKey: string }
  | { type: "run.pause" | "run.resume" | "run.cancel"; idempotencyKey: string };

export interface CreativeReviewGate {
  passed: boolean;
  verdict?: CreativeReviewInput["verdict"];
  reviewer?: CreativeReviewInput["reviewer"];
  openIssues: Array<ReviewIssue & { status: "open" | "resolved" }>;
  reason: string;
}

export interface CreativeActionResult {
  runId: string;
  commandType: CreativeCommand["type"];
  workItemId?: string;
  status: CreativeRunStatus;
  workStatus?: CreativeWorkStatus;
  artifactRefs: string[];
  reviewId?: string;
  reviewGate?: CreativeReviewGate;
  summary: string;
}

export interface CreativeRunSnapshot {
  run: CreativeRun;
  workItems: CreativeWorkItem[];
  reviews: CreativeReview[];
  events: Array<{ id: string; eventType: string; payload: Record<string, unknown>; createdAt: number }>;
}
