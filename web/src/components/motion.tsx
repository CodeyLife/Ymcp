"use client";

/**
 * 动效原语组件库
 * 所有组件遵循 prefers-reduced-motion，且将连续值放在 motion value 中（不进 React state）
 * 参考：design-taste-frontend skill Section 3.B / 5.D / 6.B
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
  type Variants,
} from "motion/react";
import { useMotionMode } from "@/hooks/useMotionMode";

/* ============================================================
 * ScrambleText - 矩阵解码式文字入场
 * 用于 Hero 标题，一次性触发（非连续循环），可用 useState
 * ============================================================ */
const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ!<>-_\\/[]{}=+*^?#01";

interface ScrambleTextProps {
  text: string;
  /** 每帧锁定字符前递增的指针速率（越大越快） */
  speed?: number;
  className?: string;
  style?: CSSProperties;
  /** 是否禁用解码动画，直接显示终态 */
  disabled?: boolean;
}

export function ScrambleText({
  text,
  speed = 0.45,
  className,
  style,
  disabled,
}: ScrambleTextProps) {
  const reduce = useMotionMode();
  const [display, setDisplay] = useState(text);

  useEffect(() => {
    if (disabled || reduce) {
      setDisplay(text);
      return;
    }

    let raf = 0;
    let pointer = 0;
    const total = text.length;

    const tick = () => {
      // 指针按 speed 速率推进
      pointer += speed;
      const lockCount = Math.floor(pointer);
      const out = text
        .split("")
        .map((ch, i) => {
          if (ch === " ") return " ";
          if (i < lockCount) return text[i];
          return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
        })
        .join("");
      setDisplay(out);

      if (lockCount < total) {
        raf = requestAnimationFrame(tick);
      } else {
        setDisplay(text);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, speed, reduce, disabled]);

  return (
    <span className={className} style={style} aria-label={text}>
      {display}
    </span>
  );
}

/* ============================================================
 * MagneticButton - 磁吸按钮
 * 鼠标接近时按钮被"吸"过去，离开时回弹。连续值走 motion value
 * ============================================================ */
interface MagneticButtonProps {
  children: ReactNode;
  /** 磁吸强度（0-1），默认 0.35 */
  strength?: number;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  disabled?: boolean;
}

export function MagneticButton({
  children,
  strength = 0.35,
  className,
  style,
  onClick,
  disabled,
}: MagneticButtonProps) {
  const reduce = useMotionMode();
  const ref = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 200, damping: 18, mass: 0.3 });
  const sy = useSpring(y, { stiffness: 200, damping: 18, mass: 0.3 });

  function handleMove(e: React.MouseEvent) {
    if (reduce || disabled || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const relX = e.clientX - (rect.left + rect.width / 2);
    const relY = e.clientY - (rect.top + rect.height / 2);
    x.set(relX * strength);
    y.set(relY * strength);
  }

  function handleLeave() {
    x.set(0);
    y.set(0);
  }

  return (
    <motion.div
      ref={ref}
      style={{ x: sx, y: sy, display: "inline-block", ...style }}
      className={className}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      onClick={onClick}
    >
      {children}
    </motion.div>
  );
}

/* ============================================================
 * SpotlightCard - 鼠标跟随光晕卡片
 * 边缘出现跟随鼠标的 emerald 光晕，连续值不进 state
 * ============================================================ */
interface SpotlightCardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  /** 是否高亮（强光），用于 active 态 */
  active?: boolean;
}

export function SpotlightCard({
  children,
  className,
  style,
  onClick,
  active,
}: SpotlightCardProps) {
  const reduce = useMotionMode();
  const ref = useRef<HTMLDivElement>(null);
  const mx = useMotionValue(50);
  const my = useMotionValue(50);
  const opacity = useMotionValue(0);

  const bg = useTransform(
    [mx, my],
    ([x, y]) =>
      `radial-gradient(360px circle at ${x}% ${y}%, rgba(52, 211, 153, 0.16), transparent 45%)`
  );

  // 边缘高光：必须放在 hooks 顶层，不能在 JSX 内调用
  const borderBg = useTransform(
    [mx, my, opacity],
    ([x, y, o]) =>
      `radial-gradient(240px circle at ${x}% ${y}%, rgba(52, 211, 153, ${(o as number) * 0.7}), transparent 50%)`
  );

  function handleMove(e: React.MouseEvent) {
    if (reduce || !ref.current) return;
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
      className={className}
      style={{
        position: "relative",
        cursor: onClick ? "pointer" : "default",
        ...style,
      }}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      onClick={onClick}
    >
      {/* 光晕层 */}
      <motion.div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: bg,
          opacity: active ? 0.55 : opacity,
          borderRadius: "inherit",
          pointerEvents: "none",
          transition: "opacity 0.25s ease",
        }}
      />
      {/* 边缘高光 */}
      <motion.div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "inherit",
          padding: 1,
          background: borderBg,
          WebkitMask:
            "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
          WebkitMaskComposite: "xor",
          maskComposite: "exclude",
          pointerEvents: "none",
        }}
      />
      <div style={{ position: "relative", zIndex: 1 }}>{children}</div>
    </motion.div>
  );
}

/* ============================================================
 * StaggerReveal - 错峰入场容器
 * 子项依次进入视图。Motion 官方推荐用 whileInView + delay 简化
 * ============================================================ */
export const staggerContainer: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.06, delayChildren: 0.05 },
  },
};

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] },
  },
};

interface StaggerRevealProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** 一次性触发（推荐 true） */
  once?: boolean;
}

export function StaggerReveal({
  children,
  className,
  style,
  once = true,
}: StaggerRevealProps) {
  const reduce = useMotionMode();
  if (reduce) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }
  return (
    <motion.div
      className={className}
      style={style}
      variants={staggerContainer}
      initial="hidden"
      whileInView="show"
      viewport={{ once, amount: 0.15 }}
    >
      {children}
    </motion.div>
  );
}

/* ============================================================
 * SlidingIndicator - 共享 layoutId 滑动指示器
 * 在父级不同子项间滑动。配合 SidebarItem 使用
 * ============================================================ */
interface SlidingIndicatorProps {
  /** 共享 layoutId，相同 ID 的元素之间会自动过渡 */
  layoutId: string;
  className?: string;
  style?: CSSProperties;
}

export function SlidingIndicator({
  layoutId,
  className,
  style,
}: SlidingIndicatorProps) {
  const reduce = useMotionMode();
  if (reduce) {
    return <div className={className} style={style} />;
  }
  return (
    <motion.div
      layoutId={layoutId}
      className={className}
      style={style}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
    />
  );
}

/* ============================================================
 * GlowPulse - 呼吸光晕
 * 用于状态点、Logo 等"还活着"的指示
 * ============================================================ */
interface GlowPulseProps {
  size?: number;
  color?: string;
  className?: string;
  style?: CSSProperties;
}

export function GlowPulse({
  size = 7,
  color = "#34d399",
  className,
  style,
}: GlowPulseProps) {
  const reduce = useMotionMode();
  return (
    <span
      className={className}
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 8px ${color}aa`,
        ...style,
      }}
    >
      {!reduce && (
        <motion.span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            background: color,
          }}
          animate={{ scale: [1, 2.4], opacity: [0.6, 0] }}
          transition={{
            duration: 2.4,
            repeat: Infinity,
            ease: "easeOut",
          }}
        />
      )}
    </span>
  );
}
