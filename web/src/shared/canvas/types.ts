/**
 * 画布核心通用类型。
 *
 * 设计原则：节点 `data` 字段泛型化，由各业务面板填入自己的领域载荷
 * （如 StoryEntity / TimelineEvent / OutlineNode）。画布核心不感知领域语义。
 */

export type Position = { x: number; y: number };

/** 视口变换：x/y 为画布平移（屏幕像素），k 为缩放系数。 */
export type ViewportTransform = { x: number; y: number; k: number };

/**
 * 画布节点。`kind` 为业务侧自定义类型字符串（如 "character" | "event" | "location"），
 * `data` 为该节点携带的领域载荷。画布核心只关心 position/width/height/groupId。
 */
export interface CanvasNode<T = unknown> {
  id: string;
  kind: string;
  position: Position;
  width: number;
  height: number;
  data: T;
  groupId?: string;
}

/** 画布连线。`kind` / `label` 由业务侧赋予语义（如 "relation" | "causality"）。 */
export interface CanvasEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label?: string;
  kind?: string;
}

/** 连线拖拽句柄状态。 */
export type ConnectionHandle = {
  nodeId: string;
  handleType: "source" | "target";
};

/** 框选状态（世界坐标）。 */
export type SelectionBox = {
  startWorldX: number;
  startWorldY: number;
  currentWorldX: number;
  currentWorldY: number;
  additive: boolean;
  initialSelectedNodeIds: string[];
};

/** 右键菜单状态。 */
export type ContextMenuState =
  | { type: "node"; x: number; y: number; nodeId: string }
  | { type: "connection"; x: number; y: number; connectionId: string }
  | { type: "canvas"; x: number; y: number };

/** 撤销/重做历史快照。 */
export type CanvasHistoryEntry<T = unknown> = {
  nodes: CanvasNode<T>[];
  edges: CanvasEdge[];
};

/** 画布背景模式。 */
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

/**
 * 节点布局快照（不含领域数据）。
 *
 * 持久化时只保存位置/尺寸/分组，领域数据（如 StoryEntity / TimelineEvent）
 * 仍在各自的业务表中。加载时通过 id 关联回领域数据。
 */
export interface CanvasNodeLayout {
  id: string;
  kind: string;
  position: Position;
  width: number;
  height: number;
  groupId?: string;
}
