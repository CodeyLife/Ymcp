import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({ callStructuredNovelModel: vi.fn() }));
vi.mock("../generation", () => ({ runGenerationTask: vi.fn() }));
vi.mock("../retrieval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../retrieval")>();
  return { ...actual, vectorSearch: vi.fn(), upsertEmbedding: vi.fn() };
});

import { callStructuredNovelModel } from "../ai";
import { createChapter, createNovelProject, novelDb, recordBase } from "../db";
import { DexieNovelMemoryService, HttpNovelMemoryService, runPendingMemoryJobs, scheduleMemoryJob, startMemoryJobWorker } from "../memory-service";
import { upsertEmbedding, vectorSearch } from "../retrieval";
import { runGenerationTask } from "../generation";

const service = new DexieNovelMemoryService();

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
  vi.mocked(callStructuredNovelModel).mockReset();
  vi.mocked(vectorSearch).mockReset();
  vi.mocked(upsertEmbedding).mockReset();
  vi.mocked(runGenerationTask).mockReset();
  vi.mocked(vectorSearch).mockRejectedValue(new Error("embedding unavailable"));
  vi.mocked(upsertEmbedding).mockResolvedValue(undefined);
  vi.mocked(runGenerationTask).mockResolvedValue({ id: "proposal-1" } as never);
});

async function seed() {
  const project = await createNovelProject({ title: "记忆生产", genre: ["悬疑"], premise: "在北港寻找失踪者。" });
  const first = await createChapter(project.id, "第一章");
  const second = await createChapter(project.id, "第二章");
  await novelDb.entities.add({
    id: "character-lin", projectId: project.id, schemaVersion: 6, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test",
    kind: "character", name: "林默", aliases: ["阿默"], summary: "负责调查北港旧案。", description: "谨慎，避免轻易下结论。", tags: [], lockedFacts: [], attributes: {},
    character: { role: "主角", appearance: "", personality: "谨慎", desire: "找到失踪者", motivation: "兑现承诺", weakness: "多疑", secret: "", abilities: [], voice: "短句", arc: "", state: { location: "北港", physical: "正常", emotional: "警觉", objective: "调查", inventory: [], relationshipNotes: [] } },
  });
  return { project, first, second };
}

describe("NovelMemoryService", () => {
  it("reuses a chapter thread and isolates different chapter targets", async () => {
    const { project, first, second } = await seed();
    const firstThread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
    const reused = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
    const other = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: second.id });
    expect(reused.id).toBe(firstThread.id);
    expect(other.id).not.toBe(firstThread.id);
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id })));
    expect(new Set(concurrent.map((item) => item.id))).toEqual(new Set([firstThread.id]));
  });

  it("creates a new draft when an author edits a confirmed brief", async () => {
    const { project, first } = await seed();
    const thread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
    const draft = await service.getDraftBrief(thread.id);
    const confirmed = await service.confirmBrief(draft.id);
    expect((await service.getDraftBrief(thread.id)).id).toBe(confirmed.id);
    const revised = await service.updateBrief(confirmed.id, { tone: "克制冷峻" });
    expect(revised.id).not.toBe(confirmed.id);
    expect(revised.status).toBe("draft");
    expect((await novelDb.creativeBriefs.get(confirmed.id))?.status).toBe("superseded");
  });

  it("uses bounded lexical retrieval, records sources, and only extracts author preferences", async () => {
    const { project, first } = await seed();
    const thread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce({ data: { answer: "我会继续查找阿默的行动边界。", enoughEvidence: false, followUpQueries: ["林默 谨慎 调查"], preferenceMemories: [], canonicalChangeRequests: [], briefPatch: { mustHappen: ["林默检查旧案卷宗"] } }, usage: { inputTokens: 0, outputTokens: 0 }, promptHash: "a" })
      .mockResolvedValueOnce({ data: { answer: "已找到人物档案，可据此规划。", enoughEvidence: true, followUpQueries: [], preferenceMemories: [{ title: "叙事偏好", content: "偏好克制的短句，不直接解释情绪。", confidence: 0.96, evidenceQuote: "我偏好克制短句，不要直接解释情绪" }], canonicalChangeRequests: [], briefPatch: { tone: "克制", languageRequirements: ["使用短句"], mustHappen: ["林默检查旧案卷宗"], forbidden: [], openQuestions: [] } }, usage: { inputTokens: 0, outputTokens: 0 }, promptHash: "b" });

    const result = await service.runConversationTurn({ threadId: thread.id, content: "写阿默调查旧案。我偏好克制短句，不要直接解释情绪。" });
    expect(result.retrievalRun.rounds).toHaveLength(2);
    expect(result.retrievalRun.selectedSourceIds).toContain("character-lin");
    expect(result.assistantMessage.sourceIds).toContain("character-lin");
    expect(result.brief.mustHappen).toContain("林默检查旧案卷宗");
    const memories = await novelDb.conversationMemories.where("projectId").equals(project.id).toArray();
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ kind: "preference", status: "pending", autoApplied: false });
    expect(await novelDb.conversationMessages.where("threadId").equals(thread.id).count()).toBe(2);
    expect(vi.mocked(vectorSearch)).toHaveBeenCalled();
    expect(vi.mocked(callStructuredNovelModel).mock.calls[1][0].prompt).toContain("同一线程近期对话");
    expect((await novelDb.conversationThreads.get(thread.id))?.summary).toContain("写阿默调查旧案");
  });

  it("persists pin and exclude overrides and can revoke automatic memory", async () => {
    const { project, first } = await seed();
    const thread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
    await service.setSourceOverride(thread.id, "character-lin", "pin");
    expect((await novelDb.conversationThreads.get(thread.id))?.pinnedSourceIds).toEqual(["character-lin"]);
    await service.setSourceOverride(thread.id, "character-lin", "exclude");
    expect((await novelDb.conversationThreads.get(thread.id))?.excludedSourceIds).toEqual(["character-lin"]);
    const memory = { id: "memory-1", projectId: project.id, schemaVersion: 6, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test", threadId: thread.id, targetId: first.id, scope: "project" as const, scopeKey: `project:${project.id}`, kind: "preference" as const, title: "偏好", content: "短句", status: "active" as const, confidence: 1, sourceMessageIds: [], evidenceQuotes: ["我偏好短句"], extractorVersion: "test", autoApplied: true };
    await novelDb.conversationMemories.add(memory);
    await service.revokeMemory(memory.id);
    expect((await novelDb.conversationMemories.get(memory.id))?.status).toBe("rejected");
  });

  it("routes explicit project-data changes into the existing proposal workflow", async () => {
    const { project, first } = await seed();
    const thread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({ data: { answer: "会作为角色候选提交。", enoughEvidence: true, followUpQueries: [], preferenceMemories: [], canonicalChangeRequests: [{ taskKey: "characters", instruction: "把林默的弱点改为过度承担责任" }], briefPatch: {} }, usage: { inputTokens: 0, outputTokens: 0 }, promptHash: "change" });
    const result = await service.runConversationTurn({ threadId: thread.id, content: "把林默的弱点改为过度承担责任" });
    expect(runGenerationTask).toHaveBeenCalledWith({ projectId: project.id, taskKey: "characters", instruction: "把林默的弱点改为过度承担责任" });
    expect(result.assistantMessage.content).toContain("等待作者审核");
    expect(await novelDb.conversationMemories.where("projectId").equals(project.id).count()).toBe(0);
  });

  it("requires a confirmed brief and creates traceable stage context", async () => {
    const { project, first } = await seed();
    const thread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
    await expect(service.compileStageContext({ threadId: thread.id, stage: "draft", role: "writer", instruction: "写正文" })).rejects.toThrow(/确认/);
    const brief = await service.getDraftBrief(thread.id);
    const confirmed = await service.confirmBrief(brief.id);
    const packet = await service.compileStageContext({ threadId: thread.id, stage: "draft", role: "writer", instruction: "写正文", workflowRunId: "run-1" });
    expect(packet.creativeBriefId).toBe(confirmed.id);
    expect(packet.consumer).toMatchObject({ workflowRunId: "run-1", stage: "draft", role: "writer" });
    expect(packet.sources.some((source) => source.kind === "creative-brief")).toBe(true);
  });

  it("separates reviewer source kinds and adds a POV behavior boundary for drafting", async () => {
    const { project, first } = await seed();
    const thread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
    const draft = await service.getDraftBrief(thread.id);
    const withPov = await service.updateBrief(draft.id, { povCharacterId: "character-lin" });
    await service.confirmBrief(withPov.id);
    const stylePacket = await service.compileStageContext({ threadId: thread.id, stage: "review", role: "style-reviewer", instruction: "审校文风" });
    const continuityPacket = await service.compileStageContext({ threadId: thread.id, stage: "review", role: "continuity-reviewer", instruction: "审校连续性" });
    const draftPacket = await service.compileStageContext({ threadId: thread.id, stage: "draft", role: "writer", instruction: "生成正文" });
    expect(stylePacket.sources.some((source) => source.kind === "entity")).toBe(false);
    expect(continuityPacket.sources.some((source) => source.kind === "entity")).toBe(true);
    expect(draftPacket.informationView?.mode).toBe("character");
    expect(draftPacket.sources.some((source) => source.id === "pov-boundary")).toBe(true);
  });

  it("keeps reader-visible facts out of a POV draft until the character knows them", async () => {
    const { project, second } = await seed();
    await novelDb.factAssertions.add({
      ...recordBase(project.id), id: "reader-only-secret", subject: { kind: "project", id: project.id }, predicate: "mystery.culprit",
      object: { kind: "string", value: "城主" }, polarity: "affirmed", truthStatus: "objective", timeMode: "timeless",
      revealedAt: { narrativeOrder: 0, precision: "exact" }, sourceRevisionId: "revision-secret", provenance: "approved-revision",
      evidence: "读者已经看到密信", confidence: 1, humanReadable: "城主是凶手", status: "active", derivedFromCandidateId: "candidate-secret",
    });
    const thread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: second.id });
    const draft = await service.getDraftBrief(thread.id);
    const withPov = await service.updateBrief(draft.id, { povCharacterId: "character-lin", factCutoffOrder: 0, goal: "调查城主是否是凶手" });
    await service.confirmBrief(withPov.id);

    const beforeLearning = await service.compileStageContext({ threadId: thread.id, stage: "draft", role: "writer", instruction: "调查城主是否是凶手" });
    expect(beforeLearning.sources.some((source) => source.id === "reader-only-secret")).toBe(false);

    await novelDb.knowledgeAssertions.add({
      ...recordBase(project.id), id: "lin-knows-secret", characterId: "character-lin", factAssertionId: "reader-only-secret",
      stance: "known", learnedAt: { narrativeOrder: 0, precision: "exact" }, sourceRevisionId: "revision-secret", status: "active",
    });
    const afterLearning = await service.compileStageContext({ threadId: thread.id, stage: "draft", role: "writer", instruction: "调查城主是否是凶手" });
    expect(afterLearning.sources.some((source) => source.id === "lin-knows-secret" && source.kind === "knowledge")).toBe(true);
  });

  it("deduplicates durable jobs and processes embeddings idempotently", async () => {
    const { project } = await seed();
    const params = { projectId: project.id, jobType: "embedding" as const, idempotencyKey: "embedding:test", payload: { targetTable: "conversationMemories", targetId: "m1", content: "偏好短句" } };
    const first = await scheduleMemoryJob(params);
    const duplicate = await scheduleMemoryJob(params);
    expect(duplicate.id).toBe(first.id);
    await runPendingMemoryJobs(project.id);
    expect((await novelDb.memoryJobs.get(first.id))?.status).toBe("completed");
    expect(upsertEmbedding).toHaveBeenCalledTimes(1);
  });

  it("compiles role-specific stage retrieval with the confirmed fact cutoff", async () => {
    const { project, second } = await seed();
    await novelDb.documents.update(second.id, { plainText: "林默在北港核对旧案卷宗。", summary: "核对北港旧案" });
    await novelDb.factAssertions.bulkAdd([
      { ...recordBase(project.id), id: "fact-visible", subject: { kind: "project", id: project.id }, predicate: "location", object: { kind: "string", value: "北港" }, polarity: "affirmed", truthStatus: "objective", timeMode: "timeless", revealedAt: { narrativeOrder: 0, precision: "exact" }, sourceRevisionId: "revision-0", provenance: "approved-revision", evidence: "林默抵达北港", confidence: 1, humanReadable: "林默在北港", status: "active", derivedFromCandidateId: "candidate-0" },
      { ...recordBase(project.id), id: "fact-future", subject: { kind: "project", id: project.id }, predicate: "secret", object: { kind: "string", value: "未来真相" }, polarity: "affirmed", truthStatus: "objective", timeMode: "timeless", revealedAt: { narrativeOrder: 2, precision: "exact" }, sourceRevisionId: "revision-2", provenance: "approved-revision", evidence: "未来章节揭示", confidence: 1, humanReadable: "未来才揭示真相", status: "active", derivedFromCandidateId: "candidate-2" },
    ]);
    await novelDb.plotThreads.add({ ...recordBase(project.id), id: "unrelated-thread", kind: "subplot", title: "南城支线", summary: "与北港旧案无关", status: "active", priority: 1, participantIds: [], progress: 0, nextMove: "等待" });
    const thread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: second.id });
    const draft = await service.getDraftBrief(thread.id);
    const changed = await service.updateBrief(draft.id, { factCutoffOrder: 0, goal: "核对北港旧案" });
    await service.confirmBrief(changed.id);

    const factPacket = await service.compileStageContext({ threadId: thread.id, stage: "fact-extraction", role: "fact-extractor", instruction: "提取北港事实", workflowRunId: "workflow-1" });
    const continuityPacket = await service.compileStageContext({ threadId: thread.id, stage: "review", role: "continuity-reviewer", instruction: "核对北港连续性", workflowRunId: "workflow-1" });

    expect(factPacket.factCutoffOrder).toBe(0);
    expect(factPacket.sources.some((item) => item.id === "fact-visible")).toBe(true);
    expect(factPacket.sources.some((item) => item.id === "fact-future")).toBe(false);
    expect(factPacket.sources.some((item) => ["architecture", "thread", "foreshadowing"].includes(item.kind))).toBe(false);
    const runs = await novelDb.retrievalRuns.where("threadId").equals(thread.id).toArray();
    expect(runs.filter((item) => item.purpose === "workflow-stage")).toHaveLength(2);
    expect(new Set(runs.map((item) => item.consumer?.role))).toEqual(new Set(["fact-extractor", "continuity-reviewer"]));
    expect(continuityPacket.retrievalRunId).not.toBe(factPacket.retrievalRunId);
  });

  it("keeps an unquoted or ambiguous preference pending until the author confirms it", async () => {
    const { project, first } = await seed();
    const thread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({ data: { answer: "收到。", enoughEvidence: true, followUpQueries: [], preferenceMemories: [{ title: "句式", content: "偏好长句", confidence: 0.99, evidenceQuote: "我偏好长句" }], canonicalChangeRequests: [], briefPatch: {} }, usage: { inputTokens: 0, outputTokens: 0 }, promptHash: "pending" });
    await service.runConversationTurn({ threadId: thread.id, content: "继续处理本章。" });
    const memory = await novelDb.conversationMemories.where("projectId").equals(project.id).first();
    expect(memory).toMatchObject({ status: "pending", autoApplied: false, evidenceQuotes: ["我偏好长句"] });
    await service.approveMemory(memory!.id);
    expect((await novelDb.conversationMemories.get(memory!.id))?.status).toBe("active");
  });

  it("recovers expired jobs and executes memory extraction from author evidence", async () => {
    const { project, first } = await seed();
    const thread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
    const message = await service.appendMessage({ threadId: thread.id, role: "user", content: "我偏好克制短句。" });
    const job = await scheduleMemoryJob({ projectId: project.id, jobType: "memory-extraction", idempotencyKey: "extract:preference", payload: { threadId: thread.id, messageId: message.id, title: "句式偏好", content: "偏好克制短句", confidence: 0.95, evidenceQuote: "我偏好克制短句" } });
    await novelDb.memoryJobs.update(job.id, { status: "running", leaseOwner: "dead-worker", leaseExpiresAt: Date.now() - 1 });
    await runPendingMemoryJobs(project.id);
    expect((await novelDb.memoryJobs.get(job.id))?.status).toBe("completed");
    expect(await novelDb.conversationMemories.where("projectId").equals(project.id).and((item) => item.status === "pending").count()).toBe(1);
  });

  it("executes invalidation and consolidation jobs instead of falsely completing them", async () => {
    const { project, first, second } = await seed();
    const content = { sceneOutcomes: [], stateChanges: [], knowledgeChanges: [], relationshipChanges: [], threadProgress: [], foreshadowingProgress: [], factAssertionIds: [], inheritedPressures: [] };
    await novelDb.derivedMemories.bulkAdd([
      { ...recordBase(project.id), id: "stale-target", level: "chapter", documentId: first.id, sourceRevisionId: "revision-stale", sourceMemoryIds: [], coverage: { chapterIds: [first.id], startOrder: 0, endOrder: 0 }, summary: "旧来源", content, status: "active", validation: { passed: true, issues: [], checkedAt: 1 }, tokenEstimate: 10, generatedAt: 1 },
      { ...recordBase(project.id), id: "chapter-a", level: "chapter", documentId: first.id, sourceRevisionId: "revision-a", sourceMemoryIds: [], coverage: { chapterIds: [first.id], startOrder: 0, endOrder: 0 }, summary: "第一章结果", content, status: "active", validation: { passed: true, issues: [], checkedAt: 1 }, tokenEstimate: 10, generatedAt: 1 },
      { ...recordBase(project.id), id: "chapter-b", level: "chapter", documentId: second.id, sourceRevisionId: "revision-b", sourceMemoryIds: [], coverage: { chapterIds: [second.id], startOrder: 1, endOrder: 1 }, summary: "第二章结果", content, status: "active", validation: { passed: true, issues: [], checkedAt: 1 }, tokenEstimate: 10, generatedAt: 1 },
    ]);
    await scheduleMemoryJob({ projectId: project.id, jobType: "memory-invalidation", idempotencyKey: "invalidate:revision-stale", payload: { sourceRevisionIds: ["revision-stale"] } });
    await scheduleMemoryJob({ projectId: project.id, jobType: "memory-consolidation", idempotencyKey: "consolidate:sequence", payload: { level: "sequence", sourceMemoryIds: ["chapter-a", "chapter-b"], summary: "两章形成完整调查序列", content } });
    await runPendingMemoryJobs(project.id);
    expect((await novelDb.derivedMemories.get("stale-target"))?.status).toBe("stale");
    expect(await novelDb.derivedMemories.where("projectId").equals(project.id).and((item) => item.level === "sequence" && item.status === "active").count()).toBe(1);
    expect(await novelDb.memoryJobs.where("projectId").equals(project.id).and((item) => item.status === "pending").count()).toBe(0);
  });

  // F-020 回归测试：savePreferenceMemory 必须拒绝空 evidenceQuote，
  // memory-extraction 任务处理必须对空 evidenceQuote 抛错触发重试，
  // TURN_SCHEMA 的 evidenceQuote 必须有 minLength: 1。
  describe("F-020: evidenceQuote non-empty enforcement", () => {
    it("savePreferenceMemory skips creation when evidenceQuote is empty (F-020)", async () => {
      const { project, first } = await seed();
      const thread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
      const message = await service.appendMessage({ threadId: thread.id, role: "user", content: "我偏好短句。" });
      // 模拟 LLM 返回空 evidenceQuote——savePreferenceMemory 应跳过创建
      const job = await scheduleMemoryJob({ projectId: project.id, jobType: "memory-extraction", idempotencyKey: "extract:empty-quote", payload: { threadId: thread.id, messageId: message.id, title: "句式偏好", content: "偏好短句", confidence: 0.95, evidenceQuote: "" } });
      await runPendingMemoryJobs(project.id);

      // 任务应失败（throw 触发重试），不应静默完成
      const jobAfter = await novelDb.memoryJobs.get(job.id);
      expect(jobAfter?.status).toBe("pending");
      expect(jobAfter?.lastError).toContain("证据引用");
      // 不应创建任何 preference memory
      const memories = await novelDb.conversationMemories.where("projectId").equals(project.id).toArray();
      expect(memories).toHaveLength(0);
    });

    it("savePreferenceMemory skips creation when evidenceQuote is whitespace-only (F-020)", async () => {
      const { project, first } = await seed();
      const thread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
      const message = await service.appendMessage({ threadId: thread.id, role: "user", content: "我偏好短句。" });
      // 模拟 LLM 返回纯空白 evidenceQuote——trim() 后为空，应跳过
      const job = await scheduleMemoryJob({ projectId: project.id, jobType: "memory-extraction", idempotencyKey: "extract:whitespace-quote", payload: { threadId: thread.id, messageId: message.id, title: "句式偏好", content: "偏好短句", confidence: 0.95, evidenceQuote: "   " } });
      await runPendingMemoryJobs(project.id);

      const jobAfter = await novelDb.memoryJobs.get(job.id);
      expect(jobAfter?.status).toBe("pending");
      expect(jobAfter?.lastError).toContain("证据引用");
      const memories = await novelDb.conversationMemories.where("projectId").equals(project.id).toArray();
      expect(memories).toHaveLength(0);
    });

    it("savePreferenceMemory skips creation when evidenceQuote is undefined (F-020)", async () => {
      const { project, first } = await seed();
      const thread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
      const message = await service.appendMessage({ threadId: thread.id, role: "user", content: "我偏好短句。" });
      // 模拟 payload 未提供 evidenceQuote
      const job = await scheduleMemoryJob({ projectId: project.id, jobType: "memory-extraction", idempotencyKey: "extract:undefined-quote", payload: { threadId: thread.id, messageId: message.id, title: "句式偏好", content: "偏好短句", confidence: 0.95 } });
      await runPendingMemoryJobs(project.id);

      const jobAfter = await novelDb.memoryJobs.get(job.id);
      expect(jobAfter?.status).toBe("pending");
      expect(jobAfter?.lastError).toContain("证据引用");
      const memories = await novelDb.conversationMemories.where("projectId").equals(project.id).toArray();
      expect(memories).toHaveLength(0);
    });

    it("still creates memory when evidenceQuote is non-empty (F-020 regression)", async () => {
      // 反例：非空 evidenceQuote 仍应正常创建记忆
      const { project, first } = await seed();
      const thread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
      const message = await service.appendMessage({ threadId: thread.id, role: "user", content: "我偏好克制短句。" });
      const job = await scheduleMemoryJob({ projectId: project.id, jobType: "memory-extraction", idempotencyKey: "extract:valid-quote", payload: { threadId: thread.id, messageId: message.id, title: "句式偏好", content: "偏好克制短句", confidence: 0.95, evidenceQuote: "我偏好克制短句" } });
      await runPendingMemoryJobs(project.id);

      const jobAfter = await novelDb.memoryJobs.get(job.id);
      expect(jobAfter?.status).toBe("completed");
      const memory = await novelDb.conversationMemories.where("projectId").equals(project.id).first();
      expect(memory).toBeDefined();
      expect(memory?.evidenceQuotes).toEqual(["我偏好克制短句"]);
    });
  });

  it("keeps polling until a backoff-delayed memory job succeeds", async () => {
    const { project } = await seed();
    vi.mocked(upsertEmbedding).mockRejectedValueOnce(new Error("temporary outage")).mockResolvedValueOnce(undefined);
    const job = await scheduleMemoryJob({ projectId: project.id, jobType: "embedding", idempotencyKey: "embedding:retry", payload: { targetTable: "conversationMemories", targetId: "retry-memory", content: "克制短句" } });
    await runPendingMemoryJobs(project.id);
    expect((await novelDb.memoryJobs.get(job.id))?.status).toBe("pending");

    const stop = startMemoryJobWorker(project.id, 50);
    try {
      await vi.waitFor(async () => {
        expect((await novelDb.memoryJobs.get(job.id))?.status).toBe("completed");
      }, { timeout: 4_000, interval: 100 });
    } finally {
      stop();
    }
  });

  it("serializes concurrent idempotent job scheduling", async () => {
    const { project } = await seed();
    const params = { projectId: project.id, jobType: "embedding" as const, idempotencyKey: "embedding:concurrent", payload: { targetTable: "conversationMemories", targetId: "m1", content: "短句" } };
    const jobs = await Promise.all([scheduleMemoryJob(params), scheduleMemoryJob(params), scheduleMemoryJob(params)]);
    expect(new Set(jobs.map((item) => item.id)).size).toBe(1);
    expect(await novelDb.memoryJobs.where("idempotencyKey").equals(params.idempotencyKey).count()).toBe(1);
  });

  it("does not retrieve task-scoped memory from another chapter thread", async () => {
    const { project, first, second } = await seed();
    const firstThread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
    const secondThread = await service.getOrCreateThread({ projectId: project.id, targetDocumentId: second.id });
    await novelDb.conversationMemories.add({ ...recordBase(project.id), id: "first-only", threadId: firstThread.id, targetId: first.id, scope: "task", scopeKey: `thread:${firstThread.id}`, kind: "constraint", title: "第一章限制", content: "第一章必须出现蓝色信封", status: "active", confidence: 1, sourceMessageIds: [], evidenceQuotes: [], extractorVersion: "test", autoApplied: false });
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({ data: { answer: "没有跨章引用。", enoughEvidence: true, followUpQueries: [], preferenceMemories: [], canonicalChangeRequests: [], briefPatch: {} }, usage: { inputTokens: 0, outputTokens: 0 }, promptHash: "isolation" });
    const result = await service.runConversationTurn({ threadId: secondThread.id, content: "蓝色信封有什么限制？" });
    expect(result.retrievalRun.selectedSourceIds).not.toContain("first-only");
  });

  it("provides an HTTP authority adapter that refreshes the Dexie working set", async () => {
    const { project, first } = await seed();
    const remoteThread = { ...recordBase(project.id), taskKey: "chapter-workflow" as const, targetId: first.id, title: "远端线程", summary: "", status: "active" as const, pinnedSourceIds: [], excludedSourceIds: [], lastMessageAt: Date.now() };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(remoteThread), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      const http = new HttpNovelMemoryService("https://memory.example.test", () => "token");
      const resolved = await http.getOrCreateThread({ projectId: project.id, targetDocumentId: first.id });
      expect(resolved.id).toBe(remoteThread.id);
      expect((await novelDb.conversationThreads.get(remoteThread.id))?.title).toBe("远端线程");
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/novel-memory/threads:resolve"), expect.objectContaining({ method: "POST" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
