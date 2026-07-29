import { createHash, randomUUID } from "node:crypto";
import Ajv from "ajv";
import type { Artifact, ContextManifest, CreativeRun, CreativeWorkItem, ExecutionBlueprint, MemoryBundle, MemoryClaim, MemoryHit, MemoryProvider, NovelIntent, PreflightPlan, PreflightProjectSnapshot, Review, RuntimeLearningAssessmentV2, SkillBundle, SkillProvider, TaskAttemptRecord } from "../protocol";
import { buildContextManifest, buildMemoryBundle, compileExecutionBlueprint, computeTokenBudget, createPreflightPlan, resolveSkillBundle } from "../cognition";
import { NovelPostgresRepository } from "../postgres-repository";
import type { ModelGateway } from "../model-gateway";
import { ExternalMcpRequiredError, type ModelExecutionProvenance, type ModelPurpose, type ModelRoutingSnapshot, type ModelTaskRecord, type ModelWorkPackage } from "../model-routing";
import { ContentObjectStore } from "../object-store";
import { parseStoryArcBundle, type ChapterPlanningContext, type StoryArcBundle } from "../application/story-arc";
import { buildStoryArcPrompt, buildStoryArcReviewPrompt, buildStoryArcRevisionPrompt, storyArcBundleSchema, storyArcReviewSchema, type StoryArcReviewOutput } from "../prompts/story-arc";
import { foundationArtifactToMemoryClaim } from "../foundation-memory";
import { CommitService } from "../commit-service";
import type { MemoryIndex } from "../qdrant-memory";
import { assessRuntimeLearningWithModel, blockingReviewIssues, buildRuntimeLearningPrompt, parseRuntimeLearningAssessmentV2, runtimeLearningAssessmentSchema } from "../learning-assessment";
import { buildChapterDraftPrompt } from "../prompts/chapter-draft";
import { buildChapterReviewPrompt, toReview, type ReviewerRole } from "../prompts/chapter-review";
import { buildChapterReflectionPrompt } from "../prompts/chapter-reflection";
import { applyRevisionWindows, buildRevisionWindowPrompt, planRevisionWindows, splitChapterParagraphs } from "../prompts/chapter-revision";
import { renderChapterPlanningContext } from "../prompts/chapter-planning-context";
import { factExtractionSchema, foundationSchema, reflectionSchema, reviewerSchema, type FactExtractionOutput, type FoundationOutput, type ReflectionOutput, type ReviewerOutput } from "../prompts/schemas";
import { extractFactsWithStats, projectFactExtractionOutput } from "../fact-extraction";
import { enrichCharactersFromChapter, parseCharacterEnrichmentOutput } from "../character-enrichment";
import { characterEnrichmentSchema } from "../prompts/schemas";
import { buildFactExtractionPrompt } from "../fact-extraction/prompt";
import { createCraftRuleCandidate } from "../craft-rule";
import { buildFoundationPrompt, FOUNDATION_SYSTEM_PROMPT } from "../prompts/foundation";
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

type GeneratedTextResult = { kind: "completed"; artifact: Artifact; text: string } | { kind: "external"; task: ModelTaskRecord };
type GeneratedReviewResult = { kind: "completed"; review: Review } | { kind: "external"; task: ModelTaskRecord };
type GeneratedArtifactResult = { kind: "completed"; artifact: Artifact } | { kind: "external"; task: ModelTaskRecord; artifact: Artifact };
type GeneratedLearningResult = { kind: "completed"; assessment: RuntimeLearningAssessmentV2 } | { kind: "external"; task: ModelTaskRecord };
type GeneratedStoryArcResult = { kind: "completed"; artifact: Artifact; bundle: StoryArcBundle } | { kind: "external"; task: ModelTaskRecord };
type GeneratedStoryArcReviewResult = { kind: "completed"; artifact: Artifact; review: StoryArcReviewOutput } | { kind: "external"; task: ModelTaskRecord };

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
  const externalTask = async (input: { workflowId: string; taskId: string; purpose: ModelPurpose; candidateIndex: number; routingSnapshot: ModelRoutingSnapshot; outputKind: ModelWorkPackage["outputKind"]; system?: string; instruction: string; schema?: Record<string, unknown>; schemaName?: string; baseRevision: number; contextRefs: ModelWorkPackage["contextRefs"] }): Promise<ModelTaskRecord> => {
    const inputFingerprint = createHash("sha256").update(JSON.stringify({ purpose: input.purpose, system: input.system, instruction: input.instruction, schema: input.schema, baseRevision: input.baseRevision, contextRefs: input.contextRefs })).digest("hex");
    const id = createHash("sha256").update(`${input.workflowId}:${input.taskId}:${input.candidateIndex}:${inputFingerprint}`).digest("hex");
    const workPackage: ModelWorkPackage = { id, workflowRunId: input.workflowId, taskId: input.taskId, purpose: input.purpose, configRevision: input.routingSnapshot.id, candidateIndex: input.candidateIndex, outputKind: input.outputKind, system: input.system, instruction: input.instruction, schema: input.schema, schemaName: input.schemaName, baseRevision: input.baseRevision, inputFingerprint, contextRefs: input.contextRefs, createdAt: Date.now() };
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
  return {
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
      const bundle = await buildMemoryBundle(input.plan, { projectId: input.projectId, provider: deps.memoryProvider, tokenBudget });

      // Phase 3.1: 注入未兑现的伏笔/承诺到 MemoryBundle
      // 设计依据：Phase 3.1 计划——buildMemoryBundle 把未兑现的 foreshadowing/promise
      // 注入上下文（高优先级），提醒 LLM 本章是否应兑现。
      // 仅 drafting/revision/planning 任务注入（review 任务不需要）。
      if (input.plan.taskClass === "drafting" || input.plan.taskClass === "revision" || input.plan.taskClass === "planning") {
        try {
          const { foreshadowings, promises } = await deps.repository.getOpenForeshadowingAndPromises(input.projectId, input.plan.narrativeCutoff);
          const narrativeHits: MemoryHit[] = [
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
          if (narrativeHits.length) {
            // 注入到 bundle.claims 顶部（高优先级，score=1.0）
            bundle.claims = [...narrativeHits, ...bundle.claims];
          }
        } catch (narrativeError) {
          console.warn(`[retrieveMemory] 伏笔/承诺注入失败（不阻塞 memory bundle）：${(narrativeError as Error).message}`);
        }
      }
      return bundle;
    },
    resolveSkills: (input: { projectId: string; plan: PreflightPlan; memory: MemoryBundle; requestedCapabilities?: string[]; genre?: string }) => resolveSkillBundle(input.plan, input.memory, { projectId: input.projectId, provider: deps.skillProvider, requestedCapabilities: input.requestedCapabilities, genre: input.genre }),
    resolveReviewSkills: async (input: { projectId: string; preflightId: string }): Promise<SkillBundle> => {
      const skills = (await deps.skillProvider.list(input.projectId)).filter((skill) => skill.enabled && skill.applicableTasks.includes("review"));
      const bundle: SkillBundle = { id: `review-skills:${input.preflightId}:${Date.now()}`, projectId: input.projectId, preflightId: input.preflightId, skills: skills.map((skill) => ({ skillId: skill.skillId, version: skill.version, qualityGates: skill.qualityGates, promptSections: skill.promptSections })), conflicts: [], missingCapabilities: [], fingerprint: "", createdAt: Date.now() };
      bundle.fingerprint = createHash("sha256").update(JSON.stringify(bundle.skills)).digest("hex");
      return bundle;
    },
    compileBlueprint: async (input: { intent: NovelIntent; plan: PreflightPlan; memory: MemoryBundle; skills: SkillBundle; snapshot: PreflightProjectSnapshot; foundationArtifacts?: Artifact[]; planningContext?: ChapterPlanningContext }): Promise<{ blueprint: ExecutionBlueprint; context: ContextManifest; routingSnapshot: ModelRoutingSnapshot }> => {
      const context = buildContextManifest(input.plan, input.memory, { retrievalRunId: `retrieval:${input.plan.id}`, allClaimIds: input.memory.claims.map((claim) => claim.id) });
      const blueprint = compileExecutionBlueprint(input.intent, input.plan, input.memory, input.skills, input.snapshot, context, input.foundationArtifacts, input.planningContext);
      await deps.repository.putCognition(input.plan, input.memory, input.skills, blueprint, context);
      if (input.planningContext && input.intent.target?.id) await deps.repository.putChapterPlanningContext(blueprint.id, input.intent.target.id, input.planningContext);
      return { blueprint, context, routingSnapshot: model.getRoutingSnapshot() };
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
      const prompt = buildChapterDraftPrompt(input);
      const system = "你是长篇小说写作 Worker。只写当前章节正文，不解释流程；只使用冻结 MemoryBundle 和 SkillBundle 中的事实；严格尊重叙事截止、视角知识边界、章节功能、文风目标和质量门。";
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
          });
        return { kind: "completed", artifact: await makeArtifact({ projectId: input.intent.projectId, taskId: `${input.blueprint.id}:draft`, kind: "draft", baseRevision: input.blueprint.baseRevision, text: generated.text, structuredData: { modelProvenance: generated.provenance, workflowId: input.workflowId } }), text: generated.text };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const task = await externalTask({ workflowId: input.workflowId, taskId: `${input.blueprint.id}:draft`, purpose: "writing.draft", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "text", system, instruction: prompt, baseRevision: input.blueprint.baseRevision, contextRefs: { blueprintId: input.blueprint.id, memoryBundleId: input.memory.id, skillBundleId: input.skills.id } });
        return { kind: "external", task };
      }
    },
    review: async (input: { workflowId: string; artifact: Artifact; text: string; blueprint: ExecutionBlueprint; memory: MemoryBundle; skills: SkillBundle; role: ReviewerRole; identity: "internal" | "independent"; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; narrativeOrder?: number; planningContext?: ChapterPlanningContext }): Promise<GeneratedReviewResult> => {
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
      const prompt = buildChapterReviewPrompt({ role: input.role, artifact: input.artifact, text: input.text, blueprint: input.blueprint, memory: input.memory, skills: input.skills, payoffStats, planningContext: input.planningContext });
      const system = `你是${input.identity === "independent" ? "独立" : "内置"}审核 Worker（${input.role}）。`;
      try {
        const generated = await model.generateStructured<ReviewerOutput>({
            purpose: reviewerPurpose(input.role),
            system,
            prompt,
            schema: reviewerSchema as unknown as Record<string, unknown>,
            schemaName: `reviewer:${input.role}`,
            workflowRunId: input.workflowId,
            taskId: `${input.artifact.taskId}:review:${input.role}`,
            routingSnapshot: input.routingSnapshot,
            candidateStartIndex: input.candidateStartIndex,
          });
        const review = { ...toReview({ artifact: input.artifact, identity: input.identity, role: input.role, output: generated.value }), modelProvenance: generated.provenance };
        await deps.repository.putReview(review);
        return { kind: "completed", review };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const task = await externalTask({ workflowId: input.workflowId, taskId: `${input.artifact.taskId}:review:${input.role}`, purpose: reviewerPurpose(input.role), candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "review", system, instruction: prompt, schema: reviewerSchema as unknown as Record<string, unknown>, schemaName: `reviewer:${input.role}`, baseRevision: input.artifact.baseRevision, contextRefs: { artifactId: input.artifact.id, blueprintId: input.blueprint.id, memoryBundleId: input.memory.id } });
        return { kind: "external", task };
      }
    },
    revise: async (input: { workflowId: string; intent: NovelIntent; artifact: Artifact; text: string; reviews: Review[]; memory: MemoryBundle; blueprint: ExecutionBlueprint; skills: SkillBundle; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; planningContext?: ChapterPlanningContext }): Promise<GeneratedTextResult> => {
      const actionableIssues = input.reviews.flatMap((review) => review.issues).filter((issue) => issue.severity === "blocker" || issue.severity === "major");
      const system = "你是长篇小说局部修订编辑。严格依据审核证据修订，不得扩写无关情节或发明冻结上下文之外的事实。";
      const fullRevisionPrompt = [
        "修订下面整章正文，修复所有列出的 blocker/major。输出必须且只能是完整修订后正文，不使用 Markdown，不解释过程。",
        "## 原文",
        input.text,
        "## 审核问题",
        actionableIssues.map((issue, index) => [
          `${index + 1}. [${issue.severity}] ${issue.title}`,
          `问题：${issue.description ?? issue.evidence}`,
          `证据：${issue.excerpt ?? issue.evidence}`,
          `建议：${issue.suggestion ?? "根据证据修复"}`,
          `改写参考：${issue.rewriteExample ?? "无"}`,
        ].join("\n")).join("\n\n") || "无 blocker/major；保持原文。",
        "## 冻结记忆",
        input.memory.claims.map((claim) => `- [${claim.authority}/${claim.kind}] ${claim.title}: ${claim.content}`).join("\n") || "（无）",
        input.planningContext ? renderChapterPlanningContext(input.planningContext) : "## 冻结章节规划上下文\n（历史章节无规划快照。）",
        "## 已激活修订技能",
        input.skills.skills.map((skill) => [`### ${skill.skillId}@${skill.version}`, skill.promptSections.revision ?? ""].filter(Boolean).join("\n")).join("\n\n") || "（无）",
      ].join("\n\n");
      try {
        const windows = planRevisionWindows(input.text, actionableIssues);
        const paragraphs = splitChapterParagraphs(input.text);
        const replacements: Array<{ window: (typeof windows)[number]; text: string }> = [];
        const modelProvenance: ModelExecutionProvenance[] = [];
        for (const window of windows) {
          const source = paragraphs.slice(window.start, window.end + 1).join("\n\n");
          const generated = await model.generateText({
            purpose: "writing.revision",
            system,
            prompt: buildRevisionWindowPrompt({ text: input.text, window, memory: input.memory, skills: input.skills, planningContext: input.planningContext }),
            maxTokens: Math.min(4096, Math.max(1024, source.length * 2)),
            temperature: 0.25,
            workflowRunId: input.workflowId,
            taskId: `${input.artifact.taskId}:revise:${window.start + 1}-${window.end + 1}`,
            routingSnapshot: input.routingSnapshot,
            candidateStartIndex: input.candidateStartIndex,
          });
          if (generated.text.trim() && generated.text.trim() !== source.trim()) {
            replacements.push({ window, text: generated.text });
            modelProvenance.push(generated.provenance);
          }
        }
        if (replacements.length) {
          const revisedText = applyRevisionWindows(input.text, replacements);
          return { kind: "completed", artifact: await makeArtifact({ projectId: input.intent.projectId, taskId: `${input.artifact.taskId}:revise`, kind: "revision", baseRevision: input.artifact.baseRevision, text: revisedText, structuredData: { modelProvenance, revisionWindows: replacements.map(({ window }) => ({ start: window.start + 1, end: window.end + 1, issueCount: window.issues.length })), workflowId: input.workflowId } }), text: revisedText };
        }
        const generated = await model.generateText({ purpose: "writing.revision", system, prompt: fullRevisionPrompt, maxTokens: input.blueprint.budget.maxOutputTokens, workflowRunId: input.workflowId, taskId: `${input.artifact.taskId}:revise:full`, routingSnapshot: input.routingSnapshot, candidateStartIndex: input.candidateStartIndex });
        return { kind: "completed", artifact: await makeArtifact({ projectId: input.intent.projectId, taskId: `${input.artifact.taskId}:revise`, kind: "revision", baseRevision: input.artifact.baseRevision, text: generated.text, structuredData: { modelProvenance: generated.provenance, revisionMode: "full-fallback", workflowId: input.workflowId } }), text: generated.text };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const task = await externalTask({ workflowId: input.workflowId, taskId: `${input.artifact.taskId}:revise`, purpose: "writing.revision", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "text", system, instruction: fullRevisionPrompt, baseRevision: input.artifact.baseRevision, contextRefs: { artifactId: input.artifact.id, blueprintId: input.blueprint.id, memoryBundleId: input.memory.id, skillBundleId: input.skills.id } });
        return { kind: "external", task };
      }
    },
    materializeExternalText: async (input: { projectId: string; modelTaskId: string; text: string; kind: "draft" | "revision"; baseRevision: number }): Promise<{ artifact: Artifact; text: string }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task || task.status !== "submitted" || task.result?.text !== input.text) throw new Error("外部文本任务尚未通过 Runtime 验证");
      const artifact = await makeArtifact({ projectId: input.projectId, taskId: task.taskId, kind: input.kind, baseRevision: input.baseRevision, text: input.text, structuredData: { externalModelTaskId: task.id, modelProvenance: { routeSnapshotId: task.configRevision, purpose: task.purpose, candidateIndex: task.candidateIndex, executor: "external-mcp", model: "external-mcp", promptFingerprint: task.workPackage.inputFingerprint }, workflowId: task.workflowRunId } });
      return { artifact, text: input.text };
    },
    materializeExternalReview: async (input: { modelTaskId: string; artifact: Artifact; identity: "internal" | "independent"; role: ReviewerRole; value: unknown }): Promise<Review> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      const validate = new Ajv({ allErrors: true, strict: false }).compile(reviewerSchema);
      if (!task || task.status !== "submitted" || !validate(input.value)) throw new Error(`外部审核结果无效：${validate.errors?.map((item) => item.message).join("；") ?? "任务未提交"}`);
      const review = { ...toReview({ artifact: input.artifact, identity: input.identity, role: input.role, output: input.value as ReviewerOutput }), modelProvenance: { routeSnapshotId: task.configRevision, purpose: task.purpose, candidateIndex: task.candidateIndex, executor: "external-mcp" as const, model: "external-mcp", promptFingerprint: task.workPackage.inputFingerprint } };
      await deps.repository.putReview(review);
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
        return { kind: "completed", artifact: { ...factArtifact, structuredData: { ...factArtifact.structuredData, narrativeElements: result.narrativeElements, payoffMoments: result.payoffMoments ?? [] } } };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const prompt = buildFactExtractionPrompt({ artifact: factArtifact, text: input.text, skills: factExtractionSkills });
        const task = await externalTask({ workflowId: input.workflowId, taskId: `${input.artifact.taskId}:facts:model`, purpose: "facts.extract", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "structured", system: "你是事实提取 Worker。只输出符合 JSON Schema 的 JSON。", instruction: prompt, schema: factExtractionSchema as unknown as Record<string, unknown>, schemaName: "fact-extraction", baseRevision: input.artifact.baseRevision, contextRefs: { artifactId: factArtifact.id, blueprintId: input.blueprint.id } });
        return { kind: "external", task, artifact: factArtifact };
      }
    },
    materializeExternalFacts: async (input: { modelTaskId: string; projectId: string; artifact: Artifact; text: string; documentId?: string; narrativeOrder?: number }): Promise<Artifact> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      const validate = new Ajv({ allErrors: true, strict: false }).compile(factExtractionSchema);
      if (!task || task.status !== "submitted" || !validate(task.result?.value)) throw new Error(`外部事实提取结果无效：${validate.errors?.map((item) => item.message).join("；") ?? "任务未提交"}`);
      const extractionContext = await deps.repository.getFactExtractionContext(input.projectId);
      const projected = projectFactExtractionOutput({ projectId: input.projectId, artifact: input.artifact, text: input.text, existingContentHashes: extractionContext.contentHashes, existingClaimsIndex: extractionContext.claimsIndex }, task.result!.value as FactExtractionOutput);
      const recorded = await deps.repository.recordFactExtraction({ projectId: input.projectId, artifact: input.artifact, claims: projected.claims });
      const retrievable = recorded.filter((claim) => claim.authority !== "candidate");
      if (retrievable.length && deps.memoryIndex) await deps.memoryIndex.upsertClaims(input.projectId, retrievable);
      return { ...input.artifact, structuredData: { ...input.artifact.structuredData, narrativeElements: projected.narrativeElements, payoffMoments: projected.payoffMoments ?? [] } };
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
        const task = await externalTask({ workflowId: input.workflowId, taskId: `${input.artifact.taskId}:learning:${input.assessmentKey}`, purpose: "learning.assess", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "structured", system: "你是长篇小说 Runtime 的学习闭环审计员。", instruction: buildRuntimeLearningPrompt({ artifact: input.artifact, reviews: input.reviews, availableSkills }), schema: runtimeLearningAssessmentSchema, schemaName: "runtime-learning-assessment", baseRevision: input.artifact.baseRevision, contextRefs: { artifactId: input.artifact.id, reviewIds: input.reviews.map((review) => review.id).join(",") } });
        return { kind: "external", task };
      }
    },
    materializeExternalLearning: async (input: { modelTaskId: string; projectId: string; workflowId: string; artifact: Artifact; reviews: Review[] }): Promise<RuntimeLearningAssessmentV2> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task || task.status !== "submitted") throw new Error("外部 learning 任务尚未提交");
      const assessment = parseRuntimeLearningAssessmentV2(task.result?.value, { id: `learning:${input.artifact.id}`, projectId: input.projectId, source: { workflowId: input.workflowId, artifactId: input.artifact.id, reviewIds: input.reviews.map((review) => review.id), fingerprint: input.artifact.fingerprint }, createdAt: Date.now() });
      return recordLearning(assessment);
    },
    commit: (input: { projectId: string; documentId: string; artifact: Artifact; factArtifact?: Artifact; narrativeOrder?: number; text: string; reviews: Review[]; baseRevision: number; idempotencyKey: string }) => commitService.commit({ ...input, narrativeElements: input.factArtifact?.structuredData?.narrativeElements as FactExtractionOutput["narrativeElements"] | undefined, payoffMoments: input.factArtifact?.structuredData?.payoffMoments as FactExtractionOutput["payoffMoments"] | undefined }),
    commitAuthorApproved: (input: { projectId: string; documentId: string; artifact: Artifact; factArtifact?: Artifact; narrativeOrder?: number; text: string; reviews: Review[]; baseRevision: number; idempotencyKey: string }) => commitService.commitAuthorApproved({ ...input, narrativeElements: input.factArtifact?.structuredData?.narrativeElements as FactExtractionOutput["narrativeElements"] | undefined, payoffMoments: input.factArtifact?.structuredData?.payoffMoments as FactExtractionOutput["payoffMoments"] | undefined }),
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
    enrichCharacters: async (input: { workflowId: string; projectId: string; documentId: string; revisionId: string; narrativeOrder: number; artifact: Artifact; text: string; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number }): Promise<{ kind: "completed"; result: { entityUpdates: number; knowledgeClaims: number; relationRecords: number } } | { kind: "external"; task: ModelTaskRecord }> => {
      try {
        const result = await enrichCharactersFromChapter(
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
        const task = await externalTask({
          workflowId: input.workflowId,
          taskId: `${input.artifact.taskId}:enrich-characters`,
          purpose: "facts.extract",
          candidateIndex: error.candidateIndex,
          routingSnapshot: input.routingSnapshot,
          outputKind: "structured",
          system: "你是角色富化提取 Worker。只输出符合 JSON Schema 的 JSON。",
          instruction: prompt,
          schema: characterEnrichmentSchema as unknown as Record<string, unknown>,
          schemaName: "character-enrichment",
          baseRevision: input.artifact.baseRevision,
          contextRefs: { artifactId: input.artifact.id, documentId: input.documentId, revisionId: input.revisionId, narrativeOrder: String(input.narrativeOrder) },
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
      try {
        const generated = await model.generateStructured<ReflectionOutput>({
          purpose: "review.reader",
          system,
          prompt,
          schema: reflectionSchema as unknown as Record<string, unknown>,
          schemaName: "chapter-reflection",
          workflowRunId: input.workflowId,
          taskId: `${input.artifact.taskId}:reflection`,
          routingSnapshot: input.routingSnapshot,
          candidateStartIndex: input.candidateStartIndex,
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
          instruction: prompt,
          schema: reflectionSchema as unknown as Record<string, unknown>,
          schemaName: "chapter-reflection",
          baseRevision: input.artifact.baseRevision,
          contextRefs: { artifactId: input.artifact.id, blueprintId: input.blueprint.id, memoryBundleId: input.memory.id },
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
    loadDocumentPlainText: async (input: { projectId: string; documentId: string }): Promise<{ plainText: string; contentHtml: string; wordCount: number; baseRevision: number; artifactId: string }> => {
      const content = await deps.repository.getFinalDocumentContentRef(input.projectId, input.documentId);
      if (!content) throw new Error(`章节不存在：${input.documentId}`);
      if (content.status !== "final") {
        throw new Error(`章节状态必须为 final（当前为 ${content.status}），只对已定稿章节开放重审`);
      }
      if (!content.objectKey) throw new Error(`章节 ${input.documentId} 无完整定稿 revision/content blob`);
      const plainText = await objects.getText(content.objectKey);

      return {
        plainText,
        contentHtml: "", // TODO P3: contentHtml 暂未存储，commit-service 也只存 plainText
        wordCount: plainText.length,
        baseRevision: content.revision,
        artifactId: content.artifactId,
      };
    },

    loadProposedDraft: async (input: { projectId: string; artifactId: string }): Promise<{ artifact: Artifact; text: string }> => {
      const artifact = await deps.repository.getArtifactById(input.projectId, input.artifactId);
      if (!artifact?.objectKey) throw new Error(`作者修订 proposal 不存在或缺少 objectKey：${input.artifactId}`);
      return { artifact, text: await objects.getText(artifact.objectKey) };
    },

    createReviewDraft: (input: { projectId: string; documentId: string; workflowId: string; sourceArtifactId: string; blueprint: ExecutionBlueprint; text: string; baseRevision: number }): Promise<Artifact> =>
      makeArtifact({
        projectId: input.projectId,
        taskId: `${input.blueprint.id}:review-draft`,
        kind: "draft",
        baseRevision: input.baseRevision,
        text: input.text,
        structuredData: {
          source: "chapter-review",
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
      if (filteredClaims.length === bundle.claims.length) return bundle;
      return {
        ...bundle,
        claims: filteredClaims,
        sourceRevisionIds: [...new Set(filteredClaims.flatMap((claim) => claim.sourceRevisionIds))],
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

    generateStoryArcBundle: async (input: { workflowId: string; projectId: string; arcId: string; authorIntent?: string; candidateStartIndex?: number }): Promise<GeneratedStoryArcResult> => {
      const planning = await deps.repository.getStoryArcPlanningInput(input.projectId);
      const prompt = buildStoryArcPrompt({ ...planning, authorIntent: input.authorIntent });
      try {
        const generated = await model.generateStructured<StoryArcBundle>({ purpose: "planning.arc", system: "你是长篇小说故事弧策划师。只输出符合 schema 的 JSON。", prompt, schema: storyArcBundleSchema as unknown as Record<string, unknown>, schemaName: "story-arc-bundle", maxTokens: 12_000, workflowRunId: input.workflowId, taskId: `${input.arcId}:story-arc`, candidateStartIndex: input.candidateStartIndex });
        const bundle = parseStoryArcBundle(generated.value);
        const artifact = await makeArtifact({ projectId: input.projectId, taskId: `${input.arcId}:story-arc`, kind: "chapter-blueprint", baseRevision: 0, text: JSON.stringify(bundle, null, 2), structuredData: { ...bundle, workflowId: input.workflowId, arcId: input.arcId, modelProvenance: generated.provenance } });
        return { kind: "completed", artifact, bundle };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const routingSnapshot = model.getRoutingSnapshot();
        return { kind: "external", task: await externalTask({ workflowId: input.workflowId, taskId: `${input.arcId}:story-arc`, purpose: "planning.arc", candidateIndex: error.candidateIndex, routingSnapshot, outputKind: "structured", system: "你是长篇小说故事弧策划师。只输出符合 schema 的 JSON。", instruction: prompt, schema: storyArcBundleSchema as unknown as Record<string, unknown>, schemaName: "story-arc-bundle", baseRevision: 0, contextRefs: { arcId: input.arcId } }) };
      }
    },

    materializeExternalStoryArcBundle: async (input: { modelTaskId: string; projectId: string; arcId: string; value: unknown }): Promise<{ artifact: Artifact; bundle: StoryArcBundle }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task) throw new Error("外部故事弧任务不存在");
      const bundle = parseStoryArcBundle(input.value);
      const artifact = await makeArtifact({ projectId: input.projectId, taskId: task.taskId, kind: "chapter-blueprint", baseRevision: 0, text: JSON.stringify(bundle, null, 2), structuredData: { ...bundle, workflowId: task.workflowRunId, arcId: input.arcId, externalModelTaskId: task.id } });
      return { artifact, bundle };
    },

    projectStoryArcBundle: async (input: { projectId: string; arcId: string; artifact: Artifact; bundle: StoryArcBundle; actor: string; edited?: boolean }) => deps.repository.projectStoryArcBundle(input),

    reviewStoryArcBundle: async (input: { workflowId: string; projectId: string; arcId: string; artifact: Artifact; bundle: StoryArcBundle; forceExternal?: boolean; candidateStartIndex?: number }): Promise<GeneratedStoryArcReviewResult> => {
      const planning = await deps.repository.getStoryArcPlanningInput(input.projectId);
      const context = JSON.stringify(planning, null, 2);
      const prompt = buildStoryArcReviewPrompt(input.bundle, context);
      const routingSnapshot = model.getRoutingSnapshot();
      if (input.forceExternal) {
        return { kind: "external", task: await externalTask({ workflowId: input.workflowId, taskId: `${input.arcId}:story-arc-review:${input.artifact.id}`, purpose: "review.arc", candidateIndex: input.candidateStartIndex ?? 0, routingSnapshot, outputKind: "review", system: "你是独立长篇故事弧审核员。", instruction: prompt, schema: storyArcReviewSchema as unknown as Record<string, unknown>, schemaName: "story-arc-review", baseRevision: 0, contextRefs: { arcId: input.arcId, artifactId: input.artifact.id } }) };
      }
      try {
        const generated = await model.generateStructured<StoryArcReviewOutput>({ purpose: "review.arc", system: "你是独立长篇故事弧审核员。", prompt, schema: storyArcReviewSchema as unknown as Record<string, unknown>, schemaName: "story-arc-review", workflowRunId: input.workflowId, taskId: `${input.arcId}:story-arc-review:${input.artifact.id}`, candidateStartIndex: input.candidateStartIndex });
        const review = generated.value;
        const artifact = await makeArtifact({ projectId: input.projectId, taskId: `${input.arcId}:story-arc-review`, kind: "review", baseRevision: 0, text: JSON.stringify(review, null, 2), structuredData: { ...review, subjectArtifactId: input.artifact.id, workflowId: input.workflowId, modelProvenance: generated.provenance } });
        return { kind: "completed", artifact, review };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        return { kind: "external", task: await externalTask({ workflowId: input.workflowId, taskId: `${input.arcId}:story-arc-review:${input.artifact.id}`, purpose: "review.arc", candidateIndex: error.candidateIndex, routingSnapshot, outputKind: "review", system: "你是独立长篇故事弧审核员。", instruction: prompt, schema: storyArcReviewSchema as unknown as Record<string, unknown>, schemaName: "story-arc-review", baseRevision: 0, contextRefs: { arcId: input.arcId, artifactId: input.artifact.id } }) };
      }
    },

    materializeExternalStoryArcReview: async (input: { modelTaskId: string; projectId: string; arcId: string; subjectArtifactId: string; value: unknown }): Promise<{ artifact: Artifact; review: StoryArcReviewOutput }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task || !input.value || typeof input.value !== "object") throw new Error("外部故事弧审核结果无效");
      const review = input.value as StoryArcReviewOutput;
      const artifact = await makeArtifact({ projectId: input.projectId, taskId: task.taskId, kind: "review", baseRevision: 0, text: JSON.stringify(review, null, 2), structuredData: { ...review, subjectArtifactId: input.subjectArtifactId, workflowId: task.workflowRunId, externalModelTaskId: task.id } });
      return { artifact, review };
    },

    reviseStoryArcBundle: async (input: { workflowId: string; projectId: string; arcId: string; artifact: Artifact; bundle: StoryArcBundle; review: StoryArcReviewOutput; candidateStartIndex?: number }): Promise<GeneratedStoryArcResult> => {
      const planning = await deps.repository.getStoryArcPlanningInput(input.projectId);
      const prompt = buildStoryArcRevisionPrompt(input.bundle, input.review, JSON.stringify(planning, null, 2));
      try {
        const generated = await model.generateStructured<StoryArcBundle>({ purpose: "planning.arc-revision", system: "你是长篇小说故事弧修订策划师。只输出完整 JSON。", prompt, schema: storyArcBundleSchema as unknown as Record<string, unknown>, schemaName: "story-arc-bundle", maxTokens: 12_000, workflowRunId: input.workflowId, taskId: `${input.arcId}:story-arc-revision`, candidateStartIndex: input.candidateStartIndex });
        const bundle = parseStoryArcBundle(generated.value);
        const artifact = await makeArtifact({ projectId: input.projectId, taskId: `${input.arcId}:story-arc-revision`, kind: "chapter-blueprint", baseRevision: 0, text: JSON.stringify(bundle, null, 2), structuredData: { ...bundle, workflowId: input.workflowId, arcId: input.arcId, sourceArtifactId: input.artifact.id, modelProvenance: generated.provenance } });
        return { kind: "completed", artifact, bundle };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const routingSnapshot = model.getRoutingSnapshot();
        return { kind: "external", task: await externalTask({ workflowId: input.workflowId, taskId: `${input.arcId}:story-arc-revision`, purpose: "planning.arc-revision", candidateIndex: error.candidateIndex, routingSnapshot, outputKind: "structured", system: "你是长篇小说故事弧修订策划师。只输出完整 JSON。", instruction: prompt, schema: storyArcBundleSchema as unknown as Record<string, unknown>, schemaName: "story-arc-bundle", baseRevision: 0, contextRefs: { arcId: input.arcId, artifactId: input.artifact.id } }) };
      }
    },

    approveStoryArcAutomatically: async (input: { projectId: string; arcId: string; artifactId: string }) => deps.repository.approveStoryArc(input.projectId, input.arcId, input.artifactId, "external-reviewer"),
    failStoryArc: async (input: { projectId: string; arcId: string; reason: string }) => deps.repository.failStoryArc(input.projectId, input.arcId, input.reason),

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

      // 4. 调用 LLM 生成（支持 external-mcp 双路径）
      try {
        const generated = await model.generateStructured<FoundationOutput>({
          purpose: "planning.foundation",
          system: FOUNDATION_SYSTEM_PROMPT,
          prompt,
          schema: foundationSchema as Record<string, unknown>,
          schemaName: "foundation-output",
          maxTokens: 4096,
          workflowRunId: input.runId,
          taskId,
          routingSnapshot,
          candidateStartIndex: input.candidateStartIndex,
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
          instruction: prompt,
          schema: foundationSchema as Record<string, unknown>,
          schemaName: "foundation-output",
          baseRevision: 0,
          contextRefs: { workItemId: input.workItemId, taskKey: work.taskKey },
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
}
