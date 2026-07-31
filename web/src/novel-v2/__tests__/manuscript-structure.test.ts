import { describe, expect, it } from "vitest";
import { inspectManuscript, normalizeManuscriptStructuralReview } from "../application/manuscript-structure";
import type { Review } from "../protocol";

describe("manuscript structural inspection", () => {
  it("blocks a repeated multi-paragraph sequence", () => {
    const first = "他沿着潮湿的石阶向下，每一步都先用刀鞘试探落脚处，直到墙后的机括声彻底停住。石缝里渗出的水沿着刀鞘往下淌，他等最后一滴落地，才把重量交给前脚。";
    const second = "水线退去以后，木牌背面的刻痕才显出来，他没有伸手，只把位置和方向一笔一笔记进册中。同行的人在门外催促，他仍等潮气散尽，确认刻痕没有被浮泥改过形状。";
    const text = [first, second, "他们绕过倒塌的门楼。", first, second].join("\n\n");
    const report = inspectManuscript({ text });
    expect(report.passed).toBe(false);
    expect(report.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "manuscript.repeated-block" })]));
  });

  it("allows short dialogue refrains and reports fragmentation without blocking", () => {
    const paragraphs = Array.from({ length: 110 }, (_, index) => index % 10 === 0 ? "“还去吗？”" : `“第${index}步。”`);
    const report = inspectManuscript({ text: paragraphs.join("\n\n") });
    expect(report.passed).toBe(true);
    expect(report.blockers).toHaveLength(0);
    expect(report.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "manuscript.fragmentation" })]));
  });

  it("does not impose any chapter length rule", () => {
    expect(inspectManuscript({ text: "灯下有人翻完一页旧案。" }).passed).toBe(true);
    expect(inspectManuscript({ text: "他们继续向前。".repeat(20_000) }).passed).toBe(true);
  });

  it("retires persisted chapter length blockers", () => {
    const review: Review = {
      id: "legacy-length-review",
      projectId: "p1",
      artifactId: "a1",
      reviewerId: "deterministic-manuscript-inspector",
      identity: "internal",
      role: "structural-validator",
      verdict: "blocked",
      issues: [{ severity: "blocker", title: "正文长度偏离章节约束", evidence: "有效字符 2706，约束 8000-12000", rule: "manuscript.length" }],
      artifactFingerprint: "fp1",
      createdAt: 1,
    };

    expect(normalizeManuscriptStructuralReview(review)).toMatchObject({ verdict: "passed", issues: [] });
  });

  it("blocks model-limit truncation and output wrappers", () => {
    expect(inspectManuscript({ text: "```\n正文\n```" }).passed).toBe(false);
    expect(inspectManuscript({ text: "真正的正文", stopReason: "max_tokens" }).blockers).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "manuscript.truncated" })]));
  });
});
