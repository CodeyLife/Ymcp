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

export type OutlineKind = "volume" | "arc" | "chapter" | "scene" | "beat";
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
  logline: string;
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
    autoCommitFacts: boolean;
    contextBudget: number;
    recentChapterCount: number;
    encrypted: boolean;
    contentProfile: "general-serial" | "progression" | "emotional";
    maxAutoRevisions: number;
    qualityThreshold: number;
    approvalMode: "blueprint-and-manuscript" | "final-only" | "every-step";
  };
}

export interface CharacterKnowledge {
  known: string[];
  suspected: string[];
  mistaken: string[];
  unknown: string[];
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
    knowledge: CharacterKnowledge;
    state: CharacterState;
  };
}

export interface EntityRelation extends VersionedRecord {
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  publicLabel: string;
  privateTruth: string;
  affinity: number;
  trust: number;
  conflict: number;
  history: Array<{ at: number; chapterId?: string; note: string }>;
}

export interface ChapterBlueprint {
  objective: string;
  povCharacterId?: string;
  locationIds: string[];
  characterIds: string[];
  conflict: string;
  informationRelease: string[];
  turningPoint: string;
  hook: string;
  mustHappen: string[];
  flexible: string[];
  forbidden: string[];
  targetWords: number;
}

export interface OutlineNode extends VersionedRecord {
  parentId?: string;
  kind: OutlineKind;
  title: string;
  summary: string;
  order: number;
  status: "idea" | "planned" | "drafting" | "done";
  storyTime?: string;
  documentId?: string;
  blueprint?: ChapterBlueprint;
  tension: number;
  emotion: number;
  information: number;
  tags: string[];
}

export interface StoryScene extends VersionedRecord {
  chapterId: string;
  title: string;
  order: number;
  locationId?: string;
  characterIds: string[];
  purpose: string;
  conflict: string;
  outcome: string;
  wordTarget: number;
}

export interface ManuscriptDocument extends VersionedRecord {
  outlineNodeId: string;
  title: string;
  contentHtml: string;
  plainText: string;
  summary: string;
  status: "outline" | "draft" | "review" | "final";
  wordCount: number;
  branch: string;
  yjsDocumentId: string;
}

export interface DocumentRevision extends VersionedRecord {
  documentId: string;
  label: string;
  contentHtml: string;
  plainText: string;
  source: "manual" | "ai" | "checkpoint" | "merge";
  parentRevisionId?: string;
  branch: string;
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

export interface ContextSource {
  id: string;
  kind: "instruction" | "document" | "entity" | "relation" | "outline" | "thread" | "foreshadowing" | "snapshot" | "style" | "skill" | "taste";
  title: string;
  content: string;
  weight: number;
  pinned: boolean;
  estimatedTokens: number;
  truncated?: boolean;
  reason: string;
  contentHash: string;
  priorityClass: "invariant" | "working" | "relevant" | "background";
  skillId?: string;
}

export interface NovelContextPacket extends VersionedRecord {
  task: string;
  instruction: string;
  targetId?: string;
  sources: ContextSource[];
  tokenBudget: number;
  estimatedTokens: number;
  omittedSourceIds: string[];
  skillRefs: Array<{ id: string; version: string; name: string; source: NovelSkillSource }>;
  compiledAt: number;
}

export interface ProposalPatch {
  targetTable: string;
  targetId: string;
  field: string;
  before: unknown;
  after: unknown;
  rationale: string;
}

export interface AIProposal extends VersionedRecord {
  title: string;
  operation: string;
  targetId?: string;
  status: ProposalStatus;
  previewMarkdown: string;
  patches: ProposalPatch[];
  contextPacketId: string;
  agentRunId?: string;
  model: string;
  artifactId?: string;
}

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
export type NovelSkillStage = "foundation" | "planning" | "drafting" | "review" | "revision" | "fact-extraction";
export type NovelAgentRole = "architect" | "writer" | "style-reviewer" | "character-reviewer" | "continuity-reviewer" | "plot-reviewer" | "pacing-reviewer" | "revision-editor" | "fact-extractor" | "quality-editor";

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
  priorityOverride?: number;
  config: Record<string, string | number | boolean | string[]>;
}

export type WorkflowStage = "context" | "blueprint" | "blueprint-approval" | "draft" | "deterministic-check" | "review" | "revision" | "manuscript-approval" | "fact-extraction" | "fact-approval" | "commit";
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
  kind: "blueprint" | "draft" | "review" | "revision" | "fact-delta" | "prompt";
  title: string;
  contentMarkdown: string;
  structuredData?: Record<string, unknown>;
  parentArtifactId?: string;
  model?: string;
  skillRefs: string[];
  contextPacketId?: string;
}

export type QualityDimension = "plot" | "characterVoice" | "sceneEmbodiment" | "dialogue" | "pacing" | "specificity" | "hookPayoff" | "continuity";

export interface QualityIssue {
  id: string;
  dimension: QualityDimension;
  severity: "blocker" | "major" | "warning";
  title: string;
  description: string;
  excerpt?: string;
  paragraph?: number;
  rule: string;
  sourceId?: string;
  suggestion: string;
  deterministic: boolean;
}

export interface QualityReport extends VersionedRecord {
  workflowRunId: string;
  artifactId: string;
  iteration: number;
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
  targetTable: string;
  targetId?: string;
  field: string;
  before?: unknown;
  after: unknown;
  evidence: string;
  paragraph?: number;
  confidence: number;
  novelty: "new" | "update" | "duplicate";
  conflict: boolean;
  status: "pending" | "accepted" | "rejected";
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

export type NovelWorkspaceView =
  | "dashboard"
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
