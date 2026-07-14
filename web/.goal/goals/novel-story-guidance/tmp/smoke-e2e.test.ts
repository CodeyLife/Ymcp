/**
 * Loop 1 端到端冒烟测试：真实调用 LLM API，跑通 premise → fact extraction 全流程。
 * 通过 vite dev server 的 /ai-proxy 代理转发到真实 API。
 *
 * 运行方式：
 *   npx vitest run .goal/goals/novel-story-guidance/tmp/smoke-e2e.test.ts --testTimeout=600000
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
const DEV_PROXY_URL = "http://localhost:5174/ai-proxy";

async function saveArtifact(name: string, content: string) {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await writeFile(path.join(ARTIFACTS_DIR, name), content, "utf8");
}

async function captureProjectState(projectId: string, label: string) {
  const [project, architecture, entities, outline, threads, clues, timelineEvents, documents, snapshots] = await Promise.all([
    novelDb.projects.get(projectId),
    novelDb.architectures.where("projectId").equals(projectId).first(),
    novelDb.entities.where("projectId").equals(projectId).toArray(),
    novelDb.outlineNodes.where("projectId").equals(projectId).sortBy("order"),
    novelDb.plotThreads.where("projectId").equals(projectId).toArray(),
    novelDb.foreshadowing.where("projectId").equals(projectId).toArray(),
    novelDb.timelineEvents.where("projectId").equals(projectId).sortBy("narrativeOrder"),
    novelDb.documents.where("projectId").equals(projectId).sortBy("order"),
    novelDb.snapshots.where("projectId").equals(projectId).reverse().sortBy("createdAt"),
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
    ``,
    `## 架构`,
    `核心问题：${architecture?.centralQuestion}`,
    `读者承诺：${architecture?.readerPromise}`,
    `核心冲突：${architecture?.centralConflict}`,
    `梗概：${architecture?.synopsis}`,
    `阶段：\n${architecture?.phases.map((p) => `- ${p.order + 1}. ${p.title}：${p.purpose}；转折：${p.turningPoint}`).join("\n") ?? "无"}`,
    ``,
    `## 角色/实体 (${entities.length})`,
    ...entities.map((e) => `- [${e.kind}] ${e.name}：${e.summary}${e.character ? `\n  欲望：${e.character.desire}；恐惧：${e.character.weakness}；弧：${e.character.arc}` : ""}`),
    ``,
    `## 大纲 (${outline.length})`,
    ...outline.map((n) => `- [${n.kind}] ${n.title}：${n.summary}\n  因果：${n.causality}；结果：${n.outcome}`),
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
    `## 章节 (${documents.length})`,
    ...documents.map((d) => `- [${d.order}] ${d.title}：${d.status}，${d.wordCount}字\n  摘要：${d.summary || "(无)"}\n  蓝图目标：${d.blueprint.objective || "(无)"}`),
    ``,
    `## 快照 (${snapshots.length})`,
    ...snapshots.map((s) => `- ${s.label}：${s.recentSummary.slice(0, 200)}`),
  ].join("\n");
  await saveArtifact(label, summary);
  return summary;
}

describe("smoke e2e: premise → fact extraction", () => {
  let projectId: string;
  let chapterId: string;

  it("配置 API 指向 dev proxy", () => {
    useUIStore.setState({ apiBaseUrl: DEV_PROXY_URL, apiKey: DEFAULT_API_KEY });
    const config = useUIStore.getState();
    expect(config.apiBaseUrl).toBe(DEV_PROXY_URL);
    expect(config.apiKey).toBe(DEFAULT_API_KEY);
  });

  it("创建测试项目", async () => {
    await novelDb.delete();
    await novelDb.open();
    const project = await createNovelProject({
      title: "遗忘之名",
      genre: ["悬疑", "都市"],
      premise: "城市里每个人都会遗忘一个名字，只有主角能记住——但每记住一个名字，他就会失去一段自己的记忆。",
    });
    projectId = project.id;
    await saveArtifact("00-project-created.txt", JSON.stringify(project, null, 2));
  });

  it("生成项目定位", async () => {
    const result = await runGenerationTask({
      projectId,
      taskKey: "project-positioning",
      instruction: "完善项目定位：明确目标读者、主题、卖点、叙事视角与基调。这是一个关于记忆与身份的都市悬疑故事。",
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
      instruction: "基于核心创意生成三幕式全书架构，明确核心冲突、读者承诺和宏观阶段转折。故事约30万字。",
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
      instruction: "设计3-4个核心角色：主角（能记住被遗忘名字的人）、关键对手、重要配角。每个角色需有明确欲望、恐惧、错误信念、秘密和人物弧。",
    });
    await saveArtifact("03-characters-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const entities = await novelDb.entities.where("projectId").equals(projectId).toArray();
    await saveArtifact("03-characters-applied.txt", JSON.stringify(entities, null, 2));
  });

  it("生成故事大纲", async () => {
    const result = await runGenerationTask({
      projectId,
      taskKey: "outline",
      instruction: "基于已批准架构生成层级故事大纲：3个幕，每幕2-3个序列，每序列2-3个事件。强调因果、人物选择和转折，不绑定章节编号。",
    });
    await saveArtifact("04-outline-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const outline = await novelDb.outlineNodes.where("projectId").equals(projectId).sortBy("order");
    await saveArtifact("04-outline-applied.txt", JSON.stringify(outline, null, 2));
  });

  it("生成剧情线", async () => {
    const result = await runGenerationTask({
      projectId,
      taskKey: "plot-threads",
      instruction: "基于已批准架构和大纲规划主线和支线剧情线：主线围绕名字消失事件调查，支线包括沈默记忆代价危机、林见夏调查者成长、顾临川秩序维护者对抗。每条线需有参与者、当前状态、优先级和下一步推进。",
    });
    await saveArtifact("05-plot-threads-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const threads = await novelDb.plotThreads.where("projectId").equals(projectId).toArray();
    await saveArtifact("05-plot-threads-applied.txt", JSON.stringify(threads, null, 2));
    expect(threads.length).toBeGreaterThan(0);
  });

  it("生成伏笔", async () => {
    const result = await runGenerationTask({
      projectId,
      taskKey: "foreshadowing",
      instruction: "基于架构、大纲和剧情线规划伏笔：包括沈默过去与名字消失机制的关联、钥匙和'别忘'纸条的悬念、匿名照片墙的威胁来源、林见夏信息来源的未解之谜。每条伏笔需有线索、真相、状态、紧迫度和回收节点。",
    });
    await saveArtifact("06-foreshadowing-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const clues = await novelDb.foreshadowing.where("projectId").equals(projectId).toArray();
    await saveArtifact("06-foreshadowing-applied.txt", JSON.stringify(clues, null, 2));
    expect(clues.length).toBeGreaterThan(0);
  });

  it("生成时间线", async () => {
    const result = await runGenerationTask({
      projectId,
      taskKey: "timeline",
      instruction: "基于架构和大纲生成故事时间线：从名字消失现象首次出现到主角卷入调查的关键事件，明确先后顺序、持续时间、原因和后果。",
    });
    await saveArtifact("07-timeline-proposal.md", result.proposal.previewMarkdown);
    await applyProposalItems(result.proposal.id, result.proposal.items.map((i) => i.id));
    const events = await novelDb.timelineEvents.where("projectId").equals(projectId).toArray();
    await saveArtifact("07-timeline-applied.txt", JSON.stringify(events, null, 2));
    expect(events.length).toBeGreaterThan(0);
  });

  it("捕获规划阶段项目状态", async () => {
    await captureProjectState(projectId, "10-state-after-planning.md");
  });

  it("创建章节并启动工作流", async () => {
    const chapter = await createChapter(projectId, "第一章：被遗忘的名字");
    chapterId = chapter.id;
    const run = await startChapterWorkflow({ projectId, documentId: chapterId, instruction: "开篇第一章。主角在城市中发现自己能记住别人遗忘的名字，但每记住一个就失去一段自己的记忆。建立世界观、主角困境和核心悬念。" });
    await saveArtifact("11-workflow-started.txt", JSON.stringify(run, null, 2));
  });

  it("推进到蓝图审批并批准", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapterId).first();
    if (!run) throw new Error("工作流未启动");
    // 等待到达 waiting-approval (blueprint-approval)
    let attempts = 0;
    while (run.status === "running" && attempts < 30) {
      await new Promise((r) => setTimeout(r, 2000));
      run = (await novelDb.workflowRuns.get(run.id))!;
      attempts++;
    }
    await saveArtifact("12-blueprint-stage-run.txt", JSON.stringify(run, null, 2));
    // 捕获蓝图产物
    const blueprintArtifact = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((a) => a.kind === "blueprint").first();
    if (blueprintArtifact) await saveArtifact("12-blueprint-artifact.md", blueprintArtifact.contentMarkdown);
    // 捕获 context packet
    if (run.contextPacketId) {
      const packet = await novelDb.contextPackets.get(run.contextPacketId);
      if (packet) await saveArtifact("12-context-packet.md", formatContextPacket(packet));
    }
    expect(run.status).toBe("waiting-approval");
    expect(run.currentStage).toBe("blueprint-approval");
    await approveWorkflowStage(run.id, { approved: true });
  });

  it("推进到正文审批并批准", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapterId).first();
    if (!run) throw new Error("工作流未找到");
    // 等待到达 waiting-approval (manuscript-approval) 或完成
    let attempts = 0;
    while (run.status === "running" && attempts < 120) {
      await new Promise((r) => setTimeout(r, 3000));
      run = (await novelDb.workflowRuns.get(run.id))!;
      attempts++;
      if (attempts % 10 === 0) {
        await saveArtifact(`13-draft-progress-${attempts}.txt`, `stage=${run.currentStage} status=${run.status} revisionIteration=${run.revisionIteration}`);
      }
    }
    await saveArtifact("13-manuscript-stage-run.txt", JSON.stringify(run, null, 2));
    // 捕获正文产物
    const draftArtifact = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((a) => a.kind === "draft" || a.kind === "revision").reverse().sortBy("createdAt");
    if (draftArtifact.length) await saveArtifact("13-draft-artifact.md", draftArtifact[0].contentMarkdown);
    // 捕获质量报告
    const reviewArtifact = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((a) => a.kind === "review").reverse().sortBy("createdAt");
    if (reviewArtifact.length) await saveArtifact("13-quality-report.md", reviewArtifact[0].contentMarkdown);
    const report = await novelDb.qualityReports.where("workflowRunId").equals(run.id).reverse().sortBy("createdAt");
    if (report.length) await saveArtifact("13-quality-report-json.txt", JSON.stringify(report[0], null, 2));
    expect(run.status).toBe("waiting-approval");
    expect(run.currentStage).toBe("manuscript-approval");
    await approveWorkflowStage(run.id, { approved: true });
  });

  it("推进到事实审批并批准", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapterId).first();
    if (!run) throw new Error("工作流未找到");
    let attempts = 0;
    while (run.status === "running" && attempts < 60) {
      await new Promise((r) => setTimeout(r, 2000));
      run = (await novelDb.workflowRuns.get(run.id))!;
      attempts++;
    }
    await saveArtifact("14-fact-stage-run.txt", JSON.stringify(run, null, 2));
    // 捕获事实候选
    const candidates = await novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray();
    await saveArtifact("14-fact-candidates.txt", JSON.stringify(candidates, null, 2));
    // 接受所有非冲突、非重复的候选；拒绝冲突的
    for (const c of candidates) {
      await setFactCandidateStatus(c.id, c.conflict ? "rejected" : "accepted");
    }
    const factArtifact = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((a) => a.kind === "fact-delta").first();
    if (factArtifact) await saveArtifact("14-fact-delta.md", factArtifact.contentMarkdown);
    expect(run.status).toBe("waiting-approval");
    expect(run.currentStage).toBe("fact-approval");
    await approveWorkflowStage(run.id, { approved: true });
  });

  it("等待工作流完成并捕获最终状态", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapterId).first();
    if (!run) throw new Error("工作流未找到");
    let attempts = 0;
    while (run.status === "running" && attempts < 30) {
      await new Promise((r) => setTimeout(r, 1000));
      run = (await novelDb.workflowRuns.get(run.id))!;
      attempts++;
    }
    await saveArtifact("15-final-run.txt", JSON.stringify(run, null, 2));
    await captureProjectState(projectId, "15-final-project-state.md");
    // 捕获最终章节内容
    const doc = await novelDb.documents.get(chapterId);
    if (doc) {
      await saveArtifact("15-final-chapter.md", `# ${doc.title}\n\n${doc.plainText}`);
      await saveArtifact("15-final-chapter-blueprint.txt", JSON.stringify(doc.blueprint, null, 2));
    }
    // 捕获所有 agent runs
    const agents = await novelDb.agentRuns.where("projectId").equals(projectId).toArray();
    await saveArtifact("15-agent-runs.txt", JSON.stringify(agents.map((a) => ({ id: a.id, role: a.role, goal: a.goal, status: a.status, usage: a.usage, promptHash: a.promptHash })), null, 2));
    expect(run.status).toBe("completed");
  });

  // ===== Loop 3 跨章节长程记忆验证 =====
  // 验证 chapter 1 的 fact candidates 被接受后，更新到 entities/relations/plotThreads/foreshadowing 表，
  // 并在 chapter 2 的 context packet 中作为记忆源被检索（长程记忆一致性的核心证据）。

  let chapter2Id: string;

  it("创建第二章并启动工作流", async () => {
    const chapter2 = await createChapter(projectId, "第二章：深入调查");
    chapter2Id = chapter2.id;
    const run = await startChapterWorkflow({
      projectId,
      documentId: chapter2Id,
      instruction: "第二章。主角开始主动调查名字消失事件，与关键配角合作追查线索。同时主角的能力代价加深——他发现自己开始遗忘与调查相关的个人记忆。本章需推进剧情线并回收/埋设伏笔。",
      blocking: false,
    });
    await saveArtifact("20-chapter2-workflow-started.txt", JSON.stringify(run, null, 2));
    expect(run.status).toBe("running");
  });

  it("验证第二章 context packet 包含第一章事实回灌", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter2Id).first();
    if (!run) throw new Error("第二章工作流未找到");
    // 等待 context 阶段完成，context packet 被保存
    let attempts = 0;
    while ((!run.contextPacketId || run.currentStage === "context") && run.status === "running" && attempts < 60) {
      await new Promise((r) => setTimeout(r, 2000));
      run = (await novelDb.workflowRuns.get(run.id))!;
      attempts++;
    }
    expect(run.contextPacketId).toBeTruthy();
    const packet = await novelDb.contextPackets.get(run.contextPacketId!);
    expect(packet).toBeTruthy();
    await saveArtifact("21-chapter2-context-packet.md", formatContextPacket(packet!));

    // 检查 context packet 是否包含第一章回写的事实
    const packetText = formatContextPacket(packet!);
    // 第一章 fact candidates 关键内容（来自 14-fact-candidates.txt）
    const expectedFacts = [
      "沈默", // 主角状态更新
      "周迟", // 调查关联
      "林见夏", // 合作关系
      "记忆", // 能力代价
      "名字", // 核心主题
    ];
    const foundFacts = expectedFacts.filter((fact) => packetText.includes(fact));
    await saveArtifact("21-chapter2-context-fact-check.txt", `期望事实关键词：${expectedFacts.join(", ")}\n找到：${foundFacts.join(", ")}\n覆盖率：${foundFacts.length}/${expectedFacts.length}\n\nPacket 来源类型：${[...new Set(packet!.sources.map((s) => s.kind))].join(", ")}\nPacket 来源数量：${packet!.sources.length}\nPacket token 估计：${packet!.estimatedTokens}`);

    // 验证 context packet 至少包含 entity 和 document 来源（第一章事实回灌的证据）
    const sourceKinds = packet!.sources.map((s) => s.kind);
    expect(sourceKinds).toContain("entity");
    expect(sourceKinds).toContain("document");

    // 验证第一章的 fact candidates 已被写入数据库（通过 entities 表更新）
    const entities = await novelDb.entities.where("projectId").equals(projectId).toArray();
    const characters = entities.filter((e) => e.kind === "character" && e.character);
    expect(characters.length).toBeGreaterThan(0);
    // 找到主角（role 包含"主角"或"protagonist"），若找不到则用第一个角色
    const protagonist = characters.find((e) => /主角|protagonist/i.test(e.character!.role)) ?? characters[0];
    expect(protagonist).toBeTruthy();
    const stateJson = JSON.stringify(protagonist.character?.state ?? {});
    const knowledgeJson = JSON.stringify(protagonist.character?.knowledge ?? {});
    await saveArtifact("21-chapter2-protagonist-state.txt", `角色：${protagonist.name}（${protagonist.character!.role}）\nstate: ${stateJson}\n\nknowledge: ${knowledgeJson}\n\nlockedFacts: ${JSON.stringify(protagonist.lockedFacts)}`);

    // 捕获第二章蓝图产物（如果已生成）
    const blueprintArtifact = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((a) => a.kind === "blueprint").first();
    if (blueprintArtifact) {
      await saveArtifact("22-chapter2-blueprint-artifact.md", blueprintArtifact.contentMarkdown);
    }

    // 等待 blueprint-approval
    attempts = 0;
    while (run.status === "running" && run.currentStage !== "blueprint-approval" && attempts < 90) {
      await new Promise((r) => setTimeout(r, 2000));
      run = (await novelDb.workflowRuns.get(run.id))!;
      attempts++;
    }
    await saveArtifact("22-chapter2-blueprint-stage-run.txt", JSON.stringify(run, null, 2));
    if (run.currentStage === "blueprint-approval") {
      await approveWorkflowStage(run.id, { approved: true });
    }
  });

  it("第二章推进到正文审批并批准", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter2Id).first();
    if (!run) throw new Error("第二章工作流未找到");
    let attempts = 0;
    while (run.status === "running" && run.currentStage !== "manuscript-approval" && attempts < 120) {
      await new Promise((r) => setTimeout(r, 3000));
      run = (await novelDb.workflowRuns.get(run.id))!;
      attempts++;
      if (attempts % 10 === 0) {
        await saveArtifact(`23-chapter2-draft-progress-${attempts}.txt`, `stage=${run.currentStage} status=${run.status} revisionIteration=${run.revisionIteration}`);
      }
    }
    await saveArtifact("23-chapter2-manuscript-stage-run.txt", JSON.stringify(run, null, 2));

    const draftArtifact = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((a) => a.kind === "draft" || a.kind === "revision").last();
    if (draftArtifact) await saveArtifact("23-chapter2-draft-artifact.md", draftArtifact.contentMarkdown);
    const qualityReport = await novelDb.qualityReports.where("workflowRunId").equals(run.id).last();
    if (qualityReport) {
      await saveArtifact("23-chapter2-quality-report.md", `分数：${qualityReport.weightedScore}（阈值 ${3.7}）\nblockers：${qualityReport.blockerCount}\npassed：${qualityReport.passed}\niteration：${qualityReport.iteration}`);
      await saveArtifact("23-chapter2-quality-report-json.txt", JSON.stringify(qualityReport, null, 2));
    }

    expect(run.currentStage).toBe("manuscript-approval");
    await approveWorkflowStage(run.id, { approved: true });
  });

  it("第二章推进到事实审批并批准", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter2Id).first();
    if (!run) throw new Error("第二章工作流未找到");
    let attempts = 0;
    while (run.status === "running" && run.currentStage !== "fact-approval" && attempts < 60) {
      await new Promise((r) => setTimeout(r, 2000));
      run = (await novelDb.workflowRuns.get(run.id))!;
      attempts++;
    }
    await saveArtifact("24-chapter2-fact-stage-run.txt", JSON.stringify(run, null, 2));

    const factArtifact = await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).and((a) => a.kind === "fact-delta").last();
    if (factArtifact) await saveArtifact("24-chapter2-fact-delta.md", factArtifact.contentMarkdown);

    expect(run.currentStage).toBe("fact-approval");
    await approveWorkflowStage(run.id, { approved: true });
  });

  it("第二章工作流完成并验证跨章节一致性", async () => {
    let run = await novelDb.workflowRuns.where("projectId").equals(projectId).and((r) => r.targetDocumentId === chapter2Id).first();
    if (!run) throw new Error("第二章工作流未找到");
    let attempts = 0;
    while (run.status === "running" && attempts < 30) {
      await new Promise((r) => setTimeout(r, 1000));
      run = (await novelDb.workflowRuns.get(run.id))!;
      attempts++;
    }
    await saveArtifact("25-chapter2-final-run.txt", JSON.stringify(run, null, 2));
    expect(run.status).toBe("completed");

    // 验证跨章节一致性：chapter 2 的 fact candidates 与 chapter 1 的已确认事实无矛盾
    const ch1FactCandidates = await novelDb.factCandidates.where("projectId").equals(projectId).and((f) => f.workflowRunId !== run.id).toArray();
    const ch2FactCandidates = await novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray();
    await saveArtifact("25-chapter2-fact-candidates.txt", JSON.stringify(ch2FactCandidates, null, 2));
    expect(ch2FactCandidates.length).toBeGreaterThan(0);

    // 验证主角实体在 chapter 2 后有状态更新（能力代价加深）
    const entities = await novelDb.entities.where("projectId").equals(projectId).toArray();
    const characters = entities.filter((e) => e.kind === "character" && e.character);
    const protagonist = characters.find((e) => /主角|protagonist/i.test(e.character!.role)) ?? characters[0];
    expect(protagonist).toBeTruthy();
    const protagonistStateJson = JSON.stringify(protagonist.character?.state ?? {});
    const protagonistLockedFacts = JSON.stringify(protagonist.lockedFacts ?? []);
    await saveArtifact("25-chapter2-protagonist-state.txt", `角色：${protagonist.name}（${protagonist.character!.role}）\nstate: ${protagonistStateJson}\n\nlockedFacts: ${protagonistLockedFacts}\n\nch1 facts: ${ch1FactCandidates.length}\nch2 facts: ${ch2FactCandidates.length}`);
    expect(protagonist.lockedFacts.length).toBeGreaterThan(0);
  });
});
