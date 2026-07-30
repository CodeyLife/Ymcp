import { defineSignal, proxyActivities, setHandler, condition, patched } from "@temporalio/workflow";
import type { Artifact, CommitResult, ContextManifest, CreativeRun, CreativeReviewGate, CreativeWorkItem, ExecutionBlueprint, FactApprovalSummary, MemoryBundle, MemoryClaim, NovelIntent, PreflightPlan, PreflightProjectSnapshot, Review, ReviewIssue, RuntimeLearningAssessmentV2, SkillBundle, TaskAttemptRecord } from "../protocol";
import type { ChapterPlanningContext, StoryArcBundle } from "../application/story-arc";
import type { StoryArcReviewOutput } from "../prompts/story-arc";
import type { ReflectionOutput } from "../prompts/schemas";
import type { ReviewerRole } from "../prompts/chapter-review";
import type { ModelRoutingSnapshot, ModelTaskRecord } from "../model-routing";
import { finalizeChapterLifecycle, runChapterLifecycle } from "../application/chapter-lifecycle";
import type { BookSynopsisRecord, BookTitleCandidate, BookTitleCandidatesRecord } from "../application/book-synopsis";

function failureMessage(error: unknown): string {
  let current: unknown = error;
  let message = error instanceof Error ? error.message : String(error);
  const seen = new Set<unknown>();
  while (current instanceof Error && current.cause && !seen.has(current.cause)) {
    seen.add(current.cause);
    current = current.cause;
    message = current instanceof Error ? current.message : String(current);
  }
  return message;
}

/**
 * V2 章节工作流。
 *
 * 与 v1 [workflow.ts] 的章节生成流程等价，但走 Temporal durable execution。
 *
 * 流程：
 * 1. 加载项目快照 → 创建 preflight → 检索记忆 → 解析技能 → 加载全书规划产出(foundation artifacts) → 编译蓝图
 *    - drafting/revision 任务校验 foundation artifacts 包含必填 taskKey,缺失则抛 ApplicationFailure.nonRetryable
 * 2. 草稿生成(注入全书规划上下文到 prompt)
 * 3. 5 种 reviewer 并行审校（style/character/continuity/plot/reader）
 * 4. 多轮修订循环（最多 maxAutoRevisions=2 轮）
 * 5. 事实提取
 * 6. Learning assessment
 * 7. 提交（commit）
 *
 * 修订决策：见 [revision-policy.ts] decideRevision。
 * - blocker 必须修订
 * - major + 改善度 ≥ 0.15 继续修订
 * - 改善度 < 0.15 停止，避免无限循环
 */

export interface NovelWorkflowActivities {
  updateWorkflowStatus(input: { workflowId: string; status: string; payload?: Record<string, unknown> }): Promise<unknown>;
  loadProjectSnapshot(input: { projectId: string; targetDocumentId?: string }): Promise<PreflightProjectSnapshot>;
  createPreflight(input: { intent: NovelIntent; snapshot: PreflightProjectSnapshot }): Promise<PreflightPlan>;
  retrieveMemory(input: { projectId: string; plan: PreflightPlan }): Promise<MemoryBundle>;
  resolveSkills(input: { projectId: string; plan: PreflightPlan; memory: MemoryBundle; requestedCapabilities?: string[]; genre?: string }): Promise<SkillBundle>;
  resolveReviewSkills(input: { projectId: string; preflightId: string }): Promise<SkillBundle>;
  compileBlueprint(input: { intent: NovelIntent; plan: PreflightPlan; memory: MemoryBundle; skills: SkillBundle; snapshot: PreflightProjectSnapshot; foundationArtifacts?: Artifact[]; planningContext?: ChapterPlanningContext }): Promise<{ blueprint: ExecutionBlueprint; context: ContextManifest; routingSnapshot: ModelRoutingSnapshot }>;
  enforceMemoryCoverage(input: { projectId: string; workflowId: string; taskClass: PreflightPlan["taskClass"]; criticalMissingFacets: string[] }): Promise<{ consecutiveCriticalMisses: number; blocked: boolean }>;
  /**
   * 加载项目下所有 foundation artifacts(全书规划产出)。
   *
   * 设计依据:AGENTS.md「root-cause analysis」——v2 重构后 foundation artifacts 未被章节生成
   * 消费,导致章节生成不基于全书规划。此 activity 供 novelIntentWorkflow 加载规划产出,
   * 用于前置检查(必填 taskKey 清单)与 compileBlueprint/draft 注入。
   */
  listFoundationArtifacts(input: { projectId: string }): Promise<Artifact[]>;
  assertRequiredPlanApproved(input: { projectId: string }): Promise<void>;
  loadChapterPlanningContext(input: { projectId: string; documentId: string }): Promise<ChapterPlanningContext>;
  loadChapterPlanningContextSnapshot(input: { blueprintId: string }): Promise<ChapterPlanningContext | undefined>;
  expireExternalModelTask(input: { modelTaskId: string; reason: string }): Promise<void>;
  generateBookSynopsis(input: { workflowId: string; projectId: string; sourceFingerprint: string; candidateStartIndex?: number }): Promise<{ kind: "completed"; text: string } | { kind: "external"; task: ModelTaskRecord }>;
  materializeExternalBookSynopsis(input: { modelTaskId: string; value: unknown }): Promise<{ text: string }>;
  persistBookSynopsis(input: { projectId: string; sourceFingerprint: string; text: string }): Promise<BookSynopsisRecord>;
  generateBookTitleCandidates(input: { workflowId: string; projectId: string; sourceFingerprint: string; candidateStartIndex?: number }): Promise<{ kind: "completed"; candidates: BookTitleCandidate[] } | { kind: "external"; task: ModelTaskRecord }>;
  materializeExternalBookTitleCandidates(input: { modelTaskId: string; value: unknown }): Promise<{ candidates: BookTitleCandidate[] }>;
  persistBookTitleCandidates(input: { projectId: string; sourceFingerprint: string; candidates: BookTitleCandidate[] }): Promise<BookTitleCandidatesRecord>;
  generateChapterTitle(input: { workflowId: string; projectId: string; documentId: string; sourceFingerprint: string; candidateStartIndex?: number }): Promise<{ kind: "completed"; title: string } | { kind: "external"; task: ModelTaskRecord }>;
  materializeExternalChapterTitle(input: { modelTaskId: string; value: unknown }): Promise<{ title: string }>;
  persistGeneratedChapterTitle(input: { projectId: string; documentId: string; sourceFingerprint: string; title: string }): Promise<{ title: string }>;
  generateStoryArcBundle(input: { workflowId: string; projectId: string; arcId: string; authorIntent?: string; candidateStartIndex?: number; batchIndex?: number; startChapterIndex?: number }): Promise<{ kind: "completed"; artifact: Artifact; bundle: StoryArcBundle } | { kind: "external"; task: ModelTaskRecord }>;
  materializeExternalStoryArcBundle(input: { modelTaskId: string; projectId: string; arcId: string; value: unknown }): Promise<{ artifact: Artifact; bundle: StoryArcBundle }>;
  projectStoryArcBundle(input: { projectId: string; arcId: string; artifact: Artifact; bundle: StoryArcBundle; actor: string; edited?: boolean }): Promise<unknown>;
  reviewStoryArcBundle(input: { workflowId: string; projectId: string; arcId: string; artifact: Artifact; bundle: StoryArcBundle; candidateStartIndex?: number }): Promise<{ kind: "completed"; artifact: Artifact; review: StoryArcReviewOutput } | { kind: "external"; task: ModelTaskRecord }>;
  materializeExternalStoryArcReview(input: { modelTaskId: string; projectId: string; arcId: string; subjectArtifactId: string; value: unknown }): Promise<{ artifact: Artifact; review: StoryArcReviewOutput }>;
  reviseStoryArcBundle(input: { workflowId: string; projectId: string; arcId: string; artifact: Artifact; bundle: StoryArcBundle; review: StoryArcReviewOutput; candidateStartIndex?: number }): Promise<{ kind: "completed"; artifact: Artifact; bundle: StoryArcBundle } | { kind: "external"; task: ModelTaskRecord }>;
  approveStoryArcAutomatically(input: { projectId: string; arcId: string; artifactId: string }): Promise<unknown>;
  failStoryArc(input: { projectId: string; arcId: string; reason: string }): Promise<void>;
  failStoryArcBatch(input: { projectId: string; arcId: string; batchIndex: number; reason: string }): Promise<void>;
  recordWorkflowSignal(input: { workflowId: string; taskId: string; signal: string; payload?: Record<string, unknown> }): Promise<unknown>;
  updateTaskAttempt(input: { id: string; workflowRunId?: string; taskId: string; status: TaskAttemptRecord["status"]; payload?: Record<string, unknown> }): Promise<unknown>;
  draft(input: { workflowId: string; intent: NovelIntent; blueprint: ExecutionBlueprint; memory: MemoryBundle; skills: SkillBundle; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; foundationArtifacts?: Artifact[]; planningContext?: ChapterPlanningContext }): Promise<{ kind: "completed"; artifact: Artifact; text: string } | { kind: "external"; task: ModelTaskRecord }>;
  draftByRefs(input: { workflowId: string; intent: NovelIntent; blueprintId: string; memoryBundleId: string; skillBundleId: string; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; foundationArtifactIds?: string[] }): Promise<{ kind: "completed"; artifact: Artifact; text: string } | { kind: "external"; task: ModelTaskRecord }>;
  review(input: { workflowId: string; artifact: Artifact; text: string; blueprint: ExecutionBlueprint; memory: MemoryBundle; skills: SkillBundle; role: ReviewerRole; identity: "internal" | "independent"; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; narrativeOrder?: number; planningContext?: ChapterPlanningContext; suppressChapterSnapshotPromotion?: boolean }): Promise<{ kind: "completed"; review: Review } | { kind: "external"; task: ModelTaskRecord }>;
  reviewByRefs(input: { workflowId: string; artifactId: string; blueprintId: string; memoryBundleId: string; skillBundleId: string; role: ReviewerRole; identity: "internal" | "independent"; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; narrativeOrder?: number; suppressChapterSnapshotPromotion?: boolean }): Promise<{ kind: "completed"; review: Review } | { kind: "external"; task: ModelTaskRecord }>;
  revise(input: { workflowId: string; intent: NovelIntent; artifact: Artifact; text: string; reviews: Review[]; directedIssues?: ReviewIssue[]; strictRevisionWindows?: boolean; authorInstruction?: string; memory: MemoryBundle; blueprint: ExecutionBlueprint; skills: SkillBundle; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; planningContext?: ChapterPlanningContext }): Promise<{ kind: "completed"; artifact: Artifact; text: string } | { kind: "external"; task: ModelTaskRecord }>;
  reviseByRefs(input: { workflowId: string; intent: NovelIntent; artifactId: string; reviewIds: string[]; directedIssues?: ReviewIssue[]; strictRevisionWindows?: boolean; authorInstruction?: string; blueprintId: string; memoryBundleId: string; skillBundleId: string; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number }): Promise<{ kind: "completed"; artifact: Artifact; text: string } | { kind: "external"; task: ModelTaskRecord }>;
  materializeExternalText(input: { projectId: string; modelTaskId: string; text: string; kind: "draft" | "revision"; baseRevision: number }): Promise<{ artifact: Artifact; text: string }>;
  materializeExternalTargetedRevision(input: { projectId: string; modelTaskId: string; artifact: Artifact; text: string; issues: ReviewIssue[] }): Promise<{ artifact: Artifact; text: string }>;
  materializeExternalReview(input: { modelTaskId: string; artifact: Artifact; identity: "internal" | "independent"; role: ReviewerRole; value: unknown; suppressChapterSnapshotPromotion?: boolean }): Promise<Review>;
  extractFacts(input: { workflowId: string; projectId: string; artifact: Artifact; text: string; blueprint: ExecutionBlueprint; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; documentId?: string; narrativeOrder?: number }): Promise<{ kind: "completed"; artifact: Artifact } | { kind: "external"; task: ModelTaskRecord; artifact: Artifact }>;
  materializeExternalFacts(input: { modelTaskId: string; projectId: string; artifact: Artifact; text: string; documentId?: string; narrativeOrder?: number }): Promise<Artifact>;
  approveFacts(input: { workflowId: string; projectId: string; artifact: Artifact }): Promise<FactApprovalSummary>;
  /** P0 #1: 人工事实审批门通过后，批量批准 pending 事实候选（candidate → approved）。 */
  approveFactClaims(input: { projectId: string; ids: string[] }): Promise<MemoryClaim[]>;
  assessLearning(input: { projectId: string; workflowId: string; assessmentKey: string; artifact: Artifact; reviews: Review[]; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number }): Promise<{ kind: "completed"; assessment: RuntimeLearningAssessmentV2 } | { kind: "external"; task: ModelTaskRecord }>;
  materializeExternalLearning(input: { modelTaskId: string; projectId: string; workflowId: string; artifact: Artifact; reviews: Review[] }): Promise<RuntimeLearningAssessmentV2>;
  commit(input: { projectId: string; documentId: string; artifact: Artifact; factArtifact?: Artifact; narrativeOrder?: number; text: string; reviews: Review[]; baseRevision: number; idempotencyKey: string }): Promise<CommitResult>;
  commitAuthorApproved(input: { projectId: string; documentId: string; artifact: Artifact; factArtifact?: Artifact; narrativeOrder?: number; text: string; reviews: Review[]; baseRevision: number; idempotencyKey: string }): Promise<CommitResult>;
  // 角色富化 activity（C-2.5）：commit 之后执行，回写角色档案
  // 设计依据：AGENTS.md「commitStageHandler → characterEnrichmentStageHandler」契约
  enrichCharacters(input: { workflowId: string; projectId: string; documentId: string; revisionId: string; narrativeOrder: number; artifact: Artifact; factArtifact?: Artifact; text: string; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number }): Promise<{ kind: "completed"; result: { entityUpdates: number; knowledgeClaims: number; relationRecords: number } } | { kind: "external"; task: ModelTaskRecord }>;
  materializeExternalEnrichment(input: { modelTaskId: string; projectId: string; documentId: string; revisionId: string; narrativeOrder: number; artifact: Artifact; text: string }): Promise<{ entityUpdates: number; knowledgeClaims: number; relationRecords: number }>;
  // 章节审校工作流专用 activities（C-2.4）
  loadHistoricalBlueprint(input: { projectId: string; documentId: string }): Promise<{ blueprint: ExecutionBlueprint; artifactId: string }>;
  loadDocumentPlainText(input: { projectId: string; documentId: string }): Promise<{ plainText: string; contentHtml: string; wordCount: number; documentRevision: number; sourceRevisionId: string; artifactId?: string; contentHash: string }>;
  loadTargetedReviewIssues(input: { projectId: string; documentId: string; issueIds: string[] }): Promise<{ snapshotId: string; reviewedContentHash: string; fingerprints: string[]; issues: ReviewIssue[] }>;
  loadProposedDraft(input: { projectId: string; artifactId: string }): Promise<{ artifact: Artifact; text: string }>;
  createReviewDraft(input: { projectId: string; documentId: string; workflowId: string; sourceRevisionId: string; sourceArtifactId?: string; blueprint: ExecutionBlueprint; text: string; baseRevision: number }): Promise<Artifact>;
  getDefaultRoutingSnapshot(input: { projectId: string; documentId: string }): Promise<ModelRoutingSnapshot>;
  retrieveMemoryForReview(input: { projectId: string; documentId: string; blueprint: ExecutionBlueprint }): Promise<MemoryBundle>;
  // 章节反思（reflection）activities（Phase 2.4）
  // 设计依据：AGENTS.md「root-cause analysis」+ Phase 2.4 reflection 机制。
  // 在 draft 之后、runAllReviewers 之前执行，不产生 commit 证据，只优化 draft。
  reflectOnDraft(input: { workflowId: string; artifact: Artifact; text: string; blueprint: ExecutionBlueprint; memory: MemoryBundle; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; planningContext?: ChapterPlanningContext }): Promise<{ kind: "completed"; critique: ReflectionOutput["critique"]; artifact: Artifact } | { kind: "external"; task: ModelTaskRecord }>;
  materializeExternalReflection(input: { modelTaskId: string; artifact: Artifact; workflowId: string }): Promise<{ critique: ReflectionOutput["critique"]; artifact: Artifact }>;
}

export const claimSignal = defineSignal<[unknown]>("claim");
export const heartbeatSignal = defineSignal<[unknown]>("heartbeat");
export const artifactSignal = defineSignal<[unknown]>("artifact");
export const reviewSignal = defineSignal<[unknown]>("review");
export const failSignal = defineSignal<[unknown]>("fail");
export const humanSignal = defineSignal<[unknown]>("humanSignal");
export const storyArcApprovedSignal = defineSignal<[unknown]>("storyArcApproved");

type HumanDecision = { decision: "approve" | "reject" | "revise" | "abandon"; authorId: string; feedback?: string; revisionBase?: "current" | "previous"; approvedArtifactId?: string };

function parseHumanDecision(payload: unknown): HumanDecision | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const body = payload as Record<string, unknown>;
  if (body.decision !== "approve" && body.decision !== "reject" && body.decision !== "revise" && body.decision !== "abandon") return undefined;
  return {
    decision: body.decision,
    authorId: typeof body.authorId === "string" && body.authorId.trim() ? body.authorId.trim() : "web-author",
    feedback: typeof body.feedback === "string" && body.feedback.trim() ? body.feedback.trim() : undefined,
    revisionBase: body.revisionBase === "previous" ? "previous" : "current",
    approvedArtifactId: typeof body.approvedArtifactId === "string" && body.approvedArtifactId.trim()
      ? body.approvedArtifactId.trim()
      : typeof body.taskId === "string" && body.taskId.trim()
        ? body.taskId.trim()
        : undefined,
  };
}

const activities = proxyActivities<NovelWorkflowActivities>({
  startToCloseTimeout: "10 minutes",
  retry: {
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["NonRetryableModelTransportError"],
  },
});

/**
 * 5 种 reviewer role 与 identity 的映射。
 *
 * internal：plot-reviewer（蓝图覆盖）、continuity-reviewer（事实连续性）—— 关注可验证的结构性问题。
 * independent：style-reviewer（语言风格）、character-reviewer（人物声部）、reader-reviewer（追更体验）—— 关注主观体验。
 */
const INTERNAL_REVIEWERS: ReviewerRole[] = ["plot-reviewer", "continuity-reviewer"];
const INDEPENDENT_REVIEWERS: ReviewerRole[] = ["style-reviewer", "character-reviewer", "reader-reviewer"];

/**
 * 运行所有 5 种 reviewer 并返回 Review 列表。
 *
 * 容错策略：使用 Promise.allSettled 而非 Promise.all，单个 reviewer 失败（如 LLM empty-response）
 * 不阻塞其他 reviewer 提供修订反馈。失败的 reviewer 不生成伪回执，最终 commit gate
 * 会因缺失角色而进入人工队列，绝不会把部分审核当成完整五审。
 * 如果全部 reviewer 都失败，抛出最后一个错误（无法在 0 条 review 下做 revision 决策）。
 * 设计依据：单个调用失败不应丢失其他 reviewer 的反馈，但正式提交必须完整五审。
 */
async function runAllReviewers(params: { workflowId: string; blueprintId: string; runReview: (role: ReviewerRole, identity: "internal" | "independent") => Promise<Review> }): Promise<Review[]> {
  const { workflowId, blueprintId } = params;
  await activities.updateTaskAttempt({ id: `${blueprintId}:review:attempt-${Date.now()}`, workflowRunId: workflowId, taskId: `${blueprintId}:review`, status: "running", payload: { taskKind: "review" } });

  const internalResults = await Promise.allSettled(
    INTERNAL_REVIEWERS.map((role) => params.runReview(role, "internal")),
  );
  const independentResults = await Promise.allSettled(
    INDEPENDENT_REVIEWERS.map((role) => params.runReview(role, "independent")),
  );

  const allResults = [...internalResults, ...independentResults];
  const reviews: Review[] = [];
  let lastError: unknown;
  for (const result of allResults) {
    if (result.status === "fulfilled") {
      reviews.push(result.value);
    } else {
      lastError = result.reason;
      // 记录失败但不阻塞——其他 reviewer 的反馈仍可用于 revision
      await activities.updateWorkflowStatus({ workflowId, status: "running", payload: { stage: "review-partial-failure", error: result.reason instanceof Error ? result.reason.message : String(result.reason) } });
    }
  }

  if (reviews.length === 0) {
    throw lastError ?? new Error("所有 reviewer 均失败，无法继续 revision");
  }

  await activities.updateTaskAttempt({ id: `${blueprintId}:review:attempt-${Date.now()}`, workflowRunId: workflowId, taskId: `${blueprintId}:review`, status: "reviewed", payload: { reviewIds: reviews.map((review) => review.id), verdicts: reviews.map((review) => review.verdict), skippedCount: allResults.length - reviews.length } });
  return reviews;
}

export async function novelIntentWorkflow(intent: NovelIntent, workflowId = `novel-intent-${intent.id}`): Promise<ExecutionBlueprint> {
  const signals: Array<{ type: string; payload: unknown }> = [];
  const externalResults = new Map<string, Record<string, unknown>>();
  const externalFailures = new Map<string, Record<string, unknown>>();
  let humanDecision: HumanDecision | undefined;
  const persistSignal = async (type: string, payload: unknown) => {
    signals.push({ type, payload });
    const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    await activities.recordWorkflowSignal({ workflowId, taskId: typeof body.taskId === "string" ? body.taskId : `${workflowId}:external`, signal: type, payload: body });
  };
  setHandler(claimSignal, async (payload) => { await persistSignal("claim", payload); });
  setHandler(heartbeatSignal, async (payload) => { await persistSignal("heartbeat", payload); });
  setHandler(artifactSignal, async (payload) => {
    await persistSignal("artifact", payload);
    const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    if (typeof body.modelTaskId === "string") externalResults.set(body.modelTaskId, body);
  });
  setHandler(reviewSignal, async (payload) => { await persistSignal("review", payload); });
  setHandler(failSignal, async (payload) => {
    await persistSignal("fail", payload);
    const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    if (typeof body.modelTaskId === "string") externalFailures.set(body.modelTaskId, body);
  });
  setHandler(humanSignal, async (payload) => { await persistSignal("humanSignal", payload); humanDecision = parseHumanDecision(payload); });

  await activities.updateWorkflowStatus({ workflowId, status: "running" });
  try {
    const snapshot = await activities.loadProjectSnapshot({ projectId: intent.projectId, targetDocumentId: intent.target?.id });
    const plan = await activities.createPreflight({ intent, snapshot });
    const memory = await activities.retrieveMemory({ projectId: intent.projectId, plan });
    const skills = await activities.resolveSkills({ projectId: intent.projectId, plan, memory, requestedCapabilities: intent.requestedCapabilities, genre: snapshot.genre });
    // 加载全书规划产出(foundation artifacts)。
    // 设计依据:AGENTS.md「root-cause analysis」——v2 重构后 foundation artifacts 未被章节生成消费,
    // 导致章节生成不基于全书规划。此处在 compileBlueprint 之前加载规划产出,
    // 供前置检查(必填 taskKey 清单)与 compileBlueprint/draft 注入使用。
    const foundationArtifacts = await activities.listFoundationArtifacts({ projectId: intent.projectId });
    // 前置检查:仅 drafting/revision 任务需要校验全书规划完成度。
    // planning/foundation 任务本身是规划任务,不应被自己的前置检查阻塞。
    // HTTP /v2/intents 入口与 MCP novel_chapter_generate 入口都走这条 workflow,
    // 所以此处是"先规划再写章节"强约束的最终保障。
    let planningContext: ChapterPlanningContext | undefined;
    if (plan.taskClass === "drafting" || plan.taskClass === "revision") {
      await activities.assertRequiredPlanApproved({ projectId: intent.projectId });
      if (!intent.target?.id) throw new Error("章节生成缺少目标 documentId");
      planningContext = await activities.loadChapterPlanningContext({ projectId: intent.projectId, documentId: intent.target.id });
    }
    const { blueprint, routingSnapshot } = await activities.compileBlueprint({ intent, plan, memory, skills, snapshot, foundationArtifacts, planningContext });
    if (plan.taskClass === "drafting" || plan.taskClass === "revision") {
      const criticalMissingFacets = blueprint.memoryGate?.manualReviewFacets.filter((facet) => facet === "fact" || facet === "chapter-memory") ?? [];
      const memoryGateState = await activities.enforceMemoryCoverage({ projectId: intent.projectId, workflowId, taskClass: plan.taskClass, criticalMissingFacets });
      if (memoryGateState.blocked) throw new Error(`关键记忆连续 ${memoryGateState.consecutiveCriticalMisses} 次不完整，已阻断正文生成；请先重建记忆索引后重试`);
    }
    if (!intent.target?.id || plan.taskClass === "planning" || plan.taskClass === "foundation") {
      await activities.updateWorkflowStatus({ workflowId, status: "completed", payload: { blueprintId: blueprint.id, signalCount: signals.length } });
      return blueprint;
    }

    const waitForExternal = async (task: ModelTaskRecord): Promise<{ result?: Record<string, unknown>; failed: boolean }> => {
      const completed = await condition(() => externalResults.has(task.id) || externalFailures.has(task.id), "15 minutes");
      if (!completed) {
        await activities.expireExternalModelTask({ modelTaskId: task.id, reason: "外部模型任务等待超时" });
        return { failed: true };
      }
      if (externalFailures.has(task.id)) {
        externalFailures.delete(task.id);
        return { failed: true };
      }
      const payload = externalResults.get(task.id);
      externalResults.delete(task.id);
      const result = payload?.result;
      return { failed: false, result: result && typeof result === "object" ? result as Record<string, unknown> : undefined };
    };

    const useContextRefs = patched("chapter-context-refs-v1");
    const runDraft = async (): Promise<{ artifact: Artifact; text: string }> => {
      let candidateStartIndex = 0;
      while (true) {
        const generated = useContextRefs
          ? await activities.draftByRefs({ workflowId, intent, blueprintId: blueprint.id, memoryBundleId: memory.id, skillBundleId: skills.id, routingSnapshot, candidateStartIndex, foundationArtifactIds: foundationArtifacts.map((artifact) => artifact.id) })
          : await activities.draft({ workflowId, intent, blueprint, memory, skills, routingSnapshot, candidateStartIndex, foundationArtifacts, planningContext });
        if (generated.kind === "completed") return generated;
        const external = await waitForExternal(generated.task);
        if (external.failed) { candidateStartIndex = generated.task.candidateIndex + 1; continue; }
        const text = typeof external.result?.text === "string" ? external.result.text : undefined;
        if (!text) throw new Error("外部草稿任务未返回 text");
        return activities.materializeExternalText({ projectId: intent.projectId, modelTaskId: generated.task.id, text, kind: "draft", baseRevision: blueprint.baseRevision });
      }
    };

    const runRevision = async (current: { artifact: Artifact; text: string }, reviews: Review[]): Promise<{ artifact: Artifact; text: string }> => {
      let candidateStartIndex = 0;
      while (true) {
        const generated = useContextRefs
          ? await activities.reviseByRefs({ workflowId, intent, artifactId: current.artifact.id, reviewIds: reviews.map((review) => review.id), blueprintId: blueprint.id, memoryBundleId: memory.id, skillBundleId: skills.id, routingSnapshot, candidateStartIndex })
          : await activities.revise({ workflowId, intent, artifact: current.artifact, text: current.text, reviews, memory, blueprint, skills, routingSnapshot, candidateStartIndex, planningContext });
        if (generated.kind === "completed") return generated;
        const external = await waitForExternal(generated.task);
        if (external.failed) { candidateStartIndex = generated.task.candidateIndex + 1; continue; }
        const text = typeof external.result?.text === "string" ? external.result.text : undefined;
        if (!text) throw new Error("外部修订任务未返回 text");
        return activities.materializeExternalText({ projectId: intent.projectId, modelTaskId: generated.task.id, text, kind: "revision", baseRevision: current.artifact.baseRevision });
      }
    };

    const runReview = async (current: { artifact: Artifact; text: string }, role: ReviewerRole, identity: "internal" | "independent"): Promise<Review> => {
      let candidateStartIndex = 0;
      while (true) {
        const generated = useContextRefs
          ? await activities.reviewByRefs({ workflowId, artifactId: current.artifact.id, blueprintId: blueprint.id, memoryBundleId: memory.id, skillBundleId: skills.id, role, identity, routingSnapshot, candidateStartIndex, narrativeOrder: snapshot.targetDocumentOrder })
          : await activities.review({ workflowId, artifact: current.artifact, text: current.text, blueprint, memory, skills, role, identity, routingSnapshot, candidateStartIndex, narrativeOrder: snapshot.targetDocumentOrder, planningContext });
        if (generated.kind === "completed") return generated.review;
        const external = await waitForExternal(generated.task);
        if (external.failed) { candidateStartIndex = generated.task.candidateIndex + 1; continue; }
        const value = external.result?.value ?? external.result;
        return activities.materializeExternalReview({ modelTaskId: generated.task.id, artifact: current.artifact, identity, role, value });
      }
    };

    let learningSequence = 0;
    const runLearning = async (current: { artifact: Artifact; text: string }, reviews: Review[]): Promise<RuntimeLearningAssessmentV2> => {
      const assessmentKey = String(++learningSequence);
      let candidateStartIndex = 0;
      while (true) {
        const generated = await activities.assessLearning({ projectId: intent.projectId, workflowId, assessmentKey, artifact: current.artifact, reviews, routingSnapshot, candidateStartIndex });
        if (generated.kind === "completed") return generated.assessment;
        const external = await waitForExternal(generated.task);
        if (external.failed) { candidateStartIndex = generated.task.candidateIndex + 1; continue; }
        return activities.materializeExternalLearning({ modelTaskId: generated.task.id, projectId: intent.projectId, workflowId, artifact: current.artifact, reviews });
      }
    };
    const resolveApprovedDraft = async (current: { artifact: Artifact; text: string }, decision: HumanDecision): Promise<{ artifact: Artifact; text: string }> => {
      if (!decision.approvedArtifactId || decision.approvedArtifactId === current.artifact.id) return current;
      const approved = await activities.loadProposedDraft({ projectId: intent.projectId, artifactId: decision.approvedArtifactId });
      if (approved.artifact.projectId !== current.artifact.projectId) throw new Error("作者批准的替换产物不属于当前项目");
      if (approved.artifact.baseRevision !== current.artifact.baseRevision) throw new Error("作者批准的替换产物基线与当前候选不一致");
      return approved;
    };

    const runFactExtraction = async (current: { artifact: Artifact; text: string }): Promise<Artifact> => {
      let candidateStartIndex = 0;
      while (true) {
        const generated = await activities.extractFacts({ workflowId, projectId: intent.projectId, artifact: current.artifact, text: current.text, blueprint, routingSnapshot, candidateStartIndex, documentId: intent.target?.id, narrativeOrder: snapshot.targetDocumentOrder });
        if (generated.kind === "completed") return generated.artifact;
        const external = await waitForExternal(generated.task);
        if (external.failed) { candidateStartIndex = generated.task.candidateIndex + 1; continue; }
        return activities.materializeExternalFacts({ modelTaskId: generated.task.id, projectId: intent.projectId, artifact: generated.artifact, text: current.text, documentId: intent.target?.id, narrativeOrder: snapshot.targetDocumentOrder });
      }
    };

    /**
     * 角色富化（character enrichment）。
     *
     * 设计依据：AGENTS.md「commitStageHandler → characterEnrichmentStageHandler」契约。
     * 在 commit 之后执行，从定稿章节提取角色声部/动机/知识/关系增量并回写角色档案。
     * 失败不阻塞 workflow（commit 已落库），由调用方 try/catch 记录警告后继续完成 workflow。
     *
     * 支持 internal LLM 与 external-mcp 双路径（同 runDraft/runRevision/runReview）。
     * narrativeOrder 缺失时（如项目级任务）跳过 enrichment。
     */
    const runEnrichCharacters = async (current: { artifact: Artifact; text: string }, revisionId: string, narrativeOrder: number | undefined, factArtifact?: Artifact): Promise<void> => {
      if (narrativeOrder === undefined) return; // 无章节顺序号，跳过 enrichment
      const documentId = intent.target?.id;
      if (!documentId) return; // 无 documentId，跳过 enrichment
      let candidateStartIndex = 0;
      while (true) {
        const generated = await activities.enrichCharacters({ workflowId, projectId: intent.projectId, documentId, revisionId, narrativeOrder, artifact: current.artifact, factArtifact, text: current.text, routingSnapshot, candidateStartIndex });
        if (generated.kind === "completed") return;
        const external = await waitForExternal(generated.task);
        if (external.failed) { candidateStartIndex = generated.task.candidateIndex + 1; continue; }
        await activities.materializeExternalEnrichment({ modelTaskId: generated.task.id, projectId: intent.projectId, documentId, revisionId, narrativeOrder, artifact: current.artifact, text: current.text });
        return;
      }
    };

    /**
     * 章节反思（reflection）。
     *
     * 设计依据：AGENTS.md「root-cause analysis」契约 + Phase 2.4 reflection 机制。
     * 在 draft 之后、runAllReviewers 之前执行，让 LLM 扮演「严苛读者」批评自己的草稿。
     * 不产生 commit 证据，只用于优化 draft。支持 external-mcp 双路径。
     *
     * 返回 ReflectionCritique（overallImpression + issues[]）。
     */
    const runReflection = async (current: { artifact: Artifact; text: string }): Promise<{ critique: ReflectionOutput["critique"]; artifact: Artifact } | null> => {
      let candidateStartIndex = 0;
      while (true) {
        const generated = await activities.reflectOnDraft({ workflowId, artifact: current.artifact, text: current.text, blueprint, memory, routingSnapshot, candidateStartIndex, planningContext });
        if (generated.kind === "completed") return generated;
        const external = await waitForExternal(generated.task);
        if (external.failed) { candidateStartIndex = generated.task.candidateIndex + 1; continue; }
        return activities.materializeExternalReflection({ modelTaskId: generated.task.id, artifact: current.artifact, workflowId });
      }
    };

    /**
     * 把 ReflectionCritique 转换为伪 Review，喂给 runRevision。
     *
     * reflection 不产生 commit 证据，所以不写入 reviews 表；
     * 但复用 runRevision 的修订逻辑，需要构造 Review 形态的输入。
     *
     * 设计依据：AGENTS.md「root-cause analysis」——原实现用 suggestion 顶替 rewriteExample、
     * rule 固定为 "reflection-critique"，导致 revise 阶段"按 issue.rule 命中 skill"机制失效
     * （所有 reflection issue 都命中同一固定 rule，无法触发题材/维度特化的修订技能）。
     * P0-2 已对齐 reflectionSchema 与 reviewerSchema 字段集，此处改为 1:1 透传 reflection
     * issue 的 dimension/rule/revisionRanges/rewriteExample，让 revise 阶段能按真实 rule 命中 skill。
     *
     * 防御性兜底：reflectionSchema 已强制 rewriteExample minLength=1，但 materializeExternalReflection
     * 走外部 MCP 路径时可能绕过 schema 校验。此处对缺 rewriteExample 的 issue 记录 warning 并跳过，
     * 避免空 rewriteExample 污染 revise 阶段（revise 依赖 rewriteExample 作为修订示范）。
     */
    const critiqueToReview = (
      critique: ReflectionOutput["critique"],
      sourceArtifact: Artifact,
    ): Review => ({
      id: `reflection:${sourceArtifact.id}`,
      projectId: intent.projectId,
      artifactId: sourceArtifact.id,
      reviewerId: "reflection-worker",
      identity: "independent",
      verdict: critique.issues.some((issue) => issue.severity === "blocker") ? "blocked" : "revise",
      issues: critique.issues
        .filter((issue) => {
          if (!issue.rewriteExample || !issue.rewriteExample.trim()) {
            console.warn(`[reflection] issue "${issue.title}" 缺 rewriteExample，已跳过（不喂给 revise 阶段）`);
            return false;
          }
          return true;
        })
        .map((issue) => ({
          severity: issue.severity,
          title: issue.title,
          description: issue.description,
          evidence: issue.excerpt ?? issue.description,
          dimension: issue.dimension,
          excerpt: issue.excerpt,
          paragraph: issue.paragraph,
          revisionRanges: issue.revisionRanges,
          rule: issue.rule,
          suggestion: issue.suggestion,
          rewriteExample: issue.rewriteExample,
        })),
      createdAt: Date.now(),
      artifactFingerprint: sourceArtifact.fingerprint,
    });

    // 草稿生成
    await activities.updateTaskAttempt({ id: `${blueprint.id}:draft:attempt-1`, workflowRunId: workflowId, taskId: `${blueprint.id}:draft`, status: "running", payload: { taskKind: "draft" } });
    let draft = await runDraft();
    await activities.updateTaskAttempt({ id: draft.artifact.attemptId, workflowRunId: workflowId, taskId: draft.artifact.taskId, status: "submitted", payload: { artifactId: draft.artifact.id, fingerprint: draft.artifact.fingerprint } });

    // 章节反思（Phase 2.4）：仅为旧历史保留。新运行由 writer self-check + 正式 reader reviewer 覆盖。
    // 若 reflection 发现 blocker/major，自动调一次 runRevision。
    // 注意：reflection 修订独立于 review-revision 循环（runChapterLifecycle 内的 ≤DEFAULT_MAX_AUTO_REVISIONS 轮），
    // 单独计数以便语义明确——reflection 最多 REFLECTION_AUTO_REVISIONS 次，不占用 review 循环的修订额度。
    // 设计依据：AGENTS.md「root-cause analysis」+ Phase 2.4 计划「autoRevise 最多 1 次」
    const useConvergedLifecycle = patched("chapter-context-convergence-v1");
    if (!useConvergedLifecycle) {
      const REFLECTION_AUTO_REVISIONS = 1;
      let reflectionRevisions = 0;
      try {
        const reflection = await runReflection(draft);
        if (reflection) {
          const hasBlocking = reflection.critique.issues.some((issue) => issue.severity === "blocker" || issue.severity === "major");
          if (hasBlocking && reflectionRevisions < REFLECTION_AUTO_REVISIONS) {
            reflectionRevisions += 1;
            await activities.updateWorkflowStatus({ workflowId, status: "running", payload: { stage: "reflection-auto-revise", issueCount: reflection.critique.issues.length } });
            const reflectionReview = critiqueToReview(reflection.critique, draft.artifact);
            draft = await runRevision(draft, [reflectionReview]);
          }
        }
      } catch (error) {
        await activities.updateWorkflowStatus({ workflowId, status: "running", payload: { stage: "reflection-failed", error: error instanceof Error ? error.message : String(error) } });
      }
    }

    const lifecycle = await runChapterLifecycle({
      projectId: intent.projectId,
      initialDraft: draft,
      review: (current) => runAllReviewers({ workflowId, blueprintId: blueprint.id, runReview: (role, identity) => runReview(current, role, identity) }),
      revise: (current, reviewList) => runRevision(current, reviewList),
      assessLearning: runLearning,
      extractFacts: runFactExtraction,
      approveFacts: (factArtifact) => activities.approveFacts({ workflowId, projectId: intent.projectId, artifact: factArtifact }),
      commit: (current, reviewList, factArtifact) => activities.commit({ projectId: intent.projectId, documentId: intent.target!.id!, artifact: current.artifact, factArtifact, narrativeOrder: snapshot.targetDocumentOrder, text: current.text, reviews: reviewList, baseRevision: blueprint.baseRevision, idempotencyKey: intent.idempotencyKey }),
      enrich: (current, commitResult, factArtifact) => runEnrichCharacters(current, commitResult.revisionId, snapshot.targetDocumentOrder, factArtifact),
      progress: (payload) => activities.updateWorkflowStatus({ workflowId, status: "running", payload }),
      beforeRevision: (revisionIteration) => activities.updateTaskAttempt({ id: `${blueprint.id}:revise:attempt-${revisionIteration}`, workflowRunId: workflowId, taskId: `${blueprint.id}:revise`, status: "running", payload: { taskKind: "revise", iteration: revisionIteration } }).then(() => undefined),
      afterRevision: (current, revisionIteration) => activities.updateTaskAttempt({ id: current.artifact.attemptId, workflowRunId: workflowId, taskId: current.artifact.taskId, status: "submitted", payload: { artifactId: current.artifact.id, iteration: revisionIteration } }).then(() => undefined),
      commitBlocked: blueprint.memoryGate?.status === "manual-review" ? { reasonCode: "memory-coverage-incomplete", missingFacets: blueprint.memoryGate.missingFacets, manualReviewFacets: blueprint.memoryGate.manualReviewFacets } : undefined,
      requireManualFactApproval: blueprint.factApprovalMode === "manual",
      learningMode: useConvergedLifecycle ? "terminal-candidate" : "legacy-each-stage",
    });

    // P0 #1: opt-in 人工事实审批门。factApprovalBlocked 仅在 commitGate 已通过、但存在 pending 事实时出现。
    if (lifecycle.factApprovalBlocked) {
      await activities.updateWorkflowStatus({ workflowId, status: "manual-review-required", payload: { blueprintId: blueprint.id, reasonCode: "fact-approval-pending", pendingIds: lifecycle.factApprovalBlocked.pendingIds, artifactId: lifecycle.draft.artifact.id, reviewIds: lifecycle.commitGate.reviewIds } });
      await condition(() => humanDecision !== undefined);
      if (humanDecision!.decision === "abandon") {
        await activities.updateWorkflowStatus({ workflowId, status: "abandoned", payload: { blueprintId: blueprint.id, artifactId: lifecycle.draft.artifact.id, restoredDocumentId: intent.target!.id!, authorId: humanDecision!.authorId, feedback: humanDecision!.feedback, reasonCode: "abandoned-by-author" } });
        return blueprint;
      }
      if (humanDecision!.decision === "reject") {
        await activities.updateWorkflowStatus({ workflowId, status: "rejected", payload: { blueprintId: blueprint.id, artifactId: lifecycle.draft.artifact.id, authorId: humanDecision!.authorId, feedback: humanDecision!.feedback } });
        return blueprint;
      }
      // 作者确认：将 pending 事实候选翻转为 approved（candidate → approved），随后正常提交。
      // approveFactClaims activity 内部同时写回 Qdrant 索引（与 recordFactExtraction 模式一致）。
      await activities.approveFactClaims({ projectId: intent.projectId, ids: lifecycle.factApprovalBlocked.pendingIds });
      const finalized = await finalizeChapterLifecycle({
        projectId: intent.projectId,
        draft: lifecycle.draft,
        reviews: lifecycle.reviews,
        commit: (current, reviewList, factArtifact) => activities.commit({ projectId: intent.projectId, documentId: intent.target!.id!, artifact: current.artifact, factArtifact, narrativeOrder: snapshot.targetDocumentOrder, text: current.text, reviews: reviewList, baseRevision: blueprint.baseRevision, idempotencyKey: `${intent.idempotencyKey}:fact-approved` }),
        enrich: (current, commitResult, factArtifact) => runEnrichCharacters(current, commitResult.revisionId, snapshot.targetDocumentOrder, factArtifact),
        assessLearning: runLearning,
        progress: (payload) => activities.updateWorkflowStatus({ workflowId, status: "running", payload }),
        factArtifact: lifecycle.factApprovalBlocked.factArtifact,
        assessPostCommitLearning: !useConvergedLifecycle,
      });
      await activities.updateWorkflowStatus({ workflowId, status: "completed", payload: { blueprintId: blueprint.id, artifactId: lifecycle.draft.artifact.id, finalScore: lifecycle.finalScore, factApproved: true, authorId: humanDecision!.authorId, enrichmentError: finalized.enrichmentError } });
      return blueprint;
    }

    if (!lifecycle.commitResult) {
      await activities.updateWorkflowStatus({ workflowId, status: "manual-review-required", payload: { blueprintId: blueprint.id, signalCount: signals.length, iterations: lifecycle.iteration, finalScore: lifecycle.finalScore, artifactId: lifecycle.draft.artifact.id, reviewIds: lifecycle.commitGate.reviewIds, failedReviewIds: lifecycle.commitGate.failedReviewIds, missingReviewerRoles: lifecycle.commitGate.missingRoles, reasonCode: lifecycle.commitBlocked?.reasonCode ?? "quality-gate-not-passed", ...lifecycle.commitBlocked } });
      await condition(() => humanDecision !== undefined);
      if (humanDecision!.decision === "abandon") {
        await activities.updateWorkflowStatus({ workflowId, status: "abandoned", payload: { blueprintId: blueprint.id, artifactId: lifecycle.draft.artifact.id, restoredDocumentId: intent.target!.id!, authorId: humanDecision!.authorId, feedback: humanDecision!.feedback, reasonCode: "abandoned-by-author" } });
        return blueprint;
      }
      if (humanDecision!.decision === "reject") {
        await activities.updateWorkflowStatus({ workflowId, status: "rejected", payload: { blueprintId: blueprint.id, artifactId: lifecycle.draft.artifact.id, authorId: humanDecision!.authorId, feedback: humanDecision!.feedback } });
        return blueprint;
      }
      const approvedDraft = await resolveApprovedDraft(lifecycle.draft, humanDecision!);
      const factArtifact = await runFactExtraction(approvedDraft);
      await activities.approveFacts({ workflowId, projectId: intent.projectId, artifact: factArtifact });
      const authorReview: Review = { id: `author-approval:${workflowId}`, projectId: intent.projectId, artifactId: approvedDraft.artifact.id, reviewerId: humanDecision!.authorId, identity: "human", verdict: "passed", issues: [], artifactFingerprint: approvedDraft.artifact.fingerprint, createdAt: Date.now() };
      const authorReviews = [...lifecycle.reviews, authorReview];
      const finalized = await finalizeChapterLifecycle({
        projectId: intent.projectId,
        draft: approvedDraft,
        reviews: authorReviews,
        commit: (current, reviewList, approvedFactArtifact) => activities.commitAuthorApproved({ projectId: intent.projectId, documentId: intent.target!.id!, artifact: current.artifact, factArtifact: approvedFactArtifact, narrativeOrder: snapshot.targetDocumentOrder, text: current.text, reviews: reviewList, baseRevision: blueprint.baseRevision, idempotencyKey: `${intent.idempotencyKey}:author-approved` }),
        enrich: (current, commitResult, factArtifact) => runEnrichCharacters(current, commitResult.revisionId, snapshot.targetDocumentOrder, factArtifact),
        assessLearning: runLearning,
        progress: (payload) => activities.updateWorkflowStatus({ workflowId, status: "running", payload }),
        factArtifact,
        assessPostCommitLearning: !useConvergedLifecycle,
      });
      await activities.updateWorkflowStatus({ workflowId, status: "completed", payload: { blueprintId: blueprint.id, artifactId: approvedDraft.artifact.id, ...(approvedDraft.artifact.id === lifecycle.draft.artifact.id ? {} : { replacedArtifactId: lifecycle.draft.artifact.id }), finalScore: lifecycle.finalScore, authorApproved: true, authorId: humanDecision!.authorId, enrichmentError: finalized.enrichmentError } });
      return blueprint;
    }
    await activities.updateTaskAttempt({ id: `${blueprint.id}:commit:attempt-1`, workflowRunId: workflowId, taskId: `${blueprint.id}:commit`, status: "completed", payload: { artifactId: lifecycle.draft.artifact.id } });
    await activities.updateWorkflowStatus({ workflowId, status: "completed", payload: { blueprintId: blueprint.id, signalCount: signals.length, iterations: lifecycle.iteration, finalScore: lifecycle.finalScore, enrichmentError: lifecycle.enrichmentError } });
    return blueprint;
  } catch (error) {
    await activities.updateWorkflowStatus({ workflowId, status: "failed", payload: { error: failureMessage(error), signalCount: signals.length } });
    throw error;
  }
}

// ===== CreativeRun Workflow =====

/**
 * CreativeRun 工作流：编排 CreativeRun 内的 work items 执行。
 *
 * 设计依据：AGENTS.md 章节审校工作流复用契约 + Phase B-2.3 重构计划。
 *
 * 流程：
 * 1. 加载 run（含 policy）→ 写 workflow.started 事件
 * 2. 循环：列出 pending work items
 *    - 无 pending → 完成 run
 *    - 有 pending → 对每个 work item 执行 startWork → reviewGate → accept
 * 3. 支持 signals：pause/resume/cancel/reviewSubmitted
 * 4. manual gate：work item start 后等待 reviewSubmittedSignal 才继续 accept
 *
 * 与 command-router 的关系：
 * - command-router 处理单条命令（含幂等性）
 * - workflow 负责整体编排（决定何时 start/accept/retry）
 * - workflow 通过 activities 调用 creative/ 模块函数（不走 command-router 的幂等检查）
 *
 * AGENTS.md 合规：章节审校工作流复用
 * - work item 的 kind="generation" 时，activity.startWork 内部应触发 novelIntentWorkflow
 * - 不允许另起一套章节生成逻辑
 */

export interface CreativeWorkflowActivities {
  updateWorkflowStatus(input: { workflowId: string; status: string; payload?: Record<string, unknown> }): Promise<unknown>;
  /** 加载 CreativeRun（含 policy/payload） */
  loadRun(input: { runId: string }): Promise<CreativeRun | null>;
  /** 加载单个 work item（重载用，获取最新 artifactRefs） */
  getWorkItem(input: { workItemId: string }): Promise<CreativeWorkItem | null>;
  /** 列出 pending 状态的 work items（按 created_at ASC） */
  listPendingWork(input: { runId: string }): Promise<CreativeWorkItem[]>;
  /** 启动 work item（调用 creative.startWork，内部更新状态 + 写事件） */
  startWork(input: { runId: string; workItemId: string }): Promise<CreativeWorkItem>;
  /** 检查 work item 的 review gate（调用 creative.checkGate） */
  checkGate(input: { runId: string; workItemId: string }): Promise<CreativeReviewGate>;
  /** 接受 work item（调用 creative.acceptWork） */
  acceptWork(input: { runId: string; workItemId: string }): Promise<CreativeWorkItem>;
  /** 修订 work item（调用 creative.reviseWork） */
  reviseWork(input: { runId: string; workItemId: string; instruction?: string }): Promise<CreativeWorkItem>;
  /** 重试 work item（调用 creative.retryWork） */
  retryWork(input: { runId: string; workItemId: string }): Promise<CreativeWorkItem>;
  /** 更新 run 状态（基于 work items 状态派生） */
  updateRunStatus(input: { runId: string }): Promise<CreativeRun>;
  /** 写入 creative_run_events 事件 */
  recordEvent(input: { runId: string; eventType: string; payload: Record<string, unknown> }): Promise<unknown>;
  /** 标记 work item 失败（达到重试上限时闭环，避免永久 running） */
  failWork(input: { runId: string; workItemId: string; reason?: string }): Promise<CreativeWorkItem>;
  /**
   * 生成架构产出（foundation artifact）。
   * 按 work item.taskKey 调用 modelGateway.generateStructured(planning.foundation)。
   * 支持 internal LLM 与 external-mcp 双路径。
   */
  generateFoundationWork(input: { runId: string; workItemId: string; candidateStartIndex?: number }): Promise<{ kind: "completed"; artifact: Artifact } | { kind: "external"; task: ModelTaskRecord; artifact: Artifact }>;
  expireExternalModelTask(input: { modelTaskId: string; reason: string }): Promise<void>;
  /** 物化外部 foundation 任务结果（external-mcp 回填路径） */
  materializeExternalFoundation(input: { modelTaskId: string; workItemId: string; value: unknown }): Promise<Artifact>;
}

export const pauseCreativeRunSignal = defineSignal("pauseCreativeRun");
export const resumeCreativeRunSignal = defineSignal("resumeCreativeRun");
export const cancelCreativeRunSignal = defineSignal("cancelCreativeRun");
export const reviewSubmittedSignal = defineSignal<[string]>("reviewSubmitted");
export const generatePlanWorkSignal = defineSignal<[string]>("generatePlanWork");

/**
 * CreativeRun 工作流主入口。
 *
 * @param runId CreativeRun ID
 *
 * 状态机：
 * - run.status=pending → workflow 启动 → run.status=running
 * - run.status=running → 循环处理 work items
 * - 所有 work items accepted → run.status=completed
 * - cancel signal → run.status=cancelled
 * - pause signal → 暂停处理（等待 resume）
 *
 * work item 处理：
 * - pending → startWork → running
 * - running → checkGate
 *   - gate.passed → acceptWork → accepted
 *   - gate.passed=false（manual）→ 等待 reviewSubmittedSignal → acceptWork
 *   - gate.passed=false（auto，有 blocker）→ reviseWork → running（重试）
 *
 * 重试限制：每个 work item 最多重试 maxRetries 次（来自 run.policy）
 * 超过限制 → failWork → run 进入人工队列
 */
export interface StoryArcPlanningWorkflowInput {
  workflowId: string;
  projectId: string;
  arcId: string;
  mode: "web" | "mcp";
  reviewPolicy?: "manual" | "auto";
  authorIntent?: string;
  maxRetries?: number;
  batchIndex?: number;
  startChapterIndex?: number;
}

export interface BookSynopsisWorkflowInput {
  workflowId: string;
  projectId: string;
  sourceFingerprint: string;
}

export async function bookSynopsisWorkflow(params: BookSynopsisWorkflowInput): Promise<void> {
  const externalResults = new Map<string, Record<string, unknown>>();
  const externalFailures = new Map<string, Record<string, unknown>>();
  setHandler(artifactSignal, (payload) => {
    const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (typeof body.modelTaskId === "string") externalResults.set(body.modelTaskId, body);
  });
  setHandler(failSignal, (payload) => {
    const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (typeof body.modelTaskId === "string") externalFailures.set(body.modelTaskId, body);
  });

  await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "running", payload: { sourceFingerprint: params.sourceFingerprint } });
  try {
    let candidateStartIndex: number | undefined;
    let text: string | undefined;
    while (text === undefined) {
      const generated = await activities.generateBookSynopsis({ ...params, candidateStartIndex });
      if (generated.kind === "completed") {
        text = generated.text;
        break;
      }
      await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "waiting-external", payload: { sourceFingerprint: params.sourceFingerprint, modelTaskId: generated.task.id } });
      const completed = await condition(() => externalResults.has(generated.task.id) || externalFailures.has(generated.task.id), "15 minutes");
      if (!completed || externalFailures.has(generated.task.id)) {
        await activities.expireExternalModelTask({ modelTaskId: generated.task.id, reason: completed ? "外部作品简介任务失败" : "外部作品简介任务等待超时" });
        candidateStartIndex = generated.task.candidateIndex + 1;
        continue;
      }
      const payload = externalResults.get(generated.task.id) ?? {};
      externalResults.delete(generated.task.id);
      try {
        text = (await activities.materializeExternalBookSynopsis({ modelTaskId: generated.task.id, value: (payload.result as Record<string, unknown> | undefined)?.value })).text;
      } catch (error) {
        await activities.expireExternalModelTask({ modelTaskId: generated.task.id, reason: failureMessage(error) });
        candidateStartIndex = generated.task.candidateIndex + 1;
      }
    }
    const synopsis = await activities.persistBookSynopsis({ projectId: params.projectId, sourceFingerprint: params.sourceFingerprint, text });
    await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "completed", payload: { sourceFingerprint: params.sourceFingerprint, generatedAt: synopsis.generatedAt } });
  } catch (error) {
    await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "failed", payload: { sourceFingerprint: params.sourceFingerprint, reason: failureMessage(error) } });
    throw error;
  }
}

export type BookTitleCandidatesWorkflowInput = BookSynopsisWorkflowInput;

export async function bookTitleCandidatesWorkflow(params: BookTitleCandidatesWorkflowInput): Promise<void> {
  const externalResults = new Map<string, Record<string, unknown>>();
  const externalFailures = new Map<string, Record<string, unknown>>();
  setHandler(artifactSignal, (payload) => {
    const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (typeof body.modelTaskId === "string") externalResults.set(body.modelTaskId, body);
  });
  setHandler(failSignal, (payload) => {
    const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (typeof body.modelTaskId === "string") externalFailures.set(body.modelTaskId, body);
  });

  await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "running", payload: { sourceFingerprint: params.sourceFingerprint } });
  try {
    let candidateStartIndex: number | undefined;
    let candidates: BookTitleCandidate[] | undefined;
    while (!candidates) {
      const generated = await activities.generateBookTitleCandidates({ ...params, candidateStartIndex });
      if (generated.kind === "completed") {
        candidates = generated.candidates;
        break;
      }
      await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "waiting-external", payload: { sourceFingerprint: params.sourceFingerprint, modelTaskId: generated.task.id } });
      const completed = await condition(() => externalResults.has(generated.task.id) || externalFailures.has(generated.task.id), "15 minutes");
      if (!completed || externalFailures.has(generated.task.id)) {
        await activities.expireExternalModelTask({ modelTaskId: generated.task.id, reason: completed ? "外部书名生成任务失败" : "外部书名生成任务等待超时" });
        candidateStartIndex = generated.task.candidateIndex + 1;
        continue;
      }
      const payload = externalResults.get(generated.task.id) ?? {};
      externalResults.delete(generated.task.id);
      try {
        candidates = (await activities.materializeExternalBookTitleCandidates({ modelTaskId: generated.task.id, value: (payload.result as Record<string, unknown> | undefined)?.value })).candidates;
      } catch (error) {
        await activities.expireExternalModelTask({ modelTaskId: generated.task.id, reason: failureMessage(error) });
        candidateStartIndex = generated.task.candidateIndex + 1;
      }
    }
    const record = await activities.persistBookTitleCandidates({ projectId: params.projectId, sourceFingerprint: params.sourceFingerprint, candidates });
    await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "completed", payload: { sourceFingerprint: params.sourceFingerprint, generatedAt: record.generatedAt } });
  } catch (error) {
    await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "failed", payload: { sourceFingerprint: params.sourceFingerprint, reason: failureMessage(error) } });
    throw error;
  }
}

export interface ChapterTitleWorkflowInput extends BookSynopsisWorkflowInput {
  documentId: string;
}

export async function chapterTitleWorkflow(params: ChapterTitleWorkflowInput): Promise<void> {
  const externalResults = new Map<string, Record<string, unknown>>();
  const externalFailures = new Map<string, Record<string, unknown>>();
  setHandler(artifactSignal, (payload) => {
    const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (typeof body.modelTaskId === "string") externalResults.set(body.modelTaskId, body);
  });
  setHandler(failSignal, (payload) => {
    const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (typeof body.modelTaskId === "string") externalFailures.set(body.modelTaskId, body);
  });

  await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "running", payload: { documentId: params.documentId, sourceFingerprint: params.sourceFingerprint } });
  try {
    let candidateStartIndex: number | undefined;
    let title: string | undefined;
    while (!title) {
      const generated = await activities.generateChapterTitle({ ...params, candidateStartIndex });
      if (generated.kind === "completed") {
        title = generated.title;
        break;
      }
      await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "waiting-external", payload: { documentId: params.documentId, sourceFingerprint: params.sourceFingerprint, modelTaskId: generated.task.id } });
      const completed = await condition(() => externalResults.has(generated.task.id) || externalFailures.has(generated.task.id), "15 minutes");
      if (!completed || externalFailures.has(generated.task.id)) {
        await activities.expireExternalModelTask({ modelTaskId: generated.task.id, reason: completed ? "外部章节命名任务失败" : "外部章节命名任务等待超时" });
        candidateStartIndex = generated.task.candidateIndex + 1;
        continue;
      }
      const payload = externalResults.get(generated.task.id) ?? {};
      externalResults.delete(generated.task.id);
      try {
        title = (await activities.materializeExternalChapterTitle({ modelTaskId: generated.task.id, value: (payload.result as Record<string, unknown> | undefined)?.value })).title;
      } catch (error) {
        await activities.expireExternalModelTask({ modelTaskId: generated.task.id, reason: failureMessage(error) });
        candidateStartIndex = generated.task.candidateIndex + 1;
      }
    }
    const result = await activities.persistGeneratedChapterTitle({ projectId: params.projectId, documentId: params.documentId, sourceFingerprint: params.sourceFingerprint, title });
    await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "completed", payload: { documentId: params.documentId, sourceFingerprint: params.sourceFingerprint, title: result.title } });
  } catch (error) {
    await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "failed", payload: { documentId: params.documentId, sourceFingerprint: params.sourceFingerprint, reason: failureMessage(error) } });
    throw error;
  }
}

export async function storyArcPlanningWorkflow(params: StoryArcPlanningWorkflowInput): Promise<void> {
  const externalResults = new Map<string, Record<string, unknown>>();
  const externalFailures = new Map<string, Record<string, unknown>>();
  let approved = false;
  setHandler(artifactSignal, (payload) => {
    const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (typeof body.modelTaskId === "string") externalResults.set(body.modelTaskId, body);
  });
  setHandler(failSignal, (payload) => {
    const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (typeof body.modelTaskId === "string") externalFailures.set(body.modelTaskId, body);
  });
  setHandler(storyArcApprovedSignal, () => { approved = true; });

  const waitForExternal = async (task: ModelTaskRecord): Promise<Record<string, unknown>> => {
    const completed = await condition(() => externalResults.has(task.id) || externalFailures.has(task.id), "15 minutes");
    if (!completed) throw new Error(`外部模型任务等待超时：${task.id}`);
    if (externalFailures.has(task.id)) throw new Error(`外部模型任务失败：${task.id}`);
    const payload = externalResults.get(task.id) ?? {};
    externalResults.delete(task.id);
    const result = payload.result;
    return result && typeof result === "object" ? result as Record<string, unknown> : {};
  };

  const generateBundle = async (candidateStartIndex?: number): Promise<{ artifact: Artifact; bundle: StoryArcBundle }> => {
    let nextCandidate = candidateStartIndex;
    while (true) {
      const generated = await activities.generateStoryArcBundle({ workflowId: params.workflowId, projectId: params.projectId, arcId: params.arcId, authorIntent: params.authorIntent, batchIndex: params.batchIndex, startChapterIndex: params.startChapterIndex, candidateStartIndex: nextCandidate });
      if (generated.kind === "completed") return { artifact: generated.artifact, bundle: generated.bundle };
      try {
        const materialized = await activities.materializeExternalStoryArcBundle({ modelTaskId: generated.task.id, projectId: params.projectId, arcId: params.arcId, value: (await waitForExternal(generated.task)).value });
        if (params.batchIndex && (materialized.bundle.batch.batchIndex !== params.batchIndex || materialized.bundle.batch.startChapterIndex !== params.startChapterIndex)) throw new Error("外部生成结果的故事弧批次位置与请求不一致");
        return materialized;
      } catch (error) {
        await activities.expireExternalModelTask({ modelTaskId: generated.task.id, reason: failureMessage(error) });
        nextCandidate = generated.task.candidateIndex + 1;
      }
    }
  };

  const reviewBundle = async (current: { artifact: Artifact; bundle: StoryArcBundle }, candidateStartIndex?: number): Promise<{ artifact: Artifact; review: StoryArcReviewOutput }> => {
    let nextCandidate = candidateStartIndex;
    while (true) {
      const reviewed = await activities.reviewStoryArcBundle({ workflowId: params.workflowId, projectId: params.projectId, arcId: params.arcId, artifact: current.artifact, bundle: current.bundle, candidateStartIndex: nextCandidate });
      if (reviewed.kind === "completed") return { artifact: reviewed.artifact, review: reviewed.review };
      try {
        return await activities.materializeExternalStoryArcReview({ modelTaskId: reviewed.task.id, projectId: params.projectId, arcId: params.arcId, subjectArtifactId: current.artifact.id, value: (await waitForExternal(reviewed.task)).value });
      } catch (error) {
        await activities.expireExternalModelTask({ modelTaskId: reviewed.task.id, reason: failureMessage(error) });
        nextCandidate = reviewed.task.candidateIndex + 1;
      }
    }
  };

  const reviseBundle = async (current: { artifact: Artifact; bundle: StoryArcBundle }, review: StoryArcReviewOutput, candidateStartIndex?: number): Promise<{ artifact: Artifact; bundle: StoryArcBundle }> => {
    let nextCandidate = candidateStartIndex;
    while (true) {
      const revised = await activities.reviseStoryArcBundle({ workflowId: params.workflowId, projectId: params.projectId, arcId: params.arcId, artifact: current.artifact, bundle: current.bundle, review, candidateStartIndex: nextCandidate });
      if (revised.kind === "completed") return { artifact: revised.artifact, bundle: revised.bundle };
      try {
        const materialized = await activities.materializeExternalStoryArcBundle({ modelTaskId: revised.task.id, projectId: params.projectId, arcId: params.arcId, value: (await waitForExternal(revised.task)).value });
        if (materialized.bundle.batch.batchIndex !== current.bundle.batch.batchIndex || materialized.bundle.batch.startChapterIndex !== current.bundle.batch.startChapterIndex) throw new Error("外部修订结果改写了故事弧批次位置");
        return materialized;
      } catch (error) {
        await activities.expireExternalModelTask({ modelTaskId: revised.task.id, reason: failureMessage(error) });
        nextCandidate = revised.task.candidateIndex + 1;
      }
    }
  };

  const reviewPolicy = params.reviewPolicy ?? (params.mode === "mcp" ? "auto" : "manual");
  await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "running", payload: { arcId: params.arcId, mode: params.mode, reviewPolicy } });
  try {
    let current = await generateBundle();
    await activities.projectStoryArcBundle({ projectId: params.projectId, arcId: params.arcId, artifact: current.artifact, bundle: current.bundle, actor: "runtime" });

    if (reviewPolicy === "manual") {
      await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "manual-review-required", payload: { arcId: params.arcId, artifactId: current.artifact.id } });
      await condition(() => approved);
      await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "completed", payload: { arcId: params.arcId, artifactId: current.artifact.id, approvedBy: "web-author" } });
      return;
    }

    const maxRetries = params.maxRetries ?? 2;
    for (let iteration = 0; iteration <= maxRetries; iteration += 1) {
      const reviewed = await reviewBundle(current);
      const blocking = reviewed.review.issues.some((issue) => issue.severity === "blocker" || issue.severity === "major");
      if (reviewed.review.verdict === "passed" && !blocking) {
        await activities.approveStoryArcAutomatically({ projectId: params.projectId, arcId: params.arcId, artifactId: current.artifact.id });
        await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "completed", payload: { arcId: params.arcId, artifactId: current.artifact.id, reviewArtifactId: reviewed.artifact.id, iterations: iteration } });
        return;
      }
      if (iteration >= maxRetries || reviewed.review.verdict === "blocked") {
        const reason = reviewed.review.verdict === "blocked" ? reviewed.review.summary : "故事弧蓝图在最大修订次数内未通过审核";
        await activities.failStoryArc({ projectId: params.projectId, arcId: params.arcId, reason });
        await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "manual-review-required", payload: { arcId: params.arcId, artifactId: current.artifact.id, reviewArtifactId: reviewed.artifact.id, reason } });
        return;
      }
      current = await reviseBundle(current, reviewed.review);
      await activities.projectStoryArcBundle({ projectId: params.projectId, arcId: params.arcId, artifact: current.artifact, bundle: current.bundle, actor: "external-reviewer" });
    }
  } catch (error) {
    const reason = failureMessage(error);
    if (params.batchIndex) await activities.failStoryArcBatch({ projectId: params.projectId, arcId: params.arcId, batchIndex: params.batchIndex, reason });
    else await activities.failStoryArc({ projectId: params.projectId, arcId: params.arcId, reason });
    await activities.updateWorkflowStatus({ workflowId: params.workflowId, status: "failed", payload: { arcId: params.arcId, reason } });
    throw error;
  }
}

export async function creativeRunWorkflow(runId: string): Promise<void> {
  const activities = proxyActivities<CreativeWorkflowActivities>({
    startToCloseTimeout: "10 minutes",
    retry: { maximumAttempts: 3 },
  });

  // 状态变量
  let paused = false;
  let cancelled = false;
  const reviewedWorkItems = new Set<string>(); // 已收到 reviewSubmitted 的 work items
  const requestedWorkItems = new Set<string>();
  const externalResults = new Map<string, Record<string, unknown>>();
  const externalFailures = new Map<string, Record<string, unknown>>();
  // Signal handlers
  setHandler(pauseCreativeRunSignal, () => {
    paused = true;
  });
  setHandler(resumeCreativeRunSignal, () => {
    paused = false;
  });
  setHandler(cancelCreativeRunSignal, () => {
    cancelled = true;
  });
  setHandler(reviewSubmittedSignal, (workItemId: string) => {
    reviewedWorkItems.add(workItemId);
  });
  setHandler(generatePlanWorkSignal, (workItemId: string) => {
    requestedWorkItems.add(workItemId);
  });
  setHandler(artifactSignal, (payload) => {
    const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    if (typeof body.modelTaskId === "string") externalResults.set(body.modelTaskId, body);
  });
  setHandler(failSignal, (payload) => {
    const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    if (typeof body.modelTaskId === "string") externalFailures.set(body.modelTaskId, body);
  });

  const waitForExternal = async (task: ModelTaskRecord): Promise<{ result?: Record<string, unknown>; failed: boolean }> => {
    const completed = await condition(() => externalResults.has(task.id) || externalFailures.has(task.id), "15 minutes");
    if (!completed) {
      await activities.expireExternalModelTask({ modelTaskId: task.id, reason: "外部模型任务等待超时" });
      return { failed: true };
    }
    if (externalFailures.has(task.id)) {
      externalFailures.delete(task.id);
      return { failed: true };
    }
    const payload = externalResults.get(task.id);
    externalResults.delete(task.id);
    const result = payload?.result;
    return { failed: false, result: result && typeof result === "object" ? result as Record<string, unknown> : undefined };
  };

  // 1. 加载 run
  const run = await activities.loadRun({ runId });
  if (!run) {
    throw new Error(`CreativeRun 不存在：${runId}`);
  }

  await activities.updateWorkflowStatus({ workflowId: runId, status: "running", payload: { runId, mode: run.mode } });
  try {
    await activities.recordEvent({
      runId,
      eventType: "workflow.started",
      payload: { mode: run.mode, policy: run.policy },
    });

    const maxRetries = run.policy.maxRetries ?? 2;
    const retryCount = new Map<string, number>();

    while (!cancelled) {
      if (paused) {
        await condition(() => !paused || cancelled, "1 minute");
        continue;
      }

      const pending = await activities.listPendingWork({ runId });
      if (pending.length === 0) break;

      if (run.policy.progression === "user-driven") {
        const requested = pending.filter((work) => requestedWorkItems.has(work.id));
        if (requested.length === 0) {
          await condition(() => requestedWorkItems.size > 0 || cancelled || paused);
          continue;
        }
        for (const work of requested) requestedWorkItems.delete(work.id);
        await Promise.all(requested.map(async (work) => {
          if (cancelled || paused) return;
          await processWorkItem({
            runId,
            work,
            activities,
            reviewedWorkItems,
            retryCount,
            maxRetries,
            waitForExternal,
            isCancelled: () => cancelled,
            isPaused: () => paused,
          });
        }));
        continue;
      }

      await Promise.all(pending.map(async (work) => {
        if (cancelled || paused) return;
        await processWorkItem({
          runId,
          work,
          activities,
          reviewedWorkItems,
          retryCount,
          maxRetries,
          waitForExternal,
          isCancelled: () => cancelled,
          isPaused: () => paused,
        });
      }));
    }

    if (cancelled) {
      await activities.recordEvent({
        runId,
        eventType: "workflow.cancelled",
        payload: { reason: "cancel signal received" },
      });
      await activities.updateWorkflowStatus({ workflowId: runId, status: "cancelled", payload: { runId } });
      return;
    }

    const finalRun = await activities.updateRunStatus({ runId });
    await activities.recordEvent({
      runId,
      eventType: finalRun.status === "failed" ? "workflow.failed" : "workflow.completed",
      payload: { finalStatus: finalRun.status },
    });
    await activities.updateWorkflowStatus({ workflowId: runId, status: finalRun.status, payload: { runId } });
  } catch (error) {
    const message = failureMessage(error);
    await activities.recordEvent({ runId, eventType: "workflow.failed", payload: { error: message } });
    await activities.updateWorkflowStatus({ workflowId: runId, status: "failed", payload: { runId, error: message } });
    throw error;
  }
}

/**
 * 处理单个 work item：start → gate → accept/revise/fail。
 *
 * 这是 workflow 的核心逻辑，单独提取以便测试。
 *
 * 重试逻辑：
 * - gate.passed=false 且 reviewGate=auto → reviseWork，retryCount++
 * - retryCount >= maxRetries → 不再 revise，work item 留在 running 状态（人工介入）
 * - gate.passed=false 且 reviewGate=manual → 等待 reviewSubmittedSignal（最多 10 分钟）
 */
async function processWorkItem(params: {
  runId: string;
  work: CreativeWorkItem;
  activities: ReturnType<typeof proxyActivities<CreativeWorkflowActivities>>;
  reviewedWorkItems: Set<string>;
  retryCount: Map<string, number>;
  maxRetries: number;
  waitForExternal(task: ModelTaskRecord): Promise<{ result?: Record<string, unknown>; failed: boolean }>;
  isCancelled: () => boolean;
  isPaused: () => boolean;
}): Promise<void> {
  const { runId, work, activities, reviewedWorkItems, retryCount, maxRetries, waitForExternal, isCancelled, isPaused } = params;

  // 1. 启动 work item（若已 running 则跳过）
  if (work.status === "pending") {
    await activities.startWork({ runId, workItemId: work.id });
  }

  // 2. 生成架构产出（仅 generation kind 且有 taskKey 且无 artifact）
  // 设计依据：AGENTS.md「reusable contracts」——生成步骤在最低共享层，
  // 由 generateFoundationWork activity 根据 taskKey 调用 modelGateway.generateStructured。
  // foundation 阶段 reviewGate="none"（bootstrap_run 配置），生成后 gate 直接 passed → accept。
  // artifactRefs.length===0 表示首次生成；revise 后的重新生成由 reviseWork 触发状态回退，
  // 下轮 listPendingWork 重新处理时 artifactRefs 非空，跳过生成（保留旧 artifact 供 reviewer 参考）。
  const needsFoundationGeneration = work.artifactRefs.length === 0 || (work.status === "pending" && work.artifactRefs.length > 0);
  if (work.kind === "generation" && work.taskKey && needsFoundationGeneration) {
    let candidateStartIndex = 0;
    while (true) {
      const generated = await activities.generateFoundationWork({ runId, workItemId: work.id, candidateStartIndex });
      if (generated.kind === "completed") {
        await activities.recordEvent({
          runId,
          eventType: "work.foundation.generated",
          payload: { workItemId: work.id, taskKey: work.taskKey, artifactId: generated.artifact.id },
        });
        break;
      }
      await activities.recordEvent({
        runId,
        eventType: "work.foundation.external-pending",
        payload: { workItemId: work.id, modelTaskId: generated.task.id, taskKey: work.taskKey },
      });
      const external = await waitForExternal(generated.task);
      if (external.failed) {
        candidateStartIndex = generated.task.candidateIndex + 1;
        continue;
      }
      const value = external.result?.value ?? external.result;
      if (!value) throw new Error(`外部 foundation 任务未返回结构化结果：${generated.task.id}`);
      const artifact = await activities.materializeExternalFoundation({
        modelTaskId: generated.task.id,
        workItemId: work.id,
        value,
      });
      await activities.recordEvent({
        runId,
        eventType: "work.foundation.generated",
        payload: { workItemId: work.id, taskKey: work.taskKey, artifactId: artifact.id, external: true },
      });
      break;
    }
  }

  // 3. 检查 gate
  const gate = await activities.checkGate({ runId, workItemId: work.id });

  if (gate.passed) {
    // gate 通过 → accept
    await activities.acceptWork({ runId, workItemId: work.id });
    return;
  }

  // 3. gate 未通过：根据 reason 决定后续动作
    // manual gate：持久等待 reviewSubmittedSignal；作者审批可能跨越任意时长。
  if (gate.reason.includes("manual gate")) {
      while (!reviewedWorkItems.has(work.id) && !isCancelled() && !isPaused()) {
        await condition(() => reviewedWorkItems.has(work.id) || isCancelled() || isPaused());
      }

    if (reviewedWorkItems.has(work.id)) {
      // 外部 accept 短路检查：work.accept 命令可能已将 work item 改为 accepted，
      // 此时 checkGate 仍可能返回 not passed（新 artifact 无 review），
      // 但 reviseWork 会把已 accepted 的 work item 打回 pending 造成不必要的重生。
      // 根因：work.accept 外部命令与 workflow 的 manual gate 等待循环没有状态同步。
      const currentWork = await activities.getWorkItem({ workItemId: work.id });
      if (currentWork?.status === "accepted") {
        reviewedWorkItems.delete(work.id);
        return;
      }
      // 收到 review → 重新检查 gate
      const recheckedGate = await activities.checkGate({ runId, workItemId: work.id });
      if (recheckedGate.passed) {
        await activities.acceptWork({ runId, workItemId: work.id });
      } else {
        // review 后仍未通过 → revise（若未达重试上限）
        const current = retryCount.get(work.id) ?? 0;
        if (current < maxRetries) {
          await activities.reviseWork({ runId, workItemId: work.id });
          retryCount.set(work.id, current + 1);
        }
      }
      reviewedWorkItems.delete(work.id);
    }
    return;
  }

  // auto gate：自动 revise（若未达重试上限）
  const current = retryCount.get(work.id) ?? 0;
  if (current < maxRetries) {
    await activities.reviseWork({ runId, workItemId: work.id });
    retryCount.set(work.id, current + 1);
    return;
  }

  // 达到重试上限：标记 work item 失败；run-manager 会把所属 run 派生为 failed 终态。
  await activities.failWork({ runId, workItemId: work.id, reason: `maxRetriesExceeded:${gate.reason}` });
  await activities.recordEvent({
    runId,
    eventType: "work.maxRetriesExceeded",
    payload: {
      workItemId: work.id,
      retryCount: current,
      maxRetries,
      gateReason: gate.reason,
    },
  });
}

// ===== Chapter Review Workflow =====

/**
 * 章节审校工作流：从 review 阶段半截启动，复用 novelIntentWorkflow 的 review/revise/commit activities。
 *
 * 设计依据：AGENTS.md 章节审校工作流复用契约。
 * - 入口等价 v1 startChapterReviewWorkflow（v1 workflow.ts:277），但基于 Temporal。
 * - 跳过 context/blueprint/blueprint-approval/draft 阶段。
 * - 复用 review→revision→commit 闭环，不另起独立修订逻辑。
 *
 * 前置条件（AGENTS.md 契约）：
 * - document.status === "final"（只对已定稿章节开放重审）
 * - 无活跃工作流
 * - 存在历史 blueprint artifact
 *
 * 不设置 conversationThreadId/creativeBriefId：review-stage 在无 threadId 时走 contextPacketId 路径。
 *
 * 数据加载 activities（C-2.4 已接入）：loadHistoricalBlueprint / loadDocumentPlainText /
 * getDefaultRoutingSnapshot / retrieveMemoryForReview。
 */
export async function chapterReviewWorkflow(params: {
  projectId: string;
  documentId: string;
  instruction?: string;
  workflowId?: string;
  proposedArtifactId?: string;
  mode?: "full" | "targeted";
  targetIssueIds?: string[];
}): Promise<void> {
  const activities = proxyActivities<NovelWorkflowActivities>({
    startToCloseTimeout: "10 minutes",
    retry: { maximumAttempts: 3, nonRetryableErrorTypes: ["NonRetryableModelTransportError"] },
  });

  const workflowId = params.workflowId ?? `chapter-review-${params.documentId}-${Date.now()}`;
  let iteration = 0;
  let finalScore: number | undefined;
  let humanDecision: HumanDecision | undefined;
  const externalResults = new Map<string, Record<string, unknown>>();
  const externalFailures = new Map<string, Record<string, unknown>>();
  const persistSignal = async (type: string, payload: unknown) => {
    const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    await activities.recordWorkflowSignal({ workflowId, taskId: typeof body.taskId === "string" ? body.taskId : `${workflowId}:external`, signal: type, payload: body });
  };
  setHandler(claimSignal, async (payload) => { await persistSignal("claim", payload); });
  setHandler(heartbeatSignal, async (payload) => { await persistSignal("heartbeat", payload); });
  setHandler(artifactSignal, async (payload) => {
    await persistSignal("artifact", payload);
    const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    if (typeof body.modelTaskId === "string") externalResults.set(body.modelTaskId, body);
  });
  setHandler(reviewSignal, async (payload) => { await persistSignal("review", payload); });
  setHandler(failSignal, async (payload) => {
    await persistSignal("fail", payload);
    const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    if (typeof body.modelTaskId === "string") externalFailures.set(body.modelTaskId, body);
  });
  setHandler(humanSignal, async (payload) => { await persistSignal("humanSignal", payload); humanDecision = parseHumanDecision(payload); });
  const waitForExternal = async (task: ModelTaskRecord): Promise<{ result?: Record<string, unknown>; failed: boolean }> => {
    const completed = await condition(() => externalResults.has(task.id) || externalFailures.has(task.id), "15 minutes");
    if (!completed) {
      await activities.expireExternalModelTask({ modelTaskId: task.id, reason: "外部模型任务等待超时" });
      return { failed: true };
    }
    if (externalFailures.has(task.id)) {
      externalFailures.delete(task.id);
      return { failed: true };
    }
    const payload = externalResults.get(task.id);
    externalResults.delete(task.id);
    const result = payload?.result;
    return { failed: false, result: result && typeof result === "object" ? result as Record<string, unknown> : undefined };
  };

  // 1. 标记运行中
  await activities.updateWorkflowStatus({
    workflowId,
    status: "running",
    payload: { stage: "init", documentId: params.documentId, instruction: params.instruction },
  });

  try {
    // 1. 加载项目快照（校验 document 存在 + 获取 currentRevision）
    const snapshot = await activities.loadProjectSnapshot({
      projectId: params.projectId,
      targetDocumentId: params.documentId,
    });
    await activities.updateWorkflowStatus({
      workflowId,
      status: "running",
      payload: {
        stage: "snapshot-loaded",
        documentId: params.documentId,
        currentRevision: snapshot.currentRevision,
      },
    });

    // 2. 并行加载数据：历史 blueprint + document plainText + routingSnapshot + memory bundle
    // AGENTS.md 契约：
    //   - blueprint 从历史 draft artifact 反查（review-stage 不重新编译蓝图）
    //   - draft.text = document.plainText（包装为 draft artifact 复用 review/revise activities）
    //   - memory 走 contextPacketId 路径（复用项目最近 memory_bundle，不重新检索）
    const blueprintArtifact = await activities.loadHistoricalBlueprint({
      projectId: params.projectId,
      documentId: params.documentId,
    });
    const [documentState, routingSnapshot, memoryBundle, proposedDraft, planningContext] = await Promise.all([
      activities.loadDocumentPlainText({ projectId: params.projectId, documentId: params.documentId }),
      activities.getDefaultRoutingSnapshot({ projectId: params.projectId, documentId: params.documentId }),
      activities.retrieveMemoryForReview({ projectId: params.projectId, documentId: params.documentId, blueprint: blueprintArtifact.blueprint }),
      params.proposedArtifactId ? activities.loadProposedDraft({ projectId: params.projectId, artifactId: params.proposedArtifactId }) : Promise.resolve(undefined),
      activities.loadChapterPlanningContextSnapshot({ blueprintId: blueprintArtifact.blueprint.id }),
    ]);
    const targetedReview = params.mode === "targeted"
      ? await activities.loadTargetedReviewIssues({ projectId: params.projectId, documentId: params.documentId, issueIds: params.targetIssueIds ?? [] })
      : undefined;
    if (targetedReview && targetedReview.reviewedContentHash !== documentState.contentHash) throw new Error("审核快照与当前正文不一致，请刷新后重试");
    const reviewSkills = await activities.resolveReviewSkills({ projectId: params.projectId, preflightId: blueprintArtifact.blueprint.preflightId });

    await activities.updateWorkflowStatus({
      workflowId,
      status: "running",
      payload: {
        stage: targetedReview ? "revision" : "data-loaded",
        mode: params.mode ?? "full",
        targetIssueCount: targetedReview?.issues.length ?? 0,
        documentId: params.documentId,
        blueprintId: blueprintArtifact.blueprint.id,
        baseRevision: snapshot.currentRevision,
        documentRevision: documentState.documentRevision,
        wordCount: documentState.wordCount,
      },
    });

    // 3. 将定稿正文持久化为不可变 draft artifact，供正式 review/revision/commit 链路复用。
    const sourceText = proposedDraft?.text ?? documentState.plainText;
    const draftArtifact = await activities.createReviewDraft({
      projectId: params.projectId,
      documentId: params.documentId,
      workflowId,
      sourceArtifactId: proposedDraft?.artifact.id ?? documentState.artifactId,
      sourceRevisionId: documentState.sourceRevisionId,
      blueprint: blueprintArtifact.blueprint,
      text: sourceText,
      baseRevision: snapshot.currentRevision,
    });
    let currentDraft = { artifact: draftArtifact, text: sourceText };

    let directedIssues = targetedReview?.issues;
    let revisionInstruction = params.instruction;
    let replayLegacyDirectedOrder = Boolean(targetedReview && !patched("chapter-targeted-revision-first-v1"));
    const useConvergedLifecycle = patched("chapter-review-context-convergence-v1");
    const useContextRefs = patched("chapter-review-context-refs-v1");
    while (true) {
      const cycleStartDraft = currentDraft;
      const lifecycle = await runChapterLifecycle({
        projectId: params.projectId,
        initialDraft: currentDraft,
        review: (current) => runAllReviewers({ workflowId, blueprintId: blueprintArtifact.blueprint.id, runReview: (role, identity) => runReview(current, role, identity) }),
        revise: async (current, reviewList, revisionIteration, issues) => {
          iteration = revisionIteration;
          return runRevision(current, reviewList, issues, revisionInstruction);
        },
        assessLearning: runLearning,
        extractFacts: runFactExtraction,
        approveFacts: (factArtifact) => activities.approveFacts({ workflowId, projectId: params.projectId, artifact: factArtifact }),
        commit: (current, reviewList, factArtifact) => activities.commit({ projectId: params.projectId, documentId: params.documentId, artifact: current.artifact, factArtifact, narrativeOrder: snapshot.targetDocumentOrder, text: current.text, reviews: reviewList, baseRevision: snapshot.currentRevision, idempotencyKey: workflowId }),
        enrich: (current, commitResult, factArtifact) => runEnrichCharacters(current, commitResult.revisionId, snapshot.targetDocumentOrder, factArtifact),
        progress: (payload) => activities.updateWorkflowStatus({ workflowId, status: "running", payload }),
        directedRevision: directedIssues ? { issues: directedIssues, requireManuscriptApproval: true } : undefined,
        reviewBeforeDirectedRevision: replayLegacyDirectedOrder,
        learningMode: useConvergedLifecycle ? "terminal-candidate" : "legacy-each-stage",
      });
      currentDraft = lifecycle.draft;
      iteration = lifecycle.iteration;
      finalScore = lifecycle.finalScore;

      if (lifecycle.commitResult) {
        await activities.updateWorkflowStatus({ workflowId, status: "completed", payload: { documentId: params.documentId, iteration, finalScore, manualReviewRequired: false, enrichmentError: lifecycle.enrichmentError } });
        return;
      }

      humanDecision = undefined;
      await activities.updateWorkflowStatus({ workflowId, status: "manual-review-required", payload: { documentId: params.documentId, iteration, finalScore, artifactId: currentDraft.artifact.id, reviewIds: lifecycle.commitGate.reviewIds, failedReviewIds: lifecycle.commitGate.failedReviewIds, missingReviewerRoles: lifecycle.commitGate.missingRoles, reasonCode: targetedReview ? "targeted-manuscript-approval" : "quality-gate-not-passed", mode: params.mode ?? "full", targetIssueIds: params.targetIssueIds ?? [] } });
      await condition(() => humanDecision !== undefined);
      const decision = humanDecision!;
      if (decision.decision === "reject" || decision.decision === "abandon") {
        await activities.updateWorkflowStatus({ workflowId, status: "abandoned", payload: { documentId: params.documentId, artifactId: currentDraft.artifact.id, restoredArtifactId: draftArtifact.id, authorId: decision.authorId, feedback: decision.feedback, reasonCode: "abandoned-by-author" } });
        return;
      }
      if (decision.decision === "revise") {
        if (!targetedReview) throw new Error("只有定向修订审批可继续按意见修订");
        const latestReviewIssues = lifecycle.reviews.flatMap((review) => review.issues);
        directedIssues = latestReviewIssues;
        if (!directedIssues.length && !decision.feedback) throw new Error("当前候选稿没有审校问题，也未提供补充修改意见");
        if (decision.revisionBase === "previous") currentDraft = cycleStartDraft;
        else currentDraft = await resolveApprovedDraft(currentDraft, decision);
        revisionInstruction = decision.feedback
          ? [params.instruction, decision.feedback].filter(Boolean).join("\n\n作者补充要求：")
          : params.instruction;
        replayLegacyDirectedOrder = false;
        await activities.updateWorkflowStatus({ workflowId, status: "running", payload: { stage: "revision", decision: "author-revision-requested", revisionBase: decision.revisionBase ?? "current", sourceArtifactId: currentDraft.artifact.id, authorId: decision.authorId, targetIssueCount: directedIssues.length } });
        continue;
      }

      const approvedDraft = await resolveApprovedDraft(currentDraft, decision);
      const factArtifact = await runFactExtraction(approvedDraft);
      await activities.approveFacts({ workflowId, projectId: params.projectId, artifact: factArtifact });
      const authorReview: Review = { id: `author-approval:${workflowId}`, projectId: params.projectId, artifactId: approvedDraft.artifact.id, reviewerId: decision.authorId, identity: "human", verdict: "passed", issues: [], artifactFingerprint: approvedDraft.artifact.fingerprint, createdAt: Date.now() };
      const finalized = await finalizeChapterLifecycle({
        projectId: params.projectId,
        draft: approvedDraft,
        reviews: [...lifecycle.reviews, authorReview],
        commit: (current, reviewList, approvedFactArtifact) => activities.commitAuthorApproved({ projectId: params.projectId, documentId: params.documentId, artifact: current.artifact, factArtifact: approvedFactArtifact, narrativeOrder: snapshot.targetDocumentOrder, text: current.text, reviews: reviewList, baseRevision: snapshot.currentRevision, idempotencyKey: `${workflowId}:author-approved` }),
        enrich: (current, commitResult, factArtifact) => runEnrichCharacters(current, commitResult.revisionId, snapshot.targetDocumentOrder, factArtifact),
        assessLearning: runLearning,
        progress: (payload) => activities.updateWorkflowStatus({ workflowId, status: "running", payload }),
        factArtifact,
        assessPostCommitLearning: !useConvergedLifecycle,
      });
      await activities.updateWorkflowStatus({ workflowId, status: "completed", payload: { documentId: params.documentId, artifactId: approvedDraft.artifact.id, ...(approvedDraft.artifact.id === currentDraft.artifact.id ? {} : { replacedArtifactId: currentDraft.artifact.id }), iteration, finalScore, authorApproved: true, authorId: decision.authorId, enrichmentError: finalized.enrichmentError } });
      return;
    }

    // 局部辅助函数（复用 novelIntentWorkflow 的模式，但不依赖其闭包变量）
    async function runReview(current: { artifact: Artifact; text: string }, role: ReviewerRole, identity: "internal" | "independent"): Promise<Review> {
      let candidateStartIndex = 0;
      while (true) {
        const generated = useContextRefs ? await activities.reviewByRefs({
          workflowId,
          artifactId: current.artifact.id,
          blueprintId: blueprintArtifact.blueprint.id,
          memoryBundleId: memoryBundle.id,
          skillBundleId: reviewSkills.id,
          role,
          identity,
          routingSnapshot,
          candidateStartIndex,
          narrativeOrder: snapshot.targetDocumentOrder,
          suppressChapterSnapshotPromotion: Boolean(targetedReview),
        }) : await activities.review({
          workflowId,
          artifact: current.artifact,
          text: current.text,
          blueprint: blueprintArtifact.blueprint,
          memory: memoryBundle,
          skills: reviewSkills,
          role,
          identity,
          routingSnapshot,
          candidateStartIndex,
          narrativeOrder: snapshot.targetDocumentOrder,
          planningContext,
          suppressChapterSnapshotPromotion: Boolean(targetedReview),
        });
        if (generated.kind === "completed") return generated.review;
        const external = await waitForExternal(generated.task);
        if (external.failed) {
          candidateStartIndex = generated.task.candidateIndex + 1;
          continue;
        }
        const value = external.result?.value ?? external.result;
        return activities.materializeExternalReview({ modelTaskId: generated.task.id, artifact: current.artifact, identity, role, value, suppressChapterSnapshotPromotion: Boolean(targetedReview) });
      }
    }

    async function runRevision(current: { artifact: Artifact; text: string }, reviewList: Review[], directedIssues?: ReviewIssue[], authorInstruction?: string): Promise<{ artifact: Artifact; text: string }> {
      // 构造最小 intent（revise activity 需要 intent.projectId）
      const reviewIntent: NovelIntent = {
        id: workflowId,
        projectId: params.projectId,
        source: "chapter-review",
        objective: "revise",
        idempotencyKey: `${workflowId}:revise-${iteration}`,
        createdAt: Date.now(),
      };
      let candidateStartIndex = 0;
      while (true) {
        const strictRevisionWindows = Boolean(directedIssues?.length && !authorInstruction?.trim() && directedIssues.every((issue) => issue.revisionRanges?.length));
        const generated = useContextRefs ? await activities.reviseByRefs({
          workflowId,
          intent: reviewIntent,
          artifactId: current.artifact.id,
          reviewIds: reviewList.map((review) => review.id),
          directedIssues,
          strictRevisionWindows,
          authorInstruction: directedIssues ? authorInstruction : undefined,
          blueprintId: blueprintArtifact.blueprint.id,
          memoryBundleId: memoryBundle.id,
          skillBundleId: reviewSkills.id,
          routingSnapshot,
          candidateStartIndex,
        }) : await activities.revise({
          workflowId,
          intent: reviewIntent,
          artifact: current.artifact,
          text: current.text,
          reviews: reviewList,
          directedIssues,
          strictRevisionWindows,
          authorInstruction: directedIssues ? authorInstruction : undefined,
          memory: memoryBundle,
          blueprint: blueprintArtifact.blueprint,
          skills: reviewSkills,
          routingSnapshot,
          candidateStartIndex,
          planningContext,
        });
        if (generated.kind === "completed") return { artifact: generated.artifact, text: generated.text };
        const external = await waitForExternal(generated.task);
        if (external.failed) {
          candidateStartIndex = generated.task.candidateIndex + 1;
          continue;
        }
        if (strictRevisionWindows) return activities.materializeExternalTargetedRevision({ projectId: params.projectId, modelTaskId: generated.task.id, artifact: current.artifact, text: current.text, issues: directedIssues ?? [] });
        const text = typeof external.result?.text === "string" ? external.result.text : undefined;
        if (!text) throw new Error("外部章节修订任务未返回 text");
        return activities.materializeExternalText({ projectId: params.projectId, modelTaskId: generated.task.id, text, kind: "revision", baseRevision: current.artifact.baseRevision });
      }
    }

    async function runLearning(current: { artifact: Artifact; text: string }, reviewList: Review[]): Promise<RuntimeLearningAssessmentV2> {
      const assessmentKey = String(iteration);
      let candidateStartIndex = 0;
      while (true) {
        const generated = await activities.assessLearning({
          projectId: params.projectId,
          workflowId,
          assessmentKey,
          artifact: current.artifact,
          reviews: reviewList,
          routingSnapshot,
          candidateStartIndex,
        });
        if (generated.kind === "completed") return generated.assessment;
        const external = await waitForExternal(generated.task);
        if (external.failed) {
          candidateStartIndex = generated.task.candidateIndex + 1;
          continue;
        }
        return activities.materializeExternalLearning({ modelTaskId: generated.task.id, projectId: params.projectId, workflowId, artifact: current.artifact, reviews: reviewList });
      }
    }

    async function resolveApprovedDraft(current: { artifact: Artifact; text: string }, decision: HumanDecision): Promise<{ artifact: Artifact; text: string }> {
      if (!decision.approvedArtifactId || decision.approvedArtifactId === current.artifact.id) return current;
      const approved = await activities.loadProposedDraft({ projectId: params.projectId, artifactId: decision.approvedArtifactId });
      if (approved.artifact.projectId !== current.artifact.projectId) throw new Error("作者批准的替换产物不属于当前项目");
      if (approved.artifact.baseRevision !== current.artifact.baseRevision) throw new Error("作者批准的替换产物基线与当前候选不一致");
      return approved;
    }

    async function runFactExtraction(current: { artifact: Artifact; text: string }): Promise<Artifact> {
      let candidateStartIndex = 0;
      while (true) {
        const generated = await activities.extractFacts({
          workflowId,
          projectId: params.projectId,
          artifact: current.artifact,
          text: current.text,
          blueprint: blueprintArtifact.blueprint,
          routingSnapshot,
          candidateStartIndex,
          documentId: params.documentId,
          narrativeOrder: snapshot.targetDocumentOrder,
        });
        if (generated.kind === "completed") return generated.artifact;
        const external = await waitForExternal(generated.task);
        if (external.failed) {
          candidateStartIndex = generated.task.candidateIndex + 1;
          continue;
        }
        return activities.materializeExternalFacts({ modelTaskId: generated.task.id, projectId: params.projectId, artifact: generated.artifact, text: current.text, documentId: params.documentId, narrativeOrder: snapshot.targetDocumentOrder });
      }
    }

    /**
     * 角色富化（character enrichment）局部函数。
     *
     * 设计依据：AGENTS.md「章节审校复用正式闭环 + commitStageHandler → characterEnrichmentStageHandler」契约。
     * 与 novelIntentWorkflow.runEnrichCharacters 同构，支持 internal LLM 与 external-mcp 双路径。
     * narrativeOrder 缺失时跳过 enrichment。
     */
    async function runEnrichCharacters(current: { artifact: Artifact; text: string }, revisionId: string, narrativeOrder: number | undefined, factArtifact?: Artifact): Promise<void> {
      if (narrativeOrder === undefined) return; // 无章节顺序号，跳过 enrichment
      let candidateStartIndex = 0;
      while (true) {
        const generated = await activities.enrichCharacters({
          workflowId,
          projectId: params.projectId,
          documentId: params.documentId,
          revisionId,
          narrativeOrder,
          artifact: current.artifact,
          factArtifact,
          text: current.text,
          routingSnapshot,
          candidateStartIndex,
        });
        if (generated.kind === "completed") return;
        const external = await waitForExternal(generated.task);
        if (external.failed) { candidateStartIndex = generated.task.candidateIndex + 1; continue; }
        await activities.materializeExternalEnrichment({
          modelTaskId: generated.task.id,
          projectId: params.projectId,
          documentId: params.documentId,
          revisionId,
          narrativeOrder,
          artifact: current.artifact,
          text: current.text,
        });
        return;
      }
    }
  } catch (error) {
    await activities.updateWorkflowStatus({
      workflowId,
      status: "failed",
      payload: {
        documentId: params.documentId,
        error: failureMessage(error),
        iteration,
        finalScore,
      },
    });
    throw error;
  }
}
