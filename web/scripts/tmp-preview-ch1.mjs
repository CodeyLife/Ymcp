// 临时：预览第一章定稿正文 + 检查残留风格问题
const API = "http://127.0.0.1:4770";
const PROJECT_ID = "spirit-logic-v4-20260729";
const CH1_DOC_ID = "85d7dad8-0b6e-4fc6-bf9f-07f1e1f4defe";

async function main() {
  const res = await fetch(`${API}/v2/projects/${PROJECT_ID}/documents/${CH1_DOC_ID}/content`);
  const data = await res.json();
  const text = data.plainText || "";
  console.log(`总字数: ${text.length}`);
  console.log(`\n=== 开头 500 字 ===\n${text.slice(0, 500)}`);
  console.log(`\n=== 结尾 300 字 ===\n${text.slice(-300)}`);

  // 检查残留风格问题：现代技术术语
  const techTerms = ["病毒", "代码", "程序", "算法", "数据", "系统", "模块", "函数", "变量", "编译", "运行", "执行", "内存", "字节", "协议", "接口", "API", "bug", "debug", "crash", "终端", "命令", "脚本", "参数", "逻辑门", "寄存器"];
  const found = [];
  for (const term of techTerms) {
    const idx = text.indexOf(term);
    if (idx >= 0) {
      const ctx = text.slice(Math.max(0, idx - 20), idx + term.length + 20);
      found.push({ term, ctx });
    }
  }
  console.log(`\n=== 残留技术术语检查 ===`);
  if (found.length === 0) {
    console.log("未发现明显现代技术术语");
  } else {
    for (const f of found) {
      console.log(`  [${f.term}] ...${f.ctx}...`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
