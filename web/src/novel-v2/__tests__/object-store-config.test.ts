import { describe, expect, it } from "vitest";
import { resolveObjectStoreConfig, S3ContentObjectStore } from "../object-store";

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
