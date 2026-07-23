export type NovelIntentKind = "plan" | "write" | "revise";
export type RuntimeDriver = "human" | "external-mcp";
export type RuntimeOperationStatus = "queued" | "running" | "awaiting_review" | "completed" | "failed" | "cancelled";
export type RuntimeChangeStatus = "pending" | "accepted" | "rejected" | "superseded";

export interface RuntimeReviewPolicy {
  mode: "human-gated" | "external-review";
  /** null keeps an external quality loop active until it reaches a valid candidate. */
  maxIterations: number | null;
}

export interface RuntimeImprovementPolicy {
  mode: "manual" | "agent-proposable";
  requireCrossScenarioEvidence: true;
  autoPromote: boolean;
}

export interface RuntimeActor {
  type: "user" | "external-llm";
  id: string;
  model?: string;
}

export interface RuntimeNextAction {
  type: "read-agent-guide" | "inspect-change" | "review-change" | "patch-change" | "regenerate-change" | "wait" | "retry" | "inspect-failure" | "propose-improvement";
  operationId: string;
  changeId?: string;
  allowedDecisions?: Array<"accept" | "reject" | "revise">;
  reason: string;
}

export interface RuntimeCandidateEvidence {
  complete: boolean;
  artifactFingerprint?: string;
  artifactKind?: string;
  qualityScore?: number;
  blockerCount?: number;
  majorCount?: number;
  openIssues: string[];
  iteration: number;
  maxIterations: number | null;
  internalGate?: { passed: boolean; reason: string; checkedAt: number };
}

export interface RuntimeReviewIssue {
  id: string;
  severity: "blocker" | "major" | "warning";
  dimension: string;
  title: string;
  evidence: string;
  suggestion: string;
  evidenceItemId?: string;
  evidenceField?: string;
  evidenceQuote?: string;
}

export interface RuntimeLearningAssessment {
  conclusion: "no-shared-learning" | "propose-improvement";
  summary: string;
  affectedInputClass?: string;
  underlyingMechanism?: string;
}

export interface RuntimeExternalReview {
  reviewRunId: string;
  verdict: "passed" | "revise";
  summary: string;
  issues: RuntimeReviewIssue[];
  learning: RuntimeLearningAssessment;
  artifactFingerprint: string;
  actor: RuntimeActor;
  reviewedAt: number;
}

export interface RuntimePatchRecord {
  itemId: string;
  expectedPayloadFingerprint: string;
  rationale: string;
  issueIds: string[];
  actor: RuntimeActor;
  patchedAt: number;
}

export interface RuntimeOperation {
  id: string;
  projectId: string;
  kind: NovelIntentKind;
  driver: RuntimeDriver;
  reviewPolicy: RuntimeReviewPolicy;
  improvementPolicy: RuntimeImprovementPolicy;
  status: RuntimeOperationStatus;
  input: Record<string, unknown>;
  baseSnapshotHash: string;
  runId?: string;
  currentWorkItemId?: string;
  currentChangeId?: string;
  result?: Record<string, unknown>;
  error?: string;
  attempt: number;
  leaseExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeChange {
  id: string;
  operationId: string;
  projectId: string;
  workItemId: string;
  artifactRefs: string[];
  title: string;
  summary: string;
  evidence: RuntimeCandidateEvidence;
  status: RuntimeChangeStatus;
  baseSnapshotHash: string;
  review?: { decision: "accept" | "reject" | "revise"; note: string; actor: RuntimeActor; reviewedAt: number };
  artifactFingerprint?: string;
  externalReviews?: RuntimeExternalReview[];
  patches?: RuntimePatchRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeEvent {
  sequence: number;
  projectId?: string;
  operationId?: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface RuntimeProjectSummary {
  id: string;
  title: string;
  premise: string;
  genre: string[];
  status: string;
  updatedAt: number;
}

export type RuntimeRecordMutation =
  | {
      type: "put";
      collection: string;
      id: string;
      expectedRevision: number | null;
      value: Record<string, unknown>;
    }
  | {
      type: "delete";
      collection: string;
      id: string;
      expectedRevision: number;
    };

export interface RuntimeProjectMutationCommand {
  projectId: string;
  actor: RuntimeActor;
  mutations: RuntimeRecordMutation[];
}

export interface RuntimeProjectSnapshot {
  projectId: string;
  snapshotHash: string;
  records: Record<string, Array<Record<string, unknown>>>;
}

export interface RuntimeProjectMutationResult extends RuntimeProjectSnapshot {
  commandId: string;
  changed: Array<{ collection: string; id: string; type: "put" | "delete"; revision?: number }>;
}

export interface LegacyMigrationBundle {
  format: "ymcp-novel-runtime-migration";
  formatVersion: 1;
  exportedAt: number;
  records: Record<string, Array<Record<string, unknown>>>;
  integrity: { algorithm: "sha256"; digest: string };
  apiConfig?: { baseUrl?: string; apiKey?: string; modelContextWindow?: number };
}

export interface RuntimeApiError {
  error: { code: string; message: string; retryable: boolean; details?: unknown };
}

export function runtimePolicies(driver: RuntimeDriver): Pick<RuntimeOperation, "reviewPolicy" | "improvementPolicy"> {
  return driver === "human"
    ? {
        reviewPolicy: { mode: "human-gated", maxIterations: 2 },
        improvementPolicy: { mode: "manual", requireCrossScenarioEvidence: true, autoPromote: false },
      }
    : {
        reviewPolicy: { mode: "external-review", maxIterations: null },
        improvementPolicy: { mode: "agent-proposable", requireCrossScenarioEvidence: true, autoPromote: true },
      };
}

export function internalEvidencePasses(evidence: RuntimeCandidateEvidence, expectedArtifactFingerprint?: string): boolean {
  return evidence.complete
    && typeof evidence.artifactFingerprint === "string"
    && evidence.artifactFingerprint.length === 64
    && (!expectedArtifactFingerprint || evidence.artifactFingerprint === expectedArtifactFingerprint)
    && evidence.internalGate?.passed === true
    && typeof evidence.blockerCount === "number"
    && typeof evidence.majorCount === "number"
    && evidence.blockerCount === 0
    && evidence.majorCount === 0;
}

export function latestExternalReview(change: RuntimeChange): RuntimeExternalReview | undefined {
  return change.externalReviews?.at(-1);
}

export function assertRuntimeActor(operation: RuntimeOperation, actor: RuntimeActor): void {
  if (!actor.id.trim()) throw new Error("审核 actor.id 不能为空");
  if (actor.type === "external-llm" && !actor.model?.trim()) throw new Error("外部 LLM 审核必须记录模型身份");
  const expected = operation.driver === "human" ? "user" : "external-llm";
  if (actor.type !== expected) throw new Error(`operation driver ${operation.driver} 不接受 ${actor.type} 审核`);
}

export function runtimeNextActions(operation: RuntimeOperation, change?: RuntimeChange): RuntimeNextAction[] {
  if (operation.status === "awaiting_review" && change?.status === "pending") {
    const internalPassed = operation.driver === "human"
      ? change.evidence.complete
      : internalEvidencePasses(change.evidence, change.artifactFingerprint);
    return [
      { type: "read-agent-guide", operationId: operation.id, changeId: change.id, reason: "先读取状态相关协议，确认本轮不可跳过的审核门" },
      { type: "inspect-change", operationId: operation.id, changeId: change.id, reason: "先读取完整候选与质量证据" },
      { type: "review-change", operationId: operation.id, changeId: change.id, allowedDecisions: internalPassed ? ["accept", "revise"] : ["revise"], reason: internalPassed ? "内部质量门已通过，仍需外部 LLM 独立审核" : "内部质量门未通过，外部审核只能选择局部修订或重生成" },
      { type: "patch-change", operationId: operation.id, changeId: change.id, reason: "问题有稳定 item 定位且可局部修复时，更新待审核候选后重新进入双审核" },
      { type: "regenerate-change", operationId: operation.id, changeId: change.id, reason: "问题影响结构、连续性或无法安全定位时，携带审核意见重生成完整候选" },
    ];
  }
  if (operation.status === "queued" || operation.status === "running") {
    return [{ type: "wait", operationId: operation.id, reason: "运行时正在生成或推进工作项" }];
  }
  if (operation.status === "failed") {
    const actions: RuntimeNextAction[] = [
      { type: "inspect-failure", operationId: operation.id, reason: operation.error || "检查失败事件和工作项证据" },
      { type: "retry", operationId: operation.id, reason: "修正可重试故障后重新提交目标" },
    ];
    if (operation.improvementPolicy.mode === "agent-proposable") {
      actions.push({ type: "propose-improvement", operationId: operation.id, reason: "仅当证据表明共享提示词或流程机制存在普遍问题时创建版本化改进候选" });
    }
    return actions;
  }
  return [];
}
