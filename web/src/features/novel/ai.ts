import Ajv, { type AnySchema } from "ajv";
import { getEffectiveApiConfig } from "@/stores/ui";
import type { NovelAgentRole } from "./types";

const SYSTEM_INVARIANTS = `你在专业小说创作系统内工作。用户批准的事实库、锁定规则、角色知识边界和审批状态不可被覆盖。区分事实、推断、建议和候选正文。未经批准不得声称已经修改正文或资料。输出必须尊重指定格式，不泄露内部推理。`;

const ROLE_PROMPTS: Record<NovelAgentRole, string> = {
  architect: "你是长篇小说架构师。先经营故事土壤——人物处境、世态人情、情境气味——让戏剧性在布局中自然显现，而不是急于宣告主题或推进剧情。规划时注重循序渐进：每层节点先回答'发生了什么、人物如何感受、世界因此有何不同'，再让因果、转折、伏笔在事件铺陈中浮现。情怀、感情与中文意境是规划期就要考虑的底色，不是正文阶段才补的装饰。",
  writer: "你是小说正文作者。忠实执行已批准蓝图，用行动、感官、对白和人物选择写作，不擅自改变上层规划。追求中文意境美：以意象承载情绪，以留白代替直说，以白描承重，以长短句交错形成呼吸感。叙述者隐身，让读者通过人物的选择与遭遇自己体会主题。",
  "style-reviewer": "你是技术文风审校。只检查视角、叙述距离、具体性、重复与项目文风，必须引用证据。",
  "character-reviewer": "你是人物编辑。只检查人物动机、声音、情绪连续性与关系行为，必须引用证据。",
  "continuity-reviewer": "你是连续性编辑。只检查时间、空间、知识、物品、世界规则和已确认事实，不能把审美偏好当矛盾。",
  "plot-reviewer": "你是剧情编辑。检查蓝图落实、因果推进、场景功能、信息释放和剧情线影响。",
  "pacing-reviewer": "你是连载节奏编辑。检查章节承诺、张弛、阶段回报、冗余和章尾驱动力。",
  "revision-editor": "你是定向修订编辑。只处理质量报告列出的有效问题，保留已通过内容、事实与人物声音。",
  "fact-extractor": "你是事实分析员。只提取已批准正文中有明确证据的状态变化，不直接提交。",
  "quality-editor": "你是总编。汇总相互独立的审校报告，合并重复问题并区分阻断、主要问题和警告。",
};

export function endpoint(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized === "https://gpt.eromaa.com/v1" && import.meta.env.DEV) return "/ai-proxy";
  return normalized;
}
async function hashPrompt(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;

class NovelHttpError extends Error {
  constructor(readonly status: number, readonly responseBody: string) {
    super(`HTTP ${status}${responseBody ? `: ${responseBody}` : ""}`);
    this.name = "NovelHttpError";
  }
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (error instanceof NovelHttpError) return error.status === 429 || error.status >= 500;
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|timeout|terminated|HTTP 5\d\d|HTTP 429|ECONNRESET|ENOTFOUND|fetch failed|socket hang up/i.test(message);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const raw = line.replace(/^data:\s*/, "").trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const chunk = JSON.parse(raw);
        result += chunk?.choices?.[0]?.delta?.content ?? "";
        if (chunk?.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0;
          outputTokens = chunk.usage.completion_tokens ?? 0;
        }
      } catch { /* vendor keepalive */ }
    }
  }
  if (!result.trim()) throw new Error("AI 未返回有效内容");
  return { content: result.trim(), usage: { inputTokens, outputTokens } };
}

async function requestChat(params: {
  model: string;
  temperature: number;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  signal?: AbortSignal;
  responseSchema?: Record<string, unknown>;
}) {
  const config = getEffectiveApiConfig();
  if (!config.apiKey) throw new Error("请先在设置中配置 API Key");
  const body: Record<string, unknown> = { model: params.model, temperature: params.temperature, messages: params.messages };
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
        throw error;
      }
    } catch (error) {
      lastError = error;
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
  onToken?: (text: string) => void;
}) {
  const config = getEffectiveApiConfig();
  if (!config.apiKey) throw new Error("请先在设置中配置 API Key");
  const system = [SYSTEM_INVARIANTS, ROLE_PROMPTS[params.role], params.skillPrompt].filter(Boolean).join("\n\n");
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    let result = "";
    try {
      const response = await fetch(`${endpoint(config.baseUrl)}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }, signal: params.signal,
        body: JSON.stringify({ model: params.model, temperature: params.temperature, stream: true, messages: [{ role: "system", content: system }, { role: "user", content: params.prompt }] }),
      });
      if (!response.ok) throw new NovelHttpError(response.status, await response.text().catch(() => ""));
      if (!response.body) throw new Error("AI 响应没有可读取内容");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const raw = line.replace(/^data:\s*/, "").trim();
          if (!raw || raw === "[DONE]") continue;
          try { const token = JSON.parse(raw)?.choices?.[0]?.delta?.content ?? ""; result += token; params.onToken?.(result); } catch { /* vendor keepalive */ }
        }
      }
      if (!result.trim()) throw new Error("AI 未返回有效内容");
      return { content: result.trim(), promptHash: await hashPrompt(`${system}\n${params.prompt}`) };
    } catch (error) {
      lastError = error;
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
}) {
  const system = [SYSTEM_INVARIANTS, ROLE_PROMPTS[params.role], params.skillPrompt, "只输出符合 JSON Schema 的 JSON，不要使用 Markdown 代码围栏。"].filter(Boolean).join("\n\n");
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{ role: "system", content: system }, { role: "user", content: params.prompt }];
  const validate = new Ajv({ allErrors: true, strict: false }).compile(params.schema as AnySchema);
  let response = await requestChat({ ...params, messages, responseSchema: params.schema });
  let parsed: Record<string, unknown> | undefined;
  try { parsed = parseJsonContent(response.content); } catch { parsed = undefined; }
  if (!parsed || !validate(parsed)) {
    const schemaStr = JSON.stringify(params.schema, null, 2);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const errors = validate.errors?.map((item) => `${item.instancePath || "root"} ${item.message}`).join("；") ?? "无法解析 JSON";
      const repairPrompt = attempt === 0
        ? `把下面输出修复为严格符合给定 Schema 的 JSON。不得增加原输出没有的故事事实。summary 字段只写候选整体概览，禁止描述修复过程、Schema 约束或被丢弃的字段。\n\nSchema:\n${schemaStr}\n\n校验错误：${errors}\n\n原输出：\n${response.content}`
        : `上一次修复仍然失败。请完全重新生成符合 Schema 的 JSON。只输出 JSON，不要输出任何其他内容。summary 字段只写候选整体概览，禁止描述修复过程、Schema 约束或被丢弃的字段。\n\n必须包含的字段：${Object.keys(params.schema.properties ?? {}).join(", ")}\n\nSchema:\n${schemaStr}\n\n校验错误：${errors}\n\n原输出：\n${response.content}`;
      const repaired = await requestChat({ model: params.model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: repairPrompt }], signal: params.signal, responseSchema: params.schema });
      response = { content: repaired.content, usage: { inputTokens: response.usage.inputTokens + repaired.usage.inputTokens, outputTokens: response.usage.outputTokens + repaired.usage.outputTokens } };
      try { parsed = parseJsonContent(response.content); } catch { parsed = undefined; }
      if (parsed && validate(parsed)) break;
    }
    if (!parsed || !validate(parsed)) throw new Error(`AI 结构化输出无效：${validate.errors?.map((item) => `${item.instancePath || "root"} ${item.message}`).join("；") ?? "JSON 解析失败"}`);
  }
  return { data: parsed as T, usage: response.usage, promptHash: await hashPrompt(`${system}\n${params.prompt}`) };
}
