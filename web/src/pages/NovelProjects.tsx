import { useRef, useState } from "react";
import { App, Button, Empty, Form, Input, Modal, Progress, Steps, Tag } from "antd";
import { ApartmentOutlined, BookOutlined, BulbOutlined, CloudSyncOutlined, DeleteOutlined, ExportOutlined, ImportOutlined, PlusOutlined, RightOutlined, StopOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate } from "react-router-dom";
import { deleteProject, novelDb } from "@/features/novel/db";
import { bootstrapNovelFromCoreIdea, NovelBootstrapError, type NovelBootstrapProgress, type NovelBootstrapStage } from "@/features/novel/bootstrap";
import { exportNovel, importNovel } from "@/features/novel/export";
import "@/features/novel/novel.css";

const BOOTSTRAP_STAGE_META: Record<NovelBootstrapStage, { title: string; description: string; icon: React.ReactNode }> = {
  "project-positioning": { title: "作品定位", description: "书名、题材、主题与文风", icon: <BulbOutlined /> },
  architecture: { title: "全书架构", description: "核心问题、冲突与阶段走向", icon: <ApartmentOutlined /> },
};

function initialBootstrapProgress(): NovelBootstrapProgress[] {
  return (Object.keys(BOOTSTRAP_STAGE_META) as NovelBootstrapStage[]).map((stage) => ({ stage, status: "waiting" }));
}

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
  const [bootstrapProjectId, setBootstrapProjectId] = useState<string>();
  const [bootstrapProgress, setBootstrapProgress] = useState<NovelBootstrapProgress[]>(initialBootstrapProgress);
  const [bootstrapError, setBootstrapError] = useState<string>();
  const importRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const [form] = Form.useForm();

  function resetCreateDialog() {
    setOpen(false);
    setBootstrapProjectId(undefined);
    setBootstrapProgress(initialBootstrapProgress());
    setBootstrapError(undefined);
    form.resetFields();
  }

  function closeCreateDialog() {
    if (!creating) resetCreateDialog();
  }

  function enterBootstrapProject() {
    if (!bootstrapProjectId) return;
    const projectId = bootstrapProjectId;
    resetCreateDialog();
    navigate(`/novels/${projectId}?view=planning`);
  }

  async function create(values: { coreIdea: string }) {
    setCreating(true);
    setBootstrapError(undefined);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await bootstrapNovelFromCoreIdea({
        coreIdea: values.coreIdea,
        projectId: bootstrapProjectId,
        signal: controller.signal,
        onProgress: setBootstrapProgress,
      });
      resetCreateDialog();
      message.success("故事工作区已建立");
      navigate(`/novels/${result.projectId}?view=planning`);
    } catch (error) {
      if (error instanceof NovelBootstrapError) setBootstrapProjectId(error.projectId);
      const cancelled = controller.signal.aborted;
      setBootstrapError(cancelled ? "生成已取消，可继续完成剩余内容" : error instanceof Error ? error.message : "创建失败");
    } finally {
      if (abortRef.current === controller) abortRef.current = undefined;
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

      <Modal
        className="novel-bootstrap-modal"
        title={creating || bootstrapProjectId ? "建立故事工作区" : "从核心创意开始"}
        open={open}
        onCancel={closeCreateDialog}
        closable={!creating}
        maskClosable={!creating}
        keyboard={!creating}
        footer={null}
        width={620}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" className="novel-bootstrap-form" onFinish={(values) => void create(values)}>
          {!creating && !bootstrapProjectId && !bootstrapError ? <>
            <Form.Item
              name="coreIdea"
              label="核心创意"
              rules={[
                { required: true, whitespace: true, message: "请输入核心创意" },
                { max: 2000, message: "核心创意不能超过 2000 字" },
              ]}
            >
              <Input.TextArea
                autoFocus
                rows={7}
                maxLength={2000}
                showCount
                placeholder="一座城市每天会遗忘一个人，只有负责销毁档案的女孩记得他们存在过。"
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" icon={<BulbOutlined />} size="large" block>生成故事设定</Button>
          </> : <div className="novel-bootstrap-progress">
            <blockquote>{form.getFieldValue("coreIdea")}</blockquote>
            <Steps
              direction="vertical"
              current={bootstrapProgress.findIndex((item) => item.status === "running" || item.status === "failed")}
              items={bootstrapProgress.map((item) => {
                const meta = BOOTSTRAP_STAGE_META[item.stage];
                return {
                  title: meta.title,
                  description: item.error || (item.status === "completed" ? "已写入项目" : item.status === "running" ? "正在生成并保存" : meta.description),
                  icon: meta.icon,
                  status: item.status === "completed" ? "finish" : item.status === "running" ? "process" : item.status === "failed" ? "error" : "wait",
                };
              })}
            />
            {bootstrapError && <div className="novel-bootstrap-error" role="alert">{bootstrapError}</div>}
            <div className="novel-bootstrap-actions">
              {creating ? <Button icon={<StopOutlined />} onClick={() => abortRef.current?.abort()}>取消生成</Button> : <>
                {bootstrapProjectId && <Button onClick={enterBootstrapProject}>进入项目</Button>}
                <Button type="primary" htmlType="submit">继续生成</Button>
              </>}
            </div>
          </div>}
        </Form>
      </Modal>
    </div>
  );
}
