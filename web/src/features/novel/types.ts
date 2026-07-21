import type { CanvasEdge, CanvasNodeLayout } from "@/shared/canvas";

export type EntityKind =
  | "character"
  | "location"
  | "organization"
  | "faction"
  | "item"
  | "species"
  | "rule"
  | "ability"
  | "term";

export type StoryFramework = "free" | "three-act" | "four-part" | "save-the-cat" | "snowflake";
export type PlotThreadKind = "main" | "subplot" | "romance" | "growth" | "mystery" | "antagonist";
export type ProjectRole = "owner" | "editor" | "commenter" | "reader";
export type ProposalStatus = "pending" | "accepted" | "rejected" | "partially_accepted";

export interface VersionedRecord {
  id: string;
  projectId: string;
  schemaVersion: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
  deletedAt?: number;
}

export interface StoryProject extends Omit<VersionedRecord, "projectId"> {
  title: string;
  subtitle: string;
  premise: string;
  genre: string[];
  audience: string;
  themes: string[];
  sellingPoints: string[];
  pov: string;
  tense: string;
  tone: string;
  languageStyle: string;
  targetWords: number;
  dailyGoal: number;
  status: "planning" | "drafting" | "revising" | "completed";
  coverColor: string;
  currentSnapshotId?: string;
  settings: {
    textModel: string;
    temperature: number;
    recentChapterCount: number;
    encrypted: boolean;
    contentProfile: "general-serial" | "progression" | "emotional";
    maxAutoRevisions: number;
    qualityThreshold: number;
    approvalMode: "blueprint-and-manuscript" | "final-only" | "every-step";
  };
}

export interface CharacterState {
  location: string;
  physical: string;
  emotional: string;
  objective: string;
  inventory: string[];
  relationshipNotes: string[];
  lastChangedChapterId?: string;
}

export interface StoryEntity extends VersionedRecord {
  kind: EntityKind;
  name: string;
  aliases: string[];
  summary: string;
  description: string;
  tags: string[];
  lockedFacts: string[];
  attributes: Record<string, string | number | boolean | string[]>;
  character?: {
    role: string;
    appearance: string;
    personality: string;
    desire: string;
    motivation: string;
    weakness: string;
    secret: string;
    abilities: string[];
    voice: string;
    arc: string;
    state: CharacterState;
  };
}

export interface EntityRelation extends VersionedRecord {
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  publicLabel: string;
  privateTruth: string;
  bond: string;
}

export interface ChapterBlueprint {
  objective: string;
  endingHook?: string;
  povCharacterId?: string;
  locationIds: string[];
  characterIds: string[];
  plotThreadIds: string[];
  foreshadowingIds: string[];
  conflict: string;
  informationRelease: string[];
  mustHappen: string[];
  flexible: string[];
  forbidden: string[];
  targetWords: number;
}

export interface ArchitecturePhase {
  id: string;
  title: string;
  purpose: string;
  turningPoint: string;
  order: number;
  locked: boolean;
}

export interface StoryArchitecture extends VersionedRecord {
  framework: StoryFramework;
  status: "draft" | "approved";
  centralQuestion: string;
  centralConflict: string;
  synopsis: string;
  phases: ArchitecturePhase[];
}

export interface OutlineNode extends VersionedRecord {
  phaseId: string;
  title: string;
  summary: string;
  order: number;
}

export interface StoryScene extends VersionedRecord {
  chapterId: string;
  title: string;
  order: number;
  status?: "idea" | "planned" | "drafting" | "done";
  povCharacterId?: string;
  storyTime?: string;
  locationId?: string;
  characterIds: string[];
  plotThreadIds?: string[];
  foreshadowingIds?: string[];
  purpose: string;
  conflict: string;
  outcome: string;
  wordTarget: number;
  beats?: Array<{ id: string; text: string; order: number }>;
}

export interface ManuscriptDocument extends VersionedRecord {
  order: number;
  plotSegmentId?: string;
  title: string;
  blueprint: ChapterBlueprint;
  contentHtml: string;
  plainText: string;
  summary: string;
  status: "outline" | "draft" | "review" | "final";
  wordCount: number;
  branch: string;
  yjsDocumentId: string;
  approvedRevisionId?: string;
  primaryNarrativeUnitId?: string;
}

export interface DocumentRevision extends VersionedRecord {
  documentId: string;
  label: string;
  contentHtml: string;
  plainText: string;
  source: "manual" | "ai" | "checkpoint" | "merge";
  parentRevisionId?: string;
  branch: string;
  approvalStatus?: "checkpoint" | "approved" | "superseded";
  approvedAt?: number;
  contentHash?: string;
  blocks?: ManuscriptBlock[];
}

export interface ManuscriptBlock {
  id: string;
  order: number;
  text: string;
  kind: "paragraph";
}

export interface ManuscriptChange extends VersionedRecord {
  documentId: string;
  workflowRunId?: string;
  sourceArtifactId?: string;
  baseRevisionId?: string;
  baseDocumentRevision: number;
  baseContentHash: string;
  sourceContentHash: string;
  operation: "insert" | "replace" | "delete";
  targetBlockId?: string;
  proposedBlockId: string;
  order: number;
  beforeText?: string;
  afterText?: string;
  beforeTextHash?: string;
  status: "pending" | "accepted" | "rejected" | "conflict";
  decidedAt?: number;
}

export interface PlotThread extends VersionedRecord {
  kind: PlotThreadKind;
  title: string;
  summary: string;
  status: "planned" | "active" | "paused" | "resolved" | "abandoned";
  priority: number;
  participantIds: string[];
  startNodeId?: string;
  targetNodeId?: string;
  progress: number;
  nextMove: string;
}

export interface Foreshadowing extends VersionedRecord {
  title: string;
  clue: string;
  truth: string;
  status: "seeded" | "reminded" | "misdirected" | "advanced" | "revealed" | "resolved" | "abandoned";
  seededNodeId?: string;
  targetNodeId?: string;
  urgency: number;
  notes: string;
}

export interface TimelineEvent extends VersionedRecord {
  title: string;
  storyDate: string;
  duration: string;
  narrativeOrder: number;
  locationId?: string;
  participantIds: string[];
  causeIds: string[];
  consequenceIds: string[];
  description: string;
  parallelGroup?: string;
}

export interface StorySnapshot extends VersionedRecord {
  label: string;
  storyTime: string;
  currentLocations: Record<string, string>;
  activeCharacterIds: string[];
  activeThreadIds: string[];
  unresolvedConflicts: string[];
  recentSummary: string;
  sourceDocumentId?: string;
}

export const CONTEXT_SOURCE_KINDS = [
  "instruction",
  "architecture",
  "document",
  "entity",
  "relation",
  "outline",
  "scene",
  "thread",
  "foreshadowing",
  "snapshot",
  "style",
  "skill",
  "taste",
  "fact",
  "knowledge",
  "memory",
  "conversation-memory",
  "creative-brief",
] as const;

export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];

export interface ContextSource {
  id: string;
  kind: ContextSourceKind;
  title: string;
  content: string;
  weight: number;
  pinned: boolean;
  estimatedTokens: number;
  truncated?: boolean;
  reason: string;
  contentHash: string;
  priorityClass: "invariant" | "working" | "relevant" | "background";
  layer: "mandatory" | "working" | "continuity" | "retrieval" | "background";
  visibilityReason: string;
  skillId?: string;
  authority?: "author" | "approved" | "derived" | "working";
  sourceRevisionId?: string;
  narrativeOrder?: number;
  evidenceRefs?: string[];
  retrieval?: {
    runId: string;
    round: number;
    lexicalRank?: number;
    vectorRank?: number;
    entityRank?: number;
    fusedScore: number;
  };
}

export interface NovelContextPacket extends VersionedRecord {
  task: string;
  instruction: string;
  targetId?: string;
  sources: ContextSource[];
  estimatedTokens: number;
  omittedSourceIds: string[];
  skillRefs: Array<{ id: string; version: string; name: string; source: NovelSkillSource }>;
  compiledAt: number;
  informationView?: { mode: "author" | "reader" | "character"; targetDocumentId?: string; targetNarrativeOrder?: number; characterId?: string };
  layerUsage?: Record<ContextSource["layer"], number>;
  omissions?: Array<{ sourceId: string; title: string; layer: ContextSource["layer"]; estimatedTokens: number; reason: string }>;
  threadId?: string;
  creativeBriefId?: string;
  retrievalRunId?: string;
  factCutoffOrder?: number;
  consumer?: { workflowRunId?: string; stage?: WorkflowStage; role?: NovelAgentRole; messageId?: string };
}

export type NovelConversationTaskKey = "chapter-workflow";

export interface NovelConversationThread extends VersionedRecord {
  taskKey: NovelConversationTaskKey;
  targetId: string;
  title: string;
  summary: string;
  status: "active" | "archived";
  pinnedSourceIds: string[];
  excludedSourceIds: string[];
  lastMessageAt: number;
}

export interface NovelConversationMessage extends VersionedRecord {
  threadId: string;
  role: "user" | "assistant";
  content: string;
  retrievalRunId?: string;
  sourceIds: string[];
}

export type ConversationMemoryKind = "preference" | "decision" | "constraint" | "open-question";

export interface ConversationMemory extends VersionedRecord {
  threadId?: string;
  targetId?: string;
  scope: "project" | "task" | "target";
  scopeKey: string;
  kind: ConversationMemoryKind;
  title: string;
  content: string;
  status: "active" | "pending" | "superseded" | "rejected";
  confidence: number;
  sourceMessageIds: string[];
  evidenceQuotes: string[];
  extractorVersion: string;
  supersedesId?: string;
  autoApplied: boolean;
  revokedAt?: number;
}

export interface CreativeBrief extends VersionedRecord {
  threadId: string;
  targetDocumentId: string;
  status: "draft" | "confirmed" | "superseded";
  goal: string;
  povCharacterId?: string;
  factCutoffOrder?: number;
  tone: string;
  languageRequirements: string[];
  mustHappen: string[];
  forbidden: string[];
  targetWords: number;
  referencedMemoryIds: string[];
  openQuestions: string[];
  sourceMessageIds: string[];
  confirmedAt?: number;
}

export interface NovelRetrievalHit {
  sourceId: string;
  kind: ContextSource["kind"];
  title: string;
  content: string;
  reason: string;
  authority: NonNullable<ContextSource["authority"]>;
  narrativeOrder?: number;
  evidenceRefs: string[];
  lexicalRank?: number;
  vectorRank?: number;
  entityRank?: number;
  fusedScore: number;
  round: number;
}

export interface NovelRetrievalRound {
  index: number;
  query: string;
  hitIds: string[];
  selectedIds: string[];
  enoughEvidence: boolean;
}

export interface NovelRetrievalRun extends VersionedRecord {
  threadId?: string;
  messageId?: string;
  targetKind?: "document" | "architecture-phase" | "project";
  targetId?: string;
  targetDocumentId?: string;
  informationView: "author" | "reader" | "character";
  purpose: "conversation" | "workflow-stage" | "task-evidence";
  factCutoffOrder?: number;
  consumer?: { workflowRunId?: string; stage?: WorkflowStage; role?: NovelAgentRole };
  queries: string[];
  rounds: NovelRetrievalRound[];
  hits: NovelRetrievalHit[];
  selectedSourceIds: string[];
  pinnedSourceIds: string[];
  excludedSourceIds: string[];
  status: "running" | "completed" | "failed";
  error?: string;
}

export interface NovelMemoryJob extends VersionedRecord {
  jobType: "embedding" | "memory-extraction" | "memory-invalidation" | "memory-consolidation";
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  lastError?: string;
  availableAt: number;
  completedAt?: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
}

export interface ProposalPatch {
  targetTable: string;
  targetId: string;
  field: string;
  before: unknown;
  after: unknown;
  rationale: string;
}

export type ProposalTargetTable =
  | "projects"
  | "architectures"
  | "outlineNodes"
  | "documents"
  | "scenes"
  | "entities"
  | "relations"
  | "plotThreads"
  | "foreshadowing"
  | "timelineEvents";

export interface ProposalItem {
  id: string;
  label: string;
  operation: "create" | "update" | "delete";
  targetTable: ProposalTargetTable;
  targetId?: string;
  tempId?: string;
  expectedRevision?: number;
  before?: Record<string, unknown>;
  status: "pending" | "accepted" | "rejected" | "conflict";
  payload: Record<string, unknown>;
  after?: Record<string, unknown>;
  rationale: string;
  dependencies: string[];
  impact?: string[];
  acceptedFields?: string[];
}

export type NovelGenerationScope = "architecture" | "outline" | "plot-design" | "chapters" | "scenes" | "bible" | "characters" | "relations" | "timeline" | "worldview" | "foreshadowing" | "threads" | "review" | "writing";

export type NovelGenerationTaskKey =
  | "project-positioning"
  | "architecture"
  | "plot-design"
  | "story-bible"
  | "characters"
  | "relations"
  | "timeline"
  | "worldview"
  | "plot-threads"
  | "foreshadowing"
  | "story-control"
  | "chapter-plan"
  | "scene-design"
  | "chapter-draft"
  | "review";

export interface AIProposal extends VersionedRecord {
  title: string;
  operation: string;
  taskKey?: NovelGenerationTaskKey;
  scope?: NovelGenerationScope;
  targetId?: string;
  status: ProposalStatus;
  previewMarkdown: string;
  patches: ProposalPatch[];
  items: ProposalItem[];
  contextPacketId: string;
  agentRunId?: string;
  model: string;
  artifactId?: string;
  generationMode?: "generate" | "refine";
  sourceFingerprint?: string;
  outlineGenerationMode?: "plot-segment-append";
  architecturePhaseId?: string;
  architecturePhaseOrder?: number;
  /**
   * 审核+迭代报告。当生成任务启用 audit 循环时记录每轮审核问题与改善情况。
   * 不参与 proposalItems 校验，仅作为元数据展示。
   */
  auditReport?: GenerationAuditReport;
}

export type AuditSeverity = "blocker" | "major" | "warning";

/**
 * audit issue 的来源分类——让 LLM 用结构化字段表达，而非在 title 中塞前缀。
 * - new: 本审核新增（reviewer 未报告）
 * - upgrade: reviewer 已报告但本审核升级严重度
 * - downgrade: reviewer 已报告但本审核降级严重度
 *
 * 仅 prose-audit（元审核）会用到 upgrade/downgrade；A/B 板块 audit 通常都是 new。
 */
export type AuditIssueOrigin = "new" | "upgrade" | "downgrade";

export interface GenerationAuditIssue {
  severity: AuditSeverity;
  /** issue 所属质量维度——让 LLM 判断，避免下游机械词匹配 */
  dimension: QualityDimension;
  title: string;
  evidence: string;
  suggestion: string;
  /** 来源分类（可选，默认 new）。prose-audit 用于区分"新增"与"升级/降级 reviewer 判断" */
  origin?: AuditIssueOrigin;
  /** upgrade/downgrade 时引用被复核 reviewer issue 的稳定 sourceId。 */
  sourceIssueId?: string;
}

export interface GenerationAuditRound {
  /** 第几轮审核（1=首次，2=迭代后再审） */
  iteration: number;
  summary: string;
  issues: GenerationAuditIssue[];
  /** 本轮是否有 blocker/major 触发迭代 */
  triggeredIteration: boolean;
}

/**
 * audit 迭代机制——三个板块的迭代方式不同：
 * - internal-iterate: A/B 板块在生成阶段内部做 audit+iterate 循环（rounds 含多轮）
 * - external-revision: C 板块利用 revision-stage 作为迭代机制（rounds 通常只有 1 轮，迭代由 workflow 循环承担）
 */
export type AuditMechanism = "internal-iterate" | "external-revision";

export interface GenerationAuditReport {
  /** 哪个 audit skill 产出（plot-segment-audit / blueprint-audit / prose-audit） */
  auditSkillId: string;
  /** 迭代机制——明确声明 rounds 语义，避免下游误读 */
  mechanism: AuditMechanism;
  /** 总轮数（含首轮+迭代后再审） */
  rounds: GenerationAuditRound[];
  /** 最终是否所有 major+ 问题已解决（最后一轮无 blocker/major） */
  improved: boolean;
  /** 最终遗留的 blocker/major 数量 */
  remainingMajorCount: number;
  /** 审核失败时的错误信息（如 LLM 调用失败、schema 校验失败）。失败时 rounds 为空，improved=false */
  error?: string;
}

export type RefinementSnapshotInput = Partial<Record<ProposalTargetTable, Array<Record<string, unknown>>>>;

export interface RefinementSnapshotRecord {
  id: string;
  revision: number;
  data: Record<string, unknown>;
}

export type RefinementSnapshot = Partial<Record<ProposalTargetTable, RefinementSnapshotRecord[]>>;

export interface AgentStep {
  id: string;
  title: string;
  tool: string;
  status: "pending" | "running" | "paused" | "completed" | "failed";
  output?: string;
  error?: string;
}

export interface AgentRun extends VersionedRecord {
  goal: string;
  status: "planning" | "running" | "paused" | "completed" | "failed" | "cancelled";
  model: string;
  promptVersion: string;
  contextPacketId?: string;
  steps: AgentStep[];
  startedAt?: number;
  finishedAt?: number;
  usage?: { inputTokens: number; outputTokens: number; cost?: number };
  workflowRunId?: string;
  role?: NovelAgentRole;
  skillRefs?: string[];
  artifactRefs?: string[];
  attempt?: number;
  promptHash?: string;
}

export type NovelSkillSource = "builtin" | "user" | "project";
export type NovelSkillCategory = "ideation" | "character-world" | "long-plan" | "chapter" | "drafting" | "serial" | "review" | "memory";
export type NovelSkillStage = "foundation" | "planning" | "drafting" | "review" | "revision" | "fact-extraction" | "character-enrichment";
export type NovelAgentRole = "architect" | "writer" | "style-reviewer" | "character-reviewer" | "continuity-reviewer" | "plot-reviewer" | "revision-editor" | "fact-extractor" | "quality-editor" | "character-enricher" | "conversation-assistant" | "memory-curator" | "skill-iterator";

export interface NovelSkillManifest extends VersionedRecord {
  skillId: string;
  version: string;
  name: string;
  description: string;
  locale: string;
  category: NovelSkillCategory;
  stages: NovelSkillStage[];
  triggers: string[];
  requires: string[];
  conflicts: string[];
  priority: number;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  prompt: string;
  qualityChecks: string[];
  source: NovelSkillSource;
  sourceUrl?: string;
  license?: string;
  enabled: boolean;
  readonly: boolean;
}

export interface ProjectSkillBinding extends VersionedRecord {
  skillId: string;
  enabled: boolean;
  activeVersion?: string;
  priorityOverride?: number;
  config: Record<string, string | number | boolean | string[]>;
}

export type CraftRuleTargetKind = "skill" | "system-prompt";
export type CraftRuleCandidateStatus = "proposed" | "evaluating" | "ready" | "rejected" | "promoted" | "rolled-back";
export type CraftRuleReviewRole = "plot-editor" | "character-editor" | "prose-editor" | "long-form-editor";

export interface CraftRuleScopeAnalysis {
  observedSymptom: string;
  failingLayer: string;
  underlyingMechanism: string;
  affectedInputClass: string;
  intendedBenefits: string[];
  boundaries: string[];
  nonGoals: string[];
  regressionRisks: string[];
}

export interface CraftRuleEvidenceCase {
  caseId: string;
  scenarioClass: string;
  subjectKind: "chapter" | "foundation-task";
  subjectId: string;
  documentId?: string;
  scenarioSignature: string;
  scenarioProfile: Record<string, string>;
  baselineWorkItemId: string;
  candidateWorkItemId: string;
  baselineArtifactId: string;
  candidateArtifactId: string;
  baselineScore: number;
  candidateScore: number;
  blockerDelta: number;
  majorDelta: number;
  recordedAt: number;
}

export interface CraftRuleReviewDecision {
  role: CraftRuleReviewRole;
  reviewer: "external-llm" | "user";
  reviewerId: string;
  reviewRunId: string;
  model?: string;
  verdict: "passed" | "revise" | "rejected";
  summary: string;
  concerns: string[];
  evidenceFingerprint?: string;
  reviewedVersion?: string;
  reviewedAt: number;
}

export interface CraftRuleCandidate extends VersionedRecord {
  targetKind: CraftRuleTargetKind;
  targetId: string;
  beforeVersion: string;
  proposedVersion: string;
  beforeText: string;
  afterText: string;
  rationale: string;
  scope: CraftRuleScopeAnalysis;
  status: CraftRuleCandidateStatus;
  evidenceCases: CraftRuleEvidenceCase[];
  reviews: CraftRuleReviewDecision[];
  promotedRecordId?: string;
  promotedAt?: number;
  rollbackOfCandidateId?: string;
}

export interface PromptTemplateVersion extends VersionedRecord {
  templateId: string;
  version: string;
  name: string;
  description: string;
  stages: NovelSkillStage[];
  content: string;
  active: boolean;
  source: "builtin" | "project";
  previousVersionId?: string;
}

/**
 * 实验库中 LLM 自动迭代后的 skill prompt 记录。
 *
 * 表示"将 skillId 的 prompt 从 beforePrompt 改为 afterPrompt"的拟议变更，
 * 由 skill-iteration 服务在实验库中产生，等待 CandidateBundle 导出 + PromotionService 晋升。
 *
 * 与 NovelSkillManifest 的区别：NovelSkillManifest 是当前生效的完整 skill 记录，
 * IteratedSkillRecord 是实验库中产生的"拟议变更"，不直接覆盖正式库的 NovelSkillManifest。
 * PromotionService 晋升时根据 IteratedSkillRecord 更新正式库 NovelSkillManifest 的 prompt 字段。
 */
export interface IteratedSkillRecord extends VersionedRecord {
  /** 实验前(基线快照中)的 skill ID，对应 NovelSkillManifest.skillId */
  skillId: string;
  /** 实验前(基线快照中)的 prompt 文本，用于晋升时校验未被人工修改 */
  beforePrompt: string;
  /** 实验后(迭代后)的 prompt 文本，晋升时写入正式库 NovelSkillManifest.prompt */
  afterPrompt: string;
  /** LLM 迭代理由，通常引用 review 报告中的 issue id 或 rule */
  rationale: string;
  /** 触发本次迭代的 review issue 摘要(QualityIssue.id 列表) */
  triggeredByIssueIds: string[];
  /** 触发本次迭代的 review issue 摘要(人类可读描述，便于审计) */
  triggeredByIssueSummaries: string[];
  /** 产生此迭代的实验库 workflowRunId，仅作 provenance 用途 */
  sourceWorkflowRunId: string;
  /** 产生此迭代时的 LLM 模型名，仅作 provenance 用途 */
  model: string;
}

export type WorkflowStage = "context" | "blueprint" | "blueprint-approval" | "draft" | "deterministic-check" | "review" | "revision" | "manuscript-approval" | "fact-extraction" | "fact-approval" | "commit" | "character-enrichment";
export type WorkflowRunStatus = "running" | "waiting-approval" | "paused" | "completed" | "failed" | "cancelled";

export interface WorkflowDefinition extends VersionedRecord {
  workflowId: string;
  name: string;
  description: string;
  stages: WorkflowStage[];
  requiredSkillIds: string[];
  maxAutoRevisions: number;
  qualityThreshold: number;
  builtin: boolean;
}

export interface WorkflowRun extends VersionedRecord {
  workflowId: string;
  targetDocumentId: string;
  status: WorkflowRunStatus;
  currentStage: WorkflowStage;
  stageIndex: number;
  revisionIteration: number;
  previousScore?: number;
  contextPacketId?: string;
  conversationThreadId?: string;
  creativeBriefId?: string;
  blueprintArtifactId?: string;
  draftArtifactId?: string;
  qualityReportId?: string;
  factCandidateIds: string[];
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface WorkflowArtifact extends VersionedRecord {
  workflowRunId: string;
  stage: WorkflowStage;
  kind: "blueprint" | "draft" | "review" | "revision" | "fact-delta" | "prompt" | "character-enrichment";
  title: string;
  contentMarkdown: string;
  structuredData?: Record<string, unknown>;
  parentArtifactId?: string;
  model?: string;
  skillRefs: string[];
  contextPacketId?: string;
}

export type CreativeRunMode = "manual" | "segment-auto" | "external";
export type CreativeRunStatus = "running" | "waiting-review" | "paused" | "completed" | "failed" | "cancelled";
export type CreativeWorkKind = "generation" | "plot-segment" | "chapter-workflow" | "audit" | "revision" | "promotion";
export type CreativeWorkStatus = "queued" | "running" | "waiting-review" | "completed" | "blocked" | "failed" | "cancelled";

export interface CreativeRunPolicy {
  auditTrigger: "manual" | "automatic" | "external";
  commitPolicy: "manual" | "quality-gated-auto" | "external-auto";
  qualityThreshold: number;
  maxIterations: number;
}

export interface CreativeRun extends VersionedRecord {
  mode: CreativeRunMode;
  objective: string;
  status: CreativeRunStatus;
  policy: CreativeRunPolicy;
  activeWorkItemId?: string;
  baseSnapshotHash?: string;
  lastEventSequence: number;
  error?: string;
  finishedAt?: number;
}

export interface CreativeWorkItem extends VersionedRecord {
  creativeRunId: string;
  kind: CreativeWorkKind;
  status: CreativeWorkStatus;
  taskKey?: NovelGenerationTaskKey;
  targetId?: string;
  instruction: string;
  parameters: Record<string, unknown>;
  dependsOn: string[];
  iteration: number;
  artifactRefs: string[];
  summary?: string;
  error?: string;
  leaseExpiresAt?: number;
  activeIdempotencyKey?: string;
}

export interface CreativeReview extends VersionedRecord {
  creativeRunId: string;
  workItemId: string;
  subjectArtifactId: string;
  reviewer: "internal" | "external-llm" | "user";
  verdict: "passed" | "revise" | "blocked" | "inconclusive";
  issues: Array<GenerationAuditIssue & {
    issueId: string;
    status: "open" | "resolved" | "accepted-risk" | "superseded";
    supersedesIssueId?: string;
  }>;
  summary: string;
}

export interface CreativeRunEvent extends VersionedRecord {
  creativeRunId: string;
  sequence: number;
  type: "run.created" | "run.status-changed" | "work.enqueued" | "work.started" | "work.requeued" | "work.result-ready" | "work.completed" | "work.blocked" | "work.failed" | "review.recorded";
  workItemId?: string;
  idempotencyKey?: string;
  payload: Record<string, unknown>;
}

export interface CreativeToolReceipt extends VersionedRecord {
  tool: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status: "pending" | "completed" | "failed";
  result?: unknown;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

export type QualityDimension = "plot" | "characterVoice" | "sceneEmbodiment" | "dialogue" | "specificity" | "hookPayoff" | "continuity";

export interface QualityIssue {
  id: string;
  dimension: QualityDimension;
  severity: "blocker" | "major" | "warning";
  title: string;
  description: string;
  excerpt?: string;
  paragraph?: number;
  revisionRanges?: Array<{ start: number; end: number }>;
  rule: string;
  sourceId?: string;
  suggestion: string;
  rewriteExample?: string;
  deterministic: boolean;
}

export interface QualityReport extends VersionedRecord {
  workflowRunId: string;
  artifactId: string;
  iteration: number;
  scoringVersion?: number;
  scores: Record<QualityDimension, number>;
  weightedScore: number;
  blockerCount: number;
  passed: boolean;
  issues: QualityIssue[];
  metrics: Record<string, number>;
  reviewerRoles: NovelAgentRole[];
}

export interface FactCandidate extends VersionedRecord {
  workflowRunId: string;
  sourceArtifactId: string;
  sourceRevisionId?: string;
  targetTable: string;
  targetId?: string;
  field: string;
  subject?: { kind: FactSubjectKind; id: string };
  predicate?: string;
  object?: FactObjectValue;
  polarity?: "affirmed" | "negated";
  truthStatus?: FactTruthStatus;
  timeMode?: FactTimeMode;
  validFrom?: StoryPoint;
  validTo?: StoryPoint;
  revealedAt?: StoryPoint;
  humanReadable?: string;
  knowledgeDeltas?: FactKnowledgeDelta[];
  before?: unknown;
  after: unknown;
  evidence: string;
  paragraph?: number;
  confidence: number;
  novelty: "new" | "update" | "duplicate";
  conflict: boolean;
  risk: "safe" | "high";
  riskReason: string;
  status: "pending" | "accepted" | "rejected";
  decisionSource?: "author" | "auto-policy";
  decidedAt?: number;
  committedAssertionId?: string;
  committedAt?: number;
}

export type FactTimeMode = "timeless" | "point" | "interval" | "open-ended" | "unknown";
export type FactTruthStatus = "objective" | "claim" | "contested" | "open-question";
export type FactSubjectKind = "project" | "entity" | "relation" | "outline" | "scene" | "thread" | "foreshadowing" | "timeline";

export interface StoryPoint {
  chapterId?: string;
  sceneId?: string;
  narrativeOrder?: number;
  absoluteDate?: string;
  anchorEventId?: string;
  relativeOffset?: { value: number; unit: "minute" | "hour" | "day" | "week" | "month" | "year" };
  precision: "exact" | "approximate" | "range" | "unknown";
}

export interface FactObjectValue {
  kind: "entity-ref" | "string" | "number" | "boolean" | "json";
  value: unknown;
}

export interface FactAssertion extends VersionedRecord {
  subject: { kind: FactSubjectKind; id: string };
  predicate: string;
  object: FactObjectValue;
  polarity: "affirmed" | "negated";
  truthStatus: FactTruthStatus;
  timeMode: FactTimeMode;
  validFrom?: StoryPoint;
  validTo?: StoryPoint;
  revealedAt?: StoryPoint;
  sourceRevisionId: string;
  sourceArtifactId?: string;
  provenance: "approved-revision" | "legacy-artifact";
  evidence: string;
  paragraph?: number;
  confidence: number;
  humanReadable: string;
  status: "active" | "superseded" | "stale" | "retracted";
  supersedesId?: string;
  derivedFromCandidateId: string;
  projection?: { targetTable: string; targetId?: string; field: string };
}

export interface KnowledgeAssertion extends VersionedRecord {
  characterId: string;
  factAssertionId: string;
  stance: "known" | "suspected" | "mistaken" | "unknown";
  learnedAt?: StoryPoint;
  sourceRevisionId: string;
  status: "active" | "superseded" | "stale" | "retracted";
  supersedesId?: string;
}

export interface FactKnowledgeDelta {
  characterId: string;
  stance: KnowledgeAssertion["stance"];
  learnedAt?: StoryPoint;
}

export type NarrativeUnitKind = "volume" | "arc" | "sequence";

export interface NarrativeUnit extends VersionedRecord {
  parentId?: string;
  kind: NarrativeUnitKind;
  title: string;
  summary: string;
  order: number;
  status: "planned" | "active" | "completed";
}

export interface OutlineRealization extends VersionedRecord {
  outlineNodeId: string;
  documentId: string;
  sceneId?: string;
  status: "planned" | "partial" | "realized";
  note: string;
}

export interface DerivedMemoryContent {
  sceneOutcomes: string[];
  stateChanges: string[];
  knowledgeChanges: string[];
  relationshipChanges: string[];
  threadProgress: string[];
  foreshadowingProgress: string[];
  factAssertionIds: string[];
  inheritedPressures: string[];
}

export interface DerivedMemory extends VersionedRecord {
  level: "chapter" | "sequence" | "arc" | "volume" | "book";
  documentId?: string;
  narrativeUnitId?: string;
  sourceRevisionId?: string;
  sourceMemoryIds: string[];
  coverage: { chapterIds: string[]; startOrder?: number; endOrder?: number };
  summary: string;
  content: DerivedMemoryContent;
  status: "draft" | "active" | "pending-review" | "cold" | "stale" | "superseded";
  validation: { passed: boolean; issues: string[]; checkedAt: number };
  tokenEstimate: number;
  generatedAt: number;
}

export interface PreferenceSignal extends VersionedRecord {
  sourceType: "proposal-accepted" | "proposal-rejected" | "manual-edit" | "quality-override";
  sourceId: string;
  category: string;
  preference: string;
  evidence?: string;
  weight: number;
}

export interface ProjectTasteProfile extends VersionedRecord {
  status: "draft" | "confirmed";
  summary: string;
  preferredPatterns: string[];
  avoidedPatterns: string[];
  exemplarDocumentIds: string[];
  signalIds: string[];
}

export interface ChangeOperation extends VersionedRecord {
  operationId: string;
  deviceId: string;
  actorId: string;
  logicalClock: number;
  entityTable: string;
  entityId: string;
  action: "create" | "update" | "delete" | "restore";
  fieldChanges: Record<string, { before: unknown; after: unknown }>;
  syncStatus: "local" | "syncing" | "synced" | "conflict";
  idempotencyKey: string;
}

export interface SyncConflict extends VersionedRecord {
  operationId: string;
  entityTable: string;
  entityId: string;
  field: string;
  localValue: unknown;
  remoteValue: unknown;
  status: "open" | "resolved-local" | "resolved-remote" | "resolved-manual";
}

/**
 * 内容向量记录：为实体/大纲/文档等生成语义 embedding，供上下文混合检索使用。
 * 通过 contentHash 判断内容是否变化，决定是否需要重新生成向量。
 */
export interface NovelEmbedding extends VersionedRecord {
  targetTable: "entities" | "outlineNodes" | "documents" | "scenes" | "plotThreads" | "foreshadowing" | "factAssertions" | "derivedMemories" | "conversationMemories";
  targetId: string;
  model: string;
  dimension: number;
  vector: number[];
  contentHash: string;
  chunkIndex?: number;
}

/** 画布面板标识 — 每个接入画布的小说板块对应一个 panelKey。 */
export type CanvasPanelKey =
  | "character-canvas"
  | "timeline-canvas";

/**
 * 画布布局持久化记录。
 *
 * 每个 (projectId, panelKey) 对应一条记录，存储视口变换、节点位置/尺寸/分组、
 * 以及画布级别的连线。领域数据（StoryEntity / TimelineEvent 等）不在此存储，
 * 加载时通过 node.id 关联回各自业务表。
 */
export interface CanvasLayout extends VersionedRecord {
  panelKey: CanvasPanelKey;
  viewport: { x: number; y: number; k: number };
  nodes: CanvasNodeLayout[];
  edges: CanvasEdge[];
}

export type NovelWorkspaceView =
  | "dashboard"
  | "planning"
  | "writing"
  | "library"
  | "review"
  | "settings"
  | "bible"
  | "characters"
  | "relations"
  | "outline"
  | "board"
  | "timeline"
  | "threads"
  | "foreshadowing"
  | "manuscript"
  | "analysis"
  | "versions"
  | "skills"
  | "workflow";
