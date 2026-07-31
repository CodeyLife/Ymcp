import { renderToStaticMarkup } from "react-dom/server";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import { describe, expect, it, vi } from "vitest";
import KnowledgeWorkbenchPanel, { isEditableKnowledgeKind } from "../KnowledgeWorkbenchPanel";

vi.stubGlobal("fetch", vi.fn());

describe("KnowledgeWorkbenchPanel", () => {
  it("exposes project material sources without duplicating the plan workspace", () => {
    const html = renderToStaticMarkup(<ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}><App><KnowledgeWorkbenchPanel projectId="p1" /></App></ConfigProvider>);
    for (const label of ["角色", "关系", "叙事事实", "章节记忆", "本项目 Skill", "全局 Skill 治理"]) expect(html).toContain(label);
    expect(html).not.toContain("创作契约");
    expect(html).not.toContain("事实账本");
    expect(html).toContain("创作资料工作台");
  });

  it("allows authors to govern narrative facts through the workbench", () => {
    expect(isEditableKnowledgeKind("claims")).toBe(true);
  });
});
