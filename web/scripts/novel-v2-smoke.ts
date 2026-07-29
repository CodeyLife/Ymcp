import { setTimeout as sleep } from "node:timers/promises";

const base = process.env.NOVEL_V2_API_URL ?? "http://127.0.0.1:4770";
const suffix = process.env.NOVEL_V2_SMOKE_ID ?? `${Date.now()}`;
const timeoutMs = Number(process.env.NOVEL_V2_SMOKE_TIMEOUT_MS ?? 15 * 60_000);
const acceptManualReview = process.env.NOVEL_V2_SMOKE_ACCEPT_MANUAL_REVIEW === "1";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  return body as T;
}

async function waitForRun(workflowId: string) {
  let latest: Record<string, unknown> | undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    latest = await request<Record<string, unknown>>(`/v2/runs/${encodeURIComponent(workflowId)}`);
    const status = (latest.record as { status?: string } | undefined)?.status ?? latest.status;
    if (["completed", "failed", "manual-review-required"].includes(String(status))) return latest;
    await sleep(2000);
  }
  throw new Error(`workflow ${workflowId} did not reach a terminal status within ${timeoutMs}ms; latest=${JSON.stringify(latest)}`);
}

function runStatus(run: Record<string, unknown>) {
  return String((run.record as { status?: string } | undefined)?.status ?? run.status ?? "unknown");
}

async function main() {
  const projectId = `smoke-${suffix}`;
  const documentId = `chapter-${suffix}`;
  console.log(`V2 smoke target: ${base}`);
  console.log("1/6 health");
  console.log(await request("/health"));

  console.log("2/6 create project and chapter");
  await request("/v2/projects", {
    method: "POST",
    body: JSON.stringify({
      premise: "一场被刻意抹去的城市火灾，让幸存者开始听见灰烬中尚未说完的证词。",
      idempotencyKey: projectId,
      title: "V2 Smoke Novel",
      autoBootstrap: false,
    }),
  });
  await request(`/v2/projects/${encodeURIComponent(projectId)}/documents`, { method: "POST", body: JSON.stringify({ documentId, title: "第一章 烟火后的低语", narrativeOrder: 1, status: "planned" }) });

  console.log("3/6 bootstrap foundation and chapter plan");
  const bootstrap = await request<{ workflowId: string }>(`/v2/projects/${encodeURIComponent(projectId)}/bootstrap`, {
    method: "POST",
    body: JSON.stringify({
      objective: "规划一部跨百万字长篇的第一卷主线、角色知识边界和伏笔承诺",
      includeChapterPlan: true,
      idempotencyKey: `bootstrap-${suffix}`,
    }),
  });
  const bootstrapRun = await waitForRun(bootstrap.workflowId);
  console.log(bootstrapRun);
  if (runStatus(bootstrapRun) !== "completed") throw new Error(`bootstrap happy path ended with status=${runStatus(bootstrapRun)}`);

  console.log("4/6 planning intent");
  const planning = await request<{ workflowId: string; intent: { id: string } }>("/v2/intents", {
    method: "POST",
    body: JSON.stringify({ projectId, source: "api", objective: "规划一部跨百万字长篇的第一卷主线、角色知识边界和伏笔承诺", requestedStage: "planning", idempotencyKey: `planning-${suffix}` }),
  });
  const planningRun = await waitForRun(planning.workflowId);
  console.log(planningRun);
  if (runStatus(planningRun) !== "completed") throw new Error(`planning happy path ended with status=${runStatus(planningRun)}`);

  console.log("5/6 drafting intent, requiring a committed happy path");
  const drafting = await request<{ workflowId: string; intent: { id: string } }>("/v2/intents", {
    method: "POST",
    body: JSON.stringify({ projectId, source: "api", objective: "续写第一章，保留主角尚不知道幕后真相的视角边界，写出有文学意象的开场", requestedStage: "drafting", target: { kind: "chapter", id: documentId, order: 1 }, idempotencyKey: `drafting-${suffix}` }),
  });
  const draftRun = await waitForRun(drafting.workflowId);
  console.log(draftRun);

  console.log("6/6 inspect persisted events");
  const events = await request(`/v2/runs/${encodeURIComponent(drafting.workflowId)}/events?after=0`);
  console.log(JSON.stringify(events, null, 2));

  const status = runStatus(draftRun);
  if (status !== "completed" && !(acceptManualReview && status === "manual-review-required")) {
    throw new Error(`drafting happy path ended with status=${status}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
