import { describe, expect, it } from "vitest";
import { aggregateQuality, countNovelWords, qualityDimensionLabel, runDeterministicQualityChecks } from "../quality";

describe("novel quality gates", () => {
  it("counts Chinese characters and alphanumeric words with the production metric", () => {
    expect(countNovelWords("归乡 route 2026。" )).toBe(4);
  });
  it("creates blockers for forbidden content but not for missing mandatory beats", () => {
    const result = runDeterministicQualityChecks({
      text: "主角忽然获得无代价的读心能力。\n\n他立刻离开现场。",
      blueprint: { objective: "发现线索", locationIds: [], characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "追查", informationRelease: [], mustHappen: ["主角发现染血账本"], flexible: [], forbidden: ["获得读心能力"], targetWords: 3000 },
    });
    // mustHappen 确定性检查已移除（containsMeaning bigram 匹配对文学化措辞误报率过高）
    // forbidden 仍为 blocker
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "chapter-blueprint.forbidden", severity: "blocker" }),
      expect.objectContaining({ rule: "chapter.minimum-length", severity: "blocker" }),
    ]));
    expect(result.issues.some((item) => item.rule === "chapter-blueprint.mustHappen")).toBe(false);
  });

  it("does not run deterministic mustHappen checks (LLM plot-reviewer is authoritative)", () => {
    const result = runDeterministicQualityChecks({
      text: "阿落望向师父，玉佩仍藏在她的袖中。两人没有交谈，随后各自离开。",
      blueprint: { objective: "交出信物", locationIds: [], characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "是否信任", informationRelease: [], mustHappen: ["阿落取出玉佩交给师父"], flexible: [], forbidden: [], targetWords: 3000 },
    });

    expect(result.issues.some((item) => item.rule === "chapter-blueprint.mustHappen")).toBe(false);
  });

  it("treats template expression density as a warning, not a blocker", () => {
    const text = Array.from({ length: 5 }, () => "他眼中闪过一丝迟疑，嘴角微微上扬。随后他看向门外。 ").join("\n\n");
    const result = runDeterministicQualityChecks({ text });
    expect(result.issues.some((item) => item.rule === "style.template-density" && item.severity === "warning")).toBe(true);
    expect(result.issues.some((item) => item.rule === "style.template-density" && item.severity === "blocker")).toBe(false);
  });

  it("requires no blockers, a dimension floor and the weighted threshold", () => {
    const deterministic = runDeterministicQualityChecks({ text: Array.from({ length: 80 }, (_, index) => `第${index + 1}次潮声漫过石阶，船工换了一种绳结，岸边等船的人也各自挪开半步。`).join("") });
    const passed = aggregateQuality({ deterministic, threshold: 3.7 });
    expect(passed.passed).toBe(true);
    const failed = aggregateQuality({ deterministic, threshold: 4.8 });
    expect(failed.passed).toBe(false);
  });

  it("keeps the weighted quality scale normalized to five", () => {
    const deterministic = runDeterministicQualityChecks({ text: "船工收紧缆绳，岸边众人依次登船。".repeat(100) });
    deterministic.issues = [];
    deterministic.scores = { plot: 5, characterVoice: 5, sceneEmbodiment: 5, dialogue: 5, specificity: 5, hookPayoff: 5, continuity: 5 };

    const result = aggregateQuality({ deterministic, threshold: 5 });

    expect(result.weightedScore).toBe(5);
    expect(result.passed).toBe(true);
  });

  it("keeps a label for pacing scores stored by older reports", () => {
    expect(qualityDimensionLabel("pacing")).toBe("节奏");
  });

  it("uses 1000 words as the only hard length floor and keeps the target as a metric", () => {
    const deterministic = runDeterministicQualityChecks({
      text: "细雨落在河面，沈砚秋低头写完一张路引。".repeat(50),
      blueprint: { objective: "建立水乡日常", locationIds: [], characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "守住生活", informationRelease: [], mustHappen: [], flexible: [], forbidden: [], targetWords: 5000 },
    });

    expect(deterministic.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "chapter.minimum-length", severity: "blocker" }),
    ]));
    expect(aggregateQuality({ deterministic, threshold: 3.7 }).passed).toBe(false);
    const longEnough = runDeterministicQualityChecks({
      text: "船工收紧缆绳，沈砚秋沿着湿石阶走回铺子。".repeat(90),
      blueprint: { objective: "回到铺子", locationIds: [], characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "压下疑问", informationRelease: [], mustHappen: [], flexible: [], forbidden: [], targetWords: 5000 },
    });
    expect(longEnough.metrics.targetRatio).toBeLessThan(0.8);
    expect(longEnough.issues.some((item) => item.rule === "chapter.minimum-length")).toBe(false);
    expect(longEnough.issues.some((item) => item.rule === "chapter.target-length")).toBe(false);
  });

  it("does not claim a complete quality pass when a reviewer is unavailable", () => {
    const deterministic = runDeterministicQualityChecks({ text: "足够具体的场景正文。".repeat(150) });
    const result = aggregateQuality({
      deterministic,
      threshold: 3.7,
      reviewers: [{
        role: "style-reviewer",
        scores: {},
        issues: [{ dimension: "specificity", severity: "warning", title: "style-reviewer 审校不可用", description: "调用超时", rule: "reviewer.unavailable", suggestion: "重试或人工审阅" }],
      }],
    });

    expect(result.weightedScore).toBeGreaterThanOrEqual(3.7);
    expect(result.passed).toBe(false);
  });

  it("promotes reviewer POV boundary warnings and blocks every major issue", () => {
    const deterministic = runDeterministicQualityChecks({ text: "渡口的人依次收船，少年站在雨里听他们说话。".repeat(100) });
    const result = aggregateQuality({
      deterministic,
      threshold: 3.7,
      reviewers: [{
        role: "continuity-reviewer",
        scores: { continuity: 4.5 },
        issues: [{ dimension: "continuity", severity: "warning", title: "叙述超出少年感知范围", description: "正文写了少年没有看见的沈砚秋内心。", rule: "pov.boundary", suggestion: "删除越界内容" }],
      }],
    });

    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "pov.boundary", severity: "major" })]));
    expect(result.passed).toBe(false);
  });

  it("promotes direct explanations of another character's psychology to major", () => {
    const deterministic = runDeterministicQualityChecks({ text: "少年看见罗渡停下手里的活，朝旧木桩望了一眼。".repeat(80) });
    const result = aggregateQuality({
      deterministic,
      threshold: 3.7,
      reviewers: [{
        role: "style-reviewer",
        scores: { plot: 4, characterVoice: 4, sceneEmbodiment: 4, dialogue: 4, specificity: 4, hookPayoff: 4, continuity: 4 },
        issues: [{ dimension: "continuity", severity: "warning", title: "视角中出现直接心理解释", description: "直接解释罗渡的心理判断，削弱当前第三人称限知。", rule: "review.pov-psychology", suggestion: "只保留可观察动作。" }],
      }],
    });
    expect(result.issues.find((item) => item.rule === "review.pov-psychology")?.severity).toBe("major");
    expect(result.passed).toBe(false);
  });

  it("does not promote a conditional POV interpretation when the quoted evidence is only observable action", () => {
    const deterministic = runDeterministicQualityChecks({ text: "内侍停住声音，将头低下。".repeat(100) });
    const result = aggregateQuality({
      deterministic,
      threshold: 3.7,
      reviewers: [{
        role: "continuity-reviewer",
        scores: { continuity: 4 },
        issues: [{
          dimension: "continuity",
          severity: "major",
          title: "可能确认了他人意图",
          description: "若进一步理解为双方刻意隐瞒，则属于替视角人物确认他人心理。",
          excerpt: "旁边的内侍停住了声音，将头低下。",
          rule: "pov.conditional-interpretation",
          suggestion: "只保留可观察动作。",
        }],
      }],
    });

    expect(result.issues.find((item) => item.rule === "pov.conditional-interpretation")?.severity).toBe("warning");
  });

  it("preserves all revision ranges when duplicate reviewer issues are merged", () => {
    const deterministic = runDeterministicQualityChecks({ text: "足够具体的场景正文。".repeat(80) });
    const baseIssue = {
      dimension: "plot" as const,
      severity: "major" as const,
      title: "后半章推进重复",
      description: "后半章出现第二套推进。",
      rule: "plot.repeated-progression",
      suggestion: "删除重复事件。",
    };
    const result = aggregateQuality({
      deterministic,
      threshold: 3.7,
      reviewers: [
        { role: "plot-reviewer", scores: { plot: 2 }, issues: [{ ...baseIssue, revisionRanges: [{ start: 291, end: 293 }] }] },
        { role: "style-reviewer", scores: { specificity: 2 }, issues: [{ ...baseIssue, revisionRanges: [{ start: 294, end: 296 }] }] },
      ],
    });

    expect(result.issues.find((item) => item.rule === baseIssue.rule)?.revisionRanges).toEqual([
      { start: 291, end: 293 },
      { start: 294, end: 296 },
    ]);
  });

  it("does not pass a chapter while a structural major issue remains", () => {
    const distinct = Array.from({ length: 5 }, (_, index) => `第${index + 1}队商旅越过山口，领队逐一核对车轮和水囊。天色转暗后，他们在背风处扎营并安排守夜。营火升起时，伙计开始清点沿途损耗。`);
    const repeated = "第一队商旅越过山口，领队逐一核对车轮和水囊。天色转暗后，他们在背风处扎营并安排守夜。营火升起时，伙计开始清点沿途损耗。";
    const deterministic = runDeterministicQualityChecks({ text: [repeated, ...distinct, repeated].join("\n\n") });

    const result = aggregateQuality({ deterministic, threshold: 3.7 });

    expect(deterministic.issues.some((item) => item.rule === "plot.exact-paragraph-repeat")).toBe(true);
    expect(result.passed).toBe(false);
  });
});

describe("prose discipline checks", () => {
  it("recognizes a pending decision across the final scene instead of judging only the last image", () => {
    const body = "宫门次第合拢，长街上的人声渐渐近了。".repeat(40);
    const ending = [
      "来人问他可愿赴约，他看着帖子，没有伸手。",
      "那人仍站在原地，等着他的回话。",
      "从前回去只有一条熟路，如今前方多了一盏还未喝下的茶。",
    ].join("\n\n");

    const result = runDeterministicQualityChecks({ text: `${body}\n\n${ending}` });

    expect(result.issues.some((item) => item.rule === "style.chapter-ending-hook")).toBe(false);
  });

  it("promotes draft structure violations into deterministic quality issues", () => {
    const text = ["风停了。", "他抬起头。", "远处有人走来。", "脚步越来越近。"].join("\n\n");

    const result = runDeterministicQualityChecks({ text });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: "style.fragmented-paragraphs",
        severity: "major",
        dimension: "specificity",
        revisionRanges: [{ start: 1, end: 4 }],
      }),
    ]));
  });

  it("flags emphasis word devaluation when a word exceeds 2 occurrences", () => {
    const text = "他第一次意识到危险。\n\n第一次，他选择了沉默。\n\n这是他第一次真正感到恐惧。";
    const result = runDeterministicQualityChecks({ text });
    expect(result.issues.some((item) => item.rule === "style.emphasis-devaluation" && item.description.includes("第一次"))).toBe(true);
  });

  it("flags direct emotion declarations", () => {
    const text = "他站在原地，他很悲伤，没有说话。\n\n风继续吹着。";
    const result = runDeterministicQualityChecks({ text });
    expect(result.issues.some((item) => item.rule === "style.emotion-direct" && item.excerpt?.includes("他很悲伤"))).toBe(true);
  });

  it("flags excessive short-sentence streaks beyond 2 occurrences", () => {
    const text = "速度。力量。变化。\n\n停下。风停。灯灭。\n\n关门。锁门。走人。";
    const result = runDeterministicQualityChecks({ text });
    expect(result.issues.some((item) => item.rule === "style.short-sentence-tic")).toBe(true);
  });

  it("keeps short-sentence streaks continuous across paragraph boundaries", () => {
    const text = ["风停。", "灯灭。", "门响。", "人来。", "刀出。", "血落。", "雨落。", "车停。", "马嘶。", "他终于向后退了一步。"].join("\n\n");

    const result = runDeterministicQualityChecks({ text });

    const issue = result.issues.find((item) => item.rule === "style.short-sentence-tic");
    expect(issue?.revisionRanges).toEqual([
      { start: 1, end: 3 },
      { start: 4, end: 6 },
      { start: 7, end: 9 },
    ]);
  });

  it("does not count dialogue-only paragraphs as short-sentence tic streaks", () => {
    const dialogue = ["“走。”", "“等等。”", "“快点。”", "“有人。”", "“在哪？”", "“门外。”", "“别动。”", "“听着。”", "“来了。”"];
    const text = [...dialogue, "门外的脚步声越过长廊，最后停在半掩的木门前。屋里的人都握紧武器，没有继续交谈。"].join("\n\n");

    const result = runDeterministicQualityChecks({ text });

    expect(result.issues.some((item) => item.rule === "style.short-sentence-tic")).toBe(false);
  });

  it("merges reviewer issues in the same dimension when their edit ranges overlap", () => {
    const deterministic = runDeterministicQualityChecks({ text: "工程师收好扳手，沿检修梯返回气闸。".repeat(100) });
    const result = aggregateQuality({
      deterministic,
      threshold: 3.7,
      reviewers: [
        {
          role: "plot-reviewer",
          scores: { hookPayoff: 3 },
          issues: [{ dimension: "hookPayoff", severity: "major", title: "章尾选择压力不足", description: "章尾没有形成后续压力。", rule: "review.hook-pressure", suggestion: "补足后果。", revisionRanges: [{ start: 100, end: 102 }] }],
        },
        {
          role: "character-reviewer",
          scores: { hookPayoff: 3 },
          issues: [{ dimension: "hookPayoff", severity: "major", title: "人物状态转折未落地", description: "最后动作没有改变人物处境。", rule: "review.character-turn", suggestion: "落实状态变化。", revisionRanges: [{ start: 101, end: 102 }] }],
        },
      ],
    });

    expect(result.issues.filter((item) => item.dimension === "hookPayoff" && !item.deterministic)).toHaveLength(1);
    expect(result.issues.find((item) => item.dimension === "hookPayoff" && !item.deterministic)?.revisionRanges).toEqual([
      { start: 100, end: 102 },
      { start: 101, end: 102 },
    ]);
  });

  it("does not count short dialogue with speaker tags as narrative staccato", () => {
    const dialogue = [
      "“开门。”值班员说。",
      "“证件。”林澈递过去。",
      "“进去吧。”对方让开。",
      "“等等。”林澈停下。",
      "“怎么？”值班员抬头。",
      "“警报响了。”林澈回身。",
    ];

    const result = runDeterministicQualityChecks({ text: dialogue.join("\n\n") });

    expect(result.issues.some((item) => item.rule === "style.short-sentence-tic")).toBe(false);
  });

  it("flags aphorism density when exceeding 3 endings", () => {
    const text = "所谓成长不过是学会沉默。\n\n也许离别就是人生的常态。\n\n这便是命运。\n\n或许遗忘才是最终的答案。";
    const result = runDeterministicQualityChecks({ text });
    expect(result.issues.some((item) => item.rule === "style.aphorism-density")).toBe(true);
  });

  it("counts imagery density in metrics", () => {
    const text = "风吹过雪地，月光照在剑上，灯火摇曳。";
    const result = runDeterministicQualityChecks({ text });
    expect(result.metrics.imageryDensity).toBeGreaterThan(0);
  });

  it("flags sustained interpretive summaries that explain meaning for the reader", () => {
    const text = Array.from({ length: 16 }, (_, index) => index % 2 === 0
      ? `他把第${index + 1}枚钥匙藏回袖中，没有看桌对面的人。他自己也清楚，这意味着两个人之间又多了一道门。`
      : `她收起第${index + 1}块没有修好的表，站到门边。她终于意识到，这说明他仍旧想替所有人作决定。`
    ).join("\n\n");

    const result = runDeterministicQualityChecks({ text });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "style.interpretive-summary-density", dimension: "specificity" }),
    ]));
    expect(result.metrics.interpretiveSummaryHits).toBeGreaterThanOrEqual(4);
  });

  it("does not flag concrete action and subtext without explanatory conclusions", () => {
    const text = Array.from({ length: 8 }, () => "他把钥匙藏回袖中，右手仍压着柜沿。她把旧表推回去，只说修好之前不会来取。").join("\n\n");

    const result = runDeterministicQualityChecks({ text });

    expect(result.issues.some((item) => item.rule === "style.interpretive-summary-density")).toBe(false);
    expect(result.metrics.interpretiveSummaryHits).toBe(0);
  });

  it("detects scene-summary tails for character names outside known fixtures", () => {
    const text = "林澈推开舱门，把损坏的呼吸阀递给工程师。此刻这些都已落在他的肩上。";

    const result = runDeterministicQualityChecks({ text });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "style.scene-summary-tail", revisionRanges: [{ start: 1, end: 1 }] }),
    ]));
  });
});
