import { renderToStaticMarkup } from "react-dom/server";
import { ConfigProvider, theme as antdTheme } from "antd";
import { describe, expect, it, vi } from "vitest";

import { InfiniteCanvas } from "../components/InfiniteCanvas";
import { CanvasNodeShell } from "../components/CanvasNodeShell";
import { EdgePath, ActiveEdgePath } from "../components/CanvasEdges";
import type { CanvasEdge, CanvasNode, Position, ViewportTransform } from "../types";

function WithTheme({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      {children}
    </ConfigProvider>
  );
}

const noOp = () => {};
const noOpEvent = vi.fn();

describe("InfiniteCanvas SSR", () => {
  it("renders the viewport container with grid background and transformed children layer", () => {
    const viewport: ViewportTransform = { x: 100, y: 50, k: 1.5 };
    const containerRef = { current: null } as React.RefObject<HTMLDivElement | null>;
    const html = renderToStaticMarkup(
      <WithTheme>
        <InfiniteCanvas
          containerRef={containerRef}
          viewport={viewport}
          onViewportChange={noOp}
          onCanvasMouseDown={noOpEvent}
          onCanvasDeselect={noOp}
          onContextMenu={noOpEvent}
        >
          <div data-testid="child">child-content</div>
        </InfiniteCanvas>
      </WithTheme>,
    );

    expect(html).toContain("child-content");
    expect(html).toContain("translate(100px, 50px) scale(1.5)");
  });

  it("renders dots background when mode is dots", () => {
    const viewport: ViewportTransform = { x: 0, y: 0, k: 1 };
    const containerRef = { current: null } as React.RefObject<HTMLDivElement | null>;
    const html = renderToStaticMarkup(
      <WithTheme>
        <InfiniteCanvas
          containerRef={containerRef}
          viewport={viewport}
          backgroundMode="dots"
          onViewportChange={noOp}
        >
          <span>marker</span>
        </InfiniteCanvas>
      </WithTheme>,
    );

    expect(html).toContain("radial-gradient");
  });

  it("omits the grid layer when mode is blank", () => {
    const viewport: ViewportTransform = { x: 0, y: 0, k: 1 };
    const containerRef = { current: null } as React.RefObject<HTMLDivElement | null>;
    const html = renderToStaticMarkup(
      <WithTheme>
        <InfiniteCanvas
          containerRef={containerRef}
          viewport={viewport}
          backgroundMode="blank"
          onViewportChange={noOp}
        >
          <span>marker</span>
        </InfiniteCanvas>
      </WithTheme>,
    );

    expect(html).not.toContain("radial-gradient");
    expect(html).not.toContain("linear-gradient");
  });
});

describe("CanvasNodeShell SSR", () => {
  type Domain = { title: string };

  const sampleNode: CanvasNode<Domain> = {
    id: "node-1",
    kind: "character",
    position: { x: 200, y: 120 },
    width: 240,
    height: 160,
    data: { title: "陆沉" },
  };

  it("renders with data-node-id and applies the translate transform", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <CanvasNodeShell
          node={sampleNode}
          scale={1}
          isSelected={false}
          onMouseDown={noOpEvent}
          onResize={noOp}
          onContextMenu={noOpEvent}
        >
          <div>node-body</div>
        </CanvasNodeShell>
      </WithTheme>,
    );

    expect(html).toContain('data-node-id="node-1"');
    expect(html).toContain("translate(200px, 120px)");
    expect(html).toContain("node-body");
  });

  it("renders children content (domain payload)", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <CanvasNodeShell
          node={sampleNode}
          scale={1}
          isSelected={false}
          onMouseDown={noOpEvent}
          onResize={noOp}
          onContextMenu={noOpEvent}
        >
          <div className="character-card">
            <h3>{sampleNode.data.title}</h3>
            <p>主角</p>
          </div>
        </CanvasNodeShell>
      </WithTheme>,
    );

    expect(html).toContain("陆沉");
    expect(html).toContain("主角");
  });

  it("applies z-50 class when selected", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <CanvasNodeShell
          node={sampleNode}
          scale={1}
          isSelected={true}
          onMouseDown={noOpEvent}
          onResize={noOp}
          onContextMenu={noOpEvent}
        >
          <span>selected</span>
        </CanvasNodeShell>
      </WithTheme>,
    );

    expect(html).toContain("z-50");
  });

  it("omits resize handles when resizable is false", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <CanvasNodeShell
          node={sampleNode}
          scale={1}
          isSelected={false}
          resizable={false}
          onMouseDown={noOpEvent}
          onResize={noOp}
          onContextMenu={noOpEvent}
        >
          <span>no-resize</span>
        </CanvasNodeShell>
      </WithTheme>,
    );

    expect(html).not.toContain("nwse-resize");
    expect(html).not.toContain("nesw-resize");
  });
});

describe("EdgePath SSR", () => {
  type Domain = { label: string };

  const fromNode: CanvasNode<Domain> = {
    id: "from",
    kind: "character",
    position: { x: 0, y: 0 },
    width: 200,
    height: 100,
    data: { label: "A" },
  };
  const toNode: CanvasNode<Domain> = {
    id: "to",
    kind: "character",
    position: { x: 400, y: 0 },
    width: 200,
    height: 100,
    data: { label: "B" },
  };
  const edge: CanvasEdge = {
    id: "edge-1",
    fromNodeId: "from",
    toNodeId: "to",
    label: "盟友",
  };

  it("renders a bezier path with data-connection-id and the label text", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <svg>
          <EdgePath edge={edge} from={fromNode} to={toNode} active={false} onSelect={noOp} />
        </svg>
      </WithTheme>,
    );

    expect(html).toContain('data-connection-id="edge-1"');
    expect(html).toContain("盟友");
    expect(html).toContain("<path");
    expect(html).toContain("M 200 50");
  });

  it("applies active styling when active is true", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <svg>
          <EdgePath edge={edge} from={fromNode} to={toNode} active={true} onSelect={noOp} />
        </svg>
      </WithTheme>,
    );

    expect(html).toContain("drop-shadow");
  });
});

describe("ActiveEdgePath SSR", () => {
  type Domain = { label: string };

  const sourceNode: CanvasNode<Domain> = {
    id: "src",
    kind: "character",
    position: { x: 0, y: 0 },
    width: 200,
    height: 100,
    data: { label: "A" },
  };

  it("renders a dashed path from the source handle to the mouse world position", () => {
    const mouseWorld: Position = { x: 500, y: 300 };
    const html = renderToStaticMarkup(
      <WithTheme>
        <svg>
          <ActiveEdgePath
            node={sourceNode}
            handle={{ nodeId: "src", handleType: "source" }}
            mouseWorld={mouseWorld}
          />
        </svg>
      </WithTheme>,
    );

    expect(html).toContain("stroke-dasharray=\"5,5\"");
    expect(html).toContain("M 200 50");
    expect(html).toContain("500");
    expect(html).toContain("300");
  });

  it("returns null (no path) when node is undefined", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <svg>
          <ActiveEdgePath
            node={undefined}
            handle={{ nodeId: "src", handleType: "source" }}
            mouseWorld={{ x: 100, y: 100 }}
          />
        </svg>
      </WithTheme>,
    );

    expect(html).not.toContain("<path");
  });
});
