import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { foundationSchemaForTask, validateFoundationTaskContract } from "../application/foundation-contract";
import type { FoundationOutput } from "../prompts/schemas";

const output = (structuredData: Record<string, unknown>): FoundationOutput => ({
  title: "规划",
  summary: "这是一段足够长的规划摘要，用于说明结构决策、冲突来源、人物方向和后续修订边界。",
  sections: [],
  structuredData,
});

describe("foundation task semantic contracts", () => {
  it("accepts the required structured anchors for all ten tasks", () => {
    const fixtures: Record<string, Record<string, unknown>> = {
      "project-positioning": { positioning: { bookTitle: "长夜归舟", sellingPoints: ["关系悬疑"], targetReader: "成年悬疑读者", coreConflict: "追查与自保", activePressureSource: "制度追责", corePromise: "每次揭示都改变关系", protagonistNeed: "承认失去", centralOpposition: "沉默的共同体", emotionalContract: "克制但有回响", themeQuestion: { notApplicable: true, rationale: "主题保留到故事弧中处理" } } },
      architecture: { architecture: { structure: "三卷递进", volumes: ["寻找", "对抗"], povStrategy: "限知视角", timeSpan: "两年" } },
      characters: { characters: [{ id: "p1", name: "甲", role: "主角", motivation: "查清旧案", fear: "失去最后的亲人", voiceAnchor: { sentenceLength: "短句", vocabulary: "克制", directness: "间接", avoidance: "回避承诺" }, arc: "从逃避到承担", independentAction: { desire: "保护证据", choice: "拒绝交易", cost: "失去职位" } }] },
      worldview: { worldview: { geography: "沿江城市", politics: "地方机构", factions: ["调查组"], rules: [{ statement: "证据必须付出关系代价", cost: "失去盟友", boundary: "不能凭空恢复被毁证据" }] } },
      relations: { relations: [{ from: "甲", to: "乙", type: "互相利用", strength: "脆弱", evolution: { from: "利用", to: "合作", trigger: "共同承担风险" }, choiceConsequence: "任一方退出都会失去翻案机会" }] },
      "plot-threads": { plotThreads: { main: ["查案"], subplots: ["家庭关系"] } },
      foreshadowing: { foreshadowings: [{ id: "f1", description: "旧照片缺角", expectedPayoffWindow: "第二卷末" }] },
      timeline: { timeline: { storyEvents: ["归乡", "发现照片"] } },
      "story-control": { storyControl: { paceCurve: ["缓", "紧"], payoffDistribution: ["关系回报", "真相回报"] } },
      "plot-design": { plotStrategy: { narrativePromises: ["真相改变关系"], characterDestinations: ["甲承担后果"], endingEnvelope: "开放但不否定代价", nonNegotiables: ["不抹除已付出的代价"] } },
    };
    for (const [taskKey, structuredData] of Object.entries(fixtures)) {
      expect(validateFoundationTaskContract(output(structuredData), taskKey), taskKey).toEqual([]);
    }
  });

  it("rejects a positioning artifact when the creation promise is only in prose", () => {
    const value = output({ positioning: { bookTitle: "长夜归舟", sellingPoints: ["悬疑"], targetReader: "读者", coreConflict: "追查", activePressureSource: "追责", protagonistNeed: "真相", centralOpposition: "制度", emotionalContract: "克制", themeQuestion: "真相是否值得代价" } });
    expect(validateFoundationTaskContract(value, "project-positioning")).toContain("positioning.corePromise 不能为空");
  });

  it("requires a rationale for explicit not-applicable positioning fields", () => {
    const value = output({ positioning: { bookTitle: "长夜归舟", sellingPoints: ["悬疑"], targetReader: "读者", coreConflict: "追查", activePressureSource: "追责", corePromise: "真相会改变关系", protagonistNeed: "真相", centralOpposition: "制度", emotionalContract: { notApplicable: true }, themeQuestion: { notApplicable: true, rationale: "保留为空" } } });
    expect(validateFoundationTaskContract(value, "project-positioning")).toContain("positioning.emotionalContract 的不适用标记必须包含 notApplicable=true 和 rationale");
  });

  it("rejects incomplete repeated entries instead of accepting an empty row", () => {
    const value = output({ characters: [{ id: "p1", name: "甲", role: "配角", motivation: "", fear: "", voiceAnchor: {}, arc: "", independentAction: {} }] });
    expect(validateFoundationTaskContract(value, "characters")).toEqual(expect.arrayContaining([
      "characters[0].motivation 不能为空",
      "characters[0].arc 不能为空",
    ]));
  });

  it("enforces the task data root during structured-output validation", () => {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(foundationSchemaForTask("architecture"));
    const base = { title: "架构", summary: "这是一段足够长的规划摘要，用于说明结构决策、冲突来源、人物方向、信息释放、卷级职责、视角边界、时间跨度和后续修订边界。", sections: [] };
    expect(validate({ ...base, structuredData: { structure: "三卷递进", volumes: ["寻找"], povStrategy: "限知", timeSpan: "两年" } })).toBe(false);
    expect(validate({ ...base, structuredData: { architecture: { structure: "三卷递进", volumes: [{ name: "寻找" }], povStrategy: "限知", timeSpan: "两年" } } })).toBe(true);
  });
});
