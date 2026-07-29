import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Modal, Progress, Space, Spin, Tag, message } from "antd";
import {
  CheckOutlined,
  EditOutlined,
  FileDoneOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import { motion } from "motion/react";
import "../novel-v2.css";

type PlanStatus = "locked" | "ready" | "generating" | "awaiting-confirmation" | "approved" | "stale" | "failed";
type Stage = { taskKey: string; label: string; dependsOn: readonly string[]; instruction: string };
type PlanItem = { label: string; detail: string; attributes?: Record<string, unknown> };
type PlanContentSection = { heading: string; content: string; items?: PlanItem[] };
type PlanPayload = { title?: string; summary?: string; sections?: PlanContentSection[]; structuredData?: Record<string, unknown> };
type PlanSection = { taskKey: string; workItemId?: string; sourceArtifactId?: string; status: PlanStatus; payload: PlanPayload; editRevision: number; updatedAt: string };
type PlanResponse = { stages: Stage[]; sections: PlanSection[]; run?: { runId: string; status: string }; progress: { approved: number; total: number } };

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

export default function ProjectPlanPanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<PlanResponse>();
  const [loading, setLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [objective, setObjective] = useState("建立可支撑长篇创作的完整全书规划");
  const [editPayload, setEditPayload] = useState<PlanPayload>();
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionInstruction, setRevisionInstruction] = useState("");
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
    if (!data?.sections.some((section) => section.status === "generating")) return;
    const timer = window.setInterval(() => void load(true), 2500);
    return () => window.clearInterval(timer);
  }, [data?.sections]);

  const sectionByKey = useMemo(() => new Map(data?.sections.map((section) => [section.taskKey, section]) ?? []), [data?.sections]);
  const selectedStage = data?.stages.find((stage) => stage.taskKey === selectedKey);
  const selected = selectedKey ? sectionByKey.get(selectedKey) : undefined;
  const meta = selected ? STATUS_META[selected.status] : STATUS_META.locked;

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

  function updateContentSection(index: number, changes: Partial<PlanContentSection>) {
    setEditPayload((current) => current ? { ...current, sections: (current.sections ?? []).map((section, sectionIndex) => sectionIndex === index ? { ...section, ...changes } : section) } : current);
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
        <details className="novel-plan-audit"><summary>审计信息</summary><code>{selected?.sourceArtifactId ?? "尚无 artifact"}</code><code>{selected?.workItemId ?? "尚无 work item"}</code></details>
      </aside>

      <Modal title="编辑当前规划" width={900} open={Boolean(editPayload)} onCancel={() => setEditPayload(undefined)} onOk={() => void saveEdit()} okText="保存并重新确认" confirmLoading={busy === "edit"}>
        {editPayload && <div className="novel-plan-editor">
          <label><span>标题</span><Input value={editPayload.title} onChange={(event) => setEditPayload({ ...editPayload, title: event.target.value })} /></label>
          <label><span>摘要</span><Input.TextArea value={editPayload.summary} autoSize={{ minRows: 4, maxRows: 10 }} onChange={(event) => setEditPayload({ ...editPayload, summary: event.target.value })} /></label>
          {(editPayload.sections ?? []).map((content, index) => <section key={index}>
            <Input value={content.heading} onChange={(event) => updateContentSection(index, { heading: event.target.value })} />
            <Input.TextArea value={content.content} autoSize={{ minRows: 3, maxRows: 10 }} onChange={(event) => updateContentSection(index, { content: event.target.value })} />
          </section>)}
        </div>}
      </Modal>
      <Modal title="带意见重新生成" open={revisionOpen} onCancel={() => setRevisionOpen(false)} onOk={() => void generate(revisionInstruction)} okText="重新生成" confirmLoading={busy === "generate"} okButtonProps={{ disabled: !revisionInstruction.trim() }}>
        <Input.TextArea value={revisionInstruction} onChange={(event) => setRevisionInstruction(event.target.value)} autoSize={{ minRows: 5, maxRows: 10 }} />
      </Modal>
    </motion.section>
  );
}
