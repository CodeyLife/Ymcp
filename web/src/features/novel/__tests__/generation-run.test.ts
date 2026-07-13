import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
  callStructuredNovelModel: vi.fn(async ({ schema }: { schema: Record<string, any> }) => {
    const targetTable = schema.properties.items.items.properties.targetTable.enum[0] as string;
    const payload: Record<string, unknown> = targetTable === "architectures" ? { centralQuestion: "谁有权保留记忆？", centralConflict: "保存与遗忘的冲突" }
      : targetTable === "entities" ? { kind: "term", name: "记忆税", summary: "记忆交易规则", description: "每次交易都会永久失去一段私人记忆" }
        : targetTable === "outlineNodes" ? { kind: "event", title: "记忆失窃", summary: "关键记录被盗", order: 0, causality: "记录被盗", outcome: "主角开始追查" }
          : targetTable === "plotThreads" ? { kind: "main", title: "失窃主线", summary: "追查被删除的记忆", status: "planned", nextMove: "寻找目击者" }
            : targetTable === "documents" ? { title: "第一章", order: 0, blueprint: { objective: "发现失窃", conflict: "档案被封锁", informationRelease: [], turningPoint: "主角找到缺页", hook: "缺页写着主角名字", locationIds: [], characterIds: [], mustHappen: [], flexible: [], forbidden: [], targetWords: 3000 } }
              : {};
    return { data: { summary: "测试生成", items: [{ label: `${targetTable} 候选`, operation: "create", targetTable, payload, rationale: "测试" }] }, usage: { inputTokens: 10, outputTokens: 20 }, promptHash: "hash" };
  }),
}));

import { callStructuredNovelModel } from "../ai";
import { applyProposalItems, cancelProjectGeneration, PROJECT_GENERATION_STAGES, skipProjectGenerationStage, startProjectGeneration } from "../generation";
import { createNovelProject, novelDb } from "../db";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("project generation workflow", () => {
  it("protects against duplicate active runs", async () => {
    const project = await createNovelProject({ title: "全案测试", genre: ["科幻"], premise: "记忆可以被交易。" });
    const first = await startProjectGeneration(project.id, project.premise);
    const second = await startProjectGeneration(project.id, "另一条要求");
    expect(first.id).toBe(second.id);
    expect(await novelDb.projectGenerationRuns.where("projectId").equals(project.id).count()).toBe(1);
    expect(first.status).toBe("waiting-approval");
    expect(vi.mocked(callStructuredNovelModel).mock.calls[0][0].prompt).toContain("生成可支撑长篇的全书架构");
  });

  it("automatically advances after each approved proposal and completes all stages", async () => {
    const project = await createNovelProject({ title: "推进测试", genre: ["奇幻"], premise: "记忆可以被交易。" });
    let run = await startProjectGeneration(project.id, project.premise);
    for (let index = 0; index < PROJECT_GENERATION_STAGES.length; index += 1) {
      expect(run.status).toBe("waiting-approval");
      expect(run.currentStage).toBe(PROJECT_GENERATION_STAGES[index]);
      const proposal = await novelDb.proposals.get(run.activeProposalId!);
      await applyProposalItems(proposal!.id, proposal!.items.map((item) => item.id));
      run = (await novelDb.projectGenerationRuns.get(run.id))!;
    }
    expect(run.status).toBe("completed");
    expect(run.proposalIds).toHaveLength(PROJECT_GENERATION_STAGES.length);
    expect(await novelDb.documents.where("projectId").equals(project.id).count()).toBeGreaterThan(0);
  });

  it("rejects the pending proposal when a stage is skipped", async () => {
    const project = await createNovelProject({ title: "跳过测试", genre: ["都市"], premise: "每个人只能说一次真话。" });
    const run = await startProjectGeneration(project.id, project.premise);
    const proposalId = run.activeProposalId!;
    const next = await skipProjectGenerationStage(run.id);
    expect((await novelDb.proposals.get(proposalId))?.status).toBe("rejected");
    expect(next?.stageIndex).toBe(1);
    expect(next?.status).toBe("waiting-approval");
  });

  it("does not revive a run when a model response arrives after cancellation", async () => {
    let resolveModel!: (value: { data: Record<string, unknown>; usage: { inputTokens: number; outputTokens: number }; promptHash: string }) => void;
    vi.mocked(callStructuredNovelModel).mockImplementationOnce(() => new Promise((resolve) => { resolveModel = resolve; }));
    const project = await createNovelProject({ title: "取消测试", genre: ["科幻"], premise: "时间会拒绝被记录。" });
    const startPromise = startProjectGeneration(project.id, project.premise);
    await vi.waitFor(() => expect(callStructuredNovelModel).toHaveBeenCalledTimes(1));
    const running = await novelDb.projectGenerationRuns.where("projectId").equals(project.id).first();
    expect(running?.status).toBe("running");
    await cancelProjectGeneration(running!.id);
    resolveModel({ data: { summary: "迟到结果", items: [{ label: "架构", operation: "update", targetTable: "architectures", targetId: "ignored", payload: { centralConflict: "迟到冲突" }, rationale: "迟到" }] }, usage: { inputTokens: 1, outputTokens: 1 }, promptHash: "late" });
    await startPromise;
    const finalRun = await novelDb.projectGenerationRuns.get(running!.id);
    expect(finalRun?.status).toBe("cancelled");
    const lateProposal = await novelDb.proposals.where("projectGenerationRunId").equals(running!.id).first();
    expect(lateProposal?.status).toBe("rejected");
  });
});
