import { getNovelApiConfig } from "./api-config";
import { endpoint } from "./ai";
import { LocalEmbeddingProvider } from "./embedding-local";

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
 *
 * 当 baseUrl 指向的代理不支持 /embeddings 端点（如某些只转发 chat/completions 的中转代理，
 * 返回 405 Method Not Allowed）时，自动标记为不可用，后续调用直接抛错。
 * 上游（context.ts 的 vectorSearch、db.ts 的 upsertEmbedding）均有 .catch() 降级为关键词检索，
 * 因此 embedding 不可用不会阻塞核心流程，只是向量检索功能失效。
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  name = "openai-text-embedding-3-small";
  dimension = 1536;
  // 一旦检测到端点不可用（405/404），标记为永久禁用，避免每次调用都发请求刷错误日志。
  // 进程生命周期内不会重试；用户切换 baseUrl 后需刷新页面重置。
  private disabled = false;
  private disabledReason = "";

  async embed(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (this.disabled) throw new Error(`embedding 不可用：${this.disabledReason}`);
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
    // 405/404 表示端点根本不存在（常见于只转发 chat/completions 的中转代理），
    // 重试无意义，直接禁用 provider 让上游降级为关键词检索。
    if (resp.status === 405 || resp.status === 404) {
      this.disabled = true;
      this.disabledReason = `API 端点返回 ${resp.status}（${resp.status === 405 ? "Method Not Allowed" : "Not Found"}），当前 baseUrl 不支持 /embeddings`;
      throw new Error(this.disabledReason);
    }
    if (!resp.ok) throw new Error(`embedding 请求失败：${resp.status} ${await resp.text().catch(() => "")}`);
    const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((item) => item.embedding);
  }
}

/**
 * 默认 provider 选择策略：
 * - 默认使用 LocalEmbeddingProvider（基于 transformers.js 的本地模型，不依赖中转代理）
 * - 当用户显式设置 embeddingBaseUrl 时（如配置了支持 /v1/embeddings 的代理），改用 OpenAIEmbeddingProvider
 * - 测试代码可通过 setEmbeddingProvider 注入 mock
 *
 * 历史背景：原默认走 OpenAIEmbeddingProvider，但项目默认 baseUrl 是中转代理
 * 该代理只转发 /v1/chat/completions 不转发 /v1/embeddings，导致 405 后向量检索长期失效。
 * 切换为本地 provider 后，向量检索与 LLM 调用解耦，不再受代理能力限制。
 */
let provider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!provider) provider = new LocalEmbeddingProvider();
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
