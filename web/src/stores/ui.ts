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

/** 生图调用模式：task = 后端异步任务接口（支持断线恢复），direct = OpenAI 兼容直连 */
export type ImageGenAdapter = "task" | "direct";

interface UIState {
  collapsed: boolean;
  toggleCollapsed: () => void;
  setCollapsed: (collapsed: boolean) => void;
  incomingImage: { src: string; from: string } | null;
  setIncomingImage: (img: { src: string; from: string } | null) => void;
  apiBaseUrl: string;
  apiKey: string;
  /** OpenAI-compatible chat model. "auto" lets the upstream choose. */
  chatModel: string;
  /** Provider hard context limit override. 0 means use /models metadata when available. */
  modelContextWindow: number;
  thumbSize: number;
  greenscreenPrompt: string;
  spritesheetPrompt: string;
  /** 生图调用模式，由 Settings 显式指定，默认 task */
  imageGenAdapter: ImageGenAdapter;
  setApiBaseUrl: (baseUrl: string) => void;
  setApiKey: (apiKey: string) => void;
  setChatModel: (model: string) => void;
  setModelContextWindow: (tokens: number) => void;
  setThumbSize: (size: number) => void;
  setGreenscreenPrompt: (prompt: string) => void;
  setSpritesheetPrompt: (prompt: string) => void;
  setImageGenAdapter: (adapter: ImageGenAdapter) => void;
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
      chatModel: "auto",
      modelContextWindow: 0,
      thumbSize: 256,
      greenscreenPrompt: "",
      spritesheetPrompt: "",
      imageGenAdapter: "task",
      setApiBaseUrl: (apiBaseUrl) => set({ apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl) }),
      setApiKey: (apiKey) => set({ apiKey }),
      setChatModel: (chatModel) => set({ chatModel: chatModel.trim() || "auto" }),
      setModelContextWindow: (modelContextWindow) => set({ modelContextWindow: Math.max(0, Math.floor(modelContextWindow || 0)) }),
      setThumbSize: (size) => set({ thumbSize: size }),
      setGreenscreenPrompt: (prompt) => set({ greenscreenPrompt: prompt }),
      setSpritesheetPrompt: (prompt) => set({ spritesheetPrompt: prompt }),
      setImageGenAdapter: (imageGenAdapter) => set({ imageGenAdapter }),
    }),
    {
      name: "ymcp-ui",
      version: 4,
      // v0 -> v1：老版本将默认提示词写入了 localStorage；迁移时把等于旧默认值的字段清空，
      // 让这些字段回到"未配置"状态，从而走默认配置读取逻辑。
      // v1 -> v2：新增 imageGenAdapter 字段，老数据缺失时回退到默认 "task"。
      migrate: (persistedState: any, version: number) => {
        if (persistedState && version < 1) {
          if (persistedState.greenscreenPrompt === DEFAULT_GREENSCREEN_PROMPT) {
            persistedState.greenscreenPrompt = "";
          }
          if (persistedState.spritesheetPrompt === DEFAULT_SPRITESHEET_PROMPT) {
            persistedState.spritesheetPrompt = "";
          }
        }
        if (persistedState && version < 2) {
          if (persistedState.imageGenAdapter !== "task" && persistedState.imageGenAdapter !== "direct") {
            persistedState.imageGenAdapter = "task";
          }
        }
        if (persistedState && version < 3) {
          persistedState.chatModel = "auto";
        }
        if (persistedState && version < 4) persistedState.modelContextWindow = 0;
        return persistedState;
      },
      partialize: (state) => ({
        apiBaseUrl: state.apiBaseUrl,
        apiKey: state.apiKey,
        chatModel: state.chatModel,
        modelContextWindow: state.modelContextWindow,
        thumbSize: state.thumbSize,
        greenscreenPrompt: state.greenscreenPrompt,
        spritesheetPrompt: state.spritesheetPrompt,
        imageGenAdapter: state.imageGenAdapter,
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
  return { baseUrl, apiKey, hasOwnKey, usesDefaultBaseUrl, modelContextWindow: state.modelContextWindow };
}
