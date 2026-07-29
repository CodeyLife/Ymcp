// 临时：触发章节生成（可复用 ch4/ch5）
// 用法: node tmp-trigger-chapter.mjs <chapterNum>
const API = "http://127.0.0.1:4770";
const PROJECT_ID = "spirit-logic-v4-20260729";

const CHAPTERS = {
  4: {
    docId: "2b1f0719-0485-4bc0-9f08-8c843a043ac7",
    title: "第四章 院长的教诲",
    idempotencyKey: "spirit-logic-ch4-draft-20260729-r3",
    objective: "生成第四章正文《院长的教诲》：白鹿书院院长（导师）察觉沈郁在符箓异动中展现的异常才能，召其入书房赠予一本晦涩古籍，书中暗藏对修真界秩序的非正统解释——灵气流转并非天道恩赐而是'经纬自织'的秩序自洽。导师话语点到为止，仅提及'天幕契约'四字便不再深说，埋下种子不展开。参考雪中悍刀行庙堂人物的深沉与剑来道理探究的层层递进。沈郁从'盲目信奉'转向'理性审视'的内心转折要细腻。注意：修真场景禁用现代技术术语（程序/代码/病毒等），隐喻须用修真体系意象（经纬/脉络/死结/天理/秩序等）。苏晚意的琴音余韵作为隐线若隐若现。保持3000字以上。",
  },
  5: {
    docId: "2f0814e5-edf9-423c-9c9a-3ef046085fbb",
    title: "第五章 江南来客",
    idempotencyKey: "spirit-logic-ch5-draft-20260729-r1",
    objective: "生成第五章正文《江南来客》：一位江南来客造访白鹿书院，声称寻找'能听懂琴音逻辑'之人。此人气质不凡，暗藏百晓门背景。来客对沈郁展现出异常关注，试探其对灵气秩序的理解。书院内外暗流涌动，外部势力介入的阴影初现。参考雪中悍刀行江湖庙堂交织的张力与剑来人物登场的惊艳感。苏晚意与沈郁的精神共鸣在来客试探时产生微妙波动。注意：修真场景禁用现代技术术语（程序/代码/病毒等），隐喻须用修真体系意象（经纬/脉络/死结/天理/秩序等）。作为首弧开篇引子收束章，要为后续故事弧（导师之死、空明案展开）埋下伏笔但不含高潮。保持3000字以上。",
  },
};

async function main() {
  const num = parseInt(process.argv[2] || "0", 10);
  const ch = CHAPTERS[num];
  if (!ch) {
    console.log("用法: node tmp-trigger-chapter.mjs <4|5>");
    process.exit(1);
  }

  const body = {
    projectId: PROJECT_ID,
    objective: ch.objective,
    target: { kind: "chapter", id: ch.docId, order: num },
    requestedStage: "drafting",
    source: "web",
    idempotencyKey: ch.idempotencyKey,
  };
  console.log(`触发 ${ch.title}...`);
  const res = await fetch(`${API}/v2/intents`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  console.log(`HTTP ${res.status}`);
  try {
    const data = JSON.parse(txt);
    console.log(`workflowId: ${data.workflowId}`);
    console.log(`intentId: ${data.intent?.id}`);
  } catch {
    console.log(txt.slice(0, 300));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
