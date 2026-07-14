import { theme as antdTheme } from "antd";

import type { CanvasBackgroundMode } from "./types";

export type CanvasColorTheme = "light" | "dark";

export const canvasThemes = {
  light: {
    canvas: {
      background: "#f4f2ed",
      dot: "rgba(68,64,60,.28)",
      line: "rgba(68,64,60,.12)",
      selectionStroke: "#1c1917",
      selectionFill: "rgba(28,25,23,.06)",
    },
    node: {
      label: "#57534e",
      fill: "#e7e5df",
      panel: "#fbfaf7",
      stroke: "#d6d3ca",
      activeStroke: "#1c1917",
      placeholder: "#8a8479",
      text: "#292524",
      muted: "#78716c",
      faint: "#a8a29e",
    },
    toolbar: {
      panel: "rgba(251,250,247,.96)",
      border: "#d6d3ca",
      item: "#57534e",
      itemHover: "#e7e5df",
      activeBg: "#e7e5df",
      activeText: "#292524",
    },
  },
  dark: {
    canvas: {
      background: "#181715",
      dot: "rgba(245,245,244,.24)",
      line: "rgba(245,245,244,.10)",
      selectionStroke: "#fafaf9",
      selectionFill: "rgba(250,250,249,.10)",
    },
    node: {
      label: "#d6d3d1",
      fill: "#292524",
      panel: "#1f1d1a",
      stroke: "#44403c",
      activeStroke: "#fafaf9",
      placeholder: "#a8a29e",
      text: "#f5f5f4",
      muted: "#d6d3d1",
      faint: "#78716c",
    },
    toolbar: {
      panel: "rgba(31,29,26,.96)",
      border: "#44403c",
      item: "#d6d3d1",
      itemHover: "#292524",
      activeBg: "#3a3631",
      activeText: "#f5f5f4",
    },
  },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];

/**
 * 通过 antd ConfigProvider 的 token 判断当前是否深色算法，返回对应画布主题。
 * 需在 ConfigProvider 内部调用（画布组件均渲染在应用根 ConfigProvider 下）。
 *
 * 检测方式：读取 colorBgBase 的亮度。antd 的 ThemeConfig.algorithm 不在
 * useToken().theme 的 TypeScript 类型上（运行时存在但类型未暴露），
 * 因此用 token 值反推，保证类型安全。
 */
export function useCanvasTheme(): CanvasTheme {
  const { token } = antdTheme.useToken();
  const isDark = isDarkColor(token.colorBgBase);
  return canvasThemes[isDark ? "dark" : "light"];
}

function isDarkColor(color: string): boolean {
  const m = color.match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return true;
  const hex = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

export type { CanvasBackgroundMode };
