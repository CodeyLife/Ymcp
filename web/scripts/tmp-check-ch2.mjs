import pg from "pg";
const WF = "novel-intent-9048ef4d-e441-4681-8ce4-ce074219a033";
const pool = new pg.Pool({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });

const wf = await pool.query("SELECT status, payload, updated_at FROM workflow_runs WHERE id=$1", [WF]);
console.log("wf:", wf.rows[0].status, "updated:", wf.rows[0].updated_at?.toISOString(), "stage:", wf.rows[0].payload?.stage);

const inv = await pool.query("SELECT purpose, status, latency_ms, created_at FROM model_invocations WHERE workflow_run_id=$1 ORDER BY created_at DESC LIMIT 10", [WF]);
console.log("\n=== invocations (desc) ===");
for (const r of inv.rows) console.log(`  ${r.purpose} status=${r.status} lat=${r.latency_ms}ms at=${new Date(r.created_at).toLocaleTimeString("zh-CN",{hour12:false})}`);

const art = await pool.query("SELECT kind, created_at FROM artifacts WHERE workflow_run_id=$1 OR task_id LIKE $2 ORDER BY created_at", [WF, `%${WF.slice(-12)}%`]);
console.log("\n=== artifacts ===");
for (const r of art.rows) console.log(`  ${r.kind} at=${new Date(r.created_at).toLocaleTimeString("zh-CN",{hour12:false})}`);

console.log("now:", new Date().toLocaleTimeString("zh-CN",{hour12:false}));
await pool.end();
