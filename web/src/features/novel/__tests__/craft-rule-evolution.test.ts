import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NovelDatabase, recordBase } from "../db";
import {
  createCraftRuleCandidate,
  evaluateCraftRuleOnFoundation,
  evaluateCraftRuleOnChapter,
  evaluateCraftRuleGate,
  promoteCraftRuleCandidate,
  recordCraftRuleEvidence,
  rollbackCraftRuleCandidate,
  submitCraftRuleReview,
} from "../craft-rule-evolution";
import { getEffectiveSkill } from "../skills";
import { MASTER_PROMPT_TEMPLATE_ID, listPromptTemplates } from "../prompt-templates";
import type { CraftRuleCandidate, CraftRuleReviewRole, CreativeWorkItem, StoryProject } from "../types";

const projectId = "project-1";
const scope = {
  observedSymptom: "多个章节的人物选择缺少代价",
  failingLayer: "drafting skill",
  underlyingMechanism: "生成规则强调行动结果但没有要求价值取舍",
  affectedInputClass: "人物在高压情境下作出不可逆选择的章节",
  intendedBenefits: ["增强人物主体性", "让剧情转折来自人物选择"],
  boundaries: ["不强制日常章制造重大抉择"],
  nonGoals: ["不统一题材文风"],
  regressionRisks: ["过度强调代价会让轻松章节失去呼吸"],
};

describe("craft rule evolution", () => {
  let db: NovelDatabase;

  beforeEach(async () => {
    db = new NovelDatabase(`ymcp-craft-rule-${crypto.randomUUID()}`);
    await db.open();
    await db.projects.put({
      id: projectId, schemaVersion: 8, revision: 1, createdAt: 1, updatedAt: 1, createdBy: "test", updatedBy: "test",
      title: "长篇测试", subtitle: "", premise: "测试", genre: ["玄幻"], audience: "读者", themes: [], sellingPoints: [], pov: "第三人称限知", tense: "过去时", tone: "克制", languageStyle: "具象", targetWords: 3000000, dailyGoal: 3000, status: "planning", coverColor: "#000000",
      settings: { textModel: "test", temperature: 0.7, recentChapterCount: 5, encrypted: false, contentProfile: "general-serial", maxAutoRevisions: 2, qualityThreshold: 3.7, approvalMode: "blueprint-and-manuscript" },
    } satisfies StoryProject);
  });

  afterEach(async () => { await db.delete(); });

  async function completeGate(candidate: CraftRuleCandidate) {
    await db.documents.bulkPut([
      { ...recordBase(projectId), id: "chapter-1", order: 0, title: "静态铺陈", blueprint: { objective: "建立常态", locationIds: [], characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "", informationRelease: [], mustHappen: [], flexible: [], forbidden: [], targetWords: 3000 }, contentHtml: "", plainText: "", summary: "", status: "outline", wordCount: 0, branch: "main", yjsDocumentId: "y1" },
      { ...recordBase(projectId), id: "chapter-2", order: 1, title: "关系余波", blueprint: { objective: "处理关系后果", locationIds: [], characterIds: ["c1"], plotThreadIds: [], foreshadowingIds: [], conflict: "双方回避同一承诺", informationRelease: [], mustHappen: ["完成一次对话"], flexible: [], forbidden: [], targetWords: 5000 }, contentHtml: "<p>旧稿</p>", plainText: "旧稿", summary: "", status: "draft", wordCount: 2, branch: "main", yjsDocumentId: "y2" },
      { ...recordBase(projectId), id: "chapter-3", order: 2, title: "多线行动", blueprint: { objective: "推进多方行动", locationIds: [], characterIds: ["c1", "c2", "c3", "c4"], plotThreadIds: [], foreshadowingIds: [], conflict: "多方争夺同一资源", informationRelease: ["线索一", "线索二", "线索三", "线索四"], mustHappen: ["遭遇阻力", "作出选择"], flexible: [], forbidden: [], targetWords: 1500 }, contentHtml: "", plainText: "", summary: "", status: "outline", wordCount: 0, branch: "main", yjsDocumentId: "y3" },
    ]);
    const scenarios = [
      { scenario: "高压行动章", documentId: "chapter-1", baseline: 3.5, changed: 3.8 },
      { scenario: "关系余波章", documentId: "chapter-2", baseline: 3.6, changed: 3.75 },
      { scenario: "线索铺陈章", documentId: "chapter-3", baseline: 3.7, changed: 3.82 },
    ];
    for (const [index, item] of scenarios.entries()) {
      const baseline: CreativeWorkItem = { ...recordBase(projectId), id: `baseline-${index}-${candidate.id}`, creativeRunId: `run-b-${index}`, kind: "chapter-workflow", status: "completed", targetId: item.documentId, instruction: "基线", dependsOn: [], iteration: 0, artifactRefs: [`artifact-b-${index}`], parameters: { evaluationRole: "baseline", scenarioClass: item.scenario, ruleCandidateId: candidate.id, ruleApplication: { candidateId: candidate.id, evaluationRole: "baseline", targetKind: candidate.targetKind, targetId: candidate.targetId, version: candidate.proposedVersion, promptFingerprint: `baseline-fingerprint-${index}`, stages: ["drafting"] }, closedLoopCandidate: { id: `artifact-b-${index}`, qualityEvidence: { weightedScore: item.baseline, blockerCount: 0, majorCount: 0 } } } };
      const changed: CreativeWorkItem = { ...recordBase(projectId), id: `candidate-${index}-${candidate.id}`, creativeRunId: `run-c-${index}`, kind: "chapter-workflow", status: "completed", targetId: item.documentId, instruction: "候选", dependsOn: [], iteration: 0, artifactRefs: [`artifact-c-${index}`], parameters: { evaluationRole: "candidate", scenarioClass: item.scenario, ruleCandidateId: candidate.id, ruleApplication: { candidateId: candidate.id, evaluationRole: "candidate", targetKind: candidate.targetKind, targetId: candidate.targetId, version: candidate.proposedVersion, promptFingerprint: `candidate-fingerprint-${index}`, stages: ["drafting"] }, closedLoopCandidate: { id: `artifact-c-${index}`, qualityEvidence: { weightedScore: item.changed, blockerCount: 0, majorCount: 0 } } } };
      await db.creativeWorkItems.bulkPut([baseline, changed]);
      candidate = await recordCraftRuleEvidence({ candidateId: candidate.id, scenarioClass: item.scenario, baselineWorkItemId: baseline.id, candidateWorkItemId: changed.id }, db);
    }
    for (const role of ["plot-editor", "character-editor", "prose-editor", "long-form-editor"] satisfies CraftRuleReviewRole[]) {
      candidate = await submitCraftRuleReview({ candidateId: candidate.id, role, reviewer: "external-llm", reviewerId: role === "plot-editor" || role === "prose-editor" ? "reviewer-a" : "reviewer-b", reviewRunId: `review-run-${role}-${candidate.id}`, model: "test-review-model", verdict: "passed", summary: `${role} 确认修改覆盖通用机制且没有压平文体`, concerns: [] }, db);
    }
    return candidate;
  }

  it("requires cross-scenario evidence and all four independent reviews", async () => {
    const skill = (await getEffectiveSkill(projectId, "embodied-prose", db))!;
    const candidate = await createCraftRuleCandidate({ projectId, targetKind: "skill", targetId: skill.skillId, afterText: `${skill.prompt}\n\n补充：人物在高压选择中应呈现代价，但日常与余波章节不强制制造抉择，具体强度服从章节功能和人物处境。`, rationale: "把单章人物问题提升为有边界的选择机制", scope }, db);
    expect(evaluateCraftRuleGate(candidate).ready).toBe(false);
    const ready = await completeGate(candidate);
    expect(ready.status).toBe("ready");
    expect(evaluateCraftRuleGate(ready)).toMatchObject({ ready: true });
  });

  it("does not treat renamed scenario labels or one self-review identity as independent evidence", async () => {
    const skill = (await getEffectiveSkill(projectId, "embodied-prose", db))!;
    const candidate = await createCraftRuleCandidate({ projectId, targetKind: "skill", targetId: skill.skillId, afterText: `${skill.prompt}\n\n补充：人物选择的代价应改变后续空间，同时服从章节功能和叙事风格。`, rationale: "验证不可伪造的多样性门禁", scope }, db);
    const ready = await completeGate(candidate);
    const renamedOnly = { ...ready, evidenceCases: ready.evidenceCases.map((item, index) => ({ ...item, scenarioClass: `自由标签-${index}`, scenarioSignature: "same-actual-structure" })) };
    expect(evaluateCraftRuleGate(renamedOnly).reasons).toContain("实际输入结构至少需要覆盖 3 类不同创作场景");
    const selfReviewed = { ...ready, reviews: ready.reviews.map((review) => ({ ...review, reviewerId: "same-agent", reviewRunId: "same-run" })) };
    expect(evaluateCraftRuleGate(selfReviewed).reasons).toEqual(expect.arrayContaining(["四项角色审核必须来自彼此独立的审核运行", "四项角色审核至少需要两个独立审核主体"]));
  });

  it("validates the complete root-cause scope in the shared service", async () => {
    const skill = (await getEffectiveSkill(projectId, "embodied-prose", db))!;
    await expect(createCraftRuleCandidate({
      projectId,
      targetKind: "skill",
      targetId: skill.skillId,
      afterText: `${skill.prompt}\n\n补充：高压选择呈现代价，但规则强度服从章节功能，并保留日常、铺陈和余波章节的呼吸空间。`,
      rationale: "验证服务层范围契约",
      scope: { ...scope, regressionRisks: [] },
    }, db)).rejects.toThrow("regressionRisks");
  });

  it("creates a foundation-only candidate and evaluates it with an isolated foundation task", async () => {
    const skill = (await getEffectiveSkill(projectId, "premise-pressure-test", db))!;
    const candidate = await createCraftRuleCandidate({
      projectId,
      targetKind: "skill",
      targetId: skill.skillId,
      afterText: `${skill.prompt}\n\n补充：创意压力测试应跨题材检查长期扩展空间，同时允许短篇式阶段实验，不把固定升级次数当作硬规则。`,
      rationale: "验证阶段评测边界",
      scope,
    }, db);
    const evaluated = await evaluateCraftRuleOnFoundation({ candidateId: candidate.id, taskKey: "architecture", scenarioClass: "长篇架构" }, {
      generate: async ({ ruleText }) => ({ artifactMarkdown: `${ruleText.includes("补充") ? "候选" : "基线"}架构方案`.repeat(30), designNotes: ["保持长线余量"] }),
      assess: async ({ artifact }) => ({ scores: { plotPotential: artifact.artifactMarkdown.includes("候选") ? 4 : 3.7, characterAgency: 4, worldCausality: 4, longFormCapacity: 4, specificity: 4, styleFitness: 4 }, issues: [], summary: "盲审完成" }),
    }, db);
    expect(evaluated.evidenceCases[0]).toMatchObject({ subjectKind: "foundation-task", subjectId: "foundation:architecture" });
  });

  it("runs an isolated baseline/candidate pair and records evidence from completed work", async () => {
    const skill = (await getEffectiveSkill(projectId, "embodied-prose", db))!;
    const candidate = await createCraftRuleCandidate({ projectId, targetKind: "skill", targetId: skill.skillId, afterText: `${skill.prompt}\n\n补充：高压选择呈现代价，但规则强度服从章节功能，并保留日常、铺陈和余波章节的呼吸空间。`, rationale: "验证真实 A/B 工作编排", scope }, db);
    await db.documents.put({
      ...recordBase(projectId),
      id: "chapter-eval",
      order: 0,
      title: "评测章节",
      blueprint: { objective: "完成一次有代价的选择", locationIds: [], characterIds: [], plotThreadIds: [], foreshadowingIds: [], conflict: "", informationRelease: [], mustHappen: [], flexible: [], forbidden: [], targetWords: 3000 },
      contentHtml: "",
      plainText: "",
      summary: "",
      status: "outline",
      wordCount: 0,
      branch: "main",
      yjsDocumentId: "eval-yjs",
    });
    const evaluated = await evaluateCraftRuleOnChapter({ candidateId: candidate.id, documentId: "chapter-eval", scenarioClass: "人物高压选择" }, {
      executor: async (work) => {
        const score = work.parameters.evaluationRole === "candidate" ? 3.9 : 3.6;
        work.parameters.ruleApplication = { candidateId: candidate.id, evaluationRole: work.parameters.evaluationRole, targetKind: candidate.targetKind, targetId: candidate.targetId, version: candidate.proposedVersion, promptFingerprint: `${work.parameters.evaluationRole}-fingerprint`, stages: ["drafting"] };
        work.parameters.closedLoopCandidate = { id: `${work.id}:artifact`, qualityEvidence: { weightedScore: score, blockerCount: 0, majorCount: 0 } };
        return { artifactRefs: [`${work.id}:artifact`], summary: "隔离候选已生成" };
      },
      reviewer: async (work) => ({ subjectArtifactId: work.artifactRefs[0]!, reviewer: "internal", verdict: "passed", summary: "评测产物通过", issues: [] }),
    }, db);
    expect(evaluated.evidenceCases).toHaveLength(1);
    expect(evaluated.evidenceCases[0]).toMatchObject({ scenarioClass: "人物高压选择", baselineScore: 3.6, candidateScore: 3.9 });
    const works = await db.creativeWorkItems.where("projectId").equals(projectId).toArray();
    expect(works.map((item) => item.parameters.evaluationRole).sort()).toEqual(["baseline", "candidate"]);
    expect(works.every((item) => item.status === "completed")).toBe(true);
  });

  it("uses the latest role review and freezes reviews after promotion", async () => {
    const skill = (await getEffectiveSkill(projectId, "embodied-prose", db))!;
    let candidate = await createCraftRuleCandidate({ projectId, targetKind: "skill", targetId: skill.skillId, afterText: `${skill.prompt}\n\n补充：高压选择呈现代价，但规则强度服从章节功能，并保留日常、铺陈和余波章节的呼吸空间。`, rationale: "验证复审状态机", scope }, db);
    candidate = await submitCraftRuleReview({ candidateId: candidate.id, role: "plot-editor", reviewer: "external-llm", reviewerId: "reviewer-a", reviewRunId: "reject-run", model: "test-review-model", verdict: "rejected", summary: "初审认为边界不清楚" }, db);
    expect(candidate.status).toBe("rejected");
    candidate = await submitCraftRuleReview({ candidateId: candidate.id, role: "plot-editor", reviewer: "external-llm", reviewerId: "reviewer-a", reviewRunId: "pass-run", model: "test-review-model", verdict: "passed", summary: "修订后的边界说明已覆盖原顾虑" }, db);
    expect(candidate.status).toBe("evaluating");

    candidate = await completeGate(candidate);
    await promoteCraftRuleCandidate(candidate.id, db);
    await expect(submitCraftRuleReview({ candidateId: candidate.id, role: "plot-editor", reviewer: "external-llm", reviewerId: "reviewer-a", reviewRunId: "late-run", model: "test-review-model", verdict: "passed", summary: "晋升后不得追加" }, db))
      .rejects.toThrow("已结束的规则候选");
  });

  it("invalidates prior rule reviews when the evidence set changes", async () => {
    const skill = (await getEffectiveSkill(projectId, "embodied-prose", db))!;
    let candidate = await createCraftRuleCandidate({ projectId, targetKind: "skill", targetId: skill.skillId, afterText: `${skill.prompt}\n\n补充：高压选择呈现代价，其他章节按主导功能保留呼吸。`, rationale: "验证证据绑定审核", scope }, db);
    candidate = await submitCraftRuleReview({ candidateId: candidate.id, role: "plot-editor", reviewer: "external-llm", reviewerId: "reviewer-a", reviewRunId: "initial-run", model: "test-review-model", verdict: "passed", summary: "初步通过" }, db);
    candidate = await completeGate(candidate);
    expect(candidate.status).toBe("ready");

    const source = candidate.evidenceCases[0]!;
    const baseline = (await db.creativeWorkItems.get(source.baselineWorkItemId))!;
    const changed = (await db.creativeWorkItems.get(source.candidateWorkItemId))!;
    const nextBaseline = { ...baseline, ...recordBase(projectId), id: `new-${baseline.id}`, parameters: { ...baseline.parameters, scenarioClass: "静态世界观铺陈" } };
    const nextChanged = { ...changed, ...recordBase(projectId), id: `new-${changed.id}`, parameters: { ...changed.parameters, scenarioClass: "静态世界观铺陈" } };
    await db.creativeWorkItems.bulkPut([nextBaseline, nextChanged]);
    candidate = await recordCraftRuleEvidence({ candidateId: candidate.id, scenarioClass: "静态世界观铺陈", baselineWorkItemId: nextBaseline.id, candidateWorkItemId: nextChanged.id }, db);
    expect(evaluateCraftRuleGate(candidate).reasons).toContain("plot-editor 审核早于当前证据集，需要重新审核");
    expect(candidate.status).toBe("evaluating");
  });

  it("rejects duplicate work pairs and evidence without actual rule provenance", async () => {
    const skill = (await getEffectiveSkill(projectId, "embodied-prose", db))!;
    const candidate = await createCraftRuleCandidate({ projectId, targetKind: "skill", targetId: skill.skillId, afterText: `${skill.prompt}\n\n补充：选择压力需要有可见代价，但日常和余波章节只在符合自身功能时采用。`, rationale: "验证证据来源", scope }, db);
    const baseline: CreativeWorkItem = { ...recordBase(projectId), id: "missing-provenance-baseline", creativeRunId: "run-1", kind: "chapter-workflow", status: "completed", targetId: "chapter-1", instruction: "基线", dependsOn: [], iteration: 0, artifactRefs: ["b"], parameters: { evaluationRole: "baseline", scenarioClass: "行动章", ruleCandidateId: candidate.id, closedLoopCandidate: { qualityEvidence: { weightedScore: 3.5 } } } };
    const changed: CreativeWorkItem = { ...recordBase(projectId), id: "missing-provenance-candidate", creativeRunId: "run-1", kind: "chapter-workflow", status: "completed", targetId: "chapter-1", instruction: "候选", dependsOn: [], iteration: 0, artifactRefs: ["c"], parameters: { evaluationRole: "candidate", scenarioClass: "行动章", ruleCandidateId: candidate.id, closedLoopCandidate: { qualityEvidence: { weightedScore: 3.8 } } } };
    await db.creativeWorkItems.bulkPut([baseline, changed]);
    await expect(recordCraftRuleEvidence({ candidateId: candidate.id, scenarioClass: "行动章", baselineWorkItemId: baseline.id, candidateWorkItemId: changed.id }, db))
      .rejects.toThrow("Prompt provenance");
  });

  it("promotes and rolls back immutable Skill and system Prompt versions", async () => {
    const skill = (await getEffectiveSkill(projectId, "embodied-prose", db))!;
    let skillCandidate = await createCraftRuleCandidate({ projectId, targetKind: "skill", targetId: skill.skillId, afterText: `${skill.prompt}\n\n补充：高压选择必须呈现人物愿意支付的代价；日常、铺陈和余波章节按自身功能保留呼吸。`, rationale: "提升跨章节人物选择质量", scope }, db);
    skillCandidate = await completeGate(skillCandidate);
    const promotedSkill = await promoteCraftRuleCandidate(skillCandidate.id, db);
    expect((await getEffectiveSkill(projectId, skill.skillId, db))?.version).toBe(promotedSkill.proposedVersion);
    expect((await db.skills.where("[projectId+skillId]").equals([projectId, skill.skillId]).toArray()).map((item) => item.version)).toContain(promotedSkill.proposedVersion);
    await rollbackCraftRuleCandidate(skillCandidate.id, db);
    expect((await getEffectiveSkill(projectId, skill.skillId, db))?.version).toBe(skill.version);

    const prompt = (await listPromptTemplates(projectId, db)).find((item) => item.templateId === MASTER_PROMPT_TEMPLATE_ID)!;
    let promptCandidate = await createCraftRuleCandidate({ projectId, targetKind: "system-prompt", targetId: prompt.templateId, afterText: `${prompt.content}\n\n对任何规则修改，必须同时检查剧情因果、人物主体性、文笔意境和百万字尺度的回归风险，不以单章得分替代跨场景证据。`, rationale: "加强系统级规则演进门禁", scope }, db);
    promptCandidate = await completeGate(promptCandidate);
    await promoteCraftRuleCandidate(promptCandidate.id, db);
    expect((await listPromptTemplates(projectId, db)).find((item) => item.templateId === prompt.templateId)?.version).toBe(promptCandidate.proposedVersion);
    await rollbackCraftRuleCandidate(promptCandidate.id, db);
    expect((await listPromptTemplates(projectId, db)).find((item) => item.templateId === prompt.templateId)?.version).toBe(prompt.version);
  });

  it("does not let an older promoted candidate roll back a newer active version", async () => {
    const skill = (await getEffectiveSkill(projectId, "embodied-prose", db))!;
    let first = await createCraftRuleCandidate({ projectId, targetKind: "skill", targetId: skill.skillId, afterText: `${skill.prompt}\n\n补充：高压选择呈现可见代价，其他章节按功能决定是否采用。`, rationale: "第一版", scope }, db);
    first = await completeGate(first);
    first = await promoteCraftRuleCandidate(first.id, db);
    const active = (await getEffectiveSkill(projectId, skill.skillId, db))!;
    let second = await createCraftRuleCandidate({ projectId, targetKind: "skill", targetId: active.skillId, afterText: `${active.prompt}\n\n补充：代价必须改变后续选择空间，而不是只增加表面痛苦。`, rationale: "第二版", scope }, db);
    second = await completeGate(second);
    await promoteCraftRuleCandidate(second.id, db);

    await expect(rollbackCraftRuleCandidate(first.id, db)).rejects.toThrow("后续版本替换");
  });
});
