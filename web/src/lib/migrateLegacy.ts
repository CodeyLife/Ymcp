/**
 * 旧版数据迁移：清理 localStorage 中残留的 base64 历史记录与素材库数据
 *
 * 旧版 history / asset store 把 base64 data URL 直接写入 localStorage，
 * 极易撑爆 5MB 配额导致刷新后记录丢失。新版改用 IndexedDB 存图片 Blob，
 * store 只保存 imageId 引用。
 *
 * 用户已确认丢弃旧数据，不做迁移。首次加载检测到旧 key 时直接清除。
 *
 * 注意：本模块在 main.tsx 顶部以副作用方式 import（import "@/lib/migrateLegacy"），
 * 必须在任何 zustand store 初始化之前执行，否则 persist 会从旧 localStorage
 * 恢复出错误的旧结构（含 images 字段而非 imageIds）。
 */

const MIGRATION_FLAG = "ymcp-migrated-v2";
const LEGACY_KEYS = ["ymcp-history", "ymcp-assets"];

/**
 * 清理旧版 localStorage 数据。仅执行一次（用 ymcp-migrated-v2 标记）。
 */
export function migrateLegacyStorage(): void {
  if (typeof window === "undefined") return;
  if (window.localStorage.getItem(MIGRATION_FLAG)) return;

  for (const key of LEGACY_KEYS) {
    if (window.localStorage.getItem(key)) {
      window.localStorage.removeItem(key);
    }
  }

  window.localStorage.setItem(MIGRATION_FLAG, "1");
}

// 模块加载时自动执行清理（通过 main.tsx 顶部 import 副作用触发）
migrateLegacyStorage();
