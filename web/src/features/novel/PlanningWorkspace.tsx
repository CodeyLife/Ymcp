import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { App, Button, Empty, Input, Progress, Segmented, Select, Spin, Tag } from "antd";
import { DeleteOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import { motion } from "motion/react";
import { ensureStoryArchitecture, novelDb, saveStoryArchitecture } from "./db";
import GenerationComposer from "./GenerationComposer";
import type { ArchitecturePhase, StoryArchitecture } from "./types";

const PlanningCanvasPanel = lazy(() => import("./canvas/PlanningCanvasPanel").then((m) => ({ default: m.PlanningCanvasPanel })));
const OutlineDocView = lazy(() => import("./OutlineDocView"));

type PlanningMode = "architecture" | "outline" | "matrix" | "board";

function SectionTitle({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <header className="novel-section-title"><div><span>STORY PLANNING</span><h2>{title}</h2><p>{description}</p></div>{action}</header>;
}

function ArchitectureView({ projectId }: { projectId: string }) {
  const { message } = App.useApp();
  const saved = useLiveQuery(() => novelDb.architectures.where("projectId").equals(projectId).first(), [projectId]);
  const [draft, setDraft] = useState<StoryArchitecture>();
  useEffect(() => { if (saved) setDraft(saved); else if (saved === undefined) void ensureStoryArchitecture(projectId); }, [projectId, saved]);
  if (!draft) return <Empty description="正在建立全书架构" />;
  const updatePhase = (id: string, changes: Partial<ArchitecturePhase>) => setDraft({ ...draft, phases: draft.phases.map((item) => item.id === id ? { ...item, ...changes } : item) });
  return <div>
    <GenerationComposer projectId={projectId} scope="architecture" taskKeys={["architecture"]} />
    <SectionTitle title="全书架构" description="只定义全书承诺、核心冲突和宏观阶段; 具体故事事件在大纲中展开。" action={<Button type="primary" icon={<SaveOutlined />} onClick={async () => { await saveStoryArchitecture(draft); message.success("全书架构已保存"); }}>保存架构</Button>} />
    <div className="novel-architecture-form">
      <section><label>结构方法<Select value={draft.framework} options={[{ value: "free", label: "自由结构" }, { value: "three-act", label: "三幕式" }, { value: "four-part", label: "起承转合" }, { value: "save-the-cat", label: "Save the Cat" }, { value: "snowflake", label: "雪花写作法" }]} onChange={(framework) => setDraft({ ...draft, framework })} /></label><label>状态<Select value={draft.status} options={[{ value: "draft", label: "草案" }, { value: "approved", label: "已批准" }]} onChange={(status) => setDraft({ ...draft, status })} /></label></section>
      <label>核心问题<Input value={draft.centralQuestion} onChange={(event) => setDraft({ ...draft, centralQuestion: event.target.value })} /></label>
      <label>核心冲突<Input.TextArea rows={2} value={draft.centralConflict} onChange={(event) => setDraft({ ...draft, centralConflict: event.target.value })} /></label>
      <label>读者承诺<Input.TextArea rows={2} value={draft.readerPromise} onChange={(event) => setDraft({ ...draft, readerPromise: event.target.value })} /></label>
      <label>全书梗概<Input.TextArea rows={6} value={draft.synopsis} onChange={(event) => setDraft({ ...draft, synopsis: event.target.value })} /></label>
    </div>
    <section className="novel-architecture-beats"><header><div><span>MACRO PHASES</span><h3>宏观阶段</h3></div><Button icon={<PlusOutlined />} onClick={() => setDraft({ ...draft, phases: [...draft.phases, { id: crypto.randomUUID(), title: `阶段 ${draft.phases.length + 1}`, purpose: "", turningPoint: "", order: draft.phases.length, locked: false }] })}>添加阶段</Button></header>
      {draft.phases.map((phase, index) => <motion.article layout key={phase.id}><i>{String(index + 1).padStart(2, "0")}</i><div><Input value={phase.title} onChange={(event) => updatePhase(phase.id, { title: event.target.value })} /><Input.TextArea rows={2} placeholder="本阶段必须完成的叙事使命" value={phase.purpose} onChange={(event) => updatePhase(phase.id, { purpose: event.target.value })} /><Input placeholder="结束时的不可逆转折" value={phase.turningPoint} onChange={(event) => updatePhase(phase.id, { turningPoint: event.target.value })} /></div><Button danger type="text" icon={<DeleteOutlined />} onClick={() => setDraft({ ...draft, phases: draft.phases.filter((item) => item.id !== phase.id).map((item, order) => ({ ...item, order })) })} /></motion.article>)}
    </section>
  </div>;
}

function MatrixView({ projectId }: { projectId: string }) {
  const nodes = useLiveQuery(() => novelDb.outlineNodes.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const entities = useLiveQuery(() => novelDb.entities.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const threads = useLiveQuery(() => novelDb.plotThreads.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const clues = useLiveQuery(() => novelDb.foreshadowing.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const events = nodes.filter((item) => item.kind === "event").sort((a, b) => a.order - b.order);
  return <div><GenerationComposer projectId={projectId} scope="review" taskKeys={["story-control"]} compact placeholder="描述希望补齐、调整或检查的剧情线、伏笔与时间线" /><SectionTitle title="剧情矩阵" description="以故事事件检查剧情线、角色、伏笔、时间和因果覆盖, 不映射章节。" /><div className="novel-story-matrix"><div className="head"><span>故事事件</span><span>剧情线</span><span>角色</span><span>伏笔</span><span>故事时间</span><span>覆盖</span></div>{events.map((event) => {
    const coverage = [event.plotThreadIds.length > 0, event.characterIds.length > 0, event.foreshadowingIds.length > 0, Boolean(event.causality && event.outcome)].filter(Boolean).length * 25;
    return <div key={event.id} className={coverage < 75 ? "warn" : ""}><span><strong>{event.title}</strong><small>{event.summary || "等待补充"}</small></span><span>{event.plotThreadIds.map((id) => <Tag key={id}>{threads.find((item) => item.id === id)?.title ?? "未知"}</Tag>)}</span><span>{event.characterIds.map((id) => <Tag key={id}>{entities.find((item) => item.id === id)?.name ?? "未知"}</Tag>)}</span><span>{event.foreshadowingIds.map((id) => <Tag key={id}>{clues.find((item) => item.id === id)?.title ?? "未知"}</Tag>)}</span><span>{event.storyTime || "未设置"}</span><span><Progress percent={coverage} size="small" status={coverage < 75 ? "exception" : "success"} /></span></div>;
  })}</div>{!events.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="建立事件节点后即可查看剧情矩阵" />}</div>;
}

const LAZY_FALLBACK = <div className="novel-studio-loading"><Spin /><span>加载中</span></div>;

export default function PlanningWorkspace({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<PlanningMode>("architecture");
  const content = useMemo(() => {
    if (mode === "architecture") return <ArchitectureView projectId={projectId} />;
    if (mode === "matrix") return <MatrixView projectId={projectId} />;
    if (mode === "outline") return <Suspense fallback={LAZY_FALLBACK}><OutlineDocView projectId={projectId} /></Suspense>;
    return <Suspense fallback={LAZY_FALLBACK}><PlanningCanvasPanel projectId={projectId} /></Suspense>;
  }, [mode, projectId]);
  return <div className="novel-view-content novel-planning-workspace"><div className="novel-workspace-tabs"><Segmented value={mode} onChange={(value) => setMode(value as PlanningMode)} options={[{ value: "architecture", label: "全书架构" }, { value: "outline", label: "故事大纲" }, { value: "matrix", label: "剧情矩阵" }, { value: "board", label: "策划画布" }]} /></div>{content}</div>;
}
