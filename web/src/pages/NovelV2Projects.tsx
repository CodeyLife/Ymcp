import { useMemo, useState } from "react";
import { Alert, Button, Form, Input, Modal, Popconfirm, Select, Switch, Tooltip, message } from "antd";
import {
  ArrowRightOutlined,
  BookOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  useCreateNovelProject,
  useDeleteNovelProject,
  useNovelProjects,
  useUpdateNovelProject,
  type NovelProjectSummary,
  type CreativeBriefSeed,
} from "@/lib/novelApi";
import "./novel-v2.css";
import "./novel-v2/workspace-command.css";
import { projectDisplayTitle } from "./novel-v2/presentation";

function revisionOf(project: NovelProjectSummary) {
  return project.currentRevision ?? project.current_revision ?? 0;
}

function updatedOf(project: NovelProjectSummary) {
  return project.updatedAt ?? project.updated_at ?? "";
}

type CreativeBriefFormValues = Omit<CreativeBriefSeed, "version" | "themeQuestion" | "emotionalContract"> & {
  themeQuestion?: string;
  themeQuestionMode?: "active" | "notApplicable";
  themeQuestionRationale?: string;
  emotionalContract?: string;
  emotionalContractMode?: "active" | "notApplicable";
  emotionalContractRationale?: string;
};

function normalizeCreativeBriefForm(value: CreativeBriefFormValues | undefined): CreativeBriefSeed | undefined {
  if (!value) return undefined;
  const {
    themeQuestionMode,
    themeQuestionRationale,
    emotionalContractMode,
    emotionalContractRationale,
    ...fields
  } = value;
  const brief: CreativeBriefSeed = { version: 1, ...fields };
  if (themeQuestionMode === "notApplicable") {
    brief.themeQuestion = { notApplicable: true, rationale: themeQuestionRationale?.trim() ?? "" };
  }
  if (emotionalContractMode === "notApplicable") {
    brief.emotionalContract = { notApplicable: true, rationale: emotionalContractRationale?.trim() ?? "" };
  }
  return brief;
}

type ProjectState = "idle" | "running" | "review" | "done" | "failed";

function statusKind(status: string | undefined): ProjectState {
  if (!status) return "idle";
  if (status === "manual-review-required") return "review";
  if (/running|accepted|received|pending|paused/i.test(status)) return "running";
  if (/completed|promoted|passed|succeeded/i.test(status)) return "done";
  if (/failed|rejected|rolled-back|blocked|cancelled|terminated/i.test(status)) return "failed";
  return "idle";
}

const STATUS_LABEL: Record<ProjectState, string> = {
  idle: "待启动",
  running: "运行中",
  review: "待审批",
  done: "已完成",
  failed: "异常",
};

export default function NovelV2Projects() {
  const projectsQ = useNovelProjects();
  const createProject = useCreateNovelProject();
  const updateProject = useUpdateNovelProject();
  const deleteProject = useDeleteNovelProject();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<NovelProjectSummary>();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProjectState | "all">("all");
  const [sortBy, setSortBy] = useState<"priority" | "updated" | "title">("priority");
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const navigate = useNavigate();
  const projects = projectsQ.data ?? [];

  async function create(values: { premise: string; title?: string; genre?: string; creativeBrief?: CreativeBriefFormValues; autoBootstrap: boolean }) {
    const body = await createProject.mutateAsync({
      ...values,
      creativeBrief: normalizeCreativeBriefForm(values.creativeBrief),
      // Kept in the request for older API clients; the runtime ignores the static chapter-plan flag.
      includeChapterPlan: true,
    });
    setOpen(false);
    form.resetFields();
    message.success(values.autoBootstrap ? "项目已创建，全书规划已启动" : "项目已创建");
    navigate(`/novels/${encodeURIComponent(body.project.id)}`);
  }

  async function rename(values: { title: string }) {
    if (!editing) return;
    await updateProject.mutateAsync({ projectId: editing.id, title: values.title });
    setEditing(undefined);
    message.success("作品已更新");
  }

  async function remove(project: NovelProjectSummary) {
    await deleteProject.mutateAsync(project.id);
    message.success("作品已删除");
  }

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const rank: Record<ProjectState, number> = { review: 0, failed: 1, running: 2, idle: 3, done: 4 };
    return projects
      .filter((project) => (!keyword || projectDisplayTitle(project.title, project.id).toLowerCase().includes(keyword)) && (statusFilter === "all" || statusKind(project.latestRunStatus) === statusFilter))
      .sort((a, b) => {
        if (sortBy === "title") return projectDisplayTitle(a.title, a.id).localeCompare(projectDisplayTitle(b.title, b.id), "zh-CN");
        if (sortBy === "updated") return updatedOf(b).localeCompare(updatedOf(a));
        return rank[statusKind(a.latestRunStatus)] - rank[statusKind(b.latestRunStatus)] || updatedOf(b).localeCompare(updatedOf(a));
      });
  }, [projects, query, sortBy, statusFilter]);

  const stats = useMemo(() => {
    const review = projects.filter((project) => statusKind(project.latestRunStatus) === "review").length;
    const failed = projects.filter((project) => statusKind(project.latestRunStatus) === "failed").length;
    const running = projects.filter((project) => statusKind(project.latestRunStatus) === "running").length;
    const totalRevisions = projects.reduce((sum, project) => sum + revisionOf(project), 0);
    const latest = [...projects].sort((a, b) => updatedOf(b).localeCompare(updatedOf(a)))[0];
    return { review, failed, running, totalRevisions, latest };
  }, [projects]);

  const priorityProjects = useMemo(() => projects
    .filter((project) => ["review", "failed", "running"].includes(statusKind(project.latestRunStatus)))
    .sort((a, b) => ({ review: 0, failed: 1, running: 2, idle: 3, done: 4 })[statusKind(a.latestRunStatus)] - ({ review: 0, failed: 1, running: 2, idle: 3, done: 4 })[statusKind(b.latestRunStatus)]), [projects]);

  return (
    <div className="nwc-page nwc-library-page">
      <motion.header className="nwc-library-topbar" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <div><span className="nwc-kicker">小说创作</span><h1>作品总控台</h1><p>查询作品状态，处理审批与异常，进入具体创作工作区。</p></div>
        <div className="nwc-topbar-actions">
          <Tooltip title="刷新作品状态"><Button icon={<ReloadOutlined />} loading={projectsQ.isFetching} onClick={() => void projectsQ.refetch()} /></Tooltip>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建作品</Button>
        </div>
      </motion.header>

      {projectsQ.isError && <Alert type="error" showIcon message="加载作品失败" description={projectsQ.error instanceof Error ? projectsQ.error.message : undefined} closable />}

      <section className="nwc-library-overview" aria-label="作品总控态势">
        <div className="nwc-library-priority">
          <header className="nwc-section-head"><div><span className="nwc-kicker">优先队列</span><h2>需要处理的作品</h2></div><span className="nwc-count">{priorityProjects.length}</span></header>
          <div className="nwc-library-priority-list">
            {priorityProjects.length === 0 && <div className="nwc-library-clear"><BookOutlined /><strong>当前没有待审批或异常项目</strong><span>可从作品库继续创作，或创建新作品。</span></div>}
            {priorityProjects.map((project) => {
              const kind = statusKind(project.latestRunStatus);
              return <button key={project.id} type="button" onClick={() => navigate(`/novels/${encodeURIComponent(project.id)}`)}>
                <span className={`nwc-project-signal is-${kind}`} />
                <span><strong>{projectDisplayTitle(project.title, project.id)}</strong><small>{STATUS_LABEL[kind]} · {updatedOf(project) ? new Date(updatedOf(project)).toLocaleString("zh-CN") : "未同步"}</small></span>
                <ArrowRightOutlined />
              </button>;
            })}
          </div>
        </div>

        <div className="nwc-library-health">
          <header className="nwc-section-head"><div><span className="nwc-kicker">运行态势</span><h2>项目健康度</h2></div></header>
          <div className="nwc-library-metrics">
            <div><strong>{stats.review}</strong><span>待审批</span></div>
            <div><strong>{stats.failed}</strong><span>异常</span></div>
            <div><strong>{stats.running}</strong><span>运行中</span></div>
            <div><strong>{stats.totalRevisions}</strong><span>总 revision</span></div>
          </div>
        </div>

        <div className="nwc-library-latest">
          <header className="nwc-section-head"><div><span className="nwc-kicker">最近作品</span><h2>{stats.latest ? projectDisplayTitle(stats.latest.title, stats.latest.id) : "暂无作品"}</h2></div><ClockCircleOutlined /></header>
          {stats.latest ? <button type="button" onClick={() => navigate(`/novels/${encodeURIComponent(stats.latest!.id)}`)}><span>revision {revisionOf(stats.latest)}</span><strong>{updatedOf(stats.latest) ? new Date(updatedOf(stats.latest)).toLocaleString("zh-CN") : "未同步"}</strong><ArrowRightOutlined /></button> : <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>创建第一部作品</Button>}
        </div>
      </section>

      <section className="nwc-library-table">
        <header className="nwc-library-toolbar">
          <div><span className="nwc-kicker">作品库</span><h2>{filtered.length} 部作品</h2></div>
          <div>
            <Input allowClear prefix={<SearchOutlined />} placeholder="搜索作品书名" value={query} onChange={(event) => setQuery(event.target.value)} />
            <Select value={statusFilter} onChange={setStatusFilter} options={[{ value: "all", label: "全部状态" }, ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))]} />
            <Select value={sortBy} onChange={setSortBy} options={[{ value: "priority", label: "优先级" }, { value: "updated", label: "最近更新" }, { value: "title", label: "标题" }]} />
          </div>
        </header>
        <div className="nwc-project-list" role="list">
          {filtered.map((project) => {
            const kind = statusKind(project.latestRunStatus);
            return <article key={project.id} role="listitem">
              <span className={`nwc-project-signal is-${kind}`} />
              <div className="nwc-project-name"><strong>{projectDisplayTitle(project.title, project.id)}</strong><small>修订 {revisionOf(project)}</small></div>
              <span className={`novel-status-pill novel-status-pill-${kind === "review" ? "gate" : kind}`}>{STATUS_LABEL[kind]}</span>
              <span className="nwc-project-revision">r{revisionOf(project)}</span>
              <span className="nwc-project-updated">{updatedOf(project) ? new Date(updatedOf(project)).toLocaleString("zh-CN") : "未同步"}</span>
              <div className="nwc-project-actions">
                <Tooltip title="重命名"><Button size="small" icon={<EditOutlined />} onClick={() => { setEditing(project); editForm.setFieldsValue({ title: projectDisplayTitle(project.title, project.id) === "未命名作品" ? "" : project.title }); }} /></Tooltip>
                <Popconfirm title="删除作品" description="会删除 Runtime 中该作品及其运行记录。" okText="删除" okButtonProps={{ danger: true }} onConfirm={() => void remove(project)}><Tooltip title="删除作品"><Button size="small" danger icon={<DeleteOutlined />} /></Tooltip></Popconfirm>
                <Button size="small" type="primary" icon={<ArrowRightOutlined />} onClick={() => navigate(`/novels/${encodeURIComponent(project.id)}`)}>打开</Button>
              </div>
            </article>;
          })}
          {filtered.length === 0 && <div className="nwc-library-empty"><WarningOutlined /><strong>{query || statusFilter !== "all" ? "没有匹配的作品" : "还没有作品"}</strong><span>调整筛选条件，或创建一部新作品。</span></div>}
        </div>
      </section>

      <Modal title="新建作品 · 创作简报" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden width={680}>
        <Form form={form} layout="vertical" initialValues={{ autoBootstrap: true, creativeBrief: { themeQuestionMode: "active", emotionalContractMode: "active" } }} onFinish={(values) => void create(values)}>
          <Form.Item name="premise" label="一句话创意" rules={[{ required: true, message: "请输入一句话创意" }]}><Input.TextArea placeholder="描述作品的核心人物、冲突与叙事承诺" autoSize={{ minRows: 3, maxRows: 6 }} autoFocus /></Form.Item>
          <Form.Item name="title" label="标题（可选）"><Input placeholder="留空则自动派生" /></Form.Item>
          <Form.Item name="genre" label="题材（可选）"><Input placeholder="如玄幻、都市、言情、科幻或悬疑" /></Form.Item>
          <Form.Item name={["creativeBrief", "targetReader"]} label="目标读者"><Input placeholder="希望谁持续阅读这部作品" /></Form.Item>
          <Form.Item name={["creativeBrief", "corePromise"]} label="核心叙事承诺"><Input.TextArea placeholder="读者持续追更时会获得什么核心体验" autoSize={{ minRows: 2, maxRows: 4 }} /></Form.Item>
          <Form.Item name={["creativeBrief", "themeQuestionMode"]} label="主题问题适用性"><Select options={[{ value: "active", label: "填写主题问题" }, { value: "notApplicable", label: "不适用" }]} /></Form.Item>
          <Form.Item noStyle shouldUpdate={(previous, current) => previous.creativeBrief?.themeQuestionMode !== current.creativeBrief?.themeQuestionMode}>
            {({ getFieldValue }) => getFieldValue(["creativeBrief", "themeQuestionMode"]) === "notApplicable"
              ? <Form.Item name={["creativeBrief", "themeQuestionRationale"]} label="主题问题不适用理由" rules={[{ required: true, whitespace: true, message: "请填写不适用理由" }]}><Input.TextArea placeholder="说明本作为什么不直接处理主题问题" autoSize={{ minRows: 2, maxRows: 4 }} /></Form.Item>
              : <Form.Item name={["creativeBrief", "themeQuestion"]} label="主题问题"><Input.TextArea placeholder="作品持续追问的矛盾，不要填写结论" autoSize={{ minRows: 2, maxRows: 4 }} /></Form.Item>}
          </Form.Item>
          <Form.Item name={["creativeBrief", "protagonistNeed"]} label="主角核心需要"><Input placeholder="主角真正想得到或改变什么" /></Form.Item>
          <Form.Item name={["creativeBrief", "protagonistContradiction"]} label="主角核心矛盾"><Input placeholder="主角的欲望、恐惧或价值冲突" /></Form.Item>
          <Form.Item name={["creativeBrief", "centralOpposition"]} label="中央对抗"><Input.TextArea placeholder="持续阻碍主角的力量、制度、关系或选择代价" autoSize={{ minRows: 2, maxRows: 4 }} /></Form.Item>
          <Form.Item name={["creativeBrief", "emotionalContractMode"]} label="情感契约适用性"><Select options={[{ value: "active", label: "填写情感契约" }, { value: "notApplicable", label: "不适用" }]} /></Form.Item>
          <Form.Item noStyle shouldUpdate={(previous, current) => previous.creativeBrief?.emotionalContractMode !== current.creativeBrief?.emotionalContractMode}>
            {({ getFieldValue }) => getFieldValue(["creativeBrief", "emotionalContractMode"]) === "notApplicable"
              ? <Form.Item name={["creativeBrief", "emotionalContractRationale"]} label="情感契约不适用理由" rules={[{ required: true, whitespace: true, message: "请填写不适用理由" }]}><Input.TextArea placeholder="说明本作为什么不设置该类情感契约" autoSize={{ minRows: 2, maxRows: 4 }} /></Form.Item>
              : <Form.Item name={["creativeBrief", "emotionalContract"]} label="情感契约"><Input.TextArea placeholder="作品希望读者在人物关系和结局中经历的情绪" autoSize={{ minRows: 2, maxRows: 4 }} /></Form.Item>}
          </Form.Item>
          <Form.Item name={["creativeBrief", "worldAnchor"]} label="世界锚点"><Input.TextArea placeholder="需要被具体研究或呈现的时代、地域、行业或社会纹理" autoSize={{ minRows: 2, maxRows: 4 }} /></Form.Item>
          <Form.Item name={["creativeBrief", "researchNeeds"]} label="研究需求"><Select mode="tags" placeholder="输入后回车，可留空" /></Form.Item>
          <Form.Item name={["creativeBrief", "nonNegotiables"]} label="不可违背项"><Select mode="tags" placeholder="输入后回车，可留空" /></Form.Item>
          <Form.Item name={["creativeBrief", "endingEnvelope"]} label="结局边界"><Input.TextArea placeholder="允许的终局方向与不能提前消费的边界" autoSize={{ minRows: 2, maxRows: 4 }} /></Form.Item>
          <Form.Item name={["creativeBrief", "stylePreferences"]} label="风格偏好"><Input.TextArea placeholder="叙述距离、语言质感、节奏偏好等，不填写作家姓名" autoSize={{ minRows: 2, maxRows: 4 }} /></Form.Item>
          <Form.Item name="autoBootstrap" label="自动启动全书规划" valuePropName="checked"><Switch /></Form.Item>
          <Button type="primary" htmlType="submit" block loading={createProject.isPending}>创建并打开</Button>
        </Form>
      </Modal>

      <Modal title="重命名作品" open={Boolean(editing)} onCancel={() => setEditing(undefined)} footer={null} destroyOnHidden>
        <Form form={editForm} layout="vertical" onFinish={(values) => void rename(values)}><Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}><Input /></Form.Item><Button type="primary" htmlType="submit" block loading={updateProject.isPending}>保存</Button></Form>
      </Modal>
    </div>
  );
}
