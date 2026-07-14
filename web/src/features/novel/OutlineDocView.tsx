import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { App, Button, Dropdown, Empty, Input, InputNumber, Modal, Select, Tag } from "antd";
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

import GenerationComposer from "./GenerationComposer";
import { addOutlineNode, appendOperation, deleteOutlineBranch, novelDb } from "./db";
import { applyProposalItems, rejectProposal, runGenerationTask } from "./generation";
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
            <div className="novel-outline-causal-grid">
              <div className="novel-outline-causal">
                <label>因为</label>
                <InlineText
                  multiline
                  rows={2}
                  value={node.causality}
                  placeholder="它为什么发生, 与前序事件有何因果"
                  onCommit={(value) => void update({ causality: value })}
                />
              </div>
              <div className="novel-outline-causal">
                <label>导致</label>
                <InlineText
                  multiline
                  rows={2}
                  value={node.outcome}
                  placeholder="它造成什么不可逆结果"
                  onCommit={(value) => void update({ outcome: value })}
                />
              </div>
            </div>
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
            <div className="novel-outline-intensity">
              <label>张力<InputNumber min={0} max={100} value={node.tension} onChange={(value) => void update({ tension: value ?? 0 })} /></label>
              <label>情绪<InputNumber min={0} max={100} value={node.emotion} onChange={(value) => void update({ emotion: value ?? 0 })} /></label>
              <label>信息<InputNumber min={0} max={100} value={node.information} onChange={(value) => void update({ information: value ?? 0 })} /></label>
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

export default function OutlineDocView({ projectId }: { projectId: string }) {
  const { message } = App.useApp();
  const nodes = useLiveQuery(() => novelDb.outlineNodes.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const entities = useLiveQuery(() => novelDb.entities.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const threads = useLiveQuery(() => novelDb.plotThreads.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
  const clues = useLiveQuery(() => novelDb.foreshadowing.where("projectId").equals(projectId).toArray(), [projectId]) ?? [];
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
  const roots = useMemo(() => nodes.filter((item) => !item.parentId).sort((a, b) => a.order - b.order), [nodes]);

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

  return (
    <div>
      <GenerationComposer projectId={projectId} scope="outline" taskKeys={["outline"]} />
      <header className="novel-section-title">
        <div>
          <span>STORY OUTLINE</span>
          <h2>故事大纲</h2>
          <p>按幕、序列和事件组织故事因果; 整棵大纲以文档形式同屏呈现, 直接在节点上内联编辑。这里不创建章节, 也不持有正文。</p>
        </div>
        <div className="flex items-center gap-2">
          {roots.length > 0 && (
            <>
              <Button size="small" onClick={expandAll}>展开全部</Button>
              <Button size="small" onClick={collapseAll}>折叠全部</Button>
            </>
          )}
          <Button icon={<PlusOutlined />} onClick={() => void addRoot("act")}>幕</Button>
          <Button icon={<PlusOutlined />} onClick={() => void addRoot("sequence")}>序列</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => void addRoot("event")}>事件</Button>
        </div>
      </header>

      {roots.length === 0 ? (
        <div className="novel-empty-panel">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <>
                <strong>尚无故事大纲</strong>
                <span>使用上方"事件"按钮手动建立, 或在 GenerationComposer 中让 LLM 一次性生成大纲。</span>
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
        </div>
      )}

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
