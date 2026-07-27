import { useEffect, useState } from "react";
import { Alert, Button, Card, Descriptions, Form, Input, List, Modal, Select, Space, Tag, Typography } from "antd";
import { ArrowLeftOutlined, FileAddOutlined, ReloadOutlined, SendOutlined } from "@ant-design/icons";
import { useNavigate, useParams } from "react-router-dom";

type DocumentSummary = { id: string; title: string; narrativeOrder: number; status: string; povCharacterId?: string };
type ProjectDetail = { id: string; title: string; currentRevision: number; documents: DocumentSummary[] };
type Run = { workflowId: string; status: string; runId?: string; record?: unknown };

export default function NovelV2Studio() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<ProjectDetail>();
  const [objective, setObjective] = useState("");
  const [targetDocumentId, setTargetDocumentId] = useState<string>();
  const [run, setRun] = useState<Run>();
  const [error, setError] = useState<string>();
  const [events, setEvents] = useState<unknown[]>([]);
  const [documentOpen, setDocumentOpen] = useState(false);
  const [form] = Form.useForm();

  async function loadProject() {
    const body = await fetch(`/v2/projects/${encodeURIComponent(projectId)}`).then((r) => r.json());
    setProject(body.project);
    setTargetDocumentId((current) => current ?? body.project?.documents?.[0]?.id);
  }
  useEffect(() => { if (projectId) void loadProject(); }, [projectId]);

  async function createDocument(values: { title: string; narrativeOrder?: number | string; povCharacterId?: string }) {
    const response = await fetch(`/v2/projects/${encodeURIComponent(projectId)}/documents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...values, narrativeOrder: values.narrativeOrder === undefined || values.narrativeOrder === "" ? undefined : Number(values.narrativeOrder) }) });
    const body = await response.json();
    if (!response.ok) { setError(body.error); return; }
    setDocumentOpen(false);
    form.resetFields();
    await loadProject();
    setTargetDocumentId(body.document.id);
  }

  async function submit() {
    setError(undefined);
    const target = targetDocumentId ? { kind: "chapter", id: targetDocumentId } : undefined;
    const response = await fetch("/v2/intents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, objective, idempotencyKey: `${projectId}:${Date.now()}`, source: "web", requestedStage: target ? "drafting" : "planning", target }) });
    const body = await response.json();
    if (!response.ok) { setError(body.error); return; }
    setRun({ workflowId: body.workflowId, status: "received", runId: body.runId });
    setObjective("");
  }

  async function refresh() {
    if (!run) return;
    const state = await fetch(`/v2/runs/${encodeURIComponent(run.workflowId)}`).then((r) => r.json());
    setRun(state);
    const eventData = await fetch(`/v2/runs/${encodeURIComponent(run.workflowId)}/events`).then((r) => r.json());
    setEvents(eventData.events ?? []);
    await loadProject();
  }
  useEffect(() => { if (!run) return; const timer = window.setInterval(() => void refresh(), 3000); return () => window.clearInterval(timer); }, [run?.workflowId]);

  const documentOptions = project?.documents.map((document) => ({ value: document.id, label: `第 ${document.narrativeOrder} 章 · ${document.title}` })) ?? [];
  return <main style={{ maxWidth: 1200, margin: "0 auto", padding: "28px" }}>
    <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate("/novels")}>作品列表</Button>
    <Typography.Title level={2}>{project?.title ?? projectId}</Typography.Title>
    <Descriptions column={3} style={{ marginBottom: 18 }}><Descriptions.Item label="Project ID">{projectId}</Descriptions.Item><Descriptions.Item label="Revision">{project?.currentRevision ?? 0}</Descriptions.Item><Descriptions.Item label="章节数">{project?.documents.length ?? 0}</Descriptions.Item></Descriptions>
    <Card title="提交创作 Intent" extra={<Tag color="blue">Web 仅交互 · V2 Runtime 持久化</Tag>}>
      <Space.Compact style={{ width: "100%" }}>
        <Select style={{ width: 280 }} allowClear placeholder="选择章节目标（留空为规划任务）" value={targetDocumentId} options={documentOptions} onChange={setTargetDocumentId} />
        <Input value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="例如：根据当前记忆和 Skill 创作下一章" onPressEnter={() => void submit()} />
        <Button type="primary" icon={<SendOutlined />} disabled={!objective.trim()} onClick={() => void submit()}>提交</Button>
      </Space.Compact>
      <Button style={{ marginTop: 12 }} icon={<FileAddOutlined />} onClick={() => setDocumentOpen(true)}>新增章节目标</Button>
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 16 }} />}
    </Card>
    <Card title="章节目标" style={{ marginTop: 20 }}>
      <List size="small" dataSource={project?.documents ?? []} renderItem={(document) => <List.Item actions={[<Button type="link" onClick={() => setTargetDocumentId(document.id)}>设为目标</Button>]}><List.Item.Meta title={`第 ${document.narrativeOrder} 章 · ${document.title}`} description={<><Tag>{document.status}</Tag>{document.povCharacterId && <Tag>{document.povCharacterId}</Tag>}</>} /></List.Item>} />
    </Card>
    {run && <Card title="Temporal Run" style={{ marginTop: 20 }} extra={<Button icon={<ReloadOutlined />} onClick={() => void refresh()}>刷新</Button>}><Descriptions column={2}><Descriptions.Item label="Workflow">{run.workflowId}</Descriptions.Item><Descriptions.Item label="状态"><Tag>{run.status}</Tag></Descriptions.Item></Descriptions><List size="small" header="Outbox Events" dataSource={events} renderItem={(event) => <List.Item><Typography.Text code>{JSON.stringify(event)}</Typography.Text></List.Item>} /></Card>}
    <Modal title="新增章节目标" open={documentOpen} onCancel={() => setDocumentOpen(false)} footer={null}><Form form={form} layout="vertical" onFinish={createDocument}><Form.Item name="title" label="章节标题" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="narrativeOrder" label="章节序号"><Input type="number" /></Form.Item><Form.Item name="povCharacterId" label="POV 角色 ID"><Input /></Form.Item><Button type="primary" htmlType="submit" block>创建章节目标</Button></Form></Modal>
  </main>;
}
