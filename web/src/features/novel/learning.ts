import { parseRuntimeLearningAssessment } from "./runtime-learning";
import { callStructuredNovelModel } from "./ai";
import { captureChapterRuleReplay, createCraftRuleCandidateFromLearning } from "./craft-rule-evolution";
import { novelDb, type NovelDatabase } from "./db";
import { listPromptTemplates } from "./prompt-templates";
import { resolveNovelSkills } from "./skills";
import type { CraftRuleCandidate, LearningAssessment, QualityReport } from "./types";

export async function getWorkflowReplayInstruction(workflowRunId: string, db: NovelDatabase = novelDb): Promise<string> {
  const prompts = await db.workflowArtifacts.where("workflowRunId").equals(workflowRunId)
    .and((artifact) => artifact.kind === "prompt")
    .sortBy("createdAt");
  const instruction = prompts.at(-1)?.contentMarkdown.trim();
  if (!instruction) throw new Error("工作流缺少冻结原始指令，不能创建失败场景回放");
  return instruction;
}

const learningAssessmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["conclusion", "summary"],
  properties: {
    conclusion: { enum: ["no-shared-learning", "propose-improvement"] },
    summary: { type: "string", minLength: 1 },
    affectedInputClass: { type: "string" },
    underlyingMechanism: { type: "string" },
    proposal: {
      type: "object",
      additionalProperties: false,
      required: ["targetKind", "targetId", "afterText", "rationale", "observedSymptom", "failingLayer", "intendedBenefits", "boundaries", "nonGoals", "regressionRisks"],
      properties: {
        targetKind: { enum: ["skill", "system-prompt"] },
        targetId: { type: "string", minLength: 1 },
        afterText: { type: "string", minLength: 100 },
        rationale: { type: "string", minLength: 1 },
        observedSymptom: { type: "string", minLength: 1 },
        failingLayer: { type: "string", minLength: 1 },
        intendedBenefits: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        boundaries: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        nonGoals: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        regressionRisks: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      },
    },
  },
} as const;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fingerprintText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function assessQualityReportLearning(input: {
  projectId: string;
  workflowRunId: string;
  report: QualityReport;
  draftExcerpt: string;
  db?: NovelDatabase;
}): Promise<LearningAssessment> {
  const db = input.db ?? novelDb;
  const reports = await db.qualityReports.where("workflowRunId").equals(input.workflowRunId).sortBy("iteration");
  const issues = reports.flatMap((report) => report.issues.map((issue) => ({ ...issue, iteration: report.iteration })))
    .filter((issue) => !issue.deterministic && issue.rule !== "reviewer.unavailable");
  if (issues.length === 0) return { conclusion: "no-shared-learning", summary: "本轮没有可归因于共享生成规则的审校问题。" };

  const project = await db.projects.get(input.projectId);
  if (!project) throw new Error("项目不存在，无法评估审校经验");
  const [drafting, review, prompts] = await Promise.all([
    resolveNovelSkills({ projectId: input.projectId, stage: "drafting", db }),
    resolveNovelSkills({ projectId: input.projectId, stage: "review", db }),
    listPromptTemplates(input.projectId, db),
  ]);
  const skills = [...new Map([...drafting.skills, ...review.skills].map((skill) => [skill.skillId, skill])).values()];
  const targetCatalog = [
    ...skills.map((skill) => ({ kind: "skill" as const, id: skill.skillId, version: skill.version, name: skill.name, stages: skill.stages, text: skill.prompt })),
    ...prompts.filter((item) => item.stages.some((stage) => stage === "drafting" || stage === "review"))
      .map((item) => ({ kind: "system-prompt" as const, id: item.templateId, version: item.version, name: item.name, stages: item.stages, text: item.content })),
  ];
  const targets = targetCatalog.map((target) => `## ${target.kind}:${target.id}@${target.version}\n名称：${target.name}\n阶段：${target.stages.join(", ")}\n当前全文：\n${target.text}`).join("\n\n");
  const issueText = issues.map((issue) => `- [round=${issue.iteration}] [id=${issue.id}] [${issue.severity}] ${issue.dimension}/${issue.rule}: ${issue.title}\n  证据：${issue.description}\n  建议：${issue.suggestion}`).join("\n");
  const result = await callStructuredNovelModel<Record<string, unknown>>({
    model: project.settings.textModel,
    temperature: 0.15,
    role: "skill-iterator",
    schema: learningAssessmentSchema,
    timeoutMs: 90_000,
    prompt: `# 章节审校经验评估\n判断以下问题是否暴露了可迁移到一类输入的共享 Skill 或系统 Prompt 缺陷。测试样例只是证据，不是规则本身。\n\n## 历轮问题\n${issueText}\n\n## 当前正文摘录\n${input.draftExcerpt.slice(0, 2400)}\n\n## 可修改规则目录与当前全文\n${targets}\n\n## 决策契约\n- 偶发内容失误、项目特有事实或已经由现有规则明确覆盖的执行偏差，返回 no-shared-learning。\n- propose-improvement 必须说明 underlyingMechanism 与 affectedInputClass，并从目录选择一个真实 target。\n- proposal.afterText 必须是保留无关内容后的完整规则全文，不是 diff。先写通用决策原则，再写边界；不得针对书名、人物名、章节号、固定短语或本样例。\n- intendedBenefits、boundaries、nonGoals、regressionRisks 均至少一项。\n- no-shared-learning 时省略 proposal、underlyingMechanism、affectedInputClass。`,
  });
  const assessment = parseRuntimeLearningAssessment(result.data);
  if (assessment.conclusion === "no-shared-learning") return assessment;
  const selected = targetCatalog.find((target) => target.kind === assessment.proposal.targetKind && target.id === assessment.proposal.targetId);
  if (!selected) throw new Error("经验改进候选引用了审核快照之外的规则目标");
  return {
    ...assessment,
    proposal: {
      ...assessment.proposal,
      targetVersion: selected.version,
      targetContentFingerprint: await fingerprintText(selected.text),
    },
  };
}

/**
 * 在事务内重读 qualityReport 最新 revision 再写入，防止并发 lost-update。
 *
 * 所有 learning 字段（learning/learningStatus/learningReplay/learningError/learningStartedAt）
 * 的持久化都必须走此函数，禁止在外部直接 `report.revision += 1; db.put(report)`。
 * 历史上 createWorkflowLearningCandidates 与 review-stage 启动路径都绕过了此函数，
 * 导致与 completeQualityReportLearning 后台任务并发时产生 lost-update（F-004）。
 */
export async function updateQualityReportLearning(
  reportId: string,
  changes: Pick<QualityReport, "learningStatus"> & Partial<Pick<QualityReport, "learning" | "learningReplay" | "learningError" | "learningStartedAt">>,
  db: NovelDatabase,
) {
  return db.transaction("rw", db.qualityReports, async () => {
    const latest = await db.qualityReports.get(reportId);
    if (!latest) throw new Error("质量报告不存在，无法写入审校经验");
    const updated: QualityReport = { ...latest, ...changes, updatedAt: Date.now(), revision: latest.revision + 1 };
    await db.qualityReports.put(updated);
    return updated;
  });
}

export async function completeQualityReportLearning(input: {
  projectId: string;
  workflowRunId: string;
  reportId: string;
  draftExcerpt: string;
  db?: NovelDatabase;
}): Promise<QualityReport> {
  const db = input.db ?? novelDb;
  const report = await db.qualityReports.get(input.reportId);
  if (!report) throw new Error("质量报告不存在，无法沉淀审校经验");
  // F-005 修复：入口先刷新 learningStartedAt，续期 staleness 窗口。
  // review-stage.ts 启动此任务前已写入 learningStartedAt，但当 revision-stage 链路耗时 >120s
  // 且本任务仍在 assessQualityReportLearning（含 LLM 调用，最长 90s）中时，
  // commit-stage 调 createWorkflowLearningCandidates 会因 stale 判定误重评。
  // 入口续期确保"我正在评估"信号覆盖整个评估生命周期，而非只覆盖启动瞬间。
  await updateQualityReportLearning(input.reportId, {
    learningStatus: "pending",
    learningStartedAt: Date.now(),
    learningError: undefined,
  }, db);
  try {
    const learning = await assessQualityReportLearning({
      projectId: input.projectId,
      workflowRunId: input.workflowRunId,
      report,
      draftExcerpt: input.draftExcerpt,
      db,
    });
    const run = await db.workflowRuns.get(input.workflowRunId);
    const learningReplay = learning.conclusion === "propose-improvement" && run
      ? await captureChapterRuleReplay({ projectId: input.projectId, documentId: run.targetDocumentId, instruction: await getWorkflowReplayInstruction(run.id, db), scenarioClass: "正式章节审校失败场景" }, db)
      : undefined;
    const updated = await updateQualityReportLearning(input.reportId, {
      learning,
      learningReplay,
      learningStatus: "completed",
      learningError: undefined,
    }, db);
    if (learning.conclusion === "propose-improvement") {
      await createWorkflowLearningCandidates({ projectId: input.projectId, workflowRunId: input.workflowRunId, db });
    }
    return updated;
  } catch (error) {
    return updateQualityReportLearning(input.reportId, {
      learningStatus: "failed",
      learningError: error instanceof Error ? error.message : "审校经验评估失败",
    }, db);
  }
}

export async function createWorkflowLearningCandidates(input: {
  projectId: string;
  workflowRunId: string;
  db?: NovelDatabase;
}): Promise<CraftRuleCandidate[]> {
  const db = input.db ?? novelDb;
  let reports = await db.qualityReports.where("workflowRunId").equals(input.workflowRunId).sortBy("iteration");
  const run = await db.workflowRuns.get(input.workflowRunId);
  if (!run) throw new Error("工作流不存在，无法沉淀审校经验");
  const stalePendingBefore = Date.now() - 120_000;
  for (const report of reports.filter((item) => item.learningStatus === "failed" || (item.learningStatus === "pending" && (item.learningStartedAt ?? 0) < stalePendingBefore))) {
    const draft = await db.workflowArtifacts.get(report.artifactId);
    // F-004 修复：先续期 learningStartedAt 防止他方并发重评（与 completeQualityReportLearning 入口一致）。
    await updateQualityReportLearning(report.id, {
      learningStatus: "pending",
      learningStartedAt: Date.now(),
      learningError: undefined,
    }, db);
    try {
      const learning = await assessQualityReportLearning({ projectId: input.projectId, workflowRunId: input.workflowRunId, report, draftExcerpt: draft?.contentMarkdown ?? "", db });
      const learningReplay = learning.conclusion === "propose-improvement"
        ? await captureChapterRuleReplay({ projectId: input.projectId, documentId: run.targetDocumentId, instruction: await getWorkflowReplayInstruction(run.id, db), scenarioClass: "正式章节审校失败场景" }, db)
        : undefined;
      // F-004 修复：通过 updateQualityReportLearning 在事务内重读最新 revision 再写入，
      // 防止与 completeQualityReportLearning 后台任务并发产生 lost-update。
      await updateQualityReportLearning(report.id, {
        learning,
        learningReplay,
        learningStatus: "completed",
        learningError: undefined,
      }, db);
    } catch (error) {
      await updateQualityReportLearning(report.id, {
        learningStatus: "failed",
        learningError: error instanceof Error ? error.message : "审校经验评估失败",
      }, db);
    }
  }
  reports = await db.qualityReports.where("workflowRunId").equals(input.workflowRunId).sortBy("iteration");
  const proposals = reports.filter((report): report is QualityReport & { learning: Extract<LearningAssessment, { conclusion: "propose-improvement" }> } => report.learning?.conclusion === "propose-improvement");
  const reportsByMechanism = new Map<string, Array<typeof proposals[number]>>();
  for (const report of proposals) {
    const learning = report.learning;
    const key = `${learning.proposal.targetKind}:${learning.proposal.targetId}:${learning.underlyingMechanism}:${learning.affectedInputClass}`;
    reportsByMechanism.set(key, [...(reportsByMechanism.get(key) ?? []), report]);
  }
  const candidates: CraftRuleCandidate[] = [];
  for (const groupedReports of reportsByMechanism.values()) {
    const report = groupedReports[groupedReports.length - 1];
    const learning = report.learning;
    try {
      const replayReports = groupedReports.filter((item) => item.learningReplay);
      if (!replayReports.length) throw new Error("审校经验缺少冻结失败场景，不能创建规则候选");
      const sourceReportIds = groupedReports.map((item) => item.id);
      const replays = replayReports.map((item) => item.learningReplay!);
      const sourceFingerprint = await fingerprint({ workflowRunId: input.workflowRunId, sourceReportIds, replayFingerprints: replays.map((item) => item.inputFingerprint).sort(), targetKind: learning.proposal.targetKind, targetId: learning.proposal.targetId, targetVersion: learning.proposal.targetVersion, targetContentFingerprint: learning.proposal.targetContentFingerprint, underlyingMechanism: learning.underlyingMechanism, affectedInputClass: learning.affectedInputClass });
      const candidate = await createCraftRuleCandidateFromLearning({
        projectId: input.projectId,
        learning,
        source: {
          kind: "chapter-review",
          fingerprint: sourceFingerprint,
          workflowRunId: input.workflowRunId,
          qualityReportId: report.id,
          issueIds: [...new Set(groupedReports.flatMap((item) => item.issues.map((issue) => issue.id)))],
          autoPromote: false,
          replay: replays[0],
          sourceReportIds,
          replays,
        },
      }, db);
      if (candidate) candidates.push(candidate);
    } catch (error) {
      // F-004 修复：候选创建失败也走 updateQualityReportLearning 事务内重读+revision+1。
      await updateQualityReportLearning(report.id, {
        learningStatus: "failed",
        learningError: error instanceof Error ? error.message : "审校经验候选创建失败",
      }, db);
    }
  }
  return candidates;
}

export async function retryFailedWorkflowLearning(input: { projectId?: string; db?: NovelDatabase } = {}): Promise<CraftRuleCandidate[]> {
  const db = input.db ?? novelDb;
  // TODO P2：staleness 窗口与 LEARNING_ASSESS_TIMEOUT_MS 耦合（须 >评估超时），集中到 config
  const LEARNING_STALENESS_MS = 120_000;
  const stalePendingBefore = Date.now() - LEARNING_STALENESS_MS;
  const failedReports = await db.qualityReports
    .filter((report) => (report.learningStatus === "failed" || (report.learningStatus === "pending" && (report.learningStartedAt ?? 0) < stalePendingBefore)) && (!input.projectId || report.projectId === input.projectId))
    .toArray();
  const runIds = [...new Set(failedReports.map((report) => report.workflowRunId))];
  const candidates: CraftRuleCandidate[] = [];
  for (const workflowRunId of runIds) {
    const run = await db.workflowRuns.get(workflowRunId);
    if (!run) continue;
    candidates.push(...await createWorkflowLearningCandidates({ projectId: run.projectId, workflowRunId, db }));
  }
  return candidates;
}
