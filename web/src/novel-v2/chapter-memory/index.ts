import { createHash } from "node:crypto";
import Ajv from "ajv";
import type { Artifact, ChapterMemory } from "../protocol";
import type { ModelGateway } from "../model-gateway";
import type { ModelRoutingSnapshot } from "../model-routing";
import { NovelPostgresRepository } from "../postgres-repository";
import type { ObjectStoreAdapter } from "../object-store";
import type { MemoryIndex } from "../qdrant-memory";
import { chapterMemorySchema, type ChapterMemoryOutput } from "../prompts/schemas";
import { buildChapterMemoryPrompt } from "./prompt";
import { compileStageContext } from "../stage-context";

/**
 * V2 章节记忆（chapter memory）创建模块。
 *
 * 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约。
 *
 * 流程：
 * 1. 从 objectStore 取章节正文（commit 后已落库）
 * 2. LLM 结构化提取（purpose=facts.extract，复用现有 model routing）：summary/keyEvents/characterStates/unresolvedThreads/emotionalArc
 * 3. 写入 chapter_memories 表（Postgres）
 * 4. 同步 upsert 到 Qdrant（向量索引，kind=chapter-memory）
 *
 * 与 fact-extraction 的区别：
 * - fact-extraction 提取细粒度事实（MemoryClaim，subject/predicate/object），用于事实账本
 * - chapter memory 提取章节级高层摘要（ChapterMemory，summary/keyEvents/...），用于跨章节一致性
 *
 * 失败处理：失败不阻塞 commit（revision 已落库），只记录错误让上游 learning 闭环感知。
 * 符合 AGENTS.md「不阻塞 commit」契约。
 *
 * 设计原则（AGENTS.md「reusable contracts over case-specific examples」）：
 * - 本模块只做编排，提取规则在 prompt.ts 中独立维护
 * - 不内置网文爽点/套路识别（走 craft rule 沉淀）
 * - 提取目标是题材无关的叙事要素
 */

export interface CreateChapterMemoryInput {
  projectId: string;
  documentId: string;
  /** 定稿 revision id（commit-stage 产出）。 */
  revisionId: string;
  /** 章节顺序号（与 manuscript_documents.narrative_order 对齐）。 */
  narrativeOrder: number;
  /** 章节正文（commit-stage 已写入 objectStore，这里直接传入避免重复读取）。 */
  text: string;
  /** 章节定稿 artifact（commit-stage 产出，用于 provenance 追溯）。 */
  artifact: Artifact;
  model: ModelGateway;
  routingSnapshot?: ModelRoutingSnapshot;
  candidateStartIndex?: number;
  workflowRunId?: string;
  taskId?: string;
}

export interface CreateChapterMemoryDeps {
  repository: NovelPostgresRepository;
  objects: ObjectStoreAdapter;
  /** Qdrant 索引（可选，缺失时跳过向量索引，不影响 Postgres 落库）。 */
  memoryIndex?: MemoryIndex;
}

/**
 * 从定稿 revision 创建 chapter memory。
 *
 * 返回值：成功返回 ChapterMemory，失败抛错（由上游 try/catch 决定是否阻塞 commit）。
 *
 * 幂等性：id 格式 `memory:chapter:${revisionId}`，同一 revision 重复调用会 UPSERT 覆盖。
 * 章节重审（产生新 revision）会创建新的 chapter memory，旧 revision 的 chapter memory 保留作为历史。
 * 检索时（getChapterMemories）用 DISTINCT ON (document_id) 取最新一条。
 */
export async function createChapterMemoryFromRevision(input: CreateChapterMemoryInput, deps: CreateChapterMemoryDeps): Promise<ChapterMemory> {
  // 1. 取前章 chapter memory 摘要（让 LLM 理解上下文连续性）
  const priorMemories = await deps.repository.getChapterMemories({
    projectId: input.projectId,
    narrativeCutoff: input.narrativeOrder - 1,
    limit: 5,
  });
  const priorChapterDigest = priorMemories.length
    ? priorMemories.map((memory) => `第${memory.narrativeRange.start}章：${memory.summary}`).join("\n")
    : undefined;

  // 2. LLM 结构化提取
  const prompt = buildChapterMemoryPrompt({
    artifact: input.artifact,
    text: input.text,
    priorChapterDigest,
  });
  const system = "你是章节记忆提取 Worker。只输出符合 JSON Schema 的 JSON。只提取正文实际呈现的内容，不提取隐喻、修辞或读者推断。";
  const promptPackage = compileStageContext({ projectId: input.projectId, workflowId: input.workflowRunId ?? input.artifact.taskId, purpose: "facts.extract", stage: "fact-extraction", system, schema: chapterMemorySchema as unknown as Record<string, unknown>, maxInputTokens: 128_000, reservedOutputTokens: 4_096, sections: [{ id: "chapter-memory-fallback", kind: "manuscript", title: "章节记忆回退提取", text: prompt, priority: "critical", provenanceRefs: [input.artifact.id, input.revisionId] }] });

  const generated = await input.model.generateStructured<ChapterMemoryOutput>({
    purpose: "facts.extract",
    system,
    prompt: promptPackage.instruction,
    schema: chapterMemorySchema as unknown as Record<string, unknown>,
    schemaName: "chapter-memory",
    routingSnapshot: input.routingSnapshot,
    candidateStartIndex: input.candidateStartIndex,
    workflowRunId: input.workflowRunId,
    taskId: input.taskId,
    promptContext: promptPackage.manifest,
  });

  const output = generated.value;
  validateChapterMemoryOutput(output);

  return persistChapterMemoryOutput(input, deps, output);
}

/** Persist a chapter-memory projection already produced by ChapterStateDelta. */
export async function persistChapterMemoryOutput(
  input: Omit<CreateChapterMemoryInput, "model" | "routingSnapshot" | "candidateStartIndex" | "workflowRunId" | "taskId">,
  deps: CreateChapterMemoryDeps,
  output: ChapterMemoryOutput,
): Promise<ChapterMemory> {
  validateChapterMemoryOutput(output);

  // 3. 构造 ChapterMemory
  const now = Date.now();
  const fingerprintInput = {
    projectId: input.projectId,
    documentId: input.documentId,
    revisionId: input.revisionId,
    narrativeOrder: input.narrativeOrder,
    summary: output.summary,
    keyEvents: output.keyEvents,
    characterStates: output.characterStates,
    unresolvedThreads: output.unresolvedThreads,
    emotionalArc: output.emotionalArc,
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex");
  const chapterMemory: ChapterMemory = {
    id: `memory:chapter:${input.revisionId}`,
    projectId: input.projectId,
    documentId: input.documentId,
    revisionId: input.revisionId,
    narrativeRange: { start: input.narrativeOrder, end: input.narrativeOrder },
    summary: output.summary,
    keyEvents: output.keyEvents,
    characterStates: output.characterStates,
    unresolvedThreads: output.unresolvedThreads,
    emotionalArc: output.emotionalArc,
    fingerprint,
    createdAt: now,
  };

  // 4. 写入 Postgres
  await deps.repository.createChapterMemory(chapterMemory);
  const rollupClaim = await deps.repository.refreshChapterMemoryRollup(input.projectId, input.narrativeOrder);

  // 5. 同步 Qdrant 向量索引（失败不阻塞，只警告）
  if (deps.memoryIndex) {
    try {
      await deps.memoryIndex.upsertClaims(input.projectId, [chapterMemoryAsClaim(chapterMemory), rollupClaim]);
    } catch (error) {
      // TODO P2: 接入 learning 闭环，把 Qdrant 索引失败作为 RuntimeLearningAssessment 的 symptom
      console.warn(`[chapter-memory] Qdrant 索引失败（不阻塞 Postgres 落库）：${(error as Error).message}`);
    }
  }

  return chapterMemory;
}

/**
 * 校验 LLM 输出符合 chapter memory schema 的基本约束。
 *
 * 与 materializeExternalChapterMemory 共用，避免重复校验逻辑。
 */
export function validateChapterMemoryOutput(output: ChapterMemoryOutput): void {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(chapterMemorySchema);
  if (!validate(output)) {
    throw new Error(`章节记忆提取结果无效：${validate.errors?.map((item) => `${item.instancePath}:${item.message}`).join("；") ?? "未知错误"}`);
  }
}

/**
 * 解析外部 MCP 提交的 chapter memory 结果（与 materializeExternalFacts 对称）。
 *
 * 用于 external-mcp 双路径：当 internal LLM 不可用时，章节记忆提取走 external-mcp，
 * 由外部 worker 调用 createChapterMemoryFromRevision 完成写入。
 */
export function parseChapterMemoryOutput(value: unknown, _input: Omit<CreateChapterMemoryInput, "model">): ChapterMemoryOutput {
  const output = value as ChapterMemoryOutput;
  validateChapterMemoryOutput(output);
  return output;
}

/**
 * 把 ChapterMemory 投影为 MemoryClaim 形态，供 QdrantMemoryProvider.upsertClaims 索引。
 *
 * Qdrant 的 collection 是统一的（novel-memory），通过 payload.kind 区分 claim 类型。
 * chapter memory 作为 MemoryClaim 索引时：
 * - kind=episodic（章节级 episodic memory）
 * - knowledgeScope=author（作者视角的全知摘要，非角色知识边界）
 * - authority=derived（由 LLM 从正文推导，非 author 亲自声明）
 * - narrativeRange.start/end = 章节顺序号
 *
 * 这样在 qdrant-memory.ts 的 search 中，chapter memory 会和细粒度 fact 一起被召回，
 * 上游 buildMemoryBundle 按 authority + score 排序融合。
 */
export function chapterMemoryAsClaim(memory: ChapterMemory) {
  const content = [
    `摘要：${memory.summary}`,
    memory.keyEvents.length ? `关键事件：${memory.keyEvents.join("；")}` : "",
    memory.characterStates.length ? `角色状态：${memory.characterStates.map((state) => `${state.characterId}——${state.stateSnapshot}`).join("；")}` : "",
    memory.unresolvedThreads.length ? `未解线索：${memory.unresolvedThreads.join("；")}` : "",
    memory.emotionalArc ? `情绪弧光：${memory.emotionalArc}` : "",
  ].filter(Boolean).join("\n");
  const contentHash = createHash("sha256").update(`${memory.id}:${content}`).digest("hex");
  return {
    id: memory.id,
    projectId: memory.projectId,
    kind: "episodic" as const,
    title: `第${memory.narrativeRange.start}章记忆`,
    content,
    subjectRefs: memory.characterStates.map((state) => state.characterId),
    narrativeRange: { start: memory.narrativeRange.start, end: memory.narrativeRange.end },
    knowledgeScope: "author" as const,
    authority: "derived" as const,
    confidence: 0.85,
    sourceRevisionIds: [memory.revisionId],
    contentHash,
    supersedes: [] as string[],
  };
}

/**
 * 把 chapter memory upsert 到 Qdrant 索引。
 *
 * 复用 QdrantMemoryProvider.upsertClaims，把 ChapterMemory 投影为 MemoryClaim 形态。
 * 这样在检索时，chapter memory 会作为 episodic memory 被 recall。
 */
