import { beforeEach, describe, expect, it } from "vitest";
import { addEntity, createChapter, createNovelProject, novelDb, recordBase } from "../db";
import { autoAcceptSafeFactCandidates, bulkSetFactCandidateStatus, classifyFactRisk, commitAcceptedFacts, dedupeCharacterFactCandidates, filterAcceptableFactIds, filterSafeAcceptableFactIds, findExistingCharacter, formatFactCandidateValue, listFactAssertionsWithMeta, listKnowledgeAssertionsWithMeta, prepareFactCandidates, setFactCandidateStatus, storeFactCandidates } from "../facts";
import type { FactAssertion, StoryEntity, WorkflowRun } from "../types";
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
    expect(committed.committedCandidateIds).toHaveLength(1);

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
    expect(committed.committedCandidateIds).toHaveLength(0);

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
    expect(committed.committedCandidateIds).toHaveLength(0);
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
    expect(committed.committedCandidateIds).toHaveLength(0);
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
    expect(committed.committedCandidateIds).toHaveLength(1);
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
    const changed = await bulkSetFactCandidateStatus(candidates.map((item) => item.id), "rejected", novelDb, "auto-policy");
    expect(changed).toHaveLength(2);
    expect(await novelDb.factCandidates.get(candidates[1].id)).toMatchObject({ status: "rejected", decisionSource: "auto-policy" });
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
    expect(committed.committedCandidateIds).toHaveLength(1);

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

  // F-018 回归测试：novelty=new + targetId 已存在 + field=record 是矛盾组合
  // （新人物新建应省略 targetId，由系统生成 id）。classifyFactRisk 必须判 high，
  // 否则 commitAcceptedFacts 会走更新路径写入 entity.record 虚拟字段导致 entity 静默腐化。
  it("marks novelty=new + targetId + field=record as high to prevent entity corruption (F-018)", () => {
    const fact: ExtractedFact = {
      targetTable: "entities",
      targetId: "existing-entity-id",
      field: "record",
      after: { kind: "character", name: "新角色", aliases: [], summary: "", description: "" },
      evidence: "新角色登场。",
      confidence: 0.99,
      novelty: "new",
      conflict: false,
    };
    const result = classifyFactRisk(fact);
    expect(result.risk).toBe("high");
    // 不应再返回"正文首次出现的重要人物新建"的 safe 理由
    expect(result.riskReason).not.toBe("正文首次出现的重要人物新建");
  });

  it("still marks novelty=new + no targetId + field=record as safe when payload is valid character (F-018 regression)", () => {
    // 反例：正常新人物新建路径（无 targetId）仍应判 safe
    const fact: ExtractedFact = {
      targetTable: "entities",
      field: "record",
      after: { kind: "character", name: "李淳罡", aliases: ["老黄"], summary: "剑神", description: "" },
      evidence: "李淳罡登场。",
      confidence: 0.92,
      novelty: "new",
      conflict: false,
    };
    expect(classifyFactRisk(fact)).toMatchObject({ risk: "safe", riskReason: "正文首次出现的重要人物新建" });
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
    expect(committed.committedCandidateIds).toHaveLength(1);

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
    expect(committed.committedCandidateIds).toHaveLength(0);

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
    expect(committed.committedCandidateIds).toHaveLength(0);
  });

  // F-018 回归测试：commitAcceptedFacts 更新路径必须防御性 skip field=record 候选，
  // 防止 applyField 写入 entity.record 虚拟字段导致 entity 静默腐化。
  // 即使人通过 fact-approval 强制采纳矛盾组合（novelty=new+targetId+field=record），
  // commit 也不应执行该写入。
  it("skips field=record candidates on update path to prevent entity corruption (F-018)", async () => {
    const project = await createNovelProject({ title: "field=record 防御", genre: ["武侠"], premise: "测试 field=record 防御性 skip。" });
    const run = makeRun(project.id);
    await novelDb.workflowRuns.add(run);
    // 先创建一个已存在的 entity 作为 targetId 目标
    const existingEntity: StoryEntity = {
      ...recordBase(project.id),
      kind: "character",
      name: "原角色",
      aliases: [],
      summary: "原有角色",
      description: "",
      tags: [],
      lockedFacts: [],
      attributes: {},
    };
    await novelDb.entities.add(existingEntity);
    // 构造矛盾候选：novelty=new + targetId 指向已存在 entity + field=record
    // classifyFactRisk 已判 high（F-018 修复），但人工确认后仍进入 commit 更新路径
    await addAcceptedCandidate(project.id, run.id, {
      targetTable: "entities",
      targetId: existingEntity.id,
      field: "record",
      after: { kind: "character", name: "新角色名", aliases: [], summary: "", description: "" },
      novelty: "new",
    });

    const committed = await commitAcceptedFacts(project.id, run.id);
    // 应被防御性 skip，不写入
    expect(committed.committedCandidateIds).toHaveLength(0);
    expect(committed.skipped).toHaveLength(1);
    expect(committed.skipped[0]?.reason).toBe("update-record-field-not-allowed");
    // 验证原 entity 未被腐化——record 虚拟字段不应被写入
    const entityAfter = await novelDb.entities.get(existingEntity.id) as Record<string, unknown> | undefined;
    expect(entityAfter?.record).toBeUndefined();
    expect(entityAfter?.name).toBe("原角色");
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

describe("prepareFactCandidates - 可提交边界", () => {
  it("filters meta absence notes and unprojectable field updates", async () => {
    const { project, charA } = await seedProjectWithCharacters();
    const result = await prepareFactCandidates(project.id, [
      { targetTable: "entities", targetId: charA.id, field: "character.state.knowledge", after: "正文未建立其来历原因", humanReadable: "正文未建立其来历原因", evidence: "正文未说明角色为何来此。", confidence: 0.8, novelty: "new", conflict: false },
      { targetTable: "entities", field: "character.state.location", after: "北港", humanReadable: "陆沉位于北港", evidence: "陆沉站在北港。", confidence: 0.95, novelty: "new", conflict: false },
      { targetTable: "relations", field: "bond", after: "互相照应", humanReadable: "陆沉与苏黎互相照应", evidence: "两人互相照应。", confidence: 0.95, novelty: "update", conflict: false },
    ]);

    expect(result.facts).toEqual([]);
    expect(result.discardedMetaAbsenceCount).toBe(1);
    expect(result.discardedUnprojectableCount).toBe(2);
  });

  it("filters novelty=new field=record facts with non-object after (LLM 输出字符串型 after 的兜底)", async () => {
    // 回归测试：Loop 6 v2 ch3 因 LLM 输出 `after: "观察雾气不能只看一天..."` 字符串型 after，
    // commitAcceptedFacts L543 静默 continue 跳过该 fact，导致 promote 抛错
    // "事实投影未完整提交：expected=3 actual=1"。prepareFactCandidates 提前过滤可避免
    // 无效 fact 进入候选库，让 closed-loop auto-policy 不会接受这些 fact。
    const { project, charA } = await seedProjectWithCharacters();
    const result = await prepareFactCandidates(project.id, [
      // 原失败用例：novelty=new field=record after=字符串 → 应丢弃
      { targetTable: "entities", field: "record", after: "观察雾气不能只看一天", humanReadable: "挑水草的汉子提供观察雾气的方法", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
      // 原失败用例：novelty=new field=record after=null → 应丢弃
      { targetTable: "entities", field: "record", after: null, humanReadable: "无效 fact", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
      // 原失败用例：novelty=new field=record after=数组 → 应丢弃
      { targetTable: "timelineEvents", field: "record", after: ["条件1", "条件2"], humanReadable: "无效 fact", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
      // 反例：novelty=new field=record after=对象 → 应保留
      { targetTable: "entities", field: "record", after: { kind: "character", name: "新角色", summary: "描述" }, humanReadable: "新角色出现", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
      // 反例：novelty=update field=description after=字符串 → 应保留（update 允许字符串 after）
      // targetId 必须真实存在（否则被新预校验 discardedInvalidUpdateTargetCount 丢弃）
      { targetTable: "entities", targetId: charA.id, field: "description", after: "更新后的描述", humanReadable: "描述更新", evidence: "正文。", confidence: 0.9, novelty: "update", conflict: false },
    ]);

    expect(result.facts).toHaveLength(2);
    expect(result.discardedInvalidRecordCount).toBe(3);
    // 保留的两条：对象型 record + update 字符串型 description
    expect(result.facts[0]!.after).toEqual({ kind: "character", name: "新角色", summary: "描述" });
    expect(result.facts[1]!.after).toBe("更新后的描述");
  });

  it("filters novelty=update facts whose targetId does not exist (LLM 幻觉 targetId 的兜底)", async () => {
    // 回归测试：Loop 6 v3 ch6 三次 attempt 全部 rejected，错误为
    // "事实投影未完整提交：expected=7 actual=0" 和 "expected=4 actual=2"。
    // Root cause：LLM 输出 novelty=update 但 targetId 引用不存在的实体 ID
    // （幻觉 ID，或引用本章 draft 中提到但尚未落库的对象），commitAcceptedFacts L603-604
    // 静默 continue 跳过所有 update fact，promote 抛错。
    const { project, charA } = await seedProjectWithCharacters();
    const result = await prepareFactCandidates(project.id, [
      // 失败用例：novelty=update targetId 不存在 → 应丢弃
      { targetTable: "entities", targetId: "ent:hallucinated-1", field: "character.state.location", after: "北港", humanReadable: "幻觉角色抵达北港", evidence: "正文。", confidence: 0.95, novelty: "update", conflict: false },
      // 失败用例：novelty=update targetId 不存在 → 应丢弃
      { targetTable: "entities", targetId: "ent:hallucinated-2", field: "character.state.location", after: "南港", humanReadable: "幻觉角色抵达南港", evidence: "正文。", confidence: 0.95, novelty: "update", conflict: false },
      // 反例：novelty=update targetId 真实存在 → 应保留
      { targetTable: "entities", targetId: charA.id, field: "character.state.location", after: "北港", humanReadable: "陆沉抵达北港", evidence: "正文。", confidence: 0.95, novelty: "update", conflict: false },
    ]);

    expect(result.facts).toHaveLength(1);
    expect(result.discardedInvalidUpdateTargetCount).toBe(2);
    expect(result.facts[0]!.targetId).toBe(charA.id);
  });

  it("filters novelty=new relations whose (fromEntityId, toEntityId) already exists (LLM 误判 new 的兜底)", async () => {
    // 回归测试：LLM 偶尔把已有关系误判为 new（特别是 aliases 匹配失败时），
    // commitAcceptedFacts L571-577 对已存在关系静默 continue，promote 抛错。
    const { project, charA, charB } = await seedProjectWithCharacters();
    // 预置已存在关系
    await novelDb.relations.add({
      ...recordBase(project.id),
      fromEntityId: charA.id,
      toEntityId: charB.id,
      relationType: "同伴",
      publicLabel: "",
      privateTruth: "",
      bond: "已有关系",
    });
    const result = await prepareFactCandidates(project.id, [
      // 失败用例：novelty=new relation 已存在 → 应丢弃
      { targetTable: "relations", field: "record", after: { fromEntityId: charA.id, toEntityId: charB.id, relationType: "同伴", bond: "重复关系", publicLabel: "", privateTruth: "" }, humanReadable: "重复关系", evidence: "正文。", confidence: 0.95, novelty: "new", conflict: false },
      // 反例：novelty=new relation 不存在 → 应保留
      { targetTable: "relations", field: "record", after: { fromEntityId: charB.id, toEntityId: charA.id, relationType: "对立", bond: "新关系", publicLabel: "", privateTruth: "" }, humanReadable: "新关系", evidence: "正文。", confidence: 0.95, novelty: "new", conflict: false },
    ]);

    expect(result.facts).toHaveLength(1);
    expect(result.discardedDuplicateRelationCount).toBe(1);
  });

  it("filters facts whose targetTable is not in MUTABLE_TABLES (LLM 输出系统内部表名的兜底)", async () => {
    // 回归测试：LLM 偶尔把上下文中提到的系统概念（如 snapshots/derivedMemories）
    // 误判为可投影 targetTable，commitAcceptedFacts L546 对非法 targetTable 静默
    // continue，promote 抛错"事实投影未完整提交：expected=N actual=0"。
    // 此校验对所有 novelty 生效（不只 update），因为 targetTable 合法性是 fact 结构前提。
    const { project, charA } = await seedProjectWithCharacters();
    const result = await prepareFactCandidates(project.id, [
      // 失败用例 1：novelty=new + 非法 targetTable=snapshots → 应丢弃
      { targetTable: "snapshots", field: "record", after: { content: "陆沉初入江湖" }, humanReadable: "本章快照", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
      // 失败用例 2：novelty=new + 非法 targetTable=derivedMemories → 应丢弃
      { targetTable: "derivedMemories", field: "record", after: { summary: "陆沉觉醒" }, humanReadable: "衍生记忆", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
      // 失败用例 3：novelty=update + 非法 targetTable=workflowRuns → 应丢弃
      { targetTable: "workflowRuns", targetId: "run-1", field: "status", after: "completed", humanReadable: "工作流完成", evidence: "正文。", confidence: 0.9, novelty: "update", conflict: false },
      // 反例：novelty=new + 合法 targetTable=entities → 应保留
      { targetTable: "entities", field: "record", after: { kind: "character", name: "新人物", aliases: [], summary: "新人", description: "描述", lockedFacts: [] }, humanReadable: "新人物", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
      // 反例：novelty=update + 合法 targetTable=entities → 应保留
      { targetTable: "entities", targetId: charA.id, field: "character.state.location", after: "北港", humanReadable: "陆沉在北港", evidence: "正文。", confidence: 0.9, novelty: "update", conflict: false },
    ]);

    expect(result.facts).toHaveLength(2);
    expect(result.discardedInvalidTargetTableCount).toBe(3);
    expect(result.facts.map((f) => f.targetTable)).toEqual(["entities", "entities"]);
  });

  it("filters novelty=new relations missing endpoints (LLM 输出不完整 relation 的兜底)", async () => {
    // 回归测试：LLM 偶尔输出 relation payload 只含 fromEntityId 或只含 toEntityId，
    // commitAcceptedFacts L681-684 对缺 endpoints 的 relation 静默 continue，
    // promote 抛错"事实投影未完整提交：expected=N actual=0"。
    const { project, charA, charB } = await seedProjectWithCharacters();
    const result = await prepareFactCandidates(project.id, [
      // 失败用例 1：缺 toEntityId → 应丢弃
      { targetTable: "relations", field: "record", after: { fromEntityId: charA.id, relationType: "同伴", bond: "关系", publicLabel: "", privateTruth: "" }, humanReadable: "缺 toId", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
      // 失败用例 2：缺 fromEntityId → 应丢弃
      { targetTable: "relations", field: "record", after: { toEntityId: charB.id, relationType: "同伴", bond: "关系", publicLabel: "", privateTruth: "" }, humanReadable: "缺 fromId", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
      // 反例：endpoints 完整 → 应保留
      { targetTable: "relations", field: "record", after: { fromEntityId: charA.id, toEntityId: charB.id, relationType: "同伴", bond: "新关系", publicLabel: "", privateTruth: "" }, humanReadable: "完整关系", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
    ]);

    expect(result.facts).toHaveLength(1);
    expect(result.discardedRelationMissingEndpointsCount).toBe(2);
  });

  it("filters novelty=new characters missing name (LLM 输出 aliases 但忘 name 的兜底)", async () => {
    // 回归测试：LLM 偶尔输出 character payload 含 aliases 但忘了 name，
    // commitAcceptedFacts L698-701 对缺 name 的 character 静默 continue。
    const { project } = await seedProjectWithCharacters();
    const result = await prepareFactCandidates(project.id, [
      // 失败用例 1：缺 name → 应丢弃
      { targetTable: "entities", field: "record", after: { kind: "character", aliases: ["小陆"], summary: "新人", description: "描述", lockedFacts: [] }, humanReadable: "缺 name", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
      // 失败用例 2：name 为空字符串 → 应丢弃
      { targetTable: "entities", field: "record", after: { kind: "character", name: "  ", aliases: [], summary: "新人", description: "描述", lockedFacts: [] }, humanReadable: "name 空白", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
      // 反例：有 name → 应保留
      { targetTable: "entities", field: "record", after: { kind: "character", name: "苏婉", aliases: [], summary: "新人", description: "描述", lockedFacts: [] }, humanReadable: "苏婉", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
      // 反例：非 character kind 不校验 name → 应保留
      { targetTable: "entities", field: "record", after: { kind: "faction", name: "白云宗", summary: "宗门", description: "描述" }, humanReadable: "白云宗", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
    ]);

    expect(result.facts).toHaveLength(2);
    expect(result.discardedCharacterMissingNameCount).toBe(2);
  });

  it("filters novelty=update facts missing targetId (LLM 混淆 new/update 语义的兜底)", async () => {
    // 回归测试：LLM 偶尔输出 novelty=update 但忘了 targetId（混淆 new/update 语义），
    // commitAcceptedFacts L725-728 对 novelty=update 但 targetId 缺失的 fact 静默 continue。
    // 注意：field !== "record" 的情况会被前面的 !targetId && field !== "record" 检查捕获，
    // 这里测试 field === "record" 的情况（如 LLM 想替换整个 record 但忘了 targetId）。
    const { project, charA } = await seedProjectWithCharacters();
    const result = await prepareFactCandidates(project.id, [
      // 失败用例 1：novelty=update field=record 缺 targetId → 应丢弃
      { targetTable: "entities", field: "record", after: { kind: "character", name: "陆沉", summary: "更新", description: "描述", aliases: [], lockedFacts: [] }, humanReadable: "缺 targetId", evidence: "正文。", confidence: 0.9, novelty: "update", conflict: false },
      // 失败用例 2：novelty=update field=record targetId 为空字符串 → 应丢弃
      { targetTable: "entities", targetId: "", field: "record", after: { kind: "character", name: "陆沉", summary: "更新", description: "描述", aliases: [], lockedFacts: [] }, humanReadable: "targetId 空", evidence: "正文。", confidence: 0.9, novelty: "update", conflict: false },
      // 反例：novelty=update field=record 有 targetId 且目标存在 → 应保留
      { targetTable: "entities", targetId: charA.id, field: "record", after: { kind: "character", name: "陆沉", summary: "更新", description: "描述", aliases: [], lockedFacts: [] }, humanReadable: "陆沉更新", evidence: "正文。", confidence: 0.9, novelty: "update", conflict: false },
    ]);

    expect(result.facts).toHaveLength(1);
    expect(result.discardedUpdateMissingTargetIdCount).toBe(2);
  });

  it("filters facts with targetId that doesn't exist in db (LLM 输出幻觉 targetId 的兜底)", async () => {
    // 回归测试：Loop 6 v6 ch 13/ch 15 暴露的新 root cause。
    // LLM 偶尔输出 novelty=new + targetId=幻觉字段名（如 `character_luchen`、
    // `object_gray_seal_box`，混淆 entity 名/字段名与真实 UUID），commitAcceptedFacts
    // L784-792 的 update 路径对所有"非 new+无targetId"的 fact 生效，对 targetId 不存在
    // 的 fact 标记 `update-target-not-found` 并跳过，promote 抛错"事实投影未完整提交"。
    // prepareFactCandidates 必须对所有有 targetId 的 fact（不只 novelty=update）校验
    // targetId 真实存在。
    const { project, charA } = await seedProjectWithCharacters();
    const result = await prepareFactCandidates(project.id, [
      // 失败用例 1：novelty=new + field=character.state.* + targetId=幻觉字段名 → 应丢弃
      { targetTable: "entities", targetId: "character_luchen", field: "character.state.objective", after: "寻找真相", humanReadable: "陆沉目标", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
      // 失败用例 2：novelty=new + field=record + targetId=不存在的 UUID → 应丢弃
      { targetTable: "entities", targetId: "ent_non_existent_uuid", field: "record", after: { kind: "character", name: "新人", summary: "新人", description: "描述", aliases: [], lockedFacts: [] }, humanReadable: "幻觉 UUID", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
      // 失败用例 3：novelty=update + targetId=不存在的 UUID → 应丢弃
      { targetTable: "entities", targetId: "ent_another_fake", field: "character.state.location", after: "北港", humanReadable: "陆沉位置", evidence: "正文。", confidence: 0.9, novelty: "update", conflict: false },
      // 反例 1：novelty=new + field=character.state.* + targetId=真实 charA.id → 应保留
      { targetTable: "entities", targetId: charA.id, field: "character.state.objective", after: "新目标", humanReadable: "陆沉新目标", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
      // 反例 2：novelty=new + field=record + 无 targetId → 应保留（走 record 创建路径）
      { targetTable: "entities", field: "record", after: { kind: "character", name: "苏婉", summary: "新人", description: "描述", aliases: [], lockedFacts: [] }, humanReadable: "苏婉", evidence: "正文。", confidence: 0.9, novelty: "new", conflict: false },
    ]);

    expect(result.facts).toHaveLength(2);
    expect(result.discardedInvalidUpdateTargetCount).toBe(3);
  });

  it("commits knowledge deltas to the truth ledger without adding ad-hoc entity fields", async () => {
    const { project, charA } = await seedProjectWithCharacters();
    const run = makeRun(project.id);
    await novelDb.workflowRuns.add(run);
    const [candidate] = await storeFactCandidates({
      projectId: project.id,
      workflowRunId: run.id,
      sourceArtifactId: "artifact-knowledge",
      facts: [{
        targetTable: "entities",
        targetId: charA.id,
        field: "knowledgeDeltas",
        after: "陆沉得知北港封航",
        humanReadable: "陆沉得知北港封航",
        evidence: "报信人说北港今日封航。",
        confidence: 0.98,
        novelty: "new",
        conflict: false,
        knowledgeDeltas: [{ characterId: charA.id, stance: "known" }],
      }],
    });
    await setFactCandidateStatus(candidate.id, "accepted");

    expect((await commitAcceptedFacts(project.id, run.id)).committedCandidateIds).toEqual([candidate.id]);
    const entity = await novelDb.entities.get(charA.id) as unknown as Record<string, unknown>;
    expect(entity.knowledgeDeltas).toBeUndefined();
    const assertion = await novelDb.factAssertions.get(`fact:${candidate.id}`);
    expect(assertion?.projection).toBeUndefined();
    expect(await novelDb.knowledgeAssertions.where("factAssertionId").equals(`fact:${candidate.id}`).count()).toBe(1);
  });

  it("deduplicates the same subject field and value, preferring the stronger update", async () => {
    const { project, charA } = await seedProjectWithCharacters();
    const common = { targetTable: "entities", field: "character.state.location", subject: { kind: "entity" as const, id: charA.id }, after: "北港", humanReadable: "陆沉位于北港", evidence: "陆沉站在北港。", confidence: 0.95, conflict: false };
    const result = await prepareFactCandidates(project.id, [
      { ...common, targetId: charA.id, novelty: "update", confidence: 0.9 },
      { ...common, targetId: charA.id, novelty: "update", confidence: 0.99 },
    ]);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({ targetId: charA.id, novelty: "update", confidence: 0.99 });
    expect(result.discardedDuplicateFactCount).toBe(1);
  });

  it("uses the human-readable description for structured values", () => {
    expect(formatFactCandidateValue({ after: { fromEntityId: "a", toEntityId: "b" }, humanReadable: "陆沉与苏黎建立同伴关系" })).toBe("陆沉与苏黎建立同伴关系");
  });
});
