// 临时：用正确端点查询第二章 draft + reviews
const API = "http://127.0.0.1:4770";
const PROJECT_ID = "spirit-logic-v4-20260729";
const DRAFT_ARTIFACT_ID = "0d2a3b51-4ed6-4421-a166-0ac7b68a6014";
const REVIEW_IDS = [
  "56789eb0-e539-49b9-bb71-bbb1207b9785",
  "780a4229-e345-40b5-9525-4e8603033d55",
  "370cceaa-a096-4b5e-9cce-cb59ca7d17b8",
  "eea1080b-2f67-4fbb-83b7-2e91da414238",
  "99829376-e1aa-4ed6-b73e-56077fe35943",
];

async function main() {
  // 1. draft artifact 内容
  console.log("=== 第二章 Draft Artifact ===");
  try {
    const res = await fetch(`${API}/v2/artifacts/${DRAFT_ARTIFACT_ID}/content`);
    const data = await res.json();
    const text = data.text || data.plainText || data.content || "";
    if (text) {
      console.log(`总字数: ${text.length}`);
      console.log(`\n开头 400 字:\n${text.slice(0, 400)}`);
      console.log(`\n结尾 200 字:\n${text.slice(-200)}`);
      // 技术术语
      const tech = ["病毒","代码","程序","算法","数据","系统","模块","函数","变量","编译","运行","执行","内存","字节","协议","接口","bug","debug","终端","命令","脚本","参数","逻辑门","寄存器"];
      const found = [];
      for (const t of tech) { const i = text.indexOf(t); if (i>=0) found.push(`[${t}] ...${text.slice(Math.max(0,i-15),i+t.length+15)}...`); }
      console.log(`\n技术术语检查: ${found.length ? "\n" + found.join("\n") : "未发现"}`);
    } else {
      console.log("artifact 无文本:", JSON.stringify(data).slice(0, 300));
    }
  } catch (e) {
    console.log(`draft 查询失败: ${e.message}`);
  }

  // 2. reviews (POST /v2/reviews)
  console.log("\n=== 第二章 Reviews ===");
  for (const rid of REVIEW_IDS) {
    try {
      const res = await fetch(`${API}/v2/reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: PROJECT_ID, reviewId: rid }),
      });
      if (!res.ok) { console.log(`  [${rid.slice(0,8)}] HTTP ${res.status}`); continue; }
      const rv = await res.json();
      const review = rv.review || rv;
      console.log(`\n  [${rid.slice(0,8)}] role=${review.role || "?"} verdict=${review.verdict} score=${review.score ?? "-"} identity=${review.identity || "?"}`);
      for (const issue of (review.issues || [])) {
        console.log(`    [${issue.severity}] ${issue.title}`);
        if (issue.description) console.log(`        ${String(issue.description).slice(0, 150)}`);
      }
    } catch (e) {
      console.log(`  [${rid.slice(0,8)}] ERR ${e.message}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
