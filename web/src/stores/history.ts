import { create } from "zustand";
import { persist } from "zustand/middleware";
import { deleteImage } from "@/lib/imageStore";

export interface HistoryItem {
  id: string;
  type: "image" | "video";
  mode: "text2img" | "img2img";
  prompt: string;
  model: string;
  size: string;
  n: number;
  quality: string;
  /** 图片引用 id 数组（指向 IndexedDB 中的 Blob），单图仅 1 项 */
  imageIds: string[];
  status: "completed" | "failed";
  error?: string;
  createdAt: number;
}

interface HistoryState {
  items: HistoryItem[];
  add: (item: HistoryItem) => void;
  remove: (id: string) => void;
  removeMany: (ids: string[]) => void;
  clear: () => void;
}

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set) => ({
      items: [],
      add: (item) =>
        set((s) => {
          const next = [item, ...s.items].slice(0, 200);
          // 被 slice 截断的旧条目：异步清理其 IndexedDB 图片
          const dropped = s.items.slice(next.length);
          if (dropped.length > 0) {
            dropped.forEach((h) => h.imageIds.forEach((id) => deleteImage(id).catch(() => {})));
          }
          return { items: next };
        }),
      remove: (id) =>
        set((s) => {
          const target = s.items.find((i) => i.id === id);
          if (target) target.imageIds.forEach((iid) => deleteImage(iid).catch(() => {}));
          return { items: s.items.filter((i) => i.id !== id) };
        }),
      removeMany: (ids) =>
        set((s) => {
          if (ids.length === 0) return s;
          const idSet = new Set(ids);
          // 清理被删除项的图片
          s.items.forEach((i) => {
            if (idSet.has(i.id)) i.imageIds.forEach((iid) => deleteImage(iid).catch(() => {}));
          });
          return { items: s.items.filter((i) => !idSet.has(i.id)) };
        }),
      clear: () =>
        set((s) => {
          s.items.forEach((i) => i.imageIds.forEach((iid) => deleteImage(iid).catch(() => {})));
          return { items: [] };
        }),
    }),
    { name: "ymcp-history" }
  )
);
