/**
 * Loop 6 验证：runSkillIteration 在实验库上写入 IteratedSkillRecord，零正式库污染。
 *
 * 目的：验证 skill-iteration 服务作为 post-commit side-effect 的核心契约：
 *   1. `runSkillIteration({...}, experimentDb)` 读取实验库中 workflowRun 的 qualityReport，
 *      过滤非 deterministic issues，调用 LLM (skill-iterator role) 提出修订后的 skill prompt。
 *   2. 每条 IteratedSkillRecord 的 afterPrompt 必须能与原 skill 元数据组合成完整
 *      NovelSkillManifest，通过 `parseNovelSkill` 验证（确保晋升时能写入正式库）。
 *   3. 写入实验库 `iteratedSkills` 表；正式库 ProjectSnapshot 哈希不变。
 *
 * Mock 策略：
 * - `callStructuredNovelModel` 按 role 分发；当 role === "skill-iterator" 时返回预定义的 iterations。
 * - 不调用 `streamNovelModel`（skill-iteration 不走流式）。
 *
 * 已知限制：
 * - 本测试不验证 LLM 真实迭代质量——那是真实 LLM bench 的职责。
 * - 本测试不验证 PromotionService 晋升流程——留待后续 loop。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock LLM 调用：所有阶段返回确定性数据，避免网络依赖。
// callStructuredNovelModel 按 role 分发；skill-iterator 返回预定义 iterations。
// 测试用例可通过 `callStructuredNovelModel.mock.mockImplementationOnce` 覆盖单次返回。
vi.mock("../../ai", () => ({
  callStructuredNovelModel: vi.fn(async ({ role }: { role: string }) => {
    if (role === "skill-iterator") {
      return {
        data: {
          iterations: [
            {
              skillId: "embodied-prose",
              afterPrompt:
                "正文优先呈现人物正在做什么、注意到什么、误读什么和选择什么。抽象总结要落回可观察行动、具体感官、环境阻力或有代价的对白。认知变化必须由前文可见信息触发；观察不足时，人物判断应保持试探性并允许出错。\n\n【画面感公式·强化版】关键瞬间必须用\"动作+停顿+环境反应+时间流逝+心境外化\"五元素组合呈现。每个元素都不能省略：动作（人物的具体行动）→ 停顿（一瞬的静默）→ 环境反应（景物/光线/温度的变化）→ 时间流逝（一炷香、半盏茶、几声鼓响）→ 心境外化（可被镜头捕捉的身体反应）。禁止只用\"他感到X\"式心理描写承载关键瞬间。",
              rationale:
                "style-specificity-audit 报告\"画面感公式落实不足\"，原文在人物登场等关键瞬间缺少环境反应与时间流逝元素，故强化 embodied-prose 的画面感公式约束，要求五元素必须齐备。",
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

import { callStructuredNovelModel } from "../../ai";
import { novelDb, type NovelDatabase } from "../../db";
import { captureProjectSnapshot } from "../../evaluation/project-snapshot";
import { loadProjectSnapshotIntoExperiment, type ExperimentWorkspace } from "../../evaluation/experiment-workspace";
import { runSkillIteration, listIteratedSkills } from "../../evaluation/skill-iteration";
import { BUILTIN_NOVEL_SKILLS, parseNovelSkill } from "../../skills";
import type {
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

const PROJECT_ID = "bench-loop6-project";
const CHAPTER_ID = "bench-loop6-chapter";
const WORKFLOW_RUN_ID = "bench-loop6-run-1";
const DRAFT_ARTIFACT_ID = "bench-loop6-draft-artifact";
const QUALITY_REPORT_ID = "bench-loop6-quality-report";
const ISSUE_ID = "issue-imagery-1";

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
  const project: StoryProject = {
    id: PROJECT_ID,
    schemaVersion: 8,
    revision: 1,
    createdAt: 1,
    updatedAt: 100,
    createdBy: "test",
    updatedBy: "test",
    title: "Loop6 技能迭代验证长篇",
    subtitle: "",
    premise: "Loop6 验证用项目",
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

  // 一个 final 章节作为前置
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
}

/**
 * 在实验库直接写入 workflowRun + draftArtifact + qualityReport，
 * 等价于章节工作流走完 draft → review 后的状态。
 */
async function seedWorkflowRunInExperimentDb(
  db: NovelDatabase,
  options: { nonDeterministicIssues?: QualityIssue[] } = {},
): Promise<void> {
  const issues: QualityIssue[] = options.nonDeterministicIssues ?? [
    {
      id: ISSUE_ID,
      dimension: "sceneEmbodiment",
      severity: "major",
      title: "画面感公式落实不足",
      description: "人物登场等关键瞬间缺少环境反应与时间流逝元素，五元素组合不完整。",
      excerpt: "沈砚走进客栈，找了个位置坐下。",
      paragraph: 1,
      revisionRanges: [{ start: 1, end: 1 }],
      rule: "画面感五元素缺失",
      sourceId: "style-specificity-audit",
      suggestion: "在关键瞬间补齐动作+停顿+环境反应+时间流逝+心境外化五元素。",
      deterministic: false,
    },
  ];

  const draftArtifact: WorkflowArtifact = {
    ...baseRecord(DRAFT_ARTIFACT_ID),
    workflowRunId: WORKFLOW_RUN_ID,
    stage: "draft",
    kind: "draft",
    title: "第一章 草稿",
    contentMarkdown:
      "渡口在黄昏时起了雾。沈砚走进客栈，找了个位置坐下。线人来过又走了。夜半有脚步声，但人影退去后，他只看见对方腰间的玉佩。天亮前他离开了客栈。",
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
    metrics: { totalIssues: issues.length, nonDeterministic: issues.filter((i) => !i.deterministic).length },
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
    contextPacketId: undefined,
    conversationThreadId: undefined,
    creativeBriefId: undefined,
    blueprintArtifactId: undefined,
    draftArtifactId: DRAFT_ARTIFACT_ID,
    qualityReportId: QUALITY_REPORT_ID,
    factCandidateIds: [],
    startedAt: 50,
    finishedAt: 200,
  } as unknown as WorkflowRun;
  await db.workflowRuns.put(workflowRun);
}

describe("Loop 6: runSkillIteration 在实验库上写入 IteratedSkillRecord，零正式库污染", () => {
  let canonicalHashBefore: string;
  let workspace: ExperimentWorkspace | undefined;

  beforeEach(async () => {
    await novelDb.delete();
    await novelDb.open();
    localStorage.clear();
    await seedCanonicalProject();
    canonicalHashBefore = await captureCanonicalHash(PROJECT_ID, "chapter-baseline");
    // 重置 mock 调用记录，确保每个测试独立
    vi.mocked(callStructuredNovelModel).mockClear();
  });

  afterEach(async () => {
    if (workspace) {
      await workspace.delete();
      workspace = undefined;
    }
    await novelDb.delete();
    await novelDb.open();
  });

  it("runSkillIteration 写入 IteratedSkillRecord，afterPrompt 通过 parseNovelSkill 验证，正式库哈希不变", async () => {
    // 1. 捕获正式库快照 + 加载到实验库
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const loaded = await loadProjectSnapshotIntoExperiment(bundle, `bench-loop6-skill-${crypto.randomUUID()}`);
    workspace = loaded.workspace;
    const experimentDb = workspace.db;

    // 2. 在实验库写入 workflowRun + draftArtifact + qualityReport
    await seedWorkflowRunInExperimentDb(experimentDb);

    // 3. 调用 runSkillIteration（默认 stage="drafting"）
    const records = await runSkillIteration({
      projectId: PROJECT_ID,
      workflowRunId: WORKFLOW_RUN_ID,
      db: experimentDb,
    });

    // 4. 验证至少 1 条 IteratedSkillRecord
    expect(records.length).toBeGreaterThanOrEqual(1);
    const record = records[0]!;
    expect(record.skillId).toBe("embodied-prose");
    expect(record.beforePrompt).not.toBe(record.afterPrompt);
    expect(record.afterPrompt.length).toBeGreaterThanOrEqual(20);
    expect(record.triggeredByIssueIds).toContain(ISSUE_ID);
    expect(record.sourceWorkflowRunId).toBe(WORKFLOW_RUN_ID);
    expect(record.model).toBe("test-model");

    // 5. 验证 record 落入实验库 iteratedSkills 表
    const storedRecords = await listIteratedSkills({ workflowRunId: WORKFLOW_RUN_ID, db: experimentDb });
    expect(storedRecords.length).toBe(records.length);
    expect(storedRecords[0]!.id).toBe(record.id);

    // 6. 验证 afterPrompt 通过 parseNovelSkill（与原 skill 元数据组合成完整 manifest）
    const originalSkill = BUILTIN_NOVEL_SKILLS.find((s) => s.skillId === "embodied-prose")!;
    expect(originalSkill).toBeDefined();
    const draftManifest = {
      skillId: originalSkill.skillId,
      version: originalSkill.version,
      name: originalSkill.name,
      description: originalSkill.description,
      locale: originalSkill.locale,
      category: originalSkill.category,
      stages: originalSkill.stages,
      triggers: originalSkill.triggers,
      requires: originalSkill.requires,
      conflicts: originalSkill.conflicts,
      priority: originalSkill.priority,
      inputSchema: originalSkill.inputSchema,
      outputSchema: originalSkill.outputSchema,
      prompt: record.afterPrompt,
      qualityChecks: originalSkill.qualityChecks,
      sourceUrl: originalSkill.sourceUrl,
      license: originalSkill.license,
    };
    // 若 afterPrompt 包含脚本注入或忽略系统指令的模式，parseNovelSkill 会抛出
    const parsed = parseNovelSkill(JSON.stringify(draftManifest));
    expect(parsed.prompt).toBe(record.afterPrompt);
    expect(parsed.skillId).toBe("embodied-prose");

    // 7. 验证 callStructuredNovelModel 被以 skill-iterator role 调用
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(callStructuredNovelModel).mock.calls[0]![0] as { role: string };
    expect(callArgs.role).toBe("skill-iterator");

    // 8. 物理证据：正式库 ProjectSnapshot 哈希不变
    const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
    assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);

    // 9. 正式库 iteratedSkills 表必须为空（实验库专有表，正式库不写入）
    const canonicalIteratedCount = await novelDb.iteratedSkills.where("projectId").equals(PROJECT_ID).count();
    expect(canonicalIteratedCount).toBe(0);

    // 10. 正式库 workflowRuns / qualityReports / workflowArtifacts 也必须无污染
    const canonicalRunCount = await novelDb.workflowRuns.where("projectId").equals(PROJECT_ID).count();
    expect(canonicalRunCount).toBe(0);
    const canonicalReportCount = await novelDb.qualityReports.where("projectId").equals(PROJECT_ID).count();
    expect(canonicalReportCount).toBe(0);
    const canonicalArtifactCount = await novelDb.workflowArtifacts.where("projectId").equals(PROJECT_ID).count();
    expect(canonicalArtifactCount).toBe(0);
  }, 30_000);

  it("qualityReport 只含 deterministic issues 时，runSkillIteration 返回空数组且不调用 LLM", async () => {
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const loaded = await loadProjectSnapshotIntoExperiment(bundle, `bench-loop6-det-${crypto.randomUUID()}`);
    workspace = loaded.workspace;
    const experimentDb = workspace.db;

    await seedWorkflowRunInExperimentDb(experimentDb, {
      nonDeterministicIssues: [
        {
          id: "issue-det-1",
          dimension: "continuity",
          severity: "warning",
          title: "时间线规则自动检测命中",
          description: "规则引擎发现时间标记冲突。",
          rule: "continuity.timeline.conflict",
          suggestion: "请作者确认时间标记。",
          deterministic: true,
        },
      ],
    });

    const records = await runSkillIteration({
      projectId: PROJECT_ID,
      workflowRunId: WORKFLOW_RUN_ID,
      db: experimentDb,
    });

    expect(records).toEqual([]);
    // candidateIssues 过滤后为空，不应调用 LLM
    expect(callStructuredNovelModel).not.toHaveBeenCalled();

    const storedRecords = await listIteratedSkills({ workflowRunId: WORKFLOW_RUN_ID, db: experimentDb });
    expect(storedRecords).toEqual([]);

    const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
    assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);
  }, 30_000);

  it("LLM 编造不存在的 skillId 时，runSkillIteration 跳过并返回空数组", async () => {
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const loaded = await loadProjectSnapshotIntoExperiment(bundle, `bench-loop6-ghost-${crypto.randomUUID()}`);
    workspace = loaded.workspace;
    const experimentDb = workspace.db;

    await seedWorkflowRunInExperimentDb(experimentDb);

    // 单次覆盖 mock：返回不存在的 skillId
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: {
        iterations: [
          {
            skillId: "ghost-skill-that-does-not-exist",
            afterPrompt:
              "这是一个修订后的 prompt，但因为 skillId 不存在，应被跳过。需要确保长度超过 20 字符以通过 schema 验证。",
            rationale: "测试用：skillId 不在激活 skills 中，应被跳过。",
            triggeredByIssueIds: [ISSUE_ID],
          },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 80 },
      promptHash: "ghost-iter",
    } as never);

    const records = await runSkillIteration({
      projectId: PROJECT_ID,
      workflowRunId: WORKFLOW_RUN_ID,
      db: experimentDb,
    });

    expect(records).toEqual([]);
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(1);

    const storedRecords = await listIteratedSkills({ workflowRunId: WORKFLOW_RUN_ID, db: experimentDb });
    expect(storedRecords).toEqual([]);

    const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
    assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);
  }, 30_000);

  it("LLM 返回与 beforePrompt 相同的 afterPrompt 时，runSkillIteration 跳过并返回空数组", async () => {
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const loaded = await loadProjectSnapshotIntoExperiment(bundle, `bench-loop6-same-${crypto.randomUUID()}`);
    workspace = loaded.workspace;
    const experimentDb = workspace.db;

    await seedWorkflowRunInExperimentDb(experimentDb);

    // 取原 skill prompt 作为 afterPrompt（与 beforePrompt 相同）
    const originalSkill = BUILTIN_NOVEL_SKILLS.find((s) => s.skillId === "embodied-prose") as NovelSkillManifest;
    const samePrompt = originalSkill.prompt;

    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: {
        iterations: [
          {
            skillId: "embodied-prose",
            afterPrompt: samePrompt,
            rationale: "测试用：afterPrompt 与 beforePrompt 相同，应被跳过。",
            triggeredByIssueIds: [ISSUE_ID],
          },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 80 },
      promptHash: "same-iter",
    } as never);

    const records = await runSkillIteration({
      projectId: PROJECT_ID,
      workflowRunId: WORKFLOW_RUN_ID,
      db: experimentDb,
    });

    expect(records).toEqual([]);
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(1);

    const storedRecords = await listIteratedSkills({ workflowRunId: WORKFLOW_RUN_ID, db: experimentDb });
    expect(storedRecords).toEqual([]);

    const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
    assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);
  }, 30_000);
});
