import { describe, expect, it, vi } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { DEFAULT_API_KEY } from "@/config/defaults";

// 与 e2e-chapter1.test.ts 相同的 DEV 代理绕过
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

import { createNovelProject, novelDb } from "../db";
import { applyProposalItems, runGenerationTask, runPlotDesignTask } from "../generation";
import { approveWorkflowStage, startChapterWorkflow } from "../workflow";
import { novelMemoryService } from "../memory-service";
import { autoAcceptSafeFactCandidates, bulkSetFactCandidateStatus, setFactCandidateStatus } from "../facts";

const OUTPUT_DIR = ".goal/goals/novel-e2e-deepening/tmp";

// 与 e2e-chapter1.test.ts 相同主题，便于横向对比
const CORE_IDEA = "东宫太子暴毙于初雪夜，三位身份悬殊的人——失宠皇子、女史、市井仵作——因一具尸体被迫结成临时代查之契。真凶不止一个，每个人都因这桩死亡获得了想要的或惧怕的东西。";

// 默认 skip：本测试需 ~40-50 分钟实际 LLM 时间，CI 不应自动跑。
// 启用方式：RUN_E2E_CHAPTERS_1_TO_3=true npx vitest run src/features/novel/__tests__/e2e-chapters-1-to-3.test.ts
const SHOULD_RUN = process.env.RUN_E2E_CHAPTERS_1_TO_3 === "true";
const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

async function resetDb() {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
}

function persist(name: string, content: unknown) {
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  writeFileSync(`${OUTPUT_DIR}/${name}`, text);
}

async function acceptProposal(proposalId: string) {
  const proposal = await novelDb.proposals.get(proposalId);
  if (!proposal) throw new Error(`proposal ${proposalId} 不存在`);
  const itemIds = proposal.items.map((item) => item.id);
  return applyProposalItems(proposalId, itemIds);
}

async function runFoundation(projectId: string) {
  console.log("[e2e-ch1-3] → project-positioning");
  const positioning = await runGenerationTask({
    projectId,
    taskKey: "project-positioning",
    instruction: "根据核心创意完善题材定位、目标读者、主题、卖点、叙事视角、基调和语言风格。古风权谋探案：以《琅琊榜》《长安十二时辰》为审美参照，重视宫廷礼俗、市井烟火与朝堂暗流交织。",
  });
  persist("ch13-01-positioning-proposal.json", positioning.proposal);
  await acceptProposal(positioning.proposal.id);

  console.log("[e2e-ch1-3] → architecture");
  const architecture = await runGenerationTask({
    projectId,
    taskKey: "architecture",
    instruction: "为长篇生成可支撑数百万字铺陈的全书架构。本作为古风权谋探案，需要：1) 朝堂权力格局、江湖势力、隐秘组织三条张力线交织；2) 四到五个不可逆阶段（暴毙案发→临时代查→幕后显形→朝堂对决→余烬与新生），每个阶段的 purpose 用文学化叙事描述人物处境与情感走向，不要用'建立X''让Y做Z'等编剧指令腔；3) 留出至少两到三条可在后续百章缓慢发酵的长线伏笔（如三年前旧案、皇室血脉疑云、市井传言体系）。",
  });
  persist("ch13-02-architecture-proposal.json", architecture.proposal);
  await acceptProposal(architecture.proposal.id);
  const arch = await novelDb.architectures.where("projectId").equals(projectId).first();
  if (!arch || !arch.phases.length) throw new Error("架构未生成阶段");

  console.log("[e2e-ch1-3] → characters");
  const characters = await runGenerationTask({
    projectId,
    taskKey: "characters",
    instruction: "设计 4-5 位核心角色：失宠皇子（视角人物之一）、女史（视角人物之二，宫中文献官）、市井仵作（视角人物之三，验尸识骨）、太子太傅（重要配角，深藏不露）、掌事宦官（次要反派，依附权臣）。每人需有明确的欲望、恐惧、错误信念、秘密、人物弧和差异化声音。注意古风权谋探案题材的声音层次：朝堂人物典雅克制、市井人物鲜活俚俗，不可共享同一种书面腔。",
  });
  persist("ch13-03-characters-proposal.json", characters.proposal);
  await acceptProposal(characters.proposal.id);

  console.log("[e2e-ch1-3] → relations");
  const relations = await runGenerationTask({
    projectId,
    taskKey: "relations",
    instruction: "为已生成的核心角色设计会推动选择与冲突的人物关系：朝堂明面关系（君臣、师生、同僚）+ 私下隐情（旧恩、暗债、血脉疑云）。每条关系需有 publicLabel（公开标签）和 privateTruth（隐情），关系类型不得雷同。仵作与女史之间应有一条非血缘的旧恩（如女史幼时被仵作之父收留半日这种细节级旧恩）。",
  });
  persist("ch13-04-relations-proposal.json", relations.proposal);
  await acceptProposal(relations.proposal.id);

  console.log("[e2e-ch1-3] → worldview");
  const worldview = await runGenerationTask({
    projectId,
    taskKey: "worldview",
    instruction: "完善古风权谋探案世界观：1) 地点（东宫、掖庭、刑部仵作房、市井瓦肆、城外山寺）；2) 组织（清查司、内书堂、瓦肆说书人网络）；3) 阵营（东宫属官、外戚、勋贵、寒门言官）；4) 物品（太子随身的玉鱼符、女史的私人手札、仵作的银针与验骨伞）；5) 规则（朝堂奏对礼俗、刑名验尸法度、宫禁出入令）。注意：地点与规则必须为后续探案与权谋场景提供可被剧情利用的具体约束（如刑部仵作房在子时后不得点灯，这种细节）。避免堆砌设定清单。",
  });
  persist("ch13-05-worldview-proposal.json", worldview.proposal);
  await acceptProposal(worldview.proposal.id);

  console.log("[e2e-ch1-3] → plot-threads");
  const threads = await runGenerationTask({
    projectId,
    taskKey: "plot-threads",
    instruction: "规划 4 条剧情线：1) 主线——太子暴毙案真相逐步显形；2) 支线——失宠皇子被推回权力中心的政治暗流；3) 感情线——失宠皇子与女史的旧识与新疑；4) 成长线——市井仵作从局外人变为承担朝堂重量的关键证人。每条线需明确参与者、当前状态、优先级与下一步推进。注意：感情线必须双向且服务主线，不得工业糖精。",
  });
  persist("ch13-06-threads-proposal.json", threads.proposal);
  await acceptProposal(threads.proposal.id);

  console.log("[e2e-ch1-3] → foreshadowing");
  const foreshadowing = await runGenerationTask({
    projectId,
    taskKey: "foreshadowing",
    instruction: "规划 4 条伏笔：1) 太子暴毙前夜赠予女史的私人手札，内夹一片被刻意烧焦半角的绢帛；2) 仵作在尸检时于太子舌下发现的一粒带特殊香气的丹砂；3) 失宠皇子三年前被贬离京时在城门听到的一句童谣；4) 掌事宦官腰间那枚不属于他品级的玉坠。每条伏笔需记录读者可见线索、角色可知范围、预期误读、揭示条件与回收影响。",
  });
  persist("ch13-07-foreshadowing-proposal.json", foreshadowing.proposal);
  await acceptProposal(foreshadowing.proposal.id);

  console.log("[e2e-ch1-3] → timeline");
  const timeline = await runGenerationTask({
    projectId,
    taskKey: "timeline",
    instruction: "生成太子暴毙前 7 日与暴毙后 3 日的关键时间线事件（共 8-12 条），每条事件标注故事日期、持续时间、参与者、原因与后果。注意：事件因果链必须能解释案发当晚各角色的位置与动机，但不得直接揭示真凶。",
  });
  persist("ch13-08-timeline-proposal.json", timeline.proposal);
  await acceptProposal(timeline.proposal.id);

  console.log("[e2e-ch1-3] → plot-design (first phase, 3 chapters)");
  const firstPhase = arch.phases[0];
  const plotDesign = await runPlotDesignTask({
    projectId,
    phaseId: firstPhase.id,
    instruction: "在第一幕下设计第一个剧情段及其章节（3 章）。第 1 章是引子章（暴毙之夜多视角切片，三人汇合于同一信息压力）；第 2 章是余波章（次日清晨各自善后与初步接触代查机制，让仵作与女史在刑部仵作房相遇）；第 3 章是蓄势章（三人首次正式会面代查，揭开第一层误读并埋下第二层压力）。注意：每章应有清晰的叙事功能差异，不得让三章都承担相同功能。",
  });
  persist("ch13-09-plot-design-proposal.json", plotDesign.proposal);
  await acceptProposal(plotDesign.proposal.id);

  return { arch };
}

async function persistAllArtifacts(runId: string, label: string) {
  const artifacts = await novelDb.workflowArtifacts.where("workflowRunId").equals(runId).sortBy("createdAt");
  persist(`ch13-${label}-artifacts.json`, artifacts.map((a) => ({
    id: a.id, stage: a.stage, kind: a.kind, title: a.title,
    contentPreview: a.contentMarkdown?.slice(0, 400),
    contentLength: a.contentMarkdown?.length ?? 0,
    structuredDataKeys: a.structuredData ? Object.keys(a.structuredData) : [],
  })));
  for (const a of artifacts) {
    if (a.kind === "blueprint" || a.kind === "draft" || a.kind === "revision" || a.kind === "fact-delta" || a.kind === "review") {
      persist(`ch13-${label}-${a.stage}-${a.kind}.md`, a.contentMarkdown ?? "");
    }
  }
}

// 跑单章完整 workflow（context→blueprint→...→completed），返回最终 run 与质量报告
async function runSingleChapterWorkflow(params: {
  projectId: string;
  chapter: { id: string; title: string; order: number };
  povCharacterId?: string;
  goal: string;
  tone: string;
  languageRequirements: string[];
  mustHappen: string[];
  forbidden: string[];
  targetWords: number;
  chapterLabel: string; // "ch1" / "ch2" / "ch3"
}) {
  const { projectId, chapter, chapterLabel } = params;
  console.log(`[e2e-ch1-3] === 第 ${chapter.order} 章 workflow 开始 ===`);
  const thread = await novelMemoryService.getOrCreateThread({ projectId, targetDocumentId: chapter.id });
  const draftBrief = await novelMemoryService.getDraftBrief(thread.id);
  const updatedBrief = await novelMemoryService.updateBrief(draftBrief.id, {
    goal: params.goal,
    povCharacterId: params.povCharacterId,
    tone: params.tone,
    languageRequirements: params.languageRequirements,
    mustHappen: params.mustHappen,
    forbidden: params.forbidden,
    targetWords: params.targetWords,
  });
  const confirmedBrief = await novelMemoryService.confirmBrief(updatedBrief.id);
  persist(`ch13-${chapterLabel}-11-creative-brief.json`, confirmedBrief);

  console.log(`[e2e-ch1-3] → startChapterWorkflow (blocking)`);
  let run = await startChapterWorkflow({
    projectId,
    documentId: chapter.id,
    threadId: thread.id,
    briefId: confirmedBrief.id,
    instruction: confirmedBrief.goal,
    blocking: true,
  });
  if (run.status !== "waiting-approval" || run.currentStage !== "blueprint-approval") {
    throw new Error(`[${chapterLabel}] 预期停在 blueprint-approval，实际：stage=${run.currentStage} status=${run.status} error=${run.error ?? "无"}`);
  }
  persist(`ch13-${chapterLabel}-12-run-after-blueprint.json`, run);
  await persistAllArtifacts(run.id, `${chapterLabel}-blueprint`);

  console.log(`[e2e-ch1-3] → approve blueprint`);
  run = await approveWorkflowStage(run.id, { approved: true });
  persist(`ch13-${chapterLabel}-13-run-after-manuscript.json`, run);
  if (run.status !== "waiting-approval" || run.currentStage !== "manuscript-approval") {
    throw new Error(`[${chapterLabel}] 预期停在 manuscript-approval，实际：stage=${run.currentStage} status=${run.status} error=${run.error ?? "无"}`);
  }
  await persistAllArtifacts(run.id, `${chapterLabel}-manuscript`);

  if (run.qualityReportId) {
    const report = await novelDb.qualityReports.get(run.qualityReportId);
    persist(`ch13-${chapterLabel}-14-quality-report.json`, report);
    if (report) {
      const dimScores = report.scores;
      const dimensions = Object.keys(dimScores) as Array<keyof typeof dimScores>;
      const avg = Object.values(dimScores).reduce((a, b) => a + b, 0) / dimensions.length;
      console.log(`[e2e-ch1-3] [${chapterLabel}] 8 维评分：${dimensions.map((d) => `${d}=${dimScores[d]}`).join(" ")} | avg=${avg.toFixed(2)} | weighted=${report.weightedScore} | blockers=${report.blockerCount}`);
    }
  }

  console.log(`[e2e-ch1-3] → approve manuscript`);
  run = await approveWorkflowStage(run.id, { approved: true });
  persist(`ch13-${chapterLabel}-15-run-after-fact.json`, run);
  if (run.status !== "waiting-approval" || run.currentStage !== "fact-approval") {
    throw new Error(`[${chapterLabel}] 预期停在 fact-approval，实际：stage=${run.currentStage} status=${run.status} error=${run.error ?? "无"}`);
  }
  await persistAllArtifacts(run.id, `${chapterLabel}-fact`);

  const factCandidates = await novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray();
  persist(`ch13-${chapterLabel}-16-fact-candidates.json`, factCandidates);
  console.log(`[e2e-ch1-3] [${chapterLabel}] 事实候选：${factCandidates.length} 条`);

  // 三层处理：safe 自动 → conflict 排除 → 剩余 high-risk non-conflict 接受
  const safeAcceptedIds = await autoAcceptSafeFactCandidates(factCandidates);
  const remainingCandidates = await novelDb.factCandidates.where("workflowRunId").equals(run.id).and((c) => c.status === "pending").toArray();
  const conflictIds = remainingCandidates.filter((c) => c.conflict).map((c) => c.id);
  const highRiskAcceptIds = remainingCandidates.filter((c) => !c.conflict).map((c) => c.id);
  for (const id of conflictIds) await setFactCandidateStatus(id, "rejected");
  if (highRiskAcceptIds.length) await bulkSetFactCandidateStatus(highRiskAcceptIds, "accepted");
  console.log(`[e2e-ch1-3] [${chapterLabel}] safe=${safeAcceptedIds.length} | conflict rejected=${conflictIds.length} | high-risk accepted=${highRiskAcceptIds.length}`);

  const decidedCandidates = await novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray();
  persist(`ch13-${chapterLabel}-16b-fact-candidates-decided.json`, decidedCandidates.map((c) => ({
    id: c.id, status: c.status, risk: c.risk, conflict: c.conflict, novelty: c.novelty,
    targetTable: c.targetTable, field: c.field, humanReadable: c.humanReadable, riskReason: c.riskReason,
  })));

  console.log(`[e2e-ch1-3] → approve facts (commit → character-enrichment → completed)`);
  run = await approveWorkflowStage(run.id, { approved: true });
  persist(`ch13-${chapterLabel}-17-run-final.json`, run);
  if (run.status !== "completed") {
    throw new Error(`[${chapterLabel}] 预期工作流完成，实际：stage=${run.currentStage} status=${run.status} error=${run.error ?? "无"}`);
  }
  await persistAllArtifacts(run.id, `${chapterLabel}-final`);

  const finalDoc = await novelDb.documents.get(chapter.id);
  persist(`ch13-${chapterLabel}-18-final-document.json`, finalDoc);
  console.log(`[e2e-ch1-3] [${chapterLabel}] 完成：status=${finalDoc?.status} wordCount=${finalDoc?.wordCount}`);

  return { run, finalDoc };
}

describeOrSkip("novel-e2e-chapters-1-to-3", { timeout: 7_200_000 }, () => {
  it("runs foundation + chapters 1-3 full workflow end-to-end with real LLM (验证工作流可扩展性)", async () => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    await resetDb();

    // === 1. 项目 + 地基阶段 ===
    const project = await createNovelProject({
      title: "初雪夜长歌",
      genre: ["古风", "权谋", "探案"],
      premise: CORE_IDEA,
    });
    console.log(`[e2e-ch1-3] 项目已创建：${project.id}`);
    persist("ch13-00-project.json", project);

    const { arch } = await runFoundation(project.id);
    console.log(`[e2e-ch1-3] 地基阶段完成：phases=${arch.phases.length}`);

    // === 2. 读取前 3 章 ===
    const documents = await novelDb.documents.where("projectId").equals(project.id).sortBy("order");
    if (documents.length < 3) throw new Error(`plot-design 应生成至少 3 章，实际：${documents.length}`);
    const [chapter1, chapter2, chapter3] = documents;
    console.log(`[e2e-ch1-3] 前 3 章：${chapter1.title} | ${chapter2.title} | ${chapter3.title}`);
    persist("ch13-10-chapters-1-3.json", documents.slice(0, 3));

    // 获取核心角色列表（第一章 POV = 失宠皇子）
    const characters = await novelDb.entities.where("projectId").equals(project.id).filter((e) => e.kind === "character").toArray();
    const pov1 = characters[0]; // 失宠皇子
    const pov2 = characters[1] ?? characters[0]; // 女史（视角之二，第 2 章 POV 切换）
    const pov3 = characters[2] ?? characters[0]; // 仵作（视角之三，第 3 章 POV 切换）
    console.log(`[e2e-ch1-3] POV 切换：ch1=${pov1?.name} → ch2=${pov2?.name} → ch3=${pov3?.name}`);

    // === 3. 第 1 章：引子章（暴毙之夜多视角切片，三人汇合于同一信息压力） ===
    const ch1 = await runSingleChapterWorkflow({
      projectId: project.id,
      chapter: { id: chapter1.id, title: chapter1.title, order: chapter1.order },
      povCharacterId: pov1?.id,
      goal: `完成《${chapter1.title}》正文。本章是引子章，承担"暴毙之夜多视角切片"功能。三位主角在同一夜里分别与太子发生某种接触或位置接近，并在章尾汇合于一个共同信息压力点（同一具尸体、同一行字或同一物事）。不要揭示真凶或核心动机。`,
      tone: "克制而诡谲，宫廷礼俗与市井烟火交织",
      languageRequirements: ["古风文言质感，但不堆砌典故", "对白要区分朝堂典雅与市井俚俗", "意象要承担信息压力，不只是装饰"],
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
      chapterLabel: "ch1",
    });

    expect(ch1.finalDoc?.status).toBe("final");
    expect(ch1.finalDoc?.wordCount ?? 0).toBeGreaterThan(1000);
    if (ch1.run.qualityReportId) {
      const report = await novelDb.qualityReports.get(ch1.run.qualityReportId);
      if (report) {
        const avgScore = Object.values(report.scores).reduce((a, b) => a + b, 0) / 8;
        expect(avgScore).toBeGreaterThanOrEqual(3.5);
        expect(report.blockerCount).toBe(0);
      }
    }

    // === 4. 第 2 章：余波章（次日清晨各自善后，仵作与女史在刑部仵作房相遇，POV 切换到女史） ===
    const ch2 = await runSingleChapterWorkflow({
      projectId: project.id,
      chapter: { id: chapter2.id, title: chapter2.title, order: chapter2.order },
      povCharacterId: pov2?.id,
      goal: `完成《${chapter2.title}》正文。本章是余波章，承担"次日清晨各自善后与初步接触代查机制"功能。POV 切换到女史视角。女史在掖庭善后太子遗物时发现手札中夹着一片被烧焦半角的绢帛，被宣入刑部仵作房协助记录尸检细节时与仵作相遇。仵作在尸检中发现太子舌下的一粒丹砂。两人通过专业交流形成初次默契。失宠皇子在另一线被东宫属官请去问话，承受被怀疑的压力。章尾三人通过不同渠道得知同一信息压力（如太子随身的玉鱼符不知所踪）。`,
      tone: "克制冷静中带细密质感，刑部仵作房的尸臭与女史的笔墨香形成感官对比",
      languageRequirements: ["女史的书面典雅与仵作的市井俚俗在对白中形成反差", "尸检过程用专业细节体现真实感", "意象（如绢帛、丹砂、玉鱼符）要承担信息压力"],
      mustHappen: [
        "女史在掖庭善后时发现太子手札中的烧焦绢帛",
        "女史与仵作在刑部仵作房相遇，仵作发现太子舌下丹砂",
        "失宠皇子在另一线承受被东宫属官问话的压力",
        "章尾三人通过不同渠道得知同一信息压力（玉鱼符不知所踪）",
      ],
      forbidden: [
        "揭示太子真凶或核心动机",
        "让三人正式组队（本章只是初次默契）",
        "使用现代词汇或网络用语",
        "对白不分身份（女史与仵作必须用词层次区分）",
      ],
      targetWords: 6000,
      chapterLabel: "ch2",
    });

    expect(ch2.finalDoc?.status).toBe("final");
    expect(ch2.finalDoc?.wordCount ?? 0).toBeGreaterThan(1000);
    if (ch2.run.qualityReportId) {
      const report = await novelDb.qualityReports.get(ch2.run.qualityReportId);
      if (report) {
        const avgScore = Object.values(report.scores).reduce((a, b) => a + b, 0) / 8;
        expect(avgScore).toBeGreaterThanOrEqual(3.5);
        expect(report.blockerCount).toBe(0);
      }
    }

    // === 5. 第 3 章：蓄势章（三人首次正式会面代查，揭开第一层误读，POV 切换到仵作） ===
    const ch3 = await runSingleChapterWorkflow({
      projectId: project.id,
      chapter: { id: chapter3.id, title: chapter3.title, order: chapter3.order },
      povCharacterId: pov3?.id,
      goal: `完成《${chapter3.title}》正文。本章是蓄势章，承担"三人首次正式会面代查机制"功能。POV 切换到切换到仵作视角。仵作在刑部被正式任命为代查仵作，与女史、失宠皇子首次同处一室。三人通过交换各自线索（仵作的丹砂、女史的绢帛、皇子被问话时听到的童谣）形成第一层误读：每人各自推出一个看似合理但彼此矛盾的方向。章尾某条线索（如玉鱼符）出现意外反常（如被人在仵作房外目击带走），三人意识到彼此掌握的信息可能不互补而是互相矛盾，留下"接下来如何识别谁被误导"的开放压力。`,
      tone: "紧绷克制，三人的专业语言在对话中形成棱镜效应",
      languageRequirements: ["仵作视角的市井务实感与偶尔冒出的尸检术语", "三人对白用词层次区分明显", "意象（玉鱼符）要承担章尾反常压力"],
      mustHappen: [
        "三人首次正式同处一室代查",
        "交换各自线索后形成第一层误读（每人推出一个看似合理但彼此矛盾的方向）",
        "玉鱼符在章尾出现意外反常（如被人在仵作房外目击带走）",
        "三人意识到彼此掌握的信息可能互相矛盾",
      ],
      forbidden: [
        "揭示太子真凶或核心动机",
        "让三人达成共识（本章是揭示误读而非解决）",
        "使用现代词汇或网络用语",
        "对白不分身份",
      ],
      targetWords: 6000,
      chapterLabel: "ch3",
    });

    expect(ch3.finalDoc?.status).toBe("final");
    expect(ch3.finalDoc?.wordCount ?? 0).toBeGreaterThan(1000);
    if (ch3.run.qualityReportId) {
      const report = await novelDb.qualityReports.get(ch3.run.qualityReportId);
      if (report) {
        const avgScore = Object.values(report.scores).reduce((a, b) => a + b, 0) / 8;
        expect(avgScore).toBeGreaterThanOrEqual(3.5);
        expect(report.blockerCount).toBe(0);
      }
    }

    // === 6. 验证工作流可扩展性：章节记忆链 + 跨章事实连续性 ===
    const chapter1Memory = await novelDb.derivedMemories.where("documentId").equals(chapter1.id).first();
    const chapter2Memory = await novelDb.derivedMemories.where("documentId").equals(chapter2.id).first();
    const chapter3Memory = await novelDb.derivedMemories.where("documentId").equals(chapter3.id).first();
    persist("ch13-19-chapter-memories.json", { chapter1Memory, chapter2Memory, chapter3Memory });
    expect(chapter1Memory).toBeDefined();
    expect(chapter2Memory).toBeDefined();
    expect(chapter3Memory).toBeDefined();
    expect(chapter1Memory?.level).toBe("chapter");
    expect(chapter2Memory?.level).toBe("chapter");
    expect(chapter3Memory?.level).toBe("chapter");
    console.log(`[e2e-ch1-3] 章节记忆链：ch1=${chapter1Memory?.id.slice(0, 8)} ch2=${chapter2Memory?.id.slice(0, 8)} ch3=${chapter3Memory?.id.slice(0, 8)}`);

    // 验证快照
    const snapshots = await novelDb.snapshots.where("projectId").equals(project.id).toArray();
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    console.log(`[e2e-ch1-3] 快照数：${snapshots.length}`);

    // 验证事实候选累计数（每章应有 fact candidates，三章累计 ≥ 5）
    const allFactCandidates = await novelDb.factCandidates.where("projectId").equals(project.id).toArray();
    console.log(`[e2e-ch1-3] 三章累计事实候选：${allFactCandidates.length}`);
    expect(allFactCandidates.length).toBeGreaterThanOrEqual(5);

    console.log("[e2e-ch1-3] 第 1-3 章完整 workflow 全部通过 ✓");
  });
});
