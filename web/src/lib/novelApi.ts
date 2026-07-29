/* ============================================================
 * novel-v2 数据层 — 统一的 typed fetch + React Query hooks
 *
 * 现状：此前各面板（NovelV2Studio / CreativeRunPanel / EvaluationPanel）
 * 各自重复 readJson + useState + 轮询。这里收敛为共享数据层，
 * 由 main.tsx 挂载的 QueryClientProvider 提供缓存/去重/轮询。
 * ============================================================ */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

// ---------- API 类型（对齐 scripts/novel-v2-api.ts 返回体） ----------
export interface NovelDocumentSummary {
  id: string;
  title: string;
  narrativeOrder: number;
  status: string;
  povCharacterId?: string;
  wordCount?: number;
  latestRevision?: number;
  blockingIssueCount?: number;
  arcId?: string;
  arcTitle?: string;
  arcPlanningStatus?: string;
}

export interface NovelProjectSummary {
  id: string;
  title: string;
  currentRevision?: number;
  current_revision?: number;
  updatedAt?: string;
  updated_at?: string;
  latestRunStatus?: string;
}

export interface NovelWorkflowRunRecord {
  id: string;
  workflowType: string;
  projectId: string;
  temporalWorkflowId: string;
  status: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface NovelProjectDetail {
  id: string;
  title: string;
  currentRevision: number;
  updatedAt: string;
  documents: NovelDocumentSummary[];
  latestRuns?: NovelWorkflowRunRecord[];
}

export interface NovelRunState {
  workflowId: string;
  status: string;
  runId?: string;
  record?: NovelWorkflowRunRecord;
}

export interface NovelRunEvent {
  id?: number;
  event_type?: string;
  eventType?: string;
  payload?: unknown;
  created_at?: string;
  createdAt?: string;
}

export interface NovelArtifactSummary {
  id: string;
  projectId: string;
  taskId: string;
  attemptId?: string;
  kind: string;
  contentHash?: string;
  objectKey?: string;
  structuredData?: Record<string, unknown>;
  baseRevision?: number;
  createdAt?: string | number;
  fingerprint?: string;
}

export interface NovelReviewSummary {
  id: string;
  artifactId: string;
  reviewerId: string;
  identity: "internal" | "independent" | "human";
  verdict: "passed" | "revise" | "blocked";
  issues: Array<{
    severity: "blocker" | "major" | "warning";
    title?: string;
    description?: string;
    excerpt?: string;
    dimension?: string;
    rule?: string;
    suggestion?: string;
  }>;
  score?: number;
  role?: string;
  createdAt: number;
}

export function novelRunDocumentId(run: NovelWorkflowRunRecord | undefined): string | undefined {
  if (!run) return undefined;
  if (typeof run.payload.documentId === "string") return run.payload.documentId;
  const intent = run.payload.intent;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return undefined;
  const target = (intent as Record<string, unknown>).target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return undefined;
  const record = target as Record<string, unknown>;
  return record.kind === "chapter" && typeof record.id === "string" ? record.id : undefined;
}

export function isChapterWorkflowRun(run: NovelWorkflowRunRecord): boolean {
  return run.workflowType === "chapter-review" || Boolean(novelRunDocumentId(run));
}

export interface NovelDocumentContent {
  documentId: string;
  title: string;
  status: string;
  revision: number;
  contentHash: string;
  plainText: string;
}

export interface NovelFactCandidate {
  id: string;
  title: string;
  content: string;
  confidence: number;
  subjectRefs: string[];
  authority: string;
}

// ---------- fetch 帮助 ----------
async function novelFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `请求失败：${response.status}`);
  return body as T;
}

const enc = encodeURIComponent;

// ---------- Query Keys ----------
export const novelKeys = {
  projects: ["novel", "projects"] as const,
  project: (id: string) => ["novel", "project", id] as const,
  runs: (id: string) => ["novel", "project", id, "runs"] as const,
  run: (wfId: string) => ["novel", "run", wfId] as const,
  runEvents: (wfId: string) => ["novel", "run", wfId, "events"] as const,
  runArtifacts: (wfId: string) => ["novel", "run", wfId, "artifacts"] as const,
  runReviews: (wfId: string) => ["novel", "run", wfId, "reviews"] as const,
  docContent: (id: string, docId: string) => ["novel", "doc", id, docId, "content"] as const,
  factCandidates: (id: string, docId: string) => ["novel", "facts", id, docId] as const,
};

// ---------- 读 ----------
export function useNovelProjects() {
  return useQuery({
    queryKey: novelKeys.projects,
    queryFn: async () => (await novelFetch<{ projects: NovelProjectSummary[] }>("/v2/projects")).projects ?? [],
  });
}

export function useNovelProject(projectId: string) {
  return useQuery({
    queryKey: novelKeys.project(projectId),
    queryFn: async () => (await novelFetch<{ project: NovelProjectDetail }>(`/v2/projects/${enc(projectId)}`)).project,
    enabled: Boolean(projectId),
  });
}

export function useNovelProjectRuns(projectId: string) {
  return useQuery({
    queryKey: novelKeys.runs(projectId),
    queryFn: async () => (await novelFetch<{ runs: NovelWorkflowRunRecord[] }>(`/v2/projects/${enc(projectId)}/runs`)).runs ?? [],
    enabled: Boolean(projectId),
  });
}

const isActiveStatus = (status?: string) => status === "running" || status === "manual-review-required" || status === "paused" || status === "pending" || status === "accepted";

export function useNovelRun(workflowId: string | undefined) {
  return useQuery({
    queryKey: novelKeys.run(workflowId ?? "none"),
    queryFn: () => novelFetch<NovelRunState>(`/v2/runs/${enc(workflowId!)}`),
    enabled: Boolean(workflowId),
    refetchInterval: (query) => (isActiveStatus(query.state.data?.status) ? 3000 : false),
  });
}

export function useNovelRunEvents(workflowId: string | undefined, active = false) {
  return useQuery({
    queryKey: novelKeys.runEvents(workflowId ?? "none"),
    queryFn: async () => (await novelFetch<{ events: NovelRunEvent[] }>(`/v2/runs/${enc(workflowId!)}/events`)).events ?? [],
    enabled: Boolean(workflowId),
    refetchInterval: active ? 3000 : false,
  });
}

export function useNovelRunArtifacts(workflowId: string | undefined, active = false) {
  return useQuery({
    queryKey: novelKeys.runArtifacts(workflowId ?? "none"),
    queryFn: async () => (await novelFetch<{ artifacts: NovelArtifactSummary[] }>(`/v2/runs/${enc(workflowId!)}/artifacts`)).artifacts ?? [],
    enabled: Boolean(workflowId),
    refetchInterval: active ? 3000 : false,
  });
}

export function useNovelDocumentContent(projectId: string, documentId: string | undefined) {
  return useQuery({
    queryKey: novelKeys.docContent(projectId, documentId ?? "none"),
    queryFn: () => novelFetch<NovelDocumentContent>(`/v2/projects/${enc(projectId)}/documents/${enc(documentId!)}/content`),
    enabled: Boolean(projectId && documentId),
  });
}

export function useNovelFactCandidates(projectId: string, documentId: string | undefined) {
  return useQuery({
    queryKey: novelKeys.factCandidates(projectId, documentId ?? "none"),
    queryFn: async () => (await novelFetch<{ candidates: NovelFactCandidate[] }>(`/v2/projects/${enc(projectId)}/fact-candidates?documentId=${enc(documentId!)}`)).candidates ?? [],
    enabled: Boolean(projectId && documentId),
  });
}

export function useNovelArtifactText(artifactId: string | undefined) {
  return useQuery({
    queryKey: ["novel", "artifact", artifactId ?? "none", "text"] as const,
    queryFn: () => novelFetch<{ text: string; kind: string; artifactId: string; wordCount: number }>(`/v2/artifacts/${enc(artifactId!)}/content`),
    enabled: Boolean(artifactId),
  });
}

/** 提交作者修改（proposedText）启动章节重审工作流（复用审核/修订/事实/提交闭环） */
export function useSubmitChapterReview(projectId: string, documentId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { proposedText: string; instruction?: string }) => {
      return novelFetch<{ workflowId: string; runId?: string }>(`/v2/projects/${enc(projectId)}/documents/${enc(documentId!)}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: input.instruction ?? "从严审视叙事逻辑、人物声音、连续性、场景呈现与读者留存，并只修改有明确证据的问题。", proposedText: input.proposedText, idempotencyKey: `${projectId}:${documentId}:review:${Date.now()}` }),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: novelKeys.runs(projectId) });
      void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) });
    },
  });
}

export function useNovelRunReviews(workflowId: string | undefined, active = false) {
  return useQuery({
    queryKey: novelKeys.runReviews(workflowId ?? "none"),
    queryFn: async () => (await novelFetch<{ reviews: NovelReviewSummary[] }>(`/v2/runs/${enc(workflowId!)}/reviews`)).reviews ?? [],
    enabled: Boolean(workflowId),
    refetchInterval: active ? 3000 : false,
  });
}

// ---------- 写 ----------
export function useCreateNovelProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { premise: string; title?: string; genre?: string; autoBootstrap: boolean; includeChapterPlan: boolean }) =>
      novelFetch<{ project: NovelProjectDetail }>("/v2/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, idempotencyKey: crypto.randomUUID() }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: novelKeys.projects }),
  });
}

export function useUpdateNovelProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, title }: { projectId: string; title: string }) =>
      novelFetch<{ project: NovelProjectDetail }>(`/v2/projects/${enc(projectId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      }),
    onSuccess: ({ project }) => {
      void qc.invalidateQueries({ queryKey: novelKeys.projects });
      void qc.invalidateQueries({ queryKey: novelKeys.project(project.id) });
    },
  });
}

export function useDeleteNovelProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => novelFetch(`/v2/projects/${enc(projectId)}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: novelKeys.projects }),
  });
}

export type NovelDocumentInput = {
  title: string;
  narrativeOrder?: number;
  povCharacterId?: string | null;
  status?: string;
};

export function useCreateNovelDocument(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: NovelDocumentInput) => novelFetch<{ document: NovelDocumentSummary }>(`/v2/projects/${enc(projectId)}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) }),
  });
}

export function useUpdateNovelDocument(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ documentId, ...input }: NovelDocumentInput & { documentId: string }) =>
      novelFetch<{ document: NovelDocumentSummary }>(`/v2/projects/${enc(projectId)}/documents/${enc(documentId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) }),
  });
}

export function useDeleteNovelDocument(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => novelFetch(`/v2/projects/${enc(projectId)}/documents/${enc(documentId)}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) }),
  });
}

export function useSubmitNovelIntent(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { objective: string; documentId?: string; factApprovalMode: "auto" | "manual" }) =>
      novelFetch<{ workflowId: string; runId?: string }>("/v2/intents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          objective: input.objective,
          idempotencyKey: `${projectId}:${Date.now()}`,
          source: "web",
          requestedStage: input.documentId ? "drafting" : "planning",
          target: input.documentId ? { kind: "chapter", id: input.documentId } : undefined,
          factApprovalMode: input.factApprovalMode,
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: novelKeys.runs(projectId) });
      void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) });
    },
  });
}

export function useSignalHumanDecision(workflowId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { artifactId: string; decision: "approve" | "reject"; authorId?: string; feedback?: string }) => {
      await novelFetch(`/v2/workflows/${enc(workflowId!)}/tasks/${enc(input.artifactId)}/signal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signal: "humanSignal", payload: { decision: input.decision, authorId: input.authorId ?? "web-author", feedback: input.feedback } }),
      });
    },
    onSuccess: () => {
      if (!workflowId) return;
      void qc.invalidateQueries({ queryKey: novelKeys.run(workflowId) });
      void qc.invalidateQueries({ queryKey: novelKeys.runEvents(workflowId) });
      void qc.invalidateQueries({ queryKey: novelKeys.runArtifacts(workflowId) });
      void qc.invalidateQueries({ queryKey: novelKeys.runReviews(workflowId) });
    },
  });
}

export function useDecideFactCandidate(projectId: string, documentId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { claimId: string; decision: "approve" | "reject" }) => {
      await novelFetch(`/v2/projects/${enc(projectId)}/fact-candidates/${enc(input.claimId)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: input.decision, actorId: "web-author" }),
      });
    },
    onSuccess: () => {
      if (documentId) void qc.invalidateQueries({ queryKey: novelKeys.factCandidates(projectId, documentId) });
    },
  });
}
