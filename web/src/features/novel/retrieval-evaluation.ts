import MiniSearch from "minisearch";

export interface LexicalRetrievalUnit {
  id: string;
  title: string;
  content: string;
  aliases: string[];
}

export function tokenizeNovelSearch(text: string): string[] {
  const segments = text.toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]+/g) ?? [];
  return [...new Set(segments.flatMap((segment) => {
    if (!/[\u3400-\u9fff]/.test(segment) || segment.length <= 2) return [segment];
    return [segment, ...Array.from({ length: segment.length - 1 }, (_, index) => segment.slice(index, index + 2))];
  }))];
}

export function rankLexicalUnits(query: string, units: LexicalRetrievalUnit[]): string[] {
  if (!query.trim() || !units.length) return [];
  const index = new MiniSearch<LexicalRetrievalUnit>({
    fields: ["title", "content", "aliases"],
    storeFields: ["id"],
    idField: "id",
    tokenize: tokenizeNovelSearch,
    searchOptions: { prefix: true, fuzzy: 0.18, boost: { title: 3, aliases: 4 } },
  });
  index.addAll(units);
  return index.search(query).map((result) => String(result.id));
}

export function retrievalRecallAtK(params: { cases: Array<{ query: string; relevantIds: string[] }>; units: LexicalRetrievalUnit[]; k: number }) {
  if (!params.cases.length) return 1;
  const recalls = params.cases.map((item) => {
    const returned = new Set(rankLexicalUnits(item.query, params.units).slice(0, params.k));
    const relevant = new Set(item.relevantIds);
    return [...relevant].filter((id) => returned.has(id)).length / Math.max(1, relevant.size);
  });
  return recalls.reduce((sum, value) => sum + value, 0) / recalls.length;
}
