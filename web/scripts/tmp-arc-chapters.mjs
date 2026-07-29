// 临时：查询 story arc 章节列表
const API = "http://127.0.0.1:4770";
const PROJECT_ID = "spirit-logic-v4-20260729";
const ARC_ID = "6c15c779-f128-48f2-bc00-9dd3b870c3fd";

async function main() {
  const res = await fetch(`${API}/v2/projects/${PROJECT_ID}/story-arcs/${ARC_ID}`);
  const data = await res.json();
  const chs = data.chapters || [];
  console.log(`=== Chapters (${chs.length}) ===`);
  for (const c of chs) {
    console.log(`\nch${c.globalOrder}: ${c.title}`);
    console.log(`  purpose: ${String(c.chapterPurpose || "").slice(0, 120)}`);
    console.log(`  summary: ${String(c.summary || "").slice(0, 180)}`);
    console.log(`  question: ${String(c.dramaticQuestion || "").slice(0, 100)}`);
    console.log(`  docId: ${c.documentId}`);
    console.log(`  status: ${c.status}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
