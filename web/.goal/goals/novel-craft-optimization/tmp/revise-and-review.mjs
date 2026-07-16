// Loop 4：基于 chapter-review.json 的 1 major + 6 minor issues 让 LLM 做定向改写，然后再审阅一轮。
// 复用 real-llm-generation.test.ts 的 API_BASE/API_KEY/streaming fetch 模式。

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const API_BASE = "https://gpt.eromaa.com/v1";
const API_KEY = "sk-ziQCyGrdbsldbmTcdFuDMrAJ_P_5jrZd";

const draftV1 = readFileSync(join(__dirname, "chapter-draft.md"), "utf8");
const reviewV1 = JSON.parse(readFileSync(join(__dirname, "chapter-review.json"), "utf8"));

async function callRealLLM(prompt, systemPrompt, maxTokens, temperature) {
  const body = {
    model: "auto",
    temperature,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
  };

  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  if (!response.body) throw new Error("AI 响应没有可读取内容");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const raw = line.replace(/^data:\s*/, "").trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const chunk = JSON.parse(raw);
        result += chunk?.choices?.[0]?.delta?.content ?? "";
        if (chunk?.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0;
          outputTokens = chunk.usage.completion_tokens ?? 0;
        }
      } catch {
        /* vendor keepalive */
      }
    }
  }

  if (!result.trim()) throw new Error("AI 未返回有效内容");
  return { content: result.trim(), usage: { inputTokens, outputTokens } };
}

async function callStructuredReview(prompt) {
  const body = {
    model: "auto",
    temperature: 0,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 8192,
    messages: [
      { role: "system", content: "你是独立小说审阅员。只基于提供的正文给出维度评分与具体改进点。不要泛泛而谈，每条改进点必须引用原文。必须只输出一个 JSON 对象，不要输出任何其他文字、代码围栏或解释。" },
      { role: "user", content: prompt },
    ],
  };

  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const raw = line.replace(/^data:\s*/, "").trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const chunk = JSON.parse(raw);
        result += chunk?.choices?.[0]?.delta?.content ?? "";
      } catch {
        /* keepalive */
      }
    }
  }
  const fenced = result.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? result.slice(result.indexOf("{"), result.lastIndexOf("}") + 1);
  return JSON.parse(candidate.trim());
}

// ===== 1. 构建 revision prompt =====
const issuesBlock = reviewV1.issues
  .map((i, idx) => {
    return `### Issue ${idx + 1}（${i.severity}）— ${i.dimension}
- 问题描述：${i.description}
- 原文证据：${i.evidence}
- 改写建议：${i.suggestion}`;
  })
  .join("\n\n");

const revisionSystemPrompt = [
  "你在专业小说创作系统内工作。用户批准的事实库、锁定规则、角色知识边界和审批状态不可被覆盖。输出必须尊重指定格式，不泄露内部推理。",
  "你是小说正文修订者。基于审阅反馈对原文做定向改写，只输出一份连续正文，不输出任何说明、对比、meta 信息或代码围栏。",
  "修订铁律：",
  "1. 不得改变已批准的冻结事实（人物年龄、身份、世界规则、时间线、物品、知识边界）。",
  "2. 不得违反必须发生与禁止事项（章尾苏婉哼歌、剑鞘露半寸、苏婉替陆寒解围、苏婉劝陆寒离开等必须保留）。",
  "3. 章尾钩子必须落在十型之一（信息遮断/关键信息凸显/倒计时/抉择时刻/立场反转/危险前置/目标失效/关系破裂/动机揭露/认知反转），并制造让读者想知道接下来发生什么的开放问题或新信息压力。",
  "4. 去情绪化书写——情绪不可直说，必须由动作/物件/环境承载（参考：五竹黑布微扬/海棠指尖捻碎花瓣/范闲捏碎瓷枕）。",
  "5. 双声部语体——典雅声部（朝堂奏对/诗会唱和）与市井声部（酒馆闲谈/师徒相处）必须区分，陆寒偏修行者疏离戒备，苏婉偏客栈掌柜绕开重点的市井话术。",
  "6. 对白要有潜台词——危险信息不可由角色直接说出，必须通过试探、回避、物件转移让对手自己推断。",
].join("\n");

const revisionUserPrompt = `请基于以下审阅反馈对原文做定向改写。

## 改写重点（按 severity 排序）

${issuesBlock}

## 额外定向改写要求

1. **苏婉提醒陆寒离开**（major）：删除"你不该进城/这里不是三年前了/青阳县现在查得严/天亮前走"这类直接说明。改为试探回避式潜台词——例如苏婉先问"你的剑还带着？"或"城门今日多了几双眼睛，你没发现？"让陆寒自己推断危险来源。最后只说"楼梯在那边"，把劝离藏在动作里（如把灯芯拨亮、把茶杯收走）。

2. **斗笠客试探**（minor）：删除"让我看看"这种直白宣告。改为先绕开包裹谈天气、路途，借查验名义接近，让"想看剑"的目的隐藏在表层交流之后。增加身份压迫——清查司铜牌的"查"字可以借由动作（如手指按在铜牌上、把斗笠摘下露出官气）让压迫感外溢。

3. **雨意象转化**（minor）：雨不可只承担单一情绪功能。至少让雨在两处改变人物选择——例如雨导致追踪痕迹暴露（陆寒进城时泥脚印被斗笠客注意到）/雨遮掩脚步（苏婉添茶时雨声盖住她的呼吸）/雨影响清查司搜查（雨打湿铜牌让查字模糊/雨让斗笠客不得不进客栈避雨）。

4. **人物声音区分**（minor）：陆寒保留修行者疏离（更短句、更多沉默、对物件而非对人说话），苏婉增加客栈掌柜话术（绕开重点、用添茶换酒掩饰情绪、对陌生人比 对陆寒更热络）。

5. **陆寒目标前置**（minor）：在陆寒进入客栈前增加明确驱动力线索——他为何必须找老周（如老周是他师父旧识/老周手里有他要的东西）、包裹中的剑为何不能暴露、清查司为何追查他。这些线索不可直接说明，必须通过陆寒的视线、动作、对苏婉话的反应让读者推断。

6. **章尾外部冲突压力**（minor）：保留小调伏笔，同时增加新的信息压力——例如让陆寒意识到苏婉为何会唱出未教过她的部分（暗示有人曾通过这首曲子寻找他），或让斗笠客在后院的方向出现异动（如灯火移动、脚步声不止一人），使结尾同时推动秘密和危险线。

7. **斗笠客剑鞘敏锐前置**（minor）：此前加入细节暗示——如斗笠客进门时先观察桌椅、兵器痕迹，或描写清查司专门追查某类兵器的设定，让他认出剑鞘显得合理。

## 原文

${draftV1}

## 输出要求

- 只输出改写后的完整正文，不输出任何说明、对比、meta 信息或代码围栏。
- 字数与原文相近（2400-2800 字符之间）。
- 保留原文的克制风格与文白相济的质感。
- 段落用空行分隔，与原文格式一致。`;

// ===== 2. 调用 LLM 改写 =====
console.log("[loop4] 开始定向改写...");
const reviseStart = Date.now();
const reviseResult = await callRealLLM(revisionUserPrompt, revisionSystemPrompt, 12000, 0.7);
const reviseDuration = Date.now() - reviseStart;
const revisedCharCount = [...reviseResult.content].length;
console.log(`[loop4] 改写完成，耗时 ${Math.round(reviseDuration / 1000)}s，输入 ${reviseResult.usage.inputTokens} tokens，输出 ${reviseResult.usage.outputTokens} tokens`);
console.log(`[loop4] 改写后正文长度：${revisedCharCount} 字符`);

writeFileSync(join(__dirname, "chapter-draft-v2.md"), reviseResult.content);
writeFileSync(join(__dirname, "revision-meta.json"), JSON.stringify({
  revisedAt: new Date().toISOString(),
  reviseDurationMs: reviseDuration,
  charCount: revisedCharCount,
  inputTokens: reviseResult.usage.inputTokens,
  outputTokens: reviseResult.usage.outputTokens,
  v1CharCount: [...draftV1].length,
}, null, 2));

// ===== 3. 独立审阅 v2 =====
const reviewPrompt = `请审阅以下仙侠小说章节正文（修订版 v2），从 8 个维度评分（1-5 分）并给出具体改进点。

评分维度说明：
1. 叙事吸引力（narrativeAppeal）：场景是否有张力，人物当下欲望是否清晰
2. 中文美学（chineseAesthetic）：文笔质感，文白是否相济，是否有模板化网文腔
3. 人物声音（characterVoice）：去掉名字是否能认出说话人，对白是否有潜台词
4. 情节连续性（plotContinuity）：人物位置、时间、知识边界是否一致
5. 意象运用（imageryUsage）：环境意象是否承载情绪，是否只是装饰
6. 对白质地（dialogueQuality）：对白是否有动作神态夹对白，是否直白宣告
7. 节奏张弛（pacing）：长短句是否交错，安静场景是否有暗流
8. 章尾驱动力（chapterEndingDrive）：章尾是否既落在悬念/伏笔/哲思/意象四者之一，又制造一个让读者想知道"接下来会发生什么"的开放问题或新信息压力。仅停在情感余韵的封闭画面（如停在楼梯不回头+只有雨声无新信息）不超过 3 分

每条 issue 必须引用原文证据（具体到句子），并给出具体改写建议。

必须只输出一个 JSON 对象，格式如下，不要输出任何其他文字：
{"scores":{"narrativeAppeal":4,"chineseAesthetic":4,"characterVoice":4,"plotContinuity":4,"imageryUsage":3,"dialogueQuality":4,"pacing":3,"chapterEndingDrive":4},"issues":[{"dimension":"对白质地","severity":"major","description":"问题说明","evidence":"原文引用","suggestion":"改写建议"}],"summary":"总体评价"}

## 章节正文（修订版 v2）

${reviseResult.content}`;

console.log("[loop4] 开始独立审阅 v2...");
const reviewStart = Date.now();
const reviewV2 = await callStructuredReview(reviewPrompt);
const reviewDuration = Date.now() - reviewStart;
console.log(`[loop4] 审阅完成，耗时 ${Math.round(reviewDuration / 1000)}s`);

writeFileSync(join(__dirname, "chapter-review-v2.json"), JSON.stringify(reviewV2, null, 2));

// ===== 4. 对比 v1 vs v2 =====
const v1Scores = reviewV1.scores;
const v2Scores = reviewV2.scores;
const dims = ["narrativeAppeal", "chineseAesthetic", "characterVoice", "plotContinuity", "imageryUsage", "dialogueQuality", "pacing", "chapterEndingDrive"];
const dimLabels = {
  narrativeAppeal: "叙事吸引力",
  chineseAesthetic: "中文美学",
  characterVoice: "人物声音",
  plotContinuity: "情节连续性",
  imageryUsage: "意象运用",
  dialogueQuality: "对白质地",
  pacing: "节奏张弛",
  chapterEndingDrive: "章尾驱动力",
};

const v1Avg = dims.reduce((s, d) => s + v1Scores[d], 0) / 8;
const v2Avg = dims.reduce((s, d) => s + v2Scores[d], 0) / 8;
const v1Blocker = reviewV1.issues.filter((i) => i.severity === "blocker").length;
const v1Major = reviewV1.issues.filter((i) => i.severity === "major").length;
const v1Minor = reviewV1.issues.filter((i) => i.severity === "minor").length;
const v2Blocker = reviewV2.issues.filter((i) => i.severity === "blocker").length;
const v2Major = reviewV2.issues.filter((i) => i.severity === "major").length;
const v2Minor = reviewV2.issues.filter((i) => i.severity === "minor").length;

console.log("");
console.log("===== v1 vs v2 对比 =====");
console.log(`维度                  v1 → v2  变化`);
for (const d of dims) {
  const v1 = v1Scores[d];
  const v2 = v2Scores[d];
  const delta = v2 - v1;
  const sign = delta > 0 ? "+" : "";
  console.log(`${dimLabels[d].padEnd(18)}  ${v1} → ${v2}  ${sign}${delta}`);
}
console.log(`平均                 ${v1Avg.toFixed(2)} → ${v2Avg.toFixed(2)}  ${v2Avg - v1Avg > 0 ? "+" : ""}${(v2Avg - v1Avg).toFixed(2)}`);
console.log(`blocker: ${v1Blocker} → ${v2Blocker}, major: ${v1Major} → ${v2Major}, minor: ${v1Minor} → ${v2Minor}`);

const comparisonSummary = {
  comparedAt: new Date().toISOString(),
  v1: {
    charCount: [...draftV1].length,
    averageScore: Number(v1Avg.toFixed(2)),
    scores: v1Scores,
    blocker: v1Blocker,
    major: v1Major,
    minor: v1Minor,
    issueCount: reviewV1.issues.length,
  },
  v2: {
    charCount: revisedCharCount,
    averageScore: Number(v2Avg.toFixed(2)),
    scores: v2Scores,
    blocker: v2Blocker,
    major: v2Major,
    minor: v2Minor,
    issueCount: reviewV2.issues.length,
  },
  delta: {
    averageScore: Number((v2Avg - v1Avg).toFixed(2)),
    scores: Object.fromEntries(dims.map((d) => [d, v2Scores[d] - v1Scores[d]])),
    blocker: v2Blocker - v1Blocker,
    major: v2Major - v1Major,
    minor: v2Minor - v1Minor,
  },
  reviseDurationMs: reviseDuration,
  reviewDurationMs: reviewDuration,
  v2Summary: reviewV2.summary,
};

writeFileSync(join(__dirname, "v1-v2-comparison.json"), JSON.stringify(comparisonSummary, null, 2));
console.log("");
console.log("[loop4] v2 总评：", reviewV2.summary);
console.log("[loop4] 产物：chapter-draft-v2.md / chapter-review-v2.json / v1-v2-comparison.json / revision-meta.json");
