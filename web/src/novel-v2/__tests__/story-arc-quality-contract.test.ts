import { describe, expect, it } from "vitest";
import { getApplicableChapterReviewDimensions, parseStoryArcBundle, validateChapterExecutionContract } from "../application/story-arc";

function chapter(overrides: Record<string, unknown> = {}) {
  return parseStoryArcBundle({
    arc: { title: "弧", objective: "推进关系", entryState: "戒备", centralConflict: "证据与信任", development: ["试探"], resolution: "暂时合作", exitState: "保留疑虑", plotThreadRefs: [], foreshadowingRefs: [], expectedChapterCount: 1, phases: [] },
    batch: { batchIndex: 1, startChapterIndex: 1, complete: false },
    chapters: [{ index: 1, title: "夜行", summary: "两人交换条件", chapterPurpose: "关系推进", narrativeFunction: "relationship", readerExperience: "感到双方都在试探", stateTransition: { before: "互疑", after: "暂时同行", evidence: "一方交出光源" }, thematicTreatment: { mode: "absent", questionRefs: [], carrier: "none", evidenceChange: "", expositionBoundary: "" }, worldRuleRefs: ["rule:light"], characterFocus: [{ characterRef: "乙", function: "制造选择", desire: "取得证据", action: "提出交换", cost: "暴露立场" }], romanceTreatment: { status: "not-applicable", stage: "", actionEvidence: "", boundary: "本章不涉及感情线" }, humorTreatment: { status: "background", opportunity: "双方对工具的误会", evidence: "乙把严肃提醒说成了讽刺", boundary: "不打断危险推进" }, dramaticQuestion: "是否同行", emotionalMovement: "戒备到试探", stateDeltaBudget: "只改变信任一层", optionalBeats: [], scenes: [{ title: "楼梯", summary: "交换光源", participants: ["甲", "乙"], goal: "取得出口", opposition: "乙要求证据", turn: "甲交出光源", outcome: "暂时同行", cost: "甲暴露底牌", participantStakes: [{ participant: "甲", want: "取得出口", leverage: "光源", withholding: "副本", failureCost: "被拦截", knowledgeBasis: { want: "planned", leverage: "planned", withholding: "planned", failureCost: "planned" } }, { participant: "乙", want: "取得证据", leverage: "出口", withholding: "", failureCost: "失去机会", knowledgeBasis: { want: "planned", leverage: "planned", withholding: "unknown", failureCost: "planned" } }] }], continuityConstraints: [], setupRefs: [], payoffRefs: [], unresolvedAtClose: ["乙的来路"], closingForce: "门外响起脚步", freedom: "允许安静余波", ...overrides }],
  }).chapters[0];
}

describe("story arc quality fields", () => {
  it("gives legacy chapter plans explicit non-applicable defaults", () => {
    const parsed = parseStoryArcBundle({ arc: { title: "旧弧", objective: "旧目的" }, batch: {}, chapters: [{ index: 1, title: "旧章", summary: "旧计划", chapterPurpose: "推进", scenes: [] }] });
    expect(parsed.chapters[0].worldRuleRefs).toEqual([]);
    expect(parsed.chapters[0].romanceTreatment.status).toBe("not-applicable");
    expect(parsed.chapters[0].humorTreatment.status).toBe("not-applicable");
  });

  it("accepts independent character action and applicable treatment evidence", () => {
    expect(() => validateChapterExecutionContract(chapter())).not.toThrow();
  });

  it("derives review coverage from chapter applicability instead of forcing every dimension", () => {
    const dimensions = getApplicableChapterReviewDimensions(chapter());
    expect(dimensions).toEqual(expect.arrayContaining(["plot", "hookPayoff", "worldbuilding", "ensemble", "humor"]));
    expect(dimensions).not.toContain("romance");
    expect(dimensions).not.toContain("subtext");
  });

  it("rejects active romance without behavioral evidence", () => {
    expect(() => validateChapterExecutionContract(chapter({ romanceTreatment: { status: "active", stage: "试探", actionEvidence: "", boundary: "不提前宣布关系结论" } }))).toThrow("active 感情线必须包含阶段和行动证据");
  });

  it("requires an applicability boundary even when a dimension is not active", () => {
    expect(() => validateChapterExecutionContract(chapter({ humorTreatment: { status: "not-applicable", opportunity: "", evidence: "", boundary: "" } }))).toThrow("幽默适用性必须包含边界");
  });
});
