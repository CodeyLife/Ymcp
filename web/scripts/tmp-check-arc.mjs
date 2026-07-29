// 临时：检查 story-arc 章节蓝图状态
import pg from "pg";
const pool = new pg.Pool({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });

const arcs = await pool.query(
  `SELECT a.id, a.title, a.ordinal, a.planning_status, a.execution_status,
          (SELECT count(*)::int FROM chapters c WHERE c.arc_id=a.id) AS chapter_count
   FROM arcs a WHERE a.project_id='spirit-logic-v4-20260729' ORDER BY a.ordinal`,
);
console.log("=== Arcs ===");
for (const r of arcs.rows) console.log(`  arc#${r.ordinal} [plan=${r.planning_status}|exec=${r.execution_status}] ch=${r.chapter_count} ${r.title} id=${r.id}`);

const chs = await pool.query(
  `SELECT c.id, c.title, c.ordinal, c.status, c.document_id,
          d.status AS doc_status
   FROM chapters c LEFT JOIN manuscript_documents d ON d.id=c.document_id
   WHERE c.project_id='spirit-logic-v4-20260729' ORDER BY c.ordinal`,
);
console.log(`\n=== Chapter blueprints (${chs.rowCount}) ===`);
for (const r of chs.rows) console.log(`  #${r.ordinal} [${r.status}|doc=${r.doc_status ?? "(无)"}] ${r.title}  docId=${r.document_id ?? "(无)"}  chId=${r.id}`);

await pool.end();
