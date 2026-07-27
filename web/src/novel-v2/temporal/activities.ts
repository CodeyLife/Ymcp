import { createHash, randomUUID } from "node:crypto";
import type { Artifact, ContextManifest, ExecutionBlueprint, MemoryBundle, MemoryProvider, NovelIntent, PreflightPlan, PreflightProjectSnapshot, Review, RuntimeLearningAssessmentV2, SkillBundle, SkillProvider, TaskAttemptRecord } from "../protocol";
import { buildContextManifest, buildMemoryBundle, compileExecutionBlueprint, createPreflightPlan, resolveSkillBundle } from "../cognition";
import { NovelPostgresRepository } from "../postgres-repository";
import type { ModelGateway } from "../model-gateway";
import { ContentObjectStore } from "../object-store";
import { CommitService } from "../commit-service";
import type { MemoryIndex } from "../qdrant-memory";
import { assessRuntimeLearningWithModel } from "../learning-assessment";

export function createNovelWorkflowActivities(deps: { repository: NovelPostgresRepository; memoryProvider: MemoryProvider; skillProvider: SkillProvider; modelGateway?: ModelGateway; objectStore?: ContentObjectStore; commitService?: CommitService; memoryIndex?: MemoryIndex }) {
  const model = deps.modelGateway;
  const objects = deps.objectStore ?? new ContentObjectStore();
  const commitService = deps.commitService ?? new CommitService(deps.repository, objects);
  const makeArtifact = async (input: { projectId: string; taskId: string; kind: Artifact["kind"]; baseRevision: number; text: string; structuredData?: Record<string, unknown> }): Promise<Artifact> => {
    const object = await objects.putText(input.text);
    const artifact = { id: randomUUID(), projectId: input.projectId, taskId: input.taskId, attemptId: randomUUID(), kind: input.kind, contentHash: object.hash, objectKey: object.key, structuredData: input.structuredData, baseRevision: input.baseRevision, createdAt: Date.now(), fingerprint: createHash("sha256").update(`${object.hash}:${input.taskId}`).digest("hex") } satisfies Artifact;
    await deps.repository.recordArtifact(artifact);
    return artifact;
  };
  return {
    updateWorkflowStatus: (input: { workflowId: string; status: string; payload?: Record<string, unknown> }) => deps.repository.updateWorkflowRunStatus(input.workflowId, input.status, input.payload),
    recordWorkflowSignal: (input: { workflowId: string; taskId: string; signal: string; payload?: Record<string, unknown> }) => deps.repository.recordTaskSignal(input),
    updateTaskAttempt: (input: { id: string; workflowRunId?: string; taskId: string; status: TaskAttemptRecord["status"]; payload?: Record<string, unknown> }) => deps.repository.upsertTaskAttempt(input),
    loadProjectSnapshot: (input: { projectId: string; targetDocumentId?: string }) => deps.repository.getProjectSnapshot(input.projectId, input.targetDocumentId),
    createPreflight: async (input: { intent: NovelIntent; snapshot: PreflightProjectSnapshot }) => createPreflightPlan(input.intent, input.snapshot),
    retrieveMemory: (input: { projectId: string; plan: PreflightPlan }) => buildMemoryBundle(input.plan, { projectId: input.projectId, provider: deps.memoryProvider }),
    resolveSkills: (input: { projectId: string; plan: PreflightPlan; memory: MemoryBundle; requestedCapabilities?: string[] }) => resolveSkillBundle(input.plan, input.memory, { projectId: input.projectId, provider: deps.skillProvider, requestedCapabilities: input.requestedCapabilities }),
    compileBlueprint: async (input: { intent: NovelIntent; plan: PreflightPlan; memory: MemoryBundle; skills: SkillBundle; snapshot: PreflightProjectSnapshot }): Promise<{ blueprint: ExecutionBlueprint; context: ContextManifest }> => {
      const context = buildContextManifest(input.plan, input.memory, { retrievalRunId: `retrieval:${input.plan.id}`, allClaimIds: input.memory.claims.map((claim) => claim.id) });
      const blueprint = compileExecutionBlueprint(input.intent, input.plan, input.memory, input.skills, input.snapshot, context);
      await deps.repository.putCognition(input.plan, input.memory, input.skills, blueprint, context);
      return { blueprint, context };
    },
    draft: async (input: { intent: NovelIntent; blueprint: ExecutionBlueprint; memory: MemoryBundle; skills: SkillBundle }) => {
      const skillSections = input.skills.skills.map((skill) => `${skill.skillId}@${skill.version}: gates=${skill.qualityGates.join(",")}`).join("\n");
      const memoryLines = input.memory.claims.map((claim) => `[${claim.authority}/${claim.kind}/${claim.reason}] ${claim.title}: ${claim.content}`).join("\n");
      const generated = model ? await model.generateText({ model: "novel-writer", system: "你是长篇小说写作 Worker。只写当前任务；只使用冻结 MemoryBundle 和 SkillBundle 中的事实；严格尊重叙事截止、视角知识边界、章节功能、文风目标和质量门。", prompt: `目标：${input.intent.objective}\n\n冻结上下文：\n${memoryLines}\n\n技能与质量门：\n${skillSections}\n\n输出要求：生成可进入审核的完整候选正文，不解释流程。`, maxTokens: input.blueprint.budget.maxOutputTokens }) : { text: "", usage: { model: "none", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 } };
      return { artifact: await makeArtifact({ projectId: input.intent.projectId, taskId: `${input.blueprint.id}:draft`, kind: "draft", baseRevision: input.blueprint.baseRevision, text: generated.text }), text: generated.text };
    },
    review: async (input: { artifact: Artifact; text: string; identity: "internal" | "independent" }): Promise<Review> => {
      const generated = model ? await model.generateStructured<{ verdict: "passed" | "revise" | "blocked"; issues: Review["issues"] }>({ model: input.identity === "independent" ? "novel-reviewer" : "novel-planner", system: `你是${input.identity === "independent" ? "独立" : "内置"}审核 Worker。`, prompt: input.text, schema: { verdict: ["passed", "revise", "blocked"], issues: [] } }) : { value: { verdict: "blocked" as const, issues: [{ severity: "blocker" as const, title: "模型网关未配置", evidence: "无法取得审核身份" }] }, usage: { model: "none", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 } };
      const review = { id: randomUUID(), projectId: input.artifact.projectId, artifactId: input.artifact.id, reviewerId: `${input.identity}-worker`, identity: input.identity, verdict: generated.value.verdict, issues: generated.value.issues, createdAt: Date.now(), artifactFingerprint: input.artifact.fingerprint } satisfies Review;
      await deps.repository.putReview(review);
      return review;
    },
    revise: async (input: { intent: NovelIntent; artifact: Artifact; text: string; reviews: Review[]; memory: MemoryBundle }) => {
      const generated = model ? await model.generateText({ model: "novel-writer", system: "根据审核证据修订正文，保留有效内容并修复所有 blocker/major。", prompt: `${input.text}\n审核：${JSON.stringify(input.reviews)}\n记忆：${JSON.stringify(input.memory.claims)}`, maxTokens: 16000 }) : { text: input.text, usage: { model: "none", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 } };
      return { artifact: await makeArtifact({ projectId: input.intent.projectId, taskId: `${input.artifact.taskId}:revise`, kind: "revision", baseRevision: input.artifact.baseRevision, text: generated.text }), text: generated.text };
    },
    extractFacts: async (input: { projectId: string; artifact: Artifact; text: string }) => {
      const artifact = await makeArtifact({ projectId: input.projectId, taskId: `${input.artifact.taskId}:facts`, kind: "fact-extraction", baseRevision: input.artifact.baseRevision, text: input.text, structuredData: { sourceArtifactId: input.artifact.id } });
      const claims = await deps.repository.recordFactExtraction({ projectId: input.projectId, artifact, text: input.text });
      if (claims.length && deps.memoryIndex) await deps.memoryIndex.upsertClaims(input.projectId, claims);
      return artifact;
    },
    assessLearning: async (input: { projectId: string; workflowId: string; artifact: Artifact; reviews: Review[] }): Promise<RuntimeLearningAssessmentV2> => {
      const { assessment, validationError } = await assessRuntimeLearningWithModel({ ...input, model });
      const recorded = validationError
        ? { ...assessment, validationError }
        : assessment;
      return deps.repository.recordLearningAssessment(recorded);
    },
    commit: (input: { projectId: string; documentId: string; artifact: Artifact; text: string; reviews: Review[]; baseRevision: number; idempotencyKey: string }) => commitService.commit(input),
  };
}
