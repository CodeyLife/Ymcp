import { ClockCircleOutlined } from "@ant-design/icons";

import type { TimelineEvent } from "../types";

/**
 * 时间线节点内容：渲染在 CanvasNodeShell 内部的事件卡片。
 *
 * 纯展示组件，不持有状态。展示序号、故事日期、标题、描述、时长与并行分组。
 * 节点尺寸由 CanvasNodeShell 的 width/height 控制，内容自适应填充。
 */
export function TimelineNodeContent({ event }: { event: TimelineEvent }) {
  const order = String(event.narrativeOrder + 1).padStart(2, "0");

  return (
    <div className="flex h-full flex-col gap-2 p-3" data-timeline-node={event.id}>
      <div className="flex items-center gap-2">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold"
          style={{ background: "rgba(255,255,255,0.10)" }}
        >
          {order}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{event.title}</div>
          <div className="truncate text-xs opacity-60">{event.storyDate}</div>
        </div>
      </div>
      <p className="line-clamp-3 flex-1 overflow-hidden text-xs leading-relaxed opacity-70">
        {event.description || "尚未描述"}
      </p>
      <div className="flex items-center gap-2 text-xs opacity-50">
        {event.duration && (
          <span className="flex items-center gap-1">
            <ClockCircleOutlined />
            <span className="truncate">{event.duration}</span>
          </span>
        )}
        {event.parallelGroup && (
          <span
            className="ml-auto rounded px-1.5 py-0.5 text-xs"
            style={{ background: "rgba(255,255,255,0.08)" }}
          >
            {event.parallelGroup}
          </span>
        )}
      </div>
    </div>
  );
}
