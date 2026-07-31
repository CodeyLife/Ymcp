import { canonicalJson, canonicalSha256 } from "../canonical-json";
import type { FactExtractionOutput } from "../prompts/schemas";

type Fact = FactExtractionOutput["facts"][number];

export function normalizeFactToken(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

const PRESET_PREDICATE_ALIASES: ReadonlyArray<readonly [canonical: string, aliases: ReadonlySet<string>]> = [
  ["持有", new Set(["持有", "拥有", "携带", "保管", "握有", "持有物品", "拥有物品", "发现并持有", "识海中拥有"])],
  ["位于", new Set(["位于", "身处", "所在地为", "抵达地点"])],
  ["知晓", new Set(["知道", "知晓", "得知", "获知", "意识到"])],
  ["隶属", new Set(["隶属", "隶属于", "属于", "所属组织"])],
  ["给予", new Set(["给予", "赠予", "交付", "给予物品"])],
  ["状态变化", new Set(["状态变化", "出现反应", "产生反应", "发生异动"])],
];

/** Normalize common relation wording while preserving project-specific predicates. */
export function canonicalizeFactPredicate(value: string): string {
  const normalized = normalizeFactToken(value);
  for (const [canonical, aliases] of PRESET_PREDICATE_ALIASES) {
    if (aliases.has(normalized)) return canonical;
  }
  return normalized;
}

function normalizeFactValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeFactToken(value);
  if (Array.isArray(value)) return value.map(normalizeFactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeFactValue(item)]));
  }
  return value;
}

export function factIdentityPayload(fact: Fact): Record<string, unknown> {
  return {
    subject: { kind: fact.subject.kind, id: normalizeFactToken(fact.subject.id) },
    predicate: canonicalizeFactPredicate(fact.predicate),
    knowledgeScope: "author",
  };
}

export function factValuePayload(fact: Fact): Record<string, unknown> {
  return {
    ...factIdentityPayload(fact),
    object: { kind: fact.object.kind, value: normalizeFactValue(fact.object.value) },
    polarity: fact.polarity,
    truthStatus: fact.truthStatus,
  };
}

export function factIdentityHash(fact: Fact): string {
  return canonicalSha256(factIdentityPayload(fact));
}

export function factValueHash(fact: Fact): string {
  return canonicalSha256(factValuePayload(fact));
}

export function factCanonicalValue(fact: Fact): string {
  return canonicalJson(factValuePayload(fact));
}
