import { callStructuredNovelModel } from "./ai";
import { compileNovelContext } from "./context";
import { invalidateRevisionDependents, novelDb, recordBase, type NovelDatabase } from "./db";
import { splitSemanticUnits, upsertEmbedding, vectorSearch } from "./retrieval";
import { rankLexicalUnits } from "./retrieval-evaluation";
import { CONTEXT_SOURCE_KINDS } from "./types";
import type {
  ConversationMemory,
  CreativeBrief,
  DerivedMemoryContent,
  NovelContextPacket,
  NovelConversationMessage,
  NovelConversationThread,
  NovelMemoryJob,
  NovelAgentRole,
  NovelRetrievalHit,
  NovelRetrievalRun,
  NovelRetrievalRound,
  NovelSkillStage,
  WorkflowStage,
} from "./types";

const MAX_SEARCH_ROUNDS = 3;
const HITS_PER_ROUND = 12;
const MAX_SELECTED_HITS = 20;
const RRF_K = 60;

type RetrievalCandidate = Omit<NovelRetrievalHit, "fusedScore" | "round" | "lexicalRank" | "vectorRank" | "entityRank"> & {
  targetTable?: "architectures" | "entities" | "relations" | "outlineNodes" | "documents" | "plotThreads" | "foreshadowing" | "factAssertions" | "derivedMemories" | "conversationMemories";
  targetId?: string;
  targetChunkIndex?: number;
  aliases: string[];
};

interface ConversationTurnResult extends Record<string, unknown> {
  answer: string;
  enoughEvidence: boolean;
  followUpQueries: string[];
  preferenceMemories: Array<{ title: string; content: string; confidence: number; evidenceQuote: string }>;
  canonicalChangeRequests: Array<{ taskKey: "story-bible" | "characters" | "relations" | "timeline" | "worldview" | "plot-threads" | "foreshadowing"; instruction: string }>;
  briefPatch: {
    goal?: string;
    tone?: string;
    languageRequirements?: string[];
    mustHappen?: string[];
    forbidden?: string[];
    openQuestions?: string[];
  };
}

const TURN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "enoughEvidence", "followUpQueries", "preferenceMemories", "canonicalChangeRequests", "briefPatch"],
  properties: {
    answer: { type: "string" },
    enoughEvidence: { type: "boolean" },
    followUpQueries: { type: "array", maxItems: 3, items: { type: "string" } },
    preferenceMemories: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "content", "confidence", "evidenceQuote"],
        properties: {
          title: { type: "string" },
          content: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          // F-020 修复：evidenceQuote 必须非空，LLM 不能返回空字符串绕过证据契约
          evidenceQuote: { type: "string", minLength: 1 },
        },
      },
    },
    canonicalChangeRequests: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["taskKey", "instruction"],
        properties: {
          taskKey: { enum: ["story-bible", "characters", "relations", "timeline", "worldview", "plot-threads", "foreshadowing"] },
          instruction: { type: "string" },
        },
      },
    },
    briefPatch: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal: { type: "string" },
        tone: { type: "string" },
        languageRequirements: { type: "array", items: { type: "string" } },
        mustHappen: { type: "array", items: { type: "string" } },
        forbidden: { type: "array", items: { type: "string" } },
        openQuestions: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

export interface NovelMemoryService {
  getOrCreateThread(params: { projectId: string; targetDocumentId: string }): Promise<NovelConversationThread>;
  appendMessage(params: { threadId: string; role: NovelConversationMessage["role"]; content: string; retrievalRunId?: string; sourceIds?: string[] }): Promise<NovelConversationMessage>;
  runConversationTurn(params: { threadId: string; content: string }): Promise<{ userMessage: NovelConversationMessage; assistantMessage: NovelConversationMessage; retrievalRun: NovelRetrievalRun; brief: CreativeBrief }>;
  getDraftBrief(threadId: string): Promise<CreativeBrief>;
  updateBrief(briefId: string, patch: Partial<Pick<CreativeBrief, "goal" | "povCharacterId" | "factCutoffOrder" | "tone" | "languageRequirements" | "mustHappen" | "forbidden" | "targetWords" | "referencedMemoryIds" | "openQuestions">>): Promise<CreativeBrief>;
  confirmBrief(briefId: string): Promise<CreativeBrief>;
  approveMemory(memoryId: string): Promise<void>;
  revokeMemory(memoryId: string): Promise<void>;
  setSourceOverride(threadId: string, sourceId: string, mode: "pin" | "exclude" | "clear"): Promise<void>;
  compileStageContext(params: { threadId: string; stage: WorkflowStage; role?: NovelAgentRole; instruction: string; workflowRunId?: string; skillStage?: NovelSkillStage; db?: NovelDatabase }): Promise<NovelContextPacket>;
}

function uniqueStrings(values: string[] | undefined) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function memoryContent(memory: { summary: string; content: DerivedMemoryContent }) {
  return [memory.summary, ...Object.values(memory.content).flatMap((value) => value)].filter(Boolean).join("\n");
}

function rrf(rank?: number) {
  return rank ? 1 / (RRF_K + rank) : 0;
}

function exactEntityRank(query: string, candidate: RetrievalCandidate) {
  const normalized = query.toLowerCase();
  const index = candidate.aliases.findIndex((alias) => alias.length > 1 && normalized.includes(alias.toLowerCase()));
  return index >= 0 ? index + 1 : undefined;
}

async function buildCandidates(params: { projectId: string; targetDocumentId?: string; informationView: "author" | "reader" | "character"; factCutoffOrder?: number; threadId?: string; characterId?: string; db?: NovelDatabase }) {
  const { projectId, targetDocumentId, informationView } = params;
  const db = params.db ?? novelDb;
  const [target, architecture, entities, relations, outline, documents, threads, clues, facts, knowledge, memories, conversationMemories] = await Promise.all([
    targetDocumentId ? db.documents.get(targetDocumentId) : Promise.resolve(undefined),
    db.architectures.where("projectId").equals(projectId).first(),
    db.entities.where("projectId").equals(projectId).toArray(),
    db.relations.where("projectId").equals(projectId).toArray(),
    db.outlineNodes.where("projectId").equals(projectId).toArray(),
    db.documents.where("projectId").equals(projectId).toArray(),
    db.plotThreads.where("projectId").equals(projectId).toArray(),
    db.foreshadowing.where("projectId").equals(projectId).toArray(),
    db.factAssertions.where("projectId").equals(projectId).and((item) => item.status === "active").toArray(),
    informationView === "character" && params.characterId
      ? db.knowledgeAssertions.where("projectId").equals(projectId).and((item) => item.status === "active" && item.characterId === params.characterId).toArray()
      : Promise.resolve([]),
    db.derivedMemories.where("projectId").equals(projectId).and((item) => item.status === "active" || item.status === "cold").toArray(),
    db.conversationMemories.where("projectId").equals(projectId).and((item) => item.status === "active" && (
      item.scope === "project"
       || (item.scope === "target" && Boolean(targetDocumentId) && item.targetId === targetDocumentId)
      || (item.scope === "task" && (item.scopeKey === `task:chapter-workflow:${targetDocumentId}` || item.scopeKey === `thread:${params.threadId}`))
    )).toArray(),
  ]);
  if (targetDocumentId && !target) throw new Error("目标章节不存在");
  const cutoff = params.factCutoffOrder ?? (target ? target.order - 1 : Number.POSITIVE_INFINITY);
  const candidates: RetrievalCandidate[] = [];
  if (informationView === "author" && architecture) {
    const phases = [...architecture.phases].sort((a, b) => a.order - b.order);
    candidates.push({
      sourceId: architecture.id,
      targetTable: "architectures",
      targetId: architecture.id,
      kind: "architecture",
      title: architecture.status === "approved" ? "已批准全书架构" : "全书架构草案",
      content: [
        `核心问题：${architecture.centralQuestion}`,
        `核心冲突：${architecture.centralConflict}`,
        `全书梗概：${architecture.synopsis}`,
        ...phases.map((phase) => `${phase.order + 1}. ${phase.title}：${phase.purpose}；转折：${phase.turningPoint}`),
      ].join("\n"),
      reason: "全书架构定义当前剧情阶段和未来创作方向",
      authority: architecture.status === "approved" ? "approved" : "working",
      evidenceRefs: [architecture.id],
      aliases: [architecture.centralQuestion, architecture.centralConflict, ...phases.map((phase) => phase.title)],
    });
  }
  for (const entity of entities) {
    const content = informationView === "author"
      ? [entity.summary, entity.description, ...entity.lockedFacts, entity.character ? JSON.stringify(entity.character) : ""].filter(Boolean).join("\n")
      : [entity.summary, entity.description].filter(Boolean).join("\n");
    candidates.push({ sourceId: entity.id, targetTable: "entities", targetId: entity.id, kind: "entity", title: `${entity.kind}：${entity.name}`, content, reason: "项目实体与当前问题相关", authority: entity.lockedFacts.length ? "approved" : "working", evidenceRefs: [entity.id], aliases: [entity.name, ...entity.aliases] });
  }
  if (informationView === "author") {
    const entityNames = new Map(entities.map((entity) => [entity.id, entity.name]));
    for (const relation of relations) {
      const from = entityNames.get(relation.fromEntityId) ?? "未知实体";
      const to = entityNames.get(relation.toEntityId) ?? "未知实体";
      candidates.push({
        sourceId: relation.id,
        targetTable: "relations",
        targetId: relation.id,
        kind: "relation",
        title: `${from} → ${to}`,
        content: `${relation.relationType}\n表面：${relation.publicLabel}\n真相：${relation.privateTruth}\n纽带：${relation.bond}`,
        reason: "已有对象关系约束后续剧情互动",
        authority: "working",
        evidenceRefs: [relation.id],
        aliases: [from, to, relation.relationType, relation.publicLabel],
      });
    }
  }
  if (informationView === "author") {
    for (const node of outline) candidates.push({ sourceId: node.id, targetTable: "outlineNodes", targetId: node.id, kind: "outline", title: `剧情段：${node.title}`, content: `所属幕：${node.phaseId}\n${node.summary}`, reason: "作者视角中的创作契约", authority: "working", evidenceRefs: [node.id], aliases: [node.title] });
  }
  for (const document of documents.filter((item) => item.id !== targetDocumentId && item.order <= cutoff && (params.factCutoffOrder === undefined || Boolean(item.approvedRevisionId)))) {
    const planning = [
      document.plotSegmentId ? `所属剧情段：${document.plotSegmentId}` : "所属剧情段：待整理",
      `章节目标：${document.blueprint.objective || "暂无"}`,
      `冲突：${document.blueprint.conflict || "暂无"}`,
      `角色：${document.blueprint.characterIds.join("、") || "未设置"}`,
      `剧情线：${(document.blueprint.plotThreadIds ?? []).join("、") || "未设置"}`,
      `伏笔：${(document.blueprint.foreshadowingIds ?? []).join("、") || "未设置"}`,
    ].join("\n");
    const units = splitSemanticUnits([document.title, document.summary, planning, document.plainText].filter(Boolean).join("\n"));
    units.forEach((content, chunkIndex) => candidates.push({ sourceId: units.length === 1 ? document.id : `${document.id}:chunk:${chunkIndex}`, targetTable: "documents", targetId: document.id, targetChunkIndex: units.length === 1 ? undefined : chunkIndex, kind: "document", title: units.length === 1 ? `章节：${document.title}` : `章节：${document.title} · 语义单元 ${chunkIndex + 1}`, content, reason: "历史已批准章节中的完整语义单元", authority: document.approvedRevisionId ? "approved" : "working", narrativeOrder: document.order, evidenceRefs: [document.approvedRevisionId ?? document.id], aliases: [document.title] }));
  }
  for (const thread of threads.filter((item) => item.status === "active" || item.status === "planned")) candidates.push({ sourceId: thread.id, targetTable: "plotThreads", targetId: thread.id, kind: "thread", title: `剧情线：${thread.title}`, content: `${thread.summary}\n下一步：${thread.nextMove}`, reason: "活跃剧情线", authority: "working", evidenceRefs: [thread.id], aliases: [thread.title] });
  for (const clue of clues.filter((item) => !["resolved", "abandoned"].includes(item.status))) candidates.push({ sourceId: clue.id, targetTable: "foreshadowing", targetId: clue.id, kind: "foreshadowing", title: `伏笔：${clue.title}`, content: informationView === "author" ? `${clue.clue}\n真相：${clue.truth}` : clue.clue, reason: "尚未回收的伏笔", authority: "working", evidenceRefs: [clue.id], aliases: [clue.title] });
  const visibleFacts = informationView === "character"
    ? []
    : facts.filter((item) => informationView === "author" && params.factCutoffOrder === undefined
      || (item.revealedAt?.narrativeOrder ?? Number.POSITIVE_INFINITY) <= cutoff);
  for (const fact of visibleFacts) candidates.push({ sourceId: fact.id, targetTable: "factAssertions", targetId: fact.id, kind: "fact", title: `正式资料：${fact.humanReadable}`, content: `${fact.humanReadable}\n证据：${fact.evidence}`, reason: "当前信息视角和事实截止点允许读取的正式事实", authority: "approved", narrativeOrder: fact.revealedAt?.narrativeOrder, evidenceRefs: [fact.sourceRevisionId], aliases: [fact.humanReadable] });
  if (informationView === "character" && params.characterId) {
    const factById = new Map(facts.map((fact) => [fact.id, fact]));
    const documentOrder = new Map(documents.map((document) => [document.id, document.order]));
    for (const item of knowledge) {
      const learnedOrder = item.learnedAt?.narrativeOrder
        ?? (item.learnedAt?.chapterId ? documentOrder.get(item.learnedAt.chapterId) : undefined);
      if (learnedOrder === undefined || learnedOrder > cutoff) continue;
      const fact = factById.get(item.factAssertionId);
      if (!fact) continue;
      candidates.push({
        sourceId: item.id,
        targetTable: "factAssertions",
        targetId: fact.id,
        kind: "knowledge",
        title: `角色认知：${fact.humanReadable}`,
        content: `认知状态：${item.stance}\n${fact.humanReadable}\n证据：${fact.evidence}`,
        reason: "当前 POV 角色在事实截止点前形成的认知",
        authority: "approved",
        narrativeOrder: learnedOrder,
        evidenceRefs: [item.sourceRevisionId, fact.sourceRevisionId],
        aliases: [fact.humanReadable],
      });
    }
  }
  for (const memory of memories.filter((item) => informationView === "author" && params.factCutoffOrder === undefined || (item.coverage.endOrder ?? Number.POSITIVE_INFINITY) <= cutoff)) candidates.push({ sourceId: memory.id, targetTable: "derivedMemories", targetId: memory.id, kind: "memory", title: `${memory.level}记忆：${memory.summary.slice(0, 50)}`, content: memoryContent(memory), reason: memory.status === "cold" ? "冷记忆被检索召回" : "活跃派生记忆", authority: "derived", narrativeOrder: memory.coverage.endOrder, evidenceRefs: [memory.sourceRevisionId, ...memory.sourceMemoryIds].filter((id): id is string => Boolean(id)), aliases: [memory.summary] });
  for (const memory of conversationMemories) candidates.push({ sourceId: memory.id, targetTable: "conversationMemories", targetId: memory.id, kind: "conversation-memory", title: memory.title, content: memory.content, reason: "作者历史对话中提炼的有效记忆", authority: "author", evidenceRefs: memory.sourceMessageIds, aliases: [memory.title] });
  return candidates.filter((candidate) => candidate.content.trim());
}

async function hybridRetrieve(params: { projectId: string; targetDocumentId?: string; informationView: "author" | "reader" | "character"; query: string; round: number; excludedIds: Set<string>; factCutoffOrder?: number; threadId?: string; characterId?: string; allowedKinds?: Set<NovelRetrievalHit["kind"]>; db?: NovelDatabase }) {
  const candidates = (await buildCandidates(params)).filter((candidate) => !params.excludedIds.has(candidate.sourceId) && (!params.allowedKinds || params.allowedKinds.has(candidate.kind)));
  if (!candidates.length) return [];
  const lexicalRanks = new Map(rankLexicalUnits(params.query, candidates.map((candidate) => ({ id: candidate.sourceId, title: candidate.title, content: candidate.content, aliases: candidate.aliases }))).map((id, index) => [id, index + 1]));
  const vectorRanks = new Map<string, number>();
  await vectorSearch({ projectId: params.projectId, query: params.query, topK: 30, db: params.db }).then((results) => results.forEach((item, index) => vectorRanks.set(`${item.targetId}:${item.chunkIndex ?? "root"}`, index + 1))).catch(() => undefined);
  const scored = candidates.map((candidate) => {
    const lexicalRank = lexicalRanks.get(candidate.sourceId);
    const vectorRank = vectorRanks.get(`${candidate.targetId ?? candidate.sourceId}:${candidate.targetChunkIndex ?? "root"}`);
    const entityRank = exactEntityRank(params.query, candidate);
    const hasRetrievalSignal = Boolean(lexicalRank || vectorRank || entityRank);
    const authorityBoost = hasRetrievalSignal && (candidate.authority === "approved" || candidate.authority === "author") ? 0.01 : 0;
    const fusedScore = rrf(lexicalRank) + rrf(vectorRank) + rrf(entityRank) + authorityBoost;
    return { ...candidate, lexicalRank, vectorRank, entityRank, fusedScore, round: params.round } satisfies NovelRetrievalHit & { aliases: string[] };
  }).filter((item) => item.fusedScore > 0).sort((a, b) => b.fusedScore - a.fusedScore).slice(0, HITS_PER_ROUND);
  return scored.map(({ aliases: _aliases, targetTable: _targetTable, targetId: _targetId, targetChunkIndex: _targetChunkIndex, ...hit }) => hit);
}

interface TaskEvidenceAssessment extends Record<string, unknown> {
  state: "ready" | "need-more" | "blocked";
  requests: Array<{ query: string; sourceKinds: NovelRetrievalHit["kind"][]; reason: string }>;
  missingFacts: string[];
  creativeGaps: string[];
}

const TASK_EVIDENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["state", "requests", "missingFacts", "creativeGaps"],
  properties: {
    state: { enum: ["ready", "need-more", "blocked"] },
    requests: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["query", "sourceKinds", "reason"], properties: { query: { type: "string" }, sourceKinds: { type: "array", items: { enum: CONTEXT_SOURCE_KINDS } }, reason: { type: "string" } } } },
    missingFacts: { type: "array", items: { type: "string" } },
    creativeGaps: { type: "array", items: { type: "string" } },
  },
} as const;

export interface TaskEvidenceResult {
  run: NovelRetrievalRun;
  selectedHits: NovelRetrievalHit[];
  missingFacts: string[];
  creativeGaps: string[];
}

export async function resolveTaskEvidence(params: {
  projectId: string;
  target: { kind: "document" | "architecture-phase" | "project"; id?: string };
  task: string;
  query: string;
  model: string;
  role: NovelAgentRole;
  allowedSourceKinds?: NovelRetrievalHit["kind"][];
  gapPolicy?: "strict" | "creative-by-default";
  maxRounds?: number;
  signal?: AbortSignal;
}): Promise<TaskEvidenceResult> {
  const run: NovelRetrievalRun = {
    ...recordBase(params.projectId),
    targetKind: params.target.kind,
    targetId: params.target.id,
    targetDocumentId: params.target.kind === "document" ? params.target.id : undefined,
    informationView: "author",
    purpose: "task-evidence",
    consumer: { role: params.role },
    queries: [],
    rounds: [],
    hits: [],
    selectedSourceIds: [],
    pinnedSourceIds: [],
    excludedSourceIds: [],
    status: "running",
  };
  await novelDb.retrievalRuns.add(run);
  const hitMap = new Map<string, NovelRetrievalHit>();
  const rounds: NovelRetrievalRound[] = [];
  let queries = [params.query.trim() || params.task];
  let assessment: TaskEvidenceAssessment = { state: "need-more", requests: [], missingFacts: [], creativeGaps: [] };
  const maxRounds = Math.max(1, Math.min(params.maxRounds ?? MAX_SEARCH_ROUNDS, MAX_SEARCH_ROUNDS));
  const allowedKinds = params.allowedSourceKinds?.length ? new Set(params.allowedSourceKinds) : undefined;
  const requestableKinds = params.allowedSourceKinds?.length ? params.allowedSourceKinds : CONTEXT_SOURCE_KINDS;
  const creativeByDefault = params.gapPolicy === "creative-by-default";
  let roundKinds = allowedKinds;
  try {
    for (let round = 1; round <= maxRounds && queries.length; round += 1) {
      const query = uniqueStrings(queries).join("；");
      const hits = await hybridRetrieve({ projectId: params.projectId, targetDocumentId: params.target.kind === "document" ? params.target.id : undefined, informationView: "author", query, round, excludedIds: new Set(), allowedKinds: roundKinds });
      const previousHitCount = hitMap.size;
      for (const hit of hits) if (!hitMap.has(hit.sourceId)) hitMap.set(hit.sourceId, hit);
      const selected = [...hitMap.values()].sort((a, b) => b.fusedScore - a.fusedScore).slice(0, MAX_SELECTED_HITS);
      const rawAssessment = (await callStructuredNovelModel<TaskEvidenceAssessment>({
        model: params.model,
        temperature: 0.1,
        role: params.role,
        schema: TASK_EVIDENCE_SCHEMA,
        signal: params.signal,
        prompt: `你正在为“${params.task}”检查项目证据是否充分。只能根据当前证据判断：已存在的正式事实、连续性状态或作者约束缺失时，写入 missingFacts；尚未设计、可以在本次任务中新建的内容写入 creativeGaps。需要继续检索时 state=need-more，并用 requests 返回精确查询。sourceKinds 只能使用以下规范值：${requestableKinds.join("、")}。${creativeByDefault ? "这是小说构造任务：检索不到的背景、经历、关系和事件细节都属于可设计空白，不得因此 blocked；只需避免与累计证据冲突。" : "事实缺口在检索耗尽后必须 state=blocked，禁止用创作填补。"}\n\n任务查询：\n${params.query || "根据现有上下文自然续写"}\n\n累计证据：\n${formatEvidence(selected) || "没有命中资料"}`,
      })).data;
      assessment = creativeByDefault
        ? {
            ...rawAssessment,
            state: rawAssessment.state === "blocked" ? "ready" : rawAssessment.state,
            missingFacts: [],
            creativeGaps: uniqueStrings([...rawAssessment.creativeGaps, ...rawAssessment.missingFacts]),
          }
        : rawAssessment;
      rounds.push({ index: round, query, hitIds: hits.map((hit) => hit.sourceId), selectedIds: selected.map((hit) => hit.sourceId), enoughEvidence: assessment.state === "ready" });
      if (assessment.state === "ready" || assessment.state === "blocked" || !assessment.requests.length) break;
      if (round > 1 && hitMap.size === previousHitCount) break;
      queries = assessment.requests.map((request) => request.query);
      const requestedKinds = new Set(assessment.requests.flatMap((request) => request.sourceKinds));
      roundKinds = requestedKinds.size
        ? new Set([...requestedKinds].filter((kind) => !allowedKinds || allowedKinds.has(kind)))
        : allowedKinds;
    }
    const selectedHits = [...hitMap.values()].sort((a, b) => b.fusedScore - a.fusedScore).slice(0, MAX_SELECTED_HITS);
    const completed = { ...run, queries: rounds.map((round) => round.query), rounds, hits: [...hitMap.values()], selectedSourceIds: selectedHits.map((hit) => hit.sourceId), status: "completed" as const, revision: run.revision + 1, updatedAt: Date.now() };
    await novelDb.retrievalRuns.put(completed);
    return { run: completed, selectedHits, missingFacts: uniqueStrings(assessment.missingFacts), creativeGaps: uniqueStrings(assessment.creativeGaps) };
  } catch (error) {
    await novelDb.retrievalRuns.update(run.id, { status: "failed", error: error instanceof Error ? error.message : String(error), rounds, hits: [...hitMap.values()], revision: run.revision + 1, updatedAt: Date.now() });
    throw error;
  }
}

function formatEvidence(hits: NovelRetrievalHit[]) {
  return hits.map((hit, index) => `【M${index + 1}｜${hit.title}】\n${hit.content}\n来源：${hit.evidenceRefs.join("、") || hit.sourceId}`).join("\n\n");
}

const MEMORY_EXTRACTOR_VERSION = "explicit-author-evidence-v1";

async function savePreferenceMemory(params: { thread: NovelConversationThread; messageId: string; authorContent: string; title: string; content: string; confidence: number; evidenceQuote?: string }) {
  const normalized = params.content.trim();
  if (!normalized) return;
  // F-020 修复：evidenceQuote 是"逐字复制本轮原话"的契约要求，不允许为空。
  // 原实现 quote 为空时 evidenceQuotes 存储为 []，违反"必须带证据"契约，且未利用 authorContent 校验逐字匹配。
  // 空证据直接跳过创建——无证据的偏好不应被存储。
  const quote = params.evidenceQuote?.trim() ?? "";
  if (!quote) return;
  const status: ConversationMemory["status"] = "pending";
  const existing = await novelDb.conversationMemories.where("projectId").equals(params.thread.projectId).and((memory) => ["active", "pending"].includes(memory.status) && memory.kind === "preference").toArray();
  const duplicate = existing.find((memory) => memory.content.trim() === normalized && memory.status === status);
  if (duplicate) return duplicate;
  const memory: ConversationMemory = {
    ...recordBase(params.thread.projectId), threadId: params.thread.id, targetId: params.thread.targetId, scope: "project", scopeKey: `project:${params.thread.projectId}`,
    kind: "preference", title: params.title.trim() || "作者偏好", content: normalized, status, confidence: Math.max(0, Math.min(1, params.confidence)),
    sourceMessageIds: [params.messageId], evidenceQuotes: [quote], extractorVersion: MEMORY_EXTRACTOR_VERSION,
    autoApplied: false,
  };
  await novelDb.conversationMemories.add(memory);
  await scheduleMemoryJob({ projectId: params.thread.projectId, jobType: "embedding", idempotencyKey: `embedding:conversationMemories:${memory.id}:${memory.revision}`, payload: { targetTable: "conversationMemories", targetId: memory.id, content: `${memory.title}\n${memory.content}` } });
  return memory;
}

export async function scheduleMemoryJob(params: Pick<NovelMemoryJob, "projectId" | "jobType" | "idempotencyKey" | "payload">, db: NovelDatabase = novelDb) {
  return db.transaction("rw", db.memoryJobs, async () => {
    const existing = await db.memoryJobs.where("idempotencyKey").equals(params.idempotencyKey).first();
    if (existing) return existing;
    const job: NovelMemoryJob = { ...recordBase(params.projectId), jobType: params.jobType, idempotencyKey: params.idempotencyKey, payload: params.payload, status: "pending", attempts: 0, availableAt: Date.now() };
    await db.memoryJobs.add(job);
    return job;
  });
}

export async function runPendingMemoryJobs(projectId: string) {
  const workerId = crypto.randomUUID();
  while (true) {
    const now = Date.now();
    await novelDb.memoryJobs.where("projectId").equals(projectId).and((job) => job.status === "running" && Boolean(job.leaseExpiresAt && job.leaseExpiresAt <= now)).modify({ status: "pending", leaseOwner: undefined, leaseExpiresAt: undefined, availableAt: now, updatedAt: now });
    const jobs = await novelDb.memoryJobs.where("projectId").equals(projectId).and((job) => job.status === "pending" && job.availableAt <= now).toArray();
    if (!jobs.length) return;
    for (const job of jobs) {
      const claimed = await novelDb.transaction("rw", novelDb.memoryJobs, async () => {
        const current = await novelDb.memoryJobs.get(job.id);
        if (!current || current.status !== "pending" || current.availableAt > Date.now()) return false;
        await novelDb.memoryJobs.update(job.id, { status: "running", attempts: current.attempts + 1, leaseOwner: workerId, leaseExpiresAt: Date.now() + 60_000, updatedAt: Date.now() });
        return true;
      });
      if (!claimed) continue;
      try {
        if (job.jobType === "embedding") {
          const payload = job.payload as { targetTable: Parameters<typeof upsertEmbedding>[0]["targetTable"]; targetId: string; content: string };
          await upsertEmbedding({ projectId, ...payload });
        } else if (job.jobType === "memory-invalidation") {
          const payload = job.payload as { sourceRevisionIds?: string[]; reason?: string };
          if (!payload.sourceRevisionIds?.length) throw new Error("记忆失效任务缺少 sourceRevisionIds");
          await invalidateRevisionDependents(projectId, payload.sourceRevisionIds, payload.reason);
        } else if (job.jobType === "memory-consolidation") {
          const payload = job.payload as Parameters<(typeof import("./memory"))["consolidateDerivedMemory"]>[0];
          const { consolidateDerivedMemory } = await import("./memory");
          await consolidateDerivedMemory({ ...payload, projectId });
        } else if (job.jobType === "memory-extraction") {
          const payload = job.payload as { threadId?: string; messageId?: string; title?: string; content?: string; confidence?: number; evidenceQuote?: string };
          const [thread, message] = await Promise.all([payload.threadId ? novelDb.conversationThreads.get(payload.threadId) : undefined, payload.messageId ? novelDb.conversationMessages.get(payload.messageId) : undefined]);
          if (!thread || !message || message.role !== "user" || !payload.title || !payload.content) throw new Error("记忆提炼任务来源无效");
          // F-020 修复：memory-extraction 任务必须带非空 evidenceQuote，否则抛错触发重试。
          // 契约要求"必须带 evidenceQuote（逐字复制本轮原话）"，空证据不应被静默跳过。
          if (!payload.evidenceQuote?.trim()) throw new Error("记忆提炼任务缺少证据引用");
          await savePreferenceMemory({ thread, messageId: message.id, authorContent: message.content, title: payload.title, content: payload.content, confidence: payload.confidence ?? 0, evidenceQuote: payload.evidenceQuote });
        } else {
          const exhaustive: never = job.jobType;
          throw new Error(`不支持的记忆任务：${exhaustive}`);
        }
        await novelDb.memoryJobs.update(job.id, { status: "completed", completedAt: Date.now(), updatedAt: Date.now(), lastError: undefined, leaseOwner: undefined, leaseExpiresAt: undefined });
      } catch (error) {
        const attempts = job.attempts + 1;
        await novelDb.memoryJobs.update(job.id, { status: attempts >= 3 ? "failed" : "pending", attempts, availableAt: Date.now() + 2 ** attempts * 1000, lastError: error instanceof Error ? error.message : String(error), updatedAt: Date.now(), leaseOwner: undefined, leaseExpiresAt: undefined });
      }
    }
  }
}

export function startMemoryJobWorker(projectId: string, intervalMs = 1_000) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delay = Math.max(50, intervalMs);
  const tick = async () => {
    try {
      await runPendingMemoryJobs(projectId);
    } catch {
      // The next poll retries database-level failures without breaking the worker loop.
    } finally {
      if (!stopped) timer = setTimeout(tick, delay);
    }
  };
  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

const STAGE_RETRIEVAL_KINDS: Partial<Record<NovelAgentRole, Set<NovelRetrievalHit["kind"]>>> = {
  "style-reviewer": new Set(["conversation-memory", "memory"]),
  "character-reviewer": new Set(["entity", "fact", "memory"]),
  "continuity-reviewer": new Set(["entity", "fact", "memory", "document", "thread", "foreshadowing"]),
  "plot-reviewer": new Set(["outline", "memory", "document", "thread", "foreshadowing"]),
  "fact-extractor": new Set(["fact"]),
  "character-enricher": new Set(["entity", "fact"]),
};

async function runStageRetrieval(params: { thread: NovelConversationThread; brief: CreativeBrief; stage: WorkflowStage; role?: NovelAgentRole; instruction: string; workflowRunId?: string; db?: NovelDatabase }) {
  const db = params.db ?? novelDb;
  const [document, povEntity] = await Promise.all([
    db.documents.get(params.thread.targetId),
    params.brief.povCharacterId ? db.entities.get(params.brief.povCharacterId) : undefined,
  ]);
  if (!document) throw new Error("目标章节不存在");
  const informationView = params.stage === "draft" && params.brief.povCharacterId ? "character" as const : "author" as const;
  const query = uniqueStrings([
    params.instruction,
    params.role ?? "",
    params.brief.goal,
    params.brief.tone,
    povEntity?.name ?? "",
    ...(povEntity?.aliases ?? []),
    ...params.brief.languageRequirements,
    ...params.brief.mustHappen,
    ...params.brief.forbidden,
    document.title,
    document.summary,
    params.stage === "fact-extraction" ? document.plainText.slice(-6000) : "",
  ]).join("；");
  const hits = await hybridRetrieve({
    projectId: params.thread.projectId,
    targetDocumentId: params.thread.targetId,
    informationView,
    query,
    round: 1,
    excludedIds: new Set(params.thread.excludedSourceIds),
    factCutoffOrder: params.brief.factCutoffOrder,
    threadId: params.thread.id,
    characterId: informationView === "character" ? params.brief.povCharacterId : undefined,
    allowedKinds: params.role ? STAGE_RETRIEVAL_KINDS[params.role] : undefined,
    db: params.db,
  });
  const selected = new Map<string, NovelRetrievalHit>(hits.map((hit) => [hit.sourceId, hit]));
  const candidates = await buildCandidates({ projectId: params.thread.projectId, targetDocumentId: params.thread.targetId, informationView, factCutoffOrder: params.brief.factCutoffOrder, threadId: params.thread.id, characterId: informationView === "character" ? params.brief.povCharacterId : undefined, db: params.db });
  for (const pinnedId of params.thread.pinnedSourceIds) {
    const pinned = candidates.find((candidate) => candidate.sourceId === pinnedId && (!params.role || !STAGE_RETRIEVAL_KINDS[params.role] || STAGE_RETRIEVAL_KINDS[params.role]!.has(candidate.kind)));
    if (pinned) selected.set(pinnedId, { ...pinned, fusedScore: 1, round: 1 });
  }
  const selectedHits = [...selected.values()].sort((a, b) => b.fusedScore - a.fusedScore).slice(0, MAX_SELECTED_HITS);
  const run: NovelRetrievalRun = {
    ...recordBase(params.thread.projectId), threadId: params.thread.id, targetDocumentId: params.thread.targetId, informationView,
    purpose: "workflow-stage", factCutoffOrder: params.brief.factCutoffOrder,
    consumer: { workflowRunId: params.workflowRunId, stage: params.stage, role: params.role },
    queries: [query], rounds: [{ index: 1, query, hitIds: hits.map((hit) => hit.sourceId), selectedIds: selectedHits.map((hit) => hit.sourceId), enoughEvidence: selectedHits.length > 0 }],
    hits: [...selected.values()], selectedSourceIds: selectedHits.map((hit) => hit.sourceId), pinnedSourceIds: [...params.thread.pinnedSourceIds], excludedSourceIds: [...params.thread.excludedSourceIds], status: "completed",
  };
  await db.retrievalRuns.add(run);
  return { run, selectedHits };
}

export class DexieNovelMemoryService implements NovelMemoryService {
  async getOrCreateThread(params: { projectId: string; targetDocumentId: string }) {
    return novelDb.transaction("rw", novelDb.conversationThreads, novelDb.documents, async () => {
      const existing = await novelDb.conversationThreads.where("[projectId+targetId]").equals([params.projectId, params.targetDocumentId]).and((thread) => thread.taskKey === "chapter-workflow" && thread.status === "active").first();
      if (existing) return existing;
      const document = await novelDb.documents.get(params.targetDocumentId);
      if (!document || document.projectId !== params.projectId) throw new Error("目标章节不存在");
      const thread: NovelConversationThread = { ...recordBase(params.projectId), taskKey: "chapter-workflow", targetId: document.id, title: `${document.title} · 创作协作`, summary: "", status: "active", pinnedSourceIds: [], excludedSourceIds: [], lastMessageAt: Date.now() };
      await novelDb.conversationThreads.add(thread);
      return thread;
    });
  }

  async appendMessage(params: { threadId: string; role: NovelConversationMessage["role"]; content: string; retrievalRunId?: string; sourceIds?: string[] }) {
    const thread = await novelDb.conversationThreads.get(params.threadId);
    if (!thread) throw new Error("协作对话不存在");
    const message: NovelConversationMessage = { ...recordBase(thread.projectId), threadId: thread.id, role: params.role, content: params.content.trim(), retrievalRunId: params.retrievalRunId, sourceIds: params.sourceIds ?? [] };
    await novelDb.transaction("rw", novelDb.conversationMessages, novelDb.conversationThreads, async () => {
      await novelDb.conversationMessages.add(message);
      await novelDb.conversationThreads.update(thread.id, { lastMessageAt: message.createdAt, updatedAt: message.createdAt, revision: thread.revision + 1 });
    });
    return message;
  }

  async getDraftBrief(threadId: string) {
    const thread = await novelDb.conversationThreads.get(threadId);
    if (!thread) throw new Error("协作对话不存在");
    const current = (await novelDb.creativeBriefs.where("threadId").equals(threadId).reverse().sortBy("updatedAt")).find((brief) => brief.status !== "superseded");
    if (current) return current;
    const document = await novelDb.documents.get(thread.targetId);
    if (!document) throw new Error("目标章节不存在");
    const brief: CreativeBrief = {
      ...recordBase(thread.projectId), threadId, targetDocumentId: document.id, status: "draft", goal: document.blueprint.objective || "完成本章正文",
      povCharacterId: document.blueprint.povCharacterId, factCutoffOrder: document.order - 1, tone: "", languageRequirements: [],
      mustHappen: [...document.blueprint.mustHappen], forbidden: [...document.blueprint.forbidden], targetWords: document.blueprint.targetWords,
      referencedMemoryIds: [], openQuestions: [], sourceMessageIds: [],
    };
    await novelDb.creativeBriefs.add(brief);
    return brief;
  }

  async updateBrief(briefId: string, patch: Partial<Pick<CreativeBrief, "goal" | "povCharacterId" | "factCutoffOrder" | "tone" | "languageRequirements" | "mustHappen" | "forbidden" | "targetWords" | "referencedMemoryIds" | "openQuestions">>) {
    const current = await novelDb.creativeBriefs.get(briefId);
    if (!current) throw new Error("创作简报不存在");
    let target = current;
    if (current.status === "confirmed") {
      const now = Date.now();
      target = { ...current, ...recordBase(current.projectId), status: "draft", confirmedAt: undefined, sourceMessageIds: [...current.sourceMessageIds] };
      await novelDb.transaction("rw", novelDb.creativeBriefs, async () => {
        await novelDb.creativeBriefs.update(current.id, { status: "superseded", revision: current.revision + 1, updatedAt: now });
        await novelDb.creativeBriefs.add(target);
      });
    }
    const next = { ...target, ...patch, languageRequirements: patch.languageRequirements ? uniqueStrings(patch.languageRequirements) : target.languageRequirements, mustHappen: patch.mustHappen ? uniqueStrings(patch.mustHappen) : target.mustHappen, forbidden: patch.forbidden ? uniqueStrings(patch.forbidden) : target.forbidden, openQuestions: patch.openQuestions ? uniqueStrings(patch.openQuestions) : target.openQuestions, revision: target.revision + 1, updatedAt: Date.now() };
    await novelDb.creativeBriefs.put(next);
    return next;
  }

  async confirmBrief(briefId: string) {
    const brief = await novelDb.creativeBriefs.get(briefId);
    if (!brief) throw new Error("创作简报不存在");
    if (!brief.goal.trim()) throw new Error("创作目标不能为空");
    if (brief.openQuestions.length) throw new Error("请先处理创作简报中的未决问题");
    const confirmed = { ...brief, status: "confirmed" as const, confirmedAt: Date.now(), revision: brief.revision + 1, updatedAt: Date.now() };
    await novelDb.creativeBriefs.put(confirmed);
    return confirmed;
  }

  async runConversationTurn(params: { threadId: string; content: string }) {
    const thread = await novelDb.conversationThreads.get(params.threadId);
    if (!thread) throw new Error("协作对话不存在");
    const project = await novelDb.projects.get(thread.projectId);
    if (!project) throw new Error("项目不存在");
    const userMessage = await this.appendMessage({ threadId: thread.id, role: "user", content: params.content });
    const [history, currentBrief] = await Promise.all([
      novelDb.conversationMessages.where("threadId").equals(thread.id).sortBy("createdAt"),
      this.getDraftBrief(thread.id),
    ]);
    const recentHistory = history.slice(-12).map((message) => `${message.role === "user" ? "作者" : "协作编辑"}：${message.content}`).join("\n");
    const briefState = [`目标：${currentBrief.goal}`, `基调：${currentBrief.tone || "未单独指定"}`, `必写：${currentBrief.mustHappen.join("；") || "无"}`, `禁写：${currentBrief.forbidden.join("；") || "无"}`, `未决：${currentBrief.openQuestions.join("；") || "无"}`].join("\n");
    const retrievalRun: NovelRetrievalRun = { ...recordBase(thread.projectId), threadId: thread.id, messageId: userMessage.id, targetDocumentId: thread.targetId, informationView: "author", purpose: "conversation", queries: [], rounds: [], hits: [], selectedSourceIds: [], pinnedSourceIds: [...thread.pinnedSourceIds], excludedSourceIds: [...thread.excludedSourceIds], status: "running" };
    await novelDb.retrievalRuns.add(retrievalRun);
    const hitMap = new Map<string, NovelRetrievalHit>();
    const rounds: NovelRetrievalRound[] = [];
    let queries = [params.content.trim()];
    let turn: ConversationTurnResult | undefined;
    try {
      for (let round = 1; round <= MAX_SEARCH_ROUNDS && queries.length; round += 1) {
        const query = queries.join("；");
        const hits = await hybridRetrieve({ projectId: thread.projectId, targetDocumentId: thread.targetId, informationView: "author", query, round, excludedIds: new Set(thread.excludedSourceIds), threadId: thread.id });
        const previousHitCount = hitMap.size;
        for (const hit of hits) if (!hitMap.has(hit.sourceId)) hitMap.set(hit.sourceId, hit);
        for (const pinnedId of thread.pinnedSourceIds) {
          const pinned = (await buildCandidates({ projectId: thread.projectId, targetDocumentId: thread.targetId, informationView: "author", threadId: thread.id })).find((candidate) => candidate.sourceId === pinnedId);
          if (pinned && !hitMap.has(pinnedId)) hitMap.set(pinnedId, { ...pinned, fusedScore: 1, round });
        }
        const selected = [...hitMap.values()].sort((a, b) => b.fusedScore - a.fusedScore).slice(0, MAX_SELECTED_HITS);
        turn = (await callStructuredNovelModel<ConversationTurnResult>({
          model: project.settings.textModel, temperature: 0.35, role: "conversation-assistant", schema: TURN_SCHEMA,
          prompt: `作者正在为章节执行创作协作。只依据作者原话、当前简报和检索证据回答。若证据不足，followUpQueries 给出下一轮搜索词；不得要求作者重复已经提供的信息。preferenceMemories 只能提炼作者明确表达的长期文风或工作方式偏好，不能包含故事事实、章节情节或助手建议；每项 evidenceQuote 必须逐字复制本轮作者原话中直接表达该偏好的最短证据，不能改写或引用历史消息。briefPatch 只能整理作者本轮明确提出的章节要求。只有作者明确要求修改项目级角色、世界观、关系、时间线、剧情线、伏笔或故事圣经时，才填写 canonicalChangeRequests；助手建议和当前章节写作要求必须返回空数组。\n\n同一线程近期对话：\n${recentHistory}\n\n当前简报：\n${briefState}\n\n作者本轮：\n${params.content}\n\n当前检索证据：\n${formatEvidence(selected) || "没有命中资料"}`,
        })).data;
        rounds.push({ index: round, query, hitIds: hits.map((hit) => hit.sourceId), selectedIds: selected.map((hit) => hit.sourceId), enoughEvidence: turn.enoughEvidence });
        if (turn.enoughEvidence || !turn.followUpQueries.length || !hits.length || (round > 1 && hitMap.size === previousHitCount)) break;
        queries = uniqueStrings(turn.followUpQueries);
      }
      if (!turn) throw new Error("协作助手未返回有效内容");
      const selectedHits = [...hitMap.values()].sort((a, b) => b.fusedScore - a.fusedScore).slice(0, MAX_SELECTED_HITS);
      const completedRun: NovelRetrievalRun = { ...retrievalRun, queries: rounds.map((round) => round.query), rounds, hits: [...hitMap.values()], selectedSourceIds: selectedHits.map((hit) => hit.sourceId), status: "completed", revision: retrievalRun.revision + 1, updatedAt: Date.now() };
      await novelDb.retrievalRuns.put(completedRun);
      const proposalNotices: string[] = [];
      for (const request of turn.canonicalChangeRequests ?? []) {
        try {
          const { runGenerationTask } = await import("./generation");
          await runGenerationTask({ projectId: thread.projectId, taskKey: request.taskKey, instruction: request.instruction });
          proposalNotices.push(`已创建“${request.taskKey}”候选，等待作者审核。`);
        } catch (error) {
          proposalNotices.push(`“${request.taskKey}”候选创建失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const assistantContent = [turn.answer, proposalNotices.length ? `\n${proposalNotices.join("\n")}` : ""].filter(Boolean).join("\n");
      const assistantMessage = await this.appendMessage({ threadId: thread.id, role: "assistant", content: assistantContent, retrievalRunId: completedRun.id, sourceIds: completedRun.selectedSourceIds });
      const userSummary = history.filter((message) => message.role === "user").slice(-6).map((message) => message.content).join("；").slice(-1200);
      const latestThread = await novelDb.conversationThreads.get(thread.id);
      await novelDb.conversationThreads.update(thread.id, { summary: userSummary, revision: (latestThread?.revision ?? thread.revision) + 1, updatedAt: Date.now(), lastMessageAt: assistantMessage.createdAt });
      for (const memory of turn.preferenceMemories) await savePreferenceMemory({ thread, messageId: userMessage.id, authorContent: params.content, ...memory });
      const brief = await this.getDraftBrief(thread.id);
      const updatedBrief = await this.updateBrief(brief.id, {
        ...turn.briefPatch,
        languageRequirements: uniqueStrings([...(brief.languageRequirements ?? []), ...(turn.briefPatch.languageRequirements ?? [])]),
        mustHappen: uniqueStrings([...(brief.mustHappen ?? []), ...(turn.briefPatch.mustHappen ?? [])]),
        forbidden: uniqueStrings([...(brief.forbidden ?? []), ...(turn.briefPatch.forbidden ?? [])]),
        openQuestions: uniqueStrings(turn.briefPatch.openQuestions ?? brief.openQuestions),
        referencedMemoryIds: uniqueStrings([...brief.referencedMemoryIds, ...completedRun.selectedSourceIds]),
      });
      updatedBrief.sourceMessageIds = uniqueStrings([...updatedBrief.sourceMessageIds, userMessage.id]);
      await novelDb.creativeBriefs.put(updatedBrief);
      void runPendingMemoryJobs(thread.projectId).catch(() => undefined);
      return { userMessage, assistantMessage, retrievalRun: completedRun, brief: updatedBrief };
    } catch (error) {
      await novelDb.retrievalRuns.update(retrievalRun.id, { status: "failed", error: error instanceof Error ? error.message : String(error), rounds, hits: [...hitMap.values()], updatedAt: Date.now(), revision: retrievalRun.revision + 1 });
      throw error;
    }
  }

  async revokeMemory(memoryId: string) {
    const memory = await novelDb.conversationMemories.get(memoryId);
    if (!memory) return;
    await novelDb.conversationMemories.update(memoryId, { status: "rejected", revokedAt: Date.now(), revision: memory.revision + 1, updatedAt: Date.now() });
    await novelDb.embeddings.where("targetId").equals(memoryId).delete();
  }

  async approveMemory(memoryId: string) {
    await novelDb.transaction("rw", novelDb.conversationMemories, async () => {
      const memory = await novelDb.conversationMemories.get(memoryId);
      if (!memory || memory.status !== "pending") return;
      const superseded = await novelDb.conversationMemories.where("projectId").equals(memory.projectId).and((item) => item.id !== memory.id && item.kind === memory.kind && item.status === "active" && item.title.trim() === memory.title.trim()).first();
      const now = Date.now();
      if (superseded) await novelDb.conversationMemories.update(superseded.id, { status: "superseded", revision: superseded.revision + 1, updatedAt: now });
      await novelDb.conversationMemories.update(memory.id, { status: "active", autoApplied: false, supersedesId: superseded?.id, revision: memory.revision + 1, updatedAt: now });
    });
  }

  async setSourceOverride(threadId: string, sourceId: string, mode: "pin" | "exclude" | "clear") {
    const thread = await novelDb.conversationThreads.get(threadId);
    if (!thread) throw new Error("协作对话不存在");
    const pinned = new Set(thread.pinnedSourceIds);
    const excluded = new Set(thread.excludedSourceIds);
    pinned.delete(sourceId); excluded.delete(sourceId);
    if (mode === "pin") pinned.add(sourceId);
    if (mode === "exclude") excluded.add(sourceId);
    await novelDb.conversationThreads.update(threadId, { pinnedSourceIds: [...pinned], excludedSourceIds: [...excluded], revision: thread.revision + 1, updatedAt: Date.now() });
  }

  async compileStageContext(params: { threadId: string; stage: WorkflowStage; role?: NovelAgentRole; instruction: string; workflowRunId?: string; skillStage?: NovelSkillStage; db?: NovelDatabase }) {
    const db = params.db ?? novelDb;
    const thread = await db.conversationThreads.get(params.threadId);
    if (!thread) throw new Error("协作对话不存在");
    const brief = (await db.creativeBriefs.where("threadId").equals(thread.id).reverse().sortBy("updatedAt")).find((item) => item.status === "confirmed");
    if (!brief) throw new Error("请先确认本章创作简报");
    const retrieval = await runStageRetrieval({ thread, brief, stage: params.stage, role: params.role, instruction: params.instruction, workflowRunId: params.workflowRunId, db: params.db });
    const stage = params.skillStage ?? (params.stage === "draft" ? "drafting" : params.stage === "review" ? "review" : params.stage === "revision" ? "revision" : params.stage === "fact-extraction" ? "fact-extraction" : "planning");
    return compileNovelContext({
      projectId: thread.projectId, task: `chapter-workflow:${params.stage}`, instruction: params.instruction, targetDocumentId: thread.targetId,
      pinnedSourceIds: thread.pinnedSourceIds, excludedSourceIds: thread.excludedSourceIds, stage,
      informationView: params.stage === "draft" && brief.povCharacterId ? "character" : "author", viewCharacterId: params.stage === "draft" ? brief.povCharacterId : undefined,
      threadId: thread.id, creativeBriefId: brief.id, retrievalRunId: retrieval.run.id, retrievalSourceIds: retrieval.run.selectedSourceIds, retrievalHits: retrieval.selectedHits, factCutoffOrder: brief.factCutoffOrder,
      consumer: { workflowRunId: params.workflowRunId, stage: params.stage, role: params.role },
      db: params.db,
    });
  }
}

export class HttpNovelMemoryService implements NovelMemoryService {
  constructor(private readonly baseUrl: string, private readonly getToken: () => string | undefined = () => undefined) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = this.getToken();
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) throw new Error((await response.text().catch(() => "")) || `小说记忆请求失败 HTTP ${response.status}`);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async getOrCreateThread(params: { projectId: string; targetDocumentId: string }) {
    const thread = await this.request<NovelConversationThread>(`/projects/${params.projectId}/novel-memory/threads:resolve`, { method: "POST", body: JSON.stringify(params) });
    await novelDb.conversationThreads.put(thread);
    return thread;
  }

  async appendMessage(params: { threadId: string; role: NovelConversationMessage["role"]; content: string; retrievalRunId?: string; sourceIds?: string[] }) {
    const message = await this.request<NovelConversationMessage>(`/novel-memory/threads/${params.threadId}/messages`, { method: "POST", body: JSON.stringify(params) });
    await novelDb.conversationMessages.put(message);
    return message;
  }

  async runConversationTurn(params: { threadId: string; content: string }) {
    const result = await this.request<{ userMessage: NovelConversationMessage; assistantMessage: NovelConversationMessage; retrievalRun: NovelRetrievalRun; brief: CreativeBrief; memories?: ConversationMemory[] }>(`/novel-memory/threads/${params.threadId}/turns`, { method: "POST", body: JSON.stringify({ content: params.content }) });
    await novelDb.transaction("rw", novelDb.conversationMessages, novelDb.retrievalRuns, novelDb.creativeBriefs, novelDb.conversationMemories, async () => {
      await novelDb.conversationMessages.bulkPut([result.userMessage, result.assistantMessage]);
      await novelDb.retrievalRuns.put(result.retrievalRun);
      await novelDb.creativeBriefs.put(result.brief);
      if (result.memories?.length) await novelDb.conversationMemories.bulkPut(result.memories);
    });
    return result;
  }

  async getDraftBrief(threadId: string) {
    const brief = await this.request<CreativeBrief>(`/novel-memory/threads/${threadId}/brief`);
    await novelDb.creativeBriefs.put(brief);
    return brief;
  }

  async updateBrief(briefId: string, patch: Partial<Pick<CreativeBrief, "goal" | "povCharacterId" | "factCutoffOrder" | "tone" | "languageRequirements" | "mustHappen" | "forbidden" | "targetWords" | "referencedMemoryIds" | "openQuestions">>) {
    const brief = await this.request<CreativeBrief>(`/novel-memory/briefs/${briefId}`, { method: "PATCH", body: JSON.stringify(patch) });
    await novelDb.creativeBriefs.put(brief);
    return brief;
  }

  async confirmBrief(briefId: string) {
    const brief = await this.request<CreativeBrief>(`/novel-memory/briefs/${briefId}:confirm`, { method: "POST" });
    await novelDb.creativeBriefs.put(brief);
    return brief;
  }

  async approveMemory(memoryId: string) {
    await this.request<void>(`/novel-memory/memories/${memoryId}:approve`, { method: "POST" });
    const memory = await novelDb.conversationMemories.get(memoryId);
    if (memory) await novelDb.conversationMemories.update(memoryId, { status: "active", autoApplied: false, revision: memory.revision + 1, updatedAt: Date.now() });
  }

  async revokeMemory(memoryId: string) {
    await this.request<void>(`/novel-memory/memories/${memoryId}:revoke`, { method: "POST" });
    const memory = await novelDb.conversationMemories.get(memoryId);
    if (memory) await novelDb.conversationMemories.update(memoryId, { status: "rejected", revokedAt: Date.now(), revision: memory.revision + 1, updatedAt: Date.now() });
  }

  async setSourceOverride(threadId: string, sourceId: string, mode: "pin" | "exclude" | "clear") {
    await this.request<void>(`/novel-memory/threads/${threadId}/source-overrides`, { method: "PUT", body: JSON.stringify({ sourceId, mode }) });
    const thread = await novelDb.conversationThreads.get(threadId);
    if (thread) {
      const pinned = new Set(thread.pinnedSourceIds); const excluded = new Set(thread.excludedSourceIds);
      pinned.delete(sourceId); excluded.delete(sourceId);
      if (mode === "pin") pinned.add(sourceId); if (mode === "exclude") excluded.add(sourceId);
      await novelDb.conversationThreads.update(threadId, { pinnedSourceIds: [...pinned], excludedSourceIds: [...excluded], revision: thread.revision + 1, updatedAt: Date.now() });
    }
  }

  async compileStageContext(params: { threadId: string; stage: WorkflowStage; role?: NovelAgentRole; instruction: string; workflowRunId?: string; skillStage?: NovelSkillStage; db?: NovelDatabase }) {
    const { db: _db, ...rest } = params;
    const packet = await this.request<NovelContextPacket>(`/novel-memory/threads/${params.threadId}/contexts:compile`, { method: "POST", body: JSON.stringify(rest) });
    const db = params.db ?? novelDb;
    await db.contextPackets.put(packet);
    return packet;
  }
}

export function createNovelMemoryService(config?: { baseUrl?: string; getToken?: () => string | undefined }): NovelMemoryService {
  return config?.baseUrl ? new HttpNovelMemoryService(config.baseUrl, config.getToken) : new DexieNovelMemoryService();
}

const configuredMemoryBaseUrl = String(import.meta.env?.VITE_NOVEL_MEMORY_BASE_URL ?? "").trim();
export const novelMemoryService: NovelMemoryService = createNovelMemoryService(configuredMemoryBaseUrl ? {
  baseUrl: configuredMemoryBaseUrl,
  getToken: () => sessionStorage.getItem("ymcp-novel-memory-token") ?? undefined,
} : undefined);
