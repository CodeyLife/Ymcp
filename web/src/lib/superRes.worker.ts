/// <reference lib="webworker" />
/// <reference types="vite/client" />
/**
 * 超分推理 Worker
 *
 * 在 DedicatedWorker 中运行 ONNX Runtime Web，避免推理阻塞主线程。
 * - 优先使用 WebGPU（Chrome 113+），不支持时回退 WASM
 * - 采用 tile-based 分块推理，支持任意尺寸输入
 * - alpha 通道单独用最近邻 4x 放大后拼回
 */

import * as ort from "onnxruntime-web/webgpu";

// 从 CDN 加载 wasm 文件（jsdelivr 在国内通常可访问）
ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";

let session: ort.InferenceSession | null = null;
let activeBackend: "webgpu" | "wasm" | null = null;

// ===== 消息类型 =====
type Req =
  | { type: "init"; modelBuffer: ArrayBuffer }
  | { type: "upscale"; imageData: ImageData; requestId: number };

type Res =
  | { type: "inited"; backend: "webgpu" | "wasm" }
  | { type: "progress"; requestId: number; progress: number }
  | { type: "result"; requestId: number; imageData: ImageData }
  | { type: "error"; requestId?: number; message: string };

function post(data: Res) {
  (self as unknown as Worker).postMessage(data);
}

// ===== 会话初始化 =====
async function initSession(modelBuffer: ArrayBuffer): Promise<"webgpu" | "wasm"> {
  // 优先尝试纯 WebGPU，失败则回退纯 WASM
  // 分别尝试单一后端，使 activeBackend 可确定追踪
  const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;

  if (hasWebGPU) {
    try {
      session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
      });
      activeBackend = "webgpu";
    } catch {
      // WebGPU 初始化失败，回退 WASM
      session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      activeBackend = "wasm";
    }
  } else {
    session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    activeBackend = "wasm";
  }
  return activeBackend;
}

// ===== 超分常量 =====
const SCALE = 4;
// tile 大小需被 SCALE 整除。
// 完整版 RRDBNet（23 blocks）感受野约 200px，tile=256 可容纳完整感受野，
// 避免边缘伪影；256/4=64 可被 SCALE 整除。
const TILE = 256;
// 重叠像素，需 ≥ 感受野半径才能完全消除接缝。
// 32 是质量与速度的折中（完整版推荐 64，但 32 已基本无可见接缝）。
const OVERLAP = 32;
const STRIDE = TILE - OVERLAP; // 224

/**
 * 从源 ImageData 提取 RGB float32 tensor 数据（NCHW，0-1 归一化）
 * 同时返回 alpha 通道用于后续处理
 */
function extractTileRGB(
  src: Uint8ClampedArray,
  srcW: number,
  x0: number,
  y0: number,
  tw: number,
  th: number,
): Float32Array {
  const out = new Float32Array(3 * tw * th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const srcIdx = ((y0 + y) * srcW + (x0 + x)) * 4;
      const dstIdx = y * tw + x;
      out[dstIdx] = src[srcIdx] / 255; // R
      out[tw * th + dstIdx] = src[srcIdx + 1] / 255; // G
      out[2 * tw * th + dstIdx] = src[srcIdx + 2] / 255; // B
    }
  }
  return out;
}

/**
 * 将模型输出的 RGB float32 tensor 写回到 RGBA Uint8ClampedArray
 * 只写回 tile 对应的非重叠区域，避免接缝
 */
function writeTileBack(
  dst: Uint8ClampedArray,
  dstW: number,
  outData: Float32Array,
  tileW: number,
  tileH: number,
  x0: number,
  y0: number,
  col: number,
  row: number,
  totalCols: number,
  totalRows: number,
): void {
  // 计算本次 tile 在输出图中需要写入的区域（去掉重叠部分）
  const dstX0 = x0 * SCALE;
  const dstY0 = y0 * SCALE;

  // 源 tile 内的起止偏移（跳过重叠区域）
  let srcOffsetX = 0;
  let srcOffsetY = 0;
  let writeW = tileW * SCALE;
  let writeH = tileH * SCALE;

  // 非首列：跳过左侧 overlap/2
  if (col > 0) {
    srcOffsetX = Math.round(OVERLAP / 2 * SCALE);
    writeW -= srcOffsetX;
  }
  // 非末列：右侧少写 overlap/2
  if (col < totalCols - 1) {
    writeW -= Math.round(OVERLAP / 2 * SCALE);
  }
  // 非首行
  if (row > 0) {
    srcOffsetY = Math.round(OVERLAP / 2 * SCALE);
    writeH -= srcOffsetY;
  }
  // 非末行
  if (row < totalRows - 1) {
    writeH -= Math.round(OVERLAP / 2 * SCALE);
  }

  const outTileW = tileW * SCALE;

  for (let y = 0; y < writeH; y++) {
    for (let x = 0; x < writeW; x++) {
      const srcTileX = srcOffsetX + x;
      const srcTileY = srcOffsetY + y;
      const srcIdx = srcTileY * outTileW + srcTileX;
      const dstIdx = ((dstY0 + srcOffsetY + y) * dstW + (dstX0 + srcOffsetX + x)) * 4;
      // clamp 0-255
      const r = outData[srcIdx];
      const g = outData[outTileW * tileH * SCALE + srcIdx];
      const b = outData[2 * outTileW * tileH * SCALE + srcIdx];
      dst[dstIdx] = Math.max(0, Math.min(255, r * 255));
      dst[dstIdx + 1] = Math.max(0, Math.min(255, g * 255));
      dst[dstIdx + 2] = Math.max(0, Math.min(255, b * 255));
      // alpha 由单独的最近邻放大填充
    }
  }
}

/**
 * 最近邻 4x 放大 alpha 通道
 * 在 Worker 中无 canvas，用纯 JS 实现
 */
function upscaleAlphaNearest(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dst: Uint8ClampedArray,
  dstW: number,
): void {
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const srcAlpha = src[(y * srcW + x) * 4 + 3];
      // 写入 4x4 块
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const dstX = x * SCALE + dx;
          const dstY = y * SCALE + dy;
          dst[(dstY * dstW + dstX) * 4 + 3] = srcAlpha;
        }
      }
    }
  }
}

/**
 * 执行超分推理
 */
async function upscale(
  imageData: ImageData,
  onProgress: (p: number) => void,
): Promise<ImageData> {
  if (!session) throw new Error("模型未初始化");

  const { width: W, height: H, data } = imageData;
  const outW = W * SCALE;
  const outH = H * SCALE;
  const out = new Uint8ClampedArray(outW * outH * 4);

  // 先填充 alpha 通道（最近邻放大）
  upscaleAlphaNearest(data, W, H, out, outW);

  // 计算 tile 网格
  const cols = Math.max(1, Math.ceil((W - OVERLAP) / STRIDE));
  const rows = Math.max(1, Math.ceil((H - OVERLAP) / STRIDE));
  const total = cols * rows;
  let done = 0;

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // tile 在源图中的左上角坐标
      let x0 = col * STRIDE;
      let y0 = row * STRIDE;
      // 边界修正：确保 tile 不超出源图
      x0 = Math.min(x0, W - TILE);
      y0 = Math.min(y0, H - TILE);
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;

      // 实际 tile 宽高（边界可能不足 TILE）
      const tw = Math.min(TILE, W - x0);
      const th = Math.min(TILE, H - y0);

      // 提取 RGB tile
      const rgbData = extractTileRGB(data, W, x0, y0, tw, th);
      const tensor = new ort.Tensor("float32", rgbData, [1, 3, th, tw]);

      // 推理
      const outputs = await session.run({ [inputName]: tensor });
      const outTensor = outputs[outputName];
      const outData = outTensor.data as Float32Array;

      // 写回到输出缓冲区
      writeTileBack(out, outW, outData, tw, th, x0, y0, col, row, cols, rows);

      done++;
      onProgress(done / total);
    }
  }

  return new ImageData(out, outW, outH);
}

// ===== 消息处理 =====
(self as unknown as Worker).onmessage = async (e: MessageEvent<Req>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      const backend = await initSession(msg.modelBuffer);
      post({ type: "inited", backend });
    } else if (msg.type === "upscale") {
      const result = await upscale(msg.imageData, (p) => {
        post({ type: "progress", requestId: msg.requestId, progress: p });
      });
      post({ type: "result", requestId: msg.requestId, imageData: result });
    }
  } catch (err) {
    post({
      type: "error",
      requestId: msg.type === "upscale" ? msg.requestId : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
