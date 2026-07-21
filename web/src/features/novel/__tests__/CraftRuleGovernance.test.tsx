import { renderToStaticMarkup } from "react-dom/server";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useLiveQueryMock, gateMock } = vi.hoisted(() => ({
  useLiveQueryMock: vi.fn(),
  gateMock: vi.fn(),
}));

vi.mock("dexie-react-hooks", () => ({ useLiveQuery: useLiveQueryMock }));
vi.mock("../db", () => ({ novelDb: {} }));
vi.mock("../skills", () => ({ listAvailableSkills: vi.fn() }));
vi.mock("../prompt-templates", () => ({ listPromptTemplates: vi.fn() }));
vi.mock("../craft-rule-evolution", () => ({
  createCraftRuleCandidate: vi.fn(),
  evaluateCraftRuleGate: gateMock,
  evaluateCraftRuleOnFoundation: vi.fn(),
  evaluateCraftRuleOnChapter: vi.fn(),
  FOUNDATION_EVALUATION_TASKS: ["project-positioning", "architecture"],
  promoteCraftRuleCandidate: vi.fn(),
  rollbackCraftRuleCandidate: vi.fn(),
  submitCraftRuleReview: vi.fn(),
  supportsChapterRuleEvaluation: (stages: string[]) => stages.some((stage) => stage !== "foundation"),
}));

import CraftRuleGovernance from "../CraftRuleGovernance";
import type { CraftRuleCandidate } from "../types";

function render() {
  return renderToStaticMarkup(<ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}><App><CraftRuleGovernance projectId="project-1" /></App></ConfigProvider>);
}

describe("CraftRuleGovernance", () => {
  beforeEach(() => {
    useLiveQueryMock.mockReset();
    gateMock.mockReset();
  });

  it("renders the manual governance entry when no candidates exist", () => {
    useLiveQueryMock.mockReturnValueOnce([]).mockReturnValueOnce([]).mockReturnValueOnce([]).mockReturnValueOnce([]);
    const html = render();
    expect(html).toContain("规则候选");
    expect(html).toContain("新建候选");
    expect(html).toContain("暂无规则候选");
  });

  it("shows cross-scenario and multi-review gate progress", () => {
    const candidate = {
      id: "candidate-1", projectId: "project-1", schemaVersion: 8, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test",
      targetKind: "skill", targetId: "embodied-prose", beforeVersion: "2.0.0", proposedVersion: "2.0.1", beforeText: "before", afterText: "after", rationale: "跨题材人物选择机制", scope: {}, status: "evaluating",
      evidenceCases: [{ caseId: "case-1" }], reviews: [{ role: "plot-editor", verdict: "passed" }, { role: "character-editor", verdict: "passed" }],
    } as unknown as CraftRuleCandidate;
    useLiveQueryMock.mockReturnValueOnce([candidate]).mockReturnValueOnce([]).mockReturnValueOnce([]).mockReturnValueOnce([]);
    gateMock.mockReturnValue({ ready: false, reasons: ["缺少跨场景证据"], averageScoreDelta: 0.12, latestReviews: { "plot-editor": candidate.reviews[0], "character-editor": candidate.reviews[1] } });
    const html = render();
    expect(html).toContain("embodied-prose");
    expect(html).toContain("2.0.0 → 2.0.1");
    expect(html).toContain("1/3 场景");
    expect(html).toContain("2/4 审核");
    expect(html).toContain("+0.12");
  });
});
