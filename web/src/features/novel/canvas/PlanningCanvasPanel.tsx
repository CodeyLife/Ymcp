import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Drawer, Empty, Form, Input, Modal, Select, Tag } from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, SaveOutlined, UndoOutlined, RedoOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";

import {
  CanvasMinimap,
  CanvasContextMenu,
  CanvasMenuItem,
  CanvasNodeShell,
  CanvasZoomControls,
  EdgePath,
  InfiniteCanvas,
  useCanvasKeyboard,
  type CanvasEdge,
  type ContextMenuState,
  type Position,
} from "@/shared/canvas";
import { addOutlineNode, appendOperation, deleteOutlineBranch, novelDb } from "../db";
import type { OutlineKind, OutlineNode } from "../types";
import { PlanningNodeContent, type PlanningNodeData } from "./PlanningNodeContent";
import { useCanvasPanel, type CanvasPanelItem } from "./useCanvasPanel";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 130;
const COL_OUTLINE_X = 40;
const COL_ENTITY_X = 560;
const COL_THREAD_X = 1080;
const ROW_SPACING = 160;

const OUTLINE_KIND_OPTIONS: Array<{ value: OutlineKind; label: string }> = [
  { value: "act", label: "幕" },
  { value: "sequence", label: "序列" },
  { value: "event", label: "事件" },
];

/**
 * 策划工作台画布面板。
 *
 * 在同一画布上混合展示三类节点：
 * - 大纲节点（OutlineNode）：幕/序列/事件，按 parentId 构成父子边。
 * - 角色实体（StoryEntity kind=character）：通过 characterIds 与事件交叉引用。
 * - 剧情线（PlotThread）：通过 plotThreadIds 与事件交叉引用。
 *
 * 节点位置/视口持久化到 CanvasLayout (panelKey="planning-canvas")。
 * 边均为派生数据（不单独持久化），随领域数据实时刷新。
 */
export function PlanningCanvasPanel({ projectId }: { projectId: string }) {
  const { message } = App.useApp();

  const outlineNodes = useLiveQuery(
    () => novelDb.outlineNodes.where("projectId").equals(projectId).toArray(),
    [projectId],
  ) ?? [];
  const entities = useLiveQuery(
    () => novelDb.entities.where("projectId").equals(projectId).and((item) => item.kind === "character").toArray(),
    [projectId],
  ) ?? [];
  const threads = useLiveQuery(
    () => novelDb.plotThreads.where("projectId").equals(projectId).toArray(),
    [projectId],
  ) ?? [];

  const items = useMemo<CanvasPanelItem<PlanningNodeData>[]>(() => {
    const outlineItems: CanvasPanelItem<PlanningNodeData>[] = outlineNodes
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((node) => ({ id: node.id, kind: "outline", data: { type: "outline", node } }));
    const entityItems: CanvasPanelItem<PlanningNodeData>[] = entities.map((node) => ({
      id: node.id,
      kind: "entity",
      data: { type: "entity", node },
    }));
    const threadItems: CanvasPanelItem<PlanningNodeData>[] = threads.map((node) => ({
      id: node.id,
      kind: "thread",
      data: { type: "thread", node },
    }));
    return [...outlineItems, ...entityItems, ...threadItems];
  }, [outlineNodes, entities, threads]);

  const edges = useMemo<CanvasEdge[]>(() => {
    const result: CanvasEdge[] = [];
    for (const node of outlineNodes) {
      if (node.parentId) {
        result.push({
          id: `parent:${node.parentId}->${node.id}`,
          fromNodeId: node.parentId,
          toNodeId: node.id,
          label: "",
          kind: "parent-child",
        });
      }
      for (const entityId of node.characterIds) {
        result.push({
          id: `ref-char:${node.id}->${entityId}`,
          fromNodeId: node.id,
          toNodeId: entityId,
          label: "角色",
          kind: "reference",
        });
      }
      for (const threadId of node.plotThreadIds) {
        result.push({
          id: `ref-thread:${node.id}->${threadId}`,
          fromNodeId: node.id,
          toNodeId: threadId,
          label: "剧情线",
          kind: "reference",
        });
      }
    }
    return result;
  }, [outlineNodes]);

  const typeIndexMap = useMemo(() => {
    let outlineIdx = 0;
    let entityIdx = 0;
    let threadIdx = 0;
    const map = new Map<string, number>();
    for (const item of items) {
      if (item.data.type === "outline") map.set(item.id, outlineIdx++);
      else if (item.data.type === "entity") map.set(item.id, entityIdx++);
      else map.set(item.id, threadIdx++);
    }
    return map;
  }, [items]);

  const planningLayout = useCallback(
    (_index: number, _total: number, item: CanvasPanelItem<PlanningNodeData>): Position => {
      const idx = typeIndexMap.get(item.id) ?? 0;
      if (item.data.type === "outline") {
        return { x: COL_OUTLINE_X, y: idx * ROW_SPACING + 40 };
      }
      if (item.data.type === "entity") {
        return { x: COL_ENTITY_X, y: idx * ROW_SPACING + 40 };
      }
      return { x: COL_THREAD_X, y: idx * ROW_SPACING + 40 };
    },
    [typeIndexMap],
  );

  const panel = useCanvasPanel<PlanningNodeData>({
    projectId,
    panelKey: "planning-canvas",
    items,
    edges,
    layoutStrategy: planningLayout,
    defaultWidth: NODE_WIDTH,
    defaultHeight: NODE_HEIGHT,
  });

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingNode, setEditingNode] = useState<PlanningNodeData | null>(null);
  const [outlineDraft, setOutlineDraft] = useState<OutlineNode | null>(null);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });

  useEffect(() => {
    if (editingNode?.type === "outline") setOutlineDraft(structuredClone(editingNode.node));
    else setOutlineDraft(null);
  }, [editingNode]);

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

  const handleAddOutlineNode = useCallback(
    async (kind: OutlineKind) => {
      const roots = outlineNodes.filter((n) => !n.parentId);
      let parentId: string | undefined;
      if (kind === "sequence") parentId = roots.find((n) => n.kind === "act")?.id;
      if (kind === "event") parentId = outlineNodes.find((n) => n.kind === "sequence")?.id ?? roots.find((n) => n.kind === "act")?.id;
      const siblings = outlineNodes.filter((n) => n.parentId === parentId && n.kind === kind);
      const title = kind === "act" ? `第${siblings.length + 1}幕` : kind === "sequence" ? `序列 ${siblings.length + 1}` : `事件 ${siblings.length + 1}`;
      await addOutlineNode(projectId, parentId, kind, title, siblings.length);
    },
    [projectId, outlineNodes],
  );

  const handleDeleteNode = useCallback(
    async (nodeId: string) => {
      const node = panel.nodeMap.get(nodeId);
      if (!node) return;
      if (node.data.type === "outline") {
        await deleteOutlineBranch(projectId, nodeId);
        message.success("大纲节点已删除");
      } else if (node.data.type === "entity") {
        message.info("角色请在资料库中删除");
      } else {
        message.info("剧情线请在剧情线面板中删除");
      }
    },
    [projectId, panel.nodeMap, message],
  );

  const handleSaveOutline = useCallback(async () => {
    if (!outlineDraft) return;
    const before = await novelDb.outlineNodes.get(outlineDraft.id);
    const next = { ...outlineDraft, revision: (before?.revision ?? 0) + 1, updatedAt: Date.now() };
    await novelDb.outlineNodes.put(next);
    await appendOperation(projectId, "outlineNodes", outlineDraft.id, "update", { value: { before, after: next } });
    setEditingNode(null);
    setOutlineDraft(null);
    message.success("大纲节点已保存");
  }, [projectId, outlineDraft, message]);

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
      if (node) setEditingNode(node.data);
    },
    [panel.nodeMap],
  );

  const handleDelete = useCallback(async () => {
    if (selectedEdgeId) {
      setSelectedEdgeId(null);
      return;
    }
    if (panel.selectedNodeIds.size > 0) {
      const ids = [...panel.selectedNodeIds];
      for (const id of ids) await handleDeleteNode(id);
      panel.onCanvasDeselect();
    }
  }, [selectedEdgeId, panel, handleDeleteNode]);

  useCanvasKeyboard({
    onDelete: () => void handleDelete(),
    onUndo: panel.onUndo,
    onRedo: panel.onRedo,
    onSelectAll: panel.onSelectAll,
    onDeselect: panel.onCanvasDeselect,
  });

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const outlineStatusOptions = [
    { value: "idea", label: "构思" },
    { value: "planned", label: "已规划" },
    { value: "resolved", label: "已完成" },
  ];

  const totalCount = outlineNodes.length + entities.length + threads.length;

  return (
    <div className="novel-view-content" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 12 }}>
      <header className="novel-section-title" style={{ flexShrink: 0 }}>
        <div>
          <span>PLANNING CANVAS</span>
          <h2>策划工作台</h2>
          <p>大纲、角色、剧情线同屏可视化；父子边连接大纲层级，引用边连接事件与角色/剧情线。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button icon={<UndoOutlined />} disabled={!panel.canUndo} onClick={panel.onUndo}>撤销</Button>
          <Button icon={<RedoOutlined />} disabled={!panel.canRedo} onClick={panel.onRedo}>重做</Button>
          <Button icon={<PlusOutlined />} onClick={() => setAddModalOpen(true)}>添加大纲节点</Button>
        </div>
      </header>

      {totalCount === 0 ? (
        <div className="novel-empty-panel" style={{ flex: 1 }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><strong>画布为空</strong><span>先在全书架构或故事大纲中建立节点，或在此添加大纲节点。</span></>} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddModalOpen(true)}>添加第一个大纲节点</Button>
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
            </svg>

            {panel.nodes.map((node) => (
              <CanvasNodeShell
                key={node.id}
                node={node}
                scale={panel.viewport.k}
                isSelected={panel.selectedNodeIds.has(node.id)}
                onMouseDown={handleNodeMouseDown}
                onResize={panel.onNodeResize}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId: node.id });
                }}
              >
                <div onDoubleClick={() => handleNodeDoubleClick(node.id)} className="h-full">
                  <PlanningNodeContent data={node.data} />
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
                  <CanvasMenuItem icon={<EditOutlined />} label="编辑节点" onClick={() => {
                    const node = panel.nodeMap.get(contextMenu.nodeId);
                    if (node) setEditingNode(node.data);
                    closeContextMenu();
                  }} />
                  <CanvasMenuItem icon={<DeleteOutlined />} label="删除节点" danger onClick={() => {
                    void handleDeleteNode(contextMenu.nodeId);
                    closeContextMenu();
                  }} />
                </>
              )}
              {contextMenu.type === "canvas" && (
                <CanvasMenuItem icon={<PlusOutlined />} label="添加大纲节点" onClick={() => {
                  setAddModalOpen(true);
                  closeContextMenu();
                }} />
              )}
            </CanvasContextMenu>
          )}
        </div>
      )}

      <Drawer
        title="编辑大纲节点"
        open={!!outlineDraft}
        onClose={() => { setEditingNode(null); setOutlineDraft(null); }}
        width={480}
        extra={<Button type="primary" icon={<SaveOutlined />} onClick={() => void handleSaveOutline()}>保存</Button>}
      >
        {outlineDraft && (
          <Form layout="vertical" className="flex flex-col gap-2">
            <Form.Item label="标题">
              <Input value={outlineDraft.title} onChange={(e) => setOutlineDraft({ ...outlineDraft, title: e.target.value })} />
            </Form.Item>
            <Form.Item label="类型">
              <Tag>{outlineDraft.kind === "act" ? "幕" : outlineDraft.kind === "sequence" ? "序列" : "事件"}</Tag>
            </Form.Item>
            <Form.Item label="状态">
              <Select
                value={outlineDraft.status}
                options={outlineStatusOptions}
                onChange={(status) => setOutlineDraft({ ...outlineDraft, status })}
              />
            </Form.Item>
            <Form.Item label="摘要">
              <Input.TextArea
                rows={3}
                value={outlineDraft.summary}
                onChange={(e) => setOutlineDraft({ ...outlineDraft, summary: e.target.value })}
              />
            </Form.Item>
            <Form.Item label="因果关系">
              <Input.TextArea
                rows={2}
                value={outlineDraft.causality}
                onChange={(e) => setOutlineDraft({ ...outlineDraft, causality: e.target.value })}
              />
            </Form.Item>
            <Form.Item label="结果">
              <Input.TextArea
                rows={2}
                value={outlineDraft.outcome}
                onChange={(e) => setOutlineDraft({ ...outlineDraft, outcome: e.target.value })}
              />
            </Form.Item>
          </Form>
        )}
      </Drawer>

      <AddOutlineNodeModal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onCreate={async (kind) => {
          await handleAddOutlineNode(kind);
          setAddModalOpen(false);
        }}
      />
    </div>
  );
}

function AddOutlineNodeModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (kind: OutlineKind) => void | Promise<void>;
}) {
  const [form] = Form.useForm<{ kind: OutlineKind }>();
  return (
    <Modal
      title="添加大纲节点"
      open={open}
      onCancel={() => { form.resetFields(); onClose(); }}
      onOk={async () => {
        const values = await form.validateFields();
        await onCreate(values.kind);
        form.resetFields();
      }}
      okText="创建"
      cancelText="取消"
    >
      <Form form={form} layout="vertical" initialValues={{ kind: "act" }}>
        <Form.Item name="kind" label="类型" rules={[{ required: true, message: "请选择类型" }]}>
          <Select options={OUTLINE_KIND_OPTIONS} placeholder="选择大纲节点类型" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
