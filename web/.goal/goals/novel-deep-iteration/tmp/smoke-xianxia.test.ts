/**
 * Loop 1 端到端冒烟测试：真实调用 LLM API，跑通仙侠题材 premise → 章节全流程。
 * 通过 vite dev server 的 /ai-proxy 代理转发到真实 API。
 *
 * 运行方式：
 *   npx vitest run .goal/goals/novel-deep-iteration/tmp/smoke-xianxia.test.ts --testTimeout=900000
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
import { createChapter, createNovelProject, novelDb } from "@/features/novel/db";
import { runGenerationTask, applyProposalItems } from "@/features/novel/generation";
import { startChapterWorkflow, approveWorkflowStage } from "@/features/novel/workflow";
import { setFactCandidateStatus } from "@/features/novel/facts";
import { formatContextPacket } from "@/features/novel/context";
import type { WorkflowRun } from "@/features/novel/types";

const ARTIFACTS_DIR = path.resolve(__dirname, "artifacts");
// dev server 当前在 5175（5173/5174 被占用）
const DEV_PROXY_URL = "http://localhost:5175/ai-proxy";

async function saveArtifact(name: string, content: string) {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await writeFile(path.join(ARTIFACTS_DIR, name), content, "utf8");
}

async function captureProjectState(projectId: string, label: string) {
  const [project, architecture, entities, outline, threads, clues, timelineEvents, documents, snapshots, scenes] = await Promise.all([
    novelDb.projects.get(projectId),
    novelDb.architectures.where("projectId").equals(projectId).first(),
    novelDb.entities.where("projectId").equals(projectId).toArray(),
    novelDb.outlineNodes.where("projectId").equals(projectId).sortBy("order"),
    novelDb.plotThreads.where("projectId").equals(projectId).toArray(),
    novelDb.foreshadowing.where("projectId").equals(projectId).toArray(),
    novelDb.timelineEvents.where("projectId").equals(projectId).sortBy("narrativeOrder"),
    novelDb.documents.where("projectId").equals(projectId).sortBy("order"),
    novelDb.snapshots.where("projectId").equals(projectId).reverse().sortBy("createdAt"),
    novelDb.scenes.where("projectId").equals(projectId).sortBy("order"),
  ]);
  const summary = [
    `# ${label}`,
    `## 项目`,
    `标题：${project?.title}`,
    `前提：${project?.premise}`,
    `题材：${project?.genre.join("、")}`,
    `受众：${project?.audience}`,
    `主题：${project?.themes.join("、")}`,
    `视角：${project?.pov} / ${project?.tense} / ${project?.tone}`,
    `语言风格：${project?.languageStyle}`,
    ``,
    `## 架构`,
    `核心问题：${architecture?.centralQuestion}`,
    `核心冲突：${architecture?.centralConflict}`,
    `梗概：${architecture?.synopsis}`,
    `阶段：\n${architecture?.phases.map((p) => `- ${p.order + 1}. ${p.title}：${p.purpose}；转折：${p.turningPoint}`).join("\n") ?? "无"}`,
    ``,
    `## 角色/实体 (${entities.length})`,
    ...entities.map((e) => `- [${e.kind}] ${e.name}：${e.summary}${e.character ? `\n  欲望：${e.character.desire}；恐惧：${e.character.weakness}；弧：${e.character.arc}` : ""}`),
    ``,
    `## 大纲 (${outline.length})`,
    ...outline.map((n) => `- [${n.kind}] ${n.title}：${n.summary}${n.storyTime ? `\n  故事时间：${n.storyTime}` : ""}`),
    ``,
    `## 剧情线 (${threads.length})`,
    ...threads.map((t) => `- [${t.kind}] ${t.title}：${t.summary}\n  状态：${t.status}；下一步：${t.nextMove}`),
    ``,
    `## 伏笔 (${clues.length})`,
    ...clues.map((c) => `- ${c.title}：${c.clue}\n  真相：${c.truth}；状态：${c.status}`),
    ``,
    `## 时间线 (${timelineEvents.length})`,
    ...timelineEvents.map((e) => `- [${e.narrativeOrder}] ${e.title}：${e.storyDate}（${e.duration}）\n  ${e.description}`),
    ``,
    `## 场景 (${scenes.length})`,
    ...scenes.map((s) => `- [${s.order}] ${s.title}：${s.purpose}；冲突：${s.conflict}；结果：${s.outcome}`),
    ``,
    `## 章节 (${documents.length})`,
    ...documents.map((d) => `- [${d.order}] ${d.title}：${d.status}，${d.wordCount}字\n  摘要：${d.summary || "(无)"}\n  蓝图目标：${d.blueprint.objective || "(无)"}`),
    ``,
    `## 快照 (${snapshots.length})`,
    ...snapshots.map((s) => `- ${s.label}：${s.recentSummary.slice(0, 200)}`),
  ].join("\n");
  await saveArtifact(label, summary);
  return summary;
}

async function waitForStage(runId: string, targetStage: WorkflowRun["currentStage"], maxAttempts: number, intervalMs: number, progressLabel?: string) {
  let run = await novelDb.workflowRuns.get(runId);
  if (!run) throw new Error("工作流不存在");
  let attempts = 0;
  while (run.status === "running" && attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, intervalMs));
    run = (await novelDb.workflowRuns.get(runId))!;
    attempts++;
    if (progressLabel && attempts % 10 === 0) {
      await saveArtifact(`${progressLabel}-progress-${attempts}.txt`, `stage=${run.currentStage} status=${run.status} revisionIteration=${run.revisionIteration}`);
    }
  }
  return run!;
}

describe("smoke e2e 仙侠: premise → 章节 2 全流程", () => {
  let projectId: string;
  let chapter1Id: string;
  let chapter2Id: string;

  it("配置 API 指向 dev proxy", () => {
    useUIStore.setState({ apiBaseUrl: DEV_PROXY_URL, apiKey: DEFAULT_API_KEY });
    const config = useUIStore.getState();
    expect(config.apiBaseUrl).toBe(DEV_PROXY_URL);
    expect(config.apiKey).toBe(DEFAULT_API_KEY);
  });

  it("创建仙侠测试项目", async () => {
    await novelDb.delete();
    await novelDb.open();
    const project = await createNovelProject({
      title: "听雨剑",
      genre: ["仙侠", "古典奇幻"],
      premise:
        "末法时代，剑修沈青衫醒来时已失去百年记忆，只记得自己曾一剑斩断了某座山。他随身一柄无名锈剑，锈迹剥落处隐隐露出前人姓名。每斩一剑，锈落一分，他便记起一段被自己亲手抹去的旧事——而那些旧事，多是他对不起的人。他一路向西寻道，沿途遇见旧友旧敌，却无人认得他。真相是：他曾以一己之力封印天地灵脉，断绝了一个时代的修行路，锈剑里封着的，是他自己的剑心。",
    });
    projectId = project.id;
    await saveArtifact("00-project-created.txt", JSON.stringify(project, null, 2));
  });

  it("生成项目定位", async () => {
    const result = await runGenerationTask({
      projectId,
      taskKey: "project-positioning",
      instruction:
        "完善项目定位：这是一部仙侠/古典奇幻长篇，追求中文意境美与古典美学。目标读者为喜爱金庸、古龙、烽火戏诸侯风格的成人读者。主题围绕'记忆、罪赎、寻道'。叙事视角为有限第三人称，过去时，基调苍凉克制而偶有侠气。语言风格追求半文半白、意象密集、留白承重。目标约200万字连载。",
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
        "基于核心创意生成四阶段全书架构（起、承、转、合），明确核心冲突、核心问题与宏观阶段转折。核心冲突：沈青衫寻回记忆 vs 记忆里尽是罪孽。核心问题：当一个人为苍生断送一整个时代，他配不配再握剑。故事约200万字，分四大卷：锈剑初醒、西行寻道、旧债新偿、剑心归位。每卷应有明确转折与情感落点。",
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
        "设计4-5个核心角色：1) 沈青衫——失忆剑修，主角，锈剑随身，罪孽深重却不自知；2) 阿落——西行路上遇到的盲眼琴师，实为沈青衫百年前斩杀的故人之女，不知真相一路相随；3) 谢道临——当世第一宗门掌教，维护末法时代残存秩序，视沈青衫为必须铲除的隐患；4) 沈青衫的剑灵/剑心——封在锈剑里的另一人格，是百年前那个决绝封脉的'真沈青衫'；5) 一位旧友——曾在封脉前与沈青衫立约，如今已老朽，是唯一认出他的人。每个角色需有明确欲望、恐惧、秘密、声音特征与人物弧。角色声音要有古典质感。",
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
        "构建末法时代仙侠世界观：1) 灵脉被封后天地灵气稀薄，修行之法大多失传，残存宗门靠灵石续命；2) 锈剑、剑修、剑心的设定体系；3) 地理——西行路上的关隘、废墟、古城；4) 势力——残存宗门、流民修士、世俗王朝；5) 规则——末法时代修行瓶颈、灵脉封印的代价。世界观要有东方意境，避免西幻设定。",
    });
    await saveArtifact("04-worldview-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const entities = await novelDb.entities.where("projectId").equals(projectId).toArray();
    await saveArtifact("04-worldview-applied.txt", JSON.stringify(entities.filter((e) => e.kind !== "character"), null, 2));
  });

  it("生成故事大纲", async () => {
    const result = await runGenerationTask({
      projectId,
      taskKey: "outline",
      instruction:
        "基于已批准架构生成第一卷'锈剑初醒'的层级故事大纲：3个幕，每幕2-3个序列，每序列2-3个事件。强调因果、人物选择与转折，不绑定章节编号。每个事件的 summary 应以散文形式完整交代'缘起→触发→阻碍→直接结果→延后余波'五要素。注意中文意境与古典叙事节奏。",
    });
    await saveArtifact("05-outline-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const outline = await novelDb.outlineNodes.where("projectId").equals(projectId).sortBy("order");
    await saveArtifact("05-outline-applied.txt", JSON.stringify(outline, null, 2));
    expect(outline.length, "大纲生成失败：0 节点，上游 analyzeOutlineProposal 可能拒绝了 LLM 输出").toBeGreaterThan(0);
    const acts = outline.filter((n) => n.kind === "act");
    expect(acts.length, "大纲应至少有 1 个幕节点").toBeGreaterThan(0);
  });

  it("生成剧情线", async () => {
    const result = await runGenerationTask({
      projectId,
      taskKey: "plot-threads",
      instruction:
        "规划剧情线：1) 主线——沈青衫西行寻道与记忆回收；2) 支线——阿落寻仇不知仇人在身边；3) 对抗线——谢道临追剿沈青衫；4) 成长线——沈青衫从避罪到承担。每条线需有参与者、当前状态、优先级、下一步推进。",
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
        "规划伏笔：1) 锈剑上每个露出的名字对应一段罪孽；2) 阿落盲眼的真正原因；3) 沈青衫为何独独记得'斩山'；4) 谢道临与沈青衫百年前的渊源；5) 封脉时沈青衫留下的某种后手。每条伏笔需有线索、真相、状态、紧迫度与回收节点。",
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
        "基于架构和大纲生成故事时间线：从百年前封脉事件到当下沈青衫醒来的关键节点，明确先后顺序、持续时间、因果。注意末法时代百年沧桑的时间感。",
    });
    await saveArtifact("08-timeline-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const events = await novelDb.timelineEvents.where("projectId").equals(projectId).toArray();
    await saveArtifact("08-timeline-applied.txt", JSON.stringify(events, null, 2));
    expect(events.length).toBeGreaterThan(0);
  });

  it("捕获规划阶段项目状态", async () => {
    await captureProjectState(projectId, "10-state-after-planning.md");
  });

  // ===== 第一章全流程 =====
  it("创建第一章并启动工作流", async () => {
    const chapter = await createChapter(projectId, "第一章：锈剑初醒");
    chapter1Id = chapter.id;
    const run = await startChapterWorkflow({
      projectId,
      documentId: chapter1Id,
      instruction:
        "开篇第一章。沈青衫在一座破败山神庙醒来，身边只有一柄锈剑。他记不清自己是谁，只记得一剑斩山的画面。庙外下着雨，一个盲眼琴师阿落避雨至此。两人初遇。本章需建立：末法时代的荒凉氛围、沈青衫的失忆困境、锈剑的诡异、阿落的身份悬念。文风追求苍凉意境，以雨声、锈迹、残庙为意象，开篇即抓人。",
      blocking: false,
    });
    await saveArtifact("11-chapter1-workflow-started.txt", JSON.stringify(run, null, 2));
  });

  it("第一章：推进到蓝图审批并批准", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter1Id).first();
    if (!run) throw new Error("工作流未启动");
    run = await waitForStage(run.id, "blueprint-approval", 60, 2000, "12-chapter1-blueprint");
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
    run = await waitForStage(run.id, "manuscript-approval", 180, 3000, "13-chapter1-draft");
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
    run = await waitForStage(run.id, "fact-approval", 90, 2000, "14-chapter1-fact");
    await saveArtifact("14-chapter1-fact-run.txt", JSON.stringify(run, null, 2));
    const candidates = await novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray();
    await saveArtifact("14-chapter1-fact-candidates.txt", JSON.stringify(candidates, null, 2));
    for (const c of candidates) {
      await setFactCandidateStatus(c.id, c.conflict ? "rejected" : "accepted");
    }
    const factArtifact = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((a) => a.kind === "fact-delta").first();
    if (factArtifact) await saveArtifact("14-chapter1-fact-delta.md", factArtifact.contentMarkdown);
    // Loop 9 修复：fact-approval 阶段已改为自动应用事实，工作流可能已自动完成（同 chapter 2 处理）
    if (run.status === "waiting-approval" && run.currentStage === "fact-approval") {
      await approveWorkflowStage(run.id, { approved: true });
    } else {
      expect(run.status).toBe("completed");
    }
  });

  it("第一章：等待工作流完成并捕获最终正文", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter1Id).first();
    if (!run) throw new Error("工作流未找到");
    run = await waitForStage(run.id, "commit", 60, 1000);
    await saveArtifact("15-chapter1-final-run.txt", JSON.stringify(run, null, 2));
    const doc = await novelDb.documents.get(chapter1Id);
    if (doc) {
      await saveArtifact("15-chapter1-final.md", `# ${doc.title}\n\n${doc.plainText}`);
      await saveArtifact("15-chapter1-blueprint.txt", JSON.stringify(doc.blueprint, null, 2));
    }
    expect(run.status).toBe("completed");
  });

  // ===== 第二章全流程（验证跨章节一致性）=====
  it("创建第二章并启动工作流", async () => {
    const chapter = await createChapter(projectId, "第二章：西行第一关");
    chapter2Id = chapter.id;
    const run = await startChapterWorkflow({
      projectId,
      documentId: chapter2Id,
      instruction:
        "第二章。沈青衫与阿落结伴西行，路过一座被遗弃的修士城镇。城中残留的护城阵法仍在运转，沈青衫锈剑出鞘斩阵，锈落一分，记起一桩旧事——他曾在百年前于此地斩杀一位故人。阿落不知情，弹琴相和。本章需承接第一章氛围，推进西行主线，埋下阿落身世伏笔，并让沈青衫第一次直面'锈剑=记忆=罪'的关联。",
      blocking: false,
    });
    await saveArtifact("21-chapter2-workflow-started.txt", JSON.stringify(run, null, 2));
  });

  it("第二章：推进到蓝图审批并批准", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter2Id).first();
    if (!run) throw new Error("工作流未启动");
    run = await waitForStage(run.id, "blueprint-approval", 60, 2000, "22-chapter2-blueprint");
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
    if (!run) throw new Error("工作流未找到");
    run = await waitForStage(run.id, "manuscript-approval", 180, 3000, "23-chapter2-draft");
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
    if (!run) throw new Error("工作流未找到");
    run = await waitForStage(run.id, "fact-approval", 90, 2000, "24-chapter2-fact");
    await saveArtifact("24-chapter2-fact-run.txt", JSON.stringify(run, null, 2));
    const candidates = await novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray();
    await saveArtifact("24-chapter2-fact-candidates.txt", JSON.stringify(candidates, null, 2));
    for (const c of candidates) {
      await setFactCandidateStatus(c.id, c.conflict ? "rejected" : "accepted");
    }
    // Loop 7 修复：fact-approval 阶段已改为自动应用事实（无需人工审批），工作流可能已自动完成
    // 如果工作流仍在 fact-approval 等待审批，则手动批准；如果已自动完成，则跳过
    if (run.status === "waiting-approval" && run.currentStage === "fact-approval") {
      await approveWorkflowStage(run.id, { approved: true });
    } else {
      expect(run.status).toBe("completed");
    }
  });

  it("第二章：等待工作流完成并捕获最终正文", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter2Id).first();
    if (!run) throw new Error("工作流未找到");
    run = await waitForStage(run.id, "commit", 60, 1000);
    await saveArtifact("25-chapter2-final-run.txt", JSON.stringify(run, null, 2));
    const doc = await novelDb.documents.get(chapter2Id);
    if (doc) {
      await saveArtifact("25-chapter2-final.md", `# ${doc.title}\n\n${doc.plainText}`);
    }
    await captureProjectState(projectId, "26-final-project-state.md");
    expect(run.status).toBe("completed");
  });
});
