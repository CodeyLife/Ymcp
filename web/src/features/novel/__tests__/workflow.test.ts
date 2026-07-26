import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
  callStructuredNovelModel: vi.fn(async ({ role }: { role: string }) => role === "skill-iterator"
    ? { data: { conclusion: "no-shared-learning", summary: "没有共享缺陷" }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "learning" }
    : { data: { scores: { plot: 4, characterVoice: 4, sceneEmbodiment: 4, dialogue: 4, specificity: 4, hookPayoff: 4, continuity: 4, readerRetention: 4 }, issues: [] }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "review" }),
  streamNovelModel: vi.fn(async () => { throw new Error("测试停止在修订前"); }),
}));
import { createChapter, createNovelProject, novelDb, recordBase } from "../db";
import { approveWorkflowStage, assertPrecedingChaptersFinal, BUILTIN_CHAPTER_WORKFLOW, findReusableChapterBlueprint, listDocumentWorkflowRuns, shouldAutoRevise, startChapterReviewWorkflow } from "../workflow";
import { asBlueprint, blueprintMarkdown, blueprintSchema, transition } from "../workflow-shared";
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
    expect(asBlueprint({ ...modelBlueprint, beats: undefined, conflict: "潮水切断归路", targetWords: 3200 }).targetWords).toBe(3200);
    expect(blueprintMarkdown(modelBlueprint)).toContain("## 目标字数\n5000 字");
  });

  it("has the two mandatory human gates in the canonical order", () => {
    expect(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("blueprint-approval")).toBeLessThan(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("draft"));
    expect(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("manuscript-approval")).toBeLessThan(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("fact-extraction"));
    expect(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("fact-extraction")).toBeLessThan(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("fact-approval"));
    expect(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("fact-approval")).toBeLessThan(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("commit"));
    expect(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("commit")).toBeLessThan(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("character-enrichment"));
    expect(BUILTIN_CHAPTER_WORKFLOW.stages).not.toContain("deterministic-check");
    expect(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("draft") + 1).toBe(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("review"));
  });

  it("stops after the configured limit or when improvement plateaus", () => {
    expect(shouldAutoRevise({ passed: false, iteration: 0, maxIterations: 2, currentScore: 3.1 })).toBe(true);
    expect(shouldAutoRevise({ passed: false, iteration: 1, maxIterations: 2, previousScore: 3.1, currentScore: 3.2 })).toBe(false);
    expect(shouldAutoRevise({ passed: false, iteration: 2, maxIterations: 2, previousScore: 3.1, currentScore: 3.6 })).toBe(false);
    expect(shouldAutoRevise({ passed: true, iteration: 0, maxIterations: 2, currentScore: 4.1 })).toBe(false);
  });

  it("isolates workflow history by chapter", async () => {
    const project = await createNovelProject({ title: "长篇隔离", genre: ["古风"], premise: "每章必须拥有独立工作流。" });
    const first = await createChapter(project.id, "第一章");
    const second = await createChapter(project.id, "第二章");
    const firstRun: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: first.id, status: "waiting-approval", currentStage: "blueprint-approval", stageIndex: 2, revisionIteration: 0, factCandidateIds: [], startedAt: Date.now() };
    const secondRun: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: second.id, status: "running", currentStage: "context", stageIndex: 0, revisionIteration: 0, factCandidateIds: [], startedAt: Date.now() };
    await novelDb.workflowRuns.bulkAdd([firstRun, secondRun]);

    expect((await listDocumentWorkflowRuns(project.id, second.id)).map((run) => run.id)).toEqual([secondRun.id]);
  });

  it("blocks chapter production until every preceding chapter is formally committed", async () => {
    const project = await createNovelProject({ title: "连续生产", genre: ["古风"], premise: "后章不得猜测未定稿前章。" });
    const first = await createChapter(project.id, "第一章");
    const second = await createChapter(project.id, "第二章");

    await expect(assertPrecedingChaptersFinal(project.id, second.id)).rejects.toThrow(/第一章.*前章正文与事实未定稿/);
    await novelDb.documents.update(first.id, { status: "final" });
    await expect(assertPrecedingChaptersFinal(project.id, second.id)).resolves.toBeUndefined();
  });

  it("does not let a stale model stage resurrect an externally cancelled run", async () => {
    const project = await createNovelProject({ title: "取消竞态", genre: ["悬疑"], premise: "取消后旧调用不得继续推进。" });
    const chapter = await createChapter(project.id, "第一章");
    const stale: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: chapter.id, status: "running", currentStage: "review", stageIndex: 4, revisionIteration: 0, factCandidateIds: [], startedAt: Date.now() };
    await novelDb.workflowRuns.add(stale);
    await novelDb.workflowRuns.update(stale.id, { status: "cancelled", revision: stale.revision + 1 });

    const result = await transition(stale, "revision", "running");
    expect(result.status).toBe("cancelled");
    expect((await novelDb.workflowRuns.get(stale.id))?.status).toBe("cancelled");
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

describe("startChapterReviewWorkflow", () => {
  it("rejects non-final chapters", async () => {
    const project = await createNovelProject({ title: "审校测试", genre: ["悬疑"], premise: "未定稿章节不得重审。" });
    const document = await createChapter(project.id, "第一章");
    // document.status 默认为 "outline"，不是 "final"
    await expect(startChapterReviewWorkflow({ projectId: project.id, documentId: document.id }, novelDb)).rejects.toThrow(/仅对已定稿章节开放/);
  });

  it("rejects when no prior blueprint artifact exists", async () => {
    const project = await createNovelProject({ title: "无蓝图", genre: ["悬疑"], premise: "没有历史蓝图无法重审。" });
    const document = await createChapter(project.id, "第一章");
    await novelDb.documents.update(document.id, { status: "final", plainText: "章节正文内容" });
    await expect(startChapterReviewWorkflow({ projectId: project.id, documentId: document.id }, novelDb)).rejects.toThrow(/找不到历史章节蓝图/);
  });

  it("reuses the approved formal blueprint after an isolated candidate was promoted", async () => {
    const project = await createNovelProject({ title: "潮汐档案", genre: ["近未来"], premise: "正式晋升的章节仍可进入统一审校闭环。" });
    const document = await createChapter(project.id, "失联浮标");
    const promotedRevision = {
      ...recordBase(project.id),
      documentId: document.id,
      label: "候选晋升版本",
      contentHtml: "<p>浮标恢复了信号。</p>",
      plainText: "浮标恢复了信号。",
      source: "ai" as const,
      branch: "main",
      approvalStatus: "superseded" as const,
      approvedAt: Date.now() - 1000,
    };
    const approvedRevision = {
      ...recordBase(project.id),
      documentId: document.id,
      label: "人工定稿版本",
      contentHtml: "<p>浮标在退潮前恢复了信号。</p>",
      plainText: "浮标在退潮前恢复了信号。",
      source: "ai" as const,
      branch: "main",
      approvalStatus: "approved" as const,
      approvedAt: Date.now(),
    };
    const candidateId = crypto.randomUUID();
    const sourceWorkflowRunId = crypto.randomUUID();
    const blueprintArtifactId = `artifact:${sourceWorkflowRunId}:blueprint:0:blueprint`;
    const workItem = {
      ...recordBase(project.id),
      creativeRunId: crypto.randomUUID(),
      kind: "chapter-workflow" as const,
      status: "completed" as const,
      targetId: document.id,
      instruction: "生成并审核章节",
      dependsOn: [],
      iteration: 0,
      artifactRefs: [candidateId, promotedRevision.id],
      parameters: {
        closedLoopCandidate: {
          formatVersion: 2,
          id: candidateId,
          sourceProjectId: project.id,
          targetDocument: { documentId: document.id },
          manuscript: { sourceWorkflowRunId },
          provenance: {
            model: project.settings.textModel,
            workflowArtifactIds: [blueprintArtifactId],
            stagePromptEvidence: [{ stage: "blueprint", artifactId: blueprintArtifactId, skillRefs: [], promptFingerprint: "blueprint-fingerprint" }],
          },
        },
      },
    };
    const promotionReceipt = {
      id: crypto.randomUUID(),
      projectId: project.id,
      operationId: `promote:${candidateId}`,
      candidateId,
      action: "promote-candidate" as const,
      status: "completed" as const,
      createdAt: Date.now(),
      completedAt: Date.now(),
      receipts: { revisionId: promotedRevision.id, factAssertionIds: [], memoryIds: [], operationIds: [] },
    };
    await novelDb.transaction("rw", [novelDb.documents, novelDb.revisions, novelDb.creativeWorkItems, novelDb.operationReceipts], async () => {
      await novelDb.revisions.bulkAdd([promotedRevision, approvedRevision]);
      await novelDb.documents.update(document.id, {
        status: "final",
        plainText: approvedRevision.plainText,
        contentHtml: approvedRevision.contentHtml,
        approvedRevisionId: approvedRevision.id,
      });
      await novelDb.creativeWorkItems.add(workItem);
      await novelDb.operationReceipts.add(promotionReceipt);
    });

    await novelDb.operationReceipts.delete(promotionReceipt.id);
    await expect(findReusableChapterBlueprint(project.id, document.id, novelDb)).resolves.toBeUndefined();
    await novelDb.operationReceipts.add(promotionReceipt);

    const run = await startChapterReviewWorkflow({ projectId: project.id, documentId: document.id, blocking: false }, novelDb);
    expect(run).toMatchObject({
      targetDocumentId: document.id,
      currentStage: "review",
    });
    await vi.waitFor(async () => expect((await novelDb.workflowRuns.get(run.id))?.status).toBe("waiting-approval"));
  });

  // F-002 回归测试：fallback 蓝图必须标记 degraded 并补齐 schema 必需字段，
  // 让 startChapterReviewWorkflow 在 instruction 与 blueprint artifact title 中标注降级状态。
  // 不允许 fallback 路径产出静默降级的 blueprint 让 reviewer 误以为蓝图完整。
  it("marks fallback blueprint as degraded and surfaces degradation in instruction/title (F-002)", async () => {
    const project = await createNovelProject({ title: "降级复用", genre: ["近未来"], premise: "隔离闭环晋升章节重审须标注降级。" });
    const document = await createChapter(project.id, "信号浮标");
    // 给 document.blueprint 写入完整 ChapterBlueprint 字段（模拟 commit-stage 晋升写入）
    await novelDb.documents.update(document.id, {
      status: "final",
      plainText: "浮标在退潮前恢复了信号。",
      blueprint: {
        objective: "找到失踪者",
        locationIds: ["loc-1"],
        characterIds: ["char-1"],
        plotThreadIds: [],
        foreshadowingIds: [],
        conflict: "信号真伪难辨",
        informationRelease: ["信号内容"],
        mustHappen: ["恢复信号"],
        flexible: [],
        forbidden: ["角色内心独白"],
        targetWords: 3000,
      },
    });
    const approvedRevision = {
      ...recordBase(project.id),
      documentId: document.id,
      label: "候选晋升版本",
      contentHtml: "<p>浮标在退潮前恢复了信号。</p>",
      plainText: "浮标在退潮前恢复了信号。",
      source: "ai" as const,
      branch: "main",
      approvalStatus: "approved" as const,
      approvedAt: Date.now(),
    };
    const candidateId = crypto.randomUUID();
    const sourceWorkflowRunId = crypto.randomUUID();
    const blueprintArtifactId = `artifact:${sourceWorkflowRunId}:blueprint:0:blueprint`;
    const workItem = {
      ...recordBase(project.id),
      creativeRunId: crypto.randomUUID(),
      kind: "chapter-workflow" as const,
      status: "completed" as const,
      targetId: document.id,
      instruction: "生成并审核章节",
      dependsOn: [],
      iteration: 0,
      artifactRefs: [candidateId, approvedRevision.id],
      parameters: {
        closedLoopCandidate: {
          formatVersion: 2,
          id: candidateId,
          sourceProjectId: project.id,
          targetDocument: { documentId: document.id },
          manuscript: { sourceWorkflowRunId },
          provenance: {
            model: project.settings.textModel,
            workflowArtifactIds: [blueprintArtifactId],
            stagePromptEvidence: [{ stage: "blueprint", artifactId: blueprintArtifactId, skillRefs: [], promptFingerprint: "blueprint-fingerprint" }],
          },
        },
      },
    };
    const promotionReceipt = {
      id: crypto.randomUUID(),
      projectId: project.id,
      operationId: `promote:${candidateId}`,
      candidateId,
      action: "promote-candidate" as const,
      status: "completed" as const,
      createdAt: Date.now(),
      completedAt: Date.now(),
      receipts: { revisionId: approvedRevision.id, factAssertionIds: [], memoryIds: [], operationIds: [] },
    };
    await novelDb.transaction("rw", [novelDb.documents, novelDb.revisions, novelDb.creativeWorkItems, novelDb.operationReceipts], async () => {
      await novelDb.revisions.add(approvedRevision);
      await novelDb.documents.update(document.id, { approvedRevisionId: approvedRevision.id });
      await novelDb.creativeWorkItems.add(workItem);
      await novelDb.operationReceipts.add(promotionReceipt);
    });

    // 验证 fallback 路径返回 degraded: true，且 structuredData 补齐了 schema 必需字段
    const reused = await findReusableChapterBlueprint(project.id, document.id, novelDb);
    expect(reused).toBeDefined();
    expect(reused!.degraded).toBe(true);
    expect(reused!.structuredData.degraded).toBe(true);
    expect(reused!.structuredData.startingState).toContain("降级复用");
    expect(Array.isArray(reused!.structuredData.beats)).toBe(true);
    expect((reused!.structuredData.beats as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect(reused!.structuredData.characters).toEqual(["char-1"]);
    expect(reused!.structuredData.locations).toEqual(["loc-1"]);
    // 保留 ChapterBlueprint 存储字段
    expect(reused!.structuredData.objective).toBe("找到失踪者");
    expect(reused!.structuredData.conflict).toBe("信号真伪难辨");
    // structuredData 应能通过 asBlueprint 还原为合法 ChapterBlueprint
    const blueprintData = asBlueprint(reused!.structuredData);
    expect(blueprintData.objective).toBe("找到失踪者");
    expect(blueprintData.conflict).toContain("降级复用"); // beats 缺失时 conflict 从 beats.action 派生

    const run = await startChapterReviewWorkflow({ projectId: project.id, documentId: document.id, blocking: false }, novelDb);
    expect(run.currentStage).toBe("review");

    // 验证 instruction 中标注了降级提示
    const promptArtifact = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id)
      .and((item) => item.kind === "prompt" && item.stage === "context").first();
    expect(promptArtifact).toBeDefined();
    expect(promptArtifact!.contentMarkdown).toContain("降级版本");
    expect(promptArtifact!.contentMarkdown).toContain("beats 与 startingState 字段缺失");

    // 验证 blueprint artifact title 标注了降级
    const reviewBlueprintArtifact = await novelDb.workflowArtifacts.get(run.blueprintArtifactId!);
    expect(reviewBlueprintArtifact).toBeDefined();
    expect(reviewBlueprintArtifact!.title).toContain("审校复用·降级");
    expect(reviewBlueprintArtifact!.structuredData).toEqual(reused!.structuredData);

    await vi.waitFor(async () => expect((await novelDb.workflowRuns.get(run.id))?.status).toBe("waiting-approval"));
  });

  it("rejects when an active workflow already exists for the chapter", async () => {
    const project = await createNovelProject({ title: "并发检查", genre: ["悬疑"], premise: "不得并发改写同一章节。" });
    const document = await createChapter(project.id, "第一章");
    await novelDb.documents.update(document.id, { status: "final", plainText: "章节正文内容" });
    // 模拟历史 blueprint
    const priorRun: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "completed", currentStage: "character-enrichment", stageIndex: 10, revisionIteration: 0, factCandidateIds: [], startedAt: Date.now(), finishedAt: Date.now() };
    await novelDb.workflowRuns.add(priorRun);
    const blueprintArtifact = { ...recordBase(project.id), id: `artifact:${priorRun.id}:blueprint:0:blueprint`, workflowRunId: priorRun.id, stage: "blueprint" as const, kind: "blueprint" as const, title: "蓝图", contentMarkdown: "# 蓝图\n内容", structuredData: { title: "第一章", objective: "目标", beats: [], mustHappen: [], forbidden: [] }, skillRefs: [] };
    await novelDb.workflowArtifacts.add(blueprintArtifact);
    await novelDb.workflowRuns.update(priorRun.id, { blueprintArtifactId: blueprintArtifact.id });
    // 创建活跃工作流
    const activeRun: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "running", currentStage: "review", stageIndex: 4, revisionIteration: 0, factCandidateIds: [], startedAt: Date.now() };
    await novelDb.workflowRuns.add(activeRun);
    await expect(startChapterReviewWorkflow({ projectId: project.id, documentId: document.id }, novelDb)).rejects.toThrow(/已有活跃工作流/);
  });

  it("creates a review-stage run with draft and blueprint artifacts wrapping the final chapter", async () => {
    const project = await createNovelProject({ title: "审校复用", genre: ["悬疑"], premise: "已定稿章节可重审优化。" });
    const document = await createChapter(project.id, "第一章");
    const finalText = "这是已定稿的章节正文，需要进行审校优化。";
    await novelDb.documents.update(document.id, { status: "final", plainText: finalText });

    // 模拟历史 blueprint artifact（来自正式生成流程的 completed run）
    const priorRun: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "completed", currentStage: "character-enrichment", stageIndex: 10, revisionIteration: 0, factCandidateIds: [], startedAt: Date.now() - 10000, finishedAt: Date.now() - 5000 };
    await novelDb.workflowRuns.add(priorRun);
    const priorBlueprintStructuredData = { title: "第一章", objective: "找到失踪者", startingState: "雨夜", beats: [{ action: "进入车站", emotion: "警惕", outcome: "发现血迹" }], endingHook: "广播叫出主角名字", characters: [], locations: [], informationRelease: [], mustHappen: ["发现血迹"], flexible: [], forbidden: ["角色内心独白"] };
    const blueprintArtifact = { ...recordBase(project.id), id: `artifact:${priorRun.id}:blueprint:0:blueprint`, workflowRunId: priorRun.id, stage: "blueprint" as const, kind: "blueprint" as const, title: "第一章蓝图", contentMarkdown: "# 第一章\n\n## 目标\n找到失踪者", structuredData: priorBlueprintStructuredData, skillRefs: [] };
    await novelDb.workflowArtifacts.add(blueprintArtifact);
    await novelDb.workflowRuns.update(priorRun.id, { blueprintArtifactId: blueprintArtifact.id });

    const run = await startChapterReviewWorkflow({ projectId: project.id, documentId: document.id, blocking: false }, novelDb);

    // 验证 run 在 review 阶段
    expect(run.currentStage).toBe("review");
    expect(run.stageIndex).toBe(BUILTIN_CHAPTER_WORKFLOW.stages.indexOf("review"));
    expect(run.workflowId).toBe("standard-chapter-v2");
    expect(run.targetDocumentId).toBe(document.id);
    expect(run.contextPacketId).toBeTruthy();
    expect(run.blueprintArtifactId).toBeTruthy();
    expect(run.draftArtifactId).toBeTruthy();
    // 审校工作流不设置 conversationThreadId/creativeBriefId（跳过 context/blueprint/brief 阶段）
    expect(run.conversationThreadId).toBeUndefined();
    expect(run.creativeBriefId).toBeUndefined();

    // 验证 draft artifact 包装了 document.plainText
    const draftArtifact = await novelDb.workflowArtifacts.get(run.draftArtifactId!);
    expect(draftArtifact).toBeDefined();
    expect(draftArtifact!.kind).toBe("draft");
    expect(draftArtifact!.contentMarkdown).toBe(finalText);
    expect(draftArtifact!.stage).toBe("draft");

    // 验证 blueprint artifact 复用了历史 structuredData（保留 beats/title/startingState 等）
    const reviewBlueprintArtifact = await novelDb.workflowArtifacts.get(run.blueprintArtifactId!);
    expect(reviewBlueprintArtifact).toBeDefined();
    expect(reviewBlueprintArtifact!.kind).toBe("blueprint");
    expect(reviewBlueprintArtifact!.structuredData).toEqual(priorBlueprintStructuredData);
    expect(reviewBlueprintArtifact!.stage).toBe("blueprint");

    // 验证新 run 与历史 run 是不同的 WorkflowRun（不复用旧 run）
    expect(run.id).not.toBe(priorRun.id);
    // 验证新 run 的 artifacts 是为新 run 创建的（workflowRunId 指向新 run）
    expect(draftArtifact!.workflowRunId).toBe(run.id);
    expect(reviewBlueprintArtifact!.workflowRunId).toBe(run.id);
    await vi.waitFor(async () => expect((await novelDb.workflowRuns.get(run.id))?.status).toBe("waiting-approval"));
  });

  it("ignores a newer failed run and reuses the latest completed run's approved blueprint", async () => {
    const project = await createNovelProject({ title: "蓝图溯源", genre: ["悬疑"], premise: "重审只能复用已完成流程的蓝图。" });
    const document = await createChapter(project.id, "第一章");
    await novelDb.documents.update(document.id, { status: "final", plainText: "已定稿正文。" });

    const completedRun: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "completed", currentStage: "character-enrichment", stageIndex: 10, revisionIteration: 0, factCandidateIds: [], startedAt: 100, finishedAt: 200 };
    const failedRun: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: document.id, status: "failed", currentStage: "draft", stageIndex: 3, revisionIteration: 0, factCandidateIds: [], startedAt: 300, finishedAt: 400 };
    const approvedBlueprint = { ...recordBase(project.id), id: `artifact:${completedRun.id}:blueprint`, workflowRunId: completedRun.id, stage: "blueprint" as const, kind: "blueprint" as const, title: "已批准蓝图", contentMarkdown: "# 已批准蓝图", structuredData: { title: "第一章", beats: [{ action: "可靠节拍" }] }, skillRefs: [] };
    const failedBlueprint = { ...recordBase(project.id), id: `artifact:${failedRun.id}:blueprint`, workflowRunId: failedRun.id, stage: "blueprint" as const, kind: "blueprint" as const, title: "失败蓝图", contentMarkdown: "# 失败蓝图", structuredData: { title: "第一章", beats: [{ action: "不应复用" }] }, skillRefs: [] };
    completedRun.blueprintArtifactId = approvedBlueprint.id;
    failedRun.blueprintArtifactId = failedBlueprint.id;
    await novelDb.workflowRuns.bulkAdd([completedRun, failedRun]);
    await novelDb.workflowArtifacts.bulkAdd([approvedBlueprint, failedBlueprint]);

    const reused = await findReusableChapterBlueprint(project.id, document.id, novelDb);
    expect(reused?.structuredData).toEqual(approvedBlueprint.structuredData);
  });
});
