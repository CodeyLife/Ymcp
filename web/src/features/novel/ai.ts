import Ajv, { type AnySchema } from "ajv";
import { getEffectiveApiConfig } from "@/stores/ui";
import type { NovelAgentRole } from "./types";

const SYSTEM_INVARIANTS = `你在专业小说创作系统内工作。用户批准的事实库、锁定规则、角色知识边界和审批状态不可被覆盖。区分事实、推断、建议和候选正文。未经批准不得声称已经修改正文或资料。输出必须尊重指定格式，不泄露内部推理。`;

const ROLE_PROMPTS: Record<NovelAgentRole, string> = {
  architect: "你是章节架构师。把上层剧情目标转换为可执行节拍，优先保证因果、人物选择、情绪反应和章尾驱动力。",
  writer: "你是小说正文作者。忠实执行已批准蓝图，用行动、感官、对白和人物选择写作，不擅自改变上层规划。",
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

function extractContent(payload: Record<string, unknown>) {
  const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
  return choices?.[0]?.message?.content?.trim() ?? "";
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
  const body: Record<string, unknown> = { model: params.model, temperature: params.temperature, stream: false, messages: params.messages };
  if (params.responseSchema) body.response_format = { type: "json_schema", json_schema: { name: "novel_artifact", strict: true, schema: params.responseSchema } };
  let response = await fetch(`${endpoint(config.baseUrl)}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }, signal: params.signal, body: JSON.stringify(body) });
  if (!response.ok && params.responseSchema && [400, 404, 422].includes(response.status)) {
    delete body.response_format;
    response = await fetch(`${endpoint(config.baseUrl)}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }, signal: params.signal, body: JSON.stringify(body) });
  }
  if (!response.ok) throw new Error((await response.text().catch(() => "")) || `HTTP ${response.status}`);
  const payload = await response.json() as Record<string, unknown>;
  const content = extractContent(payload);
  if (!content) throw new Error("AI 未返回有效内容");
  const usage = payload.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  return { content, usage: { inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0 } };
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
  const response = await fetch(`${endpoint(config.baseUrl)}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }, signal: params.signal,
    body: JSON.stringify({ model: params.model, temperature: params.temperature, stream: true, messages: [{ role: "system", content: system }, { role: "user", content: params.prompt }] }),
  });
  if (!response.ok) throw new Error((await response.text().catch(() => "")) || `HTTP ${response.status}`);
  if (!response.body) throw new Error("AI 响应没有可读取内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";
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
    const errors = validate.errors?.map((item) => `${item.instancePath || "root"} ${item.message}`).join("；") ?? "无法解析 JSON";
    const repairPrompt = `把下面输出修复为严格符合给定 Schema 的 JSON。不得增加原输出没有的故事事实。\n\nSchema:\n${JSON.stringify(params.schema)}\n\n校验错误：${errors}\n\n原输出：\n${response.content}`;
    const repaired = await requestChat({ model: params.model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: repairPrompt }], signal: params.signal, responseSchema: params.schema });
    response = { content: repaired.content, usage: { inputTokens: response.usage.inputTokens + repaired.usage.inputTokens, outputTokens: response.usage.outputTokens + repaired.usage.outputTokens } };
    try { parsed = parseJsonContent(response.content); } catch { parsed = undefined; }
    if (!parsed || !validate(parsed)) throw new Error(`AI 结构化输出无效：${validate.errors?.map((item) => `${item.instancePath || "root"} ${item.message}`).join("；") ?? "JSON 解析失败"}`);
  }
  return { data: parsed as T, usage: response.usage, promptHash: await hashPrompt(`${system}\n${params.prompt}`) };
}
