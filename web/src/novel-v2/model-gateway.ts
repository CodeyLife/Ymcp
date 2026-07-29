import { createHash } from "node:crypto";
import Ajv, { type AnySchema, type ValidateFunction } from "ajv";
import { ModelConfigStore } from "./model-config-store";
import {
  ExternalMcpRequiredError,
  type ModelExecutionProvenance,
  type ModelProviderProfile,
  type ModelPurpose,
  type ModelRoute,
  type ModelRoutingSnapshot,
  resolveProfileSecret,
  resolveRoute,
} from "./model-routing";

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface ModelResult<T> {
  value: T;
  usage: ModelUsage;
  provenance: ModelExecutionProvenance;
}

interface BaseModelInput {
  purpose: ModelPurpose;
  system?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  routingSnapshot?: ModelRoutingSnapshot;
  previousResponseId?: string;
  previousProfileId?: string;
  candidateStartIndex?: number;
  workflowRunId?: string;
  taskId?: string;
}

export interface GenerateTextInput extends BaseModelInput { prompt: string }
export interface GenerateStructuredInput<T> extends BaseModelInput {
  prompt: string;
  schema: Record<string, unknown>;
  schemaName?: string;
  maxRepairAttempts?: number;
  __type?: T;
}

export interface ModelGateway {
  getRoutingSnapshot(): ModelRoutingSnapshot;
  generateText(input: GenerateTextInput): Promise<ModelResult<string> & { text: string }>;
  generateStructured<T>(input: GenerateStructuredInput<T>): Promise<ModelResult<T>>;
  embed(input: { purpose: "memory.embed"; texts: string[]; signal?: AbortSignal; routingSnapshot?: ModelRoutingSnapshot; workflowRunId?: string; taskId?: string }): Promise<ModelResult<number[][]> & { vectors: number[][] }>;
  rerank(input: { purpose: "memory.rerank"; query: string; documents: string[]; signal?: AbortSignal; routingSnapshot?: ModelRoutingSnapshot; workflowRunId?: string; taskId?: string }): Promise<ModelResult<number[]> & { scores: number[] }>;
}

export interface ModelInvocationAudit {
  workflowRunId?: string;
  taskId?: string;
  purpose: ModelPurpose;
  configRevision: string;
  candidateIndex: number;
  executor: "api" | "external-mcp";
  profileId?: string;
  protocol?: string;
  model: string;
  status: "completed" | "failed" | "waiting-external";
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  promptFingerprint: string;
  responseId?: string;
  errorCategory?: string;
}

export type ModelInvocationRecorder = (audit: ModelInvocationAudit) => Promise<void>;

interface TransportResponse {
  text: string;
  responseId?: string;
  inputTokens: number;
  outputTokens: number;
}

interface TransportRequest {
  profile: ModelProviderProfile;
  model: string;
  system?: string;
  prompt: string;
  schema?: Record<string, unknown>;
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
  previousResponseId?: string;
  signal?: AbortSignal;
}

class ModelTransportError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly category: string, readonly status?: number) {
    super(message);
    // Temporal only serializes the error type, not arbitrary custom fields.
    // Give exhausted/non-retryable failures a distinct type so workflow retry
    // policies can avoid repeating an already completed repair loop.
    this.name = retryable ? "ModelTransportError" : "NonRetryableModelTransportError";
  }
}

function promptFingerprint(system: string | undefined, prompt: string): string {
  return createHash("sha256").update(`${system ?? ""}\n${prompt}`).digest("hex");
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function readHttpError(response: Response): Promise<never> {
  const body = await response.text().catch(() => "");
  const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
  throw new ModelTransportError(`模型服务 HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`, retryable, `http-${response.status}`, response.status);
}

function authorization(profile: ModelProviderProfile): HeadersInit {
  const secret = resolveProfileSecret(profile);
  return { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) };
}

function parseChatJson(data: Record<string, unknown>): TransportResponse {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const text = typeof first?.message?.content === "string" ? first.message.content : "";
  return {
    text,
    responseId: typeof data.id === "string" ? data.id : undefined,
    inputTokens: Number(usage.prompt_tokens ?? 0),
    outputTokens: Number(usage.completion_tokens ?? 0),
  };
}

async function parseChatSse(response: Response): Promise<TransportResponse> {
  if (!response.body) throw new ModelTransportError("Chat SSE 响应缺少 body", true, "empty-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let responseId: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  const consume = (line: string) => {
    const raw = line.replace(/^data:\s*/, "").trim();
    if (!raw || raw === "[DONE]") return;
    try {
      const event = JSON.parse(raw) as Record<string, unknown>;
      if (typeof event.id === "string") responseId = event.id;
      const choices = Array.isArray(event.choices) ? event.choices : [];
      const first = choices[0] as { delta?: { content?: unknown } } | undefined;
      if (typeof first?.delta?.content === "string") text += first.delta.content;
      const usage = (event.usage ?? {}) as Record<string, unknown>;
      inputTokens = Number(usage.prompt_tokens ?? inputTokens);
      outputTokens = Number(usage.completion_tokens ?? outputTokens);
    } catch { /* Ignore provider keepalive and non-JSON SSE lines. */ }
  };
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith("data:")) consume(line);
    if (chunk.done) break;
  }
  if (buffer.startsWith("data:")) consume(buffer);
  return { text, responseId, inputTokens, outputTokens };
}

async function requestChatCompletions(input: TransportRequest): Promise<TransportResponse> {
  const stream = input.profile.responseMode === "sse";
  const body: Record<string, unknown> = {
    model: input.model,
    messages: [
      ...(input.system ? [{ role: "system", content: input.system }] : []),
      { role: "user", content: input.prompt },
    ],
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };
  if (input.maxTokens) body.max_tokens = input.maxTokens;
  if (typeof input.temperature === "number") body.temperature = input.temperature;
  if (input.schema) body.response_format = { type: "json_schema", json_schema: { name: input.schemaName ?? "model_output", strict: true, schema: input.schema } };
  let response: Response;
  try {
    response = await fetch(endpoint(input.profile.baseUrl, "chat/completions"), { method: "POST", headers: authorization(input.profile), body: JSON.stringify(body), signal: input.signal });
  } catch (error) {
    throw new ModelTransportError(error instanceof Error ? error.message : String(error), true, "network");
  }
  if (!response.ok) return readHttpError(response);
  return stream ? parseChatSse(response) : parseChatJson(await response.json() as Record<string, unknown>);
}

function parseResponsesJson(data: Record<string, unknown>): TransportResponse {
  let text = typeof data.output_text === "string" ? data.output_text : "";
  if (!text && Array.isArray(data.output)) {
    for (const item of data.output as Array<Record<string, unknown>>) {
      if (!Array.isArray(item.content)) continue;
      for (const content of item.content as Array<Record<string, unknown>>) {
        if (typeof content.text === "string") text += content.text;
      }
    }
  }
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  return {
    text,
    responseId: typeof data.id === "string" ? data.id : undefined,
    inputTokens: Number(usage.input_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
  };
}

async function requestResponses(input: TransportRequest): Promise<TransportResponse> {
  const body: Record<string, unknown> = { model: input.model, input: input.prompt };
  if (input.system) body.instructions = input.system;
  if (input.previousResponseId) body.previous_response_id = input.previousResponseId;
  if (input.maxTokens) body.max_output_tokens = input.maxTokens;
  if (typeof input.temperature === "number") body.temperature = input.temperature;
  if (input.schema) body.text = { format: { type: "json_schema", name: input.schemaName ?? "model_output", strict: true, schema: input.schema } };
  let response: Response;
  try {
    response = await fetch(endpoint(input.profile.baseUrl, "responses"), { method: "POST", headers: authorization(input.profile), body: JSON.stringify(body), signal: input.signal });
  } catch (error) {
    throw new ModelTransportError(error instanceof Error ? error.message : String(error), true, "network");
  }
  if (!response.ok) return readHttpError(response);
  return parseResponsesJson(await response.json() as Record<string, unknown>);
}

async function requestTransport(input: TransportRequest): Promise<TransportResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`模型请求超过 ${input.profile.timeoutMs ?? 120_000}ms`));
  }, input.profile.timeoutMs ?? 120_000);
  try {
    return await (input.profile.protocol === "responses"
      ? requestResponses({ ...input, signal: controller.signal })
      : requestChatCompletions({ ...input, signal: controller.signal }));
  } catch (error) {
    if (timedOut) throw new ModelTransportError(`模型请求超过 ${input.profile.timeoutMs ?? 120_000}ms`, true, "timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}

function parseJsonContent(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  const candidate = fenced ?? (start >= 0 && end >= start ? content.slice(start, end + 1) : content);
  try { return JSON.parse(candidate.trim()); } catch { return undefined; }
}

function repairPrompt(schema: Record<string, unknown>, content: string, errors: string, attempt: number): string {
  return [
    attempt ? "上一次修复仍未通过。重新生成完整 JSON。" : "修复下面输出，使其严格符合 JSON Schema。",
    "只输出 JSON，不得新增原输出没有的故事事实。",
    `Schema:\n${JSON.stringify(schema)}`,
    `校验错误：${errors}`,
    `原输出：\n${content}`,
  ].join("\n\n");
}

function retryDelay(attempt: number): number { return [500, 1_000, 2_000][attempt] ?? 2_000; }
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); }, { once: true });
  });
}

export class RoutedModelGateway implements ModelGateway {
  constructor(readonly configStore: ModelConfigStore, private readonly recordInvocation?: ModelInvocationRecorder) {}

  getRoutingSnapshot(): ModelRoutingSnapshot { return this.configStore.getSnapshot(); }

  private resolveProfile(snapshot: ModelRoutingSnapshot, profileId: string): ModelProviderProfile {
    const frozen = snapshot.profiles.find((item) => item.id === profileId);
    if (!frozen) throw new Error(`路由快照中不存在 profile ${profileId}`);
    const current = this.configStore.getProfile(profileId);
    if (!current) throw new Error(`本地密钥配置中不存在 profile ${profileId}`);
    const { secretRef: _secretRef, hasSecret: _hasSecret, ...profile } = frozen;
    return { ...profile, secret: current.secret };
  }

  private route(input: BaseModelInput): { snapshot: ModelRoutingSnapshot; route: ModelRoute } {
    const snapshot = input.routingSnapshot ?? this.getRoutingSnapshot();
    const route = resolveRoute({ routes: snapshot.routes }, input.purpose);
    if (!route) throw new Error(`没有匹配 ${input.purpose} 的模型路由`);
    return { snapshot, route };
  }

  private async record(audit: ModelInvocationAudit): Promise<void> {
    if (this.recordInvocation) await this.recordInvocation(audit);
  }

  private async invokeCandidate(input: BaseModelInput & { prompt: string; schema?: Record<string, unknown>; schemaName?: string }, snapshot: ModelRoutingSnapshot, route: ModelRoute, candidateIndex: number): Promise<{ response: TransportResponse; profile: ModelProviderProfile; model: string; provenance: ModelExecutionProvenance; latencyMs: number }> {
    const candidate = route.candidates[candidateIndex];
    const fingerprint = promptFingerprint(input.system, input.prompt);
    if (!candidate) throw new Error(`模型候选索引越界：${candidateIndex}`);
    if (candidate.executor === "external-mcp") {
      await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex, executor: "external-mcp", model: "external-mcp", status: "waiting-external", inputTokens: 0, outputTokens: 0, latencyMs: 0, promptFingerprint: fingerprint });
      throw new ExternalMcpRequiredError(input.purpose, snapshot.id, candidateIndex);
    }
    const profile = this.resolveProfile(snapshot, candidate.profileId);
    const model = candidate.model ?? profile.model;
    const started = Date.now();
    let attempt = 0;
    let previousResponseId = route.conversationPolicy === "task-chain" && input.previousProfileId === profile.id
      ? input.previousResponseId
      : undefined;
    let continuationFallbackUsed = false;
    while (true) {
      try {
        const response = await requestTransport({ profile, model, system: input.system, prompt: input.prompt, schema: input.schema, schemaName: input.schemaName, maxTokens: input.maxTokens, temperature: input.temperature, previousResponseId, signal: input.signal });
        if (!response.text.trim()) throw new ModelTransportError("模型返回空内容", true, "empty-response");
        const latencyMs = Date.now() - started;
        const provenance: ModelExecutionProvenance = { routeSnapshotId: snapshot.id, purpose: input.purpose, candidateIndex, executor: "api", profileId: profile.id, protocol: profile.protocol, model, responseId: response.responseId, promptFingerprint: fingerprint };
        return { response, profile, model, provenance, latencyMs };
      } catch (error) {
        if (previousResponseId && !continuationFallbackUsed && error instanceof ModelTransportError && error.status === 400) {
          previousResponseId = undefined;
          continuationFallbackUsed = true;
          continue;
        }
        if (error instanceof ModelTransportError && error.retryable && attempt < 2) {
          await sleep(retryDelay(attempt++), input.signal);
          continue;
        }
        const latencyMs = Date.now() - started;
        await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex, executor: "api", profileId: profile.id, protocol: profile.protocol, model, status: "failed", inputTokens: 0, outputTokens: 0, latencyMs, promptFingerprint: fingerprint, errorCategory: error instanceof ModelTransportError ? error.category : "protocol" });
        throw error;
      }
    }
  }

  async generateText(input: GenerateTextInput): Promise<ModelResult<string> & { text: string }> {
    const { snapshot, route } = this.route(input);
    let lastError: unknown;
    for (let index = input.candidateStartIndex ?? 0; index < route.candidates.length; index += 1) {
      try {
        const result = await this.invokeCandidate(input, snapshot, route, index);
        const usage = { model: result.model, inputTokens: result.response.inputTokens, outputTokens: result.response.outputTokens, costUsd: 0, latencyMs: result.latencyMs };
        await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex: index, executor: "api", profileId: result.profile.id, protocol: result.profile.protocol, model: result.model, status: "completed", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs: usage.latencyMs, promptFingerprint: result.provenance.promptFingerprint, responseId: result.response.responseId });
        return { value: result.response.text, text: result.response.text, usage, provenance: result.provenance };
      } catch (error) {
        if (error instanceof ExternalMcpRequiredError) throw error;
        // empty-response 是瞬时 LLM 错误（模型返回空内容）：重试可能成功。
        // 不应回退到 external-mcp——没有外部客户端时会死等。
        // 让 Temporal activity retry 处理——它会重新调用 LLM。
        if (error instanceof ModelTransportError && error.category === "empty-response") throw error;
        lastError = error;
      }
    }
    throw lastError ?? new Error(`模型路由 ${input.purpose} 没有可执行候选`);
  }

  async generateStructured<T>(input: GenerateStructuredInput<T>): Promise<ModelResult<T>> {
    const { snapshot, route } = this.route(input);
    const validate = new Ajv({ allErrors: true, strict: false }).compile(input.schema as AnySchema) as ValidateFunction<T>;
    let lastError: unknown;
    for (let index = input.candidateStartIndex ?? 0; index < route.candidates.length; index += 1) {
      try {
        // Some OpenAI-compatible providers accept response_format but do not
        // enforce it. Keep the schema in the same coherent user payload so the
        // output contract remains explicit even on compatibility transports.
        let currentPrompt = [
          input.prompt,
          "## 结构化输出契约",
          "只输出一个严格符合下列 JSON Schema 的 JSON 值，不使用 Markdown，不在 JSON 前后添加说明。",
          JSON.stringify(input.schema),
        ].join("\n\n");
        let currentSystem = input.system;
        let totalInput = 0;
        let totalOutput = 0;
        let latest: Awaited<ReturnType<RoutedModelGateway["invokeCandidate"]>> | undefined;
        const repairs = input.maxRepairAttempts ?? 2;
        for (let repair = 0; repair <= repairs; repair += 1) {
          latest = await this.invokeCandidate({ ...input, system: currentSystem, prompt: currentPrompt }, snapshot, route, index);
          totalInput += latest.response.inputTokens;
          totalOutput += latest.response.outputTokens;
          const parsed = parseJsonContent(latest.response.text);
          if (validate(parsed)) {
            const usage = { model: latest.model, inputTokens: totalInput, outputTokens: totalOutput, costUsd: 0, latencyMs: latest.latencyMs };
            await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex: index, executor: "api", profileId: latest.profile.id, protocol: latest.profile.protocol, model: latest.model, status: "completed", inputTokens: totalInput, outputTokens: totalOutput, latencyMs: latest.latencyMs, promptFingerprint: latest.provenance.promptFingerprint, responseId: latest.response.responseId });
            return { value: parsed, usage, provenance: latest.provenance };
          }
          const errors = validate.errors?.map((item) => `${item.instancePath || "root"} ${item.message ?? ""}`).join("；") ?? "JSON 无法解析";
          if (repair === repairs) {
            await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex: index, executor: "api", profileId: latest.profile.id, protocol: latest.profile.protocol, model: latest.model, status: "failed", inputTokens: totalInput, outputTokens: totalOutput, latencyMs: latest.latencyMs, promptFingerprint: latest.provenance.promptFingerprint, responseId: latest.response.responseId, errorCategory: "schema-validation" });
            throw new ModelTransportError(`结构化输出校验失败：${errors}`, false, "schema-validation");
          }
          currentPrompt = repairPrompt(input.schema, latest.response.text, errors, repair);
          currentSystem = "只输出严格符合 JSON Schema 的 JSON，不使用 Markdown。";
        }
      } catch (error) {
        if (error instanceof ExternalMcpRequiredError) throw error;
        // empty-response 是瞬时 LLM 错误（同 generateText）：不回退 external-mcp，让 Temporal retry。
        if (error instanceof ModelTransportError && error.category === "empty-response") throw error;
        // schema-validation 是 LLM 已返回内容但形状不匹配 schema——
        // 已在 maxRepairAttempts 内多次修复失败，说明该模型对此 prompt+schema 组合无法稳定产出。
        // 回退 external-mcp 无意义：外部客户端会面对相同的 schema 约束，只会无限等待。
        // 让错误冒泡到 activity，runAllReviewers 的 Promise.allSettled 会跳过此 reviewer
        // 继续工作流；其他依赖该结果的调用方应通过 revision-policy 容错。
        if (error instanceof ModelTransportError && error.category === "schema-validation") throw error;
        lastError = error;
      }
    }
    throw lastError ?? new Error(`模型路由 ${input.purpose} 没有可执行候选`);
  }

  private async vectorRequest(input: { purpose: "memory.embed" | "memory.rerank"; body: Record<string, unknown>; path: string; signal?: AbortSignal; routingSnapshot?: ModelRoutingSnapshot; workflowRunId?: string; taskId?: string }): Promise<{ data: Record<string, unknown>; provenance: ModelExecutionProvenance; usage: ModelUsage }> {
    const { snapshot, route } = this.route(input);
    let lastError: unknown;
    for (let index = 0; index < route.candidates.length; index += 1) {
      const candidate = route.candidates[index];
      if (candidate.executor === "external-mcp") throw new ExternalMcpRequiredError(input.purpose, snapshot.id, index);
      const profile = this.resolveProfile(snapshot, candidate.profileId);
      const model = candidate.model ?? profile.model;
      const started = Date.now();
      const fingerprint = promptFingerprint(undefined, JSON.stringify(input.body));
      try {
        const response = await fetch(endpoint(profile.baseUrl, input.path), { method: "POST", headers: authorization(profile), body: JSON.stringify({ model, ...input.body }), signal: input.signal });
        if (!response.ok) return readHttpError(response);
        const data = await response.json() as Record<string, unknown>;
        const usageData = (data.usage ?? {}) as Record<string, unknown>;
        const usage = { model, inputTokens: Number(usageData.prompt_tokens ?? usageData.input_tokens ?? 0), outputTokens: 0, costUsd: 0, latencyMs: Date.now() - started };
        const provenance = { routeSnapshotId: snapshot.id, purpose: input.purpose, candidateIndex: index, executor: "api" as const, profileId: profile.id, protocol: profile.protocol, model, promptFingerprint: fingerprint };
        await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex: index, executor: "api", profileId: profile.id, protocol: profile.protocol, model, status: "completed", inputTokens: usage.inputTokens, outputTokens: 0, latencyMs: usage.latencyMs, promptFingerprint: fingerprint });
        return { data, provenance, usage };
      } catch (error) { lastError = error; }
    }
    throw lastError ?? new Error(`模型路由 ${input.purpose} 没有可执行候选`);
  }

  async embed(input: { purpose: "memory.embed"; texts: string[]; signal?: AbortSignal; routingSnapshot?: ModelRoutingSnapshot; workflowRunId?: string; taskId?: string }): Promise<ModelResult<number[][]> & { vectors: number[][] }> {
    const result = await this.vectorRequest({ ...input, body: { input: input.texts }, path: "embeddings" });
    const rows = Array.isArray(result.data.data) ? result.data.data as Array<{ embedding?: number[] }> : [];
    const vectors = rows.map((row) => row.embedding ?? []);
    return { value: vectors, vectors, usage: result.usage, provenance: result.provenance };
  }

  async rerank(input: { purpose: "memory.rerank"; query: string; documents: string[]; signal?: AbortSignal; routingSnapshot?: ModelRoutingSnapshot; workflowRunId?: string; taskId?: string }): Promise<ModelResult<number[]> & { scores: number[] }> {
    const result = await this.vectorRequest({ ...input, body: { query: input.query, documents: input.documents }, path: "rerank" });
    const rows = Array.isArray(result.data.results) ? result.data.results as Array<{ relevance_score?: number | string }> : [];
    const scores = rows.map((row) => Number(row.relevance_score ?? 0));
    return { value: scores, scores, usage: result.usage, provenance: result.provenance };
  }
}

export class InMemoryModelGateway implements ModelGateway {
  constructor(private readonly responder: (input: { purpose: ModelPurpose; system?: string; prompt: string; schema?: Record<string, unknown> }) => unknown) {}
  getRoutingSnapshot(): ModelRoutingSnapshot { return { id: "in-memory", configVersion: 1, profiles: [], routes: { "*": { candidates: [{ executor: "external-mcp" }] } }, createdAt: 0 }; }
  private provenance(purpose: ModelPurpose, prompt: string): ModelExecutionProvenance { return { routeSnapshotId: "in-memory", purpose, candidateIndex: 0, executor: "api", profileId: "in-memory", protocol: "chat-completions", model: "in-memory", promptFingerprint: promptFingerprint(undefined, prompt) }; }
  async generateText(input: GenerateTextInput) { const raw = this.responder({ purpose: input.purpose, system: input.system, prompt: input.prompt }); const text = typeof raw === "string" ? raw : JSON.stringify(raw); return { value: text, text, usage: { model: "in-memory", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 }, provenance: this.provenance(input.purpose, input.prompt) }; }
  async generateStructured<T>(input: GenerateStructuredInput<T>): Promise<ModelResult<T>> { const value = this.responder({ purpose: input.purpose, system: input.system, prompt: input.prompt, schema: input.schema }); const validate = new Ajv({ allErrors: true, strict: false }).compile(input.schema as AnySchema); if (!validate(value)) throw new Error(`InMemoryModelGateway structured 输出校验失败：${validate.errors?.map((item) => `${item.instancePath || "root"} ${item.message ?? ""}`).join("；")}`); return { value: value as T, usage: { model: "in-memory", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 }, provenance: this.provenance(input.purpose, input.prompt) }; }
  async embed(input: { purpose: "memory.embed"; texts: string[] }) { const vectors = input.texts.map(() => [] as number[]); return { value: vectors, vectors, usage: { model: "in-memory", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 }, provenance: this.provenance(input.purpose, input.texts.join("\n")) }; }
  async rerank(input: { purpose: "memory.rerank"; query: string; documents: string[] }) { const scores = input.documents.map(() => 0); return { value: scores, scores, usage: { model: "in-memory", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 }, provenance: this.provenance(input.purpose, input.query) }; }
}
