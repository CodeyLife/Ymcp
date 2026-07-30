import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "node:crypto";
import { chapterMemoryAsClaim } from "../src/novel-v2/chapter-memory";
import { createRuntimeModelGateway } from "../src/novel-v2/model-runtime";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";
import { QdrantMemoryProvider } from "../src/novel-v2/qdrant-memory";

const targetCollection = process.env.QDRANT_REINDEX_COLLECTION ?? "novel-memory-bge-m3-v1";
const alias = process.env.QDRANT_COLLECTION ?? "novel-memory-current";
const dimension = Number(process.env.NOVEL_EMBEDDING_DIM ?? 1024);
const batchSize = Number(process.env.NOVEL_REINDEX_BATCH_SIZE ?? 64);
const reset = process.argv.includes("--reset");
const repository = new NovelPostgresRepository();
await repository.migrate();
const qdrant = new QdrantClient({ url: process.env.QDRANT_URL ?? "http://127.0.0.1:6333" });
if (reset && (await qdrant.getCollections()).collections.some((item) => item.name === targetCollection)) await qdrant.deleteCollection(targetCollection);
const { gateway } = await createRuntimeModelGateway(repository);
const index = new QdrantMemoryProvider(qdrant, gateway, targetCollection, dimension);
await index.ensureCollection();

type Progress = { claimOffset: number; chapterOffset: number };
const key = `embedding-reindex:${targetCollection}`;
const progress = reset ? { claimOffset: 0, chapterOffset: 0 } : await repository.getRuntimeConfiguration<Progress>(key) ?? { claimOffset: 0, chapterOffset: 0 };
while (true) {
  const claims = await repository.listIndexableMemoryClaims({ offset: progress.claimOffset, limit: batchSize });
  if (!claims.length) break;
  for (const [projectId, projectClaims] of Map.groupBy(claims, (claim) => claim.projectId)) await index.upsertClaims(projectId, projectClaims);
  progress.claimOffset += claims.length;
  await repository.setRuntimeConfiguration(key, { ...progress, status: "running", targetCollection, dimension });
}
while (true) {
  const memories = await repository.listAllChapterMemories({ offset: progress.chapterOffset, limit: batchSize });
  if (!memories.length) break;
  const claims = memories.map(chapterMemoryAsClaim);
  for (const [projectId, projectClaims] of Map.groupBy(claims, (claim) => claim.projectId)) await index.upsertClaims(projectId, projectClaims);
  progress.chapterOffset += memories.length;
  await repository.setRuntimeConfiguration(key, { ...progress, status: "running", targetCollection, dimension });
}
const expected = await repository.countIndexableMemoryClaims();
const info = await qdrant.getCollection(targetCollection);
const points = Number(info.points_count ?? 0);
if (points !== expected) throw new Error(`Qdrant 重建数量不一致：expected=${expected} actual=${points}`);
const physicalCollections = await qdrant.getCollections();
if (physicalCollections.collections.some((item) => item.name === alias)) {
  if (!reset) throw new Error(`Qdrant alias 名称 ${alias} 被实体集合占用；请确认新索引完整后使用 --reset 迁移`);
  if (alias === targetCollection) throw new Error("Qdrant alias 与目标实体集合不能同名");
  await qdrant.deleteCollection(alias);
}
const aliases = await qdrant.getAliases();
const actions: Array<Record<string, unknown>> = [];
if (aliases.aliases.some((item) => item.alias_name === alias)) actions.push({ delete_alias: { alias_name: alias } });
actions.push({ create_alias: { collection_name: targetCollection, alias_name: alias } });
await qdrant.updateCollectionAliases({ actions });
const model = process.env.NOVEL_EMBEDDING_MODEL ?? "BAAI/bge-m3";
const revision = process.env.NOVEL_EMBEDDING_REVISION ?? "5617a9f61b028005a4858fdac845db406aefb181";
const fingerprint = createHash("sha256").update(`${model}:${revision}:${dimension}`).digest("hex");
await repository.setRuntimeConfiguration("embedding-index", { status: "ready", alias, targetCollection, dimension, model, revision, fingerprint, points, completedAt: new Date().toISOString() });
await repository.setRuntimeConfiguration(key, { ...progress, status: "completed", targetCollection, dimension, points });
console.log(JSON.stringify({ alias, targetCollection, dimension, points }, null, 2));
await repository.close();
