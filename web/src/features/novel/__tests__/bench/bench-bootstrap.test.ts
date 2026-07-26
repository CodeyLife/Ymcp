/**
 * Fixture 生成测试：跑完整 foundation（9 阶段）+ context + blueprint，
 * 序列化关键产物为可复用 fixture，供切片测试与冒烟测试加载。
 *
 * 默认 skip，通过 BENCH_BOOTSTRAP=true 启用：
 *   BENCH_BOOTSTRAP=true npx vitest run --config vitest.bench.config.ts bench-bootstrap.test.ts
 *
 * 已存在 fixture 时跳过（除非 FORCE_REGEN=true）。
 * 一次性成本约 15 分钟，之后所有切片测试秒级加载。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { DEFAULT_API_KEY } from "@/config/defaults";

// DEV 代理绕过：让 getEffectiveApiConfig 返回带显式 :443 端口的等价 URL
vi.mock("@/stores/ui", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEffectiveApiConfig: () => ({
      baseUrl: "https://chat.yujin8.top/v1",
      apiKey: DEFAULT_API_KEY,
      usesDefaultBaseUrl: false,
      hasOwnKey: true,
      modelContextWindow: 0,
    }),
  };
});

import { createNovelProject, novelDb } from "../../db";
import {
  applyProposalItems,
  runGenerationTask,
  runPlotDesignTask,
} from "../../generation";
import { startChapterWorkflow } from "../../workflow";
import { novelMemoryService } from "../../memory-service";
import { formatContextPacket, formatReviewerContext } from "../../context";
import {
  FIXTURE_DIR,
  fixtureExists,
  saveFixture,
  resetDb,
  log,
} from "./bench-helpers";

const SHOULD_RUN = process.env.BENCH_BOOTSTRAP === "true";
const FORCE_REGEN = process.env.FORCE_REGEN === "true";
const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

// 与 e2e 测试相同主题（古风权谋+探案），便于横向对比
const CORE_IDEA =
  "东宫太子暴毙于初雪夜，三位身份悬殊的人——失宠皇子、女史、市井仵作——因一具尸体被迫结成临时代查之契。真凶不止一个，每个人都因这桩死亡获得了想要的或惧怕的东西。";

async function acceptProposal(proposalId: string) {
  const proposal = await novelDb.proposals.get(proposalId);
  if (!proposal) throw new Error(`proposal ${proposalId} 不存在`);
  const itemIds = proposal.items.map((item) => item.id);
  return applyProposalItems(proposalId, itemIds);
}

/** 序列化项目所有地基阶段写入的 DB 数据，供冒烟测试加载 */
async function serializeFoundation(projectId: string) {
  const tables = [
    "architectures",
    "entities",
    "relations",
    "outlineNodes",
    "scenes",
    "plotThreads",
    "foreshadowing",
    "timelineEvents",
    "documents",
  ] as const;
  const snapshot: Record<string, unknown[]> = {};
  for (const table of tables) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshot[table] = await (novelDb as any)[table]
      .where("projectId")
      .equals(projectId)
      .toArray();
  }
  const project = await novelDb.projects.get(projectId);
  return { project, ...snapshot };
}

describeOrSkip("bench-bootstrap: 生成 fixture", { timeout: 1_200_000 }, () => {
  it("runs foundation + blueprint and serializes fixtures", async () => {
    // 检查 fixture 是否已存在
    if (
      !FORCE_REGEN &&
      fixtureExists("foundation.json") &&
      fixtureExists("ch1-blueprint.json") &&
      fixtureExists("ch1-context-packet.json")
    ) {
      log("bootstrap", "fixture 已存在，跳过生成（使用 FORCE_REGEN=true 强制重新生成）");
      return;
    }

    mkdirSync(FIXTURE_DIR, { recursive: true });
    await resetDb();

    // === 1. 创建项目 ===
    const project = await createNovelProject({
      title: "初雪夜长歌",
      genre: ["古风", "权谋", "探案"],
      premise: CORE_IDEA,
    });
    log("bootstrap", `项目已创建：${project.id}`);

    // === 2. 地基 9 阶段 ===
    log("bootstrap", "→ project-positioning");
    const positioning = await runGenerationTask({
      projectId: project.id,
      taskKey: "project-positioning",
      instruction:
        "根据核心创意完善题材定位、目标读者、主题、卖点、叙事视角、基调和语言风格。古风权谋探案：以《琅琊榜》《长安十二时辰》为审美参照，重视宫廷礼俗、市井烟火与朝堂暗流交织。",
    });
    await acceptProposal(positioning.proposal.id);

    log("bootstrap", "→ architecture");
    const architecture = await runGenerationTask({
      projectId: project.id,
      taskKey: "architecture",
      instruction:
        "为长篇生成可支撑数百万字铺陈的全书架构。本作为古风权谋探案，需要：1) 朝堂权力格局、江湖势力、隐秘组织三条张力线交织；2) 四到五个不可逆阶段（暴毙案发→临时代查→幕后显形→朝堂对决→余烬与新生），每个阶段的 purpose 用文学化叙事描述人物处境与情感走向；3) 留出至少两到三条可在后续百章缓慢发酵的长线伏笔。",
    });
    await acceptProposal(architecture.proposal.id);
    const arch = await novelDb.architectures
      .where("projectId")
      .equals(project.id)
      .first();
    if (!arch || !arch.phases.length) throw new Error("架构未生成阶段");

    log("bootstrap", "→ characters");
    const characters = await runGenerationTask({
      projectId: project.id,
      taskKey: "characters",
      instruction:
        "设计 4-5 位核心角色：失宠皇子（视角人物之一）、女史（视角人物之二，宫中文献官）、市井仵作（视角人物之三，验尸识骨）、太子太傅（重要配角，深藏不露）、掌事宦官（次要反派，依附权臣）。每人需有明确的欲望、恐惧、错误信念、秘密、人物弧和差异化声音。",
    });
    await acceptProposal(characters.proposal.id);

    log("bootstrap", "→ relations");
    const relations = await runGenerationTask({
      projectId: project.id,
      taskKey: "relations",
      instruction:
        "为已生成的核心角色设计会推动选择与冲突的人物关系：朝堂明面关系（君臣、师生、同僚）+ 私下隐情（旧恩、暗债、血脉疑云）。每条关系需有 publicLabel 和 privateTruth，关系类型不得雷同。",
    });
    await acceptProposal(relations.proposal.id);

    log("bootstrap", "→ worldview");
    const worldview = await runGenerationTask({
      projectId: project.id,
      taskKey: "worldview",
      instruction:
        "完善古风权谋探案世界观：1) 地点（东宫、掖庭、刑部仵作房、市井瓦肆、城外山寺）；2) 组织（清查司、内书堂、瓦肆说书人网络）；3) 阵营（东宫属官、外戚、勋贵、寒门言官）；4) 物品（太子随身的玉鱼符、女史的私人手札、仵作的银针与验骨伞）；5) 规则（朝堂奏对礼俗、刑名验尸法度、宫禁出入令）。",
    });
    await acceptProposal(worldview.proposal.id);

    log("bootstrap", "→ plot-threads");
    const threads = await runGenerationTask({
      projectId: project.id,
      taskKey: "plot-threads",
      instruction:
        "规划 4 条剧情线：1) 主线——太子暴毙案真相逐步显形；2) 支线——失宠皇子被推回权力中心的政治暗流；3) 感情线——失宠皇子与女史的旧识与新疑；4) 成长线——市井仵作从局外人变为承担朝堂重量的关键证人。",
    });
    await acceptProposal(threads.proposal.id);

    log("bootstrap", "→ foreshadowing");
    const foreshadowing = await runGenerationTask({
      projectId: project.id,
      taskKey: "foreshadowing",
      instruction:
        "规划 4 条伏笔：1) 太子暴毙前夜赠予女史的私人手札，内夹一片被刻意烧焦半角的绢帛；2) 仵作在尸检时于太子舌下发现的一粒带特殊香气的丹砂；3) 失宠皇子三年前被贬离京时在城门听到的一句童谣；4) 掌事宦官腰间那枚不属于他品级的玉坠。",
    });
    await acceptProposal(foreshadowing.proposal.id);

    log("bootstrap", "→ timeline");
    const timeline = await runGenerationTask({
      projectId: project.id,
      taskKey: "timeline",
      instruction:
        "生成太子暴毙前 7 日与暴毙后 3 日的关键时间线事件（共 8-12 条），每条事件标注故事日期、持续时间、参与者、原因与后果。",
    });
    await acceptProposal(timeline.proposal.id);

    log("bootstrap", "→ plot-design (first phase)");
    const firstPhase = arch.phases[0];
    const plotDesign = await runPlotDesignTask({
      projectId: project.id,
      phaseId: firstPhase.id,
      instruction:
        "在第一幕下设计第一个剧情段及其章节（2-4 章）。本作第一章是引子章，应承担'暴毙之夜的多视角切片'功能：让三位主角分别与太子发生某种接触或位置接近，并在章尾汇合于一个共同信息压力。",
    });
    await acceptProposal(plotDesign.proposal.id);

    // === 3. 序列化 foundation fixture ===
    log("bootstrap", "序列化 foundation.json");
    const foundationSnapshot = await serializeFoundation(project.id);
    saveFixture("foundation.json", foundationSnapshot);

    // === 4. 选择第 1 章 + 创建协作对话 + 创作简报 ===
    const documents = await novelDb.documents
      .where("projectId")
      .equals(project.id)
      .sortBy("order");
    if (!documents.length) throw new Error("plot-design 未生成章节");
    const chapter1 = documents[0];
    log("bootstrap", `第 1 章：${chapter1.title}`);

    const thread = await novelMemoryService.getOrCreateThread({
      projectId: project.id,
      targetDocumentId: chapter1.id,
    });
    const draftBrief = await novelMemoryService.getDraftBrief(thread.id);
    const povCharacter = await novelDb.entities
      .where("projectId")
      .equals(project.id)
      .filter((e) => e.kind === "character")
      .first();
    const updatedBrief = await novelMemoryService.updateBrief(draftBrief.id, {
      goal: `完成《${chapter1.title}》正文。本章是引子章，承担"暴毙之夜多视角切片"功能。三位主角在同一夜里分别与太子发生某种接触或位置接近，并在章尾汇合于一个共同信息压力。不要揭示真凶或核心动机。`,
      povCharacterId: povCharacter?.id,
      tone: "克制而诡谲，宫廷礼俗与市井烟火交织",
      languageRequirements: [
        "古风文言质感，但不堆砌典故",
        "对白要区分朝堂典雅与市井俚俗",
        "意象要承担信息压力，不只是装饰",
      ],
      mustHappen: [
        "三位主角分别在暴毙之夜出现在太子附近",
        "章尾三人汇合于一个共同信息压力点（同一具尸体、同一行字或同一物事）",
      ],
      forbidden: [
        "揭示太子真凶或核心动机",
        "使用现代词汇或网络用语",
        "使用 AI 痕迹明显的对仗排比堆砌",
      ],
      targetWords: 6000,
    });
    const confirmedBrief = await novelMemoryService.confirmBrief(updatedBrief.id);

    // === 5. 启动章节 workflow（停在 blueprint-approval） ===
    log("bootstrap", "→ startChapterWorkflow (context → blueprint → blueprint-approval)");
    const run = await startChapterWorkflow({
      projectId: project.id,
      documentId: chapter1.id,
      threadId: thread.id,
      briefId: confirmedBrief.id,
      instruction: confirmedBrief.goal,
      blocking: true,
    });

    if (run.status !== "waiting-approval" || run.currentStage !== "blueprint-approval") {
      throw new Error(
        `预期停在 blueprint-approval，实际：stage=${run.currentStage} status=${run.status} error=${run.error ?? "无"}`,
      );
    }
    log("bootstrap", `蓝图已生成，工作流停在 blueprint-approval`);

    // === 6. 提取 blueprint artifact 与 context packet ===
    const blueprintArtifact = run.blueprintArtifactId
      ? await novelDb.workflowArtifacts.get(run.blueprintArtifactId)
      : undefined;
    if (!blueprintArtifact) throw new Error("蓝图 artifact 不存在");

    const contextPacket = run.contextPacketId
      ? await novelDb.contextPackets.get(run.contextPacketId)
      : undefined;
    if (!contextPacket) throw new Error("context packet 不存在");

    // === 7. 序列化 blueprint fixture ===
    log("bootstrap", "序列化 ch1-blueprint.json");
    saveFixture("ch1-blueprint.json", {
      contentMarkdown: blueprintArtifact.contentMarkdown,
      structuredData: blueprintArtifact.structuredData,
      targetWords: chapter1.blueprint.targetWords || 6000,
      documentTitle: chapter1.title,
      documentId: chapter1.id,
      projectId: project.id,
      povCharacterId: povCharacter?.id,
      model: project.settings.textModel,
      temperature: project.settings.temperature,
      contentProfile: project.settings.contentProfile,
    });

    // === 8. 序列化 context packet fixture ===
    log("bootstrap", "序列化 ch1-context-packet.json");
    saveFixture("ch1-context-packet.json", {
      formattedContext: formatContextPacket(contextPacket),
      formattedReviewerContext: formatReviewerContext(contextPacket),
      rawPacket: contextPacket,
    });

    log("bootstrap", "fixture 生成完成 ✓");
    expect(blueprintArtifact.contentMarkdown.length).toBeGreaterThan(100);
    expect(contextPacket.sources.length).toBeGreaterThan(0);
  });
});
