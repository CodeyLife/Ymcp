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

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "motion/react";
import { Alert, Button, Empty, Input, Progress, Segmented, Tag, message } from "antd";
import {
  ArrowLeftOutlined,
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
import { describeEvent, documentStatusMeta, relativeTime, shortId, statusMeta, type EventCategory } from "./presentation";
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
  useSignalHumanDecision,
  useSubmitChapterReview,
  type NovelArtifactSummary,
  type NovelDocumentSummary,
  type NovelRunEvent,
  type NovelRunState,
  type NovelWorkflowRunRecord,
} from "@/lib/novelApi";
import "./pipeline-board.css";
import "./manuscript-tools.css";

type StageNodeStatus = "done" | "active" | "pending" | "gate" | "failed";

/** EventCategory（中文）→ 事件点配色 class key */
const EVENT_CATEGORY_CLASS: Record<EventCategory, string> = { 运行: "run", 任务: "task", 产物: "artifact", 记忆: "memory", 学习: "learning", 文档: "doc", 其他: "default" };

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

/** 由 run 状态 + 产物推导 11 阶段状态（防御式：字段缺失时退化为 pending） */
function deriveStageStates(run: NovelRunState | undefined, artifacts: NovelArtifactSummary[]): Record<string, StageNodeStatus> {
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
    const lastIdx = activeStage ? order.indexOf(activeStage) : -1;
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

function deriveQuality(run: NovelRunState | undefined, artifacts: NovelArtifactSummary[]): QualityData {
  const reviewArtifacts = artifacts.filter((a) => a.kind === "review");
  const issues: QualityIssue[] = [];
  const dimScores: Record<string, number[]> = {};
  let overallFromArtifact: number | null = null;

  for (const a of reviewArtifacts) {
    const sd = (a.structuredData ?? {}) as Record<string, unknown>;
    issues.push(...parseIssues(sd.issues));
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
  const overall = finalScore ?? overallFromArtifact;

  const dims = QUALITY_DIMENSIONS.map((d) => {
    const arr = dimScores[d.key];
    if (arr && arr.length) return { key: d.key, label: d.label, score: arr.reduce((a, b) => a + b, 0) / arr.length };
    // 退化为按该维度 issue 扣分（blocker*2 + major*1 + warning*0.3）
    const dimIssues = issues.filter((i) => i.dimension === d.key);
    if (!dimIssues.length) return { key: d.key, label: d.label, score: null as number | null };
    const penalty = dimIssues.reduce((acc, i) => acc + (i.severity === "blocker" ? 2 : i.severity === "major" ? 1 : 0.3), 0);
    return { key: d.key, label: d.label, score: Math.max(0, 5 - penalty) };
  });

  return { overall, dims, issues, reviewCount: reviewArtifacts.length };
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

function GateBanner({ run, onDecide, deciding }: { run: NovelRunState; onDecide: (d: "approve" | "reject", feedback?: string) => void; deciding: boolean }) {
  const [feedback, setFeedback] = useState("");
  const payload = (run.record?.payload ?? {}) as Record<string, unknown>;
  const reasonCode = typeof payload.reasonCode === "string" ? payload.reasonCode : "quality-gate-not-passed";
  const isFact = reasonCode === "fact-approval-pending";
  const pendingIds = Array.isArray(payload.pendingIds) ? (payload.pendingIds as string[]) : [];
  return (
    <motion.section className={`pb-gate ${isFact ? "is-fact" : "is-quality"}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="pb-gate-icon">{isFact ? <DatabaseOutlined /> : <AuditOutlined />}</div>
      <div className="pb-gate-body">
        <h3>{isFact ? "等待事实审批" : "等待正文审批"}</h3>
        <p>{isFact ? `检测到 ${pendingIds.length} 条待确认事实，需作者决定后方可提交。` : "审校门禁未通过，需作者决定批准进入事实提取，或退回继续修订。"}</p>
        <Input.TextArea value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="审批意见（可选）" rows={2} className="pb-gate-feedback" />
      </div>
      <div className="pb-gate-actions">
        <Button type="primary" icon={<CheckOutlined />} loading={deciding} onClick={() => onDecide("approve", feedback || undefined)}>批准</Button>
        <Button danger icon={<CloseOutlined />} loading={deciding} onClick={() => onDecide("reject", feedback || undefined)}>退回</Button>
      </div>
    </motion.section>
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
        {quality.reviewCount > 0 && <Tag>{quality.reviewCount} 组审校</Tag>}
      </header>
      <div className="pb-quality">
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
      </div>
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
      {quality.reviewCount === 0 && quality.issues.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无审校数据" />}
    </section>
  );
}

/** 章节正文工作台：查看 / tiptap 编辑 / 修订前后对比 / 提交审校 */
function ManuscriptWorkbench({ projectId, documentId }: { projectId: string; documentId?: string }) {
  const { data, isLoading } = useNovelDocumentContent(projectId, documentId);
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
      {!isLoading && !data && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择左侧章节查看正文" />}
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

function FactsPanel({ projectId, documentId }: { projectId: string; documentId?: string }) {
  const { data: candidates = [], isLoading } = useNovelFactCandidates(projectId, documentId);
  const decide = useDecideFactCandidate(projectId, documentId);
  if (!documentId) return null;
  return (
    <section className="pb-card">
      <header className="pb-card-head">
        <span className="pb-card-title"><DatabaseOutlined /> 事实候选</span>
        <Tag color={candidates.length ? "gold" : "default"}>{candidates.length} 待审批</Tag>
      </header>
      {isLoading && <div className="pb-loading"><LoadingOutlined /> 加载事实候选…</div>}
      {!isLoading && candidates.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待审批事实" />}
      <ul className="pb-fact-list">
        {candidates.map((c) => (
          <li key={c.id} className="pb-fact">
            <div className="pb-fact-body">
              <div className="pb-fact-title">{c.title}</div>
              <div className="pb-fact-content">{c.content}</div>
              <div className="pb-fact-meta">置信度 {(c.confidence * 100).toFixed(0)}%</div>
            </div>
            <div className="pb-fact-actions">
              <Button size="small" type="primary" ghost icon={<CheckOutlined />} loading={decide.isPending && decide.variables?.claimId === c.id} onClick={() => decide.mutate({ claimId: c.id, decision: "approve" })}>批准</Button>
              <Button size="small" danger icon={<CloseOutlined />} loading={decide.isPending && decide.variables?.claimId === c.id} onClick={() => decide.mutate({ claimId: c.id, decision: "reject" })}>拒绝</Button>
            </div>
          </li>
        ))}
      </ul>
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

function ChapterRail({ documents, selectedId, onSelect }: { documents: NovelDocumentSummary[]; selectedId?: string; onSelect: (id: string) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, NovelDocumentSummary[]>();
    for (const doc of [...documents].sort((a, b) => a.narrativeOrder - b.narrativeOrder)) {
      const key = doc.arcId ?? "__none__";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(doc);
    }
    return [...map.entries()];
  }, [documents]);
  return (
    <section className="pb-card pb-rail">
      <header className="pb-card-head"><span className="pb-card-title"><FileTextOutlined /> 章节</span></header>
      {documents.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无章节" />}
      {groups.map(([arcId, docs]) => (
        <div key={arcId} className="pb-arc-group">
          {docs[0]?.arcTitle && <div className="pb-arc-title">{docs[0].arcTitle}</div>}
          <ul className="pb-chapter-list">
            {docs.map((doc) => (
              <li key={doc.id}>
                <button type="button" className={`pb-chapter ${selectedId === doc.id ? "is-selected" : ""}`} onClick={() => onSelect(doc.id)}>
                  <span className="pb-chapter-num">{doc.narrativeOrder}</span>
                  <span className="pb-chapter-name">{doc.title}</span>
                  <span className={`pb-chapter-status ${documentStatusMeta(doc.status).pill}`}>{documentStatusMeta(doc.status).label}</span>
                </button>
              </li>
            ))}
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

// ---------- 主页面 ----------
export default function NovelPipelineBoard() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [selectedDocId, setSelectedDocId] = useState<string>();
  const [selectedWfId, setSelectedWfId] = useState<string>();
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [viewingArtifact, setViewingArtifact] = useState<ArtifactSummary | null>(null);

  const projectQ = useNovelProject(projectId);
  const runsQ = useNovelProjectRuns(projectId);

  const runs = runsQ.data ?? projectQ.data?.latestRuns ?? [];

  // 默认选中最新运行
  useEffect(() => {
    if (selectedWfId) return;
    const latest = [...runs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    if (latest) setSelectedWfId(latest.temporalWorkflowId);
  }, [runs, selectedWfId]);

  const runQ = useNovelRun(selectedWfId);
  const run = runQ.data;
  const isActive = run?.status === "running" || run?.status === "manual-review-required" || run?.status === "pending" || run?.status === "accepted";
  const eventsQ = useNovelRunEvents(selectedWfId, isActive);
  const artifactsQ = useNovelRunArtifacts(selectedWfId, isActive);
  const events = eventsQ.data ?? [];
  const artifacts = artifactsQ.data ?? [];

  const documents = projectQ.data?.documents ?? [];
  useEffect(() => {
    if (selectedDocId) return;
    if (documents[0]) setSelectedDocId(documents[0].id);
  }, [documents, selectedDocId]);

  const stageStates = useMemo(() => deriveStageStates(run, artifacts), [run, artifacts]);
  const quality = useMemo(() => deriveQuality(run, artifacts), [run, artifacts]);

  const signal = useSignalHumanDecision(selectedWfId);
  const pendingArtifactId = typeof run?.record?.payload?.artifactId === "string" ? (run.record.payload.artifactId as string) : undefined;

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

  const selectedStageMeta = selectedStage ? STAGE_META.find((m) => m.stage === selectedStage) : undefined;
  const statusInfo = statusMeta(run?.status);

  return (
    <div className="pb-page">
      <motion.header className="pb-topbar" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/novels/${encodeURIComponent(projectId)}`)}>返回工作室</Button>
        <div className="pb-topbar-title">
          <h1>创作流水线指挥中心</h1>
          <p>{projectQ.data?.title ?? shortId(projectId, 12)}</p>
        </div>
        <div className="pb-topbar-actions">
          <span className="novel-status-pill novel-status-pill-done">revision {projectQ.data?.currentRevision ?? 0}</span>
          <span className={statusInfo.pill}>{statusInfo.icon} {statusInfo.label}</span>
          <Button icon={<ReloadOutlined />} onClick={() => { void projectQ.refetch(); void runsQ.refetch(); void runQ.refetch(); void eventsQ.refetch(); void artifactsQ.refetch(); }}>刷新</Button>
        </div>
      </motion.header>

      {projectQ.isError && <Alert type="error" showIcon message="加载项目失败" description={projectQ.error instanceof Error ? projectQ.error.message : undefined} className="pb-alert" />}
      {runsQ.isError && <Alert type="warning" showIcon message="加载运行列表失败" className="pb-alert" />}

      <PipelineTracker states={stageStates} selected={selectedStage} onSelect={(s) => setSelectedStage((cur) => (cur === s ? null : s))} />

      {run?.status === "manual-review-required" && <GateBanner run={run} onDecide={handleGateDecision} deciding={signal.isPending} />}

      <div className="pb-grid">
        <div className="pb-col pb-col-left">
          <ChapterRail documents={documents} selectedId={selectedDocId} onSelect={setSelectedDocId} />
          <RunRail runs={runs} selectedWfId={selectedWfId} onSelect={setSelectedWfId} />
        </div>

        <div className="pb-col pb-col-center">
          {selectedStageMeta && (
            <section className="pb-card pb-stage-detail">
              <header className="pb-card-head">
                <span className="pb-card-title">{selectedStageMeta.label}</span>
                <Tag>{selectedStageMeta.categoryLabel}</Tag>
              </header>
              <p className="pb-stage-desc">{selectedStageMeta.description}</p>
              <div className="pb-stage-artifacts">
                {artifacts.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该阶段暂无产物" />}
                {artifacts.map((a) => (
                  <ArtifactCard key={a.id} artifact={toArtifactSummary(a)} onView={(x) => setViewingArtifact(x)} />
                ))}
              </div>
            </section>
          )}
          {!selectedStageMeta && <QualityPanel quality={quality} />}
          <RevisionDiffCard artifacts={artifacts} />
          <ManuscriptWorkbench projectId={projectId} documentId={selectedDocId} />
          <FactsPanel projectId={projectId} documentId={selectedDocId} />
        </div>

        <div className="pb-col pb-col-right">
          <EventTimeline events={events} />
        </div>
      </div>

      {viewingArtifact && <ArtifactContentModal artifact={viewingArtifact} open={Boolean(viewingArtifact)} onClose={() => setViewingArtifact(null)} />}
    </div>
  );
}
