import axios from "axios";
import {
  IMAGEGEN_SYSTEM_PROMPT,
  buildPolishUserMessage,
} from "@/lib/imagegenPresets";

export const api = axios.create({
  baseURL: "/api",
  timeout: 120_000,
  headers: { "content-type": "application/json" },
});

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
  const response = await fetch(safeUrl);
  const blob = await response.blob();
  return URL.createObjectURL(blob);
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
  onPartial?: (imageSrc: string, index: number) => void;
  onComplete?: (images: string[]) => void;
  onError?: (error: string) => void;
}

function resolveBaseUrl(baseUrl: string): string {
  const isDefault = baseUrl === "https://image.yujin8.top/v1";
  // 仅开发环境用 Vite proxy (/ai-proxy) 绕过 CORS；生产环境直连原始 URL
  if (isDefault && import.meta.env.DEV) return "/ai-proxy";
  return baseUrl;
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
    image?: string; // base64 for img2img
  },
  callbacks: StreamCallbacks
): Promise<void> {
  const { baseUrl, apiKey, ...body } = data;
  const endpoint = resolveBaseUrl(baseUrl);
  const isImg2Img = !!body.image;

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
      if (body.quality) formData.append("quality", body.quality);
      // image 是 data URL (data:image/png;base64,...)，转为 Blob
      const base64Data = body.image!.split(",")[1] || body.image!;
      const imageBlob = await (await fetch(`data:image/png;base64,${base64Data}`)).blob();
      formData.append("image", imageBlob, "reference.png");

      response = await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: formData,
      });
    } else {
      // /images/generations 用 JSON
      const requestBody: Record<string, unknown> = {
        model: body.model,
        prompt: body.prompt,
        n: body.n,
        size: body.size,
        quality: body.quality,
      };
      if (body.style) requestBody.style = body.style;

      response = await fetch(`${endpoint}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText || `HTTP ${response.status}`);
    }

    // 检查是否是 SSE 流
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream") && !contentType.includes("application/x-ndjson")) {
      // 非流式响应，直接解析 JSON
      const json = await response.json();
      const images: string[] = [];
      for (const item of json.data || []) {
        const src = item.url
          ? await cacheImageLocally(item.url)
          : item.b64_json
          ? base64ToBlobUrl(item.b64_json)
          : "";
        if (src) images.push(src);
      }
      callbacks.onComplete?.(images);
      return;
    }

    // 解析 SSE 流
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const finalImages: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 按 SSE 事件分隔
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") continue;

        try {
          const event = JSON.parse(dataStr);
          // OpenAI SSE 事件类型
          if (event.type === "image_edit.partial_image" || event.type === "image.partial") {
            const src = event.url
              ? await cacheImageLocally(event.url)
              : event.b64_json
              ? base64ToBlobUrl(event.b64_json)
              : "";
            if (src) callbacks.onPartial?.(src, event.partial_index ?? 0);
          } else if (event.type === "image_edit.completed" || event.type === "image.completed") {
            const src = event.url
              ? await cacheImageLocally(event.url)
              : event.b64_json
              ? base64ToBlobUrl(event.b64_json)
              : "";
            if (src) finalImages.push(src);
          } else if (event.type === "error") {
            throw new Error(event.message || event.error || "生成失败");
          } else if (event.data) {
            // 兼容其他格式
            const inner = event.data;
            if (inner.url || inner.b64_json) {
              const src = inner.url
                ? await cacheImageLocally(inner.url)
                : base64ToBlobUrl(inner.b64_json);
              if (event.type?.includes("partial")) {
                callbacks.onPartial?.(src, 0);
              } else {
                finalImages.push(src);
              }
            }
          }
        } catch {
          // 忽略单行解析错误
        }
      }
    }

    if (finalImages.length === 0) {
      // 没有收到完成事件，可能整个响应就是最终结果
      try {
        const json = JSON.parse(buffer);
        for (const item of json.data || []) {
          const src = item.url
            ? await cacheImageLocally(item.url)
            : item.b64_json
            ? base64ToBlobUrl(item.b64_json)
            : "";
          if (src) finalImages.push(src);
        }
      } catch {
        // 忽略
      }
    }

    callbacks.onComplete?.(finalImages);
  } catch (e) {
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
  image?: string;
}

export interface BatchCallbacks {
  onTaskStart?: (index: number) => void;
  onTaskPartial?: (index: number, imageSrc: string) => void;
  onTaskComplete?: (index: number, images: string[]) => void;
  onTaskError?: (index: number, error: string) => void;
  onAllDone?: (summary: { index: number; images?: string[]; error?: string }[]) => void;
}

/**
 * 批量生图：把 N 张拆成 N 个 n=1 并行请求，并发池控制。
 * 每个任务独立 onPartial/onComplete/onError，单任务失败不影响其他。
 */
export async function generateImageBatch(
  tasks: BatchTaskParams[],
  callbacks: BatchCallbacks,
  options?: { concurrency?: number; signal?: AbortSignal }
): Promise<void> {
  const total = tasks.length;
  const concurrency = Math.max(1, Math.min(options?.concurrency ?? 3, total || 1));
  const summary: { index: number; images?: string[]; error?: string }[] = new Array(total);
  let cursor = 0;
  let active = 0;
  let resolved = 0;

  await new Promise<void>((resolveAll) => {
    const scheduleNext = () => {
      if (options?.signal?.aborted) {
        resolveAll();
        return;
      }
      while (active < concurrency && cursor < total) {
        const idx = cursor++;
        active++;
        callbacks.onTaskStart?.(idx);

        generateImageStream(
          { ...tasks[idx], n: 1 },
          {
            onPartial: (src) => callbacks.onTaskPartial?.(idx, src),
            onComplete: (images) => {
              // 透传整个 images 数组，支持单任务返回多张
              if (images.length > 0) {
                summary[idx] = { index: idx, images };
                callbacks.onTaskComplete?.(idx, images);
              } else {
                summary[idx] = { index: idx, error: "未收到结果" };
                callbacks.onTaskError?.(idx, "未收到结果");
              }
            },
            onError: (err) => {
              summary[idx] = { index: idx, error: err };
              callbacks.onTaskError?.(idx, err);
            },
          }
        ).finally(() => {
          active--;
          resolved++;
          if (resolved === total) {
            callbacks.onAllDone?.(summary.filter(Boolean));
            resolveAll();
          } else {
            scheduleNext();
          }
        });
      }
    };
    scheduleNext();
  });
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
