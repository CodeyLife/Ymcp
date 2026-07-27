export interface ModelUsage { model: string; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; }
export interface ModelGateway {
  generateText(input: { model: string; system?: string; prompt: string; maxTokens?: number }): Promise<{ text: string; usage: ModelUsage }>;
  generateStructured<T>(input: { model: string; system?: string; prompt: string; schema: unknown }): Promise<{ value: T; usage: ModelUsage }>;
  embed(input: { model: string; texts: string[] }): Promise<{ vectors: number[][]; usage: ModelUsage }>;
  rerank(input: { model: string; query: string; documents: string[] }): Promise<{ scores: number[]; usage: ModelUsage }>;
}

export class LiteLlmGateway implements ModelGateway {
  constructor(private readonly baseUrl = process.env.LITELLM_BASE_URL ?? "http://127.0.0.1:4000", private readonly apiKey = process.env.LITELLM_MASTER_KEY ?? "") {}
  private async request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`LiteLLM ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }
  async generateText(input: { model: string; system?: string; prompt: string; maxTokens?: number }) {
    const started = Date.now();
    const data = await this.request<any>("/v1/chat/completions", { model: input.model, messages: [{ role: "system", content: input.system ?? "" }, { role: "user", content: input.prompt }], max_tokens: input.maxTokens });
    return { text: data.choices?.[0]?.message?.content ?? "", usage: { model: input.model, inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0, costUsd: 0, latencyMs: Date.now() - started } };
  }
  async generateStructured<T>(input: { model: string; system?: string; prompt: string; schema: unknown }) { const result = await this.generateText({ ...input, prompt: `${input.prompt}\nReturn JSON matching this schema:\n${JSON.stringify(input.schema)}` }); return { value: JSON.parse(result.text) as T, usage: result.usage }; }
  async embed(input: { model: string; texts: string[] }) { const started = Date.now(); const data = await this.request<any>("/v1/embeddings", { model: input.model, input: input.texts }); return { vectors: (data.data ?? []).map((item: any) => item.embedding as number[]), usage: { model: input.model, inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: 0, costUsd: 0, latencyMs: Date.now() - started } }; }
  async rerank(input: { model: string; query: string; documents: string[] }) { const started = Date.now(); const data = await this.request<any>("/v1/rerank", { model: input.model, query: input.query, documents: input.documents }); return { scores: (data.results ?? []).map((item: any) => Number(item.relevance_score ?? 0)), usage: { model: input.model, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: Date.now() - started } }; }
}
