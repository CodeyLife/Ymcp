import { useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Checkbox, Empty, Form, Input, Modal, Skeleton, Tag } from "antd";
import { BookOutlined, CloudServerOutlined, DatabaseOutlined, PlusOutlined, RightOutlined } from "@ant-design/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { queryClient } from "@/lib/queryClient";
import { novelRuntimeClient } from "@/features/novel/runtime-client";
import { buildLegacyMigrationBundle, inspectLegacyProjects } from "@/features/novel/legacy-runtime-migration";
import { syncNovelRuntimeApiConfig } from "@/features/novel/runtime-records";
import { useNovelRuntimeEvents } from "@/features/novel/use-runtime-events";
import { getEffectiveApiConfig } from "@/stores/ui";
import "@/features/novel/runtime.css";

export default function RuntimeNovelProjects() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [legacyProjects, setLegacyProjects] = useState<Array<{ id: string; title: string; premise: string; recordCount: number }>>([]);
  const [selectedLegacy, setSelectedLegacy] = useState<string[]>([]);
  const [form] = Form.useForm();
  useNovelRuntimeEvents();
  const projectsQuery = useQuery({ queryKey: ["novel-runtime", "projects"], queryFn: () => novelRuntimeClient.listProjects() });
  const projects = projectsQuery.data?.projects ?? [];

  useEffect(() => {
    if (!projectsQuery.data) return;
    void inspectLegacyProjects(new Set(projects.map((project) => project.id))).then((items) => {
      setLegacyProjects(items);
      setSelectedLegacy(items.map((item) => item.id));
      if (items.length && sessionStorage.getItem("ymcp-runtime-migration-dismissed") !== "true") setMigrationOpen(true);
    });
  }, [projectsQuery.data, projects]);

  const create = useMutation({
    mutationFn: async (values: { title: string; premise: string; genre: string }) => {
      await syncNovelRuntimeApiConfig();
      const project = (await novelRuntimeClient.createProject({ title: values.title, premise: values.premise, genre: values.genre.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) })).project;
      await novelRuntimeClient.enqueue({ projectId: project.id, kind: "plan", instruction: `围绕核心创意建立完整故事规划：${values.premise}` });
      return project;
    },
    onSuccess: (project) => { void queryClient.invalidateQueries({ queryKey: ["novel-runtime"] }); setCreateOpen(false); form.resetFields(); navigate(`/novel-runtime/${project.id}`); },
    onError: (error) => message.error(error instanceof Error ? error.message : "创建失败"),
  });
  const migrate = useMutation({
    mutationFn: async () => {
      const result = await novelRuntimeClient.migrate(await buildLegacyMigrationBundle(selectedLegacy));
      const api = getEffectiveApiConfig();
      await novelRuntimeClient.updateApiConfig({ baseUrl: api.baseUrl, apiKey: api.apiKey, modelContextWindow: api.modelContextWindow });
      return result;
    },
    onSuccess: (result) => { message.success(`已迁移 ${result.projectIds.length} 个项目，并创建迁移前备份`); setMigrationOpen(false); void queryClient.invalidateQueries({ queryKey: ["novel-runtime"] }); },
    onError: (error) => message.error(error instanceof Error ? error.message : "迁移失败"),
  });
  const totalLegacyRecords = useMemo(() => legacyProjects.filter((item) => selectedLegacy.includes(item.id)).reduce((sum, item) => sum + item.recordCount, 0), [legacyProjects, selectedLegacy]);

  if (projectsQuery.isLoading) return <div className="novel-runtime-page"><Skeleton active /></div>;
  if (projectsQuery.error) return <div className="novel-runtime-page"><Alert type="error" showIcon message="小说本地运行时未连接" description="请使用 npm run dev 启动 Ymcp；运行时恢复后此页面会重新连接。" action={<Button onClick={() => void projectsQuery.refetch()}>重试</Button>} /></div>;

  return <div className="novel-runtime-page">
    <header className="novel-runtime-header"><div><span><CloudServerOutlined /> LOCAL NOVEL RUNTIME</span><h1>小说创作</h1><p>项目、创作任务和审核状态由本地运行时统一保存。</p></div><Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建小说</Button></header>
    <div className="novel-runtime-strip"><span><strong>{projects.length}</strong> 个项目</span><span><DatabaseOutlined /> SQLite 正式数据源</span><span>MCP 无需打开本页面</span></div>
    {projects.length === 0 ? <div className="novel-runtime-empty"><Empty description="还没有运行时项目" /><Button type="primary" onClick={() => setCreateOpen(true)}>创建第一部小说</Button></div> : <section className="novel-runtime-grid">{projects.map((project, index) => <article key={project.id}><button className="novel-runtime-cover" onClick={() => navigate(`/novel-runtime/${project.id}`)}><span>{String(index + 1).padStart(2, "0")}</span><BookOutlined /></button><div><div className="novel-runtime-title"><h2>{project.title}</h2><Tag>{project.status}</Tag></div><p>{project.premise}</p><div className="novel-runtime-tags">{project.genre.map((genre) => <span key={genre}>{genre}</span>)}</div><footer><time>{new Date(project.updatedAt).toLocaleDateString("zh-CN")}</time><Button type="primary" onClick={() => navigate(`/novel-runtime/${project.id}`)}>进入控制台 <RightOutlined /></Button></footer></div></article>)}</section>}
    <Modal title="建立本地小说项目" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}><Form form={form} layout="vertical" onFinish={(values) => create.mutate(values)}><Form.Item name="title" label="书名" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="premise" label="核心创意" rules={[{ required: true }]}><Input.TextArea rows={5} /></Form.Item><Form.Item name="genre" label="题材" rules={[{ required: true }]}><Input placeholder="悬疑、都市" /></Form.Item><Button block type="primary" htmlType="submit" loading={create.isPending}>创建并开始规划</Button></Form></Modal>
    <Modal title="迁移浏览器中的旧小说项目" open={migrationOpen} closable={!migrate.isPending} maskClosable={false} onCancel={() => { sessionStorage.setItem("ymcp-runtime-migration-dismissed", "true"); setMigrationOpen(false); }} onOk={() => migrate.mutate()} okText={`备份并迁移 ${selectedLegacy.length} 个项目`} okButtonProps={{ disabled: !selectedLegacy.length, loading: migrate.isPending }}>
      <Alert type="info" showIcon message="旧 IndexedDB 只用于本次读取" description={`运行时会先保存完整 SHA-256 归档，再事务导入 ${totalLegacyRecords} 条记录；原浏览器数据不会删除。`} />
      <Checkbox.Group value={selectedLegacy} onChange={(values) => setSelectedLegacy(values as string[])} className="novel-runtime-migration-list">{legacyProjects.map((project) => <Checkbox key={project.id} value={project.id}><strong>{project.title}</strong><small>{project.recordCount} 条记录 · {project.premise}</small></Checkbox>)}</Checkbox.Group>
    </Modal>
  </div>;
}
