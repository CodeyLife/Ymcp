import { beforeEach, describe, expect, it } from "vitest";
import { addEntity, createChapter, createNovelProject, novelDb, recordBase } from "../db";
import { autoAcceptSafeFactCandidates, bulkSetFactCandidateStatus, classifyFactRisk, commitAcceptedFacts, dedupeCharacterFactCandidates, filterAcceptableFactIds, filterSafeAcceptableFactIds, findExistingCharacter, listFactAssertionsWithMeta, listKnowledgeAssertionsWithMeta, setFactCandidateStatus, storeFactCandidates } from "../facts";
import type { FactAssertion, WorkflowRun } from "../types";
import type { ExtractedFact } from "../facts";

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

  it("auto-accepts safe updates while leaving high-risk facts pending", async () => {
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

    expect(await autoAcceptSafeFactCandidates(candidates)).toEqual([candidates[0].id]);
    expect(await novelDb.factCandidates.get(candidates[0].id)).toMatchObject({ status: "accepted", decisionSource: "auto-policy" });
    expect(await novelDb.factCandidates.get(candidates[1].id)).toMatchObject({ status: "pending", risk: "high" });
  });
});

describe("bulkSetFactCandidateStatus - 一键操作", () => {
  it("批量采纳时跳过 conflict=true 的候选", async () => {
    const { project, charA } = await seedProjectWithCharacters();
    const candidates = await storeFactCandidates({
      projectId: project.id,
      workflowRunId: "run-bulk",
      sourceArtifactId: "draft-bulk",
      facts: [
        { targetTable: "entities", targetId: charA.id, field: "character.state.location", after: "北港", evidence: "陆沉抵达北港。", confidence: 0.97, novelty: "update", conflict: false },
        { targetTable: "entities", targetId: charA.id, field: "character.secret", after: "继承人", evidence: "陆沉承认身份。", confidence: 0.99, novelty: "update", conflict: false },
        { targetTable: "entities", targetId: charA.id, field: "character.state.location", after: "南港", evidence: "矛盾描述。", confidence: 0.95, novelty: "update", conflict: true },
      ],
    });
    const safe = candidates[0];
    const high = candidates[1];
    const conflict = candidates[2];
    expect(filterSafeAcceptableFactIds(candidates)).toEqual([safe.id]);
    expect(filterAcceptableFactIds(candidates)).toEqual([safe.id, high.id]);

    const changed = await bulkSetFactCandidateStatus([safe.id, high.id, conflict.id], "accepted");
    expect(changed).toHaveLength(2);
    expect(changed).not.toContain(conflict.id);
    expect(await novelDb.factCandidates.get(conflict.id)).toMatchObject({ status: "pending" });
    expect(await novelDb.factCandidates.get(safe.id)).toMatchObject({ status: "accepted", decisionSource: "author" });
    expect(await novelDb.factCandidates.get(high.id)).toMatchObject({ status: "accepted", decisionSource: "author" });
  });

  it("批量排除可覆盖 conflict=true 的候选", async () => {
    const { project, charA } = await seedProjectWithCharacters();
    const candidates = await storeFactCandidates({
      projectId: project.id,
      workflowRunId: "run-bulk-reject",
      sourceArtifactId: "draft-bulk",
      facts: [
        { targetTable: "entities", targetId: charA.id, field: "character.state.location", after: "北港", evidence: "陆沉抵达北港。", confidence: 0.97, novelty: "update", conflict: false },
        { targetTable: "entities", targetId: charA.id, field: "character.state.location", after: "南港", evidence: "矛盾描述。", confidence: 0.95, novelty: "update", conflict: true },
      ],
    });
    const changed = await bulkSetFactCandidateStatus(candidates.map((item) => item.id), "rejected");
    expect(changed).toHaveLength(2);
    expect(await novelDb.factCandidates.get(candidates[1].id)).toMatchObject({ status: "rejected" });
  });

  it("空数组和已是目标状态的候选被跳过", async () => {
    const { project, charA } = await seedProjectWithCharacters();
    expect(await bulkSetFactCandidateStatus([], "accepted")).toEqual([]);
    const candidates = await storeFactCandidates({
      projectId: project.id,
      workflowRunId: "run-bulk-skip",
      sourceArtifactId: "draft-bulk",
      facts: [
        { targetTable: "entities", targetId: charA.id, field: "character.state.location", after: "北港", evidence: "陆沉抵达北港。", confidence: 0.97, novelty: "update", conflict: false },
      ],
    });
    await autoAcceptSafeFactCandidates(candidates);
    const accepted = await novelDb.factCandidates.get(candidates[0].id);
    expect(accepted?.status).toBe("accepted");
    const changed = await bulkSetFactCandidateStatus([candidates[0].id], "accepted");
    expect(changed).toEqual([]);
  });
});

describe("listFactAssertionsWithMeta / listKnowledgeAssertionsWithMeta - 事实账本查询", () => {
  it("空项目返回空数组", async () => {
    const project = await createNovelProject({ title: "空账本", genre: [], premise: "" });
    expect(await listFactAssertionsWithMeta(project.id)).toEqual([]);
    expect(await listKnowledgeAssertionsWithMeta(project.id)).toEqual([]);
  });

  it("正确 join 章节标题、角色名、来源章节名（二跳解析）", async () => {
    const project = await createNovelProject({ title: "账本测试", genre: [], premise: "" });
    const charA = await addEntity(project.id, "character", "陆沉");
    const chapter = await createChapter(project.id, "第一章 雨夜");

    // 直接构造一个已批准的 revision 记录，作为事实来源溯源的锚点
    const revisionRecord = {
      ...recordBase(project.id),
      documentId: chapter.id,
      label: "测试批准版本",
      contentHtml: "<p>陆沉抵达北港。</p>",
      plainText: "陆沉抵达北港。",
      source: "manual" as const,
      branch: chapter.branch,
      approvalStatus: "approved" as const,
      approvedAt: Date.now(),
    };
    await novelDb.revisions.add(revisionRecord);
    const revisionId = revisionRecord.id;

    // 模拟 fact-extraction 落库候选 + commit
    const run: WorkflowRun = {
      ...recordBase(project.id),
      workflowId: "standard-chapter-v2",
      targetDocumentId: chapter.id,
      status: "running",
      currentStage: "commit",
      stageIndex: 9,
      revisionIteration: 0,
      factCandidateIds: [],
      startedAt: Date.now(),
    };
    await novelDb.workflowRuns.add(run);

    const candidates = await storeFactCandidates({
      projectId: project.id,
      workflowRunId: run.id,
      sourceArtifactId: "draft-1",
      sourceRevisionId: revisionId,
      defaultRevealedAt: { chapterId: chapter.id, narrativeOrder: chapter.order, precision: "exact" },
      facts: [{
        targetTable: "entities",
        targetId: charA.id,
        field: "character.state.location",
        subject: { kind: "entity", id: charA.id },
        after: "北港",
        evidence: "陆沉抵达北港。",
        confidence: 0.96,
        novelty: "update",
        conflict: false,
        knowledgeDeltas: [{ characterId: charA.id, stance: "known", learnedAt: { chapterId: chapter.id, narrativeOrder: chapter.order, precision: "exact" } }],
      }],
    });
    // 该候选含 knowledgeDeltas，会被 classifyFactRisk 判为 high risk（角色认知变化必须人工确认），
    // 因此 autoAccept 不会采纳，需手动通过 setFactCandidateStatus 推进
    await setFactCandidateStatus(candidates[0].id, "accepted");
    const committed = await commitAcceptedFacts(project.id, run.id);
    expect(committed).toHaveLength(1);

    // 验证 factAssertions 带 meta
    const factsWithMeta = await listFactAssertionsWithMeta(project.id);
    expect(factsWithMeta).toHaveLength(1);
    const factMeta = factsWithMeta[0];
    expect(factMeta.assertion.subject.id).toBe(charA.id);
    expect(factMeta.subjectName).toBe("陆沉");
    expect(factMeta.chapterTitle).toBe("第一章 雨夜");
    expect(factMeta.chapterOrder).toBe(chapter.order);
    expect(factMeta.sourceChapterTitle).toBe("第一章 雨夜"); // sourceRevisionId 应解析回同一章节

    // 验证 knowledgeAssertions 带 meta
    const knowledgeWithMeta = await listKnowledgeAssertionsWithMeta(project.id);
    expect(knowledgeWithMeta).toHaveLength(1);
    const knowledgeMeta = knowledgeWithMeta[0];
    expect(knowledgeMeta.characterName).toBe("陆沉");
    expect(knowledgeMeta.factHumanReadable).toContain("北港");
    expect(knowledgeMeta.factTruthStatus).toBe("objective");
    expect(knowledgeMeta.chapterTitle).toBe("第一章 雨夜");
  });

  it("未关联章节/未提供 subject 时不报错，meta 字段为 undefined", async () => {
    const project = await createNovelProject({ title: "边界测试", genre: [], premise: "" });
    const orphanAssertion: FactAssertion = {
      ...recordBase(project.id),
      subject: { kind: "project", id: project.id },
      predicate: "project.title",
      object: { kind: "string", value: "边界测试" },
      polarity: "affirmed",
      truthStatus: "objective",
      timeMode: "timeless",
      sourceRevisionId: "rev-non-existent",
      provenance: "legacy-artifact",
      evidence: "",
      confidence: 1,
      humanReadable: "项目标题：边界测试",
      status: "active",
      derivedFromCandidateId: "cand-orphan",
    };
    await novelDb.factAssertions.add(orphanAssertion);

    const result = await listFactAssertionsWithMeta(project.id);
    expect(result).toHaveLength(1);
    expect(result[0].chapterTitle).toBeUndefined();
    expect(result[0].chapterOrder).toBeUndefined();
    expect(result[0].subjectName).toBeUndefined();
    expect(result[0].sourceChapterTitle).toBeUndefined();
  });
});

describe("classifyFactRisk - 新人物新建判定", () => {
  it("marks character new with kind=character, name and confidence>=0.9 as safe", () => {
    const fact: ExtractedFact = {
      targetTable: "entities",
      field: "record",
      after: { kind: "character", name: "李淳罡", aliases: ["老黄"], summary: "剑神", description: "羊裘裘老头" },
      evidence: "李淳罡登场。",
      confidence: 0.92,
      novelty: "new",
      conflict: false,
    };
    expect(classifyFactRisk(fact)).toMatchObject({ risk: "safe", riskReason: "正文首次出现的重要人物新建" });
  });

  it("marks character new as high when confidence < 0.9", () => {
    const fact: ExtractedFact = {
      targetTable: "entities",
      field: "record",
      after: { kind: "character", name: "路人甲", aliases: [], summary: "", description: "" },
      evidence: "有人出现。",
      confidence: 0.85,
      novelty: "new",
      conflict: false,
    };
    expect(classifyFactRisk(fact)).toMatchObject({ risk: "high" });
  });

  it("marks non-character entity new as high", () => {
    const fact: ExtractedFact = {
      targetTable: "entities",
      field: "record",
      after: { kind: "term", name: "北港", aliases: [], summary: "地名", description: "" },
      evidence: "提到北港。",
      confidence: 0.99,
      novelty: "new",
      conflict: false,
    };
    expect(classifyFactRisk(fact)).toMatchObject({ risk: "high" });
  });

  it("marks character new with missing name as high", () => {
    const fact: ExtractedFact = {
      targetTable: "entities",
      field: "record",
      after: { kind: "character", name: "", aliases: [], summary: "", description: "" },
      evidence: "有人出现。",
      confidence: 0.99,
      novelty: "new",
      conflict: false,
    };
    expect(classifyFactRisk(fact)).toMatchObject({ risk: "high" });
  });
});

describe("commitAcceptedFacts - 新人物新建", () => {
  it("creates a new character entity when novelty=new and payload.kind=character", async () => {
    const project = await createNovelProject({ title: "新人物测试", genre: ["武侠"], premise: "测试新人物创建。" });
    const run = makeRun(project.id);
    await novelDb.workflowRuns.add(run);
    await addAcceptedCandidate(project.id, run.id, {
      targetTable: "entities",
      field: "record",
      after: {
        kind: "character",
        name: "温华",
        aliases: ["温小贼"],
        summary: "江湖浪子",
        description: "落魄书生模样",
        character: { role: "重要配角", appearance: "", personality: "", desire: "", motivation: "", weakness: "", secret: "", abilities: [], voice: "", arc: "", state: { location: "北港", physical: "", emotional: "", objective: "寻人", inventory: [], relationshipNotes: [] } },
      },
      novelty: "new",
    });

    const committed = await commitAcceptedFacts(project.id, run.id);
    expect(committed).toHaveLength(1);

    const characters = await novelDb.entities.where("projectId").equals(project.id).toArray();
    expect(characters).toHaveLength(1);
    expect(characters[0].kind).toBe("character");
    expect(characters[0].name).toBe("温华");
    expect(characters[0].aliases).toEqual(["温小贼"]);
    expect(characters[0].character?.role).toBe("重要配角");
    expect(characters[0].character?.state.location).toBe("北港");
  });

  it("skips creating duplicate character when name already exists", async () => {
    const { project } = await seedProjectWithCharacters(); // 已有"陆沉"
    const run = makeRun(project.id);
    await novelDb.workflowRuns.add(run);
    await addAcceptedCandidate(project.id, run.id, {
      targetTable: "entities",
      field: "record",
      after: { kind: "character", name: "陆沉", aliases: [], summary: "重复创建", description: "" },
      novelty: "new",
    });

    const committed = await commitAcceptedFacts(project.id, run.id);
    expect(committed).toHaveLength(0);

    const characters = await novelDb.entities.where("projectId").equals(project.id).and((e) => e.kind === "character").toArray();
    expect(characters).toHaveLength(2); // 只有原来的 陆沉、苏黎
  });

  it("skips creating duplicate character when alias already exists", async () => {
    const { project } = await seedProjectWithCharacters(); // 已有"陆沉"
    const run = makeRun(project.id);
    await novelDb.workflowRuns.add(run);
    await addAcceptedCandidate(project.id, run.id, {
      targetTable: "entities",
      field: "record",
      after: { kind: "character", name: "陆公子", aliases: ["陆沉"], summary: "别名重复", description: "" },
      novelty: "new",
    });

    const committed = await commitAcceptedFacts(project.id, run.id);
    expect(committed).toHaveLength(0);
  });
});

describe("findExistingCharacter - 同名/同别名查找", () => {
  it("finds by exact name match", async () => {
    const { project, charA } = await seedProjectWithCharacters();
    const found = await findExistingCharacter(project.id, "陆沉", []);
    expect(found?.id).toBe(charA.id);
  });

  it("finds by alias match when new name is in existing aliases", async () => {
    const { project, charA } = await seedProjectWithCharacters();
    await novelDb.entities.update(charA.id, { aliases: ["陆公子"] });
    const found = await findExistingCharacter(project.id, "陆公子", []);
    expect(found?.id).toBe(charA.id);
  });

  it("finds when existing name is in new aliases", async () => {
    const { project, charA } = await seedProjectWithCharacters();
    const found = await findExistingCharacter(project.id, "陆公子", ["陆沉"]);
    expect(found?.id).toBe(charA.id);
  });

  it("returns undefined when no match", async () => {
    const { project } = await seedProjectWithCharacters();
    const found = await findExistingCharacter(project.id, "不存在的人", []);
    expect(found).toBeUndefined();
  });
});

describe("dedupeCharacterFactCandidates - 预去重", () => {
  it("discards new character candidates that duplicate existing characters by name", async () => {
    const { project } = await seedProjectWithCharacters();
    const facts: ExtractedFact[] = [
      { targetTable: "entities", field: "record", after: { kind: "character", name: "陆沉", aliases: [], summary: "重复", description: "" }, evidence: "陆沉出现。", confidence: 0.95, novelty: "new", conflict: false },
      { targetTable: "entities", field: "record", after: { kind: "character", name: "温华", aliases: [], summary: "新人", description: "" }, evidence: "温华登场。", confidence: 0.92, novelty: "new", conflict: false },
    ];

    const { facts: kept, discardedCount } = await dedupeCharacterFactCandidates(project.id, facts);
    expect(kept).toHaveLength(1);
    expect(kept[0].after).toMatchObject({ name: "温华" });
    expect(discardedCount).toBe(1);
  });

  it("keeps all non-character facts untouched", async () => {
    const { project } = await seedProjectWithCharacters();
    const facts: ExtractedFact[] = [
      { targetTable: "entities", targetId: "char-1", field: "character.state.location", after: "北港", evidence: "抵达北港。", confidence: 0.96, novelty: "update", conflict: false },
      { targetTable: "relations", field: "record", after: { fromEntityId: "a", toEntityId: "b", relationType: "同伴" }, evidence: "结盟。", confidence: 0.9, novelty: "new", conflict: false },
    ];

    const { facts: kept, discardedCount } = await dedupeCharacterFactCandidates(project.id, facts);
    expect(kept).toHaveLength(2);
    expect(discardedCount).toBe(0);
  });
});
