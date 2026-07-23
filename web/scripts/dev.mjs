import { spawn } from "node:child_process";
import { resolve } from "node:path";

async function runtimeReady() {
  try {
    const response = await fetch("http://127.0.0.1:4766/v1/health", { signal: AbortSignal.timeout(700) });
    return response.ok && (await response.json()).service === "ymcp-novel-runtime";
  } catch { return false; }
}

const children = [];
if (!(await runtimeReady())) {
  children.push(spawn(process.execPath, ["--import", "tsx", "scripts/novel-runtime.ts"], { stdio: "inherit", windowsHide: true, env: process.env }));
}
children.push(spawn(process.execPath, [resolve("node_modules/vite/bin/vite.js")], { stdio: "inherit", windowsHide: true, env: process.env }));

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill();
  setTimeout(() => process.exit(code), 100).unref();
}
for (const child of children) child.once("exit", (code) => { if (!stopping && code) stop(code); });
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
