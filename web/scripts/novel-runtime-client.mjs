import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_RUNTIME_URL = "http://127.0.0.1:4766";

function runtimeUrl() {
  return (process.env.YMCP_NOVEL_RUNTIME_URL || DEFAULT_RUNTIME_URL).replace(/\/+$/, "");
}

async function health() {
  try {
    const response = await fetch(`${runtimeUrl()}/v1/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok && (await response.json()).service === "ymcp-novel-runtime";
  } catch { return false; }
}

export async function ensureNovelRuntime() {
  if (await health()) return runtimeUrl();
  if (process.env.YMCP_NOVEL_RUNTIME_NO_SPAWN === "true") throw new Error("小说本地运行时未启动");
  const child = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, "scripts/novel-runtime.ts")], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    if (await health()) return runtimeUrl();
  }
  throw new Error("小说本地运行时启动超时");
}

export async function runtimeRequest(path, options = {}) {
  const baseUrl = await ensureNovelRuntime();
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(options.requestKey ? { "x-ymcp-request-key": options.requestKey } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `小说运行时 HTTP ${response.status}`);
    error.code = payload?.error?.code;
    error.retryable = payload?.error?.retryable;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload;
}
