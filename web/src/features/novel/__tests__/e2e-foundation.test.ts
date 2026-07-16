import { describe, expect, it, vi } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { DEFAULT_API_KEY } from "@/config/defaults";

// ai.ts 的 endpoint() 在 DEV 模式下把默认 baseUrl 改写为 /ai-proxy（Vite dev-server 代理）。
// Node 测试环境没有 Vite dev-server，需让 getEffectiveApiConfig 返回一个不触发该分支的等价 URL。
// https://gpt.eromaa.com:443/v1 与默认 https://gpt.eromaa.com/v1 在 fetch 层等价，但字符串不相等，可绕过 DEV 代理逻辑。
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
import { formatContextPacket } from "../context";

const OUTPUT_DIR = ".goal/goals/novel-e2e-deepening/tmp";

// 古风权谋 + 探案：东宫太子暴毙案（题材刻意区别于已测过的《寒灯渡》仙侠武侠，用于检验工作流通用性）
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

describe("novel-e2e-foundation", { timeout: 1_200_000 }, () => {
  it("runs foundation stages end-to-end with real LLM", async () => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    await resetDb();

    // === 1. 创建项目 ===
    const project = await createNovelProject({
      title: "初雪夜长歌",
      genre: ["古风", "权谋", "探案"],
      premise: CORE_IDEA,
    });
    persist("01-project-create.json", project);
    console.log(`[e2e] 项目已创建：${project.id}`);

    // === 2. project-positioning ===
    console.log("[e2e] → project-positioning");
    const positioning = await runGenerationTask({
      projectId: project.id,
      taskKey: "project-positioning",
      instruction: "根据核心创意完善题材定位、目标读者、主题、卖点、叙事视角、基调和语言风格。古风权谋探案：以《琅琊榜》《长安十二时辰》为审美参照，重视宫廷礼俗、市井烟火与朝堂暗流交织。",
    });
    persist("02-positioning-proposal.json", positioning.proposal);
    persist("02-positioning-context.md", formatContextPacket(positioning.packet));
    await acceptProposal(positioning.proposal.id);
    const updatedProject = await novelDb.projects.get(project.id);
    persist("02-positioning-applied.json", updatedProject);
    console.log(`[e2e] positioning done: title="${updatedProject?.title}" pov="${updatedProject?.pov}"`);

    // === 3. architecture ===
    console.log("[e2e] → architecture");
    const architecture = await runGenerationTask({
      projectId: project.id,
      taskKey: "architecture",
      instruction: "为长篇生成可支撑数百万字铺陈的全书架构。本作为古风权谋探案，需要：1) 朝堂权力格局、江湖势力、隐秘组织三条张力线交织；2) 四到五个不可逆阶段（暴毙案发→临时代查→幕后显形→朝堂对决→余烬与新生），每个阶段的 purpose 用文学化叙事描述人物处境与情感走向，不要用'建立X''让Y做Z'等编剧指令腔；3) 留出至少两到三条可在后续百章缓慢发酵的长线伏笔（如三年前旧案、皇室血脉疑云、市井传言体系）。",
    });
    persist("03-architecture-proposal.json", architecture.proposal);
    persist("03-architecture-context.md", formatContextPacket(architecture.packet));
    await acceptProposal(architecture.proposal.id);
    const arch = await novelDb.architectures.where("projectId").equals(project.id).first();
    persist("03-architecture-applied.json", arch);
    console.log(`[e2e] architecture done: phases=${arch?.phases.length} framework=${arch?.framework}`);

    if (!arch || !arch.phases.length) throw new Error("架构未生成阶段");

    // === 4. characters ===
    console.log("[e2e] → characters");
    const characters = await runGenerationTask({
      projectId: project.id,
      taskKey: "characters",
      instruction: "设计 4-5 位核心角色：失宠皇子（视角人物之一）、女史（视角人物之二，宫中文献官）、市井仵作（视角人物之三，验尸识骨）、太子太傅（重要配角，深藏不露）、掌事宦官（次要反派，依附权臣）。每人需有明确的欲望、恐惧、错误信念、秘密、人物弧和差异化声音。注意古风权谋探案题材的声音层次：朝堂人物典雅克制、市井人物鲜活俚俗，不可共享同一种书面腔。",
    });
    persist("04-characters-proposal.json", characters.proposal);
    persist("04-characters-context.md", formatContextPacket(characters.packet));
    await acceptProposal(characters.proposal.id);
    const chars = await novelDb.entities.where("projectId").equals(project.id).filter((e) => e.kind === "character").toArray();
    persist("04-characters-applied.json", chars);
    console.log(`[e2e] characters done: count=${chars.length}`);

    // === 5. relations ===
    console.log("[e2e] → relations");
    const relations = await runGenerationTask({
      projectId: project.id,
      taskKey: "relations",
      instruction: "为已生成的核心角色设计会推动选择与冲突的人物关系：朝堂明面关系（君臣、师生、同僚）+ 私下隐情（旧恩、暗债、血脉疑云）。每条关系需有 publicLabel（公开标签）和 privateTruth（隐情），关系类型不得雷同。仵作与女史之间应有一条非血缘的旧恩（如女史幼时被仵作之父收留半日这种细节级旧恩）。",
    });
    persist("05-relations-proposal.json", relations.proposal);
    await acceptProposal(relations.proposal.id);
    const rels = await novelDb.relations.where("projectId").equals(project.id).toArray();
    persist("05-relations-applied.json", rels);
    console.log(`[e2e] relations done: count=${rels.length}`);

    // === 6. worldview ===
    console.log("[e2e] → worldview");
    const worldview = await runGenerationTask({
      projectId: project.id,
      taskKey: "worldview",
      instruction: "完善古风权谋探案世界观：1) 地点（东宫、掖庭、刑部仵作房、市井瓦肆、城外山寺）；2) 组织（清查司、内书堂、瓦肆说书人网络）；3) 阵营（东宫属官、外戚、勋贵、寒门言官）；4) 物品（太子随身的玉鱼符、女史的私人手札、仵作的银针与验骨伞）；5) 规则（朝堂奏对礼俗、刑名验尸法度、宫禁出入令）。注意：地点与规则必须为后续探案与权谋场景提供可被剧情利用的具体约束（如刑部仵作房在子时后不得点灯，这种细节）。避免堆砌设定清单。",
    });
    persist("06-worldview-proposal.json", worldview.proposal);
    persist("06-worldview-context.md", formatContextPacket(worldview.packet));
    await acceptProposal(worldview.proposal.id);
    const entities = await novelDb.entities.where("projectId").equals(project.id).toArray();
    persist("06-worldview-applied.json", entities);
    console.log(`[e2e] worldview done: total entities=${entities.length}`);

    // === 7. plot-threads ===
    console.log("[e2e] → plot-threads");
    const threads = await runGenerationTask({
      projectId: project.id,
      taskKey: "plot-threads",
      instruction: "规划 4 条剧情线：1) 主线——太子暴毙案真相逐步显形；2) 支线——失宠皇子被推回权力中心的政治暗流；3) 感情线——失宠皇子与女史的旧识与新疑；4) 成长线——市井仵作从局外人变为承担朝堂重量的关键证人。每条线需明确参与者、当前状态、优先级与下一步推进。注意：感情线必须双向且服务主线，不得工业糖精。",
    });
    persist("07-threads-proposal.json", threads.proposal);
    await acceptProposal(threads.proposal.id);
    const allThreads = await novelDb.plotThreads.where("projectId").equals(project.id).toArray();
    persist("07-threads-applied.json", allThreads);
    console.log(`[e2e] threads done: count=${allThreads.length}`);

    // === 8. foreshadowing ===
    console.log("[e2e] → foreshadowing");
    const foreshadowing = await runGenerationTask({
      projectId: project.id,
      taskKey: "foreshadowing",
      instruction: "规划 4 条伏笔：1) 太子暴毙前夜赠予女史的私人手札，内夹一片被刻意烧焦半角的绢帛；2) 仵作在尸检时于太子舌下发现的一粒带特殊香气的丹砂；3) 失宠皇子三年前被贬离京时在城门听到的一句童谣；4) 掌事宦官腰间那枚不属于他品级的玉坠。每条伏笔需记录读者可见线索、角色可知范围、预期误读、揭示条件与回收影响。",
    });
    persist("08-foreshadowing-proposal.json", foreshadowing.proposal);
    await acceptProposal(foreshadowing.proposal.id);
    const clues = await novelDb.foreshadowing.where("projectId").equals(project.id).toArray();
    persist("08-foreshadowing-applied.json", clues);
    console.log(`[e2e] foreshadowing done: count=${clues.length}`);

    // === 9. timeline ===
    console.log("[e2e] → timeline");
    const timeline = await runGenerationTask({
      projectId: project.id,
      taskKey: "timeline",
      instruction: "生成太子暴毙前 7 日与暴毙后 3 日的关键时间线事件（共 8-12 条），每条事件标注故事日期、持续时间、参与者、原因与后果。注意：事件因果链必须能解释案发当晚各角色的位置与动机，但不得直接揭示真凶。",
    });
    persist("09-timeline-proposal.json", timeline.proposal);
    await acceptProposal(timeline.proposal.id);
    const events = await novelDb.timelineEvents.where("projectId").equals(project.id).toArray();
    persist("09-timeline-applied.json", events);
    console.log(`[e2e] timeline done: count=${events.length}`);

    // === 10. plot-design for first phase ===
    console.log("[e2e] → plot-design (first phase)");
    const firstPhase = arch.phases[0];
    const plotDesign = await runPlotDesignTask({
      projectId: project.id,
      phaseId: firstPhase.id,
      instruction: "在第一幕下设计第一个剧情段及其章节（2-4 章）。本作第一章是引子章，应承担'暴毙之夜的多视角切片'功能：让三位主角（失宠皇子、女史、仵作）在同一夜里分别与太子发生某种接触或位置接近，并在章尾汇合于一个共同信息压力（如同一具尸体、同一行字、同一物事）。注意不要在第一章揭示真凶或核心动机。",
    });
    persist("10-plot-design-proposal.json", plotDesign.proposal);
    await acceptProposal(plotDesign.proposal.id);
    const documents = await novelDb.documents.where("projectId").equals(project.id).sortBy("order");
    persist("10-documents-applied.json", documents);
    console.log(`[e2e] plot-design done: chapters=${documents.length}`);

    // === 写入汇总 ===
    const summary = {
      generatedAt: new Date().toISOString(),
      projectId: project.id,
      foundation: {
        project: updatedProject,
        architecture: { framework: arch.framework, phases: arch.phases.length, centralQuestion: arch.centralQuestion },
        characters: chars.length,
        relations: rels.length,
        entities: entities.length,
        threads: allThreads.length,
        foreshadowing: clues.length,
        timeline: events.length,
        chapters: documents.length,
      },
    };
    persist("foundation-summary.json", summary);
    console.log("[e2e] foundation 阶段全部完成：", JSON.stringify(summary.foundation, null, 2));

    expect(chars.length).toBeGreaterThanOrEqual(3);
    expect(documents.length).toBeGreaterThanOrEqual(2);
    expect(allThreads.length).toBeGreaterThanOrEqual(3);
    expect(clues.length).toBeGreaterThanOrEqual(3);
  });
});
