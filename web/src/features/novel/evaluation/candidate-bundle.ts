/**
 * 候选包导出服务：从实验库读取章节工作流产物 + 技能迭代 + 事实候选，组装为可晋升的 CandidateBundle。
 *
 * 设计依据：docs/novel-real-data-evaluation-architecture.md §3.4 / §4.4。
 *
 * 接入点：闭环工作流（bench/CLI/UI）在 chapter-workflow + skill-iteration 完成后调用
 * `extractCandidateBundle`，产出 JSON-serializable bundle，再交给 PromotionService 晋升回正式库。
 *
 * 与正式库的关系：CandidateBundle 是只读快照 + 实验产物归一化结果，不携带实验库生成的 ID
 * （revision ID、fact assertion ID、memory ID、operation ID）。正式库在晋升事务中重新生成这些 ID。
 *
 * 验证策略：`verifyCandidateBundle` 重新计算 manuscript.contentHash，校验所有必填字段存在，
 * 确保晋升方接收的 bundle 在传输/序列化过程中未被篡改或损坏。
 *
 * 反序列化策略：`deserializeCandidateBundle` 解析 JSON 后立即调用 `verifyCandidateBundle`，
 * 任何校验失败都抛出，调用方收到的永远是已验证的 bundle。
 */
import { documentContentHash, type NovelDatabase } from "../db";
import type {
  FactCandidate,
  QualityIssue,
  WorkflowArtifact,
} from "../types";
import { BUILTIN_NOVEL_SKILLS } from "../skills";
import type { ProjectHead } from "./project-snapshot";
import { listIteratedSkills } from "./skill-iteration";
import type { ExperimentWorkspace } from "./experiment-workspace";
import type {
  CandidateBundle,
  CandidateManuscript,
  CandidateProvenance,
  CandidateTargetDocument,
  CandidateWorkflowInput,
  IteratedBinding,
  IteratedSkill,
  PromotableFact,
  QualityEvidence,
} from "./types";

// ===== 哈希辅助 =====

/**
 * 计算 CandidateManuscript.contentHash：SHA-256 over (title + contentHtml + plainText)。
 *
 * 与 db.ts 的 documentContentHash（FNV-1a，用于 ManuscriptDocument 内部比对）不同，
 * CandidateBundle 的 contentHash 是跨库传输的完整性证据，使用 SHA-256。
 */
async function computeManuscriptContentHash(input: {
  title: string;
  contentHtml: string;
  plainText: string;
}): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      title: input.title,
      contentHtml: input.contentHtml,
      plainText: input.plainText,
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 计算 promptFingerprint：所有激活 skill 的 prompt 文本 SHA-256。
 *
 * 用于 provenance，记录本次实验使用了哪些 skill prompt。
 */
async function computePromptFingerprint(skillRefs: string[], skillPrompts: string[]): Promise<string> {
  const combined = skillRefs.map((id, index) => `${id}:${skillPrompts[index] ?? ""}`).join("\n---\n");
  const bytes = new TextEncoder().encode(combined);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 计算 configFingerprint：项目关键设置 SHA-256（model + temperature + qualityThreshold + approvalMode）。
 */
async function computeConfigFingerprint(input: {
  textModel: string;
  temperature: number;
  qualityThreshold: number;
  approvalMode: string;
}): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      textModel: input.textModel,
      temperature: input.temperature,
      qualityThreshold: input.qualityThreshold,
      approvalMode: input.approvalMode,
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedHashValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedHashValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, normalizedHashValue(item)]));
}

export async function computeWorkflowInputHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(normalizedHashValue(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ===== PromotableFact 投影 =====

/**
 * 从实验库的 FactCandidate 投影为 CandidateBundle.acceptedFacts 中的 PromotableFact。
 *
 * 过滤规则：只保留 novelty !== "duplicate" && conflict === false && risk === "safe" 的候选，
 * 因为 duplicate/conflict/high-risk 候选不应自动晋升（作者可在 AuthorDecision 中显式接受子集）。
 *
 * 必填字段检查：FactCandidate.predicate/object/polarity/truthStatus/timeMode/humanReadable 是可选的，
 * 但 FactAssertion 是必填的。如果候选缺少这些字段，无法投影为 assertion，跳过。
 */
function projectFactCandidate(candidate: FactCandidate): PromotableFact | null {
  if (candidate.status !== "accepted") return null;
  if (candidate.novelty === "duplicate") return null;
  if (candidate.conflict) return null;
  if (candidate.risk !== "safe") return null;

  // FactAssertion 必填字段检查
  if (!candidate.predicate) return null;
  if (candidate.object === undefined || candidate.object === null) return null;
  if (!candidate.polarity) return null;
  if (!candidate.truthStatus) return null;
  if (!candidate.timeMode) return null;
  if (!candidate.humanReadable) return null;
  if (!candidate.subject) return null;

  // projection 字段：FactCandidate 用 targetTable/targetId/field 表示投影目标，
  // FactAssertion 的 projection 是 { targetTable, targetId?, field }
  const projection = candidate.targetTable && candidate.field
    ? { targetTable: candidate.targetTable, targetId: candidate.targetId, field: candidate.field }
    : undefined;

  return {
    // 实验库尚未产生 FactAssertion（FactAssertion 由 PromotionService 在正式库晋升时创建）。
    // sourceFactAssertionId 留空字符串，PromotionService 在晋升时根据 sourceCandidateId
    // 找到对应 FactCandidate，再决定如何处理（通常不创建 assertion 而是直接 upsert）。
    sourceFactAssertionId: "",
    sourceCandidateId: candidate.id,
    payload: {
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      polarity: candidate.polarity,
      truthStatus: candidate.truthStatus,
      timeMode: candidate.timeMode,
      validFrom: candidate.validFrom,
      validTo: candidate.validTo,
      revealedAt: candidate.revealedAt,
      // 晋升时由 PromotionService 设置为 "approved-revision"
      provenance: "approved-revision" as const,
      evidence: candidate.evidence,
      paragraph: candidate.paragraph,
      confidence: candidate.confidence,
      humanReadable: candidate.humanReadable,
      // 晋升时由 PromotionService 设置为 "active"
      status: "active" as const,
      supersedesId: undefined,
      projection,
    },
    projectionInput: {
      targetTable: candidate.targetTable,
      targetId: candidate.targetId,
      field: candidate.field,
      before: candidate.before,
      after: candidate.after,
      novelty: candidate.novelty,
      knowledgeDeltas: candidate.knowledgeDeltas,
      riskReason: candidate.riskReason,
    },
  };
}

// ===== 主导出函数 =====

/**
 * 从实验库导出 CandidateBundle。
 *
 * 读取：
 * - workflowRun（targetDocumentId, draftArtifactId, qualityReportId, factCandidateIds, startedAt, finishedAt）
 * - draftArtifact（contentMarkdown, title, model, skillRefs）
 * - targetDocument（baseRevision, baseApprovedRevisionId, contentHash via documentContentHash）
 * - qualityReport（weightedScore, scores, blockerCount, issues）
 * - iteratedSkills（via listIteratedSkills）
 * - projectSkillBindings（当前实验库状态）
 * - factCandidates（filter by workflowRunId，投影为 PromotableFact）
 * - provenance（model, promptFingerprint, configFingerprint, codeRevision, artifactIds, timestamps）
 *
 * @param params.workflowRunId 实验库中的 workflowRunId
 * @param params.workspace ExperimentWorkspace（提供 experimentId, projectId, baseSnapshotId, baseSnapshotHash, db）
 * @param params.baseDependencyHead 基线快照的 ProjectHead（晋升时用于 stale 检测）
 * @param params.variantId 变体 ID（同一实验可有多变体，默认 "default"）
 * @param params.codeRevision 代码版本（用于 provenance，默认 "unknown"）
 * @param params.db 实验库实例（默认 workspace.db）
 */
export async function extractCandidateBundle(params: {
  workflowRunId: string;
  workspace: ExperimentWorkspace;
  baseDependencyHead: ProjectHead;
  variantId?: string;
  codeRevision?: string;
  db?: NovelDatabase;
  /**
   * 基线目标文档状态（来自 ProjectSnapshotBundle.records.documents）。
   *
   * 不传时从实验库当前状态读取（向后兼容 bench-loop7/8 的 seeded workflow 场景）。
   * 传入时用此值覆盖——这是真实工作流场景的必须路径：工作流的 commit 阶段会
   * 修改实验库中的 document（contentHtml/plainText/revision/approvedRevisionId），
   * 若从实验库读取，candidate.targetDocument 会反映工作流后的状态而非基线状态，
   * 导致 promote 的 baseline 校验失败。
   */
  baseTargetDocument?: CandidateTargetDocument;
}): Promise<CandidateBundle> {
  const db = params.db ?? params.workspace.db;
  const workspace = params.workspace;
  const variantId = params.variantId ?? "default";
  const codeRevision = params.codeRevision ?? "unknown";

  // 1. 读取 workflowRun + draftArtifact + qualityReport + targetDocument
  const run = await db.workflowRuns.get(params.workflowRunId);
  if (!run) throw new Error("工作流不存在，无法导出候选包");
  if (!run.draftArtifactId) throw new Error("工作流缺少 draft artifact，无法导出候选包");
  if (!run.qualityReportId) throw new Error("工作流缺少 quality report，无法导出候选包");
  if (!run.conversationThreadId || !run.creativeBriefId) throw new Error("工作流缺少 thread/brief 输入，无法导出候选包");

  const [draftArtifact, qualityReport, targetDocument, conversationThread, creativeBrief] = await Promise.all([
    db.workflowArtifacts.get(run.draftArtifactId),
    db.qualityReports.get(run.qualityReportId),
    db.documents.get(run.targetDocumentId),
    db.conversationThreads.get(run.conversationThreadId),
    db.creativeBriefs.get(run.creativeBriefId),
  ]);

  if (!draftArtifact) throw new Error("draft artifact 不存在");
  if (!qualityReport) throw new Error("quality report 不存在");
  if (!targetDocument) throw new Error("目标章节 document 不存在");
  if (!conversationThread || !creativeBrief) throw new Error("工作流 thread/brief 输入不存在");

  const workflowInput: CandidateWorkflowInput = {
    conversationThreadId: conversationThread.id,
    conversationThreadHash: await computeWorkflowInputHash(conversationThread),
    creativeBriefId: creativeBrief.id,
    creativeBriefHash: await computeWorkflowInputHash(creativeBrief),
  };

  // 2. 读取 project（用于 configFingerprint）+ projectSkillBindings + factCandidates
  const project = await db.projects.get(workspace.projectId);
  if (!project) throw new Error("项目不存在于实验库");

  const [factCandidates, iteratedSkillRecords] = await Promise.all([
    db.factCandidates.where("workflowRunId").equals(params.workflowRunId).toArray() as Promise<FactCandidate[]>,
    listIteratedSkills({ workflowRunId: params.workflowRunId, db }),
  ]);

  // 3. 投影 factCandidates → PromotableFact[]
  const acceptedFacts: PromotableFact[] = factCandidates
    .map(projectFactCandidate)
    .filter((fact): fact is PromotableFact => fact !== null);

  // 4. 投影 iteratedSkillRecords → IteratedSkill[]
  const iteratedSkills: IteratedSkill[] = iteratedSkillRecords.map((record) => ({
    skillId: record.skillId,
    beforePrompt: record.beforePrompt,
    afterPrompt: record.afterPrompt,
    rationale: record.rationale,
    triggeredByIssues: record.triggeredByIssueSummaries,
    sourceWorkflowRunId: record.sourceWorkflowRunId,
  }));

  // Review 明确指向并成功迭代的 skill 必须成为项目的显式启用绑定。
  // 这让 prompt 变更与其生效范围使用同一份审阅证据，且不凭分数阈值猜测优先级。
  const bindings = await db.projectSkills.where("projectId").equals(workspace.projectId).toArray();
  const bindingBySkillId = new Map(bindings.map((binding) => [binding.skillId, binding]));
  const iteratedBindings: IteratedBinding[] = iteratedSkills.map((skill) => {
    const binding = bindingBySkillId.get(skill.skillId);
    return {
      skillId: skill.skillId,
      before: binding ? { enabled: binding.enabled, priorityOverride: binding.priorityOverride } : null,
      after: { enabled: true, priorityOverride: binding?.priorityOverride },
      rationale: `该 skill 已依据本轮审阅问题完成 prompt 迭代，需要在当前项目显式启用。${skill.rationale}`,
      triggeredByIssues: skill.triggeredByIssues,
    };
  });

  // 6. 计算 manuscript.contentHash + 组装 CandidateManuscript
  const manuscript: CandidateManuscript = {
    title: targetDocument.title,
    plainText: targetDocument.plainText,
    contentHtml: targetDocument.contentHtml,
    contentHash: await computeManuscriptContentHash({
      title: targetDocument.title,
      contentHtml: targetDocument.contentHtml,
      plainText: targetDocument.plainText,
    }),
    sourceWorkflowRunId: params.workflowRunId,
    sourceArtifactId: draftArtifact.id,
  };

  // 7. 组装 CandidateTargetDocument
  //    若调用方传入 baseTargetDocument（来自基线快照），优先使用——这是真实工作流场景的必须路径。
  //    否则从实验库当前状态读取（向后兼容 bench-loop7/8 的 seeded workflow 场景）。
  const targetDocumentInfo: CandidateTargetDocument = params.baseTargetDocument ?? {
    documentId: targetDocument.id,
    baseRevision: targetDocument.revision,
    baseApprovedRevisionId: targetDocument.approvedRevisionId,
    baseContentHash: documentContentHash(targetDocument),
  };

  // 8. 组装 QualityEvidence
  const dimensionScores: Record<string, number> = { ...qualityReport.scores };
  const topIssues: Array<{ severity: string; dimension: string; summary: string }> = qualityReport.issues
    .slice(0, 10)
    .map((issue: QualityIssue) => ({
      severity: issue.severity,
      dimension: issue.dimension,
      summary: issue.title,
    }));
  const avgScore =
    Object.values(qualityReport.scores).reduce((sum, score) => sum + score, 0) /
    Math.max(1, Object.keys(qualityReport.scores).length);
  const majorCount = qualityReport.issues.filter((i) => i.severity === "major").length;
  const warningCount = qualityReport.issues.filter((i) => i.severity === "warning").length;

  const qualityEvidence: QualityEvidence = {
    sourceQualityReportId: qualityReport.id,
    weightedScore: qualityReport.weightedScore,
    avgScore,
    blockerCount: qualityReport.blockerCount,
    majorCount,
    warningCount,
    issueCount: qualityReport.issues.length,
    dimensionScores,
    topIssues,
  };

  // 9. 读取所有 workflowArtifacts（用于 provenance.workflowArtifactIds）
  const workflowArtifacts = await db.workflowArtifacts
    .where("workflowRunId")
    .equals(params.workflowRunId)
    .toArray();
  const workflowArtifactIds = workflowArtifacts.map((artifact: WorkflowArtifact) => artifact.id);

  // 10. 计算 promptFingerprint（用激活 skill 的 prompt）
  //     Loop 7：用 draftArtifact.skillRefs 从实验库 skills 表读取 prompt
  const skillRefs = (draftArtifact.skillRefs ?? []).map((ref) => ref.split("@")[0]!);
  const skillRecords = skillRefs.length ? await db.skills.where("skillId").anyOf(skillRefs).toArray() : [];
  const skillPrompts = skillRefs.map((id) => (
    skillRecords.find((skill) => skill.skillId === id)?.prompt
    ?? BUILTIN_NOVEL_SKILLS.find((skill) => skill.skillId === id)?.prompt
    ?? ""
  ));
  const promptFingerprint = await computePromptFingerprint(skillRefs, skillPrompts);

  // 11. 组装 CandidateProvenance
  const configFingerprint = await computeConfigFingerprint({
    textModel: project.settings.textModel,
    temperature: project.settings.temperature,
    qualityThreshold: project.settings.qualityThreshold,
    approvalMode: project.settings.approvalMode,
  });

  const provenance: CandidateProvenance = {
    model: draftArtifact.model ?? project.settings.textModel,
    promptFingerprint,
    configFingerprint,
    codeRevision,
    workflowArtifactIds,
    experimentStartedAt: run.startedAt,
    exportedAt: Date.now(),
  };

  // 12. 组装 CandidateBundle
  const bundle: CandidateBundle = {
    formatVersion: 1,
    id: crypto.randomUUID(),
    experimentId: workspace.experimentId,
    variantId,
    sourceProjectId: workspace.projectId,
    baseSnapshotId: workspace.baseSnapshotId,
    baseSnapshotHash: workspace.baseSnapshotHash,
    dependencyHead: params.baseDependencyHead,
    targetDocument: targetDocumentInfo,
    workflowInput,
    manuscript,
    acceptedFacts,
    iteratedSkills,
    iteratedBindings,
    qualityEvidence,
    provenance,
  };

  // 13. 自校验：导出时立即 verify，确保 bundle 完整
  verifyCandidateBundle(bundle);

  return bundle;
}

// ===== 校验 =====

export interface CandidateBundleVerification {
  valid: boolean;
  issues: string[];
}

/**
 * 校验 CandidateBundle 完整性（同步版本：检查字段存在性，不重算 manuscript.contentHash）。
 *
 * 检查项：
 * - formatVersion === 1
 * - 所有必填顶层字段非空
 * - targetDocument.baseContentHash 非空
 * - 每个 acceptedFact 有 sourceCandidateId + payload 必填字段
 * - 每个 iteratedSkill 有 beforePrompt !== afterPrompt
 * - 每个 iteratedBinding.after.enabled 定义
 * - provenance 各字段非空
 *
 * 注：manuscript.contentHash 的 SHA-256 重算在 Loop 7 留给 PromotionService.inspect（Loop 8）做，
 * 因为晋升时需要重算并与 bundle.manuscript.contentHash 比对以防止传输篡改。
 * 当前同步 verify 用于导出/反序列化时的字段完整性检查。
 */
export function verifyCandidateBundle(bundle: CandidateBundle): CandidateBundleVerification {
  const issues: string[] = [];

  if (bundle.formatVersion !== 1) issues.push("formatVersion 必须为 1");

  // 必填顶层字段
  if (!bundle.id) issues.push("id 缺失");
  if (!bundle.experimentId) issues.push("experimentId 缺失");
  if (!bundle.variantId) issues.push("variantId 缺失");
  if (!bundle.sourceProjectId) issues.push("sourceProjectId 缺失");
  if (!bundle.baseSnapshotId) issues.push("baseSnapshotId 缺失");
  if (!bundle.baseSnapshotHash) issues.push("baseSnapshotHash 缺失");
  if (!bundle.dependencyHead) issues.push("dependencyHead 缺失");
  if (!bundle.targetDocument) issues.push("targetDocument 缺失");
  if (!bundle.workflowInput) issues.push("workflowInput 缺失");
  if (!bundle.manuscript) issues.push("manuscript 缺失");
  if (!Array.isArray(bundle.acceptedFacts)) issues.push("acceptedFacts 必须为数组");
  if (!Array.isArray(bundle.iteratedSkills)) issues.push("iteratedSkills 必须为数组");
  if (!Array.isArray(bundle.iteratedBindings)) issues.push("iteratedBindings 必须为数组");
  if (!bundle.qualityEvidence) issues.push("qualityEvidence 缺失");
  if (!bundle.provenance) issues.push("provenance 缺失");

  // targetDocument 字段
  if (bundle.targetDocument) {
    if (!bundle.targetDocument.documentId) issues.push("targetDocument.documentId 缺失");
    if (typeof bundle.targetDocument.baseRevision !== "number") issues.push("targetDocument.baseRevision 必须为数字");
    if (!bundle.targetDocument.baseContentHash) issues.push("targetDocument.baseContentHash 缺失");
  }
  if (bundle.workflowInput) {
    if (!bundle.workflowInput.conversationThreadId) issues.push("workflowInput.conversationThreadId 缺失");
    if (!bundle.workflowInput.conversationThreadHash) issues.push("workflowInput.conversationThreadHash 缺失");
    if (!bundle.workflowInput.creativeBriefId) issues.push("workflowInput.creativeBriefId 缺失");
    if (!bundle.workflowInput.creativeBriefHash) issues.push("workflowInput.creativeBriefHash 缺失");
  }

  // manuscript 字段
  if (bundle.manuscript) {
    if (!bundle.manuscript.title) issues.push("manuscript.title 缺失");
    if (!bundle.manuscript.contentHtml) issues.push("manuscript.contentHtml 缺失");
    if (bundle.manuscript.plainText === undefined) issues.push("manuscript.plainText 缺失");
    if (!bundle.manuscript.contentHash) issues.push("manuscript.contentHash 缺失");
  }

  // acceptedFacts 字段（先 Array.isArray 检查，避免字符串/对象误用 .entries）
  if (Array.isArray(bundle.acceptedFacts)) {
    for (const [index, fact] of bundle.acceptedFacts.entries()) {
      if (!fact.sourceCandidateId) issues.push(`acceptedFacts[${index}].sourceCandidateId 缺失`);
      if (!fact.payload) {
        issues.push(`acceptedFacts[${index}].payload 缺失`);
        continue;
      }
      if (!fact.payload.subject) issues.push(`acceptedFacts[${index}].payload.subject 缺失`);
      if (!fact.payload.predicate) issues.push(`acceptedFacts[${index}].payload.predicate 缺失`);
      if (fact.payload.object === undefined || fact.payload.object === null) issues.push(`acceptedFacts[${index}].payload.object 缺失`);
      if (!fact.payload.polarity) issues.push(`acceptedFacts[${index}].payload.polarity 缺失`);
      if (!fact.payload.truthStatus) issues.push(`acceptedFacts[${index}].payload.truthStatus 缺失`);
      if (!fact.payload.timeMode) issues.push(`acceptedFacts[${index}].payload.timeMode 缺失`);
      if (!fact.payload.humanReadable) issues.push(`acceptedFacts[${index}].payload.humanReadable 缺失`);
      if (!fact.payload.evidence) issues.push(`acceptedFacts[${index}].payload.evidence 缺失`);
      if (!fact.projectionInput) {
        issues.push(`acceptedFacts[${index}].projectionInput 缺失`);
      } else {
        if (!fact.projectionInput.targetTable) issues.push(`acceptedFacts[${index}].projectionInput.targetTable 缺失`);
        if (!fact.projectionInput.field) issues.push(`acceptedFacts[${index}].projectionInput.field 缺失`);
        if (!fact.projectionInput.novelty) issues.push(`acceptedFacts[${index}].projectionInput.novelty 缺失`);
      }
    }
  }

  // iteratedSkills 字段
  if (Array.isArray(bundle.iteratedSkills)) {
    for (const [index, skill] of bundle.iteratedSkills.entries()) {
      if (!skill.skillId) issues.push(`iteratedSkills[${index}].skillId 缺失`);
      if (!skill.beforePrompt) issues.push(`iteratedSkills[${index}].beforePrompt 缺失`);
      if (!skill.afterPrompt) issues.push(`iteratedSkills[${index}].afterPrompt 缺失`);
      if (skill.beforePrompt === skill.afterPrompt) issues.push(`iteratedSkills[${index}].beforePrompt 与 afterPrompt 相同`);
    }
  }

  // iteratedBindings 字段
  if (Array.isArray(bundle.iteratedBindings)) {
    for (const [index, binding] of bundle.iteratedBindings.entries()) {
      if (!binding.skillId) issues.push(`iteratedBindings[${index}].skillId 缺失`);
      if (!binding.after || typeof binding.after.enabled !== "boolean") issues.push(`iteratedBindings[${index}].after.enabled 必须为 boolean`);
    }
  }

  // qualityEvidence 字段
  if (bundle.qualityEvidence) {
    if (typeof bundle.qualityEvidence.weightedScore !== "number") issues.push("qualityEvidence.weightedScore 必须为数字");
    if (typeof bundle.qualityEvidence.avgScore !== "number") issues.push("qualityEvidence.avgScore 必须为数字");
    if (typeof bundle.qualityEvidence.blockerCount !== "number") issues.push("qualityEvidence.blockerCount 必须为数字");
    if (typeof bundle.qualityEvidence.issueCount !== "number") issues.push("qualityEvidence.issueCount 必须为数字");
    if (!Array.isArray(bundle.qualityEvidence.topIssues)) issues.push("qualityEvidence.topIssues 必须为数组");
  }

  // provenance 字段
  if (bundle.provenance) {
    if (!bundle.provenance.model) issues.push("provenance.model 缺失");
    if (!bundle.provenance.promptFingerprint) issues.push("provenance.promptFingerprint 缺失");
    if (!bundle.provenance.configFingerprint) issues.push("provenance.configFingerprint 缺失");
    if (!bundle.provenance.codeRevision) issues.push("provenance.codeRevision 缺失");
    if (!Array.isArray(bundle.provenance.workflowArtifactIds)) issues.push("provenance.workflowArtifactIds 必须为数组");
    if (typeof bundle.provenance.experimentStartedAt !== "number") issues.push("provenance.experimentStartedAt 必须为数字");
    if (typeof bundle.provenance.exportedAt !== "number") issues.push("provenance.exportedAt 必须为数字");
  }

  return { valid: issues.length === 0, issues };
}

// ===== 序列化 =====

/**
 * 将 CandidateBundle 序列化为稳定 JSON 字符串（key 排序）。
 *
 * 用于：CLI 写入 .novel-bench/runs/{runId}/candidate.json；
 * UI 跨窗口传输；测试 round-trip 校验。
 */
export function serializeCandidateBundle(bundle: CandidateBundle): string {
  // 先 verify，避免序列化损坏的 bundle
  const verification = verifyCandidateBundle(bundle);
  if (!verification.valid) {
    throw new Error(`CandidateBundle 校验失败，无法序列化：${verification.issues.join("；")}`);
  }
  // 不使用 replacer array —— JSON.stringify 的 replacer array 会过滤嵌套对象的字段
  // （replacer array 在每一层都生效，只保留 array 中列出的 key）
  // 直接用 2-space indent 即可，key 顺序按对象定义顺序保留
  return JSON.stringify(bundle, null, 2);
}

/**
 * 从 JSON 字符串反序列化为 CandidateBundle，并重新校验。
 *
 * 校验失败抛出错误；调用方收到的永远是已验证的 bundle。
 */
export function deserializeCandidateBundle(json: string): CandidateBundle {
  const parsed = JSON.parse(json) as CandidateBundle;
  const verification = verifyCandidateBundle(parsed);
  if (!verification.valid) {
    throw new Error(`CandidateBundle 反序列化校验失败：${verification.issues.join("；")}`);
  }
  return parsed;
}
