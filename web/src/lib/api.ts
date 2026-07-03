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
    const message =
      error?.response?.data?.detail ||
      error?.response?.data?.error ||
      error?.message ||
      "请求失败";
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

/** 从 base64 创建 blob URL */
export function base64ToBlobUrl(b64: string, mime = "image/png"): string {
  const byteChars = atob(b64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: mime });
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

export interface StreamCallbacks {
  /** 后端进度文本（image.generation.chunk.progress_text） */
  onProgress?: (text: string) => void;
  /** 单张图完成（image.generation.result），index 为 1-based */
  onResult?: (index: number, images: string[]) => void;
  /** 全部完成（流式末尾或非流式兜底），images 为全部图片 */
  onComplete?: (images: string[]) => void;
  onError?: (error: string) => void;
}

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

async function extractImageSources(
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

/** 流式生图 - 通过 SSE 接收中间帧和最终结果 */
export async function generateImageStream(
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
  callbacks: StreamCallbacks,
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
      formData.append("stream", "true");
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
        stream: true,
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

    // 检查是否是流式响应
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream") && !contentType.includes("application/x-ndjson")) {
      // 非流式响应，直接解析 JSON
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

    // 解析 SSE / NDJSON 流
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
    // 流式失败时回退到非流式
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
  onTaskProgress?: (text: string) => void;
  /** taskIndex 0-based；单张图完成 */
  onTaskResult?: (taskIndex: number, images: string[]) => void;
  onExtraResult?: (src: string) => void;
  onTaskError?: (taskIndex: number, error: string) => void;
  onAllDone?: (summary: { ok: number; fail: number; extra: number }) => void;
}

const MAX_IMAGES_PER_REQUEST = 4;

/**
 * 多图生图：后端单请求最多 4 张；更大的批次会拆成多个 n<=4 请求并发提交。
 * 通过 onResult 回调按完成顺序渐进式返回每张图，前端负责把子请求下标映射回全局任务。
 */
export async function generateImageMulti(
  task: BatchTaskParams & { n: number },
  callbacks: MultiCallbacks,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const n = task.n;
  const received = new Set<number>(); // 已通过 onResult 收到的全局 1-based index
  const failed = new Set<number>(); // 已上报真实错误的全局 1-based index
  let extra = 0;

  callbacks.onTaskStart?.();

  const runChunk = async (offset: number, count: number) => {
    const localReceived = new Set<number>(); // 子请求 1-based index
    const toGlobalIndex = (localIndex: number) => offset + localIndex;

    const markReceived = (localIndex: number, images: string[]) => {
      images.forEach((src, i) => {
        const mappedLocalIndex = localIndex + i;
        const globalIndex = toGlobalIndex(mappedLocalIndex);
        if (globalIndex <= n) {
          localReceived.add(mappedLocalIndex);
          received.add(globalIndex);
          callbacks.onTaskResult?.(globalIndex - 1, [src]);
          return;
        }
        extra += 1;
        callbacks.onExtraResult?.(src);
      });
    };

    const markMissingAsError = (error: string) => {
      for (let localIndex = 1; localIndex <= count; localIndex++) {
        const globalIndex = toGlobalIndex(localIndex);
        if (!localReceived.has(localIndex) && !received.has(globalIndex) && !failed.has(globalIndex)) {
          failed.add(globalIndex);
          callbacks.onTaskError?.(globalIndex - 1, error);
        }
      }
    };

    await generateImageStream(
      { ...task, n: count },
      {
        onProgress: (text) => callbacks.onTaskProgress?.(text),
        onResult: (index, images) => {
          markReceived(index, images);
        },
        onComplete: (images) => {
          // 非流式兜底：若这个子请求未收到任何 onResult，按顺序把图片分配给对应全局 task
          if (localReceived.size === 0 && images.length > 0) {
            markReceived(1, images);
          }
        },
        onError: (err) => {
          markMissingAsError(err);
        },
      },
      options
    );

    markMissingAsError("未收到结果");
  };

  const chunks: Array<{ offset: number; count: number }> = [];
  for (let offset = 0; offset < n; offset += MAX_IMAGES_PER_REQUEST) {
    chunks.push({ offset, count: Math.min(MAX_IMAGES_PER_REQUEST, n - offset) });
  }

  await Promise.allSettled(chunks.map((chunk) => runChunk(chunk.offset, chunk.count)));

  // 标记未收到 result 的 task 为 error（后端部分失败容错后缺失的张）
  for (let i = 0; i < n; i++) {
    const resultIndex = i + 1;
    if (!received.has(resultIndex) && !failed.has(resultIndex)) {
      failed.add(resultIndex);
      callbacks.onTaskError?.(i, "未收到结果");
    }
  }

  const ok = received.size;
  const fail = n - ok;
  callbacks.onAllDone?.({ ok, fail, extra });
}

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
