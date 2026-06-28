/**
 * 色键抠图算法，忠实移植自
 * C:\Users\admin\.codex\skills\.system\imagegen\scripts\remove_chroma_key.py
 *
 * 核心差异（相较旧实现的修正）：
 * - 使用 max-channel 距离而非欧氏距离，对纯色键更准确
 * - dominance alpha：处理抗锯齿/半透明边缘，避免硬边
 * - smoothstep 软遮罩：边缘过渡更自然
 * - spill cleanup：去除键色溢出（绿幕边缘发绿）
 * - alpha 按原始 alpha 缩放（output * origAlpha/255）而非简单封顶
 * - ALPHA_NOISE_FLOOR 噪声底，清理残留半透明噪点
 */

export type RGB = [number, number, number];

const KEY_DOMINANCE_THRESHOLD = 16.0;
const ALPHA_NOISE_FLOOR = 8;

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** max 通道距离，等价于 Python _channel_distance */
export function channelDistance(a: RGB, b: RGB): number {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2])
  );
}

/** smoothstep 平滑阶跃，等价于 Python _smoothstep */
function smoothstep(value: number): number {
  const v = Math.max(0.0, Math.min(1.0, value));
  return v * v * (3.0 - 2.0 * v);
}

/**
 * 识别键色中"主导"通道（如绿幕的 G）。
 * 键色最大值 >= 128 且接近最大值的通道视为溢色通道。
 * 等价于 Python _spill_channels
 */
function spillChannels(key: RGB): number[] {
  const keyMax = Math.max(key[0], key[1], key[2]);
  if (keyMax < 128) return [];
  const result: number[] = [];
  for (let i = 0; i < 3; i++) {
    if (key[i] >= keyMax - 16 && key[i] >= 128) result.push(i);
  }
  return result;
}

/** 键色通道主导度，等价于 Python _key_channel_dominance */
function keyChannelDominance(rgb: RGB, key: RGB): number {
  const spill = spillChannels(key);
  if (spill.length === 0) return 0;
  const nonSpill = [0, 1, 2].filter((i) => !spill.includes(i));
  const keyStrength =
    spill.length > 1
      ? Math.min(...spill.map((i) => rgb[i]))
      : rgb[spill[0]];
  const nonKeyStrength =
    nonSpill.length > 0 ? Math.max(...nonSpill.map((i) => rgb[i])) : 0;
  return keyStrength - nonKeyStrength;
}

/** 像素是否看起来像键色，等价于 Python _looks_key_colored */
function looksKeyColored(rgb: RGB, key: RGB, distance: number): boolean {
  if (distance <= 32) return true;
  if (spillChannels(key).length === 0) return true;
  return keyChannelDominance(rgb, key) >= KEY_DOMINANCE_THRESHOLD;
}

/** 基于主导度的 alpha，等价于 Python _dominance_alpha */
function dominanceAlpha(rgb: RGB, key: RGB): number {
  const spill = spillChannels(key);
  if (spill.length === 0) return 255;
  const nonSpill = [0, 1, 2].filter((i) => !spill.includes(i));
  const keyStrength =
    spill.length > 1
      ? Math.min(...spill.map((i) => rgb[i]))
      : rgb[spill[0]];
  const nonKeyStrength =
    nonSpill.length > 0 ? Math.max(...nonSpill.map((i) => rgb[i])) : 0;
  const dominance = keyStrength - nonKeyStrength;
  if (dominance <= 0) return 255;
  const denominator = Math.max(1.0, Math.max(key[0], key[1], key[2]) - nonKeyStrength);
  const alpha = 1.0 - Math.min(1.0, dominance / denominator);
  return clampChannel(alpha * 255.0);
}

/** 软遮罩 alpha，等价于 Python _soft_alpha */
function softAlpha(
  distance: number,
  transparentThreshold: number,
  opaqueThreshold: number
): number {
  if (distance <= transparentThreshold) return 0;
  if (distance >= opaqueThreshold) return 255;
  const ratio =
    (distance - transparentThreshold) / (opaqueThreshold - transparentThreshold);
  return clampChannel(255.0 * smoothstep(ratio));
}

/** 去除键色溢出，等价于 Python _cleanup_spill */
function cleanupSpill(rgb: RGB, key: RGB, alpha = 255): RGB {
  if (alpha >= 252) return rgb;
  const spill = spillChannels(key);
  if (spill.length === 0) return rgb;
  const channels: number[] = [rgb[0], rgb[1], rgb[2]];
  const nonSpill = [0, 1, 2].filter((i) => !spill.includes(i));
  if (nonSpill.length > 0) {
    const anchor = Math.max(...nonSpill.map((i) => channels[i]));
    const cap = Math.max(0.0, anchor - 1.0);
    for (const i of spill) {
      if (channels[i] > cap) channels[i] = cap;
    }
  }
  return [
    clampChannel(channels[0]),
    clampChannel(channels[1]),
    clampChannel(channels[2]),
  ];
}

export interface ChromaKeyOptions {
  /** 键色 RGB */
  key: RGB;
  /** 硬键容差：距离 <= tolerance 直接透明（非 softMatte 路径） */
  tolerance: number;
  /** 软遮罩：距离 <= transparentThreshold 全透明 */
  transparentThreshold: number;
  /** 软遮罩：距离 >= opaqueThreshold 全不透明 */
  opaqueThreshold: number;
  /** 启用 smoothstep 软遮罩过渡 */
  softMatte: boolean;
  /** 去除键色溢出（绿边） */
  spillCleanup: boolean;
}

/**
 * 对 ImageData 原地执行色键抠图，返回透明像素数。
 * 等价于 Python _apply_alpha_to_image
 */
export function applyChromaKey(imageData: ImageData, opts: ChromaKeyOptions): number {
  const {
    key,
    tolerance,
    transparentThreshold,
    opaqueThreshold,
    softMatte,
    spillCleanup,
  } = opts;
  const data = imageData.data;
  let transparent = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    const rgb: RGB = [r, g, b];
    const distance = channelDistance(rgb, key);
    const keyLike = looksKeyColored(rgb, key, distance);

    let outputAlpha: number;
    if (softMatte && keyLike) {
      outputAlpha = Math.min(
        softAlpha(distance, transparentThreshold, opaqueThreshold),
        dominanceAlpha(rgb, key)
      );
    } else {
      outputAlpha = distance <= tolerance ? 0 : 255;
    }

    // 按原始 alpha 缩放（保留原图透明信息）
    outputAlpha = Math.round(outputAlpha * (a / 255.0));

    // 噪声底：极小 alpha 直接归零，避免残留噪点
    if (outputAlpha > 0 && outputAlpha <= ALPHA_NOISE_FLOOR) {
      outputAlpha = 0;
    }

    if (outputAlpha === 0) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
      transparent++;
      continue;
    }

    if (spillCleanup && keyLike) {
      const [nr, ng, nb] = cleanupSpill(rgb, key, outputAlpha);
      data[i] = nr;
      data[i + 1] = ng;
      data[i + 2] = nb;
    }
    data[i + 3] = outputAlpha;
  }

  return transparent;
}

/**
 * 收缩 alpha 蒙版（边缘腐蚀），等价于 Python _contract_alpha（MinFilter）。
 * 在 image 上原地操作。
 */
export function contractAlpha(imageData: ImageData, pixels: number): void {
  if (pixels <= 0) return;
  const { data, width, height } = imageData;
  const alpha = new Uint8ClampedArray(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];

  for (let e = 0; e < pixels; e++) {
    const tmp = new Uint8ClampedArray(alpha);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        const minNeighbor = Math.min(
          tmp[idx],
          tmp[idx - 1],
          tmp[idx + 1],
          tmp[idx - width],
          tmp[idx + width]
        );
        alpha[idx] = Math.min(tmp[idx], minNeighbor);
      }
    }
  }

  for (let i = 0; i < alpha.length; i++) data[i * 4 + 3] = alpha[i];
}

/**
 * 从图像边框采样键色（取中位数），等价于 Python _sample_border_key(mode="border")。
 * 比"出现次数最多"更抗噪。
 */
export function sampleBorderKey(imageData: ImageData): RGB {
  const { data, width, height } = imageData;
  const band = Math.max(1, Math.min(width, height, 6));
  const step = Math.max(1, Math.floor(Math.min(width, height) / 256));
  const samples: number[] = [];
  const push = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    samples.push(data[idx], data[idx + 1], data[idx + 2]);
  };

  for (let x = 0; x < width; x += step) {
    for (let y = 0; y < band; y++) {
      push(x, y);
      push(x, height - 1 - y);
    }
  }
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < band; x++) {
      push(x, y);
      push(width - 1 - x, y);
    }
  }

  if (samples.length === 0) return [0, 255, 0];

  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let i = 0; i < samples.length; i += 3) {
    rs.push(samples[i]);
    gs.push(samples[i + 1]);
    bs.push(samples[i + 2]);
  }
  const median = (arr: number[]): number => {
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  };
  return [median(rs), median(gs), median(bs)];
}
