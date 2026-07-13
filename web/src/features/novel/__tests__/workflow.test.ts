import { beforeEach, describe, expect, it } from "vitest";
import { createChapter, createNovelProject, novelDb, recordBase } from "../db";
import { approveWorkflowStage, BUILTIN_CHAPTER_WORKFLOW, shouldAutoRevise } from "../workflow";
import type { WorkflowRun } from "../types";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
});

describe("chapter workflow policy", () => {
  it("has the two mandatory human gates in the canonical order", () => {
    expect(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("blueprint-approval")).toBeLessThan(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("draft"));
    expect(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("manuscript-approval")).toBeLessThan(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("fact-extraction"));
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
    const candidate = { ...recordBase(project.id), workflowRunId: run.id, sourceArtifactId: "draft", targetTable: "entities", field: "summary", after: "新事实", evidence: "原文证据", confidence: 0.9, novelty: "new" as const, conflict: false, status: "pending" as const };
    await novelDb.factCandidates.add(candidate);
    run.factCandidateIds = [candidate.id];
    await novelDb.workflowRuns.put(run);
    await expect(approveWorkflowStage(run.id, { approved: true })).rejects.toThrow(/未决定/);
    expect((await novelDb.workflowRuns.get(run.id))?.currentStage).toBe("fact-approval");
  });
});
