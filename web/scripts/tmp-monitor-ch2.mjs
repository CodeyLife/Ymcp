// 临时脚本：监控第二章 novelIntentWorkflow 进度
const API = "http://127.0.0.1:4770";
const WORKFLOW_ID = "novel-intent-9048ef4d-e441-4681-8ce4-ce074219a033";
const DOC_ID = "320caf6b-28b9-4873-9b2f-944f54ee7199";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollOnce() {
  const res = await fetch(`${API}/v2/runs/${WORKFLOW_ID}`);
  const data = await res.json();
  const record = data.record || {};
  const payload = record.payload || {};
  return { status: data.status, stage: payload.stage, payload, record };
}

async function main() {
  console.log(`监控第二章 workflow: ${WORKFLOW_ID}\n`);
  let lastKey = "";
  let iterations = 0;
  const maxIterations = 130;
  while (iterations < maxIterations) {
    iterations++;
    try {
      const { status, stage, payload } = await pollOnce();
      const key = `${status}|${stage || payload.error || ""}`;
      if (key !== lastKey) {
        const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        console.log(`[${ts}] iter=${iterations} status=${status} stage=${stage || payload.error || "(none)"}`);
        lastKey = key;
      }
      if (["completed", "failed", "rejected", "manual-review-required", "cancelled"].includes(status)) {
        console.log(`\n=== 终态: ${status} ===`);
        console.log("payload:", JSON.stringify(payload, null, 2));
        const docRes = await fetch(`${API}/v2/projects/spirit-logic-v4-20260729`);
        const project = (await docRes.json()).project;
        const ch = project.documents.find((d) => d.id === DOC_ID);
        console.log("\n=== 第二章 document ===");
        console.log(JSON.stringify({ id: ch.id, title: ch.title, status: ch.status, wordCount: ch.wordCount, latestRevision: ch.latestRevision }, null, 2));
        if (ch.status === "final") {
          const contentRes = await fetch(`${API}/v2/projects/spirit-logic-v4-20260729/documents/${DOC_ID}/content`);
          const content = await contentRes.json();
          if (content.plainText) {
            console.log(`\n=== 正文预览（总 ${content.plainText.length} 字）===`);
            console.log("开头:", content.plainText.slice(0, 300));
            console.log("...");
            console.log("结尾:", content.plainText.slice(-200));
          }
        }
        return;
      }
    } catch (e) { console.log(`[iter=${iterations}] 查询失败: ${e.message}`); }
    await sleep(10000);
  }
  console.log(`\n达到 ${maxIterations} 次迭代上限`);
}
main().catch((e) => { console.error(e); process.exit(1); });
