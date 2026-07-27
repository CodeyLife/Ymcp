/**
 * V2 protocol shared by Web, MCP, CLI and durable workflow adapters.
 * This module intentionally has no database or provider dependency.
 */
export const NOVEL_V2_PROTOCOL_VERSION = "2.0" as const;

export type IntentSource = "web" | "mcp" | "cli" | "api";
export type NovelStage = "foundation" | "planning" | "drafting" | "review" | "revision" | "fact-extraction";
export type MemoryKind = "canonical" | "episodic" | "hierarchical" | "author" | "working";
export type MemoryAuthority = "approved" | "author" | "derived" | "candidate";

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
  kind: "entity" | "relation" | "thread" | "foreshadowing" | "timeline" | "document" | "style" | "author-preference" | "fact";
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
}

export interface MemoryHit extends MemoryClaim {
  score: number;
  matchedFacet: string;
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
}

export interface SkillBundle {
  id: string;
  projectId: string;
  preflightId: string;
  skills: Array<Pick<SkillDescriptor, "skillId" | "version" | "qualityGates">>;
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
  fingerprint: string;
  createdAt: number;
}

export interface Artifact {
  id: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  kind: "draft" | "review" | "revision" | "fact-extraction" | "summary";
  contentHash: string;
  objectKey?: string;
  structuredData?: Record<string, unknown>;
  baseRevision: number;
  createdAt: number;
  fingerprint: string;
}

export interface Review {
  id: string;
  projectId: string;
  artifactId: string;
  reviewerId: string;
  identity: "internal" | "independent" | "human";
  verdict: "passed" | "revise" | "blocked";
  issues: Array<{ severity: "blocker" | "major" | "warning"; title: string; evidence: string }>;
  createdAt: number;
  artifactFingerprint: string;
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
}

export interface NovelProjectDetail {
  id: string;
  title: string;
  currentRevision: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  documents: ManuscriptDocumentSummary[];
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
  candidate?: {
    targetKind: "skill" | "system-prompt" | "workflow";
    targetId: string;
    rationale: string;
    afterText: string;
  };
  createdAt: number;
}
