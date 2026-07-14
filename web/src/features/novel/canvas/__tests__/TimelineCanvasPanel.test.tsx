import { renderToStaticMarkup } from "react-dom/server";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import { describe, expect, it, vi } from "vitest";

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => undefined,
}));
vi.mock("../../../db", () => ({
  addEntity: vi.fn(),
  updateEntity: vi.fn(),
  appendOperation: vi.fn(),
  novelDb: {
    entities: { where: () => ({ equals: () => ({ and: () => ({ toArray: () => Promise.resolve([]) }) }) }) },
    timelineEvents: { where: () => ({ equals: () => ({ sortBy: () => Promise.resolve([]) }) }), delete: vi.fn(), get: vi.fn(), put: vi.fn(), add: vi.fn() },
    operations: {},
    transaction: vi.fn(async (_mode, ..._stores) => {}),
  },
  recordBase: (projectId: string) => ({
    id: "test-id",
    projectId,
    schemaVersion: 4,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    createdBy: "test",
    updatedBy: "test",
  }),
  getCanvasLayout: vi.fn(async () => undefined),
  saveCanvasLayout: vi.fn(async () => ({})),
}));

import { TimelineNodeContent } from "../TimelineNodeContent";
import { TimelineCanvasPanel } from "../TimelineCanvasPanel";
import type { TimelineEvent } from "../../types";

function WithTheme({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      <App>{children}</App>
    </ConfigProvider>
  );
}

const sampleEvent: TimelineEvent = {
  id: "event-1",
  projectId: "p1",
  schemaVersion: 4,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  createdBy: "test",
  updatedBy: "test",
  title: "发现缺页",
  storyDate: "第三日",
  duration: "半天",
  narrativeOrder: 2,
  participantIds: [],
  causeIds: [],
  consequenceIds: [],
  description: "陆沉在档案馆发现一页关键证词被人撕去。",
  parallelGroup: "主线",
};

describe("TimelineNodeContent", () => {
  it("renders title, storyDate, and description", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <TimelineNodeContent event={sampleEvent} />
      </WithTheme>,
    );
    expect(html).toContain("发现缺页");
    expect(html).toContain("第三日");
    expect(html).toContain("陆沉在档案馆发现一页关键证词被人撕去。");
  });

  it("renders order badge as zero-padded narrativeOrder+1", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <TimelineNodeContent event={sampleEvent} />
      </WithTheme>,
    );
    expect(html).toContain("03");
  });

  it("renders duration when set", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <TimelineNodeContent event={sampleEvent} />
      </WithTheme>,
    );
    expect(html).toContain("半天");
  });

  it("renders parallelGroup tag when set", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <TimelineNodeContent event={sampleEvent} />
      </WithTheme>,
    );
    expect(html).toContain("主线");
  });

  it("falls back to placeholder when description is empty", () => {
    const event = { ...sampleEvent, description: "" };
    const html = renderToStaticMarkup(
      <WithTheme>
        <TimelineNodeContent event={event} />
      </WithTheme>,
    );
    expect(html).toContain("尚未描述");
  });

  it("includes data-timeline-node attribute for edge drop targeting", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <TimelineNodeContent event={sampleEvent} />
      </WithTheme>,
    );
    expect(html).toContain('data-timeline-node="event-1"');
  });
});

describe("TimelineCanvasPanel", () => {
  it("renders the panel header with title and action buttons in empty state", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <TimelineCanvasPanel projectId="p1" />
      </WithTheme>,
    );
    expect(html).toContain("故事时间线");
    expect(html).toContain("TIMELINE CANVAS");
    expect(html).toContain("添加事件");
  });

  it("renders empty state message when no events exist", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <TimelineCanvasPanel projectId="p1" />
      </WithTheme>,
    );
    expect(html).toContain("还没有事件");
    expect(html).toContain("创建第一个事件");
  });

  it("renders undo and redo buttons", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <TimelineCanvasPanel projectId="p1" />
      </WithTheme>,
    );
    expect(html).toContain("撤销");
    expect(html).toContain("重做");
  });
});
