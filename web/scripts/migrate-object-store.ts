import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { FileContentObjectStore, S3ContentObjectStore } from "../src/novel-v2/object-store";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";

const apply = process.argv.includes("--apply");
const legacyRoot = resolve(process.env.NOVEL_OBJECT_LEGACY_ROOT ?? resolve(process.cwd(), ".data", "objects"));
const endpoint = process.env.S3_ENDPOINT ?? process.env.MINIO_ENDPOINT ?? "http://127.0.0.1:9000";
const bucket = process.env.S3_BUCKET ?? process.env.MINIO_BUCKET ?? "ymcp-novel";
const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? process.env.MINIO_ROOT_USER ?? "ymcp";
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? process.env.MINIO_ROOT_PASSWORD ?? "ymcp-minio-local";
const repository = new NovelPostgresRepository();
const source = new FileContentObjectStore(legacyRoot);
const target = new S3ContentObjectStore({ endpoint, bucket, accessKeyId, secretAccessKey, region: process.env.S3_REGION });

await target.ensureReady();
const references = await repository.listReferencedObjectKeys();
let copied = 0;
let alreadyPresent = 0;
let missing = 0;
for (const reference of references) {
  const [inTarget, inSource] = await Promise.all([target.has(reference.objectKey), source.has(reference.objectKey)]);
  if (!inTarget && !inSource) { missing += 1; console.error(`MISSING ${reference.reference} ${reference.objectKey}`); continue; }
  const sourceText = inSource ? await source.getText(reference.objectKey) : undefined;
  const targetText = inTarget ? await target.getText(reference.objectKey) : undefined;
  const text = targetText ?? sourceText!;
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  if (hash !== reference.contentHash) throw new Error(`对象哈希冲突 ${reference.objectKey}：DB=${reference.contentHash} actual=${hash}`);
  if (sourceText !== undefined && targetText !== undefined && sourceText !== targetText) throw new Error(`两端对象内容冲突 ${reference.objectKey}`);
  if (inTarget) { alreadyPresent += 1; continue; }
  if (apply) {
    const object = await target.putText(sourceText!);
    if (object.key !== reference.objectKey) throw new Error(`迁移 key 不一致：${reference.objectKey} -> ${object.key}`);
  }
  copied += 1;
}

if (apply && missing === 0) {
  await repository.setRuntimeConfiguration("object-store", {
    ...target.identity(),
    legacyFallback: legacyRoot,
    verifiedReferences: references.length,
    verifiedAt: new Date().toISOString(),
  });
}
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", references: references.length, copied, alreadyPresent, missing, legacyRoot, target: `${endpoint}/${bucket}` }, null, 2));
if (missing) process.exitCode = 2;
await repository.close();
