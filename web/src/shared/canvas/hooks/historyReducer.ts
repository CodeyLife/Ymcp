import type { CanvasEdge, CanvasHistoryEntry, CanvasNode } from "../types";

export interface HistoryState<T> {
  past: CanvasHistoryEntry<T>[];
  future: CanvasHistoryEntry<T>[];
  /** 最近一次落定的快照（= 调用方当前应用的状态）。 */
  lastCommitted: CanvasHistoryEntry<T> | null;
}

export function createEmptyHistory<T>(): HistoryState<T> {
  return { past: [], future: [], lastCommitted: null };
}

/**
 * 提交当前快照：把旧的 lastCommitted 推入 past，更新 lastCommitted，清空 future。
 * 受 maxHistory 限制，超出时丢弃最旧的 past 条目。
 */
export function commitHistory<T>(state: HistoryState<T>, current: { nodes: CanvasNode<T>[]; edges: CanvasEdge[] }, maxHistory: number): HistoryState<T> {
  const entry: CanvasHistoryEntry<T> = { nodes: current.nodes, edges: current.edges };
  const past = state.lastCommitted ? [...state.past, state.lastCommitted].slice(-maxHistory) : [...state.past];
  return { past, future: [], lastCommitted: entry };
}

/** 撤销：把 lastCommitted 推入 future，从 past 弹出作为新的 lastCommitted。返回应用目标，无则 null。 */
export function undoHistory<T>(state: HistoryState<T>): { state: HistoryState<T>; target: CanvasHistoryEntry<T> | null } {
  if (state.past.length === 0) return { state, target: null };
  const previous = state.past[state.past.length - 1];
  const past = state.past.slice(0, -1);
  const future = state.lastCommitted ? [...state.future, state.lastCommitted] : state.future;
  return { state: { past, future, lastCommitted: previous }, target: previous };
}

/** 重做：把 lastCommitted 推入 past，从 future 弹出作为新的 lastCommitted。返回应用目标，无则 null。 */
export function redoHistory<T>(state: HistoryState<T>): { state: HistoryState<T>; target: CanvasHistoryEntry<T> | null } {
  if (state.future.length === 0) return { state, target: null };
  const next = state.future[state.future.length - 1];
  const future = state.future.slice(0, -1);
  const past = state.lastCommitted ? [...state.past, state.lastCommitted] : state.past;
  return { state: { past, future, lastCommitted: next }, target: next };
}
