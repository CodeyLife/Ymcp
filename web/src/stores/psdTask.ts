import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { EditableFileTask } from "@/lib/api";

/**
 * PSD 任务本地视图模型：在远端 EditableFileTask 基础上附带本地元数据。
 * - origin: "user" 用户主动创建；"split" 由结果卡片"拆分为 PSD"派生。
 * - promptSnapshot: 创建时使用的提示词（用于列表展示，避免后端字段缺失）。
 */
export interface PsdTaskView extends EditableFileTask {
  origin: "user" | "split";
  promptSnapshot?: string;
  localError?: string;
}

interface PsdTaskState {
  tasks: PsdTaskView[];
  creating: boolean;
  createError: string | null;

  /** 由"拆分为 PSD"按钮预填的参考图（data URL），表单挂载后消费并清空 */
  pendingBase64Images: string[];
  pendingPrompt: string;

  setTasks: (tasks: PsdTaskView[]) => void;
  upsertTask: (task: EditableFileTask, meta?: { origin?: "user" | "split"; promptSnapshot?: string }) => void;
  patchTask: (id: string, patch: Partial<PsdTaskView>) => void;
  removeTask: (id: string) => void;
  clearAll: () => void;

  setCreating: (creating: boolean) => void;
  setCreateError: (error: string | null) => void;

  setPendingBase64Images: (images: string[]) => void;
  setPendingPrompt: (prompt: string) => void;
  consumePending: () => { images: string[]; prompt: string };
}

export const usePsdTaskStore = create<PsdTaskState>()(
  persist(
    (set, get) => ({
      tasks: [],
      creating: false,
      createError: null,
      pendingBase64Images: [],
      pendingPrompt: "",

      setTasks: (tasks) => set({ tasks }),

      upsertTask: (task, meta) =>
        set((state) => {
          const id = task.id || task.taskId || "";
          const existingIdx = state.tasks.findIndex(
            (t) => t.id === id || (task.taskId && t.taskId === task.taskId)
          );
          const merged: PsdTaskView = {
            ...(existingIdx >= 0 ? state.tasks[existingIdx] : ({} as PsdTaskView)),
            ...task,
            id,
            origin: meta?.origin ?? (existingIdx >= 0 ? state.tasks[existingIdx].origin : "user"),
            promptSnapshot:
              meta?.promptSnapshot ??
              (existingIdx >= 0 ? state.tasks[existingIdx].promptSnapshot : undefined),
          };
          const next = [...state.tasks];
          if (existingIdx >= 0) next[existingIdx] = merged;
          else next.unshift(merged);
          return { tasks: next };
        }),

      patchTask: (id, patch) =>
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        })),

      removeTask: (id) =>
        set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) })),

      clearAll: () => set({ tasks: [], createError: null }),

      setCreating: (creating) => set({ creating }),
      setCreateError: (createError) => set({ createError }),

      setPendingBase64Images: (pendingBase64Images) => set({ pendingBase64Images }),
      setPendingPrompt: (pendingPrompt) => set({ pendingPrompt }),

      consumePending: () => {
        const { pendingBase64Images, pendingPrompt } = get();
        if (pendingBase64Images.length === 0 && !pendingPrompt) {
          return { images: [], prompt: "" };
        }
        set({ pendingBase64Images: [], pendingPrompt: "" });
        return { images: pendingBase64Images, prompt: pendingPrompt };
      },
    }),
    {
      name: "ymcp-psd-tasks",
      partialize: (state) => ({ tasks: state.tasks }),
    }
  )
);
