import "fake-indexeddb/auto";
import "./polyfills";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { deleteChapter, novelDb } from "../features/novel/db";
import { setNovelApiConfigProvider } from "../features/novel/api-config";
import { executeCreativeTool, type CreativeToolName } from "../features/novel/creative-tool-gateway";
import { updateProposalItemPayload } from "../features/novel/generation";
import { evaluateCraftRuleOnChapter, evaluateCraftRuleOnFoundation, inspectCraftRuleCandidate } from "../features/novel/craft-rule-evolution";
import {
  assertRuntimeActor,
  internalEvidencePasses,
  latestExternalReview,
  runtimeNextActions,
  runtimePolicies,
  type RuntimeActor,
  type RuntimeCandidateEvidence,
  type RuntimeExternalReview,
  type RuntimePatchRecord,
  type RuntimeChange,
  type RuntimeDriver,
  type RuntimeEvent,
  type RuntimeOperation,
  type RuntimeProjectMutationCommand,
  type RuntimeProjectMutationResult,
  type RuntimeProjectSnapshot,
  type RuntimeProjectSummary,
  type NovelIntentKind,
} from "./contracts";
import type { NovelStore } from "./sqlite-store";

const OPERATION_LEASE_MS = 20 * 60 * 1000;

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function withInternalGate(evidence: RuntimeCandidateEvidence): RuntimeCandidateEvidence {
  const hasQualityEvidence = typeof evidence.blockerCount === "number" && typeof evidence.majorCount === "number";
  const hasArtifactFingerprint = typeof evidence.artifactFingerprint === "string" && evidence.artifactFingerprint.length === 64;
  const passed = evidence.complete && hasArtifactFingerprint && hasQualityEvidence && evidence.blockerCount === 0 && evidence.majorCount === 0;
  return {
    ...evidence,
    internalGate: {
      passed,
      reason: !evidence.complete
        ? "候选产物不完整"
        : !hasArtifactFingerprint
          ? "候选内部审核没有绑定完整产物指纹"
        : !hasQualityEvidence
          ? "候选缺少可验证的项目内部质量证据"
          : passed
            ? "项目内部质量证据未发现 blocker 或 major"
            : "项目内部质量证据仍有 blocker 或 major",
      checkedAt: Date.now(),
    },
  };
}

function externalReviewPasses(change: RuntimeChange): boolean {
  const review = latestExternalReview(change);
  const lastPatchAt = change.patches?.at(-1)?.patchedAt ?? 0;
  const hasBlockingIssue = review?.issues.some((issue) => issue.severity === "blocker" || issue.severity === "major") ?? false;
  return review?.verdict === "passed" && !hasBlockingIssue && review.reviewedAt >= lastPatchAt;
}

type Listener = (event: RuntimeEvent) => void;

export function recoverInterruptedOperation(operation: RuntimeOperation, now = Date.now()): RuntimeOperation {
  if (operation.status !== "running") return operation;
  return {
    ...operation,
    status: "queued",
    leaseExpiresAt: undefined,
    input: { ...operation.input, runtimeRecovery: true },
    updatedAt: now,
  };
}

function normalizeOperation(operation: RuntimeOperation): RuntimeOperation {
  const driver = operation.driver ?? "external-mcp";
  return { ...runtimePolicies(driver), ...operation, driver };
}

interface RecoverablePlanWork {
  id: string;
  status: string;
  taskKey?: string;
  dependsOn: string[];
}

export function selectNextPlanWork(workItems: RecoverablePlanWork[]): RecoverablePlanWork | undefined {
  const waitingReview = workItems.find((work) => work.status === "waiting-review");
  if (waitingReview) return waitingReview;
  const completed = new Set(workItems.filter((work) => work.status === "completed").map((work) => work.id));
  return workItems.find((work) => work.status === "queued" && work.dependsOn.every((id) => completed.has(id)));
}

export function buildRuntimeRevisionInstruction(note: string, artifact: unknown): string {
  const reviewNote = note.trim() || "根据本轮审核意见重做当前候选";
  const envelope = artifact as { kind?: unknown; value?: { items?: unknown[] } } | undefined;
  const items = envelope?.kind === "proposal" && Array.isArray(envelope.value?.items) ? envelope.value.items : [];
  if (items.length <= 1) return reviewNote;
  const previousItems = items.map((raw) => {
    const item = raw as Record<string, unknown>;
    return {
      label: item.label,
      targetTable: item.targetTable,
      targetId: item.targetId,
      tempId: item.tempId,
      payload: item.payload,
      rationale: item.rationale,
    };
  });
  return `${reviewNote}\n\n# 多项候选修订协议\n本轮输出会完整替代上一版候选，不是增量补丁。必须返回修订后的全量候选集合：保留审核意见未要求删除的既有项，并在完整集合中执行新增、删除或修改；不得只返回新增项。\n\n# 上一版候选集合\n${JSON.stringify(previousItems, null, 2)}`;
}

export class NovelCreationEngine {
  private readonly emitter = new EventEmitter();
  private readonly projectQueues = new Map<string, Promise<void>>();
  private initialized = false;
  private shuttingDown = false;

  constructor(readonly store: NovelStore) {
    setNovelApiConfigProvider(() => {
      const saved = this.store.getSetting<{ baseUrl?: string; apiKey?: string; modelContextWindow?: number }>("apiConfig") ?? {};
      return {
        baseUrl: saved.baseUrl?.trim() || process.env.YMCP_API_BASE_URL || "https://gpt.eromaa.com/v1",
        apiKey: saved.apiKey?.trim() || process.env.YMCP_API_KEY || "",
        modelContextWindow: Number(saved.modelContextWindow ?? process.env.YMCP_MODEL_CONTEXT_WINDOW ?? 0),
      };
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.hydrate(novelDb);
    const now = Date.now();
    for (const storedOperation of this.store.listOperations()) {
      const normalized = normalizeOperation(storedOperation);
      const operation = recoverInterruptedOperation(normalized, now);
      if (JSON.stringify(operation) !== JSON.stringify(storedOperation)) this.store.putOperation(operation);
      if (operation.status === "queued") this.schedule(operation.id);
    }
    this.initialized = true;
  }

  subscribe(listener: Listener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  prepareForShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const now = Date.now();
    for (const stored of this.store.listOperations()) {
      if (stored.status !== "running") continue;
      this.store.putOperation(recoverInterruptedOperation(normalizeOperation(stored), now));
    }
  }

  private emit(type: string, payload: Record<string, unknown>, projectId?: string, operationId?: string): RuntimeEvent {
    const event = this.store.appendEvent({ type, payload, projectId, operationId, createdAt: Date.now() });
    this.emitter.emit("event", event);
    return event;
  }

  async listProjects(): Promise<RuntimeProjectSummary[]> {
    const projects = await novelDb.projects.orderBy("updatedAt").reverse().toArray();
    return projects.map((project) => ({ id: project.id, title: project.title, premise: project.premise, genre: project.genre, status: project.status, updatedAt: project.updatedAt }));
  }

  async createProject(input: { title: string; premise: string; genre: string[] }, requestKey: string): Promise<RuntimeProjectSummary> {
    const result = await executeCreativeTool("novel_project_create", { ...input, idempotencyKey: requestKey });
    const project = result.result as { id: string; title: string; premise: string; genre: string[]; status: string; updatedAt?: number };
    await this.store.flushProject(novelDb, project.id);
    this.emit("project.created", { projectId: project.id }, project.id);
    return { ...project, updatedAt: project.updatedAt ?? Date.now() };
  }

  async getProject(projectId: string) {
    const project = await novelDb.projects.get(projectId);
    if (!project) throw new Error("项目不存在");
    const documents = await novelDb.documents.where("projectId").equals(projectId).sortBy("order");
    return { project, documents };
  }

  getProjectSnapshot(projectId: string): RuntimeProjectSnapshot {
    const snapshot = this.store.getProjectSnapshot(projectId);
    if (projectId !== "__user__" && !(snapshot.records.projects ?? []).some((record) => record.id === projectId)) throw new Error("项目不存在");
    return snapshot;
  }

  async applyProjectMutation(command: RuntimeProjectMutationCommand, commandId: string): Promise<RuntimeProjectMutationResult> {
    if (!command.actor.id?.trim()) throw new Error("正式编辑命令必须携带 actor.id");
    if (command.actor.type === "external-llm" && !command.actor.model?.trim()) throw new Error("外部 LLM 正式编辑必须记录模型身份");
    if (command.projectId !== "__user__" && !this.store.getProjectSnapshot(command.projectId).records.projects?.length) throw new Error("项目不存在");
    return this.serialize(command.projectId, async () => {
      const result = this.store.applyProjectMutation(command, commandId);
      await this.store.restoreProject(novelDb, command.projectId);
      this.emit("project.records-mutated", { commandId, changed: result.changed }, command.projectId);
      return result;
    });
  }

  async deleteProject(projectId: string, actor: RuntimeActor, commandId: string) {
    if (actor.type !== "user" || !actor.id?.trim()) throw new Error("删除项目必须由有效用户 actor 发起");
    return this.serialize(projectId, async () => {
      this.store.deleteProject(projectId, commandId);
      await this.store.restoreProject(novelDb, projectId);
      this.emit("project.deleted", { projectId, actorId: actor.id });
      return { projectId, deleted: true };
    });
  }

  async deleteChapter(projectId: string, documentId: string, actor: RuntimeActor) {
    if (actor.type !== "user" || !actor.id?.trim()) throw new Error("删除章节必须由有效用户 actor 发起");
    return this.serialize(projectId, async () => {
      const document = await novelDb.documents.get(documentId);
      if (!document || document.projectId !== projectId) throw new Error("章节不存在或不属于当前项目");
      try {
        await deleteChapter(documentId);
        await this.store.flushProject(novelDb, projectId);
      } catch (error) {
        await this.store.restoreProject(novelDb, projectId).catch(() => undefined);
        throw error;
      }
      this.emit("project.chapter-deleted", { documentId, actorId: actor.id }, projectId);
      return { projectId, documentId, deleted: true };
    });
  }

  getStatus(projectId: string) {
    const operations = this.store.listOperations(projectId).map(normalizeOperation);
    const pendingChanges = this.store.listChanges(projectId, "pending");
    return {
      operations,
      pendingChanges,
      activeOperations: operations.filter((operation) => ["queued", "running", "awaiting_review"].includes(operation.status)),
      failedOperations: operations.filter((operation) => operation.status === "failed"),
      nextActions: operations.flatMap((operation) => runtimeNextActions(operation, pendingChanges.find((change) => change.operationId === operation.id))),
    };
  }

  enqueueIntent(input: { projectId: string; kind: NovelIntentKind; instruction: string; target?: string; taskKey?: string; driver: RuntimeDriver }, requestKey: string): RuntimeOperation {
    const duplicate = this.store.listOperations(input.projectId).find((operation) => operation.input.requestKey === requestKey);
    if (duplicate) return duplicate;
    const now = Date.now();
    const operation: RuntimeOperation = {
      id: randomUUID(),
      projectId: input.projectId,
      kind: input.kind,
      driver: input.driver,
      ...runtimePolicies(input.driver),
      status: "queued",
      input: { instruction: input.instruction, target: input.target, taskKey: input.taskKey, requestKey },
      baseSnapshotHash: this.store.snapshotHash(input.projectId),
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.store.putOperation(operation);
    this.emit("operation.queued", { kind: operation.kind }, operation.projectId, operation.id);
    this.schedule(operation.id);
    return operation;
  }

  getOperation(id: string, afterSequence = 0) {
    const stored = this.store.getOperation(id);
    const operation = stored ? normalizeOperation(stored) : undefined;
    if (!operation) throw new Error("创作 operation 不存在");
    const change = operation.currentChangeId ? this.store.getChange(operation.currentChangeId) : undefined;
    return { operation, change, nextActions: runtimeNextActions(operation, change), events: this.store.listEvents(afterSequence, operation.projectId).filter((event) => event.operationId === id) };
  }

  async getChangeDetails(id: string) {
    const change = this.store.getChange(id);
    if (!change) throw new Error("候选变更不存在");
    return { change, ...await this.describeChangeArtifact(change) };
  }

  private async describeChangeArtifact(change: RuntimeChange) {
    const operation = this.store.getOperation(change.operationId);
    let artifact: unknown;
    const artifactId = change.artifactRefs[0];
    if (artifactId && operation?.runId) {
      artifact = (await executeCreativeTool("novel_artifact_get", { projectId: change.projectId, runId: operation.runId, artifactId })).result;
    }
    const proposalItems = (artifact as { kind?: string; value?: { items?: Array<{ id?: string; payload?: unknown }> } } | undefined)?.kind === "proposal"
      ? (artifact as { value?: { items?: Array<{ id?: string; payload?: unknown }> } }).value?.items ?? []
      : [];
    const itemPayloadFingerprints = Object.fromEntries(proposalItems
      .filter((item): item is { id: string; payload?: unknown } => typeof item.id === "string" && Boolean(item.id))
      .map((item) => [item.id, fingerprint(item.payload)]));
    return { artifact, artifactFingerprint: fingerprint({ artifactRefs: change.artifactRefs, artifact }), itemPayloadFingerprints };
  }

  async revalidateChange(changeId: string, actor: RuntimeActor, artifactFingerprint: string) {
    const scopedChange = this.store.getChange(changeId);
    if (!scopedChange) throw new Error("候选变更不存在");
    return this.serialize(scopedChange.projectId, async () => {
      const change = this.store.getChange(changeId);
      const operation = change ? this.store.getOperation(change.operationId) : undefined;
      if (!change || change.status !== "pending" || !operation) throw new Error("候选变更已不可重新校验");
      assertRuntimeActor(normalizeOperation(operation), actor);
      const details = await this.getChangeDetails(changeId);
      if (details.artifactFingerprint !== artifactFingerprint) throw new Error("候选内容已变化，请重新读取完整候选后再校验");
      try {
        change.evidence = withInternalGate(await this.buildCandidateEvidence(normalizeOperation(operation), change.workItemId, change.artifactRefs));
        change.artifactFingerprint = details.artifactFingerprint;
        change.updatedAt = Date.now();
        await this.store.commitChangeState(novelDb, change);
      } catch (error) {
        await this.store.restoreProject(novelDb, change.projectId).catch(() => undefined);
        throw error;
      }
      this.emit("change.internal-revalidated", { changeId, passed: change.evidence.internalGate?.passed }, change.projectId, operation.id);
      return this.getChangeDetails(changeId);
    });
  }

  async patchChangeItem(input: {
    changeId: string;
    itemId: string;
    payload: Record<string, unknown>;
    actor: RuntimeActor;
    artifactFingerprint: string;
    expectedPayloadFingerprint: string;
    rationale: string;
    issueIds: string[];
    review: Omit<RuntimeExternalReview, "actor" | "reviewedAt">;
  }) {
    const scopedChange = this.store.getChange(input.changeId);
    if (!scopedChange) throw new Error("候选变更不存在");
    return this.serialize(scopedChange.projectId, async () => {
      const change = this.store.getChange(input.changeId);
      if (!change || change.status !== "pending") throw new Error("候选变更已不可编辑");
      const operation = this.store.getOperation(change.operationId);
      if (!operation) throw new Error("候选变更所属 operation 不存在");
      assertRuntimeActor(normalizeOperation(operation), input.actor);
      if (input.review.verdict !== "revise") throw new Error("局部补丁必须附带 revise 外部审核结论");
      const details = await this.getChangeDetails(input.changeId);
      if (details.artifactFingerprint !== input.artifactFingerprint) throw new Error("候选内容已变化，请重新读取完整候选后再局部修订");
      const envelope = details.artifact as { kind?: string; value?: { items?: Array<{ id?: string; payload?: Record<string, unknown> }> } } | undefined;
      const item = envelope?.kind === "proposal" ? envelope.value?.items?.find((candidate) => candidate.id === input.itemId) : undefined;
      if (!item?.payload) throw new Error("当前候选不包含可局部修订的 proposal item");
      if (fingerprint(item.payload) !== input.expectedPayloadFingerprint) throw new Error("候选项内容已变化，请重新读取候选后再局部修订");
      if (!input.rationale.trim() || !input.issueIds.length) throw new Error("局部修订必须说明理由并关联至少一个审核问题");
      const review: RuntimeExternalReview = { ...input.review, actor: input.actor, reviewedAt: Date.now() };
      if (review.artifactFingerprint !== input.artifactFingerprint) throw new Error("外部审核必须针对当前完整候选");
      const reviewIssueIds = new Set(review.issues.map((issue) => issue.id));
      if (input.issueIds.some((issueId) => !reviewIssueIds.has(issueId))) throw new Error("局部修订关联了当前外部审核中不存在的问题");
      let patch: RuntimePatchRecord;
      try {
        await updateProposalItemPayload(change.artifactRefs[0]!, input.itemId, input.payload);
        const patchedDetails = await this.getChangeDetails(input.changeId);
        patch = {
          itemId: input.itemId,
          expectedPayloadFingerprint: input.expectedPayloadFingerprint,
          rationale: input.rationale.trim(),
          issueIds: [...new Set(input.issueIds)],
          actor: input.actor,
          patchedAt: Date.now(),
        };
        change.externalReviews = [...(change.externalReviews ?? []), review];
        change.patches = [...(change.patches ?? []), patch];
        change.evidence = {
          ...(await this.buildCandidateEvidence(normalizeOperation(operation), change.workItemId, change.artifactRefs)),
          internalGate: { passed: false, reason: "局部补丁已改变候选，必须重新执行项目内部校验", checkedAt: Date.now() },
        };
        change.artifactFingerprint = patchedDetails.artifactFingerprint;
        change.updatedAt = Date.now();
        await this.store.commitChangeState(novelDb, change);
      } catch (error) {
        await this.store.restoreProject(novelDb, change.projectId).catch(() => undefined);
        throw error;
      }
      this.emit("change.item-patched", { changeId: change.id, itemId: input.itemId, issueIds: patch.issueIds, actorId: input.actor.id }, change.projectId, operation.id);
      return this.getChangeDetails(input.changeId);
    });
  }

  async updateChangeItem(changeId: string, itemId: string, payload: Record<string, unknown>, actor: RuntimeActor) {
    if (actor.type === "external-llm") throw new Error("外部 LLM 必须使用带内容指纹、审核理由和问题关联的候选补丁接口");
    const scopedChange = this.store.getChange(changeId);
    if (!scopedChange) throw new Error("候选变更不存在");
    return this.serialize(scopedChange.projectId, async () => {
      const change = this.store.getChange(changeId);
      if (!change || change.status !== "pending") throw new Error("候选变更已不可编辑");
      const operation = this.store.getOperation(change.operationId);
      if (!operation) throw new Error("候选变更所属 operation 不存在");
      assertRuntimeActor(normalizeOperation(operation), actor);
      const proposalId = change.artifactRefs[0];
      if (!proposalId) throw new Error("候选变更缺少 proposal artifact");
      try {
        await updateProposalItemPayload(proposalId, itemId, payload);
        const details = await this.getChangeDetails(changeId);
        change.artifactFingerprint = details.artifactFingerprint;
        change.evidence = {
          ...change.evidence,
          artifactFingerprint: details.artifactFingerprint,
          internalGate: { passed: false, reason: "候选内容已被人工修改，必须重新执行项目内部校验", checkedAt: Date.now() },
        };
        change.updatedAt = Date.now();
        await this.store.commitChangeState(novelDb, change);
      } catch (error) {
        await this.store.restoreProject(novelDb, change.projectId).catch(() => undefined);
        throw error;
      }
      this.emit("change.item-updated", { changeId, itemId, actorId: actor.id }, change.projectId, operation.id);
      return this.getChangeDetails(changeId);
    });
  }

  async reviewChange(
    changeId: string,
    decision: "accept" | "reject" | "revise",
    note: string,
    actor: RuntimeActor,
    _requestKey: string = randomUUID(),
    externalReview?: Omit<RuntimeExternalReview, "actor" | "reviewedAt">,
  ) {
    const scopedChange = this.store.getChange(changeId);
    if (!scopedChange) throw new Error("候选变更不存在");
    return this.serialize(scopedChange.projectId, async () => {
      const change = this.store.getChange(changeId);
      if (!change) throw new Error("候选变更不存在");
      if (change.status !== "pending") return { change, operation: this.store.getOperation(change.operationId) };
      const storedOperation = this.store.getOperation(change.operationId);
      const operation = storedOperation ? normalizeOperation(storedOperation) : undefined;
      if (!operation) throw new Error("候选变更所属 operation 不存在");
      assertRuntimeActor(operation, actor);
      let currentArtifactFingerprint: string | undefined;
      if (operation.driver === "external-mcp") {
        if (!externalReview) throw new Error("外部 MCP 审核必须提交结构化外部审核记录");
        if (!externalReview.reviewRunId.trim() || !externalReview.summary.trim()) throw new Error("外部审核缺少 reviewRunId 或摘要");
        const details = await this.getChangeDetails(changeId);
        currentArtifactFingerprint = details.artifactFingerprint;
        if (externalReview.artifactFingerprint !== details.artifactFingerprint) throw new Error("外部审核未基于当前完整候选，请重新读取候选后审核");
        if (decision === "accept" && externalReview.verdict !== "passed") throw new Error("接受候选必须使用 passed 外部审核结论");
        if (externalReview.verdict === "passed" && externalReview.issues.some((issue) => issue.severity === "blocker" || issue.severity === "major")) {
          throw new Error("passed 外部审核不能包含未解决的 blocker 或 major");
        }
        if (decision === "revise" && externalReview.verdict !== "revise") throw new Error("重生成候选必须使用 revise 外部审核结论");
        change.externalReviews = [...(change.externalReviews ?? []), { ...externalReview, actor, reviewedAt: Date.now() }];
        change.artifactFingerprint = details.artifactFingerprint;
        change.updatedAt = Date.now();
        this.store.putChange(change);
        this.emit("change.external-reviewed", { changeId, verdict: externalReview.verdict, reviewRunId: externalReview.reviewRunId, issueCount: externalReview.issues.length, learningConclusion: externalReview.learning.conclusion }, change.projectId, operation.id);
      }
      if (decision === "accept") {
        if (operation.driver === "external-mcp") {
          if (!internalEvidencePasses(change.evidence, currentArtifactFingerprint) || change.evidence.internalGate?.passed === false) {
            throw new Error(`项目内部审核门禁未通过：${change.evidence.internalGate?.reason ?? "候选仍有 blocker 或 major"}`);
          }
          if (!externalReviewPasses(change)) throw new Error("当前候选尚无通过的外部独立审核");
        }
        const currentHash = this.store.snapshotHash(change.projectId);
        if (currentHash !== change.baseSnapshotHash) {
          const error = new Error("正式项目已在候选生成后发生变化，请重新生成或修订候选");
          error.name = "SnapshotConflictError";
          throw error;
        }
        if (!operation.runId) throw new Error("候选变更缺少 runId");
        try {
          const submitted = await executeCreativeTool("novel_review_submit", {
            projectId: change.projectId,
            runId: operation.runId,
            workItemId: change.workItemId,
            idempotencyKey: `runtime-change:${change.id}:accept`,
            review: { subjectArtifactId: change.artifactRefs[0], reviewer: actor.type, verdict: "passed", summary: note || "候选已确认", issues: [] },
          });
          if (operation.driver === "external-mcp") {
            const result = submitted.result as { workStatus?: string; reviewGate?: { passed?: boolean } };
            if (result.workStatus !== "completed" || result.reviewGate?.passed !== true) {
              throw new Error("底层创作审核门未完成候选提交，不能将运行时 change 标记为 accepted");
            }
          }
          if (operation.driver === "human") {
            await executeCreativeTool("novel_action_execute", {
              projectId: change.projectId,
              runId: operation.runId,
              action: "work.accept",
              workItemId: change.workItemId,
              idempotencyKey: `runtime-change:${change.id}:human-accept`,
            });
          }
          change.status = "accepted";
          change.review = { decision, note, actor, reviewedAt: Date.now() };
          change.updatedAt = Date.now();
          operation.currentChangeId = undefined;
          operation.currentWorkItemId = undefined;
          operation.status = "queued";
          operation.updatedAt = Date.now();
          await this.store.commitAcceptedChange(novelDb, change, operation);
        } catch (error) {
          await this.store.restoreProject(novelDb, change.projectId).catch(() => undefined);
          throw error;
        }
        this.emit("change.accepted", { changeId }, change.projectId, operation.id);
        this.schedule(operation.id);
      } else if (decision === "revise") {
        if (!operation.runId) throw new Error("候选变更缺少 runId");
        let revisionInstruction = note || "根据本轮审核意见重做当前候选";
        const previousArtifactId = change.artifactRefs[0];
        if (previousArtifactId) {
          try {
            const previousArtifact = await executeCreativeTool("novel_artifact_get", {
              projectId: change.projectId,
              runId: operation.runId,
              artifactId: previousArtifactId,
            });
            revisionInstruction = buildRuntimeRevisionInstruction(revisionInstruction, previousArtifact.result);
          } catch {
            // The review can still proceed when an old artifact is unavailable.
          }
        }
        await executeCreativeTool("novel_action_execute", {
          projectId: change.projectId,
          runId: operation.runId,
          action: "work.revise",
          workItemId: change.workItemId,
          instruction: revisionInstruction,
          idempotencyKey: `runtime-change:${change.id}:revise`,
        });
        await this.store.flushProject(novelDb, change.projectId);
        change.status = "superseded";
        change.review = { decision, note, actor, reviewedAt: Date.now() };
        change.updatedAt = Date.now();
        this.store.putChange(change);
        operation.currentChangeId = undefined;
        operation.currentWorkItemId = undefined;
        operation.status = "queued";
        operation.updatedAt = Date.now();
        this.store.putOperation(operation);
        this.emit("change.superseded", { changeId, note, workItemId: change.workItemId }, change.projectId, operation.id);
        this.schedule(operation.id);
      } else {
        change.status = "rejected";
        change.review = { decision, note, actor, reviewedAt: Date.now() };
        change.updatedAt = Date.now();
        this.store.putChange(change);
        operation.status = "cancelled";
        operation.updatedAt = Date.now();
        operation.result = { decision, note };
        this.store.putOperation(operation);
        this.emit("change.rejected", { changeId, note }, change.projectId, operation.id);
      }
      return { change, operation: this.store.getOperation(operation.id) };
    });
  }

  async retryOperation(operationId: string, note: string, actor: RuntimeActor, includePreviousCandidate = true) {
    const scopedOperation = this.store.getOperation(operationId);
    if (!scopedOperation) throw new Error("operation 不存在");
    return this.serialize(scopedOperation.projectId, async () => {
      const storedOperation = this.store.getOperation(operationId);
      const operation = storedOperation ? normalizeOperation(storedOperation) : undefined;
      if (!operation) throw new Error("operation 不存在");
      assertRuntimeActor(operation, actor);
      if (operation.status !== "failed") throw new Error("只有失败的 operation 可以重试");
      // plan 与 write/revise 共享同一重试路径：若 operation 已有 runId，找到 run 内最近一次失败的
      // 工作项并调用 work.retry 将其重新排队，同时把 currentWorkItemId 指回该工作项。
      // 否则 processChapter 会因 runId 已存在但 currentWorkItemId 被清空而直接 complete，
      // 导致重试空转（不生成任何候选）。没有 runId 的 operation 走 runtimeRecovery 兜底。
      if (operation.runId) {
        const snapshot = await executeCreativeTool("novel_run_get", { projectId: operation.projectId, runId: operation.runId });
        const workItems = (snapshot.result as { workItems?: Array<{ id: string; status: string }> }).workItems ?? [];
        const failedWork = workItems.find((work) => work.status === "failed");
        if (!failedWork) throw new Error("运行没有可重试的失败工作项");
        let revisionInstruction = note.trim() || operation.error || "修正失败原因后重新生成完整候选";
        const previousChange = this.store.listChanges(operation.projectId)
          .filter((change) => change.operationId === operation.id && change.workItemId === failedWork.id && change.artifactRefs[0])
          .sort((left, right) => right.updatedAt - left.updatedAt)[0];
        if (includePreviousCandidate && previousChange?.artifactRefs[0]) {
          try {
            const previousArtifact = await executeCreativeTool("novel_artifact_get", {
              projectId: operation.projectId,
              runId: operation.runId,
              artifactId: previousChange.artifactRefs[0],
            });
            revisionInstruction = buildRuntimeRevisionInstruction(revisionInstruction, previousArtifact.result);
          } catch {
            // A failed operation remains retryable even if its prior artifact was retired.
          }
        }
        await executeCreativeTool("novel_action_execute", {
          projectId: operation.projectId,
          runId: operation.runId,
          action: "work.retry",
          workItemId: failedWork.id,
          instruction: revisionInstruction,
          idempotencyKey: `runtime-operation:${operation.id}:retry:${operation.attempt + 1}`,
        });
        await this.store.flushProject(novelDb, operation.projectId);
        operation.currentWorkItemId = failedWork.id;
      } else {
        operation.input = { ...operation.input, runtimeRecovery: true };
      }
      operation.status = "queued";
      operation.error = undefined;
      operation.currentChangeId = undefined;
      operation.leaseExpiresAt = undefined;
      operation.updatedAt = Date.now();
      this.store.putOperation(operation);
      this.emit("operation.retried", { note }, operation.projectId, operation.id);
      this.schedule(operation.id);
      return { operation: this.store.getOperation(operation.id) };
    });
  }

  async executeAdvanced(tool: CreativeToolName, args: Record<string, unknown>) {
    const scope = typeof args.projectId === "string" ? args.projectId : "__global__";
    return this.serialize(scope, async () => {
      const result = await executeCreativeTool(tool, args);
      const projectId = typeof args.projectId === "string" ? args.projectId : (result.result as { id?: string })?.id;
      if (projectId && await novelDb.projects.get(projectId)) await this.store.flushProject(novelDb, projectId);
      return result;
    });
  }

  async proposeImprovement(args: Record<string, unknown>) {
    return this.executeAdvanced("novel_rule_candidate_create", args);
  }

  async getImprovement(projectId: string, candidateId: string) {
    const result = await inspectCraftRuleCandidate(candidateId, novelDb);
    if (result.candidate.projectId !== projectId) throw new Error("规则候选不属于当前项目");
    return result;
  }

  async evaluateImprovement(input: { projectId: string; candidateId: string; scenarioClass: string; documentId?: string; taskKey?: string; instruction?: string }) {
    return this.serialize(input.projectId, async () => {
      const inspected = await this.getImprovement(input.projectId, input.candidateId);
      if (["promoted", "rolled-back"].includes(inspected.candidate.status)) throw new Error("规则候选已经结束，不能继续评测");
      if (!input.documentId && !input.taskKey) throw new Error("规则评测必须提供 documentId 或 taskKey");
      const candidate = input.documentId
        ? await evaluateCraftRuleOnChapter({ candidateId: input.candidateId, documentId: input.documentId, scenarioClass: input.scenarioClass }, {}, novelDb)
        : await evaluateCraftRuleOnFoundation({ candidateId: input.candidateId, taskKey: input.taskKey as Parameters<typeof evaluateCraftRuleOnFoundation>[0]["taskKey"], scenarioClass: input.scenarioClass, instruction: input.instruction }, {}, novelDb);
      await this.store.flushProject(novelDb, input.projectId);
      this.emit("improvement.evaluated", { candidateId: candidate.id, status: candidate.status, scenarioClass: input.scenarioClass }, input.projectId);
      return inspectCraftRuleCandidate(candidate.id, novelDb);
    });
  }

  async reviewImprovement(args: Record<string, unknown>) {
    const result = await this.executeAdvanced("novel_rule_review_submit", args);
    const candidateId = typeof args.candidateId === "string" ? args.candidateId : undefined;
    const projectId = typeof args.projectId === "string" ? args.projectId : undefined;
    if (!candidateId || !projectId) return result;
    const inspected = await this.getImprovement(projectId, candidateId);
    if (!inspected.gate.ready || inspected.candidate.status !== "ready") return result;
    const promoted = await this.executeAdvanced("novel_rule_promote", { projectId, candidateId, idempotencyKey: `runtime-auto-promote:${candidateId}:${inspected.candidate.proposedVersion}` });
    this.emit("improvement.auto-promoted", { candidateId, promotedRecordId: (promoted.result as { candidate?: { promotedRecordId?: string } })?.candidate?.promotedRecordId }, projectId);
    return promoted;
  }

  async promoteImprovement(args: Record<string, unknown>) {
    return this.executeAdvanced("novel_rule_promote", args);
  }

  async rollbackImprovement(args: Record<string, unknown>) {
    return this.executeAdvanced("novel_rule_rollback", args);
  }

  updateApiConfig(config: { baseUrl?: string; apiKey?: string; modelContextWindow?: number }) {
    const current = this.store.getSetting<Record<string, unknown>>("apiConfig") ?? {};
    this.store.setSetting("apiConfig", { ...current, ...config });
    return { baseUrl: config.baseUrl, hasApiKey: Boolean(config.apiKey || current.apiKey), modelContextWindow: config.modelContextWindow ?? current.modelContextWindow ?? 0 };
  }

  announceMigration(result: { projectIds: string[]; backupPath: string }) {
    this.emit("migration.completed", result as unknown as Record<string, unknown>);
  }

  private schedule(operationId: string) {
    if (this.shuttingDown) return;
    const operation = this.store.getOperation(operationId);
    if (!operation) return;
    queueMicrotask(() => { void this.serialize(operation.projectId, () => this.process(operationId)); });
  }

  private serialize<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const queue = this.projectQueues.get(projectId) ?? Promise.resolve();
    const result = queue.then(task, task);
    const settled = result.then(() => undefined, () => undefined);
    this.projectQueues.set(projectId, settled);
    void settled.finally(() => {
      if (this.projectQueues.get(projectId) === settled) this.projectQueues.delete(projectId);
    });
    return result;
  }

  private async process(operationId: string): Promise<void> {
    if (this.shuttingDown) return;
    const operation = this.store.getOperation(operationId);
    if (!operation || operation.status !== "queued") return;
    operation.status = "running";
    operation.attempt += 1;
    operation.leaseExpiresAt = Date.now() + OPERATION_LEASE_MS;
    operation.updatedAt = Date.now();
    this.store.putOperation(operation);
    this.emit("operation.started", { attempt: operation.attempt }, operation.projectId, operation.id);
    try {
      if (operation.kind === "plan") await this.processPlan(operation);
      else await this.processChapter(operation);
    } catch (error) {
      if (this.shuttingDown) return;
      operation.status = "failed";
      operation.error = error instanceof Error ? error.message : String(error);
      operation.leaseExpiresAt = undefined;
      operation.updatedAt = Date.now();
      this.store.putOperation(operation);
      await this.store.flushProject(novelDb, operation.projectId).catch(() => undefined);
      this.emit("operation.failed", { error: operation.error }, operation.projectId, operation.id);
    }
  }

  private async processPlan(operation: RuntimeOperation): Promise<void> {
    const taskKey = typeof operation.input.taskKey === "string" ? operation.input.taskKey : undefined;
    if (taskKey) {
      if (!operation.runId) {
        const created = await executeCreativeTool("novel_run_create", { projectId: operation.projectId, objective: operation.input.instruction, mode: operation.driver === "human" ? "manual" : "external", idempotencyKey: `${operation.id}:run` });
        operation.runId = (created.result as { run: { id: string } }).run.id;
        const enqueued = await executeCreativeTool("novel_action_execute", {
          projectId: operation.projectId,
          runId: operation.runId,
          action: "work.enqueue",
          idempotencyKey: `${operation.id}:enqueue`,
          work: { kind: "generation", taskKey, targetId: typeof operation.input.target === "string" ? operation.input.target : undefined, instruction: operation.input.instruction, parameters: { intent: operation.kind } },
        });
        operation.currentWorkItemId = (enqueued.result as { work: { id: string } }).work.id;
        await this.store.flushProject(novelDb, operation.projectId);
        operation.updatedAt = Date.now();
        this.store.putOperation(operation);
      }
      if (!operation.currentWorkItemId) return this.complete(operation, { runId: operation.runId });
      return this.startWork(operation, operation.currentWorkItemId, taskKey);
    }
    if (!operation.runId) {
      const bootstrap = await executeCreativeTool("novel_bootstrap_run", {
        projectId: operation.projectId,
        idempotencyKey: `${operation.id}:bootstrap`,
        objective: operation.input.instruction,
        includeChapterPlan: true,
        mode: operation.driver === "human" ? "manual" : "external",
      });
      operation.runId = (bootstrap.result as { run: { id: string } }).run.id;
      await this.store.flushProject(novelDb, operation.projectId);
      operation.updatedAt = Date.now();
      this.store.putOperation(operation);
    }
    let snapshot = await executeCreativeTool("novel_run_get", { projectId: operation.projectId, runId: operation.runId });
    let workItems = (snapshot.result as { workItems: Array<{ id: string; status: string; taskKey?: string; dependsOn: string[]; artifactRefs: string[]; summary?: string; leaseExpiresAt?: number }> }).workItems;
    const expired = workItems.find((work) => work.status === "running" && (operation.input.runtimeRecovery === true || (work.leaseExpiresAt ?? 0) <= Date.now()));
    if (expired) {
      await executeCreativeTool("novel_action_execute", { projectId: operation.projectId, runId: operation.runId, action: "work.recover", workItemId: expired.id, force: operation.input.runtimeRecovery === true, idempotencyKey: `${operation.id}:recover:${expired.id}:${operation.attempt}` });
      operation.input = { ...operation.input, runtimeRecovery: false };
      this.store.putOperation(operation);
      snapshot = await executeCreativeTool("novel_run_get", { projectId: operation.projectId, runId: operation.runId });
      workItems = (snapshot.result as { workItems: typeof workItems }).workItems;
    }
    const next = selectNextPlanWork(workItems);
    if (!next) {
      if (workItems.every((work) => work.status === "completed" || work.status === "cancelled")) return this.complete(operation, { runId: operation.runId });
      throw new Error("规划运行没有可执行工作，可能存在未处理的审核或依赖错误");
    }
    await this.startWork(operation, next.id, next.taskKey ?? "规划候选");
  }

  private async processChapter(operation: RuntimeOperation): Promise<void> {
    if (!operation.runId) {
      const documents = await novelDb.documents.where("projectId").equals(operation.projectId).sortBy("order");
      const target = String(operation.input.target ?? "next");
      const document = target === "next"
        ? documents.find((candidate) => candidate.status !== "final") ?? documents[documents.length - 1]
        : documents.find((candidate) => candidate.id === target || candidate.title === target);
      if (!document) throw new Error("没有可写作的章节，请先完成规划并生成章节蓝图");
      const created = await executeCreativeTool("novel_run_create", { projectId: operation.projectId, objective: operation.input.instruction, mode: operation.driver === "human" ? "manual" : "external", idempotencyKey: `${operation.id}:run` });
      operation.runId = (created.result as { run: { id: string } }).run.id;
      const enqueued = await executeCreativeTool("novel_action_execute", {
        projectId: operation.projectId,
        runId: operation.runId,
        action: "work.enqueue",
        idempotencyKey: `${operation.id}:enqueue`,
        work: { kind: "chapter-workflow", targetId: document.id, instruction: operation.input.instruction, parameters: { intent: operation.kind } },
      });
      operation.currentWorkItemId = (enqueued.result as { work: { id: string } }).work.id;
      await this.store.flushProject(novelDb, operation.projectId);
      operation.updatedAt = Date.now();
      this.store.putOperation(operation);
    }
    if (!operation.currentWorkItemId) {
      // After a revise decision, reviewChange clears currentWorkItemId but the work item
      // was re-opened by work.revise (status goes from waiting-review to queued).
      // Without looking up the run's work items, processChapter would immediately complete
      // the operation without processing the revised work item, leaving the revision
      // candidate unreviewed and the chapter content empty.
      if (!operation.runId) return this.complete(operation, { runId: operation.runId });
      const snapshot = await executeCreativeTool("novel_run_get", { projectId: operation.projectId, runId: operation.runId });
      const workItems = (snapshot.result as { workItems: Array<{ id: string; status: string }> }).workItems;
      const resumable = workItems.find((work) => work.status === "queued" || work.status === "running" || work.status === "waiting-review");
      if (!resumable) return this.complete(operation, { runId: operation.runId });
      operation.currentWorkItemId = resumable.id;
      operation.updatedAt = Date.now();
      this.store.putOperation(operation);
    }
    await this.startWork(operation, operation.currentWorkItemId, operation.kind === "write" ? "章节写作候选" : "章节修订候选");
  }

  private async startWork(operation: RuntimeOperation, workItemId: string, title: string): Promise<void> {
    if (!operation.runId) throw new Error("operation 缺少 runId");
    const snapshot = await executeCreativeTool("novel_run_get", { projectId: operation.projectId, runId: operation.runId });
    let work = (snapshot.result as { workItems: Array<{ id: string; status: string; artifactRefs: string[]; summary?: string; leaseExpiresAt?: number }> }).workItems.find((item) => item.id === workItemId);
    if (!work) throw new Error("operation 工作项不存在");
    if (work.status === "running" && (operation.input.runtimeRecovery === true || (work.leaseExpiresAt ?? 0) <= Date.now())) {
      await executeCreativeTool("novel_action_execute", { projectId: operation.projectId, runId: operation.runId, action: "work.recover", workItemId, force: operation.input.runtimeRecovery === true, idempotencyKey: `${operation.id}:recover:${workItemId}:${operation.attempt}` });
      operation.input = { ...operation.input, runtimeRecovery: false };
      this.store.putOperation(operation);
      work = { ...work, status: "queued" };
    }
    const result = work.status === "waiting-review"
      ? { result: { artifactRefs: work.artifactRefs, summary: work.summary, workStatus: work.status } }
      : await executeCreativeTool("novel_action_execute", {
        projectId: operation.projectId,
        runId: operation.runId,
        action: "work.start",
        workItemId,
        idempotencyKey: `${operation.id}:start:${workItemId}:${operation.attempt}`,
      });
    await this.store.flushProject(novelDb, operation.projectId);
    const action = result.result as { artifactRefs?: string[]; summary?: string; workStatus?: string };
    if (action.workStatus !== "waiting-review") throw new Error(action.summary || "工作项未进入待审核状态");
    const now = Date.now();
    const existingChange = this.store.listChanges(operation.projectId, "pending")
      .find((change) => change.operationId === operation.id && change.workItemId === workItemId);
    if (existingChange) {
      operation.status = "awaiting_review";
      operation.currentWorkItemId = workItemId;
      operation.currentChangeId = existingChange.id;
      operation.leaseExpiresAt = undefined;
      operation.updatedAt = now;
      this.store.putOperation(operation);
      return;
    }
    const evidence = withInternalGate(await this.buildCandidateEvidence(operation, workItemId, action.artifactRefs ?? []));
    const change: RuntimeChange = {
      id: randomUUID(), operationId: operation.id, projectId: operation.projectId, workItemId,
      artifactRefs: action.artifactRefs ?? [], title, summary: action.summary ?? title, status: "pending",
      evidence,
      baseSnapshotHash: this.store.snapshotHash(operation.projectId), createdAt: now, updatedAt: now,
    };
    change.artifactFingerprint = evidence.artifactFingerprint;
    operation.status = "awaiting_review";
    operation.currentWorkItemId = workItemId;
    operation.currentChangeId = change.id;
    operation.leaseExpiresAt = undefined;
    operation.updatedAt = now;
    try {
      await this.store.commitChangeState(novelDb, change, operation);
    } catch (error) {
      await this.store.restoreProject(novelDb, operation.projectId).catch(() => undefined);
      throw error;
    }
    this.emit("change.pending", { changeId: change.id, title, artifactRefs: change.artifactRefs }, operation.projectId, operation.id);
  }

  private async buildCandidateEvidence(operation: RuntimeOperation, workItemId: string, artifactRefs: string[]): Promise<RuntimeCandidateEvidence> {
    const fallback: RuntimeCandidateEvidence = { complete: artifactRefs.length > 0, openIssues: [], iteration: 0, maxIterations: operation.reviewPolicy.maxIterations };
    if (!operation.runId || !artifactRefs[0]) return fallback;
    try {
      const artifactEnvelope = await executeCreativeTool("novel_artifact_get", {
        projectId: operation.projectId,
        runId: operation.runId,
        artifactId: artifactRefs[0],
      });
      const artifact = artifactEnvelope.result as { kind?: string; value?: Record<string, unknown> };
      const artifactFingerprint = fingerprint({ artifactRefs, artifact });
      await executeCreativeTool("novel_action_execute", {
        projectId: operation.projectId,
        runId: operation.runId,
        action: "review.request",
        workItemId,
        idempotencyKey: `runtime-internal-review:${workItemId}:${artifactFingerprint}`,
      });
      const runEnvelope = await executeCreativeTool("novel_run_get", { projectId: operation.projectId, runId: operation.runId });
      const internalReview = (runEnvelope.result as { reviews?: Array<{ workItemId: string; subjectArtifactId: string; reviewer: string; verdict: string; summary: string; issues: Array<{ severity: string; title: string }> }> }).reviews
        ?.filter((review) => review.workItemId === workItemId && review.subjectArtifactId === artifactRefs[0] && review.reviewer === "internal")
        .at(-1);
      const work = (runEnvelope.result as { workItems?: Array<{ id: string; iteration?: number }> }).workItems?.find((item) => item.id === workItemId);
      const quality = (artifact.value?.qualityEvidence ?? (artifact.value?.parameters as Record<string, unknown> | undefined)?.qualityEvidence) as Record<string, unknown> | undefined;
      const topIssues = Array.isArray(quality?.topIssues) ? quality.topIssues : [];
      const internalIssues = internalReview?.issues ?? [];
      const blockerCount = internalReview
        ? internalIssues.filter((issue) => issue.severity === "blocker").length
        : typeof quality?.blockerCount === "number" ? quality.blockerCount : undefined;
      let majorCount = internalReview
        ? internalIssues.filter((issue) => issue.severity === "major").length
        : typeof quality?.majorCount === "number" ? quality.majorCount : undefined;
      if (internalReview && internalReview.verdict !== "passed" && blockerCount === 0 && majorCount === 0) majorCount = 1;
      return {
        complete: Boolean(artifact.value),
        artifactFingerprint,
        artifactKind: artifact.kind,
        qualityScore: typeof quality?.weightedScore === "number" ? quality.weightedScore : undefined,
        blockerCount,
        majorCount,
        openIssues: internalReview
          ? [
              ...internalIssues.map((issue) => issue.title),
              ...(internalReview.verdict === "passed" || internalIssues.length ? [] : [internalReview.summary]),
            ]
          : topIssues.map((issue) => typeof issue === "string" ? issue : String((issue as { summary?: unknown }).summary ?? "候选存在未解决问题")),
        iteration: work?.iteration ?? 0,
        maxIterations: operation.reviewPolicy.maxIterations,
      };
    } catch {
      return fallback;
    }
  }

  private complete(operation: RuntimeOperation, result: Record<string, unknown>): void {
    operation.status = "completed";
    operation.result = result;
    operation.currentWorkItemId = undefined;
    operation.currentChangeId = undefined;
    operation.leaseExpiresAt = undefined;
    operation.updatedAt = Date.now();
    this.store.putOperation(operation);
    this.emit("operation.completed", result, operation.projectId, operation.id);
  }
}

export { NovelCreationEngine as NovelRuntimeService };
