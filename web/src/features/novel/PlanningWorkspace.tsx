import { lazy, Suspense, useMemo, useState } from "react";
import { Empty, Progress, Segmented, Spin, Tag } from "antd";
import { useLiveQuery } from "dexie-react-hooks";

import { novelDb } from "./db";
import GenerationComposer from "./GenerationComposer";

const OutlineDocView = lazy(() => import("./OutlineDocView"));

type PlanningMode = "plan" | "matrix";
type OpenChapterPanel = "manuscript" | "workflow";
export const PLANNING_MODE_OPTIONS: Array<{ value: PlanningMode; label: string }> = [{ value: "plan", label: "全书规划" }, { value: "matrix", label: "章节矩阵" }];

function SectionTitle({ title, description }: { title: string; description: string }) {
  return <header className="novel-section-title"><div><span>STORY PLANNING</span><h2>{title}</h2><p>{description}</p></div></header>;
}

function MatrixView({ projectId }: { projectId: string }) {
  const documents = useLiveQuery(() => novelDb.documents.where("projectId").equals(projectId).sortBy("order"), [projectId]) ?? [];
  const entities = useLiveQuery(() => novelDb.entities.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const threads = useLiveQuery(() => novelDb.plotThreads.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const clues = useLiveQuery(() => novelDb.foreshadowing.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  return <div><GenerationComposer projectId={projectId} scope="review" taskKeys={["story-control"]} compact placeholder="描述希望补齐、调整或检查的剧情线、伏笔与时间线" /><SectionTitle title="章节矩阵" description="以正式章节检查剧情线、角色、伏笔和章节蓝图覆盖。" /><div className="novel-story-matrix"><div className="head"><span>章节</span><span>剧情线</span><span>角色</span><span>伏笔</span><span>覆盖</span></div>{documents.map((document) => {
    const plotThreadIds = document.blueprint.plotThreadIds ?? [];
    const characterIds = document.blueprint.characterIds ?? [];
    const foreshadowingIds = document.blueprint.foreshadowingIds ?? [];
    const coverage = [plotThreadIds.length > 0, characterIds.length > 0, foreshadowingIds.length > 0, Boolean(document.summary && document.blueprint.objective)].filter(Boolean).length * 25;
    return <div key={document.id} className={coverage < 75 ? "warn" : ""}><span><strong>{document.title}</strong><small>{document.summary || "等待补充章节摘要"}</small></span><span>{plotThreadIds.map((id) => <Tag key={id}>{threads.find((item) => item.id === id)?.title ?? "未知"}</Tag>)}</span><span>{characterIds.map((id) => <Tag key={id}>{entities.find((item) => item.id === id)?.name ?? "未知"}</Tag>)}</span><span>{foreshadowingIds.map((id) => <Tag key={id}>{clues.find((item) => item.id === id)?.title ?? "未知"}</Tag>)}</span><span><Progress percent={coverage} size="small" status={coverage < 75 ? "exception" : "success"} /></span></div>;
  })}</div>{!documents.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="建立章节后即可查看章节矩阵" />}</div>;
}

const LAZY_FALLBACK = <div className="novel-studio-loading"><Spin /><span>加载中</span></div>;

export default function PlanningWorkspace({ projectId, onOpenChapter }: { projectId: string; onOpenChapter: (documentId: string, panel: OpenChapterPanel) => void }) {
  const [mode, setMode] = useState<PlanningMode>("plan");
  const content = useMemo(() => mode === "matrix"
    ? <MatrixView projectId={projectId} />
    : <Suspense fallback={LAZY_FALLBACK}><OutlineDocView projectId={projectId} onOpenChapter={onOpenChapter} /></Suspense>, [mode, onOpenChapter, projectId]);
  return <div className="novel-planning-workspace"><div className="novel-workspace-tabs"><Segmented value={mode} onChange={(value) => setMode(value as PlanningMode)} options={PLANNING_MODE_OPTIONS} /></div><div className="novel-planning-content">{content}</div></div>;
}
