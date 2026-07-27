import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Descriptions, Empty, Form, Input, List, Modal, Popconfirm, Select, Space, Tag, Timeline, Typography, message } from "antd";
import { ArrowLeftOutlined, DeleteOutlined, EditOutlined, FileAddOutlined, ReloadOutlined, SendOutlined } from "@ant-design/icons";
import { useNavigate, useParams } from "react-router-dom";
import "./novel-v2.css";

type DocumentSummary = { id: string; title: string; narrativeOrder: number; status: string; povCharacterId?: string; wordCount?: number; latestRevision?: number; blockingIssueCount?: number };
type WorkflowRunRecord = { id: string; workflowType: string; projectId: string; temporalWorkflowId: string; status: string; payload: Record<string, unknown>; createdAt: string; updatedAt: string };
type ProjectDetail = { id: string; title: string; currentRevision: number; updatedAt: string; documents: DocumentSummary[]; latestRuns?: WorkflowRunRecord[] };
type Run = { workflowId: string; status: string; runId?: string; record?: WorkflowRunRecord };
type ArtifactSummary = { id: string; kind: string; taskId: string; fingerprint: string; structuredData?: Record<string, unknown>; createdAt: number };
type EventSummary = { id?: number; event_type?: string; eventType?: string; payload?: unknown; created_at?: string; createdAt?: string };

const statusOptions = ["planned", "draft", "review", "revision", "final", "archived"].map((value) => ({ value, label: value }));

function eventTitle(event: EventSummary) { return event.event_type ?? event.eventType ?? "event"; }
function eventTime(event: EventSummary) { return event.created_at ?? event.createdAt; }

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
  const [documentOpen, setDocumentOpen] = useState(false);
  const [editingDocument, setEditingDocument] = useState<DocumentSummary>();
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();

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

  useEffect(() => { if (projectId) void loadProject().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))); }, [projectId]);

  async function createDocument(values: { title: string; narrativeOrder?: number | string; povCharacterId?: string; status?: string }) {
    const body = await readJson<{ document: DocumentSummary }>(`/v2/projects/${encodeURIComponent(projectId)}/documents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...values, narrativeOrder: values.narrativeOrder === undefined || values.narrativeOrder === "" ? undefined : Number(values.narrativeOrder) }) });
    setDocumentOpen(false);
    form.resetFields();
    await loadProject();
    setTargetDocumentId(body.document.id);
    message.success("章节目标已创建");
  }

  async function updateDocument(values: { title: string; narrativeOrder?: number | string; povCharacterId?: string; status?: string }) {
    if (!editingDocument) return;
    await readJson<{ document: DocumentSummary }>(`/v2/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(editingDocument.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...values, narrativeOrder: values.narrativeOrder === undefined || values.narrativeOrder === "" ? undefined : Number(values.narrativeOrder), povCharacterId: values.povCharacterId?.trim() || null }) });
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
      const body = await readJson<{ workflowId: string; runId?: string }>("/v2/intents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, objective, idempotencyKey: `${projectId}:${Date.now()}`, source: "web", requestedStage: target ? "drafting" : "planning", target }) });
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

  useEffect(() => { if (!run) return; const timer = window.setInterval(() => void refresh(), 3000); return () => window.clearInterval(timer); }, [run?.workflowId]);

  const selectedDocument = useMemo(() => project?.documents.find((document) => document.id === targetDocumentId), [project?.documents, targetDocumentId]);
  const documentOptions = project?.documents.map((document) => ({ value: document.id, label: `第 ${document.narrativeOrder} 章 · ${document.title}` })) ?? [];

  return (
    <main className="novel-v2-page novel-v2-studio-page">
      <header className="novel-v2-studio-topbar">
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate("/novels")}>作品列表</Button>
        <div>
          <div className="novel-v2-kicker">NOVEL V2 / STUDIO</div>
          <Typography.Title level={2}>{project?.title ?? projectId}</Typography.Title>
        </div>
        <Space>
          <Tag color="blue">revision {project?.currentRevision ?? 0}</Tag>
          <Button icon={<ReloadOutlined />} onClick={() => Promise.all([loadProject(), loadRuns()]).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}>刷新</Button>
        </Space>
      </header>

      {error && <Alert type="error" showIcon message={error} className="novel-v2-alert" />}

      <section className="novel-v2-studio-grid">
        <aside className="novel-v2-panel novel-v2-chapter-panel">
          <div className="novel-v2-panel-head">
            <div><strong>章节目标</strong><span>{project?.documents.length ?? 0} 个</span></div>
            <Button size="small" icon={<FileAddOutlined />} onClick={() => setDocumentOpen(true)}>新增</Button>
          </div>
          <div className="novel-v2-chapter-list">
            {(project?.documents ?? []).map((document) => (
              <button key={document.id} className={`novel-v2-chapter-item ${targetDocumentId === document.id ? "is-active" : ""}`} onClick={() => setTargetDocumentId(document.id)}>
                <span className="novel-v2-chapter-title">第 {document.narrativeOrder} 章 · {document.title}</span>
                <span className="novel-v2-chapter-meta"><Tag>{document.status}</Tag>{document.latestRevision !== undefined && <Tag>r{document.latestRevision}</Tag>}</span>
              </button>
            ))}
            {!project?.documents.length && <Empty description="还没有章节目标" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          </div>
        </aside>

        <section className="novel-v2-panel novel-v2-command-panel">
          <Card title="提交创作 Intent" extra={<Tag color="green">Web 仅交互 · Runtime 持久化</Tag>}>
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Select allowClear placeholder="选择章节目标（留空为规划任务）" value={targetDocumentId} options={documentOptions} onChange={setTargetDocumentId} />
              <Input.TextArea value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="例如：根据当前记忆和 Skill 创作下一章，并保持已知事实一致" autoSize={{ minRows: 4, maxRows: 8 }} />
              <Button type="primary" icon={<SendOutlined />} disabled={!objective.trim()} onClick={() => void submit()}>提交到 Temporal Runtime</Button>
            </Space>
          </Card>

          <Card title="当前章节" className="novel-v2-card">
            {selectedDocument ? (
              <Descriptions column={2} size="small">
                <Descriptions.Item label="标题">{selectedDocument.title}</Descriptions.Item>
                <Descriptions.Item label="状态"><Tag>{selectedDocument.status}</Tag></Descriptions.Item>
                <Descriptions.Item label="序号">{selectedDocument.narrativeOrder}</Descriptions.Item>
                <Descriptions.Item label="POV">{selectedDocument.povCharacterId ?? "未设置"}</Descriptions.Item>
                <Descriptions.Item label="估算字节/字数">{selectedDocument.wordCount ?? 0}</Descriptions.Item>
                <Descriptions.Item label="阻塞问题">{selectedDocument.blockingIssueCount ?? 0}</Descriptions.Item>
              </Descriptions>
            ) : <Empty description="请选择章节目标" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
            {selectedDocument && <Space className="novel-v2-document-actions"><Button icon={<EditOutlined />} onClick={() => { setEditingDocument(selectedDocument); editForm.setFieldsValue(selectedDocument); }}>编辑章节</Button><Popconfirm title="删除章节目标" okText="删除" okButtonProps={{ danger: true }} onConfirm={() => deleteDocument(selectedDocument)}><Button danger icon={<DeleteOutlined />}>删除</Button></Popconfirm></Space>}
          </Card>

          <Card title="最近运行" className="novel-v2-card">
            <List size="small" dataSource={runs} locale={{ emptyText: "暂无运行记录" }} renderItem={(item) => <List.Item actions={[<Button type="link" onClick={() => { const next = { workflowId: item.temporalWorkflowId, status: item.status, record: item }; setRun(next); void refresh(next); }}>查看</Button>]}><List.Item.Meta title={item.temporalWorkflowId} description={<><Tag>{item.status}</Tag><span>{new Date(item.updatedAt).toLocaleString("zh-CN")}</span></>} /></List.Item>} />
          </Card>
        </section>

        <aside className="novel-v2-panel novel-v2-observer-panel">
          <div className="novel-v2-panel-head"><div><strong>运行观察</strong><span>{run?.workflowId ?? "未选择运行"}</span></div>{run && <Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()}>刷新</Button>}</div>
          {run ? (
            <>
              <Descriptions size="small" column={1} className="novel-v2-run-desc"><Descriptions.Item label="Workflow">{run.workflowId}</Descriptions.Item><Descriptions.Item label="状态"><Tag>{run.status}</Tag></Descriptions.Item></Descriptions>
              <Typography.Text className="novel-v2-section-label">Outbox Events</Typography.Text>
              <Timeline className="novel-v2-event-timeline" items={events.slice(0, 12).map((event) => ({ children: <div><strong>{eventTitle(event)}</strong><p>{eventTime(event) ? new Date(eventTime(event) ?? "").toLocaleString("zh-CN") : ""}</p><code>{JSON.stringify(event.payload ?? event)}</code></div> }))} />
              <Typography.Text className="novel-v2-section-label">Artifacts</Typography.Text>
              <List size="small" dataSource={artifacts} locale={{ emptyText: "暂无产物" }} renderItem={(artifact) => <List.Item><List.Item.Meta title={<><Tag>{artifact.kind}</Tag>{artifact.id}</>} description={<Typography.Text code>{artifact.fingerprint}</Typography.Text>} /></List.Item>} />
            </>
          ) : <Empty description="提交或选择运行后查看事件、产物与审核结果" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
        </aside>
      </section>

      <Modal title="新增章节目标" open={documentOpen} onCancel={() => setDocumentOpen(false)} footer={null} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(values) => createDocument(values).catch((err: unknown) => message.error(err instanceof Error ? err.message : String(err)))}>
          <Form.Item name="title" label="章节标题" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="narrativeOrder" label="章节序号"><Input type="number" /></Form.Item>
          <Form.Item name="povCharacterId" label="POV 角色 ID"><Input /></Form.Item>
          <Form.Item name="status" label="状态" initialValue="planned"><Select options={statusOptions} /></Form.Item>
          <Button type="primary" htmlType="submit" block>创建章节目标</Button>
        </Form>
      </Modal>

      <Modal title="编辑章节" open={Boolean(editingDocument)} onCancel={() => setEditingDocument(undefined)} footer={null} destroyOnHidden>
        <Form form={editForm} layout="vertical" onFinish={(values) => updateDocument(values).catch((err: unknown) => message.error(err instanceof Error ? err.message : String(err)))}>
          <Form.Item name="title" label="章节标题" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="narrativeOrder" label="章节序号"><Input type="number" /></Form.Item>
          <Form.Item name="povCharacterId" label="POV 角色 ID"><Input /></Form.Item>
          <Form.Item name="status" label="状态"><Select options={statusOptions} /></Form.Item>
          <Button type="primary" htmlType="submit" block>保存章节</Button>
        </Form>
      </Modal>
    </main>
  );
}
