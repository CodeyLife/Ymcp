/** 图像/画布共享工具函数，迁移自 src/ymcp/web/v2f_static.py 的纯前端逻辑 */

import { applyChromaKey } from "@/lib/chromaKey";

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("canvas 导出失败"))),
      "image/png"
    )
  );
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

export async function downloadCanvas(canvasId: string, filename: string) {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!canvas || !canvas.width || !canvas.height) return;
  downloadBlob(await canvasToBlob(canvas), filename);
}

export function hexToRgb(value: string): [number, number, number] {
  const raw = String(value || "#00ff00").replace("#", "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw.padEnd(6, "0").slice(0, 6);
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
}

export function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** 颜色键抠像，修改 canvas 的 alpha 通道。委托 chromaKey.ts 的改进算法 */
export function applyCanvasKey(
  canvas: HTMLCanvasElement,
  key: string,
  tolerance: number,
  feather: number
) {
  if (!key) return;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const soft = Math.max(1, feather);
  applyChromaKey(imageData, {
    key: hexToRgb(key) as [number, number, number],
    tolerance,
    transparentThreshold: tolerance,
    opaqueThreshold: tolerance + soft,
    softMatte: true,
    spillCleanup: false,
  });
  ctx.putImageData(imageData, 0, 0);
}

export function loadImageFromFile(
  file: File
): Promise<{ image: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = url;
  });
}

export function loadImagesFromFiles(
  files: File[]
): Promise<{ file: File; image: HTMLImageElement; url: string }[]> {
  return Promise.all(
    files.map(async (file) => {
      const { image, url } = await loadImageFromFile(file);
      return { file, image, url };
    })
  );
}

/** 视频 seek 到指定时间，返回 Promise */
export function seekVideo(
  video: HTMLVideoElement,
  time: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", fail);
      resolve();
    };
    const fail = () => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", fail);
      reject(new Error("视频 seek 失败"));
    };
    video.addEventListener("seeked", done, { once: true });
    video.addEventListener("error", fail, { once: true });
    if (Math.abs(video.currentTime - time) < 0.004) setTimeout(done, 0);
    else video.currentTime = time;
  });
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return "--:--";
  const whole = Math.max(0, Math.round(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h ? `${h}:${mmss}` : mmss;
}

/* ===== 极简 ZIP 打包（STORE 模式，无压缩） ===== */

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Uint8Array {
  return new Uint8Array([value & 255, (value >>> 8) & 255]);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([
    value & 255,
    (value >>> 8) & 255,
    (value >>> 16) & 255,
    (value >>> 24) & 255,
  ]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export async function makeZip(
  files: { name: string; blob: Blob }[]
): Promise<Blob> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const crc = crc32(data);
    const local = concatBytes([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(name.length), u16(0), name, data,
    ]);
    locals.push(local);
    const central = concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = concatBytes([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralSize), u32(offset), u16(0),
  ]);
  return new Blob([...locals, ...centrals, end] as BlobPart[], { type: "application/zip" });
}

export interface FrameItem {
  name: string;
  blob: Blob;
  canvas: HTMLCanvasElement;
}
