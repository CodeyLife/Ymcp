import { beforeEach, describe, expect, it } from "vitest";
import { compileNovelContext } from "../context";
import { createChapter, createNovelProject, novelDb, recordBase, saveStoryArchitecture, updateProject } from "../db";
import { commitAcceptedFacts, setFactCandidateStatus, storeFactCandidates } from "../facts";
import type { StoryEntity } from "../types";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
});

describe("context invariants and fact commits", () => {
  it("keeps locked rules when the context budget is exhausted", async () => {
    const project = await createNovelProject({ title: "规则测试", genre: ["奇幻"], premise: "潮水会改变记忆。" });
    await updateProject(project.id, { settings: { ...project.settings, contextBudget: 120 } });
    const rule: StoryEntity = { ...recordBase(project.id), kind: "rule", name: "潮汐规则", aliases: [], summary: "退潮前不可说出失踪者姓名", description: "潮水".repeat(1200), tags: [], lockedFacts: ["退潮前说出姓名会让说话者失去相关记忆"], attributes: {} };
    await novelDb.entities.add(rule);
    const packet = await compileNovelContext({ projectId: project.id, task: "planning", instruction: "规划第一章", stage: "planning" });
    const source = packet.sources.find((item) => item.id === rule.id);
    expect(source).toMatchObject({ pinned: true, priorityClass: "invariant", truncated: true });
    expect(source?.contentHash).toMatch(/^[a-f0-9]{8}$/);
    expect(packet.omittedSourceIds.length).toBeGreaterThan(0);
  });

  it("pins approved architecture and the target chapter scene plan", async () => {
    const project = await createNovelProject({ title: "架构测试", genre: ["科幻"], premise: "城市每天失去一小时。" });
    const architecture = await novelDb.architectures.where("projectId").equals(project.id).first();
    await saveStoryArchitecture({
      ...architecture!,
      status: "approved",
      endingPromise: "主角决定保留所有人遗忘的代价。",
      phases: [{ id: "phase-1", title: "中段升级", purpose: "主角发现丢失的时间被人保存。", turningPoint: "主角决定夺回时间。", order: 0, locked: true }],
    });
    const document = await createChapter(project.id, "第一章");
    await novelDb.scenes.add({
      ...recordBase(project.id),
      chapterId: document.id,
      title: "钟楼对峙",
      order: 0,
      status: "planned",
      characterIds: [],
      purpose: "揭示时间存储装置",
      conflict: "主角必须决定是否关闭装置",
      outcome: "装置继续运行，但代价转移给主角",
      wordTarget: 1200,
      beats: [{ id: "scene-beat-1", text: "主角启动逆向计时", order: 0 }],
    });
    const packet = await compileNovelContext({ projectId: project.id, task: "rewrite", instruction: "检查本章是否兑现架构", targetDocumentId: document!.id, stage: "revision" });
    expect(packet.sources.find((source) => source.kind === "architecture")).toMatchObject({ pinned: true, priorityClass: "invariant" });
    expect(packet.sources.find((source) => source.kind === "scene" && source.title.includes("钟楼对峙"))).toMatchObject({ pinned: true, priorityClass: "working" });
  });

  it("commits only accepted non-conflicting facts and writes an operation", async () => {
    const project = await createNovelProject({ title: "事实测试", genre: ["悬疑"], premise: "档案会改写现实。" });
    const entity: StoryEntity = { ...recordBase(project.id), kind: "item", name: "黑色账本", aliases: [], summary: "尚未发现", description: "", tags: [], lockedFacts: [], attributes: {} };
    await novelDb.entities.add(entity);
    const [accepted, conflict] = await storeFactCandidates({ projectId: project.id, workflowRunId: "run-1", sourceArtifactId: "draft-1", facts: [
      { targetTable: "entities", targetId: entity.id, field: "summary", before: "尚未发现", after: "被主角藏在钟楼", evidence: "他把黑色账本塞进钟楼夹层。", confidence: 0.96, novelty: "update", conflict: false },
      { targetTable: "entities", targetId: entity.id, field: "description", after: "自动消失", evidence: "可疑描述", confidence: 0.5, novelty: "update", conflict: true },
    ] });
    await setFactCandidateStatus(accepted.id, "accepted");
    await setFactCandidateStatus(conflict.id, "accepted");
    const committed = await commitAcceptedFacts(project.id, "run-1");
    expect(committed).toEqual([accepted.id]);
    expect((await novelDb.entities.get(entity.id))?.summary).toBe("被主角藏在钟楼");
    expect((await novelDb.entities.get(entity.id))?.description).toBe("");
    expect((await novelDb.operations.where("projectId").equals(project.id).toArray()).filter((item) => item.entityId === entity.id)).toHaveLength(1);
  });
});
