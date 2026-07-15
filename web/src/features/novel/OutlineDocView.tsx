import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Empty, Input, Modal, Select, Tag, Tooltip } from "antd";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  RobotOutlined,
  SaveOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { motion } from "motion/react";
import { useLiveQuery } from "dexie-react-hooks";

import ArchitectureDataEditor from "./ArchitectureDataEditor";
import GenerationComposer from "./GenerationComposer";
import OutlineProposalReview from "./OutlineProposalReview";
import {
  addOutlineNode,
  appendOperation,
  createChapter,
  deleteChapter,
  deleteOutlineBranch,
  ensureStoryArchitecture,
  normalizeChapterOrderByPlanning,
  novelDb,
  saveStoryArchitecture,
} from "./db";
import { runPlotDesignTask } from "./generation";
import type { ArchitecturePhase, ManuscriptDocument, OutlineNode, StoryArchitecture } from "./types";

type OpenChapterPanel = "plan" | "manuscript" | "workflow";

function InlineText({ value, placeholder, multiline, onCommit }: { value: string; placeholder: string; multiline?: boolean; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  return multiline
    ? <Input.TextArea value={draft} placeholder={placeholder} autoSize={{ minRows: 2, maxRows: 6 }} onChange={(event) => setDraft(event.target.value)} onBlur={commit} />
    : <Input value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onBlur={commit} />;
}

function ChapterRow({ document, onUpdate, onDelete, onOpen }: {
  document: ManuscriptDocument;
  onUpdate: (document: ManuscriptDocument, changes: Partial<ManuscriptDocument>) => void;
  onDelete: (document: ManuscriptDocument) => void;
  onOpen: (documentId: string, panel: OpenChapterPanel) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const blueprint = document.blueprint;
  return <div className="novel-planning-chapter-row">
    <header>
      <span className="novel-planning-chapter-order">{String(document.order + 1).padStart(2, "0")}</span>
      <div className="novel-planning-chapter-title"><InlineText value={document.title} placeholder="章节标题" onCommit={(title) => onUpdate(document, { title })} /><small>{document.wordCount.toLocaleString()} 字 · {document.status}</small></div>
      <div className="novel-planning-row-actions">
        <Tooltip title="编辑章节蓝图"><Button type="text" aria-label="编辑章节蓝图" icon={<EditOutlined />} onClick={() => setExpanded((value) => !value)} /></Tooltip>
        <Button size="small" onClick={() => onOpen(document.id, "manuscript")}>正文</Button>
        <Tooltip title="自动章节流程"><Button type="text" aria-label="自动章节流程" icon={<ThunderboltOutlined />} onClick={() => onOpen(document.id, "workflow")} /></Tooltip>
        <Tooltip title="删除章节"><Button danger type="text" aria-label="删除章节" icon={<DeleteOutlined />} onClick={() => onDelete(document)} /></Tooltip>
      </div>
    </header>
    {expanded && <div className="novel-planning-chapter-editor">
      <label>章节摘要<InlineText multiline value={document.summary} placeholder="本章推进与结尾变化" onCommit={(summary) => onUpdate(document, { summary })} /></label>
      <label>本章目标<InlineText multiline value={blueprint.objective} placeholder="本章必须完成什么" onCommit={(objective) => onUpdate(document, { blueprint: { ...blueprint, objective } })} /></label>
      <label>核心冲突<InlineText multiline value={blueprint.conflict} placeholder="谁想要什么，受到什么阻碍" onCommit={(conflict) => onUpdate(document, { blueprint: { ...blueprint, conflict } })} /></label>
      <label>必须发生<InlineText multiline value={blueprint.mustHappen.join("\n")} placeholder="每行一个必须发生项" onCommit={(value) => onUpdate(document, { blueprint: { ...blueprint, mustHappen: value.split("\n").map((item) => item.trim()).filter(Boolean) } })} /></label>
      <Button size="small" onClick={() => onOpen(document.id, "plan")}>打开完整章节规划</Button>
    </div>}
  </div>;
}

function SegmentSection({ segment, chapters, siblings, onUpdate, onMove, onDelete, onAddChapter, onUpdateChapter, onDeleteChapter, onOpenChapter }: {
  segment: OutlineNode;
  chapters: ManuscriptDocument[];
  siblings: OutlineNode[];
  onUpdate: (segment: OutlineNode, changes: Partial<OutlineNode>) => void;
  onMove: (segment: OutlineNode, direction: -1 | 1) => void;
  onDelete: (segment: OutlineNode) => void;
  onAddChapter: (segment: OutlineNode) => void;
  onUpdateChapter: (document: ManuscriptDocument, changes: Partial<ManuscriptDocument>) => void;
  onDeleteChapter: (document: ManuscriptDocument) => void;
  onOpenChapter: (documentId: string, panel: OpenChapterPanel) => void;
}) {
  const index = siblings.findIndex((item) => item.id === segment.id);
  return <section className="novel-plot-segment">
    <header className="novel-plot-segment-header">
      <Tag color="blue">剧情段 {index + 1}</Tag>
      <div><InlineText value={segment.title} placeholder="剧情段标题" onCommit={(title) => onUpdate(segment, { title })} /><InlineText multiline value={segment.summary} placeholder="人物处境、局部矛盾和结束时的局面变化" onCommit={(summary) => onUpdate(segment, { summary })} /></div>
      <div className="novel-planning-row-actions">
        <Tooltip title="上移剧情段"><Button type="text" aria-label="上移剧情段" icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => onMove(segment, -1)} /></Tooltip>
        <Tooltip title="下移剧情段"><Button type="text" aria-label="下移剧情段" icon={<ArrowDownOutlined />} disabled={index === siblings.length - 1} onClick={() => onMove(segment, 1)} /></Tooltip>
        <Tooltip title="新增章节"><Button type="text" aria-label="新增章节" icon={<PlusOutlined />} onClick={() => onAddChapter(segment)} /></Tooltip>
        <Tooltip title="删除剧情段"><Button danger type="text" aria-label="删除剧情段" icon={<DeleteOutlined />} onClick={() => onDelete(segment)} /></Tooltip>
      </div>
    </header>
    <div className="novel-planning-chapter-list">
      {chapters.map((document) => <ChapterRow key={document.id} document={document} onUpdate={onUpdateChapter} onDelete={onDeleteChapter} onOpen={onOpenChapter} />)}
      {!chapters.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该剧情段还没有章节" />}
    </div>
  </section>;
}

export default function OutlineDocView({ projectId, onOpenChapter }: { projectId: string; onOpenChapter: (documentId: string, panel: OpenChapterPanel) => void }) {
  const { message, modal } = App.useApp();
  const architecture = useLiveQuery(() => novelDb.architectures.where("projectId").equals(projectId).first(), [projectId]);
  const segments = useLiveQuery(() => novelDb.outlineNodes.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const documents = useLiveQuery(() => novelDb.documents.where("projectId").equals(projectId).sortBy("order"), [projectId]) ?? [];
  const proposal = useLiveQuery(() => novelDb.proposals.where("projectId").equals(projectId).and((item) => item.status === "pending" && item.taskKey === "plot-design").first(), [projectId]);
  const [draft, setDraft] = useState<StoryArchitecture>();
  const [architectureOpen, setArchitectureOpen] = useState(true);
  const [generatePhase, setGeneratePhase] = useState<ArchitecturePhase>();
  const [instruction, setInstruction] = useState("");
  const [generating, setGenerating] = useState(false);

  useEffect(() => { if (architecture) setDraft(architecture); else if (architecture === undefined) void ensureStoryArchitecture(projectId); }, [architecture, projectId]);
  const phaseList = useMemo(() => [...(draft?.phases ?? architecture?.phases ?? [])].sort((left, right) => left.order - right.order), [architecture, draft]);
  const segmentMap = useMemo(() => new Map(segments.map((segment) => [segment.id, segment])), [segments]);
  const unassigned = documents.filter((document) => !document.plotSegmentId || !segmentMap.has(document.plotSegmentId));

  const updateSegment = useCallback(async (segment: OutlineNode, changes: Partial<OutlineNode>) => {
    const before = await novelDb.outlineNodes.get(segment.id);
    if (!before) return;
    const next = { ...before, ...changes, revision: before.revision + 1, updatedAt: Date.now() };
    await novelDb.outlineNodes.put(next);
    await appendOperation(projectId, "outlineNodes", segment.id, "update", { value: { before, after: next } });
  }, [projectId]);

  const updateChapter = useCallback(async (document: ManuscriptDocument, changes: Partial<ManuscriptDocument>) => {
    const before = await novelDb.documents.get(document.id);
    if (!before) return;
    const next = { ...before, ...changes, revision: before.revision + 1, updatedAt: Date.now() };
    await novelDb.documents.put(next);
    await appendOperation(projectId, "documents", document.id, "update", { value: { before, after: next } });
  }, [projectId]);

  async function addSegment(phase: ArchitecturePhase) {
    const phaseSegments = segments.filter((segment) => segment.phaseId === phase.id);
    const order = phaseSegments.reduce((max, segment) => Math.max(max, segment.order), -1) + 1;
    await addOutlineNode(projectId, phase.id, `剧情段 ${order + 1}`, order);
  }

  const updateDraftPhase = (id: string, changes: Partial<ArchitecturePhase>) => {
    setDraft((current) => current ? { ...current, phases: current.phases.map((phase) => phase.id === id ? { ...phase, ...changes } : phase) } : current);
  };

  const addDraftPhase = () => {
    setDraft((current) => current ? { ...current, phases: [...current.phases, { id: crypto.randomUUID(), title: `第 ${current.phases.length + 1} 幕`, purpose: "", turningPoint: "", order: current.phases.length, locked: false }] } : current);
  };

  const removeDraftPhase = (phase: ArchitecturePhase) => {
    const phaseSegments = segments.filter((segment) => segment.phaseId === phase.id);
    if (phaseSegments.length) {
      message.warning("请先处理该幕下的剧情段，再删除此幕");
      return;
    }
    setDraft((current) => current ? { ...current, phases: current.phases.filter((item) => item.id !== phase.id).map((item, order) => ({ ...item, order })) } : current);
  };

  const saveArchitectureDraft = async () => {
    if (!draft) return undefined;
    const saved = await saveStoryArchitecture(draft);
    setDraft(saved);
    return saved;
  };

  async function moveSegment(segment: OutlineNode, direction: -1 | 1) {
    const siblings = segments.filter((item) => item.phaseId === segment.phaseId).sort((left, right) => left.order - right.order);
    const index = siblings.findIndex((item) => item.id === segment.id);
    const target = siblings[index + direction];
    if (!target) return;
    await novelDb.outlineNodes.bulkPut([
      { ...segment, order: target.order, revision: segment.revision + 1, updatedAt: Date.now() },
      { ...target, order: segment.order, revision: target.revision + 1, updatedAt: Date.now() },
    ]);
    await normalizeChapterOrderByPlanning(projectId);
  }

  function removeSegment(segment: OutlineNode) {
    const chapterCount = documents.filter((document) => document.plotSegmentId === segment.id).length;
    modal.confirm({ title: `删除“${segment.title}”？`, content: chapterCount ? `${chapterCount} 个章节会保留并移入待整理章节。` : "该剧情段将被删除。", okButtonProps: { danger: true }, onOk: () => deleteOutlineBranch(projectId, segment.id) });
  }

  function removeChapter(document: ManuscriptDocument) {
    modal.confirm({ title: `删除“${document.title}”？`, content: "本章场景、正文版本和自动流程记录将一并删除。", okButtonProps: { danger: true }, onOk: () => deleteChapter(document.id) });
  }

  async function generate() {
    if (!generatePhase) return;
    setGenerating(true);
    try {
      await runPlotDesignTask({ projectId, phaseId: generatePhase.id, instruction });
      setGeneratePhase(undefined);
      setInstruction("");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "剧情设计失败");
    } finally {
      setGenerating(false);
    }
  }

  if (proposal) return <OutlineProposalReview proposal={proposal} onRegenerate={() => {
    const phase = architecture?.phases.find((item) => item.id === proposal.targetId);
    if (phase) setGeneratePhase(phase);
  }} />;

  return <div className="novel-outline-document">
    <header className="novel-section-title novel-planning-title"><div><h2>全书规划</h2><p>从全书命题到每幕章节，在一条连续结构中完成规划。</p></div><Button icon={<EditOutlined />} onClick={() => setArchitectureOpen((value) => !value)}>{architectureOpen ? "收起规划设置" : "展开规划设置"}</Button></header>
    {draft && architectureOpen && <section className="novel-planning-console">
      <header className="novel-planning-console-heading"><div><strong>规划控制台</strong><span>{draft.phases.length} 幕 · {draft.status === "approved" ? "已批准" : "草案"}</span></div><Button className="novel-planning-save" type="primary" icon={<SaveOutlined />} onClick={async () => { await saveArchitectureDraft(); message.success("全书架构已保存"); }}>保存规划</Button></header>
      <div className="novel-planning-ai-command"><div className="novel-planning-ai-label"><strong>AI 规划指令</strong><span>生成新方案，或输入具体要求微调当前规划</span></div><GenerationComposer projectId={projectId} scope="architecture" taskKeys={["architecture"]} actionLabel="生成架构方案" compact getRefinementSnapshot={() => ({ architectures: [draft as unknown as Record<string, unknown>] })} /></div>
      <ArchitectureDataEditor value={draft} showPhases={false} onChange={(next) => setDraft({ ...draft, ...next })} />
    </section>}
    {!phaseList.length && <Alert type="warning" showIcon message="先建立至少一幕" description="在下方“幕与章节”中添加第一幕，再继续组织剧情段和章节。" />}
    <section className="novel-phase-workspace"><header><div><h3>幕与章节</h3><span>{phaseList.length} 幕 · {segments.length} 个剧情段 · {documents.length} 章</span></div><Button icon={<PlusOutlined />} onClick={addDraftPhase}>添加幕</Button></header>
    <div className="novel-phase-list">{phaseList.map((phase, phaseIndex) => {
      const phaseSegments = segments.filter((segment) => segment.phaseId === phase.id).sort((left, right) => left.order - right.order);
      return <motion.section className="novel-phase-section" key={phase.id} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .28, delay: Math.min(phaseIndex * .04, .2) }}>
        <header className="novel-phase-header"><div className="novel-phase-number"><span>幕</span><strong>{String(phaseIndex + 1).padStart(2, "0")}</strong></div><div className="novel-phase-summary-editor"><label><span>幕标题</span><Input value={phase.title} placeholder="为这一幕命名" onChange={(event) => updateDraftPhase(phase.id, { title: event.target.value })} /></label><label><span>叙事使命</span><Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={phase.purpose} placeholder="这一幕必须完成的叙事推进" onChange={(event) => updateDraftPhase(phase.id, { purpose: event.target.value })} /></label><label><span>不可逆转折</span><Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={phase.turningPoint} placeholder="幕末改变故事方向的决定性变化" onChange={(event) => updateDraftPhase(phase.id, { turningPoint: event.target.value })} /></label></div><div className="novel-phase-actions"><Tooltip title="删除本幕"><Button danger type="text" aria-label={`删除${phase.title || `第 ${phaseIndex + 1} 幕`}`} icon={<DeleteOutlined />} onClick={() => removeDraftPhase(phase)} /></Tooltip><Button icon={<RobotOutlined />} onClick={async () => { await saveArchitectureDraft(); setGeneratePhase(phase); }}>AI 设计章节</Button><Button type="primary" icon={<PlusOutlined />} onClick={async () => { await saveArchitectureDraft(); await addSegment(phase); }}>新增剧情段</Button></div></header>
        <div className="novel-phase-segments">{phaseSegments.map((segment) => <SegmentSection key={segment.id} segment={segment} siblings={phaseSegments} chapters={documents.filter((document) => document.plotSegmentId === segment.id)} onUpdate={(item, changes) => void updateSegment(item, changes)} onMove={(item, direction) => void moveSegment(item, direction)} onDelete={removeSegment} onAddChapter={async (item) => { const chapter = await createChapter(projectId, undefined, item.id); onOpenChapter(chapter.id, "plan"); }} onUpdateChapter={(document, changes) => void updateChapter(document, changes)} onDeleteChapter={removeChapter} onOpenChapter={onOpenChapter} />)}{!phaseSegments.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该幕还没有剧情段" />}</div>
      </motion.section>;
    })}</div></section>
    {unassigned.length > 0 && <section className="novel-unassigned-chapters"><header><div><Tag color="orange">待整理章节</Tag><strong>{unassigned.length} 章</strong></div><p>这些章节尚未归属剧情段，仍可编辑，但不会进入按幕组织的规划。</p></header>{unassigned.map((document) => <div key={document.id}><span>{document.title}</span><Select placeholder="选择剧情段" value={document.plotSegmentId} options={segments.map((segment) => ({ value: segment.id, label: `${phaseList.find((phase) => phase.id === segment.phaseId)?.title ?? "未知幕"} / ${segment.title}` }))} onChange={async (plotSegmentId) => { await updateChapter(document, { plotSegmentId }); await normalizeChapterOrderByPlanning(projectId); }} /><Button onClick={() => onOpenChapter(document.id, "manuscript")}>打开正文</Button></div>)}</section>}
    <Modal title={`为“${generatePhase?.title ?? ""}”设计剧情段与章节`} open={Boolean(generatePhase)} confirmLoading={generating} okText="开始生成" cancelText="取消" onOk={() => void generate()} onCancel={() => { if (!generating) setGeneratePhase(undefined); }}><Input.TextArea rows={5} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="可选：说明本段要推进的矛盾、角色或伏笔" /></Modal>
  </div>;
}
