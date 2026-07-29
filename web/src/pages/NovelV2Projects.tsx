import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Form, Input, Modal, Popconfirm, Switch, message } from "antd";
import {
  ArrowRightOutlined,
  BookOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
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

function revisionOf(project: Project) {
  return project.currentRevision ?? project.current_revision ?? 0;
}
function updatedOf(project: Project) {
  return project.updatedAt ?? project.updated_at ?? "";
}

/** 运行状态 → 状态点语义 */
function statusKind(status: string | undefined): "idle" | "running" | "done" | "failed" {
  if (!status) return "idle";
  if (/running|accepted|received/i.test(status)) return "running";
  if (/completed|promoted|passed/i.test(status)) return "done";
  if (/failed|rolled-back|blocked|cancelled/i.test(status)) return "failed";
  return "idle";
}

const STATUS_LABEL: Record<string, string> = {
  idle: "待启动",
  running: "运行中",
  done: "已完成",
  failed: "异常",
};

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

  useEffect(() => {
    void load();
  }, []);

  async function create(values: {
    premise: string;
    title?: string;
    genre?: string;
    autoBootstrap: boolean;
    includeChapterPlan: boolean;
  }) {
    // 对齐 v1 一句话创意入口:premise 必填 → 自动派生 title → 默认 autoBootstrap=true 一站式创建+规划
    // idempotencyKey 用前端生成的 UUID(同时作为 projectId),与后端契约一致
    const idempotencyKey = crypto.randomUUID();
    const payload: Record<string, unknown> = {
      premise: values.premise,
      idempotencyKey,
      autoBootstrap: values.autoBootstrap,
      includeChapterPlan: values.includeChapterPlan,
    };
    if (values.title?.trim()) payload.title = values.title.trim();
    if (values.genre?.trim()) payload.genre = values.genre.trim();

    const response = await fetch("/v2/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "创建失败");
    setOpen(false);
    form.resetFields();
    await load();
    if (values.autoBootstrap) {
      message.success("项目已创建,全书规划已启动");
    }
    navigate(`/novels/${body.project.id}`);
  }

  async function rename(values: { title: string }) {
    if (!editing) return;
    const response = await fetch(`/v2/projects/${encodeURIComponent(editing.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    });
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

  const stats = useMemo(() => {
    const running = projects.filter((p) => statusKind(p.latestRunStatus) === "running").length;
    const totalRevisions = projects.reduce((sum, p) => sum + revisionOf(p), 0);
    const latestUpdate = projects
      .map((p) => updatedOf(p))
      .filter(Boolean)
      .sort()
      .at(-1);
    return { total: projects.length, running, totalRevisions, latestUpdate };
  }, [projects]);

  return (
    <div className="novel-v2-page novel-v2-projects-page">
      {/* ===== HERO ===== */}
      <motion.section
        className="novel-hero"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="novel-hero-body">
          <span className="novel-eyebrow">小说创作控制台</span>
          <h1 className="novel-display-title">把每一章，写成你想要的模样。</h1>
          <p className="novel-lede">
            Web 负责操作与展示，正式稿、运行、记忆与 learning 由 Runtime 持久化。从一部作品开始，调度创意执行、评估闭环与 MCP 工具链。
          </p>
        </div>
        <div className="novel-hero-actions">
          <Button size="large" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
          <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            新建作品
          </Button>
        </div>
      </motion.section>

      {error && <Alert type="error" showIcon message={error} className="novel-v2-alert" closable onClose={() => setError(undefined)} />}

      {/* ===== BENTO 概览：1 feature(2×2) + 4 mini(1×1) = 8 cells = 4×2，零空隙 ===== */}
      <section className="novel-bento" aria-label="作品库概览">
        {/* 焦点卡：创作入口 */}
        <motion.div
          className="novel-bento-feature novel-card-focal"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
        >
          <div>
            <div className="novel-card-mini-label">
              <BookOutlined /> 创作入口
            </div>
            <h2 className="novel-display-h2" style={{ marginTop: 10 }}>
              开启一部新作品
            </h2>
            <p className="novel-lede" style={{ marginTop: 8, fontSize: 13.5 }}>
              从章节目标到正式稿，工作流串联创意执行、审核、事实抽取与 learning 沉淀。
            </p>
          </div>
          <Button type="primary" size="large" icon={<PlusOutlined />} block onClick={() => setOpen(true)}>
            创建第一部作品
          </Button>
        </motion.div>

        {/* mini：作品数 */}
        <motion.div
          className="novel-bento-mini novel-card-mini"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="novel-card-mini-label">
            <BookOutlined /> 作品数
          </div>
          <div>
            <span className="novel-card-mini-value novel-card-mini-value-accent">{stats.total}</span>
          </div>
          <div className="novel-card-mini-hint">{stats.total === 0 ? "从零开始" : "持续累积中"}</div>
        </motion.div>

        {/* mini：总 Revision */}
        <motion.div
          className="novel-bento-mini novel-card-mini"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.16, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="novel-card-mini-label">
            <ThunderboltOutlined /> 总 Revision
          </div>
          <div>
            <span className="novel-card-mini-value">{stats.totalRevisions}</span>
          </div>
          <div className="novel-card-mini-hint">跨作品累计定稿版本</div>
        </motion.div>

        {/* mini：运行中 */}
        <motion.div
          className="novel-bento-mini novel-card-mini"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.22, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="novel-card-mini-label">
            <PlayCircleOutlined /> 运行中
          </div>
          <div>
            <span className="novel-card-mini-value" style={stats.running > 0 ? { color: "#60a5fa" } : undefined}>
              {stats.running}
            </span>
          </div>
          <div className="novel-card-mini-hint">{stats.running > 0 ? "Temporal 调度中" : "当前无活跃任务"}</div>
        </motion.div>

        {/* mini：最近更新 */}
        <motion.div
          className="novel-bento-mini novel-card-mini"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.28, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="novel-card-mini-label">
            <ClockCircleOutlined /> 最近更新
          </div>
          <div className="novel-card-mini-hint" style={{ fontSize: 13, color: "#d4d4d8", marginTop: 4 }}>
            {stats.latestUpdate ? new Date(stats.latestUpdate).toLocaleString("zh-CN") : "尚未同步"}
          </div>
          <div className="novel-card-mini-hint">最后一次 Runtime 写入</div>
        </motion.div>
      </section>

      {/* ===== 作品库 ===== */}
      <motion.section
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, delay: 0.32, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="novel-card-support" style={{ padding: 0, overflow: "hidden" }}>
          {/* 工具条：标题 + 搜索 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              padding: "18px 20px",
              borderBottom: filtered.length ? "1px solid rgba(63, 63, 70, 0.42)" : "none",
            }}
          >
            <div>
              <div className="novel-section-label" style={{ margin: 0 }}>
                作品库
              </div>
              <div className="novel-card-mini-hint" style={{ marginTop: 4 }}>
                {filtered.length} 部作品{query ? ` · 搜索 "${query}"` : ""}
              </div>
            </div>
            <Input
              allowClear
              prefix={<SearchOutlined style={{ color: "#71717a" }} />}
              placeholder="搜索标题或 ID"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              style={{ width: 260, maxWidth: "40vw" }}
            />
          </div>

          {/* 网格 / 空态 */}
          {filtered.length ? (
            <div className="novel-project-grid" style={{ padding: 20 }}>
              {filtered.map((project, index) => {
                const kind = statusKind(project.latestRunStatus);
                return (
                  <motion.article
                    className="novel-project-card"
                    key={project.id}
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.45, delay: Math.min(index * 0.04, 0.32), ease: [0.16, 1, 0.3, 1] }}
                  >
                    <div className="novel-project-card-head">
                      <div style={{ minWidth: 0 }}>
                        <h3 className="novel-project-card-title">{project.title}</h3>
                        <span className="novel-project-card-id">{project.id.slice(0, 12)}</span>
                      </div>
                      <span className={`novel-status-pill novel-status-pill-${kind}`}>{STATUS_LABEL[kind]}</span>
                    </div>

                    <div className="novel-project-card-meta">
                      <span>
                        revision <strong>{revisionOf(project)}</strong>
                      </span>
                      <span>{updatedOf(project) ? new Date(updatedOf(project)).toLocaleString("zh-CN") : "未同步"}</span>
                    </div>

                    <div className="novel-project-card-actions">
                      <Button size="small" icon={<EditOutlined />} onClick={() => { setEditing(project); editForm.setFieldsValue({ title: project.title }); }}>
                        重命名
                      </Button>
                      <Popconfirm
                        title="删除作品"
                        description="会删除 V2 Runtime 中该作品及其运行记录。"
                        okText="删除"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => remove(project)}
                      >
                        <Button size="small" danger icon={<DeleteOutlined />}>
                          删除
                        </Button>
                      </Popconfirm>
                      <Button
                        size="small"
                        type="primary"
                        icon={<ArrowRightOutlined />}
                        onClick={() => navigate(`/novels/${project.id}`)}
                      >
                        打开工作室
                      </Button>
                    </div>
                  </motion.article>
                );
              })}
            </div>
          ) : (
            <div className="novel-empty">
              <div className="novel-empty-mark">
                <BookOutlined />
              </div>
              <div>
                <div className="novel-empty-title">{query ? "没有匹配的作品" : "还没有 V2 作品"}</div>
                <div className="novel-empty-desc">
                  {query ? "试试更换关键词，或清空搜索查看全部作品。" : "创建你的第一部作品，开启章节工作流、创意执行与评估闭环。"}
                </div>
              </div>
              {!query && (
                <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
                  创建第一部作品
                </Button>
              )}
            </div>
          )}
        </div>
      </motion.section>

      {/* ===== Modals ===== */}
      <Modal title="新建作品 · 一句话创意" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden width={520}>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ autoBootstrap: true, includeChapterPlan: true }}
          onFinish={(values) => create(values).catch((err: unknown) => message.error(err instanceof Error ? err.message : String(err)))}
        >
          <Form.Item
            name="premise"
            label="一句话创意"
            tooltip="作为创作核心。未提供标题时自动取第一句前 24 字作为临时标题,project-positioning task 会润色生成正式书名。"
            rules={[{ required: true, message: "请输入一句话创意" }]}
          >
            <Input.TextArea
              placeholder="例如:一个被废黜的太子在江湖中结识伙伴,逐步夺回皇位并发现王朝背后的秘密"
              autoSize={{ minRows: 2, maxRows: 5 }}
              autoFocus
            />
          </Form.Item>
          <Form.Item name="title" label="标题(可选)" tooltip="留空则从 premise 自动派生临时标题">
            <Input placeholder="留空则自动派生" />
          </Form.Item>
          <Form.Item name="genre" label="题材(可选)" tooltip="题材标签(如 玄幻/都市/言情/科幻/悬疑),用于匹配对应 skill bundle">
            <Input placeholder="如 玄幻 / 都市 / 言情" />
          </Form.Item>
          <Form.Item name="autoBootstrap" label="自动启动全书规划" valuePropName="checked" tooltip="开启后立即启动 10 个 foundation task + chapter-plan,无需手动调用 bootstrap">
            <Switch />
          </Form.Item>
          <Form.Item name="includeChapterPlan" label="包含章节计划" valuePropName="checked" tooltip="关闭后后续 novel_chapter_generate 会被前置检查拒绝">
            <Switch />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            创建并打开
          </Button>
        </Form>
      </Modal>

      <Modal
        title="重命名作品"
        open={Boolean(editing)}
        onCancel={() => setEditing(undefined)}
        footer={null}
        destroyOnHidden
      >
        <Form
          form={editForm}
          layout="vertical"
          onFinish={(values) => rename(values).catch((err: unknown) => message.error(err instanceof Error ? err.message : String(err)))}
        >
          <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            保存
          </Button>
        </Form>
      </Modal>
    </div>
  );
}
