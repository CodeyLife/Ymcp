import { renderToStaticMarkup } from "react-dom/server";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useLiveQueryMock } = vi.hoisted(() => ({
  useLiveQueryMock: vi.fn<(...args: unknown[]) => unknown>(() => undefined),
}));

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: useLiveQueryMock,
}));
vi.mock("../db", () => ({
  addEntity: vi.fn(),
  updateEntity: vi.fn(),
  appendOperation: vi.fn(),
  commitFormalRecordChanges: vi.fn(),
  isFormalMutationRuntimeEnabled: () => false,
  novelDb: {
    entities: { where: () => ({ equals: () => ({ and: () => ({ toArray: () => Promise.resolve([]) }) }) }), get: vi.fn(), delete: vi.fn() },
    relations: { where: () => ({ equals: () => ({ toArray: () => Promise.resolve([]) }) }), delete: vi.fn(), get: vi.fn(), put: vi.fn(), add: vi.fn() },
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
}));

import { WorldviewLibraryPanel } from "../WorldviewLibraryPanel";
import type { StoryEntity } from "../types";

function WithTheme({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      <App>{children}</App>
    </ConfigProvider>
  );
}

const sampleEntity: StoryEntity = {
  id: "loc-1",
  projectId: "p1",
  schemaVersion: 4,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  createdBy: "test",
  updatedBy: "test",
  kind: "location",
  name: "旧档案馆",
  aliases: [],
  summary: "城市记忆的存放地",
  description: "",
  tags: [],
  lockedFacts: [],
  attributes: {},
};

describe("WorldviewLibraryPanel", () => {
  beforeEach(() => {
    useLiveQueryMock.mockReset();
    useLiveQueryMock.mockReturnValue(undefined);
  });

  it("renders the panel header with title and add button in empty state", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <WorldviewLibraryPanel projectId="p1" />
      </WithTheme>,
    );
    expect(html).toContain("世界观设定");
    expect(html).toContain("WORLDVIEW");
    expect(html).toContain("添加设定");
  });

  it("renders empty state message when no entities exist", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <WorldviewLibraryPanel projectId="p1" />
      </WithTheme>,
    );
    expect(html).toContain("还没有设定");
    expect(html).toContain("创建第一个设定");
  });

  it("renders the search input placeholder when entities exist", () => {
    useLiveQueryMock.mockReturnValueOnce([sampleEntity]).mockReturnValueOnce([]);
    const html = renderToStaticMarkup(
      <WithTheme>
        <WorldviewLibraryPanel projectId="p1" />
      </WithTheme>,
    );
    expect(html).toContain("搜索设定");
  });

  it("renders the description text for worldview management", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <WorldviewLibraryPanel projectId="p1" />
      </WithTheme>,
    );
    expect(html).toContain("地点、组织、势力、物品");
  });
});
