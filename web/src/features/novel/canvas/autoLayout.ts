import type { Position } from "@/shared/canvas";

/**
 * 简单网格自动布局：按行列排布节点。
 * 新节点（无保存位置）会按索引获得一个网格位置，避免重叠。
 */
export function gridLayout(index: number, total: number, spacing = 320, rowHeight = 220): Position {
  const cols = Math.max(1, Math.ceil(Math.sqrt(total)));
  const col = index % cols;
  const row = Math.floor(index / cols);
  return { x: col * spacing, y: row * rowHeight };
}

/**
 * 圆形自动布局：将节点均匀分布在圆周上。
 * 适合关系图等需要中心对称展示的场景。
 */
export function circleLayout(index: number, total: number, radius = 300): Position {
  if (total <= 1) return { x: 0, y: 0 };
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}
