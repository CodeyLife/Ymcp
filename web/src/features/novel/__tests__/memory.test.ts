import { beforeEach, describe, expect, it } from "vitest";

import { createChapter, createNovelProject, novelDb, recordBase, saveApprovedDocumentRevision } from "../db";
import { assignChapterToSequence, consolidateDerivedMemory, createChapterMemory, createNarrativeUnit, linkOutlineRealization } from "../memory";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
});

async function seedHierarchy(projectId: string) {
  const volume = await createNarrativeUnit({ projectId, kind: "volume", title: "第一卷", order: 0 });
  const arc = await createNarrativeUnit({ projectId, kind: "arc", parentId: volume.id, title: "北港谜案", order: 0 });
  const sequence = await createNarrativeUnit({ projectId, kind: "sequence", parentId: arc.id, title: "抵达北港", order: 0 });
  return { volume, arc, sequence };
}

describe("narrative ownership", () => {
  it("enforces volume -> arc -> sequence ownership and one primary chapter sequence", async () => {
    const project = await createNovelProject({ title: "叙事层级", genre: ["悬疑"], premise: "章节有唯一整合位置。" });
    const chapter = await createChapter(project.id, "第一章");
    const hierarchy = await seedHierarchy(project.id);
    await assignChapterToSequence(chapter.id, hierarchy.sequence.id);
    expect((await novelDb.documents.get(chapter.id))?.primaryNarrativeUnitId).toBe(hierarchy.sequence.id);
    await expect(createNarrativeUnit({ projectId: project.id, kind: "sequence", parentId: hierarchy.volume.id, title: "错误序列", order: 1 })).rejects.toThrow(/arc/);
  });

  it("links plot segments to chapters without adding truth state to the planning contract", async () => {
    const project = await createNovelProject({ title: "大纲落实", genre: ["科幻"], premise: "计划与事实保持分离。" });
    const chapter = await createChapter(project.id, "第一章");
    const outline = { ...recordBase(project.id), phaseId: "phase-1", title: "抵达北港", summary: "", order: 0 };
    await novelDb.outlineNodes.add(outline);
    const link = await linkOutlineRealization({ projectId: project.id, outlineNodeId: outline.id, documentId: chapter.id });
    expect(link).toMatchObject({ outlineNodeId: outline.id, documentId: chapter.id, status: "planned" });
    expect(await novelDb.outlineNodes.get(outline.id)).not.toHaveProperty("status");
  });
});

describe("hierarchical memory lifecycle", () => {
  it("cools chapter memories after valid consolidation and preserves every source", async () => {
    const project = await createNovelProject({ title: "记忆整合", genre: ["都市"], premise: "旧章节退出默认上下文但不删除。" });
    const hierarchy = await seedHierarchy(project.id);
    const chapters = await Promise.all([createChapter(project.id, "第一章"), createChapter(project.id, "第二章")]);
    const leaves = [];
    for (const [index, chapter] of chapters.entries()) {
      await assignChapterToSequence(chapter.id, hierarchy.sequence.id);
      const approved = await saveApprovedDocumentRevision({ ...chapter, primaryNarrativeUnitId: hierarchy.sequence.id, plainText: `正文${index + 1}`, contentHtml: `<p>正文${index + 1}</p>`, wordCount: 3, status: "review" }, `批准${index + 1}`, "ai");
      leaves.push(await createChapterMemory({ projectId: project.id, documentId: chapter.id, sourceRevisionId: approved.revision.id, summary: `章节摘要${index + 1}`, content: { inheritedPressures: index === 0 ? ["找到失踪者"] : [] } }));
    }

    const sequenceMemory = await consolidateDerivedMemory({ projectId: project.id, level: "sequence", narrativeUnitId: hierarchy.sequence.id, sourceMemoryIds: leaves.map((memory) => memory.id), summary: "主角抵达北港并开始调查。", content: { inheritedPressures: ["找到失踪者"] } });

    expect(sequenceMemory).toMatchObject({ status: "active", validation: { passed: true }, coverage: { chapterIds: [chapters[0].id, chapters[1].id], startOrder: 0, endOrder: 1 } });
    expect(await novelDb.derivedMemories.where("level").equals("chapter").toArray()).toEqual(expect.arrayContaining([expect.objectContaining({ id: leaves[0].id, status: "cold" }), expect.objectContaining({ id: leaves[1].id, status: "cold" })]));
  });

  it("keeps invalid consolidation pending and propagates revision invalidation upward", async () => {
    const project = await createNovelProject({ title: "记忆失效", genre: ["悬疑"], premise: "失效只重建相关分支。" });
    const hierarchy = await seedHierarchy(project.id);
    const chapter = await createChapter(project.id, "第一章");
    await assignChapterToSequence(chapter.id, hierarchy.sequence.id);
    const approved = await saveApprovedDocumentRevision({ ...chapter, primaryNarrativeUnitId: hierarchy.sequence.id, plainText: "正文", contentHtml: "<p>正文</p>", wordCount: 2, status: "review" }, "批准", "ai");
    const leaf = await createChapterMemory({ projectId: project.id, documentId: chapter.id, sourceRevisionId: approved.revision.id, summary: "章节摘要" });
    const sequence = await consolidateDerivedMemory({ projectId: project.id, level: "sequence", narrativeUnitId: hierarchy.sequence.id, sourceMemoryIds: [leaf.id], summary: "序列摘要" });
    const invalid = await consolidateDerivedMemory({ projectId: project.id, level: "arc", narrativeUnitId: hierarchy.arc.id, sourceMemoryIds: [leaf.id], summary: "错误层级" });
    expect(invalid).toMatchObject({ status: "pending-review", validation: { passed: false } });

    await saveApprovedDocumentRevision({ ...approved.document, plainText: "新正文", contentHtml: "<p>新正文</p>", wordCount: 3 }, "重新批准", "manual");
    expect((await novelDb.derivedMemories.get(leaf.id))?.status).toBe("stale");
    expect((await novelDb.derivedMemories.get(sequence.id))?.status).toBe("stale");
  });
});

// F-019 回归测试：invalidateMemoryAncestors 的 BFS 传播链中存在已 superseded 的中间节点时，
// 该节点不应被重写为 stale。superseded 表示"已被新版本取代、保留为历史"，
// 重写为 stale 会丢失取代关系审计链并误导后续整合判断。
describe("F-019: invalidateMemoryAncestors preserves superseded memories", () => {
  it("does not rewrite superseded memories to stale during BFS propagation", async () => {
    const project = await createNovelProject({ title: "superseded 保留", genre: ["悬疑"], premise: "测试 superseded 记忆不被重写。" });
    const hierarchy = await seedHierarchy(project.id);
    const chapter = await createChapter(project.id, "第一章");
    await assignChapterToSequence(chapter.id, hierarchy.sequence.id);
    const approved = await saveApprovedDocumentRevision({ ...chapter, primaryNarrativeUnitId: hierarchy.sequence.id, plainText: "正文", contentHtml: "<p>正文</p>", wordCount: 2, status: "review" }, "批准", "ai");
    const leaf = await createChapterMemory({ projectId: project.id, documentId: chapter.id, sourceRevisionId: approved.revision.id, summary: "章节摘要" });
    const sequence = await consolidateDerivedMemory({ projectId: project.id, level: "sequence", narrativeUnitId: hierarchy.sequence.id, sourceMemoryIds: [leaf.id], summary: "序列摘要" });

    // 模拟 sequence 被新版本取代（superseded）
    const sequenceMemory = await novelDb.derivedMemories.get(sequence.id);
    expect(sequenceMemory).toBeDefined();
    await novelDb.derivedMemories.update(sequence.id, {
      status: "superseded",
      validation: { passed: true, issues: [], checkedAt: Date.now() },
    });

    // 触发 leaf 失效传播：BFS 应跳过 superseded 的 sequence，不重写为 stale
    await saveApprovedDocumentRevision({ ...approved.document, plainText: "新正文", contentHtml: "<p>新正文</p>", wordCount: 3 }, "重新批准", "manual");

    // leaf 应被重写为 stale（它本身不是 superseded）
    expect((await novelDb.derivedMemories.get(leaf.id))?.status).toBe("stale");
    // sequence 应保持 superseded 状态，不被重写为 stale
    const sequenceAfter = await novelDb.derivedMemories.get(sequence.id);
    expect(sequenceAfter?.status).toBe("superseded");
    // superseded 记忆的 validation.issues 应保持空数组，不应被写入"下层来源已变化"误导信息
    expect(sequenceAfter?.validation.issues).toEqual([]);
  });
});
