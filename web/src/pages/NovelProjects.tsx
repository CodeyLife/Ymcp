import { useRef, useState } from "react";
import { App, Button, Empty, Form, Input, Modal, Progress, Select, Tag } from "antd";
import { BookOutlined, CloudSyncOutlined, DeleteOutlined, ExportOutlined, ImportOutlined, PlusOutlined, RightOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate } from "react-router-dom";
import { createNovelProject, deleteProject, novelDb } from "@/features/novel/db";
import { exportNovel, importNovel } from "@/features/novel/export";
import "@/features/novel/novel.css";

const GENRES = ["玄幻", "奇幻", "科幻", "悬疑", "都市", "历史", "武侠", "言情", "现实", "轻小说", "其他"];

// 字数简写：达到 1 万字后用「x.x 万字」避免数字过长
function formatWordCount(words: number): string {
  return words >= 10000 ? `${(words / 10000).toFixed(1)} 万字` : `${words.toLocaleString()} 字`;
}

export default function NovelProjects() {
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const projects = useLiveQuery(() => novelDb.projects.orderBy("updatedAt").reverse().toArray(), []) ?? [];
  const documents = useLiveQuery(() => novelDb.documents.toArray(), []) ?? [];
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const [form] = Form.useForm();

  async function create(values: { title: string; genre: string[]; premise: string }) {
    setCreating(true);
    try {
      const project = await createNovelProject(values);
      setOpen(false);
      form.resetFields();
      navigate(`/novels/${project.id}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "创建失败");
    } finally {
      setCreating(false);
    }
  }

  async function onImport(file?: File) {
    if (!file) return;
    try {
      const projectId = await importNovel(file);
      message.success("项目已导入");
      navigate(`/novels/${projectId}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "导入失败");
    }
  }

  return (
    <div className="novel-projects-page">
      <header className="novel-projects-header">
        <div>
          <span className="novel-eyebrow"><BookOutlined /> STORY WORKSPACE</span>
          <h1>小说创作</h1>
          <p>让大纲、人物、剧情状态与正文始终属于同一个故事事实库。</p>
        </div>
        <div className="novel-header-actions">
          <input ref={importRef} type="file" accept=".json,.ymcp-novel.json" hidden onChange={(event) => void onImport(event.target.files?.[0])} />
          <Button icon={<ImportOutlined />} onClick={() => importRef.current?.click()}>导入项目</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建小说</Button>
        </div>
      </header>

      <div className="novel-library-strip">
        <span><strong>{projects.length}</strong> 个项目</span>
        <span><CloudSyncOutlined /> 本地优先 · 变更日志已启用</span>
        <span>{documents.reduce((sum, doc) => sum + doc.wordCount, 0).toLocaleString()} 字正文</span>
      </div>

      {projects.length === 0 ? (
        <div className="novel-empty-library">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有小说项目" />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>创建第一部小说</Button>
        </div>
      ) : (
        <section className="novel-project-grid">
          {projects.map((project, index) => {
            const projectDocs = documents.filter((doc) => doc.projectId === project.id);
            const words = projectDocs.reduce((sum, doc) => sum + doc.wordCount, 0);
            const progress = Math.min(100, Math.round(words / project.targetWords * 100));
            return (
              <article className="novel-project-card" key={project.id} style={{ "--project-color": project.coverColor, animationDelay: `${index * 45}ms` } as React.CSSProperties}>
                <button className="novel-project-cover" onClick={() => navigate(`/novels/${project.id}`)}>
                  <span className="novel-project-index">{String(index + 1).padStart(2, "0")}</span>
                  <BookOutlined />
                  <span>{project.title.slice(0, 2)}</span>
                </button>
                <div className="novel-project-body">
                  <div className="novel-project-title-row">
                    <div>
                      <h2>{project.title}</h2>
                      <p>{project.premise || "等待写下这个故事的核心命题"}</p>
                    </div>
                    <Tag>{project.status === "planning" ? "规划中" : project.status === "drafting" ? "创作中" : project.status === "revising" ? "修订中" : "已完成"}</Tag>
                  </div>
                  <div className="novel-project-tags">{project.genre.map((genre) => <span key={genre}>{genre}</span>)}</div>
                  <Progress percent={progress} size="small" strokeColor={project.coverColor} trailColor="#292725" />
                  <div className="novel-project-meta">
                    <span>{formatWordCount(words)}</span>
                    <span>{projectDocs.length} 章</span>
                    <span>{new Date(project.updatedAt).toLocaleDateString("zh-CN")}</span>
                  </div>
                  <div className="novel-project-actions">
                    <Button type="text" icon={<ExportOutlined />} onClick={() => void exportNovel(project.id, "json")}>备份</Button>
                    <Button type="text" danger icon={<DeleteOutlined />} onClick={() => modal.confirm({ title: `删除《${project.title}》？`, content: "本地项目资料、正文和版本记录将全部删除。", okText: "删除", okButtonProps: { danger: true }, onOk: () => deleteProject(project.id) })}>删除</Button>
                    <Button type="primary" onClick={() => navigate(`/novels/${project.id}`)}>进入创作 <RightOutlined /></Button>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}

      <Modal title="创建小说项目" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(values) => void create(values)} initialValues={{ genre: ["玄幻"] }}>
          <Form.Item name="title" label="作品名称" rules={[{ required: true, message: "请输入作品名称" }]}><Input autoFocus placeholder="例如：潮汐尽头" /></Form.Item>
          <Form.Item name="genre" label="题材" rules={[{ required: true }]}><Select mode="multiple" options={GENRES.map((value) => ({ value, label: value }))} /></Form.Item>
          <Form.Item name="premise" label="核心创意" rules={[{ required: true, message: "用一两句话描述故事" }]}><Input.TextArea rows={4} placeholder="当……发生时，一名……必须……否则……" /></Form.Item>
          <Button type="primary" htmlType="submit" loading={creating} block>建立故事工作区</Button>
        </Form>
      </Modal>
    </div>
  );
}
