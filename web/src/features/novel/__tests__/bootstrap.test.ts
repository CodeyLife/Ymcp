import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
  callStructuredNovelModel: vi.fn(),
  streamNovelModel: vi.fn(),
}));

import { callStructuredNovelModel } from "../ai";
import { bootstrapNovelFromCoreIdea, NovelBootstrapError, type NovelBootstrapProgress } from "../bootstrap";
import { novelDb } from "../db";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
  vi.mocked(callStructuredNovelModel).mockReset();
});

function result(data: Record<string, unknown>, promptHash: string) {
  return { data, usage: { inputTokens: 20, outputTokens: 20 }, promptHash };
}

function positioningResponse() {
  return result({
    summary: "建立作品定位",
    items: [{
      label: "作品定位",
      operation: "update",
      targetTable: "projects",
      payload: {
        title: "失忆档案馆",
        premise: "城市每天遗忘一个人，唯有销毁档案的女孩记得他们曾经存在。",
        genre: ["悬疑", "奇幻"],
        audience: "成年类型文学读者",
        themes: ["记忆", "存在"],
        sellingPoints: ["以档案对抗集体遗忘"],
        pov: "第三人称限知",
        tense: "过去时",
        tone: "克制而诡谲",
        languageStyle: "冷静细腻，以具体行动呈现情绪。",
      },
      rationale: "将核心创意转为稳定创作契约",
    }],
  }, "positioning");
}

function architectureResponse() {
  return result({
    summary: "建立全书架构",
    items: [{
      label: "全书架构",
      operation: "update",
      targetTable: "architectures",
      payload: {
        framework: "three-act",
         centralQuestion: "一个人被所有人遗忘后是否仍然存在",
         centralConflict: "女孩必须保存被遗忘者的痕迹，同时躲避维护遗忘秩序的机构",
         synopsis: "女孩从一次违规保留档案开始，逐步发现城市依靠遗忘维持表面稳定，并决定让消失者重新被看见。",
         powerCenters: [
           { id: "archive", name: "遗忘档案局", kind: "human-organization", interest: "维持遗忘秩序的合法性", resources: ["销毁档案的行政权"], actionCapacity: "可以调度城市档案与监控网络", bottomLine: "不允许被遗忘者重新进入公共记录", relationshipDynamics: "与记忆保留者交换线索又彼此追捕" },
           { id: "remembered", name: "被遗忘者共同体", kind: "supernatural", interest: "让自身存在重新获得见证", resources: ["无法销毁的记忆残片"], actionCapacity: "可以在城市记忆盲区留下痕迹", bottomLine: "不接受自身存在再次被抹除", relationshipDynamics: "依赖档案局的缝隙生存并逐步反抗" },
         ],
         feedbackLoops: [{ id: "memory-loop", name: "档案回声", trigger: "女孩保留一份待销毁档案", transmission: ["档案局启动追查", "共同体暴露隐藏据点", "城市居民看到异常记录", "档案局被迫公开新的销毁规则"], affectedCenters: ["archive", "remembered"], storyPressure: "每次保留都会扩大共同体的生存空间，也会让追查更接近女孩本人。", returnPath: "档案局公开新规则后失去原有隐蔽性，下一次销毁行动必须留下可追责的签名。" }],
         longHorizonHooks: [{ id: "blank-name", surfaceDetail: "每周档案盘点表上总有一行墨迹比纸面更晚干", possibleInterpretations: ["有人篡改了盘点时间", "纸张受潮造成颜色差异"], affectedCenters: ["archive", "remembered"], payoffWindow: "中后段揭示" }],
         phases: [
           { id: "phase-1", title: "残留的名字", purpose: "女孩发现第一份无法销毁的档案。", turningPoint: "她在销毁流程尽头第一次见到被遗忘者本人，机构的监控网络首次出现盲区。", order: 0, locked: false, primaryCurveId: "main", stages: [{ title: "发现档案", summary: "女孩在销毁流程中故意漏掉一份无法销毁的档案。" }, { title: "初次照面", summary: "她在档案室深处第一次见到被遗忘者本人，对方请求她保存痕迹。" }] },
           { id: "phase-2", title: "遗忘的秩序", purpose: "她追查制度背后的代价。", turningPoint: "她自己的名字出现在销毁名单上，机构正式将她列为必须清除的目标。", order: 1, locked: false, primaryCurveId: "eco", stages: [{ title: "追查代价", summary: "她摸清销毁档案维持的城市秩序与机构运作逻辑。" }, { title: "名单降临", summary: "她发现自己的名字已进入销毁名单，成为清除目标。" }] },
           { id: "phase-3", title: "重新被看见", purpose: "她让城市面对被抹去的人。", turningPoint: "所有被销毁的档案在城市公共空间同时重现，机构的遗忘秩序彻底崩塌。", order: 2, locked: false, primaryCurveId: "main", stages: [{ title: "公开对抗", summary: "她决定让所有消失者重新被城市居民看见，策划公开行动。" }, { title: "档案重现", summary: "所有被销毁的档案在城市公共空间同时重现，秩序崩塌。" }] },
         ],
        growthCurves: [
          { id: "main", kind: "main", subject: "女孩与被遗忘者的连接", resourceLoop: "每销毁一份档案城市稳定一分但女孩的记忆多一层", stageGoals: "从发现销毁异常到组织公开对抗的完整路径与代价", irreversibleChange: "城市的遗忘机制被永久打破" },
           { id: "eco", kind: "ecological", subject: "遗忘机构的权力生态", resourceLoop: "机构通过销毁档案获取维持秩序的资源与合法性", stageGoals: "从暗中运作维持秩序到公开镇压反对者的转变", irreversibleChange: "机构的合法性与运作基础被公开质疑" },
         ],
         ideologicalFactions: [
           { id: "faction-memory", name: "记忆公开派", position: "所有被抹去的记录都应公开保存，任何机构不得独占记忆处理权。", affectedCenterIds: ["archive", "remembered"] },
           { id: "faction-order", name: "秩序维护派", position: "遗忘程序必须由集中机构控制，否则城市会被无法调和的旧案撕裂。", affectedCenterIds: ["archive", "remembered"] },
           { id: "faction-witness", name: "见证互助派", position: "记录应由当事人与邻里共同维护，制度只能提供工具而不能决定谁存在。", affectedCenterIds: ["archive", "remembered"] },
         ],
      },
      rationale: "为后续规划提供阶段骨架",
    }],
  }, "architecture");
}

function mockSuccessfulBootstrap() {
  vi.mocked(callStructuredNovelModel)
    .mockResolvedValueOnce(positioningResponse())
    .mockResolvedValueOnce(architectureResponse());
}

function schemaRequires(schema: unknown, fields: string[]): boolean {
  if (!schema || typeof schema !== "object") return false;
  if (Array.isArray(schema)) return schema.some((item) => schemaRequires(item, fields));
  const record = schema as Record<string, unknown>;
  const required = Array.isArray(record.required) ? record.required.filter((value): value is string => typeof value === "string") : [];
  if (fields.every((field) => required.includes(field))) return true;
  return Object.values(record).some((value) => schemaRequires(value, fields));
}

describe("novel bootstrap", () => {
  it("requires complete positioning and architecture payloads in the model schema", async () => {
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(positioningResponse())
      .mockRejectedValueOnce(new Error("stop after schema capture"));

    await expect(bootstrapNovelFromCoreIdea({ coreIdea: "一座城市每天会遗忘一个人。" })).rejects.toBeInstanceOf(NovelBootstrapError);

    const positioningSchema = vi.mocked(callStructuredNovelModel).mock.calls[0]?.[0].schema;
    const architectureSchema = vi.mocked(callStructuredNovelModel).mock.calls[1]?.[0].schema;
    expect(schemaRequires(positioningSchema, ["title", "premise", "genre", "audience", "themes", "sellingPoints", "pov", "tense", "tone", "languageStyle"])).toBe(true);
    expect(schemaRequires(architectureSchema, ["centralQuestion", "centralConflict", "synopsis", "phases"])).toBe(true);
  });

  it("generates and auto-applies the complete foundation package in dependency order", async () => {
    mockSuccessfulBootstrap();

    const created = await bootstrapNovelFromCoreIdea({ coreIdea: "一座城市每天会遗忘一个人，只有销毁档案的女孩记得他们。" });

    expect(created.completedStages).toEqual(["project-positioning", "architecture"]);
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(2);
    const project = await novelDb.projects.get(created.projectId);
    expect(project).toMatchObject({ title: "失忆档案馆", genre: ["悬疑", "奇幻"], premise: "城市每天遗忘一个人，唯有销毁档案的女孩记得他们曾经存在。" });
    const architecture = await novelDb.architectures.where("projectId").equals(created.projectId).first();
    expect(architecture).toMatchObject({ status: "approved", phases: expect.arrayContaining([expect.objectContaining({ title: "残留的名字" })]) });
    expect(await novelDb.entities.where("projectId").equals(created.projectId).count()).toBe(0);
    expect(await novelDb.relations.where("projectId").equals(created.projectId).count()).toBe(0);

    const proposals = await novelDb.proposals.where("projectId").equals(created.projectId).sortBy("createdAt");
    expect(proposals.map((proposal) => [proposal.taskKey, proposal.status])).toEqual([
      ["project-positioning", "accepted"],
      ["architecture", "accepted"],
    ]);
    expect(await novelDb.outlineNodes.where("projectId").equals(created.projectId).count()).toBe(0);
    expect(await novelDb.documents.where("projectId").equals(created.projectId).count()).toBe(0);
    expect(await novelDb.plotThreads.where("projectId").equals(created.projectId).count()).toBe(0);
    expect(await novelDb.foreshadowing.where("projectId").equals(created.projectId).count()).toBe(0);
  });

  it("keeps the partial project and skips completed stages when generation resumes", async () => {
    vi.mocked(callStructuredNovelModel)
      .mockResolvedValueOnce(positioningResponse())
      .mockRejectedValueOnce(new Error("架构服务暂时不可用"));

    let failure: NovelBootstrapError | undefined;
    try {
      await bootstrapNovelFromCoreIdea({ coreIdea: "一座城市每天会遗忘一个人。" });
    } catch (error) {
      failure = error as NovelBootstrapError;
    }

    expect(failure).toBeInstanceOf(NovelBootstrapError);
    expect(failure?.completedStages).toEqual(["project-positioning"]);
    expect(await novelDb.projects.get(failure!.projectId)).toBeDefined();

    vi.mocked(callStructuredNovelModel).mockResolvedValueOnce(architectureResponse());
    const resumed = await bootstrapNovelFromCoreIdea({ coreIdea: "一座城市每天会遗忘一个人。", projectId: failure!.projectId });

    expect(resumed.completedStages).toEqual(["project-positioning", "architecture"]);
    expect(callStructuredNovelModel).toHaveBeenCalledTimes(3);
    const proposals = await novelDb.proposals.where("projectId").equals(resumed.projectId).toArray();
    expect(proposals.filter((proposal) => proposal.taskKey === "project-positioning")).toHaveLength(1);
  });

  it("aborts the active model call and retains the provisional project", async () => {
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const modelStarted = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(callStructuredNovelModel).mockImplementationOnce(async (params) => {
      started?.();
      return await new Promise<never>((_resolve, reject) => {
        params.signal?.addEventListener("abort", () => reject(params.signal?.reason), { once: true });
      });
    });
    const progress: NovelBootstrapProgress[][] = [];
    const task = bootstrapNovelFromCoreIdea({ coreIdea: "一座城市每天会遗忘一个人。", signal: controller.signal, onProgress: (value) => progress.push(value) });
    await modelStarted;
    controller.abort();

    await expect(task).rejects.toBeInstanceOf(NovelBootstrapError);
    expect(await novelDb.projects.count()).toBe(1);
    expect(progress.at(-1)?.find((item) => item.stage === "project-positioning")?.status).toBe("failed");
  });
});
