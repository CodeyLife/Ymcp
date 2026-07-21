import Ajv, { type AnySchema } from "ajv";
import { getEffectiveApiConfig } from "@/stores/ui";
import type { NovelAgentRole } from "./types";
import { assertModelContextLimit } from "./model-capabilities";

const SYSTEM_INVARIANTS = `你在专业小说创作系统内工作。用户批准的事实库、锁定规则、角色知识边界和审批状态不可被覆盖。输出必须尊重指定格式，不泄露内部推理。`;

const ROLE_PROMPTS: Record<NovelAgentRole, string> = {
  architect: "你是长篇小说架构师。先经营故事土壤——人物处境、世态人情、情境气味——让戏剧性在布局中自然显现，而不是急于宣告主题或推进剧情。规划时注重循序渐进：每层节点先回答'发生了什么、人物如何感受、世界因此有何不同'，再让因果、转折、伏笔在事件铺陈中浮现。情怀、感情与中文意境是规划期就要考虑的底色，不是正文阶段才补的装饰。",
  writer: "你是小说正文作者。忠实执行已批准蓝图和当前写作契约，只输出一份连续正文，不擅自改变上层规划。",
  "style-reviewer": "你是技术文风审校。只检查视角、叙述距离、具体性、重复与项目文风，必须引用证据。",
  "character-reviewer": "你是人物编辑。只检查人物动机、声音、情绪连续性与关系行为，必须引用证据。",
  "continuity-reviewer": "你是连续性编辑。只检查时间、空间、知识、物品、世界规则和已确认事实，不能把审美偏好当矛盾。",
  "plot-reviewer": "你是剧情编辑。检查蓝图落实、因果推进、场景功能、信息释放、剧情线影响、章节张弛与章尾驱动力。",
  "revision-editor": "你是定向修订编辑。只处理质量报告列出的有效问题，保留已通过内容、事实与人物声音。",
  "fact-extractor": "你是事实分析员。只提取已批准正文中有明确证据的状态变化，不直接提交。",
  "quality-editor": "你是总编。汇总相互独立的审校报告，合并重复问题并区分阻断、主要问题和警告。",
  "character-enricher": "你是人物塑造编辑。基于已确认的事实与正文证据，补完人物的外在欲望、内在恐惧、错误信念、未承认需求、道德边界、声音特征与弧光。只填写正文已建立或可合理推断的内容，不得发明与既定事实冲突的设定；不得在 payload 中标注候选/待审核等审批状态。",
  "conversation-assistant": "你是章节创作协作编辑。先理解作者本轮意图，再依据带来源的检索资料回答、澄清和整理创作简报。不得把检索资料之外的推测说成已确认事实；需要进一步证据时提出精确搜索问题。",
  "memory-curator": "你是小说记忆整理员。只从作者明确表达的内容中提炼偏好和任务要求，不把助手建议、推测或未确认故事设定写成长期记忆。",
  "skill-iterator": "你是技能迭代引擎。基于质量报告中的具体 issues，为相关 skill 提出修订后的完整 prompt。修订必须直接回应 issue 中指出的问题，不修改与 issue 无关的部分，保持原 prompt 的整体结构与语气。",
};

export function endpoint(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  // 浏器 dev 模式下走 Vite proxy 避免 CORS；但 Node/SSR 环境（如 novel:closed-loop / novel:20chapters CLI）
  // 没有 window.location，fetch 无法解析相对 URL，必须直连 baseUrl。
  if (normalized === "https://gpt.eromaa.com/v1" && import.meta.env.DEV && typeof window !== "undefined") return "/ai-proxy";
  return normalized;
}
async function hashPrompt(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;
// 默认超时：结构化调用（蓝图/审校/事实）180s，流式正文生成 300s
const DEFAULT_STRUCTURED_TIMEOUT_MS = 180_000;
const DEFAULT_STREAM_TIMEOUT_MS = 300_000;

function createTimeoutSignal(timeoutMs?: number, external?: AbortSignal): AbortSignal | undefined {
  if (!timeoutMs) return external;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(`LLM 调用超时（${timeoutMs}ms）`, "TimeoutError")), timeoutMs);
  // 若外部 signal 先触发，同步 abort 并清理 timer
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", () => { controller.abort(external.reason); clearTimeout(timer); }, { once: true });
  }
  // 当 controller 自身 abort（含超时或外部联动）时清理 timer，避免泄漏
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

function isTimeoutAbort(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /超时|timeout/i.test(message);
}

class NovelHttpError extends Error {
  constructor(readonly status: number, readonly responseBody: string) {
    super(`HTTP ${status}${responseBody ? `: ${responseBody}` : ""}`);
    this.name = "NovelHttpError";
  }
}

class NovelEmptyResponseError extends Error {
  constructor(message = "AI 未返回有效内容") {
    super(message);
    this.name = "NovelEmptyResponseError";
  }
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return false;
  if (isTimeoutAbort(error)) return false;
  if (error instanceof NovelEmptyResponseError) return true;
  if (error instanceof NovelHttpError) return error.status === 429 || error.status >= 500;
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /terminated|HTTP 5\d\d|HTTP 429|ECONNRESET|ENOTFOUND|fetch failed|socket hang up/i.test(message);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function parseSseEvent(line: string): Record<string, unknown> | undefined {
  const raw = line.replace(/^data:\s*/, "").trim();
  if (!raw || raw === "[DONE]") return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractMessageContent(payload: Record<string, unknown>): string {
  const choices = payload.choices as Array<{ message?: { content?: string | Array<{ text?: string }> } }> | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("").trim();
  return "";
}

async function fetchNonStreamingContent(params: {
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}) {
  const response = await fetch(`${endpoint(params.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${params.apiKey}` },
    signal: params.signal,
    body: JSON.stringify({ ...params.body, stream: false }),
  });
  const responseText = await response.text().catch(() => "");
  if (!response.ok) throw new NovelHttpError(response.status, responseText);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    throw new NovelEmptyResponseError("AI 非流式降级响应不是有效 JSON");
  }
  const content = extractMessageContent(payload);
  if (!content) {
    // 诊断：dump payload 结构（不含完整内容，只看 choices/usage/finish_reason）
    const diag = {
      model: params.body.model,
      hasResponseFormat: Boolean(params.body.response_format),
      choicesCount: (payload.choices as unknown[] | undefined)?.length ?? 0,
      firstChoiceFinishReason: (payload.choices as Array<{ finish_reason?: string }> | undefined)?.[0]?.finish_reason,
      usage: payload.usage,
      responseTextHead: responseText.slice(0, 500),
    };
    console.error(`[ai.ts] 非流式空内容诊断：${JSON.stringify(diag)}`);
    throw new NovelEmptyResponseError("AI 流式与非流式请求均未返回有效内容");
  }
  return content;
}

async function fetchNonStreamingContentWithRetry(params: Parameters<typeof fetchNonStreamingContent>[0]) {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      return await fetchNonStreamingContent(params);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === MAX_RETRIES - 1) throw error;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * 500);
    }
  }
  throw lastError;
}

async function fetchAccumulated(params: {
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}) {
  const response = await fetch(`${endpoint(params.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${params.apiKey}` },
    signal: params.signal,
    body: JSON.stringify({ ...params.body, stream: true, stream_options: { include_usage: true } }),
  });
  if (!response.ok) throw new NovelHttpError(response.status, await response.text().catch(() => ""));
  if (!response.body) throw new Error("AI 响应没有可读取内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const consumeLine = (line: string) => {
    const chunk = parseSseEvent(line);
    if (!chunk) return;
    const choices = chunk.choices as Array<{ delta?: { content?: string } }> | undefined;
    result += choices?.[0]?.delta?.content ?? "";
    const usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (usage) {
      inputTokens = usage.prompt_tokens ?? 0;
      outputTokens = usage.completion_tokens ?? 0;
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  }
  buffer += decoder.decode();
  for (const line of buffer.split("\n")) consumeLine(line);
  if (!result.trim()) throw new NovelEmptyResponseError();
  return { content: result.trim(), usage: { inputTokens, outputTokens } };
}

async function requestChat(params: {
  model: string;
  temperature: number;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  signal?: AbortSignal;
  responseSchema?: Record<string, unknown>;
  maxTokens?: number;
}) {
  const config = getEffectiveApiConfig();
  if (!config.apiKey) throw new Error("请先在设置中配置 API Key");
  assertModelContextLimit({ model: params.model, text: params.messages.map((message) => message.content).join("\n"), override: config.modelContextWindow, outputReserve: params.maxTokens ?? 4096 });
  const body: Record<string, unknown> = { model: params.model, temperature: params.temperature, messages: params.messages };
  if (params.maxTokens && params.maxTokens > 0) body.max_tokens = params.maxTokens;
  if (params.responseSchema) body.response_format = { type: "json_schema", json_schema: { name: "novel_artifact", strict: true, schema: params.responseSchema } };
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      try {
        return await fetchAccumulated({ baseUrl: config.baseUrl, apiKey: config.apiKey, body, signal: params.signal });
      } catch (error) {
        if (params.responseSchema && error instanceof NovelHttpError && [400, 404, 422].includes(error.status)) {
          const fallbackBody = { ...body };
          delete fallbackBody.response_format;
          return await fetchAccumulated({ baseUrl: config.baseUrl, apiKey: config.apiKey, body: fallbackBody, signal: params.signal });
        }
        // 流式 + response_format strict 模式在某些 OpenAI 兼容提供商（如 eromaa.com）
        // 会返回 HTTP 200 + 空 content（provider 端 bug，非 4xx，不会触发上面的 fallback）。
        // 此时立刻降级为非流式 + 去 schema 调用：parseJsonContent 已能处理 markdown 包裹的 JSON。
        if (params.responseSchema && error instanceof NovelEmptyResponseError) {
          const fallbackBody = { ...body };
          delete fallbackBody.response_format;
          return { content: await fetchNonStreamingContentWithRetry({ baseUrl: config.baseUrl, apiKey: config.apiKey, body: fallbackBody, signal: params.signal }), usage: { inputTokens: 0, outputTokens: 0 } };
        }
        throw error;
      }
    } catch (error) {
      lastError = error;
      if (error instanceof NovelEmptyResponseError && attempt === MAX_RETRIES - 1) {
        const content = await fetchNonStreamingContentWithRetry({ baseUrl: config.baseUrl, apiKey: config.apiKey, body, signal: params.signal });
        return { content, usage: { inputTokens: 0, outputTokens: 0 } };
      }
      if (!isRetryableError(error) || attempt === MAX_RETRIES - 1) throw error;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * 500);
    }
  }
  throw lastError;
}

export async function streamNovelModel(params: {
  model: string;
  temperature: number;
  role: NovelAgentRole;
  prompt: string;
  skillPrompt?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTokens?: number;
  onToken?: (text: string) => void;
}) {
  const config = getEffectiveApiConfig();
  if (!config.apiKey) throw new Error("请先在设置中配置 API Key");
  const system = [SYSTEM_INVARIANTS, ROLE_PROMPTS[params.role], params.skillPrompt].filter(Boolean).join("\n\n");
  assertModelContextLimit({ model: params.model, text: `${system}\n${params.prompt}`, override: config.modelContextWindow, outputReserve: params.maxTokens ?? 8192 });
  const signal = createTimeoutSignal(params.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS, params.signal);
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    let result = "";
    try {
      // Loop 3 实测：revision-stage 重写整章时 LLM 因默认 max_tokens 不足而返回"请分多次发送"拒绝消息
      // 默认 max_tokens（通常 4096）只能输出约 2000-3000 中文字，但章节蓝图目标 5000 字
      // 当 maxTokens 显式提供时传入 API，否则使用 API 提供商默认值
      const requestBody: Record<string, unknown> = {
        model: params.model,
        temperature: params.temperature,
        stream: true,
        messages: [{ role: "system", content: system }, { role: "user", content: params.prompt }],
      };
      if (params.maxTokens && params.maxTokens > 0) {
        requestBody.max_tokens = params.maxTokens;
      }
      const response = await fetch(`${endpoint(config.baseUrl)}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }, signal,
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) throw new NovelHttpError(response.status, await response.text().catch(() => ""));
      if (!response.body) throw new Error("AI 响应没有可读取内容");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventCount = 0;
      let reportedOutputTokens = 0;
      const finishReasons = new Set<string>();
      const deltaFields = new Set<string>();
      const consumeLine = (line: string) => {
        const chunk = parseSseEvent(line);
        if (!chunk) return;
        eventCount += 1;
        const choices = chunk.choices as Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }> | undefined;
        const choice = choices?.[0];
        if (choice?.finish_reason) finishReasons.add(choice.finish_reason);
        for (const field of Object.keys(choice?.delta ?? {})) deltaFields.add(field);
        const usage = chunk.usage as { completion_tokens?: number } | undefined;
        reportedOutputTokens = usage?.completion_tokens ?? reportedOutputTokens;
        const token = typeof choice?.delta?.content === "string" ? choice.delta.content : "";
        if (!token) return;
        result += token;
        params.onToken?.(result);
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      }
      buffer += decoder.decode();
      for (const line of buffer.split("\n")) consumeLine(line);
      if (!result.trim()) {
        throw new NovelEmptyResponseError(`AI 未返回有效内容（SSE events=${eventCount}, finish=${[...finishReasons].join("|") || "none"}, delta=${[...deltaFields].join("|") || "none"}, outputTokens=${reportedOutputTokens}）`);
      }
      return { content: result.trim(), promptHash: await hashPrompt(`${system}\n${params.prompt}`) };
    } catch (error) {
      lastError = error;
      if (error instanceof NovelEmptyResponseError && attempt === MAX_RETRIES - 1) {
        const requestBody: Record<string, unknown> = {
          model: params.model,
          temperature: params.temperature,
          messages: [{ role: "system", content: system }, { role: "user", content: params.prompt }],
        };
        if (params.maxTokens && params.maxTokens > 0) requestBody.max_tokens = params.maxTokens;
        const content = await fetchNonStreamingContentWithRetry({ baseUrl: config.baseUrl, apiKey: config.apiKey, body: requestBody, signal });
        params.onToken?.(content);
        return { content, promptHash: await hashPrompt(`${system}\n${params.prompt}`) };
      }
      if (!isRetryableError(error) || attempt === MAX_RETRIES - 1) throw error;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * 500);
    }
  }
  throw lastError;
}

function parseJsonContent(content: string) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  return JSON.parse(candidate.trim()) as Record<string, unknown>;
}

export async function callStructuredNovelModel<T extends Record<string, unknown>>(params: {
  model: string;
  temperature: number;
  role: NovelAgentRole;
  prompt: string;
  skillPrompt?: string;
  schema: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTokens?: number;
}) {
  const system = [SYSTEM_INVARIANTS, ROLE_PROMPTS[params.role], params.skillPrompt, "只输出符合 JSON Schema 的 JSON，不要使用 Markdown 代码围栏。"].filter(Boolean).join("\n\n");
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{ role: "system", content: system }, { role: "user", content: params.prompt }];
  const validate = new Ajv({ allErrors: true, strict: false }).compile(params.schema as AnySchema);
  const signal = createTimeoutSignal(params.timeoutMs ?? DEFAULT_STRUCTURED_TIMEOUT_MS, params.signal);
  let response = await requestChat({ ...params, signal, messages, responseSchema: params.schema });
  let parsed: Record<string, unknown> | undefined;
  try { parsed = parseJsonContent(response.content); } catch { parsed = undefined; }
  if (!parsed || !validate(parsed)) {
    const schemaStr = JSON.stringify(params.schema, null, 2);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const errors = validate.errors?.map((item) => `${item.instancePath || "root"} ${item.message}`).join("；") ?? "无法解析 JSON";
      const repairPrompt = attempt === 0
        ? `把下面输出修复为严格符合给定 Schema 的 JSON。不得增加原输出没有的故事事实。summary 字段只写候选整体概览，禁止描述修复过程、Schema 约束或被丢弃的字段。\n\nSchema:\n${schemaStr}\n\n校验错误：${errors}\n\n原输出：\n${response.content}`
        : `上一次修复仍然失败。请完全重新生成符合 Schema 的 JSON。只输出 JSON，不要输出任何其他内容。summary 字段只写候选整体概览，禁止描述修复过程、Schema 约束或被丢弃的字段。\n\n必须包含的字段：${Object.keys(params.schema.properties ?? {}).join(", ")}\n\nSchema:\n${schemaStr}\n\n校验错误：${errors}\n\n原输出：\n${response.content}`;
      const repaired = await requestChat({ model: params.model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: repairPrompt }], signal, responseSchema: params.schema, maxTokens: params.maxTokens });
      response = { content: repaired.content, usage: { inputTokens: response.usage.inputTokens + repaired.usage.inputTokens, outputTokens: response.usage.outputTokens + repaired.usage.outputTokens } };
      try { parsed = parseJsonContent(response.content); } catch { parsed = undefined; }
      if (parsed && validate(parsed)) break;
    }
    if (!parsed || !validate(parsed)) throw new Error(`AI 结构化输出无效：${validate.errors?.map((item) => `${item.instancePath || "root"} ${item.message}`).join("；") ?? "JSON 解析失败"}`);
  }
  return { data: parsed as T, usage: response.usage, promptHash: await hashPrompt(`${system}\n${params.prompt}`) };
}
