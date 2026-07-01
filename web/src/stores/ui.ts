import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_BASE_URL, DEFAULT_API_KEY } from "@/config/defaults";

// 窄屏断点：小于该宽度时侧边栏默认收折
export const SIDEBAR_COLLAPSE_BREAKPOINT = 768;

// SSR 安全地读取窗口宽度（本项目为 Vite SPA，window 始终存在）
function isNarrowScreen() {
  return typeof window !== "undefined" && window.innerWidth < SIDEBAR_COLLAPSE_BREAKPOINT;
}

interface UIState {
  collapsed: boolean;
  toggleCollapsed: () => void;
  setCollapsed: (collapsed: boolean) => void;
  incomingImage: { src: string; from: string } | null;
  setIncomingImage: (img: { src: string; from: string } | null) => void;
  apiKey: string;
  thumbSize: number;
  greenscreenPrompt: string;
  spritesheetPrompt: string;
  setApiKey: (apiKey: string) => void;
  setThumbSize: (size: number) => void;
  setGreenscreenPrompt: (prompt: string) => void;
  setSpritesheetPrompt: (prompt: string) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      collapsed: isNarrowScreen(),
      toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
      setCollapsed: (collapsed) => set({ collapsed }),
      incomingImage: null,
      setIncomingImage: (img) => set({ incomingImage: img }),
      apiKey: "",
      thumbSize: 256,
      greenscreenPrompt: "Pure chroma key green background (#00FF00), no shadows, no gradients, no highlights，background=opaque",
      spritesheetPrompt: "A seamless sprite sheet animation arranged in a grid layout, consisting of multiple frames showing sequential motion, each frame evenly spaced in a regular grid, consistent character scale and positioning, transparent or uniform background, clear visual progression of movement, designed for frame-by-frame animation extraction",
      setApiKey: (apiKey) => set({ apiKey }),
      setThumbSize: (size) => set({ thumbSize: size }),
      setGreenscreenPrompt: (prompt) => set({ greenscreenPrompt: prompt }),
      setSpritesheetPrompt: (prompt) => set({ spritesheetPrompt: prompt }),
    }),
    {
      name: "ymcp-ui",
      partialize: (state) => ({
        apiKey: state.apiKey,
        thumbSize: state.thumbSize,
        greenscreenPrompt: state.greenscreenPrompt,
        spritesheetPrompt: state.spritesheetPrompt,
      }),
    }
  )
);

export function getEffectiveApiConfig() {
  const state = useUIStore.getState();
  const baseUrl = DEFAULT_BASE_URL;
  const apiKey = state.apiKey.trim() || DEFAULT_API_KEY;
  const hasOwnKey = !!state.apiKey.trim();
  return { baseUrl, apiKey, hasOwnKey };
}
