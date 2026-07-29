// 临时：将 PostgreSQL 中的 memory claims 重新索引到 Qdrant
// 诊断为什么 Qdrant 有 0 points 尽管 PostgreSQL 有 47 claims
import { QdrantClient } from "@qdrant/js-client-rest";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";
import { QdrantMemoryProvider } from "../src/novel-v2/qdrant-memory";
import { createRuntimeModelGateway } from "../src/novel-v2/model-runtime";

const PROJECT_ID = "spirit-logic-v4-20260729";

async function main() {
  const repository = new NovelPostgresRepository();
  await repository.migrate();
  const qdrant = new QdrantClient({ url: process.env.QDRANT_URL ?? "http://127.0.0.1:6333" });
  const { gateway: modelGateway } = await createRuntimeModelGateway(repository);
  const qdrantMemory = new QdrantMemoryProvider(qdrant, modelGateway);

  // 确保集合存在
  await qdrantMemory.ensureCollection();
  console.log("Qdrant 集合已确保");

  // 读取所有 memory claims
  const { Client: PgClient } = await import("pg");
  const pg = new PgClient({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });
  await pg.connect();
  const res = await pg.query(
    "SELECT id, kind, authority, title, content, narrative_start, narrative_end, knowledge_scope, subject_refs, source_revision_ids, content_hash, supersedes FROM memory_claims WHERE project_id = $1 ORDER BY created_at",
    [PROJECT_ID]
  );
  console.log(`PostgreSQL 中有 ${res.rows.length} 条 memory claims`);

  // 转换为 MemoryClaim 格式
  const claims = res.rows.map((row) => ({
    id: row.id,
    projectId: PROJECT_ID,
    kind: row.kind,
    authority: row.authority,
    title: row.title,
    content: row.content,
    narrativeRange: row.narrative_start ? { start: row.narrative_start, end: row.narrative_end } : undefined,
    knowledgeScope: row.knowledge_scope || "author",
    subjectRefs: row.subject_refs || [],
    sourceRevisionIds: row.source_revision_ids || [],
    contentHash: row.content_hash,
    supersedes: row.supersedes || [],
  }));

  // 过滤掉 candidate（与 extractFacts 一致）
  const retrievable = claims.filter((c) => c.authority !== "candidate");
  console.log(`可索引 claims (非 candidate): ${retrievable.length}`);

  if (retrievable.length === 0) {
    console.log("无可索引 claims，退出");
    await pg.end();
    await repository.close();
    return;
  }

  // 尝试 upsert 到 Qdrant（不吞错误）
  console.log("\n开始 upsert 到 Qdrant...");
  try {
    await qdrantMemory.upsertClaims(PROJECT_ID, retrievable);
    console.log("✓ Qdrant upsert 成功！");
  } catch (error) {
    console.error("✗ Qdrant upsert 失败:", error);
    console.error("错误详情:", error instanceof Error ? error.stack : String(error));
  }

  // 验证 Qdrant 点数
  const info = await qdrant.getCollection("novel-memory");
  console.log(`\nQdrant novel-memory 集合点数: ${info.points_count ?? 0}`);

  await pg.end();
  await repository.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
