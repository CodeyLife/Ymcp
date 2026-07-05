import { create } from "zustand";
import { persist } from "zustand/middleware";
import { deleteImage } from "@/lib/imageStore";

export interface AssetGroup {
  id: string;
  name: string;
  createdAt: number;
}

export interface AssetItem {
  id: string;
  name: string;
  type: "image" | "video";
  /** 图片引用 id（指向 IndexedDB 中的 Blob） */
  imageId: string;
  tags: string[];
  /** 所属自定义分组 id，undefined = 未分组 */
  groupId?: string;
  metadata: {
    width?: number;
    height?: number;
    size?: number;
    /** 收藏自历史记录时关联的历史项 id，用于反向查找与取消收藏 */
    historyId?: string;
    /** 收藏自生图页时关联的 taskId，用于预览反查分组 */
    taskId?: string;
  };
  createdAt: number;
}

interface AssetState {
  items: AssetItem[];
  groups: AssetGroup[];
  add: (item: AssetItem) => void;
  remove: (id: string) => void;
  removeMany: (ids: string[]) => void;
  clear: () => void;
  addTag: (id: string, tag: string) => void;
  removeTag: (id: string, tag: string) => void;
  /** 按 historyId 取消收藏（删除由历史记录收藏而来的素材） */
  removeByHistoryId: (historyId: string) => void;
  /** 创建自定义分组，返回新分组 id */
  createGroup: (name: string) => string;
  /** 重命名分组 */
  renameGroup: (id: string, name: string) => void;
  /** 删除分组，同时清除该分组下所有 item 的 groupId */
  deleteGroup: (id: string) => void;
  /** 将素材移动到指定分组（undefined = 未分组） */
  moveItemToGroup: (itemId: string, groupId: string | undefined) => void;
}

export const useAssetStore = create<AssetState>()(
  persist(
    (set) => ({
      items: [],
      groups: [],
      add: (item) => set((s) => ({ items: [item, ...s.items].slice(0, 500) })),
      remove: (id) =>
        set((s) => {
          const target = s.items.find((i) => i.id === id);
          if (target) deleteImage(target.imageId).catch(() => {});
          return { items: s.items.filter((i) => i.id !== id) };
        }),
      removeMany: (ids) =>
        set((s) => {
          if (ids.length === 0) return s;
          const idSet = new Set(ids);
          s.items.forEach((i) => {
            if (idSet.has(i.id)) deleteImage(i.imageId).catch(() => {});
          });
          return { items: s.items.filter((i) => !idSet.has(i.id)) };
        }),
      clear: () =>
        set((s) => {
          s.items.forEach((i) => deleteImage(i.imageId).catch(() => {}));
          return { items: [] };
        }),
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
        set((s) => {
          const targets = s.items.filter((i) => i.metadata.historyId === historyId);
          targets.forEach((t) => deleteImage(t.imageId).catch(() => {}));
          return {
            items: s.items.filter((i) => i.metadata.historyId !== historyId),
          };
        }),
      createGroup: (name) => {
        const id = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const group: AssetGroup = { id, name, createdAt: Date.now() };
        set((s) => ({ groups: [...s.groups, group] }));
        return id;
      },
      renameGroup: (id, name) =>
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)),
        })),
      deleteGroup: (id) =>
        set((s) => ({
          groups: s.groups.filter((g) => g.id !== id),
          items: s.items.map((i) =>
            i.groupId === id ? { ...i, groupId: undefined } : i
          ),
        })),
      moveItemToGroup: (itemId, groupId) =>
        set((s) => ({
          items: s.items.map((i) =>
            i.id === itemId ? { ...i, groupId } : i
          ),
        })),
    }),
    {
      name: "ymcp-assets",
      version: 3,
      migrate: (persistedState: unknown) => {
        // v2 → v3：移除 source 字段，保留所有 item 归入未分组
        const state = persistedState as { items?: Array<Record<string, unknown>>; groups?: AssetGroup[] };
        if (!state || typeof state !== "object") return persistedState as AssetState;
        const items = (state.items ?? []).map((raw) => {
          const { source: _source, ...rest } = raw as Record<string, unknown>;
          void _source;
          return rest as unknown as AssetItem;
        });
        return {
          ...state,
          items,
          groups: state.groups ?? [],
        } as AssetState;
      },
    }
  )
);
