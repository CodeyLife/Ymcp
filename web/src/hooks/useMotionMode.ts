import { useSyncExternalStore } from "react";

/**
 * 动效降级判定 hook
 *
 * 策略：基于屏幕宽度自动降级。
 * - 窄屏（max-width: 767px，移动端）：返回 true，所有动效组件退化为静态/简化态，降低耗电与发热。
 * - 宽屏（≥768px，桌面）：返回 false，完整炫技动效全部保留。
 *
 * 仍刻意忽略系统 prefers-reduced-motion，以保证桌面体验不受 OS 设置影响。
 * 使用 useSyncExternalStore 订阅 matchMedia 变化，尺寸跨断点切换时实时 re-render，无 tearing。
 */
const MOBILE_QUERY = "(max-width: 767px)";

function subscribe(callback: () => void): () => void {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getServerSnapshot(): boolean {
  // SSR/首屏默认不降级，避免 hydration 闪烁；客户端挂载后即校正为真实视口
  return false;
}

export function useMotionMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
