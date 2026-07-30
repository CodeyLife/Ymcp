import { describe, expect, it } from "vitest";
import { ReadRepairContentObjectStore, resolveObjectStoreConfig, S3ContentObjectStore, type RuntimeObjectStoreAdapter } from "../object-store";

describe("object store runtime configuration", () => {
  it("refuses to choose a backend implicitly outside tests", () => {
    expect(() => resolveObjectStoreConfig({ NODE_ENV: "production" })).toThrow("必须显式设置");
  });

  it("requires an absolute root for the file backend", () => {
    expect(() => resolveObjectStoreConfig({ NOVEL_OBJECT_BACKEND: "file", NOVEL_OBJECT_ROOT: ".data/objects" })).toThrow("绝对路径");
  });

  it("reports every missing s3 setting", () => {
    expect(() => resolveObjectStoreConfig({ NOVEL_OBJECT_BACKEND: "s3", S3_ENDPOINT: "http://127.0.0.1:9000" }))
      .toThrow("S3_BUCKET、S3_ACCESS_KEY_ID、S3_SECRET_ACCESS_KEY");
  });

  it("derives different identities for different endpoints or buckets", () => {
    const credentials = { accessKeyId: "test", secretAccessKey: "test" };
    const first = new S3ContentObjectStore({ endpoint: "http://127.0.0.1:9000", bucket: "novels", ...credentials }).identity();
    const otherEndpoint = new S3ContentObjectStore({ endpoint: "http://localhost:9000", bucket: "novels", ...credentials }).identity();
    const otherBucket = new S3ContentObjectStore({ endpoint: "http://127.0.0.1:9000", bucket: "other", ...credentials }).identity();
    expect(first.fingerprint).not.toBe(otherEndpoint.fingerprint);
    expect(first.fingerprint).not.toBe(otherBucket.fingerprint);
  });
});

describe("read repair object store", () => {
  function memoryStore(initial: Record<string, string>): RuntimeObjectStoreAdapter {
    const values = new Map(Object.entries(initial));
    return {
      putText: async (text) => {
        const hash = (await import("node:crypto")).createHash("sha256").update(text).digest("hex");
        const key = `${hash.slice(0, 2)}/${hash.slice(2)}`;
        values.set(key, text);
        return { hash, key, bytes: Buffer.byteLength(text) };
      },
      getText: async (key) => { const value = values.get(key); if (value === undefined) throw new Error("missing"); return value; },
      has: async (key) => values.has(key), delete: async (key) => { values.delete(key); }, ensureReady: async () => undefined,
      identity: () => ({ backend: "file", location: "memory", fingerprint: "memory" }),
    };
  }

  it("reads legacy content once and repairs the primary without writing new content to legacy", async () => {
    const text = "迁移期正文";
    const hash = (await import("node:crypto")).createHash("sha256").update(text).digest("hex");
    const key = `${hash.slice(0, 2)}/${hash.slice(2)}`;
    const primary = memoryStore({});
    const legacy = memoryStore({ [key]: text });
    const hits: string[] = [];
    const store = new ReadRepairContentObjectStore(primary, legacy, ({ key: hit }) => hits.push(hit));
    await expect(store.getText(key)).resolves.toBe(text);
    expect(await primary.has(key)).toBe(true);
    await expect(store.getText(key)).resolves.toBe(text);
    expect(hits).toEqual([key]);
  });
});
