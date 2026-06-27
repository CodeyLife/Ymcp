"use client";

/**
 * 全局噪点叠层
 * - fixed 铺满视口，pointer-events-none（符合 skill 6.E）
 * - mix-blend overlay，opacity 3.5%，提升"高级感"
 * - 颜色中性，不影响 color consistency lock
 */
export function NoiseOverlay() {
  return <div className="ambient-noise" aria-hidden />;
}
