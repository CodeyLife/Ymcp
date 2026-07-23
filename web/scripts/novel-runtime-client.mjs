import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_RUNTIME_URL = "http://127.0.0.1:4766";
const RUNTIME_PROTOCOL_VERSION = 2;

const RUNTIME_SOURCE_ROOTS = [
  "scripts/novel-runtime.ts",
  "src/novel-runtime",
  "src/features/novel",
  "package.json",
  "package-lock.json",
];

function runtimeUrl() {
  return (process.env.YMCP_NOVEL_RUNTIME_URL || DEFAULT_RUNTIME_URL).replace(/\/+$/, "");
}

function runtimeSourceEntries(path, entries = []) {
  let stats;
  try { stats = statSync(path); } catch { return entries; }
  if (stats.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (name === "__tests__" || name === "node_modules" || name.startsWith(".")) continue;
      runtimeSourceEntries(resolve(path, name), entries);
    }
    return entries;
  }
  if (!/\.(?:ts|tsx|mjs|json)$/.test(path) || /(?:\.test|\.spec)\.[^.]+$/.test(path)) return entries;
  entries.push(`${path.slice(ROOT.length + 1).replaceAll("\\", "/")}:${stats.size}:${stats.mtimeMs}`);
  return entries;
}

export function runtimeSourceVersion() {
  const entries = RUNTIME_SOURCE_ROOTS.flatMap((rel) => runtimeSourceEntries(resolve(ROOT, rel))).sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

function sameRuntimeRoot(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() === ROOT.toLowerCase() : normalized === ROOT;
}

async function health() {
  try {
    const response = await fetch(`${runtimeUrl()}/v1/health`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return { available: true, compatible: false, stale: false, restartable: false, reason: `端口上的服务未提供兼容健康接口（HTTP ${response.status}）` };
    const body = await response.json();
    if (body.service !== "ymcp-novel-runtime") return { available: true, compatible: false, stale: false, restartable: false, reason: "运行时端口已被其他服务占用" };
    const restartable = sameRuntimeRoot(body.runtimeRoot);
    const compatible = restartable && body.protocolVersion === RUNTIME_PROTOCOL_VERSION && typeof body.sourceVersion === "string";
    const stale = compatible && body.sourceVersion !== runtimeSourceVersion();
    const reason = compatible
      ? undefined
      : !body.runtimeRoot
        ? "检测到旧版小说运行时协议，请先停止旧进程后重试"
        : !restartable
          ? "小说运行时端口由其他源码工作区占用"
          : `小说运行时协议不兼容（需要 ${RUNTIME_PROTOCOL_VERSION}，当前 ${String(body.protocolVersion ?? "unknown")}）`;
    return { available: true, compatible, stale, restartable, reason };
  } catch { return { available: false, compatible: false, stale: false, restartable: false }; }
}

async function stopStaleRuntime(state) {
  if (!state.available || !state.stale || !state.restartable) return;
  const response = await fetch(`${runtimeUrl()}/v1/admin/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runtimeRoot: ROOT }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error("小说本地运行时拒绝有序重启");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    if (!(await health()).available) return;
  }
  throw new Error("旧小说本地运行时未能停止");
}

export async function ensureNovelRuntime() {
  const state = await health();
  if (state.available && !state.compatible) throw new Error(state.reason || "小说本地运行时协议不兼容");
  if (state.available && !state.stale) return runtimeUrl();
  if (process.env.YMCP_NOVEL_RUNTIME_NO_SPAWN === "true") throw new Error("小说本地运行时未启动");
  await stopStaleRuntime(state);
  const child = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, "scripts/novel-runtime.ts")], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, YMCP_NOVEL_RUNTIME_SOURCE_VERSION: runtimeSourceVersion() },
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    const next = await health();
    if (next.available && next.compatible && !next.stale) return runtimeUrl();
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
