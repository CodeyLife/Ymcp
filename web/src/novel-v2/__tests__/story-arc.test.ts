import { describe, expect, it, vi } from "vitest";
import { canGenerateNextStoryArcBatch, parseStoryArcBundle, planningContextFingerprint, type ChapterPlanningContext } from "../application/story-arc";
import { startStoryArcPlanning } from "../application/story-arc-workflow";
import type { NovelPostgresRepository } from "../postgres-repository";
import type { Client } from "@temporalio/client";
import { renderChapterPlanningContext } from "../prompts/chapter-planning-context";
import { buildStoryArcBatchPrompt, buildStoryArcReviewPrompt } from "../prompts/story-arc";

const bundle = parseStoryArcBundle({
  arc: { title: "停电夜", objective: "让彼此戒备的两人建立最低限度信任", entryState: "互相怀疑", centralConflict: "证据与求生选择冲突", development: ["被迫同行", "交换一部分事实"], resolution: "共同保住证据", exitState: "愿意短暂合作", plotThreadRefs: ["main"], foreshadowingRefs: ["f-1"], expectedChapterCount: 20, phases: [{ title: "受困", objective: "共同求生", exitCondition: "取得证据" }, { title: "试探", objective: "建立最低信任", exitCondition: "愿意合作" }] },
  batch: { batchIndex: 1, startChapterIndex: 1, complete: false },
  chapters: Array.from({ length: 7 }, (_, index) => ({ index: index + 10, title: `章 ${index + 1}`, summary: `第 ${index + 1} 章摘要`, chapterPurpose: index === 5 ? "关系沉淀" : "局部推进", dramaticQuestion: "是否愿意相信对方", emotionalMovement: "戒备到试探", stateDeltaBudget: "只改变一层信任", optionalBeats: ["一次停顿"], scenes: [{ title: "楼梯间", summary: "借微光辨认脚步", participants: ["甲", "乙"] }], continuityConstraints: ["不得得知后续真相"], setupRefs: [], payoffRefs: [], closingForce: "未尽交流", freedom: "允许内省和氛围积累" })),
});

describe("story arc planning contract", () => {
  it("does not embed first-batch instructions in a later batch", () => {
    const prompt = buildStoryArcBatchPrompt({ projectTitle: "Test", macro: [], recentChapters: [], openThreads: [], arc: bundle.arc, batchIndex: 3, startChapterIndex: 14 });
    expect(prompt).toContain("batchIndex=3、startChapterIndex=14");
    expect(prompt).not.toContain("batchIndex=1、startChapterIndex=1");
    expect(prompt).not.toContain("只展开第一批");
  });

  it("normalizes author chapter indices without truncating chapters after five", () => {
    expect(bundle.arc.expectedChapterCount).toBe(20);
    expect(bundle.chapters).toHaveLength(7);
    expect(bundle.chapters[5]).toMatchObject({ index: 6, title: "章 6", chapterPurpose: "关系沉淀" });
  });

  it("opens the next batch only after an approved batch reaches the 70% final threshold", () => {
    expect(canGenerateNextStoryArcBatch({ plannedInBatch: 7, finalizedInBatch: 4, batchStatus: "approved" })).toBe(false);
    expect(canGenerateNextStoryArcBatch({ plannedInBatch: 7, finalizedInBatch: 5, batchStatus: "approved" })).toBe(true);
    expect(canGenerateNextStoryArcBatch({ plannedInBatch: 7, finalizedInBatch: 7, batchStatus: "awaiting-review" })).toBe(false);
  });

  it("renders the exact target blueprint and neighbors as one frozen context", () => {
    const base: Omit<ChapterPlanningContext, "fingerprint"> = {
      projectId: "p", arcId: "a", chapterBlueprintId: "c6",
      macroPlanArtifacts: [{ id: "macro", taskKey: "plot-design", title: "长线", summary: "真相后置", payload: {} }],
      arc: bundle.arc,
      chapter: { ...bundle.chapters[5], id: "c6", arcId: "a", projectId: "p", globalOrder: 6, status: "planned", blueprintRevision: 0 },
      neighbors: [
        { id: "c5", globalOrder: 5, title: bundle.chapters[4].title, summary: bundle.chapters[4].summary, chapterPurpose: bundle.chapters[4].chapterPurpose },
        { id: "c7", globalOrder: 7, title: bundle.chapters[6].title, summary: bundle.chapters[6].summary, chapterPurpose: bundle.chapters[6].chapterPurpose },
      ],
      sourceArtifactIds: ["macro", "arc-artifact"],
    };
    const context = { ...base, fingerprint: planningContextFingerprint(base) };
    const rendered = renderChapterPlanningContext(context);
    expect(rendered).toContain("目标章：第 6 章《章 6》");
    expect(rendered).toContain("关系沉淀");
    expect(rendered).toContain("第 5 章《章 5》");
    expect(rendered).toContain("第 7 章《章 7》");
    expect(rendered).toContain("可选组织材料，不是逐项打勾的任务清单");
  });

  it("reviews quiet chapters by function instead of mandatory main-plot movement", () => {
    const prompt = buildStoryArcReviewPrompt(bundle, "都市悬疑上下文");
    expect(prompt).toContain("不要因安静章、铺陈章、关系章没有明显推进主线而判错");
    expect(prompt).toContain("关系沉淀");
  });

  it("passes the Web auto-review policy into the durable workflow and audit payload", async () => {
    const repository = {
      createNextStoryArc: vi.fn(async () => ({ id: "arc-1" })),
      putWorkflowRun: vi.fn(async () => undefined),
    } as unknown as NovelPostgresRepository;
    const start = vi.fn(async () => ({ firstExecutionRunId: "run-1" }));
    const temporal = { workflow: { start } } as unknown as Client;

    await startStoryArcPlanning(repository, temporal, { projectId: "project-1", mode: "web", reviewPolicy: "auto", authorIntent: "检验关系弧" });

    expect(repository.putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ mode: "web", reviewPolicy: "auto" }) }));
    expect(start).toHaveBeenCalledWith("storyArcPlanningWorkflow", expect.objectContaining({ args: [expect.objectContaining({ mode: "web", reviewPolicy: "auto" })] }));
  });
});
