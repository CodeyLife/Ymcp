import { appendOperation, novelDb, recordBase, type NovelDatabase } from "./db";
import { normalizedCreate } from "./generation";
import type { FactAssertion, FactKnowledgeDelta, FactObjectValue, FactSubjectKind, FactCandidate, FactTimeMode, FactTruthStatus, KnowledgeAssertion, ManuscriptDocument, ProposalTargetTable, StoryEntity, StoryPoint, StorySnapshot } from "./types";

/**
 * 事实账本视图的辅助数据：把章节、角色、来源章节名一次性 join 到 factAssertions 上，
 * 避免组件渲染时 N+1 查询。
 */
export interface FactAssertionWithMeta {
  assertion: FactAssertion;
  chapterTitle?: string;
  chapterOrder?: number;
  subjectName?: string;
  sourceChapterTitle?: string;
}

/**
 * 角色认知视图辅助数据：把角色名一次性 join 到 knowledgeAssertions 上。
 */
export interface KnowledgeAssertionWithMeta {
  assertion: KnowledgeAssertion;
  characterName?: string;
  factHumanReadable?: string;
  factTruthStatus?: FactTruthStatus;
  chapterTitle?: string;
}

/**
 * 一次性拉取项目下全部事实（含 active/superseded/stale/retracted），
 * 并关联章节标题/序号、subject 实体名、来源章节名。
 *
 * 性能策略：
 * - factAssertions 单次 where 查询
 * - documents / entities 通过 bulkGet 一次性补全
 * - 来源章节名经 revisions → documents 二跳解析
 */
export async function listFactAssertionsWithMeta(projectId: string): Promise<FactAssertionWithMeta[]> {
  const assertions = await novelDb.factAssertions.where("projectId").equals(projectId).toArray();
  if (!assertions.length) return [];

  // 章节映射：通过 revealedAt.chapterId 或 sourceRevisionId→documentId
  const chapterIds = new Set<string>();
  const revisionIds = new Set<string>();
  const entityIds = new Set<string>();
  for (const a of assertions) {
    if (a.revealedAt?.chapterId) chapterIds.add(a.revealedAt.chapterId);
    if (a.subject?.id) entityIds.add(a.subject.id);
    if (a.sourceRevisionId) revisionIds.add(a.sourceRevisionId);
  }

  const [documents, entities, revisions] = await Promise.all([
    chapterIds.size ? novelDb.documents.bulkGet(Array.from(chapterIds)) : Promise.resolve([]),
    entityIds.size ? novelDb.entities.bulkGet(Array.from(entityIds)) : Promise.resolve([]),
    revisionIds.size ? novelDb.revisions.bulkGet(Array.from(revisionIds)) : Promise.resolve([]),
  ]);

  const chapterMap = new Map<string, ManuscriptDocument>();
  for (const doc of documents) if (doc) chapterMap.set(doc.id, doc);
  const entityMap = new Map<string, StoryEntity>();
  for (const ent of entities) if (ent) entityMap.set(ent.id, ent);
  const revisionToDocId = new Map<string, string>();
  for (const rev of revisions) if (rev) revisionToDocId.set(rev.id, rev.documentId);

  // 再补一跳：sourceRevisionId → documentId → document
  const sourceDocIds = new Set<string>();
  for (const rev of revisions) if (rev) sourceDocIds.add(rev.documentId);
  const sourceDocs = sourceDocIds.size ? await novelDb.documents.bulkGet(Array.from(sourceDocIds)) : [];
  const sourceDocMap = new Map<string, ManuscriptDocument>();
  for (const doc of sourceDocs) if (doc) sourceDocMap.set(doc.id, doc);

  return assertions.map((assertion) => {
    const chapter = assertion.revealedAt?.chapterId ? chapterMap.get(assertion.revealedAt.chapterId) : undefined;
    const sourceDocId = assertion.sourceRevisionId ? revisionToDocId.get(assertion.sourceRevisionId) : undefined;
    const sourceDoc = sourceDocId ? sourceDocMap.get(sourceDocId) : undefined;
    return {
      assertion,
      chapterTitle: chapter?.title,
      chapterOrder: chapter?.order,
      subjectName: assertion.subject?.id ? entityMap.get(assertion.subject.id)?.name : undefined,
      sourceChapterTitle: sourceDoc?.title,
    };
  });
}

/**
 * 一次性拉取项目下全部角色认知，并关联角色名、事实描述、真值状态、章节标题。
 */
export async function listKnowledgeAssertionsWithMeta(projectId: string): Promise<KnowledgeAssertionWithMeta[]> {
  const items = await novelDb.knowledgeAssertions.where("projectId").equals(projectId).toArray();
  if (!items.length) return [];

  const characterIds = new Set<string>();
  const factAssertionIds = new Set<string>();
  const chapterIds = new Set<string>();
  for (const k of items) {
    characterIds.add(k.characterId);
    factAssertionIds.add(k.factAssertionId);
    if (k.learnedAt?.chapterId) chapterIds.add(k.learnedAt.chapterId);
  }

  const [characters, facts, documents] = await Promise.all([
    novelDb.entities.bulkGet(Array.from(characterIds)),
    novelDb.factAssertions.bulkGet(Array.from(factAssertionIds)),
    chapterIds.size ? novelDb.documents.bulkGet(Array.from(chapterIds)) : Promise.resolve([]),
  ]);

  const characterMap = new Map<string, StoryEntity>();
  for (const c of characters) if (c) characterMap.set(c.id, c);
  const factMap = new Map<string, FactAssertion>();
  for (const f of facts) if (f) factMap.set(f.id, f);
  const chapterMap = new Map<string, ManuscriptDocument>();
  for (const d of documents) if (d) chapterMap.set(d.id, d);

  return items.map((assertion) => {
    const fact = factMap.get(assertion.factAssertionId);
    const chapter = assertion.learnedAt?.chapterId ? chapterMap.get(assertion.learnedAt.chapterId) : undefined;
    return {
      assertion,
      characterName: characterMap.get(assertion.characterId)?.name,
      factHumanReadable: fact?.humanReadable,
      factTruthStatus: fact?.truthStatus,
      chapterTitle: chapter?.title,
    };
  });
}

export interface ExtractedFact {
  targetTable: string;
  targetId?: string;
  field: string;
  subject?: { kind: FactSubjectKind; id: string };
  predicate?: string;
  object?: FactObjectValue;
  polarity?: "affirmed" | "negated";
  truthStatus?: FactTruthStatus;
  timeMode?: FactTimeMode;
  validFrom?: StoryPoint;
  validTo?: StoryPoint;
  humanReadable?: string;
  knowledgeDeltas?: FactKnowledgeDelta[];
  before?: unknown;
  after: unknown;
  evidence: string;
  paragraph?: number;
  confidence: number;
  novelty: "new" | "update" | "duplicate";
  conflict: boolean;
}

export interface PreparedFactCandidates {
  facts: ExtractedFact[];
  discardedDuplicateCharacterCount: number;
  discardedMetaAbsenceCount: number;
  discardedUnprojectableCount: number;
  discardedDuplicateFactCount: number;
}

export function formatFactCandidateValue(fact: Pick<ExtractedFact, "after" | "humanReadable">): string {
  const readable = fact.humanReadable?.trim();
  if (readable) return readable;
  if (typeof fact.after === "string") return fact.after;
  if (fact.after === null || fact.after === undefined) return "（空）";
  try {
    return JSON.stringify(fact.after);
  } catch {
    return String(fact.after);
  }
}

const META_ABSENCE_PATTERN = /(?:正文|本章|文本|原文)(?:中)?(?:尚未|未曾|未|没有)(?:明确)?(?:建立|说明|交代|揭示|提及|确认|给出|出现)/;

function isMetaAbsenceFact(fact: ExtractedFact): boolean {
  const text = [fact.humanReadable, fact.evidence, typeof fact.after === "string" ? fact.after : ""]
    .filter(Boolean)
    .join(" ");
  return META_ABSENCE_PATTERN.test(text);
}

function stableFactValue(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableFactValue).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableFactValue(item)}`).join(",")}}`;
}

function duplicateFactKey(fact: ExtractedFact): string | undefined {
  const subjectId = fact.subject?.id ?? fact.targetId;
  if (!subjectId) return undefined;
  return [fact.targetTable, subjectId, fact.field, stableFactValue(fact.after), fact.polarity ?? "affirmed", fact.truthStatus ?? "objective"].join("|");
}

const MUTABLE_TABLES = new Set(["projects", "entities", "relations", "outlineNodes", "plotThreads", "foreshadowing", "timelineEvents"]);
const SAFE_AUTO_UPDATE_FIELDS = new Map<string, Set<string>>([
  ["entities", new Set([
    "character.state.location",
    "character.state.physical",
    "character.state.emotional",
    "character.state.objective",
    "character.state.inventory",
    "character.state.relationshipNotes",
    "character.state.lastChangedChapterId",
  ])],
]);

export function classifyFactRisk(fact: ExtractedFact): Pick<FactCandidate, "risk" | "riskReason"> {
  if (fact.conflict) return { risk: "high", riskReason: "事实与现有资料冲突" };
  if (fact.truthStatus && fact.truthStatus !== "objective") return { risk: "high", riskReason: "陈述、争议或开放谜题必须人工确认" };
  if (fact.knowledgeDeltas?.length) return { risk: "high", riskReason: "角色认知变化必须人工确认" };
  // 新人物新建：kind=character 的 entity 新建，字段形态合法且置信度足够时走 safe
  if (fact.novelty === "new" && fact.targetTable === "entities" && fact.field === "record") {
    const payload = fact.after as Record<string, unknown> | undefined;
    if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.kind === "character" && typeof payload.name === "string" && payload.name.trim()) {
      if (fact.confidence < 0.9) return { risk: "high", riskReason: "新人物提取置信度不足 90%" };
      return { risk: "safe", riskReason: "正文首次出现的重要人物新建" };
    }
  }
  // Loop 3 改进 #11：novelty=new 但 targetId 已指向已存在实体的"已有对象的新状态变化"
  // 实测显示 80%+ 的 fact candidates 落入此类，全部判 high 会让 fact-approval 阶段形同虚设。
  // 当 targetId 存在且字段属于 SAFE_AUTO_UPDATE_FIELDS 时，按 safe 处理（仍需通过 conflict 校验）。
  if (fact.novelty === "new" && fact.targetId && fact.confidence >= 0.9 && SAFE_AUTO_UPDATE_FIELDS.get(fact.targetTable)?.has(fact.field)) {
    return { risk: "safe", riskReason: "已有对象的明确状态变化（novelty=new 但 targetId 已存在）" };
  }
  if (fact.novelty !== "update" || !fact.targetId) return { risk: "high", riskReason: "新对象或无法定位的事实必须人工确认" };
  if (fact.confidence < 0.9) return { risk: "high", riskReason: "模型置信度不足 90%" };
  if (!SAFE_AUTO_UPDATE_FIELDS.get(fact.targetTable)?.has(fact.field)) {
    return { risk: "high", riskReason: "该字段不属于可自动提交的简单状态变化" };
  }
  return { risk: "safe", riskReason: "已有角色的明确状态变化" };
}

export async function storeFactCandidates(params: { projectId: string; workflowRunId: string; sourceArtifactId: string; sourceRevisionId?: string; defaultRevealedAt?: StoryPoint; facts: ExtractedFact[] }, db: NovelDatabase = novelDb) {
  const candidates: FactCandidate[] = [];
  for (const fact of params.facts) {
    const normalized = { ...fact, confidence: Math.max(0, Math.min(1, fact.confidence)) };
    const target = normalized.targetId && MUTABLE_TABLES.has(normalized.targetTable)
      ? await db.table(normalized.targetTable).get(normalized.targetId) as Record<string, unknown> | undefined
      : undefined;
    candidates.push({
      ...recordBase(params.projectId),
      workflowRunId: params.workflowRunId,
      sourceArtifactId: params.sourceArtifactId,
      sourceRevisionId: params.sourceRevisionId,
      targetTable: normalized.targetTable,
      targetId: normalized.targetId,
      field: normalized.field,
      subject: normalized.subject ?? { kind: subjectKindForTable(normalized.targetTable), id: normalized.targetId ?? params.projectId },
      predicate: normalized.predicate ?? `${normalized.targetTable}.${normalized.field}`,
      object: normalized.object ?? factObjectValue(normalized.after),
      polarity: normalized.polarity ?? "affirmed",
      truthStatus: normalized.truthStatus ?? "objective",
      timeMode: normalized.timeMode ?? "unknown",
      validFrom: normalized.validFrom,
      validTo: normalized.validTo,
      revealedAt: params.defaultRevealedAt,
      humanReadable: normalized.humanReadable ?? `${normalized.targetTable}.${normalized.field}：${typeof normalized.after === "string" ? normalized.after : JSON.stringify(normalized.after)}`,
      knowledgeDeltas: normalized.knowledgeDeltas ?? [],
      before: normalized.before ?? readFactField(target, normalized.field),
      after: normalized.after,
      evidence: normalized.evidence,
      paragraph: normalized.paragraph,
      confidence: normalized.confidence,
      novelty: normalized.novelty,
      conflict: normalized.conflict,
      ...classifyFactRisk(normalized),
      status: "pending",
    });
  }
  await db.factCandidates.bulkAdd(candidates);
  return candidates;
}

export async function setFactCandidateStatus(id: string, status: FactCandidate["status"], db: NovelDatabase = novelDb) {
  const candidate = await db.factCandidates.get(id);
  if (!candidate) throw new Error("事实候选不存在");
  if (status === "accepted" && candidate.conflict) throw new Error("冲突事实不能直接采纳，请先修正或排除");
  const now = Date.now();
  await db.factCandidates.update(id, { status, decisionSource: "author", decidedAt: now, revision: candidate.revision + 1, updatedAt: now });
}

/**
 * 批量变更事实候选状态，用于事实审核界面的一键操作。
 * - status=accepted 时自动跳过 conflict=true 的候选（冲突事实必须先单独处理）
 * - 已是目标状态的候选会被跳过
 * - 返回成功变更的候选 id 列表
 */
export async function bulkSetFactCandidateStatus(
  ids: string[],
  status: FactCandidate["status"],
  db: NovelDatabase = novelDb,
  decisionSource: NonNullable<FactCandidate["decisionSource"]> = "author",
): Promise<string[]> {
  if (!ids.length) return [];
  const now = Date.now();
  const candidates = await db.factCandidates.bulkGet(ids);
  const updates: Array<{ key: string; changes: Partial<FactCandidate> }> = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (status === "accepted" && candidate.conflict) continue;
    if (candidate.status === status) continue;
    updates.push({
      key: candidate.id,
      changes: {
        status,
        decisionSource,
        decidedAt: now,
        revision: candidate.revision + 1,
        updatedAt: now,
      },
    });
  }
  if (updates.length) await db.factCandidates.bulkUpdate(updates);
  return updates.map((item) => item.key);
}

/**
 * 从一批事实候选中筛选出可一键采纳的子集（排除冲突项）。
 */
export function filterAcceptableFactIds(facts: FactCandidate[]): string[] {
  return facts.filter((item) => item.status === "pending" && !item.conflict).map((item) => item.id);
}

/**
 * 从一批事实候选中筛选出"安全且可一键采纳"的子集。
 * 仅包含 risk=safe、非冲突、pending 状态的候选，等价于自动策略本会采纳的事实。
 */
export function filterSafeAcceptableFactIds(facts: FactCandidate[]): string[] {
  return facts.filter((item) => item.status === "pending" && !item.conflict && item.risk === "safe").map((item) => item.id);
}

export async function autoAcceptSafeFactCandidates(candidates: FactCandidate[], db: NovelDatabase = novelDb) {
  const safe = candidates.filter((candidate) => candidate.status === "pending" && candidate.risk === "safe" && !candidate.conflict);
  const now = Date.now();
  await db.factCandidates.bulkPut(safe.map((candidate) => ({
    ...candidate,
    status: "accepted" as const,
    decisionSource: "auto-policy" as const,
    decidedAt: now,
    revision: candidate.revision + 1,
    updatedAt: now,
  })));
  return safe.map((candidate) => candidate.id);
}

function applyField(record: Record<string, unknown>, path: string, value: unknown) {
  const segments = path.split(".").filter(Boolean);
  if (!segments.length || segments.some((segment) => ["id", "projectId", "createdAt", "createdBy", "schemaVersion"].includes(segment))) throw new Error(`不允许更新字段：${path}`);
  const clone = structuredClone(record);
  let cursor = clone;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    cursor[segment] = typeof next === "object" && next !== null && !Array.isArray(next) ? { ...(next as Record<string, unknown>) } : {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = value;
  return clone;
}

export function readFactField(record: Record<string, unknown> | undefined, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return structuredClone(current);
}

export function factProjectionValuesEqual(left: unknown, right: unknown): boolean {
  return stableFactValue(left) === stableFactValue(right);
}

function subjectKindForTable(table: string): FactSubjectKind {
  const kinds: Record<string, FactSubjectKind> = {
    projects: "project",
    entities: "entity",
    relations: "relation",
    outlineNodes: "outline",
    scenes: "scene",
    plotThreads: "thread",
    foreshadowing: "foreshadowing",
    timelineEvents: "timeline",
  };
  return kinds[table] ?? "project";
}

function factObjectValue(value: unknown): FactObjectValue {
  if (typeof value === "string") return { kind: "string", value };
  if (typeof value === "number") return { kind: "number", value };
  if (typeof value === "boolean") return { kind: "boolean", value };
  return { kind: "json", value };
}

export function candidateToFactAssertion(candidate: FactCandidate, projectionTargetId = candidate.targetId): FactAssertion {
  const sourceRevisionId = candidate.sourceRevisionId ?? candidate.sourceArtifactId;
  return {
    ...recordBase(candidate.projectId),
    id: `fact:${candidate.id}`,
    subject: candidate.subject ?? { kind: subjectKindForTable(candidate.targetTable), id: projectionTargetId ?? candidate.projectId },
    predicate: candidate.predicate ?? `${candidate.targetTable}.${candidate.field}`,
    object: candidate.object ?? factObjectValue(candidate.after),
    polarity: candidate.polarity ?? "affirmed",
    truthStatus: candidate.truthStatus ?? "objective",
    timeMode: candidate.timeMode ?? "unknown",
    validFrom: candidate.validFrom,
    validTo: candidate.validTo,
    revealedAt: candidate.revealedAt,
    sourceRevisionId,
    sourceArtifactId: candidate.sourceRevisionId ? undefined : candidate.sourceArtifactId,
    provenance: candidate.sourceRevisionId ? "approved-revision" : "legacy-artifact",
    evidence: candidate.evidence,
    paragraph: candidate.paragraph,
    confidence: candidate.confidence,
    humanReadable: candidate.humanReadable ?? `${candidate.targetTable}.${candidate.field}：${typeof candidate.after === "string" ? candidate.after : JSON.stringify(candidate.after)}`,
    status: "active",
    derivedFromCandidateId: candidate.id,
    projection: { targetTable: candidate.targetTable, targetId: projectionTargetId, field: candidate.field },
  };
}

function knowledgeAssertionsForCandidate(candidate: FactCandidate, factAssertionId: string) {
  return (candidate.knowledgeDeltas ?? []).map((delta) => ({
    ...recordBase(candidate.projectId),
    id: `knowledge:${candidate.id}:${delta.characterId}:${delta.stance}`,
    characterId: delta.characterId,
    factAssertionId,
    stance: delta.stance,
    learnedAt: delta.learnedAt ?? candidate.revealedAt,
    sourceRevisionId: candidate.sourceRevisionId ?? candidate.sourceArtifactId,
    status: "active" as const,
  }));
}

/**
 * 查找项目中与给定 name/aliases 匹配的已有 character 实体。
 * 匹配规则：name 完全相等，或 aliases 交集，或已有实体的 name 在新 aliases 中，或新 name 在已有 aliases 中。
 */
export async function findExistingCharacter(projectId: string, name: string, aliases: string[], db: NovelDatabase = novelDb): Promise<StoryEntity | undefined> {
  const trimmedName = name.trim();
  const trimmedAliases = aliases.map((a) => String(a).trim()).filter(Boolean);
  if (!trimmedName) return undefined;
  return db.entities
    .where("projectId")
    .equals(projectId)
    .and((e) => {
      if (e.kind !== "character") return false;
      const existingAliases = (e.aliases ?? []).map((a) => String(a).trim());
      return e.name === trimmedName
        || trimmedAliases.includes(e.name)
        || existingAliases.includes(trimmedName)
        || existingAliases.some((a) => trimmedAliases.includes(a));
    })
    .first();
}

/**
 * 预去重：对一批 ExtractedFact 中 novelty='new' 的 character 新建候选，
 * 若项目中已存在同名/同别名 character，则丢弃该候选（LLM 误判为新建）。
 * 返回剩余 facts 与被丢弃数量。
 */
export async function dedupeCharacterFactCandidates(projectId: string, facts: ExtractedFact[], db: NovelDatabase = novelDb): Promise<{ facts: ExtractedFact[]; discardedCount: number }> {
  const kept: ExtractedFact[] = [];
  let discardedCount = 0;
  for (const fact of facts) {
    if (fact.novelty === "new" && fact.targetTable === "entities" && fact.field === "record") {
      const payload = fact.after as Record<string, unknown> | undefined;
      if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.kind === "character" && typeof payload.name === "string") {
        const name = String(payload.name).trim();
        const aliases = Array.isArray(payload.aliases) ? payload.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
        const existing = await findExistingCharacter(projectId, name, aliases, db);
        if (existing) { discardedCount += 1; continue; }
      }
    }
    kept.push(fact);
  }
  return { facts: kept, discardedCount };
}

export async function prepareFactCandidates(projectId: string, facts: ExtractedFact[], db: NovelDatabase = novelDb): Promise<PreparedFactCandidates> {
  const characterResult = await dedupeCharacterFactCandidates(projectId, facts, db);
  let discardedMetaAbsenceCount = 0;
  let discardedUnprojectableCount = 0;
  let discardedDuplicateFactCount = 0;
  const indexesByKey = new Map<string, number>();
  const prepared: ExtractedFact[] = [];

  for (const fact of characterResult.facts) {
    if (isMetaAbsenceFact(fact)) {
      discardedMetaAbsenceCount += 1;
      continue;
    }
    if (!fact.targetId && fact.field !== "record") {
      discardedUnprojectableCount += 1;
      continue;
    }
    const key = duplicateFactKey(fact);
    const existingIndex = key ? indexesByKey.get(key) : undefined;
    if (existingIndex === undefined) {
      if (key) indexesByKey.set(key, prepared.length);
      prepared.push(fact);
      continue;
    }

    discardedDuplicateFactCount += 1;
    const existing = prepared[existingIndex];
    const existingRank = Number(Boolean(existing.targetId)) + Number(existing.novelty === "update");
    const incomingRank = Number(Boolean(fact.targetId)) + Number(fact.novelty === "update");
    if (incomingRank > existingRank || (incomingRank === existingRank && fact.confidence > existing.confidence)) {
      prepared[existingIndex] = fact;
    }
  }

  return {
    facts: prepared,
    discardedDuplicateCharacterCount: characterResult.discardedCount,
    discardedMetaAbsenceCount,
    discardedUnprojectableCount,
    discardedDuplicateFactCount,
  };
}

export async function commitAcceptedFacts(projectId: string, workflowRunId: string, db: NovelDatabase = novelDb) {
  const candidates = await db.factCandidates.where("workflowRunId").equals(workflowRunId).and((item) => item.status === "accepted" && !item.conflict && item.novelty !== "duplicate" && !item.committedAt).toArray();
  const committed: string[] = [];
  for (const candidate of candidates) {
    if (!MUTABLE_TABLES.has(candidate.targetTable)) continue;

    if (candidate.field === "knowledgeDeltas") {
      const assertion = candidateToFactAssertion(candidate, candidate.targetId);
      delete assertion.projection;
      const knowledgeAssertions = knowledgeAssertionsForCandidate(candidate, assertion.id);
      const committedAt = Date.now();
      await db.transaction("rw", db.factAssertions, db.knowledgeAssertions, db.factCandidates, async () => {
        await db.factAssertions.put(assertion);
        if (knowledgeAssertions.length) await db.knowledgeAssertions.bulkPut(knowledgeAssertions);
        await db.factCandidates.update(candidate.id, { committedAssertionId: assertion.id, committedAt, updatedAt: committedAt, revision: candidate.revision + 1 });
      });
      committed.push(candidate.id);
      continue;
    }

    const table = db.table(candidate.targetTable);

    if (candidate.novelty === "new" && !candidate.targetId) {
      const payload = candidate.after as Record<string, unknown>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
      if (candidate.targetTable === "relations") {
        const fromId = String(payload.fromEntityId ?? "");
        const toId = String(payload.toEntityId ?? "");
        if (!fromId || !toId) continue;
        const existing = await db.relations
          .where("projectId")
          .equals(projectId)
          .and((r) => r.fromEntityId === fromId && r.toEntityId === toId)
          .first();
        if (existing) continue;
      }
      if (candidate.targetTable === "entities" && payload.kind === "character") {
        const name = String(payload.name ?? "").trim();
        const aliases = Array.isArray(payload.aliases) ? payload.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
        if (!name) continue;
        const existing = await findExistingCharacter(projectId, name, aliases, db);
        if (existing) continue;
      }
      const id = `${candidate.targetTable.slice(0, 3)}:${crypto.randomUUID()}`;
      const record = normalizedCreate(candidate.targetTable as ProposalTargetTable, projectId, id, payload);
      const assertion = candidateToFactAssertion(candidate, id);
      const knowledgeAssertions = knowledgeAssertionsForCandidate(candidate, assertion.id);
      const committedAt = Date.now();
      await db.transaction("rw", table, db.operations, db.factAssertions, db.knowledgeAssertions, db.factCandidates, async () => {
        await table.put(record);
        await appendOperation(projectId, candidate.targetTable, id, "create", { _create: { before: null, after: payload } }, db);
        await db.factAssertions.put(assertion);
        if (knowledgeAssertions.length) await db.knowledgeAssertions.bulkPut(knowledgeAssertions);
        await db.factCandidates.update(candidate.id, { committedAssertionId: assertion.id, committedAt, updatedAt: committedAt, revision: candidate.revision + 1 });
      });
      committed.push(candidate.id);
      continue;
    }

    const targetId = candidate.targetId;
    if (!targetId) continue;
    const current = await table.get(targetId) as Record<string, unknown> | undefined;
    if (!current || current.projectId !== projectId) continue;
    const next = applyField(current, candidate.field, candidate.after);
    next.updatedAt = Date.now();
    next.updatedBy = "local-user";
    next.revision = Number(current.revision ?? 0) + 1;
    const assertion = candidateToFactAssertion(candidate, targetId);
    const knowledgeAssertions = knowledgeAssertionsForCandidate(candidate, assertion.id);
    const committedAt = Date.now();
    await db.transaction("rw", table, db.operations, db.factAssertions, db.knowledgeAssertions, db.factCandidates, async () => {
      await table.put(next);
      await appendOperation(projectId, candidate.targetTable, targetId, "update", { [candidate.field]: { before: candidate.before, after: candidate.after } }, db);
      await db.factAssertions.put(assertion);
      if (knowledgeAssertions.length) await db.knowledgeAssertions.bulkPut(knowledgeAssertions);
      await db.factCandidates.update(candidate.id, { committedAssertionId: assertion.id, committedAt, updatedAt: committedAt, revision: candidate.revision + 1 });
    });
    committed.push(candidate.id);
  }
  return committed;
}

export async function createWorkflowSnapshot(params: { projectId: string; documentId: string; label: string; summary: string }, db: NovelDatabase = novelDb) {
  const [entities, threads, previous] = await Promise.all([
    db.entities.where("projectId").equals(params.projectId).toArray(),
    db.plotThreads.where("projectId").equals(params.projectId).toArray(),
    db.snapshots.where("projectId").equals(params.projectId).reverse().sortBy("createdAt").then((items) => items[0]),
  ]);
  const snapshot: StorySnapshot = {
    ...recordBase(params.projectId),
    label: params.label,
    storyTime: previous?.storyTime ?? "时间待确认",
    currentLocations: Object.fromEntries(entities.filter((item) => item.kind === "character" && item.character?.state.location).map((item) => [item.id, item.character!.state.location])),
    activeCharacterIds: entities.filter((item) => item.kind === "character" && item.character?.state.objective).map((item) => item.id),
    activeThreadIds: threads.filter((item) => item.status === "active" || item.status === "planned").map((item) => item.id),
    unresolvedConflicts: threads.filter((item) => item.status !== "resolved" && item.nextMove).map((item) => item.nextMove),
    recentSummary: params.summary,
    sourceDocumentId: params.documentId,
  };
  await db.snapshots.add(snapshot);
  await db.projects.update(params.projectId, { currentSnapshotId: snapshot.id, updatedAt: Date.now() });
  return snapshot;
}
