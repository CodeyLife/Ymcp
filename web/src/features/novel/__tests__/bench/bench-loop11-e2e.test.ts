/**
 * Loop 11 验证：runClosedLoop 编排层面的 stop-condition E2E 测试。
 *
 * 目的：验证编排函数不会绕过 PromotionService 的安全保证，在 runClosedLoop
 * 层面（而非 PromotionService 层面，Loop 8 已覆盖）验证失败传播与原子性：
 *   1. 注入失败（db.revisions.add 抛错）→ PromotionService 事务回滚 →
 *      runClosedLoop 收到 receipt.status="rejected" + 正式库 hash 不变 +
 *      failed OperationReceipt 记录错误（不抛错，返回 rejected receipt）。
 *   2. stale-baseline（runClosedLoop 执行期间正式库 final document 被修改）→
 *      inspect.status="stale-baseline" → runClosedLoop 构造 rejected receipt
 *      （不调用 promote）+ 正式库无 promotion 写入（无新 revision/factAssertion/
 *      OperationReceipt）。
 *
 * 与 Loop 8/9 的关系：
 * - Loop 8 在 createPromotionService 层面验证了注入失败回滚 + stale-baseline 检测。
 * - Loop 9 在 runClosedLoop 层面验证了 happy path（完整闭环 + hash 前进）。
 * - Loop 11 在 runClosedLoop 层面验证失败场景，确保编排函数正确传播 PromotionService
 *   的 rejected receipt 而非吞掉错误或抛出未捕获异常。
 *
 * Mock 策略：复用 bench-loop9 的 LLM mock（architect + 4 reviewers 全 5 分 +
 * fact-extractor + character-enricher + skill-iterator + streamNovelModel）。
 * Test 2 通过 vi.hoisted + mock runSkillIteration 注入"执行期间修改正式库
 * chapter1"的副作用，触发 inspect 检测 stale-baseline。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===== Test 2 专用：hoisted hook 用于在 runSkillIteration 调用前注入副作用 =====
// vi.mock 会被 hoisted 到所有 import 之前，必须用 vi.hoisted 才能在 mock 工厂内
// 安全引用模块级变量。preSkillIterationHookRef.current 在测试体内赋值。
const { preSkillIterationHookRef } = vi.hoisted(() => ({
  preSkillIterationHookRef: {
    current: undefined as (() => Promise<void>) | undefined,
  },
}));

vi.mock("../../evaluation/skill-iteration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../evaluation/skill-iteration")>();
  return {
    ...actual,
    runSkillIteration: vi.fn(async (params: Parameters<typeof actual.runSkillIteration>[0]) => {
      // 在真实 runSkillIteration 调用前执行 hook（Test 2 用于修改正式库 chapter1，
      // 触发 inspect 的 stale-baseline 检测）。hook 必须在 runSkillIteration 之前执行：
      //   - step 1 已捕获 baseSnapshot（含原始 dependencyHead）
      //   - step 8 (runSkillIteration) 修改正式库 chapter1
      //   - step 10 (inspect) 重新计算 dependencyHead → 与 candidate.dependencyHead 不一致
      if (preSkillIterationHookRef.current) {
        await preSkillIterationHookRef.current();
      }
      return actual.runSkillIteration(params);
    }),
  };
});

// ===== LLM mock：复用 bench-loop9 策略 =====
vi.mock("../../ai", () => ({
  callStructuredNovelModel: vi.fn(async ({ role }: { role: string }) => {
    if (role === "architect") {
      return {
        data: {
          title: "第二章 渡口夜话",
          objective: "沈砚在渡口客栈与线人接头，初步察觉异样",
          startingState: "沈砚独自抵达渡口，正值黄昏",
          beats: [
            { action: "沈砚进入客栈", emotion: "警惕", outcome: "观察到角落里有人等候" },
            { action: "线人传话", emotion: "怀疑", outcome: "得知旧案另有隐情" },
            { action: "夜半异响", emotion: "紧张", outcome: "发现窗外有人影" },
          ],
          endingHook: "窗外人影退去时，沈砚看见对方腰间挂着的半阕玉佩",
          characters: ["沈砚"],
          locations: ["渡口客栈"],
          informationRelease: ["旧案另有隐情"],
          mustHappen: ["沈砚与线人接头", "线人传话揭示旧案隐情"],
          flexible: ["客栈环境细节"],
          forbidden: ["直接揭示幕后黑手", "出现新 POV"],
        },
        usage: { inputTokens: 100, outputTokens: 200 },
        promptHash: "blueprint-mock",
      };
    }
    if (role === "style-reviewer" || role === "character-reviewer" || role === "continuity-reviewer" || role === "plot-reviewer") {
      return {
        data: {
          scores: { plot: 5, characterVoice: 5, sceneEmbodiment: 5, dialogue: 5, specificity: 5, hookPayoff: 5, continuity: 5 },
          issues: [],
        },
        usage: { inputTokens: 50, outputTokens: 30 },
        promptHash: `review-${role}`,
      };
    }
    if (role === "fact-extractor") {
      return { data: { summary: "无变化", facts: [] }, usage: { inputTokens: 50, outputTokens: 10 }, promptHash: "fact-empty" };
    }
    if (role === "character-enricher") {
      return { data: { enrichments: [] }, usage: { inputTokens: 50, outputTokens: 10 }, promptHash: "enrich-empty" };
    }
    if (role === "skill-iterator") {
      // reviewer 无 issues → skill-iteration 自然无迭代；返回空 iterations 保持契约一致
      return { data: { iterations: [] }, usage: { inputTokens: 50, outputTokens: 10 }, promptHash: "skill-iter-empty" };
    }
    return { data: {}, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "default" };
  }),
  streamNovelModel: vi.fn(async () => ({
    content: [
      "渡口在黄昏时起了雾。雾从江面升起，慢慢爬上栈桥，把那一排歪斜的木桩子染得发白。沈砚把斗笠压低，沿着栈桥走向那间挂着半旧灯笼的客栈。",
      "客栈里光线昏黄，几张空桌散着前客留下的茶渍。他在靠窗的位置坐下，背对墙壁，能同时看见门口与后厨的动向。小二端来一壶粗茶，茶汤浑浊，他没碰，只把杯子在掌心转了一圈。",
      "线人来得比约定时间晚了一刻。那是个披着灰布斗篷的中年人，进门时只与他对了一眼，便径直坐到对面。斗篷下摆还在滴水，在木地板上洇出一小片深色。",
      "沈砚把铜牌收入袖中，叫了一壶热茶。茶汤入喉，他这才察觉自己手心全是汗。",
      "夜半时分，沈砚被一阵极轻的脚步声惊醒。窗外有个人影，正贴着窗纸向内张望。退去的瞬间，灯笼的光扫过对方的腰间——那里挂着半阕玉佩，温润的青白玉，边缘有一道极细的裂痕。",
      "沈砚站在窗前良久。袖中的半枚铜牌硌着手腕，窗台上留着一点湿痕，正慢慢被风吹干。他知道天亮之前，他必须离开这里。",
    ].join("\n\n"),
    usage: { inputTokens: 200, outputTokens: 800 },
    promptHash: "draft-mock",
  })),
}));

import { novelDb } from "../../db";
import { runClosedLoop } from "../../evaluation/closed-loop";
import { captureProjectSnapshot } from "../../evaluation/project-snapshot";
import type {
  CreativeBrief,
  ManuscriptDocument,
  NovelConversationThread,
  NovelSkillManifest,
  StoryProject,
} from "../../types";

const PROJECT_ID = "bench-loop11-project";
const CHAPTER_1_ID = "bench-loop11-chapter-1";
const CHAPTER_2_ID = "bench-loop11-chapter-2";
const POV_CHARACTER_ID = "bench-loop11-character-shen-yan";
const THREAD_ID = "bench-loop11-thread-ch2";
const BRIEF_ID = "bench-loop11-brief-ch2";
const USER_SKILL_ID = "bench-loop11-embodied-prose";

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
 * 在正式库 seed 完整项目（与 bench-loop9 一致）：project + architecture + entity
 * + chapter1(final) + revision-1 + chapter2(draft) + outlineNode + plotThread
 * + user-scope skill + thread + brief。
 */
async function seedCanonicalProject(): Promise<void> {
  const project: StoryProject = {
    id: PROJECT_ID,
    schemaVersion: 8,
    revision: 4,
    createdAt: 1,
    updatedAt: 100,
    createdBy: "test",
    updatedBy: "test",
    title: "Loop11 闭环 E2E 验证长篇",
    subtitle: "",
    premise: "Loop11 验证用项目",
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

  await novelDb.table("architectures").put({
    ...baseRecord("architecture-1"),
    framework: "free",
    status: "approved",
    centralQuestion: "如何选择",
    centralConflict: "守诺与求生",
    synopsis: "沈砚追查旧案真相",
    phases: [],
  });

  await novelDb.table("entities").put({
    ...baseRecord(POV_CHARACTER_ID),
    kind: "character",
    name: "沈砚",
    aliases: [],
    summary: "主角，追查旧案",
    description: "青年侠客",
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

  // Chapter 1: 已 final，作为 chapter 2 的前置章节 + stale-baseline 触发目标
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
      characterIds: [POV_CHARACTER_ID],
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

  // Chapter 2: 待工作流的章节
  const chapter2: ManuscriptDocument = {
    ...baseRecord(CHAPTER_2_ID),
    order: 1,
    title: "第二章",
    blueprint: {
      goal: "渡口夜话",
      tone: "克制而诡谲",
      mustHappen: [],
      forbidden: [],
      targetWords: 3000,
      beats: [],
      characterIds: [POV_CHARACTER_ID],
    },
    contentHtml: "",
    plainText: "",
    summary: "",
    status: "draft",
    wordCount: 0,
    branch: "main",
    yjsDocumentId: "yjs-chapter-2",
    approvedRevisionId: undefined,
  } as unknown as ManuscriptDocument;
  await novelDb.table("documents").put(chapter2);

  await novelDb.table("outlineNodes").put({
    ...baseRecord("outline-node-1"),
    parentId: undefined,
    order: 0,
    title: "第一卷 起势",
    synopsis: "沈砚追查旧案的开端",
    plotSegmentId: undefined,
    chapterId: CHAPTER_2_ID,
    plotThreadIds: [],
    foreshadowingIds: [],
  });

  await novelDb.table("plotThreads").put({
    ...baseRecord("plot-thread-1"),
    title: "旧案真相",
    synopsis: "沈砚父亲旧案另有隐情",
    participantIds: [POV_CHARACTER_ID],
    status: "setup",
    resolved: false,
    arcPhase: "setup",
  });

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

  const thread: NovelConversationThread = {
    ...baseRecord(THREAD_ID),
    targetId: CHAPTER_2_ID,
    targetKind: "document",
    title: "第二章协作对话",
    status: "active",
    pinnedSourceIds: [],
    excludedSourceIds: [],
    lastMessageAt: 100,
    summary: "",
    messageCount: 0,
  } as unknown as NovelConversationThread;
  await novelDb.conversationThreads.put(thread);

  const brief: CreativeBrief = {
    ...baseRecord(BRIEF_ID),
    threadId: THREAD_ID,
    targetDocumentId: CHAPTER_2_ID,
    status: "confirmed",
    goal: "完成《第二章》正文",
    povCharacterId: POV_CHARACTER_ID,
    tone: "克制而诡谲",
    languageRequirements: ["古风文言质感", "第三人称限知"],
    mustHappen: ["沈砚与线人接头"],
    forbidden: ["使用现代词汇"],
    targetWords: 3000,
    factCutoffOrder: [],
    referencedMemoryIds: [],
    openQuestions: [],
    confirmedAt: 100,
  } as unknown as CreativeBrief;
  await novelDb.creativeBriefs.put(brief);
}

describe("Loop 11: runClosedLoop stop-condition E2E（注入失败 + stale-baseline）", () => {
  beforeEach(async () => {
    await novelDb.delete();
    await novelDb.open();
    localStorage.clear();
    await seedCanonicalProject();
    // 每个 test 前重置 hook，避免上一个 test 的副作用残留
    preSkillIterationHookRef.current = undefined;
  });

  afterEach(async () => {
    await novelDb.delete();
    await novelDb.open();
    preSkillIterationHookRef.current = undefined;
  });

  it("注入失败：db.revisions.add 抛错 → PromotionService 事务回滚 → runClosedLoop 收到 rejected receipt + 正式库 hash 不变 + failed OperationReceipt 记录", async () => {
    // 1. 捕获基线 hash
    const baselineSnapshot = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const canonicalHashBefore = baselineSnapshot.manifest.snapshotHash;

    // 2. 注入失败：spy on db.revisions.add，让 promote 事务内的 5.3 步骤抛错
    //    PromotionService 会 catch 异常 → 事务自动回滚 → 写 failed OperationReceipt
    //    → 返回 receipt.status="rejected" + error 字段
    const injectedError = new Error("injected: db.revisions.add failed");
    const revisionsAddSpy = vi.spyOn(novelDb.revisions, "add").mockRejectedValue(injectedError);

    // 3. 执行闭环（dryRun=false，会触发 promote）
    const result = await runClosedLoop({
      canonicalDb: novelDb,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_2_ID,
      threadId: THREAD_ID,
      briefId: BRIEF_ID,
      instruction: "完成《第二章》正文",
      codeRevision: "loop11-test",
      authorId: "bench-loop11-author",
      dryRun: false,
    });

    // 4. inspect 应通过（基线未变）
    expect(result.check.status).toBe("ready");
    expect(result.check.baselineMatches).toBe(true);

    // 5. promote 返回 rejected receipt（不抛错，由 PromotionService catch 后返回）
    expect(result.receipt).toBeDefined();
    expect(result.receipt!.status).toBe("rejected");
    expect(result.receipt!.candidateId).toBe(result.candidate.id);
    expect(result.receipt!.operationId).toBe(`promote:${result.candidate.id}`);
    expect(result.receipt!.createdRevisionId).toBeUndefined();
    expect(result.receipt!.createdFactAssertionIds).toEqual([]);
    expect(result.receipt!.createdMemoryIds).toEqual([]);
    expect(result.receipt!.createdOperationIds).toEqual([]);
    expect(result.receipt!.error).toContain("injected: db.revisions.add failed");

    // 6. 正式库 hash 不变（事务回滚保证零污染）
    expect(result.canonicalHashBefore).toBe(canonicalHashBefore);
    expect(result.canonicalHashAfter).toBe(canonicalHashBefore);

    // 7. 正式库无新 DocumentRevision（只有原有的 revision-1）
    const allRevisions = await novelDb.revisions.toArray();
    expect(allRevisions.length).toBe(1);
    expect(allRevisions[0]!.id).toBe("revision-1");

    // 8. 正式库无 FactAssertion
    const allFactAssertions = await novelDb.factAssertions.toArray();
    expect(allFactAssertions.length).toBe(0);

    // 9. 正式库有 failed OperationReceipt 记录错误（审计证据）
    const allReceipts = await novelDb.operationReceipts.toArray();
    const failedReceipt = allReceipts.find((r) => r.status === "failed");
    expect(failedReceipt).toBeDefined();
    expect(failedReceipt!.candidateId).toBe(result.candidate.id);
    expect(failedReceipt!.operationId).toBe(`promote:${result.candidate.id}`);
    expect(failedReceipt!.error).toContain("injected: db.revisions.add failed");
    expect(failedReceipt!.receipts.revisionId).toBeUndefined();
    expect(failedReceipt!.receipts.factAssertionIds).toEqual([]);

    // 10. chapter2 仍是 draft 状态（promote 未生效）
    const chapter2After = await novelDb.documents.get(CHAPTER_2_ID);
    expect(chapter2After!.status).toBe("draft");
    expect(chapter2After!.revision).toBe(1);
    expect(chapter2After!.approvedRevisionId).toBeUndefined();

    // 11. chapter1 未受影响（revision/approvedRevisionId 不变）
    const chapter1After = await novelDb.documents.get(CHAPTER_1_ID);
    expect(chapter1After!.revision).toBe(1);
    expect(chapter1After!.approvedRevisionId).toBe("revision-1");

    // 12. 验证 spy 被调用（证明 promote 事务确实执行到了 5.3 步骤）
    expect(revisionsAddSpy).toHaveBeenCalled();

    revisionsAddSpy.mockRestore();
  });

  it("stale-baseline：runClosedLoop 执行期间修改正式库 chapter1 → inspect.status=stale-baseline → runClosedLoop 构造 rejected receipt（不调用 promote）+ 正式库无 promotion 写入", async () => {
    // 1. 捕获基线 hash（此时 chapter1 是原始状态）
    const baselineSnapshot = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const canonicalHashBefore = baselineSnapshot.manifest.snapshotHash;

    // 2. 设置 hook：在 runSkillIteration 调用前修改正式库 chapter1（已 final）
    //    这会触发 inspect 的 stale-baseline 检测：
    //      - step 1 捕获 baseSnapshot → candidate.dependencyHead 基于原始 chapter1
    //      - step 8 (runSkillIteration) 前 hook 修改 chapter1.contentHtml/revision
    //      - step 10 (inspect) 重新计算 dependencyHead → chapter1.contentHash 不一致
    //    注意：hook 只修改正式库，不修改实验库（实验库已从 baseSnapshot 恢复）
    preSkillIterationHookRef.current = async () => {
      await novelDb.documents.update(CHAPTER_1_ID, {
        contentHtml: "<p>江水很冷，雾气从对岸飘来。</p>",
        plainText: "江水很冷，雾气从对岸飘来。",
        revision: 2,
        updatedAt: 200,
      });
    };

    // 3. 执行闭环（dryRun=false，但 inspect 会拒绝，不会真的调用 promote）
    const result = await runClosedLoop({
      canonicalDb: novelDb,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_2_ID,
      threadId: THREAD_ID,
      briefId: BRIEF_ID,
      instruction: "完成《第二章》正文",
      codeRevision: "loop11-test",
      authorId: "bench-loop11-author",
      dryRun: false,
    });

    // 4. inspect 检测到 stale-baseline
    expect(result.check.status).toBe("stale-baseline");
    expect(result.check.baselineMatches).toBe(false);
    expect(result.check.issues.length).toBeGreaterThan(0);
    expect(result.check.issues.some((issue) => issue.includes("过时基线"))).toBe(true);

    // 5. runClosedLoop 看到 check.status !== "ready" → 构造 rejected receipt
    //    （不调用 service.promote，由 closed-loop.ts 第 207-219 行的分支处理）
    expect(result.receipt).toBeDefined();
    expect(result.receipt!.status).toBe("rejected");
    expect(result.receipt!.candidateId).toBe(result.candidate.id);
    expect(result.receipt!.operationId).toBe(`promote:${result.candidate.id}`);
    expect(result.receipt!.createdRevisionId).toBeUndefined();
    expect(result.receipt!.createdFactAssertionIds).toEqual([]);
    expect(result.receipt!.createdMemoryIds).toEqual([]);
    expect(result.receipt!.createdOperationIds).toEqual([]);
    // error 字段包含 inspect.status=stale-baseline 标记
    expect(result.receipt!.error).toContain("stale-baseline");

    // 6. 正式库无新 DocumentRevision（只有原有的 revision-1）
    //    promote 未被调用 → 不会创建候选包对应的新 revision
    const allRevisions = await novelDb.revisions.toArray();
    expect(allRevisions.length).toBe(1);
    expect(allRevisions[0]!.id).toBe("revision-1");

    // 7. 正式库无 FactAssertion（promote 未执行）
    const allFactAssertions = await novelDb.factAssertions.toArray();
    expect(allFactAssertions.length).toBe(0);

    // 8. 正式库无 OperationReceipt（promote 未执行，没有 failed/completed receipt）
    const allReceipts = await novelDb.operationReceipts.toArray();
    const promoteReceipts = allReceipts.filter((r) => r.action === "promote-candidate");
    expect(promoteReceipts.length).toBe(0);

    // 9. chapter2 仍是 draft 状态（promote 未执行）
    const chapter2After = await novelDb.documents.get(CHAPTER_2_ID);
    expect(chapter2After!.status).toBe("draft");
    expect(chapter2After!.revision).toBe(1);
    expect(chapter2After!.approvedRevisionId).toBeUndefined();

    // 10. chapter1 被 hook 修改（这是 stale-baseline 的触发条件，不是 promote 写入）
    //     revision 从 1 → 2，contentHtml 变化
    const chapter1After = await novelDb.documents.get(CHAPTER_1_ID);
    expect(chapter1After!.revision).toBe(2);
    expect(chapter1After!.contentHtml).toContain("雾气从对岸飘来");

    // 11. canonicalHashAfter !== canonicalHashBefore（因为 chapter1 被 hook 修改了）
    //     但这不是 promotion 写入，是测试注入的副作用。
    //     关键不变量：没有 promotion 相关的写入（revision/factAssertion/OperationReceipt）。
    expect(result.canonicalHashBefore).toBe(canonicalHashBefore);
    expect(result.canonicalHashAfter).not.toBe(canonicalHashBefore);
  });
});
