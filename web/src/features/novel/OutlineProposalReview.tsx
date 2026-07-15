import { useState } from "react";
import { Alert, App, Button, Tag } from "antd";
import { CheckCircleOutlined, CloseOutlined, ReloadOutlined } from "@ant-design/icons";

import { applyProposalItems, rejectProposal, updateProposalItemPayload } from "./generation";
import type { AIProposal } from "./types";
import ProposalDataCard from "./ProposalDataCard";

export default function OutlineProposalReview({
  proposal,
  onRegenerate,
}: {
  proposal: AIProposal;
  onRegenerate: () => void;
}) {
  const { message, modal } = App.useApp();
  const [busy, setBusy] = useState(false);
  const segment = proposal.items.find((item) => item.targetTable === "outlineNodes");
  const chapters = proposal.items
    .filter((item) => item.targetTable === "documents")
    .sort((left, right) => Number(left.payload.order) - Number(right.payload.order));

  async function apply() {
    setBusy(true);
    try {
      const result = await applyProposalItems(proposal.id, proposal.items.map((item) => item.id));
      message.success(`已写入 1 个剧情段和 ${chapters.length} 个章节，共 ${result.applied} 项`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "采纳失败");
    } finally {
      setBusy(false);
    }
  }

  function discard(regenerate: boolean) {
    modal.confirm({
      title: regenerate ? "放弃当前候选并重新生成？" : "关闭当前剧情设计？",
      content: "正式的幕、剧情段和章节不会发生变化。",
      okText: regenerate ? "重新生成" : "关闭",
      okButtonProps: { danger: !regenerate },
      onOk: async () => {
        await rejectProposal(proposal.id);
        if (regenerate) onRegenerate();
      },
    });
  }

  return (
    <section className="novel-outline-review-mode" aria-label="剧情段与章节审核">
      <header className="novel-outline-review-header">
        <div><span>PLANNING REVIEW</span><h2>审核剧情段与章节</h2><p>剧情段和章节共享一次审核。章节标题、摘要与蓝图可在正式写入前直接编辑。</p></div>
        <Tag color="gold">1 个剧情段 · {chapters.length} 个章节</Tag>
      </header>
      <Alert type="info" showIcon message="整体采纳" description="章节依赖本次剧情段，提案需要整体采纳以保持归属与顺序完整。" />
      <div className="novel-outline-review-tree">
        {segment && <article className="novel-outline-proposal-node selected"><div className="novel-outline-proposal-copy"><Tag color="blue">剧情段</Tag><strong>{segment.label}</strong><ProposalDataCard value={segment.payload} editable onChange={(payload) => void updateProposalItemPayload(proposal.id, segment.id, payload)} /></div></article>}
        {chapters.map((item, index) => <article className="novel-outline-proposal-node selected" key={item.id}><div className="novel-outline-proposal-copy"><Tag color="green">章节 {index + 1}</Tag><strong>{item.label}</strong><ProposalDataCard value={item.payload} editable onChange={(payload) => void updateProposalItemPayload(proposal.id, item.id, payload)} /></div></article>)}
      </div>
      <footer className="novel-outline-review-footer">
        <div><Button icon={<CloseOutlined />} disabled={busy} onClick={() => discard(false)}>关闭</Button><Button icon={<ReloadOutlined />} disabled={busy} onClick={() => discard(true)}>退回并重新生成</Button></div>
        <Button type="primary" size="large" icon={<CheckCircleOutlined />} loading={busy} disabled={!segment || chapters.length < 2} onClick={() => void apply()}>采纳剧情段与章节</Button>
      </footer>
    </section>
  );
}
