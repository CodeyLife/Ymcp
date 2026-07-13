import { beforeEach, describe, expect, it } from "vitest";
import { compileNovelContext } from "../context";
import { createNovelProject, novelDb, recordBase, updateProject } from "../db";
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
