/**
 * 实验 DB 工作流隔离验证（goal novel-eval-loop Loop 3）。
 *
 * 目的：在不依赖真实 LLM 的前提下，验证 Loop 2 注入的 workspace seam 能让
 * workflow-shared.ts 的 8 个助手 + workflow.ts 的入口函数 + 持久化助手
 * 在物理隔离的实验库上正确写入，且正式库（global novelDb）的 ProjectSnapshot
 * 哈希在 bench 期间保持不变——这是"零正式库污染"的结构性证据。
 *
 * 已知限制：novelMemoryService 单例 + compileNovelContext 仍硬编码到 global novelDb，
 * 所以本测试不调用 startChapterWorkflow（它会触发 context-stage.ts 调用 novelMemoryService）。
 * 完整章节工作流在实验库上的端到端验证留待 novelMemoryService 重构后的后续 loop。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendOperation,
  documentContentHash,
  novelDb,
  recordBase,
  saveApprovedDocumentRevision,
} from "../../db";
import { captureProjectSnapshot } from "../../evaluation/project-snapshot";
import { loadProjectSnapshotIntoExperiment } from "../../evaluation/experiment-workspace";
import { setEmbeddingProvider } from "../../embedding";
import {
  createApprovalProposal,
  createAgentRecord,
  failAgent,
  failRun,
  finishAgent,
  latestArtifact,
  saveArtifact,
  transition,
} from "../../workflow-shared";
import {
  assertPrecedingChaptersFinal,
  cancelWorkflow,
  listDocumentWorkflowRuns,
  pauseWorkflow,
  resumeWorkflow,
} from "../../workflow";
import type { ManuscriptDocument, WorkflowRun } from "../../types";
import {
  assertCanonicalHashUnchanged,
  captureCanonicalHash,
} from "./bench-experiment-helpers";

const PROJECT_ID = "bench-exp-project";
const CHAPTER_1_ID = "bench-exp-chapter-1";
const CHAPTER_2_ID = "bench-exp-chapter-2";

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

/**
 * 种子化正式库（global novelDb）：1 个项目 + 2 个章节 + 1 个角色 + 1 个架构。
 *
 * 不调用 createNovelProject/createChapter，直接 table.put，避免触发衍生副作用。
 * 这个种子化模式与 project-snapshot.test.ts 的 seedCanonicalProject 保持一致，
 * 但写入目标是 global novelDb（生产环境的正式库），以便本测试模拟真实的 bench 场景。
 */
async function seedCanonicalProject(): Promise<void> {
  await novelDb.table("projects").put({
    id: PROJECT_ID,
    schemaVersion: 8,
    revision: 4,
    createdAt: 1,
    updatedAt: 100,
    createdBy: "test",
    updatedBy: "test",
    title: "Bench 实验 DB 验证长篇",
    subtitle: "",
    premise: "Bench 隔离验证用项目",
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

  // 第二章：未定稿，用于 assertPrecedingChaptersFinal 反向验证
  const chapter2: ManuscriptDocument = {
    ...baseRecord(CHAPTER_2_ID),
    order: 1,
    title: "第二章",
    blueprint: {
      goal: "过江",
      tone: "冷",
      mustHappen: [],
      forbidden: [],
      targetWords: 3000,
      beats: [],
      characterIds: [],
    },
    contentHtml: "",
    plainText: "",
    summary: "",
    status: "draft",
    wordCount: 0,
    branch: "main",
  } as unknown as ManuscriptDocument;
  await novelDb.table("documents").put(chapter2);
}

function buildRun(targetDocumentId: string, projectId = PROJECT_ID): WorkflowRun {
  return {
    ...recordBase(projectId),
    workflowId: "standard-chapter-v2",
    targetDocumentId,
    status: "running",
    currentStage: "blueprint",
    stageIndex: 1,
    revisionIteration: 0,
    factCandidateIds: [],
    startedAt: Date.now(),
  };
}

describe("bench-experiment-workflow: 实验 DB 隔离工作流验证", () => {
  let canonicalHashBefore: string;

  beforeEach(async () => {
    await novelDb.delete();
    await novelDb.open();
    localStorage.clear();
    await seedCanonicalProject();
    canonicalHashBefore = await captureCanonicalHash(PROJECT_ID, "chapter-baseline");
  });

  afterEach(async () => {
    // novelDb 会在下一次 beforeEach 中重置；这里不主动清理
  });

  it("workflow-shared.ts 8 个助手接受 experiment DB 参数且零正式库污染", async () => {
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const { workspace } = await loadProjectSnapshotIntoExperiment(
      bundle,
      `bench-exp-shared-${crypto.randomUUID()}`,
    );

    try {
      const { db } = workspace;

      // 验证实验库已恢复正式库快照
      const projectInExp = await db.projects.get(PROJECT_ID);
      expect(projectInExp?.title).toBe("Bench 实验 DB 验证长篇");
      const docInExp = await db.documents.get(CHAPTER_1_ID);
      expect(docInExp?.plainText).toBe("江水很冷。");

      // 1. saveArtifact：写入实验库
      const run = buildRun(CHAPTER_1_ID);
      await db.workflowRuns.add(run);

      const artifact = await saveArtifact(
        run,
        {
          projectId: PROJECT_ID,
          workflowRunId: run.id,
          stage: "blueprint",
          kind: "blueprint",
          title: "蓝图测试",
          contentMarkdown: "## 蓝图\n测试内容",
          structuredData: {},
          skillRefs: [],
        },
        db,
      );
      expect(artifact.workflowRunId).toBe(run.id);
      expect(artifact.id).toContain(run.id);

      // 2. latestArtifact：从实验库读取
      const found = await latestArtifact(run.id, ["blueprint"], db);
      expect(found?.id).toBe(artifact.id);

      // 3. transition：写入实验库
      const next = await transition(run, "draft", "running", {}, db);
      expect(next.currentStage).toBe("draft");
      const dbRun = await db.workflowRuns.get(run.id);
      expect(dbRun?.currentStage).toBe("draft");

      // 4. createAgentRecord：写入实验库
      const { agent } = await createAgentRecord(
        { run: next, role: "writer", goal: "撰写正文", skillRefs: [] },
        db,
      );
      expect(agent.workflowRunId).toBe(run.id);
      const agentInExp = await db.agentRuns.get(agent.id);
      expect(agentInExp?.status).toBe("running");

      // 5. finishAgent：写入实验库
      await finishAgent(agent, { promptHash: "test-hash" }, db);
      const finished = await db.agentRuns.get(agent.id);
      expect(finished?.status).toBe("completed");
      expect(finished?.promptHash).toBe("test-hash");

      // 6. failAgent：写入实验库
      const failedAgent = {
        ...agent,
        id: "agent-fail-test",
        status: "running" as const,
        revision: 1,
      };
      await db.agentRuns.add(failedAgent);
      await failAgent(failedAgent, new Error("test failure"), db);
      const failed = await db.agentRuns.get("agent-fail-test");
      expect(failed?.status).toBe("failed");

      // 7. failRun：写入实验库
      const failedRun = await failRun(next, new Error("workflow failure"), db);
      expect(failedRun.status).toBe("failed");
      const finalRun = await db.workflowRuns.get(run.id);
      expect(finalRun?.status).toBe("failed");

      // 8. createApprovalProposal：写入实验库
      // 用一个未失败的 run 上下文（创建 proposal 不依赖 run.status）
      const proposalRun = buildRun(CHAPTER_1_ID);
      proposalRun.id = "run-for-proposal";
      await db.workflowRuns.add(proposalRun);
      const proposal = await createApprovalProposal(
        proposalRun,
        artifact,
        "approve-blueprint",
        "批准蓝图",
        db,
      );
      expect(proposal.targetId).toBe(proposalRun.id);
      const proposalInExp = await db.proposals.get(proposal.id);
      expect(proposalInExp).toBeTruthy();

      // 断言正式库零污染
      const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
      assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);
    } finally {
      await workspace.delete();
    }
  });

  it("persistence helpers (appendOperation, saveApprovedDocumentRevision) 接受 experiment DB 参数", async () => {
    setEmbeddingProvider({
      name: "experiment-isolation-test",
      dimension: 2,
      embed: async () => [1, 0],
      embedBatch: async (texts) => texts.map(() => [1, 0]),
    });
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const { workspace } = await loadProjectSnapshotIntoExperiment(
      bundle,
      `bench-exp-persist-${crypto.randomUUID()}`,
    );

    try {
      const { db } = workspace;

      // 1. appendOperation：写入实验库 operations 表
      await appendOperation(
        PROJECT_ID,
        "documents",
        CHAPTER_1_ID,
        "update",
        { plainText: { before: "江水很冷。", after: "江水很冷，对岸有灯火。" } },
        db,
      );
      // operations 表按 projectId 索引（无 entityId 索引），按 projectId 查询后过滤
      const opsInExp = await db.operations
        .where("projectId")
        .equals(PROJECT_ID)
        .filter((op) => op.entityId === CHAPTER_1_ID)
        .toArray();
      expect(opsInExp).toHaveLength(1);
      expect(opsInExp[0]?.action).toBe("update");

      // 2. saveApprovedDocumentRevision：写入实验库 documents + revisions + operations
      const docBefore = await db.documents.get(CHAPTER_1_ID);
      expect(docBefore).toBeTruthy();
      const updatedDoc: ManuscriptDocument = {
        ...(docBefore as unknown as ManuscriptDocument),
        contentHtml: "<p>江水很冷，对岸有灯火。</p>",
        plainText: "江水很冷，对岸有灯火。",
      } as unknown as ManuscriptDocument;

      await saveApprovedDocumentRevision(
        updatedDoc,
        "实验库修订",
        "ai",
        {
          expected: {
            documentRevision: docBefore?.revision ?? 1,
            contentHash: documentContentHash(docBefore as unknown as ManuscriptDocument),
            approvedRevisionId: docBefore?.approvedRevisionId,
          },
        },
        db,
      );

      // 验证实验库中的 document 已更新
      const docAfter = await db.documents.get(CHAPTER_1_ID);
      expect(docAfter?.plainText).toBe("江水很冷，对岸有灯火。");
      expect(docAfter?.revision).toBe((docBefore?.revision ?? 1) + 1);

      // 验证实验库中新增了 revision 记录
      const revisionsInExp = await db.revisions.where("documentId").equals(CHAPTER_1_ID).toArray();
      expect(revisionsInExp.length).toBeGreaterThanOrEqual(2); // 原 revision-1 + 新 approvedRevision

      await vi.waitFor(async () => {
        expect(await db.embeddings.where("projectId").equals(PROJECT_ID).count()).toBeGreaterThan(0);
      });
      expect(await novelDb.embeddings.where("projectId").equals(PROJECT_ID).count()).toBe(0);

      // 断言正式库零污染，包括快照未覆盖的 embeddings 表
      const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
      assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);
    } finally {
      await workspace.delete();
    }
  });

  it("workflow.ts 入口函数 (listDocumentWorkflowRuns, assertPrecedingChaptersFinal, pause/resume/cancel) 接受 experiment DB 参数", async () => {
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const { workspace } = await loadProjectSnapshotIntoExperiment(
      bundle,
      `bench-exp-entry-${crypto.randomUUID()}`,
    );

    try {
      const { db } = workspace;

      // 1. assertPrecedingChaptersFinal：第二章应当被第一章（final）阻挡 → 通过
      // 注意：chapter1.status = "final" 在快照中已设置
      await expect(assertPrecedingChaptersFinal(PROJECT_ID, CHAPTER_2_ID, db)).resolves.toBeUndefined();

      // 若把 chapter1 改成 draft，应抛错
      await db.documents.update(CHAPTER_1_ID, { status: "draft" });
      await expect(assertPrecedingChaptersFinal(PROJECT_ID, CHAPTER_2_ID, db)).rejects.toThrow(/前章正文与事实未定稿/);
      // 恢复 chapter1 状态供后续测试使用
      await db.documents.update(CHAPTER_1_ID, { status: "final" });

      // 2. listDocumentWorkflowRuns：在实验库中查找 chapter1 的 workflow runs
      const run = buildRun(CHAPTER_1_ID);
      await db.workflowRuns.add(run);
      const runs = await listDocumentWorkflowRuns(PROJECT_ID, CHAPTER_1_ID, db);
      expect(runs.map((r) => r.id)).toContain(run.id);

      // 3. pauseWorkflow：写入实验库
      const paused = await pauseWorkflow(run.id, db);
      expect(paused?.status).toBe("paused");
      const dbRun = await db.workflowRuns.get(run.id);
      expect(dbRun?.status).toBe("paused");

      // 4. resumeWorkflow：写入实验库
      // 用 approval stage 测试 resume 的 status 切换：approval stage 不会触发 advance，
      // 仅 transition 到 waiting-approval，避免依赖未注册的 stage handler
      const approvalRun: WorkflowRun = {
        ...recordBase(PROJECT_ID),
        id: "run-approval-test",
        workflowId: "standard-chapter-v2",
        targetDocumentId: CHAPTER_1_ID,
        status: "paused",
        currentStage: "blueprint-approval",
        stageIndex: 2,
        revisionIteration: 0,
        factCandidateIds: [],
        startedAt: Date.now(),
      };
      await db.workflowRuns.add(approvalRun);
      const resumed = await resumeWorkflow(approvalRun.id, db);
      expect(resumed?.status).toBe("waiting-approval");

      // 5. cancelWorkflow：写入实验库（用另一个 paused run 测试 cancel）
      const cancellableRun: WorkflowRun = {
        ...recordBase(PROJECT_ID),
        id: "run-cancel-test",
        workflowId: "standard-chapter-v2",
        targetDocumentId: CHAPTER_1_ID,
        status: "running",
        currentStage: "draft",
        stageIndex: 3,
        revisionIteration: 0,
        factCandidateIds: [],
        startedAt: Date.now(),
      };
      await db.workflowRuns.add(cancellableRun);
      const cancelled = await cancelWorkflow(cancellableRun.id, db);
      expect(cancelled?.status).toBe("cancelled");
      const finalRun = await db.workflowRuns.get(cancellableRun.id);
      expect(finalRun?.status).toBe("cancelled");

      // 断言正式库零污染
      const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
      assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);
    } finally {
      await workspace.delete();
    }
  });

  it("多个实验库并行存在且互不污染", async () => {
    // 验证同时存在两个实验库，对其中一个的写入不影响另一个
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const { workspace: ws1 } = await loadProjectSnapshotIntoExperiment(
      bundle,
      `bench-exp-parallel-1-${crypto.randomUUID()}`,
    );
    const { workspace: ws2 } = await loadProjectSnapshotIntoExperiment(
      bundle,
      `bench-exp-parallel-2-${crypto.randomUUID()}`,
    );

    try {
      // 在 ws1 中改写 chapter1 正文
      await ws1.db.documents.update(CHAPTER_1_ID, { plainText: "实验库 1 的改写。" });
      // 在 ws2 中改写 chapter1 正文为不同内容
      await ws2.db.documents.update(CHAPTER_1_ID, { plainText: "实验库 2 的改写。" });

      // 各自的实验库独立
      const docInWs1 = await ws1.db.documents.get(CHAPTER_1_ID);
      const docInWs2 = await ws2.db.documents.get(CHAPTER_1_ID);
      expect(docInWs1?.plainText).toBe("实验库 1 的改写。");
      expect(docInWs2?.plainText).toBe("实验库 2 的改写。");

      // 正式库完全不受影响
      const canonicalDoc = await novelDb.documents.get(CHAPTER_1_ID);
      expect(canonicalDoc?.plainText).toBe("江水很冷。");

      // 正式库哈希不变
      const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
      assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);
    } finally {
      await ws1.delete();
      await ws2.delete();
    }
  });
});
