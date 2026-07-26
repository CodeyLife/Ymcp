import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
  callStructuredNovelModel: vi.fn(async () => ({
    data: { summary: "项目定位候选", items: [{ label: "定位", operation: "update", targetTable: "projects", targetId: "ignored", payload: { audience: "青年悬疑读者" }, rationale: "明确受众" }] },
    usage: { inputTokens: 10, outputTokens: 10 },
    promptHash: "test-hash",
  })),
  streamNovelModel: vi.fn(),
}));

import { callStructuredNovelModel, streamNovelModel } from "../ai";
import { applyProposalItems, getGenerationTask, runGenerationTask, runPlotDesignTask, tasksForScope, updateProposalItemPayload, validatePlotDesignItems, validateArchitectureHardConstraints, splitInstruction, MAX_INSTRUCTION_CHARS } from "../generation";
import { addOutlineNode, createChapter, createNovelProject, deleteChapter, deleteOutlineBranch, deletePlotThread, novelDb, recordBase, saveApprovedDocumentRevision, saveStoryArchitecture } from "../db";
import { createChapterMemory, linkOutlineRealization } from "../memory";
import type { AIProposal, ProposalItem, StoryScene } from "../types";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
  vi.mocked(callStructuredNovelModel).mockClear();
  vi.mocked(streamNovelModel).mockReset();
});

function proposal(projectId: string, items: AIProposal["items"]): AIProposal {
  return { ...recordBase(projectId), title: "测试候选", operation: "structured:characters", taskKey: "characters", scope: "characters", status: "pending", previewMarkdown: "# 测试", patches: [], items, contextPacketId: "context", model: "test" };
}

async function addArchitecture(projectId: string, phaseCount = 2) {
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

function plotDesignResponse(phaseId: string) {
  return {
    data: { summary: "新的剧情段与章节", items: [
      { label: "城门下的选择", operation: "create", targetTable: "outlineNodes", tempId: "segment", payload: { phaseId, title: "城门下的选择", summary: "主角来到陌生城门，正常入城受阻，最终决定利用规则漏洞进入城市，并为后续追查留下风险。", order: 99 }, rationale: "承接当前幕" },
      { label: "第一章 城门", operation: "create", targetTable: "documents", tempId: "chapter-1", payload: { plotSegmentId: "ref:segment", order: 99, title: "城门", summary: "主角递交文书却被拒绝。", status: "outline", blueprint: { objective: "尝试入城", characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "身份文书失效", mustHappen: ["入城受阻"] } }, rationale: "建立阻碍" },
      { label: "第二章 漏洞", operation: "create", targetTable: "documents", tempId: "chapter-2", payload: { plotSegmentId: "ref:segment", order: 100, title: "漏洞", summary: "主角发现商队漏洞并决定冒险。", status: "outline", blueprint: { objective: "寻找替代路径", characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "利用漏洞会付出代价", mustHappen: ["决定冒险"] } }, rationale: "改变局面" },
    ] },
    usage: { inputTokens: 10, outputTokens: 10 },
    promptHash: "plot-design",
  };
}

describe("phase plot design", () => {
  it("generates one plot segment and two to four formal chapters for the selected phase", async () => {
    const project = await createNovelProject({ title: "逐段规划", genre: ["悬疑"], premise: "每次只向前推进一小段。" });
    const architecture = await addArchitecture(project.id, 1);
    const phase = architecture.phases[0];
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(evidenceReady() as never)
      .mockResolvedValueOnce(plotDesignResponse(phase.id) as never);

    const { proposal: generated } = await runPlotDesignTask({ projectId: project.id, phaseId: phase.id, instruction: "让主角第一次碰到这里的规则" });

    expect(generated).toMatchObject({ taskKey: "plot-design", targetId: phase.id, outlineGenerationMode: "plot-segment-append", architecturePhaseId: phase.id });
    expect(generated.items.filter((item) => item.targetTable === "outlineNodes")).toHaveLength(1);
    expect(generated.items.filter((item) => item.targetTable === "documents")).toHaveLength(2);
    expect(generated.items.find((item) => item.targetTable === "outlineNodes")?.payload).toMatchObject({ phaseId: phase.id, order: 0 });
    expect(generated.items.filter((item) => item.targetTable === "documents").map((item) => item.payload.order)).toEqual([0, 1]);
    const modelRequest = vi.mocked(callStructuredNovelModel).mock.calls.at(-1)?.[0];
    expect(modelRequest?.prompt).toContain("不得把后续节点提前压入当前章节");
    expect(modelRequest?.prompt).not.toContain("每章至少埋一个");
    expect(modelRequest?.skillPrompt).toContain("大纲用于分配跨章节材料");

    await expect(applyProposalItems(generated.id, [generated.items[0].id])).rejects.toThrow(/整体采纳/);
    await applyProposalItems(generated.id, generated.items.map((item) => item.id));

    const segment = await novelDb.outlineNodes.where("projectId").equals(project.id).first();
    const chapters = await novelDb.documents.where("projectId").equals(project.id).sortBy("order");
    expect(segment).toMatchObject({ phaseId: phase.id, title: "城门下的选择" });
    expect(chapters).toHaveLength(2);
    expect(chapters.map((chapter) => chapter.plotSegmentId)).toEqual([segment?.id, segment?.id]);
    expect(chapters.map((chapter) => chapter.title)).toEqual(["城门", "漏洞"]);
    expect(chapters.every((chapter) => chapter.blueprint.targetWords === 5000)).toBe(true);
  });

  it("rejects generation for a phase that is not in the architecture", async () => {
    const project = await createNovelProject({ title: "无效幕", genre: ["悬疑"], premise: "幕是唯一来源。" });
    await addArchitecture(project.id, 1);
    await expect(runPlotDesignTask({ projectId: project.id, phaseId: "missing" })).rejects.toThrow(/目标幕不存在/);
    expect(callStructuredNovelModel).not.toHaveBeenCalled();
  });

  it("does not reuse a pending plot-design proposal from another phase", async () => {
    const project = await createNovelProject({ title: "分幕候选", genre: ["历史"], premise: "每一幕拥有独立剧情段。" });
    const architecture = await addArchitecture(project.id, 2);
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(evidenceReady() as never)
      .mockResolvedValueOnce(plotDesignResponse(architecture.phases[0].id) as never)
      .mockResolvedValueOnce(evidenceReady() as never)
      .mockResolvedValueOnce(plotDesignResponse(architecture.phases[1].id) as never);

    const first = await runPlotDesignTask({ projectId: project.id, phaseId: architecture.phases[0].id });
    const second = await runPlotDesignTask({ projectId: project.id, phaseId: architecture.phases[1].id });

    expect(second.proposal.id).not.toBe(first.proposal.id);
    expect(first.proposal.architecturePhaseId).toBe(architecture.phases[0].id);
    expect(second.proposal.architecturePhaseId).toBe(architecture.phases[1].id);
  });

  it("does not reuse a pending plot-design proposal when the same phase is regenerated", async () => {
    const project = await createNovelProject({ title: "同幕复审", genre: ["历史"], premise: "复审必须产生可比较的新候选。" });
    const architecture = await addArchitecture(project.id, 1);
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(evidenceReady() as never)
      .mockResolvedValueOnce(plotDesignResponse(architecture.phases[0].id) as never)
      .mockResolvedValueOnce(evidenceReady() as never)
      .mockResolvedValueOnce(plotDesignResponse(architecture.phases[0].id) as never);

    const first = await runPlotDesignTask({ projectId: project.id, phaseId: architecture.phases[0].id });
    const second = await runPlotDesignTask({ projectId: project.id, phaseId: architecture.phases[0].id });

    expect(second.proposal.id).not.toBe(first.proposal.id);
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(4);
  });

  it("validates exactly one segment and a capacity-driven number of chapters", () => {
    const segment: ProposalItem = { id: "segment", tempId: "segment", label: "段", operation: "create", targetTable: "outlineNodes", status: "pending", payload: { phaseId: "phase", title: "段", summary: "概要", order: 0 }, rationale: "", dependencies: [] };
    const chapter = (id: string, order: number): ProposalItem => ({ id, tempId: id, label: id, operation: "create", targetTable: "documents", status: "pending", payload: { plotSegmentId: "ref:segment", title: id, summary: "摘要", order, blueprint: {} }, rationale: "", dependencies: [] });
    expect(() => validatePlotDesignItems([segment], "phase", 0, 0)).toThrow(/至少需要创建 1 个章节/);
    expect(() => validatePlotDesignItems([segment, chapter("one", 0)], "phase", 0, 0)).not.toThrow();
    expect(() => validatePlotDesignItems([segment, ...Array.from({ length: 6 }, (_, index) => chapter(`chapter-${index}`, index))], "phase", 0, 0)).not.toThrow();
  });

  it("drops an unresolved POV when plot design runs before character setup", async () => {
    const project = await createNovelProject({ title: "先规划后建人物", genre: ["历史"], premise: "从一座水乡开始。" });
    const architecture = await addArchitecture(project.id, 1);
    const phase = architecture.phases[0];
    const response = plotDesignResponse(phase.id);
    const chapter = (response.data.items as Array<{ targetTable: string; payload: Record<string, unknown> }>).find((item) => item.targetTable === "documents")!;
    chapter.payload.blueprint = { ...(chapter.payload.blueprint as Record<string, unknown>), povCharacterId: "" };
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(evidenceReady() as never)
      .mockResolvedValueOnce(response as never);

    const { proposal: generated } = await runPlotDesignTask({ projectId: project.id, phaseId: phase.id });

    const blueprint = generated.items.find((item) => item.targetTable === "documents")?.payload.blueprint as Record<string, unknown>;
    expect(blueprint.povCharacterId).toBeUndefined();
    expect(vi.mocked(callStructuredNovelModel).mock.calls.at(-1)?.[0].skillPrompt).toContain("当前没有角色时必须省略该字段");
  });
});

describe("generation task ownership", () => {
  it("exposes only the new planning task for plot design", () => {
    expect(getGenerationTask("plot-design")).toMatchObject({ allowedTables: ["outlineNodes", "documents"] });
    expect(tasksForScope("outline")).toEqual([]);
    expect(tasksForScope("chapters").map((task) => task.key)).toEqual(["chapter-plan"]);
  });

  it("keeps story-control updates from replacing richer narrative fields", () => {
    const instruction = getGenerationTask("story-control").defaultInstruction;
    expect(instruction).toContain("保留性更新合同");
    expect(instruction).toContain("不得用较短的控制说明覆盖");
    expect(instruction).toContain("系统会把正式原 notes 确定性地置于前面");
  });

  it("deterministically prepends existing notes to a story-control mapping", async () => {
    const project = await createNovelProject({ title: "控制资料", genre: ["悬疑"], premise: "线索需要跨阶段回收。" });
    const clue = {
      ...recordBase(project.id),
      title: "旧票根",
      clue: "账本里夹着一张褪色票根。",
      truth: "票根记录了被删除的运输线路。",
      status: "seeded" as const,
      urgency: 30,
      notes: "中期误导解释：票根属于普通旅客。提醒方式：守门人随口提到旧线路。",
    };
    await novelDb.foreshadowing.add(clue);
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "补充映射", items: [{
        label: "更新票根控制映射",
        operation: "update",
        targetTable: "foreshadowing",
        targetId: clue.id,
        payload: { notes: "控制映射：关联时间线事件ID=event-1" },
        rationale: "补充回收位置",
      }] },
      usage: { inputTokens: 1, outputTokens: 1 },
      promptHash: "destructive-story-control",
    } as never);

    const result = await runGenerationTask({ projectId: project.id, taskKey: "story-control", instruction: "校验控制资料" });

    expect(result.proposal.items[0].payload.notes).toBe(`${clue.notes}\n控制映射：关联时间线事件ID=event-1`);
  });

  it("keeps document structure system-owned when planning an existing chapter", async () => {
    const project = await createNovelProject({ title: "章节归属", genre: ["武侠"], premise: "章节规划不能移动正式章节。" });
    const architecture = await addArchitecture(project.id, 1);
    const segment = await addOutlineNode(project.id, architecture.phases[0].id, "入城", 0);
    const chapter = await createChapter(project.id, "醒来", segment.id);
    await novelDb.documents.update(chapter.id, { order: 3, status: "outline", blueprint: { ...chapter.blueprint, targetWords: 2400 } });
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "细化第一章", items: [{
        label: "醒来",
        operation: "update",
        targetTable: "documents",
        targetId: chapter.id,
        payload: { order: 99, plotSegmentId: "ref:invented", status: "draft", summary: "建立陌生世界常态。", blueprint: { objective: "辨认处境" } },
        rationale: "细化章节",
      }] },
      usage: { inputTokens: 1, outputTokens: 1 },
      promptHash: "chapter-plan-structure",
    } as never);

    const { proposal: generated } = await runGenerationTask({ projectId: project.id, taskKey: "chapter-plan", instruction: "规划第一章", targetId: chapter.id });
    const payload = generated.items[0].payload;

    expect(payload).toMatchObject({ order: 3, plotSegmentId: segment.id, status: "outline" });
    expect(payload.blueprint).toMatchObject({ objective: "辨认处境", targetWords: 5000 });
    expect(generated.items[0].after).toEqual(payload);
    expect(vi.mocked(callStructuredNovelModel).mock.calls.at(-1)?.[0].prompt).toContain("不能借章节规划移动章节");

    await applyProposalItems(generated.id, [generated.items[0].id]);
    expect(await novelDb.documents.get(chapter.id)).toMatchObject({ order: 3, plotSegmentId: segment.id, status: "outline", blueprint: { targetWords: 5000 } });
  });

  it("compiles and repairs chapter-draft plainText before creating a proposal", async () => {
    const project = await createNovelProject({ title: "正文生成", genre: ["悬疑"], premise: "正文必须使用常规段落。" });
    const chapter = await createChapter(project.id, "第一章");
    const invalid = ["以下是正文：", "风停了。", "他抬起头。", "远处有人走来。", "脚步越来越近。"].join("\n\n");
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({ data: { summary: "正文", items: [{ label: "第一章正文", operation: "update", targetTable: "documents", targetId: chapter.id, payload: { plainText: invalid }, rationale: "生成正文" }] }, usage: { inputTokens: 10, outputTokens: 10 }, promptHash: "chapter-draft" });

    const { proposal: generated } = await runGenerationTask({ projectId: project.id, taskKey: "chapter-draft", instruction: "生成第一章正文", targetId: chapter.id });

    expect(streamNovelModel).not.toHaveBeenCalled();
    expect(generated.items[0].payload.plainText).toBe("风停了。\n\n他抬起头。\n\n远处有人走来。\n\n脚步越来越近。");
  });

  it("generates, edits, and accepts project positioning", async () => {
    const project = await createNovelProject({ title: "定位测试", genre: ["悬疑"], premise: "每个人都会遗忘一个名字。" });
    const { proposal: generated } = await runGenerationTask({ projectId: project.id, taskKey: "project-positioning", instruction: "完善项目定位" });
    expect(vi.mocked(callStructuredNovelModel).mock.calls.at(-1)?.[0].prompt).toContain("当前正式项目名为《定位测试》");
    await novelDb.proposals.update(generated.id, { auditReport: { auditSkillId: "test-audit", mechanism: "internal-iterate", rounds: [], improved: true, remainingMajorCount: 0 } });
    await updateProposalItemPayload(generated.id, generated.items[0].id, { audience: "成年悬疑读者" });
    expect((await novelDb.proposals.get(generated.id))?.auditReport).toBeUndefined();
    await applyProposalItems(generated.id, [generated.items[0].id]);
    expect((await novelDb.projects.get(project.id))?.audience).toBe("成年悬疑读者");
  });

  it("rejects a multi-million-word structure result that remains incomplete after all retries", async () => {
    const project = await createNovelProject({ title: "群像约束", genre: ["历史"], premise: "多方势力争夺一座港口。" });
    await novelDb.projects.update(project.id, { targetWords: 1_000_000 });
    const incomplete = {
      data: { summary: "角色不足", items: [{ label: "唯一角色", operation: "create", targetTable: "entities", payload: { kind: "character", name: "沈舟" }, rationale: "核心视角" }] },
      usage: { inputTokens: 10, outputTokens: 10 },
      promptHash: "incomplete-characters",
    };
    vi.mocked(callStructuredNovelModel).mockResolvedValue(incomplete as never);

    await expect(runGenerationTask({ projectId: project.id, taskKey: "characters", instruction: "设计核心群像" }))
      .rejects.toThrow(/连续 3 次未满足结构约束/);

    expect(callStructuredNovelModel).toHaveBeenCalledTimes(3);
    expect(await novelDb.proposals.where("projectId").equals(project.id).count()).toBe(0);
  });

  it("places concrete power-network requirements in the architecture prompt", async () => {
    const project = await createNovelProject({ title: "群岛账本", genre: ["架空"], premise: "群岛围绕航道与淡水结盟。" });
    await novelDb.projects.update(project.id, { targetWords: 1_800_000 });
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "群岛架构", items: [{ label: "群岛账本架构", operation: "update", targetTable: "architectures", payload: {
        centralQuestion: "共同体如何承担稀缺的代价？", centralConflict: "多方围绕淡水、航道与税权合作并竞争。", synopsis: "潮痕与空账页留下多义异常。",
        powerCenters: ["议港会", "引水社", "巡航营", "岛祠盟", "外洋船团", "潮历院", "海灵意识"].map((name, index) => ({ id: `center-${index}`, name, kind: index === 6 ? "supernatural" : "human-organization", interest: `${name}维护自身合法性`, resources: [index === 0 ? "税契" : index === 1 ? "井渠" : "船队"], actionCapacity: "可独立调动成员改变航道秩序", bottomLine: "不接受生存资源被单方垄断", relationshipDynamics: "与其他中心既交换资源又争夺解释权" })),
        feedbackLoops: [0, 1, 2, 3].map((index) => ({ id: `loop-${index}`, name: `反馈链${index}`, trigger: "淡水供给下降", transmission: ["井渠限流", "港口改道"], affectedCenters: ["center-0", `center-${index + 1}`, `center-${index + 2}`], storyPressure: "迫使联盟在民生与军务间选择" })),
        longHorizonHooks: [0, 1, 2, 3].map((index) => ({ id: `hook-${index}`, surfaceDetail: index ? `空白潮汐页${index}` : "井壁盐痕", possibleInterpretations: ["自然变化", "人为记录偏差"], affectedCenters: [`center-${index}`], payoffWindow: "中后期分层回收" })),
        phases: Array.from({ length: 5 }, (_, order) => ({ id: `phase-${order}`, title: `阶段${order}`, purpose: "资源与关系共同变化", turningPoint: "旧有承诺再也无法恢复原状", order, locked: true, primaryCurveId: order === 2 ? "ecology" : "main" })),
        growthCurves: [
          { id: "main", kind: "main", subject: "责任认知", resourceLoop: "信用交换", stageGoals: "逐步承担", irreversibleChange: "无法旁观" },
          { id: "ecology", kind: "ecological", subject: "群岛水运", resourceLoop: "淡水与航道流转", stageGoals: "联盟重组", irreversibleChange: "旧航权失效" },
        ],
        ideologicalFactions: [
          { id: "faction-public", name: "航道公有派", position: "淡水与航道应共同管理，任何组织不得独占", affectedCenterIds: ["center-0", "center-1"] },
          { id: "faction-license", name: "特许经营派", position: "航道运营需专业组织特许经营以保障效率", affectedCenterIds: ["center-2", "center-4"] },
          { id: "faction-rite", name: "岛祠守礼派", position: "淡水分配须遵循传统岛祠礼仪秩序", affectedCenterIds: ["center-3", "center-5"] },
        ],
      }, rationale: "建立长期结构" }] }, usage: { inputTokens: 10, outputTokens: 10 }, promptHash: "architecture-contract",
    } as never);

    await runGenerationTask({ projectId: project.id, taskKey: "architecture", instruction: "建立群岛长篇架构" });

    const modelRequest = vi.mocked(callStructuredNovelModel).mock.calls.at(-1)?.[0];
    const prompt = modelRequest?.prompt ?? "";
    expect(prompt).toContain("当前正式项目名为《群岛账本》");
    expect(prompt).toContain("powerCenters 至少 7 个");
    expect(prompt).toContain("不能只写抽象的“旧秩序”与“新秩序”");
    expect(prompt).toContain("affectedCenters 只能引用 powerCenters 中已有 id 或准确名称");
    const schema = JSON.stringify(modelRequest?.schema);
    expect(schema).toContain('"powerCenters":{"type":"array","minItems":7');
    expect(schema).toContain('"feedbackLoops":{"type":"array","minItems":4');
    expect(schema).toContain('"affectedCenters":{"type":"array","items":{"type":"string"},"minItems":3');
    expect(schema).toContain('"longHorizonHooks":{"type":"array","minItems":4');
  });

  it("rejects a million-word architecture that omits first-class system fields", async () => {
    const project = await createNovelProject({ title: "缺失网络", genre: ["架空"], premise: "多个组织争夺河谷。" });
    await novelDb.projects.update(project.id, { targetWords: 1_200_000 });
    const incomplete = { data: { summary: "只有概念", items: [{ label: "概念架构", operation: "update", targetTable: "architectures", payload: {
      centralQuestion: "谁能决定秩序？", centralConflict: "多方冲突。", synopsis: "天下变化。", phases: [{ id: "phase", title: "变化", purpose: "推进", turningPoint: "无法回头", order: 0, locked: true, primaryCurveId: "ecology" }],
      growthCurves: [{ id: "main", kind: "main", subject: "人物", resourceLoop: "信任", stageGoals: "成长", irreversibleChange: "承担" }, { id: "ecology", kind: "ecological", subject: "河谷", resourceLoop: "水粮", stageGoals: "重组", irreversibleChange: "改道" }],
    }, rationale: "概述" }] }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "missing-system-fields" };
    vi.mocked(callStructuredNovelModel).mockResolvedValue(incomplete as never);

    await expect(runGenerationTask({ projectId: project.id, taskKey: "architecture", instruction: "建立长期架构" }))
      .rejects.toThrow(/powerCenters 只有 0 个/);
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(3);
  });

  it("rejects dangling power-center references in a million-word architecture", async () => {
    const project = await createNovelProject({ title: "闭合网络", genre: ["科幻"], premise: "轨道城邦共同维护一座升降梯。" });
    await novelDb.projects.update(project.id, { targetWords: 1_200_000 });
    const centers = ["轨道议会", "地表港务局", "升降梯工会", "赤道农垦带", "外环船团"].map((name, index) => ({ id: `center-${index}`, name, kind: "human-organization", interest: "维持自身生存网络", resources: ["基础设施"], actionCapacity: "可独立改变物流秩序", bottomLine: "不接受生命线被单方控制", relationshipDynamics: "与其他中心互相依赖并争夺调度权" }));
    const response = { data: { summary: "轨道架构", items: [{ label: "轨道架构", operation: "update", targetTable: "architectures", payload: {
      centralQuestion: "共同维护是否可能？", centralConflict: "五方争夺调度权。", synopsis: "维修编号反复出现。", powerCenters: centers,
      feedbackLoops: [0, 1, 2].map((index) => ({ id: `loop-${index}`, name: `反馈${index}`, trigger: "运力下降", transmission: ["限流", "配给"], affectedCenters: index === 2 ? ["center-0", "未建模的监察院"] : ["center-0", `center-${index + 1}`], storyPressure: "生存与自治冲突" })),
      longHorizonHooks: [0, 1, 2].map((index) => ({ id: `hook-${index}`, surfaceDetail: `维修编号${index}`, possibleInterpretations: ["旧协议", "人为伪造"], affectedCenters: [`center-${index}`], payoffWindow: "中后期" })),
      phases: [{ id: "phase", title: "失速", purpose: "运力与信任同时下降", turningPoint: "主索永久易手", order: 0, locked: true, primaryCurveId: "ecology" }],
      growthCurves: [{ id: "main", kind: "main", subject: "责任", resourceLoop: "信用", stageGoals: "承担", irreversibleChange: "无法旁观" }, { id: "ecology", kind: "ecological", subject: "轨道物流", resourceLoop: "运力", stageGoals: "重组", irreversibleChange: "旧调度权失效" }],
    }, rationale: "建立网络" }] }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "dangling-center" };
    vi.mocked(callStructuredNovelModel).mockResolvedValue(response as never);

    await expect(runGenerationTask({ projectId: project.id, taskKey: "architecture", instruction: "建立轨道长篇架构" }))
      .rejects.toThrow(/未建模中心.*监察院/);
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(3);
  });

  it("does not impose million-word item minimums on a smaller project", async () => {
    const project = await createNovelProject({ title: "独角短篇", genre: ["现实"], premise: "一个人在雨夜做出选择。" });
    vi.mocked(callStructuredNovelModel).mockResolvedValue({
      data: { summary: "单一人物足以承载短篇", items: [{ label: "独行者", operation: "create", targetTable: "entities", payload: { kind: "character", name: "林默" }, rationale: "唯一视角" }] },
      usage: { inputTokens: 10, outputTokens: 10 },
      promptHash: "short-fiction-character",
    } as never);

    const result = await runGenerationTask({ projectId: project.id, taskKey: "characters", instruction: "只设计故事真正需要的人物" });

    expect(result.proposal.items).toHaveLength(1);
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(1);
  });

  it("rejects a million-word worldview made only of organizations", async () => {
    const project = await createNovelProject({ title: "环城纪事", genre: ["科幻"], premise: "八座环城共享同一套生命支持系统。" });
    await novelDb.projects.update(project.id, { targetWords: 1_200_000 });
    const response = { data: { summary: "只有机构", items: Array.from({ length: 8 }, (_, index) => ({
      label: `机构${index}`, operation: "create", targetTable: "entities", payload: { kind: "organization", name: `环城机构${index}`, summary: "管理环城资源", description: "负责一项公共资源。" }, rationale: "建立机构",
    })) }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "worldview-without-regions" };
    vi.mocked(callStructuredNovelModel).mockResolvedValue(response as never);

    await expect(runGenerationTask({ projectId: project.id, taskKey: "worldview", instruction: "建立完整世界观" }))
      .rejects.toThrow(/只有 0 个地点实体/);
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(3);
  });

  it("places accepted architecture centers in the worldview continuity contract", async () => {
    const project = await createNovelProject({ title: "远洋共同体", genre: ["科幻"], premise: "世代船团维持彼此不同的生态循环。" });
    await novelDb.projects.update(project.id, { targetWords: 1_200_000 });
    const architecture = await addArchitecture(project.id, 1);
    await saveStoryArchitecture({
      ...architecture,
      powerCenters: ["潮汐议会", "种源保管局", "外环维修团"].map((name, index) => ({
        id: `center-${index}`,
        name,
        kind: "human-organization",
        interest: "维护本群体的生存秩序",
        resources: ["专业人员", "公共设施"],
        actionCapacity: "能够独立调整资源分配",
        bottomLine: "不允许生命支持系统被单方切断",
        relationshipDynamics: "在共同维护与资源优先级之间合作并冲突",
      })),
    });
    const kinds = ["location", "location", "organization", "organization", "faction", "rule", "term", "ability"];
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "跨船团世界观", items: kinds.map((kind, index) => ({
        label: `实体${index}`,
        operation: "create",
        targetTable: "entities",
        payload: { kind, name: `实体${index}`, summary: "可独立引用的世界设定", description: "说明资源、职责与行动边界。" },
        rationale: "建立世界结构",
      })) },
      usage: { inputTokens: 1, outputTokens: 1 },
      promptHash: "worldview-continuity",
    } as never);

    await runGenerationTask({ projectId: project.id, taskKey: "worldview", instruction: "实体化既有世界架构" });

    const prompt = vi.mocked(callStructuredNovelModel).mock.calls.at(-1)?.[0].prompt ?? "";
    expect(prompt).toContain("世界观连续性合同");
    expect(prompt).toContain("潮汐议会、种源保管局、外环维修团");
    expect(prompt).toContain("不得仅改几个字就创建职能相同的平行组织");
  });

  it("lists only characters as valid participantIds", async () => {
    const project = await createNovelProject({ title: "环站议约", genre: ["科幻"], premise: "多个空间站共同维护航道。" });
    await novelDb.projects.update(project.id, { targetWords: 1_200_000 });
    const character = { ...recordBase(project.id), kind: "character" as const, name: "林遥", aliases: [], summary: "航道协调员", description: "", tags: [], lockedFacts: [], attributes: {} };
    const location = { ...recordBase(project.id), kind: "location" as const, name: "外环站", aliases: [], summary: "航道节点", description: "", tags: [], lockedFacts: [], attributes: {} };
    await novelDb.entities.bulkAdd([character, location]);
    const kinds = ["main", "subplot", "antagonist", "conspiracy"];
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "四条剧情线", items: kinds.map((kind, index) => ({
        label: `剧情线${index}`,
        operation: "create",
        targetTable: "plotThreads",
        payload: { kind, title: `剧情线${index}`, summary: "围绕航道资源推进独立目标。", status: "planned", priority: 80, participantIds: [character.id], progress: 0, nextMove: "协调下一轮资源交换。" },
        rationale: "建立跨线因果",
      })) },
      usage: { inputTokens: 1, outputTokens: 1 },
      promptHash: "participant-index",
    } as never);

    await runGenerationTask({ projectId: project.id, taskKey: "plot-threads", instruction: "规划长期剧情线" });

    const prompt = vi.mocked(callStructuredNovelModel).mock.calls.at(-1)?.[0].prompt ?? "";
    const participantSection = prompt.split("角色（characterIds / povCharacterId / participantIds）：")[1]?.split("关系实体（fromEntityId / toEntityId）：")[0] ?? "";
    expect(participantSection).toContain(character.id);
    expect(participantSection).not.toContain(location.id);
    expect(prompt).toContain(`地点（locationId）：\n- id=${location.id}`);
  });

  it("rejects a long-form timeline that covers only the opening and has no causal graph", async () => {
    const project = await createNovelProject({ title: "百年航路", genre: ["科幻"], premise: "移民船团跨越数代完成航行。" });
    await novelDb.projects.update(project.id, { targetWords: 1_800_000 });
    const response = {
      data: { summary: "只有开篇", items: Array.from({ length: 4 }, (_, index) => ({
        label: `开篇事件${index}`,
        operation: "create",
        targetTable: "timelineEvents",
        tempId: `event-${index}`,
        payload: { title: `开篇事件${index}`, storyDate: `第${index + 1}日`, duration: "1日", narrativeOrder: index, participantIds: [], causeIds: [], consequenceIds: [], description: "船团处理起航准备。" },
        rationale: "建立开篇",
      })) },
      usage: { inputTokens: 1, outputTokens: 1 },
      promptHash: "short-timeline",
    };
    vi.mocked(callStructuredNovelModel).mockResolvedValue(response as never);

    await expect(runGenerationTask({ projectId: project.id, taskKey: "timeline", instruction: "规划全书时间线" }))
      .rejects.toThrow(/至少需要 7 个.*不能只规划开篇/);

    expect(callStructuredNovelModel).toHaveBeenCalledTimes(3);
    expect(vi.mocked(callStructuredNovelModel).mock.calls[0]?.[0].prompt).toContain("长篇时间线合同");
    expect(vi.mocked(callStructuredNovelModel).mock.calls[0]?.[0].prompt).toContain("当前体量至少返回 7 个骨干事件");
  });

  it("requires concrete location anchors in a long-form timeline", async () => {
    const project = await createNovelProject({ title: "群岛迁徙史", genre: ["架空"], premise: "七座岛屿在海潮中重建联盟。" });
    await novelDb.projects.update(project.id, { targetWords: 1_800_000 });
    const response = {
      data: { summary: "无地点时间线", items: Array.from({ length: 7 }, (_, index) => ({
        label: `阶段事件${index}`,
        operation: "create",
        targetTable: "timelineEvents",
        tempId: `event-${index}`,
        payload: {
          title: `阶段事件${index}`,
          storyDate: `第${index + 1}年`,
          duration: "1年",
          narrativeOrder: index,
          participantIds: [],
          causeIds: index ? [`ref:event-${index - 1}`] : [],
          consequenceIds: [],
          description: "联盟在一个新阶段重新分配资源。",
        },
        rationale: "建立长期变化",
      })) },
      usage: { inputTokens: 1, outputTokens: 1 },
      promptHash: "timeline-without-locations",
    };
    vi.mocked(callStructuredNovelModel).mockResolvedValue(response as never);

    await expect(runGenerationTask({ projectId: project.id, taskKey: "timeline", instruction: "规划跨地域时间线" }))
      .rejects.toThrow(/至少需要 2 个使用真实地点 ID 的地域锚点/);

    expect(callStructuredNovelModel).toHaveBeenCalledTimes(3);
  });
});

describe("proposal application and ownership", () => {
  it("does not overwrite a record whose revision changed after generation", async () => {
    const project = await createNovelProject({ title: "冲突测试", genre: ["奇幻"], premise: "名字决定寿命。" });
    const entity = { ...recordBase(project.id), kind: "item" as const, name: "寿命簿", aliases: [], summary: "旧摘要", description: "", tags: [], lockedFacts: [], attributes: {} };
    await novelDb.entities.add(entity);
    const draft = proposal(project.id, [{ id: "update", label: "修改寿命簿", operation: "update", targetTable: "entities", targetId: entity.id, expectedRevision: entity.revision, status: "pending", payload: { summary: "AI 摘要" }, rationale: "补全", dependencies: [] }]);
    await novelDb.proposals.add(draft);
    await novelDb.entities.update(entity.id, { summary: "用户刚刚修改", revision: entity.revision + 1 });
    const result = await applyProposalItems(draft.id, ["update"]);
    expect(result).toMatchObject({ applied: 0, conflicts: 1 });
    expect((await novelDb.entities.get(entity.id))?.summary).toBe("用户刚刚修改");
  });

  it("deleting a plot segment preserves and detaches its chapters", async () => {
    const project = await createNovelProject({ title: "归属测试", genre: ["科幻"], premise: "计划可以调整。" });
    const architecture = await addArchitecture(project.id, 1);
    const segment = await addOutlineNode(project.id, architecture.phases[0].id, "跃迁失败", 0);
    const chapter = await createChapter(project.id, "第一章", segment.id);
    const realization = await linkOutlineRealization({ projectId: project.id, outlineNodeId: segment.id, documentId: chapter.id });

    await deleteOutlineBranch(project.id, segment.id);

    expect(await novelDb.outlineNodes.get(segment.id)).toBeUndefined();
    expect((await novelDb.documents.get(chapter.id))?.plotSegmentId).toBeUndefined();
    expect(await novelDb.outlineRealizations.get(realization.id)).toBeUndefined();
  });

  it("deleting a chapter retires its approved truth and memory", async () => {
    const project = await createNovelProject({ title: "删章", genre: ["悬疑"], premise: "被删除章节不能继续定义事实。" });
    const chapter = await createChapter(project.id, "证词");
    const approved = await saveApprovedDocumentRevision({ ...chapter, plainText: "证人开口。", contentHtml: "<p>证人开口。</p>", wordCount: 5, status: "review" }, "版本", "manual");
    const assertion = { ...recordBase(project.id), id: "fact", subject: { kind: "project" as const, id: project.id }, predicate: "testimony.exists", object: { kind: "boolean" as const, value: true }, polarity: "affirmed" as const, truthStatus: "objective" as const, timeMode: "point" as const, revealedAt: { chapterId: chapter.id, narrativeOrder: chapter.order, precision: "exact" as const }, sourceRevisionId: approved.revision.id, provenance: "approved-revision" as const, evidence: "证人开口。", confidence: 1, humanReadable: "证词存在", status: "active" as const, derivedFromCandidateId: "candidate" };
    await novelDb.factAssertions.add(assertion);
    const memory = await createChapterMemory({ projectId: project.id, documentId: chapter.id, sourceRevisionId: approved.revision.id, summary: "证人留下证词" });

    await deleteChapter(chapter.id);

    expect(await novelDb.documents.get(chapter.id)).toBeUndefined();
    expect((await novelDb.factAssertions.get(assertion.id))?.status).toBe("retracted");
    expect((await novelDb.derivedMemories.get(memory.id))?.status).toBe("stale");
  });

  it("deleting a plot thread detaches it from chapters and scenes", async () => {
    const project = await createNovelProject({ title: "剧情线删除", genre: ["悬疑"], premise: "失效引用不能留在创作上下文中。" });
    const thread = { ...recordBase(project.id), kind: "main" as const, title: "旧主线", summary: "追查遗失的账本", status: "active" as const, priority: 80, participantIds: [], progress: 30, nextMove: "调查码头" };
    const chapter = await createChapter(project.id, "第一章");
    const scene: StoryScene = { ...recordBase(project.id), chapterId: chapter.id, title: "码头", order: 0, characterIds: [], plotThreadIds: [thread.id], purpose: "推进调查", conflict: "守卫阻拦", outcome: "得到线索", wordTarget: 800 };
    await novelDb.plotThreads.add(thread);
    await novelDb.documents.update(chapter.id, { blueprint: { ...chapter.blueprint, plotThreadIds: [thread.id] } });
    await novelDb.scenes.add(scene);

    await deletePlotThread(thread.id);

    expect(await novelDb.plotThreads.get(thread.id)).toBeUndefined();
    expect((await novelDb.documents.get(chapter.id))?.blueprint.plotThreadIds).toEqual([]);
    expect((await novelDb.scenes.get(scene.id))?.plotThreadIds).toEqual([]);
  });

  it("normalizes chapter order from phase and plot segment order", async () => {
    const project = await createNovelProject({ title: "排序", genre: ["都市"], premise: "章节按规划层级排列。" });
    const architecture = await addArchitecture(project.id, 2);
    const later = await addOutlineNode(project.id, architecture.phases[1].id, "后幕", 0);
    const early = await addOutlineNode(project.id, architecture.phases[0].id, "前幕", 0);
    const lateChapter = await createChapter(project.id, "后章", later.id);
    const earlyChapter = await createChapter(project.id, "前章", early.id);
    expect((await novelDb.documents.get(earlyChapter.id))?.order).toBe(0);
    expect((await novelDb.documents.get(lateChapter.id))?.order).toBe(1);
  });
});

describe("splitInstruction", () => {
  it("returns original instruction when below threshold", () => {
    const instruction = "简短的生成指令";
    const result = splitInstruction(instruction);
    expect(result.core).toBe(instruction);
    expect(result.detail).toBeUndefined();
  });

  it("splits by section marker when instruction exceeds threshold", () => {
    const core = "核心指令".repeat(2000);
    const detail = "# 审核意见\n问题1：turningPoint 不够不可逆\n问题2：ecological 曲线依赖主线";
    const instruction = `${core}\n\n${detail}`;
    expect(instruction.length).toBeGreaterThan(MAX_INSTRUCTION_CHARS);
    const result = splitInstruction(instruction);
    expect(result.core).toContain("核心指令");
    expect(result.core).not.toContain("# 审核意见");
    expect(result.core).toContain("详细审核反馈");
    expect(result.detail).toBe(detail);
  });

  it("splits by fallback truncation when no marker found", () => {
    const instruction = "无标记的长指令".repeat(1000);
    expect(instruction.length).toBeGreaterThan(MAX_INSTRUCTION_CHARS);
    const result = splitInstruction(instruction);
    expect(result.core.length).toBeLessThan(instruction.length);
    expect(result.core).toContain("详细审核反馈");
    expect(result.detail).toBeTruthy();
    expect(result.detail!.length).toBeGreaterThan(0);
  });

  it("returns original when marker at start (index 0)", () => {
    const detail = "# 审核意见\n只有审核意见没有核心指令".repeat(400);
    expect(detail.length).toBeGreaterThan(MAX_INSTRUCTION_CHARS);
    // marker 在 index 0，core 为空，回退到截断
    const result = splitInstruction(detail);
    expect(result.core.length).toBeLessThan(detail.length);
  });
});

describe("validateArchitectureHardConstraints", () => {
  it("flags turningPoint without irreversible markers", () => {
    const issues = validateArchitectureHardConstraints({
      phases: [{ id: "p1", turningPoint: "主角发现了新世界" }],
    });
    expect(issues.some((i) => i.dimension === "structure.turningPoint")).toBe(true);
  });

  it("passes turningPoint with irreversible markers", () => {
    const issues = validateArchitectureHardConstraints({
      phases: [{ id: "p1", turningPoint: "主角失去了灵脉，组织永久裂变" }],
    });
    expect(issues.some((i) => i.dimension === "structure.turningPoint")).toBe(false);
  });

  it("flags ecological curve depending on main protagonist", () => {
    const issues = validateArchitectureHardConstraints({
      growthCurves: [{ kind: "ecological", resourceLoop: "陈墨推动的资源循环", stageGoals: "主角技术传播" }],
    });
    expect(issues.some((i) => i.dimension === "structure.growthCurve.ecological")).toBe(true);
  });

  it("flags feedback loop with fewer than 4 transmission steps", () => {
    const issues = validateArchitectureHardConstraints({
      feedbackLoops: [{ id: "fl1", transmission: ["甲→乙", "乙→丙"] }],
    });
    expect(issues.some((i) => i.dimension === "structure.feedbackLoop")).toBe(true);
  });

  it("flags foreshadowing with hint words", () => {
    const issues = validateArchitectureHardConstraints({
      longHorizonHooks: [{ id: "h1", surfaceDetail: "账册中有一条异常记录" }],
    });
    expect(issues.some((i) => i.dimension === "structure.foreshadowing")).toBe(true);
  });

  it("warns when power centers lack non-binary relationships", () => {
    const issues = validateArchitectureHardConstraints({
      powerCenters: [
        { id: "pc1", relationshipDynamics: "与pc2纯冲突" },
        { id: "pc2", relationshipDynamics: "与pc1纯对抗" },
      ],
    });
    expect(issues.some((i) => i.dimension === "structure.powerCenter.relationship" && i.severity === "warning")).toBe(true);
  });
});
