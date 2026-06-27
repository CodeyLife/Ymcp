import { useEffect, useMemo, useRef } from "react";
import { Tooltip } from "antd";
import {
  AppstoreOutlined,
  PictureOutlined,
  VideoCameraOutlined,
  ToolOutlined,
  ScissorOutlined,
  BorderOuterOutlined,
  HistoryOutlined,
  FolderOpenOutlined,
  SettingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from "@ant-design/icons";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useUIStore, SIDEBAR_COLLAPSE_BREAKPOINT } from "@/stores/ui";
import { SlidingIndicator, GlowPulse } from "@/components/motion";
import { NoiseOverlay } from "@/components/Background";
import { PageTransition, ScrollProgressBar } from "@/components/showtime";

interface NavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  badge?: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const groups: NavGroup[] = [
  {
    label: "创作",
    items: [
      { key: "", label: "工作台", icon: <AppstoreOutlined /> },
      { key: "image-gen", label: "AI 生图", icon: <PictureOutlined /> },
      { key: "video-gen", label: "视频生成", icon: <VideoCameraOutlined />, badge: "预留" },
    ],
  },
  {
    label: "工具",
    items: [
      { key: "workbench", label: "视频转序列帧", icon: <ToolOutlined /> },
      { key: "matte", label: "抠图", icon: <ScissorOutlined /> },
      { key: "sprite-split", label: "SpriteSheet 拆分", icon: <BorderOuterOutlined /> },
      { key: "image-tools", label: "图像工具集", icon: <AppstoreOutlined /> },
    ],
  },
  {
    label: "资产",
    items: [
      { key: "history", label: "历史记录", icon: <HistoryOutlined /> },
      { key: "assets", label: "素材库", icon: <FolderOpenOutlined /> },
    ],
  },
  {
    label: "系统",
    items: [{ key: "settings", label: "设置", icon: <SettingOutlined /> }],
  },
];

const SIDEBAR_INDICATOR_LAYOUT_ID = "sidebar-active-indicator";

export default function AppLayout() {
  const collapsed = useUIStore((s) => s.collapsed);
  const toggleCollapsed = useUIStore((s) => s.toggleCollapsed);
  const setCollapsed = useUIStore((s) => s.setCollapsed);
  const location = useLocation();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);

  const currentKey = useMemo(() => {
    const path = location.pathname.replace(/^\//, "");
    return path === "" ? "" : path;
  }, [location.pathname]);

  // 窄屏响应：窗口收窄到断点以下时自动收折侧边栏
  // 注意：不在变宽时自动展开，避免打断用户已主动折叠的状态
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${SIDEBAR_COLLAPSE_BREAKPOINT - 1}px)`);
    const handleChange = (e: MediaQueryListEvent) => {
      if (e.matches) setCollapsed(true);
    };
    // 初次挂载时再次校准，防止 store 初始化与实际视口不同步
    if (mql.matches) setCollapsed(true);
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, [setCollapsed]);

  return (
    <div style={{ display: "flex", minHeight: "100dvh", position: "relative" }}>
      {/* 固定 mesh 光斑层：仅覆盖主内容区（避开侧边栏） */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          top: 0,
          bottom: 0,
          left: collapsed ? 72 : 240,
          right: 0,
          pointerEvents: "none",
          zIndex: 0,
          overflow: "hidden",
        }}
      >
        {/* 顶部 aurora 横向光带（最底层，最先绘制） */}
        <span className="ambient-aurora" />
        {/* mesh 光斑 */}
        <span className="ambient-blob ambient-blob-1" />
        <span className="ambient-blob ambient-blob-2" />
        <span className="ambient-blob ambient-blob-3" />
        {/* 底部冷色微光，给画面"地面" */}
        <span className="ambient-floor-glow" />
        {/* 角落 vignette：让中心更聚焦（最顶层） */}
        <span className="ambient-vignette" />
      </div>

      {/* 全局噪点叠层（最顶层，pointer-events-none） */}
      <NoiseOverlay />

      <aside
        className={`sidebar-shell ${collapsed ? "sidebar-collapsed" : ""}`}
        style={{
          width: collapsed ? 72 : 240,
          flexShrink: 0,
          position: "sticky",
          top: 0,
          height: "100dvh",
          display: "flex",
          flexDirection: "column",
          transition: "width 0.22s cubic-bezier(0.16, 1, 0.3, 1)",
          zIndex: 10,
        }}
      >
        {/* 右边缘垂直流光：极弱的 emerald 光带沿 sidebar 右边缓慢上下漂移 */}
        <span className="sidebar-edge-beam" aria-hidden />

        {/* Logo / 品牌 */}
        <div
          style={{
            height: 60,
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: collapsed ? "0 20px" : "0 20px 0 20px",
            borderBottom: "1px solid #18181b",
            flexShrink: 0,
          }}
        >
          <div className="sidebar-logo-wrap">
            <span className="sidebar-logo-ring" aria-hidden />
            <div className="sidebar-logo">Y</div>
          </div>
          {!collapsed && (
            <div className="sidebar-brand-text" style={{ lineHeight: 1.15 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#f4f4f5", letterSpacing: 0.2 }}>
                Creative Studio
              </div>
              <div style={{ fontSize: 11, color: "#52525b", letterSpacing: 0.4 }}>Ymcp v0.1</div>
            </div>
          )}
        </div>

        {/* 导航 */}
        <nav
          className="sidebar-nav"
          style={{ flex: 1, overflowY: "auto", overflowX: "hidden", paddingTop: 4 }}
        >
          {groups.map((group) => (
            <div key={group.label}>
              {!collapsed && <div className="sidebar-group-label">{group.label}</div>}
              {group.items.map((item) => {
                const active = currentKey === item.key;
                const content = (
                  <div
                    className={`sidebar-item ${active ? "sidebar-item-active" : ""}`}
                    onClick={() => navigate(`/${item.key}`)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(`/${item.key}`);
                      }
                    }}
                  >
                    {/* 活跃项横向扫光：从左到右循环掠过 */}
                    {active && <span className="sidebar-item-sheen" aria-hidden />}
                    {/* 滑动指示器：layoutId 共享，切换菜单时绿色条会平滑滑动 */}
                    {active && (
                      <SlidingIndicator
                        layoutId={SIDEBAR_INDICATOR_LAYOUT_ID}
                        className="sidebar-active-indicator"
                        style={{
                          position: "absolute",
                          left: -10,
                          top: "50%",
                          transform: "translateY(-50%)",
                          width: 3,
                          height: 26,
                          borderRadius: "0 3px 3px 0",
                          background: "linear-gradient(180deg, #6ee7b7 0%, #34d399 50%, #10b981 100%)",
                          boxShadow: "0 0 14px rgba(16, 185, 129, 0.8), 0 0 4px rgba(110, 231, 183, 0.6)",
                        }}
                      />
                    )}
                    <span className="sidebar-item-icon">{item.icon}</span>
                    {!collapsed && (
                      <>
                        <span className="sidebar-item-label" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item.label}
                        </span>
                        {item.badge && <span className="sidebar-badge">{item.badge}</span>}
                      </>
                    )}
                  </div>
                );
                return collapsed ? (
                  <Tooltip key={item.key} title={item.label} placement="right">
                    {content}
                  </Tooltip>
                ) : (
                  <div key={item.key} style={{ width: "100%" }}>
                    {content}
                  </div>
                );
              })}
            </div>
          ))}
        </nav>

        {/* 底部底座：状态卡 + 折叠按钮整合为统一视觉块 */}
        <div className="sidebar-footer">
          {!collapsed && (
            <div className="sidebar-status-card">
              {/* 扫描线：从左到右循环扫过，模拟"正在监控" */}
              <span className="sidebar-status-scan" aria-hidden />
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, position: "relative", zIndex: 1 }}>
                <GlowPulse size={7} color="#34d399" />
                <span style={{ fontSize: 12, fontWeight: 600, color: "#d4d4d8" }}>本地就绪</span>
              </div>
              <div style={{ fontSize: 11, color: "#71717a", lineHeight: 1.5, position: "relative", zIndex: 1 }}>
                数据保存在你的设备上
              </div>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: collapsed ? "center" : "flex-end", padding: collapsed ? "10px 0 0" : "12px 16px 0" }}>
            <button
              className="sidebar-collapse-btn"
              onClick={toggleCollapsed}
              aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
            >
              {collapsed ? <MenuUnfoldOutlined style={{ fontSize: 14 }} /> : (
                <>
                  <MenuFoldOutlined style={{ fontSize: 14 }} />
                  <span className="sidebar-collapse-label">折叠</span>
                </>
              )}
            </button>
          </div>
        </div>
      </aside>

      <main
        ref={mainRef}
        className="grid-bg"
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "auto",
          position: "relative",
          zIndex: 1,
        }}
      >
        {/* 顶部滚动进度条 - 监听 main 容器滚动 */}
        <ScrollProgressBar targetRef={mainRef} />
        {/* 路由切换过渡 */}
        <PageTransition routeKey={location.pathname}>
          <Outlet />
        </PageTransition>
      </main>
    </div>
  );
}
