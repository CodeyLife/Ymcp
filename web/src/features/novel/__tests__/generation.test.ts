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
import { applyProposalItems, getGenerationTask, runGenerationTask, runPlotDesignTask, tasksForScope, updateProposalItemPayload, validatePlotDesignItems } from "../generation";
import { addOutlineNode, createChapter, createNovelProject, deleteChapter, deleteOutlineBranch, novelDb, recordBase, saveApprovedDocumentRevision, saveStoryArchitecture } from "../db";
import { createChapterMemory, linkOutlineRealization } from "../memory";
import type { AIProposal, ProposalItem } from "../types";

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
    phases: Array.from({ length: phaseCount }, (_, order) => ({ id: `phase-${order}`, title: `第 ${order + 1} 幕`, purpose: `推进阶段 ${order + 1}`, turningPoint: `转折 ${order + 1}`, order, locked: false })),
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

  it("validates exactly one segment and two to four chapters", () => {
    const segment: ProposalItem = { id: "segment", tempId: "segment", label: "段", operation: "create", targetTable: "outlineNodes", status: "pending", payload: { phaseId: "phase", title: "段", summary: "概要", order: 0 }, rationale: "", dependencies: [] };
    const chapter = (id: string, order: number): ProposalItem => ({ id, tempId: id, label: id, operation: "create", targetTable: "documents", status: "pending", payload: { plotSegmentId: "ref:segment", title: id, summary: "摘要", order, blueprint: {} }, rationale: "", dependencies: [] });
    expect(() => validatePlotDesignItems([segment, chapter("one", 0)], "phase", 0, 0)).toThrow(/2-4 个章节/);
    expect(() => validatePlotDesignItems([segment, chapter("one", 0), chapter("two", 1)], "phase", 0, 0)).not.toThrow();
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
    await updateProposalItemPayload(generated.id, generated.items[0].id, { audience: "成年悬疑读者" });
    await applyProposalItems(generated.id, [generated.items[0].id]);
    expect((await novelDb.projects.get(project.id))?.audience).toBe("成年悬疑读者");
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
