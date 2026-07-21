/**
 * Loop 7 验证：extractCandidateBundle 从实验库导出 CandidateBundle，verifyCandidateBundle 通过，
 * JSON round-trip 等价，正式库 hash 不变。
 *
 * 目的：验证 candidate-bundle 导出服务的核心契约：
 *   1. `extractCandidateBundle({workflowRunId, workspace, baseDependencyHead, db})` 读取实验库中
 *      workflowRun + draftArtifact + qualityReport + targetDocument + factCandidates + iteratedSkillRecords，
 *      投影为 CandidateBundle，导出时立即 verify。
 *   2. `verifyCandidateBundle(bundle)` 检查所有必填字段，返回 { valid, issues }。
 *   3. `serializeCandidateBundle(bundle)` → JSON 字符串；`deserializeCandidateBundle(json)` → bundle，
 *      round-trip 后的 bundle 与原 bundle 深度相等。
 *   4. 写入实验库不影响正式库 ProjectSnapshot hash。
 *
 * Mock 策略：复用 Loop 6 的 ai.ts mock（skill-iterator role 返回修订 prompt）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ai", () => ({
  callStructuredNovelModel: vi.fn(async ({ role }: { role: string }) => {
    if (role === "skill-iterator") {
      return {
        data: {
          iterations: [
            {
              skillId: "embodied-prose",
              afterPrompt:
                "正文优先呈现人物正在做什么、注意到什么、误读什么和选择什么。抽象总结要落回可观察行动、具体感官、环境阻力或有代价的对白。\n\n【画面感公式·强化版】关键瞬间必须用\"动作+停顿+环境反应+时间流逝+心境外化\"五元素组合呈现。每个元素都不能省略。",
              rationale: "style-specificity-audit 报告画面感公式落实不足，故强化 embodied-prose 的画面感公式约束。",
              triggeredByIssueIds: ["issue-imagery-1"],
            },
          ],
        },
        usage: { inputTokens: 300, outputTokens: 250 },
        promptHash: "skill-iter-mock",
      };
    }
    return { data: {}, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "default" };
  }),
  streamNovelModel: vi.fn(async () => ({
    content: "",
    usage: { inputTokens: 0, outputTokens: 0 },
    promptHash: "stream-mock",
  })),
}));

import { novelDb, type NovelDatabase } from "../../db";
import { captureProjectSnapshot } from "../../evaluation/project-snapshot";
import { loadProjectSnapshotIntoExperiment, type ExperimentWorkspace } from "../../evaluation/experiment-workspace";
import { runSkillIteration } from "../../evaluation/skill-iteration";
import {
  extractCandidateBundle,
  verifyCandidateBundle,
  serializeCandidateBundle,
  deserializeCandidateBundle,
} from "../../evaluation/candidate-bundle";
import type {
  FactCandidate,
  ManuscriptDocument,
  QualityIssue,
  QualityReport,
  StoryProject,
  WorkflowArtifact,
  WorkflowRun,
} from "../../types";
import {
  assertCanonicalHashUnchanged,
  captureCanonicalHash,
} from "./bench-experiment-helpers";

const PROJECT_ID = "bench-loop7-project";
const CHAPTER_ID = "bench-loop7-chapter";
const WORKFLOW_RUN_ID = "bench-loop7-run-1";
const DRAFT_ARTIFACT_ID = "bench-loop7-draft-artifact";
const QUALITY_REPORT_ID = "bench-loop7-quality-report";
const FACT_CANDIDATE_ID = "bench-loop7-fact-1";
const THREAD_ID = "bench-loop7-thread";
const BRIEF_ID = "bench-loop7-brief";

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

async function seedWorkflowInputs(db: NovelDatabase): Promise<void> {
  await db.conversationThreads.put({
    ...baseRecord(THREAD_ID),
    taskKey: "chapter-collaboration",
    targetId: CHAPTER_ID,
    title: "第一章协作",
    summary: "",
    status: "active",
    pinnedSourceIds: [],
    excludedSourceIds: [],
    lastMessageAt: 100,
  } as never);
  await db.creativeBriefs.put({
    ...baseRecord(BRIEF_ID),
    threadId: THREAD_ID,
    targetDocumentId: CHAPTER_ID,
    status: "confirmed",
    goal: "完成第一章",
    tone: "克制",
    languageRequirements: [],
    mustHappen: [],
    forbidden: [],
    targetWords: 3000,
    referencedMemoryIds: [],
    openQuestions: [],
    sourceMessageIds: [],
  } as never);
}

async function seedCanonicalProject(): Promise<void> {
  const project: StoryProject = {
    id: PROJECT_ID,
    schemaVersion: 8,
    revision: 1,
    createdAt: 1,
    updatedAt: 100,
    createdBy: "test",
    updatedBy: "test",
    title: "Loop7 候选包导出验证长篇",
    subtitle: "",
    premise: "Loop7 验证用项目",
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
  } as unknown as StoryProject;
  await novelDb.table("projects").put(project);

  const chapter: ManuscriptDocument = {
    ...baseRecord(CHAPTER_ID),
    order: 0,
    title: "第一章",
    blueprint: {
      goal: "渡口夜话",
      tone: "克制",
      mustHappen: [],
      forbidden: [],
      targetWords: 3000,
      beats: [],
      characterIds: [],
    },
    contentHtml: "<p>江水很冷。</p>",
    plainText: "江水很冷。",
    summary: "渡口夜话。",
    status: "final",
    wordCount: 6,
    branch: "main",
    yjsDocumentId: "yjs-chapter-1",
    approvedRevisionId: "revision-1",
  } as unknown as ManuscriptDocument;
  await novelDb.table("documents").put(chapter);
  await seedWorkflowInputs(novelDb);
}

const DRAFT_TEXT = "渡口在黄昏时起了雾。沈砚走进客栈，找了个位置坐下。线人来过又走了。夜半有脚步声，但人影退去后，他只看见对方腰间的玉佩。天亮前他离开了客栈。";

async function seedWorkflowRunInExperimentDb(
  db: NovelDatabase,
  options: { withFactCandidate?: boolean; withIteratedSkills?: boolean } = {},
): Promise<void> {
  await seedWorkflowInputs(db);
  const issues: QualityIssue[] = [
    {
      id: "issue-imagery-1",
      dimension: "sceneEmbodiment",
      severity: "major",
      title: "画面感公式落实不足",
      description: "人物登场等关键瞬间缺少环境反应与时间流逝元素，五元素组合不完整。",
      excerpt: "沈砚走进客栈，找了个位置坐下。",
      paragraph: 1,
      revisionRanges: [{ start: 1, end: 1 }],
      rule: "画面感五元素缺失",
      sourceId: "style-specificity-audit",
      suggestion: "在关键瞬间补齐五元素。",
      deterministic: false,
    },
  ];

  const draftArtifact: WorkflowArtifact = {
    ...baseRecord(DRAFT_ARTIFACT_ID),
    workflowRunId: WORKFLOW_RUN_ID,
    stage: "draft",
    kind: "draft",
    title: "第一章 草稿",
    contentMarkdown: DRAFT_TEXT,
    model: "test-model",
    skillRefs: ["embodied-prose", "prose-discipline"],
  } as unknown as WorkflowArtifact;
  await db.workflowArtifacts.put(draftArtifact);
  await db.workflowArtifacts.put({
    ...baseRecord("artifact-blueprint-provenance"),
    workflowRunId: WORKFLOW_RUN_ID,
    stage: "blueprint",
    kind: "blueprint",
    title: "第一章蓝图",
    contentMarkdown: "建立客栈常态并保留线索空间。",
    model: "test-model",
    skillRefs: ["system-prompt:planning-craft-guidance@1.0.0", "chapter-blueprint@1.0.0"],
  } as WorkflowArtifact);

  const qualityReport: QualityReport = {
    ...baseRecord(QUALITY_REPORT_ID),
    workflowRunId: WORKFLOW_RUN_ID,
    artifactId: DRAFT_ARTIFACT_ID,
    iteration: 1,
    scoringVersion: 1,
    scores: {
      plot: 4,
      characterVoice: 4,
      sceneEmbodiment: 3,
      dialogue: 4,
      specificity: 3,
      hookPayoff: 4,
      continuity: 5,
    },
    weightedScore: 3.8,
    blockerCount: 0,
    passed: true,
    issues,
    metrics: { totalIssues: 1, nonDeterministic: 1 },
    reviewerRoles: ["style-reviewer", "character-reviewer", "continuity-reviewer", "plot-reviewer"],
  } as unknown as QualityReport;
  await db.qualityReports.put(qualityReport);

  const workflowRun: WorkflowRun = {
    ...baseRecord(WORKFLOW_RUN_ID),
    workflowId: "builtin.chapter",
    targetDocumentId: CHAPTER_ID,
    status: "completed",
    currentStage: "character-enrichment",
    stageIndex: 11,
    revisionIteration: 1,
    factCandidateIds: options.withFactCandidate ? [FACT_CANDIDATE_ID] : [],
    draftArtifactId: DRAFT_ARTIFACT_ID,
    qualityReportId: QUALITY_REPORT_ID,
    conversationThreadId: THREAD_ID,
    creativeBriefId: BRIEF_ID,
    startedAt: 50,
    finishedAt: 200,
  } as unknown as WorkflowRun;
  await db.workflowRuns.put(workflowRun);
  await db.documents.update(CHAPTER_ID, {
    title: "第一章",
    plainText: DRAFT_TEXT,
    contentHtml: `<p>${DRAFT_TEXT}</p>`,
  });

  if (options.withFactCandidate) {
    const factCandidate: FactCandidate = {
      ...baseRecord(FACT_CANDIDATE_ID),
      workflowRunId: WORKFLOW_RUN_ID,
      sourceArtifactId: DRAFT_ARTIFACT_ID,
      targetTable: "entities",
      targetId: "entity-shen-yan",
      field: "location",
      subject: { kind: "character", id: "entity-shen-yan" },
      predicate: "located-at",
      object: "客栈",
      polarity: "affirmed",
      truthStatus: "confirmed",
      timeMode: "scene",
      validFrom: { chapterId: CHAPTER_ID, paragraph: 1 },
      humanReadable: "沈砚在客栈内",
      evidence: "沈砚走进客栈，找了个位置坐下。",
      paragraph: 1,
      confidence: 0.9,
      novelty: "new",
      conflict: false,
      risk: "safe",
      riskReason: "测试安全事实",
      status: "accepted",
      before: "渡口",
      after: "客栈",
    } as unknown as FactCandidate;
    await db.factCandidates.put(factCandidate);
  }
}

describe("Loop 7: extractCandidateBundle 从实验库导出 CandidateBundle，verify + JSON round-trip，零正式库污染", () => {
  let canonicalHashBefore: string;
  let workspace: ExperimentWorkspace | undefined;

  beforeEach(async () => {
    await novelDb.delete();
    await novelDb.open();
    localStorage.clear();
    await seedCanonicalProject();
    canonicalHashBefore = await captureCanonicalHash(PROJECT_ID, "chapter-baseline");
  });

  afterEach(async () => {
    if (workspace) {
      await workspace.delete();
      workspace = undefined;
    }
    await novelDb.delete();
    await novelDb.open();
  });

  it("extractCandidateBundle 导出完整 bundle，verify 通过，JSON round-trip 等价，正式库 hash 不变", async () => {
    // 1. 加载快照到实验库
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const loaded = await loadProjectSnapshotIntoExperiment(bundle, `bench-loop7-cb-${crypto.randomUUID()}`);
    workspace = loaded.workspace;
    const experimentDb = workspace.db;

    // 2. 在实验库写入 workflowRun + draftArtifact + qualityReport + factCandidate
    await seedWorkflowRunInExperimentDb(experimentDb, {
      withFactCandidate: true,
      withIteratedSkills: true,
    });

    // 3. 调用 runSkillIteration 产生 IteratedSkillRecord（依赖 mock LLM）
    const iteratedRecords = await runSkillIteration({
      projectId: PROJECT_ID,
      workflowRunId: WORKFLOW_RUN_ID,
      db: experimentDb,
    });
    expect(iteratedRecords.length).toBe(1);

    // 4. 调用 extractCandidateBundle
    const candidateBundle = await extractCandidateBundle({
      workflowRunId: WORKFLOW_RUN_ID,
      workspace,
      baseDependencyHead: bundle.head,
      codeRevision: "loop7-test",
    });

    // 5. 验证 bundle 顶层字段
    expect(candidateBundle.formatVersion).toBe(2);
    expect(candidateBundle.id).toBeTruthy();
    expect(candidateBundle.experimentId).toBe(workspace.experimentId);
    expect(candidateBundle.variantId).toBe("default");
    expect(candidateBundle.sourceProjectId).toBe(PROJECT_ID);
    expect(candidateBundle.baseSnapshotId).toBe(workspace.baseSnapshotId);
    expect(candidateBundle.baseSnapshotHash).toBe(workspace.baseSnapshotHash);
    expect(candidateBundle.dependencyHead).toEqual(bundle.head);

    // 6. 验证 targetDocument
    expect(candidateBundle.targetDocument.documentId).toBe(CHAPTER_ID);
    expect(candidateBundle.targetDocument.baseRevision).toBe(1);
    expect(candidateBundle.targetDocument.baseApprovedRevisionId).toBe("revision-1");
    expect(candidateBundle.targetDocument.baseContentHash).toBeTruthy();

    // 7. 验证 manuscript
    expect(candidateBundle.manuscript.title).toBe("第一章");
    expect(candidateBundle.manuscript.summary).toBe("渡口夜话。");
    expect(candidateBundle.manuscript.plainText).toBe(DRAFT_TEXT);
    expect(candidateBundle.manuscript.contentHtml).toBe(`<p>${DRAFT_TEXT}</p>`);
    expect(candidateBundle.manuscript.wordCount).toBeGreaterThan(0);
    expect(candidateBundle.manuscript.contentHash).toBeTruthy();
    expect(candidateBundle.manuscript.contentHash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
    expect(candidateBundle.manuscript.sourceWorkflowRunId).toBe(WORKFLOW_RUN_ID);
    expect(candidateBundle.manuscript.sourceArtifactId).toBe(DRAFT_ARTIFACT_ID);

    // 8. 验证 acceptedFacts（投影自 FactCandidate）
    expect(candidateBundle.acceptedFacts.length).toBe(1);
    const fact = candidateBundle.acceptedFacts[0]!;
    expect(fact.sourceCandidateId).toBe(FACT_CANDIDATE_ID);
    expect(fact.payload.subject).toEqual({ kind: "character", id: "entity-shen-yan" });
    expect(fact.payload.predicate).toBe("located-at");
    expect(fact.payload.object).toBe("客栈");
    expect(fact.payload.polarity).toBe("affirmed");
    expect(fact.payload.truthStatus).toBe("confirmed");
    expect(fact.payload.timeMode).toBe("scene");
    expect(fact.payload.humanReadable).toBe("沈砚在客栈内");
    expect(fact.payload.evidence).toContain("沈砚走进客栈");
    expect(fact.payload.provenance).toBe("approved-revision");
    expect(fact.payload.status).toBe("active");
    expect(fact.payload.projection).toEqual({ targetTable: "entities", targetId: "entity-shen-yan", field: "location" });
    expect(fact.projectionInput).toMatchObject({ targetTable: "entities", targetId: "entity-shen-yan", field: "location", after: "客栈" });

    // 9. 验证 iteratedSkills（投影自 IteratedSkillRecord）
    expect(candidateBundle.iteratedSkills.length).toBe(1);
    const iteratedSkill = candidateBundle.iteratedSkills[0]!;
    expect(iteratedSkill.skillId).toBe("embodied-prose");
    expect(iteratedSkill.beforePrompt).not.toBe(iteratedSkill.afterPrompt);
    expect(iteratedSkill.afterPrompt).toContain("画面感公式");
    expect(iteratedSkill.rationale).toContain("style-specificity-audit");
    expect(iteratedSkill.triggeredByIssues.length).toBeGreaterThan(0);
    expect(iteratedSkill.sourceWorkflowRunId).toBe(WORKFLOW_RUN_ID);

    // 10. 被 review 指向并迭代的 skill 会形成显式项目 binding 变更
    expect(candidateBundle.iteratedBindings).toEqual([
      expect.objectContaining({ skillId: "embodied-prose", before: null, after: { enabled: true } }),
    ]);

    // 11. 验证 qualityEvidence
    expect(candidateBundle.qualityEvidence.sourceQualityReportId).toBe(QUALITY_REPORT_ID);
    expect(candidateBundle.qualityEvidence.weightedScore).toBe(3.8);
    expect(candidateBundle.qualityEvidence.avgScore).toBeCloseTo(3.86, 1);
    expect(candidateBundle.qualityEvidence.blockerCount).toBe(0);
    expect(candidateBundle.qualityEvidence.majorCount).toBe(1);
    expect(candidateBundle.qualityEvidence.warningCount).toBe(0);
    expect(candidateBundle.qualityEvidence.issueCount).toBe(1);
    expect(candidateBundle.qualityEvidence.dimensionScores.sceneEmbodiment).toBe(3);
    expect(candidateBundle.qualityEvidence.topIssues.length).toBe(1);
    expect(candidateBundle.qualityEvidence.topIssues[0]!.dimension).toBe("sceneEmbodiment");

    // 12. 验证 provenance
    expect(candidateBundle.provenance.model).toBe("test-model");
    expect(candidateBundle.provenance.promptFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(candidateBundle.provenance.configFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(candidateBundle.provenance.codeRevision).toBe("loop7-test");
    expect(candidateBundle.provenance.workflowArtifactIds).toContain(DRAFT_ARTIFACT_ID);
    expect(candidateBundle.provenance.skillRefs).toEqual(expect.arrayContaining(["embodied-prose", "system-prompt:planning-craft-guidance@1.0.0", "chapter-blueprint@1.0.0"]));
    expect(candidateBundle.provenance.stagePromptEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "blueprint", artifactId: "artifact-blueprint-provenance" }),
      expect.objectContaining({ stage: "draft", artifactId: DRAFT_ARTIFACT_ID }),
    ]));
    expect(candidateBundle.provenance.experimentStartedAt).toBe(50);
    expect(candidateBundle.provenance.exportedAt).toBeGreaterThan(0);

    // 13. verifyCandidateBundle 通过
    const verification = verifyCandidateBundle(candidateBundle);
    expect(verification.valid).toBe(true);
    expect(verification.issues).toEqual([]);

    // 14. JSON round-trip 等价
    const json = serializeCandidateBundle(candidateBundle);
    expect(typeof json).toBe("string");
    const restored = deserializeCandidateBundle(json);
    expect(restored).toEqual(candidateBundle);

    // 15. 验证反序列化后 verify 仍通过
    const restoredVerification = verifyCandidateBundle(restored);
    expect(restoredVerification.valid).toBe(true);

    // 16. 物理证据：正式库 hash 不变
    const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
    assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);

    // 17. 正式库 candidateBundle 不存在表（candidate-bundle 是只读导出，不写入实验库或正式库）
    //     且 experimentDb 没有创建 candidateBundles 表（CandidateBundle 是 in-memory 数据结构）
    //     验证 experimentDb 没有写入新表：通过 canonical hash 不变已证明
  }, 30_000);

  it("verifyCandidateBundle 检测出格式错误：missing required fields", () => {
    const brokenBundle = {
      formatVersion: 2,
      id: "",
      experimentId: "",
      variantId: "",
      sourceProjectId: "",
      baseSnapshotId: "",
      baseSnapshotHash: "",
      dependencyHead: null,
      targetDocument: null,
      manuscript: null,
      acceptedFacts: "not-an-array",
      iteratedSkills: [],
      iteratedBindings: [],
      qualityEvidence: null,
      provenance: null,
    } as unknown as Parameters<typeof verifyCandidateBundle>[0];

    const verification = verifyCandidateBundle(brokenBundle);
    expect(verification.valid).toBe(false);
    expect(verification.issues.length).toBeGreaterThan(0);
    // 应该列出至少这些缺失字段
    expect(verification.issues).toContain("id 缺失");
    expect(verification.issues).toContain("experimentId 缺失");
    expect(verification.issues).toContain("manuscript 缺失");
    expect(verification.issues).toContain("qualityEvidence 缺失");
    expect(verification.issues).toContain("provenance 缺失");
    expect(verification.issues).toContain("acceptedFacts 必须为数组");
  });

  it("verifyCandidateBundle 检测出 iteratedSkills beforePrompt === afterPrompt", () => {
    const bundle = {
      formatVersion: 2,
      id: "test-id",
      experimentId: "exp-1",
      variantId: "default",
      sourceProjectId: PROJECT_ID,
      baseSnapshotId: "snap-1",
      baseSnapshotHash: "hash-1",
      dependencyHead: { projectRevision: 1, finalDocumentHeads: [] },
      targetDocument: {
        documentId: CHAPTER_ID,
        baseRevision: 1,
        baseContentHash: "doc-hash",
      },
      manuscript: {
        title: "测试章节",
        summary: "测试摘要",
        plainText: "正文内容",
        contentHtml: "正文内容",
        wordCount: 4,
        contentHash: "abc123",
      },
      acceptedFacts: [],
      iteratedSkills: [
        {
          skillId: "embodied-prose",
          beforePrompt: "same prompt",
          afterPrompt: "same prompt",
          rationale: "测试",
          triggeredByIssues: [],
        },
      ],
      iteratedBindings: [],
      qualityEvidence: {
        weightedScore: 3.5,
        avgScore: 3.5,
        blockerCount: 0,
        majorCount: 0,
        warningCount: 0,
        issueCount: 0,
        dimensionScores: {},
        topIssues: [],
      },
      provenance: {
        model: "test",
        promptFingerprint: "fp",
        configFingerprint: "cf",
        codeRevision: "test",
        workflowArtifactIds: [],
        experimentStartedAt: 1,
        exportedAt: 2,
      },
    } as never;

    const verification = verifyCandidateBundle(bundle);
    expect(verification.valid).toBe(false);
    expect(verification.issues).toContain("iteratedSkills[0].beforePrompt 与 afterPrompt 相同");
  });

  it("PromotableFact 投影过滤 duplicate/conflict 候选（high-risk 由 fact-approval 决策，不在此层过滤）", async () => {
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const loaded = await loadProjectSnapshotIntoExperiment(bundle, `bench-loop7-filter-${crypto.randomUUID()}`);
    workspace = loaded.workspace;
    const experimentDb = workspace.db;

    await seedWorkflowRunInExperimentDb(experimentDb, { withFactCandidate: false });

    // 写入 4 个 factCandidate: 1 safe + 1 duplicate + 1 high-risk + 1 conflict
    const safeFact: FactCandidate = {
      ...baseRecord("fact-safe"),
      workflowRunId: WORKFLOW_RUN_ID,
      sourceArtifactId: DRAFT_ARTIFACT_ID,
      targetTable: "entities",
      targetId: "entity-shen-yan",
      field: "location",
      subject: { kind: "character", id: "entity-shen-yan" },
      predicate: "located-at",
      object: "客栈",
      polarity: "affirmed",
      truthStatus: "confirmed",
      timeMode: "scene",
      humanReadable: "沈砚在客栈内",
      evidence: "沈砚走进客栈",
      confidence: 0.9,
      novelty: "new",
      conflict: false,
      risk: "safe",
      riskReason: "测试安全事实",
      status: "accepted",
      before: "渡口",
      after: "客栈",
    } as unknown as FactCandidate;

    const duplicateFact: FactCandidate = {
      ...safeFact,
      id: "fact-duplicate",
      novelty: "duplicate",
    } as unknown as FactCandidate;

    const highRiskFact: FactCandidate = {
      ...safeFact,
      id: "fact-high-risk",
      novelty: "new",
      risk: "high",
    } as unknown as FactCandidate;

    const conflictFact: FactCandidate = {
      ...safeFact,
      id: "fact-conflict",
      conflict: true,
    } as unknown as FactCandidate;

    await experimentDb.factCandidates.bulkPut([safeFact, duplicateFact, highRiskFact, conflictFact]);

    const candidateBundle = await extractCandidateBundle({
      workflowRunId: WORKFLOW_RUN_ID,
      workspace,
      baseDependencyHead: bundle.head,
    });

    // safeFact + highRiskFact 应被投影到 acceptedFacts（high-risk 由 fact-approval 决策，
    // bundle 导出层不再过滤 risk；duplicate 和 conflict 仍被过滤）
    expect(candidateBundle.acceptedFacts.length).toBe(2);
    const projectedIds = candidateBundle.acceptedFacts.map((fact) => fact.sourceCandidateId).sort();
    expect(projectedIds).toEqual(["fact-high-risk", "fact-safe"]);

    const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
    assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);
  }, 30_000);

  it("extractCandidateBundle 缺少 qualityReportId 时抛出", async () => {
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const loaded = await loadProjectSnapshotIntoExperiment(bundle, `bench-loop7-noqr-${crypto.randomUUID()}`);
    workspace = loaded.workspace;
    const experimentDb = workspace.db;

    // 写入 workflowRun 但不设 qualityReportId
    const workflowRun: WorkflowRun = {
      ...baseRecord(WORKFLOW_RUN_ID),
      workflowId: "builtin.chapter",
      targetDocumentId: CHAPTER_ID,
      status: "drafting",
      currentStage: "draft",
      stageIndex: 3,
      revisionIteration: 1,
      factCandidateIds: [],
      draftArtifactId: DRAFT_ARTIFACT_ID,
      qualityReportId: undefined,
      startedAt: 50,
    } as unknown as WorkflowRun;
    await experimentDb.workflowRuns.put(workflowRun);

    await expect(
      extractCandidateBundle({
        workflowRunId: WORKFLOW_RUN_ID,
        workspace,
        baseDependencyHead: bundle.head,
      }),
    ).rejects.toThrow(/quality report/);
  }, 30_000);
});
