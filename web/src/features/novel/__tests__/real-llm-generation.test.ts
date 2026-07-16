import { describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { buildChapterDraftPrompt } from "../prose-prompts";
import { compileNovelStagePrompt, resolveNovelSkills } from "../skills";
import { createNovelProject } from "../db";

const API_BASE = "https://gpt.eromaa.com/v1";
const API_KEY = "sk-ziQCyGrdbsldbmTcdFuDMrAJ_P_5jrZd";
const OUTPUT_DIR = ".goal/goals/novel-craft-refinement/tmp";

const SYSTEM_INVARIANTS = "你在专业小说创作系统内工作。用户批准的事实库、锁定规则、角色知识边界和审批状态不可被覆盖。输出必须尊重指定格式，不泄露内部推理。";
const WRITER_ROLE = "你是小说正文作者。忠实执行已批准蓝图和当前写作契约，只输出一份连续正文，不擅自改变上层规划。";

const XIANXIA_BLUEPRINT = `## 章节蓝图：寒灯渡

### 主导叙事功能
深化人物与关系 + 积累情绪与压力

### 精确起点
日落时分，陆寒背着一把裹布长剑走进青阳县的"老周客栈"。秋雨已下了三日，街面湿滑，行人稀少。他三年前曾在此住过半月，那时老周还在，苏婉才十四岁。

### 节拍
1. 行动：陆寒推门进客栈，发现堂中只有苏婉在擦桌。
   情绪：克制的不安——他不确定苏婉是否还记得他。
   结果：苏婉抬头认出他，动作停顿了一瞬，随即继续擦桌，只说"楼上空着"。

2. 行动：陆寒在堂中喝苏婉端来的热茶，试图问起老周。苏婉三次回避，用擦桌、添茶、看雨打断他。
   情绪：试探与回避——两人都在等对方先开口。
   结果：苏婉终于说"爹走了，去年冬天"，语气平淡得像在说天气。

3. 行动：一个戴斗笠的客人推门进来，要酒要肉，言行粗鲁。陆寒注意到他腰间挂着一枚铜牌——是"清查司"的牌子。
   情绪：警觉——清查司专管追捕私带兵器入城的游侠。
   结果：陆寒不动声色地将裹布长剑往桌下挪了挪。

4. 行动：斗笠客人酒过三巡，忽然问陆寒"那布包里是什么"。陆寒说"一卷旧画"。对方不信，伸手要掀。苏婉忽然开口："这位客官，酒凉了，我给你换一壶。"
   情绪：苏婉的紧张与陆寒的决断——她用行动替他解围，他意识到她比三年前懂事太多。
   结果：斗笠客人注意力被引开，陆寒趁机将剑柄转向便于拔出的角度。

5. 行动：斗笠客人起身去茅房，路过陆寒时故意碰了一下桌角，裹布滑落，剑鞘露出半寸。他回头笑了一下，没说话，走了。
   情绪：山雨欲来——双方都明白对方的身份，但都没挑明。
   结果：苏婉低声说"你走吧"。陆寒说"天亮前"。苏婉没再说话，只是把灯芯拨亮了一些。

### 章尾钩子（伏笔型+未解信息）
陆寒上楼时，听见堂下苏婉在哼一支歌——是他三年前教她的，他自己都快忘了。他停在楼梯中段，没有回头。可那支歌她只哼了前半阕就停了——剩下半阕他从未教过她，她是从哪里听来的，他不知道。

### 必须发生
- 陆寒推门进入客栈
- 苏婉认出陆寒
- 苏婉告知老周已去世
- 斗笠客人进门并引起警觉
- 斗笠客人试探陆寒的包裹
- 苏婉替陆寒解围
- 剑鞘在碰撞中露出半寸
- 苏婉劝陆寒离开，陆寒决定天亮前走
- 章尾苏婉哼歌

### 禁止事项
- 不得揭示陆寒的完整身份和来此的真实目的
- 不得让斗笠客人挑明身份或动手
- 不得揭示老周死因
- 不得让陆寒和苏婉谈论过去感情
- 不得提前揭示清查司追查的具体对象
`;

const XIANXIA_CONTEXT = `## 冻结事实

### 人物
- 陆寒：22岁，剑修，寡言，习惯用短句。三年前路过青阳县，曾在老周客栈住过半月。此次入城目的不明，随身带一把裹布长剑。
- 苏婉：17岁，老周的女儿，三年前还是扎辫子的小姑娘，如今独自经营客栈。声音沉稳，比同龄人早熟。
- 老周：苏婉的父亲，铁匠出身，去年冬天去世，死因未明。
- 斗笠客人：身份不明，腰悬清查司铜牌，言行粗鲁。

### 世界规则
- 清查司：朝廷设立，专管追查私带兵器入城的游侠和散修。持铜牌者有权盘问、搜身，但非紧急情况不得动武。
- 游侠入城需向清查司报备兵器，未报备者视为"私带"。
- 青阳县是边陲小城，秋雨季节行人稀少，客栈生意冷清。

### 时间线
- 故事发生在深秋，秋雨已下三日。
- 陆寒三年前曾在此住过半月，当时老周还在，苏婉14岁。
- 老周去年冬天去世，距今约十个月。

### 物品
- 陆寒的长剑：裹在粗布中，剑鞘半旧，剑柄磨损。
- 清查司铜牌：圆形，铜质，刻有"查"字，挂在腰间。
- 老周客栈的灯：油灯，灯芯可拨亮。

### 人物知识边界
- 陆寒知道老周已去世（苏婉告知），不知道死因。
- 苏婉知道陆寒三年前来过，不知道他现在的身份和目的。
- 斗笠客人怀疑陆寒带兵器，但没有确凿证据。
- 没有人知道陆寒三年前教过苏婉那支歌。
`;

async function callRealLLM(prompt: string, systemPrompt: string, maxTokens: number, temperature: number) {
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

async function callStructuredReview(prompt: string, _schema: Record<string, unknown>) {
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

  return await parseStreamResponse(response);
}

async function parseStreamResponse(response: Response) {
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
  return JSON.parse(candidate.trim()) as Record<string, unknown>;
}

describe("real LLM generation test", { timeout: 600_000 }, () => {
  it("generates a xianxia chapter with P0 techniques and reviews it", async () => {
    mkdirSync(OUTPUT_DIR, { recursive: true });

    // 1. 创建项目并解析 drafting 阶段 skills
    const project = await createNovelProject({
      title: "寒灯渡",
      genre: ["仙侠", "武侠"],
      premise: "一个剑修重返三年前路过的边陲客栈，在秋雨夜与故人之女重逢，却被清查司的铜牌盯上。",
    });
    const resolved = await resolveNovelSkills({ projectId: project.id, stage: "drafting" });
    const draftingSkills = resolved.skills;
    const skillPrompt = compileNovelStagePrompt(draftingSkills, "drafting");

    // 2. 构建 chapter draft prompt
    const draftPrompt = buildChapterDraftPrompt({
      targetWords: 3000,
      blueprintMarkdown: XIANXIA_BLUEPRINT,
      contextMarkdown: XIANXIA_CONTEXT,
      mustHappen: [
        "陆寒推门进入客栈",
        "苏婉认出陆寒",
        "苏婉告知老周已去世",
        "斗笠客人进门并引起警觉",
        "斗笠客人试探陆寒的包裹",
        "苏婉替陆寒解围",
        "剑鞘在碰撞中露出半寸",
        "苏婉劝陆寒离开，陆寒决定天亮前走",
      ],
      forbidden: [
        "不得揭示陆寒的完整身份和来此的真实目的",
        "不得让斗笠客人挑明身份或动手",
        "不得揭示老周死因",
        "不得让陆寒和苏婉谈论过去感情",
      ],
    });

    const fullSystemPrompt = [SYSTEM_INVARIANTS, WRITER_ROLE, skillPrompt].filter(Boolean).join("\n\n");

    writeFileSync(`${OUTPUT_DIR}/prompt-used.md`, `# System Prompt\n\n${fullSystemPrompt}\n\n# User Prompt\n\n${draftPrompt}`);

    // 3. 调用真实 LLM 生成正文
    console.log("[real-llm] 开始生成正文，目标 3000 字...");
    const generationStart = Date.now();
    const result = await callRealLLM(draftPrompt, fullSystemPrompt, 12000, 0.7);
    const generationDuration = Date.now() - generationStart;
    console.log(`[real-llm] 生成完成，耗时 ${Math.round(generationDuration / 1000)}s，输入 ${result.usage.inputTokens} tokens，输出 ${result.usage.outputTokens} tokens`);

    // 4. 保存生成的正文
    const charCount = [...result.content].length;
    console.log(`[real-llm] 正文长度：${charCount} 字符`);
    writeFileSync(`${OUTPUT_DIR}/chapter-draft.md`, result.content);
    expect(charCount).toBeGreaterThan(800);

    // 5. 独立审阅：8 维度评分
    const reviewSchema = {
      type: "object",
      additionalProperties: false,
      required: ["scores", "issues", "summary"],
      properties: {
        scores: {
          type: "object",
          additionalProperties: false,
          required: ["narrativeAppeal", "chineseAesthetic", "characterVoice", "plotContinuity", "imageryUsage", "dialogueQuality", "pacing", "chapterEndingDrive"],
          properties: {
            narrativeAppeal: { type: "number", description: "叙事吸引力 1-5" },
            chineseAesthetic: { type: "number", description: "中文美学 1-5" },
            characterVoice: { type: "number", description: "人物声音 1-5" },
            plotContinuity: { type: "number", description: "情节连续性 1-5" },
            imageryUsage: { type: "number", description: "意象运用 1-5" },
            dialogueQuality: { type: "number", description: "对白质地 1-5" },
            pacing: { type: "number", description: "节奏张弛 1-5" },
            chapterEndingDrive: { type: "number", description: "章尾驱动力 1-5" },
          },
        },
        issues: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["dimension", "severity", "description", "evidence", "suggestion"],
            properties: {
              dimension: { type: "string" },
              severity: { type: "string", enum: ["blocker", "major", "minor"] },
              description: { type: "string" },
              evidence: { type: "string", description: "引用原文证据" },
              suggestion: { type: "string", description: "具体改写建议" },
            },
          },
        },
        summary: { type: "string", description: "总体评价与改进方向" },
      },
    };

    const reviewPrompt = `请审阅以下仙侠小说章节正文，从 8 个维度评分（1-5 分）并给出具体改进点。

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

## 章节正文

${result.content}`;

    console.log("[real-llm] 开始独立审阅...");
    const reviewStart = Date.now();
    const review = await callStructuredReview(reviewPrompt, reviewSchema);
    const reviewDuration = Date.now() - reviewStart;
    console.log(`[real-llm] 审阅完成，耗时 ${Math.round(reviewDuration / 1000)}s`);

    writeFileSync(`${OUTPUT_DIR}/chapter-review.json`, JSON.stringify(review, null, 2));

    const scores = review.scores as Record<string, number>;
    const avgScore = Object.values(scores).reduce((a: number, b: number) => a + b, 0) / 8;
    const blockerCount = (review.issues as Array<{ severity: string }>).filter((i) => i.severity === "blocker").length;
    const majorCount = (review.issues as Array<{ severity: string }>).filter((i) => i.severity === "major").length;

    console.log(`[real-llm] 8 维度评分：`);
    console.log(`  叙事吸引力: ${scores.narrativeAppeal}`);
    console.log(`  中文美学: ${scores.chineseAesthetic}`);
    console.log(`  人物声音: ${scores.characterVoice}`);
    console.log(`  情节连续性: ${scores.plotContinuity}`);
    console.log(`  意象运用: ${scores.imageryUsage}`);
    console.log(`  对白质地: ${scores.dialogueQuality}`);
    console.log(`  节奏张弛: ${scores.pacing}`);
    console.log(`  章尾驱动力: ${scores.chapterEndingDrive}`);
    console.log(`  平均: ${avgScore.toFixed(2)}`);
    console.log(`  blocker: ${blockerCount}, major: ${majorCount}`);
    console.log(`  总评: ${review.summary}`);

    // 保存汇总
    const summary = {
      generatedAt: new Date().toISOString(),
      generationDurationMs: generationDuration,
      reviewDurationMs: reviewDuration,
      charCount,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      scores,
      averageScore: Number(avgScore.toFixed(2)),
      blockerCount,
      majorCount,
      baselineComparison: {
        beforeFixes: 2.75,
        afterFixes: 3.88,
        current: Number(avgScore.toFixed(2)),
      },
    };
    writeFileSync(`${OUTPUT_DIR}/generation-summary.json`, JSON.stringify(summary, null, 2));

    expect(avgScore).toBeGreaterThan(0);
  });
});
