import { spawn } from "node:child_process";
import { resolve } from "node:path";

const service = process.argv[2];
if (service !== "api" && service !== "worker") {
  throw new Error("usage: node scripts/run-v2-service.mjs <api|worker>");
}

const env = {
  ...process.env,
  NOVEL_OBJECT_BACKEND: process.env.NOVEL_OBJECT_BACKEND ?? "s3",
  NOVEL_OBJECT_LEGACY_ROOT: process.env.NOVEL_OBJECT_LEGACY_ROOT ?? resolve(".data", "objects"),
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? process.env.MINIO_ENDPOINT ?? "http://127.0.0.1:9000",
  S3_BUCKET: process.env.S3_BUCKET ?? process.env.MINIO_BUCKET ?? "ymcp-novel",
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? process.env.MINIO_ROOT_USER ?? "ymcp",
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? process.env.MINIO_ROOT_PASSWORD ?? "ymcp-minio-local",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp",
  TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  QDRANT_URL: process.env.QDRANT_URL ?? "http://127.0.0.1:6333",
};

const child = spawn(process.execPath, ["--import", "tsx", `scripts/novel-v2-${service}.ts`], {
  stdio: "inherit",
  windowsHide: true,
  env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
child.once("exit", (code) => process.exit(code ?? 0));
