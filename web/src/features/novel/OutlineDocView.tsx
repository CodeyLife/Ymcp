import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Alert, App, Button, Dropdown, Empty, Input, Modal, Select, Tag, Tooltip } from "antd";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CaretDownOutlined,
  CaretRightOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  DeleteOutlined,
  LoadingOutlined,
  PlusOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import { AnimatePresence, motion } from "motion/react";

import { addOutlineNode, appendOperation, deleteOutlineBranch, normalizeArchitecturePhases, novelDb } from "./db";
import { applyProposalItems, rejectProposal, runGenerationTask } from "./generation";
import OutlineProposalReview from "./OutlineProposalReview";
import { analyzeOutlineStructure, type OutlineStructureIssue } from "./outline-structure";
import type { AIProposal, Foreshadowing, OutlineKind, OutlineNode, PlotThread, StoryEntity } from "./types";

const FIELD_OPTIONS = [
  { value: "title", label: "标题" },
  { value: "summary", label: "概要" },
  { value: "causality", label: "因为(因果)" },
  { value: "outcome", label: "导致(结果)" },
];

const KIND_LABEL: Record<OutlineKind, string> = { act: "幕", sequence: "序列", event: "事件" };
const KIND_COLOR: Record<OutlineKind, string> = { act: "#722ed1", sequence: "#1677ff", event: "#13c2c2" };
const KIND_DEPTH: Record<OutlineKind, number> = { act: 0, sequence: 1, event: 2 };
const KIND_CHILD: Record<OutlineKind, OutlineKind | null> = { act: "sequence", sequence: "event", event: null };
const STATUS_OPTIONS = [
  { value: "idea", label: "构思" },
  { value: "planned", label: "已规划" },
  { value: "resolved", label: "已完成" },
];

function nextTitle(kind: OutlineKind, count: number): string {
  if (kind === "act") return `第${count + 1}幕`;
  if (kind === "sequence") return `序列 ${count + 1}`;
  return `事件 ${count + 1}`;
}

function compactReferenceLabels(node: OutlineNode, entities: StoryEntity[], threads: PlotThread[], clues: Foreshadowing[]) {
  const entityMap = new Map(entities.map((item) => [item.id, item.name]));
  const threadMap = new Map(threads.map((item) => [item.id, item.title]));
  const clueMap = new Map(clues.map((item) => [item.id, item.title]));
  return [
    ...node.characterIds.map((id) => entityMap.get(id) ?? "未知角色"),
    ...node.plotThreadIds.map((id) => threadMap.get(id) ?? "未知剧情线"),
    ...node.foreshadowingIds.map((id) => clueMap.get(id) ?? "未知伏笔"),
  ];
}

type InlineTextProps = {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  className?: string;
  style?: CSSProperties;
};

function InlineText({ value, onCommit, placeholder, multiline, rows = 1, className, style }: InlineTextProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = useCallback(() => {
    if (draft !== value) onCommit(draft);
  }, [draft, value, onCommit]);
  if (multiline) {
    return (
      <Input.TextArea
        className={className}
        style={style}
        value={draft}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        autoSize={{ minRows: rows, maxRows: 10 }}
      />
    );
  }
  return (
    <Input
      className={className}
      style={style}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
    />
  );
}

type BlockProps = {
  node: OutlineNode;
  nodes: OutlineNode[];
  entities: StoryEntity[];
  threads: PlotThread[];
  clues: Foreshadowing[];
  collapsedIds: Set<string>;
  toggleCollapse: (id: string) => void;
  onAddChild: (parent: OutlineNode, childKind: OutlineKind) => void;
  onMove: (node: OutlineNode, direction: -1 | 1) => void;
  onDelete: (nodeId: string) => void;
  onRewriteSubtree: (node: OutlineNode) => void;
  onReviseField: (node: OutlineNode) => void;
  sectionProposalMap: Map<string, AIProposal>;
  onAcceptSection: (proposalId: string) => void;
  onRejectSection: (proposalId: string) => void;
  sectionBusy: boolean;
};

function OutlineNodeBlock({
  node,
  nodes,
  entities,
  threads,
  clues,
  collapsedIds,
  toggleCollapse,
  onAddChild,
  onMove,
  onDelete,
  onRewriteSubtree,
  onReviseField,
  sectionProposalMap,
  onAcceptSection,
  onRejectSection,
  sectionBusy,
}: BlockProps) {
  const { modal } = App.useApp();
  const sectionProposal = sectionProposalMap.get(node.id) ?? null;
  const children = useMemo(
    () => nodes.filter((item) => item.parentId === node.id).sort((a, b) => a.order - b.order),
    [nodes, node.id],
  );
  const collapsed = collapsedIds.has(node.id);
  const depth = KIND_DEPTH[node.kind];
  const childKind = KIND_CHILD[node.kind];
  const color = KIND_COLOR[node.kind];
  const compactRefs = compactReferenceLabels(node, entities, threads, clues);

  const update = useCallback(
    async (changes: Partial<OutlineNode>) => {
      const before = await novelDb.outlineNodes.get(node.id);
      if (!before) return;
      const next = { ...before, ...changes, revision: before.revision + 1, updatedAt: Date.now() };
      await novelDb.outlineNodes.put(next);
      await appendOperation(node.projectId, "outlineNodes", node.id, "update", { value: { before, after: next } });
    },
    [node.id, node.projectId],
  );

  const menuItems = [
    ...(childKind
      ? [{ key: "add-child", label: `添加${KIND_LABEL[childKind]}`, icon: <PlusOutlined /> }]
      : []),
    { key: "up", label: "上移", icon: <ArrowUpOutlined /> },
    { key: "down", label: "下移", icon: <ArrowDownOutlined /> },
    { key: "delete", label: "删除分支", icon: <DeleteOutlined />, danger: true },
    { type: "divider" as const, key: "div-llm" },
    { key: "llm-subtree", label: "LLM 重写子树", icon: <ThunderboltOutlined />, disabled: sectionBusy },
    { key: "llm-field", label: "LLM 改写字段", icon: <ThunderboltOutlined />, disabled: sectionBusy },
  ];

  const onMenuClick = useCallback(
    ({ key }: { key: string }) => {
      if (key === "add-child" && childKind) onAddChild(node, childKind);
      else if (key === "up") onMove(node, -1);
      else if (key === "down") onMove(node, 1);
      else if (key === "delete") {
        modal.confirm({
          title: `删除"${node.title}"?`,
          content: "将删除该节点及其所有子节点, 不影响章节正文。",
          okButtonProps: { danger: true },
          onOk: () => onDelete(node.id),
        });
      } else if (key === "llm-subtree") {
        onRewriteSubtree(node);
      } else if (key === "llm-field") {
        onReviseField(node);
      }
    },
    [childKind, node, onAddChild, onMove, onDelete, onRewriteSubtree, onReviseField, modal, sectionBusy],
  );

  return (
    <motion.article layout className="novel-outline-block" style={{ marginLeft: depth * 28 }}>
      <header className="novel-outline-block-header">
        <button
          type="button"
          className="novel-outline-collapse"
          onClick={() => toggleCollapse(node.id)}
          aria-label={collapsed ? "展开" : "折叠"}
        >
          {collapsed ? <CaretRightOutlined /> : <CaretDownOutlined />}
        </button>
        <Tag className="novel-outline-kind" color={color}>{KIND_LABEL[node.kind]}</Tag>
        <InlineText
          className="novel-outline-block-title"
          value={node.title}
          placeholder="节点标题"
          onCommit={(value) => void update({ title: value })}
        />
        <Select
          size="small"
          value={node.status}
          options={STATUS_OPTIONS}
          onChange={(status) => void update({ status })}
          style={{ minWidth: 96 }}
        />
        <Dropdown menu={{ items: menuItems, onClick: onMenuClick }} trigger={["click"]}>
          <Button type="text" size="small" icon={<CaretDownOutlined />} aria-label="节点操作" />
        </Dropdown>
      </header>

      {collapsed && node.kind === "event" && (
        <div className="novel-outline-event-compact">
          <p>{node.summary || "尚未填写事件概要"}</p>
          {compactRefs.length > 0 && <div>{compactRefs.slice(0, 5).map((label, index) => <Tag key={`${label}-${index}`}>{label}</Tag>)}{compactRefs.length > 5 && <small>+{compactRefs.length - 5}</small>}</div>}
        </div>
      )}

      <AnimatePresence initial={false}>
        {sectionProposal && (
          <motion.div
            className="novel-outline-section-review"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <header className="novel-outline-section-review-header">
              <Tag color="gold">{sectionProposal.taskKey === "outline-field-revise" ? "字段修订提议" : "子树重写提议"}</Tag>
              <span>{sectionProposal.items.length} 个候选项</span>
              <div className="novel-outline-section-review-actions">
                <Button
                  size="small"
                  icon={sectionBusy ? <LoadingOutlined /> : <CheckCircleOutlined />}
                  loading={sectionBusy}
                  onClick={() => onAcceptSection(sectionProposal.id)}
                >
                  采纳替换
                </Button>
                <Button
                  size="small"
                  danger
                  icon={<CloseOutlined />}
                  disabled={sectionBusy}
                  onClick={() => onRejectSection(sectionProposal.id)}
                >
                  拒绝
                </Button>
              </div>
            </header>
            <p className="novel-outline-section-review-summary">{sectionProposal.previewMarkdown.split("\n\n").slice(1).join("\n\n") || sectionProposal.title}</p>
            <div className="novel-outline-section-review-items">
              {sectionProposal.items.map((item) => (
                <div key={item.id} className="novel-outline-section-review-item">
                  <Tag color={item.operation === "create" ? "green" : "blue"}>
                    {item.operation === "create" ? "新增" : "更新"}
                  </Tag>
                  <strong>{item.label}</strong>
                  <span className="novel-outline-section-review-item-rationale">{item.rationale}</span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            className="novel-outline-block-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <InlineText
              multiline
              rows={2}
              className="novel-outline-block-summary"
              value={node.summary}
              placeholder="这一节点发生什么"
              onCommit={(value) => void update({ summary: value })}
            />
            <div className="novel-outline-refs">
              <Select
                mode="multiple"
                placeholder="关联角色"
                value={node.characterIds}
                maxTagCount="responsive"
                options={entities.filter((item) => item.kind === "character").map((item) => ({ value: item.id, label: item.name }))}
                onChange={(characterIds) => void update({ characterIds })}
              />
              <Select
                mode="multiple"
                placeholder="剧情线"
                value={node.plotThreadIds}
                maxTagCount="responsive"
                options={threads.map((item) => ({ value: item.id, label: item.title }))}
                onChange={(plotThreadIds) => void update({ plotThreadIds })}
              />
              <Select
                mode="multiple"
                placeholder="伏笔"
                value={node.foreshadowingIds}
                maxTagCount="responsive"
                options={clues.map((item) => ({ value: item.id, label: item.title }))}
                onChange={(foreshadowingIds) => void update({ foreshadowingIds })}
              />
              <Input
                placeholder="故事时间"
                value={node.storyTime ?? ""}
                onChange={(event) => void update({ storyTime: event.target.value })}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {!collapsed && children.length > 0 && (
          <motion.div className="novel-outline-children" layout>
            {children.map((child) => (
              <OutlineNodeBlock
                key={child.id}
                node={child}
                nodes={nodes}
                entities={entities}
                threads={threads}
                clues={clues}
                collapsedIds={collapsedIds}
                toggleCollapse={toggleCollapse}
                onAddChild={onAddChild}
                onMove={onMove}
                onDelete={onDelete}
                onRewriteSubtree={onRewriteSubtree}
                onReviseField={onReviseField}
                sectionProposalMap={sectionProposalMap}
                onAcceptSection={onAcceptSection}
                onRejectSection={onRejectSection}
                sectionBusy={sectionBusy}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}

function RecoveryNodeRow({
  node,
  issue,
  validNodes,
  onRepair,
  onDelete,
}: {
  node: OutlineNode;
  issue?: OutlineStructureIssue;
  validNodes: OutlineNode[];
  onRepair: (node: OutlineNode, parentId?: string) => void;
  onDelete: (nodeId: string) => void;
}) {
  const candidates = validNodes.filter((item) => item.kind === (node.kind === "sequence" ? "act" : "sequence") && item.id !== node.id);
  const [parentId, setParentId] = useState<string>();
  useEffect(() => { setParentId(candidates[0]?.id); }, [node.id, candidates[0]?.id]);
  return (
    <div className="novel-outline-recovery-row">
      <Tag color={KIND_COLOR[node.kind]}>{KIND_LABEL[node.kind]}</Tag>
      <div><strong>{node.title}</strong><span>{issue?.message ?? "无法进入有效大纲树"}</span></div>
      {node.kind === "act" ? (
        <Button size="small" onClick={() => onRepair(node, undefined)}>设为根幕</Button>
      ) : (
        <div className="novel-outline-recovery-parent">
          <Select size="small" value={parentId} placeholder={node.kind === "sequence" ? "选择所属幕" : "选择所属序列"} options={candidates.map((item) => ({ value: item.id, label: item.title }))} onChange={setParentId} />
          <Button size="small" disabled={!parentId} onClick={() => onRepair(node, parentId)}>归入</Button>
        </div>
      )}
      <Button danger type="text" size="small" icon={<DeleteOutlined />} aria-label={`删除${node.title}`} onClick={() => onDelete(node.id)} />
    </div>
  );
}

function OutlineRecoveryPanel({
  invalidNodes,
  validNodes,
  issues,
  onRepair,
  onDelete,
  onNormalizeOrders,
}: {
  invalidNodes: OutlineNode[];
  validNodes: OutlineNode[];
  issues: OutlineStructureIssue[];
  onRepair: (node: OutlineNode, parentId?: string) => void;
  onDelete: (nodeId: string) => void;
  onNormalizeOrders: () => void;
}) {
  const issueMap = new Map(issues.map((issue) => [issue.nodeId, issue]));
  const duplicateOrders = issues.filter((issue) => issue.code === "duplicate-order");
  if (!invalidNodes.length && !duplicateOrders.length) return null;
  return (
    <section className="novel-outline-recovery" aria-label="未归类大纲内容">
      <header><div><span>STRUCTURE CHECK</span><h3>未归类内容</h3><p>这些节点仍保留在本地，但当前父子关系无法进入正式大纲。</p></div><Tag color="warning">{invalidNodes.length + duplicateOrders.length} 项异常</Tag></header>
      {duplicateOrders.length > 0 && <Alert type="warning" showIcon message="检测到同级顺序重复" description={<Button size="small" onClick={onNormalizeOrders}>按当前显示顺序重新编号</Button>} />}
      <div className="novel-outline-recovery-list">{invalidNodes.map((node) => <RecoveryNodeRow key={node.id} node={node} issue={issueMap.get(node.id)} validNodes={validNodes} onRepair={onRepair} onDelete={onDelete} />)}</div>
    </section>
  );
}

export default function OutlineDocView({ projectId }: { projectId: string }) {
  const { message, modal } = App.useApp();
  const nodes = useLiveQuery(() => novelDb.outlineNodes.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const entities = useLiveQuery(() => novelDb.entities.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const threads = useLiveQuery(() => novelDb.plotThreads.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const clues = useLiveQuery(() => novelDb.foreshadowing.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const architecture = useLiveQuery(() => novelDb.architectures.where("projectId").equals(projectId).first(), [projectId]);
  const fullProposal = useLiveQuery(async () => {
    const all = await novelDb.proposals.where("projectId").equals(projectId).reverse().sortBy("createdAt");
    return all.find((item) => item.status === "pending" && item.taskKey === "outline" && !item.targetId) ?? null;
  }, [projectId], null);
  const sectionProposals = useLiveQuery(async () => {
    const all = await novelDb.proposals.where("projectId").equals(projectId).reverse().sortBy("createdAt");
    return all.filter((item) => item.status === "pending" && (item.taskKey === "outline-section-update" || item.taskKey === "outline-field-revise"));
  }, [projectId]) ?? [];

  const sectionProposalMap = useMemo(() => {
    const map = new Map<string, AIProposal>();
    for (const proposal of sectionProposals) {
      if (proposal.targetId) map.set(proposal.targetId, proposal);
    }
    return map;
  }, [sectionProposals]);

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [sectionBusy, setSectionBusy] = useState(false);
  const [rewriteTarget, setRewriteTarget] = useState<OutlineNode | null>(null);
  const [rewriteInstruction, setRewriteInstruction] = useState("");
  const [fieldReviseTarget, setFieldReviseTarget] = useState<OutlineNode | null>(null);
  const [fieldReviseField, setFieldReviseField] = useState<string>("summary");
  const [fieldReviseInstruction, setFieldReviseInstruction] = useState("");
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generationBusy, setGenerationBusy] = useState(false);
  const [generationInstruction, setGenerationInstruction] = useState("为下一幕规划完整的序列与事件。先铺陈人物处境、世态背景与情感底色，让因果、转折与伏笔在事件流中自然浮现。");
  const generationAbortRef = useRef<AbortController | null>(null);
  const knownNodeIds = useRef<Set<string>>(new Set());
  const structure = useMemo(() => analyzeOutlineStructure(nodes), [nodes]);
  const roots = structure.roots;
  const validNodes = structure.validNodes;
  const nextActTarget = useMemo(() => {
    const occupiedOrders = new Set(roots.filter((node) => node.kind === "act").map((node) => node.order));
    const phases = normalizeArchitecturePhases(architecture?.phases ?? []);
    if (phases.length) {
      const phase = phases.find((item) => !occupiedOrders.has(item.order));
      return phase ? { order: phase.order, title: phase.title, phaseCount: phases.length } : null;
    }
    let order = 0;
    while (occupiedOrders.has(order)) order += 1;
    return { order, phaseCount: 0 };
  }, [architecture?.phases, roots]);
  const allArchitecturePhasesGenerated = Boolean(architecture?.phases.length) && !nextActTarget;
  const nextActLabel = nextActTarget?.title ? `第 ${nextActTarget.order + 1} 幕「${nextActTarget.title}」` : `第 ${(nextActTarget?.order ?? 0) + 1} 幕`;

  useEffect(() => {
    const known = knownNodeIds.current;
    const newEvents = nodes.filter((node) => node.kind === "event" && !known.has(node.id)).map((node) => node.id);
    if (newEvents.length) setCollapsedIds((current) => new Set([...current, ...newEvents]));
    knownNodeIds.current = new Set(nodes.map((node) => node.id));
  }, [nodes]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => setCollapsedIds(new Set()), []);
  const collapseAll = useCallback(() => setCollapsedIds(new Set(nodes.map((item) => item.id))), [nodes]);

  const addRoot = useCallback(
    async (kind: OutlineKind) => {
      const siblings = roots.filter((item) => item.kind === kind);
      await addOutlineNode(projectId, undefined, kind, nextTitle(kind, siblings.length), siblings.length);
      message.success(`已添加${KIND_LABEL[kind]}`);
    },
    [projectId, roots, message],
  );

  const onAddChild = useCallback(
    async (parent: OutlineNode, childKind: OutlineKind) => {
      const siblings = nodes.filter((item) => item.parentId === parent.id && item.kind === childKind);
      await addOutlineNode(projectId, parent.id, childKind, nextTitle(childKind, siblings.length), siblings.length);
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        next.delete(parent.id);
        return next;
      });
      message.success(`已添加${KIND_LABEL[childKind]}`);
    },
    [projectId, nodes, message],
  );

  const onMove = useCallback(
    async (node: OutlineNode, direction: -1 | 1) => {
      const siblings = nodes
        .filter((item) => item.parentId === node.parentId && item.kind === node.kind)
        .sort((a, b) => a.order - b.order);
      const index = siblings.findIndex((item) => item.id === node.id);
      const target = siblings[index + direction];
      if (!target) return;
      await novelDb.outlineNodes.bulkPut([
        { ...node, order: target.order, revision: node.revision + 1, updatedAt: Date.now() },
        { ...target, order: node.order, revision: target.revision + 1, updatedAt: Date.now() },
      ]);
    },
    [nodes],
  );

  const onDelete = useCallback(
    async (nodeId: string) => {
      await deleteOutlineBranch(projectId, nodeId);
      message.success("已删除");
    },
    [projectId, message],
  );

  const onRepairParent = useCallback(
    async (node: OutlineNode, parentId?: string) => {
      const before = await novelDb.outlineNodes.get(node.id);
      if (!before) return;
      const next = { ...before, parentId, revision: before.revision + 1, updatedAt: Date.now() };
      await novelDb.outlineNodes.put(next);
      await appendOperation(projectId, "outlineNodes", node.id, "update", { value: { before, after: next } });
      message.success(`“${node.title}”已重新归类`);
    },
    [projectId, message],
  );

  const normalizeOrders = useCallback(async () => {
    const groups = new Map<string, OutlineNode[]>();
    for (const node of validNodes) {
      const key = `${node.parentId ?? "root"}:${node.kind}`;
      const group = groups.get(key) ?? [];
      group.push(node);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const ordered = group.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
      for (const [order, node] of ordered.entries()) {
        if (node.order === order) continue;
        const next = { ...node, order, revision: node.revision + 1, updatedAt: Date.now() };
        await novelDb.outlineNodes.put(next);
        await appendOperation(projectId, "outlineNodes", node.id, "update", { value: { before: node, after: next } });
      }
    }
    message.success("同级节点顺序已重新编号");
  }, [projectId, validNodes, message]);

  const executeNextActGeneration = useCallback(async () => {
    const controller = new AbortController();
    generationAbortRef.current = controller;
    setGenerationBusy(true);
    try {
      await runGenerationTask({ projectId, taskKey: "outline", instruction: generationInstruction.trim(), signal: controller.signal });
      setGenerateOpen(false);
      message.success(`${nextActLabel}候选已生成，请审核后追加`);
    } catch (error) {
      if (!controller.signal.aborted) message.error(error instanceof Error ? error.message : "单幕生成失败");
    } finally {
      if (generationAbortRef.current === controller) generationAbortRef.current = null;
      setGenerationBusy(false);
    }
  }, [projectId, generationInstruction, message, nextActLabel]);

  const closeGenerationModal = useCallback(() => {
    generationAbortRef.current?.abort();
    setGenerateOpen(false);
  }, []);

  const onRewriteSubtree = useCallback((node: OutlineNode) => {
    setRewriteTarget(node);
    setRewriteInstruction(node.summary || `重写"${node.title}"及其子树, 保持兄弟节点不变。`);
  }, []);

  const executeRewrite = useCallback(
    async (instruction: string) => {
      if (!rewriteTarget) return;
      setSectionBusy(true);
      try {
        await runGenerationTask({
          projectId,
          taskKey: "outline-section-update",
          targetId: rewriteTarget.id,
          instruction: instruction.trim() || `重写"${rewriteTarget.title}"及其子树。`,
        });
        setCollapsedIds((prev) => { const next = new Set(prev); next.delete(rewriteTarget.id); return next; });
        message.success("子树重写提议已生成, 请在节点下方审核");
      } catch (error) {
        message.error(error instanceof Error ? error.message : "LLM 重写失败");
      } finally {
        setSectionBusy(false);
        setRewriteTarget(null);
      }
    },
    [projectId, rewriteTarget, message],
  );

  const onReviseField = useCallback((node: OutlineNode) => {
    setFieldReviseTarget(node);
    setFieldReviseField("summary");
    setFieldReviseInstruction("");
  }, []);

  const executeFieldRevise = useCallback(
    async (field: string, instruction: string) => {
      if (!fieldReviseTarget) return;
      setSectionBusy(true);
      try {
        await runGenerationTask({
          projectId,
          taskKey: "outline-field-revise",
          targetId: fieldReviseTarget.id,
          targetField: field,
          instruction: instruction.trim() || `改写"${fieldReviseTarget.title}"的${field}字段。`,
        });
        message.success("字段修订提议已生成, 请在节点下方审核");
      } catch (error) {
        message.error(error instanceof Error ? error.message : "LLM 字段改写失败");
      } finally {
        setSectionBusy(false);
        setFieldReviseTarget(null);
      }
    },
    [projectId, fieldReviseTarget, message],
  );

  const onAcceptSection = useCallback(
    async (proposalId: string) => {
      setSectionBusy(true);
      try {
        const proposal = await novelDb.proposals.get(proposalId);
        if (!proposal) throw new Error("提议不存在");
        const result = await applyProposalItems(proposalId, proposal.items.map((item) => item.id));
        const detail = result.conflicts ? `，${result.conflicts} 项冲突` : "";
        message.success(`子树已替换 (${result.applied} 项${detail})`);
      } catch (error) {
        message.error(error instanceof Error ? error.message : "采纳失败");
      } finally {
        setSectionBusy(false);
      }
    },
    [message],
  );

  const onRejectSection = useCallback(
    async (proposalId: string) => {
      setSectionBusy(true);
      try {
        await rejectProposal(proposalId);
        message.success("已拒绝子树重写提议");
      } catch (error) {
        message.error(error instanceof Error ? error.message : "拒绝失败");
      } finally {
        setSectionBusy(false);
      }
    },
    [message],
  );

  const generationModal = (
    <Modal
      title={`生成${nextActLabel}`}
      open={generateOpen}
      onCancel={closeGenerationModal}
      confirmLoading={generationBusy}
      okText="生成这一幕"
      cancelText="取消"
      onOk={() => void executeNextActGeneration()}
    >
      <Alert type="info" showIcon message={`本次只生成${nextActLabel}`} description="生成结果先进入审核；采纳后只追加这一幕，不会修改或删除已有大纲。" />
      <Input.TextArea className="novel-outline-generation-instruction" autoSize={{ minRows: 4, maxRows: 9 }} value={generationInstruction} onChange={(event) => setGenerationInstruction(event.target.value)} placeholder="描述故事脉络、人物处境、世态背景与情感走向，可附关键转折但不必写尽" />
    </Modal>
  );

  if (fullProposal) {
    return <>
      <OutlineProposalReview proposal={fullProposal} replacingCount={nodes.length} entities={entities} threads={threads} clues={clues} onRegenerate={() => setGenerateOpen(true)} />
      {generationModal}
    </>;
  }

  return (
    <div className="novel-outline-workspace">
      <header className="novel-section-title">
        <div>
          <span>STORY OUTLINE</span>
          <h2>故事大纲</h2>
          <p>按幕、序列和事件铺陈故事——人物处境、世态人情、情感底色先行, 因果与转折在事件流中自然浮现。整棵大纲以文档形式同屏呈现, 直接在节点上内联编辑。这里不创建章节, 也不持有正文。</p>
        </div>
        <div className="novel-outline-header-actions">
          {roots.length > 0 && (
            <>
              <Button size="small" onClick={expandAll}>展开全部</Button>
              <Button size="small" onClick={collapseAll}>折叠全部</Button>
            </>
          )}
          <Button icon={<PlusOutlined />} onClick={() => void addRoot("act")}>添加幕</Button>
          <Tooltip title={allArchitecturePhasesGenerated ? "全部架构阶段均已生成，请重写已有幕或先扩展全书架构" : `生成${nextActLabel}`}><span><Button type="primary" icon={<ThunderboltOutlined />} disabled={allArchitecturePhasesGenerated} onClick={() => setGenerateOpen(true)}>生成下一幕</Button></span></Tooltip>
        </div>
      </header>

      <OutlineRecoveryPanel
        invalidNodes={structure.invalidNodes}
        validNodes={validNodes}
        issues={structure.issues}
        onRepair={(node, parentId) => void onRepairParent(node, parentId)}
        onDelete={(nodeId) => modal.confirm({ title: "删除未归类节点？", content: "将删除该节点及其下级内容。", okText: "删除", okButtonProps: { danger: true }, onOk: () => onDelete(nodeId) })}
        onNormalizeOrders={() => void normalizeOrders()}
      />

      {roots.length === 0 ? (
        <div className="novel-empty-panel">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <>
                <strong>尚无故事大纲</strong>
                <span>先添加一幕手动规划，或生成下一幕的完整序列与事件结构。</span>
                <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => setGenerateOpen(true)}>生成下一幕</Button>
              </>
            }
          />
        </div>
      ) : (
        <div className="novel-outline-doc">
          {roots.map((node) => (
            <OutlineNodeBlock
              key={node.id}
              node={node}
              nodes={validNodes}
              entities={entities}
              threads={threads}
              clues={clues}
              collapsedIds={collapsedIds}
              toggleCollapse={toggleCollapse}
              onAddChild={onAddChild}
              onMove={onMove}
              onDelete={onDelete}
              onRewriteSubtree={onRewriteSubtree}
              onReviseField={onReviseField}
              sectionProposalMap={sectionProposalMap}
              onAcceptSection={onAcceptSection}
              onRejectSection={onRejectSection}
              sectionBusy={sectionBusy}
            />
          ))}
        </div>
      )}

      {generationModal}

      <Modal
        title={`LLM 重写子树 — ${rewriteTarget?.title ?? ""}`}
        open={Boolean(rewriteTarget)}
        onCancel={() => setRewriteTarget(null)}
        confirmLoading={sectionBusy}
        okText="开始重写"
        cancelText="取消"
        onOk={() => void executeRewrite(rewriteInstruction)}
      >
        <p style={{ color: "var(--novel-muted)", fontSize: 12, marginBottom: 8 }}>
          LLM 将重写该节点及其所有子节点。兄弟节点保持不变。重写后会出现审核面板, 可采纳或拒绝。
        </p>
        <Input.TextArea
          autoSize={{ minRows: 3, maxRows: 8 }}
          value={rewriteInstruction}
          onChange={(event) => setRewriteInstruction(event.target.value)}
          placeholder="输入重写要求, 例如: 增加冲突张力、改变因果方向、引入新角色..."
        />
      </Modal>

      <Modal
        title={`LLM 改写字段 — ${fieldReviseTarget?.title ?? ""}`}
        open={Boolean(fieldReviseTarget)}
        onCancel={() => setFieldReviseTarget(null)}
        confirmLoading={sectionBusy}
        okText="开始改写"
        cancelText="取消"
        onOk={() => void executeFieldRevise(fieldReviseField, fieldReviseInstruction)}
      >
        <p style={{ color: "var(--novel-muted)", fontSize: 12, marginBottom: 8 }}>
          LLM 将仅改写所选字段, 其他字段保持不变。改写后会出现审核面板, 可采纳或拒绝。
        </p>
        <div style={{ marginBottom: 12 }}>
          <Select
            style={{ width: "100%" }}
            value={fieldReviseField}
            onChange={setFieldReviseField}
            options={FIELD_OPTIONS}
          />
        </div>
        <Input.TextArea
          autoSize={{ minRows: 3, maxRows: 8 }}
          value={fieldReviseInstruction}
          onChange={(event) => setFieldReviseInstruction(event.target.value)}
          placeholder="输入改写要求, 例如: 更精炼、增加细节、改变语气..."
        />
      </Modal>
    </div>
  );
}
