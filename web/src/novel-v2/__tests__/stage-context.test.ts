import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { compileStageContext, createStageGoalContract, StageContextBudgetError } from "../stage-context";

function productionTypeScriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : productionTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("stage context compiler", () => {
  it("deduplicates repeated artifacts and content before filling the budget", () => {
    const result = compileStageContext({
      projectId: "p1",
      workflowId: "wf1",
      purpose: "review.plot",
      stage: "review",
      maxInputTokens: 2_000,
      reservedOutputTokens: 200,
      sections: [
        { id: "goal", kind: "goal", title: "目标", text: "保留人物克制感", priority: "critical", provenanceRefs: ["goal:1"] },
        { id: "foundation", kind: "planning", title: "设定", text: "城市处于停电状态", priority: "required", provenanceRefs: ["artifact:a"], sourceArtifactId: "a" },
        { id: "foundation-memory", kind: "fact", title: "设定投影", text: "重复但文字不同", priority: "normal", provenanceRefs: ["claim:1"], sourceArtifactId: "a" },
        { id: "duplicate", kind: "background", title: "重复文本", text: "城市处于停电状态", priority: "soft", provenanceRefs: ["claim:2"] },
      ],
    }, 1);

    expect(result.instruction).toContain("保留人物克制感");
    expect(result.instruction).toContain("城市处于停电状态");
    expect(result.instruction).not.toContain("重复但文字不同");
    expect(result.manifest.sections.find((item) => item.id === "foundation-memory")?.reason).toBe("duplicate-source");
    expect(result.manifest.sections.find((item) => item.id === "duplicate")?.reason).toBe("duplicate-content");
  });

  it("drops soft context but fails explicitly when required context cannot fit", () => {
    const soft = compileStageContext({
      projectId: "p1", workflowId: "wf1", purpose: "writing.draft", stage: "drafting",
      maxInputTokens: 120, reservedOutputTokens: 20,
      sections: [
        { id: "required", kind: "manuscript", title: "正文", text: "正文".repeat(20), priority: "required", provenanceRefs: [] },
        { id: "soft", kind: "background", title: "背景", text: "背景".repeat(100), priority: "soft", provenanceRefs: [] },
      ],
    });
    expect(soft.manifest.sections.find((item) => item.id === "soft")?.reason).toBe("budget");

    expect(() => compileStageContext({
      projectId: "p1", workflowId: "wf2", purpose: "writing.draft", stage: "drafting",
      maxInputTokens: 20, reservedOutputTokens: 10,
      sections: [{ id: "required", kind: "manuscript", title: "正文", text: "正文".repeat(100), priority: "required", provenanceRefs: [] }],
    })).toThrow(StageContextBudgetError);
  });

  it("records upstream memory exclusions without injecting placeholder sections", () => {
    const result = compileStageContext({
      projectId: "p1", workflowId: "wf-memory", purpose: "writing.draft", stage: "drafting",
      maxInputTokens: 1_000, reservedOutputTokens: 100,
      sections: [
        { id: "active", kind: "fact", title: "有效事实", text: "角色仍在站台", priority: "required", provenanceRefs: ["r1"] },
        { id: "inactive", kind: "fact", title: "失活事实", text: "", priority: "soft", provenanceRefs: ["r0"], exclusionReason: "inactive" },
        { id: "merged", kind: "fact", title: "同值来源", text: "", priority: "soft", provenanceRefs: ["r2"], exclusionReason: "merged-source" },
      ],
    });

    expect(result.instruction).toContain("角色仍在站台");
    expect(result.instruction).not.toContain("失活事实");
    expect(result.manifest.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "inactive", status: "excluded", reason: "inactive" }),
      expect.objectContaining({ id: "merged", status: "excluded", reason: "merged-source" }),
    ]));
  });

  it("creates stable semantic goal identities without keyword taxonomies", () => {
    const first = createStageGoalContract({
      projectId: "p1", workflowId: "wf1", stage: "revision", targetArtifactId: "a1",
      authorInstruction: "让交流主要通过动作和停顿呈现", reviewIssueFingerprints: ["i2", "i1"],
      acceptanceCriteria: ["正文阅读效果明确响应作者要求"], allowedChangeScope: "chapter",
    },);
    const second = createStageGoalContract({
      projectId: "p1", workflowId: "wf1", stage: "revision", targetArtifactId: "a1",
      authorInstruction: "让交流主要通过动作和停顿呈现", reviewIssueFingerprints: ["i1", "i2"],
      acceptanceCriteria: ["正文阅读效果明确响应作者要求"], allowedChangeScope: "chapter",
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.id).toBe(second.id);
  });

  it("keeps distinct claims from one extraction artifact when claims are separate semantic sources", () => {
    const result = compileStageContext({
      projectId: "p1", workflowId: "wf-claims", purpose: "review.continuity", stage: "review",
      maxInputTokens: 1_000, reservedOutputTokens: 100,
      sections: [
        { id: "claim-1", kind: "fact", title: "位置", text: "角色仍在车站", priority: "required", provenanceRefs: ["claim-1", "artifact-facts"] },
        { id: "claim-2", kind: "fact", title: "持有物", text: "角色携带旧钥匙", priority: "required", provenanceRefs: ["claim-2", "artifact-facts"] },
      ],
    });
    expect(result.instruction).toContain("角色仍在车站");
    expect(result.instruction).toContain("角色携带旧钥匙");
  });

  it("requires every production text or structured model call to carry a context manifest", () => {
    const sourceRoot = join(process.cwd(), "src", "novel-v2");
    const offenders: string[] = [];
    for (const file of productionTypeScriptFiles(sourceRoot)) {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && (node.expression.name.text === "generateText" || node.expression.name.text === "generateStructured")) {
          const argument = node.arguments[0];
          const hasManifest = argument && ts.isObjectLiteralExpression(argument)
            && argument.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText(source) === "promptContext");
          if (!hasManifest) {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source));
            offenders.push(`${relative(process.cwd(), file)}:${position.line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(offenders).toEqual([]);
  });
});
