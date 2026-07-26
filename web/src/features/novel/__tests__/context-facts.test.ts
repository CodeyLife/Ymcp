import { beforeEach, describe, expect, it } from "vitest";
import { compileNovelContext } from "../context";
import { addOutlineNode, createChapter, createNovelProject, novelDb, recordBase, saveStoryArchitecture } from "../db";
import { commitAcceptedFacts, setFactCandidateStatus, storeFactCandidates } from "../facts";
import type { FactAssertion, StoryEntity } from "../types";

beforeEach(async () => {
  await novelDb.delete();
  await novelDb.open();
  localStorage.clear();
});

describe("context invariants and fact commits", () => {
  it("provides acts, plot segments, and chapter planning data without outline events", async () => {
    const project = await createNovelProject({ title: "规划上下文", genre: ["悬疑"], premise: "章节直接落实剧情段。" });
    const architecture = (await novelDb.architectures.where("projectId").equals(project.id).first())!;
    await saveStoryArchitecture({ ...architecture, status: "approved", phases: [{ id: "phase-1", title: "第一幕", purpose: "迫使主角离开", turningPoint: "故乡被封锁", order: 0, locked: false, primaryCurveId: "main" }] });
    const segment = await addOutlineNode(project.id, "phase-1", "离开故乡", 0);
    const chapter = await createChapter(project.id, "封锁之夜", segment.id);
    await novelDb.documents.update(chapter.id, { summary: "主角在封锁前夜作出离开的决定。", blueprint: { ...chapter.blueprint, objective: "离开故乡", plotThreadIds: ["main-thread"], foreshadowingIds: ["sealed-gate"] } });

    const packet = await compileNovelContext({ projectId: project.id, task: "plot-design", instruction: "继续规划", stage: "planning" });

    expect(packet.sources.find((source) => source.kind === "architecture")?.content).toContain("第一幕");
    expect(packet.sources.find((source) => source.id === segment.id)).toMatchObject({ title: "剧情段：离开故乡" });
    const chapterSource = packet.sources.find((source) => source.id === chapter.id);
    expect(chapterSource?.title).toBe("章节：封锁之夜");
    expect(chapterSource?.content).toContain(`所属剧情段：${segment.id}`);
    expect(chapterSource?.content).toContain("剧情线：main-thread");
    expect(packet.sources.some((source) => source.title.includes("事件"))).toBe(false);
  });

  it("surfaces project sellingPoints in the mandatory project source so every stage can deliver them", async () => {
    const withPoints = await createNovelProject({ title: "卖点兑现", genre: ["仙侠"], premise: "灵气即代码——修士以符箓语法改写天地规则。" });
    await novelDb.projects.update(withPoints.id, { sellingPoints: ["灵气即代码：以编程逻辑重构修仙体系", "冷峻克制的庙堂权谋"] });
    const packetWith = await compileNovelContext({ projectId: withPoints.id, task: "planning", instruction: "规划第一章", stage: "planning" });
    const projectSourceWith = packetWith.sources.find((source) => source.id === `style:${withPoints.id}`)!;
    expect(projectSourceWith.content).toContain("卖点");
    expect(projectSourceWith.content).toContain("灵气即代码：以编程逻辑重构修仙体系");

    // 反例：项目未声明卖点时不应注入卖点行，避免污染上下文
    const withoutPoints = await createNovelProject({ title: "无卖点", genre: ["悬疑"], premise: "一个没有声明卖点的项目。" });
    const packetWithout = await compileNovelContext({ projectId: withoutPoints.id, task: "planning", instruction: "规划第一章", stage: "planning" });
    const projectSourceWithout = packetWithout.sources.find((source) => source.id === `style:${withoutPoints.id}`)!;
    expect(projectSourceWithout.content).not.toContain("卖点（须在合适章节");
    expect(projectSourceWithout.content).not.toContain("卖点（须在合适章节被读者在正文亲历其运作");
  });

  it("includes complete mandatory rules without applying a project token budget", async () => {
    const project = await createNovelProject({ title: "规则测试", genre: ["奇幻"], premise: "潮水会改变记忆。" });
    const rule: StoryEntity = { ...recordBase(project.id), kind: "rule", name: "潮汐规则", aliases: [], summary: "退潮前不可说出失踪者姓名", description: "潮水".repeat(1200), tags: [], lockedFacts: ["退潮前说出姓名会让说话者失去相关记忆"], attributes: {} };
    await novelDb.entities.add(rule);
    const packet = await compileNovelContext({ projectId: project.id, task: "planning", instruction: "规划第一章", stage: "planning" });
    expect(packet.sources.find((item) => item.id === rule.id)?.content).toContain("潮水".repeat(1200));
    expect(packet.omittedSourceIds).toEqual([]);
  });

  it("pins approved architecture and the target chapter scene plan", async () => {
    const project = await createNovelProject({ title: "架构测试", genre: ["科幻"], premise: "城市每天失去一小时。" });
    const architecture = await novelDb.architectures.where("projectId").equals(project.id).first();
    await saveStoryArchitecture({
      ...architecture!,
      status: "approved",
      phases: [{ id: "phase-1", title: "中段升级", purpose: "主角发现丢失的时间被人保存。", turningPoint: "主角决定夺回时间。", order: 0, locked: true, primaryCurveId: "main" }],
    });
    const document = await createChapter(project.id, "第一章");
    await novelDb.scenes.add({
      ...recordBase(project.id),
      chapterId: document.id,
      title: "钟楼对峙",
      order: 0,
      status: "planned",
      characterIds: [],
      purpose: "揭示时间存储装置",
      conflict: "主角必须决定是否关闭装置",
      outcome: "装置继续运行，但代价转移给主角",
      wordTarget: 1200,
      beats: [{ id: "scene-beat-1", text: "主角启动逆向计时", order: 0 }],
    });
    const packet = await compileNovelContext({ projectId: project.id, task: "rewrite", instruction: "检查本章是否兑现架构", targetDocumentId: document!.id, stage: "revision" });
    expect(packet.sources.find((source) => source.kind === "architecture")).toMatchObject({ pinned: true, priorityClass: "invariant" });
    expect(packet.sources.find((source) => source.kind === "scene" && source.title.includes("钟楼对峙"))).toMatchObject({ pinned: true, priorityClass: "working" });
  });

  it("commits only accepted non-conflicting facts and writes an operation", async () => {
    const project = await createNovelProject({ title: "事实测试", genre: ["悬疑"], premise: "档案会改写现实。" });
    const entity: StoryEntity = { ...recordBase(project.id), kind: "item", name: "黑色账本", aliases: [], summary: "尚未发现", description: "", tags: [], lockedFacts: [], attributes: {} };
    await novelDb.entities.add(entity);
    const [accepted, conflict] = await storeFactCandidates({ projectId: project.id, workflowRunId: "run-1", sourceArtifactId: "draft-1", facts: [
      { targetTable: "entities", targetId: entity.id, field: "summary", before: "尚未发现", after: "被主角藏在钟楼", evidence: "他把黑色账本塞进钟楼夹层。", confidence: 0.96, novelty: "update", conflict: false },
      { targetTable: "entities", targetId: entity.id, field: "description", after: "自动消失", evidence: "可疑描述", confidence: 0.5, novelty: "update", conflict: true },
    ] });
    await setFactCandidateStatus(accepted.id, "accepted");
    await expect(setFactCandidateStatus(conflict.id, "accepted")).rejects.toThrow(/冲突事实/);
    const committed = await commitAcceptedFacts(project.id, "run-1");
    expect(committed.committedCandidateIds).toEqual([accepted.id]);
    expect((await novelDb.entities.get(entity.id))?.summary).toBe("被主角藏在钟楼");
    expect((await novelDb.entities.get(entity.id))?.description).toBe("");
    expect((await novelDb.operations.where("projectId").equals(project.id).toArray()).filter((item) => item.entityId === entity.id)).toHaveLength(1);
  });

  it("filters formal facts by the target chapter reveal cutoff and records a context receipt", async () => {
    const project = await createNovelProject({ title: "揭示截止", genre: ["悬疑"], premise: "未来真相不能提前泄露。" });
    await createChapter(project.id, "第一章");
    await createChapter(project.id, "第二章");
    const target = await createChapter(project.id, "第三章");
    const assertion = (id: string, order: number, text: string): FactAssertion => ({
      ...recordBase(project.id), id, subject: { kind: "project", id: project.id }, predicate: "mystery.truth", object: { kind: "string", value: text }, polarity: "affirmed", truthStatus: "objective", timeMode: "timeless", revealedAt: { narrativeOrder: order, precision: "exact" }, sourceRevisionId: `revision-${order}`, provenance: "approved-revision", evidence: text, confidence: 1, humanReadable: text, status: "active", derivedFromCandidateId: `candidate-${order}`,
    });
    await novelDb.factAssertions.bulkAdd([assertion("fact-early", 1, "钟楼藏有账本"), assertion("fact-future", 4, "凶手是城主")]);

    const packet = await compileNovelContext({ projectId: project.id, task: "chapter-draft", instruction: "写第三章", targetDocumentId: target.id, stage: "drafting", informationView: "reader" });

    expect(packet.sources.some((item) => item.id === "fact-early")).toBe(true);
    expect(packet.sources.some((item) => item.id === "fact-future")).toBe(false);
    expect(packet.informationView).toMatchObject({ mode: "reader", targetDocumentId: target.id, targetNarrativeOrder: 2 });
    expect(packet.layerUsage).toBeDefined();
    expect(packet.sources.every((item) => Boolean(item.layer && item.visibilityReason))).toBe(true);
  });

  it("shows a character-held secret as cognition without exposing it as reader-visible fact", async () => {
    const project = await createNovelProject({ title: "角色认知", genre: ["悬疑"], premise: "角色知道的秘密不等于读者已知。" });
    const character: StoryEntity = { ...recordBase(project.id), kind: "character", name: "陆沉", aliases: [], summary: "", description: "", tags: [], lockedFacts: [], attributes: {}, character: { role: "主角", appearance: "", personality: "", desire: "", motivation: "", weakness: "", secret: "", abilities: [], voice: "", arc: "", state: { location: "", physical: "正常", emotional: "平静", objective: "", inventory: [], relationshipNotes: [] } } };
    await novelDb.entities.add(character);
    await createChapter(project.id, "序章");
    const target = await createChapter(project.id, "第一章");
    await novelDb.documents.update(target.id, { blueprint: { ...target.blueprint, povCharacterId: character.id, characterIds: [character.id] } });
    const fact: FactAssertion = { ...recordBase(project.id), id: "fact-secret", subject: { kind: "project", id: project.id }, predicate: "mystery.truth", object: { kind: "string", value: "城主是凶手" }, polarity: "affirmed", truthStatus: "objective", timeMode: "timeless", revealedAt: { narrativeOrder: 10, precision: "exact" }, sourceRevisionId: "revision-secret", provenance: "approved-revision", evidence: "作者秘密", confidence: 1, humanReadable: "城主是凶手", status: "active", derivedFromCandidateId: "candidate-secret" };
    await novelDb.factAssertions.add(fact);
    await novelDb.knowledgeAssertions.add({ ...recordBase(project.id), id: "knowledge-secret", characterId: character.id, factAssertionId: fact.id, stance: "known", learnedAt: { narrativeOrder: 0, precision: "exact" }, sourceRevisionId: "revision-secret", status: "active" });

    const packet = await compileNovelContext({ projectId: project.id, task: "chapter-draft", instruction: "从陆沉视角写作", targetDocumentId: target.id, stage: "drafting" });

    expect(packet.informationView).toMatchObject({ mode: "character", characterId: character.id });
    expect(packet.sources.some((item) => item.id === fact.id)).toBe(false);
    expect(packet.sources.find((item) => item.id === "knowledge-secret")).toMatchObject({ kind: "knowledge", layer: "mandatory" });
  });

  it("keeps character context inside the selected character's knowledge and story-time boundary", async () => {
    const project = await createNovelProject({ title: "角色边界", genre: ["悬疑"], premise: "读者与角色掌握不同信息。" });
    const character: StoryEntity = {
      ...recordBase(project.id),
      kind: "character",
      name: "陆沉",
      aliases: [],
      summary: "调查员",
      description: "",
      tags: [],
      lockedFacts: [],
      attributes: {},
      character: {
        role: "主角",
        appearance: "黑色风衣",
        personality: "谨慎",
        desire: "找到真相",
        motivation: "保护证人",
        weakness: "多疑",
        secret: "",
        abilities: [],
        voice: "简短",
        arc: "",
        state: { location: "第十章才抵达的南港", physical: "受伤", emotional: "警惕", objective: "追查", inventory: [], relationshipNotes: [] },
      },
    };
    await novelDb.entities.add(character);
    await createChapter(project.id, "第一章");
    await createChapter(project.id, "第二章");
    const target = await createChapter(project.id, "第三章");
    await novelDb.documents.update(target.id, { blueprint: { ...target.blueprint, povCharacterId: character.id, characterIds: [character.id] } });

    const assertion = (id: string, text: string, revealedOrder: number): FactAssertion => ({
      ...recordBase(project.id),
      id,
      subject: { kind: "project", id: project.id },
      predicate: `mystery.${id}`,
      object: { kind: "string", value: text },
      polarity: "affirmed",
      truthStatus: "objective",
      timeMode: "timeless",
      revealedAt: { narrativeOrder: revealedOrder, precision: "exact" },
      sourceRevisionId: `revision-${id}`,
      provenance: "approved-revision",
      evidence: text,
      confidence: 1,
      humanReadable: text,
      status: "active",
      derivedFromCandidateId: `candidate-${id}`,
    });
    const readerOnly = assertion("reader-only", "读者知道钟楼有密室", 0);
    const knownNow = assertion("known-now", "陆沉知道密钥在井里", 8);
    const learnedLater = assertion("learned-later", "陆沉将在第五章知道城主身份", 8);
    await novelDb.factAssertions.bulkAdd([readerOnly, knownNow, learnedLater]);
    await novelDb.knowledgeAssertions.bulkAdd([
      { ...recordBase(project.id), id: "knowledge-now", characterId: character.id, factAssertionId: knownNow.id, stance: "known", learnedAt: { narrativeOrder: 1, precision: "exact" }, sourceRevisionId: knownNow.sourceRevisionId, status: "active" },
      { ...recordBase(project.id), id: "knowledge-later", characterId: character.id, factAssertionId: learnedLater.id, stance: "known", learnedAt: { narrativeOrder: 4, precision: "exact" }, sourceRevisionId: learnedLater.sourceRevisionId, status: "active" },
    ]);

    const packet = await compileNovelContext({ projectId: project.id, task: "chapter-draft", instruction: "从陆沉视角写第三章", targetDocumentId: target.id, stage: "drafting" });

    expect(packet.sources.some((item) => item.id === readerOnly.id)).toBe(false);
    expect(packet.sources.some((item) => item.id === "knowledge-now")).toBe(true);
    expect(packet.sources.some((item) => item.id === "knowledge-later")).toBe(false);
    expect(packet.sources.find((item) => item.id === character.id)?.content).not.toContain("第十章才抵达的南港");
  });
});

// F-003 回归测试：ROLE_SOURCE_KINDS 必须覆盖所有 NovelAgentRole，
// 且 push() 必须按角色白名单过滤 source kind——不允许"角色已指定但白名单缺省"
// 被等同于"角色未指定"而无差别注入所有 source kind。
describe("F-003: ROLE_SOURCE_KINDS covers all NovelAgentRole and filters by role", () => {
  it("quality-editor role does not receive architecture/outline sources outside its whitelist", async () => {
    const project = await createNovelProject({ title: "审校角色过滤", genre: ["悬疑"], premise: "测试 quality-editor 角色白名单生效。" });
    const architecture = (await novelDb.architectures.where("projectId").equals(project.id).first())!;
    await saveStoryArchitecture({ ...architecture, status: "approved", phases: [{ id: "phase-1", title: "第一幕", purpose: "破局", turningPoint: "线索显现", order: 0, locked: false, primaryCurveId: "main" }] });
    await addOutlineNode(project.id, "phase-1", "破局起点", 0);
    const chapter = await createChapter(project.id, "线索之夜");

    const packet = await compileNovelContext({
      projectId: project.id,
      task: "chapter-review",
      instruction: "审校第一章",
      targetDocumentId: chapter.id,
      stage: "review",
      consumer: { workflowRunId: undefined, stage: "review", role: "quality-editor" },
    });

    // quality-editor 白名单应包含 instruction/style/document 等审校核心来源
    expect(packet.sources.some((s) => s.kind === "instruction")).toBe(true);
    expect(packet.sources.some((s) => s.kind === "style")).toBe(true);
    expect(packet.sources.some((s) => s.kind === "document")).toBe(true);
    // quality-editor 白名单不包含 outline（不在白名单中），应被过滤
    expect(packet.sources.some((s) => s.kind === "outline")).toBe(false);
  });

  it("memory-curator role only receives curation-relevant sources", async () => {
    const project = await createNovelProject({ title: "记忆策展过滤", genre: ["都市"], premise: "测试 memory-curator 角色白名单生效。" });
    const architecture = (await novelDb.architectures.where("projectId").equals(project.id).first())!;
    await saveStoryArchitecture({ ...architecture, status: "approved", phases: [{ id: "phase-1", title: "开端", purpose: "相遇", turningPoint: "雨夜", order: 0, locked: false, primaryCurveId: "main" }] });
    await addOutlineNode(project.id, "phase-1", "相遇", 0);
    const chapter = await createChapter(project.id, "雨夜");

    const packet = await compileNovelContext({
      projectId: project.id,
      task: "memory-curation",
      instruction: "策展本章记忆",
      targetDocumentId: chapter.id,
      stage: "review",
      consumer: { workflowRunId: undefined, stage: "review", role: "memory-curator" },
    });

    // memory-curator 白名单：instruction/document/entity/relation/fact/knowledge/memory/creative-brief/skill
    expect(packet.sources.some((s) => s.kind === "instruction")).toBe(true);
    expect(packet.sources.some((s) => s.kind === "document")).toBe(true);
    // memory-curator 不在白名单中的来源应被过滤
    expect(packet.sources.some((s) => s.kind === "outline")).toBe(false);
    expect(packet.sources.some((s) => s.kind === "scene")).toBe(false);
    expect(packet.sources.some((s) => s.kind === "taste")).toBe(false);
  });

  it("conversation-assistant role receives minimal conversational sources", async () => {
    const project = await createNovelProject({ title: "对话助理过滤", genre: ["古风"], premise: "测试 conversation-assistant 角色白名单生效。" });

    const packet = await compileNovelContext({
      projectId: project.id,
      task: "conversation",
      instruction: "与作者对话",
      stage: "drafting",
      consumer: { workflowRunId: undefined, stage: "review", role: "conversation-assistant" },
    });

    // conversation-assistant 白名单：instruction/style/document/creative-brief/skill/conversation-memory
    expect(packet.sources.some((s) => s.kind === "instruction")).toBe(true);
    expect(packet.sources.some((s) => s.kind === "style")).toBe(true);
    // conversation-assistant 不应看到 architecture/entity/outline 等结构化来源
    expect(packet.sources.some((s) => s.kind === "architecture")).toBe(false);
    expect(packet.sources.some((s) => s.kind === "entity")).toBe(false);
    expect(packet.sources.some((s) => s.kind === "outline")).toBe(false);
  });

  it("reader-reviewer role does not receive entity/relation/outline sources", async () => {
    const project = await createNovelProject({ title: "读者审校过滤", genre: ["悬疑"], premise: "测试 reader-reviewer 角色白名单生效。" });
    const entity: StoryEntity = { ...recordBase(project.id), kind: "character", name: "主角", aliases: [], summary: "侦探", description: "", tags: [], lockedFacts: [], attributes: {} };
    await novelDb.entities.add(entity);
    const architecture = (await novelDb.architectures.where("projectId").equals(project.id).first())!;
    await saveStoryArchitecture({ ...architecture, status: "approved", phases: [{ id: "phase-1", title: "开端", purpose: "破案", turningPoint: "现场", order: 0, locked: false, primaryCurveId: "main" }] });
    await addOutlineNode(project.id, "phase-1", "案发现场", 0);
    const chapter = await createChapter(project.id, "第一案");

    const packet = await compileNovelContext({
      projectId: project.id,
      task: "chapter-review",
      instruction: "从读者视角审校",
      targetDocumentId: chapter.id,
      stage: "review",
      consumer: { workflowRunId: undefined, stage: "review", role: "reader-reviewer" },
    });

    // reader-reviewer 白名单：instruction/style/taste/document/thread/foreshadowing/creative-brief/skill/conversation-memory
    expect(packet.sources.some((s) => s.kind === "instruction")).toBe(true);
    expect(packet.sources.some((s) => s.kind === "style")).toBe(true);
    expect(packet.sources.some((s) => s.kind === "document")).toBe(true);
    // reader-reviewer 不应看到 entity/relation/architecture/outline（不在白名单中）
    expect(packet.sources.some((s) => s.kind === "entity")).toBe(false);
    expect(packet.sources.some((s) => s.kind === "architecture")).toBe(false);
    expect(packet.sources.some((s) => s.kind === "outline")).toBe(false);
  });

  it("skill-iterator role only receives skill/style/taste/document sources", async () => {
    const project = await createNovelProject({ title: "技能迭代过滤", genre: ["科幻"], premise: "测试 skill-iterator 角色白名单生效。" });

    const packet = await compileNovelContext({
      projectId: project.id,
      task: "skill-iteration",
      instruction: "评估审校经验并提议技能改进",
      stage: "review",
      consumer: { workflowRunId: undefined, stage: "review", role: "skill-iterator" },
    });

    // skill-iterator 白名单：instruction/style/taste/document/creative-brief/skill
    // 注：skill source 注入依赖项目有 skill，空项目可能不注入，只验证 instruction 必存在
    expect(packet.sources.some((s) => s.kind === "instruction")).toBe(true);
    // skill-iterator 不应看到 entity/relation/outline/scene 等结构化来源
    expect(packet.sources.some((s) => s.kind === "entity")).toBe(false);
    expect(packet.sources.some((s) => s.kind === "outline")).toBe(false);
    expect(packet.sources.some((s) => s.kind === "scene")).toBe(false);
    expect(packet.sources.some((s) => s.kind === "fact")).toBe(false);
  });

  it("undefined role (no consumer) injects all source kinds without filtering", async () => {
    // 反例：未指定 role 时 allowedKinds 为 undefined，push() 跳过过滤，所有 source kind 都可注入
    const project = await createNovelProject({ title: "无角色过滤", genre: ["都市"], premise: "测试未指定 role 时不过滤。" });
    const architecture = (await novelDb.architectures.where("projectId").equals(project.id).first())!;
    await saveStoryArchitecture({ ...architecture, status: "approved", phases: [{ id: "phase-1", title: "第一幕", purpose: "相遇", turningPoint: "雨夜", order: 0, locked: false, primaryCurveId: "main" }] });
    await addOutlineNode(project.id, "phase-1", "相遇", 0);

    const packet = await compileNovelContext({
      projectId: project.id,
      task: "planning",
      instruction: "规划章节",
      stage: "planning",
      // 不传 consumer，role 为 undefined
    });

    // 未指定 role 时不过滤，architecture/outline 等都可以注入
    expect(packet.sources.some((s) => s.kind === "architecture")).toBe(true);
    expect(packet.sources.some((s) => s.kind === "outline")).toBe(true);
    expect(packet.sources.some((s) => s.kind === "instruction")).toBe(true);
  });
});
