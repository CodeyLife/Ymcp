import { beforeEach, describe, expect, it } from "vitest";
import { addEntity, createNovelProject, novelDb, recordBase } from "../db";
import { autoAcceptSafeFactCandidates, classifyFactRisk, commitAcceptedFacts, storeFactCandidates } from "../facts";
import type { WorkflowRun } from "../types";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
});

async function seedProjectWithCharacters() {
  const project = await createNovelProject({ title: "事实测试", genre: ["都市"], premise: "测试自动应用事实差异。" });
  const charA = await addEntity(project.id, "character", "陆沉");
  const charB = await addEntity(project.id, "character", "苏黎");
  return { project, charA, charB };
}

function makeRun(projectId: string): WorkflowRun {
  return {
    ...recordBase(projectId),
    workflowId: "standard-chapter-v2",
    targetDocumentId: "doc-1",
    status: "running",
    currentStage: "commit",
    stageIndex: 9,
    revisionIteration: 0,
    factCandidateIds: [],
    startedAt: Date.now(),
  };
}

async function addAcceptedCandidate(projectId: string, workflowRunId: string, overrides: Partial<Record<string, unknown>> = {}) {
  const candidate = {
    ...recordBase(projectId),
    workflowRunId,
    sourceArtifactId: "draft-1",
    targetTable: "relations",
    field: "record",
    after: { fromEntityId: "char-A", toEntityId: "char-B", relationType: "同伴", bond: "关系亲密，已建立信任", publicLabel: "", privateTruth: "" },
    evidence: "原文证据",
    confidence: 0.9,
    novelty: "new" as const,
    conflict: false,
    risk: "high" as const,
    riskReason: "新对象必须人工确认",
    status: "accepted" as const,
    ...overrides,
  };
  await novelDb.factCandidates.add(candidate);
  return candidate;
}

describe("commitAcceptedFacts - 新建关系", () => {
  it("creates a new EntityRelation when novelty=new and field=record", async () => {
    const { project, charA, charB } = await seedProjectWithCharacters();
    const run = makeRun(project.id);
    await novelDb.workflowRuns.add(run);
    await addAcceptedCandidate(project.id, run.id, { after: { fromEntityId: charA.id, toEntityId: charB.id, relationType: "同伴", bond: "关系亲密，已建立信任", publicLabel: "公开标签", privateTruth: "秘密" } });

    const committed = await commitAcceptedFacts(project.id, run.id);
    expect(committed).toHaveLength(1);

    const relations = await novelDb.relations.where("projectId").equals(project.id).toArray();
    expect(relations).toHaveLength(1);
    expect(relations[0].fromEntityId).toBe(charA.id);
    expect(relations[0].toEntityId).toBe(charB.id);
    expect(relations[0].relationType).toBe("同伴");
    expect(relations[0].bond).toBe("关系亲密，已建立信任");
    expect(relations[0].publicLabel).toBe("公开标签");
    expect(relations[0].privateTruth).toBe("秘密");
  });

  it("skips creating duplicate relation when (fromEntityId, toEntityId) already exists", async () => {
    const { project, charA, charB } = await seedProjectWithCharacters();
    await novelDb.relations.add({
      ...recordBase(project.id),
      fromEntityId: charA.id,
      toEntityId: charB.id,
      relationType: "旧关系",
      publicLabel: "",
      privateTruth: "",
      bond: "关系一般，互不熟络",
      history: [],
    });
    const run = makeRun(project.id);
    await novelDb.workflowRuns.add(run);
    await addAcceptedCandidate(project.id, run.id, { after: { fromEntityId: charA.id, toEntityId: charB.id, relationType: "同伴", bond: "关系亲密，互相信任" } });

    const committed = await commitAcceptedFacts(project.id, run.id);
    expect(committed).toHaveLength(0);

    const relations = await novelDb.relations.where("projectId").equals(project.id).toArray();
    expect(relations).toHaveLength(1);
    expect(relations[0].relationType).toBe("旧关系");
  });

  it("skips candidates with conflict=true", async () => {
    const { project, charA, charB } = await seedProjectWithCharacters();
    const run = makeRun(project.id);
    await novelDb.workflowRuns.add(run);
    await addAcceptedCandidate(project.id, run.id, {
      after: { fromEntityId: charA.id, toEntityId: charB.id, relationType: "同伴", bond: "关系亲密" },
      conflict: true,
    });

    const committed = await commitAcceptedFacts(project.id, run.id);
    expect(committed).toHaveLength(0);
    const relations = await novelDb.relations.where("projectId").equals(project.id).toArray();
    expect(relations).toHaveLength(0);
  });

  it("skips new-relation candidates with missing fromEntityId or toEntityId", async () => {
    const { project } = await seedProjectWithCharacters();
    const run = makeRun(project.id);
    await novelDb.workflowRuns.add(run);
    await addAcceptedCandidate(project.id, run.id, {
      after: { fromEntityId: "", toEntityId: "char-B", relationType: "同伴" },
    });

    const committed = await commitAcceptedFacts(project.id, run.id);
    expect(committed).toHaveLength(0);
  });
});

describe("commitAcceptedFacts - 更新现有记录", () => {
  it("updates existing relation field when novelty=update and targetId exists", async () => {
    const { project, charA, charB } = await seedProjectWithCharacters();
    const relation = {
      ...recordBase(project.id),
      fromEntityId: charA.id,
      toEntityId: charB.id,
      relationType: "同伴",
      publicLabel: "",
      privateTruth: "",
      bond: "关系一般，偶有摩擦",
      history: [],
    };
    await novelDb.relations.add(relation);
    const run = makeRun(project.id);
    await novelDb.workflowRuns.add(run);
    await addAcceptedCandidate(project.id, run.id, {
      targetId: relation.id,
      field: "bond",
      before: "关系一般，偶有摩擦",
      after: "关系亲密，已建立信任",
      novelty: "update",
    });

    const committed = await commitAcceptedFacts(project.id, run.id);
    expect(committed).toHaveLength(1);
    const updated = await novelDb.relations.get(relation.id);
    expect(updated?.bond).toBe("关系亲密，已建立信任");
  });
});

describe("fact approval policy", () => {
  it("classifies only explicit existing-character state changes as safe", () => {
    expect(classifyFactRisk({ targetTable: "entities", targetId: "character-1", field: "character.state.location", after: "北港", evidence: "她抵达北港。", confidence: 0.96, novelty: "update", conflict: false })).toMatchObject({ risk: "safe" });
    expect(classifyFactRisk({ targetTable: "entities", targetId: "character-1", field: "character.secret", after: "真实身份", evidence: "她承认了身份。", confidence: 0.99, novelty: "update", conflict: false })).toMatchObject({ risk: "high" });
    expect(classifyFactRisk({ targetTable: "entities", field: "record", after: { name: "新角色" }, evidence: "有人出现。", confidence: 0.99, novelty: "new", conflict: false })).toMatchObject({ risk: "high" });
  });

  it("auto-accepts safe updates only when the project policy is enabled", async () => {
    const { project, charA } = await seedProjectWithCharacters();
    const candidates = await storeFactCandidates({
      projectId: project.id,
      workflowRunId: "run-policy",
      sourceArtifactId: "draft-policy",
      facts: [
        { targetTable: "entities", targetId: charA.id, field: "character.state.location", after: "北港", evidence: "陆沉抵达北港。", confidence: 0.97, novelty: "update", conflict: false },
        { targetTable: "entities", targetId: charA.id, field: "character.secret", after: "继承人", evidence: "陆沉承认身份。", confidence: 0.99, novelty: "update", conflict: false },
      ],
    });

    expect(await autoAcceptSafeFactCandidates(candidates, false)).toEqual([]);
    expect(await novelDb.factCandidates.where("workflowRunId").equals("run-policy").and((item) => item.status === "pending").count()).toBe(2);

    expect(await autoAcceptSafeFactCandidates(candidates, true)).toEqual([candidates[0].id]);
    expect(await novelDb.factCandidates.get(candidates[0].id)).toMatchObject({ status: "accepted", decisionSource: "auto-policy" });
    expect(await novelDb.factCandidates.get(candidates[1].id)).toMatchObject({ status: "pending", risk: "high" });
  });
});
