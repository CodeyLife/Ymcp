/**
 * 参考图压缩模块 - 用于图生图上传前优化
 *
 * 策略：像素为主 + 文件大小触发
 *   1. file.size <= sizeThreshold 且为高压缩格式(jpeg/webp) → 跳过压缩
 *   2. 否则解码读 naturalWidth/Height，长边 > maxLongEdge 触发 resize
 *   3. 检测 alpha 通道：有透明→PNG，无透明→JPEG(0.85)
 *   4. 体积兜底：压缩后更大且未 resize → 保留原文件
 *
 * 全程使用浏览器原生 Canvas API，零依赖。
 */

export interface CompressOptions {
  /** 最大长边像素，默认 1536 */
  maxLongEdge?: number;
  /** 文件大小触发阈值（字节），小于此值且为高压缩格式则跳过，默认 1MB */
  sizeThreshold?: number;
  /** JPEG 导出质量 0-1，默认 0.85 */
  jpegQuality?: number;
}

export interface CompressResult {
  /** 最终使用的 Blob（可能为原文件或压缩后的） */
  blob: Blob;
  /** blob: URL，调用方负责在替换时 revoke */
  url: string;
  width: number;
  height: number;
  /** 实际输出的 MIME：image/png | image/jpeg */
  mime: string;
  originalSize: number;
  compressedSize: number;
  /** 是否跳过了压缩（直接使用原文件） */
  skipped: boolean;
}

const DEFAULTS: Required<CompressOptions> = {
  maxLongEdge: 1536,
  sizeThreshold: 1024 * 1024,
  jpegQuality: 0.85,
};

const ALLOWED_MIME = /^image\/(png|jpeg|webp)$/i;
const HIGH_COMP_MIME = /^image\/(jpeg|webp)$/i;

/** File → HTMLImageElement，返回图像与 blob URL（用于自然尺寸读取） */
function loadImage(file: File): Promise<{ image: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片解码失败"));
    };
    image.src = url;
  });
}

/** canvas → blob，按 MIME 与质量导出 */
function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("canvas 导出失败"))),
      mime,
      mime === "image/png" ? undefined : quality
    );
  });
}

/**
 * 检测 canvas 是否含透明像素。采用抽样以避免全图遍历。
 * 每 16 个像素采样一次（步长 4 像素 × 4 通道），覆盖足够区域。
 */
function detectAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  try {
    // 抽样：横向每 4 像素、纵向每 4 像素取一个
    const stepX = Math.max(1, Math.floor(w / 256));
    const stepY = Math.max(1, Math.floor(h / 256));
    for (let y = 0; y < h; y += stepY) {
      for (let x = 0; x < w; x += stepX) {
        const { data } = ctx.getImageData(x, y, 1, 1);
        if (data[3] < 255) return true;
      }
    }
    return false;
  } catch {
    // 跨域或异常时保守按 PNG 处理
    return true;
  }
}

export async function compressImage(
  file: File,
  options?: CompressOptions
): Promise<CompressResult> {
  const opts = { ...DEFAULTS, ...options };
  const originalSize = file.size;

  // 1. MIME 校验
  if (!ALLOWED_MIME.test(file.type)) {
    throw new Error(`不支持的图片格式：${file.type || "未知"}`);
  }

  // 2. 触发检查：小文件且为高压缩格式 → 跳过
  const isHighComp = HIGH_COMP_MIME.test(file.type);
  if (originalSize <= opts.sizeThreshold && isHighComp) {
    const { image, url } = await loadImage(file);
    const result: CompressResult = {
      blob: file,
      url,
      width: image.naturalWidth,
      height: image.naturalHeight,
      mime: file.type,
      originalSize,
      compressedSize: originalSize,
      skipped: true,
    };
    // 注意：image.src 用的就是 url，不释放（调用方持有 url）
    return result;
  }

  // 3. 解码图片读尺寸
  const { image, url: srcUrl } = await loadImage(file);
  try {
    let w = image.naturalWidth;
    let h = image.naturalHeight;
    if (!w || !h) throw new Error("无法读取图片尺寸");

    // 4. Resize：长边不超过 maxLongEdge
    const longest = Math.max(w, h);
    const needResize = longest > opts.maxLongEdge;
    if (needResize) {
      const scale = opts.maxLongEdge / longest;
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
    }

    // 5. 绘制到 canvas
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 上下文不可用");
    ctx.drawImage(image, 0, 0, w, h);

    // 6. 智能格式选择：检测 alpha 通道
    const hasAlpha = detectAlpha(ctx, w, h);
    const outMime = hasAlpha ? "image/png" : "image/jpeg";

    // 7. 导出 blob
    const blob = await canvasToBlob(canvas, outMime, opts.jpegQuality);

    // 8. 体积兜底：压缩后更大且未 resize → 用原文件
    let finalBlob = blob;
    let skipped = false;
    if (!needResize && blob.size >= originalSize) {
      finalBlob = file;
      skipped = true;
    }

    const resultUrl = URL.createObjectURL(finalBlob);
    return {
      blob: finalBlob,
      url: resultUrl,
      width: w,
      height: h,
      mime: skipped ? file.type : outMime,
      originalSize,
      compressedSize: finalBlob.size,
      skipped,
    };
  } finally {
    URL.revokeObjectURL(srcUrl);
  }
}
