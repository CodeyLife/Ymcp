import { describe, expect, it } from "vitest";
import { creativeBriefPrompt, parseCreativeBrief } from "../application/creative-brief";

describe("creative brief boundary contract", () => {
  it("normalizes an optional brief without breaking premise-only creation", () => {
    expect(parseCreativeBrief(undefined)).toBeUndefined();
    expect(parseCreativeBrief({})).toBeUndefined();
    expect(parseCreativeBrief({ targetReader: "  喜欢慢热悬疑的成年读者 ", researchNeeds: ["城市交通", ""], ignored: "drop" })).toEqual({
      version: 1,
      targetReader: "喜欢慢热悬疑的成年读者",
      researchNeeds: ["城市交通"],
    });
  });

  it("rejects a malformed structured brief at the shared boundary", () => {
    expect(() => parseCreativeBrief("not-an-object")).toThrow("creativeBrief 必须是对象");
    expect(() => parseCreativeBrief([])).toThrow("creativeBrief 必须是对象");
    expect(() => parseCreativeBrief({ version: 2 })).toThrow("creativeBrief.version");
    expect(() => parseCreativeBrief({ themeQuestion: { notApplicable: true } })).toThrow("rationale");
    expect(() => parseCreativeBrief({ targetReader: 3 })).toThrow("targetReader");
    expect(() => parseCreativeBrief({ researchNeeds: ["研究", 3] })).toThrow("researchNeeds");
    expect(() => parseCreativeBrief({ themeQuestion: 3 })).toThrow("themeQuestion");
  });

  it("preserves explicit not-applicable rationale instead of coercing it to [object Object]", () => {
    const brief = parseCreativeBrief({
      themeQuestion: { notApplicable: true, rationale: "本作不直接回答价值问题" },
      emotionalContract: { notApplicable: true, rationale: "本作不设置感情线" },
    });
    expect(brief?.themeQuestion).toEqual({ notApplicable: true, rationale: "本作不直接回答价值问题" });
    expect(creativeBriefPrompt(brief)).toContain("主题问题：不适用；理由：本作不直接回答价值问题");
  });

  it("renders a principle-oriented brief prompt without importing named author style", () => {
    const prompt = creativeBriefPrompt({ version: 1, corePromise: "每次揭示都改变人物关系", themeQuestion: "真相是否值得付出代价" });
    expect(prompt).toContain("核心叙事承诺");
    expect(prompt).toContain("主题问题");
    expect(prompt).not.toMatch(/作家|模仿|具体作品/u);
  });
});
