import { appendOperation, novelDb, recordBase } from "./db";
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
  if (fact.novelty !== "update" || !fact.targetId) return { risk: "high", riskReason: "新对象或无法定位的事实必须人工确认" };
  if (fact.confidence < 0.9) return { risk: "high", riskReason: "模型置信度不足 90%" };
  if (!SAFE_AUTO_UPDATE_FIELDS.get(fact.targetTable)?.has(fact.field)) {
    return { risk: "high", riskReason: "该字段不属于可自动提交的简单状态变化" };
  }
  return { risk: "safe", riskReason: "已有角色的明确状态变化" };
}

export async function storeFactCandidates(params: { projectId: string; workflowRunId: string; sourceArtifactId: string; sourceRevisionId?: string; defaultRevealedAt?: StoryPoint; facts: ExtractedFact[] }) {
  const candidates: FactCandidate[] = params.facts.map((fact) => {
    const normalized = { ...fact, confidence: Math.max(0, Math.min(1, fact.confidence)) };
    return {
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
      before: normalized.before,
      after: normalized.after,
      evidence: normalized.evidence,
      paragraph: normalized.paragraph,
      confidence: normalized.confidence,
      novelty: normalized.novelty,
      conflict: normalized.conflict,
      ...classifyFactRisk(normalized),
      status: "pending",
    };
  });
  await novelDb.factCandidates.bulkAdd(candidates);
  return candidates;
}

export async function setFactCandidateStatus(id: string, status: FactCandidate["status"]) {
  const candidate = await novelDb.factCandidates.get(id);
  if (!candidate) throw new Error("事实候选不存在");
  if (status === "accepted" && candidate.conflict) throw new Error("冲突事实不能直接采纳，请先修正或排除");
  const now = Date.now();
  await novelDb.factCandidates.update(id, { status, decisionSource: "author", decidedAt: now, revision: candidate.revision + 1, updatedAt: now });
}

/**
 * 批量变更事实候选状态，用于事实审核界面的一键操作。
 * - status=accepted 时自动跳过 conflict=true 的候选（冲突事实必须先单独处理）
 * - 已是目标状态的候选会被跳过
 * - 返回成功变更的候选 id 列表
 */
export async function bulkSetFactCandidateStatus(ids: string[], status: FactCandidate["status"]): Promise<string[]> {
  if (!ids.length) return [];
  const now = Date.now();
  const candidates = await novelDb.factCandidates.bulkGet(ids);
  const updates: Array<{ key: string; changes: Partial<FactCandidate> }> = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (status === "accepted" && candidate.conflict) continue;
    if (candidate.status === status) continue;
    updates.push({
      key: candidate.id,
      changes: {
        status,
        decisionSource: "author",
        decidedAt: now,
        revision: candidate.revision + 1,
        updatedAt: now,
      },
    });
  }
  if (updates.length) await novelDb.factCandidates.bulkUpdate(updates);
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

export async function autoAcceptSafeFactCandidates(candidates: FactCandidate[], enabled: boolean) {
  if (!enabled) return [];
  const safe = candidates.filter((candidate) => candidate.status === "pending" && candidate.risk === "safe" && !candidate.conflict);
  const now = Date.now();
  await novelDb.factCandidates.bulkPut(safe.map((candidate) => ({
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
    sourceArtifactId: candidate.sourceArtifactId,
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
export async function findExistingCharacter(projectId: string, name: string, aliases: string[]): Promise<StoryEntity | undefined> {
  const trimmedName = name.trim();
  const trimmedAliases = aliases.map((a) => String(a).trim()).filter(Boolean);
  if (!trimmedName) return undefined;
  return novelDb.entities
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
export async function dedupeCharacterFactCandidates(projectId: string, facts: ExtractedFact[]): Promise<{ facts: ExtractedFact[]; discardedCount: number }> {
  const kept: ExtractedFact[] = [];
  let discardedCount = 0;
  for (const fact of facts) {
    if (fact.novelty === "new" && fact.targetTable === "entities" && fact.field === "record") {
      const payload = fact.after as Record<string, unknown> | undefined;
      if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.kind === "character" && typeof payload.name === "string") {
        const name = String(payload.name).trim();
        const aliases = Array.isArray(payload.aliases) ? payload.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
        const existing = await findExistingCharacter(projectId, name, aliases);
        if (existing) { discardedCount += 1; continue; }
      }
    }
    kept.push(fact);
  }
  return { facts: kept, discardedCount };
}

export async function commitAcceptedFacts(projectId: string, workflowRunId: string) {
  const candidates = await novelDb.factCandidates.where("workflowRunId").equals(workflowRunId).and((item) => item.status === "accepted" && !item.conflict && item.novelty !== "duplicate" && !item.committedAt).toArray();
  const committed: string[] = [];
  for (const candidate of candidates) {
    if (!MUTABLE_TABLES.has(candidate.targetTable)) continue;
    const table = novelDb.table(candidate.targetTable);

    if (candidate.novelty === "new" && !candidate.targetId) {
      const payload = candidate.after as Record<string, unknown>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
      if (candidate.targetTable === "relations") {
        const fromId = String(payload.fromEntityId ?? "");
        const toId = String(payload.toEntityId ?? "");
        if (!fromId || !toId) continue;
        const existing = await novelDb.relations
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
        const existing = await findExistingCharacter(projectId, name, aliases);
        if (existing) continue;
      }
      const id = `${candidate.targetTable.slice(0, 3)}:${crypto.randomUUID()}`;
      const record = normalizedCreate(candidate.targetTable as ProposalTargetTable, projectId, id, payload);
      const assertion = candidateToFactAssertion(candidate, id);
      const knowledgeAssertions = knowledgeAssertionsForCandidate(candidate, assertion.id);
      const committedAt = Date.now();
      await novelDb.transaction("rw", table, novelDb.operations, novelDb.factAssertions, novelDb.knowledgeAssertions, novelDb.factCandidates, async () => {
        await table.put(record);
        await appendOperation(projectId, candidate.targetTable, id, "create", { _create: { before: null, after: payload } });
        await novelDb.factAssertions.put(assertion);
        if (knowledgeAssertions.length) await novelDb.knowledgeAssertions.bulkPut(knowledgeAssertions);
        await novelDb.factCandidates.update(candidate.id, { committedAssertionId: assertion.id, committedAt, updatedAt: committedAt, revision: candidate.revision + 1 });
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
    await novelDb.transaction("rw", table, novelDb.operations, novelDb.factAssertions, novelDb.knowledgeAssertions, novelDb.factCandidates, async () => {
      await table.put(next);
      await appendOperation(projectId, candidate.targetTable, targetId, "update", { [candidate.field]: { before: candidate.before, after: candidate.after } });
      await novelDb.factAssertions.put(assertion);
      if (knowledgeAssertions.length) await novelDb.knowledgeAssertions.bulkPut(knowledgeAssertions);
      await novelDb.factCandidates.update(candidate.id, { committedAssertionId: assertion.id, committedAt, updatedAt: committedAt, revision: candidate.revision + 1 });
    });
    committed.push(candidate.id);
  }
  return committed;
}

export async function createWorkflowSnapshot(params: { projectId: string; documentId: string; label: string; summary: string }) {
  const [entities, threads, previous] = await Promise.all([
    novelDb.entities.where("projectId").equals(params.projectId).toArray(),
    novelDb.plotThreads.where("projectId").equals(params.projectId).toArray(),
    novelDb.snapshots.where("projectId").equals(params.projectId).reverse().sortBy("createdAt").then((items) => items[0]),
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
  await novelDb.snapshots.add(snapshot);
  await novelDb.projects.update(params.projectId, { currentSnapshotId: snapshot.id, updatedAt: Date.now() });
  return snapshot;
}
