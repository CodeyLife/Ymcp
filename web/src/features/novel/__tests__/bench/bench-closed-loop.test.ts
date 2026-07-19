/**
 * Loop 5 验证：startChapterWorkflow 在实验库上端到端跑通完整章节工作流，零正式库污染。
 *
 * 目的：Loop 4 把 memory-service + context.ts + skills/quality 工作流同步路径上的
 * 单例全部参数化为 `db?: NovelDatabase`。本测试验证：
 *   1. `startChapterWorkflow({...}, experimentDb)` 可以在实验库上跑完整章节工作流：
 *      context → blueprint → blueprint-approval → draft → review → manuscript-approval
 *      → fact-extraction → commit → character-enrichment → completed
 *   2. 中途通过 `approveWorkflowStage(runId, {...}, experimentDb)` 推过 blueprint-approval
 *      与 manuscript-approval 两道审批门。
 *   3. LLM 调用全部 mock（无网络依赖，可重复），reviewer 全 5 分通过质量门槛、
 *      fact-extraction 返回空 facts 跳过 fact-approval。
 *   4. 正式库 ProjectSnapshot 哈希在 bench 期间保持不变——这是"零正式库污染"的物理证据。
 *
 * 已知限制：
 * - 本测试 mock LLM，不验证生成内容质量——那是 bench-smoke / bench-draft 等真实 LLM 测试的职责。
 * - 不调用 novelMemoryService.getOrCreateThread/updateBrief/confirmBrief（这些函数尚未参数化 db），
 *   改为直接在实验库写入 thread + brief 记录，等价于 memory-service 完成后的状态。
 * - 不走 fact-approval（fact-extraction 返回空 facts 直接进 commit）——fact-approval 审批流的
 *   实验库验证留待后续 loop（需先把 fact-approval handler 的 db 参数路径在闭环中跑过）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock LLM 调用：所有阶段返回确定性数据，避免网络依赖。
// callStructuredNovelModel 按 role 分发；streamNovelModel 返回足够长的中文正文。
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
          endingHook: "窗外人影退去时，沈砚看见对方腰间挂着的半阕玉佩——与他幼年遗失的那块成对",
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
    return { data: {}, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "default" };
  }),
  streamNovelModel: vi.fn(async () => ({
    content: [
      "渡口在黄昏时起了雾。雾从江面升起，慢慢爬上栈桥，把那一排歪斜的木桩子染得发白。沈砚把斗笠压低，沿着栈桥走向那间挂着半旧灯笼的客栈。木牌在风里吱呀作响，像是在替他数着步子。",
      "客栈里光线昏黄，几张空桌散着前客留下的茶渍。他在靠窗的位置坐下，背对墙壁，能同时看见门口与后厨的动向。小二端来一壶粗茶，茶汤浑浊，他没碰，只把杯子在掌心转了一圈。",
      "线人来得比约定时间晚了一刻。那是个披着灰布斗篷的中年人，进门时只与他对了一眼，便径直坐到对面。斗篷下摆还在滴水，在木地板上洇出一小片深色。",
      "“东西带来了？”沈砚问。",
      "线人没有立刻回答，只把一只粗布小囊推过桌面。囊口未系，里面是半枚烧焦的铜牌。铜牌边缘有火舔过的痕迹，但中间刻的字还依稀可辨——是个“沈”字。",
      "“旧案另有隐情。”线人的声音压得极低，“当年不是误判，是有人换掉了卷宗。你父亲那夜不是去救人的。”",
      "沈砚的指尖在铜牌上停了一瞬。他认得这枚铜牌——与他幼年家中失火那夜父亲紧紧攥在手里的那枚，是一对。那夜火光透过窗纸映在父亲脸上，他记得父亲最后望向他的眼神，不是惊慌，是某种近乎释然的疲惫。",
      "“换卷宗的人呢？”",
      "“不知道。”线人起身，斗篷带倒了桌边的茶杯，浊水洇开，“我只能送到这里。后头的路，你自己走。”",
      "线人走后，沈砚把铜牌收入袖中，叫了一壶热茶。茶汤入喉，他这才察觉自己手心全是汗。客栈里其他客人陆续散去，只剩角落里一个伏桌打盹的老者，和后厨偶尔传来的碗碟碰撞声。",
      "客栈外风声渐紧。窗纸被吹得鼓起又塌下，像有人贴着窗子在听。沈砚没有点灯，只借着窗外残月的微光，把那只小囊翻来覆去地看。囊布是粗麻，针脚歪斜，像是匆忙间随手缝制的。",
      "夜半时分，沈砚被一阵极轻的脚步声惊醒。他没有动，只把呼吸放到最缓，眼睛微微睁开一条缝。脚步声在窗外停住了，紧接着是衣料擦过墙板的细微声响。",
      "窗外有个人影，正贴着窗纸向内张望。那人身上的气息带着河水的腥气，衣服显然湿透了。沈砚能看见对方眼白的反光，却看不见眉眼。",
      "沈砚握紧了枕下的短刀，等对方下一步动作。但那人影只是看了片刻，便悄然后退。退到第三步时，脚步声消失了，仿佛从未存在过。",
      "退去的瞬间，灯笼的光扫过对方的腰间——那里挂着半阕玉佩，温润的青白玉，边缘有一道极细的裂痕。那道裂痕的形状像一弯反挂的月牙。",
      "沈砚的呼吸停住了。那道裂痕，他认得。幼年时他有一块成对的玉佩，失火那夜不知所踪。母亲临终前曾抓着他的手说，那对玉佩是定情之物，一块在父亲手中，一块在另一个人手中——那个人的名字，她没能说出来。",
      "他翻身而起，推开窗子。夜风灌入，灯笼晃灭。客栈外只剩江水拍岸的声音，那人影已消失在雾里。栈桥尽头的灯笼还在晃，但雾太浓，看不见人。",
      "沈砚站在窗前良久。袖中的半枚铜牌硌着手腕，窗台上留着一点湿痕，正慢慢被风吹干。湿痕的形状像一只按在窗台上的手印，指节修长，不像习武之人。",
      "他知道天亮之前，他必须离开这里。但那半阕玉佩，让他第一次怀疑，旧案里失的不只是父亲的命，还有他从未看清的另一个人。那个人或许一直活着，活在卷宗之外，活在他从未怀疑过的某个角落。",
      "他把铜牌与那点湿痕的形状一并记在心里，重新整束行装。短刀入鞘，斗笠压低。客栈后墙外有一段矮篱，翻过去就是江边的芦苇荡。芦苇荡里能藏人，也能藏船。",
      "推开后窗的瞬间，雾里忽然传来一声极轻的咳嗽——不是线人的声音，也不是方才窗外那人的声音。是一个女人的咳嗽，短促而克制，像是不愿被人听见。沈砚握紧短刀，但那咳嗽声没有再响起，只剩芦苇在风里相互摩擦的沙沙声。",
      "他跃出窗外，身影很快被雾吞没。客栈里的灯彻底熄了，江面上慢慢浮起一层薄薄的晨光。新的一天要开始了，而他要走的路，比昨夜更长。",
    ].join("\n\n"),
    usage: { inputTokens: 200, outputTokens: 1500 },
    promptHash: "draft-mock",
  })),
}));

import { novelDb, type NovelDatabase } from "../../db";
import { captureProjectSnapshot } from "../../evaluation/project-snapshot";
import { loadProjectSnapshotIntoExperiment, type ExperimentWorkspace } from "../../evaluation/experiment-workspace";
import { approveWorkflowStage, startChapterWorkflow } from "../../workflow";
import type { CreativeBrief, ManuscriptDocument, NovelConversationThread, StoryProject } from "../../types";
import {
  assertCanonicalHashUnchanged,
  captureCanonicalHash,
} from "./bench-experiment-helpers";

const PROJECT_ID = "bench-loop5-project";
const CHAPTER_1_ID = "bench-loop5-chapter-1";
const CHAPTER_2_ID = "bench-loop5-chapter-2";
const POV_CHARACTER_ID = "bench-loop5-character-shen-yan";
const THREAD_ID = "bench-loop5-thread-ch2";
const BRIEF_ID = "bench-loop5-brief-ch2";

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
    revision: 4,
    createdAt: 1,
    updatedAt: 100,
    createdBy: "test",
    updatedBy: "test",
    title: "Loop5 闭环验证长篇",
    subtitle: "",
    premise: "Loop5 验证用项目",
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

  // Chapter 1: 已 final，作为 chapter 2 的前置章节
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

  // 一条 outlineNode + 一条 plotThread，让 context packet 有 sources
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
}

/**
 * 在实验库直接写入 thread + brief 记录，等价于 novelMemoryService.getOrCreateThread +
 * getDraftBrief + updateBrief + confirmBrief 完成后的状态。
 *
 * 不调用 memory-service 的原因是那些函数尚未参数化 db（Loop 5 范围外）。
 * 闭环验证只需要 thread + brief 在 experimentDb 中存在且字段正确。
 */
async function seedThreadAndBriefInExperimentDb(db: NovelDatabase): Promise<void> {
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
  await db.conversationThreads.put(thread);

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
  await db.creativeBriefs.put(brief);
}

describe("Loop 5: startChapterWorkflow 在实验库上跑通完整章节工作流，零正式库污染", () => {
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

  it("startChapterWorkflow({...}, experimentDb) 跑通 context→blueprint→draft→review→commit→completed", async () => {
    // 1. 捕获正式库快照 + 加载到实验库
    const bundle = await captureProjectSnapshot(novelDb, PROJECT_ID, "chapter-baseline");
    const loaded = await loadProjectSnapshotIntoExperiment(bundle, `bench-loop5-closed-${crypto.randomUUID()}`);
    workspace = loaded.workspace;
    const experimentDb = workspace.db;

    // 2. 在实验库直接写入 thread + brief
    await seedThreadAndBriefInExperimentDb(experimentDb);

    // 3. 启动章节工作流（context → blueprint → blueprint-approval 暂停）
    let run = await startChapterWorkflow(
      {
        projectId: PROJECT_ID,
        documentId: CHAPTER_2_ID,
        threadId: THREAD_ID,
        briefId: BRIEF_ID,
        instruction: "完成《第二章》正文",
        blocking: true,
      },
      experimentDb,
    );
    expect(run.status).toBe("waiting-approval");
    expect(run.currentStage).toBe("blueprint-approval");
    expect(run.blueprintArtifactId).toBeDefined();
    expect(run.contextPacketId).toBeDefined();

    // 验证 context packet + blueprint artifact 落在实验库，不在正式库
    const experimentPacket = await experimentDb.contextPackets.get(run.contextPacketId!);
    expect(experimentPacket).toBeDefined();
    const canonicalPacketCount = await novelDb.contextPackets.where("projectId").equals(PROJECT_ID).count();
    expect(canonicalPacketCount).toBe(0);

    const experimentBlueprint = await experimentDb.workflowArtifacts.get(run.blueprintArtifactId!);
    expect(experimentBlueprint).toBeDefined();
    expect(experimentBlueprint?.kind).toBe("blueprint");
    const canonicalArtifactCount = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).count();
    expect(canonicalArtifactCount).toBe(0);

    // 4. 批准蓝图 → draft → review → manuscript-approval 暂停
    run = await approveWorkflowStage(run.id, { approved: true }, experimentDb);
    expect(run.status).toBe("waiting-approval");
    expect(run.currentStage).toBe("manuscript-approval");
    expect(run.draftArtifactId).toBeDefined();
    expect(run.qualityReportId).toBeDefined();

    // 验证 draft artifact + quality report 落在实验库
    const experimentDraft = await experimentDb.workflowArtifacts.get(run.draftArtifactId!);
    expect(experimentDraft).toBeDefined();
    expect(experimentDraft?.kind).toBe("draft");
    expect(experimentDraft?.contentMarkdown.length).toBeGreaterThan(1000);

    const experimentReport = await experimentDb.qualityReports.get(run.qualityReportId!);
    expect(experimentReport).toBeDefined();
    expect(experimentReport?.passed).toBe(true);
    // 4个 reviewer 各打 5 分，与 deterministic 默认 4.2 分逐次平均后得到 4.95
    expect(experimentReport?.weightedScore).toBeGreaterThanOrEqual(4.5);
    const canonicalReportCount = await novelDb.qualityReports.where("workflowRunId").equals(run.id).count();
    expect(canonicalReportCount).toBe(0);

    // 5. 批准正文 → fact-extraction → commit → character-enrichment → completed
    run = await approveWorkflowStage(run.id, { approved: true }, experimentDb);
    expect(run.status).toBe("completed");
    expect(run.currentStage).toBe("character-enrichment");

    // 6. 验证实验库的章节状态已更新为 final
    const finalDoc = await experimentDb.documents.get(CHAPTER_2_ID);
    expect(finalDoc?.status).toBe("final");
    expect(finalDoc?.wordCount).toBeGreaterThan(0);
    expect(finalDoc?.plainText.length).toBeGreaterThan(0);
    expect(finalDoc?.approvedRevisionId).toBeDefined();

    // 7. 验证 commit-stage 写入了 workflowSnapshot（落在实验库的 snapshots 表）
    const experimentSnapshots = await experimentDb.snapshots.where("projectId").equals(PROJECT_ID).count();
    expect(experimentSnapshots).toBeGreaterThanOrEqual(1);
    const canonicalSnapshotsBefore = await novelDb.snapshots.where("projectId").equals(PROJECT_ID).count();
    expect(canonicalSnapshotsBefore).toBe(0);

    // 8. 验证 commit-stage 写入了 derivedMemory（落在实验库的 derivedMemories 表）
    const experimentMemories = await experimentDb.derivedMemories.where("documentId").equals(CHAPTER_2_ID).count();
    expect(experimentMemories).toBeGreaterThanOrEqual(1);
    const canonicalMemories = await novelDb.derivedMemories.where("documentId").equals(CHAPTER_2_ID).count();
    expect(canonicalMemories).toBe(0);

    // 9. 物理证据：正式库 ProjectSnapshot 哈希不变
    const canonicalHashAfter = await captureCanonicalHash(PROJECT_ID, "post-bench");
    assertCanonicalHashUnchanged(canonicalHashBefore, canonicalHashAfter);
  }, 60_000);
});
