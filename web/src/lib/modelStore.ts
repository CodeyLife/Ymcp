import { get, set, createStore } from "idb-keyval";

/**
 * 超分模型缓存层
 *
 * 首次使用时从 CDN 下载 ONNX 模型，缓存到 IndexedDB。
 * 后续访问直接从本地读取，秒级就绪。
 * 支持多源 fallback，适配国内网络环境。
 */

const modelStore = createStore("ymcp-model-db", "models");

const MODEL_KEY = "realesrgan-x4plus";
const MODEL_VERSION_KEY = "realesrgan-x4plus-version";
// 模型升级时递增版本号以触发重新下载
const MODEL_VERSION = "2";

/**
 * 模型下载源（按优先级排列）
 *
 * 使用完整版 Real-ESRGAN x4plus（RRDBNet, 23 blocks, 64 features, ~64MB）：
 * - 来自 SceneWorks/real-esrgan-onnx，HuggingFace 上可用的完整版 ONNX 转换
 * - 质量远超轻量蒸馏版（4B32F），适合 4K 超分质量优先场景
 *
 * hf-mirror.com 是 HuggingFace 的国内镜像，优先使用以保证国内可访问性。
 */
const MODEL_SOURCES: string[] = [
  "https://hf-mirror.com/SceneWorks/real-esrgan-onnx/resolve/main/real_esrgan_x4.onnx",
  "https://huggingface.co/SceneWorks/real-esrgan-onnx/resolve/main/real_esrgan_x4.onnx",
];

/** 模型信息 */
export const MODEL_INFO = {
  name: "Real-ESRGAN x4plus (完整版)",
  scale: 4,
  sources: MODEL_SOURCES,
};

/**
 * 获取模型 ArrayBuffer（优先从 IndexedDB 缓存读取，否则从 CDN 下载）
 * @param onProgress 下载进度回调 (loaded, total)
 */
export async function getModelArrayBuffer(
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  // 1. 检查 IndexedDB 缓存 + 版本匹配
  const cachedVersion = await get(MODEL_VERSION_KEY, modelStore);
  if (cachedVersion === MODEL_VERSION) {
    const cached = await get<ArrayBuffer>(MODEL_KEY, modelStore);
    if (cached && cached.byteLength > 0) return cached;
  }

  // 2. 从 CDN 下载（依次尝试多个源）
  let lastError: Error | null = null;
  for (const url of MODEL_SOURCES) {
    try {
      const buffer = await downloadWithProgress(url, onProgress);
      // 3. 写入缓存
      await set(MODEL_KEY, buffer, modelStore);
      await set(MODEL_VERSION_KEY, MODEL_VERSION, modelStore);
      return buffer;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      // 继续尝试下一个源
    }
  }
  throw lastError ?? new Error("所有模型下载源均失败");
}

/** 带进度回调的下载 */
async function downloadWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载失败: HTTP ${resp.status}`);

  const total = Number(resp.headers.get("content-length")) || 0;
  const reader = resp.body?.getReader();
  if (!reader) {
    // 不支持流式读取，直接用 arrayBuffer
    return await resp.arrayBuffer();
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (onProgress && total > 0) onProgress(loaded, total);
  }

  // 合并 chunks
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged.buffer;
}

/** 检查模型是否已缓存，返回缓存大小（字节）或 null */
export async function getCachedModelSize(): Promise<number | null> {
  const v = await get(MODEL_VERSION_KEY, modelStore);
  if (v !== MODEL_VERSION) return null;
  const cached = await get<ArrayBuffer>(MODEL_KEY, modelStore);
  return cached ? cached.byteLength : null;
}

/** 清除模型缓存（用于强制重新下载） */
export async function clearModelCache(): Promise<void> {
  await set(MODEL_KEY, undefined, modelStore);
  await set(MODEL_VERSION_KEY, undefined, modelStore);
}
