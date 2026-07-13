import { useEffect, useMemo, useState } from "react";
import { App, Button, Checkbox, Input, Select, Tag } from "antd";
import { CheckCircleOutlined, CloseOutlined, ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  applyProposalItems,
  getGenerationTask,
  regenerateProposalItem,
  rejectProposal,
  retryProjectGeneration,
  runGenerationTask,
  tasksForScope,
  updateProposalItemPayload,
} from "./generation";
import { novelDb } from "./db";
import type { NovelGenerationScope, NovelGenerationTaskKey, ProposalItem } from "./types";

function PayloadEditor({ item, value, onChange }: { item: ProposalItem; value: string; onChange: (value: string) => void }) {
  return <Input.TextArea aria-label={`${item.label}候选数据`} autoSize={{ minRows: 4, maxRows: 12 }} value={value} onChange={(event) => onChange(event.target.value)} />;
}

export default function GenerationComposer({
  projectId,
  scope,
  targetId,
  taskKeys,
  projectGenerationRunId,
  placeholder,
  compact = false,
}: {
  projectId: string;
  scope: NovelGenerationScope;
  targetId?: string;
  taskKeys?: NovelGenerationTaskKey[];
  projectGenerationRunId?: string;
  placeholder?: string;
  compact?: boolean;
}) {
  const { message } = App.useApp();
  const tasks = useMemo(() => {
    const scoped = tasksForScope(scope);
    return taskKeys ? taskKeys.map(getGenerationTask) : scoped;
  }, [scope, taskKeys]);
  const [taskKey, setTaskKey] = useState<NovelGenerationTaskKey>(tasks[0]?.key ?? "architecture");
  const task = tasks.find((item) => item.key === taskKey) ?? tasks[0];
  const [instruction, setInstruction] = useState(task?.defaultInstruction ?? "");
  const [busy, setBusy] = useState(false);
  const proposal = useLiveQuery(async () => {
    const items = await novelDb.proposals.where("projectId").equals(projectId).reverse().sortBy("createdAt");
    return items.find((item) => item.status === "pending"
      && item.scope === scope
      && (!taskKeys || (item.taskKey && taskKeys.includes(item.taskKey)))
      && (projectGenerationRunId ? item.projectGenerationRunId === projectGenerationRunId : !item.projectGenerationRunId)
      && (targetId ? item.targetId === targetId : !item.targetId)) ?? null;
  }, [projectId, scope, targetId, taskKeys, projectGenerationRunId], null);
  const [selected, setSelected] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!task || task.key === taskKey) return;
    setTaskKey(task.key);
  }, [task, taskKey]);
  useEffect(() => {
    if (!task) return;
    setInstruction(task.defaultInstruction);
  }, [task?.key]);
  useEffect(() => {
    if (!proposal) { setSelected([]); setDrafts({}); return; }
    setSelected(proposal.items.filter((item) => item.status === "pending").map((item) => item.id));
    setDrafts(Object.fromEntries(proposal.items.map((item) => [item.id, JSON.stringify(item.payload, null, 2)])));
  }, [proposal?.id, proposal?.revision]);

  async function perform(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    try { await action(); if (success) message.success(success); }
    catch (error) { message.error(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  }

  async function generate() {
    if (!task) return;
    await perform(() => runGenerationTask({ projectId, taskKey: task.key, instruction: instruction.trim() || task.defaultInstruction, targetId }), "候选内容已生成，请审核");
  }

  async function apply() {
    if (!proposal) return;
    for (const id of selected) {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(drafts[id]) as Record<string, unknown>; }
      catch { throw new Error(`“${proposal.items.find((item) => item.id === id)?.label}”的候选数据不是有效 JSON`); }
      await updateProposalItemPayload(proposal.id, id, payload);
    }
    const result = await applyProposalItems(proposal.id, selected);
    const detail = `${result.conflicts ? `，${result.conflicts} 项因版本冲突未写入` : ""}${result.embeddingFailures ? `，${result.embeddingFailures} 项语义索引待重试` : ""}`;
    result.embeddingFailures ? message.warning(`已采纳 ${result.applied} 项${detail}`) : message.success(`已采纳 ${result.applied} 项${detail}`);
  }

  async function rejectAndRegenerate() {
    if (!proposal) return;
    await rejectProposal(proposal.id);
    if (proposal.projectGenerationRunId) await retryProjectGeneration(proposal.projectGenerationRunId);
    else await runGenerationTask({ projectId, taskKey: proposal.taskKey!, instruction, targetId });
  }

  return <section className={`novel-generation-composer${compact ? " compact" : ""}`}>
    <div className="novel-generation-command">
      {tasks.length > 1 && <Select value={taskKey} onChange={(value) => setTaskKey(value)} options={tasks.map((item) => ({ value: item.key, label: item.label }))} />}
      <Input.TextArea autoSize={{ minRows: compact ? 1 : 2, maxRows: 5 }} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={placeholder || "输入一句创意、补充要求或要完成的任务"} />
      <Button type="primary" icon={<ThunderboltOutlined />} loading={busy} onClick={() => void generate()}>生成候选</Button>
    </div>
    {proposal && <div className="novel-generation-review">
      <header><div><Tag color="gold">待审核</Tag><strong>{proposal.title}</strong><small>{proposal.items.length} 个候选项</small></div><Checkbox checked={selected.length > 0 && selected.length === proposal.items.filter((item) => item.status === "pending").length} indeterminate={selected.length > 0 && selected.length < proposal.items.filter((item) => item.status === "pending").length} onChange={(event) => setSelected(event.target.checked ? proposal.items.filter((item) => item.status === "pending").map((item) => item.id) : [])}>全选</Checkbox></header>
      <div className="novel-generation-summary"><ReactMarkdown remarkPlugins={[remarkGfm]}>{proposal.previewMarkdown}</ReactMarkdown></div>
      <div className="novel-generation-items">{proposal.items.map((item) => <article key={item.id} className={item.status === "conflict" ? "conflict" : ""}>
        <header><Checkbox disabled={item.status === "conflict"} checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /><div><strong>{item.label}</strong><small>{item.status === "conflict" ? "版本冲突 · 请重新生成" : item.operation === "create" ? "新增" : "更新"} · {item.targetTable}</small></div><Button type="text" icon={<ReloadOutlined />} loading={busy} title="重新生成本项" onClick={() => void perform(async () => { await regenerateProposalItem(proposal.id, item.id, instruction); }, "该候选项已重新生成")} /></header>
        <p>{item.rationale}</p>
        {item.before && <details><summary>查看修改前内容</summary><pre>{JSON.stringify(item.before, null, 2)}</pre></details>}
        <small className="novel-generation-after-label">修改后</small>
        <PayloadEditor item={item} value={drafts[item.id] ?? "{}"} onChange={(value) => setDrafts((current) => ({ ...current, [item.id]: value }))} />
      </article>)}</div>
      <footer><Button icon={<CloseOutlined />} disabled={busy} onClick={() => void perform(rejectAndRegenerate, "已退回并重新生成")}>退回重生成</Button><Button type="primary" icon={<CheckCircleOutlined />} loading={busy} disabled={!selected.length} onClick={() => void perform(apply)}>采纳所选（{selected.length}）</Button></footer>
    </div>}
  </section>;
}
