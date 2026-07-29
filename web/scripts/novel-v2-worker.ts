import { NativeConnection, Worker } from "@temporalio/worker";
import { QdrantClient } from "@qdrant/js-client-rest";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";
import { createNovelWorkflowActivities } from "../src/novel-v2/temporal/activities";
import { fileURLToPath } from "node:url";
import { createRuntimeModelGateway } from "../src/novel-v2/model-runtime";
import { QdrantMemoryProvider } from "../src/novel-v2/qdrant-memory";
import { createFusionMemoryProvider } from "../src/novel-v2/fusion-memory";
import { ContentObjectStore } from "../src/novel-v2/object-store";
import { bindRuntimeObjectStore } from "../src/novel-v2/runtime-object-store";

const repository = new NovelPostgresRepository();
await repository.migrate();
const qdrant = new QdrantClient({ url: process.env.QDRANT_URL ?? "http://127.0.0.1:6333" });
const { gateway: modelGateway } = await createRuntimeModelGateway(repository);
const qdrantMemory = new QdrantMemoryProvider(qdrant, modelGateway);
const objectStore = new ContentObjectStore();
await bindRuntimeObjectStore(repository, objectStore, "worker");
const workflowsPath = fileURLToPath(new URL("../src/novel-v2/temporal/workflows.ts", import.meta.url));

// P2-G2: 三轨加权融合（semantic 0.5 + lexical 0.3 + graph 0.2）
// 设计依据：AGENTS.md「reusable contracts」——融合逻辑从 worker 内联抽到
// FusionMemoryProvider 共享层，min-max 归一化 + 权重重分配，避免 last-wins 丢信号。
const fusionMemory = createFusionMemoryProvider(qdrantMemory, repository);

const worker = await Worker.create({
  connection: await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" }),
  namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
  taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "novel-v2",
  workflowsPath,
  activities: createNovelWorkflowActivities({
    repository,
    memoryProvider: fusionMemory,
    skillProvider: { list: (projectId) => repository.listSkills(projectId) },
    modelGateway,
    objectStore,
    // CommitService 由 createNovelWorkflowActivities 自动注入 chapter memory 依赖
    // 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约
    memoryIndex: { upsertClaims: async (projectId, claims) => { try { await qdrantMemory.upsertClaims(projectId, claims); } catch (error) { console.warn("Qdrant 写入失败，PostgreSQL memory_claims 已保留为真源", error); } } },
    enableChapterMemory: true,
  }),
});

void qdrant.getCollections().catch((error: unknown) => console.warn("Qdrant 派生索引不可用，当前仅使用 PostgreSQL 事实检索", error));

process.once("SIGINT", () => void worker.shutdown());
process.once("SIGTERM", () => void worker.shutdown());
await worker.run();
await repository.close();
