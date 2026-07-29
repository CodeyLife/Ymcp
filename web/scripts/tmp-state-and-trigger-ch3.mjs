// 临时：确认第二章定稿 + 触发第三章
const API = "http://127.0.0.1:4770";
const PROJECT_ID = "spirit-logic-v4-20260729";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. 确认文档状态
  const pr = await fetch(`${API}/v2/projects/${PROJECT_ID}`);
  const pj = (await pr.json()).project || {};
  console.log("=== 文档状态 ===");
  let ch3Doc = null;
  for (const doc of (pj.documents || [])) {
    console.log(`  ${doc.title} | status=${doc.status} words=${doc.wordCount} id=${doc.id}`);
    if (doc.title && doc.title.includes("无字天书")) ch3Doc = doc;
  }

  if (!ch3Doc) {
    console.log("\n未找到第三章文档，退出");
    return;
  }

  console.log(`\n第三章 docId: ${ch3Doc.id}`);

  // 2. 触发第三章
  const body = {
    projectId: PROJECT_ID,
    objective: "生成第三章正文《无字天书》：沈郁识海中的无字天书首次显形，揭示'灵气即秩序'的底层逻辑——不是文字而是震颤与结构。参考剑来的道理探究与雪中悍刀行的庙堂江湖张力。注意：修真场景禁用现代技术术语（程序/代码/病毒等），隐喻须用修真体系意象（阵眼/经纬/死结/脉络等）。苏晚意的琴音余韵作为隐线。保持3000字以上。",
    target: { kind: "chapter", id: ch3Doc.id, order: 3 },
    requestedStage: "drafting",
    source: "web",
    idempotencyKey: "spirit-logic-ch3-draft-20260729",
  };
  console.log("\n触发第三章生成...");
  const res = await fetch(`${API}/v2/intents`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  console.log(`HTTP ${res.status}`);
  try { console.log(JSON.stringify(JSON.parse(txt), null, 2)); } catch { console.log(txt.slice(0, 300)); }
}
main().catch((e) => { console.error(e); process.exit(1); });
