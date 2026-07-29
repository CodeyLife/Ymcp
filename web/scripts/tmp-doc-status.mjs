// 临时：查询章节文档状态 + 最近的 workflow run 状态
import pg from "pg";

const connStr = process.env.DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp";
const PROJECT_ID = process.env.PROJECT_ID ?? "spirit-logic-v4-20260729";

const pool = new pg.Pool({ connectionString: connStr });

try {
  const docs = await pool.query(
    `SELECT id, title, status, current_revision_id, narrative_order
     FROM manuscript_documents WHERE project_id=$1 ORDER BY narrative_order`,
    [PROJECT_ID],
  );
  console.log("=== 文档状态 ===");
  for (const r of docs.rows) {
    console.log(`  #${r.narrative_order} [${r.status}] ${r.title}  docId=${r.id}  rev=${r.current_revision_id ?? "(none)"}`);
  }

  // entities 检查：哪些角色 entity 存在
  const ents = await pool.query(
    `SELECT id, name FROM entities WHERE project_id=$1 AND kind='character' ORDER BY name`,
    [PROJECT_ID],
  );
  console.log(`\n=== 角色 entities (${ents.rowCount}) ===`);
  for (const r of ents.rows) console.log(`  ${r.name}  id=${r.id}`);

  // relations 检查
  const rels = await pool.query(
    `SELECT count(*)::int AS n FROM relations WHERE project_id=$1`,
    [PROJECT_ID],
  );
  console.log(`\n=== relations 记录数: ${rels.rows[0].n} ===`);

  // 最近 model_tasks / workflow runs（看 chapter 5 workflow 状态）
  const wf = await pool.query(
    `SELECT workflow_id, status, stage, score, error_category
     FROM work_items WHERE project_id=$1 ORDER BY created_at DESC LIMIT 8`,
    [PROJECT_ID],
  );
  console.log(`\n=== 最近 work_items ===`);
  for (const r of wf.rows) console.log(`  [${r.status}] stage=${r.stage ?? "(none)"} score=${r.score ?? "-"}  wf=${r.workflow_id}  err=${r.error_category ?? "-"}`);
} catch (e) {
  console.error("查询失败:", e.message);
} finally {
  await pool.end();
}
