import { createHash } from "node:crypto";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface ContentObject { hash: string; key: string; bytes: number; }
export interface ObjectStoreIdentity { backend: "file" | "s3"; location: string; fingerprint: string; }
export interface ObjectStoreAdapter {
  putText(text: string): Promise<ContentObject>;
  getText(key: string): Promise<string>;
}
export interface RuntimeObjectStoreAdapter extends ObjectStoreAdapter {
  has(key: string): Promise<boolean>;
  ensureReady(): Promise<void>;
  identity(): ObjectStoreIdentity;
  delete(key: string): Promise<void>;
}

type ObjectStoreEnvironment = Record<string, string | undefined>;
type ResolvedObjectStoreConfig =
  | { backend: "file"; root: string }
  | { backend: "s3"; endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region?: string };

function identity(backend: ObjectStoreIdentity["backend"], location: string): ObjectStoreIdentity {
  return { backend, location, fingerprint: createHash("sha256").update(`${backend}:${location}`, "utf8").digest("hex") };
}

export class FileContentObjectStore implements RuntimeObjectStoreAdapter {
  private readonly root: string;

  constructor(root = process.env.NOVEL_OBJECT_ROOT ?? join(process.cwd(), ".data", "objects")) {
    this.root = resolve(root);
  }

  async putText(text: string): Promise<ContentObject> {
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    const key = join(hash.slice(0, 2), hash.slice(2)).replaceAll("\\", "/");
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    try { await readFile(path); } catch { await writeFile(path, text, "utf8"); }
    return { hash, key, bytes: Buffer.byteLength(text, "utf8") };
  }

  async getText(key: string) { return readFile(join(this.root, key), "utf8"); }
  async delete(key: string) { await unlink(join(this.root, key)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
  async has(key: string) { try { await access(join(this.root, key)); return true; } catch { return false; } }
  async ensureReady() { await mkdir(this.root, { recursive: true }); }
  identity() { return identity("file", this.root.replaceAll("\\", "/")); }
}

export class S3ContentObjectStore implements RuntimeObjectStoreAdapter {
  readonly bucket: string;
  readonly endpoint: string;
  private readonly client: S3Client;

  constructor(input: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region?: string }) {
    this.bucket = input.bucket;
    this.endpoint = input.endpoint.replace(/\/+$/u, "");
    this.client = new S3Client({ region: input.region ?? "us-east-1", endpoint: input.endpoint, forcePathStyle: true, credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey } });
  }

  async putText(text: string): Promise<ContentObject> {
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    const key = `${hash.slice(0, 2)}/${hash.slice(2)}`;
    await this.ensureBucket();
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: text, ContentType: "text/plain; charset=utf-8" }));
    return { hash, key, bytes: Buffer.byteLength(text, "utf8") };
  }

  async ensureReady() {
    try { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); }
    catch { await this.client.send(new CreateBucketCommand({ Bucket: this.bucket })); }
  }

  private async ensureBucket() { await this.ensureReady(); }

  async getText(key: string) {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return response.Body?.transformToString("utf8") ?? "";
  }

  async has(key: string) {
    try { await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); return true; }
    catch (error) {
      const code = (error as { name?: string; Code?: string }).name ?? (error as { Code?: string }).Code;
      if (code === "NotFound" || code === "NoSuchKey") return false;
      throw error;
    }
  }

  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }

  identity() { return identity("s3", `${this.endpoint}/${this.bucket}`); }

  async health() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return true;
  }
}

export class ContentObjectStore implements RuntimeObjectStoreAdapter {
  private readonly adapter: RuntimeObjectStoreAdapter;

  constructor(adapter?: RuntimeObjectStoreAdapter) {
    this.adapter = adapter ?? createDefaultObjectStore();
  }

  putText(text: string) { return this.adapter.putText(text); }
  getText(key: string) { return this.adapter.getText(key); }
  has(key: string) { return this.adapter.has(key); }
  delete(key: string) { return this.adapter.delete(key); }
  ensureReady() { return this.adapter.ensureReady(); }
  identity() { return this.adapter.identity(); }
}

export class ReadRepairContentObjectStore implements RuntimeObjectStoreAdapter {
  private fallbackReads = 0;

  constructor(
    private readonly primary: RuntimeObjectStoreAdapter,
    private readonly fallback: RuntimeObjectStoreAdapter,
    private readonly onFallbackRead: (input: { key: string; total: number }) => void = ({ key, total }) => console.warn(`[object-store] legacy fallback 命中 ${key}，累计 ${total}`),
  ) {}

  putText(text: string) { return this.primary.putText(text); }
  delete(key: string) { return this.primary.delete(key); }
  identity() { return this.primary.identity(); }
  async ensureReady() { await this.primary.ensureReady(); await this.fallback.ensureReady(); }
  async has(key: string) { return await this.primary.has(key) || await this.fallback.has(key); }
  async getText(key: string) {
    if (await this.primary.has(key)) return this.primary.getText(key);
    const text = await this.fallback.getText(key);
    const repaired = await this.primary.putText(text);
    if (repaired.key !== key) throw new Error(`legacy 对象内容与 key 不匹配：期望 ${key}，实际 ${repaired.key}`);
    this.fallbackReads += 1;
    this.onFallbackRead({ key, total: this.fallbackReads });
    return text;
  }
}

export function resolveObjectStoreConfig(env: ObjectStoreEnvironment = process.env): ResolvedObjectStoreConfig {
  const backend = env.NOVEL_OBJECT_BACKEND?.trim().toLowerCase();
  if (!backend && env.NODE_ENV === "test") return { backend: "file", root: resolve(env.NOVEL_OBJECT_ROOT ?? join(process.cwd(), ".data", "test-objects")) };
  if (backend !== "file" && backend !== "s3") throw new Error("NOVEL_OBJECT_BACKEND 必须显式设置为 s3 或 file；Runtime 不允许静默切换对象存储");
  if (backend === "file") {
    const root = env.NOVEL_OBJECT_ROOT?.trim();
    if (!root || !isAbsolute(root)) throw new Error("file 对象存储必须配置绝对路径 NOVEL_OBJECT_ROOT");
    return { backend, root: resolve(root) };
  }
  const endpoint = env.S3_ENDPOINT ?? env.MINIO_ENDPOINT;
  const bucket = env.S3_BUCKET ?? env.MINIO_BUCKET;
  const accessKeyId = env.S3_ACCESS_KEY_ID ?? env.MINIO_ROOT_USER;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY ?? env.MINIO_ROOT_PASSWORD;
  const missing = [["S3_ENDPOINT", endpoint], ["S3_BUCKET", bucket], ["S3_ACCESS_KEY_ID", accessKeyId], ["S3_SECRET_ACCESS_KEY", secretAccessKey]].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`s3 对象存储配置不完整：缺少 ${missing.join("、")}`);
  return { backend, endpoint: endpoint!, bucket: bucket!, accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, region: env.S3_REGION };
}

export function createDefaultObjectStore(): RuntimeObjectStoreAdapter {
  const config = resolveObjectStoreConfig();
  const primary = config.backend === "file"
    ? new FileContentObjectStore(config.root)
    : new S3ContentObjectStore(config);
  const legacyRoot = process.env.NOVEL_OBJECT_LEGACY_ROOT?.trim();
  return legacyRoot && config.backend === "s3"
    ? new ReadRepairContentObjectStore(primary, new FileContentObjectStore(legacyRoot))
    : primary;
}



