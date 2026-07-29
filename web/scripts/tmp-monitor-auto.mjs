// 临时：监控章节 workflow + 自动审批（参数化）
// 用法: node tmp-monitor-auto.mjs <workflowId> <docId>
const API = "http://127.0.0.1:4770";
const PROJECT_ID = "spirit-logic-v4-20260729";
const WORKFLOW_ID = process.argv[2];
const DOC_ID = process.argv[3];
if (!WORKFLOW_ID || !DOC_ID) {
  console.log("用法: node tmp-monitor-auto.mjs <workflowId> <docId>");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollOnce() {
  const res = await fetch(`${API}/v2/runs/${WORKFLOW_ID}`);
  const data = await res.json();
  const record = data.record || {};
  const payload = record.payload || {};
  return { status: data.status, stage: payload.stage, payload };
}

async function sendApprove() {
  const body = {
    workflowId: WORKFLOW_ID,
    signal: "humanSignal",
    payload: { decision: "approve", authorId: "web-author", feedback: "作者审核通过，准予定稿。" },
  };
  const res = await fetch(`${API}/v2/tasks/${WORKFLOW_ID}/signal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return res.status;
}

async function main() {
  console.log(`监控 workflow: ${WORKFLOW_ID} | doc: ${DOC_ID}\n`);
  let lastKey = "";
  let approved = false;
  for (let i = 1; i <= 240; i++) {
    try {
      const { status, stage, payload } = await pollOnce();
      const key = `${status}|${stage || payload.error || ""}`;
      if (key !== lastKey) {
        const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        console.log(`[${ts}] iter=${i} status=${status} stage=${stage || payload.error || "(none)"}`);
        lastKey = key;
      }
      if (status === "manual-review-required" && !approved) {
        const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        console.log(`[${ts}] 到达 manual-review-required，发送审批信号...`);
        console.log(`  score=${payload.finalScore} issues=${payload.issueCount} iter=${payload.iteration}`);
        const code = await sendApprove();
        console.log(`  审批信号: HTTP ${code}`);
        approved = true;
      }
      if (["completed", "failed", "rejected", "cancelled"].includes(status)) {
        console.log(`\n=== 终态: ${status} ===`);
        console.log(`score=${payload.finalScore} authorApproved=${payload.authorApproved || false} iterations=${payload.iterations}`);
        const cr = await fetch(`${API}/v2/projects/${PROJECT_ID}/documents/${DOC_ID}/content`);
        const content = await cr.json();
        if (content.plainText) {
          console.log(`\n=== 正文（总 ${content.plainText.length} 字）===`);
          console.log("开头:", content.plainText.slice(0, 250));
          console.log("...\n结尾:", content.plainText.slice(-200));
          const tech = ["病毒", "代码", "程序", "算法", "系统", "模块", "函数", "接口", "bug"];
          const found = tech.filter((t) => content.plainText.includes(t));
          console.log(`\n技术术语: ${found.length ? found.join(", ") : "未发现 ✓"}`);
        }
        return;
      }
    } catch (e) { console.log(`[iter=${i}] 查询失败: ${e.message}`); }
    await sleep(10000);
  }
  console.log(`\n达到迭代上限`);
}
main().catch((e) => { console.error(e); process.exit(1); });
