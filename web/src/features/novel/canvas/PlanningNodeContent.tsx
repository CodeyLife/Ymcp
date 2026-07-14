import { Tag } from "antd";
import {
  ApartmentOutlined,
  BookOutlined,
  NodeIndexOutlined,
  ShareAltOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";

import type { OutlineKind, OutlineNode, PlotThread, StoryEntity } from "../types";

export type PlanningNodeData =
  | { type: "outline"; node: OutlineNode }
  | { type: "entity"; node: StoryEntity }
  | { type: "thread"; node: PlotThread };

const OUTLINE_KIND_LABEL: Record<OutlineKind, string> = {
  act: "幕",
  sequence: "序列",
  event: "事件",
};

const OUTLINE_KIND_COLOR: Record<OutlineKind, string> = {
  act: "#722ed1",
  sequence: "#1677ff",
  event: "#13c2c2",
};

const THREAD_STATUS_LABEL: Record<PlotThread["status"], string> = {
  planned: "计划中",
  active: "进行中",
  paused: "暂停",
  resolved: "已解决",
  abandoned: "已废弃",
};

/**
 * 策划工作台节点内容：根据 PlanningNodeData.type 渲染不同类型的节点卡片。
 *
 * - outline: 大纲节点（幕/序列/事件），展示层级标签、标题、摘要、状态。
 * - entity: 角色实体，展示姓名、身份、摘要。
 * - thread: 剧情线，展示标题、状态、优先级。
 */
export function PlanningNodeContent({ data }: { data: PlanningNodeData }) {
  if (data.type === "outline") {
    const { node } = data;
    const kindLabel = OUTLINE_KIND_LABEL[node.kind];
    const kindColor = OUTLINE_KIND_COLOR[node.kind];
    return (
      <div className="flex h-full flex-col gap-2 p-3" data-planning-node={node.id} data-planning-type="outline">
        <div className="flex items-center gap-2">
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-full"
            style={{ background: `${kindColor}22`, color: kindColor }}
          >
            {node.kind === "act" ? <ApartmentOutlined style={{ fontSize: 12 }} /> : node.kind === "sequence" ? <UnorderedListOutlined style={{ fontSize: 12 }} /> : <ThunderboltOutlined style={{ fontSize: 12 }} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{node.title}</div>
            <Tag color={kindColor} style={{ margin: 0, fontSize: 10, lineHeight: "16px", padding: "0 4px" }}>{kindLabel}</Tag>
          </div>
        </div>
        <p className="line-clamp-3 flex-1 overflow-hidden text-xs leading-relaxed opacity-70">{node.summary || "尚未描述"}</p>
        <div className="flex items-center gap-2 text-xs opacity-50">
          <span>{node.status === "idea" ? "构思" : node.status === "planned" ? "已规划" : "已完成"}</span>
          {node.characterIds.length > 0 && <span className="flex items-center gap-1"><NodeIndexOutlined />{node.characterIds.length}</span>}
          {node.plotThreadIds.length > 0 && <span className="flex items-center gap-1"><ShareAltOutlined />{node.plotThreadIds.length}</span>}
        </div>
      </div>
    );
  }

  if (data.type === "entity") {
    const { node } = data;
    const role = node.character?.role || "角色";
    return (
      <div className="flex h-full flex-col gap-2 p-3" data-planning-node={node.id} data-planning-type="entity">
        <div className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold" style={{ background: "rgba(22,119,255,0.15)", color: "#1677ff" }}>
            {node.name.slice(0, 1) || "?"}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{node.name}</div>
            <div className="truncate text-xs opacity-60">{role}</div>
          </div>
        </div>
        <p className="line-clamp-3 flex-1 overflow-hidden text-xs leading-relaxed opacity-70">{node.summary || "尚未设定"}</p>
      </div>
    );
  }

  const { node } = data;
  return (
    <div className="flex h-full flex-col gap-2 p-3" data-planning-node={node.id} data-planning-type="thread">
      <div className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full" style={{ background: "rgba(82,196,26,0.15)", color: "#52c41a" }}>
          <BookOutlined style={{ fontSize: 12 }} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{node.title}</div>
          <Tag color="#52c41a" style={{ margin: 0, fontSize: 10, lineHeight: "16px", padding: "0 4px" }}>{THREAD_STATUS_LABEL[node.status]}</Tag>
        </div>
      </div>
      <p className="line-clamp-3 flex-1 overflow-hidden text-xs leading-relaxed opacity-70">{node.summary || "尚未描述"}</p>
    </div>
  );
}
