import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Drawer, Empty, Segmented } from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, SaveOutlined, UndoOutlined, RedoOutlined, ApartmentOutlined, TableOutlined } from "@ant-design/icons";
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
import { addEntity, appendOperation, novelDb, recordBase, updateEntity } from "../db";
import type { EntityRelation, StoryEntity } from "../types";
import CharacterCard from "../CharacterCard";
import { CharacterNodeContent } from "./CharacterNodeContent";
import { useCanvasPanel, type CanvasPanelItem } from "./useCanvasPanel";
import CreateRelationModal from "./CreateRelationModal";
import RelationEditorDrawer from "./RelationEditorDrawer";
import RelationMatrixView from "./RelationMatrixView";

type RelationViewMode = "canvas" | "matrix";

/**
 * 人物关系图画布面板。
 *
 * 将 StoryEntity (kind=character) 渲染为画布节点，EntityRelation 渲染为连线。
 * 节点位置/视口/连线持久化到 CanvasLayout (panelKey="character-canvas")。
 * 领域数据通过 useLiveQuery 实时同步。
 */
export function CharacterCanvasPanel({ projectId }: { projectId: string }) {
  const { message } = App.useApp();

  const entities = useLiveQuery(
    () => novelDb.entities.where("projectId").equals(projectId).and((item) => item.kind === "character").toArray(),
    [projectId],
  ) ?? [];
  const relations = useLiveQuery(
    () => novelDb.relations.where("projectId").equals(projectId).toArray(),
    [projectId],
  ) ?? [];

  const items = useMemo<CanvasPanelItem<StoryEntity>[]>(
    () => entities.map((entity) => ({ id: entity.id, kind: "character", data: entity })),
    [entities],
  );
  const edges = useMemo<CanvasEdge[]>(
    () =>
      relations
        .filter(
          (r) =>
            entities.some((e) => e.id === r.fromEntityId) &&
            entities.some((e) => e.id === r.toEntityId),
        )
        .map((relation) => ({
          id: relation.id,
          fromNodeId: relation.fromEntityId,
          toNodeId: relation.toEntityId,
          label: relation.relationType,
          kind: "relation",
        })),
    [relations, entities],
  );

  const panel = useCanvasPanel<StoryEntity>({
    projectId,
    panelKey: "character-canvas",
    items,
    edges,
    layoutStrategy: "circle",
    defaultWidth: 240,
    defaultHeight: 160,
  });

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [viewMode, setViewMode] = useState<RelationViewMode>("canvas");
  const [editingCharacter, setEditingCharacter] = useState<StoryEntity | null>(null);
  const [characterDraft, setCharacterDraft] = useState<StoryEntity | null>(null);
  const [editingRelation, setEditingRelation] = useState<EntityRelation | null>(null);
  const [relationDraft, setRelationDraft] = useState<EntityRelation | null>(null);
  const [relationModalOpen, setRelationModalOpen] = useState(false);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
  const [connecting, setConnecting] = useState<{ sourceNodeId: string; mouseWorld: Position } | null>(null);
  const connectingRef = useRef(connecting);
  connectingRef.current = connecting;

  useEffect(() => {
    if (editingCharacter) setCharacterDraft(structuredClone(editingCharacter));
  }, [editingCharacter]);
  useEffect(() => {
    if (editingRelation) setRelationDraft(structuredClone(editingRelation));
  }, [editingRelation]);

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

  const handleAddCharacter = useCallback(async () => {
    const entity = await addEntity(projectId, "character", `新角色 ${entities.length + 1}`);
    setEditingCharacter(entity);
  }, [projectId, entities.length]);

  const handleDeleteCharacter = useCallback(
    async (entityId: string) => {
      const related = relations.filter((r) => r.fromEntityId === entityId || r.toEntityId === entityId);
      await novelDb.transaction("rw", novelDb.entities, novelDb.relations, novelDb.operations, async () => {
        for (const r of related) {
          await novelDb.relations.delete(r.id);
          await appendOperation(projectId, "relations", r.id, "delete", { value: { before: r, after: null } });
        }
        const entity = await novelDb.entities.get(entityId);
        await novelDb.entities.delete(entityId);
        await appendOperation(projectId, "entities", entityId, "delete", { name: { before: entity?.name ?? null, after: null } });
      });
      message.success("角色已删除");
    },
    [projectId, relations, message],
  );

  const handleDeleteRelation = useCallback(
    async (relationId: string) => {
      const relation = await novelDb.relations.get(relationId);
      await novelDb.relations.delete(relationId);
      await appendOperation(projectId, "relations", relationId, "delete", { value: { before: relation, after: null } });
      message.success("关系已删除");
    },
    [projectId, message],
  );

  const handleSaveCharacter = useCallback(async () => {
    if (!characterDraft) return;
    await updateEntity(characterDraft);
    setEditingCharacter(null);
    setCharacterDraft(null);
    message.success("角色已保存");
  }, [characterDraft, message]);

  const handleSaveRelation = useCallback(async () => {
    if (!relationDraft) return;
    const before = await novelDb.relations.get(relationDraft.id);
    await novelDb.relations.put({ ...relationDraft, revision: (before?.revision ?? 0) + 1, updatedAt: Date.now() });
    await appendOperation(projectId, "relations", relationDraft.id, before ? "update" : "create", {
      value: { before, after: relationDraft },
    });
    setEditingRelation(null);
    setRelationDraft(null);
    message.success("关系已保存");
  }, [projectId, relationDraft, message]);

  const handleCreateRelation = useCallback(
    async (fromEntityId: string, toEntityId: string) => {
      const relation: EntityRelation = {
        ...recordBase(projectId),
        fromEntityId,
        toEntityId,
        relationType: "同伴",
        publicLabel: "",
        privateTruth: "",
        bond: "",
        history: [],
      };
      await novelDb.relations.add(relation);
      await appendOperation(projectId, "relations", relation.id, "create", {
        relationType: { before: null, after: relation.relationType },
      });
      setEditingRelation(relation);
    },
    [projectId],
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
          void handleCreateRelation(srcId, targetId);
        }
        setConnecting(null);
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [panel.containerRef, panel.viewport, handleCreateRelation],
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
      if (node) setEditingCharacter(node.data);
    },
    [panel.nodeMap],
  );

  const handleDelete = useCallback(async () => {
    if (selectedEdgeId) {
      await handleDeleteRelation(selectedEdgeId);
      setSelectedEdgeId(null);
      return;
    }
    if (panel.selectedNodeIds.size > 0) {
      const ids = [...panel.selectedNodeIds];
      for (const id of ids) await handleDeleteCharacter(id);
      panel.onCanvasDeselect();
    }
  }, [selectedEdgeId, panel, handleDeleteRelation, handleDeleteCharacter]);

  useCanvasKeyboard({
    onDelete: () => void handleDelete(),
    onUndo: panel.onUndo,
    onRedo: panel.onRedo,
    onSelectAll: panel.onSelectAll,
    onDeselect: panel.onCanvasDeselect,
  });

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  return (
    <div className="novel-view-content" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 12 }}>
      <header className="novel-section-title" style={{ flexShrink: 0 }}>
        <div>
          <span>RELATIONSHIP CANVAS</span>
          <h2>{viewMode === "canvas" ? "人物关系图" : "关系矩阵"}</h2>
          <p>{viewMode === "canvas"
            ? "拖拽节点重新布局，从节点右侧拉线建立关系，双击编辑角色。"
            : "行=起点，列=终点。点击空单元格快速创建，点击有色单元格编辑。"}</p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented
            value={viewMode}
            onChange={(value) => setViewMode(value as RelationViewMode)}
            options={[
              { value: "canvas", label: (<span><ApartmentOutlined /> 关系图</span>) },
              { value: "matrix", label: (<span><TableOutlined /> 关系矩阵</span>) },
            ]}
          />
          {viewMode === "canvas" && (
            <>
              <Button icon={<UndoOutlined />} disabled={!panel.canUndo} onClick={panel.onUndo}>撤销</Button>
              <Button icon={<RedoOutlined />} disabled={!panel.canRedo} onClick={panel.onRedo}>重做</Button>
            </>
          )}
          <Button icon={<PlusOutlined />} onClick={() => void handleAddCharacter()}>添加角色</Button>
          <Button type="primary" icon={<PlusOutlined />} disabled={entities.length < 2} onClick={() => setRelationModalOpen(true)}>建立关系</Button>
        </div>
      </header>

      {entities.length === 0 ? (
        <div className="novel-empty-panel" style={{ flex: 1 }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><strong>还没有角色</strong><span>创建角色后即可在画布上构建关系网络。</span></>} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => void handleAddCharacter()}>创建第一个角色</Button>
        </div>
      ) : viewMode === "matrix" ? (
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border novel-relation-matrix-container" style={{ borderColor: "var(--ant-color-border)" }}>
          <RelationMatrixView
            entities={entities}
            relations={relations}
            onEditRelation={(relation) => setEditingRelation(relation)}
            onCreateRelation={handleCreateRelation}
            onEditCharacter={(entity) => setEditingCharacter(entity)}
          />
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
                    onSelect={() => {
                      setSelectedEdgeId(edge.id);
                      const relation = relations.find((r) => r.id === edge.id);
                      if (relation) setEditingRelation(relation);
                    }}
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
                  <CharacterNodeContent entity={node.data} />
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
                  <CanvasMenuItem icon={<EditOutlined />} label="编辑角色" onClick={() => {
                    const node = panel.nodeMap.get(contextMenu.nodeId);
                    if (node) setEditingCharacter(node.data);
                    closeContextMenu();
                  }} />
                  <CanvasMenuItem icon={<DeleteOutlined />} label="删除角色" danger onClick={() => {
                    void handleDeleteCharacter(contextMenu.nodeId);
                    closeContextMenu();
                  }} />
                </>
              )}
              {contextMenu.type === "connection" && (
                <>
                  <CanvasMenuItem icon={<EditOutlined />} label="编辑关系" onClick={() => {
                    const relation = relations.find((r) => r.id === contextMenu.connectionId);
                    if (relation) setEditingRelation(relation);
                    closeContextMenu();
                  }} />
                  <CanvasMenuItem icon={<DeleteOutlined />} label="删除关系" danger onClick={() => {
                    void handleDeleteRelation(contextMenu.connectionId);
                    closeContextMenu();
                  }} />
                </>
              )}
              {contextMenu.type === "canvas" && (
                <CanvasMenuItem icon={<PlusOutlined />} label="添加角色" onClick={() => {
                  void handleAddCharacter();
                  closeContextMenu();
                }} />
              )}
            </CanvasContextMenu>
          )}
        </div>
      )}

      <Drawer
        title="编辑角色"
        open={!!editingCharacter}
        onClose={() => { setEditingCharacter(null); setCharacterDraft(null); }}
        width={520}
        extra={<Button type="primary" icon={<SaveOutlined />} onClick={() => void handleSaveCharacter()}>保存</Button>}
      >
        {characterDraft && (
          <CharacterCard
            entity={characterDraft}
            mode="detail"
            editable
            onChange={(next) => setCharacterDraft(next as StoryEntity)}
          />
        )}
      </Drawer>

      <RelationEditorDrawer
        relation={editingRelation}
        draft={relationDraft}
        entities={entities}
        onDraftChange={(next) => setRelationDraft(next)}
        onSave={() => void handleSaveRelation()}
        onClose={() => { setEditingRelation(null); setRelationDraft(null); }}
      />

      <CreateRelationModal
        open={relationModalOpen}
        entities={entities}
        onClose={() => setRelationModalOpen(false)}
        onCreate={async (fromId, toId) => {
          await handleCreateRelation(fromId, toId);
          setRelationModalOpen(false);
        }}
      />
    </div>
  );
}
