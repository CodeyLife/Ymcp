import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NovelDatabase, recordBase } from "../db";
import { createSegmentAutomationRun, runSegmentAutomation } from "../creative-segment";
import type { ManuscriptDocument, OutlineNode, StoryArchitecture, StoryProject } from "../types";

describe("segment creative controller", () => {
  let db: NovelDatabase;
  const projectId = "project-segment";

  beforeEach(async () => {
    db = new NovelDatabase(`ymcp-segment-controller-${crypto.randomUUID()}`);
    await db.open();
    await db.projects.put({
      id: projectId, schemaVersion: 8, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test",
      title: "长篇", subtitle: "", premise: "测试", genre: ["测试"], audience: "读者", themes: [], sellingPoints: [], pov: "第三人称限知", tense: "过去时", tone: "克制", languageStyle: "具象", targetWords: 100000, dailyGoal: 3000, status: "planning", coverColor: "#000000",
      settings: { textModel: "test", temperature: 0.7, recentChapterCount: 5, encrypted: false, contentProfile: "general-serial", maxAutoRevisions: 2, qualityThreshold: 3.7, approvalMode: "blueprint-and-manuscript" },
    } satisfies StoryProject);
  });

  afterEach(async () => {
    await db.delete();
  });

  async function seedExistingSegment() {
    const segment: OutlineNode = { ...recordBase(projectId), id: "segment-1", phaseId: "phase-1", order: 0, title: "初入江湖", summary: "主角进入新环境。" };
    await db.outlineNodes.put(segment);
    const chapters: ManuscriptDocument[] = [0, 1, 2].map((order) => ({
      ...recordBase(projectId), id: `chapter-${order + 1}`, plotSegmentId: segment.id, order, title: `第${order + 1}章`,
      blueprint: { objective: `完成节拍 ${order + 1}`, locationIds: [], characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "", informationRelease: [], mustHappen: [], flexible: [], forbidden: [], targetWords: 3000 },
      contentHtml: "", plainText: "", summary: `章节 ${order + 1}`, status: "outline", wordCount: 0, branch: "main", yjsDocumentId: `yjs-${order + 1}`,
    }));
    await db.documents.bulkPut(chapters);
  }

  it("creates a strict chapter dependency chain for an existing plot segment", async () => {
    await seedExistingSegment();
    const snapshot = await createSegmentAutomationRun({ projectId, plotSegmentId: "segment-1", objective: "完成整个剧情段" }, db);
    expect(snapshot.workItems).toHaveLength(3);
    expect(snapshot.workItems[0].dependsOn).toEqual([]);
    expect(snapshot.workItems[1].dependsOn).toEqual([snapshot.workItems[0].id]);
    expect(snapshot.workItems[2].dependsOn).toEqual([snapshot.workItems[1].id]);
    expect(snapshot.nextActions).toEqual([{ type: "work.start", workItemId: snapshot.workItems[0].id }]);
  });

  it("creates one plot-design work item when starting from an architecture phase", async () => {
    await db.architectures.put({ ...recordBase(projectId), id: "architecture-1", framework: "free", status: "approved", centralQuestion: "选择", centralConflict: "取舍", synopsis: "", phases: [{ id: "phase-1", order: 0, title: "第一幕", purpose: "建立", turningPoint: "离开故乡", locked: false }] } satisfies StoryArchitecture);
    const snapshot = await createSegmentAutomationRun({ projectId, phaseId: "phase-1", objective: "设计下一个剧情段" }, db);
    expect(snapshot.workItems).toHaveLength(1);
    expect(snapshot.workItems[0]).toMatchObject({ kind: "plot-segment", targetId: "phase-1" });
  });

  it("runs eligible chapter work sequentially until the segment is complete", async () => {
    await seedExistingSegment();
    const created = await createSegmentAutomationRun({ projectId, plotSegmentId: "segment-1", objective: "完成整个剧情段" }, db);
    const executionOrder: string[] = [];
    const executor = vi.fn(async (work: { targetId?: string }) => {
      executionOrder.push(work.targetId!);
      return { artifactRefs: [`candidate-${work.targetId}`], summary: "候选已生成" };
    });
    const reviewer = vi.fn(async (work: { artifactRefs: string[] }) => ({ subjectArtifactId: work.artifactRefs[0], reviewer: "internal" as const, verdict: "passed" as const, summary: "通过", issues: [] }));
    const accepter = vi.fn(async (work: { artifactRefs: string[] }) => ({ artifactRefs: work.artifactRefs, summary: "已晋升" }));

    const finished = await runSegmentAutomation(created.run.id, { dependencies: { db, executor: executor as never, reviewer: reviewer as never, accepter: accepter as never } });
    expect(finished.run.status).toBe("completed");
    expect(executionOrder).toEqual(["chapter-1", "chapter-2", "chapter-3"]);
    expect(finished.workItems.every((work) => work.status === "completed")).toBe(true);
  });

  it("automatically revises a blocked artifact and re-runs review within the iteration budget", async () => {
    await seedExistingSegment();
    const created = await createSegmentAutomationRun({ projectId, plotSegmentId: "segment-1", objective: "完成整个剧情段", maxIterations: 1 }, db);
    const generations = new Map<string, number>();
    const seenInstructions: string[] = [];
    const executor = vi.fn(async (work: { targetId?: string; instruction: string }) => {
      const generation = (generations.get(work.targetId!) ?? 0) + 1;
      generations.set(work.targetId!, generation);
      if (work.targetId === "chapter-1") seenInstructions.push(work.instruction);
      return { artifactRefs: [`candidate-${work.targetId}-v${generation}`], summary: `第 ${generation} 稿` };
    });
    const reviewer = vi.fn(async (work: { targetId?: string; artifactRefs: string[]; iteration: number }) => work.targetId === "chapter-1" && work.iteration === 0
      ? { subjectArtifactId: work.artifactRefs[0], reviewer: "internal" as const, verdict: "revise" as const, summary: "需要修订", issues: [{ issueId: "issue-v1", severity: "major" as const, dimension: "causality" as const, title: "因果不足", evidence: "转折", suggestion: "补足推动力" }] }
      : { subjectArtifactId: work.artifactRefs[0], reviewer: "internal" as const, verdict: "passed" as const, summary: "通过", issues: [] });
    const accepter = vi.fn(async (work: { artifactRefs: string[] }) => ({ artifactRefs: work.artifactRefs, summary: "已晋升" }));

    const finished = await runSegmentAutomation(created.run.id, { dependencies: { db, executor: executor as never, reviewer: reviewer as never, accepter: accepter as never } });
    expect(finished.run.status).toBe("completed");
    expect(generations.get("chapter-1")).toBe(2);
    expect(seenInstructions[1]).toContain("因果不足");
    expect(seenInstructions[1]).toContain("补足推动力");
    expect(seenInstructions[1]).toContain("完成节拍 1");
    expect(finished.reviewGates[finished.workItems[0].id]).toMatchObject({ passed: true, openIssues: [] });
  });

  it("does not blindly revise an inconclusive review", async () => {
    await seedExistingSegment();
    const created = await createSegmentAutomationRun({ projectId, plotSegmentId: "segment-1", objective: "完成整个剧情段", maxIterations: 2 }, db);
    const executor = vi.fn(async (work: { targetId?: string }) => ({ artifactRefs: [`candidate-${work.targetId}`], summary: "候选已生成" }));
    const reviewer = vi.fn(async (work: { artifactRefs: string[] }) => ({ subjectArtifactId: work.artifactRefs[0], reviewer: "internal" as const, verdict: "inconclusive" as const, summary: "证据不足", issues: [] }));
    const snapshot = await runSegmentAutomation(created.run.id, { dependencies: { db, executor: executor as never, reviewer: reviewer as never } });
    expect(snapshot.run.status).toBe("paused");
    expect(snapshot.workItems[0]).toMatchObject({ status: "blocked", iteration: 0 });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(snapshot.nextActions.some((action) => action.type === "work.revise")).toBe(false);
  });
});
