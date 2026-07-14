import { appendOperation, novelDb, recordBase } from "./db";
import { normalizedCreate } from "./generation";
import type { FactAssertion, FactKnowledgeDelta, FactObjectValue, FactSubjectKind, FactCandidate, FactTimeMode, FactTruthStatus, ProposalTargetTable, StoryPoint, StorySnapshot } from "./types";

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
