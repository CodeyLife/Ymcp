import { renderToStaticMarkup } from "react-dom/server";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import { describe, expect, it, vi } from "vitest";
import KnowledgeWorkbenchPanel from "../KnowledgeWorkbenchPanel";

vi.stubGlobal("fetch", vi.fn());

describe("KnowledgeWorkbenchPanel", () => {
  it("keeps formal knowledge separate from the project planning workspace", () => {
    const html = renderToStaticMarkup(<ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}><App><KnowledgeWorkbenchPanel projectId="p1" /></App></ConfigProvider>);
    for (const label of ["世界观", "角色", "关系", "时间线", "事实账本", "Skill 治理"]) expect(html).toContain(label);
    expect(html).not.toContain(">Foundation<");
    expect(html).toContain("新增记录");
    expect(html).toContain("创作资料工作台");
  });
});
