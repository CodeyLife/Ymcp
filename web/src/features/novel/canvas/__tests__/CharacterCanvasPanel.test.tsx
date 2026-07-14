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
  getCanvasLayout: vi.fn(async () => undefined),
  saveCanvasLayout: vi.fn(async () => ({})),
}));

import { CharacterNodeContent } from "../CharacterNodeContent";
import { CharacterCanvasPanel } from "../CharacterCanvasPanel";
import type { StoryEntity } from "../../types";

function WithTheme({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      <App>{children}</App>
    </ConfigProvider>
  );
}

const sampleEntity: StoryEntity = {
  id: "char-1",
  projectId: "p1",
  schemaVersion: 4,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  createdBy: "test",
  updatedBy: "test",
  kind: "character",
  name: "陆沉",
  aliases: [],
  summary: "负责保存城市每次重置前的证词。",
  description: "",
  tags: ["档案员"],
  lockedFacts: [],
  attributes: {},
  character: {
    role: "主角",
    appearance: "总戴着一副有裂纹的护目镜",
    personality: "克制而多疑",
    desire: "找回被删除的证词",
    motivation: "证明自己的记忆没有失真",
    weakness: "过度依赖记录",
    secret: "曾主动参与一次记忆删除",
    abilities: [],
    voice: "说话简短",
    arc: "从相信档案转向相信自己的选择",
    knowledge: { known: [], suspected: [], mistaken: [], unknown: [] },
    state: { location: "旧档案馆", physical: "正常", emotional: "警惕", objective: "找到缺页", inventory: [], relationshipNotes: [] },
  },
};

describe("CharacterNodeContent", () => {
  it("renders character name, role, and summary", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <CharacterNodeContent entity={sampleEntity} />
      </WithTheme>,
    );
    expect(html).toContain("陆沉");
    expect(html).toContain("主角");
    expect(html).toContain("负责保存城市每次重置前的证词");
  });

  it("renders avatar with first character of name", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <CharacterNodeContent entity={sampleEntity} />
      </WithTheme>,
    );
    expect(html).toContain("陆");
  });

  it("renders character location when set", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <CharacterNodeContent entity={sampleEntity} />
      </WithTheme>,
    );
    expect(html).toContain("旧档案馆");
  });

  it("falls back to emotional state when summary is empty", () => {
    const entity = { ...sampleEntity, summary: "" };
    const html = renderToStaticMarkup(
      <WithTheme>
        <CharacterNodeContent entity={entity} />
      </WithTheme>,
    );
    expect(html).toContain("警惕");
  });

  it("falls back to placeholder when no summary or emotional state", () => {
    const entity: StoryEntity = {
      ...sampleEntity,
      summary: "",
      character: { ...sampleEntity.character!, state: { ...sampleEntity.character!.state, emotional: "" } },
    };
    const html = renderToStaticMarkup(
      <WithTheme>
        <CharacterNodeContent entity={entity} />
      </WithTheme>,
    );
    expect(html).toContain("尚未设定");
  });

  it("includes data-character-node attribute for edge drop targeting", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <CharacterNodeContent entity={sampleEntity} />
      </WithTheme>,
    );
    expect(html).toContain('data-character-node="char-1"');
  });
});

describe("CharacterCanvasPanel", () => {
  it("renders the panel header with title and action buttons in empty state", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <CharacterCanvasPanel projectId="p1" />
      </WithTheme>,
    );
    expect(html).toContain("人物关系图");
    expect(html).toContain("RELATIONSHIP CANVAS");
    expect(html).toContain("添加角色");
    expect(html).toContain("建立关系");
  });

  it("renders empty state message when no characters exist", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <CharacterCanvasPanel projectId="p1" />
      </WithTheme>,
    );
    expect(html).toContain("还没有角色");
    expect(html).toContain("创建第一个角色");
  });

  it("renders undo and redo buttons", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <CharacterCanvasPanel projectId="p1" />
      </WithTheme>,
    );
    expect(html).toContain("撤销");
    expect(html).toContain("重做");
  });

  it("renders view mode switcher with canvas and matrix options", () => {
    const html = renderToStaticMarkup(
      <WithTheme>
        <CharacterCanvasPanel projectId="p1" />
      </WithTheme>,
    );
    expect(html).toContain("关系图");
    expect(html).toContain("关系矩阵");
  });
});
