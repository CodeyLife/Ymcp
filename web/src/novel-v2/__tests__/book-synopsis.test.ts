import { describe, expect, it, vi } from "vitest";
import {
  bookSynopsisSourceFingerprint,
  bookTitleSourceFingerprint,
  buildBookSynopsisPrompt,
  buildBookTitleCandidatesPrompt,
  missingSynopsisPlanStages,
  normalizeBookTitleCandidates,
  parseBookSynopsisMetadata,
  parseBookTitleCandidatesMetadata,
} from "../application/book-synopsis";
import { PROJECT_PLAN_STAGES, type ProjectPlanSection } from "../application/project-plan";
import { startBookSynopsisGeneration, startBookTitleCandidateGeneration } from "../application/book-synopsis-workflow";
import { NovelPostgresRepository } from "../postgres-repository";
import type { Client } from "@temporalio/client";
import { createNovelWorkflowActivities } from "../temporal/activities";
import { ExternalMcpRequiredError } from "../model-routing";
import type { ModelGateway } from "../model-gateway";
import type { ContentObjectStore } from "../object-store";
import type { MemoryProvider, SkillProvider } from "../protocol";

function completePlan(topic = "归乡者追查一桩被小城集体遗忘的旧案"): ProjectPlanSection[] {
  return PROJECT_PLAN_STAGES.map((stage, index) => ({
    projectId: "project-1",
    taskKey: stage.taskKey,
    workItemId: `work-${index}`,
    sourceArtifactId: `artifact-${index}`,
    status: "approved",
    payload: { title: stage.label, summary: `${topic}；${stage.instruction}`, sections: [], structuredData: { topic } },
    editRevision: 0,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  }));
}

describe("book synopsis planning contract", () => {
  it("builds one complete, reader-facing model instruction from every approved plan stage", () => {
    const prompt = buildBookSynopsisPrompt({ projectTitle: "长夜归舟", sections: completePlan() });
    for (const stage of PROJECT_PLAN_STAGES) expect(prompt).toContain(`"taskKey": "${stage.taskKey}"`);
    expect(prompt).toContain("不泄露结局或关键反转");
    expect(prompt).toContain("不添加规划中没有依据");
  });

  it("rejects incomplete planning instead of fabricating across missing stages", () => {
    const sections = completePlan().filter((section) => section.taskKey !== "plot-design");
    expect(missingSynopsisPlanStages(sections)).toEqual(["情节设计"]);
    expect(() => buildBookSynopsisPrompt({ projectTitle: "长夜归舟", sections })).toThrow("情节设计");
  });

  it("keeps the contract genre-neutral and changes the source fingerprint when planning changes", () => {
    const scienceFiction = completePlan("深空维修师发现殖民站正在改写居民记忆");
    const prompt = buildBookSynopsisPrompt({ projectTitle: "静默轨道", sections: scienceFiction });
    expect(prompt).toContain("深空维修师");
    expect(prompt).toContain("体裁适配");
    const original = bookSynopsisSourceFingerprint({ projectTitle: "静默轨道", sections: scienceFiction });
    scienceFiction[2] = { ...scienceFiction[2], sourceArtifactId: "artifact-revised", editRevision: 1 };
    expect(bookSynopsisSourceFingerprint({ projectTitle: "静默轨道", sections: scienceFiction })).not.toBe(original);
    expect(bookSynopsisSourceFingerprint({ projectTitle: "寂静轨道", sections: completePlan("深空维修师发现殖民站正在改写居民记忆") })).not.toBe(original);
  });

  it("only reads complete persisted synopsis metadata", () => {
    expect(parseBookSynopsisMetadata({ bookSynopsis: { text: "  一段简介  ", generatedAt: "now", sourceFingerprint: "fp" } })).toEqual({ text: "一段简介", generatedAt: "now", sourceFingerprint: "fp" });
    expect(parseBookSynopsisMetadata({ bookSynopsis: { text: "缺少来源" } })).toBeUndefined();
  });

  it("builds diverse Chinese title candidates from the same complete planning contract", () => {
    const sections = completePlan("流亡医师在疫城中发现病人的梦会改写现实");
    const prompt = buildBookTitleCandidatesPrompt(sections);
    for (const stage of PROJECT_PLAN_STAGES) expect(prompt).toContain(`"taskKey": "${stage.taskKey}"`);
    expect(prompt).toContain("不同命名角度");
    expect(prompt).toContain("不使用项目 ID、日期、版本号");
    const candidates = normalizeBookTitleCandidates({ candidates: [
      { title: "《梦疫之城》", rationale: "同时承载疫病危机与梦境改写现实的核心承诺" },
      { title: "无眠处方", rationale: "从医师身份切入主角对抗异变的独特行动方式" },
      { title: "无眠处方", rationale: "重复项应该被统一去除而不是成为伪候选" },
    ] });
    expect(candidates.map((candidate) => candidate.title)).toEqual(["梦疫之城", "无眠处方"]);
    const revised = completePlan("另一类规划");
    revised[0] = { ...revised[0], sourceArtifactId: "artifact-new", editRevision: 1 };
    expect(bookTitleSourceFingerprint(sections)).not.toBe(bookTitleSourceFingerprint(revised));
  });

  it("only reads complete title-candidate metadata", () => {
    const metadata = { bookTitleCandidates: { candidates: [
      { title: "长夜归舟", rationale: "以归途意象凝练主角追索真相的叙事承诺" },
      { title: "全城失忆", rationale: "直接突出集体遗忘带来的悬疑冲突与风险" },
    ], generatedAt: "now", sourceFingerprint: "fp" } };
    expect(parseBookTitleCandidatesMetadata(metadata)?.candidates).toHaveLength(2);
    expect(parseBookTitleCandidatesMetadata({ bookTitleCandidates: { candidates: [], generatedAt: "now" } })).toBeUndefined();
  });

  it("starts one durable generation workflow and reuses the same active source", async () => {
    const sections = completePlan();
    const sourceFingerprint = bookSynopsisSourceFingerprint({ projectTitle: "长夜归舟", sections });
    const repository = {
      listProjectPlanSections: vi.fn(async () => sections),
      getProjectDetail: vi.fn(async () => ({ title: "长夜归舟" })),
      listProjectRuns: vi.fn(async () => []),
      putWorkflowRun: vi.fn(async () => undefined),
      updateWorkflowRunStatus: vi.fn(async () => undefined),
    } as unknown as NovelPostgresRepository;
    const start = vi.fn(async () => ({ firstExecutionRunId: "run-1" }));
    const temporal = { workflow: { start } } as unknown as Client;

    const result = await startBookSynopsisGeneration(repository, temporal, { projectId: "project-1" });
    expect(result).toMatchObject({ status: "accepted", sourceFingerprint, reused: false });
    expect(start).toHaveBeenCalledWith("bookSynopsisWorkflow", expect.objectContaining({ args: [expect.objectContaining({ sourceFingerprint })] }));

    vi.mocked(repository.listProjectRuns).mockResolvedValueOnce([{
      id: "existing", workflowType: "book-synopsis", projectId: "project-1", temporalWorkflowId: "existing",
      status: "waiting-external", payload: { sourceFingerprint }, createdAt: "now", updatedAt: "now",
    }]);
    expect(await startBookSynopsisGeneration(repository, temporal, { projectId: "project-1" })).toMatchObject({ workflowId: "existing", reused: true });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("starts title generation as a durable workflow tied to the plan snapshot", async () => {
    const sections = completePlan();
    const sourceFingerprint = bookTitleSourceFingerprint(sections);
    const repository = {
      listProjectPlanSections: vi.fn(async () => sections),
      listProjectRuns: vi.fn(async () => []),
      putWorkflowRun: vi.fn(async () => undefined),
      updateWorkflowRunStatus: vi.fn(async () => undefined),
    } as unknown as NovelPostgresRepository;
    const start = vi.fn(async () => ({ firstExecutionRunId: "run-title-1" }));
    const temporal = { workflow: { start } } as unknown as Client;
    expect(await startBookTitleCandidateGeneration(repository, temporal, { projectId: "project-1" })).toMatchObject({ sourceFingerprint, reused: false });
    expect(start).toHaveBeenCalledWith("bookTitleCandidatesWorkflow", expect.objectContaining({ args: [expect.objectContaining({ sourceFingerprint })] }));
  });

  it("materializes external-mcp routing as a claimable model task", async () => {
    const sections = completePlan();
    const sourceFingerprint = bookSynopsisSourceFingerprint({ projectTitle: "长夜归舟", sections });
    const createModelTask = vi.fn(async (workPackage) => ({
      id: "model-task-1", workflowRunId: workPackage.workflowRunId, taskId: workPackage.taskId,
      purpose: workPackage.purpose, configRevision: workPackage.configRevision, candidateIndex: workPackage.candidateIndex,
      status: "pending", workPackage, idempotencyKey: "key", createdAt: "now", updatedAt: "now",
    }));
    const repository = {
      listProjectPlanSections: vi.fn(async () => sections),
      getProjectDetail: vi.fn(async () => ({ title: "长夜归舟" })),
      createModelTask,
    } as unknown as NovelPostgresRepository;
    const modelGateway = {
      getRoutingSnapshot: () => ({ id: "snapshot-1" }),
      generateStructured: vi.fn(async () => { throw new ExternalMcpRequiredError("planning.foundation", "snapshot-1", 0); }),
    } as unknown as ModelGateway;
    const activities = createNovelWorkflowActivities({
      repository,
      modelGateway,
      memoryProvider: {} as MemoryProvider,
      skillProvider: {} as SkillProvider,
      objectStore: {} as ContentObjectStore,
      enableChapterMemory: false,
    });

    const result = await activities.generateBookSynopsis({ workflowId: "workflow-1", projectId: "project-1", sourceFingerprint });
    expect(result.kind).toBe("external");
    expect(createModelTask).toHaveBeenCalledWith(expect.objectContaining({ schemaName: "book_synopsis", contextRefs: expect.objectContaining({ sourceFingerprint }) }), expect.any(String));
  });

  it("does not persist a slow result after its title or plan source changes", async () => {
    const sections = completePlan();
    const sourceFingerprint = bookSynopsisSourceFingerprint({ projectTitle: "长夜归舟", sections });
    const rows = sections.map((section) => ({
      project_id: section.projectId,
      task_key: section.taskKey,
      work_item_id: section.workItemId,
      source_artifact_id: section.sourceArtifactId,
      status: section.status,
      payload: section.payload,
      edit_revision: section.editRevision,
      approved_at: null,
      created_at: section.createdAt,
      updated_at: section.updatedAt,
    }));
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM project_plan_sections")) return { rows, rowCount: rows.length };
        if (sql.includes("FROM novel_projects")) return { rows: [{ id: "project-1", title: "改名后的长夜", current_revision: 0, metadata: {}, created_at: "now", updated_at: "now" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const repository = Object.create(NovelPostgresRepository.prototype) as NovelPostgresRepository;
    Object.defineProperty(repository, "pool", { value: { connect: async () => client, query: vi.fn() } });

    await expect(repository.saveBookSynopsisIfCurrent({
      projectId: "project-1",
      sourceFingerprint,
      synopsis: { text: "旧来源简介", generatedAt: "now", sourceFingerprint },
    })).resolves.toBe(false);
    expect(queries.some((sql) => sql.startsWith("UPDATE novel_projects"))).toBe(false);
    expect(queries).toContain("ROLLBACK");
  });

  it("rejects a title that was not generated for the current planning snapshot", async () => {
    const sections = completePlan();
    const sourceFingerprint = bookTitleSourceFingerprint(sections);
    const rows = sections.map((section) => ({
      project_id: section.projectId,
      task_key: section.taskKey,
      work_item_id: section.workItemId,
      source_artifact_id: section.sourceArtifactId,
      status: section.status,
      payload: section.payload,
      edit_revision: section.editRevision,
      approved_at: null,
      created_at: section.createdAt,
      updated_at: section.updatedAt,
    }));
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM project_plan_sections")) return { rows, rowCount: rows.length };
        if (sql.includes("FROM novel_projects")) return { rows: [{
          id: "project-1", title: "project-1", current_revision: 0, created_at: "now", updated_at: "now",
          metadata: { bookTitleCandidates: { generatedAt: "now", sourceFingerprint, candidates: [
            { title: "长夜归舟", rationale: "以归途意象凝练主角追索真相的叙事承诺" },
            { title: "全城失忆", rationale: "直接突出集体遗忘带来的悬疑冲突与风险" },
          ] } },
        }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const repository = Object.create(NovelPostgresRepository.prototype) as NovelPostgresRepository;
    Object.defineProperty(repository, "pool", { value: { connect: async () => client } });

    await expect(repository.selectBookTitleCandidate({ projectId: "project-1", sourceFingerprint, title: "前端伪造书名" })).rejects.toThrow("只能选择");
    expect(queries.some((sql) => sql.startsWith("UPDATE novel_projects"))).toBe(false);
    expect(queries).toContain("ROLLBACK");
  });

  it("removes the generated candidate set after one title is selected", async () => {
    const sections = completePlan();
    const sourceFingerprint = bookTitleSourceFingerprint(sections);
    const rows = sections.map((section) => ({
      project_id: section.projectId, task_key: section.taskKey, work_item_id: section.workItemId,
      source_artifact_id: section.sourceArtifactId, status: section.status, payload: section.payload,
      edit_revision: section.editRevision, approved_at: null, created_at: section.createdAt, updated_at: section.updatedAt,
    }));
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes("FROM project_plan_sections")) return { rows, rowCount: rows.length };
        if (sql.includes("FROM novel_projects")) return { rows: [{
          id: "project-1", title: "project-1", current_revision: 0, created_at: "now", updated_at: "now",
          metadata: { bookTitleCandidates: { generatedAt: "now", sourceFingerprint, candidates: [
            { title: "长夜归舟", rationale: "以归途意象凝练主角追索真相的叙事承诺" },
            { title: "全城失忆", rationale: "直接突出集体遗忘带来的悬疑冲突与风险" },
          ] } },
        }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const repository = Object.create(NovelPostgresRepository.prototype) as NovelPostgresRepository;
    Object.defineProperty(repository, "pool", { value: { connect: async () => client } });
    Object.defineProperty(repository, "appendOutbox", { value: vi.fn(async () => undefined) });
    Object.defineProperty(repository, "getProjectDetail", { value: vi.fn(async () => ({ id: "project-1", title: "长夜归舟" })) });

    await expect(repository.selectBookTitleCandidate({ projectId: "project-1", sourceFingerprint, title: "长夜归舟" })).resolves.toMatchObject({ title: "长夜归舟" });
    const update = queries.find((entry) => entry.sql.startsWith("UPDATE novel_projects SET title"));
    expect(update?.sql).toContain("metadata=metadata - 'bookTitleCandidates'");
    expect(update?.values).toEqual(["project-1", "长夜归舟"]);
  });
});
