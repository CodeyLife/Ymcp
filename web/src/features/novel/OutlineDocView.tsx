import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, Modal, Select, Tag, Tooltip } from "antd";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  AuditOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  ExpandAltOutlined,
  CompressOutlined,
  PlusOutlined,
  RightOutlined,
  RobotOutlined,
  SaveOutlined,
  SearchOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { motion } from "motion/react";
import { useLiveQuery } from "dexie-react-hooks";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import ArchitectureDataEditor from "./ArchitectureDataEditor";
import GenerationComposer from "./GenerationComposer";
import OutlineProposalReview from "./OutlineProposalReview";
import RuntimeArchitectureReview from "./RuntimeArchitectureReview";
import {
  addOutlineNode,
  commitFormalRecordChanges,
  createChapter,
  deleteChapter,
  deleteOutlineBranch,
  ensureStoryArchitecture,
  normalizeChapterOrderByPlanning,
  novelDb,
  saveStoryArchitecture,
} from "./db";
import { runPlotDesignTask } from "./generation";
import { createSegmentAutomationRun, runSegmentAutomation } from "./creative-segment";
import { isArchitectureOperation, novelRuntimeClient } from "./runtime-client";
import { useNovelRuntimeEvents } from "./use-runtime-events";
import type { ArchitecturePhase, ManuscriptDocument, OutlineNode, StoryArchitecture, StoryFramework } from "./types";
import { startChapterReviewWorkflow } from "./workflow";

type OpenChapterPanel = "manuscript" | "workflow";
type ManuscriptDocumentStatus = ManuscriptDocument["status"];

const FRAMEWORK_LABELS: Record<StoryFramework, string> = {
  free: "自由结构",
  "three-act": "三幕式",
  "four-part": "起承转合",
  "save-the-cat": "Save the Cat",
  snowflake: "雪花写作法",
};

const STATUS_LABELS: Record<ManuscriptDocumentStatus, string> = {
  outline: "大纲",
  draft: "草稿",
  review: "审校中",
  final: "定稿",
};

function InlineText({ value, placeholder, multiline, onCommit }: { value: string; placeholder: string; multiline?: boolean; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  return multiline
    ? <Input.TextArea value={draft} placeholder={placeholder} autoSize={{ minRows: 2, maxRows: 6 }} onChange={(event) => setDraft(event.target.value)} onBlur={commit} />
    : <Input value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onBlur={commit} />;
}

function StatusPill({ status }: { status: ManuscriptDocumentStatus }) {
  return <span className="novel-chapter-status" data-status={status}>{STATUS_LABELS[status]}</span>;
}

function ChapterRow({ document, onUpdate, onDelete, onOpen, onReview, reviewing, dimmed }: {
  document: ManuscriptDocument;
  onUpdate: (document: ManuscriptDocument, changes: Partial<ManuscriptDocument>) => void;
  onDelete: (document: ManuscriptDocument) => void;
  onOpen: (documentId: string, panel: OpenChapterPanel) => void;
  onReview: (document: ManuscriptDocument) => void;
  reviewing: boolean;
  dimmed: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const blueprint = document.blueprint;
  return <div className={`novel-planning-chapter-row${dimmed ? " is-dimmed" : ""}`}>
    <header>
      <span className="novel-planning-chapter-order">{String(document.order + 1).padStart(2, "0")}</span>
      <StatusPill status={document.status} />
      <div className="novel-planning-chapter-title"><InlineText value={document.title} placeholder="章节标题" onCommit={(title) => onUpdate(document, { title })} /><small>{document.wordCount.toLocaleString()} 字</small></div>
      <div className="novel-planning-row-actions">
        <Tooltip title="编辑章节蓝图"><Button type="text" aria-label="编辑章节蓝图" icon={<EditOutlined />} onClick={() => setExpanded((value) => !value)} /></Tooltip>
        <Button size="small" onClick={() => onOpen(document.id, "manuscript")}>正文</Button>
        {document.status === "final" && <Tooltip title="严苛审校并优化正文"><Button type="text" aria-label="审校优化章节" loading={reviewing} icon={<AuditOutlined />} onClick={() => onReview(document)} /></Tooltip>}
        <Tooltip title="自动章节流程"><Button type="text" aria-label="自动章节流程" icon={<ThunderboltOutlined />} onClick={() => onOpen(document.id, "workflow")} /></Tooltip>
        <Tooltip title="删除章节"><Button danger type="text" aria-label="删除章节" icon={<DeleteOutlined />} onClick={() => onDelete(document)} /></Tooltip>
      </div>
    </header>
    {expanded && <div className="novel-planning-chapter-editor">
      <label>章节摘要<InlineText multiline value={document.summary} placeholder="本章推进与结尾变化" onCommit={(summary) => onUpdate(document, { summary })} /></label>
      <label>本章目标<InlineText multiline value={blueprint.objective} placeholder="本章必须完成什么" onCommit={(objective) => onUpdate(document, { blueprint: { ...blueprint, objective } })} /></label>
      <label>核心冲突<InlineText multiline value={blueprint.conflict} placeholder="谁想要什么，受到什么阻碍" onCommit={(conflict) => onUpdate(document, { blueprint: { ...blueprint, conflict } })} /></label>
      <label>必须发生<InlineText multiline value={blueprint.mustHappen.join("\n")} placeholder="每行一个必须发生项" onCommit={(value) => onUpdate(document, { blueprint: { ...blueprint, mustHappen: value.split("\n").map((item) => item.trim()).filter(Boolean) } })} /></label>
    </div>}
  </div>;
}

function SegmentSection({ segment, chapters, siblings, onUpdate, onMove, onDelete, onAddChapter, onUpdateChapter, onDeleteChapter, onOpenChapter, onReviewChapter, reviewingDocumentId, onAutomate, automating, searching }: {
  segment: OutlineNode;
  chapters: ManuscriptDocument[];
  siblings: OutlineNode[];
  onUpdate: (segment: OutlineNode, changes: Partial<OutlineNode>) => void;
  onMove: (segment: OutlineNode, direction: -1 | 1) => void;
  onDelete: (segment: OutlineNode) => void;
  onAddChapter: (segment: OutlineNode) => void;
  onUpdateChapter: (document: ManuscriptDocument, changes: Partial<ManuscriptDocument>) => void;
  onDeleteChapter: (document: ManuscriptDocument) => void;
  onOpenChapter: (documentId: string, panel: OpenChapterPanel) => void;
  onReviewChapter: (document: ManuscriptDocument) => void;
  reviewingDocumentId?: string;
  onAutomate: (segment: OutlineNode) => void;
  automating: boolean;
  searching: boolean;
}) {
  const index = siblings.findIndex((item) => item.id === segment.id);
  const [collapsed, setCollapsed] = useState(false);
  return <section className="novel-plot-segment">
    <header className="novel-plot-segment-header">
      <button type="button" className="novel-segment-collapse" aria-label={collapsed ? "展开剧情段" : "收起剧情段"} onClick={() => setCollapsed((value) => !value)}>
        {collapsed ? <RightOutlined /> : <DownOutlined />}
        <Tag color="blue">剧情段 {index + 1}</Tag>
      </button>
      <div><InlineText value={segment.title} placeholder="剧情段标题" onCommit={(title) => onUpdate(segment, { title })} /><InlineText multiline value={segment.summary} placeholder="人物处境、局部矛盾和结束时的局面变化" onCommit={(summary) => onUpdate(segment, { summary })} /></div>
      <div className="novel-planning-row-actions">
        <Tooltip title="上移剧情段"><Button type="text" aria-label="上移剧情段" icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => onMove(segment, -1)} /></Tooltip>
        <Tooltip title="下移剧情段"><Button type="text" aria-label="下移剧情段" icon={<ArrowDownOutlined />} disabled={index === siblings.length - 1} onClick={() => onMove(segment, 1)} /></Tooltip>
        <Tooltip title="新增章节"><Button type="text" aria-label="新增章节" icon={<PlusOutlined />} onClick={() => onAddChapter(segment)} /></Tooltip>
        <Tooltip title="一键生成并审核本剧情段全部章节"><Button type="text" aria-label="一键生成剧情段" loading={automating} icon={<ThunderboltOutlined />} disabled={!chapters.length} onClick={() => onAutomate(segment)} /></Tooltip>
        <Tooltip title="删除剧情段"><Button danger type="text" aria-label="删除剧情段" icon={<DeleteOutlined />} onClick={() => onDelete(segment)} /></Tooltip>
      </div>
    </header>
    {!collapsed && <div className="novel-planning-chapter-list">
      {chapters.map((document) => <ChapterRow key={document.id} document={document} onUpdate={onUpdateChapter} onDelete={onDeleteChapter} onOpen={onOpenChapter} onReview={onReviewChapter} reviewing={reviewingDocumentId === document.id} dimmed={false} />)}
      {!chapters.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={searching ? "无匹配章节" : "该剧情段还没有章节"} />}
    </div>}
  </section>;
}

export default function OutlineDocView({ projectId, onOpenChapter }: { projectId: string; onOpenChapter: (documentId: string, panel: OpenChapterPanel) => void }) {
  const { message, modal } = App.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const runtimeChangeId = searchParams.get("changeId") ?? undefined;
  const architecture = useLiveQuery(() => novelDb.architectures.where("projectId").equals(projectId).first(), [projectId]);
  const segments = useLiveQuery(() => novelDb.outlineNodes.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const documents = useLiveQuery(() => novelDb.documents.where("projectId").equals(projectId).sortBy("order"), [projectId]) ?? [];
  const proposal = useLiveQuery(() => novelDb.proposals.where("projectId").equals(projectId).and((item) => item.status === "pending" && item.taskKey === "plot-design").first(), [projectId]);
  // 监听 runtime 事件以实时刷新 pending change 列表（change.pending/change.superseded/operation.cancelled）
  useNovelRuntimeEvents(projectId);
  const runtimeStatusQuery = useQuery({
    queryKey: ["novel-runtime", "status", projectId],
    queryFn: () => novelRuntimeClient.status(projectId),
    refetchInterval: 10_000,
  });
  // 过滤出全书架构类 pending change：owner operation 的 kind=plan 且 input.taskKey 命中 ARCHITECTURE_TASK_KEYS。
  const runtimeArchitectureChanges = useMemo(() => {
    const pending = runtimeStatusQuery.data?.pendingChanges ?? [];
    const operations = runtimeStatusQuery.data?.operations ?? [];
    return pending.filter((change) => {
      const owner = operations.find((operation) => operation.id === change.operationId);
      // 优先用 taskKey 识别（标准化字段），回退兼容历史数据里 target 塞入的类别标识
      return owner?.kind === "plan" && isArchitectureOperation(owner);
    });
  }, [runtimeStatusQuery.data]);
  // 仅当 URL 中明确带 changeId 且对应 change 仍 pending 时，才进入审核模式。
  // 这样用户在编辑正式架构时不会被突然出现的候选拦截——只有主动点击"审核"才进入。
  const activeArchitectureChange = useMemo(() => {
    if (!runtimeChangeId) return undefined;
    return runtimeArchitectureChanges.find((change) => change.id === runtimeChangeId);
  }, [runtimeArchitectureChanges, runtimeChangeId]);
  const activeArchitectureOperation = useMemo(() => {
    if (!activeArchitectureChange) return undefined;
    return runtimeStatusQuery.data?.operations.find((operation) => operation.id === activeArchitectureChange.operationId);
  }, [activeArchitectureChange, runtimeStatusQuery.data]);
  const [draft, setDraft] = useState<StoryArchitecture>();
  const [architectureOpen, setArchitectureOpen] = useState(false);
  const [generatePhase, setGeneratePhase] = useState<ArchitecturePhase>();
  const [instruction, setInstruction] = useState("");
  const [generating, setGenerating] = useState(false);
  const [automatingTarget, setAutomatingTarget] = useState<string>();
  const [reviewingDocumentId, setReviewingDocumentId] = useState<string>();
  const [collapsedPhases, setCollapsedPhases] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const phaseRefs = useRef<Map<string, HTMLElement>>(new Map());

  const togglePhase = useCallback((phaseId: string) => {
    setCollapsedPhases((current) => {
      const next = new Set(current);
      if (next.has(phaseId)) next.delete(phaseId);
      else next.add(phaseId);
      return next;
    });
  }, []);

  useEffect(() => { if (architecture) setDraft(architecture); else if (architecture === undefined) void ensureStoryArchitecture(projectId); }, [architecture, projectId]);
  const phaseList = useMemo(() => [...(draft?.phases ?? architecture?.phases ?? [])].sort((left, right) => left.order - right.order), [architecture, draft]);
  const segmentMap = useMemo(() => new Map(segments.map((segment) => [segment.id, segment])), [segments]);
  const unassigned = useMemo(() => documents.filter((document) => !document.plotSegmentId || !segmentMap.has(document.plotSegmentId)), [documents, segmentMap]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleDocuments = useMemo(() => normalizedQuery ? documents.filter((document) => document.title.toLowerCase().includes(normalizedQuery) || (document.summary ?? "").toLowerCase().includes(normalizedQuery)) : documents, [documents, normalizedQuery]);
  const searching = normalizedQuery.length > 0;

  const phaseStats = useMemo(() => {
    const stats = new Map<string, { segments: number; chapters: number }>();
    for (const phase of phaseList) {
      const phaseSegments = segments.filter((segment) => segment.phaseId === phase.id);
      const phaseChapters = documents.filter((document) => { const seg = document.plotSegmentId ? segmentMap.get(document.plotSegmentId) : undefined; return seg ? seg.phaseId === phase.id : false; });
      stats.set(phase.id, { segments: phaseSegments.length, chapters: phaseChapters.length });
    }
    return stats;
  }, [phaseList, segments, documents, segmentMap]);

  const allCollapsed = phaseList.length > 0 && collapsedPhases.size === phaseList.length;

  const expandAllPhases = useCallback(() => setCollapsedPhases(new Set()), []);
  const collapseAllPhases = useCallback(() => setCollapsedPhases(new Set(phaseList.map((phase) => phase.id))), [phaseList]);

  const scrollToPhase = useCallback((phaseId: string) => {
    const el = phaseRefs.current.get(phaseId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const updateSegment = useCallback(async (segment: OutlineNode, changes: Partial<OutlineNode>) => {
    const before = await novelDb.outlineNodes.get(segment.id);
    if (!before) return;
    const next = { ...before, ...changes, revision: before.revision + 1, updatedAt: Date.now() };
    await commitFormalRecordChanges(projectId, [{ collection: "outlineNodes", before: before as unknown as Record<string, unknown>, after: next as unknown as Record<string, unknown> }]);
  }, [projectId]);

  const updateChapter = useCallback(async (document: ManuscriptDocument, changes: Partial<ManuscriptDocument>) => {
    const before = await novelDb.documents.get(document.id);
    if (!before) return;
    const next = { ...before, ...changes, revision: before.revision + 1, updatedAt: Date.now() };
    await commitFormalRecordChanges(projectId, [{ collection: "documents", before: before as unknown as Record<string, unknown>, after: next as unknown as Record<string, unknown> }]);
  }, [projectId]);

  async function addSegment(phase: ArchitecturePhase) {
    const phaseSegments = segments.filter((segment) => segment.phaseId === phase.id);
    const order = phaseSegments.reduce((max, segment) => Math.max(max, segment.order), -1) + 1;
    await addOutlineNode(projectId, phase.id, `剧情段 ${order + 1}`, order);
  }

  const updateDraftPhase = (id: string, changes: Partial<ArchitecturePhase>) => {
    setDraft((current) => current ? { ...current, phases: current.phases.map((phase) => phase.id === id ? { ...phase, ...changes } : phase) } : current);
  };

  const addDraftPhase = () => {
    setDraft((current) => current ? { ...current, phases: [...current.phases, { id: crypto.randomUUID(), title: `第 ${current.phases.length + 1} 幕`, purpose: "", turningPoint: "", order: current.phases.length, locked: false, primaryCurveId: "" }] } : current);
  };

  const removeDraftPhase = (phase: ArchitecturePhase) => {
    const phaseSegments = segments.filter((segment) => segment.phaseId === phase.id);
    if (phaseSegments.length) {
      message.warning("请先处理该幕下的剧情段，再删除此幕");
      return;
    }
    setDraft((current) => current ? { ...current, phases: current.phases.filter((item) => item.id !== phase.id).map((item, order) => ({ ...item, order })) } : current);
  };

  const saveArchitectureDraft = async () => {
    if (!draft) return undefined;
    const saved = await saveStoryArchitecture(draft);
    setDraft(saved);
    return saved;
  };

  async function moveSegment(segment: OutlineNode, direction: -1 | 1) {
    const siblings = segments.filter((item) => item.phaseId === segment.phaseId).sort((left, right) => left.order - right.order);
    const index = siblings.findIndex((item) => item.id === segment.id);
    const target = siblings[index + direction];
    if (!target) return;
    await commitFormalRecordChanges(projectId, [
      { collection: "outlineNodes", before: segment as unknown as Record<string, unknown>, after: { ...segment, order: target.order, revision: segment.revision + 1, updatedAt: Date.now() } as unknown as Record<string, unknown> },
      { collection: "outlineNodes", before: target as unknown as Record<string, unknown>, after: { ...target, order: segment.order, revision: target.revision + 1, updatedAt: Date.now() } as unknown as Record<string, unknown> },
    ]);
    await normalizeChapterOrderByPlanning(projectId);
  }

  function removeSegment(segment: OutlineNode) {
    const chapterCount = documents.filter((document) => document.plotSegmentId === segment.id).length;
    modal.confirm({ title: `删除“${segment.title}”？`, content: chapterCount ? `${chapterCount} 个章节会保留并移入待整理章节。` : "该剧情段将被删除。", okButtonProps: { danger: true }, onOk: () => deleteOutlineBranch(projectId, segment.id) });
  }

  function removeChapter(document: ManuscriptDocument) {
    modal.confirm({ title: `删除“${document.title}”？`, content: "本章场景、正文版本和自动流程记录将一并删除。", okButtonProps: { danger: true }, onOk: () => deleteChapter(document.id) });
  }

  function reviewChapter(document: ManuscriptDocument) {
    modal.confirm({
      title: `重新审校“${document.title}”？`,
      content: "将复用正式章节审核、修订、事实提取与提交链路，并在正文审批处等待确认。",
      okText: "开始审校",
      onOk: async () => {
        setReviewingDocumentId(document.id);
        try {
          await startChapterReviewWorkflow({ projectId, documentId: document.id, blocking: false });
          onOpenChapter(document.id, "workflow");
          message.success("章节审校工作流已启动");
        } catch (error) {
          message.error(error instanceof Error ? error.message : "章节审校启动失败");
          throw error;
        } finally {
          setReviewingDocumentId(undefined);
        }
      },
    });
  }

  async function generate() {
    if (!generatePhase) return;
    setGenerating(true);
    try {
      await runPlotDesignTask({ projectId, phaseId: generatePhase.id, instruction });
      setGeneratePhase(undefined);
      setInstruction("");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "剧情设计失败");
    } finally {
      setGenerating(false);
    }
  }

  async function automateSegment(input: { plotSegmentId?: string; phaseId?: string; objective: string }) {
    if (automatingTarget) return;
    setAutomatingTarget(input.plotSegmentId ?? input.phaseId);
    try {
      if (input.phaseId) await saveArchitectureDraft();
      const created = await createSegmentAutomationRun({ projectId, ...input });
      const finished = await runSegmentAutomation(created.run.id);
      if (finished.run.status === "completed") message.success("剧情段全部章节已通过审核并提交");
      else if (finished.run.status === "paused") message.warning(`自动流程已暂停：${finished.workItems.find((item) => item.status === "blocked")?.error ?? "需要审核决策"}`);
      else message.info(`自动流程状态：${finished.run.status}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "剧情段自动化失败");
    } finally {
      setAutomatingTarget(undefined);
    }
  }

  // 仅当用户主动通过 URL changeId 进入时，才显示审核面板（不强制接管架构编辑器）。
  if (activeArchitectureChange) return <RuntimeArchitectureReview projectId={projectId} change={activeArchitectureChange} operation={activeArchitectureOperation} onResolved={() => {
    // 审核完成后清掉 URL 中的 changeId，回到默认架构编辑器视图
    const next = new URLSearchParams(searchParams);
    next.delete("changeId");
    setSearchParams(next, { replace: true });
  }} />;

  if (proposal) return <OutlineProposalReview proposal={proposal} onRegenerate={() => {
    const phase = architecture?.phases.find((item) => item.id === proposal.targetId);
    if (phase) setGeneratePhase(phase);
  }} />;

  const frameworkLabel = draft ? FRAMEWORK_LABELS[draft.framework] ?? draft.framework : "—";
  const statusLabel = draft ? (draft.status === "approved" ? "已批准" : "草案") : "—";
  const centralQuestionSnippet = draft?.centralQuestion?.trim() ? (draft.centralQuestion.length > 48 ? `${draft.centralQuestion.slice(0, 48)}…` : draft.centralQuestion) : "未设置核心问题";

  return <div className="novel-outline-document">
    <header className="novel-planning-hero">
      <div className="novel-planning-hero-text">
        <h2>全书规划</h2>
        <p>从全书命题到每幕章节，在一条连续结构中完成规划。</p>
      </div>
    </header>

    {runtimeArchitectureChanges.length > 0 && (
      <Alert
        type="info"
        showIcon
        banner
        message={`有 ${runtimeArchitectureChanges.length} 个全书架构候选待审核`}
        description={runtimeArchitectureChanges[0].summary || "外部 LLM 通过 MCP 提交了新的架构候选，与当前正式架构并排比对后决定接受、退回或拒绝。"}
        action={<Button type="primary" size="small" onClick={() => {
          // 合并写入 changeId，保留其他 URL 参数
          const next = new URLSearchParams(searchParams);
          next.set("changeId", runtimeArchitectureChanges[0].id);
          setSearchParams(next, { replace: true });
        }}>进入审核</Button>}
      />
    )}

    <div className="novel-planning-toolbar" data-console-open={architectureOpen}>
      <div className="novel-planning-summary-band">
        <div className="novel-planning-summary-cell" data-kind="framework">
          <span>结构方法</span>
          <strong>{frameworkLabel}</strong>
        </div>
        <div className="novel-planning-summary-cell" data-kind="status">
          <span>架构状态</span>
          <strong className="novel-planning-status-pill" data-status={draft?.status ?? "draft"}>{statusLabel}</strong>
        </div>
        <div className="novel-planning-summary-cell novel-planning-summary-wide" data-kind="question">
          <span>核心问题</span>
          <strong>{centralQuestionSnippet}</strong>
        </div>
        <div className="novel-planning-summary-cell" data-kind="counts">
          <span>规模</span>
          <strong>{phaseList.length} 幕 · {segments.length} 段 · {documents.length} 章</strong>
        </div>
      </div>
      <div className="novel-planning-toolbar-actions">
        <Tooltip title={architectureOpen ? "收起规划控制台" : "展开规划控制台"}><Button icon={<SettingOutlined />} onClick={() => setArchitectureOpen((value) => !value)}>{architectureOpen ? "收起控制台" : "控制台"}</Button></Tooltip>
        <Button className="novel-planning-save" type="primary" icon={<SaveOutlined />} onClick={async () => { await saveArchitectureDraft(); message.success("全书架构已保存"); }}>保存规划</Button>
        <Button icon={<PlusOutlined />} onClick={addDraftPhase}>添加幕</Button>
        {phaseList.length > 0 && (allCollapsed
          ? <Tooltip title="展开全部幕"><Button icon={<ExpandAltOutlined />} onClick={expandAllPhases}>全展开</Button></Tooltip>
          : <Tooltip title="收起全部幕"><Button icon={<CompressOutlined />} onClick={collapseAllPhases}>全收起</Button></Tooltip>)}
      </div>
    </div>

    {draft && architectureOpen && <section className="novel-planning-console">
      <header className="novel-planning-console-heading"><div><strong>规划控制台</strong><span>{draft.phases.length} 幕 · {draft.status === "approved" ? "已批准" : "草案"}</span></div></header>
      <div className="novel-planning-ai-command"><div className="novel-planning-ai-label"><strong>AI 规划指令</strong><span>生成新方案，或输入具体要求微调当前规划</span></div><GenerationComposer projectId={projectId} scope="architecture" taskKeys={["architecture"]} actionLabel="生成架构方案" compact getRefinementSnapshot={() => ({ architectures: [draft as unknown as Record<string, unknown>] })} /></div>
      <ArchitectureDataEditor value={draft} showPhases={false} onChange={(next) => setDraft({ ...draft, ...next })} />
    </section>}

    {!phaseList.length && <Alert type="warning" showIcon message="先建立至少一幕" description="在下方“幕与章节”中添加第一幕，再继续组织剧情段和章节。" />}

    {unassigned.length > 0 && !searching && <section className="novel-unassigned-chapters">
      <header><div><Tag color="orange">待整理章节</Tag><strong>{unassigned.length} 章</strong></div><p>这些章节尚未归属剧情段，仍可编辑，但不会进入按幕组织的规划。</p></header>
      {unassigned.map((document) => <div key={document.id}><span>{document.title}</span><Select placeholder="选择剧情段" value={document.plotSegmentId} options={segments.map((segment) => ({ value: segment.id, label: `${phaseList.find((phase) => phase.id === segment.phaseId)?.title ?? "未知幕"} / ${segment.title}` }))} onChange={async (plotSegmentId) => { await updateChapter(document, { plotSegmentId }); await normalizeChapterOrderByPlanning(projectId); }} /><Button onClick={() => onOpenChapter(document.id, "manuscript")}>打开正文</Button>{document.status === "final" && <Tooltip title="严苛审校并优化正文"><Button aria-label="审校优化章节" loading={reviewingDocumentId === document.id} icon={<AuditOutlined />} onClick={() => reviewChapter(document)} /></Tooltip>}</div>)}
    </section>}

    {phaseList.length > 0 && <nav className="novel-phase-quicknav" aria-label="幕快速导航">
      {phaseList.map((phase, phaseIndex) => {
        const stats = phaseStats.get(phase.id) ?? { segments: 0, chapters: 0 };
        return <button key={phase.id} type="button" onClick={() => scrollToPhase(phase.id)}>
          <strong>{String(phaseIndex + 1).padStart(2, "0")}</strong>
          <span>{phase.title || `第 ${phaseIndex + 1} 幕`}</span>
          <small>{stats.chapters} 章</small>
        </button>;
      })}
    </nav>}

    <section className="novel-phase-workspace">
      <header>
        <div><h3>幕与章节</h3><span>{phaseList.length} 幕 · {segments.length} 个剧情段 · {documents.length} 章</span></div>
        <div className="novel-phase-search">
          <Input allowClear prefix={<SearchOutlined />} placeholder="搜索章节标题或摘要" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
        </div>
      </header>
      <div className="novel-phase-list">{phaseList.map((phase, phaseIndex) => {
        const phaseSegments = segments.filter((segment) => segment.phaseId === phase.id).sort((left, right) => left.order - right.order);
        const phaseCollapsed = collapsedPhases.has(phase.id);
        const stats = phaseStats.get(phase.id) ?? { segments: 0, chapters: 0 };
        return <motion.section className="novel-phase-section" key={phase.id} ref={(el) => { if (el) phaseRefs.current.set(phase.id, el); else phaseRefs.current.delete(phase.id); }} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .28, delay: Math.min(phaseIndex * .04, .2) }}>
          <header className="novel-phase-header">
            <button type="button" className="novel-phase-number" aria-label={phaseCollapsed ? "展开本幕" : "收起本幕"} onClick={() => togglePhase(phase.id)}>{phaseCollapsed ? <RightOutlined /> : <DownOutlined />}<span>幕</span><strong>{String(phaseIndex + 1).padStart(2, "0")}</strong></button>
            <div className="novel-phase-meta">
              <div className="novel-phase-title-row"><Input className="novel-phase-title-input" value={phase.title} placeholder="为这一幕命名" onChange={(event) => updateDraftPhase(phase.id, { title: event.target.value })} /><span className="novel-phase-counts">{stats.segments} 段 · {stats.chapters} 章</span></div>
              <div className="novel-phase-summary-editor">
                <label><span>叙事使命</span><Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={phase.purpose} placeholder="这一幕必须完成的叙事推进" onChange={(event) => updateDraftPhase(phase.id, { purpose: event.target.value })} /></label>
                <label><span>不可逆转折</span><Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={phase.turningPoint} placeholder="幕末改变故事方向的决定性变化" onChange={(event) => updateDraftPhase(phase.id, { turningPoint: event.target.value })} /></label>
              </div>
            </div>
            <div className="novel-phase-actions">
              <Tooltip title="删除本幕"><Button danger type="text" aria-label={`删除${phase.title || `第 ${phaseIndex + 1} 幕`}`} icon={<DeleteOutlined />} onClick={() => removeDraftPhase(phase)} /></Tooltip>
              <Button icon={<RobotOutlined />} onClick={async () => { await saveArchitectureDraft(); setGeneratePhase(phase); }}>AI 设计章节</Button>
              <Button loading={automatingTarget === phase.id} icon={<ThunderboltOutlined />} onClick={() => void automateSegment({ phaseId: phase.id, objective: `为“${phase.title}”设计下一个剧情段并完成全部章节` })}>一键完成下一段</Button>
              <Button type="primary" icon={<PlusOutlined />} onClick={async () => { await saveArchitectureDraft(); await addSegment(phase); }}>新增剧情段</Button>
            </div>
          </header>
          {!phaseCollapsed && <div className="novel-phase-segments">{phaseSegments.map((segment) => <SegmentSection key={segment.id} segment={segment} siblings={phaseSegments} chapters={visibleDocuments.filter((document) => document.plotSegmentId === segment.id)} onUpdate={(item, changes) => void updateSegment(item, changes)} onMove={(item, direction) => void moveSegment(item, direction)} onDelete={removeSegment} onAddChapter={async (item) => { const chapter = await createChapter(projectId, undefined, item.id); onOpenChapter(chapter.id, "manuscript"); }} onUpdateChapter={(document, changes) => void updateChapter(document, changes)} onDeleteChapter={removeChapter} onOpenChapter={onOpenChapter} onReviewChapter={reviewChapter} reviewingDocumentId={reviewingDocumentId} onAutomate={(item) => void automateSegment({ plotSegmentId: item.id, objective: `完成“${item.title}”全部章节` })} automating={automatingTarget === segment.id} searching={searching} />)}{!phaseSegments.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该幕还没有剧情段" />}</div>}
        </motion.section>;
      })}</div>
    </section>

    <Modal title={`为“${generatePhase?.title ?? ""}”设计剧情段与章节`} open={Boolean(generatePhase)} confirmLoading={generating} okText="开始生成" cancelText="取消" onOk={() => void generate()} onCancel={() => { if (!generating) setGeneratePhase(undefined); }}><Input.TextArea rows={5} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="可选：说明本段要推进的矛盾、角色或伏笔" /></Modal>
  </div>;
}
