// 临时：监控第二章审批后完成 + 获取第三章 docId
const API = "http://127.0.0.1:4770";
const PROJECT_ID = "spirit-logic-v4-20260729";
const CH2_WORKFLOW = "novel-intent-9048ef4d-e441-4681-8ce4-ce074219a033";
const CH2_DOC_ID = "320caf6b-28b9-4873-9b2f-944f54ee7199";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("监控第二章审批后完成...\n");
  let lastKey = "";
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${API}/v2/runs/${CH2_WORKFLOW}`);
      const data = await res.json();
      const p = (data.record && data.record.payload) || {};
      const key = `${data.status}|${p.stage || ""}`;
      if (key !== lastKey) {
        const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        console.log(`[${ts}] status=${data.status} stage=${p.stage || "(none)"} ${p.commitResult ? "committed" : ""}`);
        lastKey = key;
      }
      if (["completed", "failed", "cancelled"].includes(data.status)) {
        console.log(`\n=== 终态: ${data.status} ===`);
        // 查询 document
        const pr = await fetch(`${API}/v2/projects/${PROJECT_ID}`);
        const pj = (await pr.json()).project || {};
        const ch2 = (pj.documents || []).find((d) => d.id === CH2_DOC_ID);
        console.log(`第二章: status=${ch2.status} words=${ch2.wordCount} rev=${ch2.latestRevision ?? 0}`);
        console.log("\n=== 所有文档 ===");
        for (const doc of (pj.documents || [])) {
          console.log(`  ${doc.title} | status=${doc.status} words=${doc.wordCount} id=${doc.id}`);
        }
        return;
      }
    } catch (e) { console.log(`[iter=${i}] ERR ${e.message}`); }
    await sleep(5000);
  }
  console.log("达到迭代上限");
}
main().catch((e) => { console.error(e); process.exit(1); });
