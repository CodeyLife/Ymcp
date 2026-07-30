import { describe, expect, it, vi } from "vitest";
import type { Client } from "@temporalio/client";
import { buildChapterTitlePrompt, chapterTitleSourceFingerprint, normalizeChapterTitle } from "../application/chapter-title";
import { startChapterTitleGeneration } from "../application/chapter-title-workflow";
import { NovelPostgresRepository } from "../postgres-repository";

const source = {
  projectTitle: "长夜归舟",
  documentId: "chapter-7",
  currentTitle: "第七章",
  narrativeOrder: 7,
  chapterGoal: "主角从旧账簿中发现全城共同隐瞒的名字",
  blueprint: { summary: "雨夜查账，缺页处留下盐渍指纹", chapterPurpose: "让调查第一次指向主角父亲" },
  blueprintFingerprint: "blueprint-fp",
  contentHash: "content-fp",
  plainText: "雨落在账房青瓦上。他翻到缺页，盐粒在灯下泛白。",
};

describe("chapter title generation", () => {
  it("prefers four Chinese characters without making length more important than accuracy", () => {
    const prompt = buildChapterTitlePrompt(source);
    expect(prompt).toContain("优先采用四个汉字");
    expect(prompt).toContain("内容贴合度高于机械凑成四字");
    expect(prompt).toContain("盐渍指纹");
    expect(normalizeChapterTitle({ title: "第七章：盐痕旧账" })).toBe("盐痕旧账");
    expect(normalizeChapterTitle({ title: "雨夜账簿失踪" })).toBe("雨夜账簿失踪");
  });

  it("rejects non-Chinese or decorative model output", () => {
    expect(() => normalizeChapterTitle({ title: "Chapter Seven" })).toThrow("中文标题");
    expect(normalizeChapterTitle({ title: "《灯下盐痕》" })).toBe("灯下盐痕");
  });

  it("changes its source fingerprint when title, blueprint, or content changes", () => {
    const fingerprint = chapterTitleSourceFingerprint(source);
    expect(chapterTitleSourceFingerprint({ ...source, currentTitle: "旧账无名" })).not.toBe(fingerprint);
    expect(chapterTitleSourceFingerprint({ ...source, blueprintFingerprint: "new-blueprint" })).not.toBe(fingerprint);
    expect(chapterTitleSourceFingerprint({ ...source, contentHash: "new-content" })).not.toBe(fingerprint);
  });

  it("starts a durable workflow and reuses the same active chapter source", async () => {
    const sourceFingerprint = chapterTitleSourceFingerprint(source);
    const repository = {
      getChapterTitleSource: vi.fn(async () => source),
      listProjectRuns: vi.fn(async () => []),
      putWorkflowRun: vi.fn(async () => undefined),
      updateWorkflowRunStatus: vi.fn(async () => undefined),
    } as unknown as NovelPostgresRepository;
    const start = vi.fn(async () => ({ firstExecutionRunId: "run-1" }));
    const temporal = { workflow: { start } } as unknown as Client;
    expect(await startChapterTitleGeneration(repository, temporal, { projectId: "project-1", documentId: "chapter-7" })).toMatchObject({ sourceFingerprint, reused: false });
    expect(start).toHaveBeenCalledWith("chapterTitleWorkflow", expect.objectContaining({ args: [expect.objectContaining({ documentId: "chapter-7", sourceFingerprint })] }));

    vi.mocked(repository.listProjectRuns).mockResolvedValueOnce([{
      id: "existing", workflowType: "chapter-title", projectId: "project-1", temporalWorkflowId: "existing",
      status: "waiting-external", payload: { documentId: "chapter-7", sourceFingerprint }, createdAt: "now", updatedAt: "now",
    }]);
    expect(await startChapterTitleGeneration(repository, temporal, { projectId: "project-1", documentId: "chapter-7" })).toMatchObject({ workflowId: "existing", reused: true });
    expect(start).toHaveBeenCalledTimes(1);
  });
});
