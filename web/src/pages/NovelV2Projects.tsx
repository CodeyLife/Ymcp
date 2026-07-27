import { useEffect, useState } from "react";
import { Button, Form, Input, Modal, Empty, List, Tag, Typography } from "antd";
import { PlusOutlined, RightOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";

type Project = { id: string; title: string; current_revision: number; updated_at: string };
export default function NovelV2Projects() {
  const [projects, setProjects] = useState<Project[]>([]); const [open, setOpen] = useState(false); const [form] = Form.useForm(); const navigate = useNavigate();
  const load = () => fetch("/v2/projects").then((r) => r.json()).then((v) => setProjects(v.projects ?? []));
  useEffect(() => { void load(); }, []);
  async function create(values: { projectId: string; title: string }) { await fetch("/v2/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); setOpen(false); form.resetFields(); await load(); navigate(`/novels/${values.projectId}`); }
  return <main style={{ maxWidth: 1100, margin: "0 auto", padding: "48px 28px" }}><header style={{ display: "flex", justifyContent: "space-between", alignItems: "end", marginBottom: 32 }}><div><Typography.Text type="secondary">NOVEL V2 / PROJECTS</Typography.Text><Typography.Title level={1}>小说创作控制台</Typography.Title><Typography.Paragraph type="secondary">正式稿由 PostgreSQL revision 管理，长任务由 Temporal 持久化。</Typography.Paragraph></div><Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建作品</Button></header>{projects.length ? <List bordered dataSource={projects} renderItem={(project) => <List.Item actions={[<Button type="text" icon={<RightOutlined />} onClick={() => navigate(`/novels/${project.id}`)}>打开</Button>]}><List.Item.Meta title={project.title} description={<><Tag>revision {project.current_revision}</Tag><span>{new Date(project.updated_at).toLocaleString("zh-CN")}</span></>} /></List.Item>} /> : <Empty description="还没有 V2 作品" />}<Modal title="新建作品" open={open} onCancel={() => setOpen(false)} footer={null}><Form form={form} layout="vertical" onFinish={create}><Form.Item name="projectId" label="项目 ID" rules={[{ required: true }]}><Input placeholder="my-novel" /></Form.Item><Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item><Button type="primary" htmlType="submit" block>创建</Button></Form></Modal></main>;
}
