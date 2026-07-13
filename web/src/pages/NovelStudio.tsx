import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Divider, Drawer, Dropdown, Empty, Form, Input, InputNumber, Progress, Segmented, Select, Slider, Spin, Switch, Tag, Tooltip } from "antd";
import type { MenuProps } from "antd";
import {
  ApartmentOutlined,
  ArrowDownOutlined,
  ArrowLeftOutlined,
  ArrowUpOutlined,
  BookOutlined,
  BulbOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloudSyncOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  HistoryOutlined,
  MenuOutlined,
  MoreOutlined,
  NodeIndexOutlined,
  PlusOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  RobotOutlined,
  SaveOutlined,
  ToolOutlined,
  ThunderboltOutlined,
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
  appendOperation,
  createCheckpoint,
  createChapter,
  deleteChapter,
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
  EntityRelation,
  ManuscriptDocument,
  NovelWorkspaceView,
  PlotThread,
  StoryEntity,
  StoryScene,
  TimelineEvent,
} from "@/features/novel/types";
import GenerationComposer from "@/features/novel/GenerationComposer";
import { cancelProjectGeneration, PROJECT_GENERATION_STAGES, retryProjectGeneration, skipProjectGenerationStage, startProjectGeneration } from "@/features/novel/generation";
import "@/features/novel/novel.css";

const SkillCenter = lazy(() => import("@/features/novel/SkillCenter"));
const WorkflowCenter = lazy(() => import("@/features/novel/WorkflowCenter"));
const AIWorkbench = lazy(() => import("@/features/novel/AIWorkbench"));
import { ChatModelSelect } from "@/components/ChatModelSelect";

const PlanningWorkspace = lazy(() => import("@/features/novel/PlanningWorkspace"));

const VIEW_ITEMS: Array<{ key: NovelWorkspaceView; label: string; icon: React.ReactNode; group: string }> = [
  { key: "dashboard", label: "总览", icon: <DashboardOutlined />, group: "创作工作区" },
  { key: "planning", label: "规划", icon: <NodeIndexOutlined />, group: "创作工作区" },
  { key: "writing", label: "写作", icon: <EditOutlined />, group: "创作工作区" },
  { key: "library", label: "资料库", icon: <BookOutlined />, group: "创作工作区" },
  { key: "review", label: "审校", icon: <RadarChartOutlined />, group: "创作工作区" },
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
  const [collaborationReady, setCollaborationReady] = useState(false);
  const synchronizedDocument = useRef<{ id?: string; revision?: number }>({});
  useEffect(() => {
    let cancelled = false;
    setCollaborationReady(!collaboration);
    if (collaboration) void collaboration.ready.then(() => {
      if (!cancelled) setCollaborationReady(true);
    });
    return () => { cancelled = true; };
  }, [collaboration]);
  const editor = useEditor({
    extensions: [StarterKit.configure({ undoRedo: false }), Placeholder.configure({ placeholder: "落笔。让人物先做出一个选择……" }), CharacterCount, ...(collaboration && collaborationReady ? [Collaboration.configure({ document: collaboration.doc })] : [])],
    content: document?.contentHtml ?? "",
    editable: !collaboration || collaborationReady,
  }, [document?.id, collaborationReady]);
  useEffect(() => {
    if (!editor || !document || editor.isDestroyed || !collaborationReady) return;
    if (synchronizedDocument.current.id !== document.id) {
      synchronizedDocument.current = { id: document.id, revision: document.revision };
      return;
    }
    if (synchronizedDocument.current.revision === document.revision) return;
    synchronizedDocument.current.revision = document.revision;
    if (editor.getHTML() === document.contentHtml) return;
    editor.commands.setContent(document.contentHtml || "");
  }, [collaborationReady, document?.contentHtml, document?.id, document?.revision, editor]);
  useEffect(() => {
    if (!collaboration) return;
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
  }, [collaboration]);

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

  if (!document) return <EmptyPanel title="选择一个章节" description="从左侧章节管理器选择或新建章节。" />;
  if (collaboration && !collaborationReady) return <div className="novel-studio-loading"><Spin /><span>正在恢复章节内容</span></div>;
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
      <section><h3>作品定位</h3><div className="novel-form-grid"><Form.Item name="title" label="书名"><Input /></Form.Item><Form.Item name="subtitle" label="副标题"><Input /></Form.Item><Form.Item name="genre" label="题材"><Input /></Form.Item><Form.Item name="audience" label="目标读者"><Input /></Form.Item><Form.Item name="pov" label="叙事视角"><Input /></Form.Item><Form.Item name="tense" label="叙事时态"><Input /></Form.Item></div><Form.Item name="premise" label="核心创意"><Input.TextArea rows={3} /></Form.Item></section>
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
  const [selectedId, setSelectedId] = useState<string>();
  const selected = relations.find((item) => item.id === selectedId) ?? relations[0];
  const [draft, setDraft] = useState<EntityRelation>();
  useEffect(() => setDraft(selected ? structuredClone(selected) : undefined), [selected]);
  async function addRelation() {
    if (entities.length < 2) return;
    const relation: EntityRelation = { ...recordBase(projectId), fromEntityId: entities[0].id, toEntityId: entities[1].id, relationType: "同伴", publicLabel: "", privateTruth: "", affinity: 50, trust: 50, conflict: 20, history: [] };
    await novelDb.relations.add(relation);
    await appendOperation(projectId, "relations", relation.id, "create", { relationType: { before: null, after: relation.relationType } });
    setSelectedId(relation.id);
  }
  async function saveRelation() {
    if (!draft) return;
    const before = await novelDb.relations.get(draft.id);
    await novelDb.relations.put({ ...draft, revision: (before?.revision ?? 0) + 1, updatedAt: Date.now() });
    await appendOperation(projectId, "relations", draft.id, "update", { value: { before, after: draft } });
  }
  return <div className="novel-view-content"><SectionTitle eyebrow="RELATIONSHIP GRAPH" title="人物关系" description="同一段关系可以同时拥有公开表象、私人真相与动态数值。" action={<Button type="primary" icon={<PlusOutlined />} disabled={entities.length < 2} onClick={() => void addRelation()}>建立关系</Button>} />
    {entities.length < 2 ? <EmptyPanel title="至少需要两名角色" description="创建角色后即可建立关系。" /> : <><div className="novel-relation-stage">{entities.slice(0, 8).map((entity, index) => <motion.div key={entity.id} className="novel-relation-node" initial={{ opacity: 0, scale: .9 }} animate={{ opacity: 1, scale: 1 }} style={{ "--node-index": index } as React.CSSProperties}><span>{entity.name.slice(0, 1)}</span><strong>{entity.name}</strong><small>{entity.character?.state.emotional || "状态未知"}</small></motion.div>)}<div className="novel-relation-center"><ApartmentOutlined /><span>{relations.length} 条关系</span></div></div><div className="novel-relation-workbench"><aside className="novel-relation-list">{relations.length === 0 ? <p>尚未建立显式关系。</p> : relations.map((relation) => <button key={relation.id} className={selected?.id === relation.id ? "active" : ""} onClick={() => setSelectedId(relation.id)}><strong>{entities.find((item) => item.id === relation.fromEntityId)?.name} → {entities.find((item) => item.id === relation.toEntityId)?.name}</strong><Tag>{relation.relationType}</Tag><span>信任 {relation.trust}</span><span>冲突 {relation.conflict}</span></button>)}</aside>{draft && <section className="novel-relation-editor"><div className="novel-form-grid"><Select value={draft.fromEntityId} options={entities.map((item) => ({ value: item.id, label: item.name }))} onChange={(fromEntityId) => setDraft({ ...draft, fromEntityId })} /><Select value={draft.toEntityId} options={entities.map((item) => ({ value: item.id, label: item.name }))} onChange={(toEntityId) => setDraft({ ...draft, toEntityId })} /></div><Input addonBefore="关系类型" value={draft.relationType} onChange={(event) => setDraft({ ...draft, relationType: event.target.value })} /><Input.TextArea rows={3} value={draft.publicLabel} placeholder="其他人眼中的关系" onChange={(event) => setDraft({ ...draft, publicLabel: event.target.value })} /><Input.TextArea rows={3} value={draft.privateTruth} placeholder="关系双方未公开的真相" onChange={(event) => setDraft({ ...draft, privateTruth: event.target.value })} /><label>亲密度 <Slider value={draft.affinity} onChange={(affinity) => setDraft({ ...draft, affinity })} /></label><label>信任度 <Slider value={draft.trust} onChange={(trust) => setDraft({ ...draft, trust })} /></label><label>冲突度 <Slider value={draft.conflict} onChange={(conflict) => setDraft({ ...draft, conflict })} /></label><Button type="primary" icon={<SaveOutlined />} onClick={() => void saveRelation()}>保存关系</Button></section>}</div></>}
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

const PROJECT_STAGE_LABELS = { architecture: "全书架构", "story-bible": "资料库", outline: "故事大纲", "story-control": "剧情控制", chapters: "章节编排", review: "一致性检查" } as const;
const PROJECT_STAGE_TASK = { architecture: "architecture", "story-bible": "story-bible", outline: "outline", "story-control": "story-control", chapters: "chapter-arrangement", review: "review" } as const;
const PROJECT_STAGE_SCOPE = { architecture: "architecture", "story-bible": "bible", outline: "outline", "story-control": "review", chapters: "chapters", review: "review" } as const;

function ProjectGenerationPanel({ projectId, premise }: { projectId: string; premise: string }) {
  const { message } = App.useApp();
  const runs = useLiveQuery(() => novelDb.projectGenerationRuns.where("projectId").equals(projectId).reverse().sortBy("createdAt"), [projectId]) ?? [];
  const run = runs[0];
  const pendingCount = useLiveQuery(() => novelDb.proposals.where("projectId").equals(projectId).and((item) => item.status === "pending").count(), [projectId]) ?? 0;
  const active = run && !["completed", "cancelled"].includes(run.status);
  const [instruction, setInstruction] = useState(premise);
  const [busy, setBusy] = useState(false);
  async function perform(action: () => Promise<unknown>) { setBusy(true); try { await action(); } catch (error) { message.error(error instanceof Error ? error.message : "操作失败"); } finally { setBusy(false); } }
  return <section className="novel-project-generation"><header><div><span>AI PROJECT PIPELINE</span><h3>从创意生成全案</h3><p>每个阶段先生成候选，审核采纳后自动进入下一阶段。</p></div><div>{pendingCount > 0 && <Tag color="gold">{pendingCount} 项待审核</Tag>}{run && <Tag color={run.status === "failed" ? "red" : run.status === "completed" ? "green" : "gold"}>{run.status}</Tag>}</div></header>
    <div className="novel-project-stage-rail">{PROJECT_GENERATION_STAGES.map((stage, index) => <div key={stage} className={run && index < run.stageIndex ? "done" : run?.currentStage === stage ? "active" : ""}><i>{index + 1}</i><span>{PROJECT_STAGE_LABELS[stage]}</span></div>)}</div>
    {!active && <><div className="novel-project-generation-launch"><Input.TextArea rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="输入核心创意、题材方向或整套规划要求" /><Button type="primary" size="large" icon={<ThunderboltOutlined />} loading={busy} onClick={() => void perform(() => startProjectGeneration(projectId, instruction || premise))}>开始生成全案</Button></div><div className="novel-project-positioning"><strong>只完善项目定位</strong><GenerationComposer projectId={projectId} scope="dashboard" taskKeys={["project-positioning"]} compact /></div></>}
    {active && run.status !== "failed" && <GenerationComposer projectId={projectId} scope={PROJECT_STAGE_SCOPE[run.currentStage]} taskKeys={[PROJECT_STAGE_TASK[run.currentStage]]} projectGenerationRunId={run.id} />}
    {active && <footer>{run.status === "failed" && <><p>{run.error}</p><Button icon={<ReloadOutlined />} loading={busy} onClick={() => void perform(() => retryProjectGeneration(run.id))}>重试当前阶段</Button></>}<Button onClick={() => void perform(() => skipProjectGenerationStage(run.id))}>跳过当前阶段</Button><Button danger onClick={() => void perform(() => cancelProjectGeneration(run.id))}>取消全案流程</Button></footer>}
  </section>;
}

function DashboardView({ projectId, onWrite, onAI, onWorkflow }: { projectId: string; onWrite: () => void; onAI: () => void; onWorkflow: () => void }) {
  const project = useLiveQuery(() => novelDb.projects.get(projectId), [projectId]);
  const documents = useLiveQuery(() => novelDb.documents.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const threads = useLiveQuery(() => novelDb.plotThreads.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const clues = useLiveQuery(() => novelDb.foreshadowing.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const entities = useLiveQuery(() => novelDb.entities.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const words = documents.reduce((sum, item) => sum + item.wordCount, 0);
  if (!project) return <Spin />;
  return <div className="novel-view-content novel-dashboard"><ProjectGenerationPanel projectId={projectId} premise={project.premise} /><SectionTitle eyebrow="STORY NOW" title="近期剧情" description="写下一章之前，先看清故事此刻停在哪里。" action={<div className="novel-dashboard-actions"><Button className="novel-dashboard-action-primary" icon={<EditOutlined />} onClick={onWrite}>继续写作</Button><Button className="novel-dashboard-action-secondary" icon={<DeploymentUnitOutlined />} onClick={onWorkflow}>章节流程</Button><Tooltip title="打开任务历史"><Button className="novel-dashboard-action-tool" aria-label="打开任务历史" icon={<RobotOutlined />} onClick={onAI} /></Tooltip></div>} />
    <div className="novel-metric-grid"><Metric label="总字数" value={words.toLocaleString()} note={`目标 ${project.targetWords.toLocaleString()}`} /><Metric label="章节" value={documents.length} note={`${documents.filter((item) => item.status === "final").length} 章定稿`} /><Metric label="活跃剧情线" value={threads.filter((item) => item.status === "active").length} note={`${threads.length} 条已登记`} tone="good" /><Metric label="连续性风险" value={clues.filter((item) => item.urgency > 70 && item.status !== "resolved").length} note="需要关注" tone={clues.some((item) => item.urgency > 70) ? "warn" : "neutral"} /></div>
    <div className="novel-dashboard-grid"><section className="novel-current-state"><div className="novel-panel-heading"><span>CURRENT STATE</span><h3>故事现在发生了什么</h3></div>{documents.slice(-5).reverse().map((doc, index) => <article key={doc.id}><span>{index === 0 ? "现在" : `-${index}`}</span><div><strong>{doc.title}</strong><p>{doc.summary || doc.plainText.slice(0, 100) || "本章尚未形成摘要"}</p></div><Tag>{doc.status}</Tag></article>)}{documents.length === 0 && <Empty description="暂无章节" />}</section><section className="novel-active-cast"><div className="novel-panel-heading"><span>ACTIVE CAST</span><h3>活跃人物</h3></div>{entities.filter((item) => item.kind === "character").slice(0, 6).map((entity) => <article key={entity.id}><span>{entity.name.slice(0, 1)}</span><div><strong>{entity.name}</strong><p>{entity.character?.state.objective || "尚未记录当前目标"}</p></div><small>{entity.character?.state.emotional || "未知"}</small></article>)}</section><section className="novel-open-loops"><div className="novel-panel-heading"><span>OPEN LOOPS</span><h3>未闭合线索</h3></div>{clues.filter((item) => item.status !== "resolved").slice(0, 5).map((clue) => <article key={clue.id}><div><strong>{clue.title}</strong><p>{clue.clue || "等待补充线索表现"}</p></div><Progress percent={clue.urgency} showInfo={false} strokeColor={clue.urgency > 70 ? "#c45c4e" : "#ad8b51"} /></article>)}</section><section className="novel-next-moves"><div className="novel-panel-heading"><span>NEXT MOVES</span><h3>接下来要推进</h3></div>{threads.filter((item) => item.status !== "resolved").slice(0, 5).map((thread) => <article key={thread.id}><Tag>{thread.kind}</Tag><div><strong>{thread.title}</strong><p>{thread.nextMove || "等待确定下一步动作"}</p></div></article>)}</section></div>
  </div>;
}

function AnalysisView({ projectId }: { projectId: string }) {
  const nodes = useLiveQuery(() => novelDb.outlineNodes.where("projectId").equals(projectId).and((item) => item.kind === "event").sortBy("order"), [projectId]) ?? [];
  const entities = useLiveQuery(() => novelDb.entities.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const docs = useLiveQuery(() => novelDb.documents.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const max = Math.max(1, ...nodes.flatMap((node) => [node.tension, node.emotion, node.information]));
  return <div className="novel-view-content"><SectionTitle eyebrow="EDITORIAL ANALYSIS" title="故事分析" description="用可解释的指标发现节奏、角色与信息分布问题。" /><div className="novel-analysis-grid"><section><h3>故事事件节奏</h3><div className="novel-bar-chart">{nodes.map((node) => <Tooltip key={node.id} title={`${node.title} · 张力 ${node.tension} / 情绪 ${node.emotion} / 信息 ${node.information}`}><div><i style={{ height: `${node.tension / max * 100}%` }} /><i style={{ height: `${node.emotion / max * 100}%` }} /><i style={{ height: `${node.information / max * 100}%` }} /><span>{node.order + 1}</span></div></Tooltip>)}</div><footer><span className="tension">张力</span><span className="emotion">情绪</span><span className="information">信息</span></footer></section><section><h3>作品健康度</h3><div className="novel-health-ring"><Progress type="circle" percent={Math.min(100, 35 + entities.length * 3 + docs.filter((item) => item.summary).length * 4)} strokeColor="#b5483a" trailColor="#2b2927" size={150} /><p>基于设定完整度、章节摘要和连续性记录</p></div></section><section><h3>编辑建议</h3><ul className="novel-editorial-notes"><li><CheckCircleOutlined /> 已建立 {entities.length} 个故事实体</li><li><CheckCircleOutlined /> {nodes.length} 个故事事件进入节奏分析</li><li className={docs.some((item) => !item.summary) ? "warn" : ""}><BulbOutlined /> {docs.filter((item) => !item.summary).length} 章缺少摘要，会影响长期上下文</li><li className={nodes.some((item) => item.tension === nodeAverage(nodes.map((item) => item.tension))) ? "warn" : ""}><RadarChartOutlined /> 建议让相邻事件的张力形成更明显落差</li></ul></section></div></div>;
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
  const documents = useLiveQuery(() => novelDb.documents.where("projectId").equals(projectId).sortBy("order"), [projectId]) ?? [];
  const conflicts = useLiveQuery(() => novelDb.conflicts.where({ projectId, status: "open" }).count(), [projectId]) ?? 0;
  const urgentForeshadowingCount = useLiveQuery(
    () => novelDb.foreshadowing.where("projectId").equals(projectId).filter((item) => item.urgency > 70 && item.status !== "resolved").count(),
    [projectId],
  ) ?? 0;
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>();
  const [aiCollapsed, setAiCollapsed] = useState(() => window.matchMedia("(max-width: 700px)").matches);
  const [mobileNav, setMobileNav] = useState(false);
  const selectedDocument = documents.find((item) => item.id === selectedDocumentId) ?? documents[0];
  useEffect(() => { if (!selectedDocumentId && documents[0]) setSelectedDocumentId(documents[0].id); }, [documents, selectedDocumentId]);
  const exportItems: MenuProps["items"] = (["json", "markdown", "txt", "docx", "epub"] as const).map((format) => ({ key: format, label: format === "json" ? "完整项目备份" : `导出 ${format.toUpperCase()}`, onClick: () => void exportNovel(projectId, format) }));
  const groups = useMemo(() => [...new Set(VIEW_ITEMS.map((item) => item.group))], []);
  if (project === undefined) return <div className="novel-studio-loading"><Spin /><span>打开故事工作区</span></div>;
  if (!project) return <div className="novel-studio-loading"><Empty description="项目不存在" /><Button onClick={() => navigate("/novels")}>返回项目中心</Button></div>;
  function setView(next: NovelWorkspaceView, panel?: string) { setSearchParams(panel ? { view: next, panel } : { view: next }); setMobileNav(false); }
  function renderView() {
    if (view === "dashboard") return <DashboardView projectId={projectId} onWrite={() => setView("writing")} onAI={() => setAiCollapsed(false)} onWorkflow={() => setView("writing", "workflow")} />;
    if (view === "planning") return <Suspense fallback={<div className="novel-studio-loading"><Spin /><span>加载规划工作区</span></div>}><PlanningWorkspace projectId={projectId} /></Suspense>;
    if (view === "writing") return <WritingWorkspace projectId={projectId} documents={documents} selectedDocument={selectedDocument} onSelectDocument={setSelectedDocumentId} initialMode={searchParams.get("panel") === "workflow" ? "workflow" : "manuscript"} />;
    if (view === "library") return <LibraryWorkspace projectId={projectId} />;
    if (view === "review") return <ReviewWorkspace projectId={projectId} />;
    if (view === "settings") return <Suspense fallback={<div className="novel-studio-loading"><Spin /><span>加载项目设置</span></div>}><SkillCenter projectId={projectId} /></Suspense>;
    return <DashboardView projectId={projectId} onWrite={() => setView("writing")} onAI={() => setAiCollapsed(false)} onWorkflow={() => setView("writing", "workflow")} />;
  }
  const assistantScope = (["dashboard", "planning", "writing", "library", "review", "settings"].includes(view) ? view : "dashboard") as "dashboard" | "planning" | "writing" | "library" | "review" | "settings";
  const assistantDocument = assistantScope === "writing" || assistantScope === "review" ? selectedDocument : undefined;
  const assistantTarget = assistantScope === "planning" ? "当前故事规划" : assistantScope === "library" ? "当前资料库" : assistantScope === "review" ? "当前审校任务" : undefined;
  return <div className="novel-studio"><header className="novel-studio-topbar"><div><Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate("/novels")} /><Button className="novel-mobile-menu" type="text" icon={<MenuOutlined />} onClick={() => setMobileNav(true)} /><span className="novel-mini-cover" style={{ background: project.coverColor }}>{project.title.slice(0, 1)}</span><div><strong>{project.title}</strong><small>{view === "settings" ? "项目设置" : VIEW_ITEMS.find((item) => item.key === view)?.label ?? "总览"}</small></div></div><div className="novel-topbar-status"><span><CloudSyncOutlined /> 本地已保存</span>{conflicts > 0 && <Tag color="red">{conflicts} 个同步冲突</Tag>}<Button type={view === "settings" ? "primary" : "default"} icon={<ToolOutlined />} onClick={() => setView("settings")}>项目设置</Button><Dropdown menu={{ items: exportItems }}><Button icon={<ExportOutlined />}>导出 <MoreOutlined /></Button></Dropdown></div></header><div className="novel-studio-body"><nav className="novel-workspace-nav">{groups.map((group) => <section key={group}><span>{group}</span>{VIEW_ITEMS.filter((item) => item.group === group).map((item) => <button key={item.key} className={view === item.key ? "active" : ""} onClick={() => setView(item.key)}>{item.icon}<span>{item.label}</span>{item.key === "review" && urgentForeshadowingCount > 0 && <i title={`${urgentForeshadowingCount} 条高紧迫度伏笔需要关注`} />}</button>)}</section>)}</nav><main className="novel-workspace-main">{renderView()}</main><Suspense fallback={<button className="novel-ai-collapsed"><RobotOutlined /><span>AI</span></button>}><AIWorkbench projectId={projectId} document={assistantDocument} scope={assistantScope} targetLabel={assistantTarget} collapsed={aiCollapsed} onToggle={() => setAiCollapsed((value) => !value)} /></Suspense></div><footer className="novel-taskbar"><span><span className="online-dot" /> 数据库在线</span><span>Schema v{project.schemaVersion}</span><span>修订 {project.revision}</span><span className="spacer" /><span>{documents.reduce((sum, item) => sum + item.wordCount, 0).toLocaleString()} 字</span><span>今日目标 {project.dailyGoal.toLocaleString()}</span></footer><Drawer placement="left" width={280} open={mobileNav} onClose={() => setMobileNav(false)} title={project.title}>{groups.map((group) => <div className="novel-mobile-nav" key={group}><strong>{group}</strong>{VIEW_ITEMS.filter((item) => item.group === group).map((item) => <Button key={item.key} type={view === item.key ? "primary" : "text"} icon={item.icon} onClick={() => setView(item.key)} block>{item.label}</Button>)}</div>)}</Drawer></div>;
}


function ChapterPlanEditor({ document }: { document?: ManuscriptDocument }) {
  const { message } = App.useApp();
  if (!document) return <EmptyPanel title="选择一个章节" description="创建或选择章节后规划本章。" />;
  const save = async (changes: Partial<ManuscriptDocument>) => {
    const next = { ...document, ...changes, revision: document.revision + 1, updatedAt: Date.now() };
    await novelDb.documents.put(next);
    await appendOperation(document.projectId, "documents", document.id, "update", { value: { before: document, after: next } });
  };
  const blueprint = document.blueprint;
  return <div className="novel-chapter-plan"><GenerationComposer projectId={document.projectId} scope="chapters" targetId={document.id} taskKeys={["chapter-plan"]} compact /><SectionTitle eyebrow="CHAPTER PLAN" title={document.title} description="章节蓝图只约束本章写作，不与故事大纲建立硬关联。" action={<Tag>{document.status}</Tag>} />
    <div className="novel-architecture-form"><label>章节标题<Input value={document.title} onChange={(event) => void save({ title: event.target.value })} /></label><label>章节摘要<Input.TextArea rows={3} value={document.summary} onChange={(event) => void save({ summary: event.target.value })} /></label><label>本章目标<Input.TextArea rows={2} value={blueprint.objective} onChange={(event) => void save({ blueprint: { ...blueprint, objective: event.target.value } })} /></label><label>冲突<Input.TextArea rows={2} value={blueprint.conflict} onChange={(event) => void save({ blueprint: { ...blueprint, conflict: event.target.value } })} /></label><label>转折<Input.TextArea rows={2} value={blueprint.turningPoint} onChange={(event) => void save({ blueprint: { ...blueprint, turningPoint: event.target.value } })} /></label><label>章尾钩子<Input.TextArea rows={2} value={blueprint.hook} onChange={(event) => void save({ blueprint: { ...blueprint, hook: event.target.value } })} /></label><label>目标字数<InputNumber min={100} max={50000} value={blueprint.targetWords} onChange={(value) => void save({ blueprint: { ...blueprint, targetWords: value ?? 3000 } })} /></label></div>
    <Button icon={<SaveOutlined />} onClick={() => message.success("章节规划实时保存")}>确认规划</Button>
  </div>;
}

function ScenePlanner({ document }: { document?: ManuscriptDocument }) {
  const { modal } = App.useApp();
  const scenes = useLiveQuery<StoryScene[]>(async () => document ? await novelDb.scenes.where("chapterId").equals(document.id).sortBy("order") : [], [document?.id]) ?? [];
  const [selectedId, setSelectedId] = useState<string>();
  const selected = scenes.find((item) => item.id === selectedId) ?? scenes[0];
  if (!document) return <EmptyPanel title="选择一个章节" description="场景属于章节，请先创建或选择章节。" />;
  async function addScene() {
    const scene = { ...recordBase(document!.projectId), chapterId: document!.id, title: `场景 ${scenes.length + 1}`, order: scenes.length, status: "idea" as const, characterIds: [], plotThreadIds: [], foreshadowingIds: [], purpose: "", conflict: "", outcome: "", wordTarget: 800, beats: [] };
    await novelDb.scenes.add(scene); setSelectedId(scene.id);
  }
  async function updateScene(changes: Record<string, unknown>) { if (selected) await novelDb.scenes.update(selected.id, { ...changes, revision: selected.revision + 1, updatedAt: Date.now() }); }
  return <div className="novel-chapter-plan"><GenerationComposer projectId={document.projectId} scope="scenes" targetId={document.id} taskKeys={["scene-design"]} compact /><SectionTitle eyebrow="SCENE DESIGN" title={`${document.title} · 场景`} description="按目标、阻碍、结果和行动节拍设计本章内部推进。" action={<Button type="primary" icon={<PlusOutlined />} onClick={() => void addScene()}>添加场景</Button>} />
    <div className="novel-scene-layout"><aside>{scenes.map((scene) => <button key={scene.id} className={selected?.id === scene.id ? "active" : ""} onClick={() => setSelectedId(scene.id)}><strong>{scene.title}</strong><small>{scene.purpose || "等待定义场景功能"}</small></button>)}</aside>{selected ? <div className="novel-scene-detail"><div className="novel-scene-title-row"><Input value={selected.title} onChange={(event) => void updateScene({ title: event.target.value })} /><Button danger type="text" icon={<DeleteOutlined />} onClick={() => modal.confirm({ title: `删除“${selected.title}”？`, okButtonProps: { danger: true }, onOk: async () => { await novelDb.scenes.delete(selected.id); setSelectedId(undefined); } })} /></div><Input.TextArea rows={2} placeholder="场景功能" value={selected.purpose} onChange={(event) => void updateScene({ purpose: event.target.value })} /><Input.TextArea rows={2} placeholder="目标与阻碍" value={selected.conflict} onChange={(event) => void updateScene({ conflict: event.target.value })} /><Input.TextArea rows={2} placeholder="结果、代价或新决定" value={selected.outcome} onChange={(event) => void updateScene({ outcome: event.target.value })} /><div className="novel-scene-beats"><header><strong>行动节拍</strong><Button type="text" icon={<PlusOutlined />} onClick={() => void updateScene({ beats: [...(selected.beats ?? []), { id: crypto.randomUUID(), text: "", order: selected.beats?.length ?? 0 }] })}>添加</Button></header>{(selected.beats ?? []).map((beat, index) => <div key={beat.id}><i>{index + 1}</i><Input value={beat.text} onChange={(event) => void updateScene({ beats: (selected.beats ?? []).map((item) => item.id === beat.id ? { ...item, text: event.target.value } : item) })} /><Button danger type="text" icon={<DeleteOutlined />} onClick={() => void updateScene({ beats: (selected.beats ?? []).filter((item) => item.id !== beat.id).map((item, order) => ({ ...item, order })) })} /></div>)}</div></div> : <Empty description="添加一个场景" />}</div>
  </div>;
}

function WritingWorkspace({ projectId, documents, selectedDocument, onSelectDocument, initialMode }: { projectId: string; documents: ManuscriptDocument[]; selectedDocument?: ManuscriptDocument; onSelectDocument: (id: string) => void; initialMode: "manuscript" | "workflow" }) {
  const { modal } = App.useApp();
  const [mode, setMode] = useState<"plan" | "scenes" | "manuscript" | "workflow">(initialMode);
  const [draggedId, setDraggedId] = useState<string>();
  useEffect(() => setMode(initialMode), [initialMode]);
  async function moveChapter(document: ManuscriptDocument, direction: -1 | 1) {
    const index = documents.findIndex((item) => item.id === document.id);
    const target = documents[index + direction];
    if (!target) return;
    await novelDb.documents.bulkPut([{ ...document, order: target.order, revision: document.revision + 1, updatedAt: Date.now() }, { ...target, order: document.order, revision: target.revision + 1, updatedAt: Date.now() }]);
  }
  async function dropChapter(targetId: string) {
    if (!draggedId || draggedId === targetId) return;
    const sourceIndex = documents.findIndex((item) => item.id === draggedId);
    const targetIndex = documents.findIndex((item) => item.id === targetId);
    const reordered = [...documents];
    const [source] = reordered.splice(sourceIndex, 1);
    reordered.splice(targetIndex, 0, source);
    await novelDb.documents.bulkPut(reordered.map((item, order) => ({ ...item, order, revision: item.revision + 1, updatedAt: Date.now() })));
    setDraggedId(undefined);
  }
  const chapterList = <aside className="novel-chapter-list"><header><div><span>MANUSCRIPT</span><strong>章节管理</strong></div><Button type="text" icon={<PlusOutlined />} title="新增章节" onClick={async () => { const chapter = await createChapter(projectId); onSelectDocument(chapter.id); }} /></header><GenerationComposer projectId={projectId} scope="chapters" taskKeys={["chapter-arrangement"]} compact />{documents.map((doc) => <div className={`novel-chapter-row${selectedDocument?.id === doc.id ? " active" : ""}`} key={doc.id} draggable onDragStart={() => setDraggedId(doc.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => void dropChapter(doc.id)}><button onClick={() => onSelectDocument(doc.id)}><span>{String(doc.order + 1).padStart(2, "0")}</span><div><strong>{doc.title}</strong><small>{doc.wordCount} 字 · {doc.status}</small></div></button><div><Button type="text" icon={<ArrowUpOutlined />} onClick={() => void moveChapter(doc, -1)} /><Button type="text" icon={<ArrowDownOutlined />} onClick={() => void moveChapter(doc, 1)} /><Button danger type="text" icon={<DeleteOutlined />} onClick={() => modal.confirm({ title: `删除“${doc.title}”？`, content: "本章场景、正文版本和章节流程将一并删除，大纲不会受到影响。", okButtonProps: { danger: true }, onOk: async () => { if (selectedDocument?.id === doc.id) { onSelectDocument(documents.find((item) => item.id !== doc.id)?.id ?? ""); await new Promise((resolve) => setTimeout(resolve, 0)); } await deleteChapter(doc.id); } })} /></div></div>)}{!documents.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无章节，可手动新增或让 AI 编排" />}</aside>;
  const content = mode === "plan" ? <ChapterPlanEditor document={selectedDocument} /> : mode === "scenes" ? <ScenePlanner document={selectedDocument} /> : mode === "manuscript" ? <div className="novel-manuscript-with-command"><GenerationComposer projectId={projectId} scope="writing" targetId={selectedDocument?.id} taskKeys={["chapter-draft"]} compact /><ChapterEditor document={selectedDocument} onSaved={() => undefined} /></div> : <Suspense fallback={<div className="novel-studio-loading"><Spin /><span>加载章节流程</span></div>}><WorkflowCenter projectId={projectId} document={selectedDocument} /></Suspense>;
  return <div className="novel-writing-workspace"><div className="novel-workspace-tabs"><Segmented value={mode} onChange={(value) => setMode(value as typeof mode)} options={[{ value: "plan", label: "章节规划" }, { value: "scenes", label: "场景设计" }, { value: "manuscript", label: "正文编辑" }, { value: "workflow", label: "自动流程" }]} /></div><div className="novel-writing-body">{chapterList}{content}</div></div>;
}

function LibraryWorkspace({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<"bible" | "characters" | "relations" | "timeline" | "foreshadowing">("bible");
  const generation = mode === "bible" ? { scope: "bible" as const, task: "story-bible" as const } : mode === "characters" ? { scope: "characters" as const, task: "characters" as const } : mode === "relations" ? { scope: "relations" as const, task: "relations" as const } : mode === "timeline" ? { scope: "timeline" as const, task: "timeline" as const } : { scope: "foreshadowing" as const, task: "foreshadowing" as const };
  return <div className="novel-consolidated-workspace"><div className="novel-workspace-tabs"><Segmented value={mode} onChange={(value) => setMode(value as typeof mode)} options={[{ value: "bible", label: "故事圣经" }, { value: "characters", label: "角色" }, { value: "relations", label: "关系" }, { value: "timeline", label: "时间线" }, { value: "foreshadowing", label: "伏笔" }]} /></div><GenerationComposer projectId={projectId} scope={generation.scope} taskKeys={[generation.task]} compact />{mode === "bible" ? <BibleView projectId={projectId} /> : mode === "characters" ? <CharactersView projectId={projectId} /> : mode === "relations" ? <RelationsView projectId={projectId} /> : <ContinuityView projectId={projectId} type={mode} />}</div>;
}

function ReviewWorkspace({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<"analysis" | "threads" | "versions">("analysis");
  return <div className="novel-consolidated-workspace"><div className="novel-workspace-tabs"><Segmented value={mode} onChange={(value) => setMode(value as typeof mode)} options={[{ value: "analysis", label: "故事诊断" }, { value: "threads", label: "剧情线" }, { value: "versions", label: "版本历史" }]} /></div>{mode !== "versions" && <GenerationComposer projectId={projectId} scope={mode === "threads" ? "threads" : "review"} taskKeys={[mode === "threads" ? "plot-threads" : "review"]} compact />}{mode === "analysis" ? <AnalysisView projectId={projectId} /> : mode === "threads" ? <ContinuityView projectId={projectId} type="threads" /> : <VersionsView projectId={projectId} />}</div>;
}
