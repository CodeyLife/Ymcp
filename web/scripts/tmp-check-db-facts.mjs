// 临时：查询 PostgreSQL 中的 memory claims + fact artifacts
const { Client } = await import("pg");

const client = new Client({
  connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp",
});

await client.connect();

// 1. 查找 memory_claims 表
console.log("=== Memory Claims ===");
try {
  const res = await client.query("SELECT count(*) as total FROM memory_claims WHERE project_id = $1", ["spirit-logic-v4-20260729"]);
  console.log(`总 memory claims: ${res.rows[0].total}`);
  
  const res2 = await client.query("SELECT kind, authority, count(*) as cnt FROM memory_claims WHERE project_id = $1 GROUP BY kind, authority ORDER BY kind, authority", ["spirit-logic-v4-20260729"]);
  console.log("\n按 kind/authority 分组:");
  for (const row of res2.rows) {
    console.log(`  kind=${row.kind} authority=${row.authority} count=${row.cnt}`);
  }
} catch (e) {
  console.log(`memory_claims 查询失败: ${e.message}`);
  // 尝试找表名
  const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE '%memory%' OR table_name LIKE '%claim%' OR table_name LIKE '%fact%'");
  console.log("相关表:", tables.rows.map(r => r.table_name));
}

// 2. 查找 artifacts 表中的 fact-extraction 类型
console.log("\n=== Fact Extraction Artifacts ===");
try {
  const res = await client.query("SELECT id, kind, created_at FROM artifacts WHERE project_id = $1 AND kind = 'fact-extraction' ORDER BY created_at", ["spirit-logic-v4-20260729"]);
  console.log(`fact-extraction artifacts: ${res.rows.length}`);
  for (const row of res.rows) {
    console.log(`  [${row.id}] created=${new Date(row.created_at).toISOString().slice(0,19)}`);
  }
} catch (e) {
  console.log(`artifacts 查询失败: ${e.message}`);
}

await client.end();
