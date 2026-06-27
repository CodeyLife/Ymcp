import { useMemo } from "react";
import { Button } from "antd";
import {
  PictureOutlined,
  ScissorOutlined,
  ToolOutlined,
  BorderOuterOutlined,
  ArrowRightOutlined,
  QqOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  ScrambleText,
  SpotlightCard,
  MagneticButton,
  GlowPulse,
  staggerItem,
} from "@/components/motion";
import { CountUp, GlassCard } from "@/components/showtime";
import { useHistoryStore } from "@/stores/history";
import { useAssetStore } from "@/stores/asset";

interface QuickAction {
  key: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
  /** Bento 布局类型 */
  span: "feature" | "mini" | "wide";
}

const actions: QuickAction[] = [
  {
    key: "image-gen",
    title: "AI 生图",
    desc: "文生图、图生图，支持绿幕、序列帧预设工作流。",
    icon: <PictureOutlined />,
    span: "feature",
  },
  {
    key: "matte",
    title: "抠图",
    desc: "颜色键、白底去除，羽化与边缘腐蚀一体化。",
    icon: <ScissorOutlined />,
    span: "mini",
  },
  {
    key: "workbench",
    title: "视频转序列帧",
    desc: "纯浏览器抽帧，导出帧表、WebP、GIF。",
    icon: <ToolOutlined />,
    span: "mini",
  },
  {
    key: "sprite-split",
    title: "SpriteSheet 拆分",
    desc: "等分切片，ZIP 打包 PNG 帧，支持行列自动检测。",
    icon: <BorderOuterOutlined />,
    span: "wide",
  },
];

function getGreeting() {
  const h = new Date().getHours();
  if (h < 6) return "凌晨好";
  if (h < 12) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

export default function Dashboard() {
  const navigate = useNavigate();
  const greeting = useMemo(() => getGreeting(), []);

  return (
    <div style={{ maxWidth: 1440, margin: "0 auto", padding: "40px 28px 56px", position: "relative" }}>
      {/* QQ 交流群入口 - 右上角芯片 */}
      <motion.a
        href="https://qm.qq.com/q/32Ej4TfwOY"
        target="_blank"
        rel="noopener noreferrer"
        title="加入 QQ 交流群"
        className="qq-group-chip"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
        style={{ position: "absolute", top: 28, right: 28, zIndex: 5 }}
      >
        <QqOutlined className="qq-group-icon" />
        <span>交流群</span>
      </motion.a>

      {/* Hero - 单一问候 + 状态条，不再做大字号停留 */}
      <section style={{ marginBottom: 32 }}>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 14,
          }}
        >
          <GlowPulse size={7} color="#34d399" />
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: "#a1a1aa",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            本地就绪 · 4 个工具可用
          </span>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1], delay: 0.05 }}
          style={{
            fontSize: "clamp(32px, 5vw, 48px)",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            lineHeight: 1.05,
            color: "#f4f4f5",
            margin: 0,
          }}
        >
          <span style={{ display: "block" }}>
            <ScrambleText text={`${greeting}`} />, 准备好
          </span>
          <span className="text-gradient-accent" style={{ display: "block" }}>
            创造点什么
          </span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1], delay: 0.12 }}
          style={{
            color: "#a1a1aa",
            fontSize: 15,
            lineHeight: 1.55,
            maxWidth: "56ch",
            margin: "14px 0 0",
          }}
        >
          从下方选一个工具开始。所有数据保存在你的设备上，离线可用，无云端依赖。
        </motion.p>
      </section>

      {/* 快速统计条带 - CountUp 数字滚动 + 玻璃质感 */}
      <StatsStrip />

      {/* Bento 网格：1 大 + 2 小 + 1 宽，避免等高 4 卡 AI-Tell */}
      <section>
        <motion.div
          variants={{
            hidden: {},
            show: { transition: { staggerChildren: 0.07, delayChildren: 0.2 } },
          }}
          initial="hidden"
          animate="show"
          className="bento-grid"
        >
          {actions.map((a) => {
            const isFeature = a.span === "feature";
            const cellClassName = `bento-${a.span}`;

            return (
              <motion.div key={a.key} variants={staggerItem} className={cellClassName}>
                <SpotlightCard
                  onClick={() => navigate(`/${a.key}`)}
                  style={{
                    width: "100%",
                    height: "100%",
                    borderRadius: 12,
                    background: isFeature
                      ? "linear-gradient(135deg, rgba(16, 185, 129, 0.08) 0%, rgba(9, 9, 11, 0.6) 60%)"
                      : "rgba(24, 24, 27, 0.72)",
                    border: "1px solid rgba(39, 39, 42, 0.9)",
                    backdropFilter: "blur(8px)",
                    WebkitBackdropFilter: "blur(8px)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      padding: isFeature ? 26 : 20,
                      height: "100%",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      gap: 16,
                      position: "relative",
                    }}
                  >
                    {/* Feature 卡片：大号视觉 + CTA */}
                    {isFeature && (
                      <>
                        <div
                          aria-hidden
                          style={{
                            position: "absolute",
                            right: -40,
                            top: -40,
                            width: 220,
                            height: 220,
                            borderRadius: "50%",
                            background:
                              "radial-gradient(circle, rgba(52, 211, 153, 0.18), transparent 65%)",
                            filter: "blur(20px)",
                            pointerEvents: "none",
                          }}
                        />
                        <div style={{ position: "relative" }}>
                          <div
                            style={{
                              width: 52,
                              height: 52,
                              borderRadius: 12,
                              background:
                                "linear-gradient(135deg, rgba(52, 211, 153, 0.22), rgba(16, 185, 129, 0.08))",
                              border: "1px solid rgba(52, 211, 153, 0.3)",
                              display: "grid",
                              placeItems: "center",
                              fontSize: 24,
                              color: "#34d399",
                              marginBottom: 18,
                            }}
                          >
                            {a.icon}
                          </div>
                          <h3
                            style={{
                              fontSize: 22,
                              fontWeight: 700,
                              color: "#f4f4f5",
                              letterSpacing: "-0.01em",
                              margin: "0 0 8px",
                            }}
                          >
                            {a.title}
                          </h3>
                          <p
                            style={{
                              fontSize: 13.5,
                              color: "#a1a1aa",
                              lineHeight: 1.6,
                              margin: 0,
                              maxWidth: "40ch",
                            }}
                          >
                            {a.desc}
                          </p>
                        </div>
                        <div style={{ position: "relative" }}>
                          <MagneticButton strength={0.4}>
                            <Button
                              type="primary"
                              size="large"
                              onClick={() => navigate(`/${a.key}`)}
                              style={{
                                background:
                                  "linear-gradient(135deg, #10b981 0%, #047857 100%)",
                                border: "none",
                                fontWeight: 600,
                                boxShadow:
                                  "0 8px 24px rgba(16, 185, 129, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.18)",
                                borderRadius: 8,
                              }}
                            >
                              开始创作
                              <ArrowRightOutlined style={{ marginLeft: 6 }} />
                            </Button>
                          </MagneticButton>
                        </div>
                      </>
                    )}

                    {/* Mini / Wide 卡片：紧凑布局 */}
                    {!isFeature && (
                      <>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            justifyContent: "space-between",
                            gap: 12,
                          }}
                        >
                          <div
                            style={{
                              width: 38,
                              height: 38,
                              minWidth: 38,
                              borderRadius: 10,
                              background: "rgba(52, 211, 153, 0.1)",
                              border: "1px solid rgba(52, 211, 153, 0.18)",
                              display: "grid",
                              placeItems: "center",
                              fontSize: 17,
                              color: "#34d399",
                            }}
                          >
                            {a.icon}
                          </div>
                          <ArrowRightOutlined
                            style={{
                              color: "#52525b",
                              fontSize: 12,
                              marginTop: 6,
                            }}
                          />
                        </div>
                        <div>
                          <div
                            style={{
                              fontWeight: 600,
                              fontSize: 15,
                              color: "#f4f4f5",
                              marginBottom: 4,
                            }}
                          >
                            {a.title}
                          </div>
                          <div
                            style={{
                              fontSize: 12.5,
                              color: "#71717a",
                              lineHeight: 1.55,
                            }}
                          >
                            {a.desc}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </SpotlightCard>
              </motion.div>
            );
          })}
        </motion.div>
      </section>

    </div>
  );
}

/* ============================================================
 * StatsStrip - 快速统计条带
 * 4 项指标，CountUp 数字滚动 + 玻璃质感 + 进入 stagger
 * ============================================================ */
function StatsStrip() {
  const historyCount = useHistoryStore((s) => s.items.length);
  const assetCount = useAssetStore((s) => s.items.length);

  const stats = [
    { label: "可用工具", value: 4, suffix: "", hint: "全部本地运行" },
    { label: "生成记录", value: historyCount, suffix: "", hint: "自动保存" },
    { label: "素材库", value: assetCount, suffix: "", hint: "可复用" },
    { label: "云端依赖", value: 0, suffix: "", hint: "完全离线" },
  ];

  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: 0.18 }}
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, 1fr)",
        gap: 12,
        marginBottom: 28,
      }}
    >
      <style>{`
        @media (min-width: 768px) {
          .stats-strip-grid { grid-template-columns: repeat(4, 1fr) !important; }
        }
      `}</style>
      <div
        className="stats-strip-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 12,
          gridColumn: "1 / -1",
        }}
      >
        {stats.map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.45,
              ease: [0.16, 1, 0.3, 1],
              delay: 0.22 + i * 0.06,
            }}
          >
            <GlassCard padding={16} lift={3}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                <span
                  style={{
                    fontSize: 28,
                    fontWeight: 700,
                    color: "#f4f4f5",
                    letterSpacing: "-0.02em",
                    fontVariantNumeric: "tabular-nums",
                    lineHeight: 1,
                  }}
                >
                  <CountUp value={s.value} duration={1} />
                </span>
                {s.suffix && (
                  <span style={{ fontSize: 14, color: "#71717a", fontWeight: 600 }}>
                    {s.suffix}
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: "#a1a1aa",
                  fontWeight: 500,
                  marginTop: 6,
                }}
              >
                {s.label}
              </div>
              <div style={{ fontSize: 10.5, color: "#52525b", marginTop: 2 }}>
                {s.hint}
              </div>
            </GlassCard>
          </motion.div>
        ))}
      </div>
    </motion.section>
  );
}
