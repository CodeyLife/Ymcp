import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Alert, Button, Descriptions, Form, Input, Modal, Popconfirm, Select, Space, Spin, Tabs, Tag, Typography, message } from "antd";
import {
  ArrowLeftOutlined,
  AuditOutlined,
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  EyeOutlined,
  FileAddOutlined,
  ReloadOutlined,
  SendOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "motion/react";
import "./novel-v2.css";
import { describeEvent, documentStatusMeta, relativeTime, shortId, statusMeta, workflowTypeMeta } from "./novel-v2/presentation";
import ArtifactContentModal, { ArtifactCard, type ArtifactSummary } from "./novel-v2/ArtifactContentModal";

// 懒加载子面板，避免主 bundle 过大
const EvaluationPanel = lazy(() => import("./novel-v2/EvaluationPanel").then((m) => ({ default: m.default })));
const CreativeRunPanel = lazy(() => import("./novel-v2/CreativeRunPanel").then((m) => ({ default: m.default })));
const McpToolGatewayPanel = lazy(() => import("./novel-v2/McpToolGatewayPanel").then((m) => ({ default: m.default })));
const KnowledgeWorkbenchPanel = lazy(() => import("./novel-v2/KnowledgeWorkbenchPanel").then((m) => ({ default: m.default })));
const ProjectPlanPanel = lazy(() => import("./novel-v2/ProjectPlanPanel").then((m) => ({ default: m.default })));
const StoryArcPanel = lazy(() => import("./novel-v2/StoryArcPanel").then((m) => ({ default: m.default })));

type DocumentSummary = { id: string; title: string; narrativeOrder: number; status: string; povCharacterId?: string; wordCount?: number; latestRevision?: number; blockingIssueCount?: number; arcId?: string; arcTitle?: string; arcPlanningStatus?: string };
type WorkflowRunRecord = { id: string; workflowType: string; projectId: string; temporalWorkflowId: string; status: string; payload: Record<string, unknown>; createdAt: string; updatedAt: string };
type ProjectDetail = { id: string; title: string; currentRevision: number; updatedAt: string; documents: DocumentSummary[]; latestRuns?: WorkflowRunRecord[] };
type Run = { workflowId: string; status: string; runId?: string; record?: WorkflowRunRecord };
type EventSummary = { id?: number; event_type?: string; eventType?: string; payload?: unknown; created_at?: string; createdAt?: string };
type DocumentContent = { documentId: string; title: string; status: string; revision: number; contentHash: string; plainText: string };
type FactCandidate = { id: string; title: string; content: string; confidence: number; subjectRefs: string[]; authority: "candidate" };

const statusOptions = ["planned", "draft", "review", "revision", "final", "archived"].map((value) => ({ value, label: documentStatusMeta(value).label }));

function eventTime(event: EventSummary) {
  return event.created_at ?? event.createdAt;
}

const STUDIO_TABS = [
  { key: "plan", label: "全书规划" },
  { key: "arcs", label: "故事弧" },
  { key: "studio", label: "章节创作" },
  { key: "knowledge", label: "创作资料" },
  { key: "evaluation", label: "评估闭环" },
  { key: "creative", label: "创意执行" },
  { key: "mcp", label: "MCP 工具" },
] as const;

export default function NovelV2Studio() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<ProjectDetail>();
  const [objective, setObjective] = useState("");
  const [targetDocumentId, setTargetDocumentId] = useState<string>();
  const [run, setRun] = useState<Run>();
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([]);
  const [error, setError] = useState<string>();
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [documentOpen, setDocumentOpen] = useState(false);
  const [editingDocument, setEditingDocument] = useState<DocumentSummary>();
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [documentContent, setDocumentContent] = useState<DocumentContent>();
  const [contentLoading, setContentLoading] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewInstruction, setReviewInstruction] = useState("从严审视叙事逻辑、人物声音、连续性、场景呈现与读者留存，并只修改有明确证据的问题。");
  const [authorEditOpen, setAuthorEditOpen] = useState(false);
  const [authorText, setAuthorText] = useState("");
  const [factCandidates, setFactCandidates] = useState<FactCandidate[]>([]);
  const [factApprovalOpen, setFactApprovalOpen] = useState(false);
  const [viewingArtifact, setViewingArtifact] = useState<ArtifactSummary | null>(null);

  async function readJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
    const response = await fetch(input, init);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "V2 API 请求失败");
    return body as T;
  }

  async function loadProject() {
    const body = await readJson<{ project: ProjectDetail }>(`/v2/projects/${encodeURIComponent(projectId)}`);
    setProject(body.project);
    setRuns(body.project.latestRuns ?? []);
    setTargetDocumentId((current) => current ?? body.project.documents[0]?.id);
  }

  async function loadRuns() {
    const body = await readJson<{ runs: WorkflowRunRecord[] }>(`/v2/projects/${encodeURIComponent(projectId)}/runs`);
    setRuns(body.runs ?? []);
  }

  async function loadDocumentContent(documentId: string) {
    setContentLoading(true);
    try {
      setDocumentContent(await readJson<DocumentContent>(`/v2/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/content`));
    } catch {
      setDocumentContent(undefined);
    } finally {
      setContentLoading(false);
    }
  }

  async function loadFactCandidates(documentId: string) {
    const body = await readJson<{ candidates: FactCandidate[] }>(`/v2/projects/${encodeURIComponent(projectId)}/fact-candidates?documentId=${encodeURIComponent(documentId)}`);
    setFactCandidates(body.candidates ?? []);
  }

  useEffect(() => {
    if (projectId) void loadProject().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [projectId]);

  useEffect(() => {
    if (targetDocumentId) {
      void loadDocumentContent(targetDocumentId);
      void loadFactCandidates(targetDocumentId).catch(() => setFactCandidates([]));
    } else {
      setDocumentContent(undefined);
      setFactCandidates([]);
    }
  }, [projectId, targetDocumentId]);

  async function decideFactCandidate(claimId: string, decision: "approve" | "reject") {
    if (!targetDocumentId) return;
    await readJson(`/v2/projects/${encodeURIComponent(projectId)}/fact-candidates/${encodeURIComponent(claimId)}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, actorId: "web-author" }),
    });
    await loadFactCandidates(targetDocumentId);
    message.success(decision === "approve" ? "事实已批准" : "事实已拒绝");
  }

  async function startChapterReview(proposedText?: string) {
    if (!targetDocumentId) return;
    const body = await readJson<{ workflowId: string; runId?: string }>(`/v2/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(targetDocumentId)}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: reviewInstruction, proposedText, idempotencyKey: `${projectId}:${targetDocumentId}:review:${Date.now()}` }),
    });
    setReviewOpen(false);
    setAuthorEditOpen(false);
    setRun({ workflowId: body.workflowId, status: "accepted", runId: body.runId });
    await loadRuns();
    message.success("章节重审工作流已启动");
  }

  async function createDocument(values: { title: string; narrativeOrder?: number | string; povCharacterId?: string; status?: string }) {
    const body = await readJson<{ document: DocumentSummary }>(`/v2/projects/${encodeURIComponent(projectId)}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...values, narrativeOrder: values.narrativeOrder === undefined || values.narrativeOrder === "" ? undefined : Number(values.narrativeOrder) }),
    });
    setDocumentOpen(false);
    form.resetFields();
    await loadProject();
    setTargetDocumentId(body.document.id);
    message.success("章节目标已创建");
  }

  async function updateDocument(values: { title: string; narrativeOrder?: number | string; povCharacterId?: string; status?: string }) {
    if (!editingDocument) return;
    await readJson<{ document: DocumentSummary }>(`/v2/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(editingDocument.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...values, narrativeOrder: values.narrativeOrder === undefined || values.narrativeOrder === "" ? undefined : Number(values.narrativeOrder), povCharacterId: values.povCharacterId?.trim() || null }),
    });
    setEditingDocument(undefined);
    await loadProject();
    message.success("章节已更新");
  }

  async function deleteDocument(document: DocumentSummary) {
    await readJson(`/v2/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(document.id)}`, { method: "DELETE" });
    if (targetDocumentId === document.id) setTargetDocumentId(undefined);
    await loadProject();
    message.success("章节已删除");
  }

  async function submit() {
    setError(undefined);
    const target = targetDocumentId ? { kind: "chapter", id: targetDocumentId } : undefined;
    try {
      const body = await readJson<{ workflowId: string; runId?: string }>("/v2/intents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, objective, idempotencyKey: `${projectId}:${Date.now()}`, source: "web", requestedStage: target ? "drafting" : "planning", target }),
      });
      setRun({ workflowId: body.workflowId, status: "received", runId: body.runId });
      setObjective("");
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refresh(targetRun = run) {
    if (!targetRun) return;
    const [state, eventData, artifactData] = await Promise.all([
      readJson<Run>(`/v2/runs/${encodeURIComponent(targetRun.workflowId)}`),
      readJson<{ events: EventSummary[] }>(`/v2/runs/${encodeURIComponent(targetRun.workflowId)}/events`),
      readJson<{ artifacts: ArtifactSummary[] }>(`/v2/runs/${encodeURIComponent(targetRun.workflowId)}/artifacts`),
    ]);
    setRun(state);
    setEvents(eventData.events ?? []);
    setArtifacts(artifactData.artifacts ?? []);
    await Promise.all([loadProject(), loadRuns()]);
  }

  async function decideManualRun(decision: "approve" | "reject") {
    if (!run) return;
    const artifactId = typeof run.record?.payload.artifactId === "string" ? run.record.payload.artifactId : undefined;
    if (!artifactId) throw new Error("运行记录缺少待审批 artifactId");
    await readJson(`/v2/workflows/${encodeURIComponent(run.workflowId)}/tasks/${encodeURIComponent(artifactId)}/signal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signal: "humanSignal", payload: { decision, authorId: "web-author" } }),
    });
    message.success(decision === "approve" ? "已提交作者批准，Runtime 将继续提交与角色富化" : "已拒绝该稿件");
    await refresh(run);
  }

  useEffect(() => {
    if (!run) return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [run?.workflowId]);

  const selectedDocument = useMemo(() => project?.documents.find((document) => document.id === targetDocumentId), [project?.documents, targetDocumentId]);
  const documentOptions = project?.documents.map((document) => ({ value: document.id, label: `第 ${document.narrativeOrder} 章 · ${document.title}` })) ?? [];

  return (
    <div className="novel-v2-page novel-v2-studio-page">
      {/* ===== TOPBAR ===== */}
      <motion.header
        className="novel-topbar"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
      >
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate("/novels")}>
          作品列表
        </Button>
        <div className="novel-topbar-body" style={{ minWidth: 0 }}>
          <span className="novel-eyebrow">章节工作室</span>
          <h2 className="novel-display-h2" style={{ marginTop: 2 }}>
            {project?.title ?? projectId}
          </h2>
        </div>
        <div className="novel-topbar-actions">
          <span className="novel-status-pill novel-status-pill-done">
            revision {project?.currentRevision ?? 0}
          </span>
          <Button
            type="primary"
            ghost
            icon={<EyeOutlined />}
            onClick={() => navigate(`/novels/${encodeURIComponent(projectId)}/showcase`)}
          >
            工作流全景
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => Promise.all([loadProject(), loadRuns()]).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}>
            刷新
          </Button>
        </div>
      </motion.header>

      {error && <Alert type="error" showIcon message={error} className="novel-v2-alert" closable onClose={() => setError(undefined)} />}

      <Tabs
        defaultActiveKey="plan"
        className="novel-studio-tabs"
        items={[
          {
            key: "plan",
            label: STUDIO_TABS[0].label,
            children: <Suspense fallback={<div className="novel-empty"><Spin /></div>}><ProjectPlanPanel projectId={projectId} /></Suspense>,
          },
          {
            key: "arcs",
            label: STUDIO_TABS[1].label,
            children: <Suspense fallback={<div className="novel-empty"><Spin /></div>}><StoryArcPanel projectId={projectId} onApplied={() => void loadProject()} /></Suspense>,
          },
          {
            key: "studio",
            label: STUDIO_TABS[2].label,
            children: (
              <section className="novel-studio-grid">
                {/* ===== 章节轨（左栏）===== */}
                <motion.aside
                  className="novel-chapter-rail"
                  initial={{ opacity: 0, x: -14 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="novel-chapter-rail-head">
                    <div className="novel-chapter-rail-head-body">
                      <strong>章节目标</strong>
                      <span>{project?.documents.length ?? 0} 章</span>
                    </div>
                  </div>
                  <div className="novel-chapter-list">
                    {(project?.documents ?? []).map((document, index, documents) => (
                      <div key={document.id} className="novel-chapter-group-item">
                      {(index === 0 || documents[index - 1]?.arcId !== document.arcId) && <div className="novel-chapter-group-label"><span>{document.arcTitle ?? "未归属故事弧"}</span>{document.arcPlanningStatus && <Tag>{document.arcPlanningStatus === "approved" ? "蓝图有效" : document.arcPlanningStatus}</Tag>}</div>}
                      <motion.button
                        key={document.id}
                        className={`novel-chapter-card ${targetDocumentId === document.id ? "is-active" : ""}`}
                        onClick={() => setTargetDocumentId(document.id)}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.35, delay: Math.min(index * 0.04, 0.24), ease: [0.16, 1, 0.3, 1] }}
                      >
                        <span className="novel-chapter-num">{String(document.narrativeOrder).padStart(2, "0")}</span>
                        <span className="novel-chapter-card-body">
                          <span className="novel-chapter-card-title">{document.title}</span>
                          <span className="novel-chapter-card-meta">
                            <Tag>{documentStatusMeta(document.status).label}</Tag>
                            {document.latestRevision !== undefined && <Tag>r{document.latestRevision}</Tag>}
                          </span>
                        </span>
                      </motion.button></div>
                    ))}
                    {!project?.documents.length && (
                      <div className="novel-empty" style={{ padding: "32px 12px" }}>
                        <div className="novel-empty-mark" style={{ width: 44, height: 44, fontSize: 18 }}>
                          <FileAddOutlined />
                        </div>
                        <div className="novel-empty-desc" style={{ fontSize: 12.5 }}>
                          请先在故事弧页批准整弧蓝图
                        </div>
                      </div>
                    )}
                  </div>
                </motion.aside>

                {/* ===== 焦点命令栏（中栏）===== */}
                <motion.section
                  className="novel-focal-panel"
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.55, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
                >
                  {/* 提交 Intent —— 焦点卡 */}
                  <div className="novel-focal-card">
                    <div className="novel-focal-card-head">
                      <h3>提交创作 Intent</h3>
                      <span className="novel-status-pill novel-status-pill-done">Web 交互 · Runtime 持久化</span>
                    </div>
                    <div className="novel-focal-card-body">
                      <Select
                        allowClear
                        placeholder="选择已批准故事弧中的章节"
                        value={targetDocumentId}
                        options={documentOptions}
                        onChange={setTargetDocumentId}
                        style={{ width: "100%" }}
                      />
                      <Input.TextArea
                        value={objective}
                        onChange={(event) => setObjective(event.target.value)}
                        placeholder="例如：根据当前记忆和 Skill 创作下一章，并保持已知事实一致"
                        autoSize={{ minRows: 4, maxRows: 8 }}
                      />
                      {selectedDocument?.arcPlanningStatus && selectedDocument.arcPlanningStatus !== "approved" && <Alert type="warning" showIcon message="故事弧蓝图已失效，请先重基线并重新批准。" />}
                      <Button type="primary" size="large" icon={<SendOutlined />} disabled={!objective.trim() || !selectedDocument || selectedDocument.arcPlanningStatus !== "approved"} onClick={() => void submit()} block>
                        提交到 Temporal Runtime
                      </Button>
                    </div>
                  </div>

                  {/* 当前章节 —— 支撑卡 */}
                  <div className="novel-card-support">
                    <div className="novel-card-head">
                      <h3 className="novel-display-h3">当前章节</h3>
                      {selectedDocument && (
                        <Space className="novel-v2-document-actions" style={{ marginTop: 0 }}>
                          <Button size="small" icon={<EditOutlined />} onClick={() => { setEditingDocument(selectedDocument); editForm.setFieldsValue(selectedDocument); }}>
                            编辑
                          </Button>
                          <Popconfirm title="删除章节目标" okText="删除" okButtonProps={{ danger: true }} onConfirm={() => deleteDocument(selectedDocument)}>
                            <Button size="small" danger icon={<DeleteOutlined />}>
                              删除
                            </Button>
                          </Popconfirm>
                        </Space>
                      )}
                    </div>
                    {selectedDocument ? (
                      <>
                        <Descriptions column={2} size="small">
                          <Descriptions.Item label="标题">{selectedDocument.title}</Descriptions.Item>
                          <Descriptions.Item label="状态"><Tag>{documentStatusMeta(selectedDocument.status).label}</Tag></Descriptions.Item>
                          <Descriptions.Item label="序号">{selectedDocument.narrativeOrder}</Descriptions.Item>
                          <Descriptions.Item label="POV">{selectedDocument.povCharacterId ?? "未设置"}</Descriptions.Item>
                          <Descriptions.Item label="估算字数">{selectedDocument.wordCount ?? 0}</Descriptions.Item>
                          <Descriptions.Item label="阻塞问题">{selectedDocument.blockingIssueCount ?? 0}</Descriptions.Item>
                        </Descriptions>
                        <div className="novel-manuscript-preview">
                          <div className="novel-card-head">
                            <strong>定稿正文</strong>
                            <Space>
                              {documentContent && <Tag>r{documentContent.revision}</Tag>}
                              {documentContent && <Button size="small" icon={<EditOutlined />} onClick={() => { setAuthorText(documentContent.plainText); setAuthorEditOpen(true); }}>编辑正文</Button>}
                              {factCandidates.length > 0 && <Button size="small" icon={<AuditOutlined />} onClick={() => setFactApprovalOpen(true)}>事实候选 {factCandidates.length}</Button>}
                              {selectedDocument.status === "final" && <Button size="small" type="primary" icon={<AuditOutlined />} onClick={() => setReviewOpen(true)}>重审优化</Button>}
                            </Space>
                          </div>
                          {contentLoading ? <Spin size="small" /> : documentContent
                            ? <div className="novel-manuscript-text novel-manuscript-scroll">{documentContent.plainText}</div>
                            : <div className="novel-empty-desc">尚无定稿正文</div>}
                        </div>
                      </>
                    ) : (
                      <div className="novel-empty" style={{ padding: "24px 12px", textAlign: "center" }}>
                        <div className="novel-empty-desc">请选择章节目标</div>
                      </div>
                    )}
                  </div>

                  {/* 最近运行 —— 支撑卡 */}
                  <div className="novel-card-support">
                    <div className="novel-card-head">
                      <h3 className="novel-display-h3">最近运行</h3>
                      <span className="novel-card-mini-hint">{runs.length} 条记录</span>
                    </div>
                    {runs.length ? (
                      <div className="novel-run-list">
                        {runs.map((item) => {
                          const wfMeta = workflowTypeMeta(item.workflowType);
                          const stMeta = statusMeta(item.status);
                          return (
                            <div
                              key={item.id}
                              className="novel-run-item"
                              onClick={() => {
                                const next = { workflowId: item.temporalWorkflowId, status: item.status, record: item };
                                setRun(next);
                                void refresh(next);
                              }}
                            >
                              <div className="novel-run-item-left">
                                <div className="novel-run-item-header">
                                  <Space size={6} align="center">
                                    <span className="novel-run-item-icon">{wfMeta.icon}</span>
                                    <span className="novel-run-item-title">{wfMeta.label}</span>
                                    <span className={stMeta.pill}>{stMeta.label}</span>
                                  </Space>
                                </div>
                                <div className="novel-run-item-meta">
                                  <code>{shortId(item.temporalWorkflowId)}</code>
                                  <span className="novel-run-item-time">{relativeTime(item.updatedAt)}</span>
                                </div>
                              </div>
                              <Button
                                type="link"
                                size="small"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const next = { workflowId: item.temporalWorkflowId, status: item.status, record: item };
                                  setRun(next);
                                  void refresh(next);
                                }}
                              >
                                查看
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="novel-empty" style={{ padding: "24px 12px", textAlign: "center" }}>
                        <div className="novel-empty-desc">暂无运行记录</div>
                      </div>
                    )}
                  </div>
                </motion.section>

                {/* ===== 观察者栏（右栏）===== */}
                <motion.aside
                  className="novel-observer-panel"
                  initial={{ opacity: 0, x: 14 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.5, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="novel-observer-head">
                    <div className="novel-observer-head-body">
                      <strong>运行观察</strong>
                      {run ? <code>{shortId(run.workflowId)}</code> : <code>未选择运行</code>}
                    </div>
                    {run && (
                      <Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()} />
                    )}
                  </div>

                  {run ? (
                    <>
                      <div>
                        <div className="novel-section-label" style={{ margin: "0 0 8px" }}>
                          状态
                        </div>
                        {(() => {
                          const stMeta = statusMeta(run.status);
                          return (
                            <div className="novel-observer-status-block">
                              <span className={stMeta.pill}>
                                {stMeta.icon}
                                <span style={{ marginLeft: 4 }}>{stMeta.label}</span>
                              </span>
                              <code className="novel-observer-wf-id">{shortId(run.workflowId, 12)}</code>
                            </div>
                          );
                        })()}
                        {run.status === "manual-review-required" && (
                          <Space wrap style={{ marginTop: 12 }}>
                            <Popconfirm title="批准当前稿件并继续正式提交？" okText="批准" onConfirm={() => decideManualRun("approve").catch((err: unknown) => message.error(err instanceof Error ? err.message : String(err)))}>
                              <Button type="primary" icon={<AuditOutlined />}>批准定稿</Button>
                            </Popconfirm>
                            <Popconfirm title="拒绝当前稿件并结束工作流？" okText="拒绝" okButtonProps={{ danger: true }} onConfirm={() => decideManualRun("reject").catch((err: unknown) => message.error(err instanceof Error ? err.message : String(err)))}>
                              <Button danger>拒绝</Button>
                            </Popconfirm>
                          </Space>
                        )}
                      </div>

                      <div>
                        <div className="novel-section-label">事件流</div>
                        {events.length ? (
                          <div className="novel-event-timeline">
                            {events.slice(0, 12).map((event, idx) => {
                              const key = String(event.id ?? idx);
                              const desc = describeEvent(event.event_type ?? event.eventType, event.payload);
                              const isExpanded = expandedEvents.has(key);
                              const hasPayload = event.payload !== undefined && event.payload !== null;
                              const hasFields = desc.fields && desc.fields.length > 0;
                              return (
                                <div className="novel-event-item" key={key}>
                                  <div className="novel-event-item-header">
                                    <Space size={6} align="center" wrap={false}>
                                      <span className="novel-event-item-icon">{desc.icon}</span>
                                      <span className="novel-event-item-title">{desc.label}</span>
                                      <Tag className="novel-event-item-cat">{desc.category}</Tag>
                                    </Space>
                                    <div className="novel-event-item-time">
                                      {eventTime(event) ? relativeTime(eventTime(event)) : ""}
                                    </div>
                                  </div>
                                  <div className="novel-event-item-summary">{desc.summary}</div>
                                  {hasFields && (
                                    <div className="novel-event-item-fields">
                                      {desc.fields!.map((field, fieldIdx) => (
                                        <div className="novel-event-item-field" key={fieldIdx}>
                                          <span className="novel-event-item-field-label">{field.label}</span>
                                          <code className={field.mono ? "novel-event-item-field-value-mono" : "novel-event-item-field-value"}>{field.value}</code>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  {hasPayload && (
                                    <div
                                      className="novel-event-item-raw-toggle"
                                      onClick={() => setExpandedEvents((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(key)) next.delete(key);
                                        else next.add(key);
                                        return next;
                                      })}
                                    >
                                      <DownOutlined className={`novel-event-item-toggle ${isExpanded ? "is-open" : ""}`} />
                                      <span>{isExpanded ? "收起原始数据" : "原始数据"}</span>
                                    </div>
                                  )}
                                  {isExpanded && hasPayload && (
                                    <pre className="novel-event-item-payload">{JSON.stringify(event.payload, null, 2)}</pre>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="novel-empty" style={{ padding: "16px 8px", textAlign: "center" }}>
                            <div className="novel-empty-desc" style={{ fontSize: 12 }}>
                              暂无事件
                            </div>
                          </div>
                        )}
                      </div>

                      <div>
                        <div className="novel-section-label">产物</div>
                        {artifacts.length ? (
                          <div className="novel-artifact-list">
                            {artifacts.map((artifact) => (
                              <ArtifactCard
                                key={artifact.id}
                                artifact={artifact}
                                onView={(item) => setViewingArtifact(item)}
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="novel-empty" style={{ padding: "16px 8px", textAlign: "center" }}>
                            <div className="novel-empty-desc" style={{ fontSize: 12 }}>
                              暂无产物
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="novel-empty" style={{ padding: "40px 16px", textAlign: "center" }}>
                      <div className="novel-empty-mark">
                        <ThunderboltOutlined />
                      </div>
                      <div className="novel-empty-title" style={{ marginTop: 12 }}>
                        等待运行
                      </div>
                      <div className="novel-empty-desc">提交或选择运行后查看事件、产物与审核结果。</div>
                    </div>
                  )}
                </motion.aside>
              </section>
            ),
          },
          {
            key: "evaluation",
            label: STUDIO_TABS[4].label,
            children: (
              <Suspense
                fallback={
                  <div className="novel-empty">
                    <Spin />
                  </div>
                }
              >
                <EvaluationPanel projectId={projectId} />
              </Suspense>
            ),
          },
          {
            key: "creative",
            label: STUDIO_TABS[5].label,
            children: (
              <Suspense
                fallback={
                  <div className="novel-empty">
                    <Spin />
                  </div>
                }
              >
                <CreativeRunPanel projectId={projectId} />
              </Suspense>
            ),
          },
          {
            key: "mcp",
            label: STUDIO_TABS[6].label,
            children: (
              <Suspense
                fallback={
                  <div className="novel-empty">
                    <Spin />
                  </div>
                }
              >
                <McpToolGatewayPanel />
              </Suspense>
            ),
          },
          {
            key: "knowledge",
            label: STUDIO_TABS[3].label,
            children: (
              <Suspense fallback={<div className="novel-empty"><Spin /></div>}>
                <KnowledgeWorkbenchPanel projectId={projectId} />
              </Suspense>
            ),
          },
        ]}
      />

      <Modal title="严苛审校并优化定稿" open={reviewOpen} onCancel={() => setReviewOpen(false)} onOk={() => startChapterReview().catch((err: unknown) => message.error(err instanceof Error ? err.message : String(err)))} okText="启动重审">
        <Typography.Paragraph type="secondary">复用正式章节的审核、局部修订、事实提取、提交、角色富化与 learning 闭环。</Typography.Paragraph>
        <Input.TextArea value={reviewInstruction} onChange={(event) => setReviewInstruction(event.target.value)} autoSize={{ minRows: 4, maxRows: 8 }} />
      </Modal>

      <Modal width={900} title="编辑正文并提交审校" open={authorEditOpen} onCancel={() => setAuthorEditOpen(false)} onOk={() => startChapterReview(authorText).catch((err: unknown) => message.error(err instanceof Error ? err.message : String(err)))} okText="提交审校" okButtonProps={{ disabled: !authorText.trim() }}>
        <Typography.Paragraph type="secondary">作者修改先保存为不可变 proposal，再复用正式审核、修订、事实提取与提交闭环；不会直接覆盖定稿。</Typography.Paragraph>
        <Input.TextArea value={authorText} onChange={(event) => setAuthorText(event.target.value)} autoSize={{ minRows: 18, maxRows: 28 }} />
      </Modal>

      <Modal width={720} title="事实候选审批" open={factApprovalOpen} onCancel={() => setFactApprovalOpen(false)} footer={null}>
        <Typography.Paragraph type="secondary">仅批准正文明确支持的事实。未决与已拒绝事实不会进入后续创作检索。</Typography.Paragraph>
        <div className="novel-fact-candidate-list">
          {factCandidates.length ? factCandidates.map((candidate) => (
            <div className="novel-fact-candidate" key={candidate.id}>
              <div className="novel-fact-candidate-body">
                <strong>{candidate.title}</strong>
                <Typography.Paragraph>{candidate.content}</Typography.Paragraph>
                <Space size={6} wrap>
                  <Tag>置信度 {Math.round(candidate.confidence * 100)}%</Tag>
                  {candidate.subjectRefs.map((subject) => <Tag key={subject}>{subject}</Tag>)}
                </Space>
              </div>
              <Space>
                <Popconfirm title="拒绝该事实候选？" okText="拒绝" okButtonProps={{ danger: true }} onConfirm={() => decideFactCandidate(candidate.id, "reject").catch((err: unknown) => message.error(err instanceof Error ? err.message : String(err)))}>
                  <Button danger icon={<CloseOutlined />}>拒绝</Button>
                </Popconfirm>
                <Button type="primary" icon={<CheckOutlined />} onClick={() => decideFactCandidate(candidate.id, "approve").catch((err: unknown) => message.error(err instanceof Error ? err.message : String(err)))}>批准</Button>
              </Space>
            </div>
          )) : <div className="novel-empty-desc">当前章节没有待审批事实</div>}
        </div>
      </Modal>

      <Modal title="新增章节目标" open={documentOpen} onCancel={() => setDocumentOpen(false)} footer={null} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(values) => createDocument(values).catch((err: unknown) => message.error(err instanceof Error ? err.message : String(err)))}>
          <Form.Item name="title" label="章节标题" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="narrativeOrder" label="章节序号">
            <Input type="number" />
          </Form.Item>
          <Form.Item name="povCharacterId" label="POV 角色 ID">
            <Input />
          </Form.Item>
          <Form.Item name="status" label="状态" initialValue="planned">
            <Select options={statusOptions} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            创建章节目标
          </Button>
        </Form>
      </Modal>

      <Modal title="编辑章节" open={Boolean(editingDocument)} onCancel={() => setEditingDocument(undefined)} footer={null} destroyOnHidden>
        <Form form={editForm} layout="vertical" onFinish={(values) => updateDocument(values).catch((err: unknown) => message.error(err instanceof Error ? err.message : String(err)))}>
          <Form.Item name="title" label="章节标题" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="narrativeOrder" label="章节序号">
            <Input type="number" />
          </Form.Item>
          <Form.Item name="povCharacterId" label="POV 角色 ID">
            <Input />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select options={statusOptions} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            保存章节
          </Button>
        </Form>
      </Modal>

      <ArtifactContentModal
        artifact={viewingArtifact}
        open={viewingArtifact !== null}
        onClose={() => setViewingArtifact(null)}
      />
    </div>
  );
}
