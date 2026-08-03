import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ARC_PLAN_CHECK_DIMENSIONS, canGenerateNextStoryArcBatch, CHAPTER_PLAN_CHECK_DIMENSIONS, compileChapterPlanValidationReport, normalizeChapterPlanningContext, normalizeStoryArcRebaseBundle, normalizeStakeKnowledgeBasis, normalizeStoryArcStakes, parseStoryArcBundle, planningContextFingerprint, validateStoryArcExecutionContracts, validateStoryArcRebaseBundle, type ChapterPlanningContext, type StoryArcRebaseTarget } from "../application/story-arc";
import { normalizeStoryArcReviewAuthority, storyArcAuthorityPaths, storyArcReviewStrategy } from "../application/story-arc-review-policy";
import { startStoryArcPlanning, startStoryArcReview } from "../application/story-arc-workflow";
import { NovelPostgresRepository } from "../postgres-repository";
import type { Client } from "@temporalio/client";
import type { Artifact, NarrativeStateSnapshot } from "../protocol";
import { renderChapterPlanningContext, renderNarrativeRhythm } from "../prompts/chapter-planning-context";
import { buildStoryArcBatchPrompt, buildStoryArcPrompt, buildStoryArcRebasePrompt, buildStoryArcReviewPrompt, storyArcBundleSchema, validateStoryArcReview } from "../prompts/story-arc";

const bundle = parseStoryArcBundle({
  arc: { title: "停电夜", objective: "让彼此戒备的两人建立最低限度信任", entryState: "互相怀疑", centralConflict: "证据与求生选择冲突", development: ["被迫同行", "交换一部分事实"], resolution: "共同保住证据", exitState: "愿意短暂合作", plotThreadRefs: ["main"], foreshadowingRefs: ["f-1"], expectedChapterCount: 20, phases: [{ title: "受困", objective: "共同求生", exitCondition: "取得证据" }, { title: "试探", objective: "建立最低信任", exitCondition: "愿意合作" }] },
  batch: { batchIndex: 1, startChapterIndex: 1, complete: false },
  chapters: Array.from({ length: 7 }, (_, index) => ({ index: index + 10, title: `章 ${index + 1}`, summary: `第 ${index + 1} 章摘要`, chapterPurpose: index === 5 ? "关系沉淀" : "局部推进", dramaticQuestion: "是否愿意相信对方", emotionalMovement: "戒备到试探", stateDeltaBudget: "只改变一层信任", narrativeScale: { level: index === 5 ? "compact" : "standard", reason: index === 5 ? "关系余波只需完成一次停顿和留白" : "普通章节需要完整经历试探与选择", developmentAxes: ["接触", "试探", "选择后的余波"], stoppingCondition: "人物完成当前阶段的选择并留下真实未解问题" }, optionalBeats: ["一次停顿"], scenes: [{ title: "楼梯间", summary: "借微光辨认脚步", participants: ["甲", "乙"] }], continuityConstraints: ["不得得知后续真相"], setupRefs: [], payoffRefs: [], closingForce: "未尽交流", freedom: "允许内省和氛围积累" })),
});
const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("story arc planning contract", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-story-arc-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Story Arc Test");
      await repository.pool.query("INSERT INTO books(id,project_id,title) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [`book:${projectId}:test`, projectId, "测试书"]);
      await repository.pool.query("INSERT INTO volumes(id,book_id,title,ordinal) VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING", [`volume:${projectId}:test`, `book:${projectId}:test`, "正文"]);
      available = true;
    } catch (error) {
      console.warn(`[story-arc.test] Postgres 不可用，跳过故事弧仓储集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("does not embed first-batch instructions in a later batch", () => {
    const prompt = buildStoryArcBatchPrompt({ projectTitle: "Test", macro: [], recentChapters: [], openThreads: [], arc: bundle.arc, batchIndex: 3, startChapterIndex: 14 });
    expect(prompt).toContain("batchIndex=3、startChapterIndex=14");
    expect(prompt).not.toContain("batchIndex=1、startChapterIndex=1");
    expect(prompt).not.toContain("只展开第一批");
    expect(prompt).not.toContain("只展开 5–8 章");
    expect(prompt).toContain("旧批次中的未发生设想不是事实");
    expect(prompt).toContain("先复核长篇层级");
    expect(prompt).toContain("不要因为最近章节反复出现某个场景、母题或生存压力，就把后续批次继续机械扩写同一套关键词");
    expect(prompt).toContain("不必每章制造新压力");
  });

  it("lets the model choose batch size instead of encoding a fixed five-chapter contract", () => {
    const narrativeState = {
      id: "state-1", projectId: "p", documentId: "doc-7", revisionId: "rev-7", narrativeOrder: 7,
      chapterSummary: "主角暂时留下来调查旧案", keyEvents: ["决定留下"],
      characterStates: [{ characterId: "hero", stateSnapshot: "从逃避转为主动调查" }],
      openThreads: ["main:旧案"], openForeshadowings: [], openPromises: [], fulfilledNodes: [],
      prohibitedEarlyConsumption: ["幕后身份"], continuityConstraints: [], fingerprint: "state-fp", createdAt: 1,
    } satisfies NarrativeStateSnapshot;
    const prompt = buildStoryArcPrompt({ projectTitle: "Test", macro: [], recentChapters: [], openThreads: [], narrativeState });
    expect(prompt).toContain("不固定五章");
    expect(prompt).toContain("卷/篇章分区不是故事弧");
    expect(prompt).toContain("先建立长篇层级关系");
    expect(prompt).toContain("不要要求每章都有新信息、新压力、新爽点或主线推进");
    expect(prompt).toContain("重复是长篇的节奏资源，不是默认缺陷");
    expect(prompt).toContain("章节标题优先指向本章可见事件/冲突/意象");
    expect(prompt).toContain("已定稿事实与叙事状态账本 >");
    expect(prompt).toContain("全书长程战略");
    expect(prompt).toContain("幕后身份");
    expect(storyArcBundleSchema.properties.chapters.minItems).toBe(1);
    expect(storyArcBundleSchema.properties.chapters.maxItems).toBe(16);
    expect(storyArcBundleSchema.properties.chapters.items.required).toContain("narrativeScale");
    expect(prompt).toContain("standard 是普通网文的完整章节体量参考");
    expect(prompt).toContain("不是最低字数");
    expect(prompt).toContain("developmentAxes");
  });

  it("rebuilds the exact committed chapter map instead of planning the next arc", () => {
    const target: StoryArcRebaseTarget = {
      arcId: "arc-completed",
      executionStatus: "completed",
      approvedArc: bundle.arc,
      batchIndex: 1,
      startChapterIndex: 1,
      chapters: bundle.chapters.slice(0, 5).map((chapter, index) => ({
        chapterId: `chapter-${index + 1}`,
        documentId: `document-${index + 1}`,
        globalOrder: index + 1,
        title: chapter.title,
        revisionId: `revision-${index + 1}`,
        approvedPlan: { summary: chapter.summary, sceneEvents: chapter.scenes.map((scene) => scene.summary), continuityConstraints: [], setupRefs: [], payoffRefs: [] },
        committedMemory: { summary: chapter.summary, keyEvents: [`事件 ${index + 1}`], characterStates: [], unresolvedThreads: [], emotionalArc: chapter.emotionalMovement },
        authoritativeFacts: [],
      })),
    };
    const prompt = buildStoryArcRebasePrompt({ projectTitle: "Test", macro: [], recentChapters: [], openThreads: [], target });
    const rebuilt = parseStoryArcBundle({
      arc: { ...bundle.arc, expectedChapterCount: 5, thematicQuestions: [] },
      batch: { batchIndex: 1, startChapterIndex: 1, complete: true },
      chapters: bundle.chapters.slice(0, 5).map((chapter) => ({
        ...chapter,
        narrativeFunction: "development",
        readerExperience: "跟随人物完成当前章节的具体行动",
        thematicTreatment: { mode: "absent", questionRefs: [], carrier: "none", evidenceChange: "", expositionBoundary: "本章不解释主题" },
        unresolvedAtClose: [],
      })),
    });
    const wrongNextArc = parseStoryArcBundle({ ...rebuilt, arc: { ...rebuilt.arc, expectedChapterCount: 12 }, batch: { batchIndex: 1, startChapterIndex: 6, complete: false }, chapters: rebuilt.chapters.slice(0, 3) });

    expect(prompt).toContain("这不是续写、下一批规划或新故事弧规划");
    expect(prompt).toContain('"documentId": "document-5"');
    expect(() => validateStoryArcRebaseBundle(rebuilt, target)).not.toThrow();
    expect(() => validateStoryArcRebaseBundle(wrongNextArc, target)).toThrow("必须保持原批次位置");
    const upgradedForeground = parseStoryArcBundle({ ...rebuilt, chapters: [{ ...rebuilt.chapters[0], thematicTreatment: { mode: "foreground", questionRefs: ["trust"], carrier: "dialogue-conflict", evidenceChange: "双方争执", expositionBoundary: "不宣布答案" } }, ...rebuilt.chapters.slice(1)] });
    expect(() => validateStoryArcRebaseBundle(upgradedForeground, target)).toThrow("不得把缺少显式 foreground 契约的历史章节事后升级为 foreground");
    const normalized = normalizeStoryArcRebaseBundle(upgradedForeground, target);
    expect(normalized.chapters[0].thematicTreatment).toEqual({ mode: "absent", questionRefs: [], carrier: "none", evidenceChange: "", expositionBoundary: "" });
    expect(() => validateStoryArcRebaseBundle(normalized, target)).not.toThrow();
    const speculativeUnknown = parseStoryArcBundle({
      ...rebuilt,
      chapters: [{
        ...rebuilt.chapters[0],
        scenes: [{
          ...rebuilt.chapters[0].scenes[0],
          participantStakes: [{
            participant: "甲", want: "观察现场", leverage: "视线", withholding: "幕后主顾", failureCost: "场外任务失败",
            knowledgeBasis: { want: "observable-inference", leverage: "committed", withholding: "unknown", failureCost: "unknown" },
          }],
        }],
      }, ...rebuilt.chapters.slice(1)],
    });
    const epistemicallyNormalized = normalizeStoryArcRebaseBundle(speculativeUnknown, target);
    expect(epistemicallyNormalized.chapters[0].scenes[0].participantStakes?.[0]).toMatchObject({ withholding: "", failureCost: "" });
    expect(() => validateStoryArcRebaseBundle(epistemicallyNormalized, target)).not.toThrow();
    const speculativePlanned = parseStoryArcBundle({
      ...rebuilt,
      chapters: [{
        ...rebuilt.chapters[0],
        scenes: [{
          ...rebuilt.chapters[0].scenes[0],
          participantStakes: [{ participant: "甲", want: "未知动机", leverage: "", withholding: "", failureCost: "", knowledgeBasis: { want: "planned", leverage: "unknown", withholding: "unknown", failureCost: "unknown" } }],
        }],
      }, ...rebuilt.chapters.slice(1)],
    });
    const plannedBasisNormalized = normalizeStoryArcRebaseBundle(speculativePlanned, target);
    expect(plannedBasisNormalized.chapters[0].scenes[0].participantStakes?.[0]).toMatchObject({ want: "", knowledgeBasis: { want: "unknown" } });
    expect(() => validateStoryArcRebaseBundle(plannedBasisNormalized, target)).not.toThrow();
    const foregroundTarget: StoryArcRebaseTarget = {
      ...target,
      chapters: target.chapters.map((chapter, index) => index === 0
        ? { ...chapter, approvedPlan: { ...chapter.approvedPlan, thematicMode: "foreground" } }
        : chapter),
    };
    const preservedForeground = normalizeStoryArcRebaseBundle(upgradedForeground, foregroundTarget);
    expect(preservedForeground.chapters[0].thematicTreatment?.mode).toBe("foreground");
    expect(() => validateStoryArcRebaseBundle(preservedForeground, foregroundTarget)).not.toThrow();
    expect(storyArcBundleSchema.properties.arc.properties.expectedChapterCount.minimum).toBe(1);
    expect(buildStoryArcReviewPrompt(rebuilt, "context", target)).toContain("重基线专用门禁");
  });

  it("preserves approved forward blueprints for chapters without committed revisions", () => {
    const baseTarget: StoryArcRebaseTarget = {
      arcId: "arc-active",
      executionStatus: "active",
      approvedArc: bundle.arc,
      batchIndex: 1,
      startChapterIndex: 1,
      chapters: bundle.chapters.slice(0, 5).map((chapter, index) => ({
        chapterId: `chapter-${index + 1}`,
        documentId: `document-${index + 1}`,
        globalOrder: index + 1,
        title: chapter.title,
        revisionId: `revision-${index + 1}`,
        approvedPlan: { summary: chapter.summary, sceneEvents: chapter.scenes.map((scene) => scene.summary), continuityConstraints: [], setupRefs: [], payoffRefs: [] },
        committedMemory: { summary: chapter.summary, keyEvents: [`事件 ${index + 1}`], characterStates: [], unresolvedThreads: [], emotionalArc: chapter.emotionalMovement },
        authoritativeFacts: [],
      })),
    };
    const plannedTarget: StoryArcRebaseTarget = {
      ...baseTarget,
      chapters: baseTarget.chapters.map((chapter, index) => index === 0
        ? { ...chapter, globalOrder: 1, revisionId: undefined, committedMemory: undefined, plannedBlueprint: bundle.chapters[0] }
        : chapter),
    };
    const candidate = parseStoryArcBundle({
      ...bundle,
      chapters: [{
        ...bundle.chapters[0],
        title: "未经批准的未来事件",
        summary: "模型自行追加了未来冲突。",
        stateTransition: { before: "旧状态", after: "新状态", evidence: "新增证据" },
        unresolvedAtClose: ["被模型回答的问题"],
      }, ...bundle.chapters.slice(1, 5)],
    });

    const normalized = normalizeStoryArcRebaseBundle(candidate, plannedTarget);
    expect(normalized.chapters[0].title).toBe(bundle.chapters[0].title);
    expect(normalized.chapters[0].summary).toBe(bundle.chapters[0].summary);
    expect(normalized.chapters[0].unresolvedAtClose).toEqual(bundle.chapters[0].unresolvedAtClose ?? []);
    expect(() => validateStoryArcRebaseBundle(normalized, plannedTarget)).not.toThrow();
    const futureReview = normalizeStoryArcReviewAuthority(normalized, {
      verdict: "revise",
      summary: "未来章节被错误地按历史事实审查",
      issues: [{ severity: "major", title: "第 1 章事实权威越界", evidence: "找到藏身处不在已定稿记忆", suggestion: "按历史事实回退" }],
      chapterChecks: [{ chapterIndex: 1, dimension: "theme-restraint", verdict: "revise", evidence: "旧蓝图主题措辞", reason: "旧字段文案可优化" }],
      arcChecks: [],
      authorityChecks: [{
        chapterIndex: 1,
        verdict: "revise",
        unresolvedAtClose: [],
        checkedPaths: [],
        candidateClaims: [],
        frozenEvidence: ["历史记忆"],
        certaintyUpgrades: [{ candidateClaim: "找到藏身处", frozenBoundary: "无", reason: "未来章节不是历史" }],
        reason: "不应套用历史事实",
      }],
    }, plannedTarget);
    expect(futureReview.authorityChecks[0].verdict).toBe("passed");
    expect(futureReview.issues).toEqual([]);
    expect(futureReview.chapterChecks[0]).toMatchObject({ verdict: "passed" });
    expect(futureReview.authorityChecks[0]).toMatchObject({ verdict: "passed", certaintyUpgrades: [] });
    expect(futureReview.authorityChecks[0].frozenEvidence.length).toBeGreaterThan(0);

    const committedTarget: StoryArcRebaseTarget = {
      ...plannedTarget,
      chapters: plannedTarget.chapters.map((chapter, index) => index === 0
        ? { ...chapter, revisionId: "revision-1", committedMemory: { summary: "已提交", keyEvents: [], characterStates: [], unresolvedThreads: [] }, committedBlueprint: bundle.chapters[0] }
        : chapter),
    };
    const historicalCandidate = parseStoryArcBundle({
      ...candidate,
      chapters: [{ ...candidate.chapters[0], title: "模型改写的历史章节", summary: "模型追加了未批准事实" }, ...candidate.chapters.slice(1)],
    });
    const historicalNormalized = normalizeStoryArcRebaseBundle(historicalCandidate, committedTarget);
    expect(historicalNormalized.chapters[0].title).toBe(bundle.chapters[0].title);
    expect(historicalNormalized.chapters[0].summary).toBe(bundle.chapters[0].summary);
  });

  it("keeps planned scene stakes as the execution contract for future chapters", () => {
    const plannedBlueprint = parseStoryArcBundle({
      ...bundle,
      chapters: [{
        ...bundle.chapters[0],
        scenes: [{
          ...bundle.chapters[0].scenes[0],
          participants: ["甲"],
          participantStakes: [{
            participant: "甲",
            want: "找到藏身处",
            leverage: "碎陶和对脚步方向的观察",
            withholding: "不知道搜捕者是否折返",
            failureCost: "暴露后失去下一次喘息机会",
            knowledgeBasis: { want: "planned", leverage: "planned", withholding: "planned", failureCost: "planned" },
          }],
        }],
      }, ...bundle.chapters.slice(1)],
    }).chapters[0];
    const target: StoryArcRebaseTarget = {
      arcId: "arc-active",
      executionStatus: "active",
      approvedArc: bundle.arc,
      batchIndex: 1,
      startChapterIndex: 1,
      chapters: [{
        chapterId: "chapter-1",
        documentId: "document-1",
        globalOrder: 1,
        title: plannedBlueprint.title,
        approvedPlan: { summary: plannedBlueprint.summary, sceneEvents: [], continuityConstraints: [], setupRefs: [], payoffRefs: [] },
        plannedBlueprint,
        authoritativeFacts: [],
      }],
    };
    const normalized = normalizeStoryArcRebaseBundle(parseStoryArcBundle({ ...bundle, chapters: [bundle.chapters[0]] }), target);
    expect(normalized.chapters[0].scenes[0].participantStakes?.[0]!).toMatchObject({
      want: "找到藏身处",
      leverage: "碎陶和对脚步方向的观察",
      withholding: "不知道搜捕者是否折返",
      failureCost: "暴露后失去下一次喘息机会",
      knowledgeBasis: { want: "planned", leverage: "planned", withholding: "planned", failureCost: "planned" },
    });
  });

  it("requires executable scene pressure and coherent theme permissions", () => {
    const executable = parseStoryArcBundle({
      arc: { ...bundle.arc, thematicQuestions: [{ id: "trust", question: "是否交出证据？", opposingPressures: "自保与合作", resolutionWindow: "本弧后段" }] },
      batch: bundle.batch,
      chapters: [{
        ...bundle.chapters[0],
        narrativeFunction: "relationship",
        readerExperience: "跟随双方在黑暗中交换不完整的信息",
        stateTransition: { before: "双方各自持有一半路线", after: "双方暂时同行但仍各自保留证据", evidence: "甲交出光源，乙带路" },
        thematicTreatment: { mode: "subtext", questionRefs: ["trust"], carrier: "choice", evidenceChange: "一方交出唯一光源但保留证据", expositionBoundary: "不得总结信任的意义" },
        unresolvedAtClose: ["乙为何掌握追兵来向"],
        scenes: [{
          title: "楼梯间", summary: "双方交换条件", participants: ["甲", "乙"], goal: "甲要在追兵到来前换到出口位置", opposition: "乙只肯用出口换取原始证据", turn: "甲交出唯一光源但保留证据副本", outcome: "乙带路，两人暂时同行", cost: "甲失去照明并暴露自己持有副本",
          participantStakes: [
            { participant: "甲", want: "取得出口位置", leverage: "唯一光源", withholding: "证据副本", failureCost: "被追兵堵住", knowledgeBasis: { want: "planned", leverage: "planned", withholding: "planned", failureCost: "planned" } },
            { participant: "乙", want: "取得原始证据", leverage: "出口位置", withholding: "", failureCost: "失去翻案机会", knowledgeBasis: { want: "planned", leverage: "planned", withholding: "unknown", failureCost: "planned" } },
          ],
        }],
      }],
    });
    expect(() => validateStoryArcExecutionContracts(executable)).not.toThrow();

    const fakeForeground = parseStoryArcBundle({ ...executable, chapters: [{ ...executable.chapters[0], thematicTreatment: { ...executable.chapters[0].thematicTreatment!, mode: "foreground", carrier: "relationship" } }] });
    expect(() => validateStoryArcExecutionContracts(fakeForeground)).toThrow("foreground 主题必须由具体处境中的 dialogue-conflict 承载");
    const normalizedForeground = normalizeStoryArcStakes(fakeForeground);
    expect(normalizedForeground.chapters[0].thematicTreatment).toMatchObject({ mode: "subtext", carrier: "relationship" });
    expect(() => validateStoryArcExecutionContracts(normalizedForeground)).not.toThrow();

    const supportedForeground = parseStoryArcBundle({
      ...executable,
      chapters: [{
        ...executable.chapters[0],
        thematicTreatment: { mode: "foreground", questionRefs: ["trust"], carrier: "dialogue-conflict", evidenceChange: "双方围绕是否交出证据作出互斥选择", expositionBoundary: "不得宣布信任答案" },
      }],
    });
    expect(() => validateStoryArcExecutionContracts(supportedForeground)).not.toThrow();

    const missingCost = parseStoryArcBundle({ ...executable, chapters: [{ ...executable.chapters[0], scenes: [{ ...executable.chapters[0].scenes[0], cost: "" }] }] });
    expect(() => validateStoryArcExecutionContracts(missingCost)).toThrow("goal/opposition/turn/outcome/cost");

    const inventedUnknown = parseStoryArcBundle({
      ...executable,
      chapters: [{
        ...executable.chapters[0],
        scenes: [{ ...executable.chapters[0].scenes[0], participantStakes: executable.chapters[0].scenes[0].participantStakes?.map((stake) => stake.participant === "乙" ? { ...stake, withholding: "幕后主顾", knowledgeBasis: { ...stake.knowledgeBasis!, withholding: "unknown" } } : stake) }],
      }],
    });
    expect(() => validateStoryArcExecutionContracts(inventedUnknown)).toThrow("内容与 knowledgeBasis 不一致");
  });

  it("normalizes stake knowledgeBasis to match text content for non-rebase arcs", () => {
    const executable = parseStoryArcBundle({
      arc: { ...bundle.arc, thematicQuestions: [{ id: "trust", question: "是否交出证据？", opposingPressures: "自保与合作", resolutionWindow: "本弧后段" }] },
      batch: bundle.batch,
      chapters: [{
        ...bundle.chapters[0],
        narrativeFunction: "relationship",
        readerExperience: "跟随双方在黑暗中交换不完整的信息",
        stateTransition: { before: "双方各自持有一半路线", after: "双方暂时同行但仍各自保留证据", evidence: "甲交出光源，乙带路" },
        thematicTreatment: { mode: "subtext", questionRefs: ["trust"], carrier: "choice", evidenceChange: "一方交出唯一光源但保留证据", expositionBoundary: "不得总结信任的意义" },
        unresolvedAtClose: ["乙为何掌握追兵来向"],
        scenes: [{
          title: "楼梯间", summary: "双方交换条件", participants: ["甲", "乙"], goal: "甲要在追兵到来前换到出口位置", opposition: "乙只肯用出口换取原始证据", turn: "甲交出唯一光源但保留证据副本", outcome: "乙带路，两人暂时同行", cost: "甲失去照明并暴露自己持有副本",
          participantStakes: [
            { participant: "甲", want: "取得出口位置", leverage: "唯一光源", withholding: "证据副本", failureCost: "被追兵堵住", knowledgeBasis: { want: "planned", leverage: "planned", withholding: "planned", failureCost: "planned" } },
            { participant: "乙", want: "取得原始证据", leverage: "出口位置", withholding: "", failureCost: "失去翻案机会", knowledgeBasis: { want: "planned", leverage: "planned", withholding: "unknown", failureCost: "planned" } },
          ],
        }],
      }],
    });

    // Original failing case: unknown basis with non-empty text should be normalized to "planned"
    const inconsistentBundle = parseStoryArcBundle({
      ...executable,
      chapters: [{
        ...executable.chapters[0],
        scenes: [{ ...executable.chapters[0].scenes[0], participantStakes: executable.chapters[0].scenes[0].participantStakes?.map((stake) => stake.participant === "乙" ? { ...stake, withholding: "幕后主顾", knowledgeBasis: { ...stake.knowledgeBasis!, withholding: "unknown" } } : stake) }],
      }],
    });
    // Without normalization, validation still catches the inconsistency
    expect(() => validateStoryArcExecutionContracts(inconsistentBundle)).toThrow("内容与 knowledgeBasis 不一致");
    // With normalization, the inconsistency is fixed and validation passes
    const normalized = normalizeStoryArcStakes(inconsistentBundle);
    expect(() => validateStoryArcExecutionContracts(normalized)).not.toThrow();
    // The basis was upgraded from "unknown" to "planned" because the LLM wrote content
    expect(normalized.chapters[0].scenes[0].participantStakes?.[1].knowledgeBasis?.withholding).toBe("planned");

    // Counterexample: non-unknown basis with empty text should be normalized to "unknown"
    const emptyTextBundle = parseStoryArcBundle({
      ...executable,
      chapters: [{
        ...executable.chapters[0],
        scenes: [{ ...executable.chapters[0].scenes[0], participantStakes: executable.chapters[0].scenes[0].participantStakes?.map((stake) => stake.participant === "乙" ? { ...stake, want: "", knowledgeBasis: { ...stake.knowledgeBasis!, want: "planned" } } : stake) }],
      }],
    });
    expect(() => validateStoryArcExecutionContracts(emptyTextBundle)).toThrow("内容与 knowledgeBasis 不一致");
    const normalizedEmpty = normalizeStoryArcStakes(emptyTextBundle);
    expect(() => validateStoryArcExecutionContracts(normalizedEmpty)).not.toThrow();
    expect(normalizedEmpty.chapters[0].scenes[0].participantStakes?.[1].knowledgeBasis?.want).toBe("unknown");

    // Direct function test: unknown + non-empty → planned
    const stake1 = { participant: "甲", want: "content", leverage: "", withholding: "", failureCost: "", knowledgeBasis: { want: "unknown", leverage: "planned", withholding: "unknown", failureCost: "unknown" } };
    const normalized1 = normalizeStakeKnowledgeBasis(stake1);
    expect(normalized1.knowledgeBasis.want).toBe("planned");
    expect(normalized1.knowledgeBasis.leverage).toBe("unknown");
    expect(normalized1.knowledgeBasis.withholding).toBe("unknown");
    expect(normalized1.knowledgeBasis.failureCost).toBe("unknown");
  });

  it("uses narrative scale without accepting a hard chapter length policy", () => {
    const prompt = buildStoryArcPrompt({ projectTitle: "Test", macro: [], recentChapters: [], openThreads: [] });
    const parsed = parseStoryArcBundle({
      arc: bundle.arc,
      batch: bundle.batch,
      chapters: [{
        ...bundle.chapters[0],
        lengthPolicy: { minCharacters: 2_000, targetCharacters: 3_000, maxCharacters: 4_000, enforcement: "hard" },
      }],
    });

    expect(prompt).toContain("章节不设置字数、字符数或段落数硬约束");
    expect(prompt).toContain("narrativeScale");
    expect(prompt).toContain("不是最低字数");
    expect("lengthPolicy" in storyArcBundleSchema.properties.chapters.items.properties).toBe(false);
    expect(parsed.chapters[0]).not.toHaveProperty("lengthPolicy");
    expect(bundle.chapters[0]).not.toHaveProperty("lengthPolicy");
  });

  it("parses the narrative function and thematic treatment while keeping legacy blueprints compatible", () => {
    const planned = parseStoryArcBundle({
      arc: {
        ...bundle.arc,
        thematicQuestions: [{ id: "trust", question: "两个人能否在证据不完整时承担共同风险？", opposingPressures: "自保与互信", resolutionWindow: "本弧收束前只增加证据，不给答案" }],
      },
      batch: bundle.batch,
      chapters: [{
        ...bundle.chapters[0],
        narrativeFunction: "relationship",
        readerExperience: "跟随两人在黑暗楼梯间试探彼此的行动边界",
        thematicTreatment: { mode: "subtext", questionRefs: ["trust"], carrier: "choice", evidenceChange: "一人把唯一光源交给对方", expositionBoundary: "不得由人物总结信任的意义" },
      }],
    });

    expect(planned.arc.thematicQuestions).toHaveLength(1);
    expect(planned.chapters[0]).toMatchObject({ narrativeFunction: "relationship", readerExperience: expect.stringContaining("试探") });
    expect(planned.chapters[0].thematicTreatment).toMatchObject({ mode: "subtext", carrier: "choice", questionRefs: ["trust"] });
    expect(bundle.chapters[0].narrativeFunction).toBeUndefined();
    expect(bundle.chapters[0].thematicTreatment).toBeUndefined();
    expect(storyArcBundleSchema.properties.arc.required).toContain("thematicQuestions");
    expect(storyArcBundleSchema.properties.chapters.items.required).toEqual(expect.arrayContaining(["narrativeFunction", "readerExperience", "thematicTreatment"]));
  });

  it("renders absent and foreground as different permissions instead of a blanket philosophy ban", () => {
    const baseChapter = { ...bundle.chapters[0], id: "c1", arcId: "a", projectId: "p", globalOrder: 1, status: "planned", blueprintRevision: 0 };
    const makeContext = (thematicTreatment: NonNullable<typeof baseChapter.thematicTreatment>): ChapterPlanningContext => ({
      projectId: "p", arcId: "a", chapterBlueprintId: "c1", macroPlanArtifacts: [], arc: bundle.arc,
      chapter: { ...baseChapter, narrativeFunction: "aftermath", readerExperience: "人物收拾冲突留下的房间并避开一次未尽谈话", thematicTreatment },
      neighbors: [], sourceArtifactIds: [], fingerprint: "context",
    });
    const absent = renderChapterPlanningContext(makeContext({ mode: "absent", questionRefs: [], carrier: "none", evidenceChange: "", expositionBoundary: "本章不承担主题推进" }), { includeMacro: false });
    const foreground = renderChapterPlanningContext(makeContext({ mode: "foreground", questionRefs: ["trust"], carrier: "dialogue-conflict", evidenceChange: "争执迫使双方承担不同代价", expositionBoundary: "只能争论当下选择，不宣布普遍答案" }), { includeMacro: false });

    expect(absent).toContain("主题显隐：absent");
    expect(absent).toContain("主题承载：none");
    expect(foreground).toContain("主题显隐：foreground");
    expect(foreground).toContain("主题承载：dialogue-conflict");
    expect(foreground).toContain("只能争论当下选择");
    expect(foreground).not.toContain(`故事弧目标：${bundle.arc.objective}`);
    expect(foreground).not.toContain(`核心冲突：${bundle.arc.centralConflict}`);
  });

  it("renders narrative scale as a soft depth contract rather than a word-count gate", () => {
    const baseChapter = { ...bundle.chapters[0], id: "scaled", arcId: "a", projectId: "p", globalOrder: 1, status: "planned", blueprintRevision: 0 };
    const context: ChapterPlanningContext = {
      projectId: "p", arcId: "a", chapterBlueprintId: "scaled", macroPlanArtifacts: [], arc: bundle.arc,
      chapter: { ...baseChapter, narrativeScale: { level: "standard", reason: "完整经历一次试探和选择", developmentAxes: ["接触", "试探", "余波"], stoppingCondition: "选择后果已经落地且未解问题仍被保留" } },
      neighbors: [], sourceArtifactIds: [], fingerprint: "scaled-context",
    };
    const rendered = renderChapterPlanningContext(context, { includeMacro: false });
    expect(rendered).toContain("叙事规模：standard");
    expect(rendered).toContain("规模展开轴：接触；试探；余波");
    expect(rendered).toContain("自然收束条件：选择后果已经落地且未解问题仍被保留");
    expect(rendered).toContain("非硬性的体量信号，不是字数下限");
  });

  it("gives legacy blueprints a standard soft scale without imposing a length gate", () => {
    const legacy = parseStoryArcBundle({
      arc: bundle.arc,
      batch: bundle.batch,
      chapters: [{ ...bundle.chapters[0], narrativeScale: undefined }],
    });

    expect(legacy.chapters[0].narrativeScale?.level).toBe("standard");
    expect(legacy.chapters[0].narrativeScale?.developmentAxes.length).toBeGreaterThan(0);
    expect(legacy.chapters[0].narrativeScale?.reason).toContain("旧蓝图未声明");
  });

  it("normalizes persisted legacy planning snapshots before prompt rendering", () => {
    const context = normalizeChapterPlanningContext({
      projectId: "p",
      arcId: "a",
      chapterBlueprintId: "legacy-blueprint",
      arc: { title: "旧弧", objective: "先活下来", development: undefined },
      chapter: { id: "c1", arcId: "a", projectId: "p", globalOrder: 1, index: 1, title: "旧章", summary: "从水中醒来", scenes: [{ title: "水下", participants: ["主角"] }] },
      neighbors: [{ id: "c2", globalOrder: 2, title: "下一章", summary: "爬上岸" }],
      macroPlanArtifacts: [],
      sourceArtifactIds: [],
    });

    expect(context?.chapter.narrativeScale?.level).toBe("standard");
    expect(context?.chapter.worldRuleRefs).toEqual([]);
    expect(context?.chapter.characterFocus).toEqual([]);
    expect(context?.chapter.romanceTreatment.status).toBe("not-applicable");
    expect(context?.chapter.humorTreatment.status).toBe("not-applicable");
    expect(() => renderChapterPlanningContext(context!, { includeMacro: false })).not.toThrow();
  });

  it("projects legacy blueprints as observable material instead of executable theme declarations", () => {
    const legacyChapter = { ...bundle.chapters[0], id: "legacy", arcId: "a", projectId: "p", globalOrder: 1, status: "planned" as const, blueprintRevision: 0 };
    const context: ChapterPlanningContext = {
      projectId: "p",
      arcId: "a",
      chapterBlueprintId: "legacy",
      macroPlanArtifacts: [],
      arc: { ...bundle.arc, objective: "证明全书主题答案", centralConflict: "用抽象原则解释一切" },
      chapter: { ...legacyChapter, chapterPurpose: "展示某种精神", scenes: [{ ...legacyChapter.scenes[0], goal: "证明某个道理" }] },
      neighbors: [{ id: "next", globalOrder: 2, title: "下一章", summary: "两人离开楼梯间", chapterPurpose: "再次强调主题" }],
      sourceArtifactIds: [],
      fingerprint: "legacy-context",
    };

    const execution = renderChapterPlanningContext(context, { includeMacro: false });
    const planning = renderChapterPlanningContext(context);

    expect(execution).toContain("历史蓝图正文投影");
    expect(execution).toContain("场景 1：楼梯间");
    expect(execution).not.toContain("借微光辨认脚步");
    expect(execution).not.toContain("证明全书主题答案");
    expect(execution).not.toContain("展示某种精神");
    expect(execution).not.toContain("证明某个道理");
    expect(execution).not.toContain("再次强调主题");
    expect(execution).not.toContain("第 1 章摘要");
    expect(execution).not.toContain("两人离开楼梯间");
    expect(execution).toContain("仅标记相邻章节位置");
    expect(planning).toContain("证明全书主题答案");
    expect(planning).toContain("展示某种精神");
  });

  it("keeps legacy rhythm summaries out of execution prompts while preserving new contracts", () => {
    const rhythm = {
      arcId: "a",
      fingerprint: "rhythm",
      chapters: [
        { documentId: "legacy", narrativeOrder: 1, title: "旧章", summary: "旧摘要直接解释主题", keyEvents: ["旧关键事件措辞"], emotionalArc: "旧解释", thematicMode: "subtext" as const, themeCarrier: "none" as const, issueFamilies: ["subtext:summary"] },
        { documentId: "new", narrativeOrder: 2, title: "新章", summary: "两人共同修好门锁", keyEvents: ["门锁恢复"], emotionalArc: "戒备稍缓", narrativeFunction: "relationship" as const, thematicMode: "absent" as const, themeCarrier: "none" as const, issueFamilies: [] },
      ],
    };

    const execution = renderNarrativeRhythm(rhythm, { execution: true });
    const review = renderNarrativeRhythm(rhythm);
    expect(execution).not.toContain("旧摘要直接解释主题");
    expect(execution).not.toContain("旧关键事件措辞");
    expect(execution).toContain("具体连续性以本包原子事实为准");
    expect(execution).toContain("两人共同修好门锁");
    expect(review).toContain("旧摘要直接解释主题");
  });

  it("normalizes author chapter indices without truncating chapters after five", () => {
    expect(bundle.arc.expectedChapterCount).toBe(20);
    expect(bundle.chapters).toHaveLength(7);
    expect(bundle.chapters[5]).toMatchObject({ index: 6, title: "章 6", chapterPurpose: "关系沉淀" });
  });

  it("opens the next batch only after an approved batch reaches the 70% final threshold", () => {
    expect(canGenerateNextStoryArcBatch({ plannedInBatch: 7, finalizedInBatch: 4, batchStatus: "approved" })).toBe(false);
    expect(canGenerateNextStoryArcBatch({ plannedInBatch: 7, finalizedInBatch: 5, batchStatus: "approved" })).toBe(true);
    expect(canGenerateNextStoryArcBatch({ plannedInBatch: 7, finalizedInBatch: 7, batchStatus: "awaiting-review" })).toBe(false);
  });

  it("renders the exact target blueprint and neighbors as one frozen context", () => {
    const base: Omit<ChapterPlanningContext, "fingerprint"> = {
      projectId: "p", arcId: "a", chapterBlueprintId: "c6",
      macroPlanArtifacts: [{ id: "macro", taskKey: "plot-design", title: "长线", summary: "真相后置", payload: {} }],
      arc: bundle.arc,
      chapter: { ...bundle.chapters[5], id: "c6", arcId: "a", projectId: "p", globalOrder: 6, status: "planned", blueprintRevision: 0 },
      neighbors: [
        { id: "c5", globalOrder: 5, title: bundle.chapters[4].title, summary: bundle.chapters[4].summary, chapterPurpose: bundle.chapters[4].chapterPurpose },
        { id: "c7", globalOrder: 7, title: bundle.chapters[6].title, summary: bundle.chapters[6].summary, chapterPurpose: bundle.chapters[6].chapterPurpose },
      ],
      sourceArtifactIds: ["macro", "arc-artifact"],
    };
    const context = { ...base, fingerprint: planningContextFingerprint(base) };
    const rendered = renderChapterPlanningContext(context);
    expect(rendered).toContain("目标章：第 6 章《章 6》");
    expect(rendered).toContain("关系沉淀");
    expect(rendered).toContain("第 5 章《章 5》");
    expect(rendered).toContain("第 7 章《章 7》");
    expect(rendered).toContain("可选组织材料，不是逐项打勾的任务清单");
  });

  it("reviews quiet chapters by function instead of mandatory main-plot movement", () => {
    const prompt = buildStoryArcReviewPrompt(bundle, "都市悬疑上下文");
    expect(prompt).toContain("不要因安静章、铺陈章、关系章没有明显推进主线而判错");
    expect(prompt).toContain("不得因本章没有新压力、新信息、新爽点或主线推进而判错");
    expect(prompt).toContain("关系沉淀");
    expect(prompt).toContain("长篇层级与局部功能");
    expect(prompt).toContain("首批章节像卷级剧情摘要");
    expect(prompt).toContain("alignment=标题/摘要/场景是否指向同一核心事件");
    expect(prompt).toContain("母题入戏");
    expect(prompt).toContain("连续标题、场景名或行动描述退化为同一概念词库的表层标签");
    expect(prompt).toContain("motif-integration=核心设定/职业/金手指/主题隐喻是否进入具体事件");
    expect(prompt).toContain("longform-hierarchy=全书/卷级战略、故事弧、批次和章节之间职责是否分层清楚");
    expect(prompt).toContain("window-variation=连续章节窗口是否允许重复但产生理解、关系、社会质地、信息角度、情绪重量或行动代价的变化");
    expect(prompt).toContain("但不得要求每章都新增或加剧压力");
  });

  it("requires every planning check for every chapter and arc", () => {
    const oneChapter = parseStoryArcBundle({ ...bundle, chapters: bundle.chapters.slice(0, 1) });
    const checks = CHAPTER_PLAN_CHECK_DIMENSIONS.map((dimension) => ({ chapterIndex: 1, dimension, verdict: "passed", evidence: "第 1 章：标题与场景一致", reason: "规划成立" })) as Parameters<typeof compileChapterPlanValidationReport>[1];
    const arcChecks = ARC_PLAN_CHECK_DIMENSIONS.map((dimension) => ({ dimension, verdict: "passed", evidence: "整弧节奏成立", reason: "规划成立" })) as NonNullable<Parameters<typeof compileChapterPlanValidationReport>[2]>;
    const checkedPaths = storyArcAuthorityPaths(oneChapter.chapters[0]);
    const authorityChecks = [{ chapterIndex: 1, verdict: "passed" as const, unresolvedAtClose: [], checkedPaths, candidateClaims: checkedPaths.map((path) => `${path}:候选值`), frozenEvidence: ["规划状态允许交换条件"], certaintyUpgrades: [], reason: "没有提高事实确定性" }];
    expect(compileChapterPlanValidationReport(oneChapter, checks, arcChecks).passed).toBe(true);
    expect(() => validateStoryArcReview(oneChapter, { verdict: "passed", summary: "通过", issues: [], chapterChecks: checks.slice(0, 3), arcChecks, authorityChecks })).toThrow("缺少逐章校验");
    expect(() => validateStoryArcReview(oneChapter, { verdict: "passed", summary: "通过", issues: [], chapterChecks: checks, arcChecks, authorityChecks: [] })).toThrow("事实权威校验");
    const normalized = normalizeStoryArcReviewAuthority(oneChapter, { verdict: "passed", summary: "通过", issues: [], chapterChecks: checks, arcChecks, authorityChecks: [{ ...authorityChecks[0], checkedPaths: ["漏抄"], candidateClaims: ["漏抄"] }] });
    expect(normalized.authorityChecks[0].checkedPaths).toEqual(checkedPaths);
    expect(normalized.authorityChecks[0].candidateClaims).toHaveLength(checkedPaths.length);
    expect(() => validateStoryArcReview(oneChapter, normalized)).not.toThrow();
  });

  it("keeps frozen blueprint evidence valid for the unified rebase validator", () => {
    const oneChapter = parseStoryArcBundle({ ...bundle, chapters: bundle.chapters.slice(0, 1) });
    const chapter = oneChapter.chapters[0];
    const target: StoryArcRebaseTarget = {
      arcId: "arc-rebase",
      executionStatus: "active",
      approvedArc: oneChapter.arc,
      batchIndex: 1,
      startChapterIndex: 1,
      chapters: [{
        chapterId: "chapter-1",
        documentId: "document-1",
        globalOrder: 1,
        title: chapter.title,
        approvedPlan: { summary: chapter.summary, sceneEvents: [], continuityConstraints: [], setupRefs: [], payoffRefs: [] },
        authoritativeFacts: [],
        plannedBlueprint: chapter,
      }],
    };
    const checks = CHAPTER_PLAN_CHECK_DIMENSIONS.map((dimension) => ({ chapterIndex: 1, dimension, verdict: "passed" as const, evidence: "蓝图字段一致", reason: "冻结字段未变化" }));
    const arcChecks = ARC_PLAN_CHECK_DIMENSIONS.map((dimension) => ({ dimension, verdict: "passed" as const, evidence: "整弧结构成立", reason: "冻结字段未变化" }));
    const checkedPaths = storyArcAuthorityPaths(chapter);
    const review = {
      verdict: "passed" as const,
      summary: "冻结重基线通过",
      issues: [],
      chapterChecks: checks,
      arcChecks,
      authorityChecks: [{
        chapterIndex: 1,
        verdict: "passed" as const,
        unresolvedAtClose: [],
        checkedPaths,
        candidateClaims: checkedPaths.map(() => "候选值"),
        frozenEvidence: ["模型生成的泛化依据"],
        certaintyUpgrades: [],
        reason: "候选与冻结蓝图一致",
      }],
    };

    const normalized = normalizeStoryArcReviewAuthority(oneChapter, review, target);
    expect(normalized.authorityChecks[0].frozenEvidence).not.toEqual(["模型生成的泛化依据"]);
    expect(normalized.authorityChecks[0].frozenEvidence.length).toBeGreaterThan(0);
    expect(() => validateStoryArcReview(oneChapter, normalized)).not.toThrow();
  });

  it("rejects a passed verdict when a chapter alignment check fails", () => {
    const oneChapter = parseStoryArcBundle({ ...bundle, chapters: bundle.chapters.slice(0, 1) });
    const checks = CHAPTER_PLAN_CHECK_DIMENSIONS.map((dimension) => ({ chapterIndex: 1, dimension, verdict: dimension === "alignment" ? "revise" : "passed", evidence: "第 1 章：标题写观棋但场景只安排比剑", reason: "标题与核心事件不一致" })) as Parameters<typeof compileChapterPlanValidationReport>[1];
    const arcChecks = ARC_PLAN_CHECK_DIMENSIONS.map((dimension) => ({ dimension, verdict: "passed", evidence: "整弧节奏成立", reason: "规划成立" })) as NonNullable<Parameters<typeof compileChapterPlanValidationReport>[2]>;
    const checkedPaths = storyArcAuthorityPaths(oneChapter.chapters[0]);
    const authorityChecks = [{ chapterIndex: 1, verdict: "passed" as const, unresolvedAtClose: [], checkedPaths, candidateClaims: checkedPaths.map((path) => `${path}:候选值`), frozenEvidence: ["规划状态允许交换条件"], certaintyUpgrades: [], reason: "没有提高事实确定性" }];
    expect(() => validateStoryArcReview(oneChapter, { verdict: "passed", summary: "误判通过", issues: [], chapterChecks: checks, arcChecks, authorityChecks })).toThrow("结论与逐章校验不一致");
  });

  it("passes the Web auto-review policy into the durable workflow and audit payload", async () => {
    const repository = {
      createNextStoryArc: vi.fn(async () => ({ id: "arc-1" })),
      putWorkflowRun: vi.fn(async () => undefined),
    } as unknown as NovelPostgresRepository;
    const start = vi.fn(async () => ({ firstExecutionRunId: "run-1" }));
    const temporal = { workflow: { start } } as unknown as Client;

    await startStoryArcPlanning(repository, temporal, { projectId: "project-1", mode: "web", reviewPolicy: "auto", authorIntent: "检验关系弧" });

    expect(repository.putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ mode: "web", reviewPolicy: "auto" }) }));
    expect(start).toHaveBeenCalledWith("storyArcPlanningWorkflow", expect.objectContaining({ args: [expect.objectContaining({ mode: "web", reviewPolicy: "auto", rebase: false })] }));
  });

  it("propagates an explicit rebase into the durable planning workflow", async () => {
    const repository = {
      markStoryArcGenerating: vi.fn(async () => ({ id: "arc-completed", planningStatus: "generating", executionStatus: "completed" })),
      putWorkflowRun: vi.fn(async () => undefined),
    } as unknown as NovelPostgresRepository;
    const start = vi.fn(async () => ({ firstExecutionRunId: "run-rebase" }));
    const temporal = { workflow: { start } } as unknown as Client;

    await startStoryArcPlanning(repository, temporal, { projectId: "project-1", arcId: "arc-completed", mode: "web", reviewPolicy: "manual", authorIntent: "升级执行契约" });

    expect(repository.markStoryArcGenerating).toHaveBeenCalledWith("project-1", "arc-completed", "web-author");
    expect(start).toHaveBeenCalledWith("storyArcPlanningWorkflow", expect.objectContaining({ args: [expect.objectContaining({ arcId: "arc-completed", rebase: true })] }));
  });

  it("reviews the current edited artifact without regenerating the story arc", async () => {
    const repository = {
      getStoryArc: vi.fn(async () => ({ id: "arc-1", planningStatus: "awaiting-review", executionStatus: "completed", blueprintArtifactId: "edited-artifact" })),
      putWorkflowRun: vi.fn(async () => undefined),
    } as unknown as NovelPostgresRepository;
    const start = vi.fn(async () => ({ firstExecutionRunId: "run-1" }));
    const temporal = { workflow: { start } } as unknown as Client;

    await startStoryArcReview(repository, temporal, { projectId: "project-1", arcId: "arc-1", mode: "web", reviewPolicy: "auto" });

    expect(repository.putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ existingArtifactId: "edited-artifact", rebase: true }) }));
    expect(start).toHaveBeenCalledWith("storyArcPlanningWorkflow", expect.objectContaining({ args: [expect.objectContaining({ existingArtifactId: "edited-artifact", rebase: true })] }));
  });

  it("always performs an automatic arc review before manual author approval", () => {
    expect(storyArcReviewStrategy("manual")).toEqual({ automaticReview: true, automaticRevision: false, humanApproval: true });
    expect(storyArcReviewStrategy("auto")).toEqual({ automaticReview: true, automaticRevision: true, humanApproval: false });
  });

  it("rebases a completed arc without reopening its execution history", async () => {
    if (!available) return;
    const volumeId = `volume:${projectId}:test`;
    const arcId = `arc-${randomUUID()}`;
    const approvedAt = new Date("2026-07-01T12:00:00.000Z");
    await repository.pool.query(
      "INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload,context_fingerprint,approved_at,completed_at) VALUES($1,$2,$3,'已完成弧',9,'approved','completed',$4,'approved-context',$5,$5)",
      [arcId, volumeId, projectId, bundle.arc, approvedAt],
    );

    const generating = await repository.markStoryArcGenerating(projectId, arcId, "test-author");

    expect(generating).toMatchObject({ planningStatus: "generating", executionStatus: "completed", contextFingerprint: "approved-context" });
    expect(new Date(generating!.approvedAt!).toISOString()).toBe(approvedAt.toISOString());

    await repository.failStoryArc(projectId, arcId, "planner unavailable");
    const restored = await repository.getStoryArc(projectId, arcId);

    expect(restored).toMatchObject({ planningStatus: "approved", executionStatus: "completed", contextFingerprint: "approved-context" });
    expect(new Date(restored!.approvedAt!).toISOString()).toBe(approvedAt.toISOString());
    expect(restored?.arc).toMatchObject({ failureReason: "planner unavailable" });

    await repository.markStoryArcGenerating(projectId, arcId, "test-author");
    await repository.pool.query("UPDATE arcs SET context_fingerprint=NULL,approved_at=NULL WHERE id=$1", [arcId]);
    await repository.failStoryArc(projectId, arcId, "candidate review failed");
    const candidateFailed = await repository.getStoryArc(projectId, arcId);
    expect(candidateFailed).toMatchObject({ planningStatus: "approved", executionStatus: "completed", contextFingerprint: null });
    expect(candidateFailed?.arc).toMatchObject({ failureReason: "candidate review failed" });
  });

  it("removes trailing unprotected chapters when an edited batch is shortened", async () => {
    if (!available) return;
    const volumeId = `volume:${projectId}:test`;
    const arcId = `arc-${randomUUID()}`;
    await repository.pool.query("INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload) VALUES($1,$2,$3,'待缩短弧',10,'awaiting-review','planned',$4)", [arcId, volumeId, projectId, bundle.arc]);

    async function createArtifact(id: string, structuredData: unknown): Promise<Artifact> {
      const artifact: Artifact = {
        id,
        projectId,
        taskId: `task-${id}`,
        attemptId: `attempt-${id}`,
        kind: "arc-plan",
        contentHash: `hash-${id}`,
        baseRevision: 0,
        createdAt: Date.now(),
        fingerprint: `fp-${id}`,
        structuredData: structuredData as Record<string, unknown>,
      };
      await repository.pool.query(
        "INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,base_revision,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [artifact.id, artifact.projectId, artifact.taskId, artifact.attemptId, artifact.kind, artifact.contentHash, artifact.baseRevision, artifact.fingerprint, JSON.stringify(artifact.structuredData ?? {})],
      );
      return artifact;
    }

    const initialArtifact = await createArtifact(`artifact-${randomUUID()}`, bundle);
    await repository.projectStoryArcBundle({ projectId, arcId, bundle, artifact: initialArtifact, actor: "test-author" });
    expect((await repository.getStoryArc(projectId, arcId))?.chapters).toHaveLength(7);

    const shortenedBundle = parseStoryArcBundle({ arc: bundle.arc, batch: bundle.batch, chapters: bundle.chapters.slice(0, 5) });
    const editedArtifact = await createArtifact(`artifact-${randomUUID()}`, shortenedBundle);
    const updated = await repository.projectStoryArcBundle({ projectId, arcId, bundle: shortenedBundle, artifact: editedArtifact, actor: "test-author", edited: true });

    expect(updated.chapters.map((chapter) => chapter.globalOrder)).toEqual([1, 2, 3, 4, 5]);
    expect((await repository.pool.query("SELECT id FROM chapters WHERE arc_id=$1 ORDER BY ordinal", [arcId])).rows).toHaveLength(5);
  });

  it("allows editing the current awaiting-review later batch without reopening arc boundaries", async () => {
    if (!available) return;
    const volumeId = `volume:${projectId}:test`;
    const arcId = `arc-${randomUUID()}`;
    await repository.pool.query("INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload) VALUES($1,$2,$3,'后续批次弧',11,'awaiting-review','active',$4)", [arcId, volumeId, projectId, bundle.arc]);

    async function createArtifact(id: string, structuredData: unknown): Promise<Artifact> {
      const artifact: Artifact = {
        id,
        projectId,
        taskId: `task-${id}`,
        attemptId: `attempt-${id}`,
        kind: "arc-plan",
        contentHash: `hash-${id}`,
        baseRevision: 0,
        createdAt: Date.now(),
        fingerprint: `fp-${id}`,
        structuredData: structuredData as Record<string, unknown>,
      };
      await repository.pool.query(
        "INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,base_revision,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [artifact.id, artifact.projectId, artifact.taskId, artifact.attemptId, artifact.kind, artifact.contentHash, artifact.baseRevision, artifact.fingerprint, JSON.stringify(artifact.structuredData ?? {})],
      );
      return artifact;
    }

    const generatedBatch = parseStoryArcBundle({
      arc: bundle.arc,
      batch: { batchIndex: 2, startChapterIndex: 8, complete: false },
      chapters: bundle.chapters.slice(0, 2).map((chapter, index) => ({ ...chapter, index: index + 1, title: `旧后续章 ${index + 1}` })),
    });
    const generatedArtifact = await createArtifact(`artifact-${randomUUID()}`, generatedBatch);
    await repository.pool.query(
      "INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,source_artifact_id,entry_fingerprint,payload) VALUES($1,$2,$3,2,8,9,'awaiting-review',$4,'test',$5)",
      [`batch:${arcId}:2`, arcId, projectId, generatedArtifact.id, generatedBatch.batch],
    );
    for (const [offset, chapter] of generatedBatch.chapters.entries()) {
      const chapterId = `chapter-${randomUUID()}`;
      await repository.pool.query(
        "INSERT INTO chapters(id,arc_id,project_id,title,ordinal,status,payload,source_artifact_id,blueprint_revision,batch_id,batch_index) VALUES($1,$2,$3,$4,$5,'planned',$6,$7,0,$8,2)",
        [chapterId, arcId, projectId, chapter.title, 8 + offset, { ...chapter, id: chapterId, index: 8 + offset }, generatedArtifact.id, `batch:${arcId}:2`],
      );
    }

    const editedBatch = parseStoryArcBundle({
      arc: bundle.arc,
      batch: generatedBatch.batch,
      chapters: generatedBatch.chapters.map((chapter, index) => ({ ...chapter, title: `修订后续章 ${index + 1}`, summary: `${chapter.summary}（已修订）` })),
    });
    const editedArtifact = await createArtifact(`artifact-${randomUUID()}`, editedBatch);
    const updated = await repository.projectStoryArcBundle({ projectId, arcId, bundle: editedBatch, artifact: editedArtifact, actor: "test-author", edited: true });

    expect(updated.planningStatus).toBe("awaiting-review");
    expect(updated.batches.find((item) => item.batchIndex === 2)).toMatchObject({ status: "awaiting-review", sourceArtifactId: editedArtifact.id });
    expect(updated.chapters.filter((chapter) => chapter.globalOrder >= 8).map((chapter) => chapter.title)).toEqual(["修订后续章 1", "修订后续章 2"]);

    const boundaryRewrite = parseStoryArcBundle({ ...editedBatch, arc: { ...editedBatch.arc, title: "非法改边界" } });
    const boundaryArtifact = await createArtifact(`artifact-${randomUUID()}`, boundaryRewrite);
    await expect(repository.projectStoryArcBundle({ projectId, arcId, bundle: boundaryRewrite, artifact: boundaryArtifact, actor: "test-author", edited: true })).rejects.toThrow("后续批次不得改写故事弧边界");
  });

  it("protects drafted story arcs unless force deletion is requested", async () => {
    if (!available) return;
    const volumeId = `volume:${projectId}:test`;
    const removableArcId = `arc-${randomUUID()}`;
    const removableDocId = `doc-${randomUUID()}`;
    const removableChapterId = `chapter-${randomUUID()}`;
    await repository.pool.query("INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload) VALUES($1,$2,$3,'可删除弧',20,'awaiting-review','planned',$4)", [removableArcId, volumeId, projectId, bundle.arc]);
    await repository.pool.query("INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,entry_fingerprint,payload) VALUES($1,$2,$3,1,1,1,'awaiting-review','test',$4)", [`batch:${removableArcId}:1`, removableArcId, projectId, { complete: false }]);
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,'可删除章',20,'planned')", [removableDocId, projectId]);
    await repository.pool.query("INSERT INTO chapters(id,arc_id,project_id,document_id,title,ordinal,status,payload,batch_id,batch_index) VALUES($1,$2,$3,$4,'可删除章',20,'planned',$5,$6,1)", [removableChapterId, removableArcId, projectId, removableDocId, { ...bundle.chapters[0], id: removableChapterId, index: 20 }, `batch:${removableArcId}:1`]);
    await repository.pool.query("INSERT INTO scenes(id,chapter_id,ordinal,summary,payload) VALUES($1,$2,1,'场景',$3)", [`scene-${randomUUID()}`, removableChapterId, bundle.chapters[0].scenes[0]]);

    await expect(repository.deleteStoryArc(projectId, removableArcId, "test-author")).resolves.toMatchObject({ deleted: true, projectId, arcId: removableArcId, removedDocumentIds: [removableDocId] });
    await expect(repository.getStoryArc(projectId, removableArcId)).resolves.toBeUndefined();
    expect((await repository.pool.query("SELECT 1 FROM manuscript_documents WHERE id=$1", [removableDocId])).rowCount).toBe(0);

    const protectedArcId = `arc-${randomUUID()}`;
    const protectedDocId = `doc-${randomUUID()}`;
    const protectedChapterId = `chapter-${randomUUID()}`;
    const revisionId = `rev-${randomUUID()}`;
    const contentHash = randomUUID();
    await repository.pool.query("INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload) VALUES($1,$2,$3,'受保护弧',21,'approved','active',$4)", [protectedArcId, volumeId, projectId, bundle.arc]);
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,'已有正文章',21,'final')", [protectedDocId, projectId]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,1)", [contentHash, `test/${contentHash}`]);
    await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)", [revisionId, projectId, protectedDocId, contentHash]);
    await repository.pool.query("UPDATE manuscript_documents SET current_revision_id=$1 WHERE id=$2", [revisionId, protectedDocId]);
    await repository.pool.query("INSERT INTO chapters(id,arc_id,project_id,document_id,title,ordinal,status,payload,batch_index) VALUES($1,$2,$3,$4,'已有正文章',21,'planned',$5,1)", [protectedChapterId, protectedArcId, projectId, protectedDocId, { ...bundle.chapters[0], id: protectedChapterId, index: 21 }]);
    const factArtifactId = "artifact-" + randomUUID();
    const claimId = "claim-" + randomUUID();
    const rollupClaimId = "chapter-memory:rollup:" + projectId + ":21-40";
    const chapterMemoryId = "memory:chapter:" + revisionId;
    const factId = "fact-" + randomUUID();
    const promiseId = "promise-" + randomUUID();
    const foreshadowingId = "foreshadowing-" + randomUUID();
    const timelineId = "timeline-" + randomUUID();
    const workflowId = "workflow-" + randomUUID();
    await repository.pool.query(
      "INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,base_revision,fingerprint,payload) VALUES($1,$2,$3,'attempt','facts',$4,0,$5,$6)",
      [factArtifactId, projectId, "task-" + factArtifactId, "hash-" + factArtifactId, "fp-" + factArtifactId, { sourceArtifactId: "draft-" + revisionId }],
    );
    await repository.pool.query(
      "INSERT INTO memory_claims(id,project_id,kind,title,content,subject_refs,knowledge_scope,authority,confidence,source_revision_ids,content_hash,supersedes,predicate,lifecycle_status,source_document_id,source_artifact_id) VALUES($1,$2,'canonical','正文事实','这一章产生的事实',$3,$4,'approved',1,$5,$6,'{}','test-fact','active',$7,$8)",
      [claimId, projectId, ["hero"], JSON.stringify("author"), [revisionId], "hash-" + claimId, protectedDocId, factArtifactId],
    );
    await repository.pool.query(
      "INSERT INTO memory_claim_sources(claim_id,project_id,document_id,revision_id,artifact_id,lifecycle_status) VALUES($1,$2,$3,$4,$5,'active')",
      [claimId, projectId, protectedDocId, revisionId, factArtifactId],
    );
    await repository.pool.query(
      "INSERT INTO memory_claims(id,project_id,kind,title,content,subject_refs,knowledge_scope,authority,confidence,source_revision_ids,content_hash,supersedes,predicate,lifecycle_status) VALUES($1,$2,'hierarchical','章节汇总','包含被删除章节',$3,$4,'derived',0.9,$5,$6,'{}','chapter-memory-rollup','active')",
      [rollupClaimId, projectId, [], JSON.stringify("author"), [revisionId], "hash-" + rollupClaimId],
    );
    await repository.createChapterMemory({
      id: chapterMemoryId,
      projectId,
      documentId: protectedDocId,
      revisionId,
      narrativeRange: { start: 21, end: 21 },
      summary: "已有正文摘要",
      keyEvents: ["事实发生"],
      characterStates: [{ characterId: "hero", stateSnapshot: "已改变" }],
      unresolvedThreads: [],
      fingerprint: "fp-" + chapterMemoryId,
      createdAt: Date.now(),
    });
    await repository.pool.query("INSERT INTO facts(id,project_id,predicate,object_value,truth_status,confidence) VALUES($1,$2,'legacy',$3,'approved',1)", [factId, projectId, { value: "旧事实" }]);
    await repository.pool.query("INSERT INTO fact_sources(fact_id,revision_id,evidence) VALUES($1,$2,$3)", [factId, revisionId, { quote: "证据" }]);
    await repository.pool.query("INSERT INTO promises(id,project_id,statement,source_revision_id,status,narrative_order) VALUES($1,$2,'本章承诺',$3,'open',21)", [promiseId, projectId, revisionId]);
    await repository.pool.query("INSERT INTO foreshadowing(id,project_id,planted_revision_id,status,payload,narrative_order) VALUES($1,$2,$3,'open',$4,21)", [foreshadowingId, projectId, revisionId, { description: "伏笔" }]);
    await repository.pool.query("INSERT INTO timeline_events(id,project_id,narrative_time,event_type,content,source_revision_id) VALUES($1,$2,21,'chapter',$3,$4)", [timelineId, projectId, { title: "已有正文章" }, revisionId]);
    await repository.pool.query(
      "INSERT INTO narrative_state_snapshots(id,project_id,document_id,revision_id,narrative_order,payload,fingerprint) VALUES($1,$2,$3,$4,21,$5,$6)",
      ["state-" + revisionId, projectId, protectedDocId, revisionId, { id: "state-" + revisionId }, "fp-state-" + revisionId],
    );
    await repository.pool.query(
      "INSERT INTO workflow_runs(id,workflow_type,project_id,temporal_workflow_id,status,payload) VALUES($1,'chapter-lifecycle',$2,$1,'running',$3)",
      [workflowId, projectId, { documentId: protectedDocId }],
    );

    await expect(repository.deleteStoryArc(projectId, protectedArcId, "test-author")).rejects.toThrow("已有正文");
    expect((await repository.getStoryArc(projectId, protectedArcId))?.id).toBe(protectedArcId);

    const forced = await repository.deleteStoryArc(projectId, protectedArcId, "test-author", { force: true });
    expect(forced).toMatchObject({ deleted: true, force: true, projectId, arcId: protectedArcId, removedDocumentIds: [protectedDocId], removedRevisionIds: [revisionId] });
    expect(forced.removedMemoryClaimIds).toEqual(expect.arrayContaining([claimId, rollupClaimId]));
    expect(forced.removedChapterMemoryIds).toContain(chapterMemoryId);
    expect(forced.cancelledWorkflowIds).toContain(workflowId);
    await expect(repository.getStoryArc(projectId, protectedArcId)).resolves.toBeUndefined();
    expect((await repository.pool.query("SELECT 1 FROM manuscript_documents WHERE id=$1", [protectedDocId])).rowCount).toBe(0);
    expect((await repository.pool.query("SELECT 1 FROM manuscript_revisions WHERE id=$1", [revisionId])).rowCount).toBe(0);
    expect((await repository.pool.query("SELECT 1 FROM chapter_memories WHERE id=$1", [chapterMemoryId])).rowCount).toBe(0);
    expect((await repository.pool.query("SELECT 1 FROM memory_claims WHERE id=ANY($1::text[])", [[claimId, rollupClaimId]])).rowCount).toBe(0);
    expect((await repository.pool.query("SELECT 1 FROM fact_sources WHERE revision_id=$1", [revisionId])).rowCount).toBe(0);
    expect((await repository.pool.query("SELECT 1 FROM facts WHERE id=$1", [factId])).rowCount).toBe(0);
    expect((await repository.pool.query("SELECT 1 FROM promises WHERE id=$1", [promiseId])).rowCount).toBe(0);
    expect((await repository.pool.query("SELECT 1 FROM foreshadowing WHERE id=$1", [foreshadowingId])).rowCount).toBe(0);
    expect((await repository.pool.query("SELECT 1 FROM timeline_events WHERE id=$1", [timelineId])).rowCount).toBe(0);
    expect((await repository.pool.query("SELECT 1 FROM narrative_state_snapshots WHERE revision_id=$1", [revisionId])).rowCount).toBe(0);
    expect((await repository.pool.query("SELECT status FROM workflow_runs WHERE id=$1", [workflowId])).rows[0]?.status).toBe("cancelled");
  });
});
