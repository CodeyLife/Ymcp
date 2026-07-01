/**
 * 超分引擎主线程封装
 *
 * 管理 Worker 生命周期，提供 Promise 化 API。
 * Worker 负责实际推理，主线程仅负责通信与 UI 更新。
 */

import SuperResWorker from "./superRes.worker.ts?worker";

export type SuperResBackend = "webgpu" | "wasm";

interface PendingTask {
  resolve: (data: ImageData) => void;
  reject: (err: Error) => void;
  onProgress?: (p: number) => void;
}

export class SuperResEngine {
  private worker: Worker | null = null;
  private pending = new Map<number, PendingTask>();
  private nextId = 1;
  private initPromise: Promise<SuperResBackend> | null = null;
  private initHandlers: ((backend: SuperResBackend) => void) | null = null;
  private initErrorHandlers: ((err: Error) => void) | null = null;

  /** 初始化引擎（加载模型到 Worker） */
  async init(modelBuffer: ArrayBuffer): Promise<SuperResBackend> {
    if (this.initPromise) return this.initPromise;

    this.worker = new SuperResWorker();
    this.worker.onmessage = (e: MessageEvent) => this.handleMessage(e.data);
    this.worker.onerror = (e) => {
      const err = new Error(e.message || "Worker 加载失败");
      if (this.initErrorHandlers) this.initErrorHandlers(err);
      this.pending.forEach((p) => p.reject(err));
      this.pending.clear();
    };

    this.initPromise = new Promise<SuperResBackend>((resolve, reject) => {
      this.initHandlers = resolve;
      this.initErrorHandlers = reject;
      // transfer ArrayBuffer 零拷贝
      this.worker!.postMessage({ type: "init", modelBuffer }, [modelBuffer]);
    }).catch((err) => {
      this.worker?.terminate();
      this.worker = null;
      this.initPromise = null;
      this.initHandlers = null;
      this.initErrorHandlers = null;
      throw err;
    });
    return this.initPromise;
  }

  /** 执行超分 */
  upscale(
    imageData: ImageData,
    onProgress?: (p: number) => void,
  ): Promise<ImageData> {
    if (!this.worker) return Promise.reject(new Error("引擎未初始化"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker!.postMessage({ type: "upscale", imageData, requestId: id });
    });
  }

  private handleMessage(data: any) {
    if (data.type === "inited") {
      if (this.initHandlers) this.initHandlers(data.backend as SuperResBackend);
      this.initHandlers = null;
      this.initErrorHandlers = null;
    } else if (data.type === "progress") {
      const task = this.pending.get(data.requestId);
      if (task) task.onProgress?.(data.progress);
    } else if (data.type === "result") {
      const task = this.pending.get(data.requestId);
      if (task) {
        task.resolve(data.imageData as ImageData);
        this.pending.delete(data.requestId);
      }
    } else if (data.type === "error") {
      const err = new Error(data.message);
      if (data.requestId != null) {
        const task = this.pending.get(data.requestId);
        if (task) {
          task.reject(err);
          this.pending.delete(data.requestId);
        }
      } else {
        // init 阶段错误
        if (this.initErrorHandlers) this.initErrorHandlers(err);
      }
    }
  }

  /** 销毁引擎，释放 Worker */
  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
    this.initHandlers = null;
    this.initErrorHandlers = null;
    this.pending.forEach((p) => p.reject(new Error("引擎已销毁")));
    this.pending.clear();
  }
}

// 全局单例
let engine: SuperResEngine | null = null;

export function getSuperResEngine(): SuperResEngine {
  if (!engine) engine = new SuperResEngine();
  return engine;
}

/** 销毁全局引擎（用于重新初始化） */
export function disposeSuperResEngine() {
  if (engine) {
    engine.dispose();
    engine = null;
  }
}
