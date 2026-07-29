// 临时：查询项目 candidate bundles（craft rule candidates）
const API = "http://127.0.0.1:4770";
const PROJECT_ID = "spirit-logic-v4-20260729";

async function main() {
  // 1. 列出 candidates
  const res = await fetch(`${API}/v2/projects/${PROJECT_ID}/candidates`);
  const data = await res.json();
  const candidates = data.candidates || [];
  console.log(`=== Candidate Bundles (${candidates.length}) ===`);
  for (const c of candidates) {
    console.log(`\n  [${c.id}] type=${c.type || c.candidateType || "?"} status=${c.status || c.evaluationStatus || "?"}`);
    if (c.observedSymptom) console.log(`    symptom: ${String(c.observedSymptom).slice(0, 150)}`);
    if (c.underlyingMechanism) console.log(`    mechanism: ${String(c.underlyingMechanism).slice(0, 150)}`);
    if (c.affectedInputClass) console.log(`    affectedClass: ${String(c.affectedInputClass).slice(0, 100)}`);
    if (c.proposedRule) console.log(`    rule: ${String(c.proposedRule).slice(0, 150)}`);
    if (c.evaluationResult) console.log(`    evalResult: ${JSON.stringify(c.evaluationResult).slice(0, 150)}`);
  }

  // 2. 列出 learning assessments (需要先找到 IDs，从 workflow payload)
  // 查询第一章和第二章的 workflow payload 中的 assessmentKey
  const wfIds = [
    "novel-intent-a02bd77f-c4c8-47cd-bea9-ef302767ef10",
    "novel-intent-9048ef4d-e441-4681-8ce4-ce074219a033",
  ];
  console.log("\n=== Learning Assessment Keys ===");
  for (const wfId of wfIds) {
    try {
      const r = await fetch(`${API}/v2/runs/${wfId}`);
      const d = await r.json();
      const p = (d.record && d.record.payload) || {};
      console.log(`  ${wfId.slice(-12)}: stage=${p.stage} score=${p.finalScore || "-"} assessmentKey=${p.assessmentKey || "-"}`);
    } catch (e) { console.log(`  ${wfId.slice(-12)}: ERR ${e.message}`); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
