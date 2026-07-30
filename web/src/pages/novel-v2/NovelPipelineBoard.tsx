/* ============================================================
 * 创作流水线指挥中心（NovelPipelineBoard）
 *
 * 把「章节创作」里扁平的事件流升级为可读的 11 阶段流水线看板：
 * - 顶部：实时 11 阶段进度轨（由 run 状态 + 产物 + 事件推导）
 * - 左栏：章节轨（按故事弧分组）+ 运行列表
 * - 中栏：人工门禁横幅 / 质量八维报告 / 定稿正文 / 事实候选审批
 * - 右栏：按阶段聚合的语义化事件时间线
 *
 * 数据来源：/v2/projects/:id、/v2/projects/:id/runs、/v2/runs/:wfId(+events/artifacts)、
 *           /v2/projects/:id/documents/:docId/content、/v2/projects/:id/fact-candidates
 * 复用：stage-meta.ts（11 阶段 + 8 维质量）、presentation.tsx（语义转译）、novelApi.ts（数据层）
 * ============================================================ */

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { motion } from "motion/react";
import { Alert, Button, Checkbox, Empty, Input, Popconfirm, Progress, Segmented, Select, Tabs, Tag, Tooltip, message } from "antd";
import {
  AuditOutlined,
  CheckCircleFilled,
  CheckOutlined,
  ClockCircleOutlined,
  CloseCircleFilled,
  CloseOutlined,
  DatabaseOutlined,
  EditOutlined,
  FileTextOutlined,
  HistoryOutlined,
  LoadingOutlined,
  ReloadOutlined,
  RobotOutlined,
  RocketOutlined,
  SaveOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";

import { STAGE_META, QUALITY_DIMENSIONS, type StageMeta } from "./workflow-showcase/stage-meta";
import type { WorkflowStage } from "@/novel-v2/protocol";
import { describeEvent, documentStatusMeta, relativeTime, statusMeta, type EventCategory } from "./presentation";
import ArtifactContentModal, { ArtifactCard, type ArtifactSummary } from "./ArtifactContentModal";
import ManuscriptEditor from "./ManuscriptEditor";
import TextDiff from "./TextDiff";
import {
  useDecideFactCandidate,
  useChapterVersionActions,
  useNovelArtifactText,
  useNovelChapterWorkspace,
  useNovelFactCandidates,
  useNovelProject,
  useNovelProjectRuns,
  useNovelRun,
  useNovelRunArtifacts,
  useNovelRunEvents,
  useNovelRunReviews,
  useNovelRunPromptExecutions,
  useCancelNovelRun,
  useCreateChapterReviewIssue,
  useReplacePendingArtifact,
  useSignalHumanDecision,
  useSaveNovelDocumentContent,
  useSubmitChapterReview,
  useStartTargetedChapterRepair,
  useUpdateChapterReviewIssue,
  isChapterWorkflowRun,
  novelRunDocumentId,
  type NovelArtifactSummary,
  type NovelDocumentSummary,
  type NovelChapterWorkspace,
  type NovelChapterReviewIssue,
  type NovelReviewSummary,
  type NovelPromptExecution,
  type NovelRunEvent,
  type NovelRunState,
  type NovelWorkflowRunRecord,
} from "@/lib/novelApi";
import "./pipeline-board.css";
import "./manuscript-tools.css";

type StageNodeStatus = "done" | "active" | "pending" | "gate" | "failed";

export { novelRunDocumentId };

/** EventCategory（中文）→ 事件点配色 class key */
const EVENT_CATEGORY_CLASS: Record<EventCategory, string> = { 运行: "run", 任务: "task", 产物: "artifact", 记忆: "memory", 学习: "learning", 文档: "doc", 其他: "default" };
const RUN_FAILURE_STATUSES = new Set(["failed", "rejected", "cancelled", "terminated"]);
const RUN_ACTIVE_STATUSES = new Set(["running", "waiting-external", "pending", "accepted", "paused"]);
const DISMISSED_REVIEW_RUN_KEY = "ymcp:novel-v2:dismissed-review-run";

function readDismissedReviewRun(projectId: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(`${DISMISSED_REVIEW_RUN_KEY}:${projectId}`) ?? undefined;
}

function rememberDismissedReviewRun(projectId: string, workflowId: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(`${DISMISSED_REVIEW_RUN_KEY}:${projectId}`, workflowId);
}

export type ChapterWorkspaceMode = "empty" | "planned" | "running" | "manuscript-review" | "fact-review" | "final" | "failed" | "stalled";

export interface ChapterWorkspaceState {
  mode: ChapterWorkspaceMode;
  latestRun?: NovelWorkflowRunRecord;
  reasonCode?: string;
}

/** 用户状态只由章节的最新运行决定；更旧的运行仅属于诊断历史。 */
export function deriveChapterWorkspaceState(document: NovelDocumentSummary | undefined, runs: NovelWorkflowRunRecord[]): ChapterWorkspaceState {
  if (!document) return { mode: "empty" };
  const latestRun = [...runs]
    .filter((run) => novelRunDocumentId(run) === document.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const reasonCode = typeof latestRun?.payload.reasonCode === "string" ? latestRun.payload.reasonCode : undefined;

  if (latestRun?.status === "manual-review-required") {
    return { mode: reasonCode === "fact-approval-pending" ? "fact-review" : "manuscript-review", latestRun, reasonCode };
  }
  if (latestRun && RUN_ACTIVE_STATUSES.has(latestRun.status)) return { mode: "running", latestRun, reasonCode };
  // A terminal background run must never hide an existing formal manuscript.
  // The author can continue reading/editing the approved text and recover the
  // interrupted review from its own issue snapshot.
  if (document.status === "final") return { mode: "final", latestRun, reasonCode };
  if (latestRun && RUN_FAILURE_STATUSES.has(latestRun.status)) return { mode: "failed", latestRun, reasonCode };
  if (document.status === "planned" && !latestRun) return { mode: "planned" };
  return { mode: "stalled", latestRun, reasonCode };
}

export function findInterruptedChapterReviewRun(documentId: string | undefined, runs: NovelWorkflowRunRecord[]): NovelWorkflowRunRecord | undefined {
  if (!documentId) return undefined;
  const latestTargetedReview = [...runs]
    .filter((run) => run.workflowType === "chapter-review"
      && novelRunDocumentId(run) === documentId
      && run.payload.mode === "targeted"
      && Array.isArray(run.payload.targetIssueIds)
      && run.payload.targetIssueIds.length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return latestTargetedReview && ["failed", "cancelled", "terminated"].includes(latestTargetedReview.status)
    ? latestTargetedReview
    : undefined;
}

const CHAPTER_MODE_META: Record<ChapterWorkspaceMode, { label: string; tone: string }> = {
  empty: { label: "未选择", tone: "idle" },
  planned: { label: "未开始", tone: "idle" },
  running: { label: "创作中", tone: "running" },
  "manuscript-review": { label: "待审正文", tone: "review" },
  "fact-review": { label: "待核事实", tone: "review" },
  final: { label: "已定稿", tone: "done" },
  failed: { label: "需处理", tone: "failed" },
  stalled: { label: "待恢复", tone: "failed" },
};

/** NovelArtifactSummary → ArtifactCard/Modal 期望的 ArtifactSummary（createdAt 统一为 number） */
function toArtifactSummary(a: NovelArtifactSummary): ArtifactSummary {
  return { id: a.id, kind: a.kind, taskId: a.taskId, fingerprint: a.fingerprint, structuredData: a.structuredData, createdAt: typeof a.createdAt === "number" ? a.createdAt : undefined };
}

/** 把事件/记录里的 stage 字符串归一化到 STAGE_META 的阶段 id */
function normalizeStageKey(raw?: string): WorkflowStage | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (s.includes("author-decision-submitted")) return "fact-extraction";
  if (s.includes("fact-approval-pending")) return "fact-approval";
  if (s.includes("quality-gate-not-passed") || s.includes("targeted-manuscript-approval")) return "manuscript-approval";
  if (s.includes("data-loaded")) return "review";
  if (s.includes("manuscript-approval")) return "manuscript-approval";
  if (s.includes("fact-approval")) return "fact-approval";
  if (s.includes("fact-extraction") || s.includes("fact-extract")) return "fact-extraction";
  if (s.includes("blueprint-approval")) return "blueprint-approval";
  if (s.includes("blueprint")) return "blueprint";
  if (s.includes("context") || s.includes("preflight") || s.includes("memory") || s.includes("retrieve")) return "context";
  if (s.includes("revision") || s.includes("revise")) return "revision";
  if (s.includes("reflection") || s.includes("draft")) return "draft";
  if (s.includes("review")) return "review";
  if (s.includes("commit")) return "commit";
  if (s.includes("enrich") || s.includes("character")) return "character-enrichment";
  return undefined;
}

function payloadStageKey(payload: Record<string, unknown>): WorkflowStage | undefined {
  const raw = typeof payload.stage === "string" ? payload.stage : undefined;
  if (raw?.toLowerCase().includes("author-decision-submitted")) {
    const pendingDecision = payload.pendingHumanDecision && typeof payload.pendingHumanDecision === "object"
      ? (payload.pendingHumanDecision as Record<string, unknown>).decision
      : undefined;
    const decision = pendingDecision ?? payload.decision;
    if (decision === "revise") return "revision";
    if (decision === "reject") return "manuscript-approval";
    return "fact-extraction";
  }
  return normalizeStageKey(raw);
}

function artifactStage(artifact: NovelArtifactSummary): WorkflowStage | undefined {
  if (artifact.kind === "chapter-blueprint") return "blueprint";
  if (artifact.kind === "draft") return "draft";
  if (artifact.kind === "review" || artifact.kind === "summary") return "review";
  if (artifact.kind === "revision") return "revision";
  if (artifact.kind === "fact-extraction") return "fact-extraction";
  return normalizeStageKey(artifact.taskId);
}

function failedStage(payload: Record<string, unknown>, artifacts: NovelArtifactSummary[]): WorkflowStage {
  const explicit = payloadStageKey(payload);
  if (explicit) return explicit;
  const error = typeof payload.error === "string" ? payload.error.toLowerCase() : "";
  if (/memory|context|preflight|记忆|上下文/u.test(error)) return "context";
  return artifacts.map(artifactStage).find(Boolean) ?? "context";
}

/** 由 run 状态 + 产物推导 11 阶段状态（防御式：字段缺失时将预检失败落到上下文阶段） */
export function deriveStageStates(run: NovelRunState | undefined, artifacts: NovelArtifactSummary[]): Record<string, StageNodeStatus> {
  const order = STAGE_META.map((m) => m.stage);
  const states: Record<string, StageNodeStatus> = {};
  const status = run?.status;
  const payload = (run?.record?.payload ?? {}) as Record<string, unknown>;
  const activeStage = payloadStageKey(payload);
  const reasonCode = typeof payload.reasonCode === "string" ? payload.reasonCode : undefined;

  if (status === "completed" || status === "succeeded") {
    order.forEach((s) => (states[s] = "done"));
    return states;
  }

  if (status === "abandoned") {
    const stoppedAt = order.indexOf(activeStage ?? "manuscript-approval");
    order.forEach((s, i) => (states[s] = i < stoppedAt ? "done" : "pending"));
    return states;
  }

  const artifactDone = new Set<string>();
  for (const a of artifacts) {
    if (a.kind === "draft") artifactDone.add("draft");
    if (a.kind === "review") artifactDone.add("review");
    if (a.kind === "revision") artifactDone.add("revision");
    if (a.kind === "fact-extraction") artifactDone.add("fact-extraction");
  }

  if (status === "failed" || status === "rejected" || status === "cancelled") {
    const lastIdx = order.indexOf(activeStage ?? failedStage(payload, artifacts));
    order.forEach((s, i) => (states[s] = i < lastIdx ? "done" : i === lastIdx ? "failed" : "pending"));
    return states;
  }

  if (status === "manual-review-required") {
    const gate = reasonCode === "fact-approval-pending" ? "fact-approval" : "manuscript-approval";
    const gateIdx = order.indexOf(gate);
    order.forEach((s, i) => (states[s] = i < gateIdx ? "done" : i === gateIdx ? "gate" : "pending"));
    return states;
  }

  // running / pending / accepted / paused
  const activeIdx = activeStage ? order.indexOf(activeStage) : 0;
  order.forEach((s, i) => {
    if (artifactDone.has(s)) states[s] = "done";
    else if (i < activeIdx) states[s] = "done";
    else if (i === activeIdx) states[s] = "active";
    else states[s] = "pending";
  });
  return states;
}

interface CurrentProgressDetail {
  phaseIndex: number;
  stage: WorkflowStage;
  stageLabel: string;
  eyebrow: string;
  title: string;
  next: string;
  facts: string[];
  latestEventSummary?: string;
}

function workflowRecord(run: NovelWorkflowRunRecord | NovelRunState | undefined): NovelWorkflowRunRecord | undefined {
  if (!run) return undefined;
  return "workflowType" in run ? run : run.record;
}

export function deriveCurrentProgressDetail(
  run: NovelWorkflowRunRecord | NovelRunState | undefined,
  artifacts: NovelArtifactSummary[] = [],
  reviews: NovelReviewSummary[] = [],
  events: NovelRunEvent[] = [],
): CurrentProgressDetail {
  const record = workflowRecord(run);
  const payload = (record?.payload ?? {}) as Record<string, unknown>;
  const reasonCode = typeof payload.reasonCode === "string" ? payload.reasonCode : undefined;
  const stage = payloadStageKey(payload)
    ?? (record?.status === "manual-review-required" && reasonCode === "fact-approval-pending" ? "fact-approval" : undefined)
    ?? (record?.status === "manual-review-required" ? "manuscript-approval" : undefined)
    ?? artifacts.map(artifactStage).filter(Boolean).pop()
    ?? "context";
  const stageLabel = STAGE_META.find((item) => item.stage === stage)?.label ?? "章节处理";
  const reviewRoles = new Set(reviews.map((review) => review.role ?? review.reviewerId).filter(Boolean));
  const latestEvent = [...events].pop();
  const latestEventSummary = latestEvent ? describeEvent(latestEvent.event_type ?? latestEvent.eventType, latestEvent.payload).summary : undefined;
  const waitingExternal = record?.status === "waiting-external" || typeof payload.modelTaskId === "string";
  const pendingDecision = payload.pendingHumanDecision && typeof payload.pendingHumanDecision === "object"
    ? (payload.pendingHumanDecision as Record<string, unknown>).decision
    : undefined;

  const facts = [
    `${artifacts.length} 个产物`,
    reviewRoles.size ? `${reviewRoles.size} 位审校已返回` : undefined,
    waitingExternal ? "等待外部模型回填" : undefined,
    pendingDecision === "revise" && stage === "revision" ? "作者补充意见已提交" : undefined,
    pendingDecision === "approve" && stage === "fact-extraction" ? "作者已批准候选稿" : undefined,
  ].filter((item): item is string => Boolean(item));

  if (stage === "context" || stage === "blueprint" || stage === "blueprint-approval") {
    return { phaseIndex: 0, stage, stageLabel, eyebrow: "准备资料", title: stage === "context" ? "正在冻结章节上下文" : "正在准备章节方案", next: "Runtime 正在读取规划、记忆与技能，完成后会进入正文生成。", facts, latestEventSummary };
  }
  if (stage === "draft") {
    return { phaseIndex: 1, stage, stageLabel, eyebrow: "正文生成", title: "正在创作正文", next: "正文完成后会进入反思、五角色审校与必要修订。", facts, latestEventSummary };
  }
  if (stage === "review" || stage === "revision" || stage === "manuscript-approval") {
    const title = stage === "manuscript-approval" ? "等待作者确认候选正文" : stage === "revision" ? "正在按审校意见修订" : "正在进行专业审校";
    return { phaseIndex: 2, stage, stageLabel, eyebrow: "审校修订", title, next: stage === "manuscript-approval" ? "批准后会进入事实提取与正式提交；退回会结束本次候选。" : "质量门禁通过后会交给作者确认。", facts, latestEventSummary };
  }
  const title = stage === "fact-approval" ? "等待作者确认事实候选" : stage === "commit" ? "正在正式提交定稿" : stage === "character-enrichment" ? "正在完善人物档案" : "正在提取章节事实";
  return { phaseIndex: 3, stage, stageLabel, eyebrow: "定稿沉淀", title, next: stage === "fact-approval" ? "所有候选事实处理完成后即可继续提交本章。" : "完成后正文、事实与章节记忆会同步更新。", facts, latestEventSummary };
}

// ---------- 质量报告解析 ----------
interface QualityIssue {
  severity: "blocker" | "major" | "warning";
  title?: string;
  description?: string;
  excerpt?: string;
  dimension?: string;
  rule?: string;
  suggestion?: string;
}
interface QualityData {
  overall: number | null;
  dims: { key: string; label: string; score: number | null }[];
  issues: QualityIssue[];
  reviewCount: number;
}

const REVIEW_ROLE_DIMENSIONS: Record<string, string[]> = {
  "style-reviewer": ["sceneEmbodiment", "specificity"],
  "character-reviewer": ["characterVoice", "dialogue"],
  "continuity-reviewer": ["continuity"],
  "plot-reviewer": ["plot", "hookPayoff"],
  "reader-reviewer": ["readerRetention"],
};

function parseIssues(value: unknown): QualityIssue[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): QualityIssue | null => {
      if (!item || typeof item !== "object") return null;
      const o = item as Record<string, unknown>;
      const severity = o.severity === "blocker" || o.severity === "major" ? o.severity : "warning";
      return {
        severity,
        title: typeof o.title === "string" ? o.title : undefined,
        description: typeof o.description === "string" ? o.description : undefined,
        excerpt: typeof o.excerpt === "string" ? o.excerpt : undefined,
        dimension: typeof o.dimension === "string" ? o.dimension : undefined,
        rule: typeof o.rule === "string" ? o.rule : undefined,
        suggestion: typeof o.suggestion === "string" ? o.suggestion : undefined,
      };
    })
    .filter((x): x is QualityIssue => Boolean(x));
}

export function deriveQuality(run: NovelRunState | undefined, artifacts: NovelArtifactSummary[], reviews: NovelReviewSummary[] = []): QualityData {
  const latestReviewedArtifact = artifacts.find((artifact) => reviews.some((review) => review.artifactId === artifact.id));
  const currentReviews = latestReviewedArtifact ? reviews.filter((review) => review.artifactId === latestReviewedArtifact.id) : reviews;
  const reviewArtifacts = artifacts.filter((a) => a.kind === "review" || a.kind === "summary");
  const issues: QualityIssue[] = [];
  const dimScores: Record<string, number[]> = {};
  let overallFromArtifact: number | null = null;

  for (const review of currentReviews) {
    issues.push(...parseIssues(review.issues));
    if (typeof review.score === "number" && review.role) {
      for (const dimension of REVIEW_ROLE_DIMENSIONS[review.role] ?? []) (dimScores[dimension] ??= []).push(review.score);
    }
  }

  for (const a of reviewArtifacts) {
    const sd = (a.structuredData ?? {}) as Record<string, unknown>;
    if (currentReviews.length === 0) {
      issues.push(...parseIssues(sd.issues));
      const critique = sd.critique;
      if (critique && typeof critique === "object" && !Array.isArray(critique)) issues.push(...parseIssues((critique as Record<string, unknown>).issues));
    }
    const scores = sd.scores;
    if (scores && typeof scores === "object") {
      for (const [k, v] of Object.entries(scores as Record<string, unknown>)) {
        if (typeof v === "number") (dimScores[k] ??= []).push(v);
      }
    }
    if (typeof sd.score === "number") overallFromArtifact = sd.score;
  }

  const payload = (run?.record?.payload ?? {}) as Record<string, unknown>;
  const finalScore = typeof payload.finalScore === "number" ? payload.finalScore : null;
  const currentScore = typeof payload.currentScore === "number" ? payload.currentScore : null;
  const overall = finalScore ?? currentScore ?? overallFromArtifact;

  const dims = QUALITY_DIMENSIONS.map((d) => {
    const arr = dimScores[d.key];
    if (arr && arr.length) return { key: d.key, label: d.label, score: arr.reduce((a, b) => a + b, 0) / arr.length };
    // 退化为按该维度 issue 扣分（blocker*2 + major*1 + warning*0.3）
    const dimIssues = issues.filter((i) => i.dimension === d.key);
    if (!dimIssues.length) return { key: d.key, label: d.label, score: null as number | null };
    const penalty = dimIssues.reduce((acc, i) => acc + (i.severity === "blocker" ? 2 : i.severity === "major" ? 1 : 0.3), 0);
    return { key: d.key, label: d.label, score: Math.max(0, 5 - penalty) };
  });

  const uniqueIssues = issues.filter((issue, index, all) => all.findIndex((candidate) => `${candidate.title ?? candidate.rule}|${candidate.excerpt ?? candidate.description}` === `${issue.title ?? issue.rule}|${issue.excerpt ?? issue.description}`) === index);
  return { overall, dims, issues: uniqueIssues, reviewCount: currentReviews.length || reviewArtifacts.length };
}

export function artifactsForStage(stage: string, artifacts: NovelArtifactSummary[]): NovelArtifactSummary[] {
  if (stage === "blueprint" || stage === "blueprint-approval") return artifacts.filter((artifact) => artifact.kind === "chapter-blueprint");
  if (stage === "draft") return artifacts.filter((artifact) => artifact.kind === "draft");
  if (stage === "review") return artifacts.filter((artifact) => artifact.kind === "review" || artifact.kind === "summary");
  if (stage === "revision") return artifacts.filter((artifact) => artifact.kind === "revision");
  if (stage === "manuscript-approval") {
    const latest = artifacts.find((artifact) => artifact.kind === "revision") ?? artifacts.find((artifact) => artifact.kind === "draft");
    return latest ? [latest] : [];
  }
  if (stage === "fact-extraction" || stage === "fact-approval") return artifacts.filter((artifact) => artifact.kind === "fact-extraction");
  return [];
}

// ---------- 小组件 ----------
function StageIcon({ status }: { status: StageNodeStatus }) {
  if (status === "done") return <CheckCircleFilled />;
  if (status === "active") return <LoadingOutlined />;
  if (status === "gate") return <ClockCircleOutlined />;
  if (status === "failed") return <CloseCircleFilled />;
  return <span className="pb-node-hollow" aria-hidden />;
}

export function QualityPanel({ quality }: { quality: QualityData }) {
  const [showIssues, setShowIssues] = useState(true);
  const score = quality.overall;
  const scoreColor = score == null ? "#8b8b92" : score >= 4 ? "#10b981" : score >= 2.5 ? "#f59e0b" : "#ef4444";
  return (
    <section className="pb-card">
      <header className="pb-card-head">
        <span className="pb-card-title"><AuditOutlined /> 质量报告</span>
        {quality.reviewCount > 0 && <Tag>{quality.reviewCount} 位审校</Tag>}
      </header>
      {score == null && quality.reviewCount === 0 && quality.issues.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="此运行尚未产生审校数据" />
      ) : <div className="pb-quality">
        <div className="pb-quality-score" style={{ color: scoreColor }}>{score == null ? "—" : score.toFixed(1)}<small>/5</small></div>
        <div className="pb-quality-dims">
          {quality.dims.map((d) => (
            <div key={d.key} className="pb-dim">
              <span className="pb-dim-label">{d.label}</span>
              <span className="pb-dim-bar"><span className="pb-dim-fill" style={{ width: d.score == null ? "0%" : `${(d.score / 5) * 100}%` }} /></span>
              <span className="pb-dim-val">{d.score == null ? "—" : d.score.toFixed(1)}</span>
            </div>
          ))}
        </div>
      </div>}
      {quality.issues.length > 0 && (
        <div className="pb-issues">
          <button type="button" className="pb-issues-toggle" onClick={() => setShowIssues((v) => !v)}>
            {showIssues ? "收起" : "展开"}问题清单（{quality.issues.length}）
          </button>
          {showIssues && (
            <ul className="pb-issue-list">
              {quality.issues.map((issue, i) => (
                <li key={i} className={`pb-issue is-${issue.severity}`}>
                  <Tag className={`pb-sev is-${issue.severity}`}>{issue.severity === "blocker" ? "阻断" : issue.severity === "major" ? "严重" : "提示"}</Tag>
                  <div className="pb-issue-body">
                    <div className="pb-issue-title">{issue.title ?? issue.rule ?? "问题"}</div>
                    {issue.description && <div className="pb-issue-desc">{issue.description}</div>}
                    {issue.excerpt && <div className="pb-issue-excerpt">「{issue.excerpt}」</div>}
                    {issue.suggestion && <div className="pb-issue-suggestion">建议：{issue.suggestion}</div>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

const STAGE_STATUS_LABEL: Record<StageNodeStatus, string> = { done: "已完成", active: "执行中", pending: "未开始", gate: "等待审批", failed: "失败" };

function StageDetail({ meta, status, artifacts, onView }: { meta: StageMeta; status: StageNodeStatus; artifacts: NovelArtifactSummary[]; onView: (artifact: ArtifactSummary) => void }) {
  const isApproval = meta.stage === "blueprint-approval" || meta.stage === "manuscript-approval" || meta.stage === "fact-approval";
  const guidance = status === "gate"
    ? "当前确实需要作者处理，请使用页面上方审批区的批准或退回操作。"
    : status === "failed"
      ? "运行在此阶段失败。失败原因和下一步操作见上方运行状态。"
      : isApproval && status === "done"
        ? "本次运行已通过该审批阶段，无需再次操作。"
        : isApproval && status === "pending"
          ? "工作流尚未到达该审批阶段，现在无需操作。"
          : status === "active"
            ? "该阶段正在由 Runtime 执行，无需手工操作。"
            : status === "done"
              ? "该阶段已完成，可查看下方关联产物。"
              : "该阶段尚未开始，前序阶段完成后会自动进入。";
  return <section className={`pb-card pb-stage-detail is-${status}`}>
    <header className="pb-card-head">
      <span className="pb-card-title">{meta.label}</span>
      <span className="pb-card-head-right"><Tag>{meta.categoryLabel}</Tag><Tag color={status === "failed" ? "red" : status === "gate" ? "gold" : status === "done" ? "green" : "default"}>{STAGE_STATUS_LABEL[status]}</Tag></span>
    </header>
    <p className="pb-stage-desc">{meta.description}</p>
    <Alert type={status === "failed" ? "error" : status === "gate" ? "warning" : "info"} showIcon message={guidance} />
    <div className="pb-stage-artifacts">
      {artifacts.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="此阶段没有独立产物" />}
      {artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={toArtifactSummary(artifact)} onView={onView} />)}
    </div>
  </section>;
}

function RunStatusPanel({ run, document, superseded }: { run?: NovelRunState; document?: NovelDocumentSummary; superseded: boolean }) {
  if (!run) return <Alert type="info" showIcon message="该章节暂无生产运行" description="可从右上角“发起创作”创建本章的第一条运行。" />;
  const payload = (run.record?.payload ?? {}) as Record<string, unknown>;
  const error = typeof payload.error === "string" ? payload.error : undefined;
  if (["failed", "rejected", "cancelled", "terminated"].includes(run.status)) {
    const stage = failedStage(payload, []);
    const stageLabel = STAGE_META.find((item) => item.stage === stage)?.label ?? "未知阶段";
    return <Alert
      type="error"
      showIcon
      message={`运行失败于“${stageLabel}”`}
      description={<><strong>{error ?? "运行未提供详细错误信息"}</strong><br />{superseded ? "这是历史失败记录，同一章节已有更新运行，通常无需重复处理。" : "请重新发起本章创作；若仍提示资料或记忆缺失，先到“创作资料”补全对应内容后再试。"}</>}
    />;
  }
  if (run.status === "abandoned") return <Alert type="info" showIcon message="已放弃本次工作流" description="本次候选稿未写入章节正文；章节保持工作流开始时的正式版本，候选产物仍可在历史记录中查看。" />;
  if (run.status === "completed" || run.status === "succeeded") return <Alert type="success" showIcon message={document?.status === "final" ? "本次运行已完成，章节已经定稿" : "本次运行已完成"} description="流水线中的审批节点是历史执行记录，无需再次点击批准。" />;
  if (run.status === "manual-review-required") return null;
  const stage = normalizeStageKey(typeof payload.stage === "string" ? payload.stage : undefined);
  return <Alert type="info" showIcon message={`运行${statusMeta(run.status).label}`} description={stage ? `当前正在执行“${STAGE_META.find((item) => item.stage === stage)?.label ?? stage}”，完成后会自动刷新。` : "Runtime 已受理任务，正在准备执行上下文。"} />;
}

/** 章节正文工作台：纯文本是唯一事实源，保存、重审、从蓝图重写是三个显式动作。 */
function ManuscriptWorkbench({ projectId, documentId, workspace, loading, error, onRefresh, activeParagraph, onDirtyChange, onRegenerateFromBlueprint }: { projectId: string; documentId?: string; workspace?: NovelChapterWorkspace; loading?: boolean; error?: boolean; onRefresh?: () => void; activeParagraph?: number; onDirtyChange?: (dirty: boolean) => void; onRegenerateFromBlueprint?: () => void }) {
  const [mode, setMode] = useState<"read" | "edit" | "diff">("read");
  const [edited, setEdited] = useState("");
  const save = useSaveNovelDocumentContent(projectId, documentId);
  const submit = useSubmitChapterReview(projectId, documentId);
  const paragraphRefs = useRef<Array<HTMLParagraphElement | null>>([]);
  const content = workspace?.content;
  const original = content?.plainText ?? "";
  const dirty = edited !== original;

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  // 章节或定稿变化时重置编辑态
  useEffect(() => {
    setEdited(original);
    setMode("read");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, content?.contentHash]);

  useEffect(() => {
    if (activeParagraph === undefined) return;
    paragraphRefs.current[Math.max(0, activeParagraph - 1)]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeParagraph]);

  async function handleSave(showMessage = true) {
    if (!content || !dirty) return;
    try {
      await save.mutateAsync({ plainText: edited, expectedContentHash: content.contentHash });
      if (showMessage) message.success("正文已保存，原审核结果已标记为过期");
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSubmit() {
    try {
      if (dirty && content) await save.mutateAsync({ plainText: edited, expectedContentHash: content.contentHash });
      await submit.mutateAsync({ proposedText: edited || original });
      message.success("已提交章节重审工作流，复用审核/修订/事实/提交闭环");
      setMode("read");
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="pb-card">
      <header className="pb-card-head">
        <span className="pb-card-title"><FileTextOutlined /> 章节正文</span>
        <span className="pb-card-head-right">
          {workspace && content && <Tag>{documentStatusMeta(workspace.document.status).label} · r{content.revision}</Tag>}
          {workspace && content && (
            <Segmented
              size="small"
              value={mode}
              onChange={(v) => setMode(v as "read" | "edit" | "diff")}
              options={[
                { value: "read", label: "查看" },
                { value: "edit", label: "编辑" },
                { value: "diff", label: "对比" },
              ]}
            />
          )}
          {mode === "edit" && dirty && <Button size="small" icon={<SaveOutlined />} loading={save.isPending} onClick={() => void handleSave()}>保存</Button>}
          {content && <Button size="small" type="primary" loading={submit.isPending || save.isPending} onClick={() => void handleSubmit()}>{dirty ? "保存并重新审校" : "重新审校"}</Button>}
          {content && onRegenerateFromBlueprint && (
            <Popconfirm
              title="从蓝图重新生成本章？"
              description="会重新进入章节蓝图/草稿/审核/事实/提交流水线，当前定稿会保留到你批准新候选稿之后。"
              okText="从蓝图重写"
              cancelText="取消"
              onConfirm={onRegenerateFromBlueprint}
              disabled={dirty}
            >
              <Tooltip title={dirty ? "正文有未保存修改，请先保存或放弃编辑" : "不是基于审核意见局部修复，而是从章节蓝图重新生成整章候选"}>
                <span><Button size="small" icon={<ReloadOutlined />} disabled={dirty}>从蓝图重写</Button></span>
              </Tooltip>
            </Popconfirm>
          )}
        </span>
      </header>
      {loading && <div className="pb-loading"><LoadingOutlined /> 加载正文…</div>}
      {!loading && error && <Alert type="error" showIcon message="正文暂时无法读取" description="Runtime 未能从统一对象存储取得本章定稿，请检查对象存储配置。" action={<Button size="small" onClick={onRefresh}>重试</Button>} />}
      {!loading && !error && !content && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={documentId ? "当前章节尚无可读取的正文" : "选择左侧章节查看正文"} />}
      {content && mode === "read" && <div className="pb-manuscript pb-manuscript-reading">{original ? original.split(/\n\s*\n/gu).map((paragraph, index) => <p key={index} ref={(node) => { paragraphRefs.current[index] = node; }} className={activeParagraph === index + 1 ? "is-highlighted" : ""}>{paragraph}</p>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="正文为空" />}</div>}
      {content && mode === "edit" && <ManuscriptEditor key={content.contentHash} value={edited} onChange={setEdited} minHeight={620} activeParagraph={activeParagraph === undefined ? undefined : activeParagraph - 1} />}
      {content && mode === "diff" && <TextDiff baseText={original} newText={edited} baseLabel="当前定稿" newLabel="我的修改" emptyText="尚未做任何修改" />}
    </section>
  );
}

/** 修订前后对比：初稿 artifact vs 最新修订 artifact（当前 run 存在修订时显示） */
export function RevisionDiffCard({ artifacts }: { artifacts: NovelArtifactSummary[] }) {
  const draft = useMemo(() => [...artifacts].filter((a) => a.kind === "draft").pop(), [artifacts]);
  const revision = useMemo(() => [...artifacts].filter((a) => a.kind === "revision").pop(), [artifacts]);
  if (!draft || !revision) return null;
  return <RevisionDiffInner draftId={draft.id} revisionId={revision.id} />;
}

function RevisionDiffInner({ draftId, revisionId }: { draftId: string; revisionId: string }) {
  const draftQ = useNovelArtifactText(draftId);
  const revisionQ = useNovelArtifactText(revisionId);
  const loading = draftQ.isLoading || revisionQ.isLoading;
  return (
    <section className="pb-card">
      <header className="pb-card-head">
        <span className="pb-card-title"><FileTextOutlined /> 修订前后对比</span>
        <Tag>初稿 → 修订稿</Tag>
      </header>
      {loading && <div className="pb-loading"><LoadingOutlined /> 加载修订文本…</div>}
      {!loading && (draftQ.data || revisionQ.data) && (
        <TextDiff baseText={draftQ.data?.text ?? ""} newText={revisionQ.data?.text ?? ""} baseLabel="初稿" newLabel="修订稿" emptyText="修订稿与初稿一致" />
      )}
    </section>
  );
}

function EventTimeline({ events }: { events: NovelRunEvent[] }) {
  const list = useMemo(() => [...events].reverse().slice(0, 60), [events]);
  return (
    <section className="pb-card pb-events-card">
      <header className="pb-card-head"><span className="pb-card-title"><ThunderboltOutlined /> 事件流</span></header>
      {list.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无事件" />}
      <ul className="pb-event-list">
        {list.map((ev, i) => {
          const desc = describeEvent(ev.event_type ?? ev.eventType, ev.payload);
          const payload = (ev.payload ?? {}) as Record<string, unknown>;
          const stageKey = normalizeStageKey(typeof payload.stage === "string" ? payload.stage : undefined);
          const stageLabel = stageKey ? STAGE_META.find((m) => m.stage === stageKey)?.label : undefined;
          return (
            <li key={ev.id ?? i} className="pb-event">
              <span className={`pb-event-dot is-${EVENT_CATEGORY_CLASS[desc.category] ?? "default"}`} aria-hidden />
              <div className="pb-event-body">
                <div className="pb-event-line">
                  <span className="pb-event-label">{desc.label}</span>
                  {stageLabel && <Tag className="pb-event-stage">{stageLabel}</Tag>}
                </div>
                <div className="pb-event-summary">{desc.summary}</div>
                <div className="pb-event-time">{relativeTime(ev.created_at ?? ev.createdAt)}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ChapterRail({ documents, runs, selectedId, onSelect }: { documents: NovelDocumentSummary[]; runs: NovelWorkflowRunRecord[]; selectedId?: string; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [modeFilter, setModeFilter] = useState<ChapterWorkspaceMode | "all">("all");
  const visibleDocuments = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return documents.filter((document) => {
      const state = deriveChapterWorkspaceState(document, runs);
      const matchesQuery = !keyword || `${document.title} ${document.narrativeOrder} ${document.arcTitle ?? ""}`.toLowerCase().includes(keyword);
      return matchesQuery && (modeFilter === "all" || state.mode === modeFilter);
    });
  }, [documents, modeFilter, query, runs]);
  const groups = useMemo(() => {
    const map = new Map<string, NovelDocumentSummary[]>();
    for (const doc of [...visibleDocuments].sort((a, b) => a.narrativeOrder - b.narrativeOrder)) {
      const key = doc.arcId ?? "__none__";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(doc);
    }
    return [...map.entries()];
  }, [visibleDocuments]);
  return (
    <section className="pb-card pb-rail">
      <header className="pb-card-head"><span className="pb-card-title"><FileTextOutlined /> 章节</span><Tag>{visibleDocuments.length}</Tag></header>
      <div className="pb-chapter-filters">
        <Input allowClear value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索章节" />
        <Select value={modeFilter} onChange={(value) => setModeFilter(value as ChapterWorkspaceMode | "all")} options={[
          { value: "all", label: "全部状态" },
          ...(["planned", "running", "manuscript-review", "fact-review", "final", "failed", "stalled"] as ChapterWorkspaceMode[]).map((value) => ({ value, label: CHAPTER_MODE_META[value].label })),
        ]} />
      </div>
      {documents.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无章节" />}
      {documents.length > 0 && visibleDocuments.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的章节" />}
      {groups.map(([arcId, docs]) => (
        <div key={arcId} className="pb-arc-group">
          {docs[0]?.arcTitle && <div className="pb-arc-title">{docs[0].arcTitle}</div>}
          <ul className="pb-chapter-list">
            {docs.map((doc) => {
              const state = deriveChapterWorkspaceState(doc, runs);
              const meta = CHAPTER_MODE_META[state.mode];
              return <li key={doc.id}>
                <button type="button" className={`pb-chapter ${selectedId === doc.id ? "is-selected" : ""}`} onClick={() => onSelect(doc.id)}>
                  <span className="pb-chapter-num">{doc.narrativeOrder}</span>
                  <span className="pb-chapter-copy"><span className="pb-chapter-name">{doc.title}</span><small>{doc.wordCount ? `${doc.wordCount.toLocaleString()} 字` : doc.arcTitle ?? "未归属故事弧"}</small></span>
                  {doc.reviewStale ? <span className="pb-chapter-review is-stale">已修改</span> : typeof doc.reviewScore === "number" ? <span className={`pb-chapter-review is-${doc.reviewVerdict ?? "passed"}`}>{doc.reviewScore.toFixed(1)}</span> : null}
                  <span className={`pb-chapter-mode is-${meta.tone}`}>{meta.label}</span>
                </button>
              </li>
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

function WorkspaceEmpty({ children }: { children: React.ReactNode }) {
  return <section className="pb-author-empty">{children}</section>;
}

function PlannedWorkspace({ document, onStart, onDelete }: { document: NovelDocumentSummary; onStart?: () => void; onDelete?: () => void }) {
  return <WorkspaceEmpty>
    <span className="pb-author-empty-icon"><FileTextOutlined /></span>
    <span className="pb-eyebrow">章节目标已就绪</span>
    <h3>从本章的创作意图开始</h3>
    <p>{document.arcTitle ?? "尚未归属故事弧"}{document.povCharacterId ? ` · POV ${document.povCharacterId}` : ""}</p>
    <div className="pb-author-empty-actions">
      <Button type="primary" icon={<RocketOutlined />} onClick={onStart}>开始创作</Button>
      <Button danger onClick={onDelete}>删除章节</Button>
    </div>
  </WorkspaceEmpty>;
}

function RunningWorkspace({ run, artifacts, reviews, events, onCancel, cancelling }: { run?: NovelWorkflowRunRecord; artifacts: NovelArtifactSummary[]; reviews: NovelReviewSummary[]; events: NovelRunEvent[]; onCancel: () => void; cancelling: boolean }) {
  const progress = deriveCurrentProgressDetail(run, artifacts, reviews, events);
  const phases = ["准备", "创作", "审校", "定稿"];
  const targeted = run?.payload.mode === "targeted";
  const targetIssueCount = Array.isArray(run?.payload.targetIssueIds) ? run.payload.targetIssueIds.length : 0;
  return <section className="pb-author-running">
    <div className="pb-running-copy"><LoadingOutlined /><div><span className="pb-eyebrow">{targeted ? `AI 定向修复 · ${targetIssueCount} 条意见` : progress.eyebrow}</span><h3>{targeted ? "正在限定段落内生成修订" : progress.title}</h3><p>{targeted ? "完成正式复审后会进入差异确认，不会自动替换当前正文。" : progress.next}</p>{progress.latestEventSummary && <small>最新：{progress.latestEventSummary}</small>}</div></div>
    <div className="pb-author-progress" aria-label={`当前进度：${phases[progress.phaseIndex]}`}>
      {phases.map((phase, index) => <div key={phase} className={index < progress.phaseIndex ? "is-done" : index === progress.phaseIndex ? "is-active" : ""}><span>{index < progress.phaseIndex ? <CheckOutlined /> : index + 1}</span><strong>{phase}</strong></div>)}
    </div>
    <div className="pb-running-details"><Tag color="blue">{progress.stageLabel}</Tag>{progress.facts.map((fact) => <Tag key={fact}>{fact}</Tag>)}</div>
    <small>最近更新于 {relativeTime(run?.updatedAt)}</small>
    <Popconfirm title="取消本次运行？" description="已生成的候选产物会保留，当前正文不会被替换。" onConfirm={onCancel}>
      <Button danger icon={<CloseOutlined />} loading={cancelling}>取消本次运行</Button>
    </Popconfirm>
  </section>;
}

function CandidateReviewWorkspace({ text, baseText, targeted = false, targetIssueCount = 0, goal, alignment, loading, quality, onApprove, onAbandon, onReviseAgain, onRevisePrevious, onSaveReplacement, saving = false, deciding, revisingAgain = false }: { text: string; baseText?: string; targeted?: boolean; targetIssueCount?: number; goal?: { authorInstruction?: string; acceptanceCriteria?: string[] }; alignment?: { satisfied?: boolean; summary?: string; unmetRequirements?: string[] }; loading: boolean; quality: QualityData; onApprove: () => void; onAbandon: () => void; onReviseAgain?: (feedback?: string) => void; onRevisePrevious?: (feedback?: string) => void; onSaveReplacement: (plainText: string) => Promise<void>; saving?: boolean; deciding: boolean; revisingAgain?: boolean }) {
  const [activeIssue, setActiveIssue] = useState<number>();
  const [feedback, setFeedback] = useState("");
  const [view, setView] = useState<"diff" | "text" | "edit">(targeted ? "diff" : "text");
  const [editedText, setEditedText] = useState(text);
  const paragraphRefs = useRef<Array<HTMLParagraphElement | null>>([]);
  useEffect(() => { setEditedText(text); }, [text]);
  useEffect(() => { if (!targeted && view === "diff" && baseText === undefined) setView("text"); }, [baseText, targeted, view]);
  const editDirty = editedText !== text;
  const paragraphs = useMemo(() => text.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean), [text]);
  const issueParagraphs = useMemo(() => quality.issues.map((issue) => {
    const needle = (issue.excerpt ?? "").replace(/\s+/gu, "").slice(0, 60);
    return needle ? paragraphs.findIndex((paragraph) => paragraph.replace(/\s+/gu, "").includes(needle)) : -1;
  }), [paragraphs, quality.issues]);
  const hasSeriousIssue = quality.issues.some((issue) => issue.severity === "blocker" || issue.severity === "major");

  function requireSavedEdits(action: () => void) {
    if (editDirty) {
      message.warning("候选正文有未保存修改，请先保存或放弃编辑后再继续");
      setView("edit");
      return;
    }
    action();
  }

  async function saveReplacement() {
    if (!editedText.trim()) {
      message.error("候选正文不能为空");
      return;
    }
    if (!editDirty) {
      message.info("候选正文没有变化");
      return;
    }
    await onSaveReplacement(editedText);
    setView(targeted && baseText !== undefined ? "diff" : "text");
  }

  function focusIssue(index: number) {
    setActiveIssue(index);
    const paragraphIndex = issueParagraphs[index];
    if (paragraphIndex >= 0) paragraphRefs.current[paragraphIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return <div className="pb-review-workspace">
    <section className="pb-review-manuscript">
      <header><div><span className="pb-eyebrow">候选正文</span><h3>审阅当前修订稿</h3></div><div className="pb-review-head-actions">{targeted && <Tag color="cyan">定向修复 {targetIssueCount} 条</Tag>}{editDirty && <Tag color="gold">未保存修改</Tag>}<Segmented size="small" value={view} onChange={(value) => setView(value as "diff" | "text" | "edit")} options={[{ value: "diff", label: "差异", disabled: baseText === undefined }, { value: "text", label: "正文" }, { value: "edit", label: "编辑" }]} />{view === "edit" && <Button size="small" icon={<SaveOutlined />} loading={saving} disabled={!editDirty || loading} onClick={() => void saveReplacement()}>保存为本轮产物</Button>}{quality.overall != null && <strong className="pb-review-score">{quality.overall.toFixed(1)}<small>/5</small></strong>}</div></header>
      {loading ? <div className="pb-loading"><LoadingOutlined /> 加载候选正文…</div> : view === "edit" ? <ManuscriptEditor key={`candidate-edit-${text.length}-${text.slice(0, 24)}`} value={editedText} onChange={setEditedText} minHeight={620} /> : view === "diff" && baseText !== undefined ? <TextDiff baseText={baseText} newText={text} baseLabel="当前定稿" newLabel={targeted ? "AI 定向修订 / 作者保存稿" : "候选稿 / 作者保存稿"} emptyText="候选稿没有产生正文变化" /> : paragraphs.length ? <div className="pb-review-text">{paragraphs.map((paragraph, index) => <p key={index} ref={(node) => { paragraphRefs.current[index] = node; }} className={activeIssue !== undefined && issueParagraphs[activeIssue] === index ? "is-highlighted" : ""}>{paragraph}</p>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="候选正文尚未就绪" />}
    </section>
    <aside className="pb-review-issues">
      <header><div><span className="pb-eyebrow">审校意见</span><h3>{quality.issues.length} 个问题需要判断</h3></div></header>
      {(goal?.authorInstruction || goal?.acceptanceCriteria?.length) && <section className="pb-review-goal">
        <div><strong>本轮修订目标</strong>{alignment?.satisfied === false ? <Tag color="red">仍有未满足项</Tag> : alignment?.satisfied ? <Tag color="green">语义检查通过</Tag> : <Tag>待核对</Tag>}</div>
        {goal.authorInstruction && <p>{goal.authorInstruction}</p>}
        {alignment?.unmetRequirements?.length ? <ul>{alignment.unmetRequirements.map((item) => <li key={item}>{item}</li>)}</ul> : goal.acceptanceCriteria?.length ? <ul>{goal.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ul> : null}
        {alignment?.summary && <small>{alignment.summary}</small>}
      </section>}
      {quality.issues.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有结构化问题记录" />}
      <div className="pb-review-issue-list">{quality.issues.map((issue, index) => <button type="button" key={`${issue.title ?? issue.rule}-${index}`} className={`pb-review-issue is-${issue.severity} ${activeIssue === index ? "is-active" : ""}`} onClick={() => focusIssue(index)}>
        <span>{issue.severity === "blocker" ? "阻断" : issue.severity === "major" ? "严重" : "提示"}</span><strong>{issue.title ?? issue.rule ?? "审校问题"}</strong>{issue.suggestion && <small>{issue.suggestion}</small>}
      </button>)}</div>
      <div className="pb-review-feedback"><label htmlFor="pb-review-feedback">补充修改意见（可选）</label><Input.TextArea id="pb-review-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={4} placeholder="不填写时按上方审校意见重新生成；填写后会与审校意见合并" /></div>
    </aside>
    <footer className="pb-review-actions">
      <span>{targeted ? "可继续修订当前候选、退回上一版重做，或放弃整个工作流并保留开始时正文。" : "批准会接受当前候选稿并继续事实提取与正式提交。"}</span>
      <div>
        {targeted && onRevisePrevious && <Button icon={<HistoryOutlined />} disabled={quality.issues.length === 0 && !feedback.trim()} loading={revisingAgain} onClick={() => requireSavedEdits(() => onRevisePrevious(feedback.trim() || undefined))}>退回上一版继续修订</Button>}
        {targeted && onReviseAgain && <Button icon={<RobotOutlined />} disabled={quality.issues.length === 0 && !feedback.trim()} loading={revisingAgain} onClick={() => requireSavedEdits(() => onReviseAgain(feedback.trim() || undefined))}>按当前稿继续修订</Button>}
        <Popconfirm title="放弃整个工作流？" description="候选稿会保留为历史产物，章节正文仍是本次工作流开始时的正式版本。" okText="确认放弃" cancelText="继续审阅" onConfirm={() => requireSavedEdits(onAbandon)}><Button danger icon={<CloseOutlined />} loading={deciding}>放弃本次工作流</Button></Popconfirm>
        {hasSeriousIssue ? <Popconfirm title="仍有严重审校问题" description="确认以作者判断接受当前稿并继续定稿？" okText="仍然接受" cancelText="继续审阅" onConfirm={() => requireSavedEdits(onApprove)}><Button type="primary" icon={<CheckOutlined />} loading={deciding}>接受当前稿并定稿</Button></Popconfirm> : <Button type="primary" icon={<CheckOutlined />} loading={deciding} onClick={() => requireSavedEdits(onApprove)}>接受当前稿并定稿</Button>}
      </div>
    </footer>
  </div>;
}

function FactReviewWorkspace({ candidates, loading, deciding, onDecide, onContinue, onAbort }: { candidates: import("@/lib/novelApi").NovelFactCandidate[]; loading: boolean; deciding: boolean; onDecide: (id: string, decision: "approve" | "reject") => void; onContinue: () => void; onAbort: () => void }) {
  return <section className="pb-fact-review">
    <header><div><span className="pb-eyebrow">定稿前最后一步</span><h3>确认哪些事实可以进入后续创作记忆</h3><p>逐条判断正文明确支持的事实。拒绝项不会进入后续检索。</p></div><Tag color={candidates.length ? "gold" : "green"}>{candidates.length ? `${candidates.length} 条未处理` : "已全部处理"}</Tag></header>
    {loading && <div className="pb-loading"><LoadingOutlined /> 加载事实候选…</div>}
    {!loading && candidates.length === 0 && <div className="pb-fact-review-done"><CheckCircleFilled /><strong>事实决定已完成</strong><span>现在可以继续提交本章定稿。</span></div>}
    <div className="pb-fact-review-list">{candidates.map((candidate) => <article key={candidate.id}>
      <div><strong>{candidate.title}</strong><p>{candidate.content}</p><small>置信度 {Math.round(candidate.confidence * 100)}%{candidate.subjectRefs.length ? ` · ${candidate.subjectRefs.join("、")}` : ""}</small></div>
      <div><Button type="primary" ghost icon={<CheckOutlined />} onClick={() => onDecide(candidate.id, "approve")}>保留</Button><Button danger icon={<CloseOutlined />} onClick={() => onDecide(candidate.id, "reject")}>排除</Button></div>
    </article>)}</div>
    <footer><Button danger onClick={onAbort}>放弃本次提交</Button><Button type="primary" icon={<CheckOutlined />} disabled={loading || candidates.length > 0} loading={deciding} onClick={onContinue}>确认决定并继续</Button></footer>
  </section>;
}

function FinalWorkspace({ projectId, documentId, workspace, loading, error, onRefresh, activeParagraph, onDirtyChange, onRegenerateFromBlueprint }: { projectId: string; documentId?: string; workspace?: NovelChapterWorkspace; loading: boolean; error: boolean; onRefresh: () => void; activeParagraph?: number; onDirtyChange?: (dirty: boolean) => void; onRegenerateFromBlueprint?: () => void }) {
  return <ManuscriptWorkbench projectId={projectId} documentId={documentId} workspace={workspace} loading={loading} error={error} onRefresh={onRefresh} activeParagraph={activeParagraph} onDirtyChange={onDirtyChange} onRegenerateFromBlueprint={onRegenerateFromBlueprint} />;
}

function InterruptedReviewBanner({ run, retrying, onRetry, onOpenReview, onDismiss }: { run: NovelWorkflowRunRecord; retrying: boolean; onRetry: (instruction?: string) => void; onOpenReview: () => void; onDismiss: () => void }) {
  const issueCount = Array.isArray(run.payload.targetIssueIds) ? run.payload.targetIssueIds.length : 0;
  const [instruction, setInstruction] = useState("");
  return <Alert
    className="pb-alert pb-review-recovery-alert"
    type="warning"
    showIcon
    message={`上次 AI 定向修复未完成，原文未变（${issueCount} 条建议）`}
    description={<div className="pb-review-recovery-description">
      <span>你可以继续查看和编辑当前定稿，或基于同一批审核建议重新执行局部修复。</span>
      <Input.TextArea value={instruction} onChange={(event) => setInstruction(event.target.value)} maxLength={4000} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="补充修改要求（可选）：结合勾选的审核意见说明本轮希望保留或调整的效果" aria-label="补充修改要求" />
    </div>}
    action={<div className="pb-review-recovery-actions">
      <Button type="primary" size="small" icon={<RobotOutlined />} loading={retrying} onClick={() => onRetry(instruction.trim() || undefined)}>按原意见重新修复</Button>
      <Button size="small" icon={<FileTextOutlined />} onClick={onOpenReview}>查看原文与建议</Button>
      <Button size="small" type="text" icon={<CloseOutlined />} onClick={onDismiss}>关闭提示</Button>
    </div>}
  />;
}

function SnapshotReviewPanel({ projectId, documentId, workspace, state, manuscriptDirty, onLocate, onRepairStarted }: { projectId: string; documentId?: string; workspace?: NovelChapterWorkspace; state: ChapterWorkspaceState; manuscriptDirty: boolean; onLocate: (paragraph: number) => void; onRepairStarted: () => void }) {
  const updateIssue = useUpdateChapterReviewIssue(projectId, documentId);
  const createIssue = useCreateChapterReviewIssue(projectId, documentId);
  const repair = useStartTargetedChapterRepair(projectId, documentId);
  const [selectedIssueIds, setSelectedIssueIds] = useState<string[]>([]);
  const [authorInstruction, setAuthorInstruction] = useState("");
  const [newIssue, setNewIssue] = useState<{ severity: NovelChapterReviewIssue["severity"]; title: string; suggestion: string; paragraph: string }>({ severity: "warning", title: "", suggestion: "", paragraph: "" });
  const review = workspace?.review;
  useEffect(() => { setSelectedIssueIds([]); setAuthorInstruction(""); setNewIssue({ severity: "warning", title: "", suggestion: "", paragraph: "" }); }, [documentId, review?.id]);
  if (!review) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无完整审核结果" />;
  const disabledReason = manuscriptDirty ? "正文有未保存修改，请先保存或放弃修改" : review.stale ? "审核结果已过期，请先重新审校当前正文" : state.mode !== "final" ? "章节存在进行中的工作流" : undefined;
  const verdictLabel = review.verdict === "passed" ? "审核通过" : review.verdict === "blocked" ? "存在阻塞问题" : "建议继续修改";
  const pendingIssueIds = review.issues.filter((issue) => issue.status === "pending").map((issue) => issue.id);
  async function startRepair(issueIds: string[]) {
    try {
      await repair.mutateAsync({ issueIds, instruction: authorInstruction.trim() || undefined });
      setSelectedIssueIds([]);
      setAuthorInstruction("");
      onRepairStarted();
      message.success(`已启动 ${issueIds.length} 条意见的 AI 定向修复`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }
  function toggleIssue(issueId: string, checked: boolean) {
    setSelectedIssueIds((current) => checked ? [...new Set([...current, issueId])] : current.filter((id) => id !== issueId));
  }
  async function addIssue() {
    const title = newIssue.title.trim();
    if (!title) {
      message.error("请先填写审核意见");
      return;
    }
    const paragraph = newIssue.paragraph.trim() ? Number(newIssue.paragraph.trim()) : undefined;
    if (paragraph !== undefined && (!Number.isInteger(paragraph) || paragraph < 1)) {
      message.error("目标段落必须为正整数");
      return;
    }
    try {
      await createIssue.mutateAsync({ severity: newIssue.severity, title, suggestion: newIssue.suggestion.trim() || undefined, paragraph, evidenceQuote: title });
      setNewIssue({ severity: "warning", title: "", suggestion: "", paragraph: "" });
      message.success("已添加审核意见");
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }
  return <div className="pb-context-review">
    {review.stale && <Alert type="warning" showIcon message="正文已修改，审核结果可能失效" description="评分和意见仍保留供参考，重新审校后会整体替换。" />}
    <div className="pb-context-score"><strong>{review.overallScore?.toFixed(1) ?? "—"}<small>/5</small></strong><div><span>{verdictLabel}</span><small>{new Date(review.reviewedAt).toLocaleString()}</small></div></div>
    <div className="pb-context-dimensions">{QUALITY_DIMENSIONS.map((dimension) => <div key={dimension.key}><span>{dimension.label}</span><i><b style={{ width: `${Math.max(0, Math.min(100, ((review.dimensionScores[dimension.key] ?? 0) / 5) * 100))}%` }} /></i><strong>{review.dimensionScores[dimension.key]?.toFixed(1) ?? "—"}</strong></div>)}</div>
    <div className="pb-targeted-repair-instruction"><label htmlFor="pb-targeted-repair-instruction">补充修改要求</label><Input.TextArea id="pb-targeted-repair-instruction" value={authorInstruction} onChange={(event) => setAuthorInstruction(event.target.value)} maxLength={4000} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="结合勾选的审核意见，补充希望保留的内容、语气或修改方向（可选）" /></div>
    <div className="pb-targeted-repair-bar"><span>{selectedIssueIds.length > 0 ? `已选 ${selectedIssueIds.length} 条` : `待处理 ${pendingIssueIds.length} 条`}</span><div><Tooltip title={disabledReason || (pendingIssueIds.length === 0 ? "没有待处理审核意见" : undefined)}><span><Button size="small" icon={<RobotOutlined />} loading={repair.isPending} disabled={Boolean(disabledReason) || pendingIssueIds.length === 0} onClick={() => void startRepair(pendingIssueIds)}>一键重新生成</Button></span></Tooltip><Tooltip title={disabledReason}><span><Button size="small" type="primary" icon={<RobotOutlined />} loading={repair.isPending} disabled={Boolean(disabledReason) || selectedIssueIds.length === 0} onClick={() => void startRepair(selectedIssueIds)}>AI 修复选中项</Button></span></Tooltip></div></div>
    <div className="pb-review-add-issue">
      <div><Select size="small" value={newIssue.severity} onChange={(severity) => setNewIssue((current) => ({ ...current, severity }))} options={[{ value: "warning", label: "建议" }, { value: "major", label: "主要" }, { value: "blocker", label: "阻塞" }]} /><Input size="small" value={newIssue.paragraph} onChange={(event) => setNewIssue((current) => ({ ...current, paragraph: event.target.value }))} placeholder="段落（可选）" /></div>
      <Input value={newIssue.title} onChange={(event) => setNewIssue((current) => ({ ...current, title: event.target.value }))} placeholder="添加审核意见，例如：这一段人物反应太直白，需要改为动作呈现" />
      <Input.TextArea value={newIssue.suggestion} onChange={(event) => setNewIssue((current) => ({ ...current, suggestion: event.target.value }))} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="修改建议（可选）：说明希望如何修复" />
      <Button size="small" type="primary" icon={<CheckOutlined />} loading={createIssue.isPending} disabled={Boolean(disabledReason)} onClick={() => void addIssue()}>添加审核意见</Button>
    </div>
    <div className="pb-context-issues">{review.issues.map((issue) => <article key={issue.id} className={`is-${issue.severity} is-${issue.status}`}>
      <button type="button" className="pb-context-issue-main" onClick={() => issue.paragraph && onLocate(issue.paragraph)}>
        <span>{issue.severity === "blocker" ? "阻塞" : issue.severity === "major" ? "主要" : "建议"}</span><strong>{issue.title}</strong>
        {issue.evidenceQuote && <q>{issue.evidenceQuote}</q>}{issue.suggestion && <p>{issue.suggestion}</p>}
      </button>
      <div className="pb-context-issue-actions">
        <Checkbox checked={selectedIssueIds.includes(issue.id)} disabled={issue.status !== "pending" || Boolean(disabledReason)} onChange={(event) => toggleIssue(issue.id, event.target.checked)} aria-label={`选择 ${issue.title}`} />
        <Tooltip title={issue.status !== "pending" ? "先恢复为待处理意见后才能使用 AI 修复" : disabledReason}><span><Button size="small" type="text" icon={<RobotOutlined />} loading={repair.isPending} disabled={issue.status !== "pending" || Boolean(disabledReason)} onClick={() => void startRepair([issue.id])}>AI 修复</Button></span></Tooltip>
        <Tooltip title="声明该意见已由你处理；不会修改正文或评分"><Button size="small" type={issue.status === "resolved" ? "primary" : "text"} icon={<CheckOutlined />} loading={updateIssue.isPending} onClick={() => { setSelectedIssueIds((current) => current.filter((id) => id !== issue.id)); updateIssue.mutate({ issueId: issue.id, status: issue.status === "resolved" ? "pending" : "resolved" }); }}>已处理</Button></Tooltip>
        <Tooltip title="明确不采纳该意见；不会修改正文或评分"><Button size="small" type={issue.status === "ignored" ? "primary" : "text"} icon={<CloseOutlined />} loading={updateIssue.isPending} onClick={() => { setSelectedIssueIds((current) => current.filter((id) => id !== issue.id)); updateIssue.mutate({ issueId: issue.id, status: issue.status === "ignored" ? "pending" : "ignored" }); }}>忽略</Button></Tooltip>
      </div>
    </article>)}</div>
  </div>;
}

const WORKFLOW_PHASES: { label: string; stages: WorkflowStage[] }[] = [
  { label: "准备创作上下文", stages: ["context"] },
  { label: "生成章节方案", stages: ["blueprint", "blueprint-approval"] },
  { label: "撰写与优化正文", stages: ["draft", "review", "revision"] },
  { label: "审核与作者确认", stages: ["manuscript-approval", "fact-extraction", "fact-approval"] },
  { label: "定稿与更新记忆", stages: ["commit", "character-enrichment"] },
];

function phaseStatus(stages: WorkflowStage[], states: Record<string, StageNodeStatus>): StageNodeStatus {
  const statuses = stages.map((stage) => states[stage] ?? "pending");
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("gate")) return "gate";
  if (statuses.includes("active")) return "active";
  return statuses.every((status) => status === "done") ? "done" : "pending";
}

function WorkflowInspector({
  runs,
  selectedWorkflowId,
  run,
  document,
  artifacts,
  reviews,
  events,
  promptExecutions,
  selectedStage,
  latestWorkflowId,
  onSelectWorkflow,
  onSelectStage,
  onViewArtifact,
}: {
  runs: NovelWorkflowRunRecord[];
  selectedWorkflowId?: string;
  run?: NovelRunState;
  document?: NovelDocumentSummary;
  artifacts: NovelArtifactSummary[];
  reviews: NovelReviewSummary[];
  events: NovelRunEvent[];
  promptExecutions: NovelPromptExecution[];
  selectedStage: string | null;
  latestWorkflowId?: string;
  onSelectWorkflow: (workflowId: string) => void;
  onSelectStage: (stage: string) => void;
  onViewArtifact: (artifact: ArtifactSummary) => void;
}) {
  const states = useMemo(() => deriveStageStates(run, artifacts), [artifacts, run]);
  const progressDetail = useMemo(() => deriveCurrentProgressDetail(run, artifacts, reviews, events), [artifacts, events, reviews, run]);
  const doneCount = STAGE_META.filter((meta) => states[meta.stage] === "done").length;
  const progress = Math.round((doneCount / STAGE_META.length) * 100);
  const focusedStage = selectedStage
    ?? STAGE_META.find((meta) => ["failed", "gate", "active"].includes(states[meta.stage]))?.stage
    ?? [...STAGE_META].reverse().find((meta) => states[meta.stage] === "done")?.stage
    ?? "context";
  const focusedMeta = STAGE_META.find((meta) => meta.stage === focusedStage) ?? STAGE_META[0];
  const focusedArtifacts = artifactsForStage(focusedMeta.stage, artifacts);
  const selectedPhase = WORKFLOW_PHASES.find((phase) => phase.stages.includes(focusedMeta.stage));
  const phaseArtifactCount = (stages: WorkflowStage[]) => new Set(stages.flatMap((stage) => artifactsForStage(stage, artifacts).map((artifact) => artifact.id))).size;
  const runOptions = [...runs]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((item, index) => ({
      value: item.temporalWorkflowId,
      label: `${index === 0 ? "最新 · " : ""}${item.workflowType === "chapter-review" ? "章节审校" : "章节创作"} · ${statusMeta(item.status).label} · ${relativeTime(item.updatedAt)}`,
    }));
  const latestReviewsByRole = [...reviews].sort((a, b) => b.createdAt - a.createdAt).filter((review, index, orderedReviews) => {
    const reviewer = review.role ?? review.reviewerId;
    return orderedReviews.findIndex((candidate) => (candidate.role ?? candidate.reviewerId) === reviewer) === index;
  });

  return <div className="pb-workflow-inspector">
    <div className="pb-workflow-summary">
      <div className="pb-workflow-summary-head">
        <div><span>本次运行</span><strong>{run ? statusMeta(run.status).label : "尚未开始"}</strong></div>
        <b>{doneCount}<small> / {STAGE_META.length}</small></b>
      </div>
      <Progress percent={progress} showInfo={false} strokeColor="var(--color-accent)" />
      {runOptions.length > 0 && <Select aria-label="选择章节运行" value={selectedWorkflowId} options={runOptions} onChange={onSelectWorkflow} />}
    </div>

    <RunStatusPanel run={run} document={document} superseded={Boolean(selectedWorkflowId && selectedWorkflowId !== latestWorkflowId)} />

    {run && !["completed", "succeeded", "abandoned", "failed", "rejected", "cancelled", "terminated"].includes(run.status) && <section className="pb-card pb-current-progress">
      <header className="pb-card-head"><span className="pb-card-title"><LoadingOutlined /> 当前进度</span><Tag color="blue">{progressDetail.stageLabel}</Tag></header>
      <p className="pb-stage-desc"><strong>{progressDetail.title}</strong><br />{progressDetail.next}</p>
      <div className="pb-running-details">{progressDetail.facts.map((fact) => <Tag key={fact}>{fact}</Tag>)}{progressDetail.latestEventSummary && <Tag color="cyan">最新：{progressDetail.latestEventSummary}</Tag>}</div>
    </section>}

    <StageDetail meta={focusedMeta} status={states[focusedMeta.stage] ?? "pending"} artifacts={focusedArtifacts} onView={onViewArtifact} />

    <div className="pb-workflow-phases" aria-label="章节工作流进度">
      {WORKFLOW_PHASES.map((phase, phaseIndex) => {
        const status = phaseStatus(phase.stages, states);
        const artifactCount = phaseArtifactCount(phase.stages);
        const isFocused = phase === selectedPhase;
        return <section key={phase.label} className={`pb-workflow-phase is-${status} ${isFocused ? "is-focused" : ""}`}>
          <header>
            <span className="pb-workflow-phase-node"><StageIcon status={status} /></span>
            <div><strong>{phase.label}</strong><small>{STAGE_STATUS_LABEL[status]} · {phase.stages.length} 个步骤</small></div>
            {artifactCount > 0 && <span className="pb-workflow-artifact-count">{artifactCount} 产物</span>}
          </header>
          <div className="pb-workflow-stage-list">
            {phase.stages.map((stage) => {
              const meta = STAGE_META.find((item) => item.stage === stage)!;
              const stageStatus = states[stage] ?? "pending";
              return <button key={stage} type="button" className={`is-${stageStatus} ${focusedMeta.stage === stage ? "is-selected" : ""}`} onClick={() => onSelectStage(stage)}>
                <span>{meta.index}</span><strong>{meta.label}</strong><small>{STAGE_STATUS_LABEL[stageStatus]}</small>
              </button>;
            })}
          </div>
          {phaseIndex < WORKFLOW_PHASES.length - 1 && <i className="pb-workflow-phase-line" aria-hidden />}
        </section>;
      })}
    </div>

    {selectedPhase?.stages.some((stage) => stage === "review" || stage === "revision" || stage === "manuscript-approval") && latestReviewsByRole.length > 0 && <section className="pb-workflow-reviews">
      <header><strong>审校快照</strong><span>{latestReviewsByRole.length} 个角色</span></header>
      {latestReviewsByRole.map((review) => <article key={review.id}><strong>{review.role ?? review.reviewerId}</strong><span>{review.verdict}</span><b>{review.score?.toFixed(1) ?? "—"}<small>/5</small></b></article>)}
    </section>}

    {promptExecutions.length > 0 && <details className="pb-workflow-prompts">
      <summary><span><DatabaseOutlined /> 模型调用与上下文</span><b>{promptExecutions.length}</b></summary>
      <div className="pb-prompt-call-list">{promptExecutions.slice(-12).reverse().map((execution) => {
        const manifest = execution.contextManifest;
        const sectionReceipts = manifest?.sections ?? [];
        const included = sectionReceipts.filter((section) => section.status === "included").length;
        const excluded = sectionReceipts.filter((section) => section.status !== "included").length;
        return <details key={execution.id} className={`pb-prompt-call is-${execution.status}`}>
          <summary><div><strong>{execution.purpose}</strong><small>{relativeTime(execution.createdAt)} · candidate {execution.candidateIndex + 1}</small></div><span>{manifest?.estimatedInputTokens?.toLocaleString() ?? "—"}<small> tokens</small></span></summary>
          <div className="pb-prompt-call-meta">
            {manifest?.goalId && <Tag color="cyan">目标 {manifest.goalId.slice(-8)}</Tag>}
            {manifest?.maxInputTokens && <Tag>预算 {manifest.maxInputTokens.toLocaleString()}</Tag>}
            {sectionReceipts.length > 0 && <Tag color="green">纳入 {included}</Tag>}
            {excluded > 0 && <Tag color="gold">裁剪 {excluded}</Tag>}
            {execution.errorCategory && <Tag color="red">{execution.errorCategory}</Tag>}
          </div>
          {sectionReceipts.length > 0 && <div className="pb-prompt-sections">{sectionReceipts.map((section) => <div key={`${execution.id}:${section.id}`} className={`is-${section.status}`}><span>{section.title}</span><small>{section.estimatedTokens} t · {section.reason}</small></div>)}</div>}
        </details>;
      })}</div>
    </details>}

    {selectedWorkflowId && <details className="pb-workflow-activity">
      <summary>最近活动 <span>{events.length}</span></summary>
      <EventTimeline events={events.slice(-6)} />
      <code title={selectedWorkflowId}>{selectedWorkflowId}</code>
    </details>}
  </div>;
}

function ChapterInfoPanel({ projectId, documentId, workspace }: { projectId: string; documentId?: string; workspace?: NovelChapterWorkspace }) {
  const versions = useChapterVersionActions(projectId, documentId);
  if (!workspace) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无章节信息" />;
  const blueprint = workspace.spec.blueprint;
  const purpose = typeof blueprint.chapterPurpose === "string" ? blueprint.chapterPurpose : workspace.spec.chapterGoal;
  return <div className="pb-context-info">
    <dl><div><dt>章节目标</dt><dd>{purpose || "未填写"}</dd></div><div><dt>POV</dt><dd>{workspace.document.povCharacterId ?? "未指定"}</dd></div><div><dt>正文版本</dt><dd>{workspace.content ? `r${workspace.content.revision}` : "尚无正文"}</dd></div><div><dt>结构指纹</dt><dd><code>{workspace.spec.blueprintFingerprint ? workspace.spec.blueprintFingerprint.slice(0, 12) : "未绑定"}</code></dd></div></dl>
    <section><header><HistoryOutlined /> 恢复版本</header>{workspace.versions.map((version) => <div key={version.id}><span>{version.label ?? (version.retentionClass === "named" ? "命名版本" : version.retentionClass === "rolling" ? "自动保存" : "工作流定稿")}</span><strong>r{version.revision}</strong>{version.current ? <Tag color="green">当前</Tag> : <Popconfirm title={`恢复到 r${version.revision}？`} description="恢复会创建新的正文版本，当前内容不会立即删除。" onConfirm={() => versions.restore.mutate(version.id)}><Button size="small" type="text" loading={versions.restore.isPending}>恢复</Button></Popconfirm>}{version.retentionClass !== "named" && <Button size="small" type="text" loading={versions.name.isPending} onClick={() => versions.name.mutate({ revisionId: version.id, label: `保留版本 r${version.revision}` })}>长期保留</Button>}<small>{new Date(version.createdAt).toLocaleString()}</small></div>)}</section>
  </div>;
}

function ChapterContextPanel({ projectId, documentId, workspace, state, manuscriptDirty, activeKey, onActiveKeyChange, onLocate, workflow }: { projectId: string; documentId?: string; workspace?: NovelChapterWorkspace; state: ChapterWorkspaceState; manuscriptDirty: boolean; activeKey: string; onActiveKeyChange: (key: string) => void; onLocate: (paragraph: number) => void; workflow: React.ComponentProps<typeof WorkflowInspector> }) {
  const defaultKey = state.mode === "running" || state.mode === "failed" ? "workflow" : state.mode === "planned" ? "info" : "review";
  return <aside className="pb-author-context"><Tabs key={`${documentId}:${defaultKey}`} activeKey={activeKey} onChange={onActiveKeyChange} items={[
    { key: "review", label: "审核", children: <SnapshotReviewPanel projectId={projectId} documentId={documentId} workspace={workspace} state={state} manuscriptDirty={manuscriptDirty} onLocate={onLocate} onRepairStarted={() => onActiveKeyChange("workflow")} /> },
    { key: "workflow", label: "工作流", children: <WorkflowInspector {...workflow} /> },
    { key: "info", label: "章节信息", children: <ChapterInfoPanel projectId={projectId} documentId={documentId} workspace={workspace} /> },
  ]} /></aside>;
}

function AttentionWorkspace({ mode, run, onRetry, onKnowledge }: { mode: "failed" | "stalled"; run?: NovelWorkflowRunRecord; onRetry?: () => void; onKnowledge?: () => void }) {
  const payload = run?.payload ?? {};
  const error = typeof payload.error === "string" ? payload.error : undefined;
  const stage = failedStage(payload, []);
  const stageLabel = STAGE_META.find((item) => item.stage === stage)?.label ?? "章节处理";
  const guidance = !error
    ? mode === "failed" ? "本次运行没有完成，具体技术原因已保留在工作流记录中。" : "可重新发起本章创作，Runtime 会从正式资料与最新章节状态重新开始。"
    : /foreign key|relations?_object|constraint/iu.test(error)
      ? "提交章节关联资料时发生数据一致性冲突。正文定稿仍然保留，可检查创作资料后重新发起。"
      : /memory|context|preflight|记忆|上下文/iu.test(error)
        ? "本章需要的创作资料或记忆不完整。请先检查创作资料，再重新发起。"
        : /model|transport|timeout|gateway|模型|超时/iu.test(error)
          ? "生成服务未能完成本次请求。可稍后重新发起，具体错误已保留在工作流记录中。"
          : "本次运行没有完成。可重新发起创作，具体技术原因已保留在工作流记录中。";
  return <WorkspaceEmpty>
    <span className="pb-author-empty-icon is-danger"><CloseCircleFilled /></span>
    <span className="pb-eyebrow">需要作者处理</span>
    <h3>{mode === "failed" ? `本次创作在“${stageLabel}”未能完成` : "章节没有活跃运行，尚未形成定稿"}</h3>
    <p>{guidance}</p>
    <div className="pb-author-empty-actions"><Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>重新发起创作</Button><Button icon={<DatabaseOutlined />} onClick={onKnowledge}>检查创作资料</Button></div>
  </WorkspaceEmpty>;
}

export interface NovelProductionWorkspaceProps {
  projectId?: string;
  embedded?: boolean;
  documentId?: string;
  workflowId?: string;
  stage?: string;
  onSelectionChange?: (selection: { documentId?: string; workflowId?: string; stage?: string }) => void;
  onStartCreation?: (document: NovelDocumentSummary) => void | Promise<void>;
  onEditChapter?: (document: NovelDocumentSummary) => void;
  onDeleteChapter?: (document: NovelDocumentSummary) => void;
  onOpenKnowledge?: () => void;
}

// ---------- 章节生产工作区 ----------
export default function NovelProductionWorkspace({
  projectId: providedProjectId,
  embedded = false,
  documentId,
  workflowId,
  stage,
  onSelectionChange,
  onStartCreation,
  onEditChapter,
  onDeleteChapter,
  onOpenKnowledge,
}: NovelProductionWorkspaceProps = {}) {
  const { projectId: routeProjectId = "" } = useParams();
  const projectId = providedProjectId ?? routeProjectId;
  const [selectedDocId, setSelectedDocId] = useState<string | undefined>(documentId);
  const [diagnosticWfId, setDiagnosticWfId] = useState<string | undefined>(workflowId);
  const [selectedStage, setSelectedStage] = useState<string | null>(stage ?? null);
  const [viewingArtifact, setViewingArtifact] = useState<ArtifactSummary | null>(null);
  const [activeParagraph, setActiveParagraph] = useState<number>();
  const [manuscriptDirty, setManuscriptDirty] = useState(false);
  const [contextTab, setContextTab] = useState(workflowId || stage ? "workflow" : "review");

  useEffect(() => { if (documentId !== undefined) setSelectedDocId(documentId); }, [documentId]);
  useEffect(() => {
    if (workflowId !== undefined) {
      setDiagnosticWfId(workflowId);
      setContextTab("workflow");
    }
  }, [workflowId]);
  useEffect(() => {
    setSelectedStage(stage ?? null);
    if (stage) setContextTab("workflow");
  }, [stage]);
  useEffect(() => {
    setManuscriptDirty(false);
    setContextTab("review");
  }, [selectedDocId]);

  const projectQ = useNovelProject(projectId);
  const runsQ = useNovelProjectRuns(projectId);
  const runs = runsQ.data ?? projectQ.data?.latestRuns ?? [];
  const chapterRuns = useMemo(() => runs.filter(isChapterWorkflowRun), [runs]);
  const documents = projectQ.data?.documents ?? [];
  const selectedDocument = documents.find((item) => item.id === selectedDocId);
  const workspaceQ = useNovelChapterWorkspace(projectId, selectedDocId);
  const workspaceState = useMemo(() => deriveChapterWorkspaceState(selectedDocument, chapterRuns), [chapterRuns, selectedDocument]);
  const mainWorkflowId = workspaceState.latestRun?.temporalWorkflowId;
  const documentRuns = useMemo(() => chapterRuns.filter((item) => novelRunDocumentId(item) === selectedDocId), [chapterRuns, selectedDocId]);
  const interruptedReviewRun = useMemo(() => findInterruptedChapterReviewRun(selectedDocId, documentRuns), [documentRuns, selectedDocId]);

  const runQ = useNovelRun(mainWorkflowId);
  const run = runQ.data;
  const isActive = run?.status === "running" || run?.status === "manual-review-required" || run?.status === "pending" || run?.status === "accepted";
  const eventsQ = useNovelRunEvents(mainWorkflowId, isActive);
  const artifactsQ = useNovelRunArtifacts(mainWorkflowId, isActive);
  const reviewsQ = useNovelRunReviews(mainWorkflowId, isActive);
  const artifacts = artifactsQ.data ?? [];
  const reviews = reviewsQ.data ?? [];
  const factsQ = useNovelFactCandidates(projectId, selectedDocId);
  const factDecision = useDecideFactCandidate(projectId, selectedDocId);
  const pendingArtifactId = typeof run?.record?.payload?.artifactId === "string" ? run.record.payload.artifactId : undefined;
  const candidateTextQ = useNovelArtifactText(pendingArtifactId);

  useEffect(() => {
    if (workspaceState.mode === "running" || workspaceState.mode === "failed" || workspaceState.mode === "stalled") setContextTab("workflow");
    else if (workspaceState.mode === "planned") setContextTab("info");
    else if (workspaceState.mode === "final") setContextTab("review");
  }, [selectedDocId, workspaceState.mode]);

  const effectiveDiagnosticWfId = diagnosticWfId ?? mainWorkflowId;
  const diagnosticRunQ = useNovelRun(effectiveDiagnosticWfId);
  const diagnosticRun = diagnosticRunQ.data;
  const diagnosticActive = diagnosticRun?.status === "running" || diagnosticRun?.status === "manual-review-required" || diagnosticRun?.status === "pending" || diagnosticRun?.status === "accepted";
  const diagnosticEventsQ = useNovelRunEvents(effectiveDiagnosticWfId, diagnosticActive);
  const diagnosticArtifactsQ = useNovelRunArtifacts(effectiveDiagnosticWfId, diagnosticActive);
  const diagnosticReviewsQ = useNovelRunReviews(effectiveDiagnosticWfId, diagnosticActive);
  const diagnosticPromptsQ = useNovelRunPromptExecutions(effectiveDiagnosticWfId, diagnosticActive);

  useEffect(() => {
    if (selectedDocId) return;
    if (documents[0]) {
      setSelectedDocId(documents[0].id);
      onSelectionChange?.({ documentId: documents[0].id });
    }
  }, [documents, selectedDocId]);

  useEffect(() => {
    if (!selectedDocId) return;
    setDiagnosticWfId(mainWorkflowId);
    setSelectedStage(null);
  }, [mainWorkflowId, selectedDocId]);

  const quality = useMemo(() => deriveQuality(run, artifacts, reviews), [run, artifacts, reviews]);
  const diagnosticArtifacts = diagnosticArtifactsQ.data ?? [];
  const signal = useSignalHumanDecision(projectId, mainWorkflowId);
  const replacePendingArtifact = useReplacePendingArtifact(projectId, mainWorkflowId);
  const gateDecisionRef = useRef<string | undefined>(undefined);
  const cancelRun = useCancelNovelRun(projectId, mainWorkflowId);
  const retryTargetedReview = useStartTargetedChapterRepair(projectId, selectedDocId);
  const [dismissedReviewRunId, setDismissedReviewRunId] = useState<string | undefined>(() => readDismissedReviewRun(projectId));

  useEffect(() => { setDismissedReviewRunId(readDismissedReviewRun(projectId)); }, [projectId]);

  const liveReasonCode = typeof run?.record?.payload?.reasonCode === "string" ? run.record.payload.reasonCode : workspaceState.reasonCode;
  const liveWorkspaceMode: ChapterWorkspaceMode = run?.status === "manual-review-required"
    ? liveReasonCode === "fact-approval-pending" ? "fact-review" : "manuscript-review"
    : workspaceState.mode;

  async function handleCancelRun() {
    try {
      await cancelRun.mutateAsync();
      message.success("已取消本次运行");
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRetryTargetedReview(instruction?: string) {
    const issueIds = Array.isArray(interruptedReviewRun?.payload.targetIssueIds)
      ? interruptedReviewRun.payload.targetIssueIds.filter((value): value is string => typeof value === "string")
      : [];
    if (!issueIds.length) {
      message.error("原定向修复没有可重试的审核意见");
      return;
    }
    try {
      await retryTargetedReview.mutateAsync({ issueIds, instruction });
      setContextTab("workflow");
      message.success(`已按原 ${issueIds.length} 条意见重新发起 AI 定向修复`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleGateDecision(decision: "approve" | "reject" | "revise" | "abandon", feedback?: string, revisionBase?: "current" | "previous") {
    if (!pendingArtifactId) {
      message.error("运行记录缺少待审批 artifactId");
      return;
    }
    const decisionKey = `${mainWorkflowId}:${pendingArtifactId}`;
    if (gateDecisionRef.current === decisionKey) return;
    gateDecisionRef.current = decisionKey;
    try {
      await signal.mutateAsync({ artifactId: pendingArtifactId, decision, feedback, revisionBase });
      message.success(decision === "approve" ? "已批准，Runtime 将继续执行" : decision === "revise" ? revisionBase === "previous" ? "已退回上一版，Runtime 将基于上一版继续修订" : "补充意见已提交，Runtime 将继续修订当前候选" : decision === "abandon" ? "已放弃本次工作流，章节正文保持不变" : "已退回该稿件");
    } catch (err) {
      gateDecisionRef.current = undefined;
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSaveCandidateReplacement(plainText: string) {
    if (!pendingArtifactId) {
      message.error("运行记录缺少待审批 artifactId");
      return;
    }
    try {
      const result = await replacePendingArtifact.mutateAsync({ artifactId: pendingArtifactId, plainText });
      gateDecisionRef.current = undefined;
      message.success(`已保存为本轮候选产物（${result.wordCount.toLocaleString()} 字）`);
      void runQ.refetch();
      void artifactsQ.refetch();
      void reviewsQ.refetch();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  const renderGateWorkspace = () => {
    const gatePayload = run?.record?.payload ?? workspaceState.latestRun?.payload ?? {};
    if (liveWorkspaceMode === "manuscript-review") {
      const targeted = gatePayload.mode === "targeted" || liveReasonCode === "targeted-manuscript-approval";
      const targetIssueIds = Array.isArray(gatePayload.targetIssueIds) ? gatePayload.targetIssueIds.filter((value): value is string => typeof value === "string") : [];
      const candidateArtifact = artifacts.find((artifact) => artifact.id === pendingArtifactId);
      const goal = candidateArtifact?.structuredData?.stageGoal as { authorInstruction?: string; acceptanceCriteria?: string[] } | undefined;
      const alignment = candidateArtifact?.structuredData?.authorAlignment as { satisfied?: boolean; summary?: string; unmetRequirements?: string[] } | undefined;
      const reviseAgain = async (feedback?: string) => {
        if (!targetIssueIds.length) {
          message.error("本次审批记录缺少可继续修复的审核意见");
          return;
        }
        await handleGateDecision("revise", feedback);
      };
      return <CandidateReviewWorkspace text={candidateTextQ.data?.text ?? ""} baseText={workspaceQ.data?.content?.plainText} targeted={targeted} targetIssueCount={targetIssueIds.length} goal={goal} alignment={alignment} loading={candidateTextQ.isLoading} quality={quality} deciding={signal.isPending} revisingAgain={signal.isPending} saving={replacePendingArtifact.isPending} onSaveReplacement={handleSaveCandidateReplacement} onApprove={() => void handleGateDecision("approve")} onAbandon={() => void handleGateDecision("abandon", "作者放弃本次章节审校工作流")} onReviseAgain={targeted ? (feedback) => void reviseAgain(feedback) : undefined} onRevisePrevious={targeted ? (feedback) => void handleGateDecision("revise", feedback, "previous") : undefined} />;
    }
    if (liveWorkspaceMode === "fact-review") return <FactReviewWorkspace candidates={factsQ.data ?? []} loading={factsQ.isLoading} deciding={signal.isPending || factDecision.isPending} onDecide={(claimId, decision) => factDecision.mutate({ claimId, decision })} onContinue={() => void handleGateDecision("approve")} onAbort={() => void handleGateDecision("abandon", "作者放弃本次事实提交")} />;
    return null;
  };

  function selectDocument(next: string) {
    setSelectedDocId(next);
    setSelectedStage(null);
    setActiveParagraph(undefined);
    onSelectionChange?.({ documentId: next, workflowId: undefined, stage: undefined });
  }

  function selectDiagnosticWorkflow(next: string) {
    setDiagnosticWfId(next);
    setSelectedStage(null);
    onSelectionChange?.({ documentId: selectedDocId, workflowId: next, stage: undefined });
  }

  function selectStage(next: string | undefined) {
    setSelectedStage(next ?? null);
    onSelectionChange?.({ documentId: selectedDocId, workflowId: effectiveDiagnosticWfId, stage: next });
  }

  const chapterMeta = CHAPTER_MODE_META[workspaceState.mode];

  function renderAuthorWorkspace() {
    if (!selectedDocument) return <WorkspaceEmpty><span className="pb-author-empty-icon"><FileTextOutlined /></span><h3>选择一个章节开始工作</h3><p>左侧会根据每章当前状态显示需要处理的事项。</p></WorkspaceEmpty>;
    if (workspaceState.mode === "planned") return <PlannedWorkspace document={selectedDocument} onStart={() => onStartCreation?.(selectedDocument)} onDelete={() => onDeleteChapter?.(selectedDocument)} />;
    if (liveWorkspaceMode === "running") return <RunningWorkspace run={workspaceState.latestRun} artifacts={artifacts} reviews={reviews} events={eventsQ.data ?? []} onCancel={() => void handleCancelRun()} cancelling={cancelRun.isPending} />;
    if (liveWorkspaceMode === "manuscript-review" || liveWorkspaceMode === "fact-review") return renderGateWorkspace();
    if (workspaceState.mode === "final") return <>
      {interruptedReviewRun && interruptedReviewRun.temporalWorkflowId !== dismissedReviewRunId && <InterruptedReviewBanner run={interruptedReviewRun} retrying={retryTargetedReview.isPending} onRetry={(instruction) => void handleRetryTargetedReview(instruction)} onOpenReview={() => setContextTab("review")} onDismiss={() => { rememberDismissedReviewRun(projectId, interruptedReviewRun.temporalWorkflowId); setDismissedReviewRunId(interruptedReviewRun.temporalWorkflowId); }} />}
      <FinalWorkspace projectId={projectId} documentId={selectedDocId} workspace={workspaceQ.data} loading={workspaceQ.isLoading} error={workspaceQ.isError} onRefresh={() => void workspaceQ.refetch()} activeParagraph={activeParagraph} onDirtyChange={setManuscriptDirty} onRegenerateFromBlueprint={() => { void onStartCreation?.(selectedDocument); }} />
    </>;
    return <AttentionWorkspace mode={workspaceState.mode === "failed" ? "failed" : "stalled"} run={workspaceState.latestRun} onRetry={() => onStartCreation?.(selectedDocument)} onKnowledge={onOpenKnowledge} />;
  }

  return (
    <div className={`pb-page ${embedded ? "pb-embedded" : ""}`}>
      {!embedded && <motion.header className="pb-topbar" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <div className="pb-topbar-title">
          <h1>章节生产</h1>
          <p>{projectQ.data?.title ?? "未命名作品"}</p>
        </div>
        <div className="pb-topbar-actions">
          <span className="novel-status-pill novel-status-pill-done">revision {projectQ.data?.currentRevision ?? 0}</span>
          <Button icon={<ReloadOutlined />} onClick={() => { void projectQ.refetch(); void runsQ.refetch(); void runQ.refetch(); void eventsQ.refetch(); void artifactsQ.refetch(); }}>刷新</Button>
        </div>
      </motion.header>}

      {projectQ.isError && <Alert type="error" showIcon message="加载项目失败" description={projectQ.error instanceof Error ? projectQ.error.message : undefined} className="pb-alert" />}
      {runsQ.isError && <Alert type="warning" showIcon message="加载运行列表失败" className="pb-alert" />}

      <div className="pb-author-shell">
        <aside className="pb-author-chapters"><ChapterRail documents={documents} runs={chapterRuns} selectedId={selectedDocId} onSelect={selectDocument} /></aside>
        <main className="pb-author-main">
          <header className="pb-author-header">
            <div><span className="pb-eyebrow">{selectedDocument?.arcTitle ?? "章节工作台"}</span><h2>{selectedDocument?.title ?? "未选择章节"}</h2></div>
            <div className="pb-author-meta">
              {selectedDocument?.wordCount ? <span>{selectedDocument.wordCount.toLocaleString()} 字</span> : null}
              {selectedDocument?.latestRevision ? <span>修订 {selectedDocument.latestRevision}</span> : null}
              <span className={`pb-author-state is-${chapterMeta.tone}`}>{chapterMeta.label}</span>
              {selectedDocument && <Button icon={<EditOutlined />} onClick={() => onEditChapter?.(selectedDocument)}>编辑章节信息</Button>}
              {documentRuns.length > 0 && <Button icon={<RocketOutlined />} onClick={() => { setDiagnosticWfId(mainWorkflowId); setContextTab("workflow"); }}>查看工作流</Button>}
            </div>
          </header>
          <div className="pb-author-content">
            <section className="pb-author-canvas">{renderAuthorWorkspace()}</section>
            <ChapterContextPanel
              projectId={projectId}
              documentId={selectedDocId}
              workspace={workspaceQ.data}
              state={workspaceState}
              manuscriptDirty={manuscriptDirty}
              activeKey={contextTab}
              onActiveKeyChange={setContextTab}
              onLocate={setActiveParagraph}
              workflow={{
                runs: documentRuns,
                selectedWorkflowId: effectiveDiagnosticWfId,
                run: diagnosticRun,
                document: selectedDocument,
                artifacts: diagnosticArtifacts,
                reviews: diagnosticReviewsQ.data ?? [],
                events: diagnosticEventsQ.data ?? [],
                promptExecutions: diagnosticPromptsQ.data ?? [],
                selectedStage,
                latestWorkflowId: mainWorkflowId,
                onSelectWorkflow: selectDiagnosticWorkflow,
                onSelectStage: (next) => selectStage(next),
                onViewArtifact: setViewingArtifact,
              }}
            />
          </div>
        </main>
      </div>

      {viewingArtifact && <ArtifactContentModal artifact={viewingArtifact} open={Boolean(viewingArtifact)} onClose={() => setViewingArtifact(null)} />}
    </div>
  );
}
