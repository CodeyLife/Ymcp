import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Divider, Drawer, Dropdown, Empty, Form, Input, InputNumber, Progress, Segmented, Select, Spin, Switch, Tag, Tooltip } from "antd";
import type { MenuProps } from "antd";
import {
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
  RobotOutlined,
  SaveOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import CharacterCount from "@tiptap/extension-character-count";
import Collaboration from "@tiptap/extension-collaboration";
import {
  addEntity,
  appendOperation,
  createCheckpoint,
  createChapter,
  deleteChapter,
  novelDb,
  recordBase,
  saveDocumentContent,
  updateEntity,
  updateProject,
} from "@/features/novel/db";
import { exportNovel, exportNovelEvaluationSnapshot } from "@/features/novel/export";
import { startCreativeMcpBridge } from "@/features/novel/creative-mcp-bridge";
import { openCollaborativeDocument, resolveStoredManuscriptHtml, seedEmptyCollaborativeDocument } from "@/features/novel/collaboration";
import { createManuscriptPersistenceGuard, requestDurableBrowserStorage, shouldApplyStoredManuscriptContent, type ManuscriptSaveState } from "@/features/novel/persistence";
import { DB_VERSION } from "@/features/novel/db-schema";
import type {
  Foreshadowing,
  ManuscriptDocument,
  NovelWorkspaceView,
  PlotThread,
  StoryEntity,
  TimelineEvent,
} from "@/features/novel/types";
import GenerationComposer from "@/features/novel/GenerationComposer";
import CharacterCard from "@/features/novel/CharacterCard";
import "@/features/novel/novel.css";

const SkillCenter = lazy(() => import("@/features/novel/SkillCenter"));
const WorkflowCenter = lazy(() => import("@/features/novel/WorkflowCenter"));
const FactLedger = lazy(() => import("@/features/novel/FactLedger"));
const AIWorkbench = lazy(() => import("@/features/novel/AIWorkbench"));
import { ChatModelSelect } from "@/components/ChatModelSelect";

const PlanningWorkspace = lazy(() => import("@/features/novel/PlanningWorkspace"));
const CharacterCanvasPanel = lazy(() => import("@/features/novel/canvas/CharacterCanvasPanel").then((m) => ({ default: m.CharacterCanvasPanel })));
const TimelineCanvasPanel = lazy(() => import("@/features/novel/canvas/TimelineCanvasPanel").then((m) => ({ default: m.TimelineCanvasPanel })));
import { WorldviewLibraryPanel } from "@/features/novel/WorldviewLibraryPanel";

const VIEW_ITEMS: Array<{ key: NovelWorkspaceView; label: string; icon: React.ReactNode; group: string }> = [
  { key: "planning", label: "规划", icon: <NodeIndexOutlined />, group: "创作工作区" },
  { key: "dashboard", label: "总览", icon: <DashboardOutlined />, group: "创作工作区" },
  { key: "writing", label: "写作", icon: <EditOutlined />, group: "创作工作区" },
  { key: "library", label: "资料库", icon: <BookOutlined />, group: "创作工作区" },
  { key: "review", label: "审校", icon: <RadarChartOutlined />, group: "创作工作区" },
];

const ENTITY_KIND_LABEL: Record<StoryEntity["kind"], string> = {
  character: "角色", location: "地点", organization: "组织", faction: "势力", item: "物品", species: "种族", rule: "规则", ability: "能力", term: "术语",
};

const DOCUMENT_STATUS_LABEL: Record<ManuscriptDocument["status"], string> = {
  outline: "提纲",
  draft: "草稿",
  review: "修订",
  final: "定稿",
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
  const [saveState, setSaveState] = useState<ManuscriptSaveState>("saved");
  const saveStateRef = useRef(saveState);
  const persistenceGuard = useRef(createManuscriptPersistenceGuard());
  const [lastSavedAt, setLastSavedAt] = useState<number>();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const applyingStoredContent = useRef(false);
  const collaboration = useMemo(() => document ? openCollaborativeDocument(document.projectId, document.yjsDocumentId) : undefined, [document?.projectId, document?.yjsDocumentId]);
  const storedContentHtml = document ? resolveStoredManuscriptHtml(document) : "";
  const [collaborationReady, setCollaborationReady] = useState(false);
  const synchronizedDocument = useRef<{ id?: string; revision?: number }>({});
  const updateSaveState = (next: ManuscriptSaveState) => {
    saveStateRef.current = next;
    setSaveState(next);
  };
  useEffect(() => { void requestDurableBrowserStorage(); }, []);
  useEffect(() => {
    persistenceGuard.current.reset();
    updateSaveState("saved");
    setLastSavedAt(document?.updatedAt);
  }, [document?.id]);
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
    content: storedContentHtml,
    editable: !collaboration || collaborationReady,
  }, [document?.id, collaborationReady]);
  useEffect(() => {
    if (!editor || !document || editor.isDestroyed || !collaborationReady) return;
    if (synchronizedDocument.current.id !== document.id) {
      synchronizedDocument.current = { id: document.id, revision: document.revision };
      if (collaboration) seedEmptyCollaborativeDocument(collaboration, document, (contentHtml) => {
        applyingStoredContent.current = true;
        const applied = editor.commands.setContent(contentHtml);
        queueMicrotask(() => { applyingStoredContent.current = false; });
        return applied;
      });
      return;
    }
    if (synchronizedDocument.current.revision === document.revision) return;
    synchronizedDocument.current.revision = document.revision;
    if (!shouldApplyStoredManuscriptContent({ saveState: saveStateRef.current, editorHtml: editor.getHTML(), storedContentHtml })) return;
    applyingStoredContent.current = true;
    editor.commands.setContent(storedContentHtml);
    queueMicrotask(() => { applyingStoredContent.current = false; });
  }, [collaboration, collaborationReady, document, editor, storedContentHtml]);
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

  async function save(checkpoint = false, announce = true) {
    if (!editor || !document) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const saveVersion = persistenceGuard.current.beginSave();
    updateSaveState("saving");
    try {
      const plainText = editor.getText({ blockSeparator: "\n\n" });
      await saveDocumentContent({
        documentId: document.id,
        contentHtml: editor.getHTML(),
        plainText,
        wordCount: countWords(plainText),
        status: document.status === "outline" ? "draft" : undefined,
        checkpointLabel: checkpoint ? `手动检查点 ${new Date().toLocaleString("zh-CN")}` : undefined,
      });
      updateSaveState(persistenceGuard.current.isSaveCurrent(saveVersion) ? "saved" : "dirty");
      setLastSavedAt(Date.now());
      if (announce) message.success(checkpoint ? "检查点已创建" : "正文已保存");
      onSaved();
    } catch (error) {
      updateSaveState("error");
      message.error(error instanceof Error ? error.message : "正文保存失败");
    }
  }

  useEffect(() => {
    if (!editor || !document) return;
    const markDirty = () => {
      if (applyingStoredContent.current) return;
      persistenceGuard.current.markEdited();
      updateSaveState("dirty");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void save(false, false), 1500);
    };
    editor.on("update", markDirty);
    const flushWhenHidden = () => {
      if (globalThis.document.visibilityState === "hidden" && saveStateRef.current === "dirty") void save(false, false);
    };
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (saveStateRef.current !== "dirty" && saveStateRef.current !== "error") return;
      event.preventDefault();
    };
    globalThis.document.addEventListener("visibilitychange", flushWhenHidden);
    globalThis.addEventListener("beforeunload", warnBeforeUnload);
    return () => {
      editor.off("update", markDirty);
      globalThis.document.removeEventListener("visibilitychange", flushWhenHidden);
      globalThis.removeEventListener("beforeunload", warnBeforeUnload);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (saveStateRef.current === "dirty") void save(false, false);
    };
  }, [document?.id, editor]);

  if (!document) return <EmptyPanel title="选择一个章节" description="从左侧章节管理器选择或新建章节。" />;
  if (collaboration && !collaborationReady) return <div className="novel-studio-loading"><Spin /><span>正在恢复章节内容</span></div>;
  return (
    <div className="novel-editor-shell">
      <div className="novel-editor-toolbar">
        <div className="novel-editor-tools" aria-label="正文格式工具">
          <Tooltip title="加粗"><Button aria-label="加粗" type={editor?.isActive("bold") ? "primary" : "text"} onClick={() => editor?.chain().focus().toggleBold().run()}><strong>B</strong></Button></Tooltip>
          <Tooltip title="斜体"><Button aria-label="斜体" type={editor?.isActive("italic") ? "primary" : "text"} onClick={() => editor?.chain().focus().toggleItalic().run()}><em>I</em></Button></Tooltip>
          <span className="novel-toolbar-divider" />
          <Button type={editor?.isActive("blockquote") ? "primary" : "text"} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>引用</Button>
          <Button type={editor?.isActive("bulletList") ? "primary" : "text"} onClick={() => editor?.chain().focus().toggleBulletList().run()}>列表</Button>
          <Button type="text" onClick={() => editor?.chain().focus().setHorizontalRule().run()}>分隔线</Button>
        </div>
        <div className="novel-editor-actions">
          <span>{(editor?.storage.characterCount.characters() ?? 0).toLocaleString()} 字</span>
          <Tag color={saveState === "error" ? "red" : saveState === "dirty" ? "gold" : saveState === "saving" ? "processing" : "green"}>{saveState === "error" ? "保存失败" : saveState === "dirty" ? "未保存" : saveState === "saving" ? "保存中" : lastSavedAt ? `已保存 ${new Date(lastSavedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "已保存"}</Tag>
          <Tooltip title="创建正文检查点"><Button aria-label="创建正文检查点" icon={<HistoryOutlined />} onClick={() => void save(true)}>检查点</Button></Tooltip>
          <Button type="primary" icon={<SaveOutlined />} loading={saveState === "saving"} onClick={() => void save()}>保存</Button>
        </div>
      </div>
      <div className="novel-paper"><div className="novel-paper-heading"><span>正文</span><h1>{document.title}</h1><small>{DOCUMENT_STATUS_LABEL[document.status]} · {document.branch}</small></div><EditorContent editor={editor} /></div>
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
  const currentProjectSnapshot = () => {
    const values = form.getFieldsValue(true);
    const list = (value: unknown) => typeof value === "string" ? value.split(/[、,，]/).filter(Boolean) : Array.isArray(value) ? value : [];
    return { projects: [{ ...project, ...values, genre: list(values.genre), themes: list(values.themes), sellingPoints: list(values.sellingPoints) }] as Array<Record<string, unknown>> };
  };
  return <div className="novel-view-content"><GenerationComposer projectId={projectId} scope="bible" taskKeys={["project-positioning", "story-bible"]} getRefinementSnapshot={currentProjectSnapshot} /><SectionTitle eyebrow="STORY BIBLE" title="故事圣经" description="这里的内容是所有规划、写作和审校任务共同遵守的事实基础。" />
    <Form form={form} layout="vertical" className="novel-bible-form" onFinish={async (values) => { await updateProject(projectId, { ...values, genre: values.genre.split(/[、,，]/).filter(Boolean), themes: values.themes.split(/[、,，]/).filter(Boolean), sellingPoints: values.sellingPoints.split(/[、,，]/).filter(Boolean) }); message.success("故事圣经已保存"); }}>
      <section><h3>作品定位</h3><div className="novel-form-grid"><Form.Item name="title" label="书名"><Input /></Form.Item><Form.Item name="subtitle" label="副标题"><Input /></Form.Item><Form.Item name="genre" label="题材"><Input /></Form.Item><Form.Item name="audience" label="目标读者"><Input /></Form.Item><Form.Item name="pov" label="叙事视角"><Input /></Form.Item><Form.Item name="tense" label="叙事时态"><Input /></Form.Item></div><Form.Item name="premise" label="核心创意"><Input.TextArea rows={3} /></Form.Item></section>
      <section><h3>主题与风格</h3><div className="novel-form-grid"><Form.Item name="themes" label="主题"><Input placeholder="成长、代价、记忆" /></Form.Item><Form.Item name="sellingPoints" label="核心卖点"><Input /></Form.Item><Form.Item name="tone" label="整体基调"><Input /></Form.Item><Form.Item name="languageStyle" label="语言风格"><Input /></Form.Item></div></section>
      <section><h3>AI 与创作上下文</h3><div className="novel-form-grid"><Form.Item name={["settings", "textModel"]} label="文本模型"><ChatModelSelect style={{ width: "100%" }} /></Form.Item><Form.Item name={["settings", "temperature"]} label="创作温度"><InputNumber min={0} max={2} step={0.05} style={{ width: "100%" }} /></Form.Item><Form.Item name={["settings", "recentChapterCount"]} label="近期章节数量"><InputNumber min={1} max={30} style={{ width: "100%" }} /></Form.Item><Form.Item name={["settings", "encrypted"]} label="敏感项目加密" valuePropName="checked"><Switch disabled /><span className="novel-inline-help">需先设置项目密钥</span></Form.Item></div></section>
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
  return <div className="novel-view-content"><GenerationComposer projectId={projectId} scope="characters" taskKeys={["characters"]} compact getRefinementSnapshot={() => ({ entities: draft ? [draft as unknown as Record<string, unknown>] : [] })} /><SectionTitle eyebrow="CAST" title="角色档案" description="人物的欲望、知识与实时状态共同决定他们在场景中能做什么。" action={<Button type="primary" icon={<PlusOutlined />} onClick={async () => { const entity = await addEntity(projectId, "character", `新角色 ${entities.length + 1}`); setSelectedId(entity.id); }}>添加角色</Button>} />
    {entities.length === 0 ? <EmptyPanel title="还没有角色" description="创建主角、对手或关键配角。" /> : <div className="novel-character-layout"><aside>{entities.map((entity) => <button key={entity.id} className={selected?.id === entity.id ? "active" : ""} onClick={() => setSelectedId(entity.id)}><CharacterCard entity={entity} mode="rail" selected={selected?.id === entity.id} /></button>)}</aside>{draft && <main><div className="novel-character-identity"><span>{draft.name.slice(0, 1)}</span><div><Input variant="borderless" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /><Input variant="borderless" value={draft.character?.role} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, role: event.target.value } })} /></div><Button type="primary" icon={<SaveOutlined />} onClick={() => void updateEntity(draft)}>保存</Button></div><div className="novel-form-grid"><label>人物摘要<Input.TextArea rows={3} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label><label>外貌与辨识度<Input.TextArea rows={3} value={draft.character?.appearance} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, appearance: event.target.value } })} /></label><label>性格<Input.TextArea rows={3} value={draft.character?.personality} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, personality: event.target.value } })} /></label><label>欲望<Input.TextArea rows={3} value={draft.character?.desire} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, desire: event.target.value } })} /></label><label>动机<Input.TextArea rows={3} value={draft.character?.motivation} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, motivation: event.target.value } })} /></label><label>弱点<Input.TextArea rows={3} value={draft.character?.weakness} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, weakness: event.target.value } })} /></label><label>秘密<Input.TextArea rows={3} value={draft.character?.secret} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, secret: event.target.value } })} /></label><label>人物弧光<Input.TextArea rows={3} value={draft.character?.arc} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, arc: event.target.value } })} /></label></div><Divider>当前故事状态</Divider><div className="novel-state-row"><Input addonBefore="位置" value={draft.character?.state.location} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, state: { ...draft.character!.state, location: event.target.value } } })} /><Input addonBefore="情绪" value={draft.character?.state.emotional} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, state: { ...draft.character!.state, emotional: event.target.value } } })} /><Input addonBefore="当前目标" value={draft.character?.state.objective} onChange={(event) => setDraft({ ...draft, character: { ...draft.character!, state: { ...draft.character!.state, objective: event.target.value } } })} /></div></main>}</div>}
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
  return <div className="novel-view-content novel-dashboard"><SectionTitle eyebrow="STORY NOW" title="近期剧情" description="写下一章之前，先看清故事此刻停在哪里。" action={<div className="novel-dashboard-actions"><Button className="novel-dashboard-action-primary" icon={<EditOutlined />} onClick={onWrite}>继续写作</Button><Button className="novel-dashboard-action-secondary" icon={<DeploymentUnitOutlined />} onClick={onWorkflow}>章节流程</Button><Tooltip title="打开任务历史"><Button className="novel-dashboard-action-tool" aria-label="打开任务历史" icon={<RobotOutlined />} onClick={onAI} /></Tooltip></div>} />
    <div className="novel-metric-grid"><Metric label="总字数" value={words.toLocaleString()} note={`目标 ${project.targetWords.toLocaleString()}`} /><Metric label="章节" value={documents.length} note={`${documents.filter((item) => item.status === "final").length} 章定稿`} /><Metric label="活跃剧情线" value={threads.filter((item) => item.status === "active").length} note={`${threads.length} 条已登记`} tone="good" /><Metric label="连续性风险" value={clues.filter((item) => item.urgency > 70 && item.status !== "resolved").length} note="需要关注" tone={clues.some((item) => item.urgency > 70) ? "warn" : "neutral"} /></div>
    <div className="novel-dashboard-grid"><section className="novel-current-state"><div className="novel-panel-heading"><span>CURRENT STATE</span><h3>故事现在发生了什么</h3></div>{documents.slice(-5).reverse().map((doc, index) => <article key={doc.id}><span>{index === 0 ? "现在" : `-${index}`}</span><div><strong>{doc.title}</strong><p>{doc.summary || doc.plainText.slice(0, 100) || "本章尚未形成摘要"}</p></div><Tag>{doc.status}</Tag></article>)}{documents.length === 0 && <Empty description="暂无章节" />}</section><section className="novel-active-cast"><div className="novel-panel-heading"><span>ACTIVE CAST</span><h3>活跃人物</h3></div>{entities.filter((item) => item.kind === "character").slice(0, 6).map((entity) => <CharacterCard key={entity.id} entity={entity} mode="compact" />)}</section><section className="novel-open-loops"><div className="novel-panel-heading"><span>OPEN LOOPS</span><h3>未闭合线索</h3></div>{clues.filter((item) => item.status !== "resolved").slice(0, 5).map((clue) => <article key={clue.id}><div><strong>{clue.title}</strong><p>{clue.clue || "等待补充线索表现"}</p></div><Progress percent={clue.urgency} showInfo={false} strokeColor={clue.urgency > 70 ? "#c45c4e" : "#ad8b51"} /></article>)}</section><section className="novel-next-moves"><div className="novel-panel-heading"><span>NEXT MOVES</span><h3>接下来要推进</h3></div>{threads.filter((item) => item.status !== "resolved").slice(0, 5).map((thread) => <article key={thread.id}><Tag>{thread.kind}</Tag><div><strong>{thread.title}</strong><p>{thread.nextMove || "等待确定下一步动作"}</p></div></article>)}</section></div>
  </div>;
}

function AnalysisView({ projectId }: { projectId: string }) {
  const nodes = useLiveQuery(() => novelDb.outlineNodes.where("projectId").equals(projectId).sortBy("order"), [projectId]) ?? [];
  const entities = useLiveQuery(() => novelDb.entities.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const docs = useLiveQuery(() => novelDb.documents.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  return <div className="novel-view-content"><SectionTitle eyebrow="EDITORIAL ANALYSIS" title="故事分析" description="检查设定、剧情段与章节资料的完整度。" /><div className="novel-analysis-grid"><section><h3>作品健康度</h3><div className="novel-health-ring"><Progress type="circle" percent={Math.min(100, 35 + entities.length * 3 + docs.filter((item) => item.summary).length * 4)} strokeColor="#b5483a" trailColor="#2b2927" size={150} /><p>基于设定完整度、章节摘要和连续性记录</p></div></section><section><h3>编辑建议</h3><ul className="novel-editorial-notes"><li><CheckCircleOutlined /> 已建立 {entities.length} 个故事实体</li><li><CheckCircleOutlined /> 已规划 {nodes.length} 个剧情段、{docs.length} 个章节</li><li className={docs.some((item) => !item.summary) ? "warn" : ""}><BulbOutlined /> {docs.filter((item) => !item.summary).length} 章缺少摘要，会影响长期上下文</li></ul></section></div></div>;
}

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
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | undefined>(() => searchParams.get("document") ?? undefined);
  const [aiCollapsed, setAiCollapsed] = useState(() => window.matchMedia("(max-width: 1600px)").matches);
  const [mobileNav, setMobileNav] = useState(false);
  const selectedDocument = documents.find((item) => item.id === selectedDocumentId) ?? documents[0];
  useEffect(() => {
    if (!project) return undefined;
    return startCreativeMcpBridge({ projectId: project.id, projectTitle: project.title });
  }, [project?.id, project?.title]);
  useEffect(() => {
    const routeDocumentId = searchParams.get("document") ?? undefined;
    if (routeDocumentId && routeDocumentId !== selectedDocumentId) setSelectedDocumentId(routeDocumentId);
  }, [searchParams, selectedDocumentId]);
  useEffect(() => {
    if (!selectedDocumentId && documents[0]) selectDocument(documents[0].id);
  }, [documents, selectedDocumentId]);
  const exportItems: MenuProps["items"] = [
    ...(["json", "markdown", "txt", "docx", "epub"] as const).map((format) => ({ key: format, label: format === "json" ? "完整项目备份" : `导出 ${format.toUpperCase()}`, onClick: () => void exportNovel(projectId, format) })),
    { type: "divider" },
    { key: "evaluation-snapshot", label: "导出评测快照", onClick: () => void exportNovelEvaluationSnapshot(projectId) },
  ];
  const groups = useMemo(() => [...new Set(VIEW_ITEMS.map((item) => item.group))], []);
  if (project === undefined) return <div className="novel-studio-loading"><Spin /><span>打开故事工作区</span></div>;
  if (!project) return <div className="novel-studio-loading"><Empty description="项目不存在" /><Button onClick={() => navigate("/novels")}>返回项目中心</Button></div>;
  function setView(next: NovelWorkspaceView, panel?: string, documentId?: string) {
    setSearchParams({ view: next, ...(panel ? { panel } : {}), ...(documentId ? { document: documentId } : {}) });
    setMobileNav(false);
  }
  function selectDocument(documentId: string) {
    setSelectedDocumentId(documentId || undefined);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (documentId) next.set("document", documentId);
      else next.delete("document");
      return next;
    }, { replace: true });
  }
  function renderView() {
    if (view === "dashboard") return <DashboardView projectId={projectId} onWrite={() => setView("writing")} onAI={() => setAiCollapsed(false)} onWorkflow={() => setView("writing", "workflow")} />;
    if (view === "planning") return <Suspense fallback={<div className="novel-studio-loading"><Spin /><span>加载规划工作区</span></div>}><PlanningWorkspace projectId={projectId} onOpenChapter={(documentId, panel) => { setSelectedDocumentId(documentId); setView("writing", panel, documentId); }} /></Suspense>;
    if (view === "writing") {
      const panel = searchParams.get("panel");
      const initialMode = panel === "workflow" ? "workflow" : "manuscript";
      return <WritingWorkspace projectId={projectId} documents={documents} selectedDocument={selectedDocument} onSelectDocument={selectDocument} initialMode={initialMode} />;
    }
    if (view === "library") return <LibraryWorkspace projectId={projectId} />;
    if (view === "review") return <ReviewWorkspace projectId={projectId} />;
    if (view === "settings") return <Suspense fallback={<div className="novel-studio-loading"><Spin /><span>加载项目设置</span></div>}><SkillCenter projectId={projectId} /></Suspense>;
    return <DashboardView projectId={projectId} onWrite={() => setView("writing")} onAI={() => setAiCollapsed(false)} onWorkflow={() => setView("writing", "workflow")} />;
  }
  const assistantScope = (["dashboard", "planning", "writing", "library", "review", "settings"].includes(view) ? view : "dashboard") as "dashboard" | "planning" | "writing" | "library" | "review" | "settings";
  const assistantDocument = assistantScope === "writing" || assistantScope === "review" ? selectedDocument : undefined;
  const assistantTarget = assistantScope === "planning" ? "当前故事规划" : assistantScope === "library" ? "当前资料库" : assistantScope === "review" ? "当前审校任务" : undefined;
  return <div className="novel-studio">
    <header className="novel-studio-topbar">
      <div className="novel-project-identity">
        <Tooltip title="返回项目中心"><Button className="novel-icon-button" aria-label="返回项目中心" type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate("/novels")} /></Tooltip>
        <Tooltip title="打开导航"><Button className="novel-mobile-menu novel-icon-button" aria-label="打开导航" type="text" icon={<MenuOutlined />} onClick={() => setMobileNav(true)} /></Tooltip>
        <span className="novel-mini-cover" style={{ background: project.coverColor }}>{project.title.slice(0, 1)}</span>
        <div className="novel-project-title"><strong>{project.title}</strong><small>{view === "settings" ? "项目设置" : VIEW_ITEMS.find((item) => item.key === view)?.label ?? "总览"}</small></div>
      </div>
      <div className="novel-topbar-status">
        <span className="novel-save-state"><CloudSyncOutlined /> 本地已保存</span>
        {conflicts > 0 && <Tag color="red">{conflicts} 个同步冲突</Tag>}
        <Tooltip title="项目设置"><Button className="novel-topbar-tool" aria-label="项目设置" type={view === "settings" ? "primary" : "default"} icon={<ToolOutlined />} onClick={() => setView("settings")} /></Tooltip>
        <Dropdown menu={{ items: exportItems }} placement="bottomRight"><Button className="novel-export-button" icon={<ExportOutlined />}>导出 <MoreOutlined /></Button></Dropdown>
      </div>
    </header>
    <div className="novel-studio-body">
      <nav className="novel-workspace-nav" aria-label="创作工作区">
        {groups.map((group) => <section key={group}><span>{group}</span>{VIEW_ITEMS.filter((item) => item.group === group).map((item) => <Tooltip key={item.key} title={item.label} placement="right"><button aria-label={item.label} className={view === item.key ? "active" : ""} onClick={() => setView(item.key)}>{item.icon}<span>{item.label}</span>{item.key === "review" && urgentForeshadowingCount > 0 && <i title={`${urgentForeshadowingCount} 条高紧迫度伏笔需要关注`} />}</button></Tooltip>)}</section>)}
      </nav>
      <main className="novel-workspace-main">{renderView()}</main>
      <Suspense fallback={<button className="novel-ai-collapsed" aria-label="加载 AI 任务中心"><RobotOutlined /><span>AI</span></button>}><AIWorkbench projectId={projectId} document={assistantDocument} scope={assistantScope} targetLabel={assistantTarget} collapsed={aiCollapsed} onToggle={() => setAiCollapsed((value) => !value)} /></Suspense>
    </div>
    <footer className="novel-taskbar"><span><span className="online-dot" /> 数据库在线</span><span>DB v{DB_VERSION}</span><span>修订 {project.revision}</span><span className="spacer" /><span>{documents.reduce((sum, item) => sum + item.wordCount, 0).toLocaleString()} 字</span><span>今日目标 {project.dailyGoal.toLocaleString()}</span></footer>
    <Drawer placement="left" width={280} open={mobileNav} onClose={() => setMobileNav(false)} title={project.title}>{groups.map((group) => <div className="novel-mobile-nav" key={group}><strong>{group}</strong>{VIEW_ITEMS.filter((item) => item.group === group).map((item) => <Button key={item.key} type={view === item.key ? "primary" : "text"} icon={item.icon} onClick={() => setView(item.key)} block>{item.label}</Button>)}</div>)}</Drawer>
  </div>;
}


function WritingWorkspace({ projectId, documents, selectedDocument, onSelectDocument, initialMode }: { projectId: string; documents: ManuscriptDocument[]; selectedDocument?: ManuscriptDocument; onSelectDocument: (id: string) => void; initialMode: "manuscript" | "workflow" }) {
  const { modal } = App.useApp();
  const [mode, setMode] = useState<"manuscript" | "workflow">(initialMode);
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
  const chapterList = <aside className="novel-chapter-list"><header><div><span>章节</span><strong>章节管理</strong><small>{documents.length} 章 · 拖动可排序</small></div><Tooltip title="新增待整理章节"><Button aria-label="新增章节" type="text" icon={<PlusOutlined />} onClick={async () => { const chapter = await createChapter(projectId); onSelectDocument(chapter.id); }} /></Tooltip></header>{documents.map((doc) => <div className={`novel-chapter-row${selectedDocument?.id === doc.id ? " active" : ""}`} key={doc.id} draggable onDragStart={() => setDraggedId(doc.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => void dropChapter(doc.id)}><button onClick={() => onSelectDocument(doc.id)}><span>{String(doc.order + 1).padStart(2, "0")}</span><div><strong>{doc.title}</strong><small>{doc.wordCount.toLocaleString()} 字 · {DOCUMENT_STATUS_LABEL[doc.status]}</small></div></button><div><Tooltip title="上移章节"><Button aria-label="上移章节" type="text" icon={<ArrowUpOutlined />} onClick={() => void moveChapter(doc, -1)} /></Tooltip><Tooltip title="下移章节"><Button aria-label="下移章节" type="text" icon={<ArrowDownOutlined />} onClick={() => void moveChapter(doc, 1)} /></Tooltip><Tooltip title="删除章节"><Button aria-label="删除章节" danger type="text" icon={<DeleteOutlined />} onClick={() => modal.confirm({ title: `删除“${doc.title}”？`, content: "本章场景、正文版本和章节流程将一并删除，所属剧情段会保留。", okButtonProps: { danger: true }, onOk: async () => { if (selectedDocument?.id === doc.id) { onSelectDocument(documents.find((item) => item.id !== doc.id)?.id ?? ""); await new Promise((resolve) => setTimeout(resolve, 0)); } await deleteChapter(doc.id); } })} /></Tooltip></div></div>)}{!documents.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无章节，请在全书规划中建立剧情段与章节" />}</aside>;
  const content = mode === "manuscript" ? <div className="novel-manuscript-with-command"><GenerationComposer projectId={projectId} scope="writing" targetId={selectedDocument?.id} taskKeys={["chapter-draft"]} actionLabel="生成正文草稿" compact /><ChapterEditor document={selectedDocument} onSaved={() => undefined} /></div> : <Suspense fallback={<div className="novel-studio-loading"><Spin /><span>加载章节流程</span></div>}><WorkflowCenter projectId={projectId} document={selectedDocument} /></Suspense>;
  return <div className="novel-writing-workspace"><div className="novel-workspace-tabs"><Segmented value={mode} onChange={(value) => setMode(value as typeof mode)} options={[{ value: "manuscript", label: "正文编辑" }, { value: "workflow", label: "自动流程" }]} /></div><div className="novel-writing-body">{chapterList}{content}</div></div>;
}

function LibraryWorkspace({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<"bible" | "characters" | "relations" | "timeline" | "worldview" | "foreshadowing">("bible");
  return <div className="novel-consolidated-workspace"><div className="novel-workspace-tabs"><Segmented value={mode} onChange={(value) => setMode(value as typeof mode)} options={[{ value: "bible", label: "故事圣经" }, { value: "characters", label: "角色" }, { value: "relations", label: "关系" }, { value: "timeline", label: "时间线" }, { value: "worldview", label: "世界观" }, { value: "foreshadowing", label: "伏笔" }]} /></div>{mode === "foreshadowing" && <GenerationComposer projectId={projectId} scope="foreshadowing" taskKeys={["foreshadowing"]} compact />}{mode === "bible" ? <BibleView projectId={projectId} /> : mode === "characters" ? <CharactersView projectId={projectId} /> : mode === "relations" ? <Suspense fallback={<Spin />}><CharacterCanvasPanel projectId={projectId} /></Suspense> : mode === "timeline" ? <Suspense fallback={<Spin />}><TimelineCanvasPanel projectId={projectId} /></Suspense> : mode === "worldview" ? <WorldviewLibraryPanel projectId={projectId} /> : <ContinuityView projectId={projectId} type={mode} />}</div>;
}

function ReviewWorkspace({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<"analysis" | "threads" | "versions" | "facts">("analysis");
  return <div className="novel-consolidated-workspace"><div className="novel-workspace-tabs"><Segmented value={mode} onChange={(value) => setMode(value as typeof mode)} options={[{ value: "analysis", label: "故事诊断" }, { value: "threads", label: "剧情线" }, { value: "versions", label: "版本历史" }, { value: "facts", label: "事实账本" }]} /></div>{mode !== "versions" && mode !== "facts" && <GenerationComposer projectId={projectId} scope={mode === "threads" ? "threads" : "review"} taskKeys={[mode === "threads" ? "plot-threads" : "review"]} compact />}{mode === "analysis" ? <AnalysisView projectId={projectId} /> : mode === "threads" ? <ContinuityView projectId={projectId} type="threads" /> : mode === "facts" ? <Suspense fallback={<div className="novel-studio-loading"><Spin /><span>加载事实账本</span></div>}><FactLedger projectId={projectId} /></Suspense> : <VersionsView projectId={projectId} />}</div>;
}
