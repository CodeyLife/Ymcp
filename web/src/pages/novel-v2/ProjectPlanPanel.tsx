import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, InputNumber, Modal, Progress, Radio, Space, Spin, Switch, Tag, message } from "antd";
import {
  CheckOutlined,
  CopyOutlined,
  EditOutlined,
  FileDoneOutlined,
  FontColorsOutlined,
  HighlightOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import { motion } from "motion/react";
import { projectDisplayTitle } from "./presentation";
import "../novel-v2.css";

type PlanStatus = "locked" | "ready" | "generating" | "awaiting-confirmation" | "approved" | "stale" | "failed";
type Stage = { taskKey: string; label: string; dependsOn: readonly string[]; instruction: string };
type PlanItem = { label: string; detail: string; attributes?: Record<string, unknown> };
type PlanContentSection = { heading: string; content: string; items?: PlanItem[] };
type PlanPayload = { title?: string; summary?: string; sections?: PlanContentSection[]; structuredData?: Record<string, unknown> } & Record<string, unknown>;
type PlanSection = { taskKey: string; workItemId?: string; sourceArtifactId?: string; status: PlanStatus; payload: PlanPayload; editRevision: number; updatedAt: string };
type BookSynopsis = { text: string; generatedAt: string; sourceFingerprint: string; stale: boolean };
type SynopsisGeneration = { id: string; temporalWorkflowId: string; status: string; payload: Record<string, unknown> };
type BookTitleCandidates = { candidates: Array<{ title: string; rationale: string }>; generatedAt: string; sourceFingerprint: string; selectedTitle?: string; stale: boolean };
type PlanResponse = {
  stages: Stage[];
  sections: PlanSection[];
  run?: { runId: string; status: string };
  synopsis?: BookSynopsis;
  synopsisReadiness: { ready: boolean; missingStages: string[] };
  synopsisGeneration?: SynopsisGeneration;
  projectTitle: string;
  titleCandidates?: BookTitleCandidates;
  titleGeneration?: SynopsisGeneration;
  progress: { approved: number; total: number };
};

const STATUS_META: Record<PlanStatus, { label: string; tone: string }> = {
  locked: { label: "未解锁", tone: "idle" },
  ready: { label: "可生成", tone: "running" },
  generating: { label: "生成中", tone: "running" },
  "awaiting-confirmation": { label: "待确认", tone: "warning" },
  approved: { label: "已确认", tone: "done" },
  stale: { label: "需重审", tone: "failed" },
  failed: { label: "失败", tone: "failed" },
};

function clonePayload(payload: PlanPayload): PlanPayload {
  return JSON.parse(JSON.stringify(payload)) as PlanPayload;
}

const FIELD_LABELS: Record<string, string> = {
  sections: "分节内容",
  heading: "小节标题",
  content: "正文",
  items: "条目",
  label: "名称",
  detail: "详情",
  attributes: "属性",
  structuredData: "结构化规划",
};

const RUNTIME_PAYLOAD_KEYS = new Set(["modelProvenance", "workItemId", "taskKey", "runId", "origin", "pendingExternalTaskId"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function PlanValueEditor({ label, value, onChange, depth = 0 }: { label: string; value: unknown; onChange: (value: unknown) => void; depth?: number }) {
  const displayLabel = FIELD_LABELS[label] ?? label;
  if (Array.isArray(value)) {
    return <fieldset className="novel-plan-value-group" data-depth={depth}>
      <legend>{displayLabel}</legend>
      {value.length === 0 ? <span className="novel-plan-empty-value">暂无内容</span> : value.map((item, index) => (
        <PlanValueEditor
          key={index}
          label={`${displayLabel} ${index + 1}`}
          value={item}
          depth={depth + 1}
          onChange={(next) => onChange(value.map((current, itemIndex) => itemIndex === index ? next : current))}
        />
      ))}
    </fieldset>;
  }
  if (isRecord(value)) {
    return <fieldset className="novel-plan-value-group" data-depth={depth}>
      <legend>{displayLabel}</legend>
      {Object.keys(value).length === 0 ? <span className="novel-plan-empty-value">暂无内容</span> : Object.entries(value).map(([key, item]) => (
        <PlanValueEditor
          key={key}
          label={key}
          value={item}
          depth={depth + 1}
          onChange={(next) => onChange({ ...value, [key]: next })}
        />
      ))}
    </fieldset>;
  }
  if (typeof value === "boolean") {
    return <label className="novel-plan-scalar-field novel-plan-boolean-field"><span>{displayLabel}</span><Switch checked={value} onChange={onChange} /></label>;
  }
  if (typeof value === "number") {
    return <label className="novel-plan-scalar-field"><span>{displayLabel}</span><InputNumber value={value} onChange={(next) => onChange(next ?? 0)} /></label>;
  }
  if (value === null) {
    return <label className="novel-plan-scalar-field"><span>{displayLabel}</span><Input value="" placeholder="空值" onChange={(event) => onChange(event.target.value)} /></label>;
  }
  const text = typeof value === "string" ? value : String(value ?? "");
  return <label className="novel-plan-scalar-field"><span>{displayLabel}</span>{text.length > 80 || text.includes("\n")
    ? <Input.TextArea value={text} autoSize={{ minRows: 3, maxRows: 12 }} onChange={(event) => onChange(event.target.value)} />
    : <Input value={text} onChange={(event) => onChange(event.target.value)} />
  }</label>;
}

export function PlanPayloadEditor({ payload, onChange }: { payload: PlanPayload; onChange: (payload: PlanPayload) => void }) {
  const extraFields = Object.entries(payload).filter(([key]) => !["title", "summary", "sections", "structuredData"].includes(key) && !RUNTIME_PAYLOAD_KEYS.has(key));
  return <div className="novel-plan-editor">
    <label><span>标题</span><Input value={payload.title ?? ""} onChange={(event) => onChange({ ...payload, title: event.target.value })} /></label>
    <label><span>摘要</span><Input.TextArea value={payload.summary ?? ""} autoSize={{ minRows: 4, maxRows: 10 }} onChange={(event) => onChange({ ...payload, summary: event.target.value })} /></label>
    <PlanValueEditor label="sections" value={payload.sections ?? []} onChange={(sections) => onChange({ ...payload, sections: sections as PlanContentSection[] })} />
    <PlanValueEditor label="structuredData" value={payload.structuredData ?? {}} onChange={(structuredData) => onChange({ ...payload, structuredData: isRecord(structuredData) ? structuredData : {} })} />
    {extraFields.map(([key, value]) => <PlanValueEditor key={key} label={key} value={value} onChange={(next) => onChange({ ...payload, [key]: next })} />)}
  </div>;
}

export default function ProjectPlanPanel({ projectId, onProjectTitleChanged }: { projectId: string; onProjectTitleChanged?: (title: string) => void }) {
  const [data, setData] = useState<PlanResponse>();
  const [loading, setLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [objective, setObjective] = useState("建立可支撑长篇创作的完整全书规划");
  const [editPayload, setEditPayload] = useState<PlanPayload>();
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionInstruction, setRevisionInstruction] = useState("");
  const [synopsisOpen, setSynopsisOpen] = useState(false);
  const [synopsisBaseline, setSynopsisBaseline] = useState<string>();
  const [titleCandidatesOpen, setTitleCandidatesOpen] = useState(false);
  const [manualTitleOpen, setManualTitleOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [titleCandidatesBaseline, setTitleCandidatesBaseline] = useState<string>();
  const [selectedTitle, setSelectedTitle] = useState<string>();
  const [busy, setBusy] = useState<string>();

  async function readJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
    const response = await fetch(input, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
    return body as T;
  }

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const next = await readJson<PlanResponse>(`/v2/projects/${encodeURIComponent(projectId)}/plan`);
      setData(next);
      setSelectedKey((current) => current ?? next.sections.find((section) => section.status !== "approved")?.taskKey ?? next.stages[0]?.taskKey);
    } catch (error) {
      if (!silent) message.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [projectId]);
  useEffect(() => {
    const synopsisRunning = data?.synopsisGeneration && ["accepted", "pending", "running", "waiting-external"].includes(data.synopsisGeneration.status);
    const titleRunning = data?.titleGeneration && ["accepted", "pending", "running", "waiting-external"].includes(data.titleGeneration.status);
    if (!data?.sections.some((section) => section.status === "generating") && !synopsisRunning && !titleRunning) return;
    const timer = window.setInterval(() => void load(true), 2500);
    return () => window.clearInterval(timer);
  }, [data?.sections, data?.synopsisGeneration?.status, data?.titleGeneration?.status]);
  useEffect(() => {
    if (synopsisBaseline === undefined) return;
    if (data?.synopsis?.generatedAt && data.synopsis.generatedAt !== synopsisBaseline) {
      setSynopsisOpen(true);
      setSynopsisBaseline(undefined);
      message.success("作品简介已生成");
    } else if (data?.synopsisGeneration?.status === "failed") {
      const reason = typeof data.synopsisGeneration.payload.reason === "string" ? data.synopsisGeneration.payload.reason : "作品简介生成失败";
      setSynopsisBaseline(undefined);
      message.error(reason);
    }
  }, [data?.synopsis?.generatedAt, data?.synopsisGeneration?.status, synopsisBaseline]);
  useEffect(() => {
    if (titleCandidatesBaseline === undefined) return;
    if (data?.titleCandidates?.generatedAt && data.titleCandidates.generatedAt !== titleCandidatesBaseline) {
      setSelectedTitle(data.titleCandidates.candidates[0]?.title);
      setTitleCandidatesOpen(true);
      setTitleCandidatesBaseline(undefined);
      message.success("书名候选已生成");
    } else if (data?.titleGeneration?.status === "failed") {
      const reason = typeof data.titleGeneration.payload.reason === "string" ? data.titleGeneration.payload.reason : "书名候选生成失败";
      setTitleCandidatesBaseline(undefined);
      message.error(reason);
    }
  }, [data?.titleCandidates?.generatedAt, data?.titleGeneration?.status, titleCandidatesBaseline]);

  const sectionByKey = useMemo(() => new Map(data?.sections.map((section) => [section.taskKey, section]) ?? []), [data?.sections]);
  const selectedStage = data?.stages.find((stage) => stage.taskKey === selectedKey);
  const selected = selectedKey ? sectionByKey.get(selectedKey) : undefined;
  const meta = selected ? STATUS_META[selected.status] : STATUS_META.locked;
  const synopsisGenerating = Boolean(data?.synopsisGeneration && ["accepted", "pending", "running", "waiting-external"].includes(data.synopsisGeneration.status));
  const titleGenerating = Boolean(data?.titleGeneration && ["accepted", "pending", "running", "waiting-external"].includes(data.titleGeneration.status));

  async function action(key: string, callback: () => Promise<unknown>) {
    setBusy(key);
    try { await callback(); await load(true); }
    catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(undefined); }
  }

  async function start() {
    await action("start", async () => {
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}/plan/start`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective, idempotencyKey: `${projectId}:web-plan:${crypto.randomUUID()}` }),
      });
      message.success("全书规划已建立，请从项目定位开始");
    });
  }

  async function generate(instruction?: string) {
    if (!selected) return;
    await action("generate", async () => {
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}/plan/sections/${encodeURIComponent(selected.taskKey)}/generate`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction }),
      });
      setRevisionOpen(false);
      setRevisionInstruction("");
    });
  }

  async function approve() {
    if (!selected) return;
    await action("approve", async () => {
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}/plan/sections/${encodeURIComponent(selected.taskKey)}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      message.success(`${selectedStage?.label ?? "规划阶段"}已确认`);
    });
  }

  async function saveEdit() {
    if (!selected || !editPayload) return;
    await action("edit", async () => {
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}/plan/sections/${encodeURIComponent(selected.taskKey)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: editPayload }),
      });
      setEditPayload(undefined);
      message.success("当前规划已更新，请重新确认");
    });
  }

  async function generateSynopsis() {
    await action("synopsis", async () => {
      setSynopsisBaseline(data?.synopsis?.generatedAt ?? "");
      try {
        await readJson(`/v2/projects/${encodeURIComponent(projectId)}/plan/synopsis`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      } catch (error) {
        setSynopsisBaseline(undefined);
        throw error;
      }
      message.success("作品简介生成任务已启动");
    });
  }

  async function copySynopsis() {
    if (!data?.synopsis?.text) return;
    try {
      await navigator.clipboard.writeText(data.synopsis.text);
      message.success("作品简介已复制");
    } catch (error) {
      message.error(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function generateTitleCandidates() {
    await action("title-candidates", async () => {
      setTitleCandidatesBaseline(data?.titleCandidates?.generatedAt ?? "");
      try {
        await readJson(`/v2/projects/${encodeURIComponent(projectId)}/plan/title-candidates`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      } catch (error) {
        setTitleCandidatesBaseline(undefined);
        throw error;
      }
      message.success("书名候选生成任务已启动");
    });
  }

  async function applySelectedTitle() {
    if (!selectedTitle || !data?.titleCandidates) return;
    await action("select-title", async () => {
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}/plan/title`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: selectedTitle, sourceFingerprint: data.titleCandidates!.sourceFingerprint }),
      });
      setTitleCandidatesOpen(false);
      onProjectTitleChanged?.(selectedTitle);
      message.success(`作品书名已更新为《${selectedTitle}》`);
    });
  }

  async function applyManualTitle() {
    const title = manualTitle.trim();
    if (!title) return;
    await action("manual-title", async () => {
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      setManualTitleOpen(false);
      onProjectTitleChanged?.(title);
      message.success(`作品书名已更新为《${title}》`);
    });
  }

  if (loading) return <div className="novel-plan-loading"><Spin /></div>;
  if (!data?.sections.length) return (
    <motion.section className="novel-plan-empty" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      <div className="novel-plan-empty-mark"><FileDoneOutlined /></div>
      <h2>从全书规划开始</h2>
      <Input.TextArea value={objective} onChange={(event) => setObjective(event.target.value)} autoSize={{ minRows: 3, maxRows: 6 }} />
      <Button type="primary" size="large" icon={<PlayCircleOutlined />} loading={busy === "start"} onClick={() => void start()}>建立规划流程</Button>
    </motion.section>
  );

  return (
    <motion.section className="novel-plan-workspace" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <aside className="novel-plan-stage-rail">
        <div className="novel-plan-progress">
          <div><strong>全书规划</strong><span>{data.progress.approved}/{data.progress.total}</span></div>
          <Progress percent={Math.round((data.progress.approved / Math.max(data.progress.total, 1)) * 100)} showInfo={false} />
        </div>
        <div className="novel-plan-stage-list">
          {data.stages.map((stage, index) => {
            const stageSection = sectionByKey.get(stage.taskKey);
            const stageMeta = stageSection ? STATUS_META[stageSection.status] : STATUS_META.locked;
            return <button key={stage.taskKey} className={`novel-plan-stage ${selectedKey === stage.taskKey ? "is-active" : ""}`} onClick={() => setSelectedKey(stage.taskKey)}>
              <span className="novel-plan-stage-index">{String(index + 1).padStart(2, "0")}</span>
              <span><strong>{stage.label}</strong><small>{stageMeta.label}</small></span>
              <i className={`novel-plan-stage-dot is-${stageMeta.tone}`} />
            </button>;
          })}
        </div>
      </aside>

      <main className="novel-plan-reader">
        <header className="novel-plan-reader-head">
          <div><span className="novel-eyebrow">{selectedStage?.label}</span><h2>{selected?.payload.title ?? selectedStage?.instruction}</h2></div>
          <span className={`novel-status-pill novel-status-pill-${meta.tone}`}>{meta.label}</span>
        </header>
        {selected?.status === "stale" && <Alert type="warning" showIcon message="上游规划已经修改，本阶段需要重新生成或重新确认。" />}
        {selected?.payload.summary ? <p className="novel-plan-summary">{selected.payload.summary}</p> : <div className="novel-plan-placeholder">等待生成此阶段内容</div>}
        {(selected?.payload.sections ?? []).map((content, index) => <article className="novel-plan-section" key={`${content.heading}-${index}`}>
          <h3>{content.heading}</h3><p>{content.content}</p>
          {content.items?.length ? <div className="novel-plan-item-list">{content.items.map((item, itemIndex) => <div className="novel-plan-item" key={`${item.label}-${itemIndex}`}><strong>{item.label}</strong><span>{item.detail}</span></div>)}</div> : null}
        </article>)}
      </main>

      <aside className="novel-plan-actions">
        <div><span className="novel-section-label">阶段状态</span><strong>{meta.label}</strong><small>编辑修订 {selected?.editRevision ?? 0}</small></div>
        {selectedStage?.dependsOn.length ? <div><span className="novel-section-label">依赖</span><Space wrap>{selectedStage.dependsOn.map((key) => <Tag key={key}>{data.stages.find((stage) => stage.taskKey === key)?.label ?? key}</Tag>)}</Space></div> : null}
        <Space direction="vertical" style={{ width: "100%" }}>
          {selected && ["ready", "stale", "failed"].includes(selected.status) && <Button type="primary" block icon={<PlayCircleOutlined />} loading={busy === "generate"} onClick={() => void generate()}>生成此阶段</Button>}
          {selected?.status === "generating" && <Button block icon={<SyncOutlined spin />} disabled>正在生成</Button>}
          {selected?.sourceArtifactId && <Button block icon={<EditOutlined />} onClick={() => setEditPayload(clonePayload(selected.payload))}>编辑当前规划</Button>}
          {selected?.status === "awaiting-confirmation" && <Button type="primary" block icon={<CheckOutlined />} loading={busy === "approve"} onClick={() => void approve()}>确认并解锁下游</Button>}
          {selected?.sourceArtifactId && ["awaiting-confirmation", "approved", "stale", "failed"].includes(selected.status) && <Button block icon={<ReloadOutlined />} onClick={() => setRevisionOpen(true)}>带意见重新生成</Button>}
        </Space>
        <div className="novel-plan-title-action">
          <span className="novel-section-label">作品书名</span>
          <strong>{projectDisplayTitle(data.projectTitle, projectId)}</strong>
          <small>{titleGenerating ? "正在根据完整规划生成候选" : data.titleCandidates?.stale ? "规划已变化，需要重新生成候选" : data.titleCandidates ? `${data.titleCandidates.candidates.length} 个候选可供选择` : (data.synopsisReadiness.ready ? "完整规划已就绪" : "确认全部规划后可重新生成")}</small>
          <Button block icon={<EditOutlined />} onClick={() => { setManualTitle(data.projectTitle === projectId ? "" : data.projectTitle); setManualTitleOpen(true); }}>手动修改书名</Button>
          {data.titleCandidates && !data.titleCandidates.stale && <Button block icon={<FontColorsOutlined />} onClick={() => { setSelectedTitle(data.titleCandidates?.selectedTitle ?? data.titleCandidates?.candidates[0]?.title); setTitleCandidatesOpen(true); }}>选择书名</Button>}
          <Button
            block
            type={data.titleCandidates ? "default" : "primary"}
            icon={<ReloadOutlined />}
            loading={busy === "title-candidates" || titleGenerating}
            disabled={!data.synopsisReadiness.ready || titleGenerating}
            title={data.synopsisReadiness.ready ? undefined : "请先确认全部全书规划阶段"}
            onClick={() => void generateTitleCandidates()}
          >{data.titleCandidates ? "重新生成书名" : "生成书名候选"}</Button>
        </div>
        <div className="novel-plan-synopsis-action">
          <span className="novel-section-label">作品简介</span>
          <small>{synopsisGenerating ? "正在根据完整规划生成" : data.synopsis ? (data.synopsis.stale ? "规划已变化，需要重新生成" : "已根据当前完整规划生成") : (data.synopsisReadiness.ready ? "完整规划已就绪" : `待确认：${data.synopsisReadiness.missingStages.join("、")}`)}</small>
          {data.synopsis && <Button block icon={<FileDoneOutlined />} onClick={() => setSynopsisOpen(true)}>查看作品简介</Button>}
          <Button
            type={data.synopsis ? "default" : "primary"}
            block
            icon={<HighlightOutlined />}
            loading={busy === "synopsis" || synopsisGenerating}
            disabled={!data.synopsisReadiness.ready || synopsisGenerating}
            title={data.synopsisReadiness.ready ? undefined : "请先确认全部全书规划阶段"}
            onClick={() => void generateSynopsis()}
          >{data.synopsis ? "重新生成作品简介" : "生成作品简介"}</Button>
        </div>
        <details className="novel-plan-audit"><summary>审计信息</summary><code>{selected?.sourceArtifactId ?? "尚无 artifact"}</code><code>{selected?.workItemId ?? "尚无 work item"}</code></details>
      </aside>

      <Modal title="编辑当前规划" width={900} open={Boolean(editPayload)} onCancel={() => setEditPayload(undefined)} onOk={() => void saveEdit()} okText="保存并重新确认" confirmLoading={busy === "edit"}>
        {editPayload && <PlanPayloadEditor payload={editPayload} onChange={setEditPayload} />}
      </Modal>
      <Modal title="带意见重新生成" open={revisionOpen} onCancel={() => setRevisionOpen(false)} onOk={() => void generate(revisionInstruction)} okText="重新生成" confirmLoading={busy === "generate"} okButtonProps={{ disabled: !revisionInstruction.trim() }}>
        <Input.TextArea value={revisionInstruction} onChange={(event) => setRevisionInstruction(event.target.value)} autoSize={{ minRows: 5, maxRows: 10 }} />
      </Modal>
      <Modal
        title="作品简介"
        width={720}
        open={synopsisOpen}
        onCancel={() => setSynopsisOpen(false)}
        footer={<Space><Button icon={<CopyOutlined />} onClick={() => void copySynopsis()}>复制</Button><Button type="primary" icon={<HighlightOutlined />} loading={busy === "synopsis" || synopsisGenerating} disabled={!data.synopsisReadiness.ready || synopsisGenerating} title={data.synopsisReadiness.ready ? undefined : "请先确认全部全书规划阶段"} onClick={() => void generateSynopsis()}>重新生成</Button></Space>}
      >
        {data.synopsis?.stale && <Alert type="warning" showIcon message="全书规划已更新，当前简介来自旧版规划。" />}
        <p className="novel-plan-book-synopsis">{data.synopsis?.text}</p>
      </Modal>
      <Modal
        title="手动修改作品书名"
        open={manualTitleOpen}
        onCancel={() => setManualTitleOpen(false)}
        onOk={() => void applyManualTitle()}
        okText="保存书名"
        confirmLoading={busy === "manual-title"}
        okButtonProps={{ disabled: !manualTitle.trim() }}
      >
        <Input value={manualTitle} onChange={(event) => setManualTitle(event.target.value)} placeholder="输入中文作品书名" maxLength={40} showCount autoFocus />
      </Modal>
      <Modal
        title="选择作品书名"
        width={680}
        open={titleCandidatesOpen}
        onCancel={() => setTitleCandidatesOpen(false)}
        onOk={() => void applySelectedTitle()}
        okText="使用此书名"
        confirmLoading={busy === "select-title"}
        okButtonProps={{ disabled: !selectedTitle || data.titleCandidates?.stale }}
      >
        {data.titleCandidates?.stale && <Alert type="warning" showIcon message="全书规划已更新，请重新生成书名候选。" />}
        <Radio.Group className="novel-plan-title-options" value={selectedTitle} onChange={(event) => setSelectedTitle(event.target.value)}>
          {data.titleCandidates?.candidates.map((candidate) => <label key={candidate.title} className={selectedTitle === candidate.title ? "is-selected" : ""}>
            <Radio value={candidate.title} />
            <span><strong>《{candidate.title}》</strong><small>{candidate.rationale}</small></span>
          </label>)}
        </Radio.Group>
      </Modal>
    </motion.section>
  );
}
