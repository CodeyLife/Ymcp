import { novelDb, type NovelDatabase } from "./db";
import { RECORD_SCHEMA_VERSION } from "./db-schema";
import { cosineSimilarity, getEmbeddingProvider } from "./embedding";
import type { NovelEmbedding } from "./types";

const DEFAULT_SEMANTIC_UNIT_CHARS = 1800;

export function splitSemanticUnits(text: string, maxChars = DEFAULT_SEMANTIC_UNIT_CHARS): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  if (!paragraphs.length) return [];
  const units: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }
    if (current.length + 2 + paragraph.length <= maxChars) {
      current += `\n\n${paragraph}`;
      continue;
    }
    units.push(current);
    current = paragraph;
  }
  if (current) units.push(current);
  return units;
}

/**
 * FNV-1a 32 位内容哈希。
 * 与 context.ts source() 中的哈希算法一致，用于判断内容是否变化、决定是否需要重新生成 embedding。
 */
export function contentHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 为指定目标生成或更新 embedding。
 * - 通过 contentHash 判断内容是否变化，未变化则跳过，避免重复 API 调用
 * - 长文本按段落边界组成完整语义单元，单段不会在字段中间截断
 */
export async function upsertEmbedding(params: {
  projectId: string;
  targetTable: NovelEmbedding["targetTable"];
  targetId: string;
  content: string;
  db?: NovelDatabase;
}): Promise<void> {
  const db = params.db ?? novelDb;
  const units = splitSemanticUnits(params.content);
  const existing = await db.embeddings
    .where("[projectId+targetTable]")
    .equals([params.projectId, params.targetTable])
    .and((e) => e.targetId === params.targetId)
    .toArray();
  if (!units.length) {
    await db.embeddings.bulkDelete(existing.map((item) => item.id));
    return;
  }

  const provider = getEmbeddingProvider();
  const expectedIndexes: Array<number | undefined> = units.length === 1 ? [undefined] : units.map((_, index) => index);
  const existingByIndex = new Map(existing.map((item) => [item.chunkIndex, item]));
  const changed = units.map((content, index) => ({ content, chunkIndex: expectedIndexes[index], hash: contentHash(content), existing: existingByIndex.get(expectedIndexes[index]) }))
    .filter((item) => !item.existing || item.existing.contentHash !== item.hash || item.existing.model !== provider.name || item.existing.dimension !== provider.dimension);
  if (!changed.length && existing.length === units.length) return;
  const vectors = changed.length ? await provider.embedBatch(changed.map((item) => item.content)) : [];
  if (vectors.some((vector) => vector.length !== provider.dimension)) throw new Error(`embedding 维度与 provider 声明不一致：期望 ${provider.dimension}`);
  const now = Date.now();
  const next = changed.map((item, index): NovelEmbedding => ({
    id: item.existing?.id ?? crypto.randomUUID(), projectId: params.projectId, schemaVersion: RECORD_SCHEMA_VERSION,
    revision: (item.existing?.revision ?? 0) + 1, createdAt: item.existing?.createdAt ?? now, updatedAt: now,
    createdBy: "local-user", updatedBy: "local-user", targetTable: params.targetTable, targetId: params.targetId,
    model: provider.name, dimension: provider.dimension, vector: vectors[index], contentHash: item.hash, chunkIndex: item.chunkIndex,
  }));
  const retainedIds = new Set([...existing.filter((item) => !changed.some((change) => change.existing?.id === item.id)).map((item) => item.id), ...next.map((item) => item.id)]);
  await db.transaction("rw", db.embeddings, async () => {
    if (next.length) await db.embeddings.bulkPut(next);
    const staleIds = existing.filter((item) => !retainedIds.has(item.id) || !expectedIndexes.includes(item.chunkIndex)).map((item) => item.id);
    if (staleIds.length) await db.embeddings.bulkDelete(staleIds);
  });
}

/**
 * 向量检索：对项目内所有 embedding 计算与 query 的余弦相似度，返回 topK 结果。
 * 失败时抛错，由调用方（context.ts）catch 后降级为纯关键词检索。
 */
export async function vectorSearch(params: {
  projectId: string;
  targetTables?: NovelEmbedding["targetTable"][];
  query: string;
  topK?: number;
  db?: NovelDatabase;
}): Promise<Array<{ targetId: string; targetTable: NovelEmbedding["targetTable"]; chunkIndex?: number; score: number }>> {
  const provider = getEmbeddingProvider();
  const queryVec = await provider.embed(params.query);
  const db = params.db ?? novelDb;

  const all = await db.embeddings.where("projectId").equals(params.projectId).toArray();
  const compatible = all.filter((item) => item.model === provider.name && item.dimension === provider.dimension && item.vector.length === provider.dimension);
  const filtered = params.targetTables ? compatible.filter((e) => params.targetTables!.includes(e.targetTable)) : compatible;

  const scored = filtered.map((e) => ({
    targetId: e.targetId,
    targetTable: e.targetTable,
    chunkIndex: e.chunkIndex,
    score: cosineSimilarity(queryVec, e.vector),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, params.topK ?? 20);
}

/**
 * 混合评分：关键词分数与向量分数加权求和。
 * 默认向量权重更高（0.6），因为语义相关性在长篇创作中区分度更强。
 */
export function hybridScore(keywordScore: number, vectorScore: number, weights: { keyword: number; vector: number } = { keyword: 0.4, vector: 0.6 }): number {
  return weights.keyword * keywordScore + weights.vector * vectorScore;
}
