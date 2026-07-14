import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Checkbox, Input, Select, Tag } from "antd";
import { ArrowsAltOutlined, CheckCircleOutlined, CloseOutlined, EditOutlined, ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import {
  applyProposalItems,
  buildRefinementSnapshot,
  fingerprintRefinementSnapshot,
  getGenerationTask,
  regenerateProposalItem,
  rejectProposal,
  runGenerationTask,
  runRefinementTask,
  tasksForScope,
  updateProposalItemPayload,
} from "./generation";
import { novelDb } from "./db";
import type { NovelGenerationScope, NovelGenerationTaskKey, ProposalItem, RefinementSnapshotInput } from "./types";
import ProposalReviewDialog from "./ProposalReviewDialog";
import { fieldLabel } from "./ProposalDataCard";

function changedFieldsFor(item: ProposalItem, payload: Record<string, unknown>) {
  if (item.operation === "delete") return [];
  return Object.keys(payload).filter((key) => item.operation === "create" || JSON.stringify(item.before?.[key]) !== JSON.stringify(payload[key]));
}

export default function GenerationComposer({
  projectId,
  scope,
  targetId,
  taskKeys,
  placeholder,
  compact = false,
  actionLabel,
  getRefinementSnapshot,
}: {
  projectId: string;
  scope: NovelGenerationScope;
  targetId?: string;
  taskKeys?: NovelGenerationTaskKey[];
  placeholder?: string;
  compact?: boolean;
  actionLabel?: string;
  getRefinementSnapshot?: () => RefinementSnapshotInput | Promise<RefinementSnapshotInput>;
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
  const actionInFlight = useRef(false);
  const proposal = useLiveQuery(async () => {
    const items = await novelDb.proposals.where("projectId").equals(projectId).reverse().sortBy("createdAt");
    return items.find((item) => item.status === "pending"
      && item.scope === scope
      && (!taskKeys || (item.taskKey && taskKeys.includes(item.taskKey)))
      && (targetId ? item.targetId === targetId : !item.targetId)) ?? null;
  }, [projectId, scope, targetId, taskKeys], null);
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedFields, setSelectedFields] = useState<Record<string, string[]>>({});
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [reviewingItemId, setReviewingItemId] = useState<string>();
  const refinementAvailable = useLiveQuery(async () => {
    if (!task?.refinable) return false;
    const snapshot = await buildRefinementSnapshot({ projectId, taskKey: task.key, targetId });
    return Object.values(snapshot).some((records) => Boolean(records?.length));
  }, [projectId, task?.key, targetId], false);

  useEffect(() => {
    if (!task || task.key === taskKey) return;
    setTaskKey(task.key);
  }, [task, taskKey]);
  useEffect(() => {
    if (!proposal?.taskKey || proposal.taskKey === taskKey || !tasks.some((item) => item.key === proposal.taskKey)) return;
    setTaskKey(proposal.taskKey);
  }, [proposal?.taskKey, taskKey, tasks]);
  useEffect(() => {
    if (!task) return;
    setInstruction(task.defaultInstruction);
  }, [task?.key]);
  useEffect(() => {
    if (!proposal) { setSelected([]); setSelectedFields({}); setDrafts({}); setReviewingItemId(undefined); return; }
    const pendingItems = proposal.items.filter((item) => item.status === "pending");
    setSelected(pendingItems.map((item) => item.id));
    setSelectedFields(Object.fromEntries(pendingItems
      .filter((item) => item.operation === "update")
      .map((item) => [item.id, changedFieldsFor(item, item.payload)])));
    setDrafts(Object.fromEntries(proposal.items.map((item) => [item.id, structuredClone(item.payload)])));
  }, [proposal?.id, proposal?.revision]);

  async function perform(action: () => Promise<unknown>, success?: string) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    try { await action(); if (success) message.success(success); }
    catch (error) { message.error(error instanceof Error ? error.message : "操作失败"); }
    finally { actionInFlight.current = false; setBusy(false); }
  }

  async function generate() {
    if (!task || busy || proposal) return;
    await perform(() => runGenerationTask({ projectId, taskKey: task.key, instruction: instruction.trim() || task.defaultInstruction, targetId }), "候选内容已生成，请审核");
  }

  async function refine() {
    if (!task || busy || proposal) return;
    if (!instruction.trim()) { message.warning("请输入具体的微调要求"); return; }
    const sourceOverrides = await getRefinementSnapshot?.();
    await perform(() => runRefinementTask({ projectId, taskKey: task.key, instruction, targetId, sourceOverrides }), "微调候选已生成，请审核");
  }

  async function apply() {
    if (!proposal) return;
    for (const id of selected) {
      const item = proposal.items.find((candidate) => candidate.id === id);
      if (!item) continue;
      if (item.operation === "delete") continue;
      const payload = drafts[id];
      if (!payload) throw new Error(`“${item.label}”缺少候选数据`);
      await updateProposalItemPayload(proposal.id, id, payload);
    }
    let sourceFingerprint: string | undefined;
    if (proposal.generationMode === "refine" && proposal.taskKey) {
      const sourceOverrides = await getRefinementSnapshot?.();
      const snapshot = await buildRefinementSnapshot({ projectId, taskKey: proposal.taskKey, targetId: proposal.targetId, sourceOverrides });
      sourceFingerprint = await fingerprintRefinementSnapshot(snapshot);
    }
    const result = await applyProposalItems(proposal.id, selected, { sourceFingerprint, selectedFields });
    const detail = `${result.conflicts ? `，${result.conflicts} 项因版本冲突未写入` : ""}${result.embeddingFailures ? `，${result.embeddingFailures} 项语义索引待重试` : ""}`;
    result.embeddingFailures ? message.warning(`已采纳 ${result.applied} 项${detail}`) : message.success(`已采纳 ${result.applied} 项${detail}`);
  }

  async function rejectAndRegenerate() {
    if (!proposal) return;
    await rejectProposal(proposal.id);
    const sourceOverrides = await getRefinementSnapshot?.();
    if (proposal.generationMode === "refine") await runRefinementTask({ projectId, taskKey: proposal.taskKey!, instruction, targetId, sourceOverrides });
    else await runGenerationTask({ projectId, taskKey: proposal.taskKey!, instruction, targetId });
  }

  const reviewingItem = proposal?.items.find((item) => item.id === reviewingItemId);
  const pendingItems = proposal?.items.filter((item) => item.status === "pending") ?? [];

  function selectAll(checked: boolean) {
    if (!proposal || !checked) {
      setSelected([]);
      setSelectedFields({});
      return;
    }
    setSelected(pendingItems.map((item) => item.id));
    setSelectedFields(Object.fromEntries(pendingItems
      .filter((item) => item.operation === "update")
      .map((item) => [item.id, changedFieldsFor(item, drafts[item.id] ?? item.payload)])));
  }

  function selectItem(item: ProposalItem, checked: boolean, changedFields: string[]) {
    setSelected((current) => checked ? Array.from(new Set([...current, item.id])) : current.filter((id) => id !== item.id));
    if (item.operation === "update") setSelectedFields((current) => ({ ...current, [item.id]: checked ? changedFields : [] }));
  }

  function selectField(item: ProposalItem, field: string, checked: boolean) {
    const currentFields = selectedFields[item.id] ?? [];
    const nextFields = checked ? Array.from(new Set([...currentFields, field])) : currentFields.filter((key) => key !== field);
    setSelectedFields((current) => ({ ...current, [item.id]: nextFields }));
    setSelected((current) => nextFields.length
      ? Array.from(new Set([...current, item.id]))
      : current.filter((id) => id !== item.id));
  }

  return <section className={`novel-generation-composer${compact ? " compact" : ""}${tasks.length === 1 ? " single-task" : ""}`}>
    <div className="novel-generation-command">
      {tasks.length > 1 && <Select value={taskKey} disabled={Boolean(proposal)} onChange={(value) => setTaskKey(value)} options={tasks.map((item) => ({ value: item.key, label: item.label }))} />}
      <Input.TextArea autoSize={{ minRows: compact ? 1 : 2, maxRows: 7 }} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={placeholder || "输入一句创意、补充要求或要完成的任务"} />
      <div className="novel-generation-actions">
        <Button
          className={`novel-generation-trigger${busy || proposal ? " active" : ""}`}
          type="primary"
          icon={<ThunderboltOutlined />}
          loading={busy}
          disabled={busy || Boolean(proposal)}
          aria-label={busy ? "正在生成" : proposal ? "等待审核" : actionLabel || "开始生成任务"}
          title={busy ? "正在生成" : proposal ? "等待审核" : actionLabel || "开始生成任务"}
          onClick={() => void generate()}
        >
          {busy ? "正在生成" : proposal ? "等待审核" : actionLabel || "生成"}
        </Button>
        {task?.refinable && <Button className="novel-refinement-trigger" icon={<EditOutlined />} disabled={busy || Boolean(proposal) || !refinementAvailable || !instruction.trim()} title={!refinementAvailable ? "当前板块还没有可微调的数据" : "根据提示词微调当前结构化内容"} onClick={() => void refine()}>微调</Button>}
      </div>
    </div>
    {proposal && <div className="novel-generation-review">
      <header><div><Tag color="gold">待审核</Tag><strong>{proposal.title}</strong><small>{proposal.items.length} 个候选项</small></div><Checkbox checked={selected.length > 0 && selected.length === pendingItems.length} indeterminate={selected.length > 0 && selected.length < pendingItems.length} onChange={(event) => selectAll(event.target.checked)}>全选</Checkbox></header>
      <div className="novel-generation-items">{proposal.items.map((item) => {
        const draft = drafts[item.id] ?? item.payload;
        const changedFields = changedFieldsFor(item, draft);
        const selectedItemFields = selectedFields[item.id] ?? [];
        return <article key={item.id} className={`${item.status === "conflict" ? "conflict" : ""}${item.operation === "delete" ? " delete-candidate" : ""}`}>
        <header><Checkbox disabled={item.status === "conflict"} checked={selected.includes(item.id)} indeterminate={item.operation === "update" && selectedItemFields.length > 0 && selectedItemFields.length < changedFields.length} onChange={(event) => selectItem(item, event.target.checked, changedFields)} /><div><strong>{item.label}</strong><small>{item.status === "conflict" ? "版本冲突 · 请重新生成" : item.operation === "create" ? "新增" : item.operation === "delete" ? "删除" : "更新"} · {item.targetTable}</small></div><div className="novel-candidate-actions"><Button type="text" icon={<ReloadOutlined />} loading={busy} aria-label="重新生成本项" title="重新生成本项" onClick={() => void perform(async () => { await regenerateProposalItem(proposal.id, item.id, instruction, await getRefinementSnapshot?.()); }, "该候选项已重新生成")} /><Button type="text" icon={<ArrowsAltOutlined />} aria-label="打开完整预览" title="打开完整预览" onClick={() => setReviewingItemId(item.id)} /></div></header>
        <p>{item.rationale}</p>
        {item.operation === "delete"
          ? <div className="novel-delete-impact"><strong>采纳后将删除此项</strong>{item.impact?.length ? <ul>{item.impact.map((impact) => <li key={impact}>{impact}</li>)}</ul> : <span>没有检测到其他结构化引用</span>}</div>
          : <div className="novel-candidate-summary"><span>{item.operation === "create" ? "包含字段" : "变更字段"}</span><div>{changedFields.slice(0, 8).map((key) => item.operation === "update"
            ? <Checkbox key={key} checked={selectedItemFields.includes(key)} disabled={item.status === "conflict"} onChange={(event) => selectField(item, key, event.target.checked)}>{fieldLabel(key)}</Checkbox>
            : <Tag key={key}>{fieldLabel(key)}</Tag>)}{changedFields.length > 8 && <small>+{changedFields.length - 8}</small>}</div></div>}
        <footer><Button icon={<ArrowsAltOutlined />} onClick={() => setReviewingItemId(item.id)}>查看完整预览</Button></footer>
      </article>;
      })}</div>
      <footer><Button icon={<CloseOutlined />} disabled={busy} onClick={() => void perform(rejectAndRegenerate, "已退回并重新生成")}>退回重生成</Button><Button type="primary" icon={<CheckCircleOutlined />} loading={busy} disabled={!selected.length} onClick={() => void perform(apply)}>采纳所选（{selected.length}）</Button></footer>
    </div>}
    <ProposalReviewDialog item={reviewingItem} draft={reviewingItem ? drafts[reviewingItem.id] : undefined} open={Boolean(reviewingItem)} onClose={() => setReviewingItemId(undefined)} onChange={(next) => {
      if (!reviewingItem) return;
      setDrafts((current) => ({ ...current, [reviewingItem.id]: next }));
      if (reviewingItem.operation === "update") {
        const changedFields = changedFieldsFor(reviewingItem, next);
        setSelectedFields((current) => ({ ...current, [reviewingItem.id]: changedFields }));
        setSelected((current) => changedFields.length ? Array.from(new Set([...current, reviewingItem.id])) : current.filter((id) => id !== reviewingItem.id));
      }
    }} />
  </section>;
}
