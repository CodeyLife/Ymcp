import { useCallback, useEffect, useRef, useState } from "react";

import type { CanvasEdge, CanvasHistoryEntry, CanvasNode } from "../types";
import { commitHistory, createEmptyHistory, redoHistory, undoHistory, type HistoryState } from "./historyReducer";

const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_MAX_HISTORY = 50;

/**
 * 画布撤销/重做历史栈。
 *
 * - `commit()` 以防抖方式把当前 nodes/edges 快照压入 past 栈并清空 future。
 * - `undo()` / `redo()` 在 past/future 间转移快照，返回目标快照供调用方应用。
 * - `pause()` / `resume()` 用于程序化批量更新时跳过提交（如加载、应用历史本身）。
 *
 * 纯逻辑委托给 historyReducer.ts（可单测），本 Hook 只负责 React 副作用：
 * ref 持有状态、setTimeout 防抖、useState 同步 canUndo/canRedo 标志。
 *
 * 泛型 T 透传给 CanvasNode<T>，保留领域载荷类型。
 */
export function useCanvasHistory<T>(options?: {
  debounceMs?: number;
  maxHistory?: number;
}) {
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxHistory = options?.maxHistory ?? DEFAULT_MAX_HISTORY;
  const historyRef = useRef<HistoryState<T>>(createEmptyHistory<T>());
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ nodes: CanvasNode<T>[]; edges: CanvasEdge[] } | null>(null);
  const pausedRef = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const syncFlags = useCallback(() => {
    setCanUndo(historyRef.current.past.length > 0);
    setCanRedo(historyRef.current.future.length > 0);
  }, []);

  const clear = useCallback(() => {
    historyRef.current = createEmptyHistory<T>();
    pendingRef.current = null;
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    syncFlags();
  }, [syncFlags]);

  const flushPending = useCallback(() => {
    if (!pendingRef.current) return;
    historyRef.current = commitHistory(historyRef.current, pendingRef.current, maxHistory);
    pendingRef.current = null;
    syncFlags();
  }, [maxHistory, syncFlags]);

  /**
   * 防抖提交当前快照。连续快速变更只产生一条历史记录。
   * 在 paused 期间调用会被忽略。
   */
  const scheduleCommit = useCallback(
    (current: { nodes: CanvasNode<T>[]; edges: CanvasEdge[] }) => {
      if (pausedRef.current) return;
      pendingRef.current = current;
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
      commitTimerRef.current = setTimeout(() => {
        commitTimerRef.current = null;
        flushPending();
      }, debounceMs);
    },
    [debounceMs, flushPending],
  );

  const undo = useCallback((): CanvasHistoryEntry<T> | null => {
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
      pendingRef.current = null;
    }
    const result = undoHistory(historyRef.current);
    historyRef.current = result.state;
    syncFlags();
    return result.target;
  }, [syncFlags]);

  const redo = useCallback((): CanvasHistoryEntry<T> | null => {
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
      pendingRef.current = null;
    }
    const result = redoHistory(historyRef.current);
    historyRef.current = result.state;
    syncFlags();
    return result.target;
  }, [syncFlags]);

  const pause = useCallback(() => {
    pausedRef.current = true;
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
  }, []);

  /** 在加载初始快照时设置锚点，避免首次 undo 回到空状态。 */
  const seed = useCallback(
    (entry: CanvasHistoryEntry<T>) => {
      historyRef.current = { past: [], future: [], lastCommitted: entry };
      pendingRef.current = null;
      if (commitTimerRef.current) {
        clearTimeout(commitTimerRef.current);
        commitTimerRef.current = null;
      }
      syncFlags();
    },
    [syncFlags],
  );

  useEffect(
    () => () => {
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    },
    [],
  );

  return { scheduleCommit, undo, redo, clear, pause, resume, seed, canUndo, canRedo };
}
