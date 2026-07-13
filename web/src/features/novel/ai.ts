import Ajv, { type AnySchema } from "ajv";
import { getEffectiveApiConfig } from "@/stores/ui";
import { novelDb, recordBase } from "./db";
import { compileNovelContext, formatContextPacket } from "./context";
import { formatSkillPrompt, resolveNovelSkills } from "./skills";
import type { AgentRun, AIProposal, NovelAgentRole, NovelContextPacket, NovelSkillStage } from "./types";

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

function endpoint(baseUrl: string) {
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

export const NOVEL_AI_ACTIONS = [
  { key: "plan-next", label: "规划近期剧情", role: "architect" as const, stage: "planning" as const, instruction: "结合当前事实库规划后续五章，明确每章目标、冲突、转折、信息释放、伏笔推进和章尾驱动力。" },
  { key: "draft", label: "生成章节草稿", role: "writer" as const, stage: "drafting" as const, instruction: "依据已批准章节蓝图生成完整章节草稿，保持人物声音和知识边界。" },
  { key: "character", label: "深化角色", role: "architect" as const, stage: "foundation" as const, instruction: "深化相关角色的欲望、恐惧、错误信念、真实需求、声音和关系张力。" },
  { key: "continuity", label: "一致性审校", role: "continuity-reviewer" as const, stage: "review" as const, instruction: "检查时间、空间、人物知识、物品、世界规则和因果，引用证据并区分严重度。" },
  { key: "rewrite", label: "编辑式修订", role: "revision-editor" as const, stage: "revision" as const, instruction: "依据具体问题定向修订当前章节，保留已通过内容与事实。" },
] as const;

export async function runNovelAI(params: { projectId: string; action: string; instruction: string; targetDocumentId?: string; signal?: AbortSignal; onToken?: (text: string) => void }): Promise<{ proposal: AIProposal; packet: NovelContextPacket; run: AgentRun }> {
  const project = await novelDb.projects.get(params.projectId);
  if (!project) throw new Error("项目不存在");
  const action = NOVEL_AI_ACTIONS.find((item) => item.key === params.action) ?? NOVEL_AI_ACTIONS[0];
  const resolved = await resolveNovelSkills({ projectId: params.projectId, stage: action.stage as NovelSkillStage });
  if (resolved.conflicts.length) throw new Error(`Skill 冲突：${resolved.conflicts.map((item) => `${item.skillId} ↔ ${item.conflictsWith}`).join("；")}`);
  const packet = await compileNovelContext({ projectId: params.projectId, task: params.action, instruction: params.instruction, targetDocumentId: params.targetDocumentId, stage: action.stage, resolvedSkills: resolved.skills });
  const run: AgentRun = { ...recordBase(params.projectId), goal: params.instruction, status: "running", model: project.settings.textModel, promptVersion: "novel-skill-v2", contextPacketId: packet.id, role: action.role, skillRefs: resolved.skills.map((item) => `${item.skillId}@${item.version}`), artifactRefs: [], attempt: 1, startedAt: Date.now(), steps: [
    { id: crypto.randomUUID(), title: "冻结分层上下文", tool: "context.compile", status: "completed", output: `${packet.sources.length} 项来源` },
    { id: crypto.randomUUID(), title: "执行声明式 Skill", tool: "model.chat", status: "running" },
    { id: crypto.randomUUID(), title: "等待用户审阅", tool: "proposal.review", status: "pending" },
  ] };
  await novelDb.agentRuns.add(run);
  try {
    const prompt = `# 任务\n${params.instruction}\n\n# 冻结上下文\n${formatContextPacket(packet)}\n\n# 输出契约\n输出可直接审阅的 Markdown。列明意图、影响与连续性风险，不得声称已经修改项目。`;
    const output = await streamNovelModel({ model: project.settings.textModel, temperature: project.settings.temperature, role: action.role, skillPrompt: formatSkillPrompt(resolved.skills), prompt, signal: params.signal, onToken: params.onToken });
    run.status = "completed"; run.finishedAt = Date.now(); run.promptHash = output.promptHash; run.steps[1].status = "completed"; run.steps[1].output = output.content; run.steps[2].status = "completed";
    await novelDb.agentRuns.put({ ...run, revision: run.revision + 1, updatedAt: Date.now() });
    const proposal: AIProposal = { ...recordBase(params.projectId), title: action.label, operation: params.action, targetId: params.targetDocumentId, status: "pending", previewMarkdown: output.content, patches: [], contextPacketId: packet.id, agentRunId: run.id, model: project.settings.textModel };
    await novelDb.proposals.add(proposal);
    return { proposal, packet, run };
  } catch (error) {
    run.status = params.signal?.aborted ? "cancelled" : "failed"; run.finishedAt = Date.now(); run.steps[1].status = "failed"; run.steps[1].error = error instanceof Error ? error.message : "未知错误";
    await novelDb.agentRuns.put({ ...run, revision: run.revision + 1, updatedAt: Date.now() });
    throw error;
  }
}
