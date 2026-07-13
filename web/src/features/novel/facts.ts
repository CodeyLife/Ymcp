import { appendOperation, novelDb, recordBase } from "./db";
import type { FactCandidate, StorySnapshot } from "./types";

export interface ExtractedFact {
  targetTable: string;
  targetId?: string;
  field: string;
  before?: unknown;
  after: unknown;
  evidence: string;
  paragraph?: number;
  confidence: number;
  novelty: "new" | "update" | "duplicate";
  conflict: boolean;
}

const MUTABLE_TABLES = new Set(["projects", "entities", "relations", "outlineNodes", "plotThreads", "foreshadowing", "timelineEvents"]);

export async function storeFactCandidates(params: { projectId: string; workflowRunId: string; sourceArtifactId: string; facts: ExtractedFact[] }) {
  const candidates: FactCandidate[] = params.facts.map((fact) => ({
    ...recordBase(params.projectId),
    workflowRunId: params.workflowRunId,
    sourceArtifactId: params.sourceArtifactId,
    targetTable: fact.targetTable,
    targetId: fact.targetId,
    field: fact.field,
    before: fact.before,
    after: fact.after,
    evidence: fact.evidence,
    paragraph: fact.paragraph,
    confidence: Math.max(0, Math.min(1, fact.confidence)),
    novelty: fact.novelty,
    conflict: fact.conflict,
    status: "pending",
  }));
  await novelDb.factCandidates.bulkAdd(candidates);
  return candidates;
}

export async function setFactCandidateStatus(id: string, status: FactCandidate["status"]) {
  const candidate = await novelDb.factCandidates.get(id);
  if (!candidate) throw new Error("事实候选不存在");
  await novelDb.factCandidates.update(id, { status, revision: candidate.revision + 1, updatedAt: Date.now() });
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

export async function commitAcceptedFacts(projectId: string, workflowRunId: string) {
  const candidates = await novelDb.factCandidates.where("workflowRunId").equals(workflowRunId).and((item) => item.status === "accepted" && !item.conflict && item.novelty !== "duplicate").toArray();
  const committed: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.targetId || !MUTABLE_TABLES.has(candidate.targetTable)) continue;
    const table = novelDb.table(candidate.targetTable);
    const current = await table.get(candidate.targetId) as Record<string, unknown> | undefined;
    if (!current || current.projectId !== projectId) continue;
    const next = applyField(current, candidate.field, candidate.after);
    next.updatedAt = Date.now();
    next.updatedBy = "local-user";
    next.revision = Number(current.revision ?? 0) + 1;
    await novelDb.transaction("rw", table, novelDb.operations, async () => {
      await table.put(next);
      await appendOperation(projectId, candidate.targetTable, candidate.targetId!, "update", { [candidate.field]: { before: candidate.before, after: candidate.after } });
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
