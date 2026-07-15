import { beforeEach, describe, expect, it } from "vitest";
import { createChapter, createNovelProject, novelDb, recordBase } from "../db";
import { approveWorkflowStage, BUILTIN_CHAPTER_WORKFLOW, shouldAutoRevise } from "../workflow";
import { asBlueprint, blueprintMarkdown, blueprintSchema } from "../workflow-shared";
import type { WorkflowRun } from "../types";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
});

describe("chapter workflow policy", () => {
  it("uses the system 3000-word default instead of an LLM blueprint field", () => {
    const modelBlueprint = {
      title: "第一章",
      objective: "找到失踪者",
      startingState: "雨夜",
      beats: [{ action: "进入车站", emotion: "警惕", outcome: "发现血迹" }],
      endingHook: "广播叫出主角名字",
      characters: [],
      locations: [],
      informationRelease: [],
      mustHappen: [],
      flexible: [],
      forbidden: [],
      targetWords: 9000,
    };

    expect(blueprintSchema.required).not.toContain("targetWords");
    expect(blueprintSchema.properties).not.toHaveProperty("targetWords");
    expect(asBlueprint(modelBlueprint).targetWords).toBe(5000);
    expect(blueprintMarkdown(modelBlueprint)).toContain("## 目标字数\n5000 字");
  });

  it("has the two mandatory human gates in the canonical order", () => {
    expect(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("blueprint-approval")).toBeLessThan(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("draft"));
    expect(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("manuscript-approval")).toBeLessThan(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("fact-extraction"));
    expect(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("fact-extraction")).toBeLessThan(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("fact-approval"));
    expect(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("fact-approval")).toBeLessThan(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("commit"));
    expect(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("commit")).toBeLessThan(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("character-enrichment"));
  });

  it("stops after the configured limit or when improvement plateaus", () => {
    expect(shouldAutoRevise({ passed: false, iteration: 0, maxIterations: 2, currentScore: 3.1 })).toBe(true);
    expect(shouldAutoRevise({ passed: false, iteration: 1, maxIterations: 2, previousScore: 3.1, currentScore: 3.2 })).toBe(false);
    expect(shouldAutoRevise({ passed: false, iteration: 2, maxIterations: 2, previousScore: 3.1, currentScore: 3.6 })).toBe(false);
    expect(shouldAutoRevise({ passed: true, iteration: 0, maxIterations: 2, currentScore: 4.1 })).toBe(false);
  });

  it("cannot pass fact approval while any candidate remains undecided", async () => {
    const project = await createNovelProject({ title: "审批测试", genre: ["都市"], premise: "一条未确认事实不能被提交。" });
    const document = await createChapter(project.id);
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "waiting-approval", currentStage: "fact-approval", stageIndex: 9, revisionIteration: 0, factCandidateIds: [], startedAt: Date.now() };
    await novelDb.workflowRuns.add(run);
    const candidate = { ...recordBase(project.id), workflowRunId: run.id, sourceArtifactId: "draft", targetTable: "entities", field: "summary", after: "新事实", evidence: "原文证据", confidence: 0.9, novelty: "new" as const, conflict: false, risk: "high" as const, riskReason: "新事实必须人工确认", status: "pending" as const };
    await novelDb.factCandidates.add(candidate);
    run.factCandidateIds = [candidate.id];
    await novelDb.workflowRuns.put(run);
    await expect(approveWorkflowStage(run.id, { approved: true })).rejects.toThrow(/未决定/);
    expect((await novelDb.workflowRuns.get(run.id))?.currentStage).toBe("fact-approval");
  });
});
