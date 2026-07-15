/**
 * Loop 1 端到端真实生成：全新古典题材《寒灯渡》规划阶段 + 第一章全流程。
 * 适配重构后 API：plot-design 取代 outline；章节工作流需 thread + confirmed brief。
 * 每一步真实 LLM 产物均落盘到 artifacts/，供严格中文读者视角审查。
 */
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

const localStorageValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => localStorageValues.set(key, String(value)),
    removeItem: (key: string) => localStorageValues.delete(key),
    clear: () => localStorageValues.clear(),
  },
  configurable: true,
});

import { useUIStore } from "@/stores/ui";
import { DEFAULT_API_KEY } from "@/config/defaults";
import { createNovelProject, novelDb } from "@/features/novel/db";
import { runGenerationTask, runPlotDesignTask, applyProposalItems } from "@/features/novel/generation";
import { startChapterWorkflow, approveWorkflowStage } from "@/features/novel/workflow";
import { setFactCandidateStatus } from "@/features/novel/facts";
import { formatContextPacket } from "@/features/novel/context";
import { novelMemoryService } from "@/features/novel/memory-service";
import type { WorkflowRun } from "@/features/novel/types";

const ARTIFACTS_DIR = path.resolve(__dirname, "artifacts-after2");
const DEV_PROXY_URL = "http://localhost:5175/ai-proxy";

async function saveArtifact(name: string, content: string) {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await writeFile(path.join(ARTIFACTS_DIR, name), content, "utf8");
}

async function waitForStage(runId: string, predicate: (r: WorkflowRun) => boolean, maxAttempts: number, intervalMs: number, progressLabel?: string) {
  let run = await novelDb.workflowRuns.get(runId);
  if (!run) throw new Error("工作流不存在");
  let attempts = 0;
  while (!predicate(run) && run.status === "running" && attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, intervalMs));
    run = (await novelDb.workflowRuns.get(runId))!;
    attempts++;
    if (progressLabel && attempts % 10 === 0) {
      await saveArtifact(`${progressLabel}-progress-${attempts}.txt`, `stage=${run.currentStage} status=${run.status} revisionIteration=${run.revisionIteration}`);
    }
  }
  return run!;
}

describe("smoke e2e 古典武侠《寒灯渡》: 规划 → 第一章 → 第二章", () => {
  let projectId: string;
  let chapter1Id: string;
  let chapter2Id: string;

  it("配置 API 指向 dev proxy", () => {
    useUIStore.setState({ apiBaseUrl: DEV_PROXY_URL, apiKey: DEFAULT_API_KEY });
    const config = useUIStore.getState();
    expect(config.apiBaseUrl).toBe(DEV_PROXY_URL);
    expect(config.apiKey).toBe(DEFAULT_API_KEY);
  });

  it("创建《寒灯渡》测试项目", async () => {
    await novelDb.delete();
    await novelDb.open();
    const project = await createNovelProject({
      title: "寒灯渡",
      genre: ["武侠", "古典", "江湖"],
      premise:
        "寒露那年，江湖第一大派听潮阁在一夜之间被屠门，掌门幼女沈雁声携一卷被血浸透的门人录逃入大雾。雾深处有一座只在雾起时浮现的渡口，摆渡人是个不收钱、只收“一桩旧事”的哑巴老人。她用一桩自己也不愿记起的旧事换了渡河，从此改换身份混入仇人门下学剑。她要杀的人，正是当年渡她过河的哑巴老人的旧主——而门人录上每一个名字背后，都藏着一桩被江湖遗忘的旧债。雾散之后，再无人记得那一夜渡口发生的事。",
    });
    projectId = project.id;
    await saveArtifact("00-project-created.txt", JSON.stringify(project, null, 2));
  });

  it("生成项目定位", async () => {
    const result = await runGenerationTask({
      projectId,
      taskKey: "project-positioning",
      instruction:
        "完善项目定位：这是一部古典武侠/江湖长篇，追求中文意境美与古典美学，目标读者为喜爱古龙、王小波、烽火戏诸侯风格的成人读者。主题围绕“记与忘、债与渡、恩义与背叛”。叙事视角为有限第三人称，过去时，基调冷峻克制而偶有侠气。语言风格追求半文半白、意象密集、以留白承重，少用形容词堆砌。目标约200万字连载。",
    });
    await saveArtifact("01-positioning-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const project = await novelDb.projects.get(projectId);
    await saveArtifact("01-positioning-applied.txt", JSON.stringify(project, null, 2));
  });

  it("生成全书架构", async () => {
    const result = await runGenerationTask({
      projectId,
      taskKey: "architecture",
      instruction:
        "基于核心创意生成四阶段全书架构（起、承、转、合），明确核心冲突、核心问题与宏观阶段转折。核心冲突：沈雁声寻仇 vs 仇人竟是渡她过河者的旧主，恩义颠倒。核心问题：当一个人欠下的债要用另一个人的命来还，她还能不能算作江湖里的好人。故事约200万字，分四大卷：寒灯渡、雾中剑、旧债新偿、门人录尽。每个 phase 必须有 id/title/purpose/turningPoint/order/locked。",
    });
    await saveArtifact("02-architecture-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const arch = await novelDb.architectures.where("projectId").equals(projectId).first();
    await saveArtifact("02-architecture-applied.txt", JSON.stringify(arch, null, 2));
  });

  it("生成核心角色", async () => {
    const result = await runGenerationTask({
      projectId,
      taskKey: "characters",
      instruction:
        "设计4-5个核心角色：1) 沈雁声——听潮阁掌门幼女，屠门夜逃入雾中渡口，改换身份混入仇人门下学剑，冷静而隐忍，心里记着一本门人录的旧债；2) 哑渡——雾中渡口的摆渡人，不收钱只收一桩旧事，不能说话却能听懂江水，真实身份成谜；3) 裴长庚——仇人门下剑术宗师，沈雁声拜师学剑的对象，温雅有礼却手腕狠辣，是当年屠门的主使之一；4) 师兄江照——屠门夜以为她已死，十年后江湖重逢，已成为另一派执剑人；5) 门人录首位债主“陆无名”——名字被血浸透，其旧事是整本录引子。每个角色需有明确欲望、恐惧、秘密、声音特征与人物弧。角色声音要有古典质感，彼此区分度高。",
    });
    await saveArtifact("03-characters-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const entities = await novelDb.entities.where("projectId").equals(projectId).toArray();
    await saveArtifact("03-characters-applied.txt", JSON.stringify(entities, null, 2));
  });

  it("生成世界观", async () => {
    const result = await runGenerationTask({
      projectId,
      taskKey: "worldview",
      instruction:
        "构建古典武侠世界观：1) 江湖门派格局——听潮阁已灭、现存几大派与世俗王朝的微妙制衡；2) 雾中渡口的规则——只在雾起时浮现、摆渡不收钱只收一桩旧事、渡过则旧事归渡口；3) 门人录的设定——血浸之名背后皆有一桩旧债，录尽则债清；4) 地理——大江两岸的关隘、古镇、雾渡与朝堂；5) 规则——江湖旧债的偿还法则、记与忘的代价。世界观要有东方意境，避免西幻设定。",
    });
    await saveArtifact("04-worldview-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const entities = await novelDb.entities.where("projectId").equals(projectId).toArray();
    await saveArtifact("04-worldview-applied.txt", JSON.stringify(entities.filter((e) => e.kind !== "character"), null, 2));
  });

  it("生成剧情段与章节（plot-design）", async () => {
    const arch = await novelDb.architectures.where("projectId").equals(projectId).first();
    if (!arch || !arch.phases.length) throw new Error("架构缺失，无法 plot-design");
    const phaseId = arch.phases[0].id;
    const result = await runPlotDesignTask({
      projectId,
      phaseId,
      instruction:
        "在第一幕“寒灯渡”下设计开篇剧情段及其 2-3 个章节。第一章为寒露屠门夜与雾中渡口初遇，需建立惨烈克制、渡口诡秘意境、门人录悬念、沈雁声隐忍抉择。强调因果、人物选择与转折，每个事件的 summary 以散文形式完整交代“缘起→触发→阻碍→直接结果→延后余波”五要素。注意中文意境与古典叙事节奏。",
    });
    await saveArtifact("05-plot-design-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const outline = await novelDb.outlineNodes.where("projectId").equals(projectId).sortBy("order");
    await saveArtifact("05-outline-applied.txt", JSON.stringify(outline, null, 2));
    expect(outline.length, "plot-design 未生成大纲节点").toBeGreaterThan(0);
  });

  it("生成剧情线", async () => {
    const result = await runGenerationTask({
      projectId,
      taskKey: "plot-threads",
      instruction:
        "规划剧情线：1) 主线——沈雁声潜伏学剑与寻仇；2) 支线——哑渡身份与渡口旧事回收；3) 对抗线——裴长庚与听潮阁灭门真相；4) 成长线——沈雁声从记恨到辨清债与义。每条线需有参与者、当前状态、优先级、下一步推进。",
    });
    await saveArtifact("06-plot-threads-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const threads = await novelDb.plotThreads.where("projectId").equals(projectId).toArray();
    await saveArtifact("06-plot-threads-applied.txt", JSON.stringify(threads, null, 2));
    expect(threads.length).toBeGreaterThan(0);
  });

  it("生成伏笔", async () => {
    const result = await runGenerationTask({
      projectId,
      taskKey: "foreshadowing",
      instruction:
        "规划伏笔：1) 门人录上每个血浸之名对应一桩旧债；2) 哑渡为何不收钱只收旧事；3) 沈雁声渡河时交出的那桩旧事究竟是什么；4) 裴长庚与听潮阁掌门的旧缘；5) 渡口雾散后无人记得的真相。每条伏笔需有线索、真相、状态、紧迫度与回收节点。",
    });
    await saveArtifact("07-foreshadowing-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const clues = await novelDb.foreshadowing.where("projectId").equals(projectId).toArray();
    await saveArtifact("07-foreshadowing-applied.txt", JSON.stringify(clues, null, 2));
    expect(clues.length).toBeGreaterThan(0);
  });

  it("生成时间线", async () => {
    const result = await runGenerationTask({
      projectId,
      taskKey: "timeline",
      instruction:
        "基于架构和大纲生成故事时间线：从寒露屠门夜到当下沈雁声潜伏学剑的关键节点，明确先后顺序、持续时间、因果。注意十年江湖变迁的时间感与沧桑。",
    });
    await saveArtifact("08-timeline-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const events = await novelDb.timelineEvents.where("projectId").equals(projectId).toArray();
    await saveArtifact("08-timeline-applied.txt", JSON.stringify(events, null, 2));
    expect(events.length).toBeGreaterThan(0);
  });

  it("捕获规划阶段项目状态", async () => {
    const [project, architecture, entities, outline, threads, clues, timelineEvents, documents] = await Promise.all([
      novelDb.projects.get(projectId),
      novelDb.architectures.where("projectId").equals(projectId).first(),
      novelDb.entities.where("projectId").equals(projectId).toArray(),
      novelDb.outlineNodes.where("projectId").equals(projectId).sortBy("order"),
      novelDb.plotThreads.where("projectId").equals(projectId).toArray(),
      novelDb.foreshadowing.where("projectId").equals(projectId).toArray(),
      novelDb.timelineEvents.where("projectId").equals(projectId).sortBy("narrativeOrder"),
      novelDb.documents.where("projectId").equals(projectId).sortBy("order"),
    ]);
    const summary = [
      `# 规划阶段状态`,
      `## 项目`,
      `标题：${project?.title}　语言风格：${project?.languageStyle}`,
      ``,
      `## 架构`,
      `核心问题：${architecture?.centralQuestion}`,
      `阶段：\n${architecture?.phases.map((p) => `- ${p.order + 1}. ${p.title}：${p.purpose}`).join("\n") ?? "无"}`,
      ``,
      `## 角色 (${entities.filter((e) => e.kind === "character").length})`,
      ...entities.filter((e) => e.kind === "character").map((e) => `- ${e.name}：${e.summary}${e.character ? `\n  欲望：${e.character.desire}；声音：${e.character.voice}` : ""}`),
      ``,
      `## 大纲 (${outline.length})`,
      ...outline.map((n) => `- [${n.kind}] ${n.title}：${n.summary}`),
      ``,
      `## 章节 (${documents.length})`,
      ...documents.map((d) => `- [${d.order}] ${d.title}：${d.summary || "(无摘要)"}`),
    ].join("\n");
    await saveArtifact("10-state-after-planning.md", summary);
  });

  // ===== 第一章全流程 =====
  it("取第一章并启动工作流（thread + brief）", async () => {
    const docs = await novelDb.documents.where("projectId").equals(projectId).sortBy("order");
    if (!docs.length) throw new Error("plot-design 未生成章节");
    chapter1Id = docs[0].id;
    const thread = await novelMemoryService.getOrCreateThread({ projectId, targetDocumentId: chapter1Id });
    let brief = await novelMemoryService.getDraftBrief(thread.id);
    brief = await novelMemoryService.updateBrief(brief.id, {
      goal:
        "开篇第一章。寒露夜听潮阁被屠，掌门幼女沈雁声携血浸门人录逃入江上大雾。雾深处一座渡口，摆渡的哑巴老人不收钱只收一桩旧事。她交出旧事渡河，雾散后江上再无渡口痕迹。",
      tone: "冷峻克制，偶有侠气",
      languageRequirements: ["半文半白，意象密集，以雾、江水、寒灯、血字为意象", "避免大段心理独白与形容词堆砌"],
      mustHappen: [
        "听潮阁屠门夜呈现",
        "沈雁声携血浸门人录逃入大雾",
        "雾中渡口与哑巴摆渡人初遇",
        "沈雁声以一桩旧事换渡河",
      ],
      forbidden: ["不得直接揭示哑渡真实身份", "不得揭示沈雁声交出的旧事具体内容"],
      openQuestions: [],
    });
    brief = await novelMemoryService.confirmBrief(brief.id);
    const run = await startChapterWorkflow({
      projectId,
      documentId: chapter1Id,
      threadId: thread.id,
      briefId: brief.id,
      blocking: false,
    });
    await saveArtifact("11-chapter1-workflow-started.txt", JSON.stringify(run, null, 2));
  });

  it("第一章：推进到蓝图审批并批准", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter1Id).first();
    if (!run) throw new Error("工作流未启动");
    run = await waitForStage(run.id, (r) => r.status === "waiting-approval" && r.currentStage === "blueprint-approval", 90, 2000, "12-chapter1-blueprint");
    await saveArtifact("12-chapter1-blueprint-run.txt", JSON.stringify(run, null, 2));
    const blueprintArtifact = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((a) => a.kind === "blueprint").first();
    if (blueprintArtifact) await saveArtifact("12-chapter1-blueprint.md", blueprintArtifact.contentMarkdown);
    if (run.contextPacketId) {
      const packet = await novelDb.contextPackets.get(run.contextPacketId);
      if (packet) await saveArtifact("12-chapter1-context-packet.md", formatContextPacket(packet));
    }
    expect(run.status).toBe("waiting-approval");
    expect(run.currentStage).toBe("blueprint-approval");
    await approveWorkflowStage(run.id, { approved: true });
  });

  it("第一章：推进到正文审批并批准", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter1Id).first();
    if (!run) throw new Error("工作流未找到");
    run = await waitForStage(run.id, (r) => r.status === "waiting-approval" && r.currentStage === "manuscript-approval", 200, 3000, "13-chapter1-draft");
    await saveArtifact("13-chapter1-manuscript-run.txt", JSON.stringify(run, null, 2));
    const draftArtifact = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((a) => a.kind === "draft" || a.kind === "revision").reverse().sortBy("createdAt");
    if (draftArtifact.length) await saveArtifact("13-chapter1-draft.md", draftArtifact[0].contentMarkdown);
    const reviewArtifact = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((a) => a.kind === "review").reverse().sortBy("createdAt");
    if (reviewArtifact.length) await saveArtifact("13-chapter1-quality-report.md", reviewArtifact[0].contentMarkdown);
    const report = await novelDb.qualityReports.where("workflowRunId").equals(run.id).reverse().sortBy("createdAt");
    if (report.length) await saveArtifact("13-chapter1-quality-report-json.txt", JSON.stringify(report[0], null, 2));
    expect(run.status).toBe("waiting-approval");
    expect(run.currentStage).toBe("manuscript-approval");
    await approveWorkflowStage(run.id, { approved: true });
  });

  it("第一章：推进到事实审批并批准", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter1Id).first();
    if (!run) throw new Error("工作流未找到");
    run = await waitForStage(run.id, (r) => r.status === "waiting-approval" && r.currentStage === "fact-approval" || r.status === "completed", 120, 2000, "14-chapter1-fact");
    await saveArtifact("14-chapter1-fact-run.txt", JSON.stringify(run, null, 2));
    const candidates = await novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray();
    await saveArtifact("14-chapter1-fact-candidates.txt", JSON.stringify(candidates, null, 2));
    for (const c of candidates) {
      await setFactCandidateStatus(c.id, c.conflict ? "rejected" : "accepted");
    }
    if (run.status === "waiting-approval" && run.currentStage === "fact-approval") {
      await approveWorkflowStage(run.id, { approved: true });
    } else {
      expect(run.status).toBe("completed");
    }
  });

  it("第一章：等待工作流完成并捕获最终正文", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter1Id).first();
    if (!run) throw new Error("工作流未找到");
    run = await waitForStage(run.id, (r) => r.status === "completed" || r.status === "failed", 90, 1000);
    await saveArtifact("15-chapter1-final-run.txt", JSON.stringify(run, null, 2));
    const doc = await novelDb.documents.get(chapter1Id);
    if (doc) {
      await saveArtifact("15-chapter1-final.md", `# ${doc.title}\n\n${doc.plainText}`);
      await saveArtifact("15-chapter1-blueprint.txt", JSON.stringify(doc.blueprint, null, 2));
    }
    expect(run.status).toBe("completed");
  });

  // ===== 第二章全流程 =====
  it("第二章：启动工作流（thread + brief）", async () => {
    const docs = await novelDb.documents.where("projectId").equals(projectId).sortBy("order");
    if (docs.length < 2) throw new Error("plot-design 未生成第 2 章");
    chapter2Id = docs[1].id;
    const thread = await novelMemoryService.getOrCreateThread({ projectId, targetDocumentId: chapter2Id });
    let brief = await novelMemoryService.getDraftBrief(thread.id);
    brief = await novelMemoryService.updateBrief(brief.id, {
      goal:
        "第二章。沈雁声渡河之后在江边醒来，身无分文，只有一卷血染门人录。她进入最近的小镇休整，第一次以新身份在江湖中行走。镇上已有听潮阁覆灭的消息流传，有人在寻找幸存者。她需要在不暴露身份的前提下获取食物和情报，同时面对门人录第一个名字带来的追问。",
      tone: "冷峻克制，偶有侠气",
      languageRequirements: ["半文半白，意象密集，以雾、江水、寒灯、血字为意象", "避免大段心理独白与形容词堆砌"],
      mustHappen: [
        "沈雁声以新身份进入陌生小镇",
        "听潮阁覆灭的消息已在镇上流传",
        "沈雁声面对门人录第一个名字陆无名并产生追问",
        "有人在寻找听潮阁幸存者，沈雁声必须隐藏身份",
      ],
      forbidden: ["不得揭示哑渡真实身份", "不得揭示沈雁声交出的旧事具体内容", "不得让沈雁声直接说出自己的真实身份"],
      openQuestions: [],
    });
    brief = await novelMemoryService.confirmBrief(brief.id);
    const run = await startChapterWorkflow({
      projectId,
      documentId: chapter2Id,
      threadId: thread.id,
      briefId: brief.id,
      blocking: false,
    });
    await saveArtifact("21-chapter2-workflow-started.txt", JSON.stringify(run, null, 2));
  });

  it("第二章：推进到蓝图审批并批准", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter2Id).first();
    if (!run) throw new Error("第 2 章工作流未启动");
    run = await waitForStage(run.id, (r) => r.status === "waiting-approval" && r.currentStage === "blueprint-approval", 90, 2000, "22-chapter2-blueprint");
    await saveArtifact("22-chapter2-blueprint-run.txt", JSON.stringify(run, null, 2));
    const blueprintArtifact = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((a) => a.kind === "blueprint").first();
    if (blueprintArtifact) await saveArtifact("22-chapter2-blueprint.md", blueprintArtifact.contentMarkdown);
    if (run.contextPacketId) {
      const packet = await novelDb.contextPackets.get(run.contextPacketId);
      if (packet) await saveArtifact("22-chapter2-context-packet.md", formatContextPacket(packet));
    }
    expect(run.status).toBe("waiting-approval");
    expect(run.currentStage).toBe("blueprint-approval");
    await approveWorkflowStage(run.id, { approved: true });
  });

  it("第二章：推进到正文审批并批准", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter2Id).first();
    if (!run) throw new Error("第 2 章工作流未找到");
    run = await waitForStage(run.id, (r) => r.status === "waiting-approval" && r.currentStage === "manuscript-approval", 200, 3000, "23-chapter2-draft");
    await saveArtifact("23-chapter2-manuscript-run.txt", JSON.stringify(run, null, 2));
    const draftArtifact = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((a) => a.kind === "draft" || a.kind === "revision").reverse().sortBy("createdAt");
    if (draftArtifact.length) await saveArtifact("23-chapter2-draft.md", draftArtifact[0].contentMarkdown);
    const reviewArtifact = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((a) => a.kind === "review").reverse().sortBy("createdAt");
    if (reviewArtifact.length) await saveArtifact("23-chapter2-quality-report.md", reviewArtifact[0].contentMarkdown);
    const report = await novelDb.qualityReports.where("workflowRunId").equals(run.id).reverse().sortBy("createdAt");
    if (report.length) await saveArtifact("23-chapter2-quality-report-json.txt", JSON.stringify(report[0], null, 2));
    expect(run.status).toBe("waiting-approval");
    expect(run.currentStage).toBe("manuscript-approval");
    await approveWorkflowStage(run.id, { approved: true });
  });

  it("第二章：推进到事实审批并批准", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter2Id).first();
    if (!run) throw new Error("第 2 章工作流未找到");
    run = await waitForStage(run.id, (r) => r.status === "waiting-approval" && r.currentStage === "fact-approval" || r.status === "completed", 120, 2000, "24-chapter2-fact");
    await saveArtifact("24-chapter2-fact-run.txt", JSON.stringify(run, null, 2));
    const candidates = await novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray();
    await saveArtifact("24-chapter2-fact-candidates.txt", JSON.stringify(candidates, null, 2));
    for (const c of candidates) {
      await setFactCandidateStatus(c.id, c.conflict ? "rejected" : "accepted");
    }
    if (run.status === "waiting-approval" && run.currentStage === "fact-approval") {
      await approveWorkflowStage(run.id, { approved: true });
    } else {
      expect(run.status).toBe("completed");
    }
  });

  it("第二章：等待工作流完成并捕获最终正文", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter2Id).first();
    if (!run) throw new Error("第 2 章工作流未找到");
    run = await waitForStage(run.id, (r) => r.status === "completed" || r.status === "failed", 90, 1000);
    await saveArtifact("25-chapter2-final-run.txt", JSON.stringify(run, null, 2));
    const doc = await novelDb.documents.get(chapter2Id);
    if (doc) {
      await saveArtifact("25-chapter2-final.md", `# ${doc.title}\n\n${doc.plainText}`);
      await saveArtifact("25-chapter2-blueprint.txt", JSON.stringify(doc.blueprint, null, 2));
    }
    expect(run.status).toBe("completed");
  });
});
