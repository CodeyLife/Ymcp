/**
 * V2 闭环编排器：把 snapshot → experiment → skill-iteration → candidate → promote
 * 串联为单一调用。
 *
 * 设计依据：AGENTS.md + Phase B-1.3 重构计划。
 *
 * 步骤：
 * 1. captureProjectSnapshot → snapshot
 * 2. computeProjectHead → dependencyHead
 * 3. createExperimentWorkspace → workspace
 * 4. 在 schema-bound repository 中执行共享章节生命周期，得到真实 reviewer/learning 证据
 * 5. 迭代实验 skill，并在同一失败场景上重跑
 * 6. 仅当阻断模式消失、分数不回退且工作流真实提交时提取候选
 * 7. 晋升后从正式库重新捕获快照并再次重跑；失败则自动 rollback
 * 8. 关闭实验工作区，保留审计数据
 */
import { randomUUID } from "node:crypto";
import type {
  AuthorDecision,
  CandidateBundle,
  IteratedSkill,
  PromotionReceipt,
} from "../protocol";
import type { ModelGateway } from "../model-gateway";
import type { NovelPostgresRepository } from "../postgres-repository";
import { captureProjectSnapshot, computeProjectHead } from "./project-snapshot";
import { createExperimentWorkspace } from "./experiment-workspace";
import { extractCandidateBundle } from "./candidate-bundle";
import { runSkillIteration } from "./skill-iteration";
import { createPromotionService } from "./promotion";
import { executeChapterReviewExperiment, type ExperimentExecutionResult } from "./experiment-execution";

// ===== 类型 =====

export interface ClosedLoopOptions {
  repository: NovelPostgresRepository;
  model: ModelGateway;
  projectId: string;
  documentId: string;
  instruction?: string;
  experimentId?: string;
  codeRevision?: string;
  authorId?: string;
  dryRun?: boolean;
}

export interface ClosedLoopResult {
  experimentId: string;
  snapshotId: string;
  workflowRunId?: string;
  candidateBundle?: CandidateBundle;
  promotionReceipt?: PromotionReceipt;
  iteratedSkills: IteratedSkill[];
  /**
   * P1-F3: 回归验证状态。
   * - skipped: dryRun=true，未触发 promote，无需回归验证
   * - passed: 调用方提供了 regressionEvidence.passed=true，promote 已执行
   * - failed: 调用方提供了 regressionEvidence.passed=false，promote 被拒绝
   * - missing: dryRun=false 但未提供 regressionEvidence，promote 被拒绝（违反 AGENTS.md 契约）
   */
  regressionStatus?: "skipped" | "passed" | "failed" | "missing";
}

// ===== 辅助 =====

/**
 * 构造作者审批决策：默认接受候选。
 *
 * AGENTS.md 契约：promote 后必须做回归验证。调用方收到 receipt 后，
 * 用新 skill 版本重跑失败场景，验证 issue 不再复现。
 */
function buildAuthorDecision(authorId: string, candidate: CandidateBundle): AuthorDecision {
  return {
    authorId,
    decision: "accept",
    reason: `闭环自动审批：candidate=${candidate.id}，包含 ${candidate.iteratedSkills.length} 条 skill 迭代`,
    decidedAt: Date.now(),
  };
}

function blockingPatterns(result: ExperimentExecutionResult): Set<string> {
  return new Set(result.reviews.flatMap((review) => review.issues)
    .filter((issue) => issue.severity === "blocker" || issue.severity === "major")
    .map((issue) => `${issue.dimension ?? "unknown"}:${issue.rule ?? issue.title}`));
}

function regressionPassed(before: ExperimentExecutionResult, after: ExperimentExecutionResult): boolean {
  const beforePatterns = blockingPatterns(before);
  const afterPatterns = blockingPatterns(after);
  const unresolved = [...beforePatterns].filter((pattern) => afterPatterns.has(pattern));
  const structureImprovedOrHeld = after.structuralReport.passed
    && after.structuralReport.blockers.length <= before.structuralReport.blockers.length;
  return structureImprovedOrHeld && unresolved.length === 0 && after.finalScore >= before.finalScore;
}

// ===== 主入口 =====

/**
 * 执行一次完整的内容闭环评估。
 *
 * 步骤见文件头注释；回归验证由本编排器内置执行。
 *
 * @throws 若任一步骤抛错（promote 失败返回 failed receipt 不抛错）
 */
export async function runClosedLoop(options: ClosedLoopOptions): Promise<ClosedLoopResult> {
  const {
    repository,
    model,
    projectId,
    documentId,
    codeRevision,
    authorId = "closed-loop-v2",
    dryRun = false,
  } = options;

  const experimentId = options.experimentId ?? `exp-${Date.now()}-${randomUUID().slice(0, 8)}`;

  // 1. 捕获项目快照
  const snapshot = await captureProjectSnapshot(repository, projectId);
  const baseDocument = snapshot.payload.documents.find((document) => document.id === documentId);
  if (!baseDocument) throw new Error(`目标章节不存在于项目快照：${documentId}`);
  const baseRevisionRecord = snapshot.payload.revisions.find((revision) => revision.id === baseDocument.currentRevisionId);
  if (!baseRevisionRecord) throw new Error(`目标章节缺少快照基线 revision：${documentId}`);

  // 2. 计算依赖头
  const dependencyHead = await computeProjectHead(repository, projectId);

  // 3. 创建实验工作区
  const workspace = await createExperimentWorkspace(repository, snapshot, experimentId);

  let candidateBundle: CandidateBundle | undefined;
  let promotionReceipt: PromotionReceipt | undefined;
  let iteratedSkills: IteratedSkill[] = [];
  let workflowRunId: string | undefined;
  let regressionStatus: ClosedLoopResult["regressionStatus"];

  try {
    // 4. 在 schema-bound repository 中执行正式章节生命周期。
    const baseline = await executeChapterReviewExperiment({ workspace, model, projectId, documentId, instruction: options.instruction });
    workflowRunId = baseline.workflowRunId;

    iteratedSkills = await runSkillIteration({
      workspace,
      repository,
      reviews: baseline.reviews,
      learningAssessment: baseline.learningAssessment,
      model,
    });

    // A propose-improvement assessment is an obligation, not an optional hint.
    // Do not silently convert an unavailable model/external-MCP path into a
    // skipped regression; that would make promotion evidence incomplete.
    const hasBlockingBaseline = baseline.reviews.some((review) => review.issues.some((issue) => issue.severity === "blocker" || issue.severity === "major"));
    if (baseline.learningAssessment?.conclusion === "propose-improvement" && hasBlockingBaseline && iteratedSkills.length === 0) {
      throw new Error("learning 已要求 propose-improvement，但未生成任何技能迭代；回归验证不得跳过");
    }

    // 5.1 用实验 schema 内的新 skill 版本重跑原失败场景。
    const experimentalRegression = iteratedSkills.length
      ? await executeChapterReviewExperiment({ workspace, model, projectId, documentId, instruction: options.instruction })
      : baseline;
    const experimentPassed = iteratedSkills.length > 0
      && experimentalRegression.committed
      && regressionPassed(baseline, experimentalRegression);

    // 6. 提取候选包
    if (experimentPassed) {
      candidateBundle = await extractCandidateBundle(workspace, {
        sourceProjectId: projectId,
        baseSnapshotId: snapshot.id,
        baseSnapshotHash: snapshot.hash,
        dependencyHead,
        documentId,
        baseRevision: baseRevisionRecord.revision,
        baseContentHash: baseRevisionRecord.contentHash,
        workflowRunId: experimentalRegression.workflowRunId,
        codeRevision,
        baselineMemoryClaimIds: snapshot.payload.memoryClaims.map((claim) => claim.id),
      });
    }

    // 7. 若非 dryRun，只有真实实验回归通过才执行 promote。
    if (!dryRun && candidateBundle) {
      if (!experimentPassed) {
        regressionStatus = "failed";
      } else {
        const service = createPromotionService(repository);
        const decision = buildAuthorDecision(authorId, candidateBundle);
        promotionReceipt = await service.promote(candidateBundle, decision);
        if (promotionReceipt.status !== "promoted") {
          regressionStatus = "failed";
        } else {
          // Promote 后从正式状态重新捕获快照，证明正式库中的新版本可重跑。
          const promotedSnapshot = await captureProjectSnapshot(repository, projectId);
          const verificationWorkspace = await createExperimentWorkspace(repository, promotedSnapshot, `${experimentId}-post-promote`);
          try {
            const postPromote = await executeChapterReviewExperiment({ workspace: verificationWorkspace, model, projectId, documentId, instruction: options.instruction });
            if (!regressionPassed(baseline, postPromote)) {
              await service.rollback(promotionReceipt.id);
              promotionReceipt = await service.getReceipt(candidateBundle.id) ?? promotionReceipt;
              regressionStatus = "failed";
            } else {
              regressionStatus = "passed";
            }
          } finally {
            await verificationWorkspace.close();
          }
        }
      }
    } else {
      regressionStatus = "skipped";
    }
  } finally {
    // 8. 关闭实验工作区（保留数据供审计；若需删除，调用方显式调 workspace.delete()）
    try {
      await workspace.close();
    } catch {
      // 忽略关闭失败，不影响主流程结果
    }
  }

  return {
    experimentId,
    snapshotId: snapshot.id,
    workflowRunId,
    candidateBundle,
    promotionReceipt,
    iteratedSkills,
    regressionStatus,
  };
}
