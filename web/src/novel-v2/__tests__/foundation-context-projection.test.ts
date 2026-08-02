import { describe, expect, it } from "vitest";
import { buildFoundationContextMarkdown } from "../prompts/chapter-draft";
import type { Artifact } from "../protocol";

function foundationArtifact(taskKey: string, structuredData: Record<string, unknown>): Artifact {
  return {
    id: "artifact-characters",
    projectId: "project-1",
    taskId: "task-characters",
    attemptId: "attempt-1",
    kind: "foundation",
    contentHash: "hash-1",
    objectKey: "object-1",
    structuredData: { taskKey, ...structuredData },
    baseRevision: 0,
    createdAt: 1,
    fingerprint: "fingerprint-1",
  };
}

describe("foundation context projection", () => {
  it("preserves character voice anchors and independent action contracts", () => {
    const markdown = buildFoundationContextMarkdown([
      foundationArtifact("characters", {
        characters: [{
          id: "p1",
          name: "甲",
          role: "配角",
          motivation: "守住证据",
          voiceAnchor: { sentenceLength: "短句", vocabulary: "克制", directness: "间接", avoidance: "回避承诺" },
          independentAction: { desire: "保护证据", choice: "拒绝交易", cost: "失去职位" },
        }],
      }),
    ]);

    expect(markdown).toContain("声部锚点：sentenceLength=短句；vocabulary=克制；directness=间接；avoidance=回避承诺");
    expect(markdown).toContain("独立行动：desire=保护证据；choice=拒绝交易；cost=失去职位");
  });

  it("projects versioned creative brief research anchors into chapter context", () => {
    const markdown = buildFoundationContextMarkdown([
      foundationArtifact("project-positioning", {
        positioning: {
          targetReader: { segment: "持续追更的悬疑读者", expectation: "关系与选择持续变化" },
          corePromise: "每次选择都改变关系",
          themeQuestion: { notApplicable: true, rationale: "本作只处理具体处境，不直接提出抽象命题" },
          protagonistContradiction: "想保护他人却害怕承担代价",
          emotionalContract: { notApplicable: true, rationale: "本作不设置独立恋爱线" },
        },
        creativeBrief: {
          worldAnchor: "港口城市的旧工业区",
          researchNeeds: ["港口调度", "工会制度"],
          nonNegotiables: ["不可把研究事实写成百科段落"],
          endingEnvelope: "结局保留关系代价",
        },
      }),
    ]);

    expect(markdown).toContain("研究世界锚点：港口城市的旧工业区");
    expect(markdown).toContain("研究需求：港口调度、工会制度");
    expect(markdown).toContain("简报不可违背项：不可把研究事实写成百科段落");
    expect(markdown).toContain("结局边界：结局保留关系代价");
    expect(markdown).toContain('目标读者：{"segment":"持续追更的悬疑读者","expectation":"关系与选择持续变化"}');
    expect(markdown).toContain("主题问题：不适用；理由：本作只处理具体处境，不直接提出抽象命题");
    expect(markdown).toContain("情感契约：不适用；理由：本作不设置独立恋爱线");
  });
});
