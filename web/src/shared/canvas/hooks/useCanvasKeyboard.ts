import { useEffect } from "react";

/**
 * 画布全局键盘快捷键。
 *
 * 仅当焦点不在输入框/文本域/contenteditable 时触发：
 * - Delete / Backspace：删除选中
 * - Ctrl/Cmd + C / V：复制 / 粘贴
 * - Ctrl/Cmd + A：全选
 * - Ctrl/Cmd + Z：撤销；Ctrl/Cmd + Shift + Z 或 Ctrl/Cmd + Y：重做
 * - Escape：取消选择
 *
 * 所有动作通过回调注入，hook 本身不持有状态。
 */
export function useCanvasKeyboard(handlers: {
  onDelete?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onSelectAll?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onDeselect?: () => void;
  enabled?: boolean;
}) {
  const { onDelete, onCopy, onPaste, onSelectAll, onUndo, onRedo, onDeselect, enabled = true } = handlers;

  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLElement && target.isContentEditable) return;

      const meta = event.ctrlKey || event.metaKey;

      if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) onRedo?.();
        else onUndo?.();
        return;
      }
      if (meta && event.key.toLowerCase() === "y") {
        event.preventDefault();
        onRedo?.();
        return;
      }
      if (meta && event.key.toLowerCase() === "a") {
        event.preventDefault();
        onSelectAll?.();
        return;
      }
      if (meta && event.key.toLowerCase() === "c") {
        onCopy?.();
        return;
      }
      if (meta && event.key.toLowerCase() === "v") {
        onPaste?.();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        onDelete?.();
        return;
      }
      if (event.key === "Escape") {
        onDeselect?.();
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onDelete, onCopy, onPaste, onSelectAll, onUndo, onRedo, onDeselect, enabled]);
}
