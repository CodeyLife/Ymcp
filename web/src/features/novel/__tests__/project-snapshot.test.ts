import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NovelDatabase } from "../db";
import {
  captureProjectSnapshot,
  createExperimentDatabase,
  restoreProjectSnapshot,
  verifyProjectSnapshot,
  type ProjectSnapshotBundle,
} from "../evaluation/project-snapshot";
import {
  loadProjectSnapshotIntoExperiment,
  recaptureExperimentSnapshot,
} from "../evaluation/experiment-workspace";

const PROJECT_ID = "real-project-1";

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

async function seedCanonicalProject(db: NovelDatabase) {
  await db.table("projects").put({
    id: PROJECT_ID,
    schemaVersion: 8,
    revision: 4,
    createdAt: 1,
    updatedAt: 100,
    createdBy: "test",
    updatedBy: "test",
    title: "真实长篇",
    subtitle: "",
    premise: "测试真实项目快照",
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
  await db.table("architectures").put({
    ...baseRecord("architecture-1"),
    framework: "free",
    status: "approved",
    centralQuestion: "如何选择",
    centralConflict: "守诺与求生",
    synopsis: "",
    phases: [],
  });
  await db.table("entities").put({
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
      state: { location: "渡口", physical: "健康", emotional: "警惕", objective: "过河", inventory: [], relationshipNotes: [] },
    },
  });
  await db.table("documents").put({
    ...baseRecord("chapter-1"),
    order: 0,
    title: "第一章",
    blueprint: { goal: "抵达渡口", tone: "冷", mustHappen: [], forbidden: [], targetWords: 3000, beats: [], characterIds: [] },
    contentHtml: "<p>江水很冷。</p>",
    plainText: "江水很冷。",
    summary: "沈砚抵达渡口。",
    status: "final",
    wordCount: 6,
    branch: "main",
    yjsDocumentId: "yjs-chapter-1",
    approvedRevisionId: "revision-1",
  });
  await db.table("revisions").put({
    ...baseRecord("revision-1"),
    documentId: "chapter-1",
    label: "第一章定稿",
    contentHtml: "<p>江水很冷。</p>",
    plainText: "江水很冷。",
    source: "ai",
    branch: "main",
    approvalStatus: "approved",
    approvedAt: 100,
    contentHash: "existing-hash",
  });
  await db.table("skills").put({
    ...baseRecord("skill-1"),
    skillId: "project-style",
    projectId: PROJECT_ID,
    version: "1.0.0",
    name: "项目文风",
    description: "项目专属文风",
    locale: "zh-CN",
    source: "project",
    category: "drafting",
    stages: ["drafting"],
    enabled: true,
    priority: 10,
    requires: [],
    conflicts: [],
    prompt: "保持克制。",
    qualityChecks: [],
  });
  await db.table("projectSkills").put({
    ...baseRecord("binding-1"),
    skillId: "project-style",
    enabled: true,
    config: {},
  });
  await db.table("conversationMemories").put({
    ...baseRecord("conversation-memory-1"),
    threadId: "thread-1",
    targetId: "chapter-1",
    scope: "project",
    scopeKey: `project:${PROJECT_ID}`,
    kind: "preference",
    title: "叙述偏好",
    content: "保持克制的第三人称限知。",
    status: "active",
    confidence: 0.95,
    sourceMessageIds: ["message-1"],
    evidenceQuotes: ["不要替人物解释情绪"],
    extractorVersion: "test",
    autoApplied: false,
  });
  await db.table("workflowRuns").put({
    ...baseRecord("old-run"),
    workflowId: "chapter-production-v1",
    targetDocumentId: "chapter-1",
    status: "completed",
    currentStage: "commit",
    stageIndex: 11,
    revisionIteration: 0,
    factCandidateIds: [],
    startedAt: 50,
    finishedAt: 90,
  });
}

describe("real project evaluation snapshot", () => {
  let canonical: NovelDatabase;
  let experiment: NovelDatabase;

  beforeEach(async () => {
    canonical = new NovelDatabase(`ymcp-novel-canonical-test-${crypto.randomUUID()}`);
    experiment = createExperimentDatabase(`roundtrip-${crypto.randomUUID()}`);
    await canonical.open();
    await experiment.open();
    await seedCanonicalProject(canonical);
  });

  afterEach(async () => {
    await canonical.delete();
    await experiment.delete();
  });

  it("round-trips canonical records through an isolated experiment database", async () => {
    const before = await captureProjectSnapshot(canonical, PROJECT_ID, "manual");
    const verification = await verifyProjectSnapshot(before);

    expect(verification.valid).toBe(true);
    expect(before.records.projects).toHaveLength(1);
    expect(before.records.documents).toHaveLength(1);
    expect(before.records.skills).toHaveLength(1);
    expect(before.records.conversationMemories).toHaveLength(1);
    expect("workflowRuns" in before.records).toBe(false);

    await restoreProjectSnapshot(before, experiment);
    const after = await captureProjectSnapshot(experiment, PROJECT_ID, "replay");

    expect(after.manifest.snapshotHash).toBe(before.manifest.snapshotHash);
    expect(after.manifest.tableHashes).toEqual(before.manifest.tableHashes);
    expect(await experiment.conversationMemories.get("conversation-memory-1")).toBeDefined();
  });

  it("marks the project snapshot stale when active conversation memory changes", async () => {
    const before = await captureProjectSnapshot(canonical, PROJECT_ID, "manual");
    await canonical.conversationMemories.update("conversation-memory-1", {
      content: "改为第一人称，并保留更多内心独白。",
      revision: 2,
      updatedAt: 200,
    });
    const after = await captureProjectSnapshot(canonical, PROJECT_ID, "manual");

    expect(after.manifest.tableHashes.conversationMemories)
      .not.toBe(before.manifest.tableHashes.conversationMemories);
    expect(after.manifest.snapshotHash).not.toBe(before.manifest.snapshotHash);
  });

  it("detects any change to snapshot records", async () => {
    const snapshot = await captureProjectSnapshot(canonical, PROJECT_ID, "manual");
    const tampered = structuredClone(snapshot) as ProjectSnapshotBundle;
    const project = tampered.records.projects[0] as Record<string, unknown>;
    project.title = "被篡改的标题";

    const verification = await verifyProjectSnapshot(tampered);

    expect(verification.valid).toBe(false);
    expect(verification.issues).toContain("projects 表哈希不匹配");
    await expect(restoreProjectSnapshot(tampered, experiment)).rejects.toThrow(/校验失败/);
  });

  it("rejects records from another project", async () => {
    const snapshot = await captureProjectSnapshot(canonical, PROJECT_ID, "manual");
    const contaminated = structuredClone(snapshot) as ProjectSnapshotBundle;
    contaminated.records.entities[0].projectId = "other-project";

    const verification = await verifyProjectSnapshot(contaminated);

    expect(verification.valid).toBe(false);
    expect(verification.issues).toContain("entities 表包含其他项目的数据");
  });

  it("keeps experiment writes physically isolated from canonical data", async () => {
    const snapshot = await captureProjectSnapshot(canonical, PROJECT_ID, "manual");
    await restoreProjectSnapshot(snapshot, experiment);

    await experiment.documents.update("chapter-1", { plainText: "实验稿。" });

    expect((await experiment.documents.get("chapter-1"))?.plainText).toBe("实验稿。");
    expect((await canonical.documents.get("chapter-1"))?.plainText).toBe("江水很冷。");
  });

  it("refuses to restore into a non-experiment database", async () => {
    const snapshot = await captureProjectSnapshot(canonical, PROJECT_ID, "manual");

    await expect(restoreProjectSnapshot(snapshot, canonical)).rejects.toThrow(/实验数据库/);
  });
});

describe("experiment workspace loader", () => {
  let canonical: NovelDatabase;

  beforeEach(async () => {
    canonical = new NovelDatabase(`ymcp-novel-canonical-loader-test-${crypto.randomUUID()}`);
    await canonical.open();
    await seedCanonicalProject(canonical);
  });

  afterEach(async () => {
    await canonical.delete();
  });

  it("loads a snapshot into an isolated experiment workspace and exposes project metadata", async () => {
    const bundle = await captureProjectSnapshot(canonical, PROJECT_ID, "manual");

    const { workspace, verification } = await loadProjectSnapshotIntoExperiment(
      bundle,
      `loader-${crypto.randomUUID()}`,
    );

    try {
      expect(verification.valid).toBe(true);
      expect(workspace.projectId).toBe(PROJECT_ID);
      expect(workspace.baseSnapshotId).toBe(bundle.snapshotId);
      expect(workspace.baseSnapshotHash).toBe(bundle.manifest.snapshotHash);
      expect(workspace.experimentId).toBeTruthy();

      // 实验库中能读到与正式库相同的记录
      const project = await workspace.db.projects.get(PROJECT_ID);
      expect(project?.title).toBe("真实长篇");
      const document = await workspace.db.documents.get("chapter-1");
      expect(document?.plainText).toBe("江水很冷。");
      const skill = await workspace.db.skills.where("[projectId+skillId]").equals([PROJECT_ID, "project-style"]).first();
      expect(skill?.prompt).toBe("保持克制。");
    } finally {
      await workspace.delete();
    }
  });

  it("keeps canonical data untouched after loading into experiment workspace", async () => {
    const bundle = await captureProjectSnapshot(canonical, PROJECT_ID, "manual");
    const canonicalHashBefore = bundle.manifest.snapshotHash;

    const { workspace } = await loadProjectSnapshotIntoExperiment(
      bundle,
      `isolation-${crypto.randomUUID()}`,
    );

    try {
      // 在实验库中做任意写入
      await workspace.db.documents.update("chapter-1", { plainText: "实验中改写的内容。" });
      await workspace.db.skills.where("[projectId+skillId]").equals([PROJECT_ID, "project-style"]).first().then((s) => {
        if (s) return workspace.db.skills.update(s.id, { prompt: "实验中改写的 prompt。" });
        return undefined;
      });

      // 正式库数据完全不变
      const canonicalDoc = await canonical.documents.get("chapter-1");
      expect(canonicalDoc?.plainText).toBe("江水很冷。");
      const canonicalSkill = await canonical.skills.where("[projectId+skillId]").equals([PROJECT_ID, "project-style"]).first();
      expect(canonicalSkill?.prompt).toBe("保持克制。");

      // 重新捕获正式库快照,hash 应保持一致
      const reSnapshot = await captureProjectSnapshot(canonical, PROJECT_ID, "manual");
      expect(reSnapshot.manifest.snapshotHash).toBe(canonicalHashBefore);
    } finally {
      await workspace.delete();
    }
  });

  it("recaptures experiment state for pre-promotion verification", async () => {
    const bundle = await captureProjectSnapshot(canonical, PROJECT_ID, "manual");
    const { workspace } = await loadProjectSnapshotIntoExperiment(
      bundle,
      `recapture-${crypto.randomUUID()}`,
    );

    try {
      // 在实验库中改写正文
      await workspace.db.documents.update("chapter-1", { plainText: "迭代后的内容。" });

      // 重新捕获实验库快照
      const reSnapshot = await recaptureExperimentSnapshot(workspace, "manual");
      expect(reSnapshot.manifest.snapshotHash).not.toBe(bundle.manifest.snapshotHash);
      expect(reSnapshot.records.documents).toHaveLength(1);
      const doc = reSnapshot.records.documents[0] as { plainText?: string };
      expect(doc.plainText).toBe("迭代后的内容。");
    } finally {
      await workspace.delete();
    }
  });
});
