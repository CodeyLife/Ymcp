import { novelDb, recordBase, type NovelDatabase } from "./db";
import type {
  CreativeBrief,
  CreativeReview,
  CreativeRun,
  CreativeRunEvent,
  CreativeRunMode,
  CreativeRunPolicy,
  CreativeWorkItem,
  CreativeWorkKind,
  GenerationAuditIssue,
  ManuscriptDocument,
  NovelConversationThread,
  NovelGenerationTaskKey,
} from "./types";

export interface CreativeWorkInput {
  kind: CreativeWorkKind;
  taskKey?: NovelGenerationTaskKey;
  targetId?: string;
  instruction: string;
  dependsOn?: string[];
  parameters?: Record<string, unknown>;
}

export interface CreativeReviewIssueInput extends GenerationAuditIssue {
  issueId: string;
  supersedesIssueId?: string;
}

export interface CreativeReviewInput {
  subjectArtifactId: string;
  reviewer: CreativeReview["reviewer"];
  verdict: CreativeReview["verdict"];
  issues: CreativeReviewIssueInput[];
  summary: string;
}

export type CreativeCommand =
  | { runId: string; type: "work.start" | "work.accept" | "review.request"; workItemId: string; idempotencyKey: string }
  | { runId: string; type: "work.revise" | "work.retry"; workItemId: string; instruction?: string; idempotencyKey: string }
  | { runId: string; type: "work.recover"; workItemId: string; force?: boolean; idempotencyKey: string }
  | { runId: string; type: "review.submit"; workItemId: string; review: CreativeReviewInput; idempotencyKey: string }
  | { runId: string; type: "run.pause" | "run.resume" | "run.cancel"; idempotencyKey: string };

export interface CreativeReviewGate {
  passed: boolean;
  verdict?: CreativeReview["verdict"];
  reviewer?: CreativeReview["reviewer"];
  openIssues: Array<CreativeReviewIssueInput & { status: CreativeReview["issues"][number]["status"] }>;
  reason: string;
}

export interface CreativeActionResult {
  runId: string;
  commandType: CreativeCommand["type"];
  workItemId?: string;
  status: CreativeRun["status"];
  workStatus?: CreativeWorkItem["status"];
  artifactRefs: string[];
  reviewId?: string;
  reviewGate?: CreativeReviewGate;
  summary: string;
  nextActions: CreativeNextAction[];
}

export interface CreativeNextAction {
  type: "work.start" | "work.revise" | "work.retry" | "work.recover" | "work.accept" | "review.request" | "review.submit" | "run.resume";
  workItemId?: string;
}

export interface CreativeRunSnapshot {
  run: CreativeRun;
  workItems: CreativeWorkItem[];
  reviews: CreativeReview[];
  reviewGates: Record<string, CreativeReviewGate>;
  events: CreativeRunEvent[];
  nextActions: CreativeNextAction[];
}

export interface CreativeWorkExecutionResult {
  artifactRefs?: string[];
  summary: string;
  followUpWork?: Array<CreativeWorkInput & { chainAfterPrevious?: boolean }>;
}

export type CreativeWorkExecutor = (work: CreativeWorkItem, run: CreativeRun) => Promise<CreativeWorkExecutionResult>;
export type CreativeWorkReviewer = (work: CreativeWorkItem, run: CreativeRun) => Promise<CreativeReviewInput>;
export type CreativeWorkAccepter = (work: CreativeWorkItem, run: CreativeRun) => Promise<CreativeWorkExecutionResult>;

export interface CreativeExecutionDependencies {
  db?: NovelDatabase;
  executor?: CreativeWorkExecutor;
  reviewer?: CreativeWorkReviewer;
  accepter?: CreativeWorkAccepter;
}

const MODE_POLICIES: Record<CreativeRunMode, CreativeRunPolicy> = {
  manual: { auditTrigger: "manual", commitPolicy: "manual", qualityThreshold: 3.7, maxIterations: 2 },
  "segment-auto": { auditTrigger: "automatic", commitPolicy: "quality-gated-auto", qualityThreshold: 3.7, maxIterations: 2 },
  external: { auditTrigger: "external", commitPolicy: "external-auto", qualityThreshold: 3.7, maxIterations: 3 },
};

function resolveRunPolicy(mode: CreativeRunMode, overrides?: Partial<CreativeRunPolicy>): CreativeRunPolicy {
  const authority = MODE_POLICIES[mode];
  if (overrides?.auditTrigger !== undefined && overrides.auditTrigger !== authority.auditTrigger) {
    throw new Error(`运行模式 ${mode} 的 auditTrigger 不可覆盖`);
  }
  if (overrides?.commitPolicy !== undefined && overrides.commitPolicy !== authority.commitPolicy) {
    throw new Error(`运行模式 ${mode} 的 commitPolicy 不可覆盖`);
  }
  const qualityThreshold = overrides?.qualityThreshold ?? authority.qualityThreshold;
  const maxIterations = overrides?.maxIterations ?? authority.maxIterations;
  if (!Number.isFinite(qualityThreshold) || qualityThreshold < 0 || qualityThreshold > 5) {
    throw new Error("qualityThreshold 必须是 0 到 5 之间的有限数值");
  }
  if (!Number.isInteger(maxIterations) || maxIterations < 0 || maxIterations > 20) {
    throw new Error("maxIterations 必须是 0 到 20 之间的整数");
  }
  return { ...authority, qualityThreshold, maxIterations };
}

type EventInput = Omit<CreativeRunEvent, keyof ReturnType<typeof recordBase> | "creativeRunId" | "sequence">;

async function appendEvent(run: CreativeRun, input: EventInput, db: NovelDatabase): Promise<CreativeRunEvent> {
  const event: CreativeRunEvent = {
    ...recordBase(run.projectId),
    creativeRunId: run.id,
    sequence: run.lastEventSequence + 1,
    ...input,
  };
  await db.creativeRunEvents.add(event);
  run.lastEventSequence = event.sequence;
  run.updatedAt = Date.now();
  run.revision += 1;
  await db.creativeRuns.put(run);
  return event;
}

export async function createCreativeRun(
  input: { projectId: string; mode: CreativeRunMode; objective: string; policy?: Partial<CreativeRunPolicy>; baseSnapshotHash?: string },
  db: NovelDatabase = novelDb,
): Promise<CreativeRun> {
  if (!input.projectId.trim()) throw new Error("projectId 不能为空");
  if (!input.objective.trim()) throw new Error("创作目标不能为空");
  const project = await db.projects.get(input.projectId);
  if (!project) throw new Error("创作项目不存在");
  const run: CreativeRun = {
    ...recordBase(input.projectId),
    mode: input.mode,
    objective: input.objective.trim(),
    status: "running",
    policy: resolveRunPolicy(input.mode, input.policy),
    baseSnapshotHash: input.baseSnapshotHash,
    lastEventSequence: 0,
  };
  await db.transaction("rw", db.creativeRuns, db.creativeRunEvents, async () => {
    await db.creativeRuns.add(run);
    await appendEvent(run, { type: "run.created", payload: { mode: run.mode, objective: run.objective } }, db);
  });
  return run;
}

export async function enqueueCreativeWork(
  runId: string,
  input: CreativeWorkInput,
  db: NovelDatabase = novelDb,
): Promise<CreativeWorkItem> {
  const run = await db.creativeRuns.get(runId);
  if (!run) throw new Error("创作运行不存在");
  if (["completed", "failed", "cancelled"].includes(run.status)) throw new Error(`创作运行不可再添加任务：${run.status}`);
  if (!input.instruction.trim()) throw new Error("创作任务指令不能为空");
  const work: CreativeWorkItem = {
    ...recordBase(run.projectId),
    creativeRunId: run.id,
    kind: input.kind,
    status: "queued",
    taskKey: input.taskKey,
    targetId: input.targetId,
    instruction: input.instruction.trim(),
    dependsOn: [...new Set(input.dependsOn ?? [])],
    iteration: 0,
    artifactRefs: [],
    parameters: structuredClone(input.parameters ?? {}),
  };
  if (work.dependsOn.includes(work.id)) throw new Error("创作任务不能依赖自身");
  const dependencies = work.dependsOn.length ? await db.creativeWorkItems.bulkGet(work.dependsOn) : [];
  if (dependencies.some((dependency) => !dependency || dependency.creativeRunId !== run.id)) {
    throw new Error("创作任务依赖不存在或属于其他运行");
  }
  await db.transaction("rw", db.creativeRuns, db.creativeWorkItems, db.creativeRunEvents, async () => {
    await db.creativeWorkItems.add(work);
    await appendEvent(run, { type: "work.enqueued", workItemId: work.id, payload: { kind: work.kind, taskKey: work.taskKey } }, db);
  });
  return work;
}

async function appendFollowUpWork(
  run: CreativeRun,
  parent: CreativeWorkItem,
  inputs: NonNullable<CreativeWorkExecutionResult["followUpWork"]>,
  db: NovelDatabase,
): Promise<CreativeWorkItem[]> {
  const created: CreativeWorkItem[] = [];
  let previousId = parent.id;
  for (const input of inputs) {
    const dependsOn = input.chainAfterPrevious
      ? [...new Set([...(input.dependsOn ?? []), previousId])]
      : [...new Set(input.dependsOn ?? [])];
    const work: CreativeWorkItem = {
      ...recordBase(run.projectId),
      creativeRunId: run.id,
      kind: input.kind,
      status: "queued",
      taskKey: input.taskKey,
      targetId: input.targetId,
      instruction: input.instruction.trim(),
      dependsOn,
      iteration: 0,
      artifactRefs: [],
      parameters: structuredClone(input.parameters ?? {}),
    };
    await db.creativeWorkItems.add(work);
    await appendEvent(run, { type: "work.enqueued", workItemId: work.id, payload: { kind: work.kind, taskKey: work.taskKey, parentWorkItemId: parent.id } }, db);
    created.push(work);
    previousId = work.id;
  }
  return created;
}

export function evaluateCreativeReviewGate(reviews: CreativeReview[]): CreativeReviewGate {
  if (!reviews.length) return { passed: false, openIssues: [], reason: "尚未产生审核结果" };
  const ordered = [...reviews].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const latest = ordered.at(-1)!;
  const currentGeneration = ordered.filter((review) => review.subjectArtifactId === latest.subjectArtifactId);
  const supersededIds = new Set(currentGeneration.flatMap((review) => review.issues.map((issue) => issue.supersedesIssueId).filter((id): id is string => Boolean(id))));
  const openIssues = currentGeneration
    .flatMap((review) => review.issues)
    .filter((issue) => issue.status === "open" && !supersededIds.has(issue.issueId));
  const unresolvedMajor = openIssues.some((issue) => issue.severity === "blocker" || issue.severity === "major");
  const passed = latest.verdict === "passed" && !unresolvedMajor;
  const reason = passed
    ? "审核通过且没有未解决的 blocker/major"
    : latest.verdict === "inconclusive"
      ? "审核结果不确定，不能自动提交"
      : unresolvedMajor
        ? "仍有未解决的 blocker/major"
        : `最新审核结论为 ${latest.verdict}`;
  return { passed, verdict: latest.verdict, reviewer: latest.reviewer, openIssues, reason };
}

function reviewGateAllowsCommit(run: CreativeRun, gate: CreativeReviewGate): boolean {
  return gate.passed && (run.mode !== "external" || gate.reviewer === "external-llm" || gate.reviewer === "user");
}

function groupReviewsByWork(reviews: CreativeReview[]): Map<string, CreativeReview[]> {
  const grouped = new Map<string, CreativeReview[]>();
  for (const review of reviews) {
    const list = grouped.get(review.workItemId) ?? [];
    list.push(review);
    grouped.set(review.workItemId, list);
  }
  return grouped;
}

function availableActions(run: CreativeRun, workItems: CreativeWorkItem[], reviews: CreativeReview[]): CreativeNextAction[] {
  if (["completed", "cancelled"].includes(run.status)) return [];
  const actions: CreativeNextAction[] = [];
  if (run.status === "failed") {
    for (const item of workItems.filter((candidate) => candidate.status === "failed")) actions.push({ type: "work.retry", workItemId: item.id });
    return actions;
  }
  if (run.status === "paused") actions.push({ type: "run.resume" });
  const completed = new Set(workItems.filter((item) => item.status === "completed").map((item) => item.id));
  if (run.status !== "paused") {
    for (const item of workItems.filter((candidate) => candidate.status === "queued" && candidate.dependsOn.every((dependency) => completed.has(dependency)))) {
      actions.push({ type: "work.start", workItemId: item.id });
    }
  }
  for (const item of workItems.filter((candidate) => candidate.status === "running" && (candidate.leaseExpiresAt ?? 0) <= Date.now())) {
    actions.push({ type: "work.recover", workItemId: item.id });
  }
  const groupedReviews = groupReviewsByWork(reviews);
  for (const item of workItems.filter((candidate) => candidate.status === "waiting-review" || candidate.status === "blocked")) {
    actions.push({ type: "review.request", workItemId: item.id }, { type: "review.submit", workItemId: item.id });
    const gate = evaluateCreativeReviewGate(groupedReviews.get(item.id) ?? []);
    if ((gate.verdict === "revise" || gate.verdict === "blocked") && item.iteration < run.policy.maxIterations) actions.push({ type: "work.revise", workItemId: item.id });
    if (run.mode === "manual" || reviewGateAllowsCommit(run, gate)) actions.push({ type: "work.accept", workItemId: item.id });
  }
  return actions;
}

export async function inspectCreativeRun(runId: string, afterSequence?: number, db: NovelDatabase = novelDb): Promise<CreativeRunSnapshot> {
  const run = await db.creativeRuns.get(runId);
  if (!run) throw new Error("创作运行不存在");
  const [workItems, reviews, allEvents] = await Promise.all([
    db.creativeWorkItems.where("creativeRunId").equals(runId).toArray().then((items) => items.sort((left, right) => {
      const createdOrder = left.createdAt - right.createdAt;
      if (createdOrder) return createdOrder;
      const leftOrder = typeof left.parameters.chapterOrder === "number" ? left.parameters.chapterOrder : Number.MAX_SAFE_INTEGER;
      const rightOrder = typeof right.parameters.chapterOrder === "number" ? right.parameters.chapterOrder : Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.id.localeCompare(right.id);
    })),
    db.creativeReviews.where("creativeRunId").equals(runId).sortBy("createdAt"),
    db.creativeRunEvents.where("creativeRunId").equals(runId).sortBy("sequence"),
  ]);
  const reviewGroups = groupReviewsByWork(reviews);
  const reviewGates = Object.fromEntries(workItems.map((work) => [work.id, evaluateCreativeReviewGate(reviewGroups.get(work.id) ?? [])]));
  const events = afterSequence === undefined ? allEvents : allEvents.filter((event) => event.sequence > afterSequence);
  return { run, workItems, reviews, reviewGates, events, nextActions: availableActions(run, workItems, reviews) };
}

export async function findCreativeWorkForArtifact(
  projectId: string,
  artifactId: string,
  db: NovelDatabase = novelDb,
): Promise<CreativeWorkItem | undefined> {
  return db.creativeWorkItems.where("projectId").equals(projectId)
    .and((work) => work.artifactRefs.includes(artifactId))
    .reverse()
    .sortBy("createdAt")
    .then((items) => items[0]);
}

export async function startManualCreativeGeneration(
  input: { projectId: string; taskKey: NovelGenerationTaskKey; targetId?: string; instruction: string },
  db: NovelDatabase = novelDb,
  dependencies: Omit<CreativeExecutionDependencies, "db"> = {},
): Promise<CreativeActionResult> {
  const run = await createCreativeRun({ projectId: input.projectId, mode: "manual", objective: input.instruction }, db);
  const work = await enqueueCreativeWork(run.id, {
    kind: "generation",
    taskKey: input.taskKey,
    targetId: input.targetId,
    instruction: input.instruction,
  }, db);
  return executeCreativeCommand({ runId: run.id, type: "work.start", workItemId: work.id, idempotencyKey: `manual:start:${work.id}` }, { ...dependencies, db });
}

async function prepareChapterEvaluationContext(document: ManuscriptDocument, instruction: string, db: NovelDatabase) {
  return db.transaction("rw", db.conversationThreads, db.creativeBriefs, async () => {
    let thread = await db.conversationThreads.where("[projectId+targetId]").equals([document.projectId, document.id])
      .and((item) => item.taskKey === "chapter-workflow" && item.status === "active")
      .first();
    if (!thread) {
      thread = {
        ...recordBase(document.projectId),
        taskKey: "chapter-workflow",
        targetId: document.id,
        title: `${document.title} · 创作协作`,
        summary: "",
        status: "active",
        pinnedSourceIds: [],
        excludedSourceIds: [],
        lastMessageAt: Date.now(),
      } satisfies NovelConversationThread;
      await db.conversationThreads.add(thread);
    }
    const existingDraft = await db.creativeBriefs.where("threadId").equals(thread.id)
      .and((item) => item.status === "draft")
      .reverse()
      .sortBy("updatedAt");
    const base = existingDraft[0] ?? {
      ...recordBase(document.projectId),
      threadId: thread.id,
      targetDocumentId: document.id,
      status: "draft" as const,
      goal: document.blueprint.objective || "完成本章正文",
      povCharacterId: document.blueprint.povCharacterId,
      factCutoffOrder: document.order - 1,
      tone: "",
      languageRequirements: [],
      mustHappen: [...document.blueprint.mustHappen],
      forbidden: [...document.blueprint.forbidden],
      targetWords: document.blueprint.targetWords,
      referencedMemoryIds: [],
      openQuestions: [],
      sourceMessageIds: [],
    } satisfies CreativeBrief;
    const now = Date.now();
    const brief: CreativeBrief = {
      ...base,
      goal: instruction.trim(),
      targetWords: document.blueprint.targetWords,
      openQuestions: [],
      status: "confirmed",
      confirmedAt: now,
      revision: base.revision + 1,
      updatedAt: now,
    };
    await db.creativeBriefs.put(brief);
    return { thread, brief };
  });
}

async function defaultExecutor(work: CreativeWorkItem, _run: CreativeRun, db: NovelDatabase): Promise<CreativeWorkExecutionResult> {
  if (work.kind === "generation") {
    if (!work.taskKey) throw new Error("generation work 缺少 taskKey");
    const { runGenerationTask, runPlotDesignTask } = await import("./generation");
    if (work.taskKey === "plot-design") {
      const [architecture, nodes] = await Promise.all([
        db.architectures.where("projectId").equals(work.projectId).first(),
        db.outlineNodes.where("projectId").equals(work.projectId).toArray(),
      ]);
      const phases = [...(architecture?.phases ?? [])].sort((left, right) => left.order - right.order);
      const latestNode = [...nodes].sort((left, right) => right.updatedAt - left.updatedAt)[0];
      const phaseId = work.targetId || latestNode?.phaseId || phases[0]?.id;
      if (!phaseId) throw new Error("plot-design 缺少可规划的架构阶段");
      const result = await runPlotDesignTask({ projectId: work.projectId, phaseId, instruction: work.instruction, audit: { maxIterations: 1 } });
      return { artifactRefs: [result.proposal.id], summary: result.proposal.title };
    }
    let targetId = work.targetId;
    if (work.taskKey === "chapter-plan" && !targetId) {
      const documents = await db.documents.where("projectId").equals(work.projectId).sortBy("order");
      targetId = documents.find((document) => !document.deletedAt && document.status === "outline")?.id
        ?? documents.find((document) => !document.deletedAt)?.id;
      if (!targetId) throw new Error("chapter-plan 缺少可规划的正式章节");
    }
    const result = await runGenerationTask({ projectId: work.projectId, taskKey: work.taskKey, targetId, instruction: work.instruction });
    return { artifactRefs: [result.proposal.id], summary: result.proposal.title };
  }
  if (work.kind === "plot-segment") {
    if (!work.targetId) throw new Error("plot-segment work 缺少 phaseId");
    const { runPlotDesignTask } = await import("./generation");
    const result = await runPlotDesignTask({ projectId: work.projectId, phaseId: work.targetId, instruction: work.instruction, audit: { maxIterations: 1 } });
    return { artifactRefs: [result.proposal.id], summary: result.proposal.title };
  }
  if (work.kind === "chapter-workflow") {
    if (!work.targetId) throw new Error("chapter-workflow work 缺少 documentId");
    const document = await db.documents.get(work.targetId);
    if (!document || document.projectId !== work.projectId) throw new Error("章节不存在或不属于当前项目");
    const { thread, brief: confirmed } = await prepareChapterEvaluationContext(document, work.instruction, db);
    const { runClosedLoop } = await import("./evaluation/closed-loop");
    const ruleCandidateId = typeof work.parameters.ruleCandidateId === "string" ? work.parameters.ruleCandidateId : undefined;
    const ruleCandidate = ruleCandidateId ? await db.craftRuleCandidates.get(ruleCandidateId) : undefined;
    if (ruleCandidateId && (!ruleCandidate || ruleCandidate.projectId !== work.projectId)) throw new Error("规则候选不存在或不属于当前项目");
    const result = await runClosedLoop({
      canonicalDb: db,
      projectId: work.projectId,
      chapterId: document.id,
      threadId: thread.id,
      briefId: confirmed.id,
      instruction: work.instruction,
      codeRevision: "creative-engine-v1",
      authorId: "creative-engine",
      dryRun: true,
      ruleOverride: ruleCandidate ? {
        id: ruleCandidate.id,
        targetKind: ruleCandidate.targetKind,
        targetId: ruleCandidate.targetId,
        version: ruleCandidate.proposedVersion,
        text: work.parameters.evaluationRole === "baseline" ? ruleCandidate.beforeText : ruleCandidate.afterText,
      } : undefined,
    });
    if (ruleCandidate) {
      const expectedRef = `${ruleCandidate.targetKind === "system-prompt" ? "system-prompt:" : ""}${ruleCandidate.targetId}@${ruleCandidate.proposedVersion}`;
      const appliedStages = (result.candidate.provenance.stagePromptEvidence ?? [])
        .filter((evidence) => evidence.skillRefs.includes(expectedRef))
        .map((evidence) => evidence.stage);
      if (!appliedStages.length) {
        throw new Error(`规则候选未进入实际工作流 Prompt：${expectedRef}`);
      }
      work.parameters.ruleApplication = {
        candidateId: ruleCandidate.id,
        evaluationRole: work.parameters.evaluationRole,
        targetKind: ruleCandidate.targetKind,
        targetId: ruleCandidate.targetId,
        version: ruleCandidate.proposedVersion,
        promptFingerprint: result.candidate.provenance.promptFingerprint,
        stages: [...new Set(appliedStages)],
      };
    }
    work.parameters.closedLoopCandidate = structuredClone(result.candidate);
    work.parameters.closedLoopCheck = structuredClone(result.check);
    work.parameters.workflowRunId = result.workflowRunId;
    return {
      artifactRefs: [result.candidate.id],
      summary: `${document.title}候选已生成，质量分 ${result.candidate.qualityEvidence.weightedScore.toFixed(2)}`,
    };
  }
  throw new Error(`work kind 尚未接入默认执行器：${work.kind}`);
}

async function defaultReviewer(work: CreativeWorkItem, _run: CreativeRun, db: NovelDatabase): Promise<CreativeReviewInput> {
  const subjectArtifactId = work.artifactRefs[0];
  if (!subjectArtifactId) throw new Error("创作任务没有可审核产物");
  if (work.kind === "plot-segment" || work.kind === "generation") {
    const proposal = await db.proposals.get(subjectArtifactId);
    const report = proposal?.auditReport;
    if (!report) {
      if (!proposal) return { subjectArtifactId, reviewer: "internal", verdict: "inconclusive", summary: "待审核 Proposal 不存在", issues: [] };
      const project = await db.projects.get(work.projectId);
      if (!project) return { subjectArtifactId, reviewer: "internal", verdict: "inconclusive", summary: "项目不存在", issues: [] };
      const { callStructuredNovelModel } = await import("./ai");
      const { auditIssueSchema } = await import("./workflow-shared");
      const audited = await callStructuredNovelModel<{ summary: string; issues: GenerationAuditIssue[] }>({
        model: project.settings.textModel,
        temperature: 0.15,
        role: "quality-editor",
        schema: auditIssueSchema,
        maxTokens: 4096,
        prompt: `# 创作候选审核\n审核以下结构化创作候选是否满足作者指令、项目既有事实、引用完整性和长篇可持续性。只报告有具体证据的问题，不为凑数制造问题。\n\n## 作者指令\n${work.instruction}\n\n## 候选类型\n${proposal.taskKey ?? work.kind}\n\n## 候选内容\n${proposal.previewMarkdown}\n\n## 输出要求\n每个问题给出 severity、dimension、title、evidence 和可执行 suggestion。`,
      });
      const issues = audited.data.issues.map((issue, index) => ({ ...issue, issueId: `${proposal.id}:manual-audit:${index}` }));
      const majorCount = issues.filter((issue) => issue.severity === "blocker" || issue.severity === "major").length;
      return { subjectArtifactId, reviewer: "internal", verdict: majorCount ? "revise" : "passed", summary: audited.data.summary, issues };
    }
    if (report.error) {
      return { subjectArtifactId, reviewer: "internal", verdict: "inconclusive", summary: report.error, issues: [] };
    }
    const lastRound = report.rounds.at(-1);
    const issues = (lastRound?.issues ?? []).map((issue, index) => ({
      ...issue,
      issueId: `${proposal.id}:audit:${lastRound?.iteration ?? 0}:${index}`,
    }));
    return {
      subjectArtifactId,
      reviewer: "internal",
      verdict: report.remainingMajorCount > 0 ? "revise" : "passed",
      summary: lastRound?.summary ?? "审核完成",
      issues,
    };
  }
  if (work.kind === "chapter-workflow") {
    const candidate = work.parameters.closedLoopCandidate as {
      id?: string;
      qualityEvidence?: {
        weightedScore?: number;
        blockerCount?: number;
        majorCount?: number;
        topIssues?: Array<{ severity: string; dimension: string; summary: string }>;
      };
    } | undefined;
    const check = work.parameters.closedLoopCheck as { status?: string; issues?: string[]; deterministicBlockers?: string[] } | undefined;
    if (!candidate?.qualityEvidence || !check) {
      return { subjectArtifactId, reviewer: "internal", verdict: "inconclusive", summary: "章节候选缺少闭环质量证据", issues: [] };
    }
    const quality = candidate.qualityEvidence;
    const issues: CreativeReviewIssueInput[] = (quality.topIssues ?? []).map((issue, index) => ({
      issueId: `${candidate.id ?? subjectArtifactId}:quality:${index}`,
      severity: issue.severity === "blocker" || issue.severity === "major" ? issue.severity : "warning",
      dimension: ["plot", "characterVoice", "sceneEmbodiment", "dialogue", "specificity", "hookPayoff", "continuity"].includes(issue.dimension)
        ? issue.dimension as CreativeReviewIssueInput["dimension"]
        : "continuity",
      title: issue.summary,
      evidence: issue.summary,
      suggestion: "根据质量报告修订后重新审核。",
    }));
    for (const [index, blocker] of [...(check.deterministicBlockers ?? []), ...(check.issues ?? [])].entries()) {
      issues.push({ issueId: `${candidate.id ?? subjectArtifactId}:gate:${index}`, severity: "blocker", dimension: "continuity", title: blocker, evidence: blocker, suggestion: "解决门禁问题后重新运行。" });
    }
    const score = quality.weightedScore ?? 0;
    const passed = check.status === "ready" && score >= _run.policy.qualityThreshold && (quality.blockerCount ?? 0) === 0 && (quality.majorCount ?? 0) === 0;
    return {
      subjectArtifactId,
      reviewer: "internal",
      verdict: passed ? "passed" : check.status === "ready" ? "revise" : "blocked",
      summary: passed ? `章节候选通过质量门禁（${score.toFixed(2)}）` : `章节候选未通过质量门禁（${score.toFixed(2)}）`,
      issues,
    };
  }
  return { subjectArtifactId, reviewer: "internal", verdict: "inconclusive", summary: `尚未为 ${work.kind} 接入审核执行器`, issues: [] };
}

async function defaultAccepter(work: CreativeWorkItem, _run: CreativeRun, db: NovelDatabase): Promise<CreativeWorkExecutionResult> {
  if (work.kind === "generation" || work.kind === "plot-segment") {
    const proposalId = work.artifactRefs[0];
    if (!proposalId) throw new Error("创作任务没有可采纳 Proposal");
    const { applyProposalItems } = await import("./generation");
    const proposal = await db.proposals.get(proposalId);
    if (!proposal) throw new Error("待采纳 Proposal 不存在");
    const existingSegmentIds = work.kind === "plot-segment"
      ? new Set((await db.outlineNodes.where("projectId").equals(work.projectId).toArray()).map((item) => item.id))
      : undefined;
    await applyProposalItems(proposal.id, proposal.items.map((item) => item.id));
    if (work.kind === "plot-segment") {
      const createdSegment = (await db.outlineNodes.where("projectId").equals(work.projectId).toArray())
        .filter((item) => !existingSegmentIds!.has(item.id))
        .sort((left, right) => right.createdAt - left.createdAt)[0];
      if (!createdSegment) throw new Error("剧情段采纳后未找到新建剧情段");
      work.parameters.createdPlotSegmentId = createdSegment.id;
      const chapters = await db.documents.where("projectId").equals(work.projectId)
        .and((document) => document.plotSegmentId === createdSegment.id && !document.deletedAt)
        .sortBy("order");
      return {
        artifactRefs: [proposal.id, createdSegment.id],
        summary: `${proposal.title}已采纳，将继续生成 ${chapters.length} 个章节`,
        followUpWork: chapters.map((chapter) => ({
          kind: "chapter-workflow" as const,
          targetId: chapter.id,
          instruction: chapter.blueprint.objective || chapter.summary || `完成${chapter.title}`,
          chainAfterPrevious: true,
          parameters: { plotSegmentId: createdSegment.id, chapterOrder: chapter.order },
        })),
      };
    }
    return { artifactRefs: [proposal.id], summary: `${proposal.title}已采纳` };
  }
  if (work.kind === "chapter-workflow") {
    const candidate = work.parameters.closedLoopCandidate;
    if (!candidate || typeof candidate !== "object") throw new Error("章节任务缺少可晋升候选");
    if (work.parameters.evaluationRole === "baseline" || work.parameters.evaluationRole === "candidate") {
      return { artifactRefs: [String((candidate as { id?: string }).id ?? work.artifactRefs[0])], summary: "规则评测候选已保留在隔离实验中，未修改正式正文或规则" };
    }
    const { promoteClosedLoopCandidate } = await import("./evaluation/closed-loop");
    const promoted = await promoteClosedLoopCandidate({
      candidate: candidate as Parameters<typeof promoteClosedLoopCandidate>[0]["candidate"],
      canonicalDb: db,
      authorId: _run.mode === "external" ? "external-llm" : "segment-auto",
    });
    if (promoted.receipt.status !== "promoted" && promoted.receipt.status !== "already-promoted") {
      throw new Error(promoted.receipt.error ?? "章节候选晋升失败");
    }
    return {
      artifactRefs: [String((candidate as { id?: string }).id ?? work.artifactRefs[0]), ...(promoted.receipt.createdRevisionId ? [promoted.receipt.createdRevisionId] : [])],
      summary: "章节候选已通过门禁并晋升正式项目",
    };
  }
  return { artifactRefs: work.artifactRefs, summary: work.summary ?? "创作任务已完成" };
}

async function loadCommandResult(command: CreativeCommand, db: NovelDatabase): Promise<CreativeActionResult | undefined> {
  const events = await db.creativeRunEvents
    .where("[creativeRunId+idempotencyKey]")
    .equals([command.runId, command.idempotencyKey])
    .toArray();
  const event = events
    .filter((candidate) => Boolean(candidate.payload.result))
    .sort((left, right) => right.sequence - left.sequence)[0];
  return event?.payload.result ? structuredClone(event.payload.result) as unknown as CreativeActionResult : undefined;
}

async function storeReview(params: {
  run: CreativeRun;
  work: CreativeWorkItem;
  input: CreativeReviewInput;
  idempotencyKey: string;
  db: NovelDatabase;
}): Promise<CreativeReview> {
  const { run, work, input, idempotencyKey, db } = params;
  if (!input || typeof input !== "object") throw new Error("审核结果不能为空");
  if (!input.subjectArtifactId?.trim()) throw new Error("审核对象不能为空");
  if (!["internal", "external-llm", "user"].includes(input.reviewer)) throw new Error("审核者类型无效");
  if (!["passed", "revise", "blocked", "inconclusive"].includes(input.verdict)) throw new Error("审核结论无效");
  if (!Array.isArray(input.issues)) throw new Error("审核问题必须是数组");
  if (typeof input.summary !== "string" || !input.summary.trim()) throw new Error("审核摘要不能为空");
  if (!work.artifactRefs.includes(input.subjectArtifactId)) throw new Error("审核对象不属于当前创作任务");
  const priorReviews = await db.creativeReviews.where("workItemId").equals(work.id).toArray();
  const priorIssueIds = new Set(priorReviews.flatMap((review) => review.issues.map((issue) => issue.issueId)));
  const currentArtifactIssueIds = new Set(priorReviews
    .filter((review) => review.subjectArtifactId === input.subjectArtifactId)
    .flatMap((review) => review.issues.map((issue) => issue.issueId)));
  const issueIds = new Set<string>();
  for (const issue of input.issues) {
    if (!issue.issueId.trim()) throw new Error("审核问题缺少 issueId");
    if (issueIds.has(issue.issueId)) throw new Error(`审核问题 issueId 重复：${issue.issueId}`);
    if (priorIssueIds.has(issue.issueId)) throw new Error(`审核问题 issueId 已存在：${issue.issueId}`);
    if (issue.supersedesIssueId === issue.issueId) throw new Error("审核问题不能取代自身");
    if (issue.supersedesIssueId && !currentArtifactIssueIds.has(issue.supersedesIssueId)) {
      throw new Error(`被取代的审核问题不存在于当前产物代际：${issue.supersedesIssueId}`);
    }
    issueIds.add(issue.issueId);
  }
  const review: CreativeReview = {
    ...recordBase(run.projectId),
    createdAt: Math.max(Date.now(), ...priorReviews.map((prior) => prior.createdAt + 1)),
    updatedAt: Math.max(Date.now(), ...priorReviews.map((prior) => prior.createdAt + 1)),
    creativeRunId: run.id,
    workItemId: work.id,
    subjectArtifactId: input.subjectArtifactId,
    reviewer: input.reviewer,
    verdict: input.verdict,
    issues: input.issues.map((issue) => ({ ...structuredClone(issue), status: "open" })),
    summary: input.summary.trim(),
  };
  await db.creativeReviews.add(review);
  const reviews = [...priorReviews, review];
  const gate = evaluateCreativeReviewGate(reviews);
  const result: CreativeActionResult = {
    runId: run.id,
    commandType: input.reviewer === "internal" ? "review.request" : "review.submit",
    workItemId: work.id,
    status: run.status,
    workStatus: work.status,
    artifactRefs: work.artifactRefs,
    reviewId: review.id,
    reviewGate: gate,
    summary: review.summary,
    nextActions: availableActions(run, await db.creativeWorkItems.where("creativeRunId").equals(run.id).toArray(), reviews),
  };
  await appendEvent(run, { type: "review.recorded", workItemId: work.id, idempotencyKey, payload: { reviewId: review.id, result } }, db);
  return review;
}

function updateRunStatusFromWork(run: CreativeRun, workItems: CreativeWorkItem[]): void {
  if (workItems.length > 0 && workItems.every((work) => work.status === "completed" || work.status === "cancelled")) {
    run.status = "completed";
    run.finishedAt = Date.now();
    return;
  }
  if (workItems.some((work) => work.status === "blocked")) {
    run.status = "paused";
    return;
  }
  if (workItems.some((work) => work.status === "waiting-review")) {
    run.status = "waiting-review";
    return;
  }
  run.status = "running";
}

async function failWork(run: CreativeRun, work: CreativeWorkItem, error: unknown, idempotencyKey: string, db: NovelDatabase): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  work.status = "failed";
  work.error = message;
  work.leaseExpiresAt = undefined;
  work.activeIdempotencyKey = undefined;
  work.updatedAt = Date.now();
  work.revision += 1;
  run.status = "failed";
  run.error = message;
  run.activeWorkItemId = undefined;
  await db.creativeWorkItems.put(work);
  await appendEvent(run, { type: "work.failed", workItemId: work.id, idempotencyKey, payload: { error: message } }, db);
  throw error;
}

export async function executeCreativeCommand(
  command: CreativeCommand,
  dependencies: CreativeExecutionDependencies = {},
): Promise<CreativeActionResult> {
  const db = dependencies.db ?? novelDb;
  const existing = await loadCommandResult(command, db);
  if (existing) return existing;
  const run = await db.creativeRuns.get(command.runId);
  if (!run) throw new Error("创作运行不存在");
  let workItems = await db.creativeWorkItems.where("creativeRunId").equals(run.id).toArray();
  const reviews = await db.creativeReviews.where("creativeRunId").equals(run.id).toArray();

  if (command.type === "run.pause" || command.type === "run.resume" || command.type === "run.cancel") {
    if (["completed", "cancelled"].includes(run.status)) throw new Error(`创作运行不能再变更状态：${run.status}`);
    run.status = command.type === "run.pause" ? "paused" : command.type === "run.cancel" ? "cancelled" : "running";
    if (run.status === "cancelled") run.finishedAt = Date.now();
    const result: CreativeActionResult = { runId: run.id, commandType: command.type, status: run.status, artifactRefs: [], summary: `运行状态已更新为 ${run.status}`, nextActions: availableActions(run, workItems, reviews) };
    await appendEvent(run, { type: "run.status-changed", idempotencyKey: command.idempotencyKey, payload: { result } }, db);
    return result;
  }

  if (!("workItemId" in command)) throw new Error(`命令缺少 workItemId：${command.type}`);
  const work = workItems.find((item) => item.id === command.workItemId);
  if (!work) throw new Error("创作任务不存在");

  if (command.type === "review.request" || command.type === "review.submit") {
    if (!["waiting-review", "blocked"].includes(work.status)) throw new Error("创作任务当前没有可审核产物");
    const reviewInput = command.type === "review.submit"
      ? command.review
      : await (dependencies.reviewer ?? ((item, activeRun) => defaultReviewer(item, activeRun, db)))(work, run);
    const review = await storeReview({ run, work, input: reviewInput, idempotencyKey: command.idempotencyKey, db });
    const workReviews = await db.creativeReviews.where("workItemId").equals(work.id).toArray();
    const gate = evaluateCreativeReviewGate(workReviews);
    const refreshedRun = await db.creativeRuns.get(run.id) ?? run;
    const refreshedWork = await db.creativeWorkItems.get(work.id) ?? work;
    const allReviews = await db.creativeReviews.where("creativeRunId").equals(run.id).toArray();
    const reviewResult: CreativeActionResult = {
      runId: run.id,
      commandType: command.type,
      workItemId: work.id,
      status: refreshedRun.status,
      workStatus: refreshedWork.status,
      artifactRefs: work.artifactRefs,
      reviewId: review.id,
      reviewGate: gate,
      summary: review.summary,
      nextActions: availableActions(refreshedRun, workItems, allReviews),
    };
    if (command.type === "review.submit" && run.policy.commitPolicy === "external-auto" && reviewGateAllowsCommit(run, gate)) {
      const accepted = await executeCreativeCommand({
        runId: run.id,
        type: "work.accept",
        workItemId: work.id,
        idempotencyKey: `${command.idempotencyKey}:external-auto-accept`,
      }, dependencies);
      const result = { ...accepted, commandType: command.type, reviewId: review.id } satisfies CreativeActionResult;
      const committedRun = await db.creativeRuns.get(run.id) ?? run;
      await appendEvent(committedRun, { type: "work.completed", workItemId: work.id, idempotencyKey: command.idempotencyKey, payload: { result, autoAccepted: true } }, db);
      return result;
    }
    return reviewResult;
  }

  if (command.type === "work.revise") {
    if (!["waiting-review", "blocked"].includes(work.status)) throw new Error("创作任务当前不能进入下一轮修订");
    if (work.iteration >= run.policy.maxIterations) throw new Error(`创作任务已达到最大迭代次数：${run.policy.maxIterations}`);
    const instruction = command.instruction?.trim();
    if (instruction) {
      const baseInstruction = typeof work.parameters.baseInstruction === "string" && work.parameters.baseInstruction.trim()
        ? work.parameters.baseInstruction.trim()
        : work.instruction;
      work.parameters.baseInstruction = baseInstruction;
      work.instruction = `${baseInstruction}\n\n# 本轮审核驱动修订\n${instruction}`;
    }
    work.iteration += 1;
    work.status = "queued";
    work.artifactRefs = [];
    work.summary = undefined;
    work.error = undefined;
    work.leaseExpiresAt = undefined;
    work.activeIdempotencyKey = undefined;
    work.updatedAt = Date.now();
    work.revision += 1;
    run.status = "running";
    run.error = undefined;
    await db.creativeWorkItems.put(work);
    workItems = workItems.map((item) => item.id === work.id ? work : item);
    const result: CreativeActionResult = {
      runId: run.id,
      commandType: command.type,
      workItemId: work.id,
      status: run.status,
      workStatus: work.status,
      artifactRefs: [],
      summary: `创作任务已进入第 ${work.iteration + 1} 轮`,
      nextActions: availableActions(run, workItems, reviews),
    };
    await appendEvent(run, { type: "work.requeued", workItemId: work.id, idempotencyKey: command.idempotencyKey, payload: { result, iteration: work.iteration } }, db);
    return result;
  }

  if (command.type === "work.retry") {
    if (work.status !== "failed") throw new Error("只有失败的创作任务可以技术重试");
    const instruction = command.instruction?.trim();
    if (instruction) {
      const baseInstruction = typeof work.parameters.baseInstruction === "string" && work.parameters.baseInstruction.trim()
        ? work.parameters.baseInstruction.trim()
        : work.instruction;
      work.parameters.baseInstruction = baseInstruction;
      work.instruction = `${baseInstruction}\n\n# 技术失败重试\n${instruction}`;
    }
    work.status = "queued";
    work.artifactRefs = [];
    work.summary = undefined;
    work.error = undefined;
    work.leaseExpiresAt = undefined;
    work.activeIdempotencyKey = undefined;
    work.updatedAt = Date.now();
    work.revision += 1;
    run.status = "running";
    run.error = undefined;
    await db.creativeWorkItems.put(work);
    workItems = workItems.map((item) => item.id === work.id ? work : item);
    const result: CreativeActionResult = {
      runId: run.id,
      commandType: command.type,
      workItemId: work.id,
      status: run.status,
      workStatus: work.status,
      artifactRefs: [],
      summary: "技术失败任务已重新排队，审核迭代次数保持不变",
      nextActions: availableActions(run, workItems, reviews),
    };
    await appendEvent(run, { type: "work.retried", workItemId: work.id, idempotencyKey: command.idempotencyKey, payload: { result, iteration: work.iteration } }, db);
    return result;
  }

  if (command.type === "work.recover") {
    if (work.status !== "running") throw new Error("只有 running 工作项可以恢复");
    if (!command.force && (work.leaseExpiresAt ?? Number.MAX_SAFE_INTEGER) > Date.now()) throw new Error("工作项执行租约尚未过期；确认旧执行端已终止后才能强制恢复");
    work.status = "queued";
    work.leaseExpiresAt = undefined;
    work.activeIdempotencyKey = undefined;
    work.error = undefined;
    work.updatedAt = Date.now();
    work.revision += 1;
    run.activeWorkItemId = undefined;
    run.status = "running";
    run.error = undefined;
    await db.creativeWorkItems.put(work);
    workItems = workItems.map((item) => item.id === work.id ? work : item);
    const result: CreativeActionResult = { runId: run.id, commandType: command.type, workItemId: work.id, status: run.status, workStatus: work.status, artifactRefs: work.artifactRefs, summary: "中断的创作任务已恢复为可重试状态", nextActions: availableActions(run, workItems, reviews) };
    await appendEvent(run, { type: "work.requeued", workItemId: work.id, idempotencyKey: command.idempotencyKey, payload: { result, recovered: true } }, db);
    return result;
  }

  if (command.type === "work.accept") {
    if (!["waiting-review", "blocked"].includes(work.status)) throw new Error("创作任务当前不等待审核决策");
    const gate = evaluateCreativeReviewGate(reviews.filter((review) => review.workItemId === work.id));
    if (run.mode !== "manual" && !reviewGateAllowsCommit(run, gate)) {
      const reason = run.mode === "external" && gate.passed ? "外部运行需要 external-llm 或用户审核结论" : gate.reason;
      throw new Error(`审核门禁未通过：${reason}`);
    }
    try {
      const accepted = await (dependencies.accepter ?? ((item, activeRun) => defaultAccepter(item, activeRun, db)))(work, run);
      work.artifactRefs = [...new Set([...work.artifactRefs, ...(accepted.artifactRefs ?? [])])];
      work.summary = accepted.summary;
      work.status = "completed";
      work.revision += 1;
      work.updatedAt = Date.now();
      workItems = workItems.map((item) => item.id === work.id ? work : item);
      if (accepted.followUpWork?.length) workItems.push(...await appendFollowUpWork(run, work, accepted.followUpWork, db));
      updateRunStatusFromWork(run, workItems);
      await db.creativeWorkItems.put(work);
      const result: CreativeActionResult = { runId: run.id, commandType: command.type, workItemId: work.id, status: run.status, workStatus: work.status, artifactRefs: work.artifactRefs, reviewGate: gate, summary: accepted.summary, nextActions: availableActions(run, workItems, reviews) };
      await appendEvent(run, { type: "work.completed", workItemId: work.id, idempotencyKey: command.idempotencyKey, payload: { result } }, db);
      return result;
    } catch (error) {
      return failWork(run, work, error, command.idempotencyKey, db);
    }
  }

  if (work.status !== "queued") throw new Error(`创作任务不可启动：${work.status}`);
  const incompleteDependency = work.dependsOn.find((id) => !workItems.some((item) => item.id === id && item.status === "completed"));
  if (incompleteDependency) throw new Error(`创作任务依赖尚未完成：${incompleteDependency}`);
  work.status = "running";
  work.leaseExpiresAt = Date.now() + 20 * 60 * 1000;
  work.activeIdempotencyKey = command.idempotencyKey;
  work.updatedAt = Date.now();
  work.revision += 1;
  run.activeWorkItemId = work.id;
  await db.creativeWorkItems.put(work);
  await appendEvent(run, { type: "work.started", workItemId: work.id, idempotencyKey: command.idempotencyKey, payload: {} }, db);

  try {
    const executed = await (dependencies.executor ?? ((item, activeRun) => defaultExecutor(item, activeRun, db)))(work, run);
    work.artifactRefs = [...new Set(executed.artifactRefs ?? [])];
    work.summary = executed.summary;
    work.status = "waiting-review";
    work.leaseExpiresAt = undefined;
    work.activeIdempotencyKey = undefined;
    work.updatedAt = Date.now();
    work.revision += 1;
    run.activeWorkItemId = undefined;
    run.status = "waiting-review";
    await db.creativeWorkItems.put(work);
    workItems = workItems.map((item) => item.id === work.id ? work : item);

    if (run.policy.auditTrigger === "automatic") {
      const reviewInput = await (dependencies.reviewer ?? ((item, activeRun) => defaultReviewer(item, activeRun, db)))(work, run);
      await storeReview({ run, work, input: reviewInput, idempotencyKey: `${command.idempotencyKey}:auto-review`, db });
      const workReviews = await db.creativeReviews.where("workItemId").equals(work.id).toArray();
      const gate = evaluateCreativeReviewGate(workReviews);
      if (!gate.passed) {
        work.status = "blocked";
        work.error = gate.reason;
        work.revision += 1;
        work.updatedAt = Date.now();
        run.status = "paused";
        await db.creativeWorkItems.put(work);
        workItems = workItems.map((item) => item.id === work.id ? work : item);
        const result: CreativeActionResult = { runId: run.id, commandType: command.type, workItemId: work.id, status: run.status, workStatus: work.status, artifactRefs: work.artifactRefs, reviewGate: gate, summary: gate.reason, nextActions: availableActions(run, workItems, workReviews) };
        await appendEvent(run, { type: "work.blocked", workItemId: work.id, idempotencyKey: command.idempotencyKey, payload: { result } }, db);
        return result;
      }
      const accepted = await (dependencies.accepter ?? ((item, activeRun) => defaultAccepter(item, activeRun, db)))(work, run);
      work.artifactRefs = [...new Set([...work.artifactRefs, ...(accepted.artifactRefs ?? [])])];
      work.summary = accepted.summary;
      work.status = "completed";
      work.revision += 1;
      work.updatedAt = Date.now();
      workItems = workItems.map((item) => item.id === work.id ? work : item);
      if (accepted.followUpWork?.length) workItems.push(...await appendFollowUpWork(run, work, accepted.followUpWork, db));
      updateRunStatusFromWork(run, workItems);
      await db.creativeWorkItems.put(work);
      const result: CreativeActionResult = { runId: run.id, commandType: command.type, workItemId: work.id, status: run.status, workStatus: work.status, artifactRefs: work.artifactRefs, reviewGate: gate, summary: accepted.summary, nextActions: availableActions(run, workItems, workReviews) };
      await appendEvent(run, { type: "work.completed", workItemId: work.id, idempotencyKey: command.idempotencyKey, payload: { result } }, db);
      return result;
    }

    const result: CreativeActionResult = { runId: run.id, commandType: command.type, workItemId: work.id, status: run.status, workStatus: work.status, artifactRefs: work.artifactRefs, summary: executed.summary, nextActions: availableActions(run, workItems, reviews) };
    await appendEvent(run, { type: "work.result-ready", workItemId: work.id, idempotencyKey: command.idempotencyKey, payload: { result } }, db);
    return result;
  } catch (error) {
    return failWork(run, work, error, command.idempotencyKey, db);
  }
}
