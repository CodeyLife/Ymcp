import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Empty, Form, Input, Modal, Popconfirm, Statistic, Tag, Typography, message } from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, RightOutlined, SearchOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import "./novel-v2.css";

type Project = {
  id: string;
  title: string;
  currentRevision?: number;
  current_revision?: number;
  updatedAt?: string;
  updated_at?: string;
  latestRunStatus?: string;
};

function revisionOf(project: Project) { return project.currentRevision ?? project.current_revision ?? 0; }
function updatedOf(project: Project) { return project.updatedAt ?? project.updated_at ?? ""; }

export default function NovelV2Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Project>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const navigate = useNavigate();

  async function load() {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch("/v2/projects");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "加载作品失败");
      setProjects(body.projects ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function create(values: { projectId: string; title: string }) {
    const response = await fetch("/v2/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "创建失败");
    setOpen(false);
    form.resetFields();
    await load();
    navigate(`/novels/${values.projectId}`);
  }

  async function rename(values: { title: string }) {
    if (!editing) return;
    const response = await fetch(`/v2/projects/${encodeURIComponent(editing.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "更新失败");
    setEditing(undefined);
    await load();
    message.success("作品已更新");
  }

  async function remove(project: Project) {
    const response = await fetch(`/v2/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "删除失败");
    await load();
    message.success("作品已删除");
  }

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return projects;
    return projects.filter((project) => `${project.title} ${project.id}`.toLowerCase().includes(keyword));
  }, [projects, query]);

  return (
    <main className="novel-v2-page novel-v2-projects-page">
      <section className="novel-v2-hero">
        <div>
          <div className="novel-v2-kicker">NOVEL V2 / POSTGRES + TEMPORAL</div>
          <Typography.Title level={1}>小说创作控制台</Typography.Title>
          <Typography.Paragraph>V2 是唯一主入口：Web 负责操作与展示，正式稿、运行、记忆与 learning 由 Runtime 持久化。</Typography.Paragraph>
        </div>
        <div className="novel-v2-hero-actions">
          <Button onClick={() => void load()} loading={loading}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建作品</Button>
        </div>
      </section>

      {error && <Alert type="error" showIcon message={error} className="novel-v2-alert" />}

      <section className="novel-v2-stats-grid">
        <Card><Statistic title="作品数" value={projects.length} /></Card>
        <Card><Statistic title="总 Revision" value={projects.reduce((sum, project) => sum + revisionOf(project), 0)} /></Card>
        <Card><Statistic title="运行中" value={projects.filter((project) => /running|accepted|received/i.test(project.latestRunStatus ?? "")).length} /></Card>
      </section>

      <Card className="novel-v2-card" title="作品库" extra={<Input allowClear prefix={<SearchOutlined />} placeholder="搜索标题或 ID" value={query} onChange={(event) => setQuery(event.target.value)} />}>
        {filtered.length ? (
          <div className="novel-v2-project-grid">
            {filtered.map((project) => (
              <article className="novel-v2-project-card" key={project.id}>
                <div className="novel-v2-project-card-head">
                  <div>
                    <Typography.Title level={4}>{project.title}</Typography.Title>
                    <Typography.Text code>{project.id}</Typography.Text>
                  </div>
                  <Tag color={project.latestRunStatus ? "processing" : "default"}>{project.latestRunStatus ?? "idle"}</Tag>
                </div>
                <div className="novel-v2-project-meta">
                  <span>revision {revisionOf(project)}</span>
                  <span>{updatedOf(project) ? new Date(updatedOf(project)).toLocaleString("zh-CN") : "未同步时间"}</span>
                </div>
                <div className="novel-v2-project-actions">
                  <Button icon={<EditOutlined />} onClick={() => { setEditing(project); editForm.setFieldsValue({ title: project.title }); }}>重命名</Button>
                  <Popconfirm title="删除作品" description="会删除 V2 Runtime 中该作品及其运行记录。" okText="删除" okButtonProps={{ danger: true }} onConfirm={() => remove(project)}>
                    <Button danger icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                  <Button type="primary" icon={<RightOutlined />} onClick={() => navigate(`/novels/${project.id}`)}>打开</Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty description={query ? "没有匹配作品" : "还没有 V2 作品"}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>创建第一部作品</Button>
          </Empty>
        )}
      </Card>

      <Modal title="新建 V2 作品" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(values) => create(values).catch((err: unknown) => message.error(err instanceof Error ? err.message : String(err)))}>
          <Form.Item name="projectId" label="项目 ID" rules={[{ required: true, message: "请输入项目 ID" }, { pattern: /^[a-zA-Z0-9_-]+$/, message: "仅支持字母、数字、下划线和连字符" }]}><Input placeholder="my-novel" /></Form.Item>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}><Input /></Form.Item>
          <Button type="primary" htmlType="submit" block>创建并打开</Button>
        </Form>
      </Modal>

      <Modal title="重命名作品" open={Boolean(editing)} onCancel={() => setEditing(undefined)} footer={null} destroyOnHidden>
        <Form form={editForm} layout="vertical" onFinish={(values) => rename(values).catch((err: unknown) => message.error(err instanceof Error ? err.message : String(err)))}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}><Input /></Form.Item>
          <Button type="primary" htmlType="submit" block>保存</Button>
        </Form>
      </Modal>
    </main>
  );
}
