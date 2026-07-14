import type { MouseEvent as ReactMouseEvent } from "react";

import { useCanvasTheme } from "../canvas-theme";
import type { CanvasEdge, CanvasNode, ConnectionHandle, Position } from "../types";

type EdgeNode = Pick<CanvasNode, "id" | "position" | "width" | "height">;

/**
 * 已落定的连线：从源节点右侧中点出发的贝塞尔曲线，到达目标节点左侧中点。
 * 透明粗路径承担命中区域，可见细路径承担视觉。
 */
export function EdgePath({
  edge,
  from,
  to,
  active,
  onSelect,
  onContextMenu,
}: {
  edge: CanvasEdge;
  from: EdgeNode;
  to: EdgeNode;
  active: boolean;
  onSelect: () => void;
  onContextMenu?: (event: ReactMouseEvent<SVGPathElement>) => void;
}) {
  const theme = useCanvasTheme();
  const startX = from.position.x + from.width;
  const startY = from.position.y + from.height / 2;
  const endX = to.position.x;
  const endY = to.position.y + to.height / 2;
  const dx = Math.abs(endX - startX);
  const curvature = Math.max(dx * 0.5, 50);
  const pathD = `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;

  return (
    <g>
      <path
        data-connection-id={edge.id}
        d={pathD}
        stroke="transparent"
        strokeWidth={16}
        fill="none"
        style={{ cursor: "pointer", pointerEvents: "stroke" }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onContextMenu?.(event);
        }}
      />
      <path
        d={pathD}
        stroke={active ? theme.node.activeStroke : theme.node.muted}
        strokeWidth={active ? 3 : 2}
        strokeOpacity={active ? 1 : 0.82}
        fill="none"
        style={{ filter: active ? `drop-shadow(0 0 8px ${theme.node.activeStroke}66)` : undefined, pointerEvents: "none" }}
      />
      {edge.label ? (
        <text
          x={(startX + endX) / 2}
          y={(startY + endY) / 2 - 6}
          textAnchor="middle"
          fill={theme.node.muted}
          fontSize={12}
          style={{ pointerEvents: "none", userSelect: "none" }}
        >
          {edge.label}
        </text>
      ) : null}
    </g>
  );
}

/** 拖拽中的临时连线：从句柄出发跟随鼠标，吸附到目标节点时贴边。 */
export function ActiveEdgePath({
  node,
  handle,
  mouseWorld,
  target,
}: {
  node?: EdgeNode;
  handle: ConnectionHandle;
  mouseWorld: Position;
  target?: EdgeNode;
}) {
  const theme = useCanvasTheme();
  if (!node) return null;

  const startX = handle.handleType === "source" ? node.position.x + node.width : mouseWorld.x;
  const startY = handle.handleType === "source" ? node.position.y + node.height / 2 : mouseWorld.y;
  const endX = handle.handleType === "source" ? mouseWorld.x : node.position.x;
  const endY = handle.handleType === "source" ? mouseWorld.y : node.position.y + node.height / 2;
  const snappedStartX = handle.handleType === "target" && target ? target.position.x + target.width : startX;
  const snappedStartY = handle.handleType === "target" && target ? target.position.y + target.height / 2 : startY;
  const snappedEndX = handle.handleType === "source" && target ? target.position.x : endX;
  const snappedEndY = handle.handleType === "source" && target ? target.position.y + target.height / 2 : endY;
  const distance = Math.abs(snappedEndX - snappedStartX);
  const pathD = `M ${snappedStartX} ${snappedStartY} C ${snappedStartX + distance * 0.5} ${snappedStartY}, ${snappedEndX - distance * 0.5} ${snappedEndY}, ${snappedEndX} ${snappedEndY}`;

  return <path d={pathD} stroke={theme.node.activeStroke} strokeWidth={2} fill="none" strokeDasharray="5,5" />;
}
