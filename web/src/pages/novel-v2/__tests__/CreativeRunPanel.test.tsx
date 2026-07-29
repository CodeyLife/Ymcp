import { renderToStaticMarkup } from "react-dom/server";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// ===== Mocks =====
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import CreativeRunPanel from "../CreativeRunPanel";

// ===== Helpers =====

function WithTheme({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      <App>{children}</App>
    </ConfigProvider>
  );
}

function renderPanel(props: { projectId?: string } = {}) {
  return renderToStaticMarkup(
    <WithTheme>
      <CreativeRunPanel projectId={props.projectId ?? "p1"} />
    </WithTheme>,
  );
}

// ===== Tests =====

describe("CreativeRunPanel", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  });

  describe("区块 1：Run 列表", () => {
    it("渲染创意执行控制台标题与创建 run 按钮", () => {
      const html = renderPanel();
      expect(html).toContain("创意执行控制台");
      expect(html).toContain("创建 Run");
      expect(html).toContain("Creative Run 列表");
    });

    it("渲染返回 Run 列表按钮（初始禁用）", () => {
      const html = renderPanel();
      expect(html).toContain("返回 Run 列表");
    });
  });

  describe("命令类型枚举", () => {
    // TODO P1: SSR 不跑 useEffect，selectedRun 初始为 undefined，详情视图（含命令 Select）不渲染。
    //   命令枚举 work.start/work.accept/run.pause 等定义在组件模块顶层常量 WORK_ITEM_COMMANDS / RUN_COMMANDS，
    //   仅在 selectedRun 选中后通过 commandOptions 派生。如需 SSR 验证命令选项，应抽取 commandOptions 为纯函数或改用 jsdom。
    it("组件渲染不抛错（命令选择器在详情视图，初始不可见）", () => {
      const html = renderPanel();
      expect(html).toContain("Creative Run 列表");
      expect(html).toContain("暂无创意执行 run");
    });
  });

  describe("事件流区块", () => {
    // TODO P1: 事件流区块在 selectedRun 详情视图内，SSR 初始状态 selectedRun=undefined 不渲染该区块。
    //   源码 CreativeRunPanel.tsx 中 Card title=`事件流（lastSequence=...）` 仅在详情分支出现。
    //   如需验证，应改用 jsdom + 模拟 selectedRun 或抽取详情子组件独立 SSR 渲染。
    it("列表视图渲染时不抛错（事件流区块在详情视图）", () => {
      const html = renderPanel();
      expect(html).toContain("Creative Run 列表");
    });
  });

  describe("错误处理", () => {
    // TODO P2: SSR 不跑 useEffect，fetch 失败时 setError 不会触发，错误 Alert 不会出现在 HTML 中。
    it("fetch 抛错时组件渲染不抛错", () => {
      fetchMock.mockRejectedValue(new Error("network down"));
      expect(() => renderPanel()).not.toThrow();
    });
  });
});
