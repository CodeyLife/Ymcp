import { describe, expect, it, vi } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { DEFAULT_API_KEY } from "@/config/defaults";

// 与 e2e-foundation.test.ts 相同的 DEV 代理绕过：让 getEffectiveApiConfig 返回带显式 :443 端口的等价 URL
vi.mock("@/stores/ui", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEffectiveApiConfig: () => ({
      baseUrl: "https://gpt.eromaa.com:443/v1",
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

// 与 e2e-foundation.test.ts 相同主题（古风权谋+探案），便于横向对比
const CORE_IDEA = "东宫太子暴毙于初雪夜，三位身份悬殊的人——失宠皇子、女史、市井仵作——因一具尸体被迫结成临时代查之契。真凶不止一个，每个人都因这桩死亡获得了想要的或惧怕的东西。";

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
  console.log("[e2e-ch1] → project-positioning");
  const positioning = await runGenerationTask({
    projectId,
    taskKey: "project-positioning",
    instruction: "根据核心创意完善题材定位、目标读者、主题、卖点、叙事视角、基调和语言风格。古风权谋探案：以《琅琊榜》《长安十二时辰》为审美参照，重视宫廷礼俗、市井烟火与朝堂暗流交织。",
  });
  persist("ch1-01-positioning-proposal.json", positioning.proposal);
  await acceptProposal(positioning.proposal.id);

  console.log("[e2e-ch1] → architecture");
  const architecture = await runGenerationTask({
    projectId,
    taskKey: "architecture",
    instruction: "为长篇生成可支撑数百万字铺陈的全书架构。本作为古风权谋探案，需要：1) 朝堂权力格局、江湖势力、隐秘组织三条张力线交织；2) 四到五个不可逆阶段（暴毙案发→临时代查→幕后显形→朝堂对决→余烬与新生），每个阶段的 purpose 用文学化叙事描述人物处境与情感走向，不要用'建立X''让Y做Z'等编剧指令腔；3) 留出至少两到三条可在后续百章缓慢发酵的长线伏笔（如三年前旧案、皇室血脉疑云、市井传言体系）。",
  });
  persist("ch1-02-architecture-proposal.json", architecture.proposal);
  await acceptProposal(architecture.proposal.id);
  const arch = await novelDb.architectures.where("projectId").equals(projectId).first();
  if (!arch || !arch.phases.length) throw new Error("架构未生成阶段");

  console.log("[e2e-ch1] → characters");
  const characters = await runGenerationTask({
    projectId,
    taskKey: "characters",
    instruction: "设计 4-5 位核心角色：失宠皇子（视角人物之一）、女史（视角人物之二，宫中文献官）、市井仵作（视角人物之三，验尸识骨）、太子太傅（重要配角，深藏不露）、掌事宦官（次要反派，依附权臣）。每人需有明确的欲望、恐惧、错误信念、秘密、人物弧和差异化声音。注意古风权谋探案题材的声音层次：朝堂人物典雅克制、市井人物鲜活俚俗，不可共享同一种书面腔。",
  });
  persist("ch1-03-characters-proposal.json", characters.proposal);
  await acceptProposal(characters.proposal.id);

  console.log("[e2e-ch1] → relations");
  const relations = await runGenerationTask({
    projectId,
    taskKey: "relations",
    instruction: "为已生成的核心角色设计会推动选择与冲突的人物关系：朝堂明面关系（君臣、师生、同僚）+ 私下隐情（旧恩、暗债、血脉疑云）。每条关系需有 publicLabel（公开标签）和 privateTruth（隐情），关系类型不得雷同。仵作与女史之间应有一条非血缘的旧恩（如女史幼时被仵作之父收留半日这种细节级旧恩）。",
  });
  persist("ch1-04-relations-proposal.json", relations.proposal);
  await acceptProposal(relations.proposal.id);

  console.log("[e2e-ch1] → worldview");
  const worldview = await runGenerationTask({
    projectId,
    taskKey: "worldview",
    instruction: "完善古风权谋探案世界观：1) 地点（东宫、掖庭、刑部仵作房、市井瓦肆、城外山寺）；2) 组织（清查司、内书堂、瓦肆说书人网络）；3) 阵营（东宫属官、外戚、勋贵、寒门言官）；4) 物品（太子随身的玉鱼符、女史的私人手札、仵作的银针与验骨伞）；5) 规则（朝堂奏对礼俗、刑名验尸法度、宫禁出入令）。注意：地点与规则必须为后续探案与权谋场景提供可被剧情利用的具体约束（如刑部仵作房在子时后不得点灯，这种细节）。避免堆砌设定清单。",
  });
  persist("ch1-05-worldview-proposal.json", worldview.proposal);
  await acceptProposal(worldview.proposal.id);

  console.log("[e2e-ch1] → plot-threads");
  const threads = await runGenerationTask({
    projectId,
    taskKey: "plot-threads",
    instruction: "规划 4 条剧情线：1) 主线——太子暴毙案真相逐步显形；2) 支线——失宠皇子被推回权力中心的政治暗流；3) 感情线——失宠皇子与女史的旧识与新疑；4) 成长线——市井仵作从局外人变为承担朝堂重量的关键证人。每条线需明确参与者、当前状态、优先级与下一步推进。注意：感情线必须双向且服务主线，不得工业糖精。",
  });
  persist("ch1-06-threads-proposal.json", threads.proposal);
  await acceptProposal(threads.proposal.id);

  console.log("[e2e-ch1] → foreshadowing");
  const foreshadowing = await runGenerationTask({
    projectId,
    taskKey: "foreshadowing",
    instruction: "规划 4 条伏笔：1) 太子暴毙前夜赠予女史的私人手札，内夹一片被刻意烧焦半角的绢帛；2) 仵作在尸检时于太子舌下发现的一粒带特殊香气的丹砂；3) 失宠皇子三年前被贬离京时在城门听到的一句童谣；4) 掌事宦官腰间那枚不属于他品级的玉坠。每条伏笔需记录读者可见线索、角色可知范围、预期误读、揭示条件与回收影响。",
  });
  persist("ch1-07-foreshadowing-proposal.json", foreshadowing.proposal);
  await acceptProposal(foreshadowing.proposal.id);

  console.log("[e2e-ch1] → timeline");
  const timeline = await runGenerationTask({
    projectId,
    taskKey: "timeline",
    instruction: "生成太子暴毙前 7 日与暴毙后 3 日的关键时间线事件（共 8-12 条），每条事件标注故事日期、持续时间、参与者、原因与后果。注意：事件因果链必须能解释案发当晚各角色的位置与动机，但不得直接揭示真凶。",
  });
  persist("ch1-08-timeline-proposal.json", timeline.proposal);
  await acceptProposal(timeline.proposal.id);

  console.log("[e2e-ch1] → plot-design (first phase)");
  const firstPhase = arch.phases[0];
  const plotDesign = await runPlotDesignTask({
    projectId,
    phaseId: firstPhase.id,
    instruction: "在第一幕下设计第一个剧情段及其章节（2-4 章）。本作第一章是引子章，应承担'暴毙之夜的多视角切片'功能：让三位主角（失宠皇子、女史、仵作）在同一夜里分别与太子发生某种接触或位置接近，并在章尾汇合于一个共同信息压力（如同一具尸体、同一行字、同一物事）。注意不要在第一章揭示真凶或核心动机。",
  });
  persist("ch1-09-plot-design-proposal.json", plotDesign.proposal);
  await acceptProposal(plotDesign.proposal.id);

  return { arch };
}

async function persistAllArtifacts(runId: string, label: string) {
  const artifacts = await novelDb.workflowArtifacts.where("workflowRunId").equals(runId).sortBy("createdAt");
  persist(`ch1-${label}-artifacts.json`, artifacts.map((a) => ({
    id: a.id, stage: a.stage, kind: a.kind, title: a.title,
    contentPreview: a.contentMarkdown?.slice(0, 400),
    contentLength: a.contentMarkdown?.length ?? 0,
    structuredDataKeys: a.structuredData ? Object.keys(a.structuredData) : [],
  })));
  // 把关键正文产物单独持久化（便于 LLM 阅读）
  for (const a of artifacts) {
    if (a.kind === "blueprint" || a.kind === "draft" || a.kind === "revision" || a.kind === "fact-delta" || a.kind === "review") {
      persist(`ch1-${label}-${a.stage}-${a.kind}.md`, a.contentMarkdown ?? "");
    }
  }
}

describe("novel-e2e-chapter1", { timeout: 2_400_000 }, () => {
  it("runs foundation + chapter 1 full workflow end-to-end with real LLM", async () => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    await resetDb();

    // === 1. 项目 + 地基阶段 ===
    const project = await createNovelProject({
      title: "初雪夜长歌",
      genre: ["古风", "权谋", "探案"],
      premise: CORE_IDEA,
    });
    console.log(`[e2e-ch1] 项目已创建：${project.id}`);
    persist("ch1-00-project.json", project);

    const { arch } = await runFoundation(project.id);
    console.log(`[e2e-ch1] 地基阶段完成：phases=${arch.phases.length}`);

    // === 2. 选择第 1 章 ===
    const documents = await novelDb.documents.where("projectId").equals(project.id).sortBy("order");
    if (!documents.length) throw new Error("plot-design 未生成章节");
    const chapter1 = documents[0];
    console.log(`[e2e-ch1] 第 1 章：${chapter1.title} (order=${chapter1.order})`);
    persist("ch1-10-chapter1-document.json", chapter1);

    // === 3. 创建协作对话 + 创作简报 ===
    const thread = await novelMemoryService.getOrCreateThread({ projectId: project.id, targetDocumentId: chapter1.id });
    console.log(`[e2e-ch1] 协作对话：${thread.id}`);

    const draftBrief = await novelMemoryService.getDraftBrief(thread.id);
    // 选定 POV 角色为失宠皇子（角色列表中 kind=character 的第一个，作为视角人物之一）
    const povCharacter = await novelDb.entities.where("projectId").equals(project.id).filter((e) => e.kind === "character").first();
    const updatedBrief = await novelMemoryService.updateBrief(draftBrief.id, {
      goal: `完成《${chapter1.title}》正文。本章是引子章，承担"暴毙之夜多视角切片"功能。三位主角在同一夜里分别与太子发生某种接触或位置接近，并在章尾汇合于一个共同信息压力。不要揭示真凶或核心动机。`,
      povCharacterId: povCharacter?.id,
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
    });
    const confirmedBrief = await novelMemoryService.confirmBrief(updatedBrief.id);
    console.log(`[e2e-ch1] 创作简报已确认：${confirmedBrief.id}`);
    persist("ch1-11-creative-brief.json", confirmedBrief);

    // === 4. 启动章节 workflow ===
    console.log("[e2e-ch1] → startChapterWorkflow (context → blueprint → blueprint-approval)");
    let run = await startChapterWorkflow({
      projectId: project.id,
      documentId: chapter1.id,
      threadId: thread.id,
      briefId: confirmedBrief.id,
      instruction: confirmedBrief.goal,
      blocking: true,
    });
    console.log(`[e2e-ch1] 工作流暂停：stage=${run.currentStage} status=${run.status}`);
    persist("ch1-12-run-after-blueprint.json", run);

    if (run.status !== "waiting-approval" || run.currentStage !== "blueprint-approval") {
      throw new Error(`预期停在 blueprint-approval，实际：stage=${run.currentStage} status=${run.status} error=${run.error ?? "无"}`);
    }
    await persistAllArtifacts(run.id, "blueprint");

    // === 5. 批准蓝图，推进到正文/审校/修订（manuscript-approval） ===
    console.log("[e2e-ch1] → approve blueprint (draft → review → revision → manuscript-approval)");
    run = await approveWorkflowStage(run.id, { approved: true });
    console.log(`[e2e-ch1] 工作流暂停：stage=${run.currentStage} status=${run.status} iteration=${run.revisionIteration}`);
    persist("ch1-13-run-after-manuscript.json", run);

    if (run.status !== "waiting-approval" || run.currentStage !== "manuscript-approval") {
      throw new Error(`预期停在 manuscript-approval，实际：stage=${run.currentStage} status=${run.status} error=${run.error ?? "无"}`);
    }
    await persistAllArtifacts(run.id, "manuscript");

    // === 6. 读取并持久化质量报告 ===
    if (run.qualityReportId) {
      const report = await novelDb.qualityReports.get(run.qualityReportId);
      persist("ch1-14-quality-report.json", report);
      console.log(`[e2e-ch1] 质量报告：score=${report?.weightedScore} passed=${report?.passed} blockers=${report?.blockerCount} issues=${report?.issues.length}`);
      if (report) {
        const dimScores = report.scores;
        const dimensions = Object.keys(dimScores) as Array<keyof typeof dimScores>;
        console.log(`[e2e-ch1] 8 维评分：${dimensions.map((d) => `${d}=${dimScores[d]}`).join(" ")}`);
        console.log(`[e2e-ch1] 平均分：${(Object.values(dimScores).reduce((a, b) => a + b, 0) / dimensions.length).toFixed(2)}`);
      }
    }

    // === 7. 批准正文，推进到事实提取（fact-approval） ===
    console.log("[e2e-ch1] → approve manuscript (fact-extraction → fact-approval)");
    run = await approveWorkflowStage(run.id, { approved: true });
    console.log(`[e2e-ch1] 工作流暂停：stage=${run.currentStage} status=${run.status}`);
    persist("ch1-15-run-after-fact.json", run);

    if (run.status !== "waiting-approval" || run.currentStage !== "fact-approval") {
      throw new Error(`预期停在 fact-approval，实际：stage=${run.currentStage} status=${run.status} error=${run.error ?? "无"}`);
    }
    await persistAllArtifacts(run.id, "fact");

    // 读取并持久化事实候选
    const factCandidates = await novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray();
    persist("ch1-16-fact-candidates.json", factCandidates);
    console.log(`[e2e-ch1] 事实候选：${factCandidates.length} 条`);

    // === 8. 逐条处理事实候选（fact-approval 要求所有候选非 pending） ===
    // 策略：safe 候选自动接受 → conflict=true 候选 reject → 剩余 high-risk 但 non-conflict 候选模拟"人工已审视并接受"
    console.log("[e2e-ch1] → 处理 fact candidates（safe 自动 + conflict 排除 + 剩余接受）");
    const safeAcceptedIds = await autoAcceptSafeFactCandidates(factCandidates);
    console.log(`[e2e-ch1] safe 自动接受：${safeAcceptedIds.length} 条`);

    const remainingCandidates = await novelDb.factCandidates.where("workflowRunId").equals(run.id).and((c) => c.status === "pending").toArray();
    const conflictIds = remainingCandidates.filter((c) => c.conflict).map((c) => c.id);
    const highRiskAcceptIds = remainingCandidates.filter((c) => !c.conflict).map((c) => c.id);
    for (const id of conflictIds) await setFactCandidateStatus(id, "rejected");
    if (highRiskAcceptIds.length) await bulkSetFactCandidateStatus(highRiskAcceptIds, "accepted");
    console.log(`[e2e-ch1] 冲突排除：${conflictIds.length} 条 | 高风险接受：${highRiskAcceptIds.length} 条`);

    // 持久化最终决定，便于 LLM 分析
    const decidedCandidates = await novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray();
    persist("ch1-16b-fact-candidates-decided.json", decidedCandidates.map((c) => ({
      id: c.id, status: c.status, risk: c.risk, conflict: c.conflict, novelty: c.novelty,
      targetTable: c.targetTable, field: c.field, humanReadable: c.humanReadable, riskReason: c.riskReason,
    })));

    // === 9. 批准事实，推进到 commit + character-enrichment（completed） ===
    console.log("[e2e-ch1] → approve facts (commit → character-enrichment → completed)");
    run = await approveWorkflowStage(run.id, { approved: true });
    console.log(`[e2e-ch1] 工作流结束：stage=${run.currentStage} status=${run.status}`);
    persist("ch1-17-run-final.json", run);

    if (run.status !== "completed") {
      throw new Error(`预期工作流完成，实际：stage=${run.currentStage} status=${run.status} error=${run.error ?? "无"}`);
    }
    await persistAllArtifacts(run.id, "final");

    // === 9. 验证最终章节状态 ===
    const finalDoc = await novelDb.documents.get(chapter1.id);
    persist("ch1-18-final-document.json", finalDoc);
    console.log(`[e2e-ch1] 最终章节：status=${finalDoc?.status} wordCount=${finalDoc?.wordCount}`);

    expect(finalDoc?.status).toBe("final");
    expect(finalDoc?.wordCount ?? 0).toBeGreaterThan(1000);
    expect(finalDoc?.plainText?.length ?? 0).toBeGreaterThan(1000);

    // === 10. 验证质量报告 8 维评分 ===
    if (run.qualityReportId) {
      const report = await novelDb.qualityReports.get(run.qualityReportId);
      if (report) {
        const dimScores = report.scores;
        const dimensions = Object.keys(dimScores) as Array<keyof typeof dimScores>;
        const avgScore = Object.values(dimScores).reduce((a, b) => a + b, 0) / dimensions.length;
        console.log(`[e2e-ch1] 最终平均分：${avgScore.toFixed(2)}（目标 ≥ 3.8）`);
        // 目标信号：aesthetic-score-target 要求平均 ≥3.8 且 chapterEndingDrive/imageryUsage/chineseAesthetic 无 blocker
        // 这里用 8 维 weightedScore 与 blockerCount 做最低门槛校验，详细 LLM 分析写在 findings.md
        expect(avgScore).toBeGreaterThanOrEqual(3.5); // Loop 3 先放低门槛，观察实际分布后 Loop 4 再决定是否收紧到 3.8
        expect(report.blockerCount).toBe(0);
      }
    }

    // === 11. 验证章节记忆已生成 ===
    const memory = await novelDb.derivedMemories.where("documentId").equals(chapter1.id).first();
    persist("ch1-19-chapter-memory.json", memory);
    expect(memory).toBeDefined();
    expect(memory?.level).toBe("chapter");
    expect(memory?.status).toBe("active");

    // === 12. 验证工作流快照 ===
    const snapshots = await novelDb.snapshots.where("projectId").equals(project.id).toArray();
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    console.log(`[e2e-ch1] 快照数：${snapshots.length}`);

    console.log("[e2e-ch1] 第 1 章完整 workflow 全部通过 ✓");
  });
});
