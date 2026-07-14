import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
  callStructuredNovelModel: vi.fn(async () => ({
    data: { summary: "项目定位候选", items: [{ label: "定位", operation: "update", targetTable: "projects", targetId: "ignored", payload: { audience: "青年悬疑读者" }, rationale: "明确受众" }] },
    usage: { inputTokens: 10, outputTokens: 10 },
    promptHash: "test-hash",
  })),
}));

import { callStructuredNovelModel } from "../ai";
import { applyProposalItems, buildRefinementSnapshot, fingerprintRefinementSnapshot, getGenerationTask, runGenerationTask, runRefinementTask, tasksForScope, updateProposalItemPayload } from "../generation";
import { addOutlineNode, createChapter, createNovelProject, deleteChapter, deleteOutlineBranch, novelDb, recordBase, saveApprovedDocumentRevision } from "../db";
import { createChapterMemory, linkOutlineRealization } from "../memory";
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

  it("chapter-arrangement declares a scene boundary so AI does not emit scenes", () => {
    const task = getGenerationTask("chapter-arrangement");
    expect(task.allowedTables).toEqual(["documents"]);
    expect(task.defaultInstruction).toContain("不生成场景");
    expect(task.defaultInstruction).toContain("scenes");
    expect(task.defaultInstruction).toContain("设计场景");
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

describe("structured refinement", () => {
  it("maps every structured workspace to a refinable task", () => {
    expect(getGenerationTask("architecture").refinable).toBe(true);
    expect(getGenerationTask("outline").refinable).toBe(true);
    expect(getGenerationTask("chapter-arrangement").refinable).toBe(true);
    expect(getGenerationTask("chapter-plan").refinable).toBe(true);
    expect(getGenerationTask("scene-design").refinable).toBe(true);
    expect(getGenerationTask("worldview")).toMatchObject({ scope: "worldview", allowedTables: ["entities", "relations"], refinable: true });
    expect(getGenerationTask("chapter-draft").refinable).not.toBe(true);
    expect(getGenerationTask("review").refinable).not.toBe(true);
  });

  it("builds a scoped snapshot and lets the visible draft override persisted data", async () => {
    const project = await createNovelProject({ title: "草稿快照", genre: ["悬疑"], premise: "城市会忘记昨天。" });
    const character = { ...recordBase(project.id), kind: "character" as const, name: "旧名字", aliases: [], summary: "", description: "", tags: [], lockedFacts: [], attributes: {}, character: characterPayload("旧名字").character };
    const location = { ...recordBase(project.id), kind: "location" as const, name: "旧车站", aliases: [], summary: "", description: "", tags: [], lockedFacts: [], attributes: {} };
    await novelDb.entities.bulkAdd([character, location]);

    const characters = await buildRefinementSnapshot({ projectId: project.id, taskKey: "characters", sourceOverrides: { entities: [{ ...character, name: "屏幕中的名字" }] } });
    expect(characters.entities).toHaveLength(1);
    expect(characters.entities?.[0].data.name).toBe("屏幕中的名字");
    expect(characters.entities?.[0].data).not.toHaveProperty("projectId");

    const worldview = await buildRefinementSnapshot({ projectId: project.id, taskKey: "worldview" });
    expect(worldview.entities?.map((item) => item.data.name)).toEqual(["旧车站"]);
  });

  it("sends original structured data and produces a reviewable merged update", async () => {
    const project = await createNovelProject({ title: "微调项目", genre: ["悬疑"], premise: "城市会忘记昨天。" });
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "收紧语气", items: [{ label: "调整基调", operation: "update", targetTable: "projects", targetId: project.id, payload: { tone: "冷峻克制" }, rationale: "符合提示" }] },
      usage: { inputTokens: 20, outputTokens: 10 },
      promptHash: "refine-hash",
    });

    const result = await runRefinementTask({ projectId: project.id, taskKey: "project-positioning", instruction: "只把整体基调改得冷峻克制" });
    const prompt = vi.mocked(callStructuredNovelModel).mock.calls.at(-1)?.[0].prompt ?? "";
    expect(prompt).toContain("只把整体基调改得冷峻克制");
    expect(prompt).toContain("原始结构化数据");
    expect(prompt).toContain(project.premise);
    expect(result.proposal).toMatchObject({ generationMode: "refine", sourceFingerprint: expect.any(String) });
    expect(result.proposal.items[0]).toMatchObject({ operation: "update", targetId: project.id, before: expect.objectContaining({ tone: project.tone }), after: expect.objectContaining({ tone: "冷峻克制", title: project.title }) });
  });

  it("rejects a refinement operation aimed outside the supplied snapshot", async () => {
    const project = await createNovelProject({ title: "越权测试", genre: ["悬疑"], premise: "档案会说谎。" });
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "越权", items: [{ label: "未知项目", operation: "update", targetTable: "projects", targetId: "not-in-source", payload: { tone: "错误" }, rationale: "错误" }] },
      usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "bad-target",
    });
    await expect(runRefinementTask({ projectId: project.id, taskKey: "project-positioning", instruction: "调整基调" })).rejects.toThrow(/未提供的对象/);
  });

  it("rejects acceptance when the visible source fingerprint changed", async () => {
    const project = await createNovelProject({ title: "指纹冲突", genre: ["悬疑"], premise: "每次编辑都会留下指纹。" });
    const draft = proposal(project.id, [{ id: "update", label: "调整", operation: "update", targetTable: "projects", targetId: project.id, expectedRevision: project.revision, status: "pending", payload: { tone: "新基调" }, rationale: "测试", dependencies: [] }]);
    draft.generationMode = "refine";
    draft.sourceFingerprint = await fingerprintRefinementSnapshot(await buildRefinementSnapshot({ projectId: project.id, taskKey: "project-positioning" }));
    await novelDb.proposals.add(draft);
    await expect(applyProposalItems(draft.id, ["update"], { sourceFingerprint: "changed" })).rejects.toThrow(/原数据已在微调后发生变化/);
  });

  it("deletes an entity and atomically clears cross-table references", async () => {
    const project = await createNovelProject({ title: "删除清理", genre: ["悬疑"], premise: "被遗忘的人会从所有记录消失。" });
    const entity: StoryEntity = { ...recordBase(project.id), kind: "character", name: "待删除角色", aliases: [], summary: "", description: "", tags: [], lockedFacts: [], attributes: {}, character: characterPayload("待删除角色").character };
    const other: StoryEntity = { ...recordBase(project.id), kind: "character", name: "保留角色", aliases: [], summary: "", description: "", tags: [], lockedFacts: [], attributes: {}, character: characterPayload("保留角色").character };
    await novelDb.entities.bulkAdd([entity, other]);
    await novelDb.relations.add({ ...recordBase(project.id), fromEntityId: entity.id, toEntityId: other.id, relationType: "同伴", publicLabel: "同伴", privateTruth: "旧识", bond: "", history: [] });
    const node = await addOutlineNode(project.id, undefined, "event", "相遇", 0);
    await novelDb.outlineNodes.update(node.id, { characterIds: [entity.id, other.id] });
    const thread = { ...recordBase(project.id), kind: "main" as const, title: "主线", summary: "", status: "active" as const, priority: 90, participantIds: [entity.id, other.id], progress: 10, nextMove: "继续" };
    await novelDb.plotThreads.add(thread);
    const event = { ...recordBase(project.id), title: "昨日", storyDate: "第一天", duration: "1小时", narrativeOrder: 0, participantIds: [entity.id, other.id], causeIds: [], consequenceIds: [], description: "" };
    await novelDb.timelineEvents.add(event);
    const draft = proposal(project.id, [{ id: "delete-entity", label: "删除角色", operation: "delete", targetTable: "entities", targetId: entity.id, expectedRevision: entity.revision, before: entity as unknown as Record<string, unknown>, status: "pending", payload: {}, rationale: "按要求删除", dependencies: [] }]);
    draft.generationMode = "refine";
    await novelDb.proposals.add(draft);

    await applyProposalItems(draft.id, ["delete-entity"]);
    expect(await novelDb.entities.get(entity.id)).toBeUndefined();
    expect(await novelDb.relations.where("projectId").equals(project.id).count()).toBe(0);
    expect((await novelDb.outlineNodes.get(node.id))?.characterIds).toEqual([other.id]);
    expect((await novelDb.plotThreads.get(thread.id))?.participantIds).toEqual([other.id]);
    expect((await novelDb.timelineEvents.get(event.id))?.participantIds).toEqual([other.id]);
  });

  it("includes real reference ids and accepts them in generated outline candidates", async () => {
    const project = await createNovelProject({ title: "引用目录", genre: ["悬疑"], premise: "真实标识不可被猜测。" });
    const character: StoryEntity = { ...recordBase(project.id), kind: "character", name: "陆沉", aliases: [], summary: "", description: "", tags: [], lockedFacts: [], attributes: {}, character: characterPayload("陆沉").character };
    const thread = { ...recordBase(project.id), kind: "main" as const, title: "失踪主线", summary: "", status: "planned" as const, priority: 80, participantIds: [character.id], progress: 0, nextMove: "追查" };
    const clue = { ...recordBase(project.id), title: "缺页", clue: "档案缺页", truth: "有人删改", status: "seeded" as const, urgency: 60, notes: "" };
    await novelDb.entities.add(character);
    await novelDb.plotThreads.add(thread);
    await novelDb.foreshadowing.add(clue);
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "大纲", items: [
        { label: "第一幕", operation: "create", targetTable: "outlineNodes", tempId: "act", payload: { kind: "act", title: "第一幕", summary: "开端", order: 0, causality: "异常", outcome: "调查" }, rationale: "开端" },
        { label: "追查序列", operation: "create", targetTable: "outlineNodes", tempId: "sequence", payload: { parentId: "ref:act", kind: "sequence", title: "追查", summary: "追查", order: 0, causality: "发现缺页", outcome: "锁定线索" }, rationale: "推进" },
        { label: "发现缺页", operation: "create", targetTable: "outlineNodes", tempId: "event", payload: { parentId: "ref:sequence", kind: "event", title: "发现缺页", summary: "陆沉发现缺页", order: 0, causality: "档案异常", outcome: "开始调查", characterIds: [character.id], plotThreadIds: [thread.id], foreshadowingIds: [clue.id] }, rationale: "事件" },
      ] },
      usage: { inputTokens: 10, outputTokens: 10 }, promptHash: "reference-catalog",
    });

    const result = await runGenerationTask({ projectId: project.id, taskKey: "outline", instruction: "生成大纲" });
    const prompt = vi.mocked(callStructuredNovelModel).mock.calls.at(-1)?.[0].prompt ?? "";

    expect(prompt).toContain("可引用对象索引");
    expect(prompt).toContain(`id=${character.id} | ${character.name}`);
    expect(prompt).toContain(`id=${thread.id} | ${thread.title}`);
    expect(prompt).toContain(`id=${clue.id} | ${clue.title}`);
    expect(result.proposal.items[2].payload).toMatchObject({ characterIds: [character.id], plotThreadIds: [thread.id], foreshadowingIds: [clue.id] });
  });

  it("rejects invented references before saving a generated proposal", async () => {
    const project = await createNovelProject({ title: "拒绝假引用", genre: ["悬疑"], premise: "规则名不能冒充伏笔。" });
    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce({
      data: { summary: "错误大纲", items: [
        { label: "第一幕", operation: "create", targetTable: "outlineNodes", tempId: "act", payload: { kind: "act", title: "第一幕", summary: "开端", order: 0, causality: "异常", outcome: "调查" }, rationale: "开端" },
        { label: "追查序列", operation: "create", targetTable: "outlineNodes", tempId: "sequence", payload: { parentId: "ref:act", kind: "sequence", title: "追查", summary: "追查", order: 0, causality: "异常", outcome: "推进" }, rationale: "推进" },
        { label: "流民队伍规则", operation: "create", targetTable: "outlineNodes", tempId: "event", payload: { parentId: "ref:sequence", kind: "event", title: "规则", summary: "学习规则", order: 0, causality: "求生", outcome: "适应", plotThreadIds: ["survival_thread"], foreshadowingIds: ["human_rule_foreshadowing"] }, rationale: "事件" },
      ] },
      usage: { inputTokens: 10, outputTokens: 10 }, promptHash: "invented-reference",
    });

    await expect(runGenerationTask({ projectId: project.id, taskKey: "outline", instruction: "生成大纲" })).rejects.toThrow(/流民队伍规则.*plotThreadIds.*survival_thread/);
    expect(await novelDb.proposals.where("projectId").equals(project.id).count()).toBe(0);
  });
});

describe("structured proposal application", () => {
  it("applies only the accepted fields from an update candidate", async () => {
    const project = await createNovelProject({ title: "字段采纳", genre: ["悬疑"], premise: "每次选择都会留下记录。" });
    const entity: StoryEntity = { ...recordBase(project.id), kind: "item", name: "旧档案", aliases: [], summary: "旧摘要", description: "旧描述", tags: [], lockedFacts: [], attributes: {} };
    await novelDb.entities.add(entity);
    const draft = proposal(project.id, [{
      id: "update",
      label: "补充档案",
      operation: "update",
      targetTable: "entities",
      targetId: entity.id,
      expectedRevision: entity.revision,
      status: "pending",
      before: entity as unknown as Record<string, unknown>,
      payload: { summary: "新摘要", description: "新描述" },
      rationale: "补充细节",
      dependencies: [],
    }]);
    await novelDb.proposals.add(draft);

    await applyProposalItems(draft.id, ["update"], { selectedFields: { update: ["summary"] } });

    expect(await novelDb.entities.get(entity.id)).toMatchObject({ summary: "新摘要", description: "旧描述" });
    expect((await novelDb.proposals.get(draft.id))?.items[0]).toMatchObject({ status: "accepted", acceptedFields: ["summary"] });
  });

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
    const outlineProposal = proposal(project.id, [
      { id: "act", label: "第一幕", operation: "create", targetTable: "outlineNodes", tempId: "act-one", status: "pending", payload: { kind: "act", title: "第一幕", summary: "异常出现", order: 0, causality: "档案失真", outcome: "调查开始" }, rationale: "开端", dependencies: [] },
      { id: "sequence", label: "缺页序列", operation: "create", targetTable: "outlineNodes", tempId: "sequence-one", status: "pending", payload: { parentId: "ref:act-one", kind: "sequence", title: "缺页序列", summary: "追查记录", order: 0, causality: "记录异常", outcome: "锁定缺页" }, rationale: "推进", dependencies: [] },
      { id: "event", label: "陆沉发现缺页", operation: "create", targetTable: "outlineNodes", tempId: "event-one", status: "pending", payload: { parentId: "ref:sequence-one", kind: "event", title: "发现缺页", summary: "陆沉发现档案缺页", order: 0, causality: "记录异常", outcome: "开始调查", characterIds: ["ref:character_luchen"] }, rationale: "开端事件", dependencies: [] },
    ]);
    outlineProposal.taskKey = "outline";
    outlineProposal.scope = "outline";
    await novelDb.proposals.add(outlineProposal);
    await applyProposalItems(outlineProposal.id, outlineProposal.items.map((item) => item.id));
    const outlineEvent = await novelDb.outlineNodes.where("projectId").equals(project.id).filter((item) => item.kind === "event").first();
    expect(outlineEvent?.characterIds).toEqual([entity.id]);
  });

  it("replaces the complete outline instead of appending generated nodes", async () => {
    const project = await createNovelProject({ title: "整树替换", genre: ["悬疑"], premise: "旧结构必须让位给新结构。" });
    const oldAct = await addOutlineNode(project.id, undefined, "act", "旧第一幕", 0);
    const oldEvent = await addOutlineNode(project.id, oldAct.id, "event", "旧孤立事件", 0);
    const chapter = await createChapter(project.id, "旧事件章节");
    const realization = await linkOutlineRealization({ projectId: project.id, outlineNodeId: oldEvent.id, documentId: chapter.id });
    const draft = proposal(project.id, [
      { id: "act", label: "新第一幕", operation: "create", targetTable: "outlineNodes", tempId: "act-new", status: "pending", payload: { kind: "act", title: "新第一幕", summary: "开端", order: 0, causality: "旧秩序", outcome: "冲突爆发" }, rationale: "完整替换", dependencies: [] },
      { id: "sequence", label: "进入冲突", operation: "create", targetTable: "outlineNodes", tempId: "sequence-new", status: "pending", payload: { parentId: "ref:act-new", kind: "sequence", title: "进入冲突", summary: "选择", order: 0, causality: "被迫行动", outcome: "无法回头" }, rationale: "完整替换", dependencies: [] },
      { id: "event", label: "门被打开", operation: "create", targetTable: "outlineNodes", tempId: "event-new", status: "pending", payload: { parentId: "ref:sequence-new", kind: "event", title: "门被打开", summary: "关键事件", order: 0, causality: "主角选择", outcome: "秘密暴露" }, rationale: "完整替换", dependencies: [] },
    ]);
    draft.taskKey = "outline";
    draft.scope = "outline";
    await novelDb.proposals.add(draft);

    const result = await applyProposalItems(draft.id, draft.items.map((item) => item.id));

    expect(result.applied).toBe(3);
    expect(await novelDb.outlineNodes.get(oldAct.id)).toBeUndefined();
    const stored = await novelDb.outlineNodes.where("projectId").equals(project.id).toArray();
    expect(stored.map((item) => item.title).sort()).toEqual(["新第一幕", "进入冲突", "门被打开"].sort());
    const act = stored.find((item) => item.kind === "act")!;
    const sequence = stored.find((item) => item.kind === "sequence")!;
    const event = stored.find((item) => item.kind === "event")!;
    expect(sequence.parentId).toBe(act.id);
    expect(event.parentId).toBe(sequence.id);
    expect(await novelDb.outlineRealizations.get(realization.id)).toBeUndefined();
  });

  it("stores the formal target id on accepted temporary objects", async () => {
    const project = await createNovelProject({ title: "引用落盘", genre: ["都市"], premise: "人物拥有稳定标识。" });
    const draft = proposal(project.id, [{ id: "character", label: "林澈", operation: "create", targetTable: "entities", tempId: "character_linche", status: "pending", payload: characterPayload("林澈"), rationale: "主角", dependencies: [] }]);
    await novelDb.proposals.add(draft);
    await applyProposalItems(draft.id, ["character"]);
    const stored = await novelDb.proposals.get(draft.id);
    expect(stored?.items[0].targetId).toBe((await novelDb.entities.where("projectId").equals(project.id).first())?.id);
  });

  it("accepts valid same-proposal temporary references", async () => {
    const project = await createNovelProject({ title: "同批引用", genre: ["悬疑"], premise: "新角色立即进入新剧情线。" });
    const draft = proposal(project.id, [
      { id: "character", label: "林澈", operation: "create", targetTable: "entities", tempId: "character_linche", status: "pending", payload: characterPayload("林澈"), rationale: "主角", dependencies: [] },
      { id: "thread", label: "调查主线", operation: "create", targetTable: "plotThreads", tempId: "thread_main", status: "pending", payload: { kind: "main", title: "调查主线", summary: "追查档案", status: "planned", priority: 80, participantIds: ["ref:character_linche"], progress: 0, nextMove: "进入档案馆" }, rationale: "主线", dependencies: ["character_linche"] },
    ]);
    await novelDb.proposals.add(draft);

    await applyProposalItems(draft.id, ["character", "thread"]);

    const character = await novelDb.entities.where("projectId").equals(project.id).first();
    const thread = await novelDb.plotThreads.where("projectId").equals(project.id).first();
    expect(thread?.participantIds).toEqual([character?.id]);
  });

  it("revalidates references at acceptance time and rolls back the whole proposal", async () => {
    const project = await createNovelProject({ title: "采纳前复核", genre: ["悬疑"], premise: "候选等待期间角色可能被删除。" });
    const character: StoryEntity = { ...recordBase(project.id), kind: "character", name: "即将删除", aliases: [], summary: "", description: "", tags: [], lockedFacts: [], attributes: {}, character: characterPayload("即将删除").character };
    await novelDb.entities.add(character);
    const oldNode = await addOutlineNode(project.id, undefined, "act", "保留的旧大纲", 0);
    const draft = proposal(project.id, [
      { id: "act", label: "第一幕", operation: "create", targetTable: "outlineNodes", tempId: "act", status: "pending", payload: { kind: "act", title: "第一幕", summary: "开端", order: 0, causality: "异常", outcome: "调查" }, rationale: "开端", dependencies: [] },
      { id: "sequence", label: "追查序列", operation: "create", targetTable: "outlineNodes", tempId: "sequence", status: "pending", payload: { parentId: "ref:act", kind: "sequence", title: "追查", summary: "追查", order: 0, causality: "异常", outcome: "推进" }, rationale: "推进", dependencies: [] },
      { id: "event", label: "角色行动", operation: "create", targetTable: "outlineNodes", tempId: "event", status: "pending", payload: { parentId: "ref:sequence", kind: "event", title: "行动", summary: "角色行动", order: 0, causality: "发现线索", outcome: "开始调查", characterIds: [character.id] }, rationale: "事件", dependencies: [] },
    ]);
    draft.taskKey = "outline";
    draft.scope = "outline";
    await novelDb.proposals.add(draft);
    await novelDb.entities.delete(character.id);

    await expect(applyProposalItems(draft.id, draft.items.map((item) => item.id))).rejects.toThrow(/角色行动.*characterIds/);
    expect(await novelDb.outlineNodes.get(oldNode.id)).toBeDefined();
    expect((await novelDb.proposals.get(draft.id))?.status).toBe("pending");
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
    const event = await addOutlineNode(project.id, act.id, "event", "跃迁失败", 0);
    const chapter = await createChapter(project.id, "第一章");
    const realization = await linkOutlineRealization({ projectId: project.id, outlineNodeId: event.id, documentId: chapter.id });
    await deleteOutlineBranch(project.id, act.id);
    expect(await novelDb.outlineNodes.where("projectId").equals(project.id).count()).toBe(0);
    expect((await novelDb.documents.get(chapter.id))?.title).toBe("第一章");
    expect(await novelDb.outlineRealizations.get(realization.id)).toBeUndefined();
  });

  it("deleting a chapter cascades through chapter-owned records", async () => {
    const project = await createNovelProject({ title: "级联测试", genre: ["悬疑"], premise: "每个证词都会消失。" });
    const chapter = await createChapter(project.id, "证词");
    const scene = { ...recordBase(project.id), chapterId: chapter.id, title: "审讯", order: 0, status: "planned" as const, characterIds: [], plotThreadIds: [], foreshadowingIds: [], purpose: "取证", conflict: "拒绝作证", outcome: "证词消失", wordTarget: 900, beats: [] };
    await novelDb.scenes.add(scene);
    const approved = await saveApprovedDocumentRevision({ ...chapter, plainText: "证人开口。", contentHtml: "<p>证人开口。</p>", wordCount: 5, status: "review" }, "版本", "manual");
    const assertion = {
      ...recordBase(project.id),
      id: "fact-deleted-chapter",
      subject: { kind: "project" as const, id: project.id },
      predicate: "testimony.exists",
      object: { kind: "boolean" as const, value: true },
      polarity: "affirmed" as const,
      truthStatus: "objective" as const,
      timeMode: "point" as const,
      revealedAt: { chapterId: chapter.id, narrativeOrder: chapter.order, precision: "exact" as const },
      sourceRevisionId: approved.revision.id,
      provenance: "approved-revision" as const,
      evidence: "证人开口。",
      confidence: 1,
      humanReadable: "证词存在",
      status: "active" as const,
      derivedFromCandidateId: "candidate-deleted-chapter",
    };
    await novelDb.factAssertions.add(assertion);
    const knowledge = { ...recordBase(project.id), id: "knowledge-deleted-chapter", characterId: "character-1", factAssertionId: assertion.id, stance: "known" as const, sourceRevisionId: approved.revision.id, status: "active" as const };
    await novelDb.knowledgeAssertions.add(knowledge);
    const memory = await createChapterMemory({ projectId: project.id, documentId: chapter.id, sourceRevisionId: approved.revision.id, summary: "证人留下证词" });
    const outline = await addOutlineNode(project.id, undefined, "event", "证人作证", 0);
    const realization = await linkOutlineRealization({ projectId: project.id, outlineNodeId: outline.id, documentId: chapter.id });
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
    expect((await novelDb.factAssertions.get(assertion.id))?.status).toBe("retracted");
    expect((await novelDb.knowledgeAssertions.get(knowledge.id))?.status).toBe("retracted");
    expect((await novelDb.derivedMemories.get(memory.id))?.status).toBe("stale");
    expect(await novelDb.outlineRealizations.get(realization.id)).toBeUndefined();
  });

  it("retires chapter truth and memory when a structured proposal deletes the chapter", async () => {
    const project = await createNovelProject({ title: "提案删章", genre: ["悬疑"], premise: "被放弃的章节不能继续定义事实。" });
    const chapter = await createChapter(project.id, "废弃章节");
    const approved = await saveApprovedDocumentRevision({ ...chapter, plainText: "旧门已经打开。", contentHtml: "<p>旧门已经打开。</p>", wordCount: 7, status: "review" }, "批准", "manual");
    const assertion = {
      ...recordBase(project.id),
      id: "fact-proposal-deleted-chapter",
      subject: { kind: "project" as const, id: project.id },
      predicate: "door.opened",
      object: { kind: "boolean" as const, value: true },
      polarity: "affirmed" as const,
      truthStatus: "objective" as const,
      timeMode: "point" as const,
      revealedAt: { chapterId: chapter.id, narrativeOrder: chapter.order, precision: "exact" as const },
      sourceRevisionId: approved.revision.id,
      provenance: "approved-revision" as const,
      evidence: "旧门已经打开。",
      confidence: 1,
      humanReadable: "旧门已经打开",
      status: "active" as const,
      derivedFromCandidateId: "candidate-proposal-deleted-chapter",
    };
    await novelDb.factAssertions.add(assertion);
    const memory = await createChapterMemory({ projectId: project.id, documentId: chapter.id, sourceRevisionId: approved.revision.id, summary: "旧门打开" });
    const outline = await addOutlineNode(project.id, undefined, "event", "打开旧门", 0);
    const realization = await linkOutlineRealization({ projectId: project.id, outlineNodeId: outline.id, documentId: chapter.id });
    const deletion = proposal(project.id, [{ id: "delete-document", label: "删除废弃章节", operation: "delete", targetTable: "documents", targetId: chapter.id, expectedRevision: approved.document.revision, before: approved.document as unknown as Record<string, unknown>, status: "pending", payload: {}, rationale: "作者放弃该章节", dependencies: [] }]);
    deletion.generationMode = "refine";
    await novelDb.proposals.add(deletion);

    await applyProposalItems(deletion.id, ["delete-document"]);

    expect(await novelDb.documents.get(chapter.id)).toBeUndefined();
    expect((await novelDb.factAssertions.get(assertion.id))?.status).toBe("retracted");
    expect((await novelDb.derivedMemories.get(memory.id))?.status).toBe("stale");
    expect(await novelDb.outlineRealizations.get(realization.id)).toBeUndefined();
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
