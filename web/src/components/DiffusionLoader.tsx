"use client";

/**
 * AI 生成中 Diffusion 动画
 * 替换 antd Spin，作为 AI 工具的"签名视觉时刻"
 *
 * 视觉构成：
 * - emerald 波纹从中心向外扩散：所有格子共享同一周期，波峰按距中心远近
 *   用 times 关键帧精确调度，形成同步推进的环形波（而非各自闪烁的杂乱噪点）
 * - 顶部到底部扫描线循环
 * - 中心 Logo + 状态文本 + 三点呼吸
 *
 * 网格自适应：根据容器实际宽高比动态计算 cols/rows，保持每格方形，
 * 避免在非方形容器（如 16:9、9:16）里被拉伸变形。
 *
 * 性能：CSS keyframes + transform/opacity，GPU 友好
 * 可访问性：prefers-reduced-motion 下退化为静态占位
 */

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useMotionMode } from "@/hooks/useMotionMode";

interface DiffusionLoaderProps {
  /** 容器宽度（px），默认 320（fill 模式下忽略） */
  width?: number;
  /** 容器高度（px），默认 320（fill 模式下忽略） */
  height?: number;
  /** 状态文本，默认"AI 正在生成" */
  label?: string;
  /** 填满父容器：width/height=100%，移除自身边框/圆角/阴影，由外层容器控制外观 */
  fill?: boolean;
}

/** 目标格子边长 px，cols/rows 按此值四舍五入，保证每格接近方形 */
const TARGET_CELL = 50;
/** 全局波纹周期（秒）：所有格子共享，保证扩散同步 */
const WAVE_PERIOD = 3.2;
/** 波从中心扩散到最远格用掉的周期比例（剩余时间用于回落与停顿） */
const WAVE_TRAVEL = 0.62;
/** 波峰持续时长（周期比例）：到达后高亮停留多久再回落 */
const WAVE_HOLD = 0.16;
/** 波前平坦段宽度（周期比例）：到达前保持暗，避免 ease 曲线提前爬升 */
const WAVE_PRE = 0.03;

export interface DiffusionGridMetrics {
  cols: number;
  rows: number;
  cellSize: number;
  width: number;
  height: number;
}

export function computeDiffusionGridMetrics(width: number, height: number): DiffusionGridMetrics {
  const cols = Math.max(2, Math.round(width / TARGET_CELL));
  const rows = Math.max(2, Math.round(height / TARGET_CELL));
  const cellSize = Math.max(width / cols, height / rows);

  return {
    cols,
    rows,
    cellSize,
    width: cols * cellSize,
    height: rows * cellSize,
  };
}

export function DiffusionLoader({
  width = 320,
  height = 320,
  label = "AI 正在生成",
  fill = false,
}: DiffusionLoaderProps) {
  const reduce = useMotionMode();
  const containerRef = useRef<HTMLDivElement>(null);
  const [grid, setGrid] = useState<DiffusionGridMetrics | null>(() =>
    fill ? null : computeDiffusionGridMetrics(width, height)
  );

  // 监听容器尺寸，按宽高比计算 cols/rows 保持每格方形
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      const next = computeDiffusionGridMetrics(w, h);
      setGrid((prev) =>
        prev &&
        prev.cols === next.cols &&
        prev.rows === next.rows &&
        prev.cellSize === next.cellSize
          ? prev
          : next
      );
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { cols, rows } = grid ?? computeDiffusionGridMetrics(width, height);
  const total = cols * rows;
  const centerCol = (cols - 1) / 2;
  const centerRow = (rows - 1) / 2;
  const gridKey = `${cols}x${rows}`;
  // 最远格到中心的距离，用于归一化波到达时刻
  const maxDist = Math.sqrt(centerCol * centerCol + centerRow * centerRow) || 1;

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: fill ? "100%" : width,
        height: fill ? "100%" : height,
        borderRadius: fill ? 0 : 12,
        overflow: "hidden",
        background: fill
          ? "radial-gradient(circle at 50% 50%, rgba(16, 185, 129, 0.08), rgba(9, 9, 11, 0.92))"
          : "radial-gradient(circle at 50% 50%, rgba(16, 185, 129, 0.06), rgba(9, 9, 11, 0.95))",
        border: fill ? "none" : "1px solid rgba(16, 185, 129, 0.25)",
        boxShadow: fill
          ? "inset 0 1px 0 rgba(255, 255, 255, 0.04)"
          : "0 0 0 1px rgba(16, 185, 129, 0.1), 0 24px 60px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
      }}
    >
      {/* 像素方格：从噪点降噪为微光，cols/rows 按容器宽高比计算保持每格方形 */}
      {!reduce && grid && (
        <div
          key={gridKey}
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: grid.width,
            height: grid.height,
            transform: "translate(-50%, -50%)",
            display: "grid",
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gridTemplateRows: `repeat(${rows}, 1fr)`,
          }}
        >
          {Array.from({ length: total }).map((_, i) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const dx = col - centerCol;
            const dy = row - centerRow;
            const dist = Math.sqrt(dx * dx + dy * dy);
            // 波到达此格的时刻（归一化 0~1）：中心先亮，外围后亮
            const arrive = 0.015 + (dist / maxDist) * WAVE_TRAVEL;
            // 波前平坦时刻：到达前保持暗，临近到达才升（避免 ease 曲线提前爬升）
            const pre = Math.max(0.001, arrive - WAVE_PRE);
            // 波峰过后回落到微光的时刻
            const fade = arrive + WAVE_HOLD;
            return (
              <motion.div
                key={i}
                style={{
                  position: "relative",
                  background: "rgba(82, 82, 91, 0.25)",
                  overflow: "hidden",
                }}
              >
                <motion.div
                  style={{
                    position: "absolute",
                    inset: 0,
                    background: "rgba(52, 211, 153, 0.55)",
                  }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0, 0, 1, 0.12, 0] }}
                  transition={{
                    duration: WAVE_PERIOD,
                    repeat: Infinity,
                    ease: "easeInOut",
                    times: [0, pre, arrive, fade, 1],
                  }}
                />
              </motion.div>
            );
          })}
        </div>
      )}

      {/* 扫描线：从顶到底循环 */}
      {!reduce && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: "30%",
            background:
              "linear-gradient(180deg, transparent 0%, rgba(52, 211, 153, 0.18) 60%, rgba(52, 211, 153, 0.5) 90%, transparent 100%)",
            animation: "scan-down 2.2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
            pointerEvents: "none",
          }}
        />
      )}

      {/* 中心 Logo/状态 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          zIndex: 2,
        }}
      >
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 9,
            background: "linear-gradient(135deg, #10b981 0%, #047857 100%)",
            display: "grid",
            placeItems: "center",
            color: "#042f1f",
            fontWeight: 800,
            fontSize: 16,
            boxShadow:
              "0 0 0 1px rgba(16, 185, 129, 0.4), 0 8px 24px rgba(16, 185, 129, 0.35)",
          }}
        >
          Y
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "#d4d4d8",
            fontSize: 12.5,
            fontWeight: 500,
            letterSpacing: 0.3,
          }}
        >
          <span>{label}</span>
          {!reduce && (
            <span style={{ display: "inline-flex", gap: 2 }}>
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  style={{
                    width: 3,
                    height: 3,
                    borderRadius: "50%",
                    background: "#34d399",
                  }}
                  animate={{ opacity: [0.2, 1, 0.2] }}
                  transition={{
                    duration: 1.2,
                    repeat: Infinity,
                    delay: i * 0.2,
                    ease: "easeInOut",
                  }}
                />
              ))}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
