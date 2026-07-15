import { Button, Modal, Tag } from "antd";
import { CheckOutlined } from "@ant-design/icons";

import ArchitectureDataEditor, { type ArchitectureEditableData } from "./ArchitectureDataEditor";
import CharacterCard, { isCharacterEntityData, type CharacterCardData } from "./CharacterCard";
import ProposalDataCard from "./ProposalDataCard";
import type { ProposalItem } from "./types";

const OPERATION_LABEL = { create: "新增", update: "更新", delete: "删除" } as const;
const OPERATION_COLOR = { create: "green", update: "blue", delete: "red" } as const;

function architectureValue(value: Record<string, unknown>): ArchitectureEditableData {
  return {
    framework: ["free", "three-act", "four-part", "save-the-cat", "snowflake"].includes(String(value.framework)) ? value.framework as ArchitectureEditableData["framework"] : "free",
    status: value.status === "approved" ? "approved" : "draft",
    centralQuestion: String(value.centralQuestion ?? ""),
    centralConflict: String(value.centralConflict ?? ""),
    synopsis: String(value.synopsis ?? ""),
    phases: Array.isArray(value.phases) ? value.phases as ArchitectureEditableData["phases"] : [],
  };
}

function StructuredDataSurface({ item, value, compareTo, editable, onChange }: { item: ProposalItem; value: Record<string, unknown>; compareTo?: Record<string, unknown>; editable: boolean; onChange?: (next: Record<string, unknown>) => void }) {
  if (item.targetTable === "architectures") return <ArchitectureDataEditor preview readOnly={!editable} value={architectureValue(value)} compareTo={compareTo ? architectureValue(compareTo) : undefined} onChange={(next) => onChange?.({ ...value, ...next })} />;
  if (item.targetTable === "entities" && isCharacterEntityData(value)) return <CharacterCard entity={value as unknown as CharacterCardData} compareTo={compareTo && isCharacterEntityData(compareTo) ? compareTo as unknown as CharacterCardData : undefined} mode="detail" editable={editable} onChange={(next) => onChange?.(next as unknown as Record<string, unknown>)} />;
  return <ProposalDataCard value={value} compareTo={compareTo} editable={editable} onChange={onChange} />;
}

export default function ProposalReviewDialog({
  item,
  draft,
  open,
  onClose,
  onChange,
}: {
  item?: ProposalItem;
  draft?: Record<string, unknown>;
  open: boolean;
  onClose: () => void;
  onChange: (next: Record<string, unknown>) => void;
}) {
  if (!item) return null;
  const after = draft ?? item.after ?? item.payload;
  const hasBefore = Boolean(item.before);
  const hasAfter = item.operation !== "delete";
  return <Modal
    className="novel-proposal-review-modal"
    open={open}
    onCancel={onClose}
    width="min(1320px, calc(100vw - 40px))"
    centered
    title={<div className="novel-proposal-modal-title"><div><Tag color={OPERATION_COLOR[item.operation]}>{OPERATION_LABEL[item.operation]}</Tag><strong>{item.label}</strong></div><small>{item.targetTable}</small></div>}
    footer={<div className="novel-proposal-modal-footer"><span>候选修改会保留在审核草稿中，采纳时统一写入正式数据。</span><Button type="primary" icon={<CheckOutlined />} onClick={onClose}>完成查看</Button></div>}
  >
    <div className="novel-proposal-modal-intro"><p>{item.rationale}</p>{item.impact?.length ? <ul>{item.impact.map((impact) => <li key={impact}>{impact}</li>)}</ul> : null}</div>
    <div className={`novel-proposal-compare${hasBefore && hasAfter ? " split" : " single"}`}>
      {hasBefore && <section className="novel-proposal-compare-panel before"><header><span>修改前</span><small>当前正式数据</small></header><div className="novel-proposal-surface"><StructuredDataSurface item={item} value={item.before!} compareTo={hasAfter ? after : undefined} editable={false} /></div></section>}
      {hasAfter && <section className="novel-proposal-compare-panel after"><header><span>{item.operation === "create" ? "新增内容" : "修改后"}</span><small>可直接编辑候选字段</small></header><div className="novel-proposal-surface"><StructuredDataSurface item={item} value={after} compareTo={item.before} editable onChange={onChange} /></div></section>}
    </div>
  </Modal>;
}
