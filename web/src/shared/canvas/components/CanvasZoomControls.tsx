import type { ReactNode } from "react";
import { AimOutlined, CompassOutlined, QuestionCircleOutlined } from "@ant-design/icons";
import { useState } from "react";
import { Button, Modal, Tooltip } from "antd";

import { useCanvasTheme } from "../canvas-theme";

type CanvasZoomControlsProps = {
  scale: number;
  onScaleChange: (scale: number) => void;
  onReset: () => void;
  isMiniMapOpen: boolean;
  onToggleMiniMap: () => void;
};

/** 左下角缩放控制坞：小地图开关、重置视图、缩放滑块、快捷键帮助。 */
export function CanvasZoomControls({ scale, onScaleChange, onReset, isMiniMapOpen, onToggleMiniMap }: CanvasZoomControlsProps) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const theme = useCanvasTheme();
  const dockStyle = {
    background: theme.toolbar.panel,
    borderColor: theme.toolbar.border,
    color: theme.toolbar.item,
    boxShadow: "0 18px 45px rgba(0,0,0,.32)",
  };
  const activeStyle = { background: theme.toolbar.activeBg, color: theme.toolbar.activeText };

  return (
    <div className="absolute bottom-5 left-5 z-50" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
      <div className="flex h-14 items-center gap-1 rounded-xl border px-2 shadow-lg backdrop-blur" style={dockStyle}>
        <Tooltip title={isMiniMapOpen ? "关闭小地图" : "打开小地图"}>
          <Button
            type="text"
            className="!h-8 !w-8 !min-w-8 !p-0"
            style={isMiniMapOpen ? activeStyle : { color: theme.toolbar.item }}
            icon={<CompassOutlined />}
            onClick={onToggleMiniMap}
            aria-label={isMiniMapOpen ? "关闭小地图" : "打开小地图"}
          />
        </Tooltip>
        <Tooltip title="重置视图">
          <Button type="text" className="!h-8 !w-8 !min-w-8 !p-0" style={{ color: theme.toolbar.item }} icon={<AimOutlined />} onClick={onReset} aria-label="重置视图" />
        </Tooltip>
        <Tooltip title="放大/缩小画布">
          <input
            type="range"
            min="5"
            max="500"
            step="1"
            value={Math.round(scale * 100)}
            className="w-24"
            style={{ accentColor: theme.node.activeStroke }}
            onChange={(event) => onScaleChange(Number(event.target.value) / 100)}
            aria-label="放大/缩小画布"
          />
        </Tooltip>
        <span className="w-10 text-right text-xs tabular-nums" style={{ color: theme.node.muted }}>
          {Math.round(scale * 100)}%
        </span>
        <Tooltip title="快捷键">
          <Button
            type="text"
            className="!h-8 !w-8 !min-w-8 !p-0"
            style={shortcutsOpen ? activeStyle : { color: theme.toolbar.item }}
            icon={<QuestionCircleOutlined />}
            onClick={() => setShortcutsOpen(true)}
            aria-label="快捷键"
          />
        </Tooltip>
      </div>
      <Modal title="快捷键" open={shortcutsOpen} onCancel={() => setShortcutsOpen(false)} footer={null} centered>
        <div className="space-y-3 border-t pt-4 text-sm" style={{ borderColor: theme.node.stroke }}>
          <Shortcut label="拖动画布" value="平移视图" />
          <Shortcut label="滚轮" value="缩放画布" />
          <Shortcut label="Ctrl / Cmd + 拖动" value="框选多个节点" />
          <Shortcut label="Shift / Ctrl / Cmd + 点击" value="追加选择节点" />
          <Shortcut label="Ctrl / Cmd + C / V" value="复制 / 粘贴节点" />
          <Shortcut label="Delete / Backspace" value="删除选中" />
          <Shortcut label="Ctrl / Cmd + Z / Y" value="撤销 / 重做" />
        </div>
      </Modal>
    </div>
  );
}

function Shortcut({ label, value }: { label: ReactNode; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-base font-medium">{label}</span>
      <span className="opacity-60">{value}</span>
    </div>
  );
}
