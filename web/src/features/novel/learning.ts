import { parseRuntimeLearningAssessment } from "../../novel-runtime/contracts";
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

export async function createWorkflowLearningCandidates(input: {
  projectId: string;
  workflowRunId: string;
  db?: NovelDatabase;
}): Promise<CraftRuleCandidate[]> {
  const db = input.db ?? novelDb;
  let reports = await db.qualityReports.where("workflowRunId").equals(input.workflowRunId).sortBy("iteration");
  const run = await db.workflowRuns.get(input.workflowRunId);
  if (!run) throw new Error("工作流不存在，无法沉淀审校经验");
  for (const report of reports.filter((item) => item.learningStatus === "failed")) {
    const draft = await db.workflowArtifacts.get(report.artifactId);
    try {
      report.learning = await assessQualityReportLearning({ projectId: input.projectId, workflowRunId: input.workflowRunId, report, draftExcerpt: draft?.contentMarkdown ?? "", db });
      report.learningReplay = report.learning.conclusion === "propose-improvement"
        ? await captureChapterRuleReplay({ projectId: input.projectId, documentId: run.targetDocumentId, instruction: await getWorkflowReplayInstruction(run.id, db), scenarioClass: "正式章节审校失败场景" }, db)
        : undefined;
      report.learningStatus = "completed";
      report.learningError = undefined;
    } catch (error) {
      report.learningStatus = "failed";
      report.learningError = error instanceof Error ? error.message : "审校经验评估失败";
    }
    report.updatedAt = Date.now();
    report.revision += 1;
    await db.qualityReports.put(report);
  }
  reports = await db.qualityReports.where("workflowRunId").equals(input.workflowRunId).sortBy("iteration");
  const proposals = reports.filter((report): report is QualityReport & { learning: Extract<LearningAssessment, { conclusion: "propose-improvement" }> } => report.learning?.conclusion === "propose-improvement");
  const latestByMechanism = new Map<string, typeof proposals[number]>();
  for (const report of proposals) {
    const learning = report.learning;
    latestByMechanism.set(`${learning.proposal.targetKind}:${learning.proposal.targetId}:${learning.underlyingMechanism}:${learning.affectedInputClass}`, report);
  }
  const candidates: CraftRuleCandidate[] = [];
  for (const report of latestByMechanism.values()) {
    const learning = report.learning;
    try {
      if (!report.learningReplay) throw new Error("审校经验缺少冻结失败场景，不能创建规则候选");
      const sourceFingerprint = await fingerprint({ workflowRunId: input.workflowRunId, targetKind: learning.proposal.targetKind, targetId: learning.proposal.targetId, targetVersion: learning.proposal.targetVersion, targetContentFingerprint: learning.proposal.targetContentFingerprint, underlyingMechanism: learning.underlyingMechanism, affectedInputClass: learning.affectedInputClass });
      const candidate = await createCraftRuleCandidateFromLearning({
        projectId: input.projectId,
        learning,
        source: {
          kind: "chapter-review",
          fingerprint: sourceFingerprint,
          workflowRunId: input.workflowRunId,
          qualityReportId: report.id,
          issueIds: report.issues.map((issue) => issue.id),
          autoPromote: false,
          replay: report.learningReplay,
        },
      }, db);
      if (candidate) candidates.push(candidate);
    } catch (error) {
      report.learningStatus = "failed";
      report.learningError = error instanceof Error ? error.message : "审校经验候选创建失败";
      report.updatedAt = Date.now();
      report.revision += 1;
      await db.qualityReports.put(report);
    }
  }
  return candidates;
}

export async function retryFailedWorkflowLearning(input: { projectId?: string; db?: NovelDatabase } = {}): Promise<CraftRuleCandidate[]> {
  const db = input.db ?? novelDb;
  const failedReports = await db.qualityReports
    .filter((report) => report.learningStatus === "failed" && (!input.projectId || report.projectId === input.projectId))
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
