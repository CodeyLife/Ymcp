import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeLayout,
  type Position,
  type ViewportTransform,
  useCanvasHistory,
} from "@/shared/canvas";
import { getCanvasLayout, saveCanvasLayout } from "../db";
import type { CanvasPanelKey } from "../types";
import { circleLayout, gridLayout } from "./autoLayout";

export interface CanvasPanelItem<T> {
  id: string;
  kind: string;
  data: T;
}

export interface UseCanvasPanelOptions<T> {
  projectId: string;
  panelKey: CanvasPanelKey;
  items: CanvasPanelItem<T>[];
  edges: CanvasEdge[];
  defaultWidth?: number;
  defaultHeight?: number;
  layoutStrategy?: "grid" | "circle" | ((index: number, total: number, item: CanvasPanelItem<T>) => Position);
}

const DEFAULT_VIEWPORT: ViewportTransform = { x: 0, y: 0, k: 1 };
const SAVE_DEBOUNCE_MS = 600;

/**
 * 画布面板状态管理 Hook。
 *
 * 职责：
 * - 加载/保存 CanvasLayout（视口 + 节点位置 + 连线）
 * - 将领域数据（items）与保存的布局位置合并；新节点自动布局
 * - 管理视口、节点拖拽/缩放、选择
 * - 撤销/重做（useCanvasHistory）
 *
 * 领域数据由调用方通过 items/edges 传入（通常来自 useLiveQuery）。
 * 画布只存储位置/尺寸/视口，不存储领域数据本身。
 */
export function useCanvasPanel<T>(options: UseCanvasPanelOptions<T>) {
  const {
    projectId,
    panelKey,
    items,
    edges,
    defaultWidth = 240,
    defaultHeight = 160,
    layoutStrategy = "grid",
  } = options;

  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<ViewportTransform>(DEFAULT_VIEWPORT);
  const [nodes, setNodes] = useState<CanvasNode<T>[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const history = useCanvasHistory<T>({ debounceMs: 400 });
  const { scheduleCommit, undo: historyUndo, redo: historyRedo, canUndo, canRedo, pause: historyPause, resume: historyResume } = history;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragStateRef = useRef<{
    nodeId: string;
    startClientX: number;
    startClientY: number;
    startNodeX: number;
    startNodeY: number;
  } | null>(null);
  const skipHistoryRef = useRef(false);
  const savedLayoutRef = useRef<{ nodes: CanvasNodeLayout[]; viewport: ViewportTransform } | null>(null);

  // 加载已保存的布局
  useEffect(() => {
    let cancelled = false;
    historyPause();
    void getCanvasLayout(projectId, panelKey).then((layout) => {
      if (cancelled) return;
      if (layout) {
        savedLayoutRef.current = { nodes: layout.nodes, viewport: layout.viewport };
        setViewport(layout.viewport);
      }
      setLoaded(true);
      // TODO P2: 首次加载后 seed 历史，使 undo 能回到初始状态
      historyResume();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, panelKey, historyPause, historyResume]);

  // 领域数据变化时合并布局位置
  useEffect(() => {
    if (!loaded) return;
    skipHistoryRef.current = true;
    const savedMap = savedLayoutRef.current
      ? new Map(savedLayoutRef.current.nodes.map((n) => [n.id, n]))
      : null;
    setNodes((prev) => {
      const prevMap = new Map(prev.map((n) => [n.id, n]));
      return items.map((item, index) => {
        const existing = prevMap.get(item.id);
        if (existing) {
          return { ...existing, data: item.data };
        }
        const saved = savedMap?.get(item.id);
        if (saved) {
          return {
            id: item.id,
            kind: item.kind,
            position: saved.position,
            width: saved.width,
            height: saved.height,
            groupId: saved.groupId,
            data: item.data,
          };
        }
        const position =
          typeof layoutStrategy === "function"
            ? layoutStrategy(index, items.length, item)
            : layoutStrategy === "circle"
              ? circleLayout(index, items.length)
              : gridLayout(index, items.length);
        return {
          id: item.id,
          kind: item.kind,
          position,
          width: defaultWidth,
          height: defaultHeight,
          data: item.data,
        };
      });
    });
  }, [items, loaded, layoutStrategy, defaultWidth, defaultHeight]);

  // 防抖保存 + 历史提交
  useEffect(() => {
    if (!loaded || nodes.length === 0) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const layoutNodes: CanvasNodeLayout[] = nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        position: n.position,
        width: n.width,
        height: n.height,
        groupId: n.groupId,
      }));
      void saveCanvasLayout(projectId, panelKey, { viewport, nodes: layoutNodes, edges });
    }, SAVE_DEBOUNCE_MS);

    if (!skipHistoryRef.current) {
      scheduleCommit({ nodes, edges });
    }
    skipHistoryRef.current = false;
  }, [nodes, viewport, edges, loaded, projectId, panelKey, scheduleCommit]);

  // 节点拖拽
  const onNodeDragStart = useCallback((event: React.MouseEvent, nodeId: string) => {
    event.stopPropagation();
    event.preventDefault();
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    dragStateRef.current = {
      nodeId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startNodeX: node.position.x,
      startNodeY: node.position.y,
    };

    const scale = viewport.k;
    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const dx = (e.clientX - drag.startClientX) / scale;
      const dy = (e.clientY - drag.startClientY) / scale;
      setNodes((prev) =>
        prev.map((n) =>
          n.id === drag.nodeId
            ? { ...n, position: { x: drag.startNodeX + dx, y: drag.startNodeY + dy } }
            : n,
        ),
      );
    };
    const handleMouseUp = () => {
      dragStateRef.current = null;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, [nodes, viewport.k]);

  const onNodeResize = useCallback(
    (nodeId: string, width: number, height: number, position?: Position) => {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === nodeId
            ? { ...n, width, height, position: position ?? n.position }
            : n,
        ),
      );
    },
    [],
  );

  const onNodeSelect = useCallback((nodeId: string, additive: boolean) => {
    setSelectedNodeIds((prev) => {
      if (additive) {
        const next = new Set(prev);
        if (next.has(nodeId)) next.delete(nodeId);
        else next.add(nodeId);
        return next;
      }
      return new Set([nodeId]);
    });
  }, []);

  const onCanvasDeselect = useCallback(() => {
    setSelectedNodeIds(new Set());
  }, []);

  const onSelectAll = useCallback(() => {
    setSelectedNodeIds(new Set(nodes.map((n) => n.id)));
  }, [nodes]);

  const onToggleMiniMap = useCallback(() => setIsMiniMapOpen((v) => !v), []);

  const onResetView = useCallback(() => {
    setViewport(DEFAULT_VIEWPORT);
  }, []);

  const onScaleChange = useCallback((scale: number) => {
    setViewport((v) => ({ ...v, k: scale }));
  }, []);

  // 撤销/重做
  const onUndo = useCallback(() => {
    const target = historyUndo();
    if (target) {
      skipHistoryRef.current = true;
      setNodes(target.nodes);
      setViewport((v) => v); // 视口不随 undo 变化
    }
  }, [historyUndo]);

  const onRedo = useCallback(() => {
    const target = historyRedo();
    if (target) {
      skipHistoryRef.current = true;
      setNodes(target.nodes);
    }
  }, [historyRedo]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  const nodeMap = useMemo(() => {
    const map = new Map<string, CanvasNode<T>>();
    for (const node of nodes) map.set(node.id, node);
    return map;
  }, [nodes]);

  return {
    containerRef,
    viewport,
    nodes,
    nodeMap,
    edges,
    selectedNodeIds,
    isMiniMapOpen,
    canUndo,
    canRedo,
    setViewport,
    onNodeDragStart,
    onNodeResize,
    onNodeSelect,
    onCanvasDeselect,
    onSelectAll,
    onToggleMiniMap,
    onResetView,
    onScaleChange,
    onUndo,
    onRedo,
  };
}
