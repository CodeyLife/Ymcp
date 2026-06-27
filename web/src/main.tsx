import "@ant-design/v5-patch-for-react-19";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { ConfigProvider, theme as antdTheme, App as AntdApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import { queryClient } from "@/lib/queryClient";
import "@/index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: antdTheme.darkAlgorithm,
          token: {
            colorPrimary: "#10b981",
            colorBgBase: "#09090b",
            colorBgContainer: "#18181b",
            colorBgElevated: "#27272a",
            colorBorder: "#3f3f46",
            colorBorderSecondary: "#27272a",
            colorText: "#f4f4f5",
            colorTextSecondary: "#a1a1aa",
            borderRadius: 8,
            fontFamily:
              '"Geist", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
          },
          components: {
            Layout: {
              siderBg: "#0f0f12",
              headerBg: "#0f0f12",
              bodyBg: "#09090b",
            },
            Menu: {
              itemBg: "transparent",
              itemSelectedBg: "rgba(16, 185, 129, 0.15)",
              itemSelectedColor: "#34d399",
              itemHoverBg: "rgba(255, 255, 255, 0.04)",
            },
            Card: {
              colorBgContainer: "#18181b",
              colorBorderSecondary: "#27272a",
            },
          },
        }}
      >
        <AntdApp>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AntdApp>
      </ConfigProvider>
    </QueryClientProvider>
  </StrictMode>
);
