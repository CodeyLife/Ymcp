import { create } from "zustand";

type GenMode = "normal" | "greenscreen" | "spritesheet";

export type TaskStatus = "pending" | "loading" | "done" | "error";

export interface GenTask {
  id: string;            // 唯一 id（用于 React key、收藏集合）
  index: number;         // 任务序号 0..N-1
  status: TaskStatus;
  partial?: string;      // 流式中间帧
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
  refImage: string | null;
  tasks: GenTask[];
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
  setRefImage: (url: string | null) => void;
  setTasks: (tasks: GenTask[]) => void;
  updateTask: (index: number, patch: Partial<GenTask>) => void;
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
  quality: "auto",
  styleId: "none",
  refImage: null,
  tasks: [] as GenTask[],
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
  setRefImage: (refImage) => set({ refImage }),
  setTasks: (tasks) => set({ tasks }),
  updateTask: (index, patch) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.index === index ? { ...t, ...patch } : t)),
    })),
  resetTasks: (count) =>
    set({
      tasks: Array.from({ length: count }, (_, i) => ({
        id: `task-${Date.now()}-${i}`,
        index: i,
        status: "pending" as TaskStatus,
        startedAt: Date.now(),
      })),
    }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  reset: () => set(DEFAULTS),
}));
