import { useEffect } from "react";
import type { ReactNode } from "react";

import { useCanvasTheme } from "../canvas-theme";
import type { ContextMenuState } from "../types";

/**
 * 画布右键菜单。菜单项由业务侧通过 `children` 注入（推荐使用 `CanvasMenuItem`）。
 * 在任意位置 pointerdown 时自动关闭（antd 浮层内点击除外）。
 */
export function CanvasContextMenu({
  menu,
  onClose,
  children,
}: {
  menu: ContextMenuState;
  onClose: () => void;
  children?: ReactNode;
}) {
  const theme = useCanvasTheme();

  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".ant-popover,.ant-dropdown")) return;
      onClose();
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onClose]);

  return (
    <div
      className="fixed z-[80] min-w-44 overflow-hidden rounded-xl border py-1 shadow-2xl"
      style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

export function CanvasMenuItem({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon?: ReactNode;
  label: string;
  onClick?: () => void;
  danger?: boolean;
}) {
  const theme = useCanvasTheme();
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80"
      style={{ color: danger ? "#f87171" : theme.node.text }}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
