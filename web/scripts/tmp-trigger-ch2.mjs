// 临时脚本：触发第二章正文生成
const API = "http://127.0.0.1:4770";
const PROJECT_ID = "spirit-logic-v4-20260729";
const DOC_ID = "320caf6b-28b9-4873-9b2f-944f54ee7199";
const IDEMPOTENCY_KEY = "spirit-logic-ch2-draft-20260729";

async function main() {
  const body = {
    projectId: PROJECT_ID,
    objective: "生成第二章正文《琴音知遇》：异动平息后琴音穿透雨幕与灵气共振，沈郁寻声至古亭初遇苏晚意。建立'风花雪月式等待'的缱绻情感基调，琴音与灵气共鸣强化'灵气即秩序'世界观。女主苏晚意性沉静内持锋芒，擅琴，少言语多留白。注意：修真场景禁用现代技术术语（程序/代码/病毒等），隐喻须用修真体系意象（阵眼/经纬/死结等）。",
    target: { kind: "chapter", id: DOC_ID, order: 2 },
    requestedStage: "drafting",
    source: "web",
    idempotencyKey: IDEMPOTENCY_KEY,
  };
  const res = await fetch(`${API}/v2/intents`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(`HTTP ${res.status}`);
  if (!res.ok) { console.log(JSON.stringify(json, null, 2)); process.exit(1); }
  console.log("✓ 第二章 workflow 已启动");
  console.log("workflowId:", json.workflowId);
  console.log("runId:", json.runId);
}
main().catch((e) => { console.error(e); process.exit(1); });
