import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CharacterCard, { isCharacterEntityData } from "../CharacterCard";

const character = {
  kind: "character" as const,
  name: "陆沉",
  summary: "负责保存城市每一次重置前的证词。",
  tags: ["档案员"],
  character: {
    role: "主角",
    desire: "找回被删除的证词",
    motivation: "证明自己的记忆没有失真",
    personality: "克制而多疑",
    weakness: "过度依赖记录",
    secret: "曾主动参与一次记忆删除",
    arc: "从相信档案转向相信自己的选择",
    appearance: "总戴着一副有裂纹的护目镜",
    voice: "说话简短，习惯引用时间戳",
    state: { location: "旧档案馆", emotional: "警惕", objective: "找到缺页" },
  },
};

describe("character card", () => {
  it("renders a character candidate as named story fields instead of raw json", () => {
    const html = renderToStaticMarkup(<CharacterCard entity={character} mode="detail" />);

    expect(html).toContain("陆沉");
    expect(html).toContain("人物摘要");
    expect(html).toContain("核心欲望");
    expect(html).toContain("人物弧光");
    expect(html).toContain("旧档案馆");
    expect(html).not.toContain("&quot;kind&quot;");
  });

  it("only identifies entity payloads explicitly marked as characters", () => {
    expect(isCharacterEntityData(character)).toBe(true);
    expect(isCharacterEntityData({ kind: "location", name: "旧档案馆" })).toBe(false);
  });
});
