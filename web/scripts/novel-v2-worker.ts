import { NativeConnection, Worker } from "@temporalio/worker";
import { QdrantClient } from "@qdrant/js-client-rest";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";
import { createNovelWorkflowActivities } from "../src/novel-v2/temporal/activities";
import { fileURLToPath } from "node:url";
import { LiteLlmGateway } from "../src/novel-v2/model-gateway";
import { QdrantMemoryProvider } from "../src/novel-v2/qdrant-memory";
import { ContentObjectStore } from "../src/novel-v2/object-store";
import { CommitService } from "../src/novel-v2/commit-service";

const repository = new NovelPostgresRepository();
await repository.migrate();
const qdrant = new QdrantClient({ url: process.env.QDRANT_URL ?? "http://127.0.0.1:6333" });
const modelGateway = new LiteLlmGateway();
const qdrantMemory = new QdrantMemoryProvider(qdrant, modelGateway);
const objectStore = new ContentObjectStore();
const workflowsPath = fileURLToPath(new URL("../src/novel-v2/temporal/workflows.ts", import.meta.url));

const worker = await Worker.create({
  connection: await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" }),
  namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
  taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "novel-v2",
  workflowsPath,
  activities: createNovelWorkflowActivities({
    repository,
    memoryProvider: { search: async (input) => { const lexical = await repository.searchMemory(input); try { const semantic = await qdrantMemory.search(input); return [...new Map([...semantic, ...lexical].map((claim) => [claim.id, claim])).values()]; } catch (error) { console.warn("Qdrant 检索失败，回退 PostgreSQL 事实召回", error); return lexical; } } },
    skillProvider: { list: (projectId) => repository.listSkills(projectId) },
    modelGateway,
    objectStore,
    commitService: new CommitService(repository, objectStore),
    memoryIndex: { upsertClaims: async (projectId, claims) => { try { await qdrantMemory.upsertClaims(projectId, claims); } catch (error) { console.warn("Qdrant 写入失败，PostgreSQL memory_claims 已保留为真源", error); } } },
  }),
});

void qdrant.getCollections().catch((error: unknown) => console.warn("Qdrant 派生索引不可用，当前仅使用 PostgreSQL 事实检索", error));

process.once("SIGINT", () => void worker.shutdown());
process.once("SIGTERM", () => void worker.shutdown());
await worker.run();
await repository.close();
