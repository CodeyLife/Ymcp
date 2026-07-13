import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { App, Button, Divider, Drawer, Dropdown, Empty, Form, Input, InputNumber, Progress, Select, Slider, Spin, Switch, Tag, Tooltip } from "antd";
import type { MenuProps } from "antd";
import {
  AimOutlined,
  ApartmentOutlined,
  ArrowLeftOutlined,
  BookOutlined,
  BranchesOutlined,
  BulbOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloudSyncOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  EditOutlined,
  ExportOutlined,
  FileTextOutlined,
  HistoryOutlined,
  MenuOutlined,
  MoreOutlined,
  NodeIndexOutlined,
  PlusOutlined,
  RadarChartOutlined,
  RobotOutlined,
  SaveOutlined,
  TeamOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import CharacterCount from "@tiptap/extension-character-count";
import Collaboration from "@tiptap/extension-collaboration";
import { motion } from "motion/react";
import {
  addEntity,
  addOutlineNode,
  appendOperation,
  createCheckpoint,
  novelDb,
  recordBase,
  saveDocument,
  updateEntity,
  updateProject,
} from "@/features/novel/db";
import { exportNovel } from "@/features/novel/export";
import { openCollaborativeDocument } from "@/features/novel/collaboration";
import type {
  Foreshadowing,
  ManuscriptDocument,
  NovelWorkspaceView,
  PlotThread,
  StoryEntity,
  TimelineEvent,
} from "@/features/novel/types";
import "@/features/novel/novel.css";

const SkillCenter = lazy(() => import("@/features/novel/SkillCenter"));
const WorkflowCenter = lazy(() => import("@/features/novel/WorkflowCenter"));
const AIWorkbench = lazy(() => import("@/features/novel/AIWorkbench"));
import { ChatModelSelect } from "@/components/ChatModelSelect";

const VIEW_ITEMS: Array<{ key: NovelWorkspaceView; label: string; icon: React.ReactNode; group: string }> = [
  { key: "dashboard", label: "近期剧情", icon: <DashboardOutlined />, group: "创作中枢" },
  { key: "workflow", label: "创作流程", icon: <DeploymentUnitOutlined />, group: "创作中枢" },
  { key: "manuscript", label: "正文写作", icon: <EditOutlined />, group: "创作中枢" },
  { key: "bible", label: "故事圣经", icon: <BookOutlined />, group: "故事资料" },
  { key: "characters", label: "角色档案", icon: <TeamOutlined />, group: "故事资料" },
  { key: "relations", label: "人物关系", icon: <ApartmentOutlined />, group: "故事资料" },
  { key: "skills", label: "Skill 中心", icon: <ToolOutlined />, group: "故事资料" },
  { key: "outline", label: "层级大纲", icon: <NodeIndexOutlined />, group: "剧情规划" },
  { key: "board", label: "剧情卡片", icon: <BranchesOutlined />, group: "剧情规划" },
  { key: "timeline", label: "故事时间线", icon: <CalendarOutlined />, group: "剧情规划" },
  { key: "threads", label: "剧情线", icon: <AimOutlined />, group: "连续性" },
  { key: "foreshadowing", label: "伏笔管理", icon: <BulbOutlined />, group: "连续性" },
  { key: "analysis", label: "故事分析", icon: <RadarChartOutlined />, group: "审校与历史" },
  { key: "versions", label: "版本历史", icon: <HistoryOutlined />, group: "审校与历史" },
];

const ENTITY_KIND_LABEL: Record<StoryEntity["kind"], string> = {
  character: "角色", location: "地点", organization: "组织", faction: "势力", item: "物品", species: "种族", rule: "规则", ability: "能力", term: "术语",
};

const COLLAB_CLEANUP_TIMERS = new WeakMap<object, ReturnType<typeof setTimeout>>();

function countWords(text: string) {
  return (text.match(/[\u3400-\u9fff]|[a-zA-Z0-9]+/g) ?? []).length;
}

function Metric({ label, value, note, tone = "neutral" }: { label: string; value: string | number; note: string; tone?: "neutral" | "good" | "warn" }) {
  return <div className={`novel-metric novel-metric-${tone}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

function SectionTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: React.ReactNode }) {
  return <header className="novel-section-title"><div><span>{eyebrow}</span><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</header>;
}

function EmptyPanel({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="novel-empty-panel"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><strong>{title}</strong><span>{description}</span></>} />{action}</div>;
}

function ChapterEditor({ document, onSaved }: { document?: ManuscriptDocument; onSaved: () => void }) {
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  const collaboration = useMemo(() => document ? openCollaborativeDocument(document.projectId, document.yjsDocumentId) : undefined, [document?.projectId, document?.yjsDocumentId]);
  const editor = useEditor({
    extensions: [StarterKit.configure({ undoRedo: false }), Placeholder.configure({ placeholder: "落笔。让人物先做出一个选择……" }), CharacterCount, ...(collaboration ? [Collaboration.configure({ document: collaboration.doc })] : [])],
    content: document?.contentHtml ?? "",
  }, [document?.id]);
  useEffect(() => {
    if (!collaboration || !editor || !document) return;
    const pendingCleanup = COLLAB_CLEANUP_TIMERS.get(collaboration);
    if (pendingCleanup) {
      clearTimeout(pendingCleanup);
      COLLAB_CLEANUP_TIMERS.delete(collaboration);
    }
    return () => {
      const cleanupTimer = setTimeout(() => {
        COLLAB_CLEANUP_TIMERS.delete(collaboration);
        void collaboration.destroy();
      }, 0);
      COLLAB_CLEANUP_TIMERS.set(collaboration, cleanupTimer);
    };
  }, [collaboration, editor]);

  async function save(checkpoint = false) {
    if (!editor || !document) return;
    setSaving(true);
    try {
      const plainText = editor.getText({ blockSeparator: "\n\n" });
      await saveDocument({ ...document, contentHtml: editor.getHTML(), plainText, wordCount: countWords(plainText), status: document.status === "outline" ? "draft" : document.status }, checkpoint ? `手动检查点 ${new Date().toLocaleString("zh-CN")}` : undefined);
      message.success(checkpoint ? "检查点已创建" : "正文已保存");
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  if (!document) return <EmptyPanel title="选择一个章节" description="从左侧章节目录选择，或在大纲中创建新章节。" />;
  return (
    <div className="novel-editor-shell">
      <div className="novel-editor-toolbar">
        <div>
          <Button type={editor?.isActive("bold") ? "primary" : "text"} onClick={() => editor?.chain().focus().toggleBold().run()}><strong>B</strong></Button>
          <Button type={editor?.isActive("italic") ? "primary" : "text"} onClick={() => editor?.chain().focus().toggleItalic().run()}><em>I</em></Button>
          <Button type={editor?.isActive("blockquote") ? "primary" : "text"} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>引用</Button>
          <Button type={editor?.isActive("bulletList") ? "primary" : "text"} onClick={() => editor?.chain().focus().toggleBulletList().run()}>列表</Button>
          <Button type="text" onClick={() => editor?.chain().focus().setHorizontalRule().run()}>场景线</Button>
        </div>
        <div>
          <span>{editor?.storage.characterCount.characters() ?? 0} 字符</span>
          <Button icon={<HistoryOutlined />} onClick={() => void save(true)}>检查点</Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>保存</Button>
        </div>
      </div>
      <div className="novel-paper"><div className="novel-paper-heading"><span>MANUSCRIPT</span><h1>{document.title}</h1><small>{document.status.toUpperCase()} · {document.branch}</small></div><EditorContent editor={editor} /></div>
    </div>
  );
}

function BibleView({ projectId }: { projectId: string }) {
  const project = useLiveQuery(() => novelDb.projects.get(projectId), [projectId]);
  const entities = useLiveQuery(() => novelDb.entities.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const { message } = App.useApp();
  const [form] = Form.useForm();
  useEffect(() => { if (project) form.setFieldsValue({ ...project, genre: project.genre.join("、"), themes: project.themes.join("、"), sellingPoints: project.sellingPoints.join("、") }); }, [form, project]);
  if (!project) return <Spin />;
  return <div className="novel-view-content"><SectionTitle eyebrow="STORY BIBLE" title="故事圣经" description="这里的内容是所有规划、写作和审校任务共同遵守的事实基础。" />
    <Form form={form} layout="vertical" className="novel-bible-form" onFinish={async (values) => { await updateProject(projectId, { ...values, genre: values.genre.split(/[、,，]/).filter(Boolean), themes: values.themes.split(/[、,，]/).filter(Boolean), sellingPoints: values.sellingPoints.split(/[、,，]/).filter(Boolean) }); message.success("故事圣经已保存"); }}>
      <section><h3>作品定位</h3><div className="novel-form-grid"><Form.Item name="title" label="书名"><Input /></Form.Item><Form.Item name="subtitle" label="副标题"><Input /></Form.Item><Form.Item name="genre" label="题材"><Input /></Form.Item><Form.Item name="audience" label="目标读者"><Input /></Form.Item><Form.Item name="pov" label="叙事视角"><Input /></Form.Item><Form.Item name="tense" label="叙事时态"><Input /></Form.Item></div><Form.Item name="logline" label="一句话梗概"><Input /></Form.Item><Form.Item name="premise" label="核心创意"><Input.TextArea rows={3} /></Form.Item></section>
      <section><h3>主题与风格</h3><div className="novel-form-grid"><Form.Item name="themes" label="主题"><Input placeholder="成长、代价、记忆" /></Form.Item><Form.Item name="sellingPoints" label="核心卖点"><Input /></Form.Item><Form.Item name="tone" label="整体基调"><Input /></Form.Item><Form.Item name="languageStyle" label="语言风格"><Input /></Form.Item></div></section>
      <section><h3>AI 与创作上下文</h3><div className="novel-form-grid"><Form.Item name={["settings", "textModel"]} label="文本模型"><ChatModelSelect style={{ width: "100%" }} /></Form.Item><Form.Item name={["settings", "temperature"]} label="创作温度"><InputNumber min={0} max={2} step={0.05} style={{ width: "100%" }} /></Form.Item><Form.Item name={["settings", "contextBudget"]} label="上下文 Token 预算"><InputNumber min={4000} max={200000} step={1000} style={{ width: "100%" }} /></Form.Item><Form.Item name={["settings", "recentChapterCount"]} label="近期章节数量"><InputNumber min={1} max={30} style={{ width: "100%" }} /></Form.Item><Form.Item name={["settings", "autoCommitFacts"]} label="授权 AI 自动提交事实变更" valuePropName="checked"><Switch /></Form.Item><Form.Item name={["settings", "encrypted"]} label="敏感项目加密" valuePropName="checked"><Switch disabled /><span className="novel-inline-help">需先设置项目密钥</span></Form.Item></div></section>
      <section><h3>世界规则</h3><div className="novel-world-grid">{entities.filter((item) => item.kind !== "character").map((entity) => <article key={entity.id}><Tag>{ENTITY_KIND_LABEL[entity.kind]}</Tag><strong>{entity.name}</strong><p>{entity.summary || "等待补充定义"}</p></article>)}<button type="button" onClick={() => void addEntity(projectId, "rule", "新世界规则")}><PlusOutlined /><span>添加世界规则</span></button></div></section>
      <div className="novel-sticky-save"><Button type="primary" htmlType="submit" icon={<SaveOutlined />}>保存故事圣经</Button></div>
    </Form>
  </div>;
}

function CharactersView({ projectId }: { projectId: string }) {
  const entities = useLiveQuery(() => novelDb.entities.where("projectId").equals(projectId).and((item) => item.kind === "character").toArray(), [projectId]) ?? [];
  const [selectedId, setSelectedId] = useState<string>();
  const selected = entities.find((item) => item.id === selectedId) ?? entities[0];
  const [draft, setDraft] = useState<StoryEntity>();
  useEffect(() => setDraft(selected ? structuredClone(selected) : undefined), [selected]);
  return <div className="novel-view-content"><SectionTitle eyebrow="CAST" title="角色档案" description="人物的欲望、知识与实时状态共同决定他们在场景中能做什么。" action={<Button type="primary" icon={<PlusOutlined />} onClick={async () => { const entity = await addEntity(projectId, "character", `新角色 ${entities.length + 1}`); setSelectedId(entity.id); }}>添加角色</Button>} />
    {entities.length === 0 ? <EmptyPanel title="还没有角色" description="创建主角、对手或关键配角。" /> : <div className="novel-character-layout"><aside>{entities.map((entity) => <button key={entity.id} className={selected?.id === entity.id ? "active" : ""} onClick={() => setSelectedId(entity.id)}><span>{entity.name.slice(0, 1)}</span><div><strong>{entity.name}</strong><small>{entity.character?.role || "角色"}</small></div></button>)}</aside>{draft && <main><div className="novel-character-identity"><span>{draft.name.slice(0, 1)}</span><div><Input variant="borderless" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /><Input variant="borderless" value={draft.character?.role} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, role: event.target.value } })} /></div><Button type="primary" icon={<SaveOutlined />} onClick={() => void updateEntity(draft)}>保存</Button></div><div className="novel-form-grid"><label>人物摘要<Input.TextArea rows={3} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label><label>外貌与辨识度<Input.TextArea rows={3} value={draft.character?.appearance} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, appearance: event.target.value } })} /></label><label>性格<Input.TextArea rows={3} value={draft.character?.personality} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, personality: event.target.value } })} /></label><label>欲望<Input.TextArea rows={3} value={draft.character?.desire} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, desire: event.target.value } })} /></label><label>动机<Input.TextArea rows={3} value={draft.character?.motivation} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, motivation: event.target.value } })} /></label><label>弱点<Input.TextArea rows={3} value={draft.character?.weakness} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, weakness: event.target.value } })} /></label><label>秘密<Input.TextArea rows={3} value={draft.character?.secret} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, secret: event.target.value } })} /></label><label>人物弧光<Input.TextArea rows={3} value={draft.character?.arc} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, arc: event.target.value } })} /></label></div><Divider>当前故事状态</Divider><div className="novel-state-row"><Input addonBefore="位置" value={draft.character?.state.location} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, state: { ...draft.character!.state, location: event.target.value } } })} /><Input addonBefore="情绪" value={draft.character?.state.emotional} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, state: { ...draft.character!.state, emotional: event.target.value } } })} /><Input addonBefore="当前目标" value={draft.character?.state.objective} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, state: { ...draft.character!.state, objective: event.target.value } } })} /></div></main>}</div>}
  </div>;
}

function RelationsView({ projectId }: { projectId: string }) {
  const entities = useLiveQuery(() => novelDb.entities.where("projectId").equals(projectId).and((item) => item.kind === "character").toArray(), [projectId]) ?? [];
  const relations = useLiveQuery(() => novelDb.relations.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  return <div className="novel-view-content"><SectionTitle eyebrow="RELATIONSHIP GRAPH" title="人物关系" description="同一段关系可以同时拥有公开表象、私人真相与动态数值。" />
    {entities.length < 2 ? <EmptyPanel title="至少需要两名角色" description="创建角色后即可建立关系。" /> : <><div className="novel-relation-stage">{entities.slice(0, 8).map((entity, index) => <motion.div key={entity.id} className="novel-relation-node" initial={{ opacity: 0, scale: .9 }} animate={{ opacity: 1, scale: 1 }} style={{ "--node-index": index } as React.CSSProperties}><span>{entity.name.slice(0, 1)}</span><strong>{entity.name}</strong><small>{entity.character?.state.emotional || "状态未知"}</small></motion.div>)}<div className="novel-relation-center"><ApartmentOutlined /><span>{relations.length} 条关系</span></div></div><div className="novel-relation-list">{relations.length === 0 ? <p>尚未建立显式关系。角色仍可通过剧情线和章节共同出场形成关联。</p> : relations.map((relation) => <article key={relation.id}><strong>{entities.find((item) => item.id === relation.fromEntityId)?.name} → {entities.find((item) => item.id === relation.toEntityId)?.name}</strong><Tag>{relation.relationType}</Tag><span>信任 {relation.trust}</span><span>冲突 {relation.conflict}</span></article>)}</div></>}
  </div>;
}

function OutlineView({ projectId, mode }: { projectId: string; mode: "tree" | "board" }) {
  const nodes = useLiveQuery(() => novelDb.outlineNodes.where("projectId").equals(projectId).sortBy("order"), [projectId]) ?? [];
  const [selectedId, setSelectedId] = useState<string>();
  const selected = nodes.find((item) => item.id === selectedId);
  async function addChapter() {
    const volume = nodes.find((item) => item.kind === "volume");
    const chapters = nodes.filter((item) => item.kind === "chapter");
    const node = await addOutlineNode(projectId, volume?.id, "chapter", `第${chapters.length + 1}章`, chapters.length);
    const document: ManuscriptDocument = { ...recordBase(projectId), outlineNodeId: node.id, title: node.title, contentHtml: "", plainText: "", summary: "", status: "outline", wordCount: 0, branch: "main", yjsDocumentId: crypto.randomUUID() };
    await novelDb.documents.add(document);
    await novelDb.outlineNodes.update(node.id, { documentId: document.id });
    setSelectedId(node.id);
  }
  return <div className="novel-view-content"><SectionTitle eyebrow={mode === "tree" ? "STRUCTURE" : "STORY BOARD"} title={mode === "tree" ? "层级大纲" : "剧情卡片"} description="从作品结构一路拆解到可以执行的场景节拍。" action={<Button type="primary" icon={<PlusOutlined />} onClick={() => void addChapter()}>新增章节</Button>} />
    {mode === "board" ? <div className="novel-board">{nodes.filter((node) => node.kind === "chapter").map((node, index) => <article key={node.id}><span>{String(index + 1).padStart(2, "0")}</span><Tag>{node.status}</Tag><h3>{node.title}</h3><p>{node.summary || "等待规划本章目标"}</p><div><small>张力</small><Progress percent={node.tension} showInfo={false} strokeColor="#b5483a" /></div><div><small>情绪</small><Progress percent={node.emotion} showInfo={false} strokeColor="#ad8b51" /></div><strong>{node.blueprint?.hook || "尚未设置章节钩子"}</strong></article>)}</div> : <div className="novel-outline-layout"><div className="novel-outline-tree">{nodes.filter((node) => !node.parentId).map((root) => <div key={root.id}><button onClick={() => setSelectedId(root.id)} className={selectedId === root.id ? "active" : ""}><BookOutlined /><strong>{root.title}</strong><Tag>{root.status}</Tag></button>{nodes.filter((node) => node.parentId === root.id).map((child) => <button key={child.id} onClick={() => setSelectedId(child.id)} className={selectedId === child.id ? "active child" : "child"}><FileTextOutlined /><span>{child.title}</span><small>{child.summary}</small></button>)}</div>)}</div><div className="novel-outline-detail">{selected ? <><Tag>{selected.kind}</Tag><Input value={selected.title} onChange={(event) => void novelDb.outlineNodes.update(selected.id, { title: event.target.value, updatedAt: Date.now() })} /><Input.TextArea value={selected.summary} rows={4} onChange={(event) => void novelDb.outlineNodes.update(selected.id, { summary: event.target.value, updatedAt: Date.now() })} /><label>冲突张力 <Slider value={selected.tension} onChange={(value) => void novelDb.outlineNodes.update(selected.id, { tension: value })} /></label><label>情绪强度 <Slider value={selected.emotion} onChange={(value) => void novelDb.outlineNodes.update(selected.id, { emotion: value })} /></label><label>信息释放 <Slider value={selected.information} onChange={(value) => void novelDb.outlineNodes.update(selected.id, { information: value })} /></label>{selected.blueprint && <div className="novel-blueprint"><h3>章节蓝图</h3><Input addonBefore="目标" value={selected.blueprint.objective} readOnly /><Input addonBefore="冲突" value={selected.blueprint.conflict} readOnly /><Input addonBefore="转折" value={selected.blueprint.turningPoint} readOnly /><Input addonBefore="钩子" value={selected.blueprint.hook} readOnly /></div>}</> : <EmptyPanel title="选择大纲节点" description="在左侧查看并编辑具体内容。" />}</div></div>}
  </div>;
}

function ContinuityView({ projectId, type }: { projectId: string; type: "threads" | "foreshadowing" | "timeline" }) {
  const threads = useLiveQuery(() => novelDb.plotThreads.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const clues = useLiveQuery(() => novelDb.foreshadowing.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const events = useLiveQuery(() => novelDb.timelineEvents.where("projectId").equals(projectId).sortBy("narrativeOrder"), [projectId]) ?? [];
  async function add() {
    if (type === "threads") { const item: PlotThread = { ...recordBase(projectId), kind: "subplot", title: "新剧情线", summary: "", status: "planned", priority: 50, participantIds: [], progress: 0, nextMove: "" }; await novelDb.plotThreads.add(item); await appendOperation(projectId, "plotThreads", item.id, "create", { title: { before: null, after: item.title } }); }
    if (type === "foreshadowing") { const item: Foreshadowing = { ...recordBase(projectId), title: "新伏笔", clue: "", truth: "", status: "seeded", urgency: 50, notes: "" }; await novelDb.foreshadowing.add(item); await appendOperation(projectId, "foreshadowing", item.id, "create", { title: { before: null, after: item.title } }); }
    if (type === "timeline") { const item: TimelineEvent = { ...recordBase(projectId), title: "新事件", storyDate: "未定", duration: "", narrativeOrder: events.length, participantIds: [], causeIds: [], consequenceIds: [], description: "" }; await novelDb.timelineEvents.add(item); await appendOperation(projectId, "timelineEvents", item.id, "create", { title: { before: null, after: item.title } }); }
  }
  const title = type === "threads" ? "剧情线" : type === "foreshadowing" ? "伏笔管理" : "故事时间线";
  return <div className="novel-view-content"><SectionTitle eyebrow="CONTINUITY" title={title} description="把跨章节变化从记忆负担变成可追踪的连续性数据。" action={<Button type="primary" icon={<PlusOutlined />} onClick={() => void add()}>新增</Button>} />
    {type === "threads" && <div className="novel-continuity-list">{threads.map((item) => <article key={item.id}><div className="novel-continuity-marker"><span>{item.kind.slice(0, 1).toUpperCase()}</span></div><div><Input variant="borderless" value={item.title} onChange={(event) => void novelDb.plotThreads.update(item.id, { title: event.target.value })} /><Input.TextArea variant="borderless" autoSize value={item.summary} placeholder="这条剧情线在解决什么问题？" onChange={(event) => void novelDb.plotThreads.update(item.id, { summary: event.target.value })} /><Input variant="borderless" addonBefore="下一步" value={item.nextMove} onChange={(event) => void novelDb.plotThreads.update(item.id, { nextMove: event.target.value })} /></div><div><Tag>{item.status}</Tag><Progress type="circle" size={54} percent={item.progress} /></div></article>)}</div>}
    {type === "foreshadowing" && <div className="novel-clue-table"><div className="head"><span>伏笔</span><span>线索</span><span>真相</span><span>状态</span><span>紧迫度</span></div>{clues.map((item) => <div key={item.id}><Input variant="borderless" value={item.title} onChange={(event) => void novelDb.foreshadowing.update(item.id, { title: event.target.value })} /><Input variant="borderless" value={item.clue} placeholder="读者看到什么" onChange={(event) => void novelDb.foreshadowing.update(item.id, { clue: event.target.value })} /><Input variant="borderless" value={item.truth} placeholder="背后的真相" onChange={(event) => void novelDb.foreshadowing.update(item.id, { truth: event.target.value })} /><Select variant="borderless" value={item.status} onChange={(status) => void novelDb.foreshadowing.update(item.id, { status })} options={["seeded", "reminded", "misdirected", "advanced", "revealed", "resolved", "abandoned"].map((value) => ({ value }))} /><Progress percent={item.urgency} size="small" /></div>)}</div>}
    {type === "timeline" && <div className="novel-timeline">{events.map((item, index) => <article key={item.id}><div><span>{String(index + 1).padStart(2, "0")}</span></div><section><Input variant="borderless" value={item.storyDate} onChange={(event) => void novelDb.timelineEvents.update(item.id, { storyDate: event.target.value })} /><Input variant="borderless" value={item.title} onChange={(event) => void novelDb.timelineEvents.update(item.id, { title: event.target.value })} /><Input.TextArea variant="borderless" autoSize value={item.description} placeholder="事件经过、原因与结果" onChange={(event) => void novelDb.timelineEvents.update(item.id, { description: event.target.value })} /></section><ClockCircleOutlined /></article>)}</div>}
    {((type === "threads" && threads.length === 0) || (type === "foreshadowing" && clues.length === 0) || (type === "timeline" && events.length === 0)) && <EmptyPanel title={`还没有${title}`} description="新增一条记录，开始追踪跨章节连续性。" />}
  </div>;
}

function DashboardView({ projectId, onWrite, onAI, onWorkflow }: { projectId: string; onWrite: () => void; onAI: () => void; onWorkflow: () => void }) {
  const project = useLiveQuery(() => novelDb.projects.get(projectId), [projectId]);
  const documents = useLiveQuery(() => novelDb.documents.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const threads = useLiveQuery(() => novelDb.plotThreads.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const clues = useLiveQuery(() => novelDb.foreshadowing.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const entities = useLiveQuery(() => novelDb.entities.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const words = documents.reduce((sum, item) => sum + item.wordCount, 0);
  if (!project) return <Spin />;
  return <div className="novel-view-content novel-dashboard"><SectionTitle eyebrow="STORY NOW" title="近期剧情" description="写下一章之前，先看清故事此刻停在哪里。" action={<div><Button icon={<RobotOutlined />} onClick={onAI}>单步工具</Button><Button icon={<EditOutlined />} onClick={onWrite}>继续写作</Button><Button type="primary" icon={<DeploymentUnitOutlined />} onClick={onWorkflow}>标准创作流程</Button></div>} />
    <div className="novel-metric-grid"><Metric label="总字数" value={words.toLocaleString()} note={`目标 ${project.targetWords.toLocaleString()}`} /><Metric label="章节" value={documents.length} note={`${documents.filter((item) => item.status === "final").length} 章定稿`} /><Metric label="活跃剧情线" value={threads.filter((item) => item.status === "active").length} note={`${threads.length} 条已登记`} tone="good" /><Metric label="连续性风险" value={clues.filter((item) => item.urgency > 70 && item.status !== "resolved").length} note="需要关注" tone={clues.some((item) => item.urgency > 70) ? "warn" : "neutral"} /></div>
    <div className="novel-dashboard-grid"><section className="novel-current-state"><div className="novel-panel-heading"><span>CURRENT STATE</span><h3>故事现在发生了什么</h3></div>{documents.slice(-5).reverse().map((doc, index) => <article key={doc.id}><span>{index === 0 ? "现在" : `-${index}`}</span><div><strong>{doc.title}</strong><p>{doc.summary || doc.plainText.slice(0, 100) || "本章尚未形成摘要"}</p></div><Tag>{doc.status}</Tag></article>)}{documents.length === 0 && <Empty description="暂无章节" />}</section><section className="novel-active-cast"><div className="novel-panel-heading"><span>ACTIVE CAST</span><h3>活跃人物</h3></div>{entities.filter((item) => item.kind === "character").slice(0, 6).map((entity) => <article key={entity.id}><span>{entity.name.slice(0, 1)}</span><div><strong>{entity.name}</strong><p>{entity.character?.state.objective || "尚未记录当前目标"}</p></div><small>{entity.character?.state.emotional || "未知"}</small></article>)}</section><section className="novel-open-loops"><div className="novel-panel-heading"><span>OPEN LOOPS</span><h3>未闭合线索</h3></div>{clues.filter((item) => item.status !== "resolved").slice(0, 5).map((clue) => <article key={clue.id}><div><strong>{clue.title}</strong><p>{clue.clue || "等待补充线索表现"}</p></div><Progress percent={clue.urgency} showInfo={false} strokeColor={clue.urgency > 70 ? "#c45c4e" : "#ad8b51"} /></article>)}</section><section className="novel-next-moves"><div className="novel-panel-heading"><span>NEXT MOVES</span><h3>接下来要推进</h3></div>{threads.filter((item) => item.status !== "resolved").slice(0, 5).map((thread) => <article key={thread.id}><Tag>{thread.kind}</Tag><div><strong>{thread.title}</strong><p>{thread.nextMove || "等待确定下一步动作"}</p></div></article>)}</section></div>
  </div>;
}

function AnalysisView({ projectId }: { projectId: string }) {
  const nodes = useLiveQuery(() => novelDb.outlineNodes.where("projectId").equals(projectId).and((item) => item.kind === "chapter").sortBy("order"), [projectId]) ?? [];
  const entities = useLiveQuery(() => novelDb.entities.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const docs = useLiveQuery(() => novelDb.documents.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const max = Math.max(1, ...nodes.flatMap((node) => [node.tension, node.emotion, node.information]));
  return <div className="novel-view-content"><SectionTitle eyebrow="EDITORIAL ANALYSIS" title="故事分析" description="用可解释的指标发现节奏、角色与信息分布问题。" /><div className="novel-analysis-grid"><section><h3>章节节奏曲线</h3><div className="novel-bar-chart">{nodes.map((node) => <Tooltip key={node.id} title={`${node.title} · 张力 ${node.tension} / 情绪 ${node.emotion} / 信息 ${node.information}`}><div><i style={{ height: `${node.tension / max * 100}%` }} /><i style={{ height: `${node.emotion / max * 100}%` }} /><i style={{ height: `${node.information / max * 100}%` }} /><span>{node.order + 1}</span></div></Tooltip>)}</div><footer><span className="tension">张力</span><span className="emotion">情绪</span><span className="information">信息</span></footer></section><section><h3>作品健康度</h3><div className="novel-health-ring"><Progress type="circle" percent={Math.min(100, 35 + entities.length * 3 + docs.filter((item) => item.summary).length * 4)} strokeColor="#b5483a" trailColor="#2b2927" size={150} /><p>基于设定完整度、章节摘要和连续性记录</p></div></section><section><h3>编辑建议</h3><ul className="novel-editorial-notes"><li><CheckCircleOutlined /> 已建立 {entities.length} 个故事实体</li><li><CheckCircleOutlined /> {nodes.length} 个章节节点进入节奏分析</li><li className={docs.some((item) => !item.summary) ? "warn" : ""}><BulbOutlined /> {docs.filter((item) => !item.summary).length} 章缺少摘要，会影响长期上下文</li><li className={nodes.some((item) => item.tension === nodeAverage(nodes.map((item) => item.tension))) ? "warn" : ""}><RadarChartOutlined /> 建议让相邻章节的张力形成更明显落差</li></ul></section></div></div>;
}

function nodeAverage(values: number[]) { return values.length ? Math.round(values.reduce((sum, item) => sum + item, 0) / values.length) : 0; }

function VersionsView({ projectId }: { projectId: string }) {
  const revisions = useLiveQuery(() => novelDb.revisions.where("projectId").equals(projectId).reverse().sortBy("createdAt"), [projectId]) ?? [];
  const operations = useLiveQuery(() => novelDb.operations.where("projectId").equals(projectId).reverse().sortBy("logicalClock"), [projectId]) ?? [];
  const [label, setLabel] = useState("");
  return <div className="novel-view-content"><SectionTitle eyebrow="AUDIT & RECOVERY" title="版本历史" description="正文检查点与结构化资料变更共享同一条可审计时间轴。" action={<Input.Search value={label} onChange={(event) => setLabel(event.target.value)} placeholder="检查点名称" enterButton="创建检查点" onSearch={async (value) => { await createCheckpoint(projectId, value || `项目检查点 ${new Date().toLocaleString("zh-CN")}`); setLabel(""); }} />} /><div className="novel-version-layout"><section><h3>正文检查点</h3>{revisions.map((revision) => <article key={revision.id}><HistoryOutlined /><div><strong>{revision.label}</strong><p>{revision.plainText.slice(0, 100) || "空白版本"}</p></div><Tag>{revision.source}</Tag><time>{new Date(revision.createdAt).toLocaleString("zh-CN")}</time></article>)}</section><section><h3>结构变更日志</h3>{operations.slice(0, 50).map((operation) => <article key={operation.id}><CloudSyncOutlined /><div><strong>{operation.action} · {operation.entityTable}</strong><p>{Object.keys(operation.fieldChanges).join("、")}</p></div><Tag color={operation.syncStatus === "conflict" ? "red" : undefined}>{operation.syncStatus}</Tag><time>{new Date(operation.createdAt).toLocaleString("zh-CN")}</time></article>)}</section></div></div>;
}

export default function NovelStudio() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = (searchParams.get("view") as NovelWorkspaceView) || "dashboard";
  const project = useLiveQuery(() => novelDb.projects.get(projectId), [projectId]);
  const outline = useLiveQuery(() => novelDb.outlineNodes.where("projectId").equals(projectId).sortBy("order"), [projectId]) ?? [];
  const documents = useLiveQuery(() => novelDb.documents.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const conflicts = useLiveQuery(() => novelDb.conflicts.where({ projectId, status: "open" }).count(), [projectId]) ?? 0;
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>();
  const [aiCollapsed, setAiCollapsed] = useState(() => window.matchMedia("(max-width: 700px)").matches);
  const [mobileNav, setMobileNav] = useState(false);
  const selectedDocument = documents.find((item) => item.id === selectedDocumentId) ?? documents[0];
  useEffect(() => { if (!selectedDocumentId && documents[0]) setSelectedDocumentId(documents[0].id); }, [documents, selectedDocumentId]);
  const exportItems: MenuProps["items"] = (["json", "markdown", "txt", "docx", "epub"] as const).map((format) => ({ key: format, label: format === "json" ? "完整项目备份" : `导出 ${format.toUpperCase()}`, onClick: () => void exportNovel(projectId, format) }));
  const groups = useMemo(() => [...new Set(VIEW_ITEMS.map((item) => item.group))], []);
  if (project === undefined) return <div className="novel-studio-loading"><Spin /><span>打开故事工作区</span></div>;
  if (!project) return <div className="novel-studio-loading"><Empty description="项目不存在" /><Button onClick={() => navigate("/novels")}>返回项目中心</Button></div>;
  function setView(next: NovelWorkspaceView) { setSearchParams({ view: next }); setMobileNav(false); }
  function renderView() {
    if (view === "dashboard") return <DashboardView projectId={projectId} onWrite={() => setView("manuscript")} onAI={() => setAiCollapsed(false)} onWorkflow={() => setView("workflow")} />;
    if (view === "workflow") return <Suspense fallback={<div className="novel-studio-loading"><Spin /><span>加载创作流程</span></div>}><WorkflowCenter projectId={projectId} document={selectedDocument} /></Suspense>;
    if (view === "bible") return <BibleView projectId={projectId} />;
    if (view === "characters") return <CharactersView projectId={projectId} />;
    if (view === "relations") return <RelationsView projectId={projectId} />;
    if (view === "skills") return <Suspense fallback={<div className="novel-studio-loading"><Spin /><span>加载 Skill 中心</span></div>}><SkillCenter projectId={projectId} /></Suspense>;
    if (view === "outline" || view === "board") return <OutlineView projectId={projectId} mode={view === "board" ? "board" : "tree"} />;
    if (view === "threads" || view === "foreshadowing" || view === "timeline") return <ContinuityView projectId={projectId} type={view} />;
    if (view === "analysis") return <AnalysisView projectId={projectId} />;
    if (view === "versions") return <VersionsView projectId={projectId} />;
    return <div className="novel-manuscript-view"><aside className="novel-chapter-list"><header><span>MANUSCRIPT</span><strong>章节目录</strong></header>{outline.filter((node) => node.kind === "chapter").map((node) => { const doc = documents.find((item) => item.id === node.documentId); return <button key={node.id} className={selectedDocument?.id === doc?.id ? "active" : ""} onClick={() => doc && setSelectedDocumentId(doc.id)}><span>{String(node.order + 1).padStart(2, "0")}</span><div><strong>{node.title}</strong><small>{doc?.wordCount ?? 0} 字 · {doc?.status ?? "未创建"}</small></div></button>; })}</aside><ChapterEditor document={selectedDocument} onSaved={() => undefined} /></div>;
  }
  return <div className="novel-studio"><header className="novel-studio-topbar"><div><Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate("/novels")} /><Button className="novel-mobile-menu" type="text" icon={<MenuOutlined />} onClick={() => setMobileNav(true)} /><span className="novel-mini-cover" style={{ background: project.coverColor }}>{project.title.slice(0, 1)}</span><div><strong>{project.title}</strong><small>{VIEW_ITEMS.find((item) => item.key === view)?.label}</small></div></div><div className="novel-topbar-status"><span><CloudSyncOutlined /> 本地已保存</span>{conflicts > 0 && <Tag color="red">{conflicts} 个同步冲突</Tag>}<Dropdown menu={{ items: exportItems }}><Button icon={<ExportOutlined />}>导出 <MoreOutlined /></Button></Dropdown></div></header><div className="novel-studio-body"><nav className="novel-workspace-nav">{groups.map((group) => <section key={group}><span>{group}</span>{VIEW_ITEMS.filter((item) => item.group === group).map((item) => <button key={item.key} className={view === item.key ? "active" : ""} onClick={() => setView(item.key)}>{item.icon}<span>{item.label}</span>{item.key === "foreshadowing" && <i />}</button>)}</section>)}</nav><main className="novel-workspace-main">{renderView()}</main><Suspense fallback={<button className="novel-ai-collapsed"><RobotOutlined /><span>AI</span></button>}><AIWorkbench projectId={projectId} document={selectedDocument} collapsed={aiCollapsed} onToggle={() => setAiCollapsed((value) => !value)} /></Suspense></div><footer className="novel-taskbar"><span><span className="online-dot" /> 数据库在线</span><span>Schema v{project.schemaVersion}</span><span>修订 {project.revision}</span><span className="spacer" /><span>{documents.reduce((sum, item) => sum + item.wordCount, 0).toLocaleString()} 字</span><span>今日目标 {project.dailyGoal.toLocaleString()}</span></footer><Drawer placement="left" width={280} open={mobileNav} onClose={() => setMobileNav(false)} title={project.title}>{groups.map((group) => <div className="novel-mobile-nav" key={group}><strong>{group}</strong>{VIEW_ITEMS.filter((item) => item.group === group).map((item) => <Button key={item.key} type={view === item.key ? "primary" : "text"} icon={item.icon} onClick={() => setView(item.key)} block>{item.label}</Button>)}</div>)}</Drawer></div>;
}
