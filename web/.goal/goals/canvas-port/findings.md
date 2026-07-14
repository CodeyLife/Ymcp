# Findings — canvas-port

## Reference repo: infinite-canvas

Cloned to `.goal/goals/canvas-port/tmp/infinite-canvas/`. Tech stack matches current project: React + Vite + TypeScript + Ant Design + Tailwind + Zustand + Dexie (localforage). AGENTS.md conventions: canvas page in `pages/canvas/`, components in `components/canvas/`, state in `stores/canvas/`, utils in `lib/canvas/`.

### Core architecture (controlled-component pattern)

The canvas is built as **controlled components** — the page owns all state (viewport, nodes, edges, selection, history) and passes it down as props. This makes the core trivially reusable.

| File | Lines | Role | Generic? |
|---|---|---|---|
| `components/canvas/infinite-canvas.tsx` | 185 | Viewport container: pan (pointer-drag background / space-drag / middle-click), zoom (wheel, cursor-anchored), grid background (dots/lines/blank), ctrl+drag box-select guard. Renders children inside a `translate+scale` transformed div. | YES — port as-is |
| `components/canvas/canvas-connections.tsx` | 72 | `ConnectionPath` (bezier edge source-right → target-left) + `ActiveConnectionPath` (live drag edge). SVG `<path>`, transparent hit-area + visible stroke. | YES — port as-is |
| `components/canvas/canvas-mini-map.tsx` | 121 | Computes world bounds from nodes, renders scaled node rects + viewport indicator, click/drag to pan. | YES — generalize node color mapping |
| `components/canvas/canvas-context-menu.tsx` | 37 | Right-click menu (duplicate / delete) for node or connection. Closes on outside pointerdown. | YES — port, make actions pluggable |
| `components/canvas/canvas-zoom-controls.tsx` | 76 | Bottom-left dock: minimap toggle, reset view, zoom slider (5%–500%), shortcuts help modal. | YES — port as-is |
| `components/canvas/canvas-node.tsx` | 718 | AI-image-specific node (image/text/config/video/audio/group). Drag, resize, rotation, batch, mask edit, crop, upscale, split, prompt panel. | NO — too AI-specific. Design new generic `CanvasNodeShell` |
| `lib/canvas-theme.ts` | 62 | `canvasThemes` light/dark tokens: canvas bg/dot/line/selectionStroke, node fill/stroke/text/muted, toolbar panel/border/item. | YES — port, adapt to project theme |
| `types/canvas.ts` | — | `Position`, `ViewportTransform{x,y,k}`, `CanvasNodeType` enum, `CanvasNodeData`, `CanvasConnection`, `SelectionBox`, `ContextMenuState`, `ConnectionHandle`. | PARTIAL — drop AI node types, make `CanvasNode<T>` generic |

### State ownership (in page `project.tsx`, ~178KB)

- `viewport: ViewportTransform` — useState
- `nodes: CanvasNodeData[]` — useState
- `connections: CanvasConnection[]` — useState
- `selectedNodeIds: Set<string>` — useState
- `selectionBox: SelectionBox | null` — useState (ctrl+drag box)
- `contextMenu: ContextMenuState | null` — useState
- `dragState` / `resizeState` — useRef (pointer-driven, rAF-throttled)
- **Undo/redo**: `historyRef = useRef<{past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[]}>` with 400ms debounced commit via `historyCommitTimerRef`, `historyPausedRef` to skip commits during programmatic applies, `undoCanvas`/`redoCanvas` pop/push entries. Manual stack, no library. `historyState` mirror in useState for toolbar button enable/disable.

### Node interactions (scattered across page + canvas-node.tsx)

- Single click select; shift/ctrl+click additive select; ctrl+drag on background = box select.
- Node drag: pointerdown on node → capture → pointermove updates position (rAF-throttled) → pointerup commits to history.
- Node resize: 8 handles (corners + edges).
- Keyboard: Delete/Backspace (delete), Ctrl+C/V (copy/paste), Ctrl+Z/Y (undo/redo), Ctrl+A (select all), Escape (deselect).
- Connection creation: drag from node source handle → drop on target node.

### What NOT to port (per scope decision)

AI image generation, prompt library, agent chat, asset picker, video/audio/image settings panels, mask/crop/upscale/split/angle dialogs, batch generation, local agent panel, resource mentions.

---

## Current project (Ymcp web) integration targets

### Novel data model relevant to canvas (from `src/features/novel/types.ts`)

| Domain type | Canvas panel | Node source | Edge source |
|---|---|---|---|
| `StoryEntity` (kind=character) + `EntityRelation` | 人物关系图 | characters | `EntityRelation` (fromEntityId→toEntityId, affinity/trust/conflict) |
| `TimelineEvent` (causeIds/consequenceIds/parallelGroup/narrativeOrder) | 情节时间线 | timelineEvents | cause→consequence, parallelGroup = swimlane |
| `StoryEntity` (kind=location/organization/faction/item/species/rule/ability/term) | 世界观/设定地图 | non-character entities | (group by kind, free-form edges) |
| `OutlineNode` (act/sequence/event, parentId) + mixed | 策划工作台 | outlineNodes + entities + threads | parent→child + cross-references |

### Persistence layer (`src/features/novel/db.ts`)

- `NovelDatabase extends Dexie` ("ymcp-novel-db-v4"), version 5.
- All records extend `VersionedRecord` (id, projectId, schemaVersion, revision, timestamps, deletedAt).
- `appendOperation()` writes change log for sync.
- `useLiveQuery` from dexie-react-hooks for reactive queries.
- Existing `NovelWorkspaceView` union already includes: `characters`, `relations`, `outline`, `board`, `timeline`, `threads`, `foreshadowing`, `bible`, `planning`.

### Existing `PlanningWorkspace.tsx`

Three modes (architecture / outline / matrix). Outline mode uses a tree+detail layout. Canvas integration = add a 4th mode "board" (free-form canvas) OR convert outline mode to canvas-backed. Decision: add canvas as a new view mode alongside existing tree, keep existing UI working.

---

## Port architecture decision

### Target folder: `src/shared/canvas/`

Reusable base capability, feature-agnostic. Novel panels import from here.

```
src/shared/canvas/
  types.ts                    — Generic types: Position, ViewportTransform, CanvasNode<T>, CanvasEdge, SelectionBox, ContextMenuState, ConnectionHandle, CanvasHistoryEntry
  canvas-theme.ts             — Theme tokens (port canvasThemes; integrate with project's existing theme system if any, else standalone)
  components/
    InfiniteCanvas.tsx        — Viewport container (port, controlled)
    CanvasEdges.tsx            — EdgePath + ActiveEdgePath (port, generalize)
    CanvasMinimap.tsx          — Minimap (port, generalize node color via prop)
    CanvasContextMenu.tsx      — Right-click menu (port, pluggable actions)
    CanvasZoomControls.tsx     — Zoom dock (port)
    CanvasNodeShell.tsx        — NEW generic node: drag/resize/select handles, renders children (pluggable content)
  hooks/
    useCanvasHistory.ts        — Undo/redo stack (extract from page, generic)
    useCanvasKeyboard.ts       — Keyboard shortcuts (delete/copy/paste/undo/redo/select-all)
    useCanvasBoxSelect.ts      — Ctrl+drag box selection
  layout/
    CanvasViewport.tsx         — Higher-level wrapper bundling InfiniteCanvas + edges + minimap + zoom + context menu + history + keyboard, takes nodes/edges + renderNode callback
```

### Generic node type

```ts
export interface CanvasNode<T = unknown> {
  id: string;
  position: Position;
  width: number;
  height: number;
  kind: string;          // domain-specific kind, e.g. "character" | "event" | "location"
  data: T;               // domain payload (entity/event/etc.)
  groupId?: string;
}
export interface CanvasEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label?: string;
  kind?: string;
}
```

### Persistence: new Dexie stores in `NovelDatabase`

Per (projectId, panelKey) canvas layout. Keeps canvas positions separate from domain data so one entity can appear in multiple canvases.

```ts
export interface CanvasLayout extends VersionedRecord {
  panelKey: string;        // "characters" | "timeline" | "worldview" | "planning-board"
  viewport: ViewportTransform;
  nodes: Array<{ id: string; entityId?: string; kind: string; x: number; y: number; width: number; height: number; groupId?: string }>;
  edges: Array<{ id: string; fromNodeId: string; toNodeId: string; label?: string; kind?: string }>;
}
```

Add `canvasLayouts` store to NovelDatabase v6. Domain entity data stays in existing stores (entities/relations/timelineEvents/etc.); canvas layout only stores positions + references.

### Novel panel integration pattern

Each canvas-backed panel:
1. Loads domain data via `useLiveQuery` (existing pattern).
2. Loads/saves `CanvasLayout` via new db helpers.
3. Renders `<CanvasViewport nodes={...} edges={...} renderNode={(node) => <CharacterNode .../>} ... />`.
4. Node content components live under `src/features/novel/canvas/` (e.g. `CharacterCanvasNode.tsx`, `TimelineCanvasNode.tsx`, `WorldviewCanvasNode.tsx`, `PlanningCanvasNode.tsx`).

### Routing / view wiring

Add canvas views to `NovelWorkspaceView` (already has `relations`/`timeline`/`board`). Wire into the existing workspace view switcher. The four target panels:
- `relations` → character relationship canvas (replaces or supplements list view)
- `timeline` → plot timeline canvas
- `board` → worldview/setting map canvas (or new `worldview` key)
- planning "board" mode → free-form planning canvas

---

## Open questions deferred to implementation loops

1. Whether to convert existing tree-based outline view to canvas, or offer canvas as an alternative view (decision: alternative, keep tree).
2. Whether canvas layout auto-arranges on first load (e.g., force-directed for relations, timeline-axis for events) or starts empty. Both — auto-layout on first load, free-edit after.
3. Sync between canvas edits and domain data: editing a node title should update the underlying entity. Wire via existing `updateEntity`/`updateOutlineNode` etc.
