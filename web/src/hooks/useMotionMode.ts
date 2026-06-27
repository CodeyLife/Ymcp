/**
 * 动效降级判定 hook
 *
 * 当前策略：默认强制开启动效，忽略系统 prefers-reduced-motion。
 * 返回 false 表示"不降级"，所有动效组件按完整炫技模式运行。
 *
 * 如未来需要恢复可访问性降级，可在此处读取 store 或系统媒体查询。
 */
export function useMotionMode(): boolean {
  return false;
}
