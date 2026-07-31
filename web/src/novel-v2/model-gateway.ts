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
import type { PromptContextManifest } from "./protocol";

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  usageSource?: "provider" | "estimated" | "mixed";
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
  promptContext?: PromptContextManifest;
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
  providerInputTokens?: number;
  providerOutputTokens?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  usageSource?: "provider" | "estimated" | "mixed";
  latencyMs: number;
  promptFingerprint: string;
  responseId?: string;
  errorCategory?: string;
}

export type ModelInvocationRecorder = (audit: ModelInvocationAudit) => Promise<void>;

export interface ModelPromptExecution {
  workflowRunId?: string;
  taskId?: string;
  purpose: ModelPurpose;
  candidateIndex: number;
  status: "completed" | "failed";
  system?: string;
  prompt: string;
  response?: string;
  promptFingerprint: string;
  contextManifest?: PromptContextManifest;
  errorCategory?: string;
}

export type ModelPromptExecutionRecorder = (execution: ModelPromptExecution) => Promise<void>;

export class ModelContextBudgetError extends Error {
  readonly category = "context-budget-exceeded";
  constructor(readonly estimatedInputTokens: number, readonly maxInputTokens: number, readonly purpose: ModelPurpose) {
    super(`context-budget-exceeded: ${purpose} 实际输入约 ${estimatedInputTokens} tokens，超过有效预算 ${maxInputTokens}`);
    this.name = "ModelContextBudgetError";
  }
}

interface TransportResponse {
  text: string;
  responseId?: string;
  inputTokens: number;
  outputTokens: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  usageSource: "provider" | "estimated" | "mixed";
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

function exhaustedRouteError(purpose: ModelPurpose, error: unknown): ModelTransportError {
  if (error instanceof ModelTransportError) {
    return new ModelTransportError(error.message, false, error.category, error.status);
  }
  const message = error instanceof Error ? error.message : error === undefined ? `模型路由 ${purpose} 没有可执行候选` : String(error);
  return new ModelTransportError(message, false, "route-exhausted");
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

function finiteToken(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

function nextApiCandidateIndex(route: ModelRoute, currentIndex: number): number | undefined {
  const offset = route.candidates.slice(currentIndex + 1).findIndex((candidate) => candidate.executor === "api");
  return offset < 0 ? undefined : currentIndex + 1 + offset;
}

function tokenEstimate(text: string): number {
  if (!text.trim()) return 0;
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.max(1, Math.ceil(cjk * 0.75 + other / 4));
}

export function normalizeUsage(
  usageValue: unknown,
  inputText: string,
  outputText: string,
): Pick<TransportResponse, "inputTokens" | "outputTokens" | "providerInputTokens" | "providerOutputTokens" | "estimatedInputTokens" | "estimatedOutputTokens" | "usageSource"> {
  const usage = usageValue && typeof usageValue === "object" && !Array.isArray(usageValue) ? usageValue as Record<string, unknown> : {};
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === "object" ? usage.input_tokens_details as Record<string, unknown> : {};
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === "object" ? usage.output_tokens_details as Record<string, unknown> : {};
  const providerInputTokens = finiteToken(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens ?? inputDetails.total_tokens);
  const providerOutputTokens = finiteToken(usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens ?? outputDetails.total_tokens);
  const estimatedInputTokens = tokenEstimate(inputText);
  const estimatedOutputTokens = tokenEstimate(outputText);
  const hasProviderInput = providerInputTokens !== undefined;
  const hasProviderOutput = providerOutputTokens !== undefined;
  const usageSource = hasProviderInput && hasProviderOutput ? "provider" : hasProviderInput || hasProviderOutput ? "mixed" : "estimated";
  return {
    inputTokens: providerInputTokens ?? estimatedInputTokens,
    outputTokens: providerOutputTokens ?? estimatedOutputTokens,
    providerInputTokens,
    providerOutputTokens,
    estimatedInputTokens,
    estimatedOutputTokens,
    usageSource,
  };
}

function parseChatJson(data: Record<string, unknown>, inputText: string): TransportResponse {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const text = typeof first?.message?.content === "string" ? first.message.content : "";
  return {
    text,
    responseId: typeof data.id === "string" ? data.id : undefined,
    ...normalizeUsage(data.usage, inputText, text),
  };
}

async function parseChatSse(response: Response, inputText: string): Promise<TransportResponse> {
  if (!response.body) throw new ModelTransportError("Chat SSE 响应缺少 body", true, "empty-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let responseId: string | undefined;
  let usageValue: unknown;
  const consume = (line: string) => {
    const raw = line.replace(/^data:\s*/, "").trim();
    if (!raw || raw === "[DONE]") return;
    try {
      const event = JSON.parse(raw) as Record<string, unknown>;
      if (typeof event.id === "string") responseId = event.id;
      const choices = Array.isArray(event.choices) ? event.choices : [];
      const first = choices[0] as { delta?: { content?: unknown } } | undefined;
      if (typeof first?.delta?.content === "string") text += first.delta.content;
      if (event.usage) usageValue = event.usage;
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
  return { text, responseId, ...normalizeUsage(usageValue, inputText, text) };
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
  return stream ? parseChatSse(response, input.prompt) : parseChatJson(await response.json() as Record<string, unknown>, input.prompt);
}

function parseResponsesJson(data: Record<string, unknown>, inputText: string): TransportResponse {
  let text = typeof data.output_text === "string" ? data.output_text : "";
  if (!text && Array.isArray(data.output)) {
    for (const item of data.output as Array<Record<string, unknown>>) {
      if (!Array.isArray(item.content)) continue;
      for (const content of item.content as Array<Record<string, unknown>>) {
        if (typeof content.text === "string") text += content.text;
      }
    }
  }
  return {
    text,
    responseId: typeof data.id === "string" ? data.id : undefined,
    ...normalizeUsage(data.usage, inputText, text),
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
  return parseResponsesJson(await response.json() as Record<string, unknown>, input.prompt);
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

function parseJsonCandidate(candidate: string): unknown {
  try {
    let value: unknown = JSON.parse(candidate.trim());
    if (typeof value === "string") value = JSON.parse(value.trim());
    return value;
  } catch { return undefined; }
}

function balancedJsonObjects(content: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) candidates.push(content.slice(start, index + 1));
    }
  }
  return candidates;
}

export function normalizeStructuredContent<T>(content: string, validate: ValidateFunction<T>): T | undefined {
  const fenced = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)].map((match) => match[1]);
  const fullValue = parseJsonCandidate(content);
  const rawCandidates = fullValue === undefined ? [...fenced, ...balancedJsonObjects(content)] : [content];
  for (const raw of rawCandidates) {
    const parsed = parseJsonCandidate(raw);
    const candidates = [parsed];
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const root = parsed as Record<string, unknown>;
      for (const key of ["data", "result", "output"]) if (key in root) candidates.push(root[key]);
    }
    for (const candidate of candidates) if (validate(candidate)) return candidate;
  }
  return undefined;
}

function repairPrompt(schema: Record<string, unknown>, originalTask: string, content: string, errors: string, attempt: number, maxInputTokens: number, system?: string): string {
  const prefix = [
    attempt ? "上一次修复仍未通过。重新生成完整 JSON。" : "修复下面输出，使其严格符合 JSON Schema。",
    "只输出 JSON。必须继续完成原始任务，不得只追求通过 Schema；不得新增原输出和原始任务依据中都不存在的故事事实。",
    `原始任务与语义约束：\n${originalTask}`,
    `Schema:\n${JSON.stringify(schema)}`,
    `校验错误：${errors}`,
  ].join("\n\n");
  const maxCharacters = Number.isFinite(maxInputTokens) ? Math.max(0, maxInputTokens * 2 - (system?.length ?? 0) - prefix.length - 128) : content.length;
  const retained = content.slice(0, maxCharacters);
  const outputSection = retained
    ? `${retained.length < content.length ? "原输出（因上下文预算仅保留开头，必要时按原始任务重新生成）" : "原输出"}：\n${retained}`
    : "原输出因上下文预算未重复注入；请依据原始任务、Schema 和校验错误重新生成。";
  return `${prefix}\n\n${outputSection}`;
}

function retryDelay(attempt: number): number { return [500, 1_000, 2_000][attempt] ?? 2_000; }
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); }, { once: true });
  });
}

export class RoutedModelGateway implements ModelGateway {
  constructor(readonly configStore: ModelConfigStore, private readonly recordInvocation?: ModelInvocationRecorder, private readonly recordPromptExecution?: ModelPromptExecutionRecorder) {}

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

  private async recordPrompt(input: ModelPromptExecution): Promise<void> {
    if (!this.recordPromptExecution) return;
    try { await this.recordPromptExecution(input); }
    catch (error) { console.warn(`[model-gateway] 提示词诊断留痕失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  private async invokeCandidate(input: BaseModelInput & { prompt: string; schema?: Record<string, unknown>; schemaName?: string }, snapshot: ModelRoutingSnapshot, route: ModelRoute, candidateIndex: number): Promise<{ response: TransportResponse; profile: ModelProviderProfile; model: string; provenance: ModelExecutionProvenance; latencyMs: number }> {
    const candidate = route.candidates[candidateIndex];
    const fingerprint = promptFingerprint(input.system, input.prompt);
    if (!candidate) throw new Error(`模型候选索引越界：${candidateIndex}`);
    if (candidate.executor === "external-mcp") {
      const effectiveInputLimit = Math.min(route.maxInputTokens ?? Number.MAX_SAFE_INTEGER, input.promptContext?.maxInputTokens ?? Number.MAX_SAFE_INTEGER);
      const estimatedInputTokens = Math.ceil(`${input.system ?? ""}\n${input.prompt}`.length / 2);
      if (estimatedInputTokens > effectiveInputLimit) {
        const error = new ModelContextBudgetError(estimatedInputTokens, effectiveInputLimit, input.purpose);
        await this.recordPrompt({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, candidateIndex, status: "failed", system: input.system, prompt: input.prompt, promptFingerprint: fingerprint, contextManifest: input.promptContext, errorCategory: error.category });
        await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex, executor: "external-mcp", model: "external-mcp", status: "failed", inputTokens: estimatedInputTokens, outputTokens: 0, estimatedInputTokens, estimatedOutputTokens: 0, usageSource: "estimated", latencyMs: 0, promptFingerprint: fingerprint, errorCategory: error.category });
        throw error;
      }
      await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex, executor: "external-mcp", model: "external-mcp", status: "waiting-external", inputTokens: 0, outputTokens: 0, latencyMs: 0, promptFingerprint: fingerprint });
      throw new ExternalMcpRequiredError(input.purpose, snapshot.id, candidateIndex);
    }
    const profile = this.resolveProfile(snapshot, candidate.profileId);
    const model = candidate.model ?? profile.model;
    const outputReserve = Math.max(1, Math.min(input.maxTokens ?? route.maxOutputTokens ?? 4_096, route.maxOutputTokens ?? Number.MAX_SAFE_INTEGER));
    const profileInputLimit = profile.contextWindow ? Math.max(0, profile.contextWindow - outputReserve) : Number.MAX_SAFE_INTEGER;
    const effectiveInputLimit = Math.min(route.maxInputTokens ?? Number.MAX_SAFE_INTEGER, input.promptContext?.maxInputTokens ?? Number.MAX_SAFE_INTEGER, profileInputLimit);
    const estimatedInputTokens = Math.ceil(`${input.system ?? ""}\n${input.prompt}`.length / 2);
    if (estimatedInputTokens > effectiveInputLimit) {
      const error = new ModelContextBudgetError(estimatedInputTokens, effectiveInputLimit, input.purpose);
      await this.recordPrompt({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, candidateIndex, status: "failed", system: input.system, prompt: input.prompt, promptFingerprint: fingerprint, contextManifest: input.promptContext, errorCategory: error.category });
      await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex, executor: "api", profileId: profile.id, protocol: profile.protocol, model, status: "failed", inputTokens: estimatedInputTokens, outputTokens: 0, estimatedInputTokens, estimatedOutputTokens: 0, usageSource: "estimated", latencyMs: 0, promptFingerprint: fingerprint, errorCategory: error.category });
      throw error;
    }
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
        await this.recordPrompt({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, candidateIndex, status: "completed", system: input.system, prompt: input.prompt, response: response.text, promptFingerprint: fingerprint, contextManifest: input.promptContext });
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
        const errorCategory = error instanceof ModelTransportError ? error.category : error instanceof ModelContextBudgetError ? error.category : "protocol";
        await this.recordPrompt({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, candidateIndex, status: "failed", system: input.system, prompt: input.prompt, promptFingerprint: fingerprint, contextManifest: input.promptContext, errorCategory });
        await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex, executor: "api", profileId: profile.id, protocol: profile.protocol, model, status: "failed", inputTokens: 0, outputTokens: 0, latencyMs, promptFingerprint: fingerprint, errorCategory });
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
        const usage = { model: result.model, inputTokens: result.response.inputTokens, outputTokens: result.response.outputTokens, providerInputTokens: result.response.providerInputTokens, providerOutputTokens: result.response.providerOutputTokens, estimatedInputTokens: result.response.estimatedInputTokens, estimatedOutputTokens: result.response.estimatedOutputTokens, usageSource: result.response.usageSource, costUsd: 0, latencyMs: result.latencyMs };
        await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex: index, executor: "api", profileId: result.profile.id, protocol: result.profile.protocol, model: result.model, status: "completed", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, providerInputTokens: usage.providerInputTokens, providerOutputTokens: usage.providerOutputTokens, estimatedInputTokens: usage.estimatedInputTokens, estimatedOutputTokens: usage.estimatedOutputTokens, usageSource: usage.usageSource, latencyMs: usage.latencyMs, promptFingerprint: result.provenance.promptFingerprint, responseId: result.response.responseId });
        return { value: result.response.text, text: result.response.text, usage, provenance: result.provenance };
      } catch (error) {
        if (error instanceof ExternalMcpRequiredError) throw error;
        // Empty output first exhausts transport retries, then moves only to the
        // next explicit API candidate. Never turn it into an external-MCP wait.
        if (error instanceof ModelTransportError && error.category === "empty-response") {
          const nextApi = nextApiCandidateIndex(route, index);
          if (nextApi === undefined) throw error;
          lastError = error;
          index = nextApi - 1;
          continue;
        }
        lastError = error;
      }
    }
    // Every API candidate already exhausted its transport retries here. Mark
    // the terminal error non-retryable so Temporal does not repeat the entire
    // activity and leave the chapter locked in `running` for many minutes.
    throw exhaustedRouteError(input.purpose, lastError);
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
        const originalPrompt = [
          input.prompt,
          "## 结构化输出契约",
          "只输出一个严格符合下列 JSON Schema 的 JSON 值，不使用 Markdown，不在 JSON 前后添加说明。",
          JSON.stringify(input.schema),
        ].join("\n\n");
        let currentPrompt = originalPrompt;
        let currentSystem = input.system;
        let totalInput = 0;
        let totalOutput = 0;
        let providerInputTotal = 0;
        let providerOutputTotal = 0;
        let estimatedInputTotal = 0;
        let estimatedOutputTotal = 0;
        let providerInputComplete = true;
        let providerOutputComplete = true;
        let providerInputSeen = false;
        let providerOutputSeen = false;
        let latest: Awaited<ReturnType<RoutedModelGateway["invokeCandidate"]>> | undefined;
        const repairs = input.maxRepairAttempts ?? 2;
        for (let repair = 0; repair <= repairs; repair += 1) {
          latest = await this.invokeCandidate({ ...input, system: currentSystem, prompt: currentPrompt }, snapshot, route, index);
          totalInput += latest.response.inputTokens;
          totalOutput += latest.response.outputTokens;
          estimatedInputTotal += latest.response.estimatedInputTokens;
          estimatedOutputTotal += latest.response.estimatedOutputTokens;
          if (latest.response.providerInputTokens === undefined) providerInputComplete = false;
          else { providerInputSeen = true; providerInputTotal += latest.response.providerInputTokens; }
          if (latest.response.providerOutputTokens === undefined) providerOutputComplete = false;
          else { providerOutputSeen = true; providerOutputTotal += latest.response.providerOutputTokens; }
          const parsed = normalizeStructuredContent(latest.response.text, validate);
          if (parsed !== undefined) {
            const providerInputTokens = providerInputSeen ? providerInputTotal : undefined;
            const providerOutputTokens = providerOutputSeen ? providerOutputTotal : undefined;
            const usageSource = providerInputComplete && providerOutputComplete ? "provider" as const : providerInputSeen || providerOutputSeen ? "mixed" as const : "estimated" as const;
            const usage = { model: latest.model, inputTokens: totalInput, outputTokens: totalOutput, providerInputTokens, providerOutputTokens, estimatedInputTokens: estimatedInputTotal, estimatedOutputTokens: estimatedOutputTotal, usageSource, costUsd: 0, latencyMs: latest.latencyMs };
            await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex: index, executor: "api", profileId: latest.profile.id, protocol: latest.profile.protocol, model: latest.model, status: "completed", inputTokens: totalInput, outputTokens: totalOutput, providerInputTokens: usage.providerInputTokens, providerOutputTokens: usage.providerOutputTokens, estimatedInputTokens: usage.estimatedInputTokens, estimatedOutputTokens: usage.estimatedOutputTokens, usageSource: usage.usageSource, latencyMs: latest.latencyMs, promptFingerprint: latest.provenance.promptFingerprint, responseId: latest.response.responseId });
            return { value: parsed, usage, provenance: latest.provenance };
          }
          const errors = validate.errors?.map((item) => `${item.instancePath || "root"} ${item.message ?? ""}`).join("；") ?? "JSON 无法解析";
          if (repair === repairs) {
            await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex: index, executor: "api", profileId: latest.profile.id, protocol: latest.profile.protocol, model: latest.model, status: "failed", inputTokens: totalInput, outputTokens: totalOutput, providerInputTokens: providerInputSeen ? providerInputTotal : undefined, providerOutputTokens: providerOutputSeen ? providerOutputTotal : undefined, estimatedInputTokens: estimatedInputTotal, estimatedOutputTokens: estimatedOutputTotal, usageSource: providerInputComplete && providerOutputComplete ? "provider" : providerInputSeen || providerOutputSeen ? "mixed" : "estimated", latencyMs: latest.latencyMs, promptFingerprint: latest.provenance.promptFingerprint, responseId: latest.response.responseId, errorCategory: "schema-validation" });
            throw new ModelTransportError(`结构化输出校验失败：${errors}`, false, "schema-validation");
          }
          const repairSystem = [input.system, "修复结构化输出时仍须遵守原始角色、任务目标和事实边界。只输出严格符合 JSON Schema 的 JSON，不使用 Markdown。"].filter(Boolean).join("\n\n");
          const candidate = route.candidates[index];
          let repairInputLimit = Math.min(route.maxInputTokens ?? Number.MAX_SAFE_INTEGER, input.promptContext?.maxInputTokens ?? Number.MAX_SAFE_INTEGER);
          if (candidate?.executor === "api") {
            const profile = this.resolveProfile(snapshot, candidate.profileId);
            const outputReserve = Math.max(1, Math.min(input.maxTokens ?? route.maxOutputTokens ?? 4_096, route.maxOutputTokens ?? Number.MAX_SAFE_INTEGER));
            if (profile.contextWindow) repairInputLimit = Math.min(repairInputLimit, Math.max(0, profile.contextWindow - outputReserve));
          }
          currentSystem = repairSystem;
          currentPrompt = repairPrompt(input.schema, input.prompt, latest.response.text, errors, repair, repairInputLimit, repairSystem);
        }
      } catch (error) {
        if (error instanceof ExternalMcpRequiredError) throw error;
        if (error instanceof ModelTransportError && error.category === "empty-response") {
          const nextApi = nextApiCandidateIndex(route, index);
          if (nextApi === undefined) throw error;
          lastError = error;
          index = nextApi - 1;
          continue;
        }
        // schema-validation 是 LLM 已返回内容但形状不匹配 schema——
        // 已在 maxRepairAttempts 内多次修复失败，说明该模型对此 prompt+schema 组合无法稳定产出。
        // 回退 external-mcp 无意义：外部客户端会面对相同的 schema 约束，只会无限等待。
        // 让错误冒泡到 activity，runAllReviewers 的 Promise.allSettled 会跳过此 reviewer
        // 继续工作流；其他依赖该结果的调用方应通过 revision-policy 容错。
        if (error instanceof ModelTransportError && error.category === "schema-validation") throw error;
        lastError = error;
      }
    }
    throw exhaustedRouteError(input.purpose, lastError);
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
        const meta = data.meta && typeof data.meta === "object" && !Array.isArray(data.meta)
          ? data.meta as Record<string, unknown>
          : undefined;
        // OpenAI-compatible embeddings expose `usage`; SiliconFlow rerank
        // exposes the same token counters under `meta.tokens`.
        const normalized = normalizeUsage(data.usage ?? meta?.tokens, JSON.stringify(input.body), "");
        const usage = { model, ...normalized, costUsd: 0, latencyMs: Date.now() - started };
        const provenance = { routeSnapshotId: snapshot.id, purpose: input.purpose, candidateIndex: index, executor: "api" as const, profileId: profile.id, protocol: profile.protocol, model, promptFingerprint: fingerprint };
        await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex: index, executor: "api", profileId: profile.id, protocol: profile.protocol, model, status: "completed", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, providerInputTokens: usage.providerInputTokens, providerOutputTokens: usage.providerOutputTokens, estimatedInputTokens: usage.estimatedInputTokens, estimatedOutputTokens: usage.estimatedOutputTokens, usageSource: usage.usageSource, latencyMs: usage.latencyMs, promptFingerprint: fingerprint });
        return { data, provenance, usage };
      } catch (error) { lastError = error; }
    }
    throw lastError ?? new Error(`模型路由 ${input.purpose} 没有可执行候选`);
  }

  async embed(input: { purpose: "memory.embed"; texts: string[]; signal?: AbortSignal; routingSnapshot?: ModelRoutingSnapshot; workflowRunId?: string; taskId?: string }): Promise<ModelResult<number[][]> & { vectors: number[][] }> {
    const result = await this.vectorRequest({ ...input, body: { input: input.texts, encoding_format: "float" }, path: "embeddings" });
    const rows = Array.isArray(result.data.data) ? result.data.data as Array<{ embedding?: number[]; index?: number }> : [];
    const vectors = Array.from({ length: input.texts.length }, () => [] as number[]);
    rows.forEach((row, responseIndex) => {
      const inputIndex = Number.isInteger(row.index) ? Number(row.index) : responseIndex;
      if (inputIndex >= 0 && inputIndex < vectors.length && Array.isArray(row.embedding)) vectors[inputIndex] = row.embedding;
    });
    return { value: vectors, vectors, usage: result.usage, provenance: result.provenance };
  }

  async rerank(input: { purpose: "memory.rerank"; query: string; documents: string[]; signal?: AbortSignal; routingSnapshot?: ModelRoutingSnapshot; workflowRunId?: string; taskId?: string }): Promise<ModelResult<number[]> & { scores: number[] }> {
    const result = await this.vectorRequest({
      ...input,
      body: { query: input.query, documents: input.documents, top_n: input.documents.length, return_documents: false },
      path: "rerank",
    });
    const rows = Array.isArray(result.data.results)
      ? result.data.results as Array<{ index?: number; relevance_score?: number | string; score?: number | string }>
      : [];
    // SiliconFlow returns results sorted by relevance, so map each score back
    // to its original document index before the retrieval layer consumes it.
    const scores = Array.from({ length: input.documents.length }, () => 0);
    const assigned = Array.from({ length: input.documents.length }, () => false);
    rows.forEach((row, responseIndex) => {
      const documentIndex = Number.isInteger(row.index) ? Number(row.index) : responseIndex;
      const score = Number(row.relevance_score ?? row.score);
      if (documentIndex >= 0 && documentIndex < scores.length && !assigned[documentIndex] && Number.isFinite(score)) {
        scores[documentIndex] = score;
        assigned[documentIndex] = true;
      }
    });
    if (assigned.some((value) => !value)) throw new Error(`rerank 返回 ${rows.length} 个有效结果，要求覆盖 ${input.documents.length} 个文档`);
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
