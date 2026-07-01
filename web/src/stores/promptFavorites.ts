import { create } from "zustand";
import { persist } from "zustand/middleware";

export type PromptSourceMode = "text2img" | "img2img";
export type PromptGenMode = "normal" | "greenscreen" | "spritesheet";

export interface PromptFavorite {
  id: string;
  title: string;
  prompt: string;
  sourceMode: PromptSourceMode;
  genMode: PromptGenMode;
  styleId: string;
  createdAt: number;
  updatedAt: number;
  usageCount: number;
  lastUsedAt: number | null;
}

interface PromptFavoriteDraft {
  title?: string;
  prompt: string;
  sourceMode: PromptSourceMode;
  genMode: PromptGenMode;
  styleId: string;
}

interface PromptFavoriteState {
  items: PromptFavorite[];
  add: (draft: PromptFavoriteDraft) => PromptFavorite;
  update: (id: string, patch: Partial<Omit<PromptFavorite, "id" | "createdAt">>) => PromptFavorite | null;
  remove: (id: string) => void;
  markUsed: (id: string) => void;
  findDuplicate: (prompt: string) => PromptFavorite | undefined;
}

function normalizePrompt(prompt: string): string {
  return prompt.trim();
}

function makeId(): string {
  return `prompt-fav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createPromptFavoriteTitle(prompt: string): string {
  const firstLine = normalizePrompt(prompt).split(/\r?\n/).find(Boolean) || "未命名提示词";
  const compact = firstLine.replace(/\s+/g, " ").trim();
  return compact.length > 18 ? `${compact.slice(0, 18)}…` : compact;
}

export const usePromptFavoriteStore = create<PromptFavoriteState>()(
  persist(
    (set, get) => ({
      items: [],
      add: (draft) => {
        const now = Date.now();
        const prompt = normalizePrompt(draft.prompt);
        const item: PromptFavorite = {
          id: makeId(),
          title: draft.title?.trim() || createPromptFavoriteTitle(prompt),
          prompt,
          sourceMode: draft.sourceMode,
          genMode: draft.genMode,
          styleId: draft.styleId,
          createdAt: now,
          updatedAt: now,
          usageCount: 0,
          lastUsedAt: null,
        };
        set((state) => ({ items: [item, ...state.items].slice(0, 300) }));
        return item;
      },
      update: (id, patch) => {
        let updated: PromptFavorite | null = null;
        set((state) => ({
          items: state.items.map((item) => {
            if (item.id !== id) return item;
            updated = {
              ...item,
              ...patch,
              title: patch.title !== undefined ? patch.title.trim() || createPromptFavoriteTitle(patch.prompt ?? item.prompt) : item.title,
              prompt: patch.prompt !== undefined ? normalizePrompt(patch.prompt) : item.prompt,
              updatedAt: Date.now(),
            };
            return updated;
          }),
        }));
        return updated;
      },
      remove: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
      markUsed: (id) =>
        set((state) => ({
          items: state.items.map((item) =>
            item.id === id
              ? {
                  ...item,
                  usageCount: item.usageCount + 1,
                  lastUsedAt: Date.now(),
                }
              : item
          ),
        })),
      findDuplicate: (prompt) => {
        const normalized = normalizePrompt(prompt);
        return get().items.find((item) => item.prompt === normalized);
      },
    }),
    { name: "ymcp-prompt-favorites" }
  )
);
