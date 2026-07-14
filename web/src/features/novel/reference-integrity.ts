import type { ProposalItem, ProposalTargetTable } from "./types";

type ReferenceKind = "entity" | "character" | "plotThread" | "foreshadowing";

export interface ProjectReferenceCatalog {
  entityIds: Set<string>;
  characterIds: Set<string>;
  plotThreadIds: Set<string>;
  foreshadowingIds: Set<string>;
}

type ReferenceRecord = { id?: unknown; projectId?: unknown; kind?: unknown };

export function emptyReferenceCatalog(): ProjectReferenceCatalog {
  return {
    entityIds: new Set(),
    characterIds: new Set(),
    plotThreadIds: new Set(),
    foreshadowingIds: new Set(),
  };
}

export function buildProjectReferenceCatalogs(
  entities: ReferenceRecord[],
  plotThreads: ReferenceRecord[],
  foreshadowing: ReferenceRecord[],
) {
  const catalogs = new Map<string, ProjectReferenceCatalog>();
  const get = (projectId: unknown) => {
    const id = String(projectId ?? "");
    const existing = catalogs.get(id);
    if (existing) return existing;
    const created = emptyReferenceCatalog();
    catalogs.set(id, created);
    return created;
  };
  for (const entity of entities) {
    const id = String(entity.id ?? "");
    if (!id) continue;
    const catalog = get(entity.projectId);
    catalog.entityIds.add(id);
    if (entity.kind === "character") catalog.characterIds.add(id);
  }
  for (const thread of plotThreads) {
    const id = String(thread.id ?? "");
    if (id) get(thread.projectId).plotThreadIds.add(id);
  }
  for (const clue of foreshadowing) {
    const id = String(clue.id ?? "");
    if (id) get(clue.projectId).foreshadowingIds.add(id);
  }
  return catalogs;
}

function idsFor(catalog: ProjectReferenceCatalog, kind: ReferenceKind) {
  if (kind === "entity") return catalog.entityIds;
  if (kind === "character") return catalog.characterIds;
  if (kind === "plotThread") return catalog.plotThreadIds;
  return catalog.foreshadowingIds;
}

function uniqueValidIds(value: unknown, valid: Set<string>, preserveTemporaryRefs: boolean) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter((id) => valid.has(id) || (preserveTemporaryRefs && id.startsWith("ref:"))))];
}

function validOptionalId(value: unknown, valid: Set<string>, preserveTemporaryRefs: boolean) {
  if (typeof value !== "string" || !value) return undefined;
  return valid.has(value) || (preserveTemporaryRefs && value.startsWith("ref:")) ? value : undefined;
}

export function sanitizeReferenceRecordInPlace(
  table: ProposalTargetTable,
  record: Record<string, unknown>,
  catalog: ProjectReferenceCatalog,
  preserveTemporaryRefs = false,
) {
  if (table === "outlineNodes") {
    delete record.tension;
    delete record.emotion;
    delete record.information;
    if ("characterIds" in record) record.characterIds = uniqueValidIds(record.characterIds, catalog.characterIds, preserveTemporaryRefs);
    if ("plotThreadIds" in record) record.plotThreadIds = uniqueValidIds(record.plotThreadIds, catalog.plotThreadIds, preserveTemporaryRefs);
    if ("foreshadowingIds" in record) record.foreshadowingIds = uniqueValidIds(record.foreshadowingIds, catalog.foreshadowingIds, preserveTemporaryRefs);
  }
  if (table === "scenes") {
    if ("characterIds" in record) record.characterIds = uniqueValidIds(record.characterIds, catalog.characterIds, preserveTemporaryRefs);
    if ("plotThreadIds" in record) record.plotThreadIds = uniqueValidIds(record.plotThreadIds, catalog.plotThreadIds, preserveTemporaryRefs);
    if ("foreshadowingIds" in record) record.foreshadowingIds = uniqueValidIds(record.foreshadowingIds, catalog.foreshadowingIds, preserveTemporaryRefs);
    if ("povCharacterId" in record) record.povCharacterId = validOptionalId(record.povCharacterId, catalog.characterIds, preserveTemporaryRefs);
  }
  if (table === "documents" && record.blueprint && typeof record.blueprint === "object" && !Array.isArray(record.blueprint)) {
    const blueprint = { ...(record.blueprint as Record<string, unknown>) };
    if ("characterIds" in blueprint) blueprint.characterIds = uniqueValidIds(blueprint.characterIds, catalog.characterIds, preserveTemporaryRefs);
    if ("povCharacterId" in blueprint) blueprint.povCharacterId = validOptionalId(blueprint.povCharacterId, catalog.characterIds, preserveTemporaryRefs);
    record.blueprint = blueprint;
  }
  if ((table === "plotThreads" || table === "timelineEvents") && "participantIds" in record) {
    record.participantIds = uniqueValidIds(record.participantIds, catalog.entityIds, preserveTemporaryRefs);
  }
  return record;
}

export function sanitizeProposalReferencesInPlace(proposal: Record<string, unknown>, catalog: ProjectReferenceCatalog) {
  if (!Array.isArray(proposal.items)) return proposal;
  for (const entry of proposal.items) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const table = item.targetTable as ProposalTargetTable;
    for (const key of ["payload", "before", "after"] as const) {
      const value = item[key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        sanitizeReferenceRecordInPlace(table, value as Record<string, unknown>, catalog, true);
      }
    }
  }
  return proposal;
}

function referenceKindsForItem(item: ProposalItem) {
  const kinds = new Set<ReferenceKind>();
  const payload = item.after ?? item.payload;
  if (item.operation !== "create") return kinds;
  if (item.targetTable === "entities") {
    kinds.add("entity");
    if (payload.kind === "character") kinds.add("character");
  }
  if (item.targetTable === "plotThreads") kinds.add("plotThread");
  if (item.targetTable === "foreshadowing") kinds.add("foreshadowing");
  return kinds;
}

function candidateTempReferences(items: ProposalItem[]) {
  const refs = new Map<string, Set<ReferenceKind>>();
  for (const item of items) if (item.tempId) refs.set(item.tempId, referenceKindsForItem(item));
  return refs;
}

function assertReference(
  item: ProposalItem,
  field: string,
  value: string,
  kind: ReferenceKind,
  catalog: ProjectReferenceCatalog,
  tempRefs: Map<string, Set<ReferenceKind>>,
  aliases: Map<string, string>,
) {
  let valid = false;
  if (value.startsWith("ref:")) {
    const alias = value.slice(4);
    const resolved = aliases.get(alias);
    valid = resolved ? idsFor(catalog, kind).has(resolved) : Boolean(tempRefs.get(alias)?.has(kind));
  } else {
    valid = idsFor(catalog, kind).has(value);
  }
  if (!valid) throw new Error(`候选项“${item.label}”的 ${field} 包含不存在或类型不匹配的 ID：${value}`);
}

function assertArrayField(
  item: ProposalItem,
  payload: Record<string, unknown>,
  field: string,
  kind: ReferenceKind,
  catalog: ProjectReferenceCatalog,
  tempRefs: Map<string, Set<ReferenceKind>>,
  aliases: Map<string, string>,
) {
  const value = payload[field];
  if (value === undefined) return;
  if (!Array.isArray(value)) return;
  for (const id of value.map(String)) assertReference(item, field, id, kind, catalog, tempRefs, aliases);
}

function assertOptionalField(
  item: ProposalItem,
  payload: Record<string, unknown>,
  field: string,
  kind: ReferenceKind,
  catalog: ProjectReferenceCatalog,
  tempRefs: Map<string, Set<ReferenceKind>>,
  aliases: Map<string, string>,
) {
  const value = payload[field];
  if (value === undefined) return;
  if (typeof value !== "string") return;
  assertReference(item, field, value, kind, catalog, tempRefs, aliases);
}

function assertPayloadReferences(
  item: ProposalItem,
  payload: Record<string, unknown>,
  catalog: ProjectReferenceCatalog,
  tempRefs: Map<string, Set<ReferenceKind>>,
  aliases: Map<string, string>,
) {
  if (item.targetTable === "outlineNodes" || item.targetTable === "scenes") {
    assertArrayField(item, payload, "characterIds", "character", catalog, tempRefs, aliases);
    assertArrayField(item, payload, "plotThreadIds", "plotThread", catalog, tempRefs, aliases);
    assertArrayField(item, payload, "foreshadowingIds", "foreshadowing", catalog, tempRefs, aliases);
  }
  if (item.targetTable === "scenes") assertOptionalField(item, payload, "povCharacterId", "character", catalog, tempRefs, aliases);
  if (item.targetTable === "documents" && payload.blueprint && typeof payload.blueprint === "object" && !Array.isArray(payload.blueprint)) {
    const blueprint = payload.blueprint as Record<string, unknown>;
    assertArrayField(item, blueprint, "characterIds", "character", catalog, tempRefs, aliases);
    assertOptionalField(item, blueprint, "povCharacterId", "character", catalog, tempRefs, aliases);
  }
  if (item.targetTable === "plotThreads" || item.targetTable === "timelineEvents") {
    assertArrayField(item, payload, "participantIds", "entity", catalog, tempRefs, aliases);
  }
}

export function assertProposalReferences(
  items: ProposalItem[],
  catalog: ProjectReferenceCatalog,
  aliases = new Map<string, string>(),
) {
  const tempRefs = candidateTempReferences(items);
  for (const item of items) {
    if (item.operation === "delete") continue;
    assertPayloadReferences(item, item.after ?? item.payload, catalog, tempRefs, aliases);
  }
}

export function catalogWithResolvedProposalItems(
  catalog: ProjectReferenceCatalog,
  items: ProposalItem[],
  resolvedIds: Map<string, string>,
) {
  const extended: ProjectReferenceCatalog = {
    entityIds: new Set(catalog.entityIds),
    characterIds: new Set(catalog.characterIds),
    plotThreadIds: new Set(catalog.plotThreadIds),
    foreshadowingIds: new Set(catalog.foreshadowingIds),
  };
  for (const item of items) {
    if (item.operation !== "create" || !item.tempId) continue;
    const id = resolvedIds.get(item.tempId);
    if (!id) continue;
    const kinds = referenceKindsForItem(item);
    if (kinds.has("entity")) extended.entityIds.add(id);
    if (kinds.has("character")) extended.characterIds.add(id);
    if (kinds.has("plotThread")) extended.plotThreadIds.add(id);
    if (kinds.has("foreshadowing")) extended.foreshadowingIds.add(id);
  }
  return extended;
}

export function assertResolvedPayloadReferences(
  item: ProposalItem,
  payload: Record<string, unknown>,
  catalog: ProjectReferenceCatalog,
) {
  assertPayloadReferences(item, payload, catalog, new Map(), new Map());
}
