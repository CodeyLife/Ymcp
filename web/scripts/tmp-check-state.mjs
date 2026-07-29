// 临时诊断：查询两章 workflow + 项目文档状态
const API = "http://127.0.0.1:4770";
const PROJECT_ID = "spirit-logic-v4-20260729";
const WORKFLOWS = [
  { id: "novel-intent-9048ef4d-e441-4681-8ce4-ce074219a033", label: "第二章 琴音知遇" },
  { id: "novel-intent-a02bd77f-c4c8-47cd-bea9-ef302767ef10", label: "第一章 符箓中的错误" },
];

async function main() {
  for (const wf of WORKFLOWS) {
    try {
      const res = await fetch(`${API}/v2/runs/${wf.id}`);
      const data = await res.json();
      const p = (data.record && data.record.payload) || {};
      console.log(`[${wf.label}] status=${data.status} stage=${p.stage || "(none)"} score=${p.finalScore ?? "-"} issues=${p.issueCount ?? "-"} iter=${p.iteration ?? "-"} reason=${(p.decision || p.reasonCode || "").slice(0, 80)}`);
    } catch (e) {
      console.log(`[${wf.label}] ERR ${e.message}`);
    }
  }

  const pr = await fetch(`${API}/v2/projects/${PROJECT_ID}`);
  const pj = (await pr.json()).project || {};
  console.log("\n=== Documents ===");
  for (const doc of (pj.documents || [])) {
    console.log(`  ch${doc.order ?? "-"} | ${doc.title} | status=${doc.status} words=${doc.wordCount || 0} rev=${doc.latestRevision ?? 0}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
