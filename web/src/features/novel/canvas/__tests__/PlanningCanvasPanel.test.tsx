import { renderToStaticMarkup } from "react-dom/server";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import { describe, expect, it, vi } from "vitest";

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => undefined,
}));
vi.mock("../../../db", () => ({
  addOutlineNode: vi.fn(),
  appendOperation: vi.fn(),
  deleteOutlineBranch: vi.fn(),
  novelDb: {
    outlineNodes: { where: () => ({ equals: () => ({ toArray: () => Promise.resolve([]) }) }) },
    entities: { where: () => ({ equals: () => ({ and: () => ({ toArray: () => Promise.resolve([]) }) }) }) },
    plotThreads: { where: () => ({ equals: () => ({ toArray: () => Promise.resolve([]) }) }) },
    relations: { where: () => ({ equals: () => ({ toArray: () => Promise.resolve([]) }) }) },
    operations: {},
    transaction: vi.fn(async (_mode, ..._stores) => {}),
  },
  getCanvasLayout: vi.fn(async () => undefined),
  saveCanvasLayout: vi.fn(async () => ({})),
}));

import { PlanningNodeContent, type PlanningNodeData } from "../PlanningNodeContent";
import { PlanningCanvasPanel } from "../PlanningCanvasPanel";
import type { OutlineNode, PlotThread, StoryEntity } from "../../types";

function WithTheme({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      <App>{children}</App>
    </ConfigProvider>
  );
}

const baseRecord = {
  projectId: "p1",
  schemaVersion: 4,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  createdBy: "test",
  updatedBy: "test",
};

const sampleOutline: OutlineNode = {
  ...baseRecord,
  id: "outline-1",
  kind: "event",
  title: "档案馆遇袭",
  summary: "主角在档案馆遭到记忆窃贼的突袭。",
  order: 0,
  status: "planned",
  causality: "因为记忆删除事件",
  outcome: "主角失去一段关键记忆",
  characterIds: ["char-1"],
  plotThreadIds: ["thread-1"],
  foreshadowingIds: [],
  tension: 70,
  emotion: 60,
  information: 40,
  tags: [],
};

const sampleEntity: StoryEntity = {
  ...baseRecord,
  id: "char-1",
  kind: "character",
  name: "陆沉",
  aliases: [],
  summary: "档案员，负责保存城市证词。",
  description: "",
  tags: [],
  lockedFacts: [],
  attributes: {},
  character: {
    role: "主角",
    appearance: "",
    personality: "",
    desire: "",
    motivation: "",
    weakness: "",
    secret: "",
    abilities: [],
    voice: "",
    arc: "",
    knowledge: { known: [], suspected: [], mistaken: [], unknown: [] },
    state: { location: "", physical: "", emotional: "", objective: "", inventory: [], relationshipNotes: [] },
  },
};

const sampleThread: PlotThread = {
  ...baseRecord,
  id: "thread-1",
  kind: "main",
  title: "记忆追寻",
  summary: "主角追寻被删除记忆的主线。",
  status: "active",
  priority: 1,
  participantIds: ["char-1"],
  progress: 30,
  nextMove: "",
};

describe("PlanningNodeContent", () => {
  it("renders outline node with kind label, title, and summary", () => {
    const data: PlanningNodeData = { type: "outline", node: sampleOutline };
    const html = renderToStaticMarkup(
      <WithTheme><PlanningNodeContent data={data} /></WithTheme>,
    );
    expect(html).toContain("档案馆遇袭");
    expect(html).toContain("事件");
    expect(html).toContain("主角在档案馆遭到记忆窃贼的突袭");
  });

  it("renders outline node status and reference counts", () => {
    const data: PlanningNodeData = { type: "outline", node: sampleOutline };
    const html = renderToStaticMarkup(
      <WithTheme><PlanningNodeContent data={data} /></WithTheme>,
    );
    expect(html).toContain("已规划");
    expect(html).toContain("1");
  });

  it("renders outline node fallback when summary is empty", () => {
    const data: PlanningNodeData = { type: "outline", node: { ...sampleOutline, summary: "" } };
    const html = renderToStaticMarkup(
      <WithTheme><PlanningNodeContent data={data} /></WithTheme>,
    );
    expect(html).toContain("尚未描述");
  });

  it("renders entity node with name, role, and summary", () => {
    const data: PlanningNodeData = { type: "entity", node: sampleEntity };
    const html = renderToStaticMarkup(
      <WithTheme><PlanningNodeContent data={data} /></WithTheme>,
    );
    expect(html).toContain("陆沉");
    expect(html).toContain("主角");
    expect(html).toContain("档案员");
  });

  it("renders entity node fallback when summary is empty", () => {
    const data: PlanningNodeData = { type: "entity", node: { ...sampleEntity, summary: "" } };
    const html = renderToStaticMarkup(
      <WithTheme><PlanningNodeContent data={data} /></WithTheme>,
    );
    expect(html).toContain("尚未设定");
  });

  it("renders thread node with title, status, and summary", () => {
    const data: PlanningNodeData = { type: "thread", node: sampleThread };
    const html = renderToStaticMarkup(
      <WithTheme><PlanningNodeContent data={data} /></WithTheme>,
    );
    expect(html).toContain("记忆追寻");
    expect(html).toContain("进行中");
    expect(html).toContain("主角追寻被删除记忆的主线");
  });

  it("renders thread node fallback when summary is empty", () => {
    const data: PlanningNodeData = { type: "thread", node: { ...sampleThread, summary: "" } };
    const html = renderToStaticMarkup(
      <WithTheme><PlanningNodeContent data={data} /></WithTheme>,
    );
    expect(html).toContain("尚未描述");
  });

  it("includes data-planning-node and data-planning-type attributes", () => {
    const outlineData: PlanningNodeData = { type: "outline", node: sampleOutline };
    const entityData: PlanningNodeData = { type: "entity", node: sampleEntity };
    const threadData: PlanningNodeData = { type: "thread", node: sampleThread };
    const outlineHtml = renderToStaticMarkup(<WithTheme><PlanningNodeContent data={outlineData} /></WithTheme>);
    const entityHtml = renderToStaticMarkup(<WithTheme><PlanningNodeContent data={entityData} /></WithTheme>);
    const threadHtml = renderToStaticMarkup(<WithTheme><PlanningNodeContent data={threadData} /></WithTheme>);
    expect(outlineHtml).toContain('data-planning-node="outline-1"');
    expect(outlineHtml).toContain('data-planning-type="outline"');
    expect(entityHtml).toContain('data-planning-node="char-1"');
    expect(entityHtml).toContain('data-planning-type="entity"');
    expect(threadHtml).toContain('data-planning-node="thread-1"');
    expect(threadHtml).toContain('data-planning-type="thread"');
  });
});

describe("PlanningCanvasPanel", () => {
  it("renders the panel header with title and action buttons in empty state", () => {
    const html = renderToStaticMarkup(
      <WithTheme><PlanningCanvasPanel projectId="p1" /></WithTheme>,
    );
    expect(html).toContain("策划工作台");
    expect(html).toContain("PLANNING CANVAS");
    expect(html).toContain("添加大纲节点");
  });

  it("renders empty state message when no nodes exist", () => {
    const html = renderToStaticMarkup(
      <WithTheme><PlanningCanvasPanel projectId="p1" /></WithTheme>,
    );
    expect(html).toContain("画布为空");
    expect(html).toContain("添加第一个大纲节点");
  });

  it("renders undo and redo buttons", () => {
    const html = renderToStaticMarkup(
      <WithTheme><PlanningCanvasPanel projectId="p1" /></WithTheme>,
    );
    expect(html).toContain("撤销");
    expect(html).toContain("重做");
  });
});
