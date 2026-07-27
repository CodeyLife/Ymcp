import { describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../../../novel-v2/postgres-repository";
import type { RuntimeLearningAssessmentV2 } from "../../../novel-v2/protocol";

type QueryCall = { sql: string; params?: unknown[] };

function createRepository(responses: Array<{ rows?: unknown[]; rowCount?: number }> = []) {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return responses.shift() ?? { rows: [], rowCount: 0 };
    },
    connect: async () => {
      const clientCalls: QueryCall[] = [];
      const client = {
        calls: clientCalls,
        query: async (sql: string, params?: unknown[]) => {
          clientCalls.push({ sql, params });
          if (sql.startsWith("DELETE FROM novel_projects")) return { rows: [{ id: params?.[0] }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      };
      return client;
    },
  };
  const repository = Object.create(NovelPostgresRepository.prototype) as NovelPostgresRepository;
  Object.defineProperty(repository, "pool", { value: pool });
  return { repository, calls };
}

const documentRow = { id: "doc-1", project_id: "p1", title: "第一章", narrative_order: 1, pov_character_id: null, current_revision_id: null, status: "planned", created_at: new Date(0), updated_at: new Date(0) };

describe("V2 repository management APIs", () => {
  it("updates documents with explicit POV clearing and emits an outbox event", async () => {
    const { repository, calls } = createRepository([{ rows: [documentRow], rowCount: 1 }, { rows: [{ id: 1 }], rowCount: 1 }]);
    await expect(repository.updateDocument({ projectId: "p1", documentId: "doc-1", title: "新标题", povCharacterId: null, status: "review" })).resolves.toMatchObject({ id: "doc-1", title: "第一章" });
    expect(calls[0].params).toEqual(["p1", "doc-1", "新标题", null, true, null, "review"]);
    expect(calls[1].sql).toContain("INSERT INTO outbox_events");
    expect(calls[1].params?.[2]).toBe("document.updated");
  });

  it("lists project runs as protocol records", async () => {
    const { repository } = createRepository([{ rows: [{ id: "run-1", workflow_type: "novel-intent", project_id: "p1", temporal_workflow_id: "wf-1", status: "accepted", payload: { task: "draft" }, created_at: new Date(0), updated_at: new Date(1) }], rowCount: 1 }]);
    await expect(repository.listProjectRuns("p1", 5)).resolves.toEqual([{ id: "run-1", workflowType: "novel-intent", projectId: "p1", temporalWorkflowId: "wf-1", status: "accepted", payload: { task: "draft" }, createdAt: new Date(0).toISOString(), updatedAt: new Date(1).toISOString() }]);
  });

  it("does not promote learning directly; it records regression validation requirement", async () => {
    const assessment: RuntimeLearningAssessmentV2 = { id: "learn-1", projectId: "p1", source: { workflowId: "wf-1", reviewIds: [], fingerprint: "fp" }, conclusion: "propose-improvement", symptom: "问题", failingLayer: "review", underlyingMechanism: "共享机制", affectedInputClass: "长篇章节", boundaries: "仅章节", regressionRisks: ["误伤"], candidate: { targetKind: "skill", targetId: "reader-audit", rationale: "修复", afterText: "足够长的候选文本" }, createdAt: 1 };
    const { repository, calls } = createRepository([{ rows: [{ project_id: "p1", payload: assessment }], rowCount: 1 }, { rows: [], rowCount: 1 }, { rows: [{ id: 7 }], rowCount: 1 }]);
    await expect(repository.requestLearningPromotion("learn-1")).resolves.toMatchObject({ promoted: false, status: "regression-validation-required" });
    expect(calls[1].sql).toContain("INSERT INTO audit_records");
    expect(calls[2].params?.[2]).toBe("learning.promotion-regression-required");
  });

  it("deletes projects through a transaction before removing the project row", async () => {
    const { repository } = createRepository();
    await expect(repository.deleteProject("p1")).resolves.toEqual({ deleted: true, projectId: "p1" });
  });
});
