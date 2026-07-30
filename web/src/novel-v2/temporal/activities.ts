import { createHash, randomUUID } from "node:crypto";
import Ajv from "ajv";
import type { Artifact, ContextManifest, CreativeRun, CreativeWorkItem, ExecutionBlueprint, MemoryBundle, MemoryClaim, MemoryHit, MemoryProvider, NovelIntent, PreflightPlan, PreflightProjectSnapshot, PromptContextManifest, Review, ReviewIssue, RuntimeLearningAssessmentV2, SkillBundle, SkillProvider, StageGoalContract, TaskAttemptRecord } from "../protocol";
import { buildContextManifest, buildMemoryBundle, compileExecutionBlueprint, computeTokenBudget, createPreflightPlan, matchedFacetsOf, resolveSkillBundle } from "../cognition";
import { canonicalSha256 } from "../canonical-json";
import { NovelPostgresRepository } from "../postgres-repository";
import type { ModelGateway } from "../model-gateway";
import { ExternalMcpRequiredError, type ModelExecutionProvenance, type ModelPurpose, type ModelRoutingSnapshot, type ModelTaskRecord, type ModelWorkPackage } from "../model-routing";
import { ContentObjectStore } from "../object-store";
import { parseStoryArcBundle, type ChapterPlanningContext, type StoryArcBundle } from "../application/story-arc";
import { buildStoryArcBatchPrompt, buildStoryArcPrompt, buildStoryArcReviewPrompt, buildStoryArcRevisionPrompt, storyArcBundleSchema, storyArcReviewSchema, type StoryArcReviewOutput } from "../prompts/story-arc";
import { foundationArtifactToMemoryClaim } from "../foundation-memory";
import { CommitService } from "../commit-service";
import type { MemoryIndex } from "../qdrant-memory";
import { assessRuntimeLearningWithModel, blockingReviewIssues, buildRuntimeLearningPrompt, parseRuntimeLearningAssessmentV2, runtimeLearningAssessmentSchema } from "../learning-assessment";
import { buildChapterDraftPromptPackage } from "../prompts/chapter-draft";
import { buildChapterReviewPromptPackage, getReviewFocus, REVIEWER_DIMENSIONS, selectReviewerMemory, selectReviewerSkills, toReview, type ReviewerRole } from "../prompts/chapter-review";
import { buildChapterReflectionPrompt } from "../prompts/chapter-reflection";
import { applyRevisionWindows, applyTargetedRevisionReplacements, authorRevisionAlignmentSchema, buildAuthorRevisionRepairPrompt, buildFullChapterRevisionPromptPackage, buildRevisionWindowPrompt, buildTargetedRevisionBatchPrompt, planRevisionWindows, revisionWindowsCoverAllIssues, shouldUseRevisionWindows, splitChapterParagraphs, targetedRevisionBatchSchema, type AuthorRevisionAlignment, type TargetedRevisionReplacement } from "../prompts/chapter-revision";
import { chapterStateDeltaSchema, foundationSchema, reflectionSchema, reviewerSchemaForDimensions, type ChapterStateDelta, type FactExtractionOutput, type FoundationOutput, type ReflectionOutput, type ReviewerOutput } from "../prompts/schemas";
import { extractFactsWithStats, projectFactExtractionOutput } from "../fact-extraction";
import { enrichCharactersFromChapter, parseCharacterEnrichmentOutput, persistCharacterEnrichment, validateCharacterEnrichmentOutput } from "../character-enrichment";
import { characterEnrichmentSchema } from "../prompts/schemas";
import { buildFactExtractionPrompt } from "../fact-extraction/prompt";
import { createCraftRuleCandidate } from "../craft-rule";
import { countNovelCharacters } from "../word-count";
import { buildFoundationPrompt, FOUNDATION_SYSTEM_PROMPT } from "../prompts/foundation";
import { compileStageContext, createStageGoalContract } from "../stage-context";
import { reviewIssueFingerprint } from "../chapter-review-snapshot";
import {
  BOOK_SYNOPSIS_SCHEMA,
  BOOK_TITLE_CANDIDATES_SCHEMA,
  bookSynopsisSourceFingerprint,
  bookTitleSourceFingerprint,
  buildBookSynopsisPrompt,
  buildBookTitleCandidatesPrompt,
  normalizeBookTitleCandidates,
  type BookSynopsisRecord,
  type BookTitleCandidate,
  type BookTitleCandidatesRecord,
} from "../application/book-synopsis";
import {
  CHAPTER_TITLE_SCHEMA,
  buildChapterTitlePrompt,
  chapterTitleSourceFingerprint,
  normalizeChapterTitle,
} from "../application/chapter-title";
import {
  acceptWork as creativeAcceptWork,
  attachArtifact as creativeAttachArtifact,
  checkGate as creativeCheckGate,
  getCreativeRun,
  getWorkItem as creativeGetWorkItem,
  listWorkItems as creativeListWorkItems,
  retryWork as creativeRetryWork,
  reviseWork as creativeReviseWork,
  startWork as creativeStartWork,
  updateRunStatusFromWork,
  failWork as creativeFailWork,
} from "../creative";

function assertStructuredSchema(value: unknown, schema: Record<string, unknown>, label: string): void {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (!validate(value)) throw new Error(`${label}不符合输出契约：${validate.errors?.map((item) => `${item.instancePath || "root"} ${item.message ?? ""}`).join("；") ?? "未知错误"}`);
}

type GeneratedTextResult = { kind: "completed"; artifact: Artifact; text: string } | { kind: "external"; task: ModelTaskRecord };
type GeneratedReviewResult = { kind: "completed"; review: Review } | { kind: "external"; task: ModelTaskRecord };
type GeneratedArtifactResult = { kind: "completed"; artifact: Artifact } | { kind: "external"; task: ModelTaskRecord; artifact: Artifact };
type GeneratedLearningResult = { kind: "completed"; assessment: RuntimeLearningAssessmentV2 } | { kind: "external"; task: ModelTaskRecord };
type GeneratedStoryArcResult = { kind: "completed"; artifact: Artifact; bundle: StoryArcBundle } | { kind: "external"; task: ModelTaskRecord };
type GeneratedStoryArcReviewResult = { kind: "completed"; artifact: Artifact; review: StoryArcReviewOutput } | { kind: "external"; task: ModelTaskRecord };
type GeneratedBookSynopsisResult = { kind: "completed"; text: string } | { kind: "external"; task: ModelTaskRecord };
type GeneratedBookTitleCandidatesResult = { kind: "completed"; candidates: BookTitleCandidate[] } | { kind: "external"; task: ModelTaskRecord };
type GeneratedChapterTitleResult = { kind: "completed"; title: string } | { kind: "external"; task: ModelTaskRecord };

export function createNovelWorkflowActivities(deps: { repository: NovelPostgresRepository; memoryProvider: MemoryProvider; skillProvider: SkillProvider; modelGateway: ModelGateway; objectStore?: ContentObjectStore; commitService?: CommitService; memoryIndex?: MemoryIndex; /** 是否启用 chapter memory 创建（默认 true，需 modelGateway 支持）。 */ enableChapterMemory?: boolean }) {
  const model = deps.modelGateway;
  const objects = deps.objectStore ?? new ContentObjectStore();
  // CommitService 自动注入 chapter memory 依赖（若未提供 commitService 且未显式禁用）
  // 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约
  const enableChapterMemory = deps.enableChapterMemory ?? true;
  const commitService = deps.commitService ?? new CommitService(deps.repository, objects, enableChapterMemory ? { model, memoryIndex: deps.memoryIndex } : undefined);
  const reviewerPurpose = (role: ReviewerRole): ModelPurpose => ({
    "style-reviewer": "review.style",
    "character-reviewer": "review.character",
    "continuity-reviewer": "review.continuity",
    "plot-reviewer": "review.plot",
    "reader-reviewer": "review.reader",
  } satisfies Record<ReviewerRole, ModelPurpose>)[role];
  const makeArtifact = async (input: { projectId: string; taskId: string; kind: Artifact["kind"]; baseRevision: number; text: string; structuredData?: Record<string, unknown> }): Promise<Artifact> => {
    const object = await objects.putText(input.text);
    const artifact = { id: randomUUID(), projectId: input.projectId, taskId: input.taskId, attemptId: randomUUID(), kind: input.kind, contentHash: object.hash, objectKey: object.key, structuredData: input.structuredData, baseRevision: input.baseRevision, createdAt: Date.now(), fingerprint: createHash("sha256").update(`${object.hash}:${input.taskId}`).digest("hex") } satisfies Artifact;
    await deps.repository.recordArtifact(artifact);
    return artifact;
  };
  const compileSinglePrompt = (input: { projectId: string; workflowId: string; purpose: ModelPurpose; stage: "foundation" | "planning" | "review" | "revision" | "fact-extraction"; system: string; prompt: string; schema?: Record<string, unknown>; reservedOutputTokens?: number; provenanceRefs?: string[] }) => compileStageContext({
    projectId: input.projectId,
    workflowId: input.workflowId,
    purpose: input.purpose,
    stage: input.stage,
    system: input.system,
    schema: input.schema,
    maxInputTokens: 128_000,
    reservedOutputTokens: input.reservedOutputTokens ?? 8_192,
    sections: [{ id: `${input.stage}-prompt`, kind: "background", title: "阶段任务与上下文", text: input.prompt, priority: "required", provenanceRefs: input.provenanceRefs ?? [] }],
  });
  const externalTask = async (input: { workflowId: string; taskId: string; purpose: ModelPurpose; candidateIndex: number; routingSnapshot: ModelRoutingSnapshot; outputKind: ModelWorkPackage["outputKind"]; system?: string; instruction: string; schema?: Record<string, unknown>; schemaName?: string; baseRevision: number; contextRefs: ModelWorkPackage["contextRefs"]; promptContext?: PromptContextManifest }): Promise<ModelTaskRecord> => {
    const inputFingerprint = createHash("sha256").update(JSON.stringify({ purpose: input.purpose, system: input.system, instruction: input.instruction, schema: input.schema, baseRevision: input.baseRevision, contextRefs: input.contextRefs, promptContextFingerprint: input.promptContext?.fingerprint })).digest("hex");
    const id = createHash("sha256").update(`${input.workflowId}:${input.taskId}:${input.candidateIndex}:${inputFingerprint}`).digest("hex");
    const workPackage: ModelWorkPackage = { id, workflowRunId: input.workflowId, taskId: input.taskId, purpose: input.purpose, configRevision: input.routingSnapshot.id, candidateIndex: input.candidateIndex, outputKind: input.outputKind, system: input.system, instruction: input.instruction, schema: input.schema, schemaName: input.schemaName, baseRevision: input.baseRevision, inputFingerprint, contextRefs: input.contextRefs, promptContext: input.promptContext, createdAt: Date.now() };
    return deps.repository.createModelTask(workPackage, `${input.workflowId}:${input.taskId}:${input.candidateIndex}:${inputFingerprint}`);
  };
  const recordLearning = async (assessment: RuntimeLearningAssessmentV2) => {
    const recorded = await deps.repository.recordLearningAssessment(assessment);
    if (recorded.conclusion === "propose-improvement" && recorded.candidate) {
      const underlyingMechanism = recorded.underlyingMechanism;
      const affectedInputClass = recorded.affectedInputClass;
      if (!underlyingMechanism || !affectedInputClass) {
        throw new Error("propose-improvement 已落库但缺少 underlyingMechanism/affectedInputClass，不能创建改进候选");
      }
      await createCraftRuleCandidate(deps.repository, {
        projectId: recorded.projectId,
        targetKind: recorded.candidate.targetKind,
        targetId: recorded.candidate.targetId,
        afterText: recorded.candidate.afterText,
        rationale: recorded.candidate.rationale,
        scope: {
          observedSymptom: recorded.symptom ?? "未记录症状",
          failingLayer: recorded.failingLayer ?? "未记录失败层",
          underlyingMechanism,
          affectedInputClass,
          intendedBenefits: [recorded.candidate.rationale],
          boundaries: recorded.boundaries ? [recorded.boundaries] : [],
          nonGoals: [],
          regressionRisks: recorded.regressionRisks ?? [],
        },
        learningSource: {
          assessmentId: recorded.id,
          conclusion: recorded.conclusion,
          mechanism: underlyingMechanism,
        },
        applicableGenres: recorded.candidate.applicableGenres,
      });
    }
    return recorded;
  };
  const api = {
    updateWorkflowStatus: (input: { workflowId: string; status: string; payload?: Record<string, unknown> }) => deps.repository.updateWorkflowRunStatus(input.workflowId, input.status, input.payload),
    recordWorkflowSignal: (input: { workflowId: string; taskId: string; signal: string; payload?: Record<string, unknown> }) => deps.repository.recordTaskSignal(input),
    updateTaskAttempt: (input: { id: string; workflowRunId?: string; taskId: string; status: TaskAttemptRecord["status"]; payload?: Record<string, unknown> }) => deps.repository.upsertTaskAttempt(input),
    loadProjectSnapshot: (input: { projectId: string; targetDocumentId?: string }) => deps.repository.getProjectSnapshot(input.projectId, input.targetDocumentId),
    createPreflight: async (input: { intent: NovelIntent; snapshot: PreflightProjectSnapshot }) => createPreflightPlan(input.intent, input.snapshot),
    retrieveMemory: async (input: { projectId: string; plan: PreflightPlan }): Promise<MemoryBundle> => {
      const repairedFoundationClaims = await deps.repository.ensureFoundationMemoryClaims(input.projectId);
      if (repairedFoundationClaims.length && deps.memoryIndex) {
        try {
          await deps.memoryIndex.upsertClaims(input.projectId, repairedFoundationClaims);
        } catch (error) {
          console.warn(`[foundation-memory] 历史 projection 的 Qdrant 索引失败，PostgreSQL 真源已保留：${(error as Error).message}`);
        }
      }
      // Phase 2.3 动态上下文预算：根据 taskClass + totalChapters 计算合理预算
      // 设计依据：Phase 2.3 计划——长篇后期需要更多前章记忆（chapter memory + 伏笔 + 角色状态）
      let totalChapters: number | undefined;
      try {
        totalChapters = await deps.repository.countDocuments(input.projectId);
      } catch {
        // 查询失败时降级为默认预算（computeTokenBudget 会返回 24K）
        totalChapters = undefined;
      }
      const tokenBudget = computeTokenBudget(input.plan.taskClass, totalChapters);
      let narrativeHits: MemoryHit[] = [];
      if (input.plan.taskClass === "drafting" || input.plan.taskClass === "revision" || input.plan.taskClass === "planning") {
        try {
          const { foreshadowings, promises } = await deps.repository.getOpenForeshadowingAndPromises(input.projectId, input.plan.narrativeCutoff);
          narrativeHits = [
            ...foreshadowings.map((f) => ({
              id: f.id,
              projectId: input.projectId,
              kind: "working" as const,
              title: `未兑现伏笔：${f.description.slice(0, 40)}`,
              content: `伏笔内容：${f.description}\n触发关键词：${f.triggerKeywords.join("、")}\n预期兑现：${f.expectedPayoffWindow}\n埋设于：${f.plantedRevisionId}`,
              subjectRefs: [],
              knowledgeScope: "author" as const,
              authority: "derived" as const,
              confidence: 0.9,
              sourceRevisionIds: [f.plantedRevisionId],
              contentHash: f.id,
              supersedes: [],
              score: 1.0,
              matchedFacet: "foreshadowing",
              reason: "open-foreshadowing-injection",
              semanticRank: 1.0,
            })),
            ...promises.map((p) => ({
              id: p.id,
              projectId: input.projectId,
              kind: "working" as const,
              title: `未兑现承诺：${p.statement.slice(0, 40)}`,
              content: `承诺内容：${p.statement}\n承诺者：${p.promiser || "未知"}\n被承诺者：${p.promisee || "未知"}\n来源：${p.sourceRevisionId}`,
              subjectRefs: [],
              knowledgeScope: "author" as const,
              authority: "derived" as const,
              confidence: 0.9,
              sourceRevisionIds: [p.sourceRevisionId],
              contentHash: p.id,
              supersedes: [],
              score: 1.0,
              matchedFacet: "foreshadowing",
              reason: "open-promise-injection",
              semanticRank: 1.0,
            })),
          ];
        } catch (narrativeError) {
          console.warn(`[retrieveMemory] 伏笔/承诺候选加载失败（不阻塞 memory bundle）：${(narrativeError as Error).message}`);
        }
      }
      return buildMemoryBundle(input.plan, { projectId: input.projectId, provider: deps.memoryProvider, tokenBudget, pinnedClaims: narrativeHits });
    },
    resolveSkills: (input: { projectId: string; plan: PreflightPlan; memory: MemoryBundle; requestedCapabilities?: string[]; genre?: string }) => resolveSkillBundle(input.plan, input.memory, { projectId: input.projectId, provider: deps.skillProvider, requestedCapabilities: input.requestedCapabilities, genre: input.genre }),
    resolveReviewSkills: async (input: { projectId: string; preflightId: string }): Promise<SkillBundle> => {
      const skills = (await deps.skillProvider.list(input.projectId)).filter((skill) => skill.enabled && skill.applicableTasks.includes("review"));
      const bundle: SkillBundle = { id: `review-skills:${input.preflightId}:${Date.now()}`, projectId: input.projectId, preflightId: input.preflightId, skills: skills.map((skill) => ({ skillId: skill.skillId, version: skill.version, capabilities: skill.capabilities, applicableTasks: skill.applicableTasks, requiredMemoryKinds: skill.requiredMemoryKinds, qualityGates: skill.qualityGates, promptSections: skill.promptSections })), conflicts: [], missingCapabilities: [], fingerprint: "", createdAt: Date.now() };
      bundle.fingerprint = canonicalSha256(bundle.skills);
      return bundle;
    },
    compileBlueprint: async (input: { intent: NovelIntent; plan: PreflightPlan; memory: MemoryBundle; skills: SkillBundle; snapshot: PreflightProjectSnapshot; foundationArtifacts?: Artifact[]; planningContext?: ChapterPlanningContext }): Promise<{ blueprint: ExecutionBlueprint; context: ContextManifest; routingSnapshot: ModelRoutingSnapshot }> => {
      const context = buildContextManifest(input.plan, input.memory, { retrievalRunId: `retrieval:${input.plan.id}` });
      const blueprint = compileExecutionBlueprint(input.intent, input.plan, input.memory, input.skills, input.snapshot, context, input.foundationArtifacts, input.planningContext);
      await deps.repository.putCognition(input.plan, input.memory, input.skills, blueprint, context);
      if (input.planningContext && input.intent.target?.id) await deps.repository.putChapterPlanningContext(blueprint.id, input.intent.target.id, input.planningContext);
      return { blueprint, context, routingSnapshot: model.getRoutingSnapshot() };
    },
    enforceMemoryCoverage: async (input: { projectId: string; workflowId: string; taskClass: PreflightPlan["taskClass"]; criticalMissingFacets: string[] }) => {
      if (input.taskClass !== "drafting" && input.taskClass !== "revision") return { consecutiveCriticalMisses: 0, blocked: false };
      return deps.repository.recordMemoryGateCheck({ projectId: input.projectId, workflowId: input.workflowId, criticalMissingFacets: input.criticalMissingFacets });
    },
    /**
     * 加载项目下所有 foundation artifacts(全书规划产出)。
     *
     * 设计依据:AGENTS.md「root-cause analysis」——v2 重构后 foundation artifacts 未被章节生成
     * 消费,导致章节生成不基于全书规划。此 activity 是 novelIntentWorkflow 加载规划产出的入口,
     * 供前置检查(必填 taskKey 清单)与 compileBlueprint/draft 注入使用。
     */
    listFoundationArtifacts: async (input: { projectId: string }) => {
      const current = await deps.repository.listCurrentFoundationArtifacts(input.projectId);
      return current.length ? current : deps.repository.listFoundationArtifacts(input.projectId);
    },
    assertRequiredPlanApproved: (input: { projectId: string }) => deps.repository.assertRequiredPlanApproved(input.projectId),
    loadChapterPlanningContext: (input: { projectId: string; documentId: string }) => deps.repository.getChapterPlanningContext(input.projectId, input.documentId),
    loadChapterPlanningContextSnapshot: (input: { blueprintId: string }) => deps.repository.getChapterPlanningContextSnapshot(input.blueprintId),
    draft: async (input: { workflowId: string; intent: NovelIntent; blueprint: ExecutionBlueprint; memory: MemoryBundle; skills: SkillBundle; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; foundationArtifacts?: Artifact[]; planningContext?: ChapterPlanningContext }): Promise<GeneratedTextResult> => {
      const system = "你是长篇小说写作 Worker。只写当前章节正文，不解释流程；只使用冻结 MemoryBundle 和 SkillBundle 中的事实；严格尊重叙事截止、视角知识边界、章节功能、文风目标和质量门。";
      const promptPackage = buildChapterDraftPromptPackage({ ...input, system });
      const prompt = promptPackage.instruction;
      try {
        const generated = await model.generateText({
            purpose: "writing.draft",
            system,
            prompt,
            maxTokens: input.blueprint.budget.maxOutputTokens,
            workflowRunId: input.workflowId,
            taskId: `${input.blueprint.id}:draft`,
            routingSnapshot: input.routingSnapshot,
            candidateStartIndex: input.candidateStartIndex,
            promptContext: promptPackage.manifest,
          });
        return { kind: "completed", artifact: await makeArtifact({ projectId: input.intent.projectId, taskId: `${input.blueprint.id}:draft`, kind: "draft", baseRevision: input.blueprint.baseRevision, text: generated.text, structuredData: { modelProvenance: generated.provenance, workflowId: input.workflowId } }), text: generated.text };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const task = await externalTask({ workflowId: input.workflowId, taskId: `${input.blueprint.id}:draft`, purpose: "writing.draft", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "text", system, instruction: prompt, baseRevision: input.blueprint.baseRevision, contextRefs: { blueprintId: input.blueprint.id, memoryBundleId: input.memory.id, skillBundleId: input.skills.id }, promptContext: promptPackage.manifest });
        return { kind: "external", task };
      }
    },
    review: async (input: { workflowId: string; artifact: Artifact; text: string; blueprint: ExecutionBlueprint; memory: MemoryBundle; skills: SkillBundle; role: ReviewerRole; identity: "internal" | "independent"; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; narrativeOrder?: number; planningContext?: ChapterPlanningContext; suppressChapterSnapshotPromotion?: boolean; stageGoal?: StageGoalContract }): Promise<GeneratedReviewResult> => {
      // Phase 3.2: reader-reviewer 注入前章爽点统计，基于事实检查连续无爽点
      // 设计依据：AGENTS.md「reusable contracts over case-specific rules」——
      // 不在 prompt 里硬编码阈值，把结构化数据给 LLM 判断。
      // 首章（narrativeOrder 未提供或 <= 1）不查询，避免无意义 DB 调用。
      let payoffStats: Awaited<ReturnType<typeof deps.repository.getRecentPayoffStats>> | undefined;
      if (input.role === "reader-reviewer" && input.narrativeOrder !== undefined && input.narrativeOrder > 1) {
        try {
          payoffStats = await deps.repository.getRecentPayoffStats({
            projectId: input.artifact.projectId,
            narrativeCutoff: input.narrativeOrder,
          });
        } catch (payoffError) {
          // 爽点统计查询失败不阻塞 review（payoff_curve 表可能未建）
          console.warn(`[review] getRecentPayoffStats 失败（不阻塞 review）：${(payoffError as Error).message}`);
        }
      }
      const roleMemory = selectReviewerMemory(input.memory, input.role);
      const roleSkills = selectReviewerSkills(input.skills, input.role) ?? input.skills;
      const embeddedGoal = input.artifact.structuredData?.stageGoal as StageGoalContract | undefined;
      const stageGoal = input.stageGoal ?? embeddedGoal;
      // P1-2: system prompt 注入完整 reviewer 职责（默认 + 题材/项目特化补充）。
      // 设计依据：AGENTS.md「reusable contracts over case-specific rules」——原 system 极简
      // (`你是${identity}审核 Worker(${role})。`)，职责定义只在 user prompt 中，导致 system/user
      // 角色割裂；且职责硬编码无法题材特化。现改为：system 承载完整角色定义（含 craft rule
      // 沉淀的题材特化补充），user 只保留维度边界与正文数据。
      const reviewFocus = getReviewFocus(input.role);
      const system = `你是${input.identity === "independent" ? "独立" : "内置"}审核 Worker（${input.role}）。\n\n## 审核职责\n${reviewFocus}`;
      const promptPackage = buildChapterReviewPromptPackage({ workflowId: input.workflowId, system, role: input.role, artifact: input.artifact, text: input.text, blueprint: input.blueprint, memory: roleMemory, skills: roleSkills, payoffStats, planningContext: input.planningContext, stageGoal });
      const prompt = promptPackage.instruction;
      const roleSchema = promptPackage.schema!;
      try {
        const generated = await model.generateStructured<ReviewerOutput>({
            purpose: reviewerPurpose(input.role),
            system,
            prompt,
            schema: roleSchema,
            schemaName: `reviewer:${input.role}`,
            workflowRunId: input.workflowId,
            taskId: `${input.artifact.taskId}:review:${input.role}`,
            routingSnapshot: input.routingSnapshot,
            candidateStartIndex: input.candidateStartIndex,
            promptContext: promptPackage.manifest,
          });
        const review = { ...toReview({ artifact: input.artifact, identity: input.identity, role: input.role, output: generated.value }), modelProvenance: generated.provenance };
        await deps.repository.putReview(review, { refreshChapterSnapshot: !input.suppressChapterSnapshotPromotion });
        return { kind: "completed", review };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const task = await externalTask({ workflowId: input.workflowId, taskId: `${input.artifact.taskId}:review:${input.role}`, purpose: reviewerPurpose(input.role), candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "review", system, instruction: prompt, schema: roleSchema, schemaName: `reviewer:${input.role}`, baseRevision: input.artifact.baseRevision, contextRefs: { artifactId: input.artifact.id, blueprintId: input.blueprint.id, memoryBundleId: roleMemory.id, skillBundleId: roleSkills.id, goalId: stageGoal?.id }, promptContext: promptPackage.manifest });
        return { kind: "external", task };
      }
    },
    revise: async (input: { workflowId: string; intent: NovelIntent; artifact: Artifact; text: string; reviews: Review[]; directedIssues?: ReviewIssue[]; strictRevisionWindows?: boolean; authorInstruction?: string; memory: MemoryBundle; blueprint: ExecutionBlueprint; skills: SkillBundle; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; planningContext?: ChapterPlanningContext }): Promise<GeneratedTextResult> => {
      const actionableIssues = input.directedIssues ?? input.reviews.flatMap((review) => review.issues).filter((issue) => issue.severity === "blocker" || issue.severity === "major");
      const hasAuthorInstruction = Boolean(input.authorInstruction?.trim());
      const stageGoal = actionableIssues.length || hasAuthorInstruction ? createStageGoalContract({
        projectId: input.intent.projectId,
        workflowId: input.workflowId,
        stage: "revision",
        targetArtifactId: input.artifact.id,
        authorInstruction: input.authorInstruction,
        reviewIssueFingerprints: actionableIssues.map(reviewIssueFingerprint),
        acceptanceCriteria: [
          ...(hasAuthorInstruction ? ["修订后的实际阅读效果明确响应作者原始要求"] : []),
          ...actionableIssues.map((issue) => `${issue.title}：${issue.suggestion ?? issue.description ?? issue.evidence}`),
          "未被目标触及的有效事实、人物关系与章节功能保持连续",
        ],
        allowedChangeScope: input.strictRevisionWindows && !hasAuthorInstruction ? "local" : "chapter",
      }) : undefined;
      const system = hasAuthorInstruction
        ? "你是长篇小说定向修订编辑。作者原话是本轮任务目标，审核问题是辅助证据，技能是仅在不冲突时使用的背景方法；不得用完成审校问题代替完成作者目标。先理解它们的关系，再让修改结果在正文中明确可见，同时保持冻结事实、章节规划与既定因果。"
        : "你是长篇小说局部修订编辑。严格依据审核证据修订，不得扩写无关情节或发明冻结上下文之外的事实。";
      const fullRevisionPackage = buildFullChapterRevisionPromptPackage({
        projectId: input.intent.projectId,
        workflowId: input.workflowId,
        system,
        goal: stageGoal,
        sourceArtifactId: input.artifact.id,
        maxInputTokens: input.blueprint.budget.maxInputTokens,
        maxOutputTokens: input.blueprint.budget.maxOutputTokens,
        text: input.text,
        issues: actionableIssues,
        memory: input.memory,
        skills: input.skills,
        planningContext: input.planningContext,
        authorInstruction: input.authorInstruction,
      });
      try {
        const windows = planRevisionWindows(input.text, actionableIssues);
        if (input.strictRevisionWindows && !windows.length) throw new Error("目标意见无法解析出安全修订窗口");
        const requiresFullRevision = !input.strictRevisionWindows && !revisionWindowsCoverAllIssues(windows, actionableIssues);
        const useRevisionWindows = shouldUseRevisionWindows({ requiresFullRevision, authorInstruction: input.authorInstruction });
        const paragraphs = splitChapterParagraphs(input.text);
        const replacements: Array<{ window: (typeof windows)[number]; text: string }> = [];
        const modelProvenance: ModelExecutionProvenance[] = [];
        for (const window of useRevisionWindows ? windows : []) {
          const source = paragraphs.slice(window.start, window.end + 1).join("\n\n");
          const windowPrompt = buildRevisionWindowPrompt({ text: input.text, window, memory: input.memory, skills: input.skills, planningContext: input.planningContext, authorInstruction: input.authorInstruction });
          const windowPackage = compileStageContext({ projectId: input.intent.projectId, workflowId: input.workflowId, purpose: "writing.revision", stage: "revision", system, goal: stageGoal, maxInputTokens: input.blueprint.budget.maxInputTokens, reservedOutputTokens: Math.min(4096, Math.max(1024, source.length * 2)), sections: [{ id: `revision-window:${window.start + 1}-${window.end + 1}`, kind: "manuscript", title: "局部修订任务、约束与正文", text: windowPrompt, priority: "critical", provenanceRefs: [input.artifact.id, input.memory.id, input.skills.id, input.blueprint.id] }] });
          const generated = await model.generateText({
            purpose: "writing.revision",
            system,
            prompt: windowPackage.instruction,
            maxTokens: Math.min(4096, Math.max(1024, source.length * 2)),
            temperature: 0.25,
            workflowRunId: input.workflowId,
            taskId: `${input.artifact.taskId}:revise:${window.start + 1}-${window.end + 1}`,
            routingSnapshot: input.routingSnapshot,
            candidateStartIndex: input.candidateStartIndex,
            promptContext: windowPackage.manifest,
          });
          if (generated.text.trim() && generated.text.trim() !== source.trim()) {
            replacements.push({ window, text: generated.text });
            modelProvenance.push(generated.provenance);
          }
        }
        if (input.strictRevisionWindows && replacements.length !== windows.length) throw new Error("AI 未实际修改全部目标段落");
        if (replacements.length) {
          const revisedText = applyRevisionWindows(input.text, replacements);
          return { kind: "completed", artifact: await makeArtifact({ projectId: input.intent.projectId, taskId: `${input.artifact.taskId}:revise`, kind: "revision", baseRevision: input.artifact.baseRevision, text: revisedText, structuredData: { modelProvenance, revisionWindows: replacements.map(({ window }) => ({ start: window.start + 1, end: window.end + 1, issueCount: window.issues.length })), stageGoal, workflowId: input.workflowId } }), text: revisedText };
        }
        if (input.strictRevisionWindows) throw new Error("AI 未实际修改任何目标段落");
        const generated = await model.generateText({ purpose: "writing.revision", system, prompt: fullRevisionPackage.instruction, maxTokens: input.blueprint.budget.maxOutputTokens, workflowRunId: input.workflowId, taskId: `${input.artifact.taskId}:revise:full`, routingSnapshot: input.routingSnapshot, candidateStartIndex: input.candidateStartIndex, promptContext: fullRevisionPackage.manifest });
        let revisedText = generated.text;
        const fullRevisionProvenance: ModelExecutionProvenance[] = [generated.provenance];
        let authorAlignment: AuthorRevisionAlignment | undefined;
        const authorAlignmentHistory: AuthorRevisionAlignment[] = [];
        let authorAlignmentRepairApplied = false;
        if (hasAuthorInstruction) {
          try {
            const alignmentSystem = "你是独立的作者修改要求对齐检查员。只根据作者要求与修订前后文本的可核对差异判断，不替修订模型找借口。";
            const buildAlignmentPackage = (candidate: string) => compileStageContext({
              projectId: input.intent.projectId,
              workflowId: input.workflowId,
              purpose: "review.reader",
              stage: "review",
              system: alignmentSystem,
              goal: stageGoal,
              schema: authorRevisionAlignmentSchema as unknown as Record<string, unknown>,
              maxInputTokens: input.blueprint.budget.maxInputTokens,
              reservedOutputTokens: 2_048,
              sections: [
                { id: "alignment-rubric", kind: "review", title: "语义验收规则", text: "判断候选正文是否实质响应作者本轮修改要求。需要结合修订前后的实际阅读效果，不做关键词匹配；若未满足，指出未满足目标与可核对证据。", priority: "required", provenanceRefs: [stageGoal?.id ?? input.artifact.id] },
                { id: "author-goal", kind: "goal", title: "作者原始修改要求", text: input.authorInstruction!, priority: "critical", provenanceRefs: [stageGoal?.id ?? input.artifact.id] },
                { id: "original-manuscript", kind: "manuscript", title: "修订前正文", text: input.text, priority: "required", provenanceRefs: [input.artifact.id], sourceArtifactId: input.artifact.id },
                { id: "candidate-manuscript", kind: "manuscript", title: "候选正文", text: candidate, priority: "critical", provenanceRefs: [input.artifact.id] },
              ],
            });
            const alignmentPackage = buildAlignmentPackage(revisedText);
            const alignment = await model.generateStructured<AuthorRevisionAlignment>({
              purpose: "review.reader",
              system: alignmentSystem,
              prompt: alignmentPackage.instruction,
              schema: authorRevisionAlignmentSchema as unknown as Record<string, unknown>,
              schemaName: "author-revision-alignment",
              maxTokens: 2048,
              temperature: 0.1,
              workflowRunId: input.workflowId,
              taskId: `${input.artifact.taskId}:revise:author-alignment`,
              routingSnapshot: input.routingSnapshot,
              promptContext: alignmentPackage.manifest,
            });
            authorAlignment = alignment.value;
            authorAlignmentHistory.push(alignment.value);
            fullRevisionProvenance.push(alignment.provenance);
            if (!alignment.value.satisfied) {
              const repairPackage = compileStageContext({
                projectId: input.intent.projectId,
                workflowId: input.workflowId,
                purpose: "writing.revision",
                stage: "revision",
                system,
                goal: stageGoal,
                maxInputTokens: input.blueprint.budget.maxInputTokens,
                reservedOutputTokens: input.blueprint.budget.maxOutputTokens,
                sections: [{ id: "author-alignment-repair", kind: "manuscript", title: "作者目标未满足项、证据与待修正文", text: buildAuthorRevisionRepairPrompt({ original: input.text, candidate: revisedText, authorInstruction: input.authorInstruction!, alignment: alignment.value, memory: input.memory, planningContext: input.planningContext }), priority: "critical", provenanceRefs: [input.artifact.id, input.memory.id, input.blueprint.id, stageGoal?.id ?? ""] }],
              });
              const repaired = await model.generateText({
                purpose: "writing.revision",
                system,
                prompt: repairPackage.instruction,
                maxTokens: input.blueprint.budget.maxOutputTokens,
                workflowRunId: input.workflowId,
                taskId: `${input.artifact.taskId}:revise:author-repair`,
                routingSnapshot: input.routingSnapshot,
                candidateStartIndex: input.candidateStartIndex,
                promptContext: repairPackage.manifest,
              });
              revisedText = repaired.text;
              fullRevisionProvenance.push(repaired.provenance);
              authorAlignmentRepairApplied = true;
              const repairedAlignmentPackage = buildAlignmentPackage(revisedText);
              const repairedAlignment = await model.generateStructured<AuthorRevisionAlignment>({
                purpose: "review.reader",
                system: alignmentSystem,
                prompt: repairedAlignmentPackage.instruction,
                schema: authorRevisionAlignmentSchema as unknown as Record<string, unknown>,
                schemaName: "author-revision-alignment",
                maxTokens: 2048,
                temperature: 0.1,
                workflowRunId: input.workflowId,
                taskId: `${input.artifact.taskId}:revise:author-alignment-after-repair`,
                routingSnapshot: input.routingSnapshot,
                promptContext: repairedAlignmentPackage.manifest,
              });
              authorAlignment = repairedAlignment.value;
              authorAlignmentHistory.push(repairedAlignment.value);
              fullRevisionProvenance.push(repairedAlignment.provenance);
            }
          } catch (error) {
            if (!(error instanceof ExternalMcpRequiredError)) throw error;
            const unresolvedAlignment: AuthorRevisionAlignment = authorAlignment ?? {
              satisfied: false,
              summary: "需要外部执行器独立核对作者目标，并在未满足时继续修订。",
              unmetRequirements: [input.authorInstruction!],
              evidence: ["API 执行器无法完成作者目标语义验收，禁止跳过该门禁。"],
            };
            const externalGoalPackage = compileStageContext({
              projectId: input.intent.projectId,
              workflowId: input.workflowId,
              purpose: error.purpose,
              stage: "revision",
              system,
              goal: stageGoal,
              maxInputTokens: input.blueprint.budget.maxInputTokens,
              reservedOutputTokens: input.blueprint.budget.maxOutputTokens,
              sections: [{
                id: "external-author-goal-continuation",
                kind: "manuscript",
                title: "作者目标语义验收与必要修订",
                text: buildAuthorRevisionRepairPrompt({ original: input.text, candidate: revisedText, authorInstruction: input.authorInstruction!, alignment: unresolvedAlignment, memory: input.memory, planningContext: input.planningContext }),
                priority: "critical",
                provenanceRefs: [input.artifact.id, input.memory.id, input.blueprint.id, ...(stageGoal ? [stageGoal.id] : [])],
              }],
            });
            const task = await externalTask({
              workflowId: input.workflowId,
              taskId: `${input.artifact.taskId}:revise:author-goal-external`,
              purpose: error.purpose,
              candidateIndex: error.candidateIndex,
              routingSnapshot: input.routingSnapshot,
              outputKind: "text",
              system,
              instruction: externalGoalPackage.instruction,
              baseRevision: input.artifact.baseRevision,
              contextRefs: { artifactId: input.artifact.id, blueprintId: input.blueprint.id, memoryBundleId: input.memory.id, skillBundleId: input.skills.id, goalId: stageGoal?.id, goalContract: stageGoal ? JSON.stringify(stageGoal) : "", externalContinuation: "author-goal-alignment" },
              promptContext: externalGoalPackage.manifest,
            });
            return { kind: "external", task };
          }
        }
        return { kind: "completed", artifact: await makeArtifact({ projectId: input.intent.projectId, taskId: `${input.artifact.taskId}:revise`, kind: "revision", baseRevision: input.artifact.baseRevision, text: revisedText, structuredData: { modelProvenance: fullRevisionProvenance, revisionMode: "full-fallback", authorAlignment, authorAlignmentHistory, authorAlignmentRepairApplied, stageGoal, workflowId: input.workflowId } }), text: revisedText };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const windows = planRevisionWindows(input.text, actionableIssues);
        if (input.strictRevisionWindows && !windows.length) throw new Error("目标意见无法解析出安全修订窗口");
        const useTargetedExternal = input.strictRevisionWindows && shouldUseRevisionWindows({ requiresFullRevision: false, authorInstruction: input.authorInstruction });
        const targetedRevisionPackage = useTargetedExternal ? compileStageContext({
          projectId: input.intent.projectId,
          workflowId: input.workflowId,
          purpose: "writing.revision",
          stage: "revision",
          system,
          goal: stageGoal,
          schema: targetedRevisionBatchSchema as unknown as Record<string, unknown>,
          maxInputTokens: input.blueprint.budget.maxInputTokens,
          reservedOutputTokens: input.blueprint.budget.maxOutputTokens,
          sections: [{ id: "targeted-revision-batch", kind: "manuscript", title: "局部修订任务、约束与正文", text: buildTargetedRevisionBatchPrompt({ text: input.text, windows, memory: input.memory, skills: input.skills, planningContext: input.planningContext, authorInstruction: input.authorInstruction }), priority: "critical", provenanceRefs: [input.artifact.id, input.memory.id, input.skills.id, input.blueprint.id] }],
        }) : undefined;
        const task = targetedRevisionPackage
          ? await externalTask({ workflowId: input.workflowId, taskId: `${input.artifact.taskId}:revise:targeted`, purpose: "writing.revision", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "structured", system, instruction: targetedRevisionPackage.instruction, schema: targetedRevisionBatchSchema as unknown as Record<string, unknown>, schemaName: "targeted-chapter-revision", baseRevision: input.artifact.baseRevision, contextRefs: { artifactId: input.artifact.id, blueprintId: input.blueprint.id, memoryBundleId: input.memory.id, skillBundleId: input.skills.id, goalContract: stageGoal ? JSON.stringify(stageGoal) : "" }, promptContext: targetedRevisionPackage.manifest })
          : await externalTask({ workflowId: input.workflowId, taskId: `${input.artifact.taskId}:revise`, purpose: "writing.revision", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "text", system, instruction: fullRevisionPackage.instruction, baseRevision: input.artifact.baseRevision, contextRefs: { artifactId: input.artifact.id, blueprintId: input.blueprint.id, memoryBundleId: input.memory.id, skillBundleId: input.skills.id, goalId: stageGoal?.id, goalContract: stageGoal ? JSON.stringify(stageGoal) : "" }, promptContext: fullRevisionPackage.manifest });
        return { kind: "external", task };
      }
    },
    materializeExternalText: async (input: { projectId: string; modelTaskId: string; text: string; kind: "draft" | "revision"; baseRevision: number }): Promise<{ artifact: Artifact; text: string }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task || task.status !== "submitted" || task.result?.text !== input.text) throw new Error("外部文本任务尚未通过 Runtime 验证");
      const stageGoal = task.workPackage.contextRefs.goalContract ? JSON.parse(task.workPackage.contextRefs.goalContract) as StageGoalContract : undefined;
      const artifact = await makeArtifact({ projectId: input.projectId, taskId: task.taskId, kind: input.kind, baseRevision: input.baseRevision, text: input.text, structuredData: { externalModelTaskId: task.id, modelProvenance: { routeSnapshotId: task.configRevision, purpose: task.purpose, candidateIndex: task.candidateIndex, executor: "external-mcp", model: "external-mcp", promptFingerprint: task.workPackage.inputFingerprint }, stageGoal, workflowId: task.workflowRunId } });
      return { artifact, text: input.text };
    },
    materializeExternalTargetedRevision: async (input: { projectId: string; modelTaskId: string; artifact: Artifact; text: string; issues: ReviewIssue[] }): Promise<{ artifact: Artifact; text: string }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      const value = task?.result?.value as { replacements?: TargetedRevisionReplacement[] } | undefined;
      if (!task || task.status !== "submitted" || !Array.isArray(value?.replacements)) throw new Error("外部定向修订任务尚未通过 Runtime 验证");
      const windows = planRevisionWindows(input.text, input.issues);
      const revisedText = applyTargetedRevisionReplacements(input.text, windows, value.replacements);
      const stageGoal = task.workPackage.contextRefs.goalContract ? JSON.parse(task.workPackage.contextRefs.goalContract) as StageGoalContract : undefined;
      const artifact = await makeArtifact({ projectId: input.projectId, taskId: task.taskId, kind: "revision", baseRevision: input.artifact.baseRevision, text: revisedText, structuredData: { externalModelTaskId: task.id, revisionMode: "targeted-windows", revisionWindows: windows.map((window) => ({ start: window.start + 1, end: window.end + 1, issueCount: window.issues.length })), modelProvenance: { routeSnapshotId: task.configRevision, purpose: task.purpose, candidateIndex: task.candidateIndex, executor: "external-mcp", model: "external-mcp", promptFingerprint: task.workPackage.inputFingerprint }, stageGoal, workflowId: task.workflowRunId } });
      return { artifact, text: revisedText };
    },
    materializeExternalReview: async (input: { modelTaskId: string; artifact: Artifact; identity: "internal" | "independent"; role: ReviewerRole; value: unknown; suppressChapterSnapshotPromotion?: boolean }): Promise<Review> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      const validate = new Ajv({ allErrors: true, strict: false }).compile(reviewerSchemaForDimensions(REVIEWER_DIMENSIONS[input.role]));
      if (!task || task.status !== "submitted" || !validate(input.value)) throw new Error(`外部审核结果无效：${validate.errors?.map((item) => item.message).join("；") ?? "任务未提交"}`);
      const review = { ...toReview({ artifact: input.artifact, identity: input.identity, role: input.role, output: input.value as ReviewerOutput }), modelProvenance: { routeSnapshotId: task.configRevision, purpose: task.purpose, candidateIndex: task.candidateIndex, executor: "external-mcp" as const, model: "external-mcp", promptFingerprint: task.workPackage.inputFingerprint } };
      await deps.repository.putReview(review, { refreshChapterSnapshot: !input.suppressChapterSnapshotPromotion });
      return review;
    },
    extractFacts: async (input: { workflowId: string; projectId: string; artifact: Artifact; text: string; blueprint: ExecutionBlueprint; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; documentId?: string; narrativeOrder?: number }): Promise<GeneratedArtifactResult> => {
      const factArtifact = await makeArtifact({ projectId: input.projectId, taskId: `${input.artifact.taskId}:facts`, kind: "fact-extraction", baseRevision: input.artifact.baseRevision, text: input.text, structuredData: { sourceArtifactId: input.artifact.id } });
      // Skill 注入(对齐 generateFoundationWork / chapter-draft 的 skill 消费方式):
      // 从 skillProvider 查询 applicableTasks 含 memory-maintenance 的 skill,
      // 让 v1 迁移的 fact-delta-extraction skill 的 promptSections 真正进入 LLM。
      // 设计依据:AGENTS.md「reusable contracts」——不针对特定 skill 加规则,
      // 而是让所有声明 memory-maintenance taskClass 的 skill 都有机会注入 prompt。
      const allSkills = await deps.skillProvider.list(input.projectId);
      const factExtractionSkills = allSkills
        .filter((skill) => skill.enabled && skill.applicableTasks.includes("memory-maintenance"))
        .map((skill) => ({ skillId: skill.skillId, promptSections: skill.promptSections }));

      try {
        const extractionContext = await deps.repository.getFactExtractionContext(input.projectId);
        // Phase 3.1: 提取 claims 与正文修订派生数据；派生数据等待 commit 取得真实 revisionId 后落库。
        const result = await extractFactsWithStats({ projectId: input.projectId, artifact: factArtifact, text: input.text, model, existingContentHashes: extractionContext.contentHashes, existingClaimsIndex: extractionContext.claimsIndex, routingSnapshot: input.routingSnapshot, candidateStartIndex: input.candidateStartIndex, workflowRunId: input.workflowId, taskId: `${input.artifact.taskId}:facts:model`, skills: factExtractionSkills });
        const recorded = await deps.repository.recordFactExtraction({ projectId: input.projectId, artifact: factArtifact, claims: result.claims });
        const retrievable = recorded.filter((claim) => claim.authority !== "candidate");
        if (retrievable.length && deps.memoryIndex) await deps.memoryIndex.upsertClaims(input.projectId, retrievable);
        // 爽点是正文 revision 的派生记录。此阶段尚未创建 manuscript revision，
        // 只把提取结果随 artifact 返回，统一由 CommitService 在 commit 后落库。
        return { kind: "completed", artifact: { ...factArtifact, structuredData: { ...factArtifact.structuredData, narrativeElements: result.narrativeElements, payoffMoments: result.payoffMoments ?? [], chapterMemory: result.chapterMemory, characterDeltas: result.characterDeltas } } };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const prompt = buildFactExtractionPrompt({ artifact: factArtifact, text: input.text, skills: factExtractionSkills });
        const system = "你是事实提取 Worker。只输出符合 JSON Schema 的 JSON。只提取正文实际呈现的事实，不提取隐喻、修辞或读者推断。";
        const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "facts.extract", stage: "fact-extraction", system, prompt, schema: chapterStateDeltaSchema as unknown as Record<string, unknown>, provenanceRefs: [factArtifact.id] });
        const task = await externalTask({ workflowId: input.workflowId, taskId: `${input.artifact.taskId}:facts:model`, purpose: "facts.extract", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "structured", system, instruction: promptPackage.instruction, schema: chapterStateDeltaSchema as unknown as Record<string, unknown>, schemaName: "chapter-state-delta", baseRevision: input.artifact.baseRevision, contextRefs: { artifactId: factArtifact.id, blueprintId: input.blueprint.id }, promptContext: promptPackage.manifest });
        return { kind: "external", task, artifact: factArtifact };
      }
    },
    materializeExternalFacts: async (input: { modelTaskId: string; projectId: string; artifact: Artifact; text: string; documentId?: string; narrativeOrder?: number }): Promise<Artifact> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      const validate = new Ajv({ allErrors: true, strict: false }).compile(chapterStateDeltaSchema);
      if (!task || task.status !== "submitted" || !validate(task.result?.value)) throw new Error(`外部事实提取结果无效：${validate.errors?.map((item) => item.message).join("；") ?? "任务未提交"}`);
      const extractionContext = await deps.repository.getFactExtractionContext(input.projectId);
      const projected = projectFactExtractionOutput({ projectId: input.projectId, artifact: input.artifact, text: input.text, existingContentHashes: extractionContext.contentHashes, existingClaimsIndex: extractionContext.claimsIndex }, task.result!.value as ChapterStateDelta);
      const recorded = await deps.repository.recordFactExtraction({ projectId: input.projectId, artifact: input.artifact, claims: projected.claims });
      const retrievable = recorded.filter((claim) => claim.authority !== "candidate");
      if (retrievable.length && deps.memoryIndex) await deps.memoryIndex.upsertClaims(input.projectId, retrievable);
      return { ...input.artifact, structuredData: { ...input.artifact.structuredData, narrativeElements: projected.narrativeElements, payoffMoments: projected.payoffMoments ?? [], chapterMemory: projected.chapterMemory, characterDeltas: projected.characterDeltas } };
    },
    approveFacts: (input: { workflowId: string; projectId: string; artifact: Artifact }) =>
      deps.repository.recordFactApprovalPolicy({ workflowId: input.workflowId, projectId: input.projectId, artifactId: input.artifact.id }),
    assessLearning: async (input: { projectId: string; workflowId: string; assessmentKey: string; artifact: Artifact; reviews: Review[]; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number }): Promise<GeneratedLearningResult> => {
      // 加载数据库中实际存在的 skill 列表，注入 learning prompt 让 LLM 使用真实 skill ID。
      // 设计依据：AGENTS.md「root-cause analysis」——原 prompt 未提供可用 skill 列表，
      // LLM 自行编造 skill ID（如 "drafting"），导致 createCraftRuleCandidate 抛错。
      let availableSkills: Array<{ skillId: string; capabilities: string[] }> = [];
      try {
        const skills = await deps.repository.listSkills(input.projectId);
        availableSkills = skills.map((s) => ({ skillId: s.skillId, capabilities: s.capabilities }));
      } catch (skillError) {
        console.warn(`[assessLearning] listSkills 失败（不阻塞 learning）：${(skillError as Error).message}`);
      }
      try {
        const { assessment, validationError } = await assessRuntimeLearningWithModel({ ...input, model, routingSnapshot: input.routingSnapshot, candidateStartIndex: input.candidateStartIndex, availableSkills });
        const recorded = validationError ? { ...assessment, validationError } : assessment;
        return { kind: "completed", assessment: await recordLearning(recorded) };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const blocking = blockingReviewIssues(input.reviews);
        if (!blocking.length) throw error;
        const system = "你是长篇小说 Runtime 的学习闭环审计员，只在能说明底层机制和影响输入类时提出可复用规则改进。";
        const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "learning.assess", stage: "review", system, prompt: buildRuntimeLearningPrompt({ artifact: input.artifact, reviews: input.reviews, availableSkills }), schema: runtimeLearningAssessmentSchema, reservedOutputTokens: 4_096, provenanceRefs: [input.artifact.id, ...input.reviews.map((review) => review.id)] });
        const task = await externalTask({ workflowId: input.workflowId, taskId: `${input.artifact.taskId}:learning:${input.assessmentKey}`, purpose: "learning.assess", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "structured", system, instruction: promptPackage.instruction, schema: runtimeLearningAssessmentSchema, schemaName: "runtime-learning-assessment", baseRevision: input.artifact.baseRevision, contextRefs: { artifactId: input.artifact.id, reviewIds: input.reviews.map((review) => review.id).join(",") }, promptContext: promptPackage.manifest });
        return { kind: "external", task };
      }
    },
    materializeExternalLearning: async (input: { modelTaskId: string; projectId: string; workflowId: string; artifact: Artifact; reviews: Review[] }): Promise<RuntimeLearningAssessmentV2> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task || task.status !== "submitted") throw new Error("外部 learning 任务尚未提交");
      const assessment = parseRuntimeLearningAssessmentV2(task.result?.value, { id: `learning:${input.artifact.id}`, projectId: input.projectId, source: { workflowId: input.workflowId, artifactId: input.artifact.id, reviewIds: input.reviews.map((review) => review.id), fingerprint: input.artifact.fingerprint }, createdAt: Date.now() });
      return recordLearning(assessment);
    },
    commit: (input: { projectId: string; documentId: string; artifact: Artifact; factArtifact?: Artifact; narrativeOrder?: number; text: string; reviews: Review[]; baseRevision: number; idempotencyKey: string }) => commitService.commit({ ...input, narrativeElements: input.factArtifact?.structuredData?.narrativeElements as FactExtractionOutput["narrativeElements"] | undefined, payoffMoments: input.factArtifact?.structuredData?.payoffMoments as FactExtractionOutput["payoffMoments"] | undefined, chapterMemoryDelta: input.factArtifact?.structuredData?.chapterMemory as ChapterStateDelta["chapterMemory"] }),
    commitAuthorApproved: (input: { projectId: string; documentId: string; artifact: Artifact; factArtifact?: Artifact; narrativeOrder?: number; text: string; reviews: Review[]; baseRevision: number; idempotencyKey: string }) => commitService.commitAuthorApproved({ ...input, narrativeElements: input.factArtifact?.structuredData?.narrativeElements as FactExtractionOutput["narrativeElements"] | undefined, payoffMoments: input.factArtifact?.structuredData?.payoffMoments as FactExtractionOutput["payoffMoments"] | undefined, chapterMemoryDelta: input.factArtifact?.structuredData?.chapterMemory as ChapterStateDelta["chapterMemory"] }),
    /** P0 #1: 人工事实审批门通过后，批量批准 pending 事实候选（candidate → approved）。
     *  内部同时写回 Qdrant 向量索引，与 recordFactExtraction 模式一致；
     *  Qdrant 失败不阻塞（PostgreSQL 真源已保留），只警告。 */
    approveFactClaims: async (input: { projectId: string; ids: string[] }): Promise<MemoryClaim[]> => {
      const approved = await deps.repository.approveFactClaims(input);
      if (approved.length && deps.memoryIndex) {
        try {
          await deps.memoryIndex.upsertClaims(input.projectId, approved);
        } catch (error) {
          console.warn(`[fact-approval] Qdrant 索引失败（PostgreSQL 真源已保留）：${(error as Error).message}`);
        }
      }
      return approved;
    },

    /**
     * 角色富化（character enrichment）activity。
     *
     * 设计依据：AGENTS.md「commitStageHandler → characterEnrichmentStageHandler」契约。
     * 在 commit 之后执行，从定稿章节提取角色声部/动机/知识/关系增量并回写角色档案。
     * 失败不阻塞 commit（revision 已落库），只抛错让 workflow 决定是否记录 learning。
     *
     * 支持 internal LLM 与 external-mcp 双路径（同其他生成类 activity）。
     */
    enrichCharacters: async (input: { workflowId: string; projectId: string; documentId: string; revisionId: string; narrativeOrder: number; artifact: Artifact; factArtifact?: Artifact; text: string; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number }): Promise<{ kind: "completed"; result: { entityUpdates: number; knowledgeClaims: number; relationRecords: number } } | { kind: "external"; task: ModelTaskRecord }> => {
      try {
        const extractedCharacters = input.factArtifact?.structuredData?.characterDeltas;
        let result;
        if (Array.isArray(extractedCharacters)) {
          const output = { characters: extractedCharacters };
          try {
            validateCharacterEnrichmentOutput(output);
          } catch (validationError) {
            console.warn(`[character-enrichment] ChapterStateDelta 无效，回退独立提取：${(validationError as Error).message}`);
          }
          if (new Ajv({ allErrors: true, strict: false }).compile(characterEnrichmentSchema)(output)) {
            result = await persistCharacterEnrichment(
              { projectId: input.projectId, documentId: input.documentId, revisionId: input.revisionId, narrativeOrder: input.narrativeOrder, artifact: input.artifact },
              { repository: deps.repository, objects, memoryIndex: deps.memoryIndex },
              output.characters,
            );
          }
        }
        if (!result) result = await enrichCharactersFromChapter(
          {
            projectId: input.projectId,
            documentId: input.documentId,
            revisionId: input.revisionId,
            narrativeOrder: input.narrativeOrder,
            text: input.text,
            artifact: input.artifact,
            model,
            routingSnapshot: input.routingSnapshot,
            candidateStartIndex: input.candidateStartIndex,
            workflowRunId: input.workflowId,
            taskId: `${input.artifact.taskId}:enrich-characters`,
          },
          { repository: deps.repository, objects, memoryIndex: deps.memoryIndex },
        );
        return { kind: "completed", result: { entityUpdates: result.entityUpdates, knowledgeClaims: result.knowledgeClaims.length, relationRecords: result.relationRecords } };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        // external-mcp 双路径：构造 enrichment prompt + schema，让外部 worker 提取
        const { buildCharacterEnrichmentPrompt } = await import("../character-enrichment/prompt");
        const prompt = buildCharacterEnrichmentPrompt({ artifact: input.artifact, text: input.text });
        const system = "你是角色富化提取 Worker。只输出符合 JSON Schema 的 JSON。只提取正文实际呈现的内容，不提取读者推断或作者意图。";
        const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "facts.extract", stage: "fact-extraction", system, prompt, schema: characterEnrichmentSchema as unknown as Record<string, unknown>, reservedOutputTokens: 4_096, provenanceRefs: [input.artifact.id, input.revisionId] });
        const task = await externalTask({
          workflowId: input.workflowId,
          taskId: `${input.artifact.taskId}:enrich-characters`,
          purpose: "facts.extract",
          candidateIndex: error.candidateIndex,
          routingSnapshot: input.routingSnapshot,
          outputKind: "structured",
          system,
          instruction: promptPackage.instruction,
          schema: characterEnrichmentSchema as unknown as Record<string, unknown>,
          schemaName: "character-enrichment",
          baseRevision: input.artifact.baseRevision,
          contextRefs: { artifactId: input.artifact.id, documentId: input.documentId, revisionId: input.revisionId, narrativeOrder: String(input.narrativeOrder) },
          promptContext: promptPackage.manifest,
        });
        return { kind: "external", task };
      }
    },
    materializeExternalEnrichment: async (input: { modelTaskId: string; projectId: string; documentId: string; revisionId: string; narrativeOrder: number; artifact: Artifact; text: string }): Promise<{ entityUpdates: number; knowledgeClaims: number; relationRecords: number }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task || task.status !== "submitted") throw new Error("外部角色富化任务尚未提交");
      const output = parseCharacterEnrichmentOutput(task.result?.value);
      const deltas = output.characters.map((character) => ({
        characterId: character.characterId,
        voiceAnchor: character.voiceAnchor,
        motivationDelta: character.motivationDelta,
        newKnowledge: character.newKnowledge,
        relationDeltas: character.relationDeltas,
      }));
      // 复用 persistCharacterEnrichment 回写角色档案，避免重复实现回写逻辑
      const { persistCharacterEnrichment } = await import("../character-enrichment");
      const result = await persistCharacterEnrichment(
        { projectId: input.projectId, documentId: input.documentId, revisionId: input.revisionId, narrativeOrder: input.narrativeOrder, artifact: input.artifact },
        { repository: deps.repository, objects, memoryIndex: deps.memoryIndex },
        deltas,
      );
      return { entityUpdates: result.entityUpdates, knowledgeClaims: result.knowledgeClaims.length, relationRecords: result.relationRecords };
    },

    /**
     * 章节反思（reflection）activity。
     *
     * 设计依据：AGENTS.md「root-cause analysis」契约 + Phase 2.4 reflection 机制。
     * 在 draft 之后、runAllReviewers 之前执行，让 LLM 扮演「严苛读者」批评自己的草稿，
     * 输出 ReflectionCritique（issues + 优先级 + 改写建议）。
     *
     * 不产生 commit 证据，只用于优化 draft。purpose=review.reader（复用路由）。
     * 支持 internal LLM 与 external-mcp 双路径。
     */
    reflectOnDraft: async (input: { workflowId: string; artifact: Artifact; text: string; blueprint: ExecutionBlueprint; memory: MemoryBundle; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; planningContext?: ChapterPlanningContext }): Promise<{ kind: "completed"; critique: ReflectionOutput["critique"]; artifact: Artifact } | { kind: "external"; task: ModelTaskRecord }> => {
      const prompt = buildChapterReflectionPrompt({ artifact: input.artifact, text: input.text, blueprint: input.blueprint, memory: input.memory, planningContext: input.planningContext });
      const system = "你是章节反思 Worker。以严苛读者 + 资深网文编辑的视角审视草稿，只输出符合 JSON Schema 的 JSON。不要复述优点，只关注问题。";
      const promptPackage = compileSinglePrompt({ projectId: input.artifact.projectId, workflowId: input.workflowId, purpose: "review.reader", stage: "review", system, prompt, schema: reflectionSchema as unknown as Record<string, unknown>, provenanceRefs: [input.artifact.id, input.blueprint.id, input.memory.id] });
      try {
        const generated = await model.generateStructured<ReflectionOutput>({
          purpose: "review.reader",
          system,
          prompt: promptPackage.instruction,
          schema: reflectionSchema as unknown as Record<string, unknown>,
          schemaName: "chapter-reflection",
          workflowRunId: input.workflowId,
          taskId: `${input.artifact.taskId}:reflection`,
          routingSnapshot: input.routingSnapshot,
          candidateStartIndex: input.candidateStartIndex,
          promptContext: promptPackage.manifest,
        });
        // reflection artifact：kind=summary，structuredData 存 critique
        const reflectionArtifact = await makeArtifact({
          projectId: input.artifact.projectId,
          taskId: `${input.artifact.taskId}:reflection`,
          kind: "summary",
          baseRevision: input.artifact.baseRevision,
          text: JSON.stringify(generated.value.critique, null, 2),
          structuredData: { critique: generated.value.critique, modelProvenance: generated.provenance, workflowId: input.workflowId, sourceArtifactId: input.artifact.id },
        });
        return { kind: "completed", critique: generated.value.critique, artifact: reflectionArtifact };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const task = await externalTask({
          workflowId: input.workflowId,
          taskId: `${input.artifact.taskId}:reflection`,
          purpose: "review.reader",
          candidateIndex: error.candidateIndex,
          routingSnapshot: input.routingSnapshot,
          outputKind: "structured",
          system,
          instruction: promptPackage.instruction,
          schema: reflectionSchema as unknown as Record<string, unknown>,
          schemaName: "chapter-reflection",
          baseRevision: input.artifact.baseRevision,
          contextRefs: { artifactId: input.artifact.id, blueprintId: input.blueprint.id, memoryBundleId: input.memory.id },
          promptContext: promptPackage.manifest,
        });
        return { kind: "external", task };
      }
    },

    materializeExternalReflection: async (input: { modelTaskId: string; artifact: Artifact; workflowId: string }): Promise<{ critique: ReflectionOutput["critique"]; artifact: Artifact }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task || task.status !== "submitted") throw new Error("外部反思任务尚未提交");
      const value = task.result?.value as ReflectionOutput | undefined;
      if (!value?.critique) throw new Error("外部反思任务结果缺少 critique");
      const reflectionArtifact = await makeArtifact({
        projectId: input.artifact.projectId,
        taskId: `${input.artifact.taskId}:reflection`,
        kind: "summary",
        baseRevision: input.artifact.baseRevision,
        text: JSON.stringify(value.critique, null, 2),
        structuredData: { critique: value.critique, workflowId: input.workflowId, sourceArtifactId: input.artifact.id },
      });
      return { critique: value.critique, artifact: reflectionArtifact };
    },

    // ===== 章节审校工作流专用 activities（C-2.4）=====
    // 设计依据：AGENTS.md 章节审校工作流复用契约。
    // 4 个独立 activity，不与 loadProjectSnapshot 合并（单一职责）。

    /**
     * 加载历史 blueprint artifact。
     *
     * 查 artifacts WHERE kind='draft' ORDER BY created_at DESC，取最新 draft 的 taskId
     * 反查 execution_blueprints.payload 获取完整 ExecutionBlueprint。
     *
     * 前置条件：项目必须有历史 draft artifact（即至少生成过一次章节）。
     */
    loadHistoricalBlueprint: async (input: { projectId: string; documentId: string }): Promise<{ blueprint: ExecutionBlueprint; artifactId: string }> => {
      const record = await deps.repository.findHistoricalBlueprintForDocument(input.projectId, input.documentId);
      if (!record) {
        throw new Error(`项目 ${input.projectId} 无历史 draft artifact，无法启动章节审校（需先运行 novelIntentWorkflow 生成章节）`);
      }
      return record;
    },

    /**
     * 加载章节当前定稿正文。
     *
     * 流程：manuscript_documents → manuscript_revisions → content_blobs → objectStore.getText。
     *
     * 前置条件：document.status === "final"（只对已定稿章节开放重审）。
     */
    loadDocumentPlainText: async (input: { projectId: string; documentId: string }): Promise<{ plainText: string; contentHtml: string; wordCount: number; documentRevision: number; sourceRevisionId: string; artifactId?: string; contentHash: string }> => {
      const content = await deps.repository.getFinalDocumentContentRef(input.projectId, input.documentId);
      if (!content) throw new Error(`章节不存在：${input.documentId}`);
      if (content.status !== "final") {
        throw new Error(`章节状态必须为 final（当前为 ${content.status}），只对已定稿章节开放重审`);
      }
      if (!content.objectKey || !content.sourceRevisionId) throw new Error(`章节 ${input.documentId} 无完整定稿 revision/content blob`);
      const plainText = await objects.getText(content.objectKey);

      return {
        plainText,
        contentHtml: "", // TODO P3: contentHtml 暂未存储，commit-service 也只存 plainText
        wordCount: countNovelCharacters(plainText),
        documentRevision: content.revision,
        sourceRevisionId: content.sourceRevisionId,
        artifactId: content.artifactId,
        contentHash: content.contentHash,
      };
    },

    loadTargetedReviewIssues: async (input: { projectId: string; documentId: string; issueIds: string[] }): Promise<{ snapshotId: string; reviewedContentHash: string; fingerprints: string[]; issues: ReviewIssue[] }> => {
      return deps.repository.getTargetedChapterReviewIssues(input);
    },

    loadProposedDraft: async (input: { projectId: string; artifactId: string }): Promise<{ artifact: Artifact; text: string }> => {
      const artifact = await deps.repository.getArtifactById(input.projectId, input.artifactId);
      if (!artifact?.objectKey) throw new Error(`作者修订 proposal 不存在或缺少 objectKey：${input.artifactId}`);
      return { artifact, text: await objects.getText(artifact.objectKey) };
    },

    createReviewDraft: (input: { projectId: string; documentId: string; workflowId: string; sourceRevisionId: string; sourceArtifactId?: string; blueprint: ExecutionBlueprint; text: string; baseRevision: number }): Promise<Artifact> =>
      makeArtifact({
        projectId: input.projectId,
        taskId: `${input.blueprint.id}:review-draft`,
        kind: "draft",
        baseRevision: input.baseRevision,
        text: input.text,
        structuredData: {
          source: "chapter-review",
          sourceRevisionId: input.sourceRevisionId,
          sourceArtifactId: input.sourceArtifactId,
          documentId: input.documentId,
          workflowId: input.workflowId,
          historicalBlueprint: input.blueprint,
        },
      }),

    /**
     * 获取默认 routing snapshot。
     *
     * 直接调 model.getRoutingSnapshot()，documentId 参数保留用于接口一致性。
     */
    getDefaultRoutingSnapshot: async (_input: { projectId: string; documentId: string }): Promise<ModelRoutingSnapshot> => {
      return model.getRoutingSnapshot();
    },

    /**
     * 检索 review 阶段所需的 memory bundle。
     *
     * 章节审校走 contextPacketId 路径（AGENTS.md 契约），不重新跑 preflight→retrieveMemory，
     * 而是复用项目最近的 memory_bundle（review 只需冻结事实，不需动态检索）。
     *
     * P1-D5: 应用 narrativeCutoff 屏蔽未来章节事实。
     * 设计依据：AGENTS.md「root-cause analysis」——原实现直接返回最新 memory_bundle，
     * 但审校早期章节时，bundle 可能包含后期章节的事实/伏笔兑现结果，让 reviewer 看到剧透，
     * 导致「未来事实污染当前审校」（如 reviewer 基于未来章节事实判定当前章节伏笔未兑现）。
     * 必须按当前章节 narrativeOrder 屏蔽未来事实，让审校器只看到「截至当前章节的已知事实」。
     */
    retrieveMemoryForReview: async (input: { projectId: string; documentId: string; blueprint: ExecutionBlueprint }): Promise<MemoryBundle> => {
      // 查询当前章节的 narrativeOrder，作为 narrativeCutoff
      const narrativeCutoff = await deps.repository.getDocumentNarrativeOrder(input.projectId, input.documentId);
      const latestBundle = await deps.repository.getLatestMemoryBundle(input.projectId);
      if (!latestBundle) {
        // 无历史 memory bundle：返回空 bundle（review 仍可进行，只是无冻结事实）
        return {
          id: `empty-memory:${input.projectId}:${Date.now()}`,
          projectId: input.projectId,
          preflightId: input.blueprint.preflightId,
          claims: [],
          conflicts: [],
          missingFacets: [],
          tokenBudget: 0,
          sourceRevisionIds: [],
          fingerprint: "empty",
          createdAt: Date.now(),
        };
      }
      const bundle = latestBundle;
      // P1-D5: 应用 narrativeCutoff 过滤未来章节事实
      // claim.narrativeRange.start === undefined 表示全局可见事实（世界观/作者偏好），不过滤
      if (narrativeCutoff === undefined) return bundle;
      const filteredClaims = bundle.claims.filter((claim) => {
        const start = claim.narrativeRange?.start;
        return start === undefined || start <= narrativeCutoff;
      });

      // P1-5: 对已兑现伏笔/承诺标记 resolved，而非删除。
      // 设计依据：AGENTS.md「root-cause analysis」——原实现未过滤 narrativeRange.end，
      // 已兑现伏笔仍以"未兑现"形态注入（reason 含 "injection"），reviewer 误报"伏笔未兑现"。
      // 根因：foreshadowing claim 的 narrativeRange.end 表示兑现章节，end <= narrativeCutoff
      // 意味着该伏笔在当前章节之前已兑现，不再是"未兑现"状态。
      // 修复：不删除已兑现伏笔（reviewer 仍需知道伏笔存在过以判断兑现质量），而是在 reason
      // 字段追加 `[resolved-at:${end}]` 标记，让渲染层（buildContextMarkdown/buildReviewerContext）
      // 识别并加"【已兑现于第 X 章】"前缀，与未兑现伏笔区分。
      // 题材无关，覆盖所有 matchedFacets 含 foreshadowing 且 end <= narrativeCutoff 的 claim。
      let hasResolvedMarker = false;
      const markedClaims = filteredClaims.map((claim) => {
        const end = claim.narrativeRange?.end;
        const isForeshadowing = matchedFacetsOf(claim).includes("foreshadowing");
        if (isForeshadowing && typeof end === "number" && end <= narrativeCutoff) {
          const resolvedMarker = `[resolved-at:${end}]`;
          const originalReason = claim.reason ?? "";
          // 避免重复标记（多次 retrieve 不会累加）
          if (originalReason.includes(resolvedMarker)) return claim;
          hasResolvedMarker = true;
          return { ...claim, reason: `${resolvedMarker}${originalReason}` };
        }
        return claim;
      });

      // 若无 start 过滤也无 resolved 标记，直接返回原 bundle（避免无谓的对象重建）
      if (filteredClaims.length === bundle.claims.length && !hasResolvedMarker) return bundle;
      return {
        ...bundle,
        claims: markedClaims,
        sourceRevisionIds: [...new Set(markedClaims.flatMap((claim) => claim.sourceRevisionIds))],
      };
    },

    // ===== CreativeRun Workflow activities（Phase B-2.3）=====
    // 设计依据：AGENTS.md「章节审校工作流复用」+ Phase B-2.3 重构计划。
    // 9 个活动包装 creative/ 模块函数（状态机 + 事件溯源），
    // 不另起一套独立逻辑——所有状态转换与事件记录都走 creative/ 共享层。
    // 新增 generateFoundationWork + getWorkItem，驱动架构生成与 work item 重载。

    /**
     * 加载 CreativeRun（含 policy/payload）。
     * 包装 creative.getCreativeRun。
     */
    loadRun: async (input: { runId: string }): Promise<CreativeRun | null> => {
      return getCreativeRun(deps.repository, input.runId);
    },

    /**
     * 加载单个 work item（重载用）。
     * 包装 creative.getWorkItem。
     * processWorkItem 在生成步骤后需要重载 work item 以获取最新 artifactRefs。
     */
    getWorkItem: async (input: { workItemId: string }): Promise<CreativeWorkItem | null> => {
      return creativeGetWorkItem(deps.repository, input.workItemId);
    },

    /**
     * 列出 pending 状态的 work items（按 created_at ASC）。
     * 包装 creative.listWorkItems + 过滤 pending。
     */
    listPendingWork: async (input: { runId: string }): Promise<CreativeWorkItem[]> => {
      const all = await creativeListWorkItems(deps.repository, input.runId);
      const statusById = new Map(all.map((work) => [work.id, work.status]));
      return all.filter((work) =>
        work.status === "pending"
        && work.dependsOn.every((dependencyId) => statusById.get(dependencyId) === "accepted"),
      );
    },

    /**
     * 启动 work item（pending → running）。
     * 包装 creative.startWork，内部更新状态 + 写 work.started 事件。
     */
    startWork: async (input: { runId: string; workItemId: string }): Promise<CreativeWorkItem> => {
      return creativeStartWork(deps.repository, input.workItemId);
    },

    /**
     * 检查 work item 的 review gate。
     * 包装 creative.checkGate，自动从 run 反查 policy。
     */
    checkGate: async (input: { runId: string; workItemId: string }): Promise<import("../protocol").CreativeReviewGate> => {
      const run = await getCreativeRun(deps.repository, input.runId);
      if (!run) throw new Error(`CreativeRun 不存在：${input.runId}`);
      return creativeCheckGate(deps.repository, input.workItemId, run.policy);
    },

    /**
     * 接受 work item（running → accepted 终态）。
     * 包装 creative.acceptWork，内部触发 updateRunStatusFromWork 派生 run 状态。
     */
    acceptWork: async (input: { runId: string; workItemId: string }): Promise<CreativeWorkItem> => {
      const accepted = await creativeAcceptWork(deps.repository, input.workItemId);
      if (accepted.taskKey) {
        const artifactId = accepted.artifactRefs.at(-1);
        const run = await getCreativeRun(deps.repository, input.runId);
        if (artifactId && run) {
          const section = await deps.repository.getProjectPlanSection(run.projectId, accepted.taskKey as import("../application/project-plan").ProjectPlanTaskKey);
          if (section?.sourceArtifactId === artifactId && section.status !== "approved") {
            await deps.repository.approveProjectPlanSection(run.projectId, section.taskKey, artifactId, "runtime");
          }
        }
      }
      return accepted;
    },

    /**
     * 修订 work item（running/accepted → pending，iteration+1）。
     * 包装 creative.reviseWork。
     */
    reviseWork: async (input: { runId: string; workItemId: string; instruction?: string }): Promise<CreativeWorkItem> => {
      return creativeReviseWork(deps.repository, input.workItemId, input.instruction);
    },

    /**
     * 重试 work item（failed → pending）。
     * 包装 creative.retryWork。
     */
    retryWork: async (input: { runId: string; workItemId: string }): Promise<CreativeWorkItem> => {
      return creativeRetryWork(deps.repository, input.workItemId);
    },

    /**
     * 更新 run 状态（基于 work items 状态派生）。
     * 包装 creative.updateRunStatusFromWork。
     */
    updateRunStatus: async (input: { runId: string }): Promise<CreativeRun> => {
      return updateRunStatusFromWork(deps.repository, input.runId);
    },

    /**
     * 写入 creative_run_events 事件。
     * 直接 INSERT，与 creative/ 模块的 writeRunEvent 一致。
     */
    recordEvent: async (input: { runId: string; eventType: string; payload: Record<string, unknown> }): Promise<unknown> => {
      await deps.repository.appendCreativeRunEvent(input.runId, input.eventType, input.payload);
      return { recorded: true };
    },

    /**
     * 标记 work item 失败并写入 run 事件（闭环状态机）。
     * 用于 CreativeRun 达到重试上限时，避免 work item 永久停留在 running。
     * 包装 creative.failWork。
     */
    failWork: async (input: { runId: string; workItemId: string; reason?: string }): Promise<CreativeWorkItem> => {
      return creativeFailWork(deps.repository, input.workItemId, input.reason ?? "maxRetriesExceeded");
    },

    getStoryArcRoutingSnapshot: async (): Promise<ModelRoutingSnapshot> => model.getRoutingSnapshot(),
    expireExternalModelTask: async (input: { modelTaskId: string; reason: string }) => deps.repository.expireModelTask(input.modelTaskId, input.reason),

    generateBookSynopsis: async (input: { workflowId: string; projectId: string; sourceFingerprint: string; candidateStartIndex?: number }): Promise<GeneratedBookSynopsisResult> => {
      const [sections, project] = await Promise.all([
        deps.repository.listProjectPlanSections(input.projectId),
        deps.repository.getProjectDetail(input.projectId),
      ]);
      const currentFingerprint = bookSynopsisSourceFingerprint({ projectTitle: project.title, sections });
      if (currentFingerprint !== input.sourceFingerprint) throw new Error("作品简介生成来源已变化，请基于最新规划重新生成");
      const prompt = buildBookSynopsisPrompt({ projectTitle: project.title, sections });
      const system = "你是擅长将长篇小说创作规划转化为读者向作品简介的资深出版文案编辑。忠实于规划事实，以阅读吸引力为目标。";
      const routingSnapshot = model.getRoutingSnapshot();
      const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "planning.foundation", stage: "foundation", system, prompt, schema: BOOK_SYNOPSIS_SCHEMA as unknown as Record<string, unknown>, reservedOutputTokens: 1_200, provenanceRefs: [input.sourceFingerprint] });
      try {
        const generated = await model.generateStructured<{ synopsis: string }>({
          purpose: "planning.foundation",
          system,
          prompt: promptPackage.instruction,
          schema: BOOK_SYNOPSIS_SCHEMA as unknown as Record<string, unknown>,
          schemaName: "book_synopsis",
          maxTokens: 1200,
          temperature: 0.75,
          workflowRunId: input.workflowId,
          taskId: `${input.projectId}:book-synopsis`,
          routingSnapshot,
          candidateStartIndex: input.candidateStartIndex,
          promptContext: promptPackage.manifest,
        });
        return { kind: "completed", text: generated.value.synopsis.trim() };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        return {
          kind: "external",
          task: await externalTask({
            workflowId: input.workflowId,
            taskId: `${input.projectId}:book-synopsis`,
            purpose: "planning.foundation",
            candidateIndex: error.candidateIndex,
            routingSnapshot,
            outputKind: "structured",
            system,
            instruction: promptPackage.instruction,
            schema: BOOK_SYNOPSIS_SCHEMA as unknown as Record<string, unknown>,
            schemaName: "book_synopsis",
            baseRevision: 0,
            contextRefs: { projectId: input.projectId, sourceFingerprint: input.sourceFingerprint },
            promptContext: promptPackage.manifest,
          }),
        };
      }
    },

    materializeExternalBookSynopsis: async (input: { modelTaskId: string; value: unknown }): Promise<{ text: string }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task) throw new Error("外部作品简介任务不存在");
      assertStructuredSchema(input.value, BOOK_SYNOPSIS_SCHEMA as unknown as Record<string, unknown>, "外部作品简介结果");
      return { text: (input.value as { synopsis: string }).synopsis.trim() };
    },

    persistBookSynopsis: async (input: { projectId: string; sourceFingerprint: string; text: string }): Promise<BookSynopsisRecord> => {
      const synopsis = { text: input.text.trim(), generatedAt: new Date().toISOString(), sourceFingerprint: input.sourceFingerprint };
      if (!synopsis.text) throw new Error("模型没有返回有效的作品简介");
      const saved = await deps.repository.saveBookSynopsisIfCurrent({ projectId: input.projectId, sourceFingerprint: input.sourceFingerprint, synopsis });
      if (!saved) throw new Error("作品简介生成期间全书规划已变化，旧结果未保存");
      return synopsis;
    },

    generateBookTitleCandidates: async (input: { workflowId: string; projectId: string; sourceFingerprint: string; candidateStartIndex?: number }): Promise<GeneratedBookTitleCandidatesResult> => {
      const sections = await deps.repository.listProjectPlanSections(input.projectId);
      if (bookTitleSourceFingerprint(sections) !== input.sourceFingerprint) throw new Error("书名生成来源已变化，请基于最新规划重新生成");
      const prompt = buildBookTitleCandidatesPrompt(sections);
      const system = "你是擅长为长篇中文小说提炼有辨识度书名的资深出版策划。忠实于作品规划，并让候选覆盖不同命名角度。";
      const routingSnapshot = model.getRoutingSnapshot();
      const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "planning.foundation", stage: "foundation", system, prompt, schema: BOOK_TITLE_CANDIDATES_SCHEMA as unknown as Record<string, unknown>, reservedOutputTokens: 1_600, provenanceRefs: [input.sourceFingerprint] });
      try {
        const generated = await model.generateStructured<{ candidates: BookTitleCandidate[] }>({
          purpose: "planning.foundation",
          system,
          prompt: promptPackage.instruction,
          schema: BOOK_TITLE_CANDIDATES_SCHEMA as unknown as Record<string, unknown>,
          schemaName: "book_title_candidates",
          maxTokens: 1600,
          temperature: 0.9,
          workflowRunId: input.workflowId,
          taskId: `${input.projectId}:book-title-candidates`,
          routingSnapshot,
          candidateStartIndex: input.candidateStartIndex,
          promptContext: promptPackage.manifest,
        });
        return { kind: "completed", candidates: normalizeBookTitleCandidates(generated.value) };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        return {
          kind: "external",
          task: await externalTask({
            workflowId: input.workflowId,
            taskId: `${input.projectId}:book-title-candidates`,
            purpose: "planning.foundation",
            candidateIndex: error.candidateIndex,
            routingSnapshot,
            outputKind: "structured",
            system,
            instruction: promptPackage.instruction,
            schema: BOOK_TITLE_CANDIDATES_SCHEMA as unknown as Record<string, unknown>,
            schemaName: "book_title_candidates",
            baseRevision: 0,
            contextRefs: { projectId: input.projectId, sourceFingerprint: input.sourceFingerprint },
            promptContext: promptPackage.manifest,
          }),
        };
      }
    },

    materializeExternalBookTitleCandidates: async (input: { modelTaskId: string; value: unknown }): Promise<{ candidates: BookTitleCandidate[] }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task) throw new Error("外部书名生成任务不存在");
      assertStructuredSchema(input.value, BOOK_TITLE_CANDIDATES_SCHEMA as unknown as Record<string, unknown>, "外部书名候选结果");
      return { candidates: normalizeBookTitleCandidates(input.value) };
    },

    persistBookTitleCandidates: async (input: { projectId: string; sourceFingerprint: string; candidates: BookTitleCandidate[] }): Promise<BookTitleCandidatesRecord> => {
      const record = { candidates: input.candidates, generatedAt: new Date().toISOString(), sourceFingerprint: input.sourceFingerprint };
      const saved = await deps.repository.saveBookTitleCandidatesIfCurrent({ projectId: input.projectId, sourceFingerprint: input.sourceFingerprint, candidates: record });
      if (!saved) throw new Error("书名生成期间全书规划已变化，旧结果未保存");
      return record;
    },

    generateChapterTitle: async (input: { workflowId: string; projectId: string; documentId: string; sourceFingerprint: string; candidateStartIndex?: number }): Promise<GeneratedChapterTitleResult> => {
      const source = await deps.repository.getChapterTitleSource(input.projectId, input.documentId);
      if (!source) throw new Error("章节不存在");
      if (chapterTitleSourceFingerprint(source) !== input.sourceFingerprint) throw new Error("章节命名来源已变化，请重新生成");
      const plainText = source.objectKey ? await objects.getText(source.objectKey) : undefined;
      const prompt = buildChapterTitlePrompt({ ...source, plainText });
      const system = "你是中文长篇小说的章节命名编辑。标题必须忠实于本章独特内容，优先简练的四字中文，但不以牺牲准确性换取字数整齐。";
      const routingSnapshot = model.getRoutingSnapshot();
      const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "planning.foundation", stage: "foundation", system, prompt, schema: CHAPTER_TITLE_SCHEMA as unknown as Record<string, unknown>, reservedOutputTokens: 300, provenanceRefs: [input.documentId, input.sourceFingerprint] });
      try {
        const generated = await model.generateStructured<{ title: string }>({
          purpose: "planning.foundation",
          system,
          prompt: promptPackage.instruction,
          schema: CHAPTER_TITLE_SCHEMA as unknown as Record<string, unknown>,
          schemaName: "chapter_title",
          maxTokens: 300,
          temperature: 0.75,
          workflowRunId: input.workflowId,
          taskId: `${input.documentId}:chapter-title`,
          routingSnapshot,
          candidateStartIndex: input.candidateStartIndex,
          promptContext: promptPackage.manifest,
        });
        return { kind: "completed", title: normalizeChapterTitle(generated.value) };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        return {
          kind: "external",
          task: await externalTask({
            workflowId: input.workflowId,
            taskId: `${input.documentId}:chapter-title`,
            purpose: "planning.foundation",
            candidateIndex: error.candidateIndex,
            routingSnapshot,
            outputKind: "structured",
            system,
            instruction: promptPackage.instruction,
            schema: CHAPTER_TITLE_SCHEMA as unknown as Record<string, unknown>,
            schemaName: "chapter_title",
            baseRevision: 0,
            contextRefs: { projectId: input.projectId, documentId: input.documentId, sourceFingerprint: input.sourceFingerprint },
            promptContext: promptPackage.manifest,
          }),
        };
      }
    },

    materializeExternalChapterTitle: async (input: { modelTaskId: string; value: unknown }): Promise<{ title: string }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task) throw new Error("外部章节命名任务不存在");
      assertStructuredSchema(input.value, CHAPTER_TITLE_SCHEMA as unknown as Record<string, unknown>, "外部章节命名结果");
      return { title: normalizeChapterTitle(input.value) };
    },

    persistGeneratedChapterTitle: async (input: { projectId: string; documentId: string; sourceFingerprint: string; title: string }): Promise<{ title: string }> => {
      const title = normalizeChapterTitle({ title: input.title });
      const saved = await deps.repository.saveGeneratedChapterTitleIfCurrent({ ...input, title });
      if (!saved) throw new Error("章节命名期间标题、蓝图或正文已变化，旧结果未保存");
      return { title };
    },

    generateStoryArcBundle: async (input: { workflowId: string; projectId: string; arcId: string; authorIntent?: string; candidateStartIndex?: number; batchIndex?: number; startChapterIndex?: number }): Promise<GeneratedStoryArcResult> => {
      const planning = await deps.repository.getStoryArcPlanningInput(input.projectId);
      const arc = input.batchIndex ? await deps.repository.getStoryArc(input.projectId, input.arcId) : undefined;
      if (input.batchIndex && !arc) throw new Error("故事弧不存在");
      const prompt = input.batchIndex && arc
        ? buildStoryArcBatchPrompt({ ...planning, authorIntent: input.authorIntent, arc: arc.arc, batchIndex: input.batchIndex, startChapterIndex: input.startChapterIndex! })
        : buildStoryArcPrompt({ ...planning, authorIntent: input.authorIntent });
      const system = "你是长篇小说故事弧策划师。只输出符合 schema 的 JSON。";
      const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "planning.arc", stage: "planning", system, prompt, schema: storyArcBundleSchema as unknown as Record<string, unknown>, reservedOutputTokens: 12_000, provenanceRefs: [input.arcId] });
      try {
        const generated = await model.generateStructured<StoryArcBundle>({ purpose: "planning.arc", system, prompt: promptPackage.instruction, schema: storyArcBundleSchema as unknown as Record<string, unknown>, schemaName: "story-arc-bundle", maxTokens: 12_000, workflowRunId: input.workflowId, taskId: `${input.arcId}:story-arc`, candidateStartIndex: input.candidateStartIndex, promptContext: promptPackage.manifest });
        const bundle = parseStoryArcBundle(generated.value);
        if (input.batchIndex && (bundle.batch.batchIndex !== input.batchIndex || bundle.batch.startChapterIndex !== input.startChapterIndex)) throw new Error("生成结果的故事弧批次位置与请求不一致");
        const artifact = await makeArtifact({ projectId: input.projectId, taskId: `${input.arcId}:story-arc`, kind: "chapter-blueprint", baseRevision: 0, text: JSON.stringify(bundle, null, 2), structuredData: { ...bundle, workflowId: input.workflowId, arcId: input.arcId, modelProvenance: generated.provenance } });
        return { kind: "completed", artifact, bundle };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const routingSnapshot = model.getRoutingSnapshot();
        return { kind: "external", task: await externalTask({ workflowId: input.workflowId, taskId: `${input.arcId}:story-arc`, purpose: "planning.arc", candidateIndex: error.candidateIndex, routingSnapshot, outputKind: "structured", system, instruction: promptPackage.instruction, schema: storyArcBundleSchema as unknown as Record<string, unknown>, schemaName: "story-arc-bundle", baseRevision: 0, contextRefs: { arcId: input.arcId }, promptContext: promptPackage.manifest }) };
      }
    },

    materializeExternalStoryArcBundle: async (input: { modelTaskId: string; projectId: string; arcId: string; value: unknown }): Promise<{ artifact: Artifact; bundle: StoryArcBundle }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task) throw new Error("外部故事弧任务不存在");
      assertStructuredSchema(input.value, storyArcBundleSchema as unknown as Record<string, unknown>, "外部故事弧结果");
      const bundle = parseStoryArcBundle(input.value);
      const artifact = await makeArtifact({ projectId: input.projectId, taskId: task.taskId, kind: "chapter-blueprint", baseRevision: 0, text: JSON.stringify(bundle, null, 2), structuredData: { ...bundle, workflowId: task.workflowRunId, arcId: input.arcId, externalModelTaskId: task.id } });
      return { artifact, bundle };
    },

    projectStoryArcBundle: async (input: { projectId: string; arcId: string; artifact: Artifact; bundle: StoryArcBundle; actor: string; edited?: boolean }) => deps.repository.projectStoryArcBundle(input),

    reviewStoryArcBundle: async (input: { workflowId: string; projectId: string; arcId: string; artifact: Artifact; bundle: StoryArcBundle; candidateStartIndex?: number }): Promise<GeneratedStoryArcReviewResult> => {
      const planning = await deps.repository.getStoryArcPlanningInput(input.projectId);
      const context = JSON.stringify(planning, null, 2);
      const prompt = buildStoryArcReviewPrompt(input.bundle, context);
      const routingSnapshot = model.getRoutingSnapshot();
      const system = "你是独立长篇故事弧审核员。";
      const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "review.arc", stage: "review", system, prompt, schema: storyArcReviewSchema as unknown as Record<string, unknown>, provenanceRefs: [input.arcId, input.artifact.id] });
      try {
        const generated = await model.generateStructured<StoryArcReviewOutput>({ purpose: "review.arc", system, prompt: promptPackage.instruction, schema: storyArcReviewSchema as unknown as Record<string, unknown>, schemaName: "story-arc-review", workflowRunId: input.workflowId, taskId: `${input.arcId}:story-arc-review:${input.artifact.id}`, candidateStartIndex: input.candidateStartIndex, promptContext: promptPackage.manifest });
        const review = generated.value;
        const artifact = await makeArtifact({ projectId: input.projectId, taskId: `${input.arcId}:story-arc-review`, kind: "review", baseRevision: 0, text: JSON.stringify(review, null, 2), structuredData: { ...review, subjectArtifactId: input.artifact.id, workflowId: input.workflowId, modelProvenance: generated.provenance } });
        return { kind: "completed", artifact, review };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        return { kind: "external", task: await externalTask({ workflowId: input.workflowId, taskId: `${input.arcId}:story-arc-review:${input.artifact.id}`, purpose: "review.arc", candidateIndex: error.candidateIndex, routingSnapshot, outputKind: "review", system, instruction: promptPackage.instruction, schema: storyArcReviewSchema as unknown as Record<string, unknown>, schemaName: "story-arc-review", baseRevision: 0, contextRefs: { arcId: input.arcId, artifactId: input.artifact.id }, promptContext: promptPackage.manifest }) };
      }
    },

    materializeExternalStoryArcReview: async (input: { modelTaskId: string; projectId: string; arcId: string; subjectArtifactId: string; value: unknown }): Promise<{ artifact: Artifact; review: StoryArcReviewOutput }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task) throw new Error("外部故事弧审核任务不存在");
      assertStructuredSchema(input.value, storyArcReviewSchema as unknown as Record<string, unknown>, "外部故事弧审核结果");
      const review = input.value as StoryArcReviewOutput;
      const artifact = await makeArtifact({ projectId: input.projectId, taskId: task.taskId, kind: "review", baseRevision: 0, text: JSON.stringify(review, null, 2), structuredData: { ...review, subjectArtifactId: input.subjectArtifactId, workflowId: task.workflowRunId, externalModelTaskId: task.id } });
      return { artifact, review };
    },

    reviseStoryArcBundle: async (input: { workflowId: string; projectId: string; arcId: string; artifact: Artifact; bundle: StoryArcBundle; review: StoryArcReviewOutput; candidateStartIndex?: number }): Promise<GeneratedStoryArcResult> => {
      const planning = await deps.repository.getStoryArcPlanningInput(input.projectId);
      const prompt = buildStoryArcRevisionPrompt(input.bundle, input.review, JSON.stringify(planning, null, 2));
      const system = "你是长篇小说故事弧修订策划师。只输出完整 JSON。";
      const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "planning.arc-revision", stage: "revision", system, prompt, schema: storyArcBundleSchema as unknown as Record<string, unknown>, reservedOutputTokens: 12_000, provenanceRefs: [input.arcId, input.artifact.id] });
      try {
        const generated = await model.generateStructured<StoryArcBundle>({ purpose: "planning.arc-revision", system, prompt: promptPackage.instruction, schema: storyArcBundleSchema as unknown as Record<string, unknown>, schemaName: "story-arc-bundle", maxTokens: 12_000, workflowRunId: input.workflowId, taskId: `${input.arcId}:story-arc-revision`, candidateStartIndex: input.candidateStartIndex, promptContext: promptPackage.manifest });
        const bundle = parseStoryArcBundle(generated.value);
        if (bundle.batch.batchIndex !== input.bundle.batch.batchIndex || bundle.batch.startChapterIndex !== input.bundle.batch.startChapterIndex) throw new Error("故事弧修订不得改写批次位置");
        const artifact = await makeArtifact({ projectId: input.projectId, taskId: `${input.arcId}:story-arc-revision`, kind: "chapter-blueprint", baseRevision: 0, text: JSON.stringify(bundle, null, 2), structuredData: { ...bundle, workflowId: input.workflowId, arcId: input.arcId, sourceArtifactId: input.artifact.id, modelProvenance: generated.provenance } });
        return { kind: "completed", artifact, bundle };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const routingSnapshot = model.getRoutingSnapshot();
        return { kind: "external", task: await externalTask({ workflowId: input.workflowId, taskId: `${input.arcId}:story-arc-revision`, purpose: "planning.arc-revision", candidateIndex: error.candidateIndex, routingSnapshot, outputKind: "structured", system, instruction: promptPackage.instruction, schema: storyArcBundleSchema as unknown as Record<string, unknown>, schemaName: "story-arc-bundle", baseRevision: 0, contextRefs: { arcId: input.arcId, artifactId: input.artifact.id }, promptContext: promptPackage.manifest }) };
      }
    },

    approveStoryArcAutomatically: async (input: { projectId: string; arcId: string; artifactId: string }) => deps.repository.approveStoryArc(input.projectId, input.arcId, input.artifactId, "external-reviewer"),
    failStoryArc: async (input: { projectId: string; arcId: string; reason: string }) => deps.repository.failStoryArc(input.projectId, input.arcId, input.reason),
    failStoryArcBatch: async (input: { projectId: string; arcId: string; batchIndex: number; reason: string }) => deps.repository.failStoryArcBatch(input.projectId, input.arcId, input.batchIndex, input.reason),

    /**
     * 生成架构产出（foundation artifact）。
     *
     * 设计依据：AGENTS.md「reusable contracts over case-specific examples」+ 架构阶段原则。
     * - 按 work item.taskKey 调用 modelGateway.generateStructured(planning.foundation)
     * - 用 buildFoundationPrompt 构建 prompt（通用维度指导，不内置题材 fixture）
     * - 产出存为 kind="foundation" 的 artifact，并 attachArtifact 到 work item
     * - 前序 artifact 摘要从 dependsOn 链加载，提供依赖链上下文
     * - 支持 internal LLM 与 external-mcp 双路径（同 draft/review/revise）
     *
     * 与 draft activity 的区别：
     * - draft 生成章节正文（writing.draft, kind="draft"）
     * - generateFoundationWork 生成架构产出（planning.foundation, kind="foundation"）
     * - 两者都复用 makeArtifact + externalTask 模式
     */
    generateFoundationWork: async (input: {
      runId: string;
      workItemId: string;
      candidateStartIndex?: number;
    }): Promise<{ kind: "completed"; artifact: Artifact } | { kind: "external"; task: ModelTaskRecord; artifact: Artifact }> => {
      // 1. 加载 work item + run + project
      const work = await creativeGetWorkItem(deps.repository, input.workItemId);
      if (!work) throw new Error(`CreativeWorkItem 不存在：${input.workItemId}`);
      if (!work.taskKey) throw new Error(`work item 缺少 taskKey：${input.workItemId}`);

      const run = await getCreativeRun(deps.repository, input.runId);
      if (!run) throw new Error(`CreativeRun 不存在：${input.runId}`);

      const { project, priorArtifacts } = await deps.repository.getFoundationWorkContext(
        run.projectId,
        work.dependsOn,
        work.parameters.focusedPlanRegeneration === true ? work.taskKey as import("../application/project-plan").ProjectPlanTaskKey : undefined,
      );

      // Skill 注入(对齐 chapter-draft.ts 的 skill 消费方式):
      // 从 skillProvider 查询 applicableTasks 含 foundation 或 planning 的 skill,
      // 让 v1 迁移的 long-form-master-craft/hierarchical-outline/chapter-blueprint/
      // plot-segment-design/premise-pressure-test 等 skill 的 promptSections 真正进入 LLM。
      // 设计依据:AGENTS.md「reusable contracts」——不针对特定 skill 加规则,
      // 而是让所有声明 foundation/planning taskClass 的 skill 都有机会注入 prompt。
      // TODO P2: 当前未走 resolveSkillBundle(因 foundation 阶段无 PreflightPlan),
      // 未来若 cognition 层支持 foundation 阶段的 plan,可切换到 resolveSkillBundle 统一选中逻辑。
      const allSkills = await deps.skillProvider.list(run.projectId);
      const foundationSkills = allSkills
        .filter((skill) => skill.enabled && (skill.applicableTasks.includes("foundation") || skill.applicableTasks.includes("planning")))
        .map((skill) => ({ skillId: skill.skillId, promptSections: skill.promptSections }));

      // 3. 构建 prompt
      const prompt = buildFoundationPrompt({
        taskKey: work.taskKey,
        instruction: work.instruction,
        projectTitle: project.title,
        premise: typeof project.metadata?.premise === "string" ? project.metadata.premise : undefined,
        genre: typeof project.metadata?.genre === "string" ? project.metadata.genre : undefined,
        objective: typeof run.payload?.objective === "string" ? run.payload.objective : undefined,
        priorArtifacts,
        skills: foundationSkills,
      });

      const routingSnapshot = model.getRoutingSnapshot();
      const taskId = `${input.workItemId}:foundation`;
      const promptPackage = compileSinglePrompt({ projectId: run.projectId, workflowId: input.runId, purpose: "planning.foundation", stage: "foundation", system: FOUNDATION_SYSTEM_PROMPT, prompt, schema: foundationSchema as Record<string, unknown>, reservedOutputTokens: 4096, provenanceRefs: [input.workItemId, ...work.dependsOn] });

      // 4. 调用 LLM 生成（支持 external-mcp 双路径）
      try {
        const generated = await model.generateStructured<FoundationOutput>({
          purpose: "planning.foundation",
          system: FOUNDATION_SYSTEM_PROMPT,
          prompt: promptPackage.instruction,
          schema: foundationSchema as Record<string, unknown>,
          schemaName: "foundation-output",
          maxTokens: 4096,
          workflowRunId: input.runId,
          taskId,
          routingSnapshot,
          candidateStartIndex: input.candidateStartIndex,
          promptContext: promptPackage.manifest,
        });

        const artifact = await makeArtifact({
          projectId: run.projectId,
          taskId,
          kind: "foundation",
          baseRevision: 0,
          text: JSON.stringify(generated.value, null, 2),
          structuredData: {
            ...generated.value,
            modelProvenance: generated.provenance,
            workItemId: input.workItemId,
            taskKey: work.taskKey,
            runId: input.runId,
          },
        });
        await deps.repository.projectFoundationArtifact(artifact);

        const foundationClaim = foundationArtifactToMemoryClaim(artifact, {
          objective: typeof run.payload?.objective === "string" ? run.payload.objective : undefined,
        });
        const recordedClaims = await deps.repository.recordMemoryClaims({
          projectId: run.projectId,
          claims: [foundationClaim],
          sourceArtifactId: artifact.id,
        });
        if (recordedClaims.length && deps.memoryIndex) {
          try {
            await deps.memoryIndex.upsertClaims(run.projectId, recordedClaims);
          } catch (error) {
            console.warn(`[foundation-memory] Qdrant 索引失败，PostgreSQL 真源已保留：${(error as Error).message}`);
          }
        }

        // attachArtifact 到 work item
        await creativeAttachArtifact(deps.repository, input.workItemId, artifact.id);

        return { kind: "completed", artifact };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        // external-mcp 路径：创建 external task，返回 stub artifact（待外部回填）
        const task = await externalTask({
          workflowId: input.runId,
          taskId,
          purpose: "planning.foundation",
          candidateIndex: error.candidateIndex,
          routingSnapshot,
          outputKind: "structured",
          system: FOUNDATION_SYSTEM_PROMPT,
          instruction: promptPackage.instruction,
          schema: foundationSchema as Record<string, unknown>,
          schemaName: "foundation-output",
          baseRevision: 0,
          contextRefs: { workItemId: input.workItemId, taskKey: work.taskKey },
          promptContext: promptPackage.manifest,
        });
        // stub artifact：外部回填时由 materializeExternalFoundation 替换
        const stubArtifact = await makeArtifact({
          projectId: run.projectId,
          taskId,
          kind: "foundation",
          baseRevision: 0,
          text: "",
          structuredData: { workItemId: input.workItemId, taskKey: work.taskKey, runId: input.runId, pendingExternalTaskId: task.id },
        });
        await creativeAttachArtifact(deps.repository, input.workItemId, stubArtifact.id);
        return { kind: "external", task, artifact: stubArtifact };
      }
    },

    /**
     * 物化外部 foundation 任务结果（external-mcp 回填路径）。
     *
     * 与 materializeExternalText 对称：外部 MCP 完成 foundation 任务后，
     * 调用本 activity 将结果物化为 artifact 并 attach 到 work item。
     */
    materializeExternalFoundation: async (input: {
      modelTaskId: string;
      workItemId: string;
      value: unknown;
    }): Promise<Artifact> => {
      const work = await creativeGetWorkItem(deps.repository, input.workItemId);
      if (!work) throw new Error(`CreativeWorkItem 不存在：${input.workItemId}`);
      const run = await getCreativeRun(deps.repository, work.runId);
      if (!run) throw new Error(`CreativeRun 不存在：${work.runId}`);

      const artifact = await makeArtifact({
        projectId: run.projectId,
        taskId: `${input.workItemId}:foundation`,
        kind: "foundation",
        baseRevision: 0,
        text: JSON.stringify(input.value, null, 2),
        structuredData: {
          ...(input.value as Record<string, unknown>),
          workItemId: input.workItemId,
          taskKey: work.taskKey,
          runId: work.runId,
          materializedFromTask: input.modelTaskId,
        },
      });
      await deps.repository.projectFoundationArtifact(artifact);
      const foundationClaim = foundationArtifactToMemoryClaim(artifact, {
        objective: typeof run.payload?.objective === "string" ? run.payload.objective : undefined,
      });
      const recordedClaims = await deps.repository.recordMemoryClaims({
        projectId: run.projectId,
        claims: [foundationClaim],
        sourceArtifactId: artifact.id,
      });
      if (recordedClaims.length && deps.memoryIndex) {
        try {
          await deps.memoryIndex.upsertClaims(run.projectId, recordedClaims);
        } catch (error) {
          console.warn(`[foundation-memory] Qdrant 索引失败，PostgreSQL 真源已保留：${(error as Error).message}`);
        }
      }
      await creativeAttachArtifact(deps.repository, input.workItemId, artifact.id);
      return artifact;
    },
  };

  const loadRecord = async <T>(table: "memory_bundles" | "skill_bundles" | "execution_blueprints", id: string, label: string): Promise<T> => {
    const value = await deps.repository.getRecord(table, id);
    if (!value) throw new Error(`${label}不存在：${id}`);
    return value as T;
  };
  const loadArtifactText = async (artifactId: string): Promise<{ artifact: Artifact; text: string }> => {
    const artifact = await deps.repository.getArtifact(artifactId);
    if (!artifact) throw new Error(`产物不存在：${artifactId}`);
    if (!artifact.objectKey) throw new Error(`产物缺少正文对象：${artifactId}`);
    return { artifact, text: await objects.getText(artifact.objectKey) };
  };

  return {
    ...api,
    draftByRefs: async (input: { workflowId: string; intent: NovelIntent; blueprintId: string; memoryBundleId: string; skillBundleId: string; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; foundationArtifactIds?: string[] }): Promise<GeneratedTextResult> => {
      const [blueprint, memory, skills] = await Promise.all([
        loadRecord<ExecutionBlueprint>("execution_blueprints", input.blueprintId, "执行蓝图"),
        loadRecord<MemoryBundle>("memory_bundles", input.memoryBundleId, "记忆包"),
        loadRecord<SkillBundle>("skill_bundles", input.skillBundleId, "技能包"),
      ]);
      const requestedFoundationIds = input.foundationArtifactIds ?? [];
      const resolvedFoundationArtifacts = await Promise.all(requestedFoundationIds.map((id) => deps.repository.getArtifact(id)));
      const missingFoundationIds = requestedFoundationIds.filter((_, index) => !resolvedFoundationArtifacts[index]);
      if (missingFoundationIds.length) throw new Error(`冻结的全书规划产物不存在：${missingFoundationIds.join(",")}`);
      const foundationArtifacts = resolvedFoundationArtifacts as Artifact[];
      const planningContext = await deps.repository.getChapterPlanningContextSnapshot(blueprint.id);
      return api.draft({ ...input, blueprint, memory, skills, foundationArtifacts, planningContext });
    },
    reviewByRefs: async (input: { workflowId: string; artifactId: string; blueprintId: string; memoryBundleId: string; skillBundleId: string; role: ReviewerRole; identity: "internal" | "independent"; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; narrativeOrder?: number; suppressChapterSnapshotPromotion?: boolean }): Promise<GeneratedReviewResult> => {
      const [{ artifact, text }, blueprint, memory, skills] = await Promise.all([
        loadArtifactText(input.artifactId),
        loadRecord<ExecutionBlueprint>("execution_blueprints", input.blueprintId, "执行蓝图"),
        loadRecord<MemoryBundle>("memory_bundles", input.memoryBundleId, "记忆包"),
        loadRecord<SkillBundle>("skill_bundles", input.skillBundleId, "技能包"),
      ]);
      const planningContext = await deps.repository.getChapterPlanningContextSnapshot(blueprint.id);
      return api.review({ ...input, artifact, text, blueprint, memory, skills, planningContext });
    },
    reviseByRefs: async (input: { workflowId: string; intent: NovelIntent; artifactId: string; reviewIds: string[]; directedIssues?: ReviewIssue[]; strictRevisionWindows?: boolean; authorInstruction?: string; blueprintId: string; memoryBundleId: string; skillBundleId: string; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number }): Promise<GeneratedTextResult> => {
      const [{ artifact, text }, reviews, blueprint, memory, skills] = await Promise.all([
        loadArtifactText(input.artifactId),
        deps.repository.getReviewsByIds(input.reviewIds),
        loadRecord<ExecutionBlueprint>("execution_blueprints", input.blueprintId, "执行蓝图"),
        loadRecord<MemoryBundle>("memory_bundles", input.memoryBundleId, "记忆包"),
        loadRecord<SkillBundle>("skill_bundles", input.skillBundleId, "技能包"),
      ]);
      const planningContext = await deps.repository.getChapterPlanningContextSnapshot(blueprint.id);
      return api.revise({ ...input, artifact, text, reviews, blueprint, memory, skills, planningContext });
    },
  };
}
