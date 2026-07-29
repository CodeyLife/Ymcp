// 临时：批准第二章（humanSignal approve）
const API = "http://127.0.0.1:4770";
const WORKFLOW_ID = "novel-intent-9048ef4d-e441-4681-8ce4-ce074219a033";

async function main() {
  const body = {
    workflowId: WORKFLOW_ID,
    signal: "humanSignal",
    payload: {
      decision: "approve",
      authorId: "web-author",
      feedback: "作者审核通过第二章《琴音知遇》。琴音与灵气共振的意象到位，女主苏晚意初遇留白得当，无现代技术术语残留。准予定稿。",
    },
  };
  const res = await fetch(`${API}/v2/tasks/${WORKFLOW_ID}/signal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
}
main().catch((e) => { console.error(e); process.exit(1); });
