import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
  callStructuredNovelModel: vi.fn(async () => ({
    data: { summary: "项目定位候选", items: [{ label: "定位", operation: "update", targetTable: "projects", targetId: "ignored", payload: { audience: "青年悬疑读者" }, rationale: "明确受众" }] },
    usage: { inputTokens: 10, outputTokens: 10 },
    promptHash: "test-hash",
  })),
}));

import { callStructuredNovelModel } from "../ai";
import { applyProposalItems, getGenerationTask, runGenerationTask, tasksForScope, updateProposalItemPayload } from "../generation";
import { addOutlineNode, createChapter, createNovelProject, deleteChapter, deleteOutlineBranch, novelDb, recordBase } from "../db";
import type { AIProposal, StoryEntity, WorkflowRun } from "../types";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
});

function proposal(projectId: string, items: AIProposal["items"]): AIProposal {
  return { ...recordBase(projectId), title: "测试候选", operation: "structured:characters", taskKey: "characters", scope: "characters", status: "pending", previewMarkdown: "# 测试", patches: [], items, contextPacketId: "context", model: "test" };
}

function characterPayload(name: string) {
  return { kind: "character", name, summary: "核心人物", description: "负责推动故事选择", character: { role: "主角", appearance: "", personality: "谨慎", desire: "找出真相", motivation: "保护记忆", weakness: "过度怀疑", secret: "", abilities: [], voice: "简短", arc: "从记录走向行动", knowledge: { known: [], suspected: [], mistaken: [], unknown: [] }, state: { location: "", physical: "正常", emotional: "警惕", objective: "调查", inventory: [], relationshipNotes: [] } } };
}

describe("generation task ownership", () => {
  it("exposes project positioning alongside story data in the bible scope", () => {
    expect(getGenerationTask("project-positioning").scope).toBe("bible");
    expect(tasksForScope("bible").map((task) => task.key)).toEqual(["project-positioning", "story-bible"]);
  });

  it("generates, edits, and accepts project positioning as a bible proposal", async () => {
    const project = await createNovelProject({ title: "定位测试", genre: ["悬疑"], premise: "每个人都会遗忘一个名字。" });
    const { proposal: generated } = await runGenerationTask({ projectId: project.id, taskKey: "project-positioning", instruction: "完善项目定位" });
    const visibleProposal = (await novelDb.proposals.where("projectId").equals(project.id).reverse().sortBy("createdAt")).find((item) => item.status === "pending" && item.scope === "bible" && ["project-positioning", "story-bible"].includes(item.taskKey ?? ""));
    expect(visibleProposal?.id).toBe(generated.id);
    expect(generated).toMatchObject({ scope: "bible", taskKey: "project-positioning", targetId: undefined });
    expect(generated.items[0]).toMatchObject({ operation: "update", targetTable: "projects", targetId: project.id });

    await updateProposalItemPayload(generated.id, generated.items[0].id, { audience: "成年悬疑读者" });
    await applyProposalItems(generated.id, [generated.items[0].id]);
    expect((await novelDb.projects.get(project.id))?.audience).toBe("成年悬疑读者");
    expect((await novelDb.proposals.get(generated.id))?.status).toBe("accepted");
  });
});

describe("structured proposal application", () => {
  it("applies only selected items and marks a partial acceptance", async () => {
    const project = await createNovelProject({ title: "候选测试", genre: ["悬疑"], premise: "所有门都会记住开门的人。" });
    const draft = proposal(project.id, [
      { id: "one", label: "守门人", operation: "create", targetTable: "entities", tempId: "keeper", status: "pending", payload: characterPayload("守门人"), rationale: "核心角色", dependencies: [] },
      { id: "two", label: "旧门", operation: "create", targetTable: "entities", tempId: "door", status: "pending", payload: { kind: "item", name: "旧门", summary: "旧门", description: "会记住开门者" }, rationale: "关键物品", dependencies: [] },
    ]);
    await novelDb.proposals.add(draft);
    const result = await applyProposalItems(draft.id, ["one"]);
    expect(result).toEqual(expect.objectContaining({ applied: 1, conflicts: 0 }));
    expect((await novelDb.entities.where("projectId").equals(project.id).toArray()).map((item) => item.name)).toEqual(["守门人"]);
    expect((await novelDb.proposals.get(draft.id))?.status).toBe("partially_accepted");
  });

  it("resolves temporary references between selected candidates", async () => {
    const project = await createNovelProject({ title: "关系测试", genre: ["都市"], premise: "陌生人共享同一个梦。" });
    const draft = proposal(project.id, [
      { id: "character", label: "林澈", operation: "create", targetTable: "entities", tempId: "lin", status: "pending", payload: characterPayload("林澈"), rationale: "主角", dependencies: [] },
      { id: "relation", label: "梦中关系", operation: "create", targetTable: "relations", tempId: "dream-link", status: "pending", payload: { fromEntityId: "ref:lin", toEntityId: "ref:lin", relationType: "自我镜像", publicLabel: "陌生人", privateTruth: "同一意识" }, rationale: "测试引用", dependencies: ["lin"] },
    ]);
    await novelDb.proposals.add(draft);
    await applyProposalItems(draft.id, ["character", "relation"]);
    const entity = await novelDb.entities.where("projectId").equals(project.id).first();
    const relation = await novelDb.relations.where("projectId").equals(project.id).first();
    expect(relation?.fromEntityId).toBe(entity?.id);
    expect(relation?.toEntityId).toBe(entity?.id);
  });

  it("resolves a reference alias from an already accepted character proposal", async () => {
    const project = await createNovelProject({ title: "跨阶段引用", genre: ["悬疑"], premise: "角色会进入后续大纲。" });
    const entity: StoryEntity = { ...recordBase(project.id), kind: "character", name: "陆沉", aliases: [], summary: "记录员", description: "", tags: [], lockedFacts: [], attributes: {}, character: characterPayload("陆沉").character };
    await novelDb.entities.add(entity);
    const characterProposal = proposal(project.id, [{ id: "character", label: "陆沉", operation: "create", targetTable: "entities", tempId: "character_luchen", status: "accepted", payload: characterPayload("陆沉"), rationale: "主角", dependencies: [] }]);
    characterProposal.status = "accepted";
    await novelDb.proposals.add(characterProposal);
    const outlineProposal = proposal(project.id, [{ id: "event", label: "陆沉发现缺页", operation: "create", targetTable: "outlineNodes", status: "pending", payload: { kind: "event", title: "发现缺页", summary: "陆沉发现档案缺页", order: 0, causality: "记录异常", outcome: "开始调查", characterIds: ["ref:character_luchen"] }, rationale: "开端事件", dependencies: [] }]);
    outlineProposal.taskKey = "outline";
    outlineProposal.scope = "outline";
    await novelDb.proposals.add(outlineProposal);
    await applyProposalItems(outlineProposal.id, ["event"]);
    expect((await novelDb.outlineNodes.where("projectId").equals(project.id).first())?.characterIds).toEqual([entity.id]);
  });

  it("stores the formal target id on accepted temporary objects", async () => {
    const project = await createNovelProject({ title: "引用落盘", genre: ["都市"], premise: "人物拥有稳定标识。" });
    const draft = proposal(project.id, [{ id: "character", label: "林澈", operation: "create", targetTable: "entities", tempId: "character_linche", status: "pending", payload: characterPayload("林澈"), rationale: "主角", dependencies: [] }]);
    await novelDb.proposals.add(draft);
    await applyProposalItems(draft.id, ["character"]);
    const stored = await novelDb.proposals.get(draft.id);
    expect(stored?.items[0].targetId).toBe((await novelDb.entities.where("projectId").equals(project.id).first())?.id);
  });

  it("refuses to apply a candidate without its generated dependency", async () => {
    const project = await createNovelProject({ title: "依赖测试", genre: ["都市"], premise: "所有关系都会留下伤痕。" });
    const draft = proposal(project.id, [
      { id: "character", label: "林澈", operation: "create", targetTable: "entities", tempId: "lin", status: "pending", payload: characterPayload("林澈"), rationale: "主角", dependencies: [] },
      { id: "relation", label: "梦中关系", operation: "create", targetTable: "relations", tempId: "dream-link", status: "pending", payload: { fromEntityId: "ref:lin", toEntityId: "ref:lin", relationType: "自我镜像", publicLabel: "陌生人", privateTruth: "同一意识" }, rationale: "依赖角色", dependencies: ["lin"] },
    ]);
    await novelDb.proposals.add(draft);
    await expect(applyProposalItems(draft.id, ["relation"])).rejects.toThrow(/依赖项/);
    expect(await novelDb.relations.where("projectId").equals(project.id).count()).toBe(0);
  });

  it("refuses unresolved temporary references even when dependencies are omitted", async () => {
    const project = await createNovelProject({ title: "悬空引用", genre: ["都市"], premise: "一段关系找不到任何一端。" });
    const draft = proposal(project.id, [
      { id: "relation", label: "悬空关系", operation: "create", targetTable: "relations", status: "pending", payload: { fromEntityId: "ref:missing", toEntityId: "ref:missing", relationType: "陌生人", publicLabel: "未知", privateTruth: "未知" }, rationale: "测试引用", dependencies: [] },
    ]);
    await novelDb.proposals.add(draft);
    await expect(applyProposalItems(draft.id, ["relation"])).rejects.toThrow(/临时对象/);
    expect(await novelDb.relations.where("projectId").equals(project.id).count()).toBe(0);
  });

  it("does not overwrite a record whose revision changed after generation", async () => {
    const project = await createNovelProject({ title: "冲突测试", genre: ["奇幻"], premise: "名字决定寿命。" });
    const entity: StoryEntity = { ...recordBase(project.id), kind: "item", name: "寿命簿", aliases: [], summary: "旧摘要", description: "", tags: [], lockedFacts: [], attributes: {} };
    await novelDb.entities.add(entity);
    const draft = proposal(project.id, [{ id: "update", label: "修改寿命簿", operation: "update", targetTable: "entities", targetId: entity.id, expectedRevision: entity.revision, status: "pending", payload: { summary: "AI 摘要" }, rationale: "补全", dependencies: [] }]);
    await novelDb.proposals.add(draft);
    await novelDb.entities.update(entity.id, { summary: "用户刚刚修改", revision: entity.revision + 1 });
    const result = await applyProposalItems(draft.id, ["update"]);
    expect(result).toEqual({ applied: 0, conflicts: 1, embeddingFailures: 0 });
    expect((await novelDb.entities.get(entity.id))?.summary).toBe("用户刚刚修改");
    expect((await novelDb.proposals.get(draft.id))?.items[0].status).toBe("conflict");
    expect((await novelDb.proposals.get(draft.id))?.status).toBe("pending");
  });

  it("keeps the existing outline subtree when the section root has a revision conflict", async () => {
    const project = await createNovelProject({ title: "子树冲突", genre: ["悬疑"], premise: "每次改写都会留下旧版本。" });
    const root = await addOutlineNode(project.id, undefined, "act", "第一幕", 0);
    const child = await addOutlineNode(project.id, root.id, "event", "旧事件", 0);
    const draft = proposal(project.id, [
      { id: "root", label: "改写第一幕", operation: "update", targetTable: "outlineNodes", targetId: root.id, expectedRevision: root.revision, status: "pending", payload: { summary: "AI 改写" }, rationale: "重写根节点", dependencies: [] },
      { id: "new-child", label: "新事件", operation: "create", targetTable: "outlineNodes", tempId: "new-event", status: "pending", payload: { parentId: root.id, kind: "event", title: "新事件", summary: "替代事件", causality: "新的原因", outcome: "新的结果", order: 0 }, rationale: "替换子树", dependencies: [] },
    ]);
    draft.taskKey = "outline-section-update";
    draft.scope = "outline";
    draft.targetId = root.id;
    await novelDb.proposals.add(draft);
    await novelDb.outlineNodes.update(root.id, { summary: "用户刚刚修改", revision: root.revision + 1 });

    const result = await applyProposalItems(draft.id, draft.items.map((item) => item.id));

    expect(result).toEqual({ applied: 0, conflicts: 2, embeddingFailures: 0 });
    expect(await novelDb.outlineNodes.get(child.id)).toBeDefined();
    expect((await novelDb.outlineNodes.where("projectId").equals(project.id).toArray()).map((item) => item.title)).toEqual(expect.arrayContaining(["第一幕", "旧事件"]));
  });

  it("rejects a field revision response that omits the requested field", async () => {
    const project = await createNovelProject({ title: "字段修订", genre: ["都市"], premise: "只允许修改指定字段。" });
    const node = await addOutlineNode(project.id, undefined, "event", "原事件", 0);
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "错误字段", items: [{ label: "越界修改", operation: "update", targetTable: "outlineNodes", targetId: node.id, payload: { title: "被改标题" }, rationale: "错误输出" }] },
      usage: { inputTokens: 1, outputTokens: 1 },
      promptHash: "field-test",
    });

    await expect(runGenerationTask({ projectId: project.id, taskKey: "outline-field-revise", targetId: node.id, targetField: "summary", instruction: "改写摘要" })).rejects.toThrow(/未返回目标字段/);
    expect((await novelDb.outlineNodes.get(node.id))?.title).toBe("原事件");
  });

  it("rejects malformed create payloads before writing formal data", async () => {
    const project = await createNovelProject({ title: "校验测试", genre: ["奇幻"], premise: "梦境会污染现实。" });
    const draft = proposal(project.id, [{ id: "invalid", label: "残缺角色", operation: "create", targetTable: "entities", status: "pending", payload: { kind: "character", name: "无状态角色", summary: "", description: "" }, rationale: "缺少角色状态", dependencies: [] }]);
    await novelDb.proposals.add(draft);
    await expect(applyProposalItems(draft.id, ["invalid"])).rejects.toThrow(/字段无效/);
    expect(await novelDb.entities.where("projectId").equals(project.id).count()).toBe(0);
  });

  it("serializes concurrent acceptance so a candidate is written once", async () => {
    const project = await createNovelProject({ title: "并发测试", genre: ["悬疑"], premise: "同一证据只能被读取一次。" });
    const draft = proposal(project.id, [{ id: "item", label: "证据", operation: "create", targetTable: "entities", tempId: "evidence", status: "pending", payload: { kind: "item", name: "烧焦的纸", summary: "唯一证据", description: "边缘有指纹" }, rationale: "关键物品", dependencies: [] }]);
    await novelDb.proposals.add(draft);
    const results = await Promise.allSettled([applyProposalItems(draft.id, ["item"]), applyProposalItems(draft.id, ["item"])]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await novelDb.entities.where("projectId").equals(project.id).count()).toBe(1);
  });

  it("normalizes generated chapter prose into html, plain text, and word count", async () => {
    const project = await createNovelProject({ title: "正文同步", genre: ["都市"], premise: "雨夜里有人敲门。" });
    const chapter = await createChapter(project.id, "雨夜");
    const draft = proposal(project.id, [{ id: "draft", label: "正文", operation: "update", targetTable: "documents", targetId: chapter.id, expectedRevision: chapter.revision, status: "pending", payload: { plainText: "雨停了。\n门外没有人。" }, rationale: "生成正文", dependencies: [] }]);
    await novelDb.proposals.add(draft);
    await applyProposalItems(draft.id, ["draft"]);
    const stored = await novelDb.documents.get(chapter.id);
    expect(stored?.plainText).toBe("雨停了。\n门外没有人。");
    expect(stored?.wordCount).toBe(8);
  });
});

describe("outline and chapter ownership", () => {
  it("deleting an outline branch never deletes independent chapters", async () => {
    const project = await createNovelProject({ title: "解耦测试", genre: ["科幻"], premise: "航线会改写过去。" });
    const act = await addOutlineNode(project.id, undefined, "act", "第一幕", 0);
    await addOutlineNode(project.id, act.id, "event", "跃迁失败", 0);
    const chapter = await createChapter(project.id, "第一章");
    await deleteOutlineBranch(project.id, act.id);
    expect(await novelDb.outlineNodes.where("projectId").equals(project.id).count()).toBe(0);
    expect((await novelDb.documents.get(chapter.id))?.title).toBe("第一章");
  });

  it("deleting a chapter cascades through chapter-owned records", async () => {
    const project = await createNovelProject({ title: "级联测试", genre: ["悬疑"], premise: "每个证词都会消失。" });
    const chapter = await createChapter(project.id, "证词");
    const scene = { ...recordBase(project.id), chapterId: chapter.id, title: "审讯", order: 0, status: "planned" as const, characterIds: [], plotThreadIds: [], foreshadowingIds: [], purpose: "取证", conflict: "拒绝作证", outcome: "证词消失", wordTarget: 900, beats: [] };
    await novelDb.scenes.add(scene);
    await novelDb.revisions.add({ ...recordBase(project.id), documentId: chapter.id, label: "版本", contentHtml: "", plainText: "", source: "manual", branch: "main" });
    const packet = { ...recordBase(project.id), task: "draft", instruction: "写作", targetId: chapter.id, sources: [], tokenBudget: 1000, estimatedTokens: 0, omittedSourceIds: [], skillRefs: [], compiledAt: Date.now() };
    const run: WorkflowRun = { ...recordBase(project.id), workflowId: "standard-chapter-v2", targetDocumentId: chapter.id, status: "running", currentStage: "context", stageIndex: 0, revisionIteration: 0, contextPacketId: packet.id, factCandidateIds: [], startedAt: Date.now() };
    await novelDb.contextPackets.add(packet);
    await novelDb.workflowRuns.add(run);
    await novelDb.agentRuns.add({ ...recordBase(project.id), workflowRunId: run.id, goal: "写作", status: "completed", model: "test", promptVersion: "test", steps: [] });
    const ordinaryPacket = { ...recordBase(project.id), task: "chapter-draft", instruction: "重写本章", targetId: chapter.id, sources: [], tokenBudget: 1000, estimatedTokens: 0, omittedSourceIds: [], skillRefs: [], compiledAt: Date.now() };
    const ordinaryAgent = { ...recordBase(project.id), goal: "重写本章", status: "completed" as const, model: "test", promptVersion: "test", contextPacketId: ordinaryPacket.id, steps: [] };
    const ordinaryProposal = { ...proposal(project.id, []), targetId: chapter.id, contextPacketId: ordinaryPacket.id, agentRunId: ordinaryAgent.id };
    await novelDb.contextPackets.add(ordinaryPacket);
    await novelDb.agentRuns.add(ordinaryAgent);
    await novelDb.proposals.add(ordinaryProposal);
    await deleteChapter(chapter.id);
    expect(await novelDb.documents.get(chapter.id)).toBeUndefined();
    expect(await novelDb.scenes.get(scene.id)).toBeUndefined();
    expect(await novelDb.revisions.where("documentId").equals(chapter.id).count()).toBe(0);
    expect(await novelDb.workflowRuns.get(run.id)).toBeUndefined();
    expect(await novelDb.contextPackets.get(packet.id)).toBeUndefined();
    expect(await novelDb.contextPackets.get(ordinaryPacket.id)).toBeUndefined();
    expect(await novelDb.proposals.get(ordinaryProposal.id)).toBeUndefined();
    expect(await novelDb.agentRuns.where("projectId").equals(project.id).count()).toBe(0);
  });

  it("assigns a unique order after a middle chapter was deleted", async () => {
    const project = await createNovelProject({ title: "排序测试", genre: ["都市"], premise: "章节会自行交换位置。" });
    const first = await createChapter(project.id, "第一章");
    const second = await createChapter(project.id, "第二章");
    const third = await createChapter(project.id, "第三章");
    await deleteChapter(second.id);
    const fourth = await createChapter(project.id, "第四章");
    expect([first.order, third.order, fourth.order]).toEqual([0, 2, 3]);
    expect(new Set((await novelDb.documents.where("projectId").equals(project.id).toArray()).map((item) => item.order)).size).toBe(3);
  });

  it("serializes concurrent chapter creation and preserves unique order", async () => {
    const project = await createNovelProject({ title: "并发章节", genre: ["悬疑"], premise: "两章同时发生。" });
    const chapters = await Promise.all([createChapter(project.id, "甲"), createChapter(project.id, "乙"), createChapter(project.id, "丙")]);
    expect(chapters.map((chapter) => chapter.order).sort()).toEqual([0, 1, 2]);
  });
});
