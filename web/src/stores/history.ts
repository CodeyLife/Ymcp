import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface HistoryItem {
  id: string;
  type: "image" | "video";
  mode: "text2img" | "img2img";
  prompt: string;
  model: string;
  size: string;
  n: number;
  quality: string;
  images: string[]; // blob URLs or data URLs
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
      add: (item) => set((s) => ({ items: [item, ...s.items].slice(0, 200) })),
      remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
      removeMany: (ids) =>
        set((s) => {
          if (ids.length === 0) return s;
          const idSet = new Set(ids);
          return { items: s.items.filter((i) => !idSet.has(i.id)) };
        }),
      clear: () => set({ items: [] }),
    }),
    { name: "ymcp-history" }
  )
);
