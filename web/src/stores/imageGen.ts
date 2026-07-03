import { create } from "zustand";

export type GenMode = "normal" | "greenscreen" | "spritesheet";

/** 图生图参考图数量上限，对齐 OpenAI gpt-image-1 /images/edits 多图上限 */
export const MAX_REF_IMAGES = 16;

function revokeBlobUrl(url: string) {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

export type TaskStatus = "pending" | "loading" | "waiting" | "done" | "error";

export interface GenTask {
  id: string;            // 唯一 id（用于 React key、收藏集合）
  index: number;         // 任务序号 0..N-1
  status: TaskStatus;
  partial?: string;      // 流式中间帧（保留兼容，当前后端不产生）
  progress?: string;     // 后端进度文本（image.generation.chunk.progress_text）
  results?: string[];    // 最终图（blob URL / data URL），支持单任务返回多张
  error?: string;
  startedAt: number;
}

interface ImageGenState {
  mode: "text2img" | "img2img" | "psd";
  genMode: GenMode;
  textPrompt: string;
  imgPrompt: string;
  size: string;
  n: number;
  spritesheetN: number;
  quality: string;
  styleId: string;
  img2imgReferenceGuideId: string | null;
  refImages: string[];
  tasks: GenTask[];
  extraResults: string[];
  loading: boolean;
  error: string | null;
  setMode: (mode: "text2img" | "img2img" | "psd") => void;
  setGenMode: (mode: GenMode) => void;
  setTextPrompt: (prompt: string) => void;
  setImgPrompt: (prompt: string) => void;
  setSize: (size: string) => void;
  setN: (n: number) => void;
  setSpritesheetN: (n: number) => void;
  setQuality: (quality: string) => void;
  setStyleId: (styleId: string) => void;
  setImg2imgReferenceGuideId: (guideId: string | null) => void;
  /** 整体替换参考图数组（程序化送图用，会 revoke 旧 blob URL） */
  setRefImages: (urls: string[]) => void;
  /** 追加参考图（上传用，内部裁剪到 MAX_REF_IMAGES） */
  addRefImages: (urls: string[]) => number;
  /** 移除指定下标的参考图并 revoke 其 blob URL */
  removeRefImage: (index: number) => void;
  /** 清空全部参考图并 revoke 所有 blob URL */
  clearRefImages: () => void;
  setTasks: (tasks: GenTask[]) => void;
  updateTask: (index: number, patch: Partial<GenTask>) => void;
  addExtraResult: (src: string) => void;
  resetTasks: (count: number) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const DEFAULTS = {
  mode: "text2img" as const,
  genMode: "normal" as const,
  textPrompt: "",
  imgPrompt: "",
  size: "auto",
  n: 1,
  spritesheetN: 4,
  quality: "high",
  styleId: "none",
  img2imgReferenceGuideId: null,
  refImages: [] as string[],
  tasks: [] as GenTask[],
  extraResults: [] as string[],
  loading: false,
  error: null as string | null,
};

export const useImageGenStore = create<ImageGenState>((set) => ({
  ...DEFAULTS,
  setMode: (mode) => set({ mode }),
  setGenMode: (genMode) => set({ genMode }),
  setTextPrompt: (textPrompt) => set({ textPrompt }),
  setImgPrompt: (imgPrompt) => set({ imgPrompt }),
  setSize: (size) => set({ size }),
  setN: (n) => set({ n }),
  setSpritesheetN: (n) => set({ spritesheetN: n }),
  setQuality: (quality) => set({ quality }),
  setStyleId: (styleId) => set({ styleId }),
  setImg2imgReferenceGuideId: (img2imgReferenceGuideId) => set({ img2imgReferenceGuideId }),
  setRefImages: (refImages) =>
    set((state) => {
      const kept = refImages.slice(0, MAX_REF_IMAGES);
      const keptSet = new Set(kept);
      state.refImages.forEach((url) => {
        if (!keptSet.has(url)) revokeBlobUrl(url);
      });
      refImages.slice(MAX_REF_IMAGES).forEach((url) => {
        if (!keptSet.has(url)) revokeBlobUrl(url);
      });
      return { refImages: kept };
    }),
  addRefImages: (urls) => {
    let acceptedCount = 0;
    set((state) => {
      const remaining = Math.max(0, MAX_REF_IMAGES - state.refImages.length);
      const accepted = urls.slice(0, remaining);
      acceptedCount = accepted.length;
      urls.slice(remaining).forEach(revokeBlobUrl);
      return { refImages: [...state.refImages, ...accepted] };
    });
    return acceptedCount;
  },
  removeRefImage: (index) =>
    set((state) => {
      const removed = state.refImages[index];
      if (removed) revokeBlobUrl(removed);
      return { refImages: state.refImages.filter((_, i) => i !== index) };
    }),
  clearRefImages: () =>
    set((state) => {
      state.refImages.forEach(revokeBlobUrl);
      return { refImages: [] };
    }),
  setTasks: (tasks) => set({ tasks }),
  updateTask: (index, patch) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.index === index ? { ...t, ...patch } : t)),
    })),
  addExtraResult: (src) =>
    set((state) => ({
      extraResults: [...state.extraResults, src],
    })),
  resetTasks: (count) =>
    set({
      tasks: Array.from({ length: count }, (_, i) => ({
        id: `task-${Date.now()}-${i}`,
        index: i,
        status: "pending" as TaskStatus,
        startedAt: Date.now(),
      })),
      extraResults: [],
    }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  reset: () =>
    set((state) => {
      state.refImages.forEach(revokeBlobUrl);
      return { ...DEFAULTS, tasks: [], extraResults: [] };
    }),
}));
