import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_BASE_URL,
  DEFAULT_API_KEY,
  DEFAULT_GREENSCREEN_PROMPT,
  DEFAULT_SPRITESHEET_PROMPT,
} from "@/config/defaults";

// 窄屏断点：小于该宽度时侧边栏默认收折
export const SIDEBAR_COLLAPSE_BREAKPOINT = 768;

// SSR 安全地读取窗口宽度（本项目为 Vite SPA，window 始终存在）
function isNarrowScreen() {
  return typeof window !== "undefined" && window.innerWidth < SIDEBAR_COLLAPSE_BREAKPOINT;
}

function normalizeApiBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
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
  setApiBaseUrl: (baseUrl: string) => void;
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
      apiBaseUrl: "",
      apiKey: "",
      thumbSize: 256,
      greenscreenPrompt: "",
      spritesheetPrompt: "",
      setApiBaseUrl: (apiBaseUrl) => set({ apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl) }),
      setApiKey: (apiKey) => set({ apiKey }),
      setThumbSize: (size) => set({ thumbSize: size }),
      setGreenscreenPrompt: (prompt) => set({ greenscreenPrompt: prompt }),
      setSpritesheetPrompt: (prompt) => set({ spritesheetPrompt: prompt }),
    }),
    {
      name: "ymcp-ui",
      version: 1,
      // 老版本将默认提示词写入了 localStorage；迁移时把等于旧默认值的字段清空，
      // 让这些字段回到"未配置"状态，从而走默认配置读取逻辑。
      migrate: (persistedState: any, version: number) => {
        if (version === 0 && persistedState) {
          if (persistedState.greenscreenPrompt === DEFAULT_GREENSCREEN_PROMPT) {
            persistedState.greenscreenPrompt = "";
          }
          if (persistedState.spritesheetPrompt === DEFAULT_SPRITESHEET_PROMPT) {
            persistedState.spritesheetPrompt = "";
          }
        }
        return persistedState;
      },
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
  const customBaseUrl = normalizeApiBaseUrl(state.apiBaseUrl);
  const defaultBaseUrl = normalizeApiBaseUrl(DEFAULT_BASE_URL);
  const baseUrl = customBaseUrl || defaultBaseUrl;
  const usesDefaultBaseUrl = baseUrl === defaultBaseUrl;
  const apiKey = state.apiKey.trim() || (usesDefaultBaseUrl ? DEFAULT_API_KEY : "");
  const hasOwnKey = !!state.apiKey.trim();
  return { baseUrl, apiKey, hasOwnKey, usesDefaultBaseUrl };
}
