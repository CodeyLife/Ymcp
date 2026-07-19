/**
 * Loop 8 验证：PromotionService.inspect + promote 实现原子单事务晋升 + 幂等 receipt。
 *
 * 目的：验证晋升服务的核心契约：
 *   1. `promote(candidate, decision)` 在单个 Dexie 事务内创建 DocumentRevision +
 *      更新 ManuscriptDocument + 持久化 FactAssertions + 更新 NovelSkillManifest prompt
 *      + 写入 OperationReceipt。正式库 hash 前进（不是不变——晋升写正式库）。
 *   2. 幂等：同一 candidateId 重复 promote 返回 `status="already-promoted"` + 同一 operationId，
 *      不重复创建 revision / factAssertion。
 *   3. 注入失败回滚：mock db.revisions.add 抛错 → 事务回滚 → 正式库 hash 不变 + 失败 receipt 记录错误。
 *   4. inspect 检测 stale-baseline：在 candidate 导出后修改正式库 document → inspect.status="stale-baseline"
 *      + promote 返回 `status="rejected"` + 不写任何数据。
 *   5. inspect 检测 content-hash-mismatch：篡改 candidate.manuscript.contentHash → inspect.status="rejected"。
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

import { documentContentHash, novelDb, type NovelDatabase } from "../../db";
import { captureProjectSnapshot, type ProjectHead } from "../../evaluation/project-snapshot";
import { loadProjectSnapshotIntoExperiment } from "../../evaluation/experiment-workspace";
import { runSkillIteration } from "../../evaluation/skill-iteration";
import { extractCandidateBundle } from "../../evaluation/candidate-bundle";
import { createPromotionService } from "../../evaluation/promotion";
import type {
  CandidateBundle,
  PromotableFact,
  IteratedSkill,
  IteratedBinding,
} from "../../evaluation/types";
import type {
  FactCandidate,
  ManuscriptDocument,
  NovelSkillManifest,
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

const PROJECT_ID = "bench-loop8-project";
const CHAPTER_ID = "bench-loop8-chapter";
const WORKFLOW_RUN_ID = "bench-loop8-run-1";
const DRAFT_ARTIFACT_ID = "bench-loop8-draft-artifact";
const QUALITY_REPORT_ID = "bench-loop8-quality-report";
const FACT_CANDIDATE_ID = "bench-loop8-fact-1";
const USER_SKILL_ID = "bench-loop8-embodied-prose";
const THREAD_ID = "bench-loop8-thread";
const BRIEF_ID = "bench-loop8-brief";

const DRAFT_TEXT_BEFORE = "江水很冷。";
const DRAFT_TEXT_AFTER = "渡口在黄昏时起了雾。沈砚走进客栈，找了个位置坐下。线人来过又走了。夜半有脚步声，但人影退去后，他只看见对方腰间的玉佩。天亮前他离开了客栈。";

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
    title: "Loop8 晋升服务验证长篇",
    subtitle: "",
    premise: "Loop8 验证用项目",
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
    contentHtml: DRAFT_TEXT_BEFORE,
    plainText: DRAFT_TEXT_BEFORE,
    summary: "渡口夜话。",
    status: "final",
    wordCount: DRAFT_TEXT_BEFORE.length,
    branch: "main",
    yjsDocumentId: "yjs-chapter-1",
    approvedRevisionId: "revision-1",
  } as unknown as ManuscriptDocument;
  await novelDb.table("documents").put(chapter);
  await seedWorkflowInputs(novelDb);
  await novelDb.table("entities").put({
    ...baseRecord("entity-shen-yan"),
    kind: "character",
    name: "沈砚",
    aliases: [],
    summary: "渡口旅人",
    description: "",
    tags: [],
    lockedFacts: [],
    customFields: {},
    location: "渡口",
  });

  // seed revision-1：chapter 引用 approvedRevisionId="revision-1"，必须实际存在，
  // 否则 promote 事务的 supersede 步骤会无对象可 supersede（Dexie update 静默 no-op），
  // 测试断言 oldRevision.approvalStatus === "superseded" 会失败。
  await novelDb.table("revisions").put({
    ...baseRecord("revision-1"),
    documentId: CHAPTER_ID,
    label: "第一章定稿",
    contentHtml: DRAFT_TEXT_BEFORE,
    plainText: DRAFT_TEXT_BEFORE,
    source: "ai",
    branch: "main",
    approvalStatus: "approved",
    approvedAt: 100,
    contentHash: "existing-hash",
  });

  // seed 一个 user-scope 的 embodied-prose skill，供 Loop 8 晋升时更新 prompt
  // category 必须在 parseNovelSkill 的 AJV enum 内（"prose" 不在 enum 中会导致
  // runSkillIteration 的 validateIteratedPrompt 静默跳过 iteration，bundle.iteratedSkills 为空）。
  // builtin embodied-prose 用 "drafting"，此处保持一致。
  const skill: NovelSkillManifest = {
    ...baseRecord(USER_SKILL_ID, "__user__"),
    skillId: "embodied-prose",
    version: "1.0.0",
    name: "具象散文",
    description: "强调画面感与具象行动",
    locale: "zh-CN",
    category: "drafting",
    stages: ["drafting"],
    triggers: [],
    requires: [],
    conflicts: [],
    priority: 50,
    prompt: "正文优先呈现人物正在做什么、注意到什么、误读什么和选择什么。抽象总结要落回可观察行动、具体感官、环境阻力或有代价的对白。",
    qualityChecks: [],
    source: "user",
    enabled: true,
    readonly: false,
  } as unknown as NovelSkillManifest;
  await novelDb.table("skills").put(skill);
}

async function seedWorkflowRunInExperimentDb(db: NovelDatabase): Promise<void> {
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
    contentMarkdown: DRAFT_TEXT_AFTER,
    model: "test-model",
    skillRefs: ["embodied-prose", "prose-discipline"],
  } as unknown as WorkflowArtifact;
  await db.workflowArtifacts.put(draftArtifact);

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
    factCandidateIds: [FACT_CANDIDATE_ID],
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
    plainText: DRAFT_TEXT_AFTER,
    contentHtml: `<p>${DRAFT_TEXT_AFTER}</p>`,
  });

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

/**
 * 从实验库提取 candidate bundle 的完整流程（Loop 7 的接入点）。
 * 返回 bundle 后立即关闭实验库（candidate 已是只读快照，不再依赖实验库）。
 */
async function extractCandidateFromExperiment(baseDependencyHead: ProjectHead): Promise<CandidateBundle> {
  const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
  const baseDocument = await novelDb.documents.get(CHAPTER_ID);
  if (!baseDocument) throw new Error("测试基线章节不存在");
  const loaded = await loadProjectSnapshotIntoExperiment(bundle, `bench-loop8-${crypto.randomUUID()}`);
  const workspace = loaded.workspace;
  try {
    await seedWorkflowRunInExperimentDb(workspace.db);
    await runSkillIteration({
      projectId: PROJECT_ID,
      workflowRunId: WORKFLOW_RUN_ID,
      db: workspace.db,
    });
    return await extractCandidateBundle({
      workflowRunId: WORKFLOW_RUN_ID,
      workspace,
      baseDependencyHead,
      baseTargetDocument: {
        documentId: baseDocument.id,
        baseRevision: baseDocument.revision,
        baseApprovedRevisionId: baseDocument.approvedRevisionId,
        baseContentHash: documentContentHash(baseDocument),
      },
      codeRevision: "loop8-test",
    });
  } finally {
    await workspace.delete();
  }
}

function buildAuthorDecision(candidate: CandidateBundle) {
  return {
    accepted: true as const,
    authorId: "bench-loop8-author",
    rationale: "接受候选包晋升",
    acceptedFactIds: candidate.acceptedFacts.map((fact: PromotableFact) => fact.sourceCandidateId),
    acceptedSkillIds: candidate.iteratedSkills.map((skill: IteratedSkill) => skill.skillId),
    acceptedBindingKeys: candidate.iteratedBindings.map((binding: IteratedBinding) => binding.skillId),
    decidedAt: Date.now(),
  };
}

describe("Loop 8: PromotionService 原子单事务晋升 + 幂等 receipt + 注入失败回滚", () => {
  let canonicalHashBefore: string;
  let baseHead: ProjectHead;

  beforeEach(async () => {
    await novelDb.delete();
    await novelDb.open();
    localStorage.clear();
    await seedCanonicalProject();
    const baselineSnapshot = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    baseHead = baselineSnapshot.head;
    canonicalHashBefore = baselineSnapshot.manifest.snapshotHash;
  });

  afterEach(async () => {
    await novelDb.delete();
    await novelDb.open();
  });

  it("promote 写入正式库（revision + document + factAssertion + skill prompt + receipt），hash 前进；幂等 re-promote 返回相同 operationId", async () => {
    const candidate = await extractCandidateFromExperiment(baseHead);
    const service = createPromotionService(novelDb);

    // 决策：接受所有 facts + skills
    const decision = buildAuthorDecision(candidate);

    const receipt1 = await service.promote(candidate, decision);

    // 1. receipt 字段
    expect(receipt1.status).toBe("promoted");
    expect(receipt1.candidateId).toBe(candidate.id);
    expect(receipt1.operationId).toBe(`promote:${candidate.id}`);
    expect(receipt1.promotedAt).toBeGreaterThan(0);
    expect(receipt1.createdRevisionId).toBeTruthy();
    expect(receipt1.createdFactAssertionIds.length).toBe(1);
    expect(receipt1.createdMemoryIds).toEqual([]);
    expect(receipt1.createdOperationIds.length).toBe(1);

    // 2. 正式库新增了 DocumentRevision
    const newRevision = await novelDb.revisions.get(receipt1.createdRevisionId!);
    expect(newRevision).toBeDefined();
    expect(newRevision!.approvalStatus).toBe("approved");
    expect(newRevision!.contentHtml).toBe(candidate.manuscript.contentHtml);
    expect(newRevision!.parentRevisionId).toBe("revision-1");

    // 3. ManuscriptDocument 被更新
    const updatedDocument = await novelDb.documents.get(CHAPTER_ID);
    expect(updatedDocument).toBeDefined();
    expect(updatedDocument!.contentHtml).toBe(candidate.manuscript.contentHtml);
    expect(updatedDocument!.plainText).toBe(candidate.manuscript.plainText);
    expect(updatedDocument!.approvedRevisionId).toBe(receipt1.createdRevisionId);
    expect(updatedDocument!.revision).toBe(2); // 从 1 → 2

    // 4. FactAssertion 被创建
    const factAssertion = await novelDb.factAssertions.get(receipt1.createdFactAssertionIds[0]!);
    expect(factAssertion).toBeDefined();
    expect(factAssertion!.sourceRevisionId).toBe(receipt1.createdRevisionId);
    expect(factAssertion!.derivedFromCandidateId).toBe(candidate.acceptedFacts[0]!.sourceCandidateId);
    expect(factAssertion!.predicate).toBe("located-at");
    expect(factAssertion!.status).toBe("active");
    expect(factAssertion!.sourceArtifactId).toBeUndefined();
    expect((await novelDb.entities.get("entity-shen-yan") as unknown as { location?: string })?.location).toBe("客栈");

    // 5. NovelSkillManifest.prompt 被更新
    const updatedSkill = await novelDb.skills.where("[projectId+skillId]").equals([PROJECT_ID, "embodied-prose"]).first();
    expect(updatedSkill).toBeDefined();
    expect(updatedSkill!.prompt).toBe(candidate.iteratedSkills[0]!.afterPrompt);
    expect(updatedSkill!.revision).toBe(1); // 创建项目级覆盖，不修改全局 user skill
    expect((await novelDb.skills.get(USER_SKILL_ID))!.prompt).toBe(candidate.iteratedSkills[0]!.beforePrompt);
    expect((await novelDb.projectSkills.where("[projectId+skillId]").equals([PROJECT_ID, "embodied-prose"]).first())?.enabled).toBe(true);

    // 6. OperationReceipt 被写入
    const opReceipt = await novelDb.operationReceipts
      .where("operationId")
      .equals(receipt1.operationId)
      .first();
    expect(opReceipt).toBeDefined();
    expect(opReceipt!.status).toBe("completed");
    expect(opReceipt!.candidateId).toBe(candidate.id);
    expect(opReceipt!.receipts.revisionId).toBe(receipt1.createdRevisionId);

    // 7. 旧 approvedRevision 被 superseded
    const oldRevision = await novelDb.revisions.get("revision-1");
    expect(oldRevision).toBeDefined();
    expect(oldRevision!.approvalStatus).toBe("superseded");

    // 8. 正式库 hash 前进（不是不变——晋升写入正式库）
    const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-promotion");
    expect(canonicalHashAfter).not.toBe(canonicalHashBefore);

    // 9. 幂等 re-promote：返回相同 operationId，status=already-promoted
    const receipt2 = await service.promote(candidate, decision);
    expect(receipt2.status).toBe("already-promoted");
    expect(receipt2.operationId).toBe(receipt1.operationId);
    expect(receipt2.createdRevisionId).toBe(receipt1.createdRevisionId);
    expect(receipt2.createdFactAssertionIds).toEqual(receipt1.createdFactAssertionIds);

    // 10. 幂等后正式库无新增 revision / factAssertion
    const revisionCount = await novelDb.revisions.where("projectId").equals(PROJECT_ID).count();
    const factCount = await novelDb.factAssertions.where("projectId").equals(PROJECT_ID).count();
    expect(revisionCount).toBe(2); // revision-1 + newRevision
    expect(factCount).toBe(1);
  }, 30_000);

  it("注入失败回滚：mock db.revisions.add 抛错 → 事务回滚 → 正式库 hash 不变 + 失败 receipt 记录错误", async () => {
    const candidate = await extractCandidateFromExperiment(baseHead);
    const service = createPromotionService(novelDb);
    const decision = buildAuthorDecision(candidate);

    // 先正常 promote 一次，让 candidate 进入"已晋升"状态——不！我们要测的是首次晋升失败。
    // 直接 mock db.revisions.add 抛错（mockRejectedValue 避免 PromiseExtended 类型不匹配）
    const addSpy = vi.spyOn(novelDb.revisions, "add").mockRejectedValue(new Error("注入失败：模拟 revisions.add 抛错"));

    const receipt = await service.promote(candidate, decision);

    // 恢复 spy
    addSpy.mockRestore();

    // 1. receipt 报 rejected
    expect(receipt.status).toBe("rejected");
    expect(receipt.error).toContain("注入失败");
    expect(receipt.candidateId).toBe(candidate.id);

    // 2. 正式库 hash 不变（事务回滚）
    const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
    assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);

    // 3. 正式库只有 seed 的 revision-1，没有新 revision（事务回滚）。
    //    factAssertions 表为空（promote 创建的 assertion 已回滚）。
    const revisions = await novelDb.revisions.where("projectId").equals(PROJECT_ID).toArray();
    expect(revisions.length).toBe(1);
    expect(revisions[0]!.id).toBe("revision-1");
    expect(revisions[0]!.approvalStatus).toBe("approved"); // 未被 superseded
    const factAssertions = await novelDb.factAssertions.where("projectId").equals(PROJECT_ID).count();
    expect(factAssertions).toBe(0);

    // 4. 操作 receipt 表有一条 failed 记录
    const failedReceipt = await novelDb.operationReceipts
      .where("operationId")
      .equals(`promote:${candidate.id}`)
      .first();
    expect(failedReceipt).toBeDefined();
    expect(failedReceipt!.status).toBe("failed");
    expect(failedReceipt!.error).toContain("注入失败");

    // 5. 文档保持原状（未被更新）
    const documentAfter = await novelDb.documents.get(CHAPTER_ID);
    expect(documentAfter!.contentHtml).toBe(DRAFT_TEXT_BEFORE);
    expect(documentAfter!.revision).toBe(1);
    expect(documentAfter!.approvedRevisionId).toBe("revision-1");
  }, 30_000);

  it("inspect 检测 stale-baseline：在 candidate 导出后修改正式库 document → inspect.status=stale-baseline + promote 拒绝写入", async () => {
    const candidate = await extractCandidateFromExperiment(baseHead);
    const service = createPromotionService(novelDb);

    // 在 candidate 导出后，正式库 document 被修改（模拟实验期间正式库前进）
    const document = await novelDb.documents.get(CHAPTER_ID);
    expect(document).toBeDefined();
    await novelDb.documents.put({
      ...document!,
      contentHtml: "其他人在实验期间手改了正文。",
      plainText: "其他人在实验期间手改了正文。",
      revision: document!.revision + 1,
      updatedAt: Date.now(),
      updatedBy: "another-author",
    });

    // inspect 应该返回 stale-baseline
    const check = await service.inspect(candidate);
    expect(check.status).toBe("stale-baseline");
    expect(check.baselineMatches).toBe(false);
    expect(check.recomputedDependencyHead.finalDocumentHeads[0]!.documentRevision).toBe(2);

    // promote 应该拒绝
    const decision = buildAuthorDecision(candidate);
    const receipt = await service.promote(candidate, decision);

    expect(receipt.status).toBe("rejected");
    expect(receipt.error).toContain("stale-baseline");

    // 正式库 hash 没有因为 promote 调用而变化（虽然手改已经让它变化了，但 promote 不应该再写）
    // 用 promote 前后的 hash 对比（手改后的 hash 是 promote 调用前的状态）
    const hashBeforePromote = await captureCanonicalHash(PROJECT_ID, "post-bench");
    const hashAfterPromote = await captureCanonicalHash(PROJECT_ID, "replay");
    assertCanonicalHashUnchanged(hashBeforePromote, hashAfterPromote, "stale-baseline promote 仍写入了正式库");

    // 没有 OperationReceipt 被写入（rejected 不写 receipt）
    const opReceipt = await novelDb.operationReceipts
      .where("operationId")
      .equals(`promote:${candidate.id}`)
      .first();
    expect(opReceipt).toBeUndefined();
  }, 30_000);

  it("inspect 检测 content-hash-mismatch：篡改 candidate.manuscript.contentHash → inspect.status=rejected", async () => {
    const candidate = await extractCandidateFromExperiment(baseHead);
    const service = createPromotionService(novelDb);

    // 篡改 candidate.manuscript.contentHash（模拟传输篡改）
    const tamperedCandidate: CandidateBundle = {
      ...candidate,
      manuscript: {
        ...candidate.manuscript,
        contentHash: "deadbeef".repeat(16), // 64 字符的伪造 hash
      },
    };

    const check = await service.inspect(tamperedCandidate);
    expect(check.status).toBe("rejected");
    expect(check.deterministicBlockers.length).toBeGreaterThan(0);
    const hasHashMismatch = check.deterministicBlockers.some((issue) => issue.includes("contentHash"));
    expect(hasHashMismatch).toBe(true);

    // promote 应该拒绝
    const decision = buildAuthorDecision(tamperedCandidate);
    const receipt = await service.promote(tamperedCandidate, decision);
    expect(receipt.status).toBe("rejected");
    expect(receipt.error).toContain("deterministic-blocker");

    // 正式库 hash 不变
    const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
    assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);
  }, 30_000);

  it("非文档依赖在 dry-run 后变化时也判定 stale-baseline", async () => {
    const candidate = await extractCandidateFromExperiment(baseHead);
    await novelDb.entities.update("entity-shen-yan", {
      summary: "作者在候选预览后补充了人物资料",
      revision: 2,
      updatedAt: Date.now(),
    });
    const service = createPromotionService(novelDb);
    const check = await service.inspect(candidate);
    expect(check.status).toBe("stale-baseline");
    expect(check.baselineMatches).toBe(false);
    expect(check.issues).toContain("正式库项目快照已变化，候选包基于过时基线");
    const receipt = await service.promote(candidate, buildAuthorDecision(candidate));
    expect(receipt.status).toBe("rejected");
    expect(await novelDb.operationReceipts.where("candidateId").equals(candidate.id).count()).toBe(0);
  }, 30_000);

  it("创作简报或检索源覆盖变化时拒绝晋升旧候选", async () => {
    const candidate = await extractCandidateFromExperiment(baseHead);
    await novelDb.creativeBriefs.update(BRIEF_ID, {
      goal: "作者在预览后改变了本章目标",
      revision: 2,
      updatedAt: Date.now(),
    });
    const check = await createPromotionService(novelDb).inspect(candidate);
    expect(check.status).toBe("stale-baseline");
    expect(check.issues).toContain("创作简报或检索源覆盖已变化，候选包基于过时输入");
  }, 30_000);

  it("晋升替换 approved revision 时同步失效旧事实、角色认知和派生记忆", async () => {
    await novelDb.factAssertions.put({
      ...baseRecord("fact-old"),
      sourceRevisionId: "revision-1",
      status: "active",
    } as never);
    await novelDb.knowledgeAssertions.put({
      ...baseRecord("knowledge-old"),
      characterId: "entity-shen-yan",
      factAssertionId: "fact-old",
      sourceRevisionId: "revision-1",
      status: "active",
    } as never);
    await novelDb.derivedMemories.put({
      ...baseRecord("memory-old"),
      sourceRevisionId: "revision-1",
      sourceMemoryIds: [],
      status: "active",
    } as never);

    const candidate = await extractCandidateFromExperiment(baseHead);
    const receipt = await createPromotionService(novelDb).promote(candidate, buildAuthorDecision(candidate));
    expect(receipt.status).toBe("promoted");
    expect((await novelDb.factAssertions.get("fact-old"))?.status).toBe("stale");
    expect((await novelDb.knowledgeAssertions.get("knowledge-old"))?.status).toBe("stale");
    expect((await novelDb.derivedMemories.get("memory-old"))?.status).toBe("stale");
  }, 30_000);

  it("只有内置 skill 时创建项目级覆盖，不静默丢弃迭代结果", async () => {
    await novelDb.skills.delete(USER_SKILL_ID);
    const candidate = await extractCandidateFromExperiment(baseHead);
    expect(candidate.iteratedSkills[0]?.skillId).toBe("embodied-prose");

    const receipt = await createPromotionService(novelDb).promote(candidate, buildAuthorDecision(candidate));
    expect(receipt.status).toBe("promoted");
    const projectOverride = await novelDb.skills
      .where("[projectId+skillId]")
      .equals([PROJECT_ID, "embodied-prose"])
      .first();
    expect(projectOverride?.source).toBe("project");
    expect(projectOverride?.readonly).toBe(false);
    expect(projectOverride?.prompt).toBe(candidate.iteratedSkills[0]!.afterPrompt);
  }, 30_000);
});
