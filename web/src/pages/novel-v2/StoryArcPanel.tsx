import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Modal, Popconfirm, Segmented, Space, Spin, Tag, message } from "antd";
import { ArrowDownOutlined, ArrowUpOutlined, CheckOutlined, DeleteOutlined, EditOutlined, FileAddOutlined, PlusOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import { motion } from "motion/react";

type Scene = { title: string; summary: string; goal?: string; participants: string[]; turn?: string; outcome?: string };
type Chapter = { id?: string; index: number; globalOrder?: number; documentId?: string; title: string; summary: string; chapterPurpose: string; dramaticQuestion: string; povCharacterId?: string; emotionalMovement: string; stateDeltaBudget: string; optionalBeats: string[]; scenes: Scene[]; continuityConstraints: string[]; setupRefs: string[]; payoffRefs: string[]; closingForce: string; freedom: string };
type ArcPlan = { title: string; objective: string; entryState: string; centralConflict: string; development: string[]; resolution: string; exitState: string; plotThreadRefs: string[]; foreshadowingRefs: string[]; expectedChapterCount: number; phases: Array<{ title: string; objective: string; exitCondition: string }>; authorIntent?: string };
type StoryArcBatch = { id: string; batchIndex: number; startChapterIndex: number; endChapterIndex: number; complete: boolean; status: "generating" | "awaiting-review" | "approved" | "failed"; entryFingerprint: string; sourceArtifactId?: string; approvedAt?: string };
type StoryArc = { id: string; ordinal: number; planningStatus: "generating" | "awaiting-review" | "approved" | "stale" | "failed"; executionStatus: "planned" | "active" | "completed" | "abandoned"; arc: ArcPlan; chapters: Chapter[]; batches: StoryArcBatch[]; sourceArtifactId?: string; blueprintArtifactId?: string; contextFingerprint?: string; editRevision: number; updatedAt: string };
type ApprovalPreview = { creates: Array<{ chapterId: string; index: number; title: string }>; updates: Array<{ chapterId: string; documentId: string; index: number; title: string }>; conflicts: Array<{ chapterId: string; documentId: string; index: number; title: string; reason: string }>; artifactId: string };

const PLAN_LABEL: Record<StoryArc["planningStatus"], string> = { generating: "生成中", "awaiting-review": "待整弧审核", approved: "已批准", stale: "需重基线", failed: "需人工处理" };
const EXEC_LABEL: Record<StoryArc["executionStatus"], string> = { planned: "未开始", active: "创作中", completed: "已完成", abandoned: "已放弃" };
const csv = (value: string) => value.split(/[，,\n]/u).map((item) => item.trim()).filter(Boolean);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function editableBatch(arc: StoryArc): StoryArc {
  const copy = clone(arc);
  const batch = copy.batches.find((item) => item.status === "awaiting-review") ?? copy.batches.at(-1);
  return batch ? { ...copy, chapters: copy.chapters.filter((chapter) => chapter.index >= batch.startChapterIndex && chapter.index <= batch.endChapterIndex) } : copy;
}
function currentEditableBatch(arc: StoryArc): StoryArcBatch | undefined {
  return arc.batches.find((item) => item.status === "awaiting-review") ?? arc.batches.at(-1);
}
function arcCanBeEdited(arc: StoryArc): boolean {
  return arc.planningStatus !== "generating" && !["completed", "abandoned"].includes(arc.executionStatus);
}
function arcCanBeDeleted(arc: StoryArc): boolean {
  return arc.planningStatus !== "generating" || arc.executionStatus === "abandoned";
}

async function readJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
  return body as T;
}

export default function StoryArcPanel({ projectId, onApplied }: { projectId: string; onApplied?: () => void }) {
  const [arcs, setArcs] = useState<StoryArc[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [intentOpen, setIntentOpen] = useState(false);
  const [authorIntent, setAuthorIntent] = useState("");
  const [reviewPolicy, setReviewPolicy] = useState<"manual" | "auto">("manual");
  const [editArc, setEditArc] = useState<StoryArc>();
  const [preview, setPreview] = useState<ApprovalPreview>();
  const [abandonReason, setAbandonReason] = useState("");
  const [abandonOpen, setAbandonOpen] = useState(false);

  const selected = useMemo(() => arcs.find((arc) => arc.id === selectedId) ?? arcs.at(-1), [arcs, selectedId]);

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const body = await readJson<{ arcs: StoryArc[] }>(`/v2/projects/${encodeURIComponent(projectId)}/story-arcs`);
      setArcs(body.arcs);
      setSelectedId((current) => current && body.arcs.some((arc) => arc.id === current) ? current : body.arcs.at(-1)?.id);
    } catch (error) { if (!silent) message.error(error instanceof Error ? error.message : String(error)); }
    finally { if (!silent) setLoading(false); }
  }

  useEffect(() => { void load(); }, [projectId]);
  useEffect(() => {
    if (!arcs.some((arc) => arc.planningStatus === "generating")) return;
    const timer = window.setInterval(() => void load(true), 2500);
    return () => window.clearInterval(timer);
  }, [arcs]);

  async function action(key: string, work: () => Promise<void>) {
    setBusy(key);
    try { await work(); await load(true); }
    catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(undefined); }
  }

  async function startNext() {
    await action("next", async () => {
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}/story-arcs/next`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authorIntent: authorIntent.trim() || undefined, reviewPolicy }) });
      setIntentOpen(false); setAuthorIntent(""); message.success("故事弧规划已启动");
    });
  }

  async function startNextBatch() {
    if (!selected) return;
    await action("next-batch", async () => {
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}/story-arcs/${encodeURIComponent(selected.id)}/batches/next`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewPolicy }) });
      message.success("下一批章节蓝图已启动");
    });
  }

  async function saveEdit() {
    if (!editArc) return;
    await action("edit", async () => {
      const batch = editArc.batches.find((item) => item.status === "awaiting-review") ?? editArc.batches.at(-1);
      if (!batch) throw new Error("当前故事弧没有可编辑批次");
      const chapters = editArc.chapters.map((chapter, index) => ({ ...chapter, index: index + 1 }));
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}/story-arcs/${encodeURIComponent(editArc.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle: { arc: editArc.arc, batch: { batchIndex: batch.batchIndex, startChapterIndex: batch.startChapterIndex, complete: batch.complete }, chapters } }) });
      setEditArc(undefined); message.success(`第 ${batch.batchIndex} 批蓝图已保存，需重新审核`);
    });
  }

  async function previewApproval() {
    if (!selected) return;
    await action("preview", async () => {
      const body = await readJson<{ preview: ApprovalPreview }>(`/v2/projects/${encodeURIComponent(projectId)}/story-arcs/${encodeURIComponent(selected.id)}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: false }) });
      setPreview(body.preview);
    });
  }

  async function confirmApproval() {
    if (!selected) return;
    await action("approve", async () => {
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}/story-arcs/${encodeURIComponent(selected.id)}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
      setPreview(undefined); onApplied?.(); message.success("故事弧已批准并应用为章节目标");
    });
  }

  async function rebase() {
    if (!selected) return;
    await action("rebase", async () => {
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}/story-arcs/${encodeURIComponent(selected.id)}/rebase`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authorIntent: authorIntent.trim() || selected.arc.authorIntent, reviewPolicy }) });
      setIntentOpen(false); message.success("已按当前宏观规划重建章节蓝图");
    });
  }

  async function abandon() {
    if (!selected || !abandonReason.trim()) return;
    await action("abandon", async () => {
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}/story-arcs/${encodeURIComponent(selected.id)}/abandon`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: abandonReason }) });
      setAbandonOpen(false); setAbandonReason(""); message.success("故事弧已放弃，下一故事弧现已开放");
    });
  }

  async function deleteArc(force = false) {
    if (!selected) return;
    await action(force ? "force-delete" : "delete", async () => {
      const deleteUrl = "/v2/projects/" + encodeURIComponent(projectId) + "/story-arcs/" + encodeURIComponent(selected.id) + (force ? "?force=true" : "");
      await readJson(deleteUrl, { method: "DELETE", headers: { "content-type": "application/json", ...(force ? { "x-force-delete": "true" } : {}) }, body: JSON.stringify(force ? { force: true } : {}) });
      setEditArc(undefined); setPreview(undefined); message.success(force ? "故事弧及关联章节记忆已强制删除" : "故事弧已删除");
    });
  }

  function updateChapter(index: number, changes: Partial<Chapter>) {
    setEditArc((current) => current ? { ...current, chapters: current.chapters.map((chapter, at) => at === index ? { ...chapter, ...changes } : chapter) } : current);
  }
  function moveChapter(index: number, delta: number) {
    setEditArc((current) => {
      if (!current) return current;
      const target = index + delta;
      if (target < 0 || target >= current.chapters.length) return current;
      const chapters = [...current.chapters]; [chapters[index], chapters[target]] = [chapters[target], chapters[index]];
      return { ...current, chapters };
    });
  }
  function addChapter() {
    setEditArc((current) => current ? { ...current, chapters: [...current.chapters, { index: Math.max(0, ...current.chapters.map((chapter) => chapter.index)) + 1, title: "新章节", summary: "", chapterPurpose: "", dramaticQuestion: "", emotionalMovement: "", stateDeltaBudget: "", optionalBeats: [], scenes: [], continuityConstraints: [], setupRefs: [], payoffRefs: [], closingForce: "", freedom: "允许在章节功能和连续性约束内自由组织场景。" }] } : current);
  }
  function updateArc(changes: Partial<ArcPlan>) {
    setEditArc((current) => current ? { ...current, arc: { ...current.arc, ...changes } } : current);
  }
  function updatePhase(index: number, changes: Partial<ArcPlan["phases"][number]>) {
    setEditArc((current) => current ? { ...current, arc: { ...current.arc, phases: current.arc.phases.map((phase, at) => at === index ? { ...phase, ...changes } : phase) } } : current);
  }

  if (loading) return <div className="novel-plan-loading"><Spin /></div>;
  if (!arcs.length) return <motion.section className="novel-plan-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><div className="novel-plan-empty-mark"><FileAddOutlined /></div><h2>规划第一个故事弧</h2><p>卷负责长篇分区，故事弧负责阶段推进；每次只展开由叙事密度决定的一批连续章节蓝图。</p><Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setIntentOpen(true)}>生成故事弧</Button><Modal title="本弧创作意图" open={intentOpen} onCancel={() => setIntentOpen(false)} onOk={() => void startNext()} confirmLoading={busy === "next"} okText="开始生成"><Space direction="vertical" size={12} style={{ width: "100%" }}><Segmented block value={reviewPolicy} onChange={(value) => setReviewPolicy(value as "manual" | "auto")} options={[{ label: "人工审核", value: "manual" }, { label: "自动审校修订", value: "auto" }]} /><Input.TextArea value={authorIntent} onChange={(event) => setAuthorIntent(event.target.value)} autoSize={{ minRows: 4, maxRows: 8 }} placeholder="可选：本弧想重点探索的冲突、关系或氛围" /></Space></Modal></motion.section>;
  if (!selected) return null;
  const latestBatch = selected.batches.at(-1);
  const selectedEditableBatch = currentEditableBatch(selected);
  const canEditSelected = arcCanBeEdited(selected) && Boolean(selectedEditableBatch);
  const canDeleteSelected = arcCanBeDeleted(selected);
  const editBatch = editArc ? currentEditableBatch(editArc) : undefined;
  const canEditArcBoundary = !editBatch || editBatch.batchIndex === 1;

  return <motion.section className="novel-arc-workspace" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
    <aside className="novel-arc-rail">
      <header><strong>顺序故事弧</strong><Button size="small" type="primary" icon={<PlusOutlined />} disabled={selected.executionStatus !== "completed" && selected.executionStatus !== "abandoned"} onClick={() => setIntentOpen(true)}>下一弧</Button></header>
      {arcs.map((arc) => <button key={arc.id} className={`novel-arc-nav ${selected.id === arc.id ? "is-active" : ""}`} onClick={() => setSelectedId(arc.id)}><span>{String(arc.ordinal).padStart(2, "0")}</span><strong>{arc.arc.title}</strong><small>{PLAN_LABEL[arc.planningStatus]} · {EXEC_LABEL[arc.executionStatus]}</small></button>)}
    </aside>
    <main className="novel-arc-reader">
      <header className="novel-plan-reader-head"><div><span className="novel-eyebrow">故事弧 {selected.ordinal}</span><h2>{selected.arc.title}</h2></div><Space wrap><Tag>{PLAN_LABEL[selected.planningStatus]}</Tag><Tag>{EXEC_LABEL[selected.executionStatus]}</Tag>{selected.batches.map((batch) => <Tag key={batch.id}>批次 {batch.batchIndex} · {batch.status}</Tag>)}</Space></header>
      {selected.planningStatus === "stale" && <Alert showIcon type="warning" message="宏观规划已变化，后续章节生成已阻止。请重基线章节蓝图以匹配当前宏观规划。" />}
      {selected.planningStatus === "failed" && <Alert showIcon type="error" message="自动审核/修订未能通过，需作者编辑或重基线后再确认。" />}
      <section className="novel-arc-summary"><p>{selected.arc.objective}</p><dl><dt>入场状态</dt><dd>{selected.arc.entryState}</dd><dt>核心冲突</dt><dd>{selected.arc.centralConflict}</dd><dt>发展路径</dt><dd>{selected.arc.development.join(" → ")}</dd><dt>收束方式</dt><dd>{selected.arc.resolution}</dd><dt>离场状态</dt><dd>{selected.arc.exitState}</dd></dl></section>
      <div className="novel-arc-chapters">{selected.chapters.map((chapter) => <article key={chapter.id ?? chapter.index}><header><span>{String(chapter.globalOrder ?? chapter.index).padStart(2, "0")}</span><div><h3>{chapter.title}</h3><p>{chapter.summary}</p></div>{chapter.documentId && <Tag>已关联章节</Tag>}</header><div className="novel-arc-chapter-grid"><span><b>功能</b>{chapter.chapterPurpose}</span><span><b>戏剧问题</b>{chapter.dramaticQuestion}</span><span><b>情绪运动</b>{chapter.emotionalMovement}</span><span><b>章尾驱动力</b>{chapter.closingForce}</span></div>{chapter.scenes.length > 0 && <details><summary>{chapter.scenes.length} 个场景</summary>{chapter.scenes.map((scene, index) => <p key={index}><b>{scene.title}</b> · {scene.summary}</p>)}</details>}</article>)}</div>
    </main>
    <aside className="novel-plan-actions"><div><span className="novel-section-label">整弧状态</span><strong>{PLAN_LABEL[selected.planningStatus]}</strong><small>{selected.chapters.length} 章 · 修订 {selected.editRevision}</small></div><Space direction="vertical" style={{ width: "100%" }}>
      {canEditSelected && <Button block icon={<EditOutlined />} onClick={() => setEditArc(editableBatch(selected))}>{selected.planningStatus === "awaiting-review" ? "编辑待审批次" : "编辑故事弧"}</Button>}
      {selected.planningStatus === "awaiting-review" && <Button block type="primary" icon={<CheckOutlined />} loading={busy === "preview"} onClick={() => void previewApproval()}>审核并预览应用</Button>}
      {selected.planningStatus === "approved" && selected.executionStatus === "active" && latestBatch?.status === "approved" && !latestBatch.complete && <Button block type="primary" icon={<PlusOutlined />} loading={busy === "next-batch"} onClick={() => void startNextBatch()}>生成下一批蓝图</Button>}
      {selected.planningStatus === "generating" && <Button block disabled loading>正在生成整弧蓝图</Button>}
      {["stale", "failed"].includes(selected.planningStatus) && <Popconfirm title="按当前宏观规划重建章节蓝图；已有正文和定稿章节保持不变。" onConfirm={() => void rebase()}><Button block icon={<ReloadOutlined />} loading={busy === "rebase"}>重基线</Button></Popconfirm>}
      {!["completed", "abandoned"].includes(selected.executionStatus) && <Button block danger icon={<StopOutlined />} onClick={() => setAbandonOpen(true)}>放弃故事弧</Button>}
      {canDeleteSelected && <Popconfirm title="删除此故事弧？" description="仅删除未产出正文的故事弧；已有正文时后端仍会拒绝。" okText="删除" okButtonProps={{ danger: true }} onConfirm={() => void deleteArc()}><Button block danger icon={<DeleteOutlined />} loading={busy === "delete"}>删除故事弧</Button></Popconfirm>}
      {canDeleteSelected && <Popconfirm title="强制删除此故事弧？" description="将删除关联章节正文、修订、章节记忆和事实记忆；该操作不可恢复。" okText="强制删除" okButtonProps={{ danger: true }} onConfirm={() => void deleteArc(true)}><Button block danger icon={<DeleteOutlined />} loading={busy === "force-delete"}>强制删除故事弧</Button></Popconfirm>}
    </Space><details className="novel-plan-audit"><summary>审计信息</summary><code>{selected.blueprintArtifactId ?? selected.sourceArtifactId ?? "暂无 artifact"}</code><code>{selected.contextFingerprint ?? "尚未批准"}</code></details></aside>

    <Modal title="本弧创作意图" open={intentOpen} onCancel={() => setIntentOpen(false)} onOk={() => void startNext()} confirmLoading={busy === "next"} okText="开始生成"><Space direction="vertical" size={12} style={{ width: "100%" }}><Segmented block value={reviewPolicy} onChange={(value) => setReviewPolicy(value as "manual" | "auto")} options={[{ label: "人工审核", value: "manual" }, { label: "自动审校修订", value: "auto" }]} /><Input.TextArea value={authorIntent} onChange={(event) => setAuthorIntent(event.target.value)} autoSize={{ minRows: 4, maxRows: 8 }} /></Space></Modal>
    <Modal title="编辑整弧蓝图" width={1040} open={Boolean(editArc)} onCancel={() => setEditArc(undefined)} onOk={() => void saveEdit()} confirmLoading={busy === "edit"} okText="保存并重新审核">
      {editArc && <div className="novel-arc-editor">
        {editBatch && editBatch.batchIndex > 1 && <Alert showIcon type="info" message="后续批次只能编辑本批章节蓝图；故事弧边界沿用已批准版本。" />}
        <label><span>故事弧标题</span><Input disabled={!canEditArcBoundary} value={editArc.arc.title} onChange={(event) => updateArc({ title: event.target.value })} /></label>
        <label><span>创作目的</span><Input.TextArea disabled={!canEditArcBoundary} value={editArc.arc.objective} onChange={(event) => updateArc({ objective: event.target.value })} /></label>
        {(["entryState", "centralConflict", "resolution", "exitState"] as const).map((field) => <label key={field}><span>{{ entryState: "入场状态", centralConflict: "核心冲突", resolution: "收束方式", exitState: "离场状态" }[field]}</span><Input.TextArea disabled={!canEditArcBoundary} value={editArc.arc[field]} onChange={(event) => updateArc({ [field]: event.target.value } as Partial<ArcPlan>)} /></label>)}
        <label><span>预计章节数</span><Input disabled={!canEditArcBoundary} type="number" min={editArc.chapters.length} value={editArc.arc.expectedChapterCount} onChange={(event) => updateArc({ expectedChapterCount: Math.max(editArc.chapters.length, Number(event.target.value) || editArc.chapters.length) })} /></label>
        <label><span>发展路径（每行一项）</span><Input.TextArea disabled={!canEditArcBoundary} value={editArc.arc.development.join("\n")} onChange={(event) => updateArc({ development: csv(event.target.value) })} /></label>
        <label><span>剧情线引用（每行一项）</span><Input.TextArea disabled={!canEditArcBoundary} value={editArc.arc.plotThreadRefs.join("\n")} onChange={(event) => updateArc({ plotThreadRefs: csv(event.target.value) })} /></label>
        <label><span>伏笔引用（每行一项）</span><Input.TextArea disabled={!canEditArcBoundary} value={editArc.arc.foreshadowingRefs.join("\n")} onChange={(event) => updateArc({ foreshadowingRefs: csv(event.target.value) })} /></label>
        <div className="novel-arc-editor-head"><strong>阶段</strong><Button icon={<PlusOutlined />} disabled={!canEditArcBoundary} onClick={() => updateArc({ phases: [...editArc.arc.phases, { title: "新阶段", objective: "", exitCondition: "" }] })}>添加阶段</Button></div>
        {editArc.arc.phases.map((phase, index) => <section key={index}><header><strong>阶段 {index + 1}</strong><Button danger icon={<DeleteOutlined />} disabled={!canEditArcBoundary} onClick={() => updateArc({ phases: editArc.arc.phases.filter((_, at) => at !== index) })} /></header><Input disabled={!canEditArcBoundary} value={phase.title} placeholder="阶段标题" onChange={(event) => updatePhase(index, { title: event.target.value })} /><Input value={phase.objective} disabled={!canEditArcBoundary} placeholder="阶段目标" onChange={(event) => updatePhase(index, { objective: event.target.value })} /><Input value={phase.exitCondition} disabled={!canEditArcBoundary} placeholder="退出条件" onChange={(event) => updatePhase(index, { exitCondition: event.target.value })} /></section>)}
        <div className="novel-arc-editor-head"><strong>当前批次章节蓝图</strong><Button icon={<PlusOutlined />} disabled={editArc.chapters.length >= 16} onClick={addChapter}>添加章节</Button></div>{editArc.chapters.map((chapter, index) => <section key={chapter.id ?? index}><header><strong>第 {index + 1} 章</strong><Space><Button icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => moveChapter(index, -1)} /><Button icon={<ArrowDownOutlined />} disabled={index === editArc.chapters.length - 1} onClick={() => moveChapter(index, 1)} /><Button danger icon={<DeleteOutlined />} disabled={editArc.chapters.length <= 1 || Boolean(chapter.documentId)} onClick={() => setEditArc({ ...editArc, chapters: editArc.chapters.filter((_, at) => at !== index) })} /></Space></header><Input value={chapter.title} placeholder="章节标题" onChange={(event) => updateChapter(index, { title: event.target.value })} /><Input.TextArea value={chapter.summary} placeholder="摘要" onChange={(event) => updateChapter(index, { summary: event.target.value })} /><Input value={chapter.chapterPurpose} placeholder="章节功能" onChange={(event) => updateChapter(index, { chapterPurpose: event.target.value })} /><Input value={chapter.dramaticQuestion} placeholder="戏剧问题" onChange={(event) => updateChapter(index, { dramaticQuestion: event.target.value })} /><Input value={chapter.povCharacterId ?? ""} placeholder="POV 角色" onChange={(event) => updateChapter(index, { povCharacterId: event.target.value.trim() || undefined })} /><Input value={chapter.emotionalMovement} placeholder="情绪运动" onChange={(event) => updateChapter(index, { emotionalMovement: event.target.value })} /><Input value={chapter.stateDeltaBudget} placeholder="状态变化预算" onChange={(event) => updateChapter(index, { stateDeltaBudget: event.target.value })} /><Input value={chapter.closingForce} placeholder="章尾驱动力" onChange={(event) => updateChapter(index, { closingForce: event.target.value })} /><Input.TextArea value={chapter.freedom} placeholder="允许自由发挥范围" onChange={(event) => updateChapter(index, { freedom: event.target.value })} /><Input.TextArea value={chapter.optionalBeats.join("\n")} placeholder="可选节拍，每行一项" onChange={(event) => updateChapter(index, { optionalBeats: csv(event.target.value) })} /><Input.TextArea value={chapter.continuityConstraints.join("\n")} placeholder="连续性约束，每行一项" onChange={(event) => updateChapter(index, { continuityConstraints: csv(event.target.value) })} /><Input.TextArea value={chapter.setupRefs.join("\n")} placeholder="建立伏笔引用，每行一项" onChange={(event) => updateChapter(index, { setupRefs: csv(event.target.value) })} /><Input.TextArea value={chapter.payoffRefs.join("\n")} placeholder="兑现伏笔引用，每行一项" onChange={(event) => updateChapter(index, { payoffRefs: csv(event.target.value) })} /><div className="novel-arc-scenes"><strong>场景</strong>{chapter.scenes.map((scene, sceneIndex) => <div key={sceneIndex}><Input value={scene.title} placeholder="场景标题" onChange={(event) => updateChapter(index, { scenes: chapter.scenes.map((item, at) => at === sceneIndex ? { ...item, title: event.target.value } : item) })} /><Input.TextArea value={scene.summary} placeholder="场景摘要" onChange={(event) => updateChapter(index, { scenes: chapter.scenes.map((item, at) => at === sceneIndex ? { ...item, summary: event.target.value } : item) })} /><Input.TextArea value={scene.participants.join("\n")} placeholder="参与者，每行一项" onChange={(event) => updateChapter(index, { scenes: chapter.scenes.map((item, at) => at === sceneIndex ? { ...item, participants: csv(event.target.value) } : item) })} /><Button danger icon={<DeleteOutlined />} onClick={() => updateChapter(index, { scenes: chapter.scenes.filter((_, at) => at !== sceneIndex) })} /></div>)}<Button icon={<PlusOutlined />} onClick={() => updateChapter(index, { scenes: [...chapter.scenes, { title: "新场景", summary: "", participants: [] }] })}>添加场景</Button></div></section>)}</div>}
    </Modal>
    <Modal title="批准并应用章节目标" open={Boolean(preview)} onCancel={() => setPreview(undefined)} onOk={() => void confirmApproval()} confirmLoading={busy === "approve"} okText="确认批准"><div className="novel-plan-apply-preview"><p>新增 {preview?.creates.length ?? 0} 章，更新 {preview?.updates.length ?? 0} 章，冲突 {preview?.conflicts.length ?? 0} 章。</p>{preview?.creates.map((item) => <div key={item.chapterId}><Tag color="green">新增</Tag>第 {item.index} 章 · {item.title}</div>)}{preview?.updates.map((item) => <div key={item.chapterId}><Tag color="blue">更新</Tag>第 {item.index} 章 · {item.title}</div>)}{preview?.conflicts.map((item) => <Alert key={item.chapterId} type="warning" showIcon message={`第 ${item.index} 章《${item.title}》保持不变`} description={item.reason} />)}</div></Modal>
    <Modal title="放弃故事弧" open={abandonOpen} onCancel={() => setAbandonOpen(false)} onOk={() => void abandon()} okButtonProps={{ danger: true, disabled: !abandonReason.trim() }} confirmLoading={busy === "abandon"}><Input.TextArea value={abandonReason} onChange={(event) => setAbandonReason(event.target.value)} autoSize={{ minRows: 4, maxRows: 8 }} placeholder="记录放弃原因" /></Modal>
  </motion.section>;
}
