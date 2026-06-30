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
  apiBaseUrl: string;
  apiKey: string;
  thumbSize: number;
  greenscreenPrompt: string;
  spritesheetPrompt: string;
  setApiConfig: (baseUrl: string, apiKey: string) => void;
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
      apiBaseUrl: "",
      apiKey: "",
      thumbSize: 256,
      greenscreenPrompt: "Pure chroma key green background (#00FF00), no shadows, no gradients, no highlights, isolated on solid green screen,background=opaque",
      spritesheetPrompt: "A seamless sprite sheet animation arranged in a grid layout, consisting of multiple frames showing sequential motion, each frame evenly spaced in a regular grid, consistent character scale and positioning, transparent or uniform background, clear visual progression of movement, designed for frame-by-frame animation extraction",
      setApiConfig: (baseUrl, apiKey) => set({ apiBaseUrl: baseUrl, apiKey }),
      setThumbSize: (size) => set({ thumbSize: size }),
      setGreenscreenPrompt: (prompt) => set({ greenscreenPrompt: prompt }),
      setSpritesheetPrompt: (prompt) => set({ spritesheetPrompt: prompt }),
    }),
    {
      name: "ymcp-ui",
      partialize: (state) => ({
        apiBaseUrl: state.apiBaseUrl,
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
  const baseUrl = state.apiBaseUrl.trim() || DEFAULT_BASE_URL;
  const apiKey = state.apiKey.trim() || DEFAULT_API_KEY;
  const hasOwnKey = !!(state.apiBaseUrl.trim() && state.apiKey.trim());
  return { baseUrl, apiKey, hasOwnKey };
}
