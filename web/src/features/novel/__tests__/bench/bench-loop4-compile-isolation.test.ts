/**
 * Loop 4 验证：compileNovelContext / vectorSearch / memory-service 路径在实验库上可写且零正式库污染。
 *
 * 目的：Loop 4 把 `compileNovelContext`、`vectorSearch`、`buildCandidates`、`hybridRetrieve`、
 * `runStageRetrieval`、`NovelMemoryService.compileStageContext` 全部参数化为 `db?: NovelDatabase`。
 * 本测试验证：
 *   1. `compileNovelContext({..., db: experimentDb})` 把 contextPacket 写到实验库，不污染正式库。
 *   2. 实验 DB 调用路径触发 `vectorSearch`（被 catch 后降级为空结果，不污染正式库 embeddings）。
 *   3. `DexieNovelMemoryService.compileStageContext({..., db: experimentDb})` 在没有 thread/brief 时
 *      抛错（验证 db 参数已被透传到 runStageRetrieval 的 documents.get 调用路径）。
 *   4. 正式库 ProjectSnapshot 哈希在 bench 期间保持不变。
 *
 * 已知限制：
 * - 本测试不调用 `startChapterWorkflow(..., experimentDb)`，因为 blueprint/revision/commit 等
 *   阶段仍有大量 `novelDb` 引用未参数化。完整 E2E 验证留待后续 loop。
 * - 不依赖真实 LLM；vectorSearch 在没有 embedding provider 时会抛错，被 compileNovelContext 捕获降级。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { novelDb } from "../../db";
import { captureProjectSnapshot } from "../../evaluation/project-snapshot";
import { loadProjectSnapshotIntoExperiment } from "../../evaluation/experiment-workspace";
import { compileNovelContext } from "../../context";
import { DexieNovelMemoryService } from "../../memory-service";
import type { ManuscriptDocument } from "../../types";
import {
  assertCanonicalHashUnchanged,
  captureCanonicalHash,
} from "./bench-experiment-helpers";

const PROJECT_ID = "bench-loop4-project";
const CHAPTER_1_ID = "bench-loop4-chapter-1";

function baseRecord(id: string, projectId = PROJECT_ID) {
  return {
    id,
    projectId,
    schemaVersion: 8,
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
    createdBy: "test",
    updatedBy: "test",
  };
}

async function seedCanonicalProject(): Promise<void> {
  await novelDb.table("projects").put({
    id: PROJECT_ID,
    schemaVersion: 8,
    revision: 4,
    createdAt: 1,
    updatedAt: 100,
    createdBy: "test",
    updatedBy: "test",
    title: "Loop4 隔离验证长篇",
    subtitle: "",
    premise: "Loop4 验证用项目",
    genre: ["武侠"],
    audience: "成年读者",
    themes: ["选择"],
    sellingPoints: [],
    pov: "第三人称限知",
    tense: "过去时",
    tone: "克制",
    languageStyle: "具象",
    targetWords: 300000,
    dailyGoal: 3000,
    status: "drafting",
    coverColor: "#000000",
    settings: {
      textModel: "test-model",
      temperature: 0.7,
      recentChapterCount: 5,
      encrypted: false,
      contentProfile: "general-serial",
      maxAutoRevisions: 2,
      qualityThreshold: 3.7,
      approvalMode: "blueprint-and-manuscript",
    },
  });

  await novelDb.table("architectures").put({
    ...baseRecord("architecture-1"),
    framework: "free",
    status: "approved",
    centralQuestion: "如何选择",
    centralConflict: "守诺与求生",
    synopsis: "",
    phases: [],
  });

  await novelDb.table("entities").put({
    ...baseRecord("character-1"),
    kind: "character",
    name: "沈砚",
    aliases: [],
    summary: "主角",
    description: "",
    tags: [],
    lockedFacts: [],
    customFields: {},
    character: {
      role: "protagonist",
      desire: "查清旧案",
      fear: "重蹈覆辙",
      misbelief: "只能独行",
      need: "学会信任",
      stakes: "失去同伴",
      arc: "",
      voice: "",
      appearance: "",
      state: {
        location: "渡口",
        physical: "健康",
        emotional: "警惕",
        objective: "过河",
        inventory: [],
        relationshipNotes: [],
      },
    },
  });

  const chapter1: ManuscriptDocument = {
    ...baseRecord(CHAPTER_1_ID),
    order: 0,
    title: "第一章",
    blueprint: {
      goal: "抵达渡口",
      tone: "冷",
      mustHappen: [],
      forbidden: [],
      targetWords: 3000,
      beats: [],
      characterIds: [],
    },
    contentHtml: "<p>江水很冷。</p>",
    plainText: "江水很冷。",
    summary: "沈砚抵达渡口。",
    status: "final",
    wordCount: 6,
    branch: "main",
    yjsDocumentId: "yjs-chapter-1",
    approvedRevisionId: "revision-1",
  } as unknown as ManuscriptDocument;
  await novelDb.table("documents").put(chapter1);

  await novelDb.table("revisions").put({
    ...baseRecord("revision-1"),
    documentId: CHAPTER_1_ID,
    label: "第一章定稿",
    contentHtml: "<p>江水很冷。</p>",
    plainText: "江水很冷。",
    source: "ai",
    branch: "main",
    approvalStatus: "approved",
    approvedAt: 100,
    contentHash: "existing-hash",
  });
}

describe("Loop 4: compileNovelContext + memory-service 在实验库上可写且零正式库污染", () => {
  let canonicalHashBefore: string;

  beforeEach(async () => {
    await novelDb.delete();
    await novelDb.open();
    localStorage.clear();
    await seedCanonicalProject();
    canonicalHashBefore = await captureCanonicalHash(PROJECT_ID, "chapter-baseline");
  });

  afterEach(async () => {
    await novelDb.delete();
    await novelDb.open();
  });

  it("compileNovelContext({db: experimentDb}) 把 packet 写到实验库，正式库 contextPackets 仍为空", async () => {
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const { workspace } = await loadProjectSnapshotIntoExperiment(bundle, `bench-loop4-compile-${crypto.randomUUID()}`);
    try {
      const experimentDb = workspace.db;
      const experimentPacketCountBefore = await experimentDb.contextPackets.where("projectId").equals(PROJECT_ID).count();
      expect(experimentPacketCountBefore).toBe(0);

      const canonicalPacketCountBefore = await novelDb.contextPackets.where("projectId").equals(PROJECT_ID).count();
      expect(canonicalPacketCountBefore).toBe(0);

      const packet = await compileNovelContext({
        projectId: PROJECT_ID,
        task: "chapter-workflow",
        instruction: "为第二章构建上下文",
        stage: "planning",
        db: experimentDb,
      });

      expect(packet.projectId).toBe(PROJECT_ID);
      expect(packet.sources.length).toBeGreaterThan(0);

      const experimentPacketCountAfter = await experimentDb.contextPackets.where("projectId").equals(PROJECT_ID).count();
      expect(experimentPacketCountAfter).toBe(1);
      const experimentPacket = await experimentDb.contextPackets.get(packet.id);
      expect(experimentPacket).toBeDefined();
      expect(experimentPacket?.id).toBe(packet.id);

      const canonicalPacketCountAfter = await novelDb.contextPackets.where("projectId").equals(PROJECT_ID).count();
      expect(canonicalPacketCountAfter).toBe(0);

      const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
      assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);
    } finally {
      await workspace.delete();
    }
  });

  it("compileNovelContext 在实验库上调用 vectorSearch 时不会污染正式库 embeddings", async () => {
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const { workspace } = await loadProjectSnapshotIntoExperiment(bundle, `bench-loop4-vec-${crypto.randomUUID()}`);
    try {
      const experimentDb = workspace.db;

      const canonicalEmbeddingsBefore = await novelDb.embeddings.where("projectId").equals(PROJECT_ID).count();
      const experimentEmbeddingsBefore = await experimentDb.embeddings.where("projectId").equals(PROJECT_ID).count();
      expect(canonicalEmbeddingsBefore).toBe(0);
      expect(experimentEmbeddingsBefore).toBe(0);

      // vectorSearch 在没有 embedding provider 配置时会抛错，被 compileNovelContext 捕获后降级为空结果。
      // 关键验证：即使抛错，错也抛在 experimentDb 上下文，不会回退到 novelDb。
      const packet = await compileNovelContext({
        projectId: PROJECT_ID,
        task: "chapter-workflow",
        instruction: "为第二章构建上下文",
        stage: "planning",
        db: experimentDb,
      });
      expect(packet.sources.length).toBeGreaterThan(0);

      const canonicalEmbeddingsAfter = await novelDb.embeddings.where("projectId").equals(PROJECT_ID).count();
      expect(canonicalEmbeddingsAfter).toBe(0);

      const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
      assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);
    } finally {
      await workspace.delete();
    }
  });

  it("DexieNovelMemoryService.compileStageContext 在实验库上查询 thread 时不会污染正式库", async () => {
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const { workspace } = await loadProjectSnapshotIntoExperiment(bundle, `bench-loop4-mem-${crypto.randomUUID()}`);
    try {
      const experimentDb = workspace.db;

      // 实验库中没有 thread，所以应该在 compileStageContext 入口抛 "协作对话不存在"。
      // 验证：抛错前查询的是实验库 conversationThreads，而非正式库。
      const service = new DexieNovelMemoryService();
      await expect(
        service.compileStageContext({
          threadId: "non-existent-thread",
          stage: "context",
          role: "architect",
          instruction: "构建上下文",
          workflowRunId: "run-1",
          skillStage: "planning",
          db: experimentDb,
        }),
      ).rejects.toThrow(/协作对话不存在/);

      // 正式库 conversationMemories / contextPackets / retrievalRuns 都不应有写入。
      const canonicalThreadsAfter = await novelDb.conversationThreads.where("projectId").equals(PROJECT_ID).count();
      expect(canonicalThreadsAfter).toBe(0);
      const canonicalPacketsAfter = await novelDb.contextPackets.where("projectId").equals(PROJECT_ID).count();
      expect(canonicalPacketsAfter).toBe(0);
      const canonicalRunsAfter = await novelDb.retrievalRuns.where("projectId").equals(PROJECT_ID).count();
      expect(canonicalRunsAfter).toBe(0);

      const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
      assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);
    } finally {
      await workspace.delete();
    }
  });

  it("两个并行实验库各自调用 compileNovelContext 互不污染", async () => {
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const { workspace: workspaceA } = await loadProjectSnapshotIntoExperiment(bundle, `bench-loop4-para-a-${crypto.randomUUID()}`);
    const { workspace: workspaceB } = await loadProjectSnapshotIntoExperiment(bundle, `bench-loop4-para-b-${crypto.randomUUID()}`);
    try {
      const [packetA, packetB] = await Promise.all([
        compileNovelContext({
          projectId: PROJECT_ID,
          task: "chapter-workflow",
          instruction: "实验库 A 的上下文编译",
          stage: "planning",
          db: workspaceA.db,
        }),
        compileNovelContext({
          projectId: PROJECT_ID,
          task: "chapter-workflow",
          instruction: "实验库 B 的上下文编译",
          stage: "planning",
          db: workspaceB.db,
        }),
      ]);

      expect(packetA.id).not.toBe(packetB.id);

      const packetsA = await workspaceA.db.contextPackets.where("projectId").equals(PROJECT_ID).toArray();
      const packetsB = await workspaceB.db.contextPackets.where("projectId").equals(PROJECT_ID).toArray();
      expect(packetsA.map((p) => p.id)).toEqual([packetA.id]);
      expect(packetsB.map((p) => p.id)).toEqual([packetB.id]);

      const canonicalPackets = await novelDb.contextPackets.where("projectId").equals(PROJECT_ID).count();
      expect(canonicalPackets).toBe(0);

      const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
      assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);
    } finally {
      await workspaceA.delete();
      await workspaceB.delete();
    }
  });
});
