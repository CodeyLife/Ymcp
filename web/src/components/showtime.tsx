"use client";

/**
 * 炫技组件库
 * - PageHeader：统一页头，标题 scramble 入场 + 装饰条
 * - GlassCard：玻璃质感卡片，spotlight + hover lift
 * - EmptyState：统一空态，带 SVG 动效
 * - TiltCard：3D 鼠标倾斜卡片
 * - CountUp：数字滚动计数
 * - ScrollProgressBar：顶部 emerald 滚动进度条
 * - PageTransition：路由切换过渡包裹器
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  useScroll,
} from "motion/react";
import { ScrambleText } from "./motion";
import { useMotionMode } from "@/hooks/useMotionMode";

/* ============================================================
 * PageHeader - 统一页头
 * 标题 scramble 入场 + 左侧装饰条 + 副标题 fade
 * ============================================================ */
interface PageHeaderProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  extra?: ReactNode;
}

export function PageHeader({ title, description, icon, extra }: PageHeaderProps) {
  const reduce = useMotionMode();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 16,
        marginBottom: 20,
        position: "relative",
      }}
    >
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", minWidth: 0 }}>
        {/* 装饰条 */}
        <motion.div
          aria-hidden
          initial={reduce ? false : { scaleY: 0, opacity: 0 }}
          animate={{ scaleY: 1, opacity: 1 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: 0.1 }}
          style={{
            width: 3,
            height: 40,
            borderRadius: "0 3px 3px 0",
            background: "linear-gradient(180deg, #34d399, #10b981)",
            boxShadow: "0 0 12px rgba(16, 185, 129, 0.55)",
            transformOrigin: "top",
            flexShrink: 0,
            marginTop: 2,
          }}
        />
        <div style={{ minWidth: 0 }}>
          <h1
            style={{
              fontSize: 26,
              fontWeight: 700,
              letterSpacing: "-0.015em",
              lineHeight: 1.15,
              color: "#f4f4f5",
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            {icon && (
              <span style={{ color: "#34d399", fontSize: 22, filter: "drop-shadow(0 0 8px rgba(52, 211, 153, 0.4))" }}>
                {icon}
              </span>
            )}
            <ScrambleText text={title} speed={0.5} />
          </h1>
          {description && (
            <motion.p
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.25 }}
              style={{
                color: "#a1a1aa",
                fontSize: 13,
                lineHeight: 1.5,
                margin: "4px 0 0",
                maxWidth: "65ch",
              }}
            >
              {description}
            </motion.p>
          )}
        </div>
      </div>
      {extra && <div style={{ flexShrink: 0 }}>{extra}</div>}
    </motion.div>
  );
}

/* ============================================================
 * GlassCard - 玻璃质感卡片
 * backdrop-blur + spotlight + hover lift + 边缘高光
 * ============================================================ */
interface GlassCardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  /** hover 时上浮距离（px），默认 4 */
  lift?: number;
  /** 是否高亮（强光），用于 active 态 */
  active?: boolean;
  /** 内边距，默认 18 */
  padding?: number;
  /** 是否启用 spotlight 鼠标跟随，默认 true */
  spotlight?: boolean;
}

export function GlassCard({
  children,
  className,
  style,
  onClick,
  lift = 4,
  active,
  padding = 18,
  spotlight = true,
}: GlassCardProps) {
  const reduce = useMotionMode();
  const ref = useRef<HTMLDivElement>(null);
  const mx = useMotionValue(50);
  const my = useMotionValue(50);
  const opacity = useMotionValue(0);

  const spotBg = useTransform(
    [mx, my],
    ([x, y]) =>
      `radial-gradient(320px circle at ${x}% ${y}%, rgba(52, 211, 153, 0.14), transparent 45%)`
  );

  function handleMove(e: React.MouseEvent) {
    if (reduce || !spotlight || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    mx.set(((e.clientX - rect.left) / rect.width) * 100);
    my.set(((e.clientY - rect.top) / rect.height) * 100);
    opacity.set(1);
  }
  function handleLeave() {
    opacity.set(0);
  }

  return (
    <motion.div
      ref={ref}
      className={`glass-card ${className ?? ""}`}
      style={{
        position: "relative",
        borderRadius: 12,
        background: "rgba(24, 24, 27, 0.72)",
        border: "1px solid rgba(39, 39, 42, 0.9)",
        backdropFilter: "blur(12px) saturate(140%)",
        WebkitBackdropFilter: "blur(12px) saturate(140%)",
        boxShadow:
          "inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 8px 24px rgba(0, 0, 0, 0.18)",
        cursor: onClick ? "pointer" : "default",
        overflow: "hidden",
        ...style,
      }}
      whileHover={
        reduce
          ? undefined
          : { y: -lift, borderColor: "rgba(52, 211, 153, 0.4)" }
      }
      transition={{ type: "spring", stiffness: 320, damping: 24 }}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      onClick={onClick}
    >
      {/* 顶部内高光 */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 1,
          background:
            "linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.12), transparent)",
          pointerEvents: "none",
        }}
      />
      {/* Spotlight 鼠标跟随光晕 */}
      {spotlight && !reduce && (
        <motion.div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background: spotBg,
            opacity: active ? 0.45 : opacity,
            borderRadius: "inherit",
            pointerEvents: "none",
            transition: "opacity 0.2s ease",
          }}
        />
      )}
      <div style={{ position: "relative", zIndex: 1, padding }}>{children}</div>
    </motion.div>
  );
}

/* ============================================================
 * EmptyState - 统一空态
 * SVG 微动效 + 标题 + 副标题 + 可选 CTA
 * ============================================================ */
interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  minHeight?: number;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  minHeight = 240,
}: EmptyStateProps) {
  const reduce = useMotionMode();
  return (
    <div
      style={{
        minHeight,
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
          textAlign: "center",
          maxWidth: 360,
        }}
      >
        {/* 动效图标容器 */}
        <motion.div
          initial={reduce ? false : { opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            background:
              "radial-gradient(circle, rgba(52, 211, 153, 0.12), rgba(16, 185, 129, 0.03))",
            border: "1px solid rgba(52, 211, 153, 0.18)",
            display: "grid",
            placeItems: "center",
            position: "relative",
          }}
        >
          {/* 呼吸光晕 */}
          {!reduce && (
            <motion.div
              aria-hidden
              style={{
                position: "absolute",
                inset: -1,
                borderRadius: "inherit",
                border: "1px solid rgba(52, 211, 153, 0.35)",
              }}
              animate={{ scale: [1, 1.18], opacity: [0.6, 0] }}
              transition={{
                duration: 2.4,
                repeat: Infinity,
                ease: "easeOut",
              }}
            />
          )}
          <span style={{ color: "#34d399", fontSize: 22, position: "relative" }}>
            {icon ?? <span style={{ opacity: 0.5 }}>·</span>}
          </span>
        </motion.div>
        <div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "#d4d4d8",
              marginBottom: 4,
            }}
          >
            {title}
          </div>
          {description && (
            <div style={{ fontSize: 12.5, color: "#71717a", lineHeight: 1.55 }}>
              {description}
            </div>
          )}
        </div>
        {action}
      </div>
    </div>
  );
}

/* ============================================================
 * TiltCard - 3D 鼠标倾斜卡片
 * 鼠标移动时卡片轻微 3D 倾斜，连续值走 motion value
 * ============================================================ */
interface TiltCardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** 倾斜最大角度（度），默认 8 */
  max?: number;
  onClick?: () => void;
}

export function TiltCard({ children, className, style, max = 8, onClick }: TiltCardProps) {
  const reduce = useMotionMode();
  const ref = useRef<HTMLDivElement>(null);
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const srx = useSpring(rx, { stiffness: 200, damping: 18 });
  const sry = useSpring(ry, { stiffness: 200, damping: 18 });

  // 透视 + rotate
  const transform = useTransform(
    [srx, sry],
    ([x, y]) => `perspective(900px) rotateX(${x}deg) rotateY(${y}deg)`
  );

  function handleMove(e: React.MouseEvent) {
    if (reduce || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    rx.set(-py * max * 2);
    ry.set(px * max * 2);
  }
  function handleLeave() {
    rx.set(0);
    ry.set(0);
  }

  return (
    <motion.div
      ref={ref}
      className={className}
      style={{ transform, transformStyle: "preserve-3d", cursor: onClick ? "pointer" : "default", ...style }}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      onClick={onClick}
    >
      {children}
    </motion.div>
  );
}

/* ============================================================
 * CountUp - 数字滚动计数
 * 一次性触发（mount 或 inView），可用 useState
 * ============================================================ */
interface CountUpProps {
  value: number;
  duration?: number;
  className?: string;
  style?: CSSProperties;
  /** 格式化函数 */
  format?: (n: number) => string;
}

export function CountUp({ value, duration = 1.2, className, style, format }: CountUpProps) {
  const reduce = useMotionMode();
  const [display, setDisplay] = useState(reduce ? value : 0);

  useEffect(() => {
    if (reduce) {
      setDisplay(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const from = 0;
    const to = value;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / (duration * 1000));
      // easeOutExpo
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setDisplay(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, reduce]);

  return (
    <span className={className} style={style}>
      {format ? format(display) : Math.round(display)}
    </span>
  );
}

/* ============================================================
 * ScrollProgressBar - 顶部滚动进度条
 * Linear 风格 emerald 细线，跟随主滚动容器
 * 用 sticky 定位贴在 main 容器顶部，避免盖住 sidebar
 * ============================================================ */
interface ScrollProgressBarProps {
  /** 滚动容器 ref，不传则监听 window */
  targetRef?: React.RefObject<HTMLElement | null>;
}

export function ScrollProgressBar({ targetRef }: ScrollProgressBarProps) {
  const reduce = useMotionMode();
  const { scrollYProgress } = useScroll({
    container: targetRef,
  });
  const scaleX = useSpring(scrollYProgress, {
    stiffness: 200,
    damping: 30,
    restDelta: 0.001,
  });

  if (reduce) return null;

  return (
    <motion.div
      aria-hidden
      style={{
        position: "sticky",
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        background: "linear-gradient(90deg, #10b981, #34d399, #6ee7b7)",
        transformOrigin: "0%",
        scaleX,
        zIndex: 50,
        boxShadow: "0 0 12px rgba(52, 211, 153, 0.6)",
        pointerEvents: "none",
      }}
    />
  );
}

/* ============================================================
 * PageTransition - 路由切换过渡包裹器
 * 用 key 触发重新挂载播 initial→animate（无 exit，避免 Outlet 缓存问题）
 * ============================================================ */
interface PageTransitionProps {
  children: ReactNode;
  /** 路由 key，通常用 location.pathname */
  routeKey: string;
}

export function PageTransition({ children, routeKey }: PageTransitionProps) {
  const reduce = useMotionMode();
  return (
    <motion.div
      key={routeKey}
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
