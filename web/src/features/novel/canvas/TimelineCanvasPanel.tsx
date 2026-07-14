import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Drawer, Empty, Input, Select, Tag } from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, RedoOutlined, SaveOutlined, UndoOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";

import {
  CanvasMinimap,
  CanvasContextMenu,
  CanvasMenuItem,
  CanvasNodeShell,
  CanvasZoomControls,
  EdgePath,
  ActiveEdgePath,
  InfiniteCanvas,
  useCanvasKeyboard,
  type CanvasEdge,
  type ContextMenuState,
  type Position,
} from "@/shared/canvas";
import { appendOperation, novelDb, recordBase } from "../db";
import type { TimelineEvent } from "../types";
import { TimelineNodeContent } from "./TimelineNodeContent";
import { useCanvasPanel, type CanvasPanelItem } from "./useCanvasPanel";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 140;
const COL_SPACING = 320;
const ROW_SPACING = 200;

/**
 * 故事时间线画布面板。
 *
 * 将 TimelineEvent 渲染为画布节点，按 narrativeOrder 水平排列，parallelGroup 垂直分泳道。
 * cause→consequence 关系通过 consequenceIds 派生为画布连线。
 * 节点位置/视口持久化到 CanvasLayout (panelKey="timeline-canvas")。
 */
export function TimelineCanvasPanel({ projectId }: { projectId: string }) {
  const { message } = App.useApp();

  const events = useLiveQuery(
    () => novelDb.timelineEvents.where("projectId").equals(projectId).sortBy("narrativeOrder"),
    [projectId],
  ) ?? [];
  const characters = useLiveQuery(
    () => novelDb.entities.where("projectId").equals(projectId).and((item) => item.kind === "character").toArray(),
    [projectId],
  ) ?? [];

  const items = useMemo<CanvasPanelItem<TimelineEvent>[]>(
    () => events.map((event) => ({ id: event.id, kind: "timeline-event", data: event })),
    [events],
  );

  const edges = useMemo<CanvasEdge[]>(() => {
    const eventIds = new Set(events.map((e) => e.id));
    const result: CanvasEdge[] = [];
    for (const event of events) {
      for (const consequenceId of event.consequenceIds) {
        if (eventIds.has(consequenceId)) {
          result.push({
            id: `${event.id}->${consequenceId}`,
            fromNodeId: event.id,
            toNodeId: consequenceId,
            label: "导致",
            kind: "consequence",
          });
        }
      }
    }
    return result;
  }, [events]);

  // 时间线布局：按 narrativeOrder 水平排列，parallelGroup 垂直分泳道
  const timelineLayout = useMemo(() => {
    const groups = new Set<string>();
    for (const event of events) {
      groups.add(event.parallelGroup || "主线");
    }
    const groupLanes = new Map<string, number>();
    let laneIndex = 0;
    for (const group of groups) {
      groupLanes.set(group, laneIndex++);
    }
    return (_index: number, _total: number, item: CanvasPanelItem<TimelineEvent>): Position => {
      const x = (item.data.narrativeOrder || 0) * COL_SPACING;
      const lane = groupLanes.get(item.data.parallelGroup || "主线") ?? 0;
      const y = lane * ROW_SPACING;
      return { x, y };
    };
  }, [events]);

  const panel = useCanvasPanel<TimelineEvent>({
    projectId,
    panelKey: "timeline-canvas",
    items,
    edges,
    layoutStrategy: timelineLayout,
    defaultWidth: NODE_WIDTH,
    defaultHeight: NODE_HEIGHT,
  });

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingEvent, setEditingEvent] = useState<TimelineEvent | null>(null);
  const [eventDraft, setEventDraft] = useState<TimelineEvent | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
  const [connecting, setConnecting] = useState<{ sourceNodeId: string; mouseWorld: Position } | null>(null);
  const connectingRef = useRef(connecting);
  connectingRef.current = connecting;

  useEffect(() => {
    if (editingEvent) setEventDraft(structuredClone(editingEvent));
  }, [editingEvent]);

  useEffect(() => {
    const container = panel.containerRef.current;
    if (!container) return;
    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) setContainerSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [panel.containerRef]);

  const handleAddEvent = useCallback(async () => {
    const event: TimelineEvent = {
      ...recordBase(projectId),
      title: `新事件 ${events.length + 1}`,
      storyDate: "未定",
      duration: "",
      narrativeOrder: events.length,
      participantIds: [],
      causeIds: [],
      consequenceIds: [],
      description: "",
    };
    await novelDb.timelineEvents.add(event);
    await appendOperation(projectId, "timelineEvents", event.id, "create", { title: { before: null, after: event.title } });
    setEditingEvent(event);
  }, [projectId, events.length]);

  const handleDeleteEvent = useCallback(
    async (eventId: string) => {
      const target = await novelDb.timelineEvents.get(eventId);
      // 清理其他事件中对本事件的引用
      const related = events.filter((e) => e.causeIds.includes(eventId) || e.consequenceIds.includes(eventId));
      await novelDb.transaction("rw", novelDb.timelineEvents, novelDb.operations, async () => {
        for (const e of related) {
          const updated = {
            ...e,
            causeIds: e.causeIds.filter((id) => id !== eventId),
            consequenceIds: e.consequenceIds.filter((id) => id !== eventId),
          };
          await novelDb.timelineEvents.put({ ...updated, revision: e.revision + 1, updatedAt: Date.now() });
          await appendOperation(projectId, "timelineEvents", e.id, "update", { value: { before: e, after: updated } });
        }
        await novelDb.timelineEvents.delete(eventId);
        await appendOperation(projectId, "timelineEvents", eventId, "delete", { title: { before: target?.title ?? null, after: null } });
      });
      message.success("事件已删除");
    },
    [projectId, events, message],
  );

  const handleDeleteEdge = useCallback(
    async (edgeId: string) => {
      const [fromId, toId] = edgeId.split("->");
      const fromEvent = await novelDb.timelineEvents.get(fromId);
      const toEvent = await novelDb.timelineEvents.get(toId);
      if (!fromEvent || !toEvent) return;
      await novelDb.transaction("rw", novelDb.timelineEvents, novelDb.operations, async () => {
        const updatedFrom = { ...fromEvent, consequenceIds: fromEvent.consequenceIds.filter((id) => id !== toId) };
        const updatedTo = { ...toEvent, causeIds: toEvent.causeIds.filter((id) => id !== fromId) };
        await novelDb.timelineEvents.put({ ...updatedFrom, revision: fromEvent.revision + 1, updatedAt: Date.now() });
        await novelDb.timelineEvents.put({ ...updatedTo, revision: toEvent.revision + 1, updatedAt: Date.now() });
        await appendOperation(projectId, "timelineEvents", fromId, "update", { value: { before: fromEvent, after: updatedFrom } });
        await appendOperation(projectId, "timelineEvents", toId, "update", { value: { before: toEvent, after: updatedTo } });
      });
      message.success("因果关系已删除");
    },
    [projectId, message],
  );

  const handleSaveEvent = useCallback(async () => {
    if (!eventDraft) return;
    const before = await novelDb.timelineEvents.get(eventDraft.id);
    await novelDb.timelineEvents.put({ ...eventDraft, revision: (before?.revision ?? 0) + 1, updatedAt: Date.now() });
    await appendOperation(projectId, "timelineEvents", eventDraft.id, before ? "update" : "create", {
      value: { before, after: eventDraft },
    });
    setEditingEvent(null);
    setEventDraft(null);
    message.success("事件已保存");
  }, [projectId, eventDraft, message]);

  const handleCreateConnection = useCallback(
    async (fromId: string, toId: string) => {
      const fromEvent = await novelDb.timelineEvents.get(fromId);
      const toEvent = await novelDb.timelineEvents.get(toId);
      if (!fromEvent || !toEvent) return;
      if (fromEvent.consequenceIds.includes(toId)) return;
      await novelDb.transaction("rw", novelDb.timelineEvents, novelDb.operations, async () => {
        const updatedFrom = { ...fromEvent, consequenceIds: [...fromEvent.consequenceIds, toId] };
        const updatedTo = { ...toEvent, causeIds: [...toEvent.causeIds, fromId] };
        await novelDb.timelineEvents.put({ ...updatedFrom, revision: fromEvent.revision + 1, updatedAt: Date.now() });
        await novelDb.timelineEvents.put({ ...updatedTo, revision: toEvent.revision + 1, updatedAt: Date.now() });
        await appendOperation(projectId, "timelineEvents", fromId, "update", { value: { before: fromEvent, after: updatedFrom } });
        await appendOperation(projectId, "timelineEvents", toId, "update", { value: { before: toEvent, after: updatedTo } });
      });
      message.success("因果关系已建立");
    },
    [projectId, message],
  );

  const handleConnectStart = useCallback(
    (event: React.MouseEvent, nodeId: string, handleType: "source" | "target") => {
      if (handleType !== "source") return;
      event.stopPropagation();
      event.preventDefault();
      const container = panel.containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const vp = panel.viewport;
      const initialWorld: Position = {
        x: (event.clientX - rect.left - vp.x) / vp.k,
        y: (event.clientY - rect.top - vp.y) / vp.k,
      };
      setConnecting({ sourceNodeId: nodeId, mouseWorld: initialWorld });

      const handleMouseMove = (e: MouseEvent) => {
        const r = container.getBoundingClientRect();
        const world: Position = {
          x: (e.clientX - r.left - vp.x) / vp.k,
          y: (e.clientY - r.top - vp.y) / vp.k,
        };
        setConnecting({ sourceNodeId: nodeId, mouseWorld: world });
      };
      const handleMouseUp = (e: MouseEvent) => {
        const target = e.target as Element | null;
        const nodeEl = target?.closest("[data-node-id]");
        const targetId = nodeEl?.getAttribute("data-node-id");
        const srcId = connectingRef.current?.sourceNodeId;
        if (targetId && srcId && targetId !== srcId) {
          void handleCreateConnection(srcId, targetId);
        }
        setConnecting(null);
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [panel.containerRef, panel.viewport, handleCreateConnection],
  );

  const handleNodeMouseDown = useCallback(
    (event: React.MouseEvent, nodeId: string) => {
      panel.onNodeSelect(nodeId, event.shiftKey || event.ctrlKey || event.metaKey);
      panel.onNodeDragStart(event, nodeId);
    },
    [panel.onNodeSelect, panel.onNodeDragStart],
  );

  const handleNodeDoubleClick = useCallback(
    (nodeId: string) => {
      const node = panel.nodeMap.get(nodeId);
      if (node) setEditingEvent(node.data);
    },
    [panel.nodeMap],
  );

  const handleDelete = useCallback(async () => {
    if (selectedEdgeId) {
      await handleDeleteEdge(selectedEdgeId);
      setSelectedEdgeId(null);
      return;
    }
    if (panel.selectedNodeIds.size > 0) {
      const ids = [...panel.selectedNodeIds];
      for (const id of ids) await handleDeleteEvent(id);
      panel.onCanvasDeselect();
    }
  }, [selectedEdgeId, panel, handleDeleteEdge, handleDeleteEvent]);

  useCanvasKeyboard({
    onDelete: () => void handleDelete(),
    onUndo: panel.onUndo,
    onRedo: panel.onRedo,
    onSelectAll: panel.onSelectAll,
    onDeselect: panel.onCanvasDeselect,
  });

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const characterOptions = useMemo(
    () => characters.map((c) => ({ value: c.id, label: c.name })),
    [characters],
  );

  return (
    <div className="novel-view-content" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 12 }}>
      <header className="novel-section-title" style={{ flexShrink: 0 }}>
        <div>
          <span>TIMELINE CANVAS</span>
          <h2>故事时间线</h2>
          <p>拖拽节点重新布局，从节点右侧拉线建立因果关系，双击编辑事件。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button icon={<UndoOutlined />} disabled={!panel.canUndo} onClick={panel.onUndo}>撤销</Button>
          <Button icon={<RedoOutlined />} disabled={!panel.canRedo} onClick={panel.onRedo}>重做</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => void handleAddEvent()}>添加事件</Button>
        </div>
      </header>

      {events.length === 0 ? (
        <div className="novel-empty-panel" style={{ flex: 1 }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><strong>还没有事件</strong><span>创建事件后即可在画布上构建时间线。</span></>} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => void handleAddEvent()}>创建第一个事件</Button>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border" style={{ borderColor: "var(--ant-color-border)" }}>
          <InfiniteCanvas
            containerRef={panel.containerRef}
            viewport={panel.viewport}
            onViewportChange={panel.setViewport}
            onCanvasDeselect={panel.onCanvasDeselect}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu({ type: "canvas", x: event.clientX, y: event.clientY });
            }}
          >
            <svg
              className="absolute left-0 top-0"
              style={{ width: 1, height: 1, overflow: "visible", pointerEvents: "none" }}
            >
              {panel.edges.map((edge) => {
                const from = panel.nodeMap.get(edge.fromNodeId);
                const to = panel.nodeMap.get(edge.toNodeId);
                if (!from || !to) return null;
                const isActive = selectedEdgeId === edge.id || panel.selectedNodeIds.has(edge.fromNodeId) || panel.selectedNodeIds.has(edge.toNodeId);
                return (
                  <EdgePath
                    key={edge.id}
                    edge={edge}
                    from={from}
                    to={to}
                    active={isActive}
                    onSelect={() => setSelectedEdgeId(edge.id)}
                    onContextMenu={(event) => {
                      setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: edge.id });
                    }}
                  />
                );
              })}
              {connecting && (() => {
                const sourceNode = panel.nodeMap.get(connecting.sourceNodeId);
                if (!sourceNode) return null;
                return (
                  <ActiveEdgePath
                    node={sourceNode}
                    handle={{ nodeId: connecting.sourceNodeId, handleType: "source" }}
                    mouseWorld={connecting.mouseWorld}
                  />
                );
              })()}
            </svg>

            {panel.nodes.map((node) => (
              <CanvasNodeShell
                key={node.id}
                node={node}
                scale={panel.viewport.k}
                isSelected={panel.selectedNodeIds.has(node.id)}
                onMouseDown={handleNodeMouseDown}
                onResize={panel.onNodeResize}
                onConnectStart={handleConnectStart}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId: node.id });
                }}
              >
                <div onDoubleClick={() => handleNodeDoubleClick(node.id)} className="h-full">
                  <TimelineNodeContent event={node.data} />
                </div>
              </CanvasNodeShell>
            ))}
          </InfiniteCanvas>

          <CanvasZoomControls
            scale={panel.viewport.k}
            onScaleChange={panel.onScaleChange}
            onReset={panel.onResetView}
            isMiniMapOpen={panel.isMiniMapOpen}
            onToggleMiniMap={panel.onToggleMiniMap}
          />

          {panel.isMiniMapOpen && (
            <CanvasMinimap
              nodes={panel.nodes}
              viewport={panel.viewport}
              viewportSize={containerSize}
              onViewportChange={panel.setViewport}
            />
          )}

          {contextMenu && (
            <CanvasContextMenu menu={contextMenu} onClose={closeContextMenu}>
              {contextMenu.type === "node" && (
                <>
                  <CanvasMenuItem icon={<EditOutlined />} label="编辑事件" onClick={() => {
                    const node = panel.nodeMap.get(contextMenu.nodeId);
                    if (node) setEditingEvent(node.data);
                    closeContextMenu();
                  }} />
                  <CanvasMenuItem icon={<DeleteOutlined />} label="删除事件" danger onClick={() => {
                    void handleDeleteEvent(contextMenu.nodeId);
                    closeContextMenu();
                  }} />
                </>
              )}
              {contextMenu.type === "connection" && (
                <CanvasMenuItem icon={<DeleteOutlined />} label="删除因果关系" danger onClick={() => {
                  void handleDeleteEdge(contextMenu.connectionId);
                  closeContextMenu();
                }} />
              )}
              {contextMenu.type === "canvas" && (
                <CanvasMenuItem icon={<PlusOutlined />} label="添加事件" onClick={() => {
                  void handleAddEvent();
                  closeContextMenu();
                }} />
              )}
            </CanvasContextMenu>
          )}
        </div>
      )}

      <Drawer
        title="编辑事件"
        open={!!editingEvent}
        onClose={() => { setEditingEvent(null); setEventDraft(null); }}
        width={480}
        extra={<Button type="primary" icon={<SaveOutlined />} onClick={() => void handleSaveEvent()}>保存</Button>}
      >
        {eventDraft && (
          <div className="flex flex-col gap-4">
            <Input
              addonBefore="标题"
              value={eventDraft.title}
              onChange={(event) => setEventDraft({ ...eventDraft, title: event.target.value })}
            />
            <div className="flex gap-2">
              <Input
                addonBefore="故事日期"
                value={eventDraft.storyDate}
                onChange={(event) => setEventDraft({ ...eventDraft, storyDate: event.target.value })}
                className="flex-1"
              />
              <Input
                addonBefore="时长"
                value={eventDraft.duration}
                onChange={(event) => setEventDraft({ ...eventDraft, duration: event.target.value })}
                className="flex-1"
              />
            </div>
            <Input
              addonBefore="并行分组"
              value={eventDraft.parallelGroup ?? ""}
              onChange={(event) => setEventDraft({ ...eventDraft, parallelGroup: event.target.value || undefined })}
              placeholder="留空表示主线"
            />
            <Input.TextArea
              rows={4}
              value={eventDraft.description}
              placeholder="事件经过、原因与结果"
              onChange={(event) => setEventDraft({ ...eventDraft, description: event.target.value })}
            />
            <div>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span>参与角色</span>
                <Tag>{eventDraft.participantIds.length}</Tag>
              </div>
              <Select
                mode="multiple"
                value={eventDraft.participantIds}
                options={characterOptions}
                placeholder="选择参与事件的角色"
                onChange={(participantIds) => setEventDraft({ ...eventDraft, participantIds })}
              />
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
