import { useEffect, useMemo, useState } from "react";
import { App, Button, Empty, Input, InputNumber, Progress, Segmented, Select, Tag } from "antd";
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import { motion } from "motion/react";
import { addOutlineNode, appendOperation, deleteOutlineBranch, ensureStoryArchitecture, novelDb, saveStoryArchitecture } from "./db";
import GenerationComposer from "./GenerationComposer";
import type { ArchitecturePhase, OutlineKind, OutlineNode, StoryArchitecture } from "./types";

type PlanningMode = "architecture" | "outline" | "matrix";

const KIND_LABEL: Record<OutlineKind, string> = { act: "幕", sequence: "序列", event: "事件" };

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
    <SectionTitle title="全书架构" description="只定义全书承诺、核心冲突和宏观阶段；具体故事事件在大纲中展开。" action={<Button type="primary" icon={<SaveOutlined />} onClick={async () => { await saveStoryArchitecture(draft); message.success("全书架构已保存"); }}>保存架构</Button>} />
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

function TreeNode({ node, nodes, selectedId, onSelect }: { node: OutlineNode; nodes: OutlineNode[]; selectedId?: string; onSelect: (id: string) => void }) {
  const children = nodes.filter((item) => item.parentId === node.id).sort((a, b) => a.order - b.order);
  return <div className="novel-tree-node"><button className={selectedId === node.id ? "active" : ""} onClick={() => onSelect(node.id)}><span>{KIND_LABEL[node.kind]}</span><strong>{node.title}</strong><small>{node.status}</small></button>{children.length > 0 && <div>{children.map((child) => <TreeNode key={child.id} node={child} nodes={nodes} selectedId={selectedId} onSelect={onSelect} />)}</div>}</div>;
}

function OutlineView({ projectId }: { projectId: string }) {
  const { modal, message } = App.useApp();
  const nodes = useLiveQuery(() => novelDb.outlineNodes.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const entities = useLiveQuery(() => novelDb.entities.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const threads = useLiveQuery(() => novelDb.plotThreads.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const clues = useLiveQuery(() => novelDb.foreshadowing.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const [selectedId, setSelectedId] = useState<string>();
  const selected = nodes.find((item) => item.id === selectedId);
  const roots = nodes.filter((item) => !item.parentId).sort((a, b) => a.order - b.order);

  async function addNode(kind: OutlineKind) {
    let parentId: string | undefined;
    if (kind === "sequence") parentId = selected?.kind === "act" ? selected.id : selected?.parentId || roots[0]?.id;
    if (kind === "event") parentId = selected?.kind === "sequence" ? selected.id : selected?.kind === "act" ? selected.id : selected?.parentId;
    if (kind !== "act" && !parentId) { message.warning("请先建立或选择上层大纲节点"); return; }
    const siblings = nodes.filter((item) => item.parentId === parentId && item.kind === kind);
    const title = kind === "act" ? `第${siblings.length + 1}幕` : kind === "sequence" ? `序列 ${siblings.length + 1}` : `事件 ${siblings.length + 1}`;
    const node = await addOutlineNode(projectId, parentId, kind, title, siblings.length);
    setSelectedId(node.id);
  }

  async function updateNode(changes: Partial<OutlineNode>) {
    if (!selected) return;
    const next = { ...selected, ...changes, revision: selected.revision + 1, updatedAt: Date.now() };
    await novelDb.outlineNodes.put(next);
    await appendOperation(projectId, "outlineNodes", selected.id, "update", { value: { before: selected, after: next } });
  }

  async function moveNode(direction: -1 | 1) {
    if (!selected) return;
    const siblings = nodes.filter((item) => item.parentId === selected.parentId && item.kind === selected.kind).sort((a, b) => a.order - b.order);
    const index = siblings.findIndex((item) => item.id === selected.id);
    const target = siblings[index + direction];
    if (!target) return;
    await novelDb.outlineNodes.bulkPut([{ ...selected, order: target.order, revision: selected.revision + 1, updatedAt: Date.now() }, { ...target, order: selected.order, revision: target.revision + 1, updatedAt: Date.now() }]);
  }

  async function deleteNode() {
    if (!selected) return;
    await deleteOutlineBranch(projectId, selected.id);
    setSelectedId(undefined);
  }

  return <div>
    <GenerationComposer projectId={projectId} scope="outline" taskKeys={["outline"]} />
    <SectionTitle title="故事大纲" description="按幕、序列和事件组织故事因果；这里不创建章节，也不持有正文。" action={<div className="novel-outline-actions"><Button icon={<PlusOutlined />} onClick={() => void addNode("act")}>幕</Button><Button icon={<PlusOutlined />} onClick={() => void addNode("sequence")}>序列</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => void addNode("event")}>事件</Button></div>} />
    <div className="novel-structure-layout"><aside className="novel-structure-tree">{roots.length ? roots.map((node) => <TreeNode key={node.id} node={node} nodes={nodes} selectedId={selectedId} onSelect={setSelectedId} />) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未建立故事大纲" />}</aside>
      <main className="novel-structure-detail">{selected ? <><div className="novel-structure-heading"><Tag>{KIND_LABEL[selected.kind]}</Tag><div className="novel-row-actions"><Button type="text" icon={<ArrowUpOutlined />} onClick={() => void moveNode(-1)} /><Button type="text" icon={<ArrowDownOutlined />} onClick={() => void moveNode(1)} /><Button danger type="text" icon={<DeleteOutlined />} onClick={() => modal.confirm({ title: `删除“${selected.title}”？`, content: "只删除该大纲节点及其子节点，不会删除任何章节或正文。", okButtonProps: { danger: true }, onOk: deleteNode })} /><Select value={selected.status} onChange={(status) => void updateNode({ status })} options={[{ value: "idea", label: "构思" }, { value: "planned", label: "已规划" }, { value: "resolved", label: "已完成" }]} /></div></div>
        <Input value={selected.title} onChange={(event) => void updateNode({ title: event.target.value })} />
        <Input.TextArea rows={4} value={selected.summary} placeholder="这一故事节点发生什么" onChange={(event) => void updateNode({ summary: event.target.value })} />
        <Input.TextArea rows={2} value={selected.causality} placeholder="它为什么发生，与前序事件有何因果关系" onChange={(event) => void updateNode({ causality: event.target.value })} />
        <Input.TextArea rows={2} value={selected.outcome} placeholder="它造成什么不可逆结果" onChange={(event) => void updateNode({ outcome: event.target.value })} />
        <div className="novel-form-grid"><Select mode="multiple" placeholder="关联角色" value={selected.characterIds} options={entities.filter((item) => item.kind === "character").map((item) => ({ value: item.id, label: item.name }))} onChange={(characterIds) => void updateNode({ characterIds })} /><Select mode="multiple" placeholder="剧情线" value={selected.plotThreadIds} options={threads.map((item) => ({ value: item.id, label: item.title }))} onChange={(plotThreadIds) => void updateNode({ plotThreadIds })} /><Select mode="multiple" placeholder="伏笔" value={selected.foreshadowingIds} options={clues.map((item) => ({ value: item.id, label: item.title }))} onChange={(foreshadowingIds) => void updateNode({ foreshadowingIds })} /><Input placeholder="故事时间" value={selected.storyTime} onChange={(event) => void updateNode({ storyTime: event.target.value })} /></div>
        <div className="novel-intensity-row"><label>张力<InputNumber min={0} max={100} value={selected.tension} onChange={(value) => void updateNode({ tension: value ?? 0 })} /></label><label>情绪<InputNumber min={0} max={100} value={selected.emotion} onChange={(value) => void updateNode({ emotion: value ?? 0 })} /></label><label>信息<InputNumber min={0} max={100} value={selected.information} onChange={(value) => void updateNode({ information: value ?? 0 })} /></label></div>
      </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择一个故事节点进行规划" />}</main></div>
  </div>;
}

function MatrixView({ projectId }: { projectId: string }) {
  const nodes = useLiveQuery(() => novelDb.outlineNodes.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const entities = useLiveQuery(() => novelDb.entities.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const threads = useLiveQuery(() => novelDb.plotThreads.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const clues = useLiveQuery(() => novelDb.foreshadowing.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const events = nodes.filter((item) => item.kind === "event").sort((a, b) => a.order - b.order);
  return <div><GenerationComposer projectId={projectId} scope="review" taskKeys={["story-control"]} compact placeholder="描述希望补齐、调整或检查的剧情线、伏笔与时间线" /><SectionTitle title="剧情矩阵" description="以故事事件检查剧情线、角色、伏笔、时间和因果覆盖，不映射章节。" /><div className="novel-story-matrix"><div className="head"><span>故事事件</span><span>剧情线</span><span>角色</span><span>伏笔</span><span>故事时间</span><span>覆盖</span></div>{events.map((event) => {
    const coverage = [event.plotThreadIds.length > 0, event.characterIds.length > 0, event.foreshadowingIds.length > 0, Boolean(event.causality && event.outcome)].filter(Boolean).length * 25;
    return <div key={event.id} className={coverage < 75 ? "warn" : ""}><span><strong>{event.title}</strong><small>{event.summary || "等待补充"}</small></span><span>{event.plotThreadIds.map((id) => <Tag key={id}>{threads.find((item) => item.id === id)?.title ?? "未知"}</Tag>)}</span><span>{event.characterIds.map((id) => <Tag key={id}>{entities.find((item) => item.id === id)?.name ?? "未知"}</Tag>)}</span><span>{event.foreshadowingIds.map((id) => <Tag key={id}>{clues.find((item) => item.id === id)?.title ?? "未知"}</Tag>)}</span><span>{event.storyTime || "未设置"}</span><span><Progress percent={coverage} size="small" status={coverage < 75 ? "exception" : "success"} /></span></div>;
  })}</div>{!events.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="建立事件节点后即可查看剧情矩阵" />}</div>;
}

export default function PlanningWorkspace({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<PlanningMode>("architecture");
  const content = useMemo(() => mode === "architecture" ? <ArchitectureView projectId={projectId} /> : mode === "outline" ? <OutlineView projectId={projectId} /> : <MatrixView projectId={projectId} />, [mode, projectId]);
  return <div className="novel-view-content novel-planning-workspace"><div className="novel-workspace-tabs"><Segmented value={mode} onChange={(value) => setMode(value as PlanningMode)} options={[{ value: "architecture", label: "全书架构" }, { value: "outline", label: "故事大纲" }, { value: "matrix", label: "剧情矩阵" }]} /></div>{content}</div>;
}
