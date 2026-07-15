import { useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Checkbox, Tag } from "antd";
import { CheckCircleOutlined, CloseOutlined, ReloadOutlined } from "@ant-design/icons";

import { applyProposalItems, rejectProposal } from "./generation";
import { analyzeOutlineProposal, type OutlineProposalNode } from "./outline-structure";
import type { AIProposal, Foreshadowing, PlotThread, StoryEntity } from "./types";

const KIND_LABEL = { act: "幕", sequence: "序列", event: "事件" } as const;
const KIND_COLOR = { act: "#a65c51", sequence: "#537e68", event: "#487a91" } as const;

function referenceLabels(ids: string[], values: Array<{ id: string; label: string }>) {
  const labels = new Map(values.map((item) => [item.id, item.label]));
  return ids.map((id) => labels.get(id) ?? "待关联");
}

function ProposalNodeRow({
  node,
  nodes,
  selected,
  onToggle,
  entities,
  threads,
  clues,
}: {
  node: OutlineProposalNode;
  nodes: OutlineProposalNode[];
  selected: Set<string>;
  onToggle: (nodeId: string, checked: boolean) => void;
  entities: StoryEntity[];
  threads: PlotThread[];
  clues: Foreshadowing[];
}) {
  const children = nodes.filter((item) => item.parentId === node.id).sort((a, b) => a.order - b.order);
  const refs = [
    ...referenceLabels(node.characterIds, entities.filter((item) => item.kind === "character").map((item) => ({ id: item.id, label: item.name }))),
    ...referenceLabels(node.plotThreadIds, threads.map((item) => ({ id: item.id, label: item.title }))),
    ...referenceLabels(node.foreshadowingIds, clues.map((item) => ({ id: item.id, label: item.title }))),
  ];
  return (
    <div className={`novel-outline-proposal-node is-${node.kind}${selected.has(node.proposalItemId) ? " selected" : " excluded"}`}>
      <div className="novel-outline-proposal-node-main">
        <Checkbox checked={selected.has(node.proposalItemId)} onChange={(event) => onToggle(node.id, event.target.checked)} />
        <Tag color={KIND_COLOR[node.kind]}>{KIND_LABEL[node.kind]}</Tag>
        <div className="novel-outline-proposal-copy">
          <strong>{node.title}</strong>
          <p className="novel-outline-proposal-summary">{node.summary || "尚未填写概要"}</p>
          {refs.length > 0 && <div className="novel-outline-proposal-refs">{refs.slice(0, 6).map((label, index) => <Tag key={`${label}-${index}`}>{label}</Tag>)}{refs.length > 6 && <small>+{refs.length - 6}</small>}</div>}
        </div>
        <small className="novel-outline-proposal-order">{String(node.order + 1).padStart(2, "0")}</small>
      </div>
      {children.length > 0 && <div className="novel-outline-proposal-children">{children.map((child) => <ProposalNodeRow key={child.id} node={child} nodes={nodes} selected={selected} onToggle={onToggle} entities={entities} threads={threads} clues={clues} />)}</div>}
    </div>
  );
}

export default function OutlineProposalReview({
  proposal,
  replacingCount,
  entities,
  threads,
  clues,
  onRegenerate,
}: {
  proposal: AIProposal;
  replacingCount: number;
  entities: StoryEntity[];
  threads: PlotThread[];
  clues: Foreshadowing[];
  onRegenerate: () => void;
}) {
  const { message, modal } = App.useApp();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const analysis = useMemo(() => analyzeOutlineProposal(proposal.items), [proposal.items]);
  useEffect(() => {
    setSelected(new Set(proposal.items.filter((item) => item.status === "pending").map((item) => item.id)));
  }, [proposal.id, proposal.revision, proposal.items]);

  const nodeMap = useMemo(() => new Map(analysis.nodes.map((node) => [node.id, node])), [analysis.nodes]);
  const selectedItems = proposal.items.filter((item) => selected.has(item.id));
  const selectedAnalysis = useMemo(() => analyzeOutlineProposal(selectedItems), [selectedItems]);

  function branchIds(nodeId: string) {
    const result = new Set<string>([nodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of analysis.nodes) {
        if (node.parentId && result.has(node.parentId) && !result.has(node.id)) {
          result.add(node.id);
          changed = true;
        }
      }
    }
    return result;
  }

  function toggleNode(nodeId: string, checked: boolean) {
    const affected = branchIds(nodeId);
    setSelected((current) => {
      const next = new Set(current);
      for (const affectedId of affected) {
        const itemId = nodeMap.get(affectedId)?.proposalItemId;
        if (!itemId) continue;
        if (checked) next.add(itemId);
        else next.delete(itemId);
      }
      if (checked) {
        let parentId = nodeMap.get(nodeId)?.parentId;
        while (parentId) {
          const parent = nodeMap.get(parentId);
          if (!parent) break;
          next.add(parent.proposalItemId);
          parentId = parent.parentId;
        }
      }
      return next;
    });
  }

  async function apply() {
    if (selectedAnalysis.issues.length) return;
    setBusy(true);
    try {
      const result = await applyProposalItems(proposal.id, [...selected]);
      message.success(`故事大纲已替换，共写入 ${result.applied} 个节点`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "采纳失败");
    } finally {
      setBusy(false);
    }
  }

  function discard(regenerate = false) {
    modal.confirm({
      title: regenerate ? "放弃当前候选并重新生成？" : "关闭当前候选大纲？",
      content: "正式大纲不会发生变化。",
      okText: regenerate ? "重新生成" : "关闭",
      okButtonProps: { danger: !regenerate },
      onOk: async () => {
        await rejectProposal(proposal.id);
        if (regenerate) onRegenerate();
      },
    });
  }

  const uniqueErrors = [...new Set(selectedAnalysis.issues.map((issue) => issue.message))];
  return (
    <section className="novel-outline-review-mode" aria-label="故事大纲审核">
      <header className="novel-outline-review-header">
        <div><span>OUTLINE REVIEW</span><h2>审核完整大纲</h2><p>候选内容按真实层级呈现。取消某个幕或序列时，其下级节点会一并取消。</p></div>
        <Tag color="gold">{selected.size} / {proposal.items.length} 个节点</Tag>
      </header>
      {replacingCount > 0 && <Alert type="warning" showIcon message={`采纳后将整体替换当前 ${replacingCount} 个大纲节点`} description="章节正文不会受到影响；剧情线和伏笔中指向旧大纲节点的定位会被清除。" />}
      {uniqueErrors.length > 0 && <Alert type="error" showIcon message="当前选择无法形成完整大纲" description={uniqueErrors.join("；")} />}
      <div className="novel-outline-review-tree">
        {analysis.roots.map((root) => <ProposalNodeRow key={root.id} node={root} nodes={analysis.nodes} selected={selected} onToggle={toggleNode} entities={entities} threads={threads} clues={clues} />)}
      </div>
      <footer className="novel-outline-review-footer">
        <div><Button icon={<CloseOutlined />} disabled={busy} onClick={() => discard(false)}>关闭</Button><Button icon={<ReloadOutlined />} disabled={busy} onClick={() => discard(true)}>退回并重新生成</Button></div>
        <Button type="primary" size="large" icon={<CheckCircleOutlined />} loading={busy} disabled={!selected.size || uniqueErrors.length > 0} onClick={() => void apply()}>采纳完整大纲</Button>
      </footer>
    </section>
  );
}

