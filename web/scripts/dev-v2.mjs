import { spawn } from "node:child_process";
import { resolve } from "node:path";

const env = {
  ...process.env,
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? "ymcp",
  MINIO_ROOT_USER: process.env.MINIO_ROOT_USER ?? "ymcp",
  MINIO_ROOT_PASSWORD: process.env.MINIO_ROOT_PASSWORD ?? "ymcp-minio-local",
  MINIO_BUCKET: process.env.MINIO_BUCKET ?? "ymcp-novel",
  MINIO_ENDPOINT: process.env.MINIO_ENDPOINT ?? "http://127.0.0.1:9000",
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? process.env.MINIO_ENDPOINT ?? "http://127.0.0.1:9000",
  S3_BUCKET: process.env.S3_BUCKET ?? process.env.MINIO_BUCKET ?? "ymcp-novel",
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? process.env.MINIO_ROOT_USER ?? "ymcp",
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? process.env.MINIO_ROOT_PASSWORD ?? "ymcp-minio-local",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp",
  TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  QDRANT_URL: process.env.QDRANT_URL ?? "http://127.0.0.1:6333",
};
const children = [];
let stopping = false;

function run(command, args) {
  const child = spawn(command, args, { stdio: "inherit", windowsHide: true, env, shell: false });
  children.push(child);
  child.once("exit", (code) => { if (!stopping && code) stop(code); });
  return child;
}

run(process.platform === "win32" ? "docker.exe" : "docker", ["compose", "-f", resolve("docker-compose.v2.yml"), "up", "-d"]);
run(process.execPath, ["--import", "tsx", "scripts/novel-v2-worker.ts"]);
run(process.execPath, ["--import", "tsx", "scripts/novel-v2-api.ts"]);
run(process.execPath, [resolve("node_modules/vite/bin/vite.js")]);

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill();
  setTimeout(() => process.exit(code), 100).unref();
}
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
