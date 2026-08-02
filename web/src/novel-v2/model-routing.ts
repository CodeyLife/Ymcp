import { createHash } from "node:crypto";
import type { PromptContextManifest } from "./protocol";

export const MODEL_PURPOSES = [
  "planning.foundation",
  "planning.blueprint",
  "planning.arc",
  "planning.arc-revision",
  "writing.draft",
  "writing.revision",
  "review.style",
  "review.character",
  "review.continuity",
  "review.plot",
  "review.reader",
  "review.foundation",
  "review.arc",
  "facts.extract",
  "learning.assess",
  "skill.iterate",
  "memory.embed",
  "memory.rerank",
] as const;

export type ModelPurpose = (typeof MODEL_PURPOSES)[number];
export type ModelProtocol = "chat-completions" | "responses";
export type ModelCapability = "text" | "structured" | "stream" | "responses-continuation" | "embedding" | "rerank";
export type ConversationPolicy = "stateless" | "task-chain";

export type ModelSecret =
  | { source: "inline"; value: string }
  | { source: "env"; name: string };

export interface ModelProviderProfile {
  id: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  responseMode?: "json" | "sse";
  capabilities: ModelCapability[];
  secret?: ModelSecret;
  enabled: boolean;
  timeoutMs?: number;
  contextWindow?: number;
}

export type RouteCandidate =
  | { executor: "api"; profileId: string; model?: string }
  | { executor: "external-mcp" };

export interface ModelRoute {
  candidates: RouteCandidate[];
  conversationPolicy?: ConversationPolicy;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface ModelRoutingConfig {
  version: 1;
  profiles: ModelProviderProfile[];
  routes: Record<string, ModelRoute>;
}

export interface ModelRoutingSnapshot {
  id: string;
  configVersion: number;
  profiles: Array<Omit<ModelProviderProfile, "secret"> & { secretRef?: string; hasSecret: boolean }>;
  routes: Record<string, ModelRoute>;
  createdAt: number;
}

export interface ModelExecutionProvenance {
  routeSnapshotId: string;
  purpose: ModelPurpose;
  candidateIndex: number;
  executor: "api" | "external-mcp";
  profileId?: string;
  protocol?: ModelProtocol;
  model: string;
  responseId?: string;
  promptFingerprint: string;
}

export interface ModelWorkPackage {
  id: string;
  workflowRunId: string;
  taskId: string;
  purpose: ModelPurpose;
  configRevision: string;
  candidateIndex: number;
  outputKind: "text" | "structured" | "review";
  system?: string;
  instruction: string;
  schema?: Record<string, unknown>;
  schemaName?: string;
  baseRevision: number;
  inputFingerprint: string;
  contextRefs: Record<string, string | undefined>;
  /** Optional for historical tasks; new compiled prompts carry the same manifest as API execution. */
  promptContext?: PromptContextManifest;
  createdAt: number;
}

export interface ModelTaskRecord {
  id: string;
  workflowRunId: string;
  taskId: string;
  purpose: ModelPurpose;
  configRevision: string;
  candidateIndex: number;
  status: "pending" | "claimed" | "running" | "submitted" | "failed" | "cancelled";
  workPackage: ModelWorkPackage;
  result?: { text?: string; value?: unknown; reviewer?: string; verdict?: string; issues?: unknown[] };
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export class ModelRoutingConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`模型路由配置无效：${problems.join("；")}`);
    this.name = "ModelRoutingConfigError";
  }
}

export class ExternalMcpRequiredError extends Error {
  constructor(
    readonly purpose: ModelPurpose,
    readonly snapshotId: string,
    readonly candidateIndex: number,
  ) {
    super(`模型任务 ${purpose} 需要由外部 MCP 执行`);
    this.name = "ExternalMcpRequiredError";
  }
}

const PURPOSE_CAPABILITY: Record<ModelPurpose, ModelCapability> = {
  "planning.foundation": "structured",
  "planning.blueprint": "structured",
  "planning.arc": "structured",
  "planning.arc-revision": "structured",
  "writing.draft": "text",
  "writing.revision": "text",
  "review.style": "structured",
  "review.character": "structured",
  "review.continuity": "structured",
  "review.plot": "structured",
  "review.reader": "structured",
  "review.foundation": "structured",
  "review.arc": "structured",
  "facts.extract": "structured",
  "learning.assess": "structured",
  "skill.iterate": "structured",
  "memory.embed": "embedding",
  "memory.rerank": "rerank",
};

export function requiredCapability(purpose: ModelPurpose): ModelCapability {
  return PURPOSE_CAPABILITY[purpose];
}

export function resolveRoute(config: Pick<ModelRoutingConfig, "routes">, purpose: ModelPurpose): ModelRoute | undefined {
  return config.routes[purpose] ?? config.routes[`${purpose.split(".")[0]}.*`] ?? config.routes["*"];
}

export function validateModelRoutingConfig(config: ModelRoutingConfig): void {
  const problems: string[] = [];
  if (config.version !== 1) problems.push("仅支持 version=1");
  const profiles = new Map<string, ModelProviderProfile>();
  for (const profile of config.profiles ?? []) {
    if (!profile.id?.trim()) problems.push("profile.id 不能为空");
    if (profiles.has(profile.id)) problems.push(`profile.id 重复：${profile.id}`);
    profiles.set(profile.id, profile);
    try { new URL(profile.baseUrl); } catch { problems.push(`profile ${profile.id} 的 baseUrl 无效`); }
    if (!profile.model?.trim()) problems.push(`profile ${profile.id} 缺少默认模型`);
    if (!Array.isArray(profile.capabilities) || !profile.capabilities.length) problems.push(`profile ${profile.id} 缺少 capabilities`);
    if (profile.protocol === "responses" && profile.responseMode === "sse") problems.push(`profile ${profile.id} 的 Responses adapter 当前仅支持 JSON 聚合`);
    if (profile.secret?.source === "inline" && !profile.secret.value.trim()) problems.push(`profile ${profile.id} 的 inline key 为空`);
    if (profile.secret?.source === "env" && !profile.secret.name.trim()) problems.push(`profile ${profile.id} 的环境变量名为空`);
  }
  if (!Object.keys(config.routes ?? {}).length) problems.push("至少需要一条模型路由");
  for (const purpose of MODEL_PURPOSES) {
    const route = resolveRoute(config, purpose);
    if (!route?.candidates.length) {
      problems.push(`purpose ${purpose} 没有可用候选链`);
      continue;
    }
    if (route.conversationPolicy === "task-chain" && !purpose.startsWith("writing.")) {
      problems.push(`task-chain 仅允许 writing.*：${purpose}`);
    }
    for (const candidate of route.candidates) {
      if (candidate.executor === "external-mcp") continue;
      const profile = profiles.get(candidate.profileId);
      if (!profile) {
        problems.push(`purpose ${purpose} 引用了不存在的 profile ${candidate.profileId}`);
        continue;
      }
      if (!profile.enabled) problems.push(`purpose ${purpose} 引用了已禁用的 profile ${profile.id}`);
      const capability = requiredCapability(purpose);
      if (!profile.capabilities.includes(capability)) problems.push(`profile ${profile.id} 不支持 ${purpose} 所需的 ${capability}`);
      if (route.conversationPolicy === "task-chain" && (profile.protocol !== "responses" || !profile.capabilities.includes("responses-continuation"))) {
        problems.push(`purpose ${purpose} 的 task-chain 候选 ${profile.id} 不支持 Responses 续接`);
      }
    }
  }
  if (problems.length) throw new ModelRoutingConfigError([...new Set(problems)]);
}

function secretRef(secret?: ModelSecret): string | undefined {
  if (!secret) return undefined;
  return secret.source === "env" ? `env:${secret.name}` : "local:inline";
}

export function createRoutingSnapshot(config: ModelRoutingConfig, now = Date.now()): ModelRoutingSnapshot {
  validateModelRoutingConfig(config);
  const sanitized = {
    version: config.version,
    profiles: config.profiles.map(({ secret, ...profile }) => ({ ...profile, secretRef: secretRef(secret), hasSecret: Boolean(secret) })),
    routes: config.routes,
  };
  const id = createHash("sha256").update(JSON.stringify(sanitized)).digest("hex");
  return { id, configVersion: config.version, profiles: sanitized.profiles, routes: structuredClone(config.routes), createdAt: now };
}

export function maskSecret(secret?: ModelSecret): { hasSecret: boolean; secretSource?: "inline" | "env"; secretHint?: string } {
  if (!secret) return { hasSecret: false };
  if (secret.source === "env") return { hasSecret: true, secretSource: "env", secretHint: secret.name };
  const value = secret.value.trim();
  return { hasSecret: Boolean(value), secretSource: "inline", secretHint: value ? `***${value.slice(-4)}` : undefined };
}

export function resolveProfileSecret(profile: ModelProviderProfile): string {
  if (!profile.secret) return "";
  return profile.secret.source === "inline" ? profile.secret.value : process.env[profile.secret.name] ?? "";
}
