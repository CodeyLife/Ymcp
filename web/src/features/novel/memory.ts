import { invalidateRevisionDependents, novelDb, recordBase, type NovelDatabase } from "./db";
import type { DerivedMemory, DerivedMemoryContent, NarrativeUnit, NarrativeUnitKind, OutlineRealization } from "./types";
import { scheduleMemoryJob } from "./memory-service";

const EMPTY_CONTENT: DerivedMemoryContent = {
  sceneOutcomes: [],
  stateChanges: [],
  knowledgeChanges: [],
  relationshipChanges: [],
  threadProgress: [],
  foreshadowingProgress: [],
  factAssertionIds: [],
  inheritedPressures: [],
};

function estimateTokens(text: string) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return Math.ceil(cjk * 1.1 + (text.length - cjk) / 4);
}

/**
 * 检测 summary 是否为 schema 修复日志污染。
 * LLM 在结构化输出 schema 修复时，可能违反 prompt 指令把修复过程写入 summary 字段，
 * 导致 DerivedMemory.summary 出现"已将原输出修复为符合给定 Schema 的 JSON..."这类元描述，
 * 而非真正的故事记忆摘要。
 */
const SCHEMA_REPAIR_LOG_PATTERN = /^(已将原输出|原输出包含|原输出|已将)|Schema[\s\S]{0,16}(修复|JSON|字段|校验|映射|移除|超出)|修复为[\s\S]{0,16}Schema/i;

export function isSchemaRepairLogSummary(text: string): boolean {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return false;
  return SCHEMA_REPAIR_LOG_PATTERN.test(trimmed);
}

/** 清洗 memory summary：若为 schema 修复日志则回退到 fallback，否则保留原值（空值也回退）。 */
export function sanitizeMemorySummary(raw: string, fallback: string): string {
  const trimmed = (raw ?? "").trim();
  if (isSchemaRepairLogSummary(trimmed)) return fallback;
  return trimmed || fallback;
}

function mergeContent(content?: Partial<DerivedMemoryContent>): DerivedMemoryContent {
  return Object.fromEntries(Object.entries(EMPTY_CONTENT).map(([key, value]) => [key, [...(content?.[key as keyof DerivedMemoryContent] ?? value)]])) as unknown as DerivedMemoryContent;
}

function expectedParentKind(kind: NarrativeUnitKind): NarrativeUnitKind | undefined {
  if (kind === "sequence") return "arc";
  if (kind === "arc") return "volume";
  return undefined;
}

export async function createNarrativeUnit(params: { projectId: string; kind: NarrativeUnitKind; parentId?: string; title: string; summary?: string; order: number }) {
  const parent = params.parentId ? await novelDb.narrativeUnits.get(params.parentId) : undefined;
  const expected = expectedParentKind(params.kind);
  if (expected && (!parent || parent.projectId !== params.projectId || parent.kind !== expected)) throw new Error(`${params.kind} 必须归属于 ${expected}`);
  if (!expected && params.parentId) throw new Error("分卷不能归属于其它叙事单元");
  const unit: NarrativeUnit = { ...recordBase(params.projectId), parentId: params.parentId, kind: params.kind, title: params.title, summary: params.summary ?? "", order: params.order, status: "planned" };
  await novelDb.narrativeUnits.add(unit);
  return unit;
}

export async function assignChapterToSequence(documentId: string, sequenceId?: string) {
  const document = await novelDb.documents.get(documentId);
  if (!document) throw new Error("章节不存在");
  if (sequenceId) {
    const sequence = await novelDb.narrativeUnits.get(sequenceId);
    if (!sequence || sequence.projectId !== document.projectId || sequence.kind !== "sequence") throw new Error("章节主要归属必须是同项目的序列");
  }
  await novelDb.documents.update(documentId, { primaryNarrativeUnitId: sequenceId, revision: document.revision + 1, updatedAt: Date.now() });
  const active = await novelDb.derivedMemories.where("documentId").equals(documentId).and((memory) => memory.status === "active" || memory.status === "cold").toArray();
  if (active.length) await invalidateMemoryAncestors(document.projectId, active.map((memory) => memory.id), novelDb);
}

export async function linkOutlineRealization(params: { projectId: string; outlineNodeId: string; documentId: string; sceneId?: string; status?: OutlineRealization["status"]; note?: string }) {
  const [outline, document, scene] = await Promise.all([
    novelDb.outlineNodes.get(params.outlineNodeId),
    novelDb.documents.get(params.documentId),
    params.sceneId ? novelDb.scenes.get(params.sceneId) : undefined,
  ]);
  if (!outline || !document || outline.projectId !== params.projectId || document.projectId !== params.projectId) throw new Error("大纲事件或章节不存在");
  if (scene && (scene.projectId !== params.projectId || scene.chapterId !== params.documentId)) throw new Error("场景不属于目标章节");
  const existing = await novelDb.outlineRealizations.where("[projectId+documentId]").equals([params.projectId, params.documentId]).and((item) => item.outlineNodeId === params.outlineNodeId && item.sceneId === params.sceneId).first();
  if (existing) return existing;
  const realization: OutlineRealization = { ...recordBase(params.projectId), outlineNodeId: params.outlineNodeId, documentId: params.documentId, sceneId: params.sceneId, status: params.status ?? "planned", note: params.note ?? "" };
  await novelDb.outlineRealizations.add(realization);
  return realization;
}

async function invalidateMemoryAncestors(projectId: string, sourceIds: string[], db: NovelDatabase) {
  const all = await db.derivedMemories.where("projectId").equals(projectId).toArray();
  const stale = new Set(sourceIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const memory of all) {
      if (!stale.has(memory.id) && memory.sourceMemoryIds.some((id) => stale.has(id))) {
        stale.add(memory.id);
        changed = true;
      }
    }
  }
  // F-019 修复：过滤条件追加 memory.status !== "superseded"，与 db.ts:markDerivedMemoriesStale 对齐。
  // superseded 表示"已被新版本取代、保留为历史"，stale 表示"下层来源变化、需重新整合"。
  // 原条件只跳过 stale，BFS 传播链中存在已 superseded 的中间节点时会被重写为 stale，
  // 丢失取代关系审计链，且使 validation.issues 从空数组变为 ["下层来源已变化，需要重新整合"]，
  // 误导后续整合判断。
  const ancestors = all.filter((memory) => stale.has(memory.id) && !sourceIds.includes(memory.id) && memory.status !== "stale" && memory.status !== "superseded");
  const now = Date.now();
  await db.derivedMemories.bulkPut(ancestors.map((memory) => ({ ...memory, status: "stale" as const, validation: { passed: false, issues: ["下层来源已变化，需要重新整合"], checkedAt: now }, revision: memory.revision + 1, updatedAt: now })));
  return ancestors.map((memory) => memory.id);
}

export async function invalidateDerivedMemoriesForRevision(projectId: string, sourceRevisionId: string, db: NovelDatabase = novelDb) {
  return invalidateRevisionDependents(projectId, [sourceRevisionId], "来源正文修订已被取代", db);
}

export async function createChapterMemory(params: { projectId: string; documentId: string; sourceRevisionId: string; summary: string; content?: Partial<DerivedMemoryContent> }, db: NovelDatabase = novelDb) {
  const [document, revision] = await Promise.all([db.documents.get(params.documentId), db.revisions.get(params.sourceRevisionId)]);
  if (!document || !revision || document.projectId !== params.projectId || revision.projectId !== params.projectId || revision.documentId !== document.id || revision.approvalStatus !== "approved") throw new Error("章节记忆必须绑定当前有效的已批准正文修订");
  const previous = await db.derivedMemories.where("documentId").equals(document.id).and((memory) => memory.level === "chapter" && (memory.status === "active" || memory.status === "cold")).toArray();
  const content = mergeContent(params.content);
  const now = Date.now();
  const memory: DerivedMemory = {
    ...recordBase(params.projectId),
    level: "chapter",
    documentId: document.id,
    narrativeUnitId: document.primaryNarrativeUnitId,
    sourceRevisionId: revision.id,
    sourceMemoryIds: [],
    coverage: { chapterIds: [document.id], startOrder: document.order, endOrder: document.order },
    summary: params.summary,
    content,
    status: "active",
    validation: { passed: true, issues: [], checkedAt: now },
    tokenEstimate: estimateTokens(`${params.summary}\n${Object.values(content).flat().join("\n")}`),
    generatedAt: now,
  };
  await db.transaction("rw", db.derivedMemories, async () => {
    await db.derivedMemories.bulkPut(previous.map((item) => ({ ...item, status: "superseded" as const, revision: item.revision + 1, updatedAt: now })));
    await db.derivedMemories.add(memory);
  });
  if (previous.length) await invalidateMemoryAncestors(params.projectId, previous.map((item) => item.id), db);
  await scheduleMemoryJob({ projectId: params.projectId, jobType: "embedding", idempotencyKey: `embedding:derivedMemories:${memory.id}:${memory.revision}`, payload: { targetTable: "derivedMemories", targetId: memory.id, content: `${memory.summary}\n${Object.values(memory.content).flat().join("\n")}` } }, db);
  return memory;
}

const SOURCE_LEVEL: Record<Exclude<DerivedMemory["level"], "chapter">, DerivedMemory["level"]> = {
  sequence: "chapter",
  arc: "sequence",
  volume: "arc",
  book: "volume",
};

export async function consolidateDerivedMemory(params: { projectId: string; level: Exclude<DerivedMemory["level"], "chapter">; narrativeUnitId?: string; sourceMemoryIds: string[]; summary: string; content?: Partial<DerivedMemoryContent> }) {
  const uniqueSourceIds = [...new Set(params.sourceMemoryIds)];
  const sources = await novelDb.derivedMemories.bulkGet(uniqueSourceIds);
  const issues: string[] = [];
  if (!uniqueSourceIds.length) issues.push("没有可整合的下层记忆");
  if (!params.summary.trim()) issues.push("整合摘要为空");
  if (sources.some((source) => !source || source.projectId !== params.projectId)) issues.push("存在缺失或跨项目的来源记忆");
  const expectedLevel = SOURCE_LEVEL[params.level];
  if (sources.some((source) => source && source.level !== expectedLevel)) issues.push(`${params.level} 只能由 ${expectedLevel} 记忆整合`);
  if (sources.some((source) => source && !["active", "cold"].includes(source.status))) issues.push("来源记忆不是可用版本");
  const resolvedSources = sources.filter((source): source is DerivedMemory => Boolean(source));
  const now = Date.now();
  const chapterIds = [...new Set(resolvedSources.flatMap((source) => source.coverage.chapterIds))];
  const orders = resolvedSources.flatMap((source) => [source.coverage.startOrder, source.coverage.endOrder]).filter((value): value is number => typeof value === "number");
  const content = mergeContent(params.content);
  const memory: DerivedMemory = {
    ...recordBase(params.projectId),
    level: params.level,
    narrativeUnitId: params.narrativeUnitId,
    sourceMemoryIds: uniqueSourceIds,
    coverage: { chapterIds, startOrder: orders.length ? Math.min(...orders) : undefined, endOrder: orders.length ? Math.max(...orders) : undefined },
    summary: params.summary,
    content,
    status: issues.length ? "pending-review" : "active",
    validation: { passed: issues.length === 0, issues, checkedAt: now },
    tokenEstimate: estimateTokens(`${params.summary}\n${Object.values(content).flat().join("\n")}`),
    generatedAt: now,
  };
  const existing = await novelDb.derivedMemories.where("projectId").equals(params.projectId).and((item) => item.level === params.level && item.narrativeUnitId === params.narrativeUnitId && item.status === "active").toArray();
  await novelDb.transaction("rw", novelDb.derivedMemories, async () => {
    if (!issues.length) {
      await novelDb.derivedMemories.bulkPut(existing.map((item) => ({ ...item, status: "superseded" as const, revision: item.revision + 1, updatedAt: now })));
      await novelDb.derivedMemories.bulkPut(resolvedSources.filter((item) => item.status === "active").map((item) => ({ ...item, status: "cold" as const, revision: item.revision + 1, updatedAt: now })));
    }
    await novelDb.derivedMemories.add(memory);
  });
  if (!issues.length && existing.length) await invalidateMemoryAncestors(params.projectId, existing.map((item) => item.id), novelDb);
  if (!issues.length) await scheduleMemoryJob({ projectId: params.projectId, jobType: "embedding", idempotencyKey: `embedding:derivedMemories:${memory.id}:${memory.revision}`, payload: { targetTable: "derivedMemories", targetId: memory.id, content: `${memory.summary}\n${Object.values(memory.content).flat().join("\n")}` } });
  return memory;
}
