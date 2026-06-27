import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface AssetItem {
  id: string;
  name: string;
  type: "image" | "video";
  src: string; // blob URL or data URL
  thumbnail: string;
  tags: string[];
  source: "generated" | "uploaded" | "matte";
  metadata: {
    width?: number;
    height?: number;
    size?: number;
    /** 收藏自历史记录时关联的历史项 id，用于反向查找与取消收藏 */
    historyId?: string;
  };
  createdAt: number;
}

interface AssetState {
  items: AssetItem[];
  add: (item: AssetItem) => void;
  remove: (id: string) => void;
  removeMany: (ids: string[]) => void;
  clear: () => void;
  addTag: (id: string, tag: string) => void;
  removeTag: (id: string, tag: string) => void;
  /** 按 historyId 取消收藏（删除由历史记录收藏而来的素材） */
  removeByHistoryId: (historyId: string) => void;
}

export const useAssetStore = create<AssetState>()(
  persist(
    (set) => ({
      items: [],
      add: (item) => set((s) => ({ items: [item, ...s.items].slice(0, 500) })),
      remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
      removeMany: (ids) =>
        set((s) => {
          if (ids.length === 0) return s;
          const idSet = new Set(ids);
          return { items: s.items.filter((i) => !idSet.has(i.id)) };
        }),
      clear: () => set({ items: [] }),
      addTag: (id, tag) =>
        set((s) => ({
          items: s.items.map((i) =>
            i.id === id && !i.tags.includes(tag)
              ? { ...i, tags: [...i.tags, tag] }
              : i
          ),
        })),
      removeTag: (id, tag) =>
        set((s) => ({
          items: s.items.map((i) =>
            i.id === id ? { ...i, tags: i.tags.filter((t) => t !== tag) } : i
          ),
        })),
      removeByHistoryId: (historyId) =>
        set((s) => ({
          items: s.items.filter((i) => i.metadata.historyId !== historyId),
        })),
    }),
    { name: "ymcp-assets" }
  )
);
