// 临时：查询 craft rule candidates + learning assessments
const API = "http://127.0.0.1:4770";
const PROJECT_ID = "spirit-logic-v4-20260729";

async function main() {
  // 查询 craft rule candidates
  try {
    const res = await fetch(`${API}/v2/projects/${PROJECT_ID}/craft-rules`);
    const data = await res.json();
    const candidates = data.candidates || data.items || data.craftRules || [];
    console.log(`=== Craft Rule Candidates (${candidates.length}) ===`);
    for (const c of candidates) {
      console.log(`  [${c.id}] status=${c.status || c.evaluationStatus || "?"} scope=${c.scope || c.observedSymptom || "?"}`.slice(0, 120));
      if (c.observedSymptom) console.log(`    symptom: ${c.observedSymptom.slice(0, 100)}`);
      if (c.underlyingMechanism) console.log(`    mechanism: ${c.underlyingMechanism.slice(0, 100)}`);
    }
  } catch (e) {
    console.log(`craft-rules 查询失败: ${e.message}`);
    // 尝试其他端点
    try {
      const res2 = await fetch(`${API}/v2/projects/${PROJECT_ID}/candidates`);
      const d2 = await res2.json();
      console.log(`candidates endpoint: ${JSON.stringify(d2).slice(0, 200)}`);
    } catch (e2) {
      console.log(`candidates 也失败: ${e2.message}`);
    }
  }

  // 查询最近的 learning assessments
  try {
    const res = await fetch(`${API}/v2/projects/${PROJECT_ID}/learning`);
    const data = await res.json();
    console.log(`\n=== Learning Assessments ===`);
    console.log(JSON.stringify(data).slice(0, 500));
  } catch (e) {
    console.log(`learning 查询失败: ${e.message}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
