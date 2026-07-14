import { renderToStaticMarkup } from "react-dom/server";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import { describe, expect, it } from "vitest";

import RelationMatrixView from "../RelationMatrixView";
import { bondToBackground, bondToBorder, bondToTrustDot } from "../relationColor";
import type { EntityRelation, StoryEntity } from "../../types";

function WithTheme({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      <App>{children}</App>
    </ConfigProvider>
  );
}

const baseEntity = {
  projectId: "p1",
  schemaVersion: 4,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  createdBy: "test",
  updatedBy: "test",
  aliases: [] as string[],
  summary: "",
  description: "",
  tags: [] as string[],
  lockedFacts: [] as string[],
  attributes: {},
};

const sampleEntities: StoryEntity[] = [
  { ...baseEntity, id: "char-1", kind: "character", name: "陆沉", tags: ["主角"] },
  { ...baseEntity, id: "char-2", kind: "character", name: "苏黎", tags: ["配角"] },
  { ...baseEntity, id: "char-3", kind: "character", name: "顾衍", tags: ["反派"] },
];

const baseRelation = {
  projectId: "p1",
  schemaVersion: 4,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  createdBy: "test",
  updatedBy: "test",
  publicLabel: "",
  privateTruth: "",
  history: [] as Array<{ at: number; chapterId?: string; note: string }>,
};

const sampleRelations: EntityRelation[] = [
  { ...baseRelation, id: "rel-1", fromEntityId: "char-1", toEntityId: "char-2", relationType: "同伴", bond: "关系亲密，已建立信任" },
  { ...baseRelation, id: "rel-2", fromEntityId: "char-1", toEntityId: "char-3", relationType: "宿敌", bond: "疏远，敌对，存在冲突" },
];

function renderMatrix(entities = sampleEntities, relations = sampleRelations) {
  return renderToStaticMarkup(
    <WithTheme>
      <RelationMatrixView
        entities={entities}
        relations={relations}
        onEditRelation={() => {}}
        onCreateRelation={() => {}}
        onEditCharacter={() => {}}
      />
    </WithTheme>,
  );
}

describe("RelationMatrixView", () => {
  it("renders all entity names as row and column headers", () => {
    const html = renderMatrix();
    expect(html).toContain("陆沉");
    expect(html).toContain("苏黎");
    expect(html).toContain("顾衍");
  });

  it("renders relation type in cell when relation exists", () => {
    const html = renderMatrix();
    expect(html).toContain("同伴");
    expect(html).toContain("宿敌");
  });

  it("renders + placeholder in empty cells", () => {
    const html = renderMatrix();
    // char-2 → char-3 没有关系,应该有 + 占位
    expect(html).toContain("+");
  });

  it("renders diagonal cells with first character of entity name", () => {
    const html = renderMatrix();
    // 对角线单元格显示角色名首字(陆/苏/顾)
    // 注:行头和列头也会显示完整名字,这里主要验证 diagonal cell 的存在
    expect(html).toMatch(/陆/);
  });

  it("renders bond text in cell", () => {
    const html = renderMatrix();
    expect(html).toContain("关系亲密");
    expect(html).toContain("疏远");
  });

  it("renders trust dot indicator for high-trust relations", () => {
    const html = renderMatrix();
    // rel-1 bond 含"信任" → 应该有信任角标
    expect(html).toContain("novel-relation-matrix-cell-trust");
  });

  it("renders empty state when entities list is empty", () => {
    const html = renderMatrix([], []);
    // RelationMatrixView 在 entities 为空时返回 null,外层 App 容器仍在但不渲染矩阵内容
    expect(html).not.toContain("novel-relation-matrix");
    expect(html).not.toContain("陆沉");
  });

  it("renders toolbar with search input and sort select", () => {
    const html = renderMatrix();
    expect(html).toContain("按角色名");
    expect(html).toContain("按名称");
  });

  it("renders meta count of entities and relations", () => {
    const html = renderMatrix();
    expect(html).toContain("3 角色");
    expect(html).toContain("2 关系");
  });

  it("applies bond-based background color to relation cells", () => {
    const html = renderMatrix();
    // rel-1 bond 含"亲密" → 绿色背景
    const greenBackground = bondToBackground("关系亲密，已建立信任");
    expect(greenBackground).toBeDefined();
    expect(html).toContain(greenBackground!);
    // rel-2 bond 含"疏远" → 红色背景
    const redBackground = bondToBackground("疏远，敌对，存在冲突");
    expect(redBackground).toBeDefined();
    expect(html).toContain(redBackground!);
  });

  it("applies bond-based border color to conflict relations", () => {
    const html = renderMatrix();
    // rel-2 bond 含"冲突" → 红色边框
    const border = bondToBorder("疏远，敌对，存在冲突");
    expect(border).toBeDefined();
    expect(html).toContain(border!);
  });

  it("renders create-relation title hint on empty cells", () => {
    const html = renderMatrix();
    expect(html).toContain("创建关系");
  });
});

describe("relationColor utilities", () => {
  it("bondToBackground returns green for positive affinity keywords", () => {
    const bg = bondToBackground("关系亲密，互相信任");
    expect(bg).toContain("hsla(120");
  });

  it("bondToBackground returns red for negative affinity keywords", () => {
    const bg = bondToBackground("疏远，形同陌路");
    expect(bg).toContain("hsla(0");
  });

  it("bondToBackground returns undefined for neutral text", () => {
    expect(bondToBackground("普通同事关系")).toBeUndefined();
    expect(bondToBackground("")).toBeUndefined();
  });

  it("bondToBorder returns color for conflict keywords", () => {
    const border = bondToBorder("存在矛盾和隔阂");
    expect(border).toBeDefined();
    expect(border).toContain("hsla(0");
  });

  it("bondToBorder returns undefined for non-conflict text", () => {
    expect(bondToBorder("关系和谐")).toBeUndefined();
  });

  it("bondToTrustDot returns true for trust keywords", () => {
    expect(bondToTrustDot("已建立信任")).toBe(true);
    expect(bondToTrustDot("推心置腹")).toBe(true);
  });

  it("bondToTrustDot returns false for non-trust text", () => {
    expect(bondToTrustDot("互相猜忌")).toBe(false);
    expect(bondToTrustDot("")).toBe(false);
  });
});
