import { describe, expect, it } from "vitest";
import { buildRevisionBrief, buildRevisionDirection } from "../application/revision-brief";
import type { Review } from "../protocol";

function review(role: string, issues: Review["issues"]): Review {
  return { id: `review-${role}`, projectId: "p", artifactId: "draft", reviewerId: role, role, identity: "independent", verdict: "revise", issues, createdAt: 1, artifactFingerprint: "draft-fingerprint" };
}

describe("revision brief", () => {
  it("keeps an author instruction independent from directed review issues", () => {
    expect(buildRevisionDirection({ authorInstruction: "  保持限制视角并重做章尾压力。  " })).toEqual({
      directedIssues: undefined,
      authorInstruction: "保持限制视角并重做章尾压力。",
      strictRevisionWindows: false,
    });
  });

  it("keeps scene-local structural findings bounded and escalates cross-scene findings", () => {
    expect(buildRevisionDirection({ directedIssues: [{
      severity: "major",
      title: "来客在当前场景只是线索工具",
      dimension: "ensemble",
      evidence: "来客留下物件后离开",
      revisionRanges: [{ start: 8, end: 15 }],
    }] }).strictRevisionWindows).toBe(true);
    expect(buildRevisionDirection({ directedIssues: [{
      severity: "major",
      title: "关系变化在多个场景都缺少过程",
      dimension: "romance",
      evidence: "开场疏离，章尾突然确认关系",
      revisionRanges: [{ start: 3, end: 6 }, { start: 28, end: 32 }],
    }] }).strictRevisionWindows).toBe(false);
    expect(buildRevisionDirection({ directedIssues: [{
      severity: "major",
      title: "关键过程完全缺失，无法安全定位",
      dimension: "narrativePacing",
      evidence: "正文从准备直接跳到结果",
      revisionRanges: [],
    }] }).strictRevisionWindows).toBe(false);
    expect(buildRevisionDirection({ directedIssues: [{
      severity: "warning",
      title: "单句重复",
      dimension: "specificity",
      evidence: "同一动作重复一次",
      revisionRanges: [{ start: 12, end: 12 }],
    }] }).strictRevisionWindows).toBe(true);
  });

  it("allows strict revision windows even when an author instruction is present", () => {
    expect(buildRevisionDirection({
      authorInstruction: "保持限制视角并重做章尾压力",
      directedIssues: [{
        severity: "major",
        title: "来客在当前场景只是线索工具",
        dimension: "ensemble",
        evidence: "来客留下物件后离开",
        revisionRanges: [{ start: 8, end: 15 }],
      }],
    }).strictRevisionWindows).toBe(true);
  });

  it("consolidates duplicate reviewer evidence into one actionable problem family", () => {
    const result = buildRevisionBrief([
      review("reader", [{ severity: "major", title: "访客沦为工具人", evidence: "访客只负责递交线索", revisionRanges: [{ start: 8, end: 12 }], rule: "character-agency", suggestion: "让访客以自己的目标选择说与不说" }]),
      review("character", [{ severity: "major", title: "来客缺少自主诉求", evidence: "访客只负责递交线索", revisionRanges: [{ start: 8, end: 12 }], rule: "character-agency", suggestion: "让来客基于自身目标控制信息释放" }]),
      review("style", [{ severity: "major", title: "配角像剧情工具", evidence: "访客只负责递交线索", revisionRanges: [{ start: 8, end: 12 }], rule: "character-agency", suggestion: "通过有取舍的行动体现其自身目的" }]),
    ]);

    expect(result.issues).toHaveLength(1);
    expect(result.clusters[0].sourceIssueFingerprints).toHaveLength(3);
    expect(result.clusters[0].sourceRoles).toEqual(["character", "reader", "style"]);
  });

  it("consolidates paraphrased mechanisms when reviewers point at overlapping evidence", () => {
    const result = buildRevisionBrief([
      review("continuity", [{ severity: "major", title: "来客心理越界", rule: "limited-pov", evidence: "访客压下轻慢，重新估量沈郁", revisionRanges: [{ start: 29, end: 29 }], suggestion: "改为沈郁能看见的停顿和记录动作" }]),
      review("style", [{ severity: "major", title: "来客反应缺少现场动作", rule: "scene-embodiment", evidence: "访客听到物理回响后重新估量沈郁", revisionRanges: [{ start: 29, end: 29 }], suggestion: "增加访客的记录、视线和追问行为" }]),
      review("character", [{ severity: "major", title: "来客像信息工具", rule: "ensemble-agency", evidence: "访客听到陌生词汇后重新估量沈郁，反应停留在内心评价", revisionRanges: [{ start: 29, end: 29 }], suggestion: "让访客依据自身标准做出外在选择" }]),
    ]);

    expect(result.issues).toHaveLength(1);
    expect(result.clusters[0].sourceRoles).toEqual(["character", "continuity", "style"]);
  });

  it("merges connected duplicate groups instead of leaving transitive reviewer findings split", () => {
    const result = buildRevisionBrief([
      review("reader", [{ severity: "major", title: "访客主要承担信息投放", rule: "reader-retention", evidence: "访客没有试探，只继续递送线索", revisionRanges: [{ start: 24, end: 29 }], suggestion: "让访客根据回应改变提问角度" }]),
      review("style", [{ severity: "major", title: "访客反应工具化", rule: "scene-embodiment", evidence: "访客的反应缺少动作，像听众", revisionRanges: [{ start: 28, end: 29 }], suggestion: "增加访客记录与审视动作" }]),
      review("character", [{ severity: "major", title: "访客缺少独立行动质地", rule: "ensemble-agency", evidence: "访客没有试探，只继续递送线索，反应也缺少动作", revisionRanges: [{ start: 29, end: 30 }], suggestion: "让访客以自身标准做出试探选择" }]),
    ]);

    expect(result.issues).toHaveLength(1);
    expect(result.clusters[0].sourceRoles).toEqual(["character", "reader", "style"]);
  });

  it("keeps materially different mechanisms separate even on the same paragraph", () => {
    const result = buildRevisionBrief([
      review("continuity", [{ severity: "major", title: "物件名称冲突", evidence: "琴身刻着断续二字", revisionRanges: [{ start: 6, end: 6 }], rule: "established-fact", suggestion: "使用已经建立的正式名称" }]),
      review("pov", [{ severity: "major", title: "越过限制视角", evidence: "琴身刻着断续二字", revisionRanges: [{ start: 6, end: 6 }], rule: "limited-pov", suggestion: "删除非视角人物的内心判断" }]),
    ]);

    expect(result.issues).toHaveLength(2);
    expect(result.conflicts).toEqual([]);
  });

  it("reports incompatible directives for the same mechanism instead of feeding both to revision", () => {
    const result = buildRevisionBrief([
      review("continuity", [{ severity: "major", title: "名称必须直接修正", evidence: "琴名断续", revisionRanges: [{ start: 6, end: 6 }], rule: "established-name", suggestion: "直接改为已建立的真名" }]),
      review("reader", [{ severity: "major", title: "名称应保持传闻", evidence: "琴名断续", revisionRanges: [{ start: 6, end: 6 }], rule: "established-name", suggestion: "保留断续作为真假未定的传闻，不要确认真名" }]),
    ]);

    expect(result.conflicts).toHaveLength(1);
    expect(result.issues).toHaveLength(0);
  });

  it("does not treat preserve and remove directives for different narrative targets as a conflict", () => {
    const result = buildRevisionBrief([
      review("continuity", [{
        severity: "major",
        title: "限知视角越界确认来客目的",
        evidence: "来客并不确定目标，所以他在撒网",
        revisionRanges: [{ start: 39, end: 40 }],
        rule: "limited-pov",
        suggestion: "保留沈郁的推理过程，但改为带有主观判断的内心反应，让读者保留对来客真实目的的疑问。",
      }]),
      review("style", [{
        severity: "major",
        title: "潜台词被显性心理活动揭示",
        evidence: "来客并不确定目标，所以他在撒网，而珠子就是诱饵",
        revisionRanges: [{ start: 38, end: 42 }],
        rule: "subtext-through-action",
        suggestion: "删除直接下定论的心理描写，改写为对珠子的物理感知和收下珠子的行动。",
      }]),
    ]);

    expect(result.conflicts).toEqual([]);
    expect(result.issues).toHaveLength(1);
  });

  it("still rejects cross-rule directives that act on the same target", () => {
    const result = buildRevisionBrief([
      review("continuity", [{
        severity: "major",
        title: "必须保留伤口证据",
        evidence: "角色手背有一道伤口",
        revisionRanges: [{ start: 18, end: 18 }],
        rule: "fact-continuity",
        suggestion: "保留手背伤口，它承接前章已经发生的受伤事实。",
      }]),
      review("style", [{
        severity: "major",
        title: "重复伤痕意象",
        evidence: "角色手背的那道伤口在灯下再次发红",
        revisionRanges: [{ start: 18, end: 18 }],
        rule: "motif-restraint",
        suggestion: "删除手背伤口，避免再次使用同一伤痕意象。",
      }]),
    ]);

    expect(result.conflicts).toHaveLength(1);
    expect(result.issues).toHaveLength(0);
  });
});
