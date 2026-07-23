import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
  callStructuredNovelModel: vi.fn(async () => ({
    data: { summary: "项目定位候选", items: [{ label: "定位", operation: "update", targetTable: "projects", targetId: "ignored", payload: { audience: "青年悬疑读者" }, rationale: "明确受众" }] },
    usage: { inputTokens: 10, outputTokens: 10 },
    promptHash: "test-hash",
  })),
  streamNovelModel: vi.fn(),
}));

import { callStructuredNovelModel } from "../ai";
import { runPlotDesignTask } from "../generation";
import { createNovelProject, novelDb, saveStoryArchitecture } from "../db";
import type { ArchitecturePhase } from "../types";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
  vi.mocked(callStructuredNovelModel).mockClear();
});

async function addArchitecture(projectId: string, phaseCount = 1) {
  const architecture = (await novelDb.architectures.where("projectId").equals(projectId).first())!;
  return saveStoryArchitecture({
    ...architecture,
    framework: "three-act",
    status: "approved",
    centralQuestion: "人物能否找回真相？",
    centralConflict: "记忆与现实冲突",
    synopsis: "人物逐步接近真相。",
    phases: Array.from({ length: phaseCount }, (_, order) => ({ id: `phase-${order}`, title: `第 ${order + 1} 幕`, purpose: `推进阶段 ${order + 1}`, turningPoint: `转折 ${order + 1}`, order, locked: false, primaryCurveId: "main" })),
  });
}

function evidenceReady() {
  return { data: { state: "ready", requests: [], missingFacts: [], creativeGaps: ["局部阻碍可以自由设计"] }, usage: { inputTokens: 3, outputTokens: 3 }, promptHash: "evidence-ready" };
}

/**
 * 全行动章 plot-design 响应——3 章都是高强度行动章，无余波/蓄势，触发节奏 audit 问题。
 */
function plotDesignAllActionResponse(phaseId: string) {
  return {
    data: { summary: "全行动章剧情段", items: [
      { label: "城门激战", operation: "create", targetTable: "outlineNodes", tempId: "segment", payload: { phaseId, title: "城门激战", summary: "主角率队强攻城门，三场连续战斗推进。", order: 99 }, rationale: "承接当前幕" },
      { label: "第一章 破门", operation: "create", targetTable: "documents", tempId: "chapter-1", payload: { plotSegmentId: "ref:segment", order: 99, title: "破门", summary: "主角率队攻打城门，冲突升级。", status: "outline", blueprint: { objective: "攻打城门", characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "守军顽强抵抗", mustHappen: ["城门被攻破"] } }, rationale: "行动章" },
      { label: "第二章 巷战", operation: "create", targetTable: "documents", tempId: "chapter-2", payload: { plotSegmentId: "ref:segment", order: 100, title: "巷战", summary: "主角在城内巷战推进，遭遇伏击。", status: "outline", blueprint: { objective: "清除城内残敌", characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "伏击", mustHappen: ["伏击出现"] } }, rationale: "行动章" },
      { label: "第三章 决战", operation: "create", targetTable: "documents", tempId: "chapter-3", payload: { plotSegmentId: "ref:segment", order: 101, title: "决战", summary: "主角与守将单挑，决定胜负。", status: "outline", blueprint: { objective: "击败守将", characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "单挑", mustHappen: ["守将被击败"] } }, rationale: "行动章" },
    ] },
    usage: { inputTokens: 10, outputTokens: 10 },
    promptHash: "plot-design-all-action",
  };
}

/**
 * 改善后的 plot-design 响应——含余波章，节奏多样。
 */
function plotDesignImprovedResponse(phaseId: string) {
  return {
    data: { summary: "张弛有度剧情段", items: [
      { label: "城门激战", operation: "create", targetTable: "outlineNodes", tempId: "segment", payload: { phaseId, title: "城门激战与余波", summary: "主角攻城、巷战、战后清点与情感余波。", order: 99 }, rationale: "承接当前幕" },
      { label: "第一章 破门", operation: "create", targetTable: "documents", tempId: "chapter-1", payload: { plotSegmentId: "ref:segment", order: 99, title: "破门", summary: "主角率队攻打城门。", status: "outline", blueprint: { objective: "攻打城门", characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "守军顽强抵抗", mustHappen: ["城门被攻破"] } }, rationale: "行动章" },
      { label: "第二章 巷战", operation: "create", targetTable: "documents", tempId: "chapter-2", payload: { plotSegmentId: "ref:segment", order: 100, title: "巷战", summary: "主角在城内巷战。", status: "outline", blueprint: { objective: "清除城内残敌", characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "伏击", mustHappen: ["伏击出现"] } }, rationale: "行动章" },
      { label: "第三章 战后余波", operation: "create", targetTable: "documents", tempId: "chapter-3", payload: { plotSegmentId: "ref:segment", order: 101, title: "战后余波", summary: "主角清点伤亡，与幸存者对话，处理情感余波。", status: "outline", blueprint: { objective: "消化战后情绪与人际关系", characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "幸存者的愧疚与质疑", mustHappen: ["主角面对战友死亡的内心反应"] } }, rationale: "余波章" },
    ] },
    usage: { inputTokens: 10, outputTokens: 10 },
    promptHash: "plot-design-improved",
  };
}

/**
 * 审核报告：节奏单一问题（major）。
 */
function auditMajorResponse() {
  return {
    data: {
      summary: "剧情段三章都是高强度行动章，缺少张弛呼吸。",
      issues: [
        {
          severity: "major" as const,
          dimension: "plot" as const,
          title: "节奏单一：三章都是行动章",
          evidence: "第一章「破门」/第二章「巷战」/第三章「决战」三章主导功能均为行动推进，无余波或蓄势章穿插。",
          evidenceItemId: "plot_0_0_chapter-3",
          evidenceField: "blueprint.objective",
          evidenceQuote: "击败守将",
          suggestion: "将第三章改为余波章，处理战后情绪与人物关系，与第一、二章行动章形成张弛。",
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
      summary: "剧情段节奏张弛有度，因果链清晰，伏笔埋设自然。",
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
      summary: "剧情段仍存在节奏问题。",
      issues: [
        {
          severity: "major" as const,
          dimension: "plot" as const,
          title: "节奏仍偏紧",
          evidence: "虽然加入了余波章，但余波章仍然承担过多推进。",
          evidenceItemId: "plot_0_0_chapter-3",
          evidenceField: "blueprint.objective",
          evidenceQuote: "消化战后情绪与人际关系",
          suggestion: "让余波章更安静，只处理情绪与关系，不推进主线。",
        },
      ],
    },
    usage: { inputTokens: 8, outputTokens: 6 },
    promptHash: "audit-still-major",
  };
}

describe("plot-segment-audit closed loop", () => {
  it("runs audit→iterate→re-audit and records improvement when iteration resolves major issues", async () => {
    const project = await createNovelProject({ title: "审核闭环", genre: ["奇幻"], premise: "测试 plot-segment-audit 接入。" });
    const architecture = await addArchitecture(project.id, 1);
    const phase = architecture.phases[0] as ArchitecturePhase;
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(evidenceReady() as never)
      .mockResolvedValueOnce(plotDesignAllActionResponse(phase.id) as never)
      .mockResolvedValueOnce(auditMajorResponse() as never)
      .mockResolvedValueOnce(plotDesignImprovedResponse(phase.id) as never)
      .mockResolvedValueOnce(auditCleanResponse() as never);

    const { proposal } = await runPlotDesignTask({ projectId: project.id, phaseId: phase.id, audit: { maxIterations: 1 } });

    expect(proposal.auditReport).toBeDefined();
    const report = proposal.auditReport!;
    expect(report.auditSkillId).toBe("plot-segment-audit");
    expect(report.mechanism).toBe("internal-iterate");
    expect(report.rounds).toHaveLength(2);
    expect(report.rounds[0].iteration).toBe(1);
    expect(report.rounds[0].triggeredIteration).toBe(true);
    expect(report.rounds[0].issues).toHaveLength(1);
    expect(report.rounds[0].issues[0].severity).toBe("major");
    expect(report.rounds[1].iteration).toBe(2);
    expect(report.rounds[1].triggeredIteration).toBe(false);
    expect(report.rounds[1].issues).toHaveLength(0);
    expect(report.improved).toBe(true);
    expect(report.remainingMajorCount).toBe(0);

    // 验证 LLM 调用次数：evidence + 初始 plot-design + 第1轮 audit + 迭代 plot-design + 第2轮 audit = 5
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(5);
    // 验证迭代后的 plot-design 调用 prompt 包含审核意见
    const secondPlotDesignCall = vi.mocked(callStructuredNovelModel).mock.calls[3]?.[0];
    expect(secondPlotDesignCall?.prompt).toContain("上一轮 LLM 审核意见");
    expect(secondPlotDesignCall?.prompt).toContain("节奏单一：三章都是行动章");
    // 验证 audit 调用使用 quality-editor 角色 + plot-segment-audit skill
    const auditCall = vi.mocked(callStructuredNovelModel).mock.calls[2]?.[0];
    expect(auditCall?.role).toBe("quality-editor");
    expect(auditCall?.skillPrompt).toContain("剧情段设计审核");
    // 验证最终 proposal 的 items 已替换为迭代后版本（含「战后余波」章）
    expect(proposal.items.map((item) => item.payload.title)).toContain("战后余波");
  });

  it("skips iteration when first audit is clean", async () => {
    const project = await createNovelProject({ title: "审核无问题", genre: ["奇幻"], premise: "审核直接通过。" });
    const architecture = await addArchitecture(project.id, 1);
    const phase = architecture.phases[0] as ArchitecturePhase;
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(evidenceReady() as never)
      .mockResolvedValueOnce(plotDesignImprovedResponse(phase.id) as never)
      .mockResolvedValueOnce(auditCleanResponse() as never);

    const { proposal } = await runPlotDesignTask({ projectId: project.id, phaseId: phase.id, audit: { maxIterations: 1 } });

    expect(proposal.auditReport).toBeDefined();
    const report = proposal.auditReport!;
    expect(report.rounds).toHaveLength(1);
    expect(report.rounds[0].triggeredIteration).toBe(false);
    expect(report.improved).toBe(true);
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(3); // evidence + plot-design + 1 audit
  });

  it("marks improved=false when major issues persist after maxIterations", async () => {
    const project = await createNovelProject({ title: "迭代失败", genre: ["奇幻"], premise: "审核仍报 major。" });
    const architecture = await addArchitecture(project.id, 1);
    const phase = architecture.phases[0] as ArchitecturePhase;
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(evidenceReady() as never)
      .mockResolvedValueOnce(plotDesignAllActionResponse(phase.id) as never)
      .mockResolvedValueOnce(auditMajorResponse() as never)
      .mockResolvedValueOnce(plotDesignImprovedResponse(phase.id) as never)
      .mockResolvedValueOnce(auditStillMajorResponse() as never);

    const { proposal } = await runPlotDesignTask({ projectId: project.id, phaseId: phase.id, audit: { maxIterations: 1 } });

    expect(proposal.auditReport).toBeDefined();
    const report = proposal.auditReport!;
    expect(report.rounds).toHaveLength(2);
    expect(report.improved).toBe(false);
    expect(report.remainingMajorCount).toBe(1);
  });

  it("ignores audit issues whose quoted evidence is absent from the current candidate", async () => {
    const project = await createNovelProject({ title: "证据核验", genre: ["奇幻"], premise: "审核只能引用当前候选。" });
    const architecture = await addArchitecture(project.id, 1);
    const phase = architecture.phases[0] as ArchitecturePhase;
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(evidenceReady() as never)
      .mockResolvedValueOnce(plotDesignImprovedResponse(phase.id) as never)
      .mockResolvedValueOnce({
        data: {
          summary: "引用了旧版本字段。",
          issues: [{
            severity: "major",
            dimension: "plot",
            title: "旧文本仍存在",
            evidence: "声称第三章仍要求决战。",
            evidenceItemId: "plot_0_0_chapter-3",
            evidenceField: "blueprint.objective",
            evidenceQuote: "击败守将",
            suggestion: "删除旧要求。",
          }],
        },
        usage: { inputTokens: 8, outputTokens: 6 },
        promptHash: "audit-ungrounded",
      } as never);

    const { proposal } = await runPlotDesignTask({ projectId: project.id, phaseId: phase.id, audit: { maxIterations: 1 } });

    expect(proposal.auditReport?.rounds[0].issues).toEqual([]);
    expect(proposal.auditReport?.rounds[0].summary).toContain("已忽略 1 条");
    expect(proposal.auditReport?.improved).toBe(true);
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(3);
  });

  it("skips audit entirely when audit param is not provided (backward compatibility)", async () => {
    const project = await createNovelProject({ title: "不启用审核", genre: ["奇幻"], premise: "向后兼容。" });
    const architecture = await addArchitecture(project.id, 1);
    const phase = architecture.phases[0] as ArchitecturePhase;
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(evidenceReady() as never)
      .mockResolvedValueOnce(plotDesignAllActionResponse(phase.id) as never);

    const { proposal } = await runPlotDesignTask({ projectId: project.id, phaseId: phase.id });

    expect(proposal.auditReport).toBeUndefined();
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(2); // evidence + plot-design only
  });

  it("does not iterate when maxIterations is 0", async () => {
    const project = await createNovelProject({ title: "零迭代", genre: ["奇幻"], premise: "审核但不迭代。" });
    const architecture = await addArchitecture(project.id, 1);
    const phase = architecture.phases[0] as ArchitecturePhase;
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(evidenceReady() as never)
      .mockResolvedValueOnce(plotDesignAllActionResponse(phase.id) as never)
      .mockResolvedValueOnce(auditMajorResponse() as never);

    const { proposal } = await runPlotDesignTask({ projectId: project.id, phaseId: phase.id, audit: { maxIterations: 0 } });

    // maxIterations=0 时 auditEnabled=true 但 maxAuditIterations=0，跳过循环
    expect(proposal.auditReport).toBeUndefined();
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(2);
  });
});
