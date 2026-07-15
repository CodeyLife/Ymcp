import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { App, Button, Empty, Progress, Segmented, Spin, Tag } from "antd";
import { SaveOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import { ensureStoryArchitecture, novelDb, saveStoryArchitecture } from "./db";
import GenerationComposer from "./GenerationComposer";
import ArchitectureDataEditor from "./ArchitectureDataEditor";
import type { StoryArchitecture } from "./types";

const OutlineDocView = lazy(() => import("./OutlineDocView"));

type PlanningMode = "architecture" | "outline" | "matrix";

function SectionTitle({ title, description, action, eyebrow = "STORY PLANNING" }: { title: string; description: string; action?: React.ReactNode; eyebrow?: string }) {
  return <header className="novel-section-title"><div>{eyebrow && <span>{eyebrow}</span>}<h2>{title}</h2><p>{description}</p></div>{action}</header>;
}

function ArchitectureView({ projectId }: { projectId: string }) {
  const { message } = App.useApp();
  const saved = useLiveQuery(() => novelDb.architectures.where("projectId").equals(projectId).first(), [projectId]);
  const [draft, setDraft] = useState<StoryArchitecture>();
  useEffect(() => { if (saved) setDraft(saved); else if (saved === undefined) void ensureStoryArchitecture(projectId); }, [projectId, saved]);
  if (!draft) return <Empty description="正在建立全书架构" />;
  return <div className="novel-architecture-view">
    <SectionTitle eyebrow="" title="全书架构" description="定义核心问题、核心冲突与宏观阶段，具体故事事件在大纲中展开。" action={<Button className="novel-architecture-save" icon={<SaveOutlined />} onClick={async () => { await saveStoryArchitecture(draft); message.success("全书架构已保存"); }}>保存架构</Button>} />
    <GenerationComposer projectId={projectId} scope="architecture" taskKeys={["architecture"]} actionLabel="生成架构方案" getRefinementSnapshot={() => ({ architectures: [draft as unknown as Record<string, unknown>] })} />
    <ArchitectureDataEditor value={draft} onChange={(next) => setDraft({ ...draft, ...next })} />
  </div>;
}

function MatrixView({ projectId }: { projectId: string }) {
  const nodes = useLiveQuery(() => novelDb.outlineNodes.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const entities = useLiveQuery(() => novelDb.entities.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const threads = useLiveQuery(() => novelDb.plotThreads.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const clues = useLiveQuery(() => novelDb.foreshadowing.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const events = nodes.filter((item) => item.kind === "event").sort((a, b) => a.order - b.order);
  return <div><GenerationComposer projectId={projectId} scope="review" taskKeys={["story-control"]} compact placeholder="描述希望补齐、调整或检查的剧情线、伏笔与时间线" /><SectionTitle title="剧情矩阵" description="以故事事件检查剧情线、角色、伏笔和因果覆盖，不映射章节。" /><div className="novel-story-matrix"><div className="head"><span>故事事件</span><span>剧情线</span><span>角色</span><span>伏笔</span><span>覆盖</span></div>{events.map((event) => {
    const coverage = [event.plotThreadIds.length > 0, event.characterIds.length > 0, event.foreshadowingIds.length > 0, Boolean(event.summary)].filter(Boolean).length * 25;
    return <div key={event.id} className={coverage < 75 ? "warn" : ""}><span><strong>{event.title}</strong><small>{event.summary || "等待补充"}</small></span><span>{event.plotThreadIds.map((id) => <Tag key={id}>{threads.find((item) => item.id === id)?.title ?? "未知"}</Tag>)}</span><span>{event.characterIds.map((id) => <Tag key={id}>{entities.find((item) => item.id === id)?.name ?? "未知"}</Tag>)}</span><span>{event.foreshadowingIds.map((id) => <Tag key={id}>{clues.find((item) => item.id === id)?.title ?? "未知"}</Tag>)}</span><span><Progress percent={coverage} size="small" status={coverage < 75 ? "exception" : "success"} /></span></div>;
  })}</div>{!events.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="建立事件节点后即可查看剧情矩阵" />}</div>;
}

const LAZY_FALLBACK = <div className="novel-studio-loading"><Spin /><span>加载中</span></div>;

export default function PlanningWorkspace({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<PlanningMode>("architecture");
  const content = useMemo(() => {
    if (mode === "architecture") return <ArchitectureView projectId={projectId} />;
    if (mode === "matrix") return <MatrixView projectId={projectId} />;
    return <Suspense fallback={LAZY_FALLBACK}><OutlineDocView projectId={projectId} /></Suspense>;
  }, [mode, projectId]);
  return <div className="novel-planning-workspace"><div className="novel-workspace-tabs"><Segmented value={mode} onChange={(value) => setMode(value as PlanningMode)} options={[{ value: "architecture", label: "全书架构" }, { value: "outline", label: "故事大纲" }, { value: "matrix", label: "剧情矩阵" }]} /></div><div className="novel-planning-content">{content}</div></div>;
}
