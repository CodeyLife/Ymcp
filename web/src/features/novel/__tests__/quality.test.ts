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

  it("does not treat a shared topic as proof that a prohibited relationship occurred", () => {
    const result = runDeterministicQualityChecks({
      text: "守门人明确拒绝了请求，并当面说明自己并不信任那名陌生访客。".repeat(80),
      blueprint: { objective: "拒绝通行", locationIds: [], characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "身份不明", informationRelease: [], mustHappen: [], flexible: [], forbidden: ["不得让守门人立即完全信任陌生访客"], targetWords: 3000 },
    });

    expect(result.issues.some((item) => item.rule === "chapter-blueprint.forbidden")).toBe(false);
  });

  it("does not flag a closely worded statement that explicitly negates the prohibited action", () => {
    const result = runDeterministicQualityChecks({
      text: "守门人没有立即完全信任陌生访客，术士也拒绝获得读心能力。".repeat(80),
      blueprint: { objective: "守住边界", locationIds: [], characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "诱惑", informationRelease: [], mustHappen: [], flexible: [], forbidden: ["不得让守门人立即完全信任陌生访客", "获得读心能力"], targetWords: 3000 },
    });

    expect(result.issues.some((item) => item.rule === "chapter-blueprint.forbidden")).toBe(false);
  });

  it("detects a prohibited action when modifiers are inserted inside the same clause", () => {
    const result = runDeterministicQualityChecks({
      text: "术士在仪式后获得一种没有任何代价的读心能力。".repeat(80),
      blueprint: { objective: "完成仪式", locationIds: [], characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "能力代价", informationRelease: [], mustHappen: [], flexible: [], forbidden: ["获得读心能力"], targetWords: 3000 },
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "chapter-blueprint.forbidden", severity: "blocker" }),
    ]));
  });

  it("does not let an unrelated negation hide a later prohibited action", () => {
    const result = runDeterministicQualityChecks({
      text: "术士没有犹豫便获得了读心能力。".repeat(80),
      blueprint: { objective: "接受仪式", locationIds: [], characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "能力诱惑", informationRelease: [], mustHappen: [], flexible: [], forbidden: ["获得读心能力"], targetWords: 3000 },
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "chapter-blueprint.forbidden", severity: "blocker" }),
    ]));
  });

  it("checks every semantic clause in a composite forbidden requirement", () => {
    const result = runDeterministicQualityChecks({
      text: "决战开始后，主角最终杀死了反派。".repeat(80),
      blueprint: { objective: "结束冲突", locationIds: [], characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "决战", informationRelease: [], mustHappen: [], flexible: [], forbidden: ["在决战中，主角杀死反派"], targetWords: 3000 },
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "chapter-blueprint.forbidden", severity: "blocker" }),
    ]));
  });

  it("treats directive negation as a prohibition instead of required wording", () => {
    const result = runDeterministicQualityChecks({
      text: "主角最终死在坍塌的塔下。".repeat(100),
      blueprint: { objective: "逃离高塔", locationIds: [], characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "坍塌", informationRelease: [], mustHappen: [], flexible: [], forbidden: ["主角不能死亡"], targetWords: 3000 },
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "chapter-blueprint.forbidden", severity: "blocker" }),
    ]));
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
    deterministic.scores = { plot: 5, characterVoice: 5, sceneEmbodiment: 5, dialogue: 5, specificity: 5, hookPayoff: 5, continuity: 5, readerRetention: 5 };

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
  it("recognizes dialogue at the first character as an opening hook", () => {
    const text = `“你终于来了。”她把湿透的车票压在桌上。\n\n${"雨水沿着玻璃缓慢滑落，候车室里的人依次抬头，又各自移开目光。".repeat(45)}`;
    const result = runDeterministicQualityChecks({ text });

    expect(result.issues.some((item) => item.rule === "reader.opening-hook")).toBe(false);
  });

  it("does not infer reader fatigue from a fixed action-verb vocabulary", () => {
    const actionParagraphs = [
      "她奔过月台，鞋跟擦过积水，跃上即将合拢的车门。",
      "列车掠过桥面，她敲了敲结霜的玻璃，把信递给身旁的人。",
      "风拂起纸角，他笑了一下，将最后一行折进掌心。",
      "站台向后退去，两个人都没有立刻解释信里的名字。",
    ];
    const reflectiveParagraphs = [
      "旧城的冬季总比记忆更长，灰色屋脊把天光切成细窄的片。",
      "那些没有寄出的年月并非空白，它们沉在每一次迟疑背后。",
      "人们以为沉默等于遗忘，其实许多答案只是尚未找到说法。",
      "远处钟声越过河面，时间仍按自己的秩序向前。",
    ];

    for (const paragraphs of [actionParagraphs, reflectiveParagraphs]) {
      const result = runDeterministicQualityChecks({ text: paragraphs.join("\n\n") });
      expect(result.issues.some((item) => item.rule === "reader.fatigue-streak")).toBe(false);
    }
  });

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

  it("flags a truly closed ending and provides revision ranges so it can be auto-revised", () => {
    // 反例验证：末段没有任何开放信号（无问号、无转折、无未行动信号、无 pendingDecision），
    // 只有情感余韵的封闭画面——应被标记且带 revisionRanges 锁定末段。
    const body = "宫门次第合拢，长街上的人声渐渐近了。".repeat(40);
    const closedEnding = "月光落在空庭里，一切都安静下来，像是什么都没有发生过。";

    const result = runDeterministicQualityChecks({ text: `${body}\n\n${closedEnding}` });
    const hookIssue = result.issues.find((item) => item.rule === "style.chapter-ending-hook");

    expect(hookIssue).toBeDefined();
    expect(hookIssue?.severity).toBe("warning");
    // revisionRanges 是 collectRevisionParagraphs 定位修订窗口的必要条件；
    // 无 revisionRanges 的 issue 即使升级为 major 也只能触发人工审批而非自动修订。
    expect(hookIssue?.revisionRanges?.length).toBeGreaterThan(0);
    expect(hookIssue?.paragraph).toBeDefined();
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

  // 根因 E：旧检查被过渡词（然而/可是/忽然）欺骗——LLM 撒一个"然而"即通过钩子检查，
  // 但读者感受不到拉力。修复后只用 HOOK_TENSION_MARKERS（强张力信号）判定。
  it("flags a chapter ending that relies only on transition words without genuine tension", () => {
    const body = "宫门次第合拢，长街上的人声渐渐近了。".repeat(40);
    // 末段只有过渡词和突发词，没有任何强张力信号（无问号、无省略号、无未行动信号、无 pendingDecision）
    const weakEnding = "然而他没有说话。忽然风吹过庭院，一切归于平静。";

    const result = runDeterministicQualityChecks({ text: `${body}\n\n${weakEnding}` });

    expect(result.issues.some((item) => item.rule === "style.chapter-ending-hook")).toBe(true);
  });

  it("does not flag a chapter ending with strong tension markers", () => {
    // 根因 E 反例验证：末段包含省略号（HOOK_TENSION_MARKERS 之一），
    // 即使没有过渡词也应通过钩子检查——强信号本身构成钩子。
    const body = "宫门次第合拢，长街上的人声渐渐近了。".repeat(40);
    const strongEnding = "他看着那封没有署名的信，手指停在封口处……";

    const result = runDeterministicQualityChecks({ text: `${body}\n\n${strongEnding}` });

    expect(result.issues.some((item) => item.rule === "style.chapter-ending-hook")).toBe(false);
  });

  // 根因 F：反套路手势词被 LLM 机械套用形成新模板。
  // prose-prompts 教 LLM 用"停步/侧首"替代心理直说（正确方向），但高频重复后读者感知到的是新 AI 腔。
  it("flags gesture word repetition when a gesture exceeds 2 occurrences", () => {
    const text = [
      "他停步在门前，听见里面的争执声，没有推门。",
      "她停步看了一眼窗外，雨还没停，转身走回桌前。",
      "那人停步转身，把信递了过来，目光没有停留。",
    ].join("\n\n");

    const result = runDeterministicQualityChecks({ text });
    const gestureIssue = result.issues.find((item) => item.rule === "style.gesture-repetition");

    expect(gestureIssue).toBeDefined();
    expect(gestureIssue?.severity).toBe("warning");
    expect(gestureIssue?.description).toContain("停步");
    expect(gestureIssue?.revisionRanges?.length).toBeGreaterThan(0);
  });

  it("does not flag gesture words within the 2-occurrence threshold", () => {
    // 根因 F 反例：手势词出现 ≤2 次不算模板化，不应被标记。
    const text = [
      "他停步在门前，听见里面的争执声，没有推门。",
      "她侧首看了一眼窗外，雨还没停，转身走回桌前。",
      "那人转身把信递了过来，目光没有停留。",
    ].join("\n\n");

    const result = runDeterministicQualityChecks({ text });

    expect(result.issues.some((item) => item.rule === "style.gesture-repetition")).toBe(false);
  });
});
