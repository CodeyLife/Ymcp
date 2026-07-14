import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useCanvasTheme } from "../canvas-theme";
import type { CanvasNode, Position } from "../types";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

type CanvasNodeShellProps<T> = {
  node: CanvasNode<T>;
  scale: number;
  isSelected: boolean;
  isConnectionTarget?: boolean;
  isConnecting?: boolean;
  /** 是否可缩放，默认 true。 */
  resizable?: boolean;
  /** 是否可拉连线，默认 true。 */
  connectable?: boolean;
  minWidth?: number;
  minHeight?: number;
  /** 节点拖拽起始（pointerdown on node body）。父组件接管拖拽状态机。 */
  onMouseDown: (event: React.MouseEvent, nodeId: string) => void;
  /** 节点缩放（四角手柄拖拽）。 */
  onResize: (nodeId: string, width: number, height: number, position?: Position) => void;
  /** 从左右句柄拉出连线。 */
  onConnectStart?: (event: React.MouseEvent, nodeId: string, handleType: "source" | "target") => void;
  onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
  onHoverStart?: (nodeId: string) => void;
  onHoverEnd?: (nodeId: string) => void;
  /** 节点内容（业务侧自定义渲染）。 */
  children?: ReactNode;
  /** 选中描边色覆盖（默认用主题 activeStroke）。 */
  activeStroke?: string;
};

/**
 * 通用画布节点外壳。
 *
 * 负责：世界坐标定位（translate）、选中描边与层级、四角缩放手柄、左右连线句柄、
 * hover/右键事件转发。节点内部内容由 `children` 注入，画布核心不感知领域语义。
 *
 * 拖拽移动由父组件接管（onMouseDown 回调），缩放由本组件内部管理（与参考实现一致）。
 */
export function CanvasNodeShell<T>({
  node,
  scale,
  isSelected,
  isConnectionTarget = false,
  isConnecting = false,
  resizable = true,
  connectable = true,
  minWidth = 220,
  minHeight = 120,
  onMouseDown,
  onResize,
  onConnectStart,
  onContextMenu,
  onHoverStart,
  onHoverEnd,
  children,
  activeStroke,
}: CanvasNodeShellProps<T>) {
  const theme = useCanvasTheme();
  const [hovered, setHovered] = useState(false);
  const isActive = isConnectionTarget || isSelected;
  const stroke = activeStroke ?? theme.node.activeStroke;
  const resizeRef = useRef({
    isResizing: false,
    corner: "bottom-right" as ResizeCorner,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0,
    startWidth: 0,
    startHeight: 0,
  });

  const handleResizeMove = useCallback(
    (event: MouseEvent) => {
      if (!resizeRef.current.isResizing) return;
      const dx = (event.clientX - resizeRef.current.startX) / scale;
      const dy = (event.clientY - resizeRef.current.startY) / scale;
      const startRight = resizeRef.current.startLeft + resizeRef.current.startWidth;
      const startBottom = resizeRef.current.startTop + resizeRef.current.startHeight;
      const fromLeft = resizeRef.current.corner.includes("left");
      const fromTop = resizeRef.current.corner.includes("top");
      const width = Math.max(minWidth, resizeRef.current.startWidth + (fromLeft ? -dx : dx));
      const height = Math.max(minHeight, resizeRef.current.startHeight + (fromTop ? -dy : dy));
      onResize(node.id, width, height, {
        x: fromLeft ? startRight - width : resizeRef.current.startLeft,
        y: fromTop ? startBottom - height : resizeRef.current.startTop,
      });
    },
    [minWidth, minHeight, node.id, onResize, scale],
  );

  const handleResizeUp = useCallback(() => {
    resizeRef.current.isResizing = false;
    window.removeEventListener("mousemove", handleResizeMove);
    window.removeEventListener("mouseup", handleResizeUp);
  }, [handleResizeMove]);

  const handleResizeMouseDown = (event: React.MouseEvent, corner: ResizeCorner) => {
    event.stopPropagation();
    event.preventDefault();
    resizeRef.current = {
      isResizing: true,
      corner,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: node.position.x,
      startTop: node.position.y,
      startWidth: node.width,
      startHeight: node.height,
    };
    window.addEventListener("mousemove", handleResizeMove);
    window.addEventListener("mouseup", handleResizeUp);
  };

  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", handleResizeMove);
      window.removeEventListener("mouseup", handleResizeUp);
    };
  }, [handleResizeMove, handleResizeUp]);

  return (
    <div
      data-node-id={node.id}
      className={`absolute flex select-none flex-col transition-shadow duration-200 ${isSelected ? "z-50" : "z-10"}`}
      style={{
        transform: `translate(${node.position.x}px, ${node.position.y}px)`,
        width: node.width,
        height: node.height,
        contain: "layout style",
      }}
      onMouseEnter={() => {
        setHovered(true);
        onHoverStart?.(node.id);
      }}
      onMouseLeave={() => {
        setHovered(false);
        onHoverEnd?.(node.id);
      }}
      onMouseDown={(event) => onMouseDown(event, node.id)}
      onContextMenu={(event) => onContextMenu(event, node.id)}
    >
      <div
        className="relative h-full w-full overflow-hidden rounded-2xl border"
        style={{
          background: theme.node.fill,
          borderColor: isActive ? stroke : theme.node.stroke,
          boxShadow: isActive ? `0 0 0 2px ${stroke}55, 0 12px 32px rgba(0,0,0,.28)` : hovered ? `0 8px 24px rgba(0,0,0,.20)` : "0 4px 14px rgba(0,0,0,.14)",
        }}
      >
        {children}
      </div>

      {resizable ? (
        <>
          <ResizeHandle corner="top-left" onMouseDown={handleResizeMouseDown} />
          <ResizeHandle corner="top-right" onMouseDown={handleResizeMouseDown} />
          <ResizeHandle corner="bottom-left" onMouseDown={handleResizeMouseDown} />
          <ResizeHandle corner="bottom-right" onMouseDown={handleResizeMouseDown} />
        </>
      ) : null}

      {connectable ? (
        <>
          <ConnectionHandleDot side="left" visible={hovered || isSelected || isConnecting} onMouseDown={(event) => onConnectStart?.(event, node.id, "target")} />
          <ConnectionHandleDot side="right" visible={hovered || isSelected || isConnecting} onMouseDown={(event) => onConnectStart?.(event, node.id, "source")} />
        </>
      ) : null}
    </div>
  );
}

function ResizeHandle({ corner, onMouseDown }: { corner: ResizeCorner; onMouseDown: (event: React.MouseEvent, corner: ResizeCorner) => void }) {
  const positionClass = {
    "top-left": "-left-[14px] -top-[14px] cursor-nwse-resize",
    "top-right": "-right-[14px] -top-[14px] cursor-nesw-resize",
    "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize",
    "bottom-right": "-bottom-[14px] -right-[14px] cursor-nwse-resize",
  }[corner];
  return <div className={`absolute z-50 size-7 ${positionClass}`} onMouseDown={(event) => onMouseDown(event, corner)} />;
}

function ConnectionHandleDot({ side, visible, onMouseDown }: { side: "left" | "right"; visible: boolean; onMouseDown: (event: React.MouseEvent) => void }) {
  const theme = useCanvasTheme();
  return (
    <div
      className={`absolute top-1/2 z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150 ${
        side === "left" ? "-left-6" : "-right-6"
      } ${visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
      onMouseDown={onMouseDown}
    >
      <div className="size-3 rounded-full border-2 transition-all hover:scale-125" style={{ background: theme.node.panel, borderColor: theme.node.muted }} />
    </div>
  );
}
