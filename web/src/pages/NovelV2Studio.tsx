import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tooltip,
  message,
} from "antd";
import {
  ApartmentOutlined,
  ArrowLeftOutlined,
  BookOutlined,
  CheckOutlined,
  CloseOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FileAddOutlined,
  FileTextOutlined,
  HighlightOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ReloadOutlined,
  RobotOutlined,
  RocketOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { motion } from "motion/react";
import {
  useCreateNovelDocument,
  useDeleteNovelDocument,
  useDecideFactCandidate,
  useNovelFactCandidates,
  useGenerateChapterTitle,
  useNovelProject,
  useNovelProjectRuns,
  useNovelRun,
  useNovelRunArtifacts,
  useNovelRunEvents,
  useSignalHumanDecision,
  useSubmitNovelIntent,
  useUpdateNovelDocument,
  isChapterWorkflowRun,
  novelRunDocumentId,
  type NovelDocumentInput,
  type NovelWorkflowRunRecord,
} from "@/lib/novelApi";
import { documentStatusMeta, projectDisplayTitle, relativeTime, statusMeta, workflowTypeMeta } from "./novel-v2/presentation";
import "./novel-v2.css";
import "./novel-v2/workspace-command.css";

const EvaluationPanel = lazy(() => import("./novel-v2/EvaluationPanel"));
const CreativeRunPanel = lazy(() => import("./novel-v2/CreativeRunPanel"));
const McpToolGatewayPanel = lazy(() => import("./novel-v2/McpToolGatewayPanel"));
const KnowledgeWorkbenchPanel = lazy(() => import("./novel-v2/KnowledgeWorkbenchPanel"));
const ProjectPlanPanel = lazy(() => import("./novel-v2/ProjectPlanPanel"));
const StoryArcPanel = lazy(() => import("./novel-v2/StoryArcPanel"));
const NovelProductionWorkspace = lazy(() => import("./novel-v2/NovelPipelineBoard"));

export type NovelWorkspaceView = "overview" | "plan" | "arcs" | "production" | "knowledge" | "evaluation" | "creative" | "mcp";

const VIEW_ITEMS: Array<{ key: NovelWorkspaceView; label: string; icon: React.ReactNode }> = [
  { key: "overview", label: "总览", icon: <ThunderboltOutlined /> },
  { key: "plan", label: "全书规划", icon: <BookOutlined /> },
  { key: "arcs", label: "故事弧", icon: <ApartmentOutlined /> },
  { key: "production", label: "章节生产", icon: <FileTextOutlined /> },
  { key: "knowledge", label: "创作资料", icon: <DatabaseOutlined /> },
  { key: "evaluation", label: "评估闭环", icon: <ExperimentOutlined /> },
  { key: "creative", label: "创意执行", icon: <RocketOutlined /> },
  { key: "mcp", label: "MCP 工具", icon: <RobotOutlined /> },
];

const VALID_VIEWS = new Set(VIEW_ITEMS.map((item) => item.key));
const ACTIVE_STATUSES = new Set(["running", "waiting-external", "accepted", "received", "pending", "paused"]);
const FAILED_STATUSES = new Set(["failed", "rejected", "cancelled", "terminated", "blocked"]);
const DOCUMENT_STATUSES = ["planned", "draft", "review", "revision", "final", "archived"].map((value) => ({ value, label: documentStatusMeta(value).label }));

function latestRun(runs: NovelWorkflowRunRecord[]) {
  return [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

function PanelFallback() {
  return <div className="nwc-loading"><Spin /><span>正在加载工作区</span></div>;
}

export default function NovelV2Studio() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [chapterModal, setChapterModal] = useState<"create" | "edit" | null>(null);
  const [chapterTitleWorkflowId, setChapterTitleWorkflowId] = useState<string>();
  const [chapterQuery, setChapterQuery] = useState("");
  const [chapterStatus, setChapterStatus] = useState<string>();
  const [chapterForm] = Form.useForm<NovelDocumentInput>();
  const pageRef = useRef<HTMLDivElement>(null);

  const projectQ = useNovelProject(projectId);
  const runsQ = useNovelProjectRuns(projectId);
  const project = projectQ.data;
  const runs = runsQ.data ?? project?.latestRuns ?? [];
  const chapterRuns = useMemo(() => runs.filter(isChapterWorkflowRun), [runs]);

  const rawView = searchParams.get("view") ?? "overview";
  const view: NovelWorkspaceView = VALID_VIEWS.has(rawView as NovelWorkspaceView) ? rawView as NovelWorkspaceView : "overview";
  const selectedDocumentId = searchParams.get("document") ?? undefined;
  const selectedWorkflowId = searchParams.get("run") ?? undefined;
  const selectedStage = searchParams.get("stage") ?? undefined;
  const selectedDocument = project?.documents.find((document) => document.id === selectedDocumentId);

  const selectedRunQ = useNovelRun(selectedWorkflowId);
  const chapterTitleRunQ = useNovelRun(chapterTitleWorkflowId);
  const selectedRun = selectedRunQ.data;
  const runActive = ACTIVE_STATUSES.has(selectedRun?.status ?? "") || selectedRun?.status === "manual-review-required";
  const eventsQ = useNovelRunEvents(selectedWorkflowId, runActive);
  const artifactsQ = useNovelRunArtifacts(selectedWorkflowId, runActive);
  const factsQ = useNovelFactCandidates(projectId, selectedDocumentId);
  const factDecision = useDecideFactCandidate(projectId, selectedDocumentId);
  const signalDecision = useSignalHumanDecision(projectId, selectedWorkflowId);
  const createDocument = useCreateNovelDocument(projectId);
  const updateDocument = useUpdateNovelDocument(projectId);
  const generateChapterTitle = useGenerateChapterTitle(projectId);
  const deleteDocument = useDeleteNovelDocument(projectId);
  const submitIntent = useSubmitNovelIntent(projectId);

  function updateLocation(patch: Partial<Record<"view" | "document" | "run" | "stage", string | undefined>>) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    }, { replace: true });
  }

  useEffect(() => {
    if (rawView !== view) updateLocation({ view });
  }, [rawView, view]);

  useEffect(() => {
    if (!project?.documents.length) return;
    if (!selectedDocumentId || !project.documents.some((document) => document.id === selectedDocumentId)) {
      const runDocumentId = novelRunDocumentId(runs.find((run) => run.temporalWorkflowId === selectedWorkflowId));
      updateLocation({ document: runDocumentId && project.documents.some((document) => document.id === runDocumentId) ? runDocumentId : project.documents[0].id });
    }
  }, [project?.documents, runs, selectedDocumentId, selectedWorkflowId]);

  useEffect(() => {
    if (view === "production") return;
    if (runs.length && (!selectedWorkflowId || !runs.some((run) => run.temporalWorkflowId === selectedWorkflowId))) updateLocation({ run: latestRun(runs)?.temporalWorkflowId });
  }, [runs, selectedWorkflowId, view]);

  useEffect(() => {
    const run = chapterTitleRunQ.data;
    if (!chapterTitleWorkflowId || !run || !["completed", "failed"].includes(run.status)) return;
    if (run.status === "completed") {
      const title = typeof run.record?.payload.title === "string" ? run.record.payload.title : undefined;
      const documentId = typeof run.record?.payload.documentId === "string" ? run.record.payload.documentId : undefined;
      if (title && chapterModal === "edit" && selectedDocument?.id === documentId) chapterForm.setFieldValue("title", title);
      void projectQ.refetch();
      message.success(title ? `章节已更名为“${title}”` : "章节更名已完成");
    } else {
      const reason = typeof run.record?.payload.reason === "string" ? run.record.payload.reason : "章节 AI 更名失败";
      message.error(reason);
    }
    setChapterTitleWorkflowId(undefined);
  }, [chapterTitleRunQ.data?.status, chapterTitleWorkflowId]);

  const metrics = useMemo(() => {
    const manual = runs.filter((run) => run.status === "manual-review-required").length;
    const failed = runs.filter((run) => FAILED_STATUSES.has(run.status)).length;
    const active = runs.filter((run) => ACTIVE_STATUSES.has(run.status)).length;
    const blocking = project?.documents.reduce((sum, document) => sum + (document.blockingIssueCount ?? 0), 0) ?? 0;
    return { manual, failed, active, blocking, priority: manual + failed + blocking };
  }, [project?.documents, runs]);
  const productionMetrics = useMemo(() => {
    const manual = chapterRuns.filter((run) => run.status === "manual-review-required").length;
    const failed = chapterRuns.filter((run) => FAILED_STATUSES.has(run.status)).length;
    const blocking = project?.documents.reduce((sum, document) => sum + (document.blockingIssueCount ?? 0), 0) ?? 0;
    return { priority: manual + failed + blocking };
  }, [chapterRuns, project?.documents]);
  const arcRiskCount = useMemo(() => runs.filter((run) => run.workflowType === "story-arc-planning" && FAILED_STATUSES.has(run.status)).length, [runs]);

  const filteredDocuments = useMemo(() => {
    const keyword = chapterQuery.trim().toLowerCase();
    return (project?.documents ?? []).filter((document) => {
      const matchesKeyword = !keyword || `${document.title} ${document.narrativeOrder} ${document.povCharacterId ?? ""}`.toLowerCase().includes(keyword);
      return matchesKeyword && (!chapterStatus || document.status === chapterStatus);
    });
  }, [chapterQuery, chapterStatus, project?.documents]);

  const priorityItems = useMemo(() => {
    const items: Array<{ key: string; tone: "danger" | "warning" | "active"; title: string; detail: string; documentId?: string; workflowId?: string }> = [];
    for (const run of runs) {
      if (run.status === "manual-review-required") items.push({ key: run.id, tone: "warning", title: "等待作者审批", detail: `${workflowTypeMeta(run.workflowType).label} · ${relativeTime(run.updatedAt)}`, workflowId: run.temporalWorkflowId, documentId: typeof run.payload.documentId === "string" ? run.payload.documentId : undefined });
      else if (FAILED_STATUSES.has(run.status)) items.push({ key: run.id, tone: "danger", title: "运行异常", detail: `${workflowTypeMeta(run.workflowType).label} · ${statusMeta(run.status).label}`, workflowId: run.temporalWorkflowId, documentId: typeof run.payload.documentId === "string" ? run.payload.documentId : undefined });
      else if (ACTIVE_STATUSES.has(run.status)) items.push({ key: run.id, tone: "active", title: "工作流执行中", detail: `${workflowTypeMeta(run.workflowType).label} · ${relativeTime(run.updatedAt)}`, workflowId: run.temporalWorkflowId, documentId: typeof run.payload.documentId === "string" ? run.payload.documentId : undefined });
    }
    for (const document of project?.documents ?? []) {
      if ((document.blockingIssueCount ?? 0) > 0) items.push({ key: `doc-${document.id}`, tone: "danger", title: `${document.title} 存在阻塞问题`, detail: `${document.blockingIssueCount} 项需要处理`, documentId: document.id });
    }
    const rank = { warning: 0, danger: 1, active: 2 };
    return items.sort((a, b) => rank[a.tone] - rank[b.tone]);
  }, [project?.documents, runs]);

  async function refreshAll() {
    await Promise.all([projectQ.refetch(), runsQ.refetch(), selectedRunQ.refetch(), eventsQ.refetch(), artifactsQ.refetch(), factsQ.refetch()]);
  }

  async function saveChapter(values: NovelDocumentInput) {
    const normalized = { ...values, narrativeOrder: values.narrativeOrder === undefined ? undefined : Number(values.narrativeOrder) };
    if (chapterModal === "edit" && selectedDocument) {
      await updateDocument.mutateAsync({ ...normalized, documentId: selectedDocument.id, povCharacterId: normalized.povCharacterId || null });
      message.success("章节已更新");
    } else {
      const result = await createDocument.mutateAsync(normalized);
      updateLocation({ document: result.document.id, view: "production" });
      message.success("章节目标已创建");
    }
    setChapterModal(null);
    chapterForm.resetFields();
  }

  async function startChapterCreation(document: NonNullable<typeof selectedDocument>) {
    const result = await submitIntent.mutateAsync({ objective: `完成第 ${document.narrativeOrder} 章《${document.title}》的正式创作，遵循已批准的章节规格与故事弧约束。`, documentId: document.id, factApprovalMode: "auto" });
    updateLocation({ view: "production", document: document.id, run: result.workflowId });
    message.success("章节创作已开始");
  }

  async function startChapterTitleGeneration() {
    if (!selectedDocument) return;
    try {
      const result = await generateChapterTitle.mutateAsync(selectedDocument.id);
      setChapterTitleWorkflowId(result.workflowId);
      message.success("章节 AI 更名任务已启动");
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  function confirmDeleteChapter(document: NonNullable<typeof selectedDocument>) {
    Modal.confirm({
      title: `删除“${document.title}”？`,
      content: "将删除章节目标及关联的项目记录，此操作不可撤销。",
      okText: "删除章节",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        await deleteDocument.mutateAsync(document.id);
        updateLocation({ document: undefined, run: undefined, stage: undefined });
        message.success("章节已删除");
      },
    });
  }

  async function decideRun(decision: "approve" | "reject") {
    const artifactId = typeof selectedRun?.record?.payload.artifactId === "string" ? selectedRun.record.payload.artifactId : undefined;
    if (!artifactId) return message.error("运行记录缺少待审批产物");
    await signalDecision.mutateAsync({ artifactId, decision });
    message.success(decision === "approve" ? "已批准，Runtime 将继续执行" : "已退回该稿件");
  }

  const viewTitle = VIEW_ITEMS.find((item) => item.key === view)?.label ?? "总览";
  const latestStatus = statusMeta(latestRun(runs)?.status);
  const projectTitle = projectDisplayTitle(project?.title, projectId);

  useGSAP(() => {
    if (view !== "production") {
      gsap.fromTo(
        ".nwc-inspector-body > *",
        { opacity: 0, y: 12, scale: 0.985 },
        { opacity: 1, y: 0, scale: 1, duration: 0.32, stagger: 0.035, ease: "power2.out" },
      );
    }
    gsap.to(".nwc-priority-row.is-active .nwc-priority-signal", {
      scale: 1.35,
      opacity: 0.65,
      duration: 0.8,
      repeat: -1,
      yoyo: true,
      ease: "sine.inOut",
    });
  }, { scope: pageRef, dependencies: [selectedDocumentId, selectedWorkflowId, view], revertOnUpdate: true });

  function renderMainView() {
    if (view === "production") {
      return <Suspense fallback={<PanelFallback />}><NovelProductionWorkspace
          embedded
          projectId={projectId}
          documentId={selectedDocumentId}
          workflowId={selectedWorkflowId}
          stage={selectedStage}
          onSelectionChange={(selection) => updateLocation({ document: selection.documentId, run: selection.workflowId, stage: selection.stage })}
          onStartCreation={(document) => void startChapterCreation(document)}
          onEditChapter={(document) => { setChapterModal("edit"); chapterForm.setFieldsValue(document); }}
          onDeleteChapter={confirmDeleteChapter}
          onOpenKnowledge={() => updateLocation({ view: "knowledge", run: undefined, stage: undefined })}
        /></Suspense>;
    }
    if (view === "plan") return <Suspense fallback={<PanelFallback />}><ProjectPlanPanel projectId={projectId} onProjectTitleChanged={() => void projectQ.refetch()} /></Suspense>;
    if (view === "arcs") return <Suspense fallback={<PanelFallback />}><StoryArcPanel projectId={projectId} onApplied={() => void projectQ.refetch()} /></Suspense>;
    if (view === "knowledge") return <Suspense fallback={<PanelFallback />}><KnowledgeWorkbenchPanel projectId={projectId} /></Suspense>;
    if (view === "evaluation") return <Suspense fallback={<PanelFallback />}><EvaluationPanel projectId={projectId} /></Suspense>;
    if (view === "creative") return <Suspense fallback={<PanelFallback />}><CreativeRunPanel projectId={projectId} /></Suspense>;
    if (view === "mcp") return <Suspense fallback={<PanelFallback />}><McpToolGatewayPanel /></Suspense>;
    return (
      <div className="nwc-overview">
        <section className="nwc-priority" aria-label="优先处理队列">
          <header className="nwc-section-head">
            <div><span className="nwc-kicker">优先队列</span><h2>先处理会阻塞创作的事项</h2></div>
            <span className="nwc-count">{priorityItems.length}</span>
          </header>
          <div className="nwc-priority-list">
            {priorityItems.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有阻塞或待审批事项" />}
            {priorityItems.map((item) => (
              <button key={item.key} type="button" className={`nwc-priority-row is-${item.tone}`} onClick={() => updateLocation({ view: "production", document: item.documentId ?? selectedDocumentId, run: item.workflowId ?? selectedWorkflowId })}>
                <span className="nwc-priority-signal" />
                <span className="nwc-priority-copy"><strong>{item.title}</strong><small>{item.detail}</small></span>
                <span className="nwc-row-action">查看</span>
              </button>
            ))}
          </div>
        </section>

        <section className="nwc-health" aria-label="运行态势">
          <header className="nwc-section-head"><div><span className="nwc-kicker">运行态势</span><h2>当前工作负载</h2></div></header>
          <div className="nwc-metric-grid">
            <div><strong>{metrics.manual}</strong><span>待审批</span></div>
            <div><strong>{metrics.failed}</strong><span>异常</span></div>
            <div><strong>{metrics.active}</strong><span>运行中</span></div>
            <div><strong>{metrics.blocking}</strong><span>质量阻塞</span></div>
          </div>
        </section>

        <section className="nwc-recent" aria-label="章节查询">
          <header className="nwc-section-head">
            <div><span className="nwc-kicker">章节索引</span><h2>查询与进入章节</h2></div>
            <Button type="primary" icon={<FileAddOutlined />} onClick={() => { setChapterModal("create"); chapterForm.setFieldsValue({ status: "planned" }); }}>新增章节</Button>
          </header>
          <div className="nwc-filters">
            <Input allowClear prefix={<SearchOutlined />} value={chapterQuery} onChange={(event) => setChapterQuery(event.target.value)} placeholder="搜索章节标题、序号或 POV" />
            <Select allowClear value={chapterStatus} onChange={setChapterStatus} placeholder="全部状态" options={DOCUMENT_STATUSES} />
          </div>
          <div className="nwc-chapter-table">
            {filteredDocuments.map((document) => (
              <button key={document.id} type="button" onClick={() => updateLocation({ view: "production", document: document.id })}>
                <span className="nwc-chapter-order">{String(document.narrativeOrder).padStart(2, "0")}</span>
                <span className="nwc-chapter-title"><strong>{document.title}</strong><small>{document.arcTitle ?? "未归属故事弧"}</small></span>
                <span className="nwc-chapter-words">{document.wordCount ? `${document.wordCount.toLocaleString()} 字` : "未定稿"}</span>
                <span className={documentStatusMeta(document.status).pill}>{documentStatusMeta(document.status).label}</span>
              </button>
            ))}
            {filteredDocuments.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的章节" />}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div ref={pageRef} className="nwc-page">
      <motion.div className="nwc-command-header" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <nav className="nwc-workspace-tabs" aria-label="作品工作区">
          <button type="button" onClick={() => navigate("/novels")}><ArrowLeftOutlined /><span>作品工作区</span></button>
          <button type="button" className="is-active" aria-current="page"><BookOutlined /><span>{projectTitle}</span></button>
        </nav>

        <header className="nwc-topbar">
          <div className="nwc-project-title"><span>小说创作指挥台</span><h1>{projectTitle}</h1></div>
          <div className="nwc-topbar-state">
            <span className="nwc-revision">修订 {project?.currentRevision ?? 0}</span>
            <span className={latestStatus.pill}>{latestStatus.icon}{latestStatus.label}</span>
          </div>
          <div className="nwc-topbar-actions">
            <Button type="primary" icon={<FileAddOutlined />} onClick={() => { setChapterModal("create"); chapterForm.setFieldsValue({ status: "planned" }); }}>新增章节</Button>
            <Tooltip title="刷新全部数据"><Button aria-label="刷新全部数据" icon={<ReloadOutlined />} loading={projectQ.isFetching || runsQ.isFetching} onClick={() => void refreshAll()} /></Tooltip>
          </div>
        </header>

        <nav className="nwc-view-tabs" aria-label="创作领域">
          {VIEW_ITEMS.map((item) => {
            const badge = item.key === "overview" ? metrics.priority : item.key === "production" ? productionMetrics.priority : item.key === "arcs" ? arcRiskCount : item.key === "knowledge" ? factsQ.data?.length ?? 0 : 0;
            return <button key={item.key} type="button" className={view === item.key ? "is-active" : ""} aria-current={view === item.key ? "page" : undefined} onClick={() => updateLocation({ view: item.key })}>
              <span className="nwc-nav-icon">{item.icon}</span><span>{item.label}</span>{badge > 0 && <span className="nwc-nav-badge">{badge}</span>}
            </button>;
          })}
        </nav>
      </motion.div>

      {(projectQ.isError || runsQ.isError) && <Alert type="error" showIcon message="无法加载作品指挥台" description={(projectQ.error ?? runsQ.error) instanceof Error ? (projectQ.error ?? runsQ.error as Error).message : undefined} />}

      <div className={`nwc-shell ${inspectorCollapsed ? "is-inspector-collapsed" : ""} ${view === "production" ? "is-production" : ""}`}>
        <main className="nwc-main">
          <header className="nwc-view-head">
            <div><span className="nwc-kicker">{view === "overview" ? "作品态势" : "当前领域"}</span><h2>{viewTitle}</h2></div>
            {view === "overview" && <div className="nwc-view-summary"><span>{project?.documents.length ?? 0} 章</span><span>{runs.length} 条运行</span></div>}
            {view === "production" && <div className="nwc-production-actions">
              <Button icon={<FileAddOutlined />} onClick={() => { setChapterModal("create"); chapterForm.setFieldsValue({ status: "planned" }); }}>新增章节</Button>
            </div>}
          </header>
          {renderMainView()}
        </main>

        {view !== "production" && <aside className="nwc-inspector">
          <header><div><span className="nwc-kicker">上下文审阅</span><h2>{selectedDocument?.title ?? "当前运行"}</h2></div><Tooltip title={inspectorCollapsed ? "展开审阅台" : "折叠审阅台"}><Button type="text" icon={inspectorCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setInspectorCollapsed((value) => !value)} /></Tooltip></header>
          <div className="nwc-inspector-body">
            {selectedRun ? <>
              <div className="nwc-inspector-status"><span className={statusMeta(selectedRun.status).pill}>{statusMeta(selectedRun.status).icon}{statusMeta(selectedRun.status).label}</span><small>{selectedWorkflowId ? relativeTime(selectedRun.record?.updatedAt) : ""}</small></div>
              {selectedRun.status === "manual-review-required" && <div className="nwc-gate-actions"><Button type="primary" icon={<CheckOutlined />} loading={signalDecision.isPending} onClick={() => void decideRun("approve")}>批准并继续</Button><Button danger icon={<CloseOutlined />} loading={signalDecision.isPending} onClick={() => void decideRun("reject")}>退回</Button></div>}
              <div className="nwc-inspector-block"><span>工作流产物</span><strong>{artifactsQ.data?.length ?? 0}</strong></div>
              <div className="nwc-inspector-block"><span>事件</span><strong>{eventsQ.data?.length ?? 0}</strong></div>
            </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无运行上下文" />}
            <section className="nwc-facts-mini"><h3>待审批事实 <span>{factsQ.data?.length ?? 0}</span></h3>{factsQ.data?.slice(0, 4).map((fact) => <article key={fact.id}><strong>{fact.title}</strong><p>{fact.content}</p><div><Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => void factDecision.mutateAsync({ claimId: fact.id, decision: "approve" })}>批准</Button><Button size="small" danger icon={<CloseOutlined />} onClick={() => void factDecision.mutateAsync({ claimId: fact.id, decision: "reject" })}>拒绝</Button></div></article>)}</section>
            <section className="nwc-events-mini"><h3>最近事件</h3>{eventsQ.data?.slice(-6).reverse().map((event, index) => <div key={event.id ?? index}><span /><p>{typeof event.event_type === "string" ? event.event_type : event.eventType ?? "系统事件"}<small>{relativeTime(event.created_at ?? event.createdAt)}</small></p></div>)}</section>
          </div>
        </aside>}
      </div>

      <Modal title={chapterModal === "edit" ? "编辑章节" : "新增章节目标"} open={Boolean(chapterModal)} onCancel={() => { setChapterModal(null); chapterForm.resetFields(); }} footer={null} destroyOnHidden>
        <Form form={chapterForm} layout="vertical" onFinish={(values) => void saveChapter(values)}>
          <Form.Item label="章节标题">
            <Space.Compact block>
              <Form.Item name="title" noStyle rules={[{ required: true, message: "请输入章节标题" }]}><Input /></Form.Item>
              <Button type="default" icon={<HighlightOutlined />} loading={generateChapterTitle.isPending || Boolean(chapterTitleWorkflowId)} disabled={chapterModal !== "edit" || !selectedDocument} onClick={() => void startChapterTitleGeneration()}>AI 更名</Button>
            </Space.Compact>
          </Form.Item>
          <Form.Item name="narrativeOrder" label="章节序号"><Input type="number" /></Form.Item>
          <Form.Item name="povCharacterId" label="POV 角色 ID"><Input /></Form.Item>
          <Form.Item name="chapterGoal" label="章节目标"><Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} placeholder="说明本章承担的叙事功能与预期状态变化" /></Form.Item>
          <Form.Item name="status" label="状态" initialValue="planned"><Select options={DOCUMENT_STATUSES} /></Form.Item>
          <Button type="primary" htmlType="submit" block loading={createDocument.isPending || updateDocument.isPending}>保存章节</Button>
        </Form>
      </Modal>

    </div>
  );
}
