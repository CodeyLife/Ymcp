import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { canGenerateNextStoryArcBatch, parseStoryArcBundle, planningContextFingerprint, type ChapterPlanningContext } from "../application/story-arc";
import { startStoryArcPlanning } from "../application/story-arc-workflow";
import { NovelPostgresRepository } from "../postgres-repository";
import type { Client } from "@temporalio/client";
import type { Artifact } from "../protocol";
import { renderChapterPlanningContext } from "../prompts/chapter-planning-context";
import { buildStoryArcBatchPrompt, buildStoryArcPrompt, buildStoryArcReviewPrompt, storyArcBundleSchema } from "../prompts/story-arc";

const bundle = parseStoryArcBundle({
  arc: { title: "停电夜", objective: "让彼此戒备的两人建立最低限度信任", entryState: "互相怀疑", centralConflict: "证据与求生选择冲突", development: ["被迫同行", "交换一部分事实"], resolution: "共同保住证据", exitState: "愿意短暂合作", plotThreadRefs: ["main"], foreshadowingRefs: ["f-1"], expectedChapterCount: 20, phases: [{ title: "受困", objective: "共同求生", exitCondition: "取得证据" }, { title: "试探", objective: "建立最低信任", exitCondition: "愿意合作" }] },
  batch: { batchIndex: 1, startChapterIndex: 1, complete: false },
  chapters: Array.from({ length: 7 }, (_, index) => ({ index: index + 10, title: `章 ${index + 1}`, summary: `第 ${index + 1} 章摘要`, chapterPurpose: index === 5 ? "关系沉淀" : "局部推进", dramaticQuestion: "是否愿意相信对方", emotionalMovement: "戒备到试探", stateDeltaBudget: "只改变一层信任", optionalBeats: ["一次停顿"], scenes: [{ title: "楼梯间", summary: "借微光辨认脚步", participants: ["甲", "乙"] }], continuityConstraints: ["不得得知后续真相"], setupRefs: [], payoffRefs: [], closingForce: "未尽交流", freedom: "允许内省和氛围积累" })),
});
const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("story arc planning contract", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-story-arc-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Story Arc Test");
      await repository.pool.query("INSERT INTO books(id,project_id,title) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [`book:${projectId}:test`, projectId, "测试书"]);
      await repository.pool.query("INSERT INTO volumes(id,book_id,title,ordinal) VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING", [`volume:${projectId}:test`, `book:${projectId}:test`, "正文"]);
      available = true;
    } catch (error) {
      console.warn(`[story-arc.test] Postgres 不可用，跳过故事弧仓储集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("does not embed first-batch instructions in a later batch", () => {
    const prompt = buildStoryArcBatchPrompt({ projectTitle: "Test", macro: [], recentChapters: [], openThreads: [], arc: bundle.arc, batchIndex: 3, startChapterIndex: 14 });
    expect(prompt).toContain("batchIndex=3、startChapterIndex=14");
    expect(prompt).not.toContain("batchIndex=1、startChapterIndex=1");
    expect(prompt).not.toContain("只展开第一批");
    expect(prompt).not.toContain("只展开 5–8 章");
  });

  it("lets the model choose batch size instead of encoding a fixed five-chapter contract", () => {
    const prompt = buildStoryArcPrompt({ projectTitle: "Test", macro: [], recentChapters: [], openThreads: [] });
    expect(prompt).toContain("不固定五章");
    expect(prompt).toContain("卷/篇章分区不是故事弧");
    expect(storyArcBundleSchema.properties.chapters.minItems).toBe(1);
    expect(storyArcBundleSchema.properties.chapters.maxItems).toBe(16);
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
    expect(prompt).toContain("长篇节奏与批次边界");
    expect(prompt).toContain("首批章节像卷级剧情摘要");
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

  it("removes trailing unprotected chapters when an edited batch is shortened", async () => {
    if (!available) return;
    const volumeId = `volume:${projectId}:test`;
    const arcId = `arc-${randomUUID()}`;
    await repository.pool.query("INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload) VALUES($1,$2,$3,'待缩短弧',10,'awaiting-review','planned',$4)", [arcId, volumeId, projectId, bundle.arc]);

    async function createArtifact(id: string, structuredData: unknown): Promise<Artifact> {
      const artifact: Artifact = {
        id,
        projectId,
        taskId: `task-${id}`,
        attemptId: `attempt-${id}`,
        kind: "arc-plan",
        contentHash: `hash-${id}`,
        baseRevision: 0,
        createdAt: Date.now(),
        fingerprint: `fp-${id}`,
        structuredData: structuredData as Record<string, unknown>,
      };
      await repository.pool.query(
        "INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,base_revision,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [artifact.id, artifact.projectId, artifact.taskId, artifact.attemptId, artifact.kind, artifact.contentHash, artifact.baseRevision, artifact.fingerprint, JSON.stringify(artifact.structuredData ?? {})],
      );
      return artifact;
    }

    const initialArtifact = await createArtifact(`artifact-${randomUUID()}`, bundle);
    await repository.projectStoryArcBundle({ projectId, arcId, bundle, artifact: initialArtifact, actor: "test-author" });
    expect((await repository.getStoryArc(projectId, arcId))?.chapters).toHaveLength(7);

    const shortenedBundle = parseStoryArcBundle({ arc: bundle.arc, batch: bundle.batch, chapters: bundle.chapters.slice(0, 5) });
    const editedArtifact = await createArtifact(`artifact-${randomUUID()}`, shortenedBundle);
    const updated = await repository.projectStoryArcBundle({ projectId, arcId, bundle: shortenedBundle, artifact: editedArtifact, actor: "test-author", edited: true });

    expect(updated.chapters.map((chapter) => chapter.globalOrder)).toEqual([1, 2, 3, 4, 5]);
    expect((await repository.pool.query("SELECT id FROM chapters WHERE arc_id=$1 ORDER BY ordinal", [arcId])).rows).toHaveLength(5);
  });

  it("deletes only story arcs whose linked documents have not entered drafting", async () => {
    if (!available) return;
    const volumeId = `volume:${projectId}:test`;
    const removableArcId = `arc-${randomUUID()}`;
    const removableDocId = `doc-${randomUUID()}`;
    const removableChapterId = `chapter-${randomUUID()}`;
    await repository.pool.query("INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload) VALUES($1,$2,$3,'可删除弧',20,'awaiting-review','planned',$4)", [removableArcId, volumeId, projectId, bundle.arc]);
    await repository.pool.query("INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,entry_fingerprint,payload) VALUES($1,$2,$3,1,1,1,'awaiting-review','test',$4)", [`batch:${removableArcId}:1`, removableArcId, projectId, { complete: false }]);
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,'可删除章',20,'planned')", [removableDocId, projectId]);
    await repository.pool.query("INSERT INTO chapters(id,arc_id,project_id,document_id,title,ordinal,status,payload,batch_id,batch_index) VALUES($1,$2,$3,$4,'可删除章',20,'planned',$5,$6,1)", [removableChapterId, removableArcId, projectId, removableDocId, { ...bundle.chapters[0], id: removableChapterId, index: 20 }, `batch:${removableArcId}:1`]);
    await repository.pool.query("INSERT INTO scenes(id,chapter_id,ordinal,summary,payload) VALUES($1,$2,1,'场景',$3)", [`scene-${randomUUID()}`, removableChapterId, bundle.chapters[0].scenes[0]]);

    await expect(repository.deleteStoryArc(projectId, removableArcId, "test-author")).resolves.toMatchObject({ deleted: true, projectId, arcId: removableArcId, removedDocumentIds: [removableDocId] });
    await expect(repository.getStoryArc(projectId, removableArcId)).resolves.toBeUndefined();
    expect((await repository.pool.query("SELECT 1 FROM manuscript_documents WHERE id=$1", [removableDocId])).rowCount).toBe(0);

    const protectedArcId = `arc-${randomUUID()}`;
    const protectedDocId = `doc-${randomUUID()}`;
    const protectedChapterId = `chapter-${randomUUID()}`;
    const revisionId = `rev-${randomUUID()}`;
    const contentHash = randomUUID();
    await repository.pool.query("INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload) VALUES($1,$2,$3,'受保护弧',21,'approved','active',$4)", [protectedArcId, volumeId, projectId, bundle.arc]);
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,'已有正文章',21,'final')", [protectedDocId, projectId]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,1)", [contentHash, `test/${contentHash}`]);
    await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)", [revisionId, projectId, protectedDocId, contentHash]);
    await repository.pool.query("UPDATE manuscript_documents SET current_revision_id=$1 WHERE id=$2", [revisionId, protectedDocId]);
    await repository.pool.query("INSERT INTO chapters(id,arc_id,project_id,document_id,title,ordinal,status,payload,batch_index) VALUES($1,$2,$3,$4,'已有正文章',21,'planned',$5,1)", [protectedChapterId, protectedArcId, projectId, protectedDocId, { ...bundle.chapters[0], id: protectedChapterId, index: 21 }]);
    await expect(repository.deleteStoryArc(projectId, protectedArcId, "test-author")).rejects.toThrow("已有正文");
    expect((await repository.getStoryArc(projectId, protectedArcId))?.id).toBe(protectedArcId);
  });
});
