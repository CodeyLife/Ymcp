import type { ContentObjectStore } from "./object-store";
import type { NovelPostgresRepository } from "./postgres-repository";

export async function bindRuntimeObjectStore(
  repository: NovelPostgresRepository,
  objects: ContentObjectStore,
  service: "api" | "worker",
): Promise<void> {
  await objects.ensureReady();
  const identity = objects.identity();
  const references = await repository.listCurrentDocumentObjectKeys();
  const availability = await Promise.all(references.map(async (item) => ({ ...item, available: await objects.has(item.objectKey) })));
  const missing = availability.filter((item) => !item.available);
  if (missing.length) {
    const chapters = missing.slice(0, 5).map((item) => `${item.title}(${item.objectKey})`).join("、");
    throw new Error(`对象存储完整性检查失败：${missing.length} 个当前定稿对象不可读：${chapters}`);
  }
  await repository.assertRuntimeObjectStoreIdentity(identity);

  console.info(`[object-store] ${service} 已绑定 ${identity.backend} ${identity.location}，已校验 ${references.length} 个当前定稿对象`);
}
