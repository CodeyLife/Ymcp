// 临时：重新检查第二章 workflow 状态 + 重发信号
const API = "http://127.0.0.1:4770";
const WORKFLOW_ID = "novel-intent-9048ef4d-e441-4681-8ce4-ce074219a033";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 当前状态
  const res = await fetch(`${API}/v2/runs/${WORKFLOW_ID}`);
  const data = await res.json();
  const p = (data.record && data.record.payload) || {};
  console.log(`当前状态: status=${data.status} stage=${p.stage || "(none)"} authorApproved=${p.authorApproved || false}`);

  if (data.status === "manual-review-required") {
    console.log("\n仍在 manual-review-required，重新发送审批信号...");
    const body = {
      workflowId: WORKFLOW_ID,
      signal: "humanSignal",
      payload: {
        decision: "approve",
        authorId: "web-author",
        feedback: "作者审核通过第二章，准予定稿。",
      },
    };
    const res2 = await fetch(`${API}/v2/tasks/${WORKFLOW_ID}/signal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    console.log(`重发信号: HTTP ${res2.status}`);
    const txt = await res2.text();
    console.log(txt.slice(0, 200));

    // 等待 15 秒再查
    console.log("\n等待 15 秒...");
    await sleep(15000);
    const res3 = await fetch(`${API}/v2/runs/${WORKFLOW_ID}`);
    const data3 = await res3.json();
    const p3 = (data3.record && data3.record.payload) || {};
    console.log(`重发后状态: status=${data3.status} stage=${p3.stage || "(none)"} authorApproved=${p3.authorApproved || false}`);
  } else {
    console.log("已脱离 manual-review-required");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
