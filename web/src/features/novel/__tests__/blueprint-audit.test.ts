import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
  callStructuredNovelModel: vi.fn(async () => ({
    data: { title: "默认章节", objective: "默认目标", startingState: "默认起点", beats: [{ action: "默认行动", emotion: "默认情绪", outcome: "默认结果" }, { action: "默认行动二", emotion: "默认情绪二", outcome: "默认结果二" }], endingHook: "默认钩子", characters: [], locations: [], informationRelease: [], mustHappen: [], flexible: [], forbidden: [] },
    usage: { inputTokens: 10, outputTokens: 10 },
    promptHash: "test-hash",
  })),
  streamNovelModel: vi.fn(),
}));

import { callStructuredNovelModel } from "../ai";
import { createChapter, createNovelProject, novelDb, recordBase } from "../db";
import { advanceChapterWorkflow } from "../workflow";
import { blueprintStageHandler, getBlueprintAuditMaxIterations } from "../workflow-stages/blueprint-stage";
import type { CreativeBrief, NovelContextPacket, WorkflowRun } from "../types";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
  vi.mocked(callStructuredNovelModel).mockClear();
  // 默认关闭 audit，需要 audit 的测试用例显式开启
  // 这样可以避免污染其他默认行为测试
  vi.stubEnv("NOVEL_BLUEPRINT_AUDIT_MAX_ITER", "0");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function packet(projectId: string): NovelContextPacket {
  return { ...recordBase(projectId), task: "chapter-draft", instruction: "继续写作", sources: [], estimatedTokens: 0, omittedSourceIds: [], skillRefs: [], compiledAt: Date.now() };
}

function brief(projectId: string, documentId: string, overrides: Partial<CreativeBrief> = {}): CreativeBrief {
  return {
    ...recordBase(projectId),
    threadId: `thread-${documentId}`,
    targetDocumentId: documentId,
    status: "confirmed",
    goal: "测试章节蓝图审核闭环",
    tone: "克制",
    languageRequirements: [],
    mustHappen: [],
    forbidden: [],
    targetWords: 3000,
    referencedMemoryIds: [],
    openQuestions: [],
    sourceMessageIds: [],
    confirmedAt: Date.now(),
    ...overrides,
  };
}

function buildRun(projectId: string, documentId: string, contextPacketId: string, creativeBriefId: string): WorkflowRun {
  return {
    ...recordBase(projectId),
    workflowId: "standard-chapter-v2",
    targetDocumentId: documentId,
    status: "running",
    currentStage: "blueprint",
    stageIndex: 1,
    revisionIteration: 0,
    contextPacketId,
    creativeBriefId,
    factCandidateIds: [],
    startedAt: Date.now(),
  };
}

/**
 * 含 POV 越界的 bad blueprint——mustHappen 中"沈知微意识到..."替非 POV 角色下结论，
 * endingHook 停在封闭画面（无未解信息）。触发 audit major。
 */
function badBlueprintResponse() {
  return {
    data: {
      title: "初雪夜",
      objective: "建立故事背景与日常秩序",
      startingState: "东宫外廊，初雪夜。",
      beats: [
        { action: "萧彻在东宫外廊踱步", emotion: "压抑", outcome: "听到内侍低语太子未起" },
        { action: "沈知微呈上旧档", emotion: "戒备", outcome: "档被魏承恩拦下" },
        { action: "萧彻回到屋内独坐", emotion: "孤寂", outcome: "灯花爆了一下" },
      ],
      endingHook: "萧彻坐在灯下，听了一夜的雪。",
      characters: [],
      locations: [],
      informationRelease: [],
      mustHappen: ["萧彻在东宫外廊听到内侍低语太子未起", "沈知微意识到旧档中存在矛盾", "魏承恩拦下旧档"],
      flexible: [],
      forbidden: [],
    },
    usage: { inputTokens: 12, outputTokens: 14 },
    promptHash: "bad-blueprint",
  };
}

/**
 * 改善后的 blueprint——POV 一致性 + endingHook 携带未解信息。
 */
function improvedBlueprintResponse() {
  return {
    data: {
      title: "初雪夜",
      objective: "建立故事背景与日常秩序",
      startingState: "东宫外廊，初雪夜。",
      beats: [
        { action: "萧彻在东宫外廊踱步", emotion: "压抑", outcome: "听到内侍低语太子未起" },
        { action: "沈知微呈上旧档", emotion: "戒备", outcome: "档被魏承恩拦下，沈知微指尖轻颤" },
        { action: "萧彻回到屋内独坐", emotion: "孤寂", outcome: "听到楼下哼出自己从未教过的半阕歌" },
      ],
      endingHook: "萧彻坐在灯下。楼下又哼起了那半阕歌——他从未教过任何人。",
      characters: [],
      locations: [],
      informationRelease: [],
      mustHappen: ["萧彻在东宫外廊听到内侍低语太子未起", "沈知微呈上的旧档被魏承恩拦下", "萧彻听到楼下哼出自己从未教过的半阕歌"],
      flexible: [],
      forbidden: [],
    },
    usage: { inputTokens: 12, outputTokens: 14 },
    promptHash: "improved-blueprint",
  };
}

/**
 * 审核报告：POV 越界 + endingHook 封闭画面（major）。
 */
function auditMajorResponse() {
  return {
    data: {
      summary: "POV 越界且章尾封闭，需修订。",
      issues: [
        {
          severity: "major" as const,
          dimension: "continuity" as const,
          title: "POV 越界：mustHappen 替非 POV 角色下内心结论",
          evidence: "mustHappen 中「沈知微意识到旧档中存在矛盾」——本章 POV 为萧彻，沈知微的内心活动萧彻无法直接观察。",
          suggestion: "改写为 POV 可观察的外部行为，如「沈知微呈上旧档时指尖轻颤了一下」。",
        },
        {
          severity: "major" as const,
          dimension: "hookPayoff" as const,
          title: "章尾驱动力封闭：停在情感余韵的封闭画面",
          evidence: "endingHook「萧彻坐在灯下，听了一夜的雪」——读者无须翻下一章，无未解信息或新压力。",
          suggestion: "改写章尾，加入未解信息或新压力（如听到楼下哼出从未教过的半阕歌，留下「她从哪里听来」的开放问题）。",
        },
      ],
    },
    usage: { inputTokens: 8, outputTokens: 6 },
    promptHash: "audit-major",
  };
}

/**
 * 审核报告：无 major 问题（通过）。
 */
function auditCleanResponse() {
  return {
    data: {
      summary: "POV 一致性合规，章尾开放，节拍因果连续。",
      issues: [],
    },
    usage: { inputTokens: 8, outputTokens: 4 },
    promptHash: "audit-clean",
  };
}

/**
 * 审核报告：仍有 major 问题（迭代失败）。
 */
function auditStillMajorResponse() {
  return {
    data: {
      summary: "POV 已修正，但章尾仍封闭。",
      issues: [
        {
          severity: "major" as const,
          dimension: "hookPayoff" as const,
          title: "章尾驱动力仍封闭",
          evidence: "endingHook「萧彻坐在灯下，灯花爆了一下」仍是封闭画面。",
          suggestion: "加入未解信息或新压力。",
        },
      ],
    },
    usage: { inputTokens: 8, outputTokens: 6 },
    promptHash: "audit-still-major",
  };
}

describe("getBlueprintAuditMaxIterations", () => {
  it("returns 1 by default when env var is unset", () => {
    vi.unstubAllEnvs();
    expect(getBlueprintAuditMaxIterations()).toBe(1);
  });

  it("returns 0 when env var is '0'", () => {
    vi.stubEnv("NOVEL_BLUEPRINT_AUDIT_MAX_ITER", "0");
    expect(getBlueprintAuditMaxIterations()).toBe(0);
  });

  it("caps at 3 when env var exceeds 3", () => {
    vi.stubEnv("NOVEL_BLUEPRINT_AUDIT_MAX_ITER", "5");
    expect(getBlueprintAuditMaxIterations()).toBe(3);
  });

  it("falls back to 1 when env var is invalid", () => {
    vi.stubEnv("NOVEL_BLUEPRINT_AUDIT_MAX_ITER", "abc");
    expect(getBlueprintAuditMaxIterations()).toBe(1);
  });
});

describe("blueprint-audit closed loop", () => {
  it("runs audit→iterate→re-audit and records improvement when iteration resolves major issues", async () => {
    // 启用 audit，maxIterations=1
    vi.stubEnv("NOVEL_BLUEPRINT_AUDIT_MAX_ITER", "1");

    const project = await createNovelProject({ title: "蓝图审核闭环", genre: ["古风权谋"], premise: "测试 blueprint-audit 接入。" });
    const document = await createChapter(project.id, "第一章");
    const ctx = packet(project.id);
    const brf = brief(project.id, document.id);
    const run = buildRun(project.id, document.id, ctx.id, brf.id);
    await novelDb.contextPackets.add(ctx);
    await novelDb.creativeBriefs.add(brf);
    await novelDb.workflowRuns.add(run);

    // Mock LLM 调用序列：bad blueprint → audit major → improved blueprint → audit clean
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(badBlueprintResponse() as never)
      .mockResolvedValueOnce(auditMajorResponse() as never)
      .mockResolvedValueOnce(improvedBlueprintResponse() as never)
      .mockResolvedValueOnce(auditCleanResponse() as never);

    await advanceChapterWorkflow(run.id);

    // 验证 LLM 调用次数：初始 blueprint + 第1轮 audit + 迭代 blueprint + 第2轮 audit = 4
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(4);

    // 验证 audit 调用使用 quality-editor 角色 + blueprint-audit skill
    const auditCall = vi.mocked(callStructuredNovelModel).mock.calls[1]?.[0];
    expect(auditCall?.role).toBe("quality-editor");
    expect(auditCall?.skillPrompt).toContain("章节蓝图审核");

    // 验证迭代后的 blueprint 调用 prompt 包含审核意见
    const secondBlueprintCall = vi.mocked(callStructuredNovelModel).mock.calls[2]?.[0];
    expect(secondBlueprintCall?.prompt).toContain("上一轮 LLM 审核意见");
    expect(secondBlueprintCall?.prompt).toContain("POV 越界");

    // 验证 blueprint artifact 中写入 auditReport
    const blueprintArtifact = await novelDb.workflowArtifacts
      .where("workflowRunId").equals(run.id)
      .and((item) => item.stage === "blueprint" && item.kind === "blueprint")
      .first();
    expect(blueprintArtifact).toBeDefined();
    const structuredData = blueprintArtifact!.structuredData as Record<string, unknown>;
    expect(structuredData.auditReport).toBeDefined();
    const report = structuredData.auditReport as { auditSkillId: string; mechanism: string; rounds: Array<{ iteration: number; triggeredIteration: boolean; issues: unknown[] }>; improved: boolean; remainingMajorCount: number };
    expect(report.auditSkillId).toBe("blueprint-audit");
    expect(report.mechanism).toBe("internal-iterate");
    expect(report.rounds).toHaveLength(2);
    expect(report.rounds[0].iteration).toBe(1);
    expect(report.rounds[0].triggeredIteration).toBe(true);
    expect(report.rounds[0].issues).toHaveLength(2);
    expect(report.rounds[1].iteration).toBe(2);
    expect(report.rounds[1].triggeredIteration).toBe(false);
    expect(report.rounds[1].issues).toHaveLength(0);
    expect(report.improved).toBe(true);
    expect(report.remainingMajorCount).toBe(0);

    // 验证迭代后的 blueprint 内容已替换（含「半阕歌」开放钩子）
    expect(structuredData.endingHook).toContain("半阕歌");
    expect(structuredData.mustHappen).toEqual(expect.arrayContaining([
      "萧彻在东宫外廊听到内侍低语太子未起",
      "萧彻听到楼下哼出自己从未教过的半阕歌",
    ]));

    // 验证 workflow 已转入 blueprint-approval
    const finalRun = await novelDb.workflowRuns.get(run.id);
    expect(finalRun?.currentStage).toBe("blueprint-approval");
    expect(finalRun?.status).toBe("waiting-approval");
  });

  it("skips iteration when first audit is clean", async () => {
    vi.stubEnv("NOVEL_BLUEPRINT_AUDIT_MAX_ITER", "1");

    const project = await createNovelProject({ title: "审核无问题", genre: ["古风权谋"], premise: "审核直接通过。" });
    const document = await createChapter(project.id, "第一章");
    const ctx = packet(project.id);
    const brf = brief(project.id, document.id);
    const run = buildRun(project.id, document.id, ctx.id, brf.id);
    await novelDb.contextPackets.add(ctx);
    await novelDb.creativeBriefs.add(brf);
    await novelDb.workflowRuns.add(run);

    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(improvedBlueprintResponse() as never)
      .mockResolvedValueOnce(auditCleanResponse() as never);

    await advanceChapterWorkflow(run.id);

    // 只有初始 blueprint + 1 轮 audit
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(2);
    const blueprintArtifact = await novelDb.workflowArtifacts
      .where("workflowRunId").equals(run.id)
      .and((item) => item.stage === "blueprint" && item.kind === "blueprint")
      .first();
    const structuredData = blueprintArtifact!.structuredData as Record<string, unknown>;
    const report = structuredData.auditReport as { rounds: unknown[]; improved: boolean; remainingMajorCount: number };
    expect(report.rounds).toHaveLength(1);
    expect(report.improved).toBe(true);
    expect(report.remainingMajorCount).toBe(0);
  });

  it("marks improved=false when major issues persist after maxIterations", async () => {
    vi.stubEnv("NOVEL_BLUEPRINT_AUDIT_MAX_ITER", "1");

    const project = await createNovelProject({ title: "迭代失败", genre: ["古风权谋"], premise: "审核仍报 major。" });
    const document = await createChapter(project.id, "第一章");
    const ctx = packet(project.id);
    const brf = brief(project.id, document.id);
    const run = buildRun(project.id, document.id, ctx.id, brf.id);
    await novelDb.contextPackets.add(ctx);
    await novelDb.creativeBriefs.add(brf);
    await novelDb.workflowRuns.add(run);

    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(badBlueprintResponse() as never)
      .mockResolvedValueOnce(auditMajorResponse() as never)
      .mockResolvedValueOnce(improvedBlueprintResponse() as never)
      .mockResolvedValueOnce(auditStillMajorResponse() as never);

    await advanceChapterWorkflow(run.id);

    expect(callStructuredNovelModel).toHaveBeenCalledTimes(4);
    const blueprintArtifact = await novelDb.workflowArtifacts
      .where("workflowRunId").equals(run.id)
      .and((item) => item.stage === "blueprint" && item.kind === "blueprint")
      .first();
    const structuredData = blueprintArtifact!.structuredData as Record<string, unknown>;
    const report = structuredData.auditReport as { rounds: unknown[]; improved: boolean; remainingMajorCount: number };
    expect(report.rounds).toHaveLength(2);
    expect(report.improved).toBe(false);
    expect(report.remainingMajorCount).toBe(1);
  });

  it("skips audit entirely when NOVEL_BLUEPRINT_AUDIT_MAX_ITER=0 (backward compatibility)", async () => {
    // 环境变量已在 beforeEach 设置为 "0"
    const project = await createNovelProject({ title: "不启用审核", genre: ["古风权谋"], premise: "向后兼容。" });
    const document = await createChapter(project.id, "第一章");
    const ctx = packet(project.id);
    const brf = brief(project.id, document.id);
    const run = buildRun(project.id, document.id, ctx.id, brf.id);
    await novelDb.contextPackets.add(ctx);
    await novelDb.creativeBriefs.add(brf);
    await novelDb.workflowRuns.add(run);

    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(badBlueprintResponse() as never);

    await advanceChapterWorkflow(run.id);

    // 只调用初始 blueprint，无 audit
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(1);
    const blueprintArtifact = await novelDb.workflowArtifacts
      .where("workflowRunId").equals(run.id)
      .and((item) => item.stage === "blueprint" && item.kind === "blueprint")
      .first();
    const structuredData = blueprintArtifact!.structuredData as Record<string, unknown>;
    // auditReport 应为 undefined（向后兼容场景不写）
    expect(structuredData.auditReport).toBeUndefined();
  });

  it("keeps a valid blueprint when the optional audit call fails", async () => {
    vi.stubEnv("NOVEL_BLUEPRINT_AUDIT_MAX_ITER", "1");
    const project = await createNovelProject({ title: "审核降级", genre: ["悬疑"], premise: "审核服务偶发不可用。" });
    const document = await createChapter(project.id, "第一章");
    const ctx = packet(project.id);
    const brf = brief(project.id, document.id);
    const run = buildRun(project.id, document.id, ctx.id, brf.id);
    await novelDb.contextPackets.add(ctx);
    await novelDb.creativeBriefs.add(brf);
    await novelDb.workflowRuns.add(run);

    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(improvedBlueprintResponse() as never)
      .mockRejectedValueOnce(new Error("audit provider unavailable"));

    const advanced = await advanceChapterWorkflow(run.id);

    expect(advanced.status).toBe("waiting-approval");
    expect(advanced.currentStage).toBe("blueprint-approval");
    const artifact = await novelDb.workflowArtifacts.get(advanced.blueprintArtifactId!);
    const report = artifact?.structuredData?.auditReport as { error?: string; rounds: unknown[] };
    expect(report.error).toContain("audit provider unavailable");
    expect(report.rounds).toEqual([]);
  });

  it("iterates twice when NOVEL_BLUEPRINT_AUDIT_MAX_ITER=2 and first iteration still has major", async () => {
    vi.stubEnv("NOVEL_BLUEPRINT_AUDIT_MAX_ITER", "2");

    const project = await createNovelProject({ title: "二次迭代", genre: ["古风权谋"], premise: "maxIterations=2 时第一次迭代仍 major，第二次迭代 clean。" });
    const document = await createChapter(project.id, "第一章");
    const ctx = packet(project.id);
    const brf = brief(project.id, document.id);
    const run = buildRun(project.id, document.id, ctx.id, brf.id);
    await novelDb.contextPackets.add(ctx);
    await novelDb.creativeBriefs.add(brf);
    await novelDb.workflowRuns.add(run);

    // Mock：bad → major → improved(仍 major) → stillMajor → improved(clean) → clean
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(badBlueprintResponse() as never)
      .mockResolvedValueOnce(auditMajorResponse() as never)
      .mockResolvedValueOnce(improvedBlueprintResponse() as never)
      .mockResolvedValueOnce(auditStillMajorResponse() as never)
      .mockResolvedValueOnce(improvedBlueprintResponse() as never)
      .mockResolvedValueOnce(auditCleanResponse() as never);

    await advanceChapterWorkflow(run.id);

    // 初始 blueprint + 3 轮 audit + 2 次迭代 = 6
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(6);
    const blueprintArtifact = await novelDb.workflowArtifacts
      .where("workflowRunId").equals(run.id)
      .and((item) => item.stage === "blueprint" && item.kind === "blueprint")
      .first();
    const structuredData = blueprintArtifact!.structuredData as Record<string, unknown>;
    const report = structuredData.auditReport as { rounds: Array<{ iteration: number; issues: unknown[] }>; improved: boolean; remainingMajorCount: number };
    expect(report.rounds).toHaveLength(3);
    expect(report.improved).toBe(true);
    expect(report.remainingMajorCount).toBe(0);
  });
});

describe("blueprintStageHandler export", () => {
  it("exports blueprintStageHandler with stage='blueprint'", () => {
    expect(blueprintStageHandler.stage).toBe("blueprint");
    expect(typeof blueprintStageHandler.execute).toBe("function");
  });
});
