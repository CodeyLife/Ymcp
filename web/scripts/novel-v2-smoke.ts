import { setTimeout as sleep } from "node:timers/promises";

const base = process.env.NOVEL_V2_API_URL ?? "http://127.0.0.1:4770";
const suffix = process.env.NOVEL_V2_SMOKE_ID ?? `${Date.now()}`;

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

async function waitForRun(workflowId: string, expected: "completed" | "failed" | "running" = "completed") {
  let latest: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    latest = await request<Record<string, unknown>>(`/v2/runs/${encodeURIComponent(workflowId)}`);
    const status = (latest.record as { status?: string } | undefined)?.status ?? latest.status;
    if (status === expected || status === "failed") return latest;
    await sleep(1000);
  }
  throw new Error(`workflow ${workflowId} did not reach ${expected}; latest=${JSON.stringify(latest)}`);
}

async function main() {
  const projectId = `smoke-${suffix}`;
  const documentId = `chapter-${suffix}`;
  console.log(`V2 smoke target: ${base}`);
  console.log("1/5 health");
  console.log(await request("/health"));

  console.log("2/5 create project and chapter");
  await request("/v2/projects", { method: "POST", body: JSON.stringify({ projectId, title: "V2 Smoke Novel" }) });
  await request(`/v2/projects/${encodeURIComponent(projectId)}/documents`, { method: "POST", body: JSON.stringify({ documentId, title: "第一章 烟火后的低语", narrativeOrder: 1, status: "planned" }) });

  console.log("3/5 planning intent");
  const planning = await request<{ workflowId: string; intent: { id: string } }>("/v2/intents", {
    method: "POST",
    body: JSON.stringify({ projectId, source: "api", objective: "规划一部跨百万字长篇的第一卷主线、角色知识边界和伏笔承诺", requestedStage: "planning", idempotencyKey: `planning-${suffix}` }),
  });
  const planningRun = await waitForRun(planning.workflowId);
  console.log(planningRun);

  console.log("4/5 drafting intent, expecting committed output or persisted failure evidence");
  const drafting = await request<{ workflowId: string; intent: { id: string } }>("/v2/intents", {
    method: "POST",
    body: JSON.stringify({ projectId, source: "api", objective: "续写第一章，保留主角尚不知道幕后真相的视角边界，写出有文学意象的开场", requestedStage: "drafting", target: { kind: "chapter", id: documentId, order: 1 }, idempotencyKey: `drafting-${suffix}` }),
  });
  const draftRun = await waitForRun(drafting.workflowId, "completed").catch((error) => ({ error: String(error) }));
  console.log(draftRun);

  console.log("5/5 inspect persisted events");
  const events = await request(`/v2/runs/${encodeURIComponent(drafting.workflowId)}/events?after=0`);
  console.log(JSON.stringify(events, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
