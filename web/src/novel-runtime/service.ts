import "fake-indexeddb/auto";
import "./polyfills";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { deleteChapter, novelDb } from "../features/novel/db";
import { setNovelApiConfigProvider } from "../features/novel/api-config";
import { executeCreativeTool, type CreativeToolName } from "../features/novel/creative-tool-gateway";
import { updateProposalItemPayload, validateArchitectureHardConstraints, type ArchitectureConstraintIssue } from "../features/novel/generation";
import { captureChapterRuleReplay, captureFoundationRuleReplay, createCraftRuleCandidateFromLearning, evaluateCraftRuleOnChapter, evaluateCraftRuleOnFoundation, inspectCraftRuleCandidate } from "../features/novel/craft-rule-evolution";
import { retryFailedWorkflowLearning } from "../features/novel/learning";
import {
  assertRuntimeActor,
  isAdvisoryReview,
  internalEvidencePasses,
  latestExternalReview,
  runtimeNextActions,
  runtimePolicies,
  type RuntimeActor,
  type RuntimeCandidateEvidence,
  type RuntimeExternalReview,
  type RuntimePatchRecord,
  type RuntimeReviewIssue,
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
/** operation 层自动重试上限（仅针对 HTTP 5xx/upstream_error 等临时故障，非 assertRuntimeActor 等逻辑错误）。 */
const MAX_OPERATION_AUTO_RETRIES = 2;
/** operation 层自动重试退避基数（1s/2s），与 ai.ts 通用错误退避一致。 */
const OPERATION_RETRY_BASE_DELAY_MS = 1_000;

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * 判断 operation 层错误是否可自动重试。
 *
 * operation 层错误主要来自 executeCreativeTool 调用链（含 LLM 上游 API），
 * 错误信息可能包含 "HTTP 5xx"、"upstream_error"、"socket hang up" 等临时故障特征。
 * 逻辑错误（如 assertRuntimeActor 抛错、schema 校验失败）不在此列。
 */
function isRetryableOperationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 5\d\d|upstream_error|socket hang up|ECONNRESET|ENOTFOUND|fetch failed|terminated|AI 未返回有效内容/i.test(message);
}

/** 计算 operation 层自动重试退避延迟（1s/2s + jitter）。 */
function getOperationRetryDelay(attempt: number): number {
  const jitter = Math.random() * 500;
  return OPERATION_RETRY_BASE_DELAY_MS * 2 ** attempt + jitter;
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
  if (items.length <= 1) {
    // 根因修复（iter14 非确定性退步）：单项候选（如 architecture）此前直接返回 reviewNote，
    // 不包含前一候选的任何结构信息。LLM 重生成时看不到前一次的 powerCenters/phases/growthCurves，
    // 自然丢失已通过审核的结构强项（如 iter13 的第8个 powerCenter lingqi_origin_consciousness
    // 在 iter14 丢失，导致 feedbackLoops 引用悬空 → 连续 3 次结构约束失败）。
    // 修复：为单项候选生成"上一版结构摘要"，列出关键结构元素的 id/name，
    // 告诉 LLM 这些是已通过审核的结构强项，除非审核意见明确要求删除/修改，否则必须保留。
    // 判定信号：单项候选 revise/retry 后丢失前序已建模的结构元素 + review 未要求删除 → 非确定性退步。
    const structuralSummary = buildSingleItemStructuralSummary(items[0]);
    return structuralSummary ? `${reviewNote}\n\n${structuralSummary}` : reviewNote;
  }
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

/**
 * 为单项候选（如 architecture）生成"上一版结构摘要"。
 *
 * 提取 payload 中被其他字段引用的关键结构元素（powerCenters/growthCurves/phases）的 id/name，
 * 告诉 LLM 这些是已通过审核的结构强项，revise/retry 时必须保留除非审核意见明确要求删除。
 * 只提取 id/name 而非完整 payload，避免指令膨胀；完整 payload 已在 artifact 中可查。
 */
function buildSingleItemStructuralSummary(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  const payload = raw.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return null;

  const lines: string[] = [];

  // powerCenters：被 feedbackLoops.affectedCenters 和 longHorizonHooks.affectedCenters 引用
  const powerCenters = Array.isArray(payload.powerCenters) ? payload.powerCenters as Array<Record<string, unknown>> : [];
  if (powerCenters.length) {
    const centerList = powerCenters
      .map((center) => {
        const id = String(center.id ?? "").trim();
        const name = String(center.name ?? "").trim();
        return id && name ? `${id}（${name}）` : id || name;
      })
      .filter(Boolean);
    if (centerList.length) {
      lines.push(`- powerCenters（${centerList.length} 个，被 feedbackLoops/longHorizonHooks 的 affectedCenters 引用）：${centerList.join("、")}`);
    }
  }

  // growthCurves：被 phases.primaryCurveId 引用
  const growthCurves = Array.isArray(payload.growthCurves) ? payload.growthCurves as Array<Record<string, unknown>> : [];
  if (growthCurves.length) {
    const curveList = growthCurves
      .map((curve) => {
        const id = String(curve.id ?? "").trim();
        const kind = String(curve.kind ?? "").trim();
        const subject = String(curve.subject ?? "").trim();
        return id ? `${id}（kind=${kind || "?"}, subject=${subject || "?"}）` : "";
      })
      .filter(Boolean);
    if (curveList.length) {
      lines.push(`- growthCurves（${curveList.length} 条，被 phases.primaryCurveId 引用）：${curveList.join("、")}`);
    }
  }

  // phases：定义五幕结构 + 每幕已填充的结构化字段
  const phases = Array.isArray(payload.phases) ? payload.phases as Array<Record<string, unknown>> : [];
  if (phases.length) {
    const phaseList = phases
      .map((phase) => {
        const id = String(phase.id ?? "").trim();
        const title = String(phase.title ?? "").trim();
        const primaryCurveId = String(phase.primaryCurveId ?? "").trim();
        if (!id) return "";
        // 根因修复（iter15 发现）：结构摘要只列 phase id/title/primaryCurveId，
        // 不列每幕已填充的 romanceProgress/techGeneration/originTruthLayer，
        // 导致 LLM 看不到前序已填充的结构化字段 → 非确定性退步（romanceProgress 5/5→0）。
        // 修复：列出每幕已填充的结构化字段，标注为已通过审核必须保留。
        const filledFields: string[] = [];
        const rp = Array.isArray(phase.romanceProgress) ? phase.romanceProgress as Array<Record<string, unknown>> : [];
        if (rp.length) {
          const rpLines = rp.map((r) => {
            const lineId = String(r.romanceLineId ?? "").trim();
            const stage = String(r.relationshipStage ?? "").trim();
            return lineId ? `${lineId}(${stage})` : "";
          }).filter(Boolean);
          filledFields.push(`romanceProgress[${rpLines.join(";")}]`);
        }
        const tg = phase.techGeneration as Record<string, unknown> | undefined;
        if (tg && typeof tg === "object") {
          const tgName = String(tg.name ?? "").trim();
          const tgGen = String(tg.generation ?? "").trim();
          filledFields.push(`techGeneration(${tgGen}:${tgName})`);
        }
        const otl = phase.originTruthLayer as Record<string, unknown> | undefined;
        if (otl && typeof otl === "object") {
          const otlLayer = String(otl.layer ?? "").trim();
          const otlRev = String(otl.revelation ?? "").trim().slice(0, 30);
          filledFields.push(`originTruthLayer(L${otlLayer}:${otlRev})`);
        }
        const filledSuffix = filledFields.length ? `, 已填充: ${filledFields.join(" | ")}` : "";
        return `${id}（${title || "?"}, primaryCurveId=${primaryCurveId || "?"}${filledSuffix}）`;
      })
      .filter(Boolean);
    if (phaseList.length) {
      lines.push(`- phases（${phaseList.length} 幕，每幕的 primaryCurveId 引用 growthCurves.id；标注"已填充"的结构化字段必须保留除非审核要求删除）：${phaseList.join("、")}`);
    }
  }

  if (!lines.length) return null;
  return `# 上一版已通过审核的结构强项（必须保留除非审核意见明确要求删除/修改）\n以下结构元素已在上一版候选中建模并通过审核，被其他字段引用（如 feedbackLoops.affectedCenters 引用 powerCenters.id、phases.primaryCurveId 引用 growthCurves.id）。本轮重生成时必须保留这些结构元素的 id/name 与引用关系，除非审核意见明确要求删除或修改某一项。特别地，每幕 phases 中标注"已填充"的 romanceProgress/techGeneration/originTruthLayer 是前序已通过审核的结构化字段，必须原样保留或在此基础上深化，不得清零。若需新增结构元素，在保留既有元素的基础上追加；不得以"不得保留上一版"为由丢弃已通过审核的结构强项。\n${lines.join("\n")}`;
}

/**
 * 将外部审核 issues 格式化为可注入 revisionInstruction 的定向反馈文本。
 *
 * 根因修复：reviewChange 存储了 externalReview.issues（含字段级证据与修复建议），
 * 但 buildRuntimeRevisionInstruction 仅使用 note + 上一版 payload，issues 从未传入 LLM。
 * 这导致 LLM 在 regenerate 时只看到泛述 note，无法针对性修复 → 内容层无效循环。
 * 本函数把每个 issue 的 severity/dimension/evidenceField/title/evidence/suggestion
 * 格式化为 LLM 可直接执行的修复清单，注入 revisionInstruction。
 */
export function formatReviewIssuesForInstruction(issues: RuntimeReviewIssue[]): string {
  const lines = issues.map((issue, index) => {
    const severityTag = `[${issue.severity}]`;
    const fieldHint = issue.evidenceField ? ` (${issue.evidenceField})` : "";
    const quote = issue.evidenceQuote ? ` 当前值: "${truncateForInstruction(issue.evidenceQuote, 120)}"` : "";
    const evidence = issue.evidence ? `\n  证据: ${truncateForInstruction(issue.evidence, 200)}` : "";
    const suggestion = issue.suggestion ? `\n  修复: ${truncateForInstruction(issue.suggestion, 300)}` : "";
    return `${index + 1}. ${severityTag} ${issue.dimension}${fieldHint}: ${issue.title}${quote}${evidence}${suggestion}`;
  });
  // 根因修复 2（矛盾指令覆盖，iter13 发现）：work.revise/work.retry 把 baseInstruction（可能含
  // "不得保留上一版任何结构"等推倒重写指令）prepend 到 revisionInstruction，形成矛盾——
  // base 说"不得保留"，issues 说"恢复/保留/填充"。LLM 因 primacy effect 倾向遵循 base，
  // 导致非确定性退步（丢弃已通过审核的结构强项）+ 必填字段不填充。
  // 本段在 issues 前注入"优先级覆盖指令"，明确 issues 优先于 base 中的推倒重写指令。
  // 判定信号：base instruction 含"不得保留/全新重生成" + issues 含"恢复/保留/填充" +
  // LLM 丢弃前序结构 + 必填字段不填充。
  const precedenceOverride = `# 优先级覆盖指令（高于基础指令中的"不得保留/全新重生成"）\n以下外部审核具体意见的优先级高于基础指令中的任何"不得保留上一版/全新重生成/不得在上一版基础上微调"等推倒重写指令。对于审核意见明确要求"恢复/保留/填充"的字段，必须按要求填充或保留已通过审核的结构强项，不得以"不得保留上一版"为由丢弃。基础指令中的推倒重写要求仅适用于未被审核意见提及的字段——审核意见未提及的内容可以重新生成，但审核意见明确要求保留/恢复的内容必须保留/恢复。\n\n`;
  return `${precedenceOverride}# 外部审核具体意见（必须逐条修复）\n${lines.join("\n")}`;
}

function truncateForInstruction(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class NovelCreationEngine {
  private readonly emitter = new EventEmitter();
  private readonly projectQueues = new Map<string, Promise<void>>();
  private initialized = false;
  private shuttingDown = false;

  constructor(readonly store: NovelStore) {
    setNovelApiConfigProvider(() => {
      const saved = this.store.getSetting<{ baseUrl?: string; apiKey?: string; modelContextWindow?: number }>("apiConfig") ?? {};
      // TODO P1：默认 baseUrl 与 src/config/defaults.ts DEFAULT_BASE_URL、ai.ts DEV_PROXY_BASE_URL 三处硬编码同步；
      // 任一处变更会破坏 ai.ts endpoint() 字符串等式判定。应集中到单一 config 并由其他模块导入。
      return {
        baseUrl: saved.baseUrl?.trim() || process.env.YMCP_API_BASE_URL || "https://chat.yujin8.top/v1",
        apiKey: saved.apiKey?.trim() || process.env.YMCP_API_KEY || "",
        modelContextWindow: Number(saved.modelContextWindow ?? process.env.YMCP_MODEL_CONTEXT_WINDOW ?? 0),
      };
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.hydrate(novelDb);
    void retryFailedWorkflowLearning({ db: novelDb }).catch((error) => {
      console.warn("[novel-runtime] 恢复失败的 learning 任务失败", error);
    });
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

  private async persistReviewLearning(change: RuntimeChange, operation: RuntimeOperation, review: RuntimeExternalReview) {
    if (review.learning.conclusion === "propose-improvement"
      && (!review.learning.proposal.targetVersion || !review.learning.proposal.targetContentFingerprint)) {
      throw new Error("外部 learning 提案缺少审核时规则版本或内容指纹");
    }
    const learningFingerprint = fingerprint({ projectId: change.projectId, changeId: change.id, reviewRunId: review.reviewRunId, learning: review.learning });
    const work = await novelDb.creativeWorkItems.get(change.workItemId);
    const replay = work?.kind === "chapter-workflow" && work.targetId
      ? await captureChapterRuleReplay({ projectId: change.projectId, documentId: work.targetId, instruction: work.instruction, scenarioClass: `原失败场景:${operation.kind}` }, novelDb)
      : work?.kind === "generation" && work.taskKey && ["project-positioning", "architecture", "story-bible", "characters", "relations", "worldview"].includes(work.taskKey)
        ? await captureFoundationRuleReplay({ projectId: change.projectId, taskKey: work.taskKey as "project-positioning" | "architecture" | "story-bible" | "characters" | "relations" | "worldview", instruction: work.instruction, scenarioClass: `原失败场景:${operation.kind}` }, novelDb)
        : undefined;
    return createCraftRuleCandidateFromLearning({
      projectId: change.projectId,
      learning: review.learning,
      source: {
        kind: "external-review",
        fingerprint: learningFingerprint,
        operationId: operation.id,
        changeId: change.id,
        reviewRunId: review.reviewRunId,
        issueIds: review.issues.map((issue) => issue.id),
        autoPromote: operation.improvementPolicy.autoPromote,
        replay,
      },
    }, novelDb);
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
    // 1. requestKey 幂等去重（保留：相同请求键直接返回已有 operation）
    const duplicate = this.store.listOperations(input.projectId).find((operation) => operation.input.requestKey === requestKey);
    if (duplicate) return duplicate;
    // 2. instructionHash 去重：相同 instruction+target+taskKey 且仍在排队/审核中的 operation 不重复入队
    const instructionHash = fingerprint({ instruction: input.instruction, target: input.target ?? "", taskKey: input.taskKey ?? "", projectId: input.projectId });
    const instructionDuplicate = this.store.listOperations(input.projectId).find((operation) =>
      operation.instructionHash === instructionHash
      && (operation.status === "queued" || operation.status === "awaiting_review" || operation.status === "running"));
    if (instructionDuplicate) return instructionDuplicate;
    // 3. 收尾同类仍在 queued/awaiting_review 的旧 operation，避免孤儿堆积。
    //    running 状态保留——它通常很快进入 awaiting_review，下次重新发起时会被 supersede；
    //    若强行 cancel 可能与正在执行的 LLM 调用产生写回竞态。
    this.supersedeObsoleteOperations(input, `被新的 ${input.kind} 指令取代`);
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
      instructionHash,
      createdAt: now,
      updatedAt: now,
    };
    this.store.putOperation(operation);
    this.emit("operation.queued", { kind: operation.kind }, operation.projectId, operation.id);
    this.schedule(operation.id);
    return operation;
  }

  /**
   * 在重新发起同类 operation 前，把同 projectId+kind+target+taskKey 且仍处于
   * queued/awaiting_review 的旧 operation 收尾：旧 operation 标 cancelled，
   * 其当前 pending change 标 superseded（保留审核历史供回溯）。
   *
   * 设计权衡：
   * - 不动 running 状态——它通常几十秒内会进入 awaiting_review，下次重新发起时会被 supersede；
   *   强行 cancel 会与正在执行的 LLM 调用产生写回竞态（process 函数无乐观锁）。
   * - 通过 emit 事件让 UI 与 SSE 订阅方即时感知，避免依赖 10s 轮询。
   * - supersede 而非 reject：reject 会污染 learning 闭环的 reject 模式统计。
   * - review.decision 用 "superseded"（非 "revise"）：避免污染 learning 闭环的 revise 模式统计，
   *   "superseded" 语义是"被新候选取代"，与用户审核的 "revise"（重做）路径解耦。
   */
  private supersedeObsoleteOperations(input: { projectId: string; kind: NovelIntentKind; target?: string; taskKey?: string }, reason: string): void {
    // 标准化子任务标识：优先 taskKey（标准化字段），回退 target（历史数据曾用 target 塞入类别）。
    // 这样旧 op（taskKey=undefined, target="architecture"）与新 op（taskKey="architecture", target=undefined）
    // 能正确匹配为同类，触发 supersede 避免孤儿堆积。
    // 对 write/revise 类（taskKey 通常为空，target 是章节 ID），仍按 target 精确匹配。
    const inputTaskKey = input.taskKey ?? input.target;
    const obsolete = this.store.listOperations(input.projectId).filter((operation) =>
      operation.kind === input.kind
      && (operation.status === "queued" || operation.status === "awaiting_review")
      && (operation.input.taskKey ?? operation.input.target) === inputTaskKey);
    if (!obsolete.length) return;
    const now = Date.now();
    const actor: RuntimeActor = { type: "user", id: "runtime-supersede" };
    for (const operation of obsolete) {
      const pendingChange = operation.currentChangeId
        ? this.store.getChange(operation.currentChangeId)
        : undefined;
      if (pendingChange && pendingChange.status === "pending") {
        pendingChange.status = "superseded";
        pendingChange.review = { decision: "superseded", note: reason, actor, reviewedAt: now };
        pendingChange.updatedAt = now;
        this.store.putChange(pendingChange);
        this.emit("change.superseded", { changeId: pendingChange.id, note: reason, workItemId: pendingChange.workItemId, supersededBy: "newer-operation" }, operation.projectId, operation.id);
      }
      operation.status = "cancelled";
      operation.currentChangeId = undefined;
      operation.currentWorkItemId = undefined;
      operation.leaseExpiresAt = undefined;
      operation.result = { superseded: true, reason };
      operation.updatedAt = now;
      this.store.putOperation(operation);
      this.emit("operation.cancelled", { reason, supersededBy: "newer-operation" }, operation.projectId, operation.id);
    }
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
      let learningCandidateId: string | undefined;
      let learningError: string | undefined;
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
        try {
          learningCandidateId = (await this.persistReviewLearning(change, normalizeOperation(operation), review))?.id;
          review.learningCandidateId = learningCandidateId;
        } catch (error) {
          learningError = error instanceof Error ? error.message : "审核经验沉淀失败";
          review.learningError = learningError;
        }
        await this.store.commitChangeState(novelDb, change);
      } catch (error) {
        await this.store.restoreProject(novelDb, change.projectId).catch(() => undefined);
        throw error;
      }
      if (learningError) this.emit("change.learning-failed", { changeId: change.id, reviewRunId: review.reviewRunId, error: learningError }, change.projectId, operation.id);
      this.emit("change.item-patched", { changeId: change.id, itemId: input.itemId, issueIds: patch.issueIds, actorId: input.actor.id, learningCandidateId }, change.projectId, operation.id);
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
      let learningCandidateId: string | undefined;
      let learningError: string | undefined;
      // P1-3: advisory review 路径——external-llm 对 human driver operation 提交非约束性审核意见。
      // 不改变 operation.status（仍 awaiting_review），只把审核意见附加到 change.externalReviews，
      // user 仍保留最终决策权（accept/revise/reject 由 user actor 完成）。
      if (isAdvisoryReview(operation, actor)) {
        if (!externalReview) throw new Error("advisory review 必须提交结构化外部审核记录");
        if (!externalReview.reviewRunId.trim() || !externalReview.summary.trim()) throw new Error("外部审核缺少 reviewRunId 或摘要");
        if (decision !== "revise") throw new Error("advisory review 只能提交 revise 决策（非约束性意见），最终决策由 user 完成");
        const details = await this.getChangeDetails(changeId);
        if (externalReview.artifactFingerprint !== details.artifactFingerprint) throw new Error("外部审核未基于当前完整候选，请重新读取候选后审核");
        const persistedReview: RuntimeExternalReview = { ...externalReview, actor, reviewedAt: Date.now() };
        change.externalReviews = [...(change.externalReviews ?? []), persistedReview];
        change.artifactFingerprint = details.artifactFingerprint;
        change.updatedAt = Date.now();
        try {
          learningCandidateId = (await this.persistReviewLearning(change, operation, persistedReview))?.id;
        } catch (error) {
          learningError = error instanceof Error ? error.message : "审核经验沉淀失败";
          persistedReview.learningError = learningError;
        }
        persistedReview.learningCandidateId = learningCandidateId;
        this.store.putChange(change);
        await this.store.flushProject(novelDb, change.projectId).catch(() => undefined);
        if (learningError) this.emit("change.learning-failed", { changeId, reviewRunId: externalReview.reviewRunId, error: learningError }, change.projectId, operation.id);
        this.emit("change.advisory-reviewed", { changeId, verdict: externalReview.verdict, reviewRunId: externalReview.reviewRunId, issueCount: externalReview.issues.length, learningConclusion: externalReview.learning.conclusion, learningCandidateId, learningError }, change.projectId, operation.id);
        return { change, operation: this.store.getOperation(operation.id) };
      }
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
        const persistedReview: RuntimeExternalReview = { ...externalReview, actor, reviewedAt: Date.now() };
        change.externalReviews = [...(change.externalReviews ?? []), persistedReview];
        change.artifactFingerprint = details.artifactFingerprint;
        change.updatedAt = Date.now();
        try {
          learningCandidateId = (await this.persistReviewLearning(change, operation, persistedReview))?.id;
        } catch (error) {
          learningError = error instanceof Error ? error.message : "审核经验沉淀失败";
          persistedReview.learningError = learningError;
        }
        persistedReview.learningCandidateId = learningCandidateId;
        try {
          await this.store.commitChangeState(novelDb, change);
        } catch (error) {
          await this.store.restoreProject(novelDb, change.projectId).catch(() => undefined);
          throw error;
        }
        if (learningError) this.emit("change.learning-failed", { changeId, reviewRunId: externalReview.reviewRunId, error: learningError }, change.projectId, operation.id);
        this.emit("change.external-reviewed", { changeId, verdict: externalReview.verdict, reviewRunId: externalReview.reviewRunId, issueCount: externalReview.issues.length, learningConclusion: externalReview.learning.conclusion, learningCandidateId, learningError }, change.projectId, operation.id);
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
        // 根因修复：将外部审核的 issues（含字段级证据与修复建议）注入修订指令。
        // 此前 reviewChange 存储了 externalReview.issues 但 buildRuntimeRevisionInstruction
        // 仅用 note + 上一版 payload，issues 从未传入 LLM，导致内容层无效循环。
        if (externalReview?.issues?.length) {
          revisionInstruction = `${revisionInstruction}\n\n${formatReviewIssuesForInstruction(externalReview.issues)}`;
        }
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
        // 根因修复：保留 currentWorkItemId 指向被 revise 的工作项。
        // processPlan 的 taskKey 快速路径（L1082）检查 currentWorkItemId，为空时直接 complete operation
        // 而不执行 work.revise 重置的工作项。这与 retryOperation（L914）保留 failedWork.id 一致。
        // 判定信号：review=revise 后 attempt 在数毫秒内 completed 且无 change.pending 事件。
        operation.currentWorkItemId = change.workItemId;
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
        // 根因修复：retry 路径同样注入最近一次外部审核 issues，避免失败重试时丢失定向反馈。
        if (previousChange) {
          const latestReview = latestExternalReview(previousChange);
          if (latestReview?.issues?.length) {
            revisionInstruction = `${revisionInstruction}\n\n${formatReviewIssuesForInstruction(latestReview.issues)}`;
          }
        }
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
      operation.autoRetryCount = 0;
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
    if (inspected.candidate.learningSource?.autoPromote !== true) return result;
    const promoted = await this.executeAdvanced("novel_rule_promote", { projectId, candidateId, idempotencyKey: `runtime-auto-promote:${candidateId}:${inspected.candidate.proposedVersion}` });
    const promotedCandidate = (promoted.result as { candidate?: { status?: string; promotedRecordId?: string; promotionValidation?: unknown } })?.candidate;
    this.emit(promotedCandidate?.status === "promoted" ? "improvement.auto-promoted" : "improvement.auto-rolled-back", { candidateId, promotedRecordId: promotedCandidate?.promotedRecordId, promotionValidation: promotedCandidate?.promotionValidation }, projectId);
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      const autoRetryCount = operation.autoRetryCount ?? 0;
      // HTTP 5xx/upstream_error 等临时故障自动重试，避免用户手动 retryOperation
      if (isRetryableOperationError(error) && autoRetryCount < MAX_OPERATION_AUTO_RETRIES) {
        operation.status = "queued";
        operation.autoRetryCount = autoRetryCount + 1;
        operation.error = errorMessage;
        operation.leaseExpiresAt = undefined;
        // 临时故障常发生在 startWork 的 LLM 调用阶段，此时工作项已被 work.start 置为 "running"
        // 并取得 OPERATION_LEASE_MS（20 分钟）租约。若不重置，下一次 attempt 的 selectNextPlanWork
        // 会跳过 "running" 项 → 抛出"没有可执行工作"→ 形成自动重试无效循环（HTTP 500 → no-work → failed）。
        // 设 runtimeRecovery=true 让 processPlan 的 expired-work 恢复分支（无需等待租约过期）强制
        // work.recover 把卡住的 "running" 项重置回 "queued"，使其重新可被 selectNextPlanWork 选中。
        operation.input = { ...operation.input, runtimeRecovery: true };
        operation.updatedAt = Date.now();
        this.store.putOperation(operation);
        await this.store.flushProject(novelDb, operation.projectId).catch(() => undefined);
        const delay = getOperationRetryDelay(autoRetryCount);
        const reason = `临时故障自动重试 ${autoRetryCount + 1}/${MAX_OPERATION_AUTO_RETRIES}，${Math.round(delay)}ms 后重新入队：${errorMessage}`;
        this.emit("operation.auto-retry", { error: errorMessage, retryCount: autoRetryCount + 1, delay }, operation.projectId, operation.id);
        console.error(`[service.ts] operation ${operation.id} ${reason}`);
        setTimeout(() => this.schedule(operation.id), delay);
        return;
      }
      operation.status = "failed";
      operation.error = errorMessage;
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
    // 自动重试（runtimeRecovery=true）场景：work.start 的 LLM 调用失败时创意网关会把工作项标记为
    // "failed" 而非 "running"，work.recover 只处理 "running"。若不在此处用 work.retry 重新排队
    // "failed" 项，selectNextPlanWork 会跳过它 → 抛出"没有可执行工作"→ 自动重试无效循环。
    // 这与 retryOperation（L761-798）对失败 operation 的处理保持一致：找到 failed 项 → work.retry。
    // 注意：不传 instruction —— work.retry 在 instruction 为 undefined 时保留工作项既有 instruction
    //（由 retryOperation 构造的 revisionInstruction，含 formatReviewIssuesForInstruction + 保留指令）。
    // 若传 operation.input.instruction 会覆盖为 base instruction（可能含"不得保留上一版任何结构"等
    // 过时指令），丢失定向反馈与必须保留约束，导致非确定性退步。
    if (operation.input.runtimeRecovery === true) {
      const failedWork = workItems.find((work) => work.status === "failed");
      if (failedWork) {
        await executeCreativeTool("novel_action_execute", {
          projectId: operation.projectId, runId: operation.runId, action: "work.retry",
          workItemId: failedWork.id,
          idempotencyKey: `${operation.id}:auto-retry:${failedWork.id}:${operation.attempt}`,
        });
        operation.input = { ...operation.input, runtimeRecovery: false };
        this.store.putOperation(operation);
        snapshot = await executeCreativeTool("novel_run_get", { projectId: operation.projectId, runId: operation.runId });
        workItems = (snapshot.result as { workItems: typeof workItems }).workItems;
      }
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
      // review.request 可能因 work item 状态不匹配（如 patch 后未重置为 waiting-review）而失败，
      // 不应阻塞后续质量评估——继续从 run_get 获取已有审核结果或使用 artifact 的 qualityEvidence。
      try {
        await executeCreativeTool("novel_action_execute", {
          projectId: operation.projectId,
          runId: operation.runId,
          action: "review.request",
          workItemId,
          idempotencyKey: `runtime-internal-review:${workItemId}:${artifactFingerprint}`,
        });
      } catch {
        // review.request 失败不阻塞——已有审核结果仍可通过 run_get 获取
      }
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
      // 架构层硬约束语义校验：对 architecture task 的 payload 做结构化内容检查，
      // 拦截「形式满足 schema 但内容违反硬约束」的候选（如 turningPoint 是事件摘要）
      const taskKey = typeof operation.input.taskKey === "string" ? operation.input.taskKey : "";
      let archIssues: ArchitectureConstraintIssue[] = [];
      if (taskKey === "architecture") {
        const items = Array.isArray(artifact.value?.items) ? artifact.value.items as Array<Record<string, unknown>> : [];
        const archPayload = items[0]?.payload;
        if (archPayload && typeof archPayload === "object") {
          archIssues = validateArchitectureHardConstraints(archPayload as Record<string, unknown>);
        }
      }
      const archBlockerCount = archIssues.filter((i) => i.severity === "blocker").length;
      const archMajorCount = archIssues.filter((i) => i.severity === "major").length;
      const archIssueTitles = archIssues.map((i) => `${i.dimension}: ${i.title}`);
      return {
        complete: Boolean(artifact.value),
        artifactFingerprint,
        artifactKind: artifact.kind,
        qualityScore: typeof quality?.weightedScore === "number" ? quality.weightedScore : undefined,
        blockerCount: (blockerCount ?? 0) + archBlockerCount,
        majorCount: (majorCount ?? 0) + archMajorCount,
        openIssues: [
          ...(internalReview
            ? [
                ...internalIssues.map((issue) => issue.title),
                ...(internalReview.verdict === "passed" || internalIssues.length ? [] : [internalReview.summary]),
              ]
            : topIssues.map((issue) => typeof issue === "string" ? issue : String((issue as { summary?: unknown }).summary ?? "候选存在未解决问题"))),
          ...archIssueTitles,
        ],
        iteration: work?.iteration ?? 0,
        maxIterations: operation.reviewPolicy.maxIterations,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...fallback, openIssues: [`内部审核证据构建失败：${message}`] };
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
