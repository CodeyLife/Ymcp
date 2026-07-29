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
import { Alert, Button, Drawer, Empty, Input, Popconfirm, Progress, Segmented, Select, Tag, message } from "antd";
import {
  AuditOutlined,
  CheckCircleFilled,
  CheckOutlined,
  ClockCircleOutlined,
  CloseCircleFilled,
  CloseOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  LoadingOutlined,
  ReloadOutlined,
  RocketOutlined,
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
  useNovelArtifactText,
  useNovelDocumentContent,
  useNovelFactCandidates,
  useNovelProject,
  useNovelProjectRuns,
  useNovelRun,
  useNovelRunArtifacts,
  useNovelRunEvents,
  useNovelRunReviews,
  useSignalHumanDecision,
  useSubmitChapterReview,
  isChapterWorkflowRun,
  novelRunDocumentId,
  type NovelArtifactSummary,
  type NovelDocumentSummary,
  type NovelReviewSummary,
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
const RUN_ACTIVE_STATUSES = new Set(["running", "pending", "accepted", "paused"]);

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
  if (latestRun && RUN_FAILURE_STATUSES.has(latestRun.status)) return { mode: "failed", latestRun, reasonCode };
  if (document.status === "final") return { mode: "final", latestRun, reasonCode };
  if (document.status === "planned" && !latestRun) return { mode: "planned" };
  return { mode: "stalled", latestRun, reasonCode };
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

function artifactStage(artifact: NovelArtifactSummary): WorkflowStage | undefined {
  if (artifact.kind === "chapter-blueprint") return "blueprint";
  if (artifact.kind === "draft") return "draft";
  if (artifact.kind === "review" || artifact.kind === "summary") return "review";
  if (artifact.kind === "revision") return "revision";
  if (artifact.kind === "fact-extraction") return "fact-extraction";
  return normalizeStageKey(artifact.taskId);
}

function failedStage(payload: Record<string, unknown>, artifacts: NovelArtifactSummary[]): WorkflowStage {
  const explicit = normalizeStageKey(typeof payload.stage === "string" ? payload.stage : undefined);
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
  const activeStage = normalizeStageKey(typeof payload.stage === "string" ? payload.stage : undefined);
  const reasonCode = typeof payload.reasonCode === "string" ? payload.reasonCode : undefined;

  if (status === "completed" || status === "succeeded") {
    order.forEach((s) => (states[s] = "done"));
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

function PipelineTracker({ states, selected, onSelect }: { states: Record<string, StageNodeStatus>; selected: string | null; onSelect: (s: string) => void }) {
  const doneCount = STAGE_META.filter((m) => states[m.stage] === "done").length;
  const pct = Math.round((doneCount / STAGE_META.length) * 100);
  return (
    <section className="pb-tracker" aria-label="创作流水线进度">
      <div className="pb-tracker-head">
        <span className="pb-eyebrow">创作流水线</span>
        <span className="pb-tracker-progress">{doneCount}/{STAGE_META.length} 阶段 · {pct}%</span>
      </div>
      <div className="pb-track">
        {STAGE_META.map((meta: StageMeta, i: number) => {
          const status = states[meta.stage] ?? "pending";
          const prevDone = i === 0 ? false : states[STAGE_META[i - 1].stage] === "done";
          return (
            <div key={meta.stage} className="pb-track-seg">
              {i > 0 && <span className={`pb-connector ${prevDone ? "is-done" : ""}`} aria-hidden />}
              <button
                type="button"
                className={`pb-node is-${meta.category} is-${status} ${selected === meta.stage ? "is-selected" : ""}`}
                onClick={() => onSelect(meta.stage)}
                title={meta.description}
              >
                <span className="pb-node-icon"><StageIcon status={status} /></span>
                <span className="pb-node-label">{meta.label}</span>
                <span className="pb-node-index">{meta.index}</span>
              </button>
            </div>
          );
        })}
      </div>
      <Progress percent={pct} showInfo={false} strokeColor="var(--color-accent)" className="pb-progress" />
    </section>
  );
}

function QualityPanel({ quality }: { quality: QualityData }) {
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
  if (run.status === "completed" || run.status === "succeeded") return <Alert type="success" showIcon message={document?.status === "final" ? "本次运行已完成，章节已经定稿" : "本次运行已完成"} description="流水线中的审批节点是历史执行记录，无需再次点击批准。" />;
  if (run.status === "manual-review-required") return null;
  const stage = normalizeStageKey(typeof payload.stage === "string" ? payload.stage : undefined);
  return <Alert type="info" showIcon message={`运行${statusMeta(run.status).label}`} description={stage ? `当前正在执行“${STAGE_META.find((item) => item.stage === stage)?.label ?? stage}”，完成后会自动刷新。` : "Runtime 已受理任务，正在准备执行上下文。"} />;
}

/** 章节正文工作台：查看 / tiptap 编辑 / 修订前后对比 / 提交审校 */
function ManuscriptWorkbench({ projectId, documentId }: { projectId: string; documentId?: string }) {
  const { data, isLoading, isError, refetch } = useNovelDocumentContent(projectId, documentId);
  const [mode, setMode] = useState<"read" | "edit" | "diff">("read");
  const [edited, setEdited] = useState("");
  const submit = useSubmitChapterReview(projectId, documentId);
  const original = data?.plainText ?? "";
  const dirty = edited.trim().length > 0 && edited !== original;

  // 章节或定稿变化时重置编辑态
  useEffect(() => {
    setEdited(original);
    setMode("read");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, data?.contentHash]);

  async function handleSubmit() {
    try {
      await submit.mutateAsync({ proposedText: edited });
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
          {data && <Tag>{documentStatusMeta(data.status).label} · r{data.revision}</Tag>}
          {data && (
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
          {mode !== "read" && dirty && (
            <Button size="small" type="primary" loading={submit.isPending} onClick={() => void handleSubmit()}>提交审校</Button>
          )}
        </span>
      </header>
      {isLoading && <div className="pb-loading"><LoadingOutlined /> 加载正文…</div>}
      {!isLoading && isError && <Alert type="error" showIcon message="正文暂时无法读取" description="Runtime 未能从统一对象存储取得本章定稿，请重试；持续失败时可在运行详情中查看诊断信息。" action={<Button size="small" onClick={() => void refetch()}>重试</Button>} />}
      {!isLoading && !isError && !data && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={documentId ? "当前章节尚无可读取的正文" : "选择左侧章节查看正文"} />}
      {data && mode === "read" && <div className="pb-manuscript">{original || <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="正文为空" />}</div>}
      {data && mode === "edit" && <ManuscriptEditor key={data.contentHash} value={edited || original} onChange={setEdited} minHeight={440} />}
      {data && mode === "diff" && <TextDiff baseText={original} newText={edited} baseLabel="当前定稿" newLabel="我的修改" emptyText="尚未做任何修改（切到「编辑」修改后再来对比）" />}
    </section>
  );
}

/** 修订前后对比：初稿 artifact vs 最新修订 artifact（当前 run 存在修订时显示） */
function RevisionDiffCard({ artifacts }: { artifacts: NovelArtifactSummary[] }) {
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
                  <span className="pb-chapter-name">{doc.title}</span>
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

function RunRail({ runs, selectedWfId, onSelect }: { runs: NovelWorkflowRunRecord[]; selectedWfId?: string; onSelect: (wfId: string) => void }) {
  const list = useMemo(() => [...runs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 20), [runs]);
  return (
    <section className="pb-card pb-rail">
      <header className="pb-card-head"><span className="pb-card-title"><RocketOutlined /> 运行</span></header>
      {list.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无运行记录" />}
      <ul className="pb-run-list">
        {list.map((r) => {
          const meta = statusMeta(r.status);
          return (
            <li key={r.id}>
              <button type="button" className={`pb-run ${selectedWfId === r.temporalWorkflowId ? "is-selected" : ""}`} onClick={() => onSelect(r.temporalWorkflowId)}>
                <span className="pb-run-icon">{meta.icon}</span>
                <span className="pb-run-body">
                  <span className="pb-run-type">{r.workflowType === "chapter-review" ? "章节审校" : r.workflowType === "creative-run" ? "创意执行" : "创作意图"}</span>
                  <span className="pb-run-time">{relativeTime(r.updatedAt)}</span>
                </span>
                <span className={meta.pill}>{meta.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function chapterProgress(run: NovelWorkflowRunRecord | undefined) {
  const raw = typeof run?.payload.stage === "string" ? run.payload.stage : undefined;
  const stage = normalizeStageKey(raw);
  if (stage === "context" || stage === "blueprint" || stage === "blueprint-approval") return { index: 0, title: "正在准备章节方案", next: "完成后将开始生成正文" };
  if (stage === "draft") return { index: 1, title: "正在创作正文", next: "正文完成后会自动进入专业审校" };
  if (stage === "review" || stage === "revision" || stage === "manuscript-approval") return { index: 2, title: "正在审校与修订", next: "达到质量要求后将整理事实并定稿" };
  if (stage === "fact-extraction" || stage === "fact-approval" || stage === "commit" || stage === "character-enrichment") return { index: 3, title: "正在整理并提交定稿", next: "完成后正文会自动更新" };
  return { index: 0, title: "Runtime 已接收创作任务", next: "正在加载创作所需的资料与记忆" };
}

function WorkspaceEmpty({ children }: { children: React.ReactNode }) {
  return <section className="pb-author-empty">{children}</section>;
}

function PlannedWorkspace({ document, onStart, onEdit, onDelete }: { document: NovelDocumentSummary; onStart?: () => void; onEdit?: () => void; onDelete?: () => void }) {
  return <WorkspaceEmpty>
    <span className="pb-author-empty-icon"><FileTextOutlined /></span>
    <span className="pb-eyebrow">章节目标已就绪</span>
    <h3>从本章的创作意图开始</h3>
    <p>{document.arcTitle ?? "尚未归属故事弧"}{document.povCharacterId ? ` · POV ${document.povCharacterId}` : ""}</p>
    <div className="pb-author-empty-actions">
      <Button type="primary" icon={<RocketOutlined />} onClick={onStart}>开始创作</Button>
      <Button onClick={onEdit}>编辑章节信息</Button>
      <Button danger onClick={onDelete}>删除章节</Button>
    </div>
  </WorkspaceEmpty>;
}

function RunningWorkspace({ run }: { run?: NovelWorkflowRunRecord }) {
  const progress = chapterProgress(run);
  const phases = ["准备", "创作", "审校", "定稿"];
  return <section className="pb-author-running">
    <div className="pb-running-copy"><LoadingOutlined /><div><span className="pb-eyebrow">创作进行中</span><h3>{progress.title}</h3><p>{progress.next}</p></div></div>
    <div className="pb-author-progress" aria-label={`当前进度：${phases[progress.index]}`}>
      {phases.map((phase, index) => <div key={phase} className={index < progress.index ? "is-done" : index === progress.index ? "is-active" : ""}><span>{index < progress.index ? <CheckOutlined /> : index + 1}</span><strong>{phase}</strong></div>)}
    </div>
    <small>最近更新于 {relativeTime(run?.updatedAt)}</small>
  </section>;
}

function CandidateReviewWorkspace({ text, loading, quality, onApprove, onReject, deciding }: { text: string; loading: boolean; quality: QualityData; onApprove: () => void; onReject: (feedback: string) => void; deciding: boolean }) {
  const [activeIssue, setActiveIssue] = useState<number>();
  const [feedback, setFeedback] = useState("");
  const paragraphRefs = useRef<Array<HTMLParagraphElement | null>>([]);
  const paragraphs = useMemo(() => text.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean), [text]);
  const issueParagraphs = useMemo(() => quality.issues.map((issue) => {
    const needle = (issue.excerpt ?? "").replace(/\s+/gu, "").slice(0, 60);
    return needle ? paragraphs.findIndex((paragraph) => paragraph.replace(/\s+/gu, "").includes(needle)) : -1;
  }), [paragraphs, quality.issues]);
  const hasSeriousIssue = quality.issues.some((issue) => issue.severity === "blocker" || issue.severity === "major");

  function focusIssue(index: number) {
    setActiveIssue(index);
    const paragraphIndex = issueParagraphs[index];
    if (paragraphIndex >= 0) paragraphRefs.current[paragraphIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return <div className="pb-review-workspace">
    <section className="pb-review-manuscript">
      <header><div><span className="pb-eyebrow">候选正文</span><h3>审阅当前修订稿</h3></div>{quality.overall != null && <strong className="pb-review-score">{quality.overall.toFixed(1)}<small>/5</small></strong>}</header>
      {loading ? <div className="pb-loading"><LoadingOutlined /> 加载候选正文…</div> : paragraphs.length ? <div className="pb-review-text">{paragraphs.map((paragraph, index) => <p key={index} ref={(node) => { paragraphRefs.current[index] = node; }} className={activeIssue !== undefined && issueParagraphs[activeIssue] === index ? "is-highlighted" : ""}>{paragraph}</p>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="候选正文尚未就绪" />}
    </section>
    <aside className="pb-review-issues">
      <header><div><span className="pb-eyebrow">审校意见</span><h3>{quality.issues.length} 个问题需要判断</h3></div></header>
      {quality.issues.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有结构化问题记录" />}
      <div className="pb-review-issue-list">{quality.issues.map((issue, index) => <button type="button" key={`${issue.title ?? issue.rule}-${index}`} className={`pb-review-issue is-${issue.severity} ${activeIssue === index ? "is-active" : ""}`} onClick={() => focusIssue(index)}>
        <span>{issue.severity === "blocker" ? "阻断" : issue.severity === "major" ? "严重" : "提示"}</span><strong>{issue.title ?? issue.rule ?? "审校问题"}</strong>{issue.suggestion && <small>{issue.suggestion}</small>}
      </button>)}</div>
      <div className="pb-review-feedback"><label htmlFor="pb-review-feedback">退回意见</label><Input.TextArea id="pb-review-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={4} placeholder="说明需要修改的位置、原因和预期效果" /></div>
    </aside>
    <footer className="pb-review-actions">
      <span>批准会接受当前候选稿并继续事实提取与正式提交。</span>
      <div>
        <Button danger icon={<CloseOutlined />} disabled={!feedback.trim()} loading={deciding} onClick={() => onReject(feedback.trim())}>退回修改</Button>
        {hasSeriousIssue ? <Popconfirm title="仍有严重审校问题" description="确认以作者判断接受当前稿并继续定稿？" okText="仍然接受" cancelText="继续审阅" onConfirm={onApprove}><Button type="primary" icon={<CheckOutlined />} loading={deciding}>接受当前稿并定稿</Button></Popconfirm> : <Button type="primary" icon={<CheckOutlined />} loading={deciding} onClick={onApprove}>接受当前稿并定稿</Button>}
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

function FinalWorkspace({ projectId, documentId, quality, artifacts }: { projectId: string; documentId?: string; quality: QualityData; artifacts: NovelArtifactSummary[] }) {
  const [view, setView] = useState<"manuscript" | "review">("manuscript");
  return <div className="pb-final-workspace">
    <Segmented value={view} onChange={(value) => setView(value as "manuscript" | "review")} options={[{ value: "manuscript", label: "定稿正文" }, { value: "review", label: "最近审校" }]} />
    {view === "manuscript" ? <ManuscriptWorkbench projectId={projectId} documentId={documentId} /> : <><QualityPanel quality={quality} /><RevisionDiffCard artifacts={artifacts} /></>}
  </div>;
}

function AttentionWorkspace({ mode, run, onRetry, onKnowledge }: { mode: "failed" | "stalled"; run?: NovelWorkflowRunRecord; onRetry?: () => void; onKnowledge?: () => void }) {
  const payload = run?.payload ?? {};
  const error = typeof payload.error === "string" ? payload.error : undefined;
  const stage = failedStage(payload, []);
  const stageLabel = STAGE_META.find((item) => item.stage === stage)?.label ?? "章节处理";
  const guidance = !error
    ? mode === "failed" ? "本次运行没有完成，具体技术原因已保留在运行详情中。" : "可重新发起本章创作，Runtime 会从正式资料与最新章节状态重新开始。"
    : /foreign key|relations?_object|constraint/iu.test(error)
      ? "提交章节关联资料时发生数据一致性冲突。正文定稿仍然保留，可检查创作资料后重新发起。"
      : /memory|context|preflight|记忆|上下文/iu.test(error)
        ? "本章需要的创作资料或记忆不完整。请先检查创作资料，再重新发起。"
        : /model|transport|timeout|gateway|模型|超时/iu.test(error)
          ? "生成服务未能完成本次请求。可稍后重新发起，具体错误已保留在运行详情中。"
          : "本次运行没有完成。可重新发起创作，具体技术原因已保留在运行详情中。";
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
  onStartCreation?: (document: NovelDocumentSummary) => void;
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
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(Boolean(workflowId || stage));

  useEffect(() => { if (documentId !== undefined) setSelectedDocId(documentId); }, [documentId]);
  useEffect(() => {
    if (workflowId !== undefined) {
      setDiagnosticWfId(workflowId);
      setDiagnosticsOpen(true);
    }
  }, [workflowId]);
  useEffect(() => {
    setSelectedStage(stage ?? null);
    if (stage) setDiagnosticsOpen(true);
  }, [stage]);

  const projectQ = useNovelProject(projectId);
  const runsQ = useNovelProjectRuns(projectId);
  const runs = runsQ.data ?? projectQ.data?.latestRuns ?? [];
  const chapterRuns = useMemo(() => runs.filter(isChapterWorkflowRun), [runs]);
  const documents = projectQ.data?.documents ?? [];
  const selectedDocument = documents.find((item) => item.id === selectedDocId);
  const workspaceState = useMemo(() => deriveChapterWorkspaceState(selectedDocument, chapterRuns), [chapterRuns, selectedDocument]);
  const mainWorkflowId = workspaceState.latestRun?.temporalWorkflowId;
  const documentRuns = useMemo(() => chapterRuns.filter((item) => novelRunDocumentId(item) === selectedDocId), [chapterRuns, selectedDocId]);

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

  const effectiveDiagnosticWfId = diagnosticWfId ?? mainWorkflowId;
  const diagnosticRunQ = useNovelRun(effectiveDiagnosticWfId);
  const diagnosticRun = diagnosticRunQ.data;
  const diagnosticActive = diagnosticRun?.status === "running" || diagnosticRun?.status === "manual-review-required" || diagnosticRun?.status === "pending" || diagnosticRun?.status === "accepted";
  const diagnosticEventsQ = useNovelRunEvents(effectiveDiagnosticWfId, diagnosticActive);
  const diagnosticArtifactsQ = useNovelRunArtifacts(effectiveDiagnosticWfId, diagnosticActive);
  const diagnosticReviewsQ = useNovelRunReviews(effectiveDiagnosticWfId, diagnosticActive);

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
  const diagnosticStageStates = useMemo(() => deriveStageStates(diagnosticRun, diagnosticArtifacts), [diagnosticArtifacts, diagnosticRun]);
  const signal = useSignalHumanDecision(mainWorkflowId);

  async function handleGateDecision(decision: "approve" | "reject", feedback?: string) {
    if (!pendingArtifactId) {
      message.error("运行记录缺少待审批 artifactId");
      return;
    }
    try {
      await signal.mutateAsync({ artifactId: pendingArtifactId, decision, feedback });
      message.success(decision === "approve" ? "已批准，Runtime 将继续执行" : "已退回该稿件");
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  function selectDocument(next: string) {
    setSelectedDocId(next);
    setDiagnosticsOpen(false);
    setSelectedStage(null);
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

  const selectedStageMeta = selectedStage ? STAGE_META.find((item) => item.stage === selectedStage) : undefined;
  const selectedStageArtifacts = selectedStage ? artifactsForStage(selectedStage, diagnosticArtifacts) : [];
  const chapterMeta = CHAPTER_MODE_META[workspaceState.mode];

  function renderAuthorWorkspace() {
    if (!selectedDocument) return <WorkspaceEmpty><span className="pb-author-empty-icon"><FileTextOutlined /></span><h3>选择一个章节开始工作</h3><p>左侧会根据每章当前状态显示需要处理的事项。</p></WorkspaceEmpty>;
    if (workspaceState.mode === "planned") return <PlannedWorkspace document={selectedDocument} onStart={() => onStartCreation?.(selectedDocument)} onEdit={() => onEditChapter?.(selectedDocument)} onDelete={() => onDeleteChapter?.(selectedDocument)} />;
    if (workspaceState.mode === "running") return <RunningWorkspace run={workspaceState.latestRun} />;
    if (workspaceState.mode === "manuscript-review") return <CandidateReviewWorkspace text={candidateTextQ.data?.text ?? ""} loading={candidateTextQ.isLoading} quality={quality} deciding={signal.isPending} onApprove={() => void handleGateDecision("approve")} onReject={(feedback) => void handleGateDecision("reject", feedback)} />;
    if (workspaceState.mode === "fact-review") return <FactReviewWorkspace candidates={factsQ.data ?? []} loading={factsQ.isLoading} deciding={signal.isPending || factDecision.isPending} onDecide={(claimId, decision) => factDecision.mutate({ claimId, decision })} onContinue={() => void handleGateDecision("approve")} onAbort={() => void handleGateDecision("reject", "作者放弃本次事实提交")} />;
    if (workspaceState.mode === "final") return <FinalWorkspace projectId={projectId} documentId={selectedDocId} quality={quality} artifacts={artifacts} />;
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
              {documentRuns.length > 0 && <Button onClick={() => { setDiagnosticWfId(mainWorkflowId); setDiagnosticsOpen(true); }}>运行详情</Button>}
            </div>
          </header>
          {renderAuthorWorkspace()}
        </main>
      </div>

      <Drawer title="运行详情" width={720} open={diagnosticsOpen} onClose={() => { setDiagnosticsOpen(false); onSelectionChange?.({ documentId: selectedDocId, workflowId: undefined, stage: undefined }); }} destroyOnHidden>
        <div className="pb-diagnostics">
          <RunRail runs={documentRuns} selectedWfId={effectiveDiagnosticWfId} onSelect={selectDiagnosticWorkflow} />
          <PipelineTracker states={diagnosticStageStates} selected={selectedStage} onSelect={(value) => selectStage(selectedStage === value ? undefined : value)} />
          <RunStatusPanel run={diagnosticRun} document={selectedDocument} superseded={Boolean(effectiveDiagnosticWfId && effectiveDiagnosticWfId !== mainWorkflowId)} />
          {effectiveDiagnosticWfId && <div className="pb-diagnostic-id"><span>Workflow ID</span><code>{effectiveDiagnosticWfId}</code></div>}
          {selectedStageMeta && <StageDetail meta={selectedStageMeta} status={diagnosticStageStates[selectedStageMeta.stage] ?? "pending"} artifacts={selectedStageArtifacts} onView={setViewingArtifact} />}
          <section className="pb-card pb-diagnostic-artifacts"><header className="pb-card-head"><span className="pb-card-title">阶段产物</span><Tag>{diagnosticArtifacts.length}</Tag></header><div>{diagnosticArtifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={toArtifactSummary(artifact)} onView={setViewingArtifact} />)}{diagnosticArtifacts.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无产物" />}</div></section>
          <section className="pb-card pb-diagnostic-reviews"><header className="pb-card-head"><span className="pb-card-title">原始审校记录</span><Tag>{diagnosticReviewsQ.data?.length ?? 0}</Tag></header><div>{diagnosticReviewsQ.data?.map((review) => <article key={review.id}><strong>{review.role ?? review.reviewerId}</strong><span>{review.verdict} · {review.score?.toFixed(1) ?? "—"}/5</span><small>{review.issues.length} 个问题</small></article>)}</div></section>
          <EventTimeline events={diagnosticEventsQ.data ?? []} />
        </div>
      </Drawer>

      {viewingArtifact && <ArtifactContentModal artifact={viewingArtifact} open={Boolean(viewingArtifact)} onClose={() => setViewingArtifact(null)} />}
    </div>
  );
}
