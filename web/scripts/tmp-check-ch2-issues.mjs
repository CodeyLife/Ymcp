// 临时：查询第二章 review 详情 + draft 内容
const API = "http://127.0.0.1:4770";
const PROJECT_ID = "spirit-logic-v4-20260729";
const CH2_WORKFLOW = "novel-intent-9048ef4d-e441-4681-8ce4-ce074219a033";
const CH2_DOC_ID = "320caf6b-28b9-4873-9b2f-944f54ee7199";
const FAILED_REVIEW_IDS = ["eea1080b-2f67-4fbb-83b7-2e91da414238", "99829376-e1aa-4ed6-b73e-56077fe35943"];
const ALL_REVIEW_IDS = ["56789eb0-e539-49b9-bb71-bbb1207b9785", "780a4229-e345-40b5-9525-4e8603033d55", "370cceaa-a096-4b5e-9cce-cb59ca7d17b8", "eea1080b-2f67-4fbb-83b7-2e91da414238", "99829376-e1aa-4ed6-b73e-56077fe35943"];

async function main() {
  // 1. 查询 reviews
  console.log("=== 第二章 Reviews ===");
  for (const rid of ALL_REVIEW_IDS) {
    try {
      const res = await fetch(`${API}/v2/projects/${PROJECT_ID}/reviews/${rid}`);
      if (!res.ok) { console.log(`  [${rid.slice(0,8)}] HTTP ${res.status}`); continue; }
      const rv = await res.json();
      const review = rv.review || rv;
      const failed = FAILED_REVIEW_IDS.includes(rid) ? " ❌FAILED" : " ✓passed";
      console.log(`\n  [${rid.slice(0,8)}] role=${review.role || "?"} verdict=${review.verdict}${failed} score=${review.score ?? "-"}`);
      for (const issue of (review.issues || [])) {
        console.log(`    [${issue.severity}] ${issue.title}: ${String(issue.description||"").slice(0,120)}`);
      }
    } catch (e) {
      console.log(`  [${rid.slice(0,8)}] ERR ${e.message}`);
    }
  }

  // 2. 查询 chapter 2 draft artifact 内容
  console.log("\n=== 第二章 Draft 内容检查 ===");
  try {
    const res = await fetch(`${API}/v2/projects/${PROJECT_ID}/documents/${CH2_DOC_ID}/content`);
    const data = await res.json();
    const text = data.plainText || "";
    if (text) {
      console.log(`总字数: ${text.length}`);
      console.log(`开头: ${text.slice(0, 300)}`);
      // 技术术语检查
      const techTerms = ["病毒","代码","程序","算法","数据","系统","模块","函数","变量","编译","运行","执行","内存","字节","协议","接口","bug","debug","终端","命令","脚本","参数","逻辑门","寄存器"];
      const found = [];
      for (const t of techTerms) { const i = text.indexOf(t); if (i>=0) found.push(`${t}@"${text.slice(Math.max(0,i-15),i+t.length+15)}"`); }
      console.log(`\n技术术语: ${found.length ? found.join(" | ") : "未发现"}`);
    } else {
      console.log("document 尚无 plainText（未 commit）");
    }
  } catch (e) {
    console.log(`draft 查询失败: ${e.message}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
