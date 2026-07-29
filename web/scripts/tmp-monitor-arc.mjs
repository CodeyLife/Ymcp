// 临时：监控 story-arc 工作流，到达 manual-review-required 时打印蓝图供审核
// 用法: node scripts/tmp-monitor-arc.mjs <workflowId> <arcId>
import pg from "pg";

const PROJECT_ID = "spirit-logic-v4-20260729";
const WORKFLOW_ID = process.argv[2];
const ARC_ID = process.argv[3];
if (!WORKFLOW_ID || !ARC_ID) { console.log("用法: node tmp-monitor-arc.mjs <workflowId> <arcId>"); process.exit(1); }
const API = "http://127.0.0.1:4770";

const pool = new pg.Pool({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });

let final = null;
for (let i = 1; i <= 120; i++) {
  const r = await pool.query("SELECT status, payload FROM workflow_runs WHERE temporal_workflow_id=$1", [WORKFLOW_ID]);
  const status = r.rows[0]?.status ?? "(unknown)";
  const stage = r.rows[0]?.payload?.stage ?? r.rows[0]?.payload?.arcId ?? "(none)";
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  console.log(`[${ts}] iter=${i} status=${status}`);
  if (status === "manual-review-required" || status === "completed" || status === "failed") { final = status; break; }
  await new Promise((r) => setTimeout(r, 8000));
}

console.log(`\n=== 终态: ${final} ===`);

if (final === "manual-review-required") {
  // 拉取 arc 蓝图审核
  const arc = await (await fetch(`${API}/v2/projects/${PROJECT_ID}/story-arcs/${ARC_ID}`)).json();
  const a = arc.arc;
  console.log(`\n=== Story Arc 蓝图 ===`);
  console.log(`标题: ${a?.arc?.title ?? a?.title ?? "(?)"}`);
  console.log(`planning_status: ${a?.planningStatus}`);
  const arcBundle = a?.arc ?? a?.payload?.arc;
  if (arcBundle) {
    console.log(`\narc 描述:\n${arcBundle.description ?? arcBundle.summary ?? "(无描述)"}`);
    console.log(`\narc 情感线/主线:\n${arcBundle.emotionalArc ?? arcBundle.thematicFocus ?? "(无)"}`);
  }
  console.log(`\n=== 章节 (${a?.chapters?.length ?? 0}) ===`);
  for (const c of a?.chapters ?? []) {
    console.log(`  #${c.ordinal} ${c.title}`);
    console.log(`    ${c.payload?.beats ?? c.beats ?? "(无 beats)"}`);
    console.log(`    目标: ${c.payload?.objective ?? c.objective ?? "(无)"}`);
  }

  // 程序术语/导师之死 等断层检查
  const blob = JSON.stringify(a);
  const techHits = (blob.match(/程序|代码|变量|函数|编译|算法|bug|debug|系统流|金手指|面板/g) || []);
  console.log(`\n=== 断层检查 ===`);
  console.log(`程序术语命中: ${techHits.length} ${techHits.length ? techHits.slice(0,10).join(", ") : "✓ 未发现"}`);
  console.log(`导师之死: ${blob.includes("导师之死") || blob.includes("院长之死") ? "⚠ 出现" : "✓ 未出现"}`);
  console.log(`苏晚意: ${blob.includes("苏晚意") ? "✓ 出现" : "⚠ 未出现"}`);
}

await pool.end();
