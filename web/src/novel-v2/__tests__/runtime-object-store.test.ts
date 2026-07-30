import { describe, expect, it, vi } from "vitest";
import type { ContentObjectStore } from "../object-store";
import type { NovelPostgresRepository } from "../postgres-repository";
import { bindRuntimeObjectStore } from "../runtime-object-store";

describe("runtime object store binding", () => {
  it("refuses startup when a current final manuscript object is missing", async () => {
    const repository = {
      assertRuntimeObjectStoreIdentity: vi.fn().mockResolvedValue(undefined),
      listReferencedObjectKeys: vi.fn().mockResolvedValue([
        { contentHash: "aabb", reference: "content-blob", objectKey: "aa/missing" },
      ]),
    } as unknown as NovelPostgresRepository;
    const objects = {
      ensureReady: vi.fn().mockResolvedValue(undefined),
      identity: vi.fn().mockReturnValue({ backend: "s3", location: "http://minio/novels", fingerprint: "fingerprint" }),
      has: vi.fn().mockResolvedValue(false),
    } as unknown as ContentObjectStore;

    await expect(bindRuntimeObjectStore(repository, objects, "api"))
      .rejects.toThrow("1 个活跃引用对象不可读：content-blob(aa/missing)");
    expect(repository.assertRuntimeObjectStoreIdentity).not.toHaveBeenCalled();
  });
});
