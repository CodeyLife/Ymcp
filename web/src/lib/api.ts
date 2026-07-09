import axios from "axios";
import {
  IMAGEGEN_SYSTEM_PROMPT,
  buildPolishUserMessage,
} from "@/lib/imagegenPresets";
import { DEFAULT_BASE_URL } from "@/config/defaults";

export const api = axios.create({
  baseURL: "/api",
  timeout: 120_000,
  headers: { "content-type": "application/json" },
});

const localImageCache = new Map<string, Promise<string>>();

const SUPPORTED_RASTER_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
]);

api.interceptors.response.use(
  (res) => res,
  (error) => {
    const rawMessage = error?.message || "";
    let message: string;
    // 识别网络层错误（手机后台切换/断网等），替换为友好提示
    if (
      rawMessage === "Failed to fetch" ||
      rawMessage === "Network Error" ||
      error?.name === "TypeError"
    ) {
      message = "网络连接失败，请检查网络或 API 地址";
    } else {
      message =
        error?.response?.data?.detail ||
        error?.response?.data?.error ||
        rawMessage ||
        "请求失败";
    }
    return Promise.reject(new Error(String(message)));
  }
);

/* ---- 类型定义 ---- */

export interface Session {
  id: string;
  title: string;
  type: "v2f" | "image_gen" | "video_gen";
  workflow_id?: string;
  params: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Generation {
  id: string;
  session_id: string;
  type: "image" | "video" | "framesheet";
  prompt: string;
  negative_prompt: string;
  model: string;
  params: Record<string, unknown>;
  output_path: string;
  thumbnail_path?: string;
  status: "pending" | "processing" | "completed" | "failed";
  created_at: string;
}

export interface Workflow {
  id: string;
  name: string;
  type: "image_gen" | "video_gen";
  params: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Asset {
  id: string;
  path: string;
  type: "image" | "video" | "audio";
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: string;
}

/* ---- 工具函数 ---- */

/** 将远程图片 URL 下载为本地 blob URL，避免跨域和链接失效 */
export async function cacheImageLocally(url: string): Promise<string> {
  // 如果已经是 data URL 或 blob URL，直接返回
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;
  // HTTPS 页面禁止加载 HTTP 资源（Mixed Content），强制升级为 HTTPS
  const safeUrl = url.replace(/^http:\/\//i, "https://");
  const cached = localImageCache.get(safeUrl);
  if (cached) return cached;

  const localUrl = fetch(safeUrl)
    .then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(formatRemoteImageError(response.status, errorText));
      }

      const blob = await response.blob();
      const contentType = normalizeMime(response.headers.get("content-type"));
      const blobType = normalizeMime(blob.type) || contentType;
      const hasImageSignature = await hasRasterImageSignature(blob);

      if (blobType && !SUPPORTED_RASTER_IMAGE_MIME.has(blobType)) {
        if (hasImageSignature) return URL.createObjectURL(blob);
        const errorText = await blob.text().catch(() => "");
        throw new Error(formatRemoteImageError(response.status, errorText || `非图片响应：${blobType}`));
      }
      if (!blobType && !hasImageSignature) {
        const errorText = await blob.text().catch(() => "");
        throw new Error(formatRemoteImageError(response.status, errorText || "响应不是有效图片"));
      }

      return URL.createObjectURL(blob);
    })
    .catch((error) => {
      localImageCache.delete(safeUrl);
      throw error;
    });
  localImageCache.set(safeUrl, localUrl);
  return localUrl;
}

function normalizeMime(value: string | null): string {
  return (value || "").split(";")[0].trim().toLowerCase();
}

function formatRemoteImageError(status: number, body: string): string {
  const text = body.trim().replace(/\s+/g, " ").slice(0, 180);
  return text ? `图片下载失败（HTTP ${status}）：${text}` : `图片下载失败（HTTP ${status}）`;
}

async function hasRasterImageSignature(blob: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  if (bytes.length < 4) return false;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isGif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
  const isWebp =
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;
  return isPng || isJpeg || isGif || isWebp;
}

/** 通过字节流魔数检测图片真实 mime，未知返回 image/png */
export function detectMimeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < 4) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return "image/png";
}

/** 从 base64 创建 blob URL */
export function base64ToBlobUrl(b64: string, mime?: string): string {
  const byteChars = atob(b64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  // 调用方显式指定 mime 时优先用指定值；否则用魔数检测结果（覆盖旧的默认 image/png）
  const finalMime = mime || detectMimeFromBytes(byteArray);
  const blob = new Blob([byteArray], { type: finalMime });
  return URL.createObjectURL(blob);
}

/**
 * 将 blob URL / 普通图片 URL 转为 data URL（base64），用于持久化到 localStorage。
 * data URL 不会因页面刷新而失效，可直接存入持久化存储。
 */
export async function toDataUrl(src: string): Promise<string> {
  if (src.startsWith("data:")) return src;
  const response = await fetch(src);
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** 将 blob URL 转为 data URL（base64），用于持久化存储 */
export async function blobUrlToDataUrl(blobUrl: string): Promise<string> {
  if (blobUrl.startsWith("data:")) return blobUrl;
  if (!blobUrl.startsWith("blob:")) return blobUrl;
  
  const response = await fetch(blobUrl);
  const blob = await response.blob();
  
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/* ---- API 封装 ---- */

export const sessionsApi = {
  list: () => api.get<Session[]>("/sessions").then((r) => r.data),
  get: (id: string) => api.get<Session>(`/sessions/${id}`).then((r) => r.data),
  create: (data: Partial<Session>) =>
    api.post<Session>("/sessions", data).then((r) => r.data),
  remove: (id: string) => api.delete(`/sessions/${id}`),
};

export const workflowsApi = {
  list: () => api.get<Workflow[]>("/workflows").then((r) => r.data),
  create: (data: Partial<Workflow>) =>
    api.post<Workflow>("/workflows", data).then((r) => r.data),
  update: (id: string, data: Partial<Workflow>) =>
    api.put<Workflow>(`/workflows/${id}`, data).then((r) => r.data),
  remove: (id: string) => api.delete(`/workflows/${id}`),
  execute: (id: string) =>
    api.post<Generation[]>(`/workflows/${id}/execute`).then((r) => r.data),
};

export interface ImageRequestCallbacks {
  /** 后端进度文本（image.generation.chunk.progress_text） */
  onProgress?: (text: string) => void;
  /** 单张图完成（image.generation.result），index 为 1-based */
  onResult?: (index: number, images: string[]) => void;
  /** 全部完成（流式末尾或非流式兜底），images 为全部图片 */
  onComplete?: (images: string[]) => void;
  onError?: (error: string) => void;
}

const IMAGE_GENERATION_STREAMING_ENABLED = false;

function resolveBaseUrl(baseUrl: string): string {
  const isDefault = baseUrl === DEFAULT_BASE_URL;
  // 仅开发环境用 Vite proxy (/ai-proxy) 绕过 CORS；生产环境直连原始 URL
  if (isDefault && import.meta.env.DEV) return "/ai-proxy";
  return baseUrl;
}

function isImageDataUrl(value: string): boolean {
  return /^data:image\/(png|jpe?g|webp|gif|avif|bmp);base64,/i.test(value);
}

function isImageLikeBase64(value: string): boolean {
  const normalized = value.replace(/\s+/g, "");
  if (normalized.length < 32 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return false;
  return (
    normalized.startsWith("iVBORw0KGgo") ||
    normalized.startsWith("/9j/") ||
    normalized.startsWith("UklGR") ||
    normalized.startsWith("R0lGOD")
  );
}

function extractApiErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const item = payload as Record<string, unknown>;
  const candidates = [item.error, item.message, item.detail];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      const nestedMessage = nested.message || nested.detail || nested.error;
      if (typeof nestedMessage === "string" && nestedMessage.trim()) return nestedMessage.trim();
    }
  }

  return null;
}

function extractStreamErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const error = extractStreamErrorMessage(item);
      if (error) return error;
    }
    return null;
  }

  const item = payload as Record<string, unknown>;
  const kind = String(item.object || item.type || "").toLowerCase();
  const status = String(item.status || "").toLowerCase();
  const isFailedStatus = status === "failed" || status === "error";
  const isErrorEvent = kind === "error" || kind.endsWith(".error");

  if (isFailedStatus || isErrorEvent) {
    return extractApiErrorMessage(item) || "生成失败";
  }

  if ("error" in item && item.error) {
    const explicitError = extractApiErrorMessage({ error: item.error });
    if (explicitError) return explicitError;
  }

  return extractStreamErrorMessage(item.data);
}

function isInternalImageMessage(message: string): boolean {
  return /\bskipped_[a-z0-9_]+\s*:/i.test(message);
}

function splitSseBlocks(buffer: string): { payloads: string[]; rest: string } {
  if (!buffer.includes("\n\n") && !buffer.includes("\r\n\r\n")) {
    const lines = buffer.split(/\r?\n/);
    const rest = lines.pop() || "";
    return {
      payloads: lines
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean),
      rest,
    };
  }

  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() || "";
  const payloads = blocks
    .map((block) => block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim())
    .filter(Boolean);
  return { payloads, rest };
}

function splitNdjsonLines(buffer: string): { payloads: string[]; rest: string } {
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() || "";
  return {
    payloads: lines.map((line) => line.trim()).filter(Boolean),
    rest,
  };
}

async function readApiError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return `HTTP ${response.status}`;

  try {
    const json = JSON.parse(text);
    return extractApiErrorMessage(json) || text;
  } catch {
    return text;
  }
}

export async function extractImageSources(
  payload: unknown,
  seenSources: Set<string> = new Set()
): Promise<string[]> {
  const images: string[] = [];

  const addUrl = async (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    const src = value.trim();
    const key = `url:${src}`;
    if (seenSources.has(key)) return;
    if (isImageDataUrl(src) || src.startsWith("blob:")) {
      seenSources.add(key);
      images.push(src);
    } else if (/^https?:\/\//i.test(src)) {
      seenSources.add(key);
      images.push(await cacheImageLocally(src));
    }
  };

  const addBase64 = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    const src = value.trim();
    if (isImageDataUrl(src) || src.startsWith("blob:")) {
      const key = `url:${src}`;
      if (seenSources.has(key)) return;
      seenSources.add(key);
      images.push(src);
      return;
    }
    if (/^https?:\/\//i.test(src)) return;
    if (!isImageLikeBase64(src)) return;
    const key = `b64:${src}`;
    if (seenSources.has(key)) return;
    seenSources.add(key);
    images.push(base64ToBlobUrl(src));
  };

  const addAmbiguousImage = async (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    const src = value.trim();
    if (isImageDataUrl(src) || src.startsWith("blob:") || /^https?:\/\//i.test(src)) {
      await addUrl(src);
    } else if (isImageLikeBase64(src)) {
      addBase64(src);
    }
  };

  const visit = async (value: unknown): Promise<void> => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) await visit(item);
      return;
    }
    if (typeof value === "string") {
      await addAmbiguousImage(value);
      return;
    }
    if (typeof value !== "object") return;

    const item = value as Record<string, unknown>;
    const hasPrimaryImage =
      (typeof item.url === "string" && item.url.trim()) ||
      (typeof item.image_url === "string" && item.image_url.trim()) ||
      (typeof item.src === "string" && item.src.trim());

    await addUrl(item.url);
    await addAmbiguousImage(item.image_url);
    await addAmbiguousImage(item.src);

    if (!hasPrimaryImage) {
      addBase64(item.b64_json);
      addBase64(item.image_base64);
      addBase64(item.base64);
      await addAmbiguousImage(item.result);
    }

    await visit(item.data);
    await visit(item.output);
    await visit(item.urls);
    await visit(item.images);
    await visit(item.image_url);
    if (!hasPrimaryImage || (typeof item.result === "object" && item.result !== null)) {
      await visit(item.result);
    }
    if (!hasPrimaryImage || (typeof item.content === "object" && item.content !== null)) {
      await visit(item.content);
    }
  };

  await visit(payload);
  return images;
}

/** 生图请求：当前默认非流式返回；保留 SSE/NDJSON 解析路径供后续重新启用流式。 */
export async function generateImageRequest(
  data: {
    prompt: string;
    model: string;
    size: string;
    n: number;
    quality?: string;
    style?: string;
    baseUrl: string;
    apiKey: string;
    images?: string[]; // base64 data URLs for img2img（支持多张）
  },
  callbacks: ImageRequestCallbacks,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const { baseUrl, apiKey, ...body } = data;
  const endpoint = resolveBaseUrl(baseUrl);
  const isImg2Img = !!(body.images && body.images.length > 0);

  // 图生图用 /images/edits 端点，文生图用 /images/generations
  const path = isImg2Img ? "/images/edits" : "/images/generations";

  try {
    let response: Response;
    if (isImg2Img) {
      // /images/edits 需要 multipart/form-data
      const formData = new FormData();
      formData.append("model", body.model);
      formData.append("prompt", body.prompt);
      formData.append("n", String(body.n));
      formData.append("size", body.size);
      formData.append("response_format", "b64_json");
      formData.append("stream", String(IMAGE_GENERATION_STREAMING_ENABLED));
      if (body.quality) formData.append("quality", body.quality);
      // 多图：循环 append "image" 字段
      // API 文档：image 类型为 file | file[] | URL，OpenAI 兼容约定下多图通过重复 image 字段传递
      const images = body.images!;
      for (let i = 0; i < images.length; i++) {
        const dataUrl = images[i];
        const mimeMatch = dataUrl.match(/^data:(image\/[a-z+]+);/i);
        const mime = mimeMatch?.[1] || "image/png";
        const base64Data = dataUrl.split(",")[1] || dataUrl;
        const imageBlob = await (await fetch(`data:${mime};base64,${base64Data}`)).blob();
        const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
        formData.append("image", imageBlob, `reference-${i}.${ext}`);
      }

      response = await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: formData,
        signal: options?.signal,
      });
    } else {
      // /images/generations 用 JSON
      const requestBody: Record<string, unknown> = {
        model: body.model,
        prompt: body.prompt,
        n: body.n,
        size: body.size,
        quality: body.quality,
        response_format: "b64_json",
        stream: IMAGE_GENERATION_STREAMING_ENABLED,
      };
      if (body.style) requestBody.style = body.style;

      response = await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: options?.signal,
      });
    }

    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    const contentType = response.headers.get("content-type") || "";
    const isStreamResponse =
      contentType.includes("text/event-stream") || contentType.includes("application/x-ndjson");
    if (!isStreamResponse) {
      const json = await response.json();
      const images = await extractImageSources(json);
      if (images.length === 0) {
        const apiError = extractApiErrorMessage(json);
        if (apiError) throw new Error(apiError);
      }
      if (options?.signal?.aborted) return;
      callbacks.onComplete?.(images);
      return;
    }

    // 解析 SSE / NDJSON 流。当前开关关闭，但保留实现以便未来恢复渐进式进度。
    const isNdjson = contentType.includes("application/x-ndjson");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const finalImages: string[] = [];
    const finalImageSources = new Set<string>();
    let nextImplicitResultIndex = 1;
    let sawDoneEvent = false;
    let sawStreamEvent = false;

    const emitImages = (index: number, images: string[]) => {
      if (images.length === 0) return;
      finalImages.push(...images);
      callbacks.onResult?.(index, images);
      nextImplicitResultIndex = Math.max(nextImplicitResultIndex, index + images.length);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parsed = isNdjson ? splitNdjsonLines(buffer) : splitSseBlocks(buffer);
      buffer = parsed.rest;

      for (const dataStr of parsed.payloads) {
        if (!dataStr) continue;
        sawStreamEvent = true;
        if (dataStr === "[DONE]") {
          sawDoneEvent = true;
          continue;
        }

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(dataStr);
        } catch {
          // 忽略非 JSON SSE 心跳/日志行
          continue;
        }

        const streamError = extractStreamErrorMessage(event);
        if (streamError) throw new Error(streamError);

        // 后端 SSE 事件类型（chatgpt2api 使用 event.object 标识）
        const obj = String(event.object || event.type || "");
        if (obj === "image.generation.chunk") {
          const text = String(event.progress_text || "").trim();
          if (text) callbacks.onProgress?.(text);
        } else if (obj === "image.generation.result") {
          const idx = Number(event.index) || 1;
          const images = await extractImageSources(event, finalImageSources);
          emitImages(idx, images);
        } else if (obj === "image.generation.message") {
          // message 可能是上游文本/警告，作为进度信息呈现
          const msg = String(event.message || "").trim();
          if (msg && !isInternalImageMessage(msg)) callbacks.onProgress?.(msg);
        } else if (obj === "error" || event.type === "error") {
          throw new Error(extractApiErrorMessage(event) || "生成失败");
        } else if (event.data) {
          // 兼容其他后端格式：尝试提取图片
          const apiError = extractApiErrorMessage(event.data);
          if (apiError) throw new Error(apiError);
          const images = await extractImageSources(event.data, finalImageSources);
          emitImages(nextImplicitResultIndex, images);
        }
        if (options?.signal?.aborted) return;
      }
    }

    const tail = buffer.trim();
    if (tail && tail !== "[DONE]") {
      let json: unknown = null;
      try {
        json = JSON.parse(tail.startsWith("data:") ? tail.slice(5).trim() : tail);
      } catch {
        // 忽略不完整的流尾碎片
      }
      if (json) {
        const streamError = extractStreamErrorMessage(json);
        if (streamError) throw new Error(streamError);
        const images = await extractImageSources(json, finalImageSources);
        emitImages(nextImplicitResultIndex, images);
      }
    }

    if (finalImages.length === 0) {
      throw new Error(
        sawStreamEvent
          ? sawDoneEvent
            ? "生成结束，但未收到生成结果"
            : "SSE 连接已中断，未收到生成结果"
          : "SSE 连接已结束，未收到任何生成事件"
      );
    }

    if (!options?.signal?.aborted) callbacks.onComplete?.(finalImages);
  } catch (e) {
    if (options?.signal?.aborted) return;
    callbacks.onError?.(String((e as Error).message));
  }
}

export interface BatchTaskParams {
  prompt: string;
  model: string;
  size: string;
  quality?: string;
  style?: string;
  baseUrl: string;
  apiKey: string;
  images?: string[];
}

export interface MultiCallbacks {
  onTaskStart?: () => void;
  onTaskProgress?: (text: string, taskIndex?: number) => void;
  /** taskIndex 0-based；单张图完成 */
  onTaskResult?: (taskIndex: number, images: string[]) => void;
  onExtraResult?: (src: string) => void;
  onTaskError?: (taskIndex: number, error: string) => void;
  onAllDone?: (summary: { ok: number; fail: number; extra: number }) => void;
  /** 任务提交后触发，暴露 clientTaskId 供外部用于断线恢复查询（globalIndex 1-based） */
  onTaskSubmit?: (globalIndex: number, clientTaskId: string) => void;
  /** 实际使用的后端能力：task 支持断线恢复，direct 为标准 OpenAI-compatible 直连降级 */
  onAdapterResolved?: (adapter: ImageGenerationAdapterKind) => void;
}

export type ImageGenerationAdapterKind = "task" | "direct";

export interface SubmittedImageTaskRef {
  taskId: string;
  globalIndex: number;
}

export interface ImageTaskRefreshCallbacks {
  onTaskProgress?: (taskIndex: number, text: string) => void;
  onTaskResult?: (taskIndex: number, images: string[]) => void;
  onTaskError?: (taskIndex: number, error: string) => void;
}

export interface ImageTaskRefreshResult {
  remaining: SubmittedImageTaskRef[];
  ok: number;
  fail: number;
}

export interface ImageTaskRefreshOptions {
  totalN: number;
  settledSlots?: Set<number>;
}

function imageTaskSlotRange(taskG: number, totalN: number): { startSlot: number; endSlot: number } {
  return {
    startSlot: (taskG - 1) * IMAGE_TASK_MAX_N_PER_TASK,
    endSlot: Math.min(taskG * IMAGE_TASK_MAX_N_PER_TASK, totalN),
  };
}

function imageTaskDataIndex(item: unknown, fallback: number): number {
  const value = typeof item === "object" && item ? (item as ImageTaskData).index : undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function extractImageTaskSlotImages(data: ImageTaskData[] | unknown): Promise<Array<{ relativeIndex: number; src: string }>> {
  const seenSources = new Set<string>();
  if (!Array.isArray(data)) {
    const images = await extractImageSources({ data }, seenSources);
    return images.map((src, index) => ({ relativeIndex: index, src }));
  }

  const output: Array<{ relativeIndex: number; src: string }> = [];
  for (let itemOffset = 0; itemOffset < data.length; itemOffset++) {
    const item = data[itemOffset];
    const images = await extractImageSources(item, seenSources);
    const baseIndex = imageTaskDataIndex(item, itemOffset + 1);
    images.forEach((src, imageOffset) => {
      output.push({ relativeIndex: baseIndex - 1 + imageOffset, src });
    });
  }
  return output;
}

function imageTaskFailedIndices(item: ImageTask): Set<number> {
  const values = Array.isArray(item.failed_indices) ? item.failed_indices : [];
  return new Set(
    values
      .map((value) => (typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN))
      .filter((value) => Number.isInteger(value) && value > 0)
  );
}

function imageTaskSlotFailureMessage(item: ImageTask, relativeIndex: number, fallback: string): string {
  const error = typeof item.error === "string" ? item.error.trim() : "";
  if (error) return error;
  if (imageTaskFailedIndices(item).has(relativeIndex)) return `第 ${relativeIndex} 张生成失败`;
  return fallback;
}

export interface ImageGenerationClient {
  submitBatch: (
    task: BatchTaskParams & { n: number; adapter: ImageGenerationAdapterKind },
    callbacks: MultiCallbacks,
    options?: { signal?: AbortSignal }
  ) => Promise<void>;
  refreshTasks: (
    taskRefs: SubmittedImageTaskRef[],
    config: { baseUrl: string; apiKey: string },
    callbacks?: ImageTaskRefreshCallbacks,
    options?: ImageTaskRefreshOptions
  ) => Promise<ImageTaskRefreshResult>;
  resumeTasks: (
    taskRefs: SubmittedImageTaskRef[],
    config: { baseUrl: string; apiKey: string },
    callbacks?: ImageTaskRefreshCallbacks & {
      onAllDone?: (summary: { ok: number; fail: number }) => void;
    },
    options?: { totalN: number },
    signalOptions?: { signal?: AbortSignal }
  ) => Promise<void>;
}

const IMAGE_TASK_POLL_INTERVAL_MS = 1500;
const IMAGE_TASK_QUERY_FAILURE_LIMIT = 3;
export const IMAGE_TASK_MAX_N_PER_TASK = 24;

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function resolveImageTaskApiBaseUrl(baseUrl: string): string {
  const normalized = trimTrailingSlash(baseUrl);
  const defaultBaseUrl = trimTrailingSlash(DEFAULT_BASE_URL);
  if (normalized === defaultBaseUrl && import.meta.env.DEV) return "/api/image-tasks";

  try {
    const url = new URL(normalized);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (/\/v\d+$/i.test(pathname)) {
      url.pathname = pathname.replace(/\/v\d+$/i, "/api/image-tasks");
    } else {
      url.pathname = `${pathname}/api/image-tasks`.replace(/\/{2,}/g, "/");
    }
    url.search = "";
    url.hash = "";
    return trimTrailingSlash(url.toString());
  } catch {
    if (/\/v\d+$/i.test(normalized)) return normalized.replace(/\/v\d+$/i, "/api/image-tasks");
    return `${normalized}/api/image-tasks`;
  }
}

function waitForImageTaskPoll(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, IMAGE_TASK_POLL_INTERVAL_MS);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export async function refreshSubmittedImageTasks(
  taskRefs: SubmittedImageTaskRef[],
  config: { baseUrl: string; apiKey: string },
  callbacks: ImageTaskRefreshCallbacks = {},
  options?: ImageTaskRefreshOptions
): Promise<ImageTaskRefreshResult> {
  if (taskRefs.length === 0) return { remaining: [], ok: 0, fail: 0 };

  const totalN = options?.totalN ?? taskRefs.length;
  const pendingTaskIds = new Map(taskRefs.map((item) => [item.taskId, item.globalIndex] as const));
  const resp = await queryImageTasks([...pendingTaskIds.keys()], config);
  const remaining = new Map(pendingTaskIds);
  const settledSlots = options?.settledSlots ?? new Set<number>();
  let ok = 0;
  let fail = 0;

  for (const item of resp.items) {
    const taskG = pendingTaskIds.get(item.id);
    if (taskG === undefined) continue;
    const { startSlot, endSlot } = imageTaskSlotRange(taskG, totalN);

    const itemDeliveredSlots = new Set<number>();
    if (item.data?.length) {
      const slotImages = await extractImageTaskSlotImages(item.data);
      slotImages.forEach(({ relativeIndex, src }) => {
        const slot = startSlot + relativeIndex;
        if (slot >= startSlot && slot < endSlot) {
          itemDeliveredSlots.add(slot);
          if (!settledSlots.has(slot)) {
            settledSlots.add(slot);
            ok++;
            callbacks.onTaskResult?.(slot, [src]);
          }
        }
      });
    }

    if (item.status === "queued" || item.status === "running") {
      const text = item.progress || (item.status === "queued" ? "排队中" : "生成中");
      for (let slot = startSlot; slot < endSlot; slot++) {
        if (!itemDeliveredSlots.has(slot)) callbacks.onTaskProgress?.(slot, text);
      }
      continue;
    }

    remaining.delete(item.id);
    if (item.status === "success") {
      for (let slot = startSlot; slot < endSlot; slot++) {
        if (!itemDeliveredSlots.has(slot) && !settledSlots.has(slot)) {
          settledSlots.add(slot);
          fail++;
          const relativeIndex = slot - startSlot + 1;
          const fallback = item.data?.length ? "未收到该位置结果" : "生成成功但未返回图片";
          callbacks.onTaskError?.(slot, imageTaskSlotFailureMessage(item, relativeIndex, fallback));
        }
      }
    } else {
      const err = item.error || "生成失败";
      for (let slot = startSlot; slot < endSlot; slot++) {
        if (!itemDeliveredSlots.has(slot) && !settledSlots.has(slot)) {
          settledSlots.add(slot);
          fail++;
          callbacks.onTaskError?.(slot, err);
        }
      }
    }
  }

  for (const missingId of resp.missing_ids || []) {
    const taskG = pendingTaskIds.get(missingId);
    if (taskG === undefined) continue;
    remaining.delete(missingId);
    const { startSlot, endSlot } = imageTaskSlotRange(taskG, totalN);
    for (let slot = startSlot; slot < endSlot; slot++) {
      if (!settledSlots.has(slot)) {
        settledSlots.add(slot);
        fail++;
        callbacks.onTaskError?.(slot, "任务不存在或已被清理");
      }
    }
  }

  return {
    remaining: [...remaining].map(([taskId, globalIndex]) => ({ taskId, globalIndex })),
    ok,
    fail,
  };
}

export async function resumeSubmittedImageTasks(
  taskRefs: SubmittedImageTaskRef[],
  config: { baseUrl: string; apiKey: string },
  callbacks: ImageTaskRefreshCallbacks & {
    onAllDone?: (summary: { ok: number; fail: number }) => void;
  } = {},
  options?: { totalN: number },
  signalOptions?: { signal?: AbortSignal }
): Promise<void> {
  const totalN = options?.totalN ?? taskRefs.length;
  let pending = [...taskRefs];
  const queryFailureCounts = new Map<string, number>();
  const settledSlots = new Set<number>();
  let ok = 0;
  let fail = 0;

  while (pending.length > 0) {
    if (signalOptions?.signal?.aborted) return;

    try {
      const result = await refreshSubmittedImageTasks(pending, config, callbacks, { totalN, settledSlots });
      ok += result.ok;
      fail += result.fail;
      pending = result.remaining;
      for (const item of pending) queryFailureCounts.delete(item.taskId);
    } catch (e) {
      const queryError = String((e as Error).message || e || "查询任务状态失败");
      const stillPending: SubmittedImageTaskRef[] = [];
      for (const item of pending) {
        const failures = (queryFailureCounts.get(item.taskId) || 0) + 1;
        queryFailureCounts.set(item.taskId, failures);
        if (failures < IMAGE_TASK_QUERY_FAILURE_LIMIT) {
          stillPending.push(item);
          continue;
        }
        const { startSlot, endSlot } = imageTaskSlotRange(item.globalIndex, totalN);
        for (let slot = startSlot; slot < endSlot; slot++) {
          if (!settledSlots.has(slot)) {
            settledSlots.add(slot);
            fail++;
            callbacks.onTaskError?.(slot, `恢复查询失败：${queryError}`);
          }
        }
      }
      pending = stillPending;
    }

    if (pending.length > 0) {
      await waitForImageTaskPoll(signalOptions?.signal);
    }
  }

  callbacks.onAllDone?.({ ok, fail });
}

/**
 * 多图生图（任务模式）：把 n 张目标图拆为 ceil(n/MAX_N) 个后端任务并发提交，
 * 每个任务携带 n_per_task（≤MAX_N），参考图每任务只上传一次。任务返回的多图结果
 * 通过 slot 映射分发到 n 个 UI 占位（imageSlot 0-based）。clientTaskId 作为幂等键，
 * 支持断线后用相同 ID 查询恢复。
 */
async function generateImageMultiWithTaskApi(
  task: BatchTaskParams & { n: number },
  callbacks: MultiCallbacks,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const n = task.n;
  const taskCount = Math.max(1, Math.ceil(n / IMAGE_TASK_MAX_N_PER_TASK));
  const completedSlots = new Set<number>();
  let totalImageCount = 0; // 累计收到的有效图片数（落在 [0,n) 区间内）
  let extra = 0; // 超出 n 的额外图片数
  const imageTaskConfig = { baseUrl: task.baseUrl, apiKey: task.apiKey };

  callbacks.onTaskStart?.();
  callbacks.onAdapterResolved?.("task");

  // task globalIndex（1-based）→ image slot 区间 [startSlot, endSlot)（0-based）
  const slotRangeOf = (taskG: number): { startSlot: number; endSlot: number } => imageTaskSlotRange(taskG, n);

  // 任务到终态且失败：对该任务所有 slot 上报错误
  const emitTaskError = (globalIndex: number, err: string) => {
    const { startSlot, endSlot } = slotRangeOf(globalIndex);
    for (let slot = startSlot; slot < endSlot; slot++) {
      if (!completedSlots.has(slot)) {
        completedSlots.add(slot);
        callbacks.onTaskError?.(slot, err);
      }
    }
  };

  const emitTaskImages = async (globalIndex: number, data: ImageTaskData[] | unknown) => {
    const slotImages = await extractImageTaskSlotImages(data);
    const { startSlot, endSlot } = slotRangeOf(globalIndex);
    if (slotImages.length === 0) {
      return;
    }
    slotImages.forEach(({ relativeIndex, src }) => {
      const slot = startSlot + relativeIndex;
      if (slot < endSlot) {
        if (completedSlots.has(slot)) return;
        completedSlots.add(slot);
        totalImageCount++;
        callbacks.onTaskResult?.(slot, [src]);
      } else {
        extra++;
        callbacks.onExtraResult?.(src);
      }
    });
  };

  const emitMissingSlots = (globalIndex: number, message: string | ((relativeIndex: number) => string)) => {
    const { startSlot, endSlot } = slotRangeOf(globalIndex);
    for (let slot = startSlot; slot < endSlot; slot++) {
      if (!completedSlots.has(slot)) {
        completedSlots.add(slot);
        const relativeIndex = slot - startSlot + 1;
        callbacks.onTaskError?.(slot, typeof message === "function" ? message(relativeIndex) : message);
      }
    }
  };

  // 1. 拆分任务：每个任务承载 ≤ MAX_N 张图，参考图只随任务上传一次
  const batchTs = Date.now();
  const taskMeta: Array<{ globalIndex: number; n: number; clientTaskId: string }> = [];
  for (let i = 0; i < taskCount; i++) {
    const start = i * IMAGE_TASK_MAX_N_PER_TASK;
    const end = Math.min(start + IMAGE_TASK_MAX_N_PER_TASK, n);
    taskMeta.push({
      globalIndex: i + 1, // 1-based
      n: end - start,
      clientTaskId: `img-${batchTs}-${i + 1}`,
    });
  }

  // 图生图需要先把 base64 data URL 转 Blob（一次转换，多任务复用）
  let imageBlobs: { blob: Blob; filename: string }[] | undefined;
  if (task.images && task.images.length > 0) {
    imageBlobs = [];
    for (let i = 0; i < task.images.length; i++) {
      const dataUrl = task.images[i];
      const mimeMatch = dataUrl.match(/^data:(image\/[a-z+]+);/i);
      const mime = mimeMatch?.[1] || "image/png";
      const base64Data = dataUrl.split(",")[1] || dataUrl;
      const blob = await (await fetch(`data:${mime};base64,${base64Data}`)).blob();
      const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
      imageBlobs.push({ blob, filename: `reference-${i}.${ext}` });
    }
  }

  // 通知外部每个 task 的 clientTaskId（供 visibilitychange 断线恢复使用）
  for (const meta of taskMeta) {
    callbacks.onTaskSubmit?.(meta.globalIndex, meta.clientTaskId);
  }

  // 并发提交（allSettled，单个失败不影响其他）
  const submitResults = await Promise.allSettled(
    taskMeta.map(async (meta) => {
      try {
        if (imageBlobs && imageBlobs.length > 0) {
          return await submitImageEditTask(
            {
              clientTaskId: meta.clientTaskId,
              prompt: task.prompt,
              model: task.model,
              size: task.size,
              quality: task.quality,
              images: imageBlobs,
              n: meta.n,
            },
            imageTaskConfig
          );
        }
        return await submitImageGenerationTask(
          {
            clientTaskId: meta.clientTaskId,
            prompt: task.prompt,
            model: task.model,
            size: task.size,
            quality: task.quality,
            n: meta.n,
          },
          imageTaskConfig
        );
      } catch (e) {
        // 提交失败：可能是网络错误，但任务可能已在后端创建（幂等）
        // 不立即标记 error，留给轮询阶段用 clientTaskId 查询确认
        return { _submitError: String((e as Error).message), clientTaskId: meta.clientTaskId };
      }
    })
  );

  // 收集需要轮询的 clientTaskId（提交失败也加入，用查询确认）
  const pendingTaskIds = new Map<string, number>(); // clientTaskId -> globalIndex
  const submitErrors = new Map<string, string>();
  const queryFailureCounts = new Map<string, number>();
  for (let i = 0; i < submitResults.length; i++) {
    const meta = taskMeta[i];
    const result = submitResults[i];
    if (result.status === "fulfilled") {
      const value = result.value;
      if (value && typeof value === "object" && "_submitError" in value) {
        // 提交时出错，但仍尝试查询（幂等，可能后端已创建）
        submitErrors.set(meta.clientTaskId, String(value._submitError || "提交失败"));
        pendingTaskIds.set(meta.clientTaskId, meta.globalIndex);
      } else if (value && value.data) {
        // 提交即完成（极少数情况，幂等命中已成功任务）
        await emitTaskImages(meta.globalIndex, value.data);
        if (value.status === "success" || value.status === "error") {
          emitMissingSlots(
            meta.globalIndex,
            value.status === "success"
              ? (relativeIndex) =>
                  imageTaskSlotFailureMessage(value, relativeIndex, value.data?.length ? "未收到该位置结果" : "生成成功但未返回图片")
              : value.error || "生成失败"
          );
        } else {
          pendingTaskIds.set(meta.clientTaskId, meta.globalIndex);
        }
      } else {
        // queued 或 running，加入轮询
        pendingTaskIds.set(meta.clientTaskId, meta.globalIndex);
      }
    } else {
      // rejected（不应发生，submit 内部已 catch），仍尝试查询
      submitErrors.set(meta.clientTaskId, String((result.reason as Error)?.message || result.reason || "提交失败"));
      pendingTaskIds.set(meta.clientTaskId, meta.globalIndex);
    }
  }

  // 2. 轮询未完成任务
  while (pendingTaskIds.size > 0) {
    if (options?.signal?.aborted) return;

    await waitForImageTaskPoll(options?.signal);
    if (options?.signal?.aborted) return;

    let resp: ImageTaskQueryResponse;
    try {
      resp = await queryImageTasks([...pendingTaskIds.keys()], imageTaskConfig);
      for (const taskId of pendingTaskIds.keys()) {
        queryFailureCounts.delete(taskId);
      }
    } catch (e) {
      const queryError = String((e as Error).message || e || "查询任务状态失败");
      for (const [taskId, globalIndex] of [...pendingTaskIds]) {
        const failures = (queryFailureCounts.get(taskId) || 0) + 1;
        queryFailureCounts.set(taskId, failures);
        if (failures < IMAGE_TASK_QUERY_FAILURE_LIMIT) continue;

        pendingTaskIds.delete(taskId);
        const submitError = submitErrors.get(taskId);
        const message = submitError
          ? `提交失败，且无法查询任务状态：${queryError}`
          : `查询任务状态失败：${queryError}`;
        emitTaskError(globalIndex, message);
      }
      continue;
    }

    for (const item of resp.items) {
      const globalIndex = pendingTaskIds.get(item.id);
      if (globalIndex === undefined) continue;

      if (item.data?.length) {
        await emitTaskImages(globalIndex, item.data);
      }

      if (item.status === "queued" || item.status === "running") {
        const text = item.progress || (item.status === "queued" ? "排队中" : "生成中");
        const { startSlot, endSlot } = slotRangeOf(globalIndex);
        for (let slot = startSlot; slot < endSlot; slot++) {
          if (!completedSlots.has(slot)) callbacks.onTaskProgress?.(text, slot);
        }
        continue;
      }

      // 终态：success 或 error
      pendingTaskIds.delete(item.id);

      if (item.status === "success") {
        emitMissingSlots(globalIndex, (relativeIndex) =>
          imageTaskSlotFailureMessage(item, relativeIndex, item.data?.length ? "未收到该位置结果" : "生成成功但未返回图片")
        );
      } else {
        emitTaskError(globalIndex, item.error || "生成失败");
      }
    }

    // missing_ids：任务不存在或被清理
    for (const missingId of resp.missing_ids || []) {
      const globalIndex = pendingTaskIds.get(missingId);
      if (globalIndex !== undefined) {
        pendingTaskIds.delete(missingId);
        emitTaskError(globalIndex, "任务不存在或已被清理");
      }
    }
  }

  // 3. 兜底：标记未到终态的任务（每个 slot 上报错误）
  for (let g = 1; g <= taskCount; g++) {
    emitMissingSlots(g, "未收到结果");
  }

  // ok=有效图片数，fail=未收到图片的 slot 数；extra 为超出 n 的额外图片
  const ok = totalImageCount;
  const fail = n - totalImageCount;
  callbacks.onAllDone?.({ ok, fail, extra });
}

async function generateImageMultiDirect(
  task: BatchTaskParams & { n: number },
  callbacks: MultiCallbacks,
  options?: { signal?: AbortSignal }
): Promise<void> {
  callbacks.onTaskStart?.();
  callbacks.onAdapterResolved?.("direct");

  const received = new Set<number>();
  let extra = 0;
  let completed = false;

  const finishWithImages = (images: string[]) => {
    if (completed) return;
    completed = true;
    if (images.length === 0) {
      for (let i = 0; i < task.n; i++) callbacks.onTaskError?.(i, "生成成功但未返回图片");
      callbacks.onAllDone?.({ ok: 0, fail: task.n, extra: 0 });
      return;
    }

    images.forEach((src, index) => {
      if (index < task.n) {
        if (received.has(index + 1)) return;
        received.add(index + 1);
        callbacks.onTaskResult?.(index, [src]);
      } else {
        extra++;
        callbacks.onExtraResult?.(src);
      }
    });

    for (let i = 0; i < task.n; i++) {
      if (!received.has(i + 1)) callbacks.onTaskError?.(i, "未收到结果");
    }
    callbacks.onAllDone?.({ ok: received.size, fail: task.n - received.size, extra });
  };

  await generateImageRequest(
    task,
    {
      onProgress: (text) => callbacks.onTaskProgress?.(text),
      onResult: (index, images) => {
        if (completed) return;
        images.forEach((src, offset) => {
          const globalIndex = index + offset;
          if (globalIndex <= task.n) {
            received.add(globalIndex);
            callbacks.onTaskResult?.(globalIndex - 1, [src]);
          } else {
            extra++;
            callbacks.onExtraResult?.(src);
          }
        });
      },
      onComplete: finishWithImages,
      onError: (error) => {
        if (completed) return;
        completed = true;
        for (let i = 0; i < task.n; i++) {
          if (!received.has(i + 1)) callbacks.onTaskError?.(i, error);
        }
        callbacks.onAllDone?.({ ok: received.size, fail: task.n - received.size, extra });
      },
    },
    options
  );
}

/**
 * 统一生图入口：由调用方通过 task.adapter 显式指定模式，不再运行时探测。
 * - adapter === "task"    → chatgpt2api 增强任务接口，支持 client_task_id 断线恢复
 * - adapter === "direct"  → 标准 OpenAI-compatible /images/generations 或 /images/edits
 */
export async function submitBatchImageGeneration(
  task: BatchTaskParams & { n: number; adapter: ImageGenerationAdapterKind },
  callbacks: MultiCallbacks,
  options?: { signal?: AbortSignal }
): Promise<void> {
  if (task.adapter === "direct") return generateImageMultiDirect(task, callbacks, options);
  return generateImageMultiWithTaskApi(task, callbacks, options);
}

/** 兼容旧调用名，后续页面代码应优先使用 submitBatchImageGeneration。 */
export const generateImageMulti = submitBatchImageGeneration;

export const imageGenerationClient: ImageGenerationClient = {
  submitBatch: submitBatchImageGeneration,
  refreshTasks: refreshSubmittedImageTasks,
  resumeTasks: resumeSubmittedImageTasks,
};

/**
 * AI 润色提示词：调用 POST /v1/chat/completions，
 * 把 imagegen 提示词约束作为 system prompt，用户输入 + 画风片段作为 user message，
 * 返回 AI 生成的更高质量生图提示词。
 */
export async function polishPrompt(params: {
  baseUrl: string;
  apiKey: string;
  prompt: string;
  styleFragment?: string;
}): Promise<string> {
  const { baseUrl, apiKey, prompt, styleFragment } = params;
  const endpoint = resolveBaseUrl(baseUrl);

  // TODO P1: 模型名暂时硬编码 gpt-4o-mini，后续可在 Settings 中暴露 chatModel 配置项
  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: IMAGEGEN_SYSTEM_PROMPT },
      { role: "user", content: buildPolishUserMessage(prompt, styleFragment) },
    ],
    temperature: 0.7,
    stream: false,
  };

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(errText || `HTTP ${response.status}`);
  }

  const json = await response.json();
  const content: string | undefined = json?.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    throw new Error("AI 未返回有效内容");
  }
  return content.trim();
}

/* ---- 可编辑文件（PSD/PPT）任务 API ---- */

export type EditableFileKind = "psd" | "ppt";
export type EditableFileTaskStatus = "queued" | "running" | "success" | "error";

export interface EditableFileTaskResult {
  primary_url?: string;
  zip_url?: string;
  [key: string]: unknown;
}

export interface EditableFileTask {
  id: string;
  taskId?: string;
  status: EditableFileTaskStatus;
  kind: EditableFileKind;
  created_at: string;
  updated_at: string;
  result?: EditableFileTaskResult;
  error?: string;
  [key: string]: unknown;
}

export interface EditableFileTaskQueryResponse {
  items: EditableFileTask[];
  missing_ids?: string[];
  [key: string]: unknown;
}

export interface CreatePsdTaskParams {
  prompt: string;
  base64_images?: string[];
  client_task_id?: string;
}

/**
 * 创建 PSD 任务：POST /v1/psd/generations
 * 重复提交相同 client_task_id 会返回已有任务（幂等）。
 */
export async function createPsdTask(
  params: CreatePsdTaskParams,
  config: { baseUrl: string; apiKey: string }
): Promise<EditableFileTask> {
  const endpoint = resolveBaseUrl(config.baseUrl);
  const response = await fetch(`${endpoint}/psd/generations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
  return (await response.json()) as EditableFileTask;
}

/**
 * 查询可编辑文件任务状态：GET /v1/editable-file-tasks?ids=
 * 不传 ids 时返回当前用户全部任务。
 */
export async function queryEditableFileTasks(
  ids: string[] | undefined,
  config: { baseUrl: string; apiKey: string }
): Promise<EditableFileTaskQueryResponse> {
  const endpoint = resolveBaseUrl(config.baseUrl);
  const search = ids && ids.length ? `?ids=${ids.map(encodeURIComponent).join(",")}` : "";
  const response = await fetch(`${endpoint}/editable-file-tasks${search}`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
  return (await response.json()) as EditableFileTaskQueryResponse;
}

/**
 * 构造结果文件下载 URL：GET /files/{file_path}
 * - 若 file_path 已是完整 URL（http/https），直接返回。
 * - 若是 /files/... 相对路径，基于 baseUrl 的 origin 拼接。
 * - 否则按相对路径处理，附加到 baseUrl origin 上。
 */
export function buildEditableFileUrl(
  filePath: string,
  config: { baseUrl: string }
): string {
  if (!filePath) return "";
  if (/^https?:\/\//i.test(filePath)) return filePath;
  const origin = config.baseUrl.replace(/\/v\d+\/?$/, "");
  const trimmed = filePath.replace(/^\/+/, "");
  return `${origin}/${trimmed}`;
}

/**
 * 下载结果文件（pptx/psd/zip 二进制流），返回 Blob。
 */
export async function downloadEditableFile(
  filePath: string,
  config: { baseUrl: string; apiKey: string }
): Promise<Blob> {
  const url = buildEditableFileUrl(filePath, config);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `下载失败（HTTP ${response.status}）`);
  }
  return response.blob();
}

/* ---- 图片异步任务 API（/api/image-tasks/*） ---- */

export type ImageTaskStatus = "queued" | "running" | "success" | "error";

export interface ImageTaskData {
  url?: string;
  b64_json?: string;
  index?: number | string;
  [key: string]: unknown;
}

export interface ImageTask {
  id: string;
  status: ImageTaskStatus;
  mode: "generate" | "edit";
  model: string;
  size: string;
  quality: string;
  created_at: string;
  updated_at: string;
  data?: ImageTaskData[];
  error?: string;
  progress?: string;
  expected_count?: number;
  completed_count?: number;
  failed_indices?: Array<number | string>;
  elapsed_secs?: number;
  duration_ms?: number;
  conversation_id?: string;
  usage?: Record<string, unknown>;
}

export interface ImageTaskQueryResponse {
  items: ImageTask[];
  missing_ids: string[];
}

/** 提交文生图任务（幂等：相同 client_task_id 返回已有任务） */
export async function submitImageGenerationTask(
  params: {
    clientTaskId: string;
    prompt: string;
    model: string;
    size?: string;
    quality?: string;
    n?: number;
  },
  config: { baseUrl: string; apiKey: string }
): Promise<ImageTask> {
  const endpoint = resolveImageTaskApiBaseUrl(config.baseUrl);
  const response = await fetch(`${endpoint}/generations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      client_task_id: params.clientTaskId,
      prompt: params.prompt,
      model: params.model,
      size: params.size ?? null,
      quality: params.quality ?? "auto",
      n: params.n ?? 1,
    }),
  });
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
  return (await response.json()) as ImageTask;
}

/** 提交图生图任务（multipart/form-data，幂等） */
export async function submitImageEditTask(
  params: {
    clientTaskId: string;
    prompt: string;
    model: string;
    size?: string;
    quality?: string;
    n?: number;
    images: { blob: Blob; filename: string }[];
  },
  config: { baseUrl: string; apiKey: string }
): Promise<ImageTask> {
  const endpoint = resolveImageTaskApiBaseUrl(config.baseUrl);
  const formData = new FormData();
  formData.append("client_task_id", params.clientTaskId);
  formData.append("prompt", params.prompt);
  formData.append("model", params.model);
  formData.append("size", params.size ?? "");
  formData.append("quality", params.quality ?? "auto");
  formData.append("n", String(params.n ?? 1));
  for (const img of params.images) {
    formData.append("image", img.blob, img.filename);
  }
  const response = await fetch(`${endpoint}/edits`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}` },
    body: formData,
  });
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
  return (await response.json()) as ImageTask;
}

/** 批量查询任务状态 */
export async function queryImageTasks(
  ids: string[],
  config: { baseUrl: string; apiKey: string }
): Promise<ImageTaskQueryResponse> {
  const endpoint = resolveImageTaskApiBaseUrl(config.baseUrl);
  const search = ids.length ? `?ids=${ids.map(encodeURIComponent).join(",")}` : "";
  const response = await fetch(`${endpoint}${search}`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
  return (await response.json()) as ImageTaskQueryResponse;
}
