/**
 * 闭环编排服务：把 capture → load → workflow → skill-iterate → export → inspect → promote
 * 串联为单一调用，供 CLI（scripts/novel-bench/run-closed-loop.mjs）与 UI 共享同一编排逻辑。
 *
 * 设计依据：docs/novel-real-data-evaluation-architecture.md §3.4 / §4.4 / §5.3
 * + goal novel-eval-loop Loop 9 (CLI trigger)。
 *
 * 与实验库的关系：本模块负责实验工作区的生命周期（创建 → 使用 → 删除）。
 * 调用方只需提供 canonicalDb + 目标章节/对话/brief 标识，本模块在内部完成快照注入、
 * 工作流执行、技能迭代、候选导出、晋升回写。
 *
 * 与 LLM 的关系：本模块不感知 LLM mock/real——startChapterWorkflow 内部直接调用
 * ai.ts 的 LLM 函数。测试时通过 vitest 的 vi.mock 替换 ai 模块；CLI 运行时使用真实 LLM
 * （需要配置 API key）。dryRun 仅跳过 promote 步骤，不跳过 LLM 调用。
 *
 * 与 thread/brief 的关系：PROJECT_SNAPSHOT_TABLES 不含 conversationThreads 与 creativeBriefs，
 * 因为这两张表属于"对话层"而非"地基层"。本模块在加载快照后，从正式库读取 thread + brief
 * 记录，显式 seed 到实验库，使 startChapterWorkflow 能在实验库上找到它们。
 */
import { documentContentHash, type NovelDatabase } from "../db";
import type { CreativeBrief, ManuscriptDocument, NovelConversationThread } from "../types";
import { captureProjectSnapshot, type ProjectSnapshotBundle } from "./project-snapshot";
import {
  loadProjectSnapshotIntoExperiment,
  type ExperimentWorkspace,
} from "./experiment-workspace";
import { approveWorkflowStage, startChapterWorkflow } from "../workflow";
import { bulkSetFactCandidateStatus } from "../facts";
import { runSkillIteration } from "./skill-iteration";
import { extractCandidateBundle } from "./candidate-bundle";
import { createPromotionService } from "./promotion";
import type {
  AuthorDecision,
  CandidateBundle,
  CandidateTargetDocument,
  IteratedBinding,
  IteratedSkill,
  PromotableFact,
  PromotionCheck,
  PromotionReceipt,
} from "./types";

// ===== 选项与结果 =====

export interface ClosedLoopOptions {
  /** 正式库实例（CLI 传入全局 novelDb；UI 传入当前项目库；测试传入 fake-indexeddb 实例） */
  canonicalDb: NovelDatabase;
  /** 目标项目 ID */
  projectId: string;
  /** 目标章节 document ID（必须已在正式库中存在且为 draft 状态） */
  chapterId: string;
  /** 章节协作对话 thread ID（必须已在正式库中存在） */
  threadId: string;
  /** 章节创作 brief ID（必须已在正式库中存在且 status=confirmed） */
  briefId: string;
  /** 工作流指令（透传给 startChapterWorkflow.instruction） */
  instruction?: string;
  /** 实验标识符；不传时自动生成 `closed-loop-<timestamp>-<random>` */
  experimentId?: string;
  /** 代码版本号，写入 candidate.provenance.codeRevision；默认 "unknown" */
  codeRevision?: string;
  /** 作者 ID，写入 AuthorDecision.authorId；默认 "closed-loop-cli" */
  authorId?: string;
  /** 若为 true，仅执行 inspect 不执行 promote；默认 false */
  dryRun?: boolean;
}

export interface ClosedLoopResult {
  /** 实际使用的实验 ID */
  experimentId: string;
  /** 实验工作区（已 delete，仅供诊断字段读取） */
  experimentWorkspace: ExperimentWorkspace;
  /** 实验期间生成的候选包 */
  candidate: CandidateBundle;
  /** inspect 检查结果（含 recomputedDependencyHead + baselineMatches） */
  check: PromotionCheck;
  /** 晋升 receipt（dryRun=true 时为 undefined） */
  receipt?: PromotionReceipt;
  /** 实验开始前的正式库快照 hash */
  canonicalHashBefore: string;
  /** 实验结束后的正式库快照 hash（dryRun=true 时等于 canonicalHashBefore） */
  canonicalHashAfter: string;
  /** 实验期间产生的 workflowRunId */
  workflowRunId: string;
  /** 基线快照 bundle（用于审计） */
  baseSnapshot: ProjectSnapshotBundle;
}

export interface PromoteClosedLoopCandidateResult {
  check: PromotionCheck;
  receipt: PromotionReceipt;
  canonicalHashAfter: string;
}

// ===== 主入口 =====

/**
 * 执行一次完整的闭环评估：capture → load → workflow → skill-iterate → export → inspect → promote。
 *
 * 步骤：
 * 1. 捕获正式库基线快照 + hash（用于事后比对）
 * 2. 从正式库读取 thread + brief（PROJECT_SNAPSHOT_TABLES 不含这两张表）
 * 3. 加载快照到实验库
 * 4. 在实验库 seed thread + brief
 * 5. startChapterWorkflow(blocking=true) → blueprint-approval 暂停
 * 6. approveWorkflowStage(approved=true) → 推过 blueprint-approval
 * 7. approveWorkflowStage(approved=true) → 推过 manuscript-approval → completed
 * 8. runSkillIteration → 在实验库写入 IteratedSkillRecord[]
 * 9. extractCandidateBundle → 产出 CandidateBundle
 * 10. createPromotionService.inspect(candidate) → 检查基线/完整性
 * 11. 若 dryRun：跳过 promote；否则 promote(candidate, decision) → receipt
 * 12. finally：删除实验库（即使失败也要清理）
 *
 * @throws 若任一步骤抛错（除 promote 返回 rejected receipt 外）
 */
export async function runClosedLoop(options: ClosedLoopOptions): Promise<ClosedLoopResult> {
  const {
    canonicalDb,
    projectId,
    chapterId,
    threadId,
    briefId,
    instruction,
    codeRevision = "unknown",
    authorId = "closed-loop-cli",
    dryRun = false,
  } = options;

  const experimentId = options.experimentId ?? `closed-loop-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  // 1. 捕获正式库基线快照（同时得到 hash + bundle）
  const baseSnapshot = await captureProjectSnapshot(canonicalDb, projectId, "manual");
  const canonicalHashBefore = baseSnapshot.manifest.snapshotHash;

  // 2. 从正式库读取 thread + brief
  const [thread, brief] = await Promise.all([
    canonicalDb.conversationThreads.get(threadId),
    canonicalDb.creativeBriefs.get(briefId),
  ]);
  if (!thread) throw new Error(`thread 不存在于正式库：${threadId}`);
  if (!brief) throw new Error(`brief 不存在于正式库：${briefId}`);
  if (brief.status !== "confirmed") {
    throw new Error(`brief 状态必须为 confirmed，当前：${brief.status}`);
  }

  // 3. 加载快照到实验库
  const loaded = await loadProjectSnapshotIntoExperiment(baseSnapshot, experimentId);
  const workspace = loaded.workspace;

  try {
    // 4. 在实验库 seed thread + brief（PROJECT_SNAPSHOT_TABLES 不含这两张表）
    await workspace.db.conversationThreads.put(thread);
    await workspace.db.creativeBriefs.put(brief);

    // 5. 启动章节工作流（context → blueprint → blueprint-approval 暂停）
    const run = await startChapterWorkflow(
      {
        projectId,
        documentId: chapterId,
        threadId,
        briefId,
        instruction: instruction ?? brief.goal,
        blocking: true,
      },
      workspace.db,
    );
    if (run.status !== "waiting-approval" || run.currentStage !== "blueprint-approval") {
      throw new Error(
        `工作流启动后预期停在 blueprint-approval，实际 status=${run.status} stage=${run.currentStage}`,
      );
    }

    // 6. 推过 blueprint-approval
    await approveWorkflowStage(run.id, { approved: true }, workspace.db);

    // 7. 推过 manuscript-approval；若事实阶段留下高风险待决项，自动闭环明确拒绝
    //    这些未获作者批准的事实，再继续 commit。安全事实已由规则自动接受，不受影响。
    let advancedRun = await approveWorkflowStage(run.id, { approved: true }, workspace.db);
    if (advancedRun.status === "waiting-approval" && advancedRun.currentStage === "fact-approval") {
      const pendingFactIds = (await workspace.db.factCandidates
        .where("workflowRunId")
        .equals(run.id)
        .and((fact) => fact.status === "pending")
        .toArray())
        .map((fact) => fact.id);
      await bulkSetFactCandidateStatus(pendingFactIds, "rejected", workspace.db, "auto-policy");
      advancedRun = await approveWorkflowStage(run.id, { approved: true }, workspace.db);
    }

    // 校验工作流已完成
    const completedRun = advancedRun;
    if (!completedRun || completedRun.status !== "completed") {
      throw new Error(
        `工作流预期已完成，实际 status=${completedRun?.status ?? "missing"}`,
      );
    }

    // 8. 技能迭代（post-commit side-effect）
    await runSkillIteration({
      projectId,
      workflowRunId: run.id,
      db: workspace.db,
    });

    // 9. 导出候选包
    //    baseTargetDocument 必须来自基线快照（工作流前状态），而非实验库当前状态。
    //    工作流的 commit 阶段已修改实验库中的 document（contentHtml/plainText/revision/
    //    approvedRevisionId），若从实验库读取会得到工作流后的状态，promote 的 baseline
    //    校验会失败。baseSnapshot.records.documents 是工作流前的不可变快照。
    const baseTargetDocument = resolveBaseTargetDocument(baseSnapshot, chapterId);
    const candidate = await extractCandidateBundle({
      workflowRunId: run.id,
      workspace,
      baseDependencyHead: baseSnapshot.head,
      baseTargetDocument,
      codeRevision,
    });

    // 10. inspect 候选包
    const service = createPromotionService(canonicalDb);
    const check = await service.inspect(candidate);

    // 11. 若非 dryRun，执行 promote
    let receipt: PromotionReceipt | undefined;
    if (!dryRun) {
      if (check.status !== "ready") {
        // inspect 未通过，构造 rejected receipt（不调用 promote）
        receipt = {
          candidateId: candidate.id,
          operationId: `promote:${candidate.id}`,
          status: "rejected",
          promotedAt: Date.now(),
          createdFactAssertionIds: [],
          createdMemoryIds: [],
          createdOperationIds: [],
          error: `inspect.status=${check.status}：${[...check.issues, ...check.deterministicBlockers].join("；") || "无详细原因"}`,
        };
      } else {
        const decision = buildAuthorDecision(candidate, authorId);
        receipt = await service.promote(candidate, decision);
      }
    }

    // 12. 捕获事后正式库 hash（dryRun 时不变；promote 时前进）
    const afterSnapshot = await captureProjectSnapshot(canonicalDb, projectId, "post-bench");
    const canonicalHashAfter = afterSnapshot.manifest.snapshotHash;

    return {
      experimentId,
      experimentWorkspace: workspace,
      candidate,
      check,
      receipt,
      canonicalHashBefore,
      canonicalHashAfter,
      workflowRunId: run.id,
      baseSnapshot,
    };
  } finally {
    // 实验库清理：即使上面任一步骤抛错也要删除实验库
    try {
      await workspace.delete();
    } catch {
      // 忽略清理失败，不影响主流程错误传播
    }
  }
}

// ===== 辅助 =====

/**
 * 从基线快照的 documents 记录中解析目标章节的工作流前状态。
 *
 * ProjectSnapshotBundle.records.documents 是工作流前捕获的不可变快照，
 * 每条记录是 ManuscriptDocument 的 JSON 序列化形式。本函数找到 chapterId 对应的记录，
 * 重新计算 baseContentHash（FNV-1a，与 db.ts 的 documentContentHash 一致），
 * 组装为 CandidateTargetDocument。
 *
 * @throws 若目标章节不在基线快照中
 */
function resolveBaseTargetDocument(
  baseSnapshot: ProjectSnapshotBundle,
  chapterId: string,
): CandidateTargetDocument {
  const records = baseSnapshot.records.documents ?? [];
  const found = records.find((record) => (record as { id?: string }).id === chapterId);
  if (!found) {
    throw new Error(
      `目标章节 ${chapterId} 不在基线快照中（records.documents 共 ${records.length} 条）`,
    );
  }
  const document = found as unknown as ManuscriptDocument;
  return {
    documentId: document.id,
    baseRevision: document.revision,
    baseApprovedRevisionId: document.approvedRevisionId,
    baseContentHash: documentContentHash(document),
  };
}

/**
 * 构造 AuthorDecision：默认接受所有 facts + skills + bindings。
 *
 * CLI/UI 可在此基础上提供更细粒度的审批 UI；本模块默认全接受以使闭环可一键执行。
 */
export function buildAuthorDecision(candidate: CandidateBundle, authorId: string): AuthorDecision {
  return {
    accepted: true,
    authorId,
    rationale: "闭环 CLI 默认接受全部候选",
    acceptedFactIds: candidate.acceptedFacts.map((fact: PromotableFact) => fact.sourceCandidateId),
    acceptedSkillIds: candidate.iteratedSkills.map((skill: IteratedSkill) => skill.skillId),
    acceptedBindingKeys: candidate.iteratedBindings.map((binding: IteratedBinding) => binding.skillId),
    decidedAt: Date.now(),
  };
}

/** 晋升已经展示并确认的候选，不重新运行 LLM 或实验工作流。 */
export async function promoteClosedLoopCandidate(params: {
  canonicalDb: NovelDatabase;
  candidate: CandidateBundle;
  authorId: string;
}): Promise<PromoteClosedLoopCandidateResult> {
  const service = createPromotionService(params.canonicalDb);
  const check = await service.inspect(params.candidate);
  if (check.status !== "ready") {
    return {
      check,
      receipt: {
        candidateId: params.candidate.id,
        operationId: `promote:${params.candidate.id}`,
        status: "rejected",
        promotedAt: Date.now(),
        createdFactAssertionIds: [],
        createdMemoryIds: [],
        createdOperationIds: [],
        error: `inspect.status=${check.status}：${[...check.issues, ...check.deterministicBlockers].join("；") || "无详细原因"}`,
      },
      canonicalHashAfter: (await captureProjectSnapshot(params.canonicalDb, params.candidate.sourceProjectId, "post-bench")).manifest.snapshotHash,
    };
  }
  const receipt = await service.promote(params.candidate, buildAuthorDecision(params.candidate, params.authorId));
  const canonicalHashAfter = (await captureProjectSnapshot(params.canonicalDb, params.candidate.sourceProjectId, "post-promotion")).manifest.snapshotHash;
  return { check, receipt, canonicalHashAfter };
}

// ===== 类型 re-export =====

export type { CreativeBrief, NovelConversationThread };
