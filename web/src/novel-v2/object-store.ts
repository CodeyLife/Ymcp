import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface ContentObject { hash: string; key: string; bytes: number; }
export interface ObjectStoreAdapter {
  putText(text: string): Promise<ContentObject>;
  getText(key: string): Promise<string>;
}

export class FileContentObjectStore implements ObjectStoreAdapter {
  constructor(private readonly root = process.env.NOVEL_OBJECT_ROOT ?? join(process.cwd(), ".data", "objects")) {}

  async putText(text: string): Promise<ContentObject> {
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    const key = join(hash.slice(0, 2), hash.slice(2)).replaceAll("\\", "/");
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    try { await readFile(path); } catch { await writeFile(path, text, "utf8"); }
    return { hash, key, bytes: Buffer.byteLength(text, "utf8") };
  }

  async getText(key: string) { return readFile(join(this.root, key), "utf8"); }
}

export class S3ContentObjectStore implements ObjectStoreAdapter {
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(input: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region?: string }) {
    this.bucket = input.bucket;
    this.client = new S3Client({ region: input.region ?? "us-east-1", endpoint: input.endpoint, forcePathStyle: true, credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey } });
  }

  async putText(text: string): Promise<ContentObject> {
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    const key = `${hash.slice(0, 2)}/${hash.slice(2)}`;
    await this.ensureBucket();
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: text, ContentType: "text/plain; charset=utf-8" }));
    return { hash, key, bytes: Buffer.byteLength(text, "utf8") };
  }

  private async ensureBucket() {
    try { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); }
    catch { await this.client.send(new CreateBucketCommand({ Bucket: this.bucket })); }
  }

  async getText(key: string) {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return response.Body?.transformToString("utf8") ?? "";
  }

  async health() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return true;
  }
}

export class ContentObjectStore implements ObjectStoreAdapter {
  private readonly adapter: ObjectStoreAdapter;

  constructor(adapter?: ObjectStoreAdapter) {
    this.adapter = adapter ?? createDefaultObjectStore();
  }

  putText(text: string) { return this.adapter.putText(text); }
  getText(key: string) { return this.adapter.getText(key); }
}

export function createDefaultObjectStore(): ObjectStoreAdapter {
  const endpoint = process.env.S3_ENDPOINT ?? process.env.MINIO_ENDPOINT;
  const bucket = process.env.S3_BUCKET ?? process.env.MINIO_BUCKET ?? "ymcp-novel";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? process.env.MINIO_ROOT_USER;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? process.env.MINIO_ROOT_PASSWORD;
  if (endpoint && accessKeyId && secretAccessKey) return new S3ContentObjectStore({ endpoint, bucket, accessKeyId, secretAccessKey, region: process.env.S3_REGION });
  return new FileContentObjectStore();
}



