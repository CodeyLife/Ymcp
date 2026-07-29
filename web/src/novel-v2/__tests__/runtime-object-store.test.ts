import { describe, expect, it, vi } from "vitest";
import type { ContentObjectStore } from "../object-store";
import type { NovelPostgresRepository } from "../postgres-repository";
import { bindRuntimeObjectStore } from "../runtime-object-store";

describe("runtime object store binding", () => {
  it("refuses startup when a current final manuscript object is missing", async () => {
    const repository = {
      assertRuntimeObjectStoreIdentity: vi.fn().mockResolvedValue(undefined),
      listCurrentDocumentObjectKeys: vi.fn().mockResolvedValue([
        { documentId: "chapter-1", title: "第一章", objectKey: "aa/missing" },
      ]),
    } as unknown as NovelPostgresRepository;
    const objects = {
      ensureReady: vi.fn().mockResolvedValue(undefined),
      identity: vi.fn().mockReturnValue({ backend: "s3", location: "http://minio/novels", fingerprint: "fingerprint" }),
      has: vi.fn().mockResolvedValue(false),
    } as unknown as ContentObjectStore;

    await expect(bindRuntimeObjectStore(repository, objects, "api"))
      .rejects.toThrow("1 个当前定稿对象不可读：第一章(aa/missing)");
    expect(repository.assertRuntimeObjectStoreIdentity).not.toHaveBeenCalled();
  });
});
