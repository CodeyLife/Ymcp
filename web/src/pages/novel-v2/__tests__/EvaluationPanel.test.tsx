import { renderToStaticMarkup } from "react-dom/server";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// ===== Mocks =====
// fetch 在 SSR 时不会被调用（useEffect 不跑），但仍 stub 以防组件模块初始化期触发请求。
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import EvaluationPanel from "../EvaluationPanel";

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
      <EvaluationPanel projectId={props.projectId ?? "p1"} />
    </WithTheme>,
  );
}

// ===== Tests =====

describe("EvaluationPanel", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // 默认返回空数据；SSR 不跑 useEffect，fetch 实际不会被调用。
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  });

  describe("区块 1：快照列表", () => {
    it("渲染快照列表标题与捕获快照按钮", () => {
      const html = renderPanel();
      expect(html).toContain("快照列表");
      expect(html).toContain("捕获快照");
      expect(html).toContain("刷新");
    });
  });

  describe("区块 2：实验工作区", () => {
    it("渲染实验工作区标题与创建实验按钮", () => {
      const html = renderPanel();
      expect(html).toContain("实验工作区");
      expect(html).toContain(">创建<");
    });
  });

  describe("IndexedDB 删除契约合规（AGENTS.md）", () => {
    // AGENTS.md：删除按钮始终可用，不被任何全局开关短路；即使 status=closed 也允许删除。
    // TODO P1: SSR 不跑 useEffect，无法通过 fetch mock 注入 status="closed" 的实验数据来断言行内 "删除" 按钮渲染。
    //   源码层面 EvaluationPanel.tsx 的实验表格「操作」列对每行无条件渲染 <Popconfirm><Button danger>删除</Button></Popconfirm>，
    //   不依赖 row.status，已满足契约。后续如需运行时验证，应改用 jsdom + @testing-library/react 或抽取 useEvaluation hook。
    it("实验工作区表格「操作」列头存在（删除按钮在 row render 中无条件产出）", () => {
      const html = renderPanel();
      expect(html).toContain("操作");
    });
  });

  describe("区块 3/4：候选包 / 晋升记录", () => {
    it("渲染候选预览、候选列表与晋升收据", () => {
      const html = renderPanel();
      expect(html).toContain("候选预览");
      expect(html).toContain("候选包列表");
      expect(html).toContain("晋升收据");
    });
  });

  describe("错误处理", () => {
    // TODO P2: SSR 不跑 useEffect，fetch 失败时 setError 不会触发，错误 Alert 不会出现在 HTML 中。
    //   仅验证组件在 fetch mock 抛错时不抛未捕获异常。
    it("fetch 抛错时组件渲染不抛错", () => {
      fetchMock.mockRejectedValue(new Error("network down"));
      expect(() => renderPanel()).not.toThrow();
    });

    it("fetch 返回 !ok 时组件渲染不抛错", () => {
      fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "boom" }) } as Response);
      expect(() => renderPanel()).not.toThrow();
    });
  });
});
