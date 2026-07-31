import { renderToStaticMarkup } from "react-dom/server";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// ===== Mocks =====
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import McpToolGatewayPanel from "../McpToolGatewayPanel";

// ===== Helpers =====

function WithTheme({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      <App>{children}</App>
    </ConfigProvider>
  );
}

function renderPanel() {
  return renderToStaticMarkup(
    <WithTheme>
      <McpToolGatewayPanel />
    </WithTheme>,
  );
}

// 4 个直接执行工具（DIRECT_EXEC_TOOLS）
const DIRECT_EXEC_TOOLS = [
  "novel_project_create",
  "novel_project_list",
  "novel_run_create",
  "novel_closed_loop_run",
];

// ===== Tests =====

describe("McpToolGatewayPanel", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  });

  describe("工具名", () => {
    it("渲染关键工具名", () => {
      const html = renderPanel();
      expect(html).toContain("novel_project_create");
      expect(html).toContain("novel_run_create");
      expect(html).toContain("novel_closed_loop_run");
      expect(html).toContain("novel_bootstrap_run");
      expect(html).toContain("novel_story_arc_start");
      expect(html).toContain("novel_story_arc_get");
      expect(html).toContain("novel_chapter_review");
      expect(html).toContain("novel_chapter_generate");
    });
  });

  describe("历史记录区块", () => {
    it("渲染历史调用记录区块", () => {
      const html = renderPanel();
      expect(html).toContain("历史调用记录");
      // 初始 history 为空（useEffect 不跑），但空状态文案应存在
      expect(html).toContain("暂无调用记录");
    });
  });

  describe("可执行工具标识", () => {
    it("4 个直接执行工具带有「可执行」标识", () => {
      const html = renderPanel();
      for (const toolName of DIRECT_EXEC_TOOLS) {
        expect(html).toContain(toolName);
      }
      // 「可执行」Tag 出现次数应 >= 4（每个 DIRECT_EXEC 工具一个）
      const execCount = (html.match(/可执行/g) ?? []).length;
      expect(execCount).toBeGreaterThanOrEqual(4);
      expect(html).toContain("执行（通过 API）");
    });
  });

  describe("错误处理", () => {
    it("组件渲染不抛错", () => {
      expect(() => renderPanel()).not.toThrow();
    });
  });
});
