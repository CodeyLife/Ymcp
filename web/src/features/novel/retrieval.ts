import { novelDb } from "./db";
import { RECORD_SCHEMA_VERSION } from "./db-schema";
import { cosineSimilarity, getEmbeddingProvider } from "./embedding";
import type { NovelEmbedding } from "./types";

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
 * - 整文生成（chunkIndex 为 undefined），长文本分块作为 TODO P2
 */
export async function upsertEmbedding(params: {
  projectId: string;
  targetTable: NovelEmbedding["targetTable"];
  targetId: string;
  content: string;
}): Promise<void> {
  const hash = contentHash(params.content);
  const existing = await novelDb.embeddings
    .where("[projectId+targetTable]")
    .equals([params.projectId, params.targetTable])
    .and((e) => e.targetId === params.targetId && e.chunkIndex === undefined)
    .first();
  if (existing && existing.contentHash === hash) return;

  const provider = getEmbeddingProvider();
  const vector = await provider.embed(params.content);
  const now = Date.now();
  const id = existing?.id ?? crypto.randomUUID();
  await novelDb.embeddings.put({
    id,
    projectId: params.projectId,
    schemaVersion: RECORD_SCHEMA_VERSION,
    revision: (existing?.revision ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    createdBy: "local-user",
    updatedBy: "local-user",
    targetTable: params.targetTable,
    targetId: params.targetId,
    model: provider.name,
    dimension: provider.dimension,
    vector,
    contentHash: hash,
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
}): Promise<Array<{ targetId: string; targetTable: NovelEmbedding["targetTable"]; score: number }>> {
  const provider = getEmbeddingProvider();
  const queryVec = await provider.embed(params.query);

  const all = await novelDb.embeddings.where("projectId").equals(params.projectId).toArray();
  const filtered = params.targetTables
    ? all.filter((e) => params.targetTables!.includes(e.targetTable))
    : all;

  const scored = filtered.map((e) => ({
    targetId: e.targetId,
    targetTable: e.targetTable,
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
