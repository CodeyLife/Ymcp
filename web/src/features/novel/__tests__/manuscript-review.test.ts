import { beforeEach, describe, expect, it } from "vitest";
import { createChapter, createNovelProject, novelDb, saveApprovedDocumentRevision, saveDocument, saveDocumentContent } from "../db";
import { applyManuscriptChanges, planManuscriptChanges, prepareManuscriptChanges } from "../manuscript-review";
import type { ManuscriptBlock } from "../types";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
});

describe("paragraph manuscript review", () => {
  it("autosaves content without overwriting concurrent document metadata", async () => {
    const project = await createNovelProject({ title: "自动保存", genre: ["都市"], premise: "正文持续落盘。" });
    const chapter = await createChapter(project.id, "第一章");
    const approved = await saveApprovedDocumentRevision({ ...chapter, plainText: "基线。", contentHtml: "<p>基线。</p>", wordCount: 3, status: "review", primaryNarrativeUnitId: "sequence-1" }, "基线", "manual");

    const saved = await saveDocumentContent({ documentId: chapter.id, plainText: "继续写作。", contentHtml: "<p>继续写作。</p>", wordCount: 5 });

    expect(saved).toMatchObject({ approvedRevisionId: approved.revision.id, primaryNarrativeUnitId: "sequence-1", plainText: "继续写作。" });
  });

  it("plans a first draft as individually reviewable paragraph insertions", () => {
    let nextId = 0;
    const plan = planManuscriptChanges([], "第一段。\n\n第二段。", () => `new-${++nextId}`);
    expect(plan.changes).toMatchObject([
      { operation: "insert", proposedBlockId: "new-1", order: 0, afterText: "第一段。" },
      { operation: "insert", proposedBlockId: "new-2", order: 1, afterText: "第二段。" },
    ]);
  });

  it("keeps the stable block id when a paragraph is replaced", () => {
    const base: ManuscriptBlock[] = [
      { id: "a", order: 0, text: "旧第一段。", kind: "paragraph" },
      { id: "b", order: 1, text: "第二段。", kind: "paragraph" },
    ];
    const plan = planManuscriptChanges(base, "新第一段。\n\n第二段。", () => "unused");
    expect(plan.changes).toMatchObject([{ operation: "replace", targetBlockId: "a", proposedBlockId: "a" }]);
    expect(plan.proposedBlocks.map((block) => block.id)).toEqual(["a", "b"]);
  });

  it("applies only selected paragraph changes and records the rejected remainder", async () => {
    const project = await createNovelProject({ title: "逐段审批", genre: ["悬疑"], premise: "记录会留下版本。" });
    const chapter = await createChapter(project.id, "第一章");
    const blocks: ManuscriptBlock[] = [
      { id: "a", order: 0, text: "旧第一段。", kind: "paragraph" },
      { id: "b", order: 1, text: "第二段。", kind: "paragraph" },
    ];
    const approved = await saveApprovedDocumentRevision({ ...chapter, plainText: "旧第一段。\n\n第二段。", contentHtml: "<p>旧第一段。</p><p>第二段。</p>", wordCount: 9, status: "review" }, "基线", "manual", { blocks });
    const changes = await prepareManuscriptChanges({
      projectId: project.id,
      documentId: chapter.id,
      proposedText: "新第一段。\n\n第二段。\n\n新增第三段。",
      sourceArtifactId: "artifact-1",
    });
    const replace = changes.find((change) => change.operation === "replace")!;
    const insert = changes.find((change) => change.operation === "insert")!;

    const result = await applyManuscriptChanges({ documentId: chapter.id, sourceArtifactId: "artifact-1", selectedChangeIds: [replace.id], label: "部分采纳" });

    expect(result.document.plainText).toBe("新第一段。\n\n第二段。");
    expect(result.revision.parentRevisionId).toBe(approved.revision.id);
    expect(result.revision.blocks?.map((block) => block.id)).toEqual(["a", "b"]);
    expect((await novelDb.manuscriptChanges.get(replace.id))?.status).toBe("accepted");
    expect((await novelDb.manuscriptChanges.get(insert.id))?.status).toBe("rejected");
  });

  it("marks review changes conflicted when the chapter changes after preparation", async () => {
    const project = await createNovelProject({ title: "冲突审批", genre: ["都市"], premise: "作者仍可继续编辑。" });
    const chapter = await createChapter(project.id, "第一章");
    const approved = await saveApprovedDocumentRevision({ ...chapter, plainText: "原文。", contentHtml: "<p>原文。</p>", wordCount: 3, status: "review" }, "基线", "manual");
    const changes = await prepareManuscriptChanges({ projectId: project.id, documentId: chapter.id, proposedText: "AI 改写。", sourceArtifactId: "artifact-2" });
    await saveDocument({ ...approved.document, plainText: "作者刚刚修改。", contentHtml: "<p>作者刚刚修改。</p>" });

    await expect(applyManuscriptChanges({ documentId: chapter.id, sourceArtifactId: "artifact-2", selectedChangeIds: changes.map((change) => change.id), label: "不应成功" })).rejects.toThrow(/基线已发生变化/);
    expect((await novelDb.manuscriptChanges.get(changes[0].id))?.status).toBe("conflict");
    expect((await novelDb.documents.get(chapter.id))?.plainText).toBe("作者刚刚修改。");
  });
});
