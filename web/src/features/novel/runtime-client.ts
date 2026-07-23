import type { LegacyMigrationBundle, RuntimeActor, RuntimeChange, RuntimeEvent, RuntimeOperation, RuntimeProjectMutationResult, RuntimeProjectSnapshot, RuntimeRecordMutation, RuntimeProjectSummary } from "@/novel-runtime/contracts";

const configuredBaseUrl = String(import.meta.env?.VITE_NOVEL_RUNTIME_URL ?? "").trim().replace(/\/+$/, "");
const BASE_URL = configuredBaseUrl || "/novel-api";

export class NovelRuntimeHttpError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); }
}

async function request<T>(path: string, options: { method?: string; body?: unknown; requestKey?: string } = {}): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(options.requestKey ? { "x-ymcp-request-key": options.requestKey } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string; retryable?: boolean } };
  if (!response.ok) throw new NovelRuntimeHttpError(payload.error?.code ?? "HTTP_ERROR", payload.error?.message ?? `HTTP ${response.status}`, payload.error?.retryable);
  return payload as T;
}

export const novelRuntimeClient = {
  health: () => request<{ ok: boolean; service: string; version: number }>("/v1/health"),
  listProjects: () => request<{ projects: RuntimeProjectSummary[] }>("/v1/projects"),
  createProject: (input: { title: string; premise: string; genre: string[] }) => request<{ project: RuntimeProjectSummary }>("/v1/projects", { body: input, requestKey: crypto.randomUUID() }),
  getProject: (projectId: string) => request<{ project: Record<string, unknown>; documents: Array<Record<string, unknown>> }>(`/v1/projects/${encodeURIComponent(projectId)}`),
  projectRecords: (projectId: string) => request<RuntimeProjectSnapshot>(`/v1/projects/${encodeURIComponent(projectId)}/records`),
  mutateProject: (projectId: string, mutations: RuntimeRecordMutation[], actor: RuntimeActor = { type: "user", id: "runtime-ui" }, requestKey = crypto.randomUUID()) =>
    request<RuntimeProjectMutationResult>(`/v1/projects/${encodeURIComponent(projectId)}/mutations`, { body: { actor, mutations }, requestKey }),
  deleteProject: (projectId: string) => request<{ projectId: string; deleted: true }>(`/v1/projects/${encodeURIComponent(projectId)}/delete`, { body: { actor: { type: "user", id: "runtime-ui" } }, requestKey: crypto.randomUUID() }),
  deleteChapter: (projectId: string, documentId: string) => request<{ projectId: string; documentId: string; deleted: true }>(`/v1/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(documentId)}/delete`, { body: { actor: { type: "user", id: "runtime-ui" } }, requestKey: crypto.randomUUID() }),
  status: (projectId: string) => request<{ operations: RuntimeOperation[]; pendingChanges: RuntimeChange[]; activeOperations: RuntimeOperation[]; failedOperations: RuntimeOperation[]; nextActions: unknown[] }>(`/v1/projects/${encodeURIComponent(projectId)}/status`),
  enqueue: (input: { projectId: string; kind: "plan" | "write" | "revise"; instruction: string; target?: string; taskKey?: string; driver?: "human" | "external-mcp" }) => request<{ operation: RuntimeOperation }>("/v1/operations", { body: { ...input, driver: input.driver ?? "human" }, requestKey: crypto.randomUUID() }),
  operation: (operationId: string, afterSequence = 0) => request<{ operation: RuntimeOperation; change?: RuntimeChange; nextActions: unknown[]; events: RuntimeEvent[] }>(`/v1/operations/${encodeURIComponent(operationId)}?afterSequence=${afterSequence}`),
  change: (changeId: string) => request<{ change: RuntimeChange; artifact?: unknown }>(`/v1/changes/${encodeURIComponent(changeId)}`),
  review: (changeId: string, input: { projectId: string; decision: "accept" | "reject" | "revise"; note?: string; actor?: RuntimeActor }) => request(`/v1/changes/${encodeURIComponent(changeId)}/review`, { body: { ...input, actor: input.actor ?? { type: "user", id: "runtime-ui" } }, requestKey: crypto.randomUUID() }),
  migrate: (bundle: LegacyMigrationBundle) => request<{ projectIds: string[]; backupPath: string }>("/v1/migrations/indexeddb", { body: bundle }),
  updateApiConfig: (config: { baseUrl: string; apiKey: string; modelContextWindow: number }) => request<{ baseUrl: string; hasApiKey: boolean; modelContextWindow: number }>("/v1/settings/api", { body: config }),
  eventsUrl: (projectId?: string) => `${BASE_URL}/v1/events${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
};
