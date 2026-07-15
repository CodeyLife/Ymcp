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
    delete record.status;
    delete record.storyTime;
    delete record.tags;
    if (record.kind === "event" || !record.kind) {
      if ("characterIds" in record) record.characterIds = uniqueValidIds(record.characterIds, catalog.characterIds, preserveTemporaryRefs);
      if ("plotThreadIds" in record) record.plotThreadIds = uniqueValidIds(record.plotThreadIds, catalog.plotThreadIds, preserveTemporaryRefs);
      if ("foreshadowingIds" in record) record.foreshadowingIds = uniqueValidIds(record.foreshadowingIds, catalog.foreshadowingIds, preserveTemporaryRefs);
    } else {
      delete record.characterIds;
      delete record.plotThreadIds;
      delete record.foreshadowingIds;
    }
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

/**
 * 修复 LLM 凭空生成的无效角色 ID（问题 #9）。
 *
 * LLM 在生成大纲/场景/章节蓝图时，偶尔会凭空生成 UUID 格式的 characterIds，
 * 而不是使用 prompt 中注入的角色名→ID 映射表。此函数在 assertProposalReferences
 * 之前执行，对每个无效 ID：
 * 1. 尝试从 item 的 label/rationale/summary/title 文本中按角色名匹配，命中则替换为正确 ID
 * 2. 匹配不到则删除该 ID（避免 assertReference 抛错导致整个生成失败）
 *
 * 同步处理 povCharacterId 单值字段。
 */
export function repairProposalCharacterReferences(
  items: ProposalItem[],
  catalog: ProjectReferenceCatalog,
  characterNameToIdMap: Map<string, string>,
): { repaired: number; dropped: number } {
  if (!characterNameToIdMap.size) return { repaired: 0, dropped: 0 };
  // 按角色名长度降序匹配，避免短名（如"青衫"）匹配到长名（如"沈青衫"）的子串
  const sortedNames = [...characterNameToIdMap.keys()].sort((a, b) => b.length - a.length);
  let repaired = 0;
  let dropped = 0;

  const resolveByName = (item: ProposalItem): string | undefined => {
    const payload = item.after ?? item.payload;
    if (!payload || typeof payload !== "object") return undefined;
    const label = String(item.label || "");
    const rationale = String(item.rationale || "");
    const summary = String((payload as Record<string, unknown>).summary || "");
    const title = String((payload as Record<string, unknown>).title || "");
    const fullText = `${label} ${rationale} ${summary} ${title}`;
    for (const name of sortedNames) {
      if (fullText.includes(name)) return characterNameToIdMap.get(name);
    }
    return undefined;
  };

  for (const item of items) {
    if (item.operation === "delete") continue;
    const payload = item.after ?? item.payload;
    if (!payload || typeof payload !== "object") continue;
    const table = item.targetTable;

    // 处理 characterIds 数组字段（outlineNodes / scenes / documents.blueprint）
    const arrayTargets: Array<{ container: Record<string, unknown>; field: string }> = [];
    if (table === "outlineNodes" || table === "scenes") {
      if (Array.isArray(payload.characterIds)) arrayTargets.push({ container: payload, field: "characterIds" });
    }
    if (table === "documents" && payload.blueprint && typeof payload.blueprint === "object" && !Array.isArray(payload.blueprint)) {
      const blueprint = payload.blueprint as Record<string, unknown>;
      if (Array.isArray(blueprint.characterIds)) arrayTargets.push({ container: blueprint, field: "characterIds" });
    }

    for (const { container, field } of arrayTargets) {
      const arr = container[field] as unknown[];
      const fixed: string[] = [];
      for (const idRaw of arr) {
        const id = String(idRaw);
        if (id.startsWith("ref:") || catalog.characterIds.has(id)) {
          fixed.push(id);
          continue;
        }
        const resolved = resolveByName(item);
        if (resolved) {
          fixed.push(resolved);
          repaired++;
        } else {
          dropped++;
        }
      }
      container[field] = fixed;
    }

    // 处理 povCharacterId 单值字段（scenes / documents.blueprint）
    const optionalTargets: Array<{ container: Record<string, unknown>; field: string }> = [];
    if (table === "scenes" && typeof payload.povCharacterId === "string") {
      optionalTargets.push({ container: payload, field: "povCharacterId" });
    }
    if (table === "documents" && payload.blueprint && typeof payload.blueprint === "object" && !Array.isArray(payload.blueprint)) {
      const blueprint = payload.blueprint as Record<string, unknown>;
      if (typeof blueprint.povCharacterId === "string") {
        optionalTargets.push({ container: blueprint, field: "povCharacterId" });
      }
    }
    for (const { container, field } of optionalTargets) {
      const id = String(container[field]);
      if (id.startsWith("ref:") || catalog.characterIds.has(id)) continue;
      const resolved = resolveByName(item);
      if (resolved) {
        container[field] = resolved;
        repaired++;
      } else {
        delete container[field];
        dropped++;
      }
    }

    // Loop 6 修复 #12：处理 participantIds 数组字段（plotThreads / timelineEvents）
    // participantIds 接受 entity ID（角色是 entity 的子集），LLM 可能凭空生成不存在的 UUID
    if (table === "plotThreads" || table === "timelineEvents") {
      if (Array.isArray(payload.participantIds)) {
        const fixedParticipants: string[] = [];
        for (const idRaw of payload.participantIds) {
          const id = String(idRaw);
          if (id.startsWith("ref:") || catalog.entityIds.has(id)) {
            fixedParticipants.push(id);
            continue;
          }
          // 尝试按角色名匹配（角色是 entity 的子集，participantIds 接受 entity ID）
          const resolved = resolveByName(item);
          if (resolved) {
            fixedParticipants.push(resolved);
            repaired++;
          } else {
            dropped++;
          }
        }
        payload.participantIds = fixedParticipants;
      }
    }
  }
  return { repaired, dropped };
}

/**
 * 修复 LLM 自行发明的 ref: 标识（问题 #13）。
 *
 * prompt 已明确禁止"不得自行发明 ref: 标识"，但 LLM 偶尔仍会生成形如
 * ref:tempId_system_jianxiu 的引用，而对应的 tempId 从未在任何候选项中定义。
 * 这会导致 applyProposalItems 中 resolveReferences 抛错，整个提案无法采纳。
 *
 * 此函数在 assertProposalReferences 之前执行：
 * 1. 收集当前提案中所有已定义的 tempId
 * 2. 递归扫描所有 payload 字段中的 ref:* 字符串
 * 3. 对无法解析的 ref：
 *    a. 尝试按名称匹配现有实体（从 ref 字符串中提取名称提示）
 *    b. 匹配不到则删除该字段（数组中移除，单值字段设为 undefined）
 * 4. 对 relations 表，若 fromEntityId/toEntityId 修复后仍为空，丢弃整个 item
 */
export function repairUnresolvableTempRefs(
  items: ProposalItem[],
  acceptedRefs: Map<string, string>,
  entityNameToIdMap: Map<string, string>,
): { repaired: number; dropped: number; droppedItems: number } {
  const definedTempIds = new Set<string>();
  for (const item of items) {
    if (item.tempId) definedTempIds.add(item.tempId);
  }

  let repaired = 0;
  let dropped = 0;
  let droppedItems = 0;

  const tryNameMatch = (refAlias: string): string | undefined => {
    // 从 ref:tempId_system_jianxiu 中提取名称提示
    const hint = refAlias.replace(/^tempId_/, "").replace(/_/g, "");
    if (!hint) return undefined;
    // 按实体名长度降序匹配，避免短名误匹配
    const sortedNames = [...entityNameToIdMap.keys()].sort((a, b) => b.length - a.length);
    for (const name of sortedNames) {
      // 中文名或英文名包含 hint，或 hint 包含中文名的拼音近似
      const nameClean = name.replace(/\s/g, "");
      if (nameClean.includes(hint) || hint.includes(nameClean)) {
        return entityNameToIdMap.get(name);
      }
    }
    return undefined;
  };

  const repairValue = (value: unknown): unknown => {
    if (typeof value === "string" && value.startsWith("ref:")) {
      const alias = value.slice(4);
      // 已定义的 tempId 或已采纳的别名——保留
      if (definedTempIds.has(alias) || acceptedRefs.has(alias)) return value;
      // 尝试按名称匹配
      const matched = tryNameMatch(alias);
      if (matched) {
        repaired++;
        return matched;
      }
      dropped++;
      return undefined;
    }
    if (Array.isArray(value)) {
      // 保留空数组（如 inventory: []、abilities: []），只过滤 unresolvable ref
      // 仅当原数组非空且修复后全部被过滤时，才返回 undefined（表示所有元素都是无效 ref）
      if (value.length === 0) return value;
      const fixed = value.map(repairValue).filter((v) => v !== undefined);
      return fixed.length ? fixed : undefined;
    }
    if (value && typeof value === "object") {
      const fixed: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) {
        const repaired = repairValue(v);
        if (repaired !== undefined) fixed[key] = repaired;
      }
      return Object.keys(fixed).length ? fixed : undefined;
    }
    return value;
  };

  const survivingItems: ProposalItem[] = [];
  for (const item of items) {
    if (item.operation === "delete") {
      survivingItems.push(item);
      continue;
    }
    const payload = item.after ?? item.payload;
    if (!payload || typeof payload !== "object") {
      survivingItems.push(item);
      continue;
    }

    const repairedPayload = repairValue(payload) as Record<string, unknown>;
    if (!repairedPayload) {
      // 整个 payload 修复后为空——丢弃
      droppedItems++;
      continue;
    }

    // relations 表特殊处理：fromEntityId/toEntityId 修复后必须存在
    if (item.targetTable === "relations") {
      if (!repairedPayload.fromEntityId || !repairedPayload.toEntityId) {
        droppedItems++;
        continue;
      }
    }

    // 写回修复后的 payload
    if (item.after) {
      item.after = repairedPayload;
    } else {
      item.payload = repairedPayload;
    }
    survivingItems.push(item);
  }

  // 原地替换 items 数组，保持外部引用
  items.length = 0;
  items.push(...survivingItems);

  return { repaired, dropped, droppedItems };
}
