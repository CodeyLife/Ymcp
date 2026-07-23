import { getNovelApiConfig } from "./api-config";
import { endpoint } from "./ai";

/**
 * Embedding 提供者接口：抽象向量生成能力，便于切换不同后端（OpenAI / 本地模型）。
 */
export interface EmbeddingProvider {
  name: string;
  dimension: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * OpenAI 兼容 embedding provider。
 * 复用 ai.ts 的 endpoint() 处理开发环境代理，与 LLM 调用共享 baseUrl/apiKey 配置。
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  name = "openai-text-embedding-3-small";
  dimension = 1536;

  async embed(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const config = getNovelApiConfig();
    if (!config.apiKey) throw new Error("请先在设置中配置 API Key");
    const resp = await fetch(`${endpoint(config.baseUrl)}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: texts,
      }),
    });
    if (!resp.ok) throw new Error(`embedding 请求失败：${resp.status} ${await resp.text().catch(() => "")}`);
    const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((item) => item.embedding);
  }
}

// TODO P2: 实现 LocalEmbeddingProvider（基于 transformers.js 的本地模型，离线场景使用）

let provider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!provider) provider = new OpenAIEmbeddingProvider();
  return provider;
}

export function setEmbeddingProvider(p: EmbeddingProvider): void {
  provider = p;
}

/**
 * 余弦相似度：衡量两向量的方向一致性，范围 [-1, 1]。
 * 用于上下文检索时对候选源按语义相关性排序。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
