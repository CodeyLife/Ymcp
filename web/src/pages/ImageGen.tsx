import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import type { CSSProperties } from "react";
import {
  Card, Typography, Segmented, Form, Input, Slider, Button, Row, Col, Space, App, Alert, Switch, Tag, Drawer, Empty, Popconfirm,
} from "antd";
import { PictureOutlined, ScissorOutlined, DownloadOutlined, StarOutlined, StarFilled, EditOutlined, CloseCircleOutlined, ReloadOutlined, PlayCircleOutlined, PauseCircleOutlined, ThunderboltOutlined, InboxOutlined, DeleteOutlined, BlockOutlined, BookOutlined, SaveOutlined, PlusOutlined, EyeOutlined, FileImageOutlined } from "@ant-design/icons";
import { useUIStore, getEffectiveApiConfig } from "@/stores/ui";
import { DEFAULT_GREENSCREEN_PROMPT, DEFAULT_SPRITESHEET_PROMPT } from "@/config/defaults";
import { useImageGenStore, type TaskStatus, type GenTask, type GenMode, MAX_REF_IMAGES } from "@/stores/imageGen";
import { usePromptFavoriteStore, createPromptFavoriteTitle, type PromptFavorite } from "@/stores/promptFavorites";
import { useHistoryStore, type HistoryItem } from "@/stores/history";
import { useAssetStore } from "@/stores/asset";
import { usePsdTaskStore } from "@/stores/psdTask";
import {
  imageGenerationClient,
  cacheImageLocally,
  polishPrompt,
  toDataUrl,
  type ImageGenerationAdapterKind,
  type SubmittedImageTaskRef,
} from "@/lib/api";
import { setImage } from "@/lib/imageStore";
import { IMG2IMG_REFERENCE_GUIDES, STYLE_PRESETS } from "@/lib/imagegenPresets";
import { downloadBlob } from "@/lib/canvas";
import { compressImage } from "@/lib/imageCompress";
import { useNavigate } from "react-router-dom";
import { DiffusionLoader } from "@/components/DiffusionLoader";
import { MagneticButton } from "@/components/motion";
import { PageHeader, TiltCard } from "@/components/showtime";
import { FileUploadTrigger } from "@/components/FileUploadTrigger";
import { type ImagePreviewAction } from "@/components/ImagePreviewActionToolbar";
import { ImagePreviewWithToolbar } from "@/components/ImagePreviewToolbar";
import { PsdTaskPanel } from "@/components/PsdTaskPanel";
import { motion } from "motion/react";
import { useMotionMode } from "@/hooks/useMotionMode";

const { Text } = Typography;
const { TextArea } = Input;
const IMAGE_GEN_SOFT_TIMEOUT_MS = 120_000;
const GREENSCREEN_BG = "#00ff00";
const GREENSCREEN_REFERENCE_MIME = "image/jpeg";
const GREENSCREEN_REFERENCE_QUALITY = 0.95;

// === 模块级任务运行时（脱离组件生命周期，切换 Tab 时保持任务运行） ===
interface ActiveBatch {
  id: number;
  controller: AbortController;
  softTimeoutId: number | null;
  clientTaskIds: Map<string, number>; // clientTaskId -> globalIndex（1-based），用于断线恢复查询
  handleTaskResult: (taskIndex: number, images: string[]) => void;
  handleTaskError: (taskIndex: number, error: string) => void;
  adapter: ImageGenerationAdapterKind | null;
  apiConfig: { baseUrl: string; apiKey: string };
}
// 单批次运行：同一时刻只允许一个活跃批次
let activeBatch: ActiveBatch | null = null;
let batchSeq = 0;
const PENDING_IMAGE_BATCH_STORAGE_KEY = "ymcp-imagegen-pending-batch";
const PENDING_IMAGE_BATCH_VERSION = 1;
const PENDING_IMAGE_BATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isActiveBatch(batchId: number) {
  return activeBatch?.id === batchId;
}
function clearBatchTimer() {
  if (activeBatch?.softTimeoutId != null) {
    window.clearTimeout(activeBatch.softTimeoutId);
    activeBatch.softTimeoutId = null;
  }
}
function abortActiveBatch() {
  if (!activeBatch) return;
  if (activeBatch.softTimeoutId != null) window.clearTimeout(activeBatch.softTimeoutId);
  activeBatch.controller.abort();
  activeBatch = null;
}
type ImageHistorySnapshot = Pick<HistoryItem, "mode" | "prompt" | "size" | "quality">;

interface PersistedImageBatch {
  version: typeof PENDING_IMAGE_BATCH_VERSION;
  id: number;
  createdAt: number;
  updatedAt: number;
  baseUrl: string;
  apiKey: string;
  n: number;
  size: string;
  quality?: string;
  historySnapshot: ImageHistorySnapshot;
  clientTaskIds: SubmittedImageTaskRef[];
  taskSnapshots: Array<{
    globalIndex: number;
    status: Exclude<TaskStatus, "done">;
    progress?: string;
    error?: string;
  }>;
}

function readPendingImageBatch(): PersistedImageBatch | null {
  try {
    const raw = window.localStorage.getItem(PENDING_IMAGE_BATCH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedImageBatch>;
    if (!isPersistedImageBatch(parsed)) {
      window.localStorage.removeItem(PENDING_IMAGE_BATCH_STORAGE_KEY);
      return null;
    }
    const age = Date.now() - parsed.createdAt;
    const idleAge = Date.now() - parsed.updatedAt;
    if (age > PENDING_IMAGE_BATCH_MAX_AGE_MS || idleAge > PENDING_IMAGE_BATCH_MAX_AGE_MS) {
      window.localStorage.removeItem(PENDING_IMAGE_BATCH_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    window.localStorage.removeItem(PENDING_IMAGE_BATCH_STORAGE_KEY);
    return null;
  }
}

function isPersistedImageBatch(value: Partial<PersistedImageBatch> | null): value is PersistedImageBatch {
  if (!value || value.version !== PENDING_IMAGE_BATCH_VERSION) return false;
  if (
    typeof value.id !== "number" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    !Number.isFinite(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    typeof value.baseUrl !== "string" ||
    typeof value.apiKey !== "string" ||
    typeof value.n !== "number" ||
    !Number.isFinite(value.n) ||
    value.n <= 0 ||
    typeof value.size !== "string" ||
    !value.historySnapshot ||
    typeof value.historySnapshot.mode !== "string" ||
    typeof value.historySnapshot.prompt !== "string" ||
    typeof value.historySnapshot.size !== "string" ||
    typeof value.historySnapshot.quality !== "string" ||
    !Array.isArray(value.clientTaskIds) ||
    value.clientTaskIds.length === 0 ||
    !Array.isArray(value.taskSnapshots)
  ) {
    return false;
  }

  const taskCount = value.n;

  return (
    value.clientTaskIds.every(
      (item) =>
        item &&
        typeof item.taskId === "string" &&
        !!item.taskId.trim() &&
        typeof item.globalIndex === "number" &&
        Number.isInteger(item.globalIndex) &&
        item.globalIndex >= 1 &&
        item.globalIndex <= taskCount
    ) &&
    value.taskSnapshots.every(
      (item) =>
        item &&
        typeof item.globalIndex === "number" &&
        Number.isInteger(item.globalIndex) &&
        item.globalIndex >= 1 &&
        item.globalIndex <= taskCount &&
        ["pending", "loading", "waiting", "error"].includes(item.status) &&
        (item.progress === undefined || typeof item.progress === "string") &&
        (item.error === undefined || typeof item.error === "string")
    )
  );
}

function writePendingImageBatch(batch: PersistedImageBatch): void {
  try {
    if (batch.clientTaskIds.length === 0) {
      window.localStorage.removeItem(PENDING_IMAGE_BATCH_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(PENDING_IMAGE_BATCH_STORAGE_KEY, JSON.stringify({ ...batch, updatedAt: Date.now() }));
  } catch {
    // localStorage 可能被禁用；不影响当前页面内任务轮询
  }
}

function clearPendingImageBatch(batchId?: number): void {
  try {
    if (batchId != null) {
      const current = readPendingImageBatch();
      if (current && current.id !== batchId) return;
    }
    window.localStorage.removeItem(PENDING_IMAGE_BATCH_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function removePendingImageTask(batchId: number, globalIndex: number): void {
  const current = readPendingImageBatch();
  if (!current || current.id !== batchId) return;
  const next = {
    ...current,
    clientTaskIds: current.clientTaskIds.filter((item) => item.globalIndex !== globalIndex),
  };
  writePendingImageBatch(next);
}

/* gpt-image-2 支持的尺寸 */
interface SizeOption {
  ratio: string;
  value: string;
  w: number;
  h: number;
  tier: "1k" | "2k" | "4k" | "auto";
}

const SIZE_OPTIONS: SizeOption[] = [
  { ratio: "auto", value: "auto", w: 0, h: 0, tier: "auto" },
  { ratio: "1:1", value: "1024x1024", w: 1024, h: 1024, tier: "1k" },
  { ratio: "2:3", value: "1024x1536", w: 1024, h: 1536, tier: "1k" },
  { ratio: "3:2", value: "1536x1024", w: 1536, h: 1024, tier: "1k" },
  { ratio: "3:4", value: "1024x1365", w: 1024, h: 1365, tier: "1k" },
  { ratio: "4:3", value: "1365x1024", w: 1365, h: 1024, tier: "1k" },
  { ratio: "9:16", value: "1024x1792", w: 1024, h: 1792, tier: "1k" },
  { ratio: "16:9", value: "1792x1024", w: 1792, h: 1024, tier: "1k" },
];

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new window.Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片解码失败"));
    };
    image.src = url;
  });
}

async function flattenImageOnGreen(blob: Blob): Promise<Blob> {
  const image = await loadImageFromBlob(blob);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 上下文不可用");

  ctx.fillStyle = GREENSCREEN_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (out) => (out ? resolve(out) : reject(new Error("绿幕参考图导出失败"))),
      GREENSCREEN_REFERENCE_MIME,
      GREENSCREEN_REFERENCE_QUALITY
    );
  });
}

/**
 * 将图片转为 JPEG blob URL。
 * 用于超分前预处理：JPG 无 alpha 通道、体积更小，可加速推理并避免透明区域伪影。
 */
async function pngToJpegUrl(src: string): Promise<string> {
  const response = await fetch(src);
  const blob = await response.blob();
  const image = await loadImageFromBlob(blob);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 上下文不可用");
  // JPG 不支持透明，填充白色背景
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (out) => (out ? resolve(URL.createObjectURL(out)) : reject(new Error("JPEG 导出失败"))),
      "image/jpeg",
      0.95
    );
  });
}

/**
 * 根据结果数量、容器宽高比、图片宽高比，算出能装下全部卡片且总高不超过可用高度的最优列数。
 * 目标：每格尽量大、行数最少、不溢出视口。
 *
 * 算法：遍历所有可能的 cols (1..count)，对每个 cols 算 rows=ceil(count/cols)，
 *       算每格宽度 = (containerW - (cols-1)*gap) / cols，
 *       每格高度 = cellW / imgRatio（按图片宽高比），
 *       每行可用高度上限 = (availH - (rows-1)*gap) / rows - cardOverhead，
 *       约束：cellH ≤ 每行可用上限（保证不溢出）且 cellH ≥ 80px（避免过小），
 *       在所有候选里选 cellH 最大的 cols（即格子最大）。
 *       兜底：无满足约束方案时，选行数最少且 cellH 不超上限的；仍无则强制限制 cellH。
 */
function computeOptimalCols(
  count: number,
  containerW: number,
  availH: number,
  imgRatio: number,
  gap: number,
  cardOverhead: number
): number {
  if (count <= 1) return 1;
  let best = 1;
  let bestCellH = 0;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cellW = (containerW - (cols - 1) * gap) / cols;
    if (cellW <= 0) continue;
    const cellH = cellW / imgRatio;
    // 每行可用高度上限：均分扣除 gap 与 cardOverhead
    const rowMaxH = (availH - (rows - 1) * gap) / rows - cardOverhead;
    // 约束：单格高度不超过行上限（保证总高不溢出），且不小于 80px
    if (cellH <= rowMaxH && cellH >= 80) {
      if (cellH > bestCellH) {
        bestCellH = cellH;
        best = cols;
      }
    }
  }
  // 兜底 1：无满足约束方案，选行数最少（cols 最大）且 cellW 合理的
  if (best === 1 && bestCellH === 0) {
    for (let cols = count; cols >= 1; cols--) {
      const cellW = (containerW - (cols - 1) * gap) / cols;
      if (cellW > 0) return cols;
    }
  }
  return best;
}

/**
 * 根据可用高度、行数、gap、cardOverhead，算每格图片容器的最大高度（px，硬上限）。
 * 保证 rows 行总高（含 gap 与 cardOverhead）不超过 availH。
 */
function computeCellMaxH(
  availH: number,
  rows: number,
  gap: number,
  cardOverhead: number
): number {
  return Math.max(80, (availH - (rows - 1) * gap) / rows - cardOverhead);
}

function SizeIcon({ ratio }: { ratio: string }) {
  if (ratio === "auto") return <span style={{ fontSize: 12, color: "#71717a" }}>auto</span>;
  const [a, b] = ratio.split(":").map(Number);
  const isPortrait = b > a;
  const isSquare = a === b;
  const w = isSquare ? 14 : isPortrait ? 10 : 18;
  const h = isSquare ? 14 : isPortrait ? 18 : 10;
  return (
    <div
      style={{
        width: w,
        height: h,
        border: "1.5px solid currentColor",
        borderRadius: 2,
        margin: "0 auto 4px",
      }}
    />
  );
}

/* 任务状态标签 */
function TaskStatusTag({ status }: { status: TaskStatus }) {
  const map: Record<TaskStatus, { color: string; text: string }> = {
    pending: { color: "default", text: "等待中" },
    loading: { color: "processing", text: "生成中" },
    waiting: { color: "warning", text: "仍在等待" },
    done: { color: "success", text: "完成" },
    error: { color: "error", text: "失败" },
  };
  const cfg = map[status];
  return <Tag color={cfg.color} style={{ marginInlineEnd: 0 }}>{cfg.text}</Tag>;
}

function formatFavoriteTime(time: number | null): string {
  if (!time) return "尚未使用";
  return new Date(time).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function PromptFavoriteDrawer({
  open,
  items,
  activeId,
  search,
  onSearchChange,
  onClose,
  onUse,
  onDelete,
  onRename,
}: {
  open: boolean;
  items: PromptFavorite[];
  activeId: string | null;
  search: string;
  onSearchChange: (value: string) => void;
  onClose: () => void;
  onUse: (item: PromptFavorite) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});

  const commitTitle = (item: PromptFavorite) => {
    const nextTitle = (titleDrafts[item.id] ?? item.title).trim();
    if (nextTitle && nextTitle !== item.title) onRename(item.id, nextTitle);
  };

  return (
    <Drawer
      title={(
        <div className="prompt-favorite-drawer-title">
          <BookOutlined />
          <span>提示词收藏库</span>
          <Tag color="green" style={{ marginInlineStart: 8 }}>{items.length}</Tag>
        </div>
      )}
      open={open}
      onClose={onClose}
      width={520}
      className="prompt-favorite-drawer"
      styles={{
        body: { padding: 16 },
        header: { borderBottom: "1px solid rgba(63, 63, 70, 0.72)" },
      }}
    >
      <Input
        allowClear
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder="搜索标题或提示词"
        className="prompt-favorite-search"
      />

      {items.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={search.trim() ? "没有匹配的收藏" : "还没有收藏提示词"}
          style={{ color: "#71717a", marginTop: 48 }}
        />
      ) : (
        <div className="prompt-favorite-list">
          {items.map((item) => {
            const active = item.id === activeId;
            return (
              <div key={item.id} className={`prompt-favorite-card${active ? " is-active" : ""}`}>
                <div className="prompt-favorite-card-head">
                  <Input
                    size="small"
                    value={titleDrafts[item.id] ?? item.title}
                    onChange={(event) => setTitleDrafts((prev) => ({ ...prev, [item.id]: event.target.value }))}
                    onBlur={() => commitTitle(item)}
                    onPressEnter={() => commitTitle(item)}
                    className="prompt-favorite-title-input"
                  />
                  <Space size={6}>
                    <Button size="small" type={active ? "primary" : "default"} onClick={() => onUse(item)}>
                      使用
                    </Button>
                    <Popconfirm
                      title="删除这条提示词收藏？"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => onDelete(item.id)}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                </div>
                <div className="prompt-favorite-preview">{item.prompt}</div>
                <div className="prompt-favorite-meta">
                  <span>{item.sourceMode === "img2img" ? "图生图" : "文生图"} · {item.genMode}</span>
                  <span>使用 {item.usageCount} 次 · {formatFavoriteTime(item.lastUsedAt)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Drawer>
  );
}

/* 序列帧模式：原图 + N×N 拆分动画预览（两板块垂直分布） */
function SpritesheetPreview({ src, n, onDownload }: { src: string; n: number; onDownload: (src: string) => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [frames, setFrames] = useState<HTMLCanvasElement[]>([]);
  const [animPlaying, setAnimPlaying] = useState(true);
  const [animFps, setAnimFps] = useState(8);
  const [animFrame, setAnimFrame] = useState(0);
  const [animLoop, setAnimLoop] = useState(true);
  const animRef = useRef<HTMLCanvasElement>(null);
  const animTimerRef = useRef<number | null>(null);

  // 加载图片并按 N×N 等分切割
  useEffect(() => {
    let cancelled = false;
    const image = new (window.Image as typeof HTMLImageElement)();
    image.onload = () => {
      if (cancelled) return;
      setImg(image);
      const cellW = image.naturalWidth / n;
      const cellH = image.naturalHeight / n;
      const result: HTMLCanvasElement[] = [];
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(cellW));
          canvas.height = Math.max(1, Math.round(cellH));
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(
              image,
              x * cellW, y * cellH, cellW, cellH,
              0, 0, canvas.width, canvas.height
            );
          }
          result.push(canvas);
        }
      }
      setFrames(result);
      setAnimFrame(0);
      setAnimPlaying(true);
    };
    image.src = src;
    return () => { cancelled = true; };
  }, [src, n]);

  // 绘制指定帧
  const drawAnimFrame = useCallback((frameIdx: number) => {
    const canvas = animRef.current;
    if (!canvas || !frames.length) return;
    const f = frames[frameIdx % frames.length];
    if (!f) return;
    canvas.width = f.width;
    canvas.height = f.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(f, 0, 0);
  }, [frames]);

  // 用 ref 保存当前帧索引，避免每帧 setState 触发 effect 重建 rAF 循环
  const animFrameRef = useRef(0);
  useEffect(() => { animFrameRef.current = animFrame; }, [animFrame]);

  // 动画播放循环：仅依赖 playing/fps/loop/frames，帧推进不重建循环
  useEffect(() => {
    if (!animPlaying || !frames.length) return;
    const interval = 1000 / animFps;
    let lastTime = performance.now();
    const tick = (now: number) => {
      if (now - lastTime >= interval) {
        let next = animFrameRef.current + 1;
        if (next >= frames.length) {
          if (animLoop) next = 0;
          else {
            setAnimPlaying(false);
            setAnimFrame(frames.length - 1);
            animFrameRef.current = frames.length - 1;
            return;
          }
        }
        animFrameRef.current = next;
        setAnimFrame(next);
        drawAnimFrame(next);
        lastTime = now;
      }
      animTimerRef.current = requestAnimationFrame(tick);
    };
    animTimerRef.current = requestAnimationFrame(tick);
    return () => { if (animTimerRef.current) cancelAnimationFrame(animTimerRef.current); };
  }, [animPlaying, animFps, animLoop, frames, drawAnimFrame]);

  // 非播放状态切换帧时重绘
  useEffect(() => {
    if (!animPlaying) drawAnimFrame(animFrame);
  }, [animFrame, animPlaying, drawAnimFrame]);

  // 卸载清理
  useEffect(() => () => { if (animTimerRef.current) cancelAnimationFrame(animTimerRef.current); }, []);

  if (!img) {
    return (
      <div style={{ minHeight: 200, display: "grid", placeItems: "center" }}>
        <Text style={{ color: "#71717a", fontSize: 12 }}>拆分中...</Text>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 上：原图预览 */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <Text style={{ color: "#a1a1aa", fontSize: 13, fontWeight: 500 }}>
            原图（Sprite Sheet）
          </Text>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={() => onDownload(src)}
          >
            下载原图
          </Button>
        </div>
        <div
          className="checker-bg"
          style={{
            borderRadius: 10,
            overflow: "hidden",
            border: "1px solid #27272a",
            textAlign: "center",
            padding: 8,
          }}
        >
          <img
            src={src}
            alt="sprite sheet"
            style={{ maxWidth: "100%", maxHeight: "55vh", objectFit: "contain", display: "block", margin: "0 auto" }}
          />
        </div>
      </div>

      {/* 下：序列帧动画预览 */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <Text style={{ color: "#a1a1aa", fontSize: 13, fontWeight: 500 }}>
            序列帧动画预览（{n}×{n} = {frames.length} 帧）
          </Text>
          <Space size={12}>
            <Button
              size="small"
              type={animPlaying ? "default" : "primary"}
              icon={animPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              onClick={() => setAnimPlaying((p) => !p)}
            >
              {animPlaying ? "暂停" : "播放"}
            </Button>
            <Space size={4}>
              <Text style={{ color: "#71717a", fontSize: 12 }}>循环</Text>
              <Switch size="small" checked={animLoop} onChange={setAnimLoop} />
            </Space>
          </Space>
        </div>
        <div
          style={{
            display: "flex",
            gap: 16,
            alignItems: "flex-start",
            background: "#0a0a0a",
            borderRadius: 10,
            padding: 16,
            border: "1px solid #27272a",
          }}
        >
          <div className="checker-bg" style={{ borderRadius: 6, padding: 8, flex: "0 0 auto" }}>
            <canvas
              ref={animRef}
              style={{ maxWidth: 280, maxHeight: 280, imageRendering: "pixelated" }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: "#71717a", fontSize: 12, display: "block", marginBottom: 4 }}>
              帧率: {animFps} FPS
            </Text>
            <Slider
              min={1}
              max={30}
              value={animFps}
              onChange={setAnimFps}
              style={{ marginBottom: 12 }}
            />
            <Text style={{ color: "#71717a", fontSize: 12, display: "block", marginBottom: 4 }}>
              帧: {animFrame + 1} / {frames.length}
            </Text>
            <Slider
              min={0}
              max={Math.max(0, frames.length - 1)}
              value={animFrame}
              onChange={(v) => { setAnimFrame(v); setAnimPlaying(false); }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * TaskCard - 单个任务卡片（memo 化）
 * 拆分为独立组件 + React.memo：流式 partial 更新时，
 * 只有 partial 变化的那个 task 的卡片会重渲染，
 * 其他卡片因 props 不变被 memo 跳过。
 * ============================================================ */
interface TaskCardProps {
  task: GenTask;
  status: TaskStatus;
  src?: string;
  favoriteId: string;
  displayIndex: number;
  doneIdx?: number;
  isFavorited: boolean;
  previewRatio: number;
  aspectRatio: string;
  cellMaxH: string;
  genMode: GenMode;
  spritesheetN: number;
  reduceMotion: boolean;
  onRetry: (taskIndex: number) => void;
  onOpenPreview: (favoriteId: string) => void;
  onDownload: (src: string) => void;
  onToggleFavorite: (favoriteId: string, src: string, displayIndex: number) => void;
  onEditImage: (src: string) => void;
  onSendToMatte: (src: string) => void;
  onSendToSuperRes: (src: string) => void;
  onSplitToPsd: (src: string) => void;
  onResultRatio: (favoriteId: string, ratio: number) => void;
}

interface ResultActionButtonsProps {
  src: string;
  favoriteId: string;
  displayIndex: number;
  isFavorited: boolean;
  genMode: GenMode;
  onDownload: (src: string) => void;
  onToggleFavorite: (favoriteId: string, src: string, displayIndex: number) => void;
  onEditImage: (src: string) => void;
  onSendToMatte: (src: string) => void;
  onSendToSuperRes: (src: string) => void;
  onSplitToPsd: (src: string) => void;
}

function ResultActionButtons({
  src,
  favoriteId,
  displayIndex,
  isFavorited,
  genMode,
  onDownload,
  onToggleFavorite,
  onEditImage,
  onSendToMatte,
  onSendToSuperRes,
  onSplitToPsd,
}: ResultActionButtonsProps) {
  return (
    <>
      <button
        type="button"
        aria-label={isFavorited ? "取消收藏" : "收藏"}
        title={isFavorited ? "取消收藏" : "收藏"}
        className={isFavorited ? "is-active" : undefined}
        onClick={() => onToggleFavorite(favoriteId, src, displayIndex)}
      >
        {isFavorited
          ? <StarFilled style={{ color: "#fbbf24" }} />
          : <StarOutlined />}
      </button>
      <button
        type="button"
        aria-label="编辑（送入图生图）"
        title="编辑（送入图生图）"
        onClick={() => onEditImage(src)}
      >
        <EditOutlined />
      </button>
      {genMode === "greenscreen" && (
        <button
          type="button"
          aria-label="送入抠图"
          title="送入抠图"
          onClick={() => onSendToMatte(src)}
        >
          <ScissorOutlined />
        </button>
      )}
      <button
        type="button"
        aria-label="拆分为 PSD"
        title="拆分为 PSD"
        onClick={() => onSplitToPsd(src)}
      >
        <BlockOutlined />
      </button>
      <button
        type="button"
        aria-label="超分 4K"
        title="超分 4K（本地）"
        onClick={() => onSendToSuperRes(src)}
      >
        <ThunderboltOutlined />
      </button>
      <button
        type="button"
        aria-label="下载"
        title="下载"
        onClick={() => onDownload(src)}
      >
        <DownloadOutlined />
      </button>
    </>
  );
}

const TaskCard = memo(function TaskCard({
  task, status, src, favoriteId, displayIndex,
  isFavorited, previewRatio, aspectRatio, cellMaxH,
  genMode, spritesheetN, reduceMotion,
  onRetry, onOpenPreview, onDownload, onToggleFavorite,
  onEditImage, onSendToMatte, onSendToSuperRes, onSplitToPsd,
  onResultRatio,
}: TaskCardProps) {
  const isDone = status === "done" && src;
  const frameStyle: CSSProperties = useMemo(() => ({
    maxHeight: cellMaxH,
    maxWidth: "100%",
    width: `min(100%, calc(${cellMaxH} * ${previewRatio}))`,
    aspectRatio: `${previewRatio}`,
    borderRadius: 10,
    overflow: "hidden",
    position: "relative",
    border: "1px solid rgba(16, 185, 129, 0.18)",
    boxShadow:
      "0 4px 14px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 auto",
  }), [cellMaxH, previewRatio]);

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        duration: 0.5,
        delay: displayIndex * 0.06,
        ease: [0.16, 1, 0.3, 1],
      }}
    >
      <div className={`task-card${isDone && genMode !== "spritesheet" ? " result-task-card" : ""}`}>
        <div className="task-header">
          <span className="task-index">#{String(displayIndex + 1).padStart(2, "0")}</span>
          <TaskStatusTag status={status} />
          {status === "error" && (
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined />}
              onClick={() => onRetry(task.index)}
              style={{ color: "#f87171", marginLeft: "auto" }}
            >
              重试
            </Button>
          )}
        </div>

        <div className="task-body">
          {(status === "pending" || status === "waiting" || (status === "loading" && !task.partial)) && (
            <div
              style={{
                maxHeight: cellMaxH,
                maxWidth: "100%",
                aspectRatio,
                borderRadius: 10,
                overflow: "hidden",
                position: "relative",
                border: "1px solid rgba(16, 185, 129, 0.18)",
                margin: "0 auto",
                width: "100%",
              }}
            >
              <DiffusionLoader
                fill
                label={status === "waiting" ? "仍在等待" : status === "loading" ? (task.progress || "生成中") : "等待中"}
              />
            </div>
          )}

          {status === "loading" && task.partial && (
            <div
              className="checker-bg"
              style={{
                maxHeight: cellMaxH,
                maxWidth: "100%",
                aspectRatio,
                borderRadius: 10,
                overflow: "hidden",
                position: "relative",
                border: "1px solid rgba(16, 185, 129, 0.25)",
                boxShadow: "0 0 24px rgba(16, 185, 129, 0.18)",
                display: "flex",
                justifyContent: "center",
                margin: "0 auto",
                width: "100%",
              }}
            >
              <img
                src={task.partial}
                alt="生成中"
                style={{
                  maxWidth: "100%",
                  maxHeight: "60vh",
                  objectFit: "contain",
                  display: "block",
                }}
              />
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: 0,
                  height: "30%",
                  background:
                    "linear-gradient(180deg, transparent 0%, rgba(52, 211, 153, 0.15) 70%, rgba(52, 211, 153, 0.4) 95%, transparent 100%)",
                  animation: "scan-down 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
                  pointerEvents: "none",
                  mixBlendMode: "screen",
                }}
              />
            </div>
          )}

          {status === "error" && (
            <div
              style={{
                maxHeight: cellMaxH,
                display: "grid",
                placeItems: "center",
                borderRadius: 10,
                border: "1px dashed rgba(239, 68, 68, 0.45)",
                background:
                  "repeating-conic-gradient(#1a1a1e 0% 25%, #131316 0% 50%) 50% / 24px 24px",
                padding: 16,
                margin: "0 auto",
                width: "100%",
              }}
            >
              <div style={{ textAlign: "center", maxWidth: 420 }}>
                <CloseCircleOutlined style={{ color: "#f87171", fontSize: 22, marginBottom: 8 }} />
                <Text
                  style={{
                    color: "#fca5a5",
                    fontSize: 12,
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    display: "block",
                  }}
                >
                  {task.error || "生成失败"}
                </Text>
              </div>
            </div>
          )}

          {isDone && genMode === "spritesheet" && (
            <SpritesheetPreview
              src={src!}
              n={spritesheetN}
              onDownload={onDownload}
            />
          )}
          {isDone && genMode !== "spritesheet" && (
            <>
              <TiltCard
                max={6}
                className="result-tilt"
                onClick={() => onOpenPreview(favoriteId)}
                style={{ cursor: "pointer" }}
              >
                <div
                  className="checker-bg result-preview-frame"
                  style={frameStyle}
                >
                  <img
                    src={src}
                    alt={`结果 ${displayIndex + 1}`}
                    style={{
                      display: "block",
                      width: "100%",
                      height: "100%",
                      maxWidth: "100%",
                      maxHeight: cellMaxH,
                      objectFit: "contain",
                    }}
                    onLoad={(event) => {
                      const { naturalWidth, naturalHeight } = event.currentTarget;
                      if (naturalWidth <= 0 || naturalHeight <= 0) return;
                      const nextRatio = naturalWidth / naturalHeight;
                      onResultRatio(favoriteId, nextRatio);
                    }}
                  />
                  <div
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: 0,
                      height: "50%",
                      background:
                        "linear-gradient(180deg, rgba(52, 211, 153, 0.18) 0%, transparent 100%)",
                      pointerEvents: "none",
                      mixBlendMode: "screen",
                      animation: "scan-down 0.9s cubic-bezier(0.16, 1, 0.3, 1) forwards",
                      animationDelay: `${displayIndex * 0.06}s`,
                    }}
                  />
                  <div
                    className="result-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ResultActionButtons
                      src={src}
                      favoriteId={favoriteId}
                      displayIndex={displayIndex}
                      isFavorited={isFavorited}
                      genMode={genMode}
                      onDownload={onDownload}
                      onToggleFavorite={onToggleFavorite}
                      onEditImage={onEditImage}
                      onSendToMatte={onSendToMatte}
                      onSendToSuperRes={onSendToSuperRes}
                      onSplitToPsd={onSplitToPsd}
                    />
                  </div>
                </div>
              </TiltCard>
              <div
                className="result-actions-mobile"
                onClick={(e) => e.stopPropagation()}
              >
                <ResultActionButtons
                  src={src}
                  favoriteId={favoriteId}
                  displayIndex={displayIndex}
                  isFavorited={isFavorited}
                  genMode={genMode}
                  onDownload={onDownload}
                  onToggleFavorite={onToggleFavorite}
                  onEditImage={onEditImage}
                  onSendToMatte={onSendToMatte}
                  onSendToSuperRes={onSendToSuperRes}
                  onSplitToPsd={onSplitToPsd}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
});
// 历史遗留：TaskCard 组件待后续接入，此处引用以通过 noUnusedLocals
void TaskCard;

export default function ImageGen() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const setIncomingImage = useUIStore((s) => s.setIncomingImage);

  const mode = useImageGenStore((s) => s.mode);
  const genMode = useImageGenStore((s) => s.genMode);
  const textPrompt = useImageGenStore((s) => s.textPrompt);
  const imgPrompt = useImageGenStore((s) => s.imgPrompt);
  const size = useImageGenStore((s) => s.size);
  const n = useImageGenStore((s) => s.n);
  const spritesheetN = useImageGenStore((s) => s.spritesheetN);
  const quality = useImageGenStore((s) => s.quality);
  const styleId = useImageGenStore((s) => s.styleId);
  const img2imgReferenceGuideId = useImageGenStore((s) => s.img2imgReferenceGuideId);
  const refImages = useImageGenStore((s) => s.refImages);
  const tasks = useImageGenStore((s) => s.tasks);
  const extraResults = useImageGenStore((s) => s.extraResults);
  const loading = useImageGenStore((s) => s.loading);
  const error = useImageGenStore((s) => s.error);
  const setMode = useImageGenStore((s) => s.setMode);
  const setGenMode = useImageGenStore((s) => s.setGenMode);
  const setTextPrompt = useImageGenStore((s) => s.setTextPrompt);
  const setImgPrompt = useImageGenStore((s) => s.setImgPrompt);
  const setSize = useImageGenStore((s) => s.setSize);
  const setN = useImageGenStore((s) => s.setN);
  const setSpritesheetN = useImageGenStore((s) => s.setSpritesheetN);
  const setQuality = useImageGenStore((s) => s.setQuality);
  const setStyleId = useImageGenStore((s) => s.setStyleId);
  const setImg2imgReferenceGuideId = useImageGenStore((s) => s.setImg2imgReferenceGuideId);
  const addRefImages = useImageGenStore((s) => s.addRefImages);
  const removeRefImage = useImageGenStore((s) => s.removeRefImage);
  const clearRefImages = useImageGenStore((s) => s.clearRefImages);
  const setTasks = useImageGenStore((s) => s.setTasks);
  const updateTask = useImageGenStore((s) => s.updateTask);
  const addExtraResult = useImageGenStore((s) => s.addExtraResult);
  const resetTasks = useImageGenStore((s) => s.resetTasks);
  const setLoading = useImageGenStore((s) => s.setLoading);
  const setError = useImageGenStore((s) => s.setError);

  const greenscreenPrompt = useUIStore((s) => s.greenscreenPrompt);
  const spritesheetPrompt = useUIStore((s) => s.spritesheetPrompt);
  const imageGenAdapter = useUIStore((s) => s.imageGenAdapter);

  const addHistory = useHistoryStore((s) => s.add);
  const addAsset = useAssetStore((s) => s.add);
  const assetItems = useAssetStore((s) => s.items);
  const assetGroups = useAssetStore((s) => s.groups);
  const moveAssetToGroup = useAssetStore((s) => s.moveItemToGroup);
  const promptFavorites = usePromptFavoriteStore((s) => s.items);
  const addPromptFavorite = usePromptFavoriteStore((s) => s.add);
  const updatePromptFavorite = usePromptFavoriteStore((s) => s.update);
  const removePromptFavorite = usePromptFavoriteStore((s) => s.remove);
  const markPromptFavoriteUsed = usePromptFavoriteStore((s) => s.markUsed);
  const findDuplicatePromptFavorite = usePromptFavoriteStore((s) => s.findDuplicate);
  const setPsdPendingImages = usePsdTaskStore((s) => s.setPendingBase64Images);
  const setPsdPendingPrompt = usePsdTaskStore((s) => s.setPendingPrompt);

  // 派生：已完成的图列表（一个任务可能返回多张，全部扁平化）
  // useMemo：避免每次 partial 更新都重新 flatMap（仅 done 任务变化才重算）
  const doneImages = useMemo(
    () => [
      ...tasks.flatMap((t) =>
        t.status === "done" && t.results ? t.results.map((src) => ({ key: t.id, src })) : []
      ),
      ...extraResults.map((src, index) => ({ key: `extra-result-${index}`, src })),
    ],
    [tasks, extraResults]
  );

  // 大图预览：用 favoriteId 作为虚拟 imageId（ImageGen 的 src 是直接 URL，非 imageStore id）
  // 进入预览时锁定 imageIds 列表 + cardInfoMap（仿 Assets previewContext 模式），
  // 避免批次流式生成期间 doneImages 变化导致翻页索引错位
  const [previewImageId, setPreviewImageId] = useState<string | null>(null);
  const [previewContext, setPreviewContext] = useState<{
    imageIds: string[];
    cardInfoMap: Map<string, { favoriteId: string; displayIndex: number; src: string }>;
  } | null>(null);
  const [previewCompareActive, setPreviewCompareActive] = useState(false);
  const [favorited, setFavorited] = useState<Set<string>>(new Set());
  const [resultRatios, setResultRatios] = useState<Record<string, number>>({});
  const [polishing, setPolishing] = useState(false);
  const [undoPrompt, setUndoPrompt] = useState<string | null>(null);
  const [generationAdapter, setGenerationAdapter] = useState<ImageGenerationAdapterKind | null>(null);
  const [promptFavoriteDrawerOpen, setPromptFavoriteDrawerOpen] = useState(false);
  const [promptFavoriteSearch, setPromptFavoriteSearch] = useState("");
  const [activePromptFavoriteIds, setActivePromptFavoriteIds] = useState<Record<"text2img" | "img2img", string | null>>({
    text2img: null,
    img2img: null,
  });
  const reduceMotion = useMotionMode();
  // 暂存最近一次批量生成的参数，供整体重试复用
  const lastBatchRef = useRef<{
    finalPrompt: string;
    imagesBase64?: string[];
    baseUrl: string;
    apiKey: string;
    size: string;
    n: number;
    quality?: string;
    historySnapshot: ImageHistorySnapshot;
  } | null>(null);

  // 锁定生成时的 size value，任务进行/完成后切换 size 不影响已渲染格子的尺寸
  const lockedSizeRef = useRef<string | null>(null);

  // 结果区容器实测尺寸，用于动态计算最优网格列数（不溢出视口）
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const [gridDims, setGridDims] = useState({ w: 0, h: 0 });

  const { hasOwnKey } = getEffectiveApiConfig();

  useEffect(() => {
    if (!hasOwnKey) {
      if (n > 1) setN(1);
    }
  }, [hasOwnKey, n, setN]);

  // 监听结果区容器尺寸，用于动态算最优网格列数
  // 依赖 tasks.length：task-grid 渲染后 ref 才可用，effect 重新执行
  // 移动端（reduceMotion）只计算一次，不订阅 resize/ResizeObserver，
  // 避免地址栏伸缩导致卡片大小在上下拖动时持续抖动
  useEffect(() => {
    const el = gridContainerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = window.innerHeight;
      setGridDims((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    update();
    if (reduceMotion) {
      // 移动端：仅一次性计算，不挂载监听
      return;
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [tasks.length, reduceMotion]);

  const currentSize = SIZE_OPTIONS.find((s) => s.value === size);
  const currentStylePreset = STYLE_PRESETS.find((s) => s.id === styleId);
  const currentImg2imgReferenceGuide = IMG2IMG_REFERENCE_GUIDES.find((p) => p.id === img2imgReferenceGuideId);
  const prompt = mode === "img2img" ? imgPrompt : textPrompt;
  const setPrompt = mode === "img2img" ? setImgPrompt : setTextPrompt;
  const firstCompareReferenceImage = mode === "img2img" ? refImages[0] : undefined;
  const currentPromptSourceMode = mode === "img2img" ? "img2img" : "text2img";
  const activePromptFavoriteId = activePromptFavoriteIds[currentPromptSourceMode];
  const activePromptFavorite = activePromptFavoriteId
    ? promptFavorites.find((item) => item.id === activePromptFavoriteId)
    : undefined;
  const promptFavoriteDirty = !!activePromptFavorite && prompt.trim() !== activePromptFavorite.prompt;
  const filteredPromptFavorites = useMemo(() => {
    const q = promptFavoriteSearch.trim().toLowerCase();
    const sorted = [...promptFavorites].sort((a, b) => {
      const aTime = a.lastUsedAt ?? a.updatedAt;
      const bTime = b.lastUsedAt ?? b.updatedAt;
      return bTime - aTime;
    });
    if (!q) return sorted;
    return sorted.filter((item) =>
      item.title.toLowerCase().includes(q) ||
      item.prompt.toLowerCase().includes(q)
    );
  }, [promptFavorites, promptFavoriteSearch]);

  useEffect(() => {
    const existingIds = new Set(promptFavorites.map((item) => item.id));
    setActivePromptFavoriteIds((prev) => ({
      text2img: prev.text2img && !existingIds.has(prev.text2img) ? null : prev.text2img,
      img2img: prev.img2img && !existingIds.has(prev.img2img) ? null : prev.img2img,
    }));
  }, [promptFavorites]);

  useEffect(() => {
    if (previewImageId === null || !firstCompareReferenceImage) {
      setPreviewCompareActive(false);
    }
  }, [firstCompareReferenceImage, previewImageId]);

  // 按住"查看参考图"时，直接替换 antd 预览中 img 的 src 为参考图，松开后恢复原图
  // 相比叠加浮层，此方案保留 antd 预览的框架 UI（工具栏、关闭按钮、左右切换等）
  useEffect(() => {
    if (!previewCompareActive || !firstCompareReferenceImage) return;
    const imgEl = document.querySelector<HTMLImageElement>(".ant-image-preview-img");
    if (!imgEl) return;
    const originalSrc = imgEl.getAttribute("src") ?? "";
    imgEl.setAttribute("src", firstCompareReferenceImage);
    return () => {
      imgEl.setAttribute("src", originalSrc);
    };
  }, [previewCompareActive, firstCompareReferenceImage]);

  function setCurrentActivePromptFavoriteId(id: string | null) {
    setActivePromptFavoriteIds((prev) => ({ ...prev, [currentPromptSourceMode]: id }));
  }

  // prompt 用 ref 镜像，让 toggleFavorite/splitToPsd 等回调不依赖 prompt 字符串变化而重建
  const promptRef = useRef(prompt);
  useEffect(() => { promptRef.current = prompt; }, [prompt]);

  async function handleRefImageFiles(files: FileList) {
    const fileArr = Array.from(files);
    if (!fileArr.length) return;
    const remaining = MAX_REF_IMAGES - refImages.length;
    if (remaining <= 0) {
      message.warning(`最多 ${MAX_REF_IMAGES} 张参考图`);
      return;
    }
    const accepted = fileArr.filter((f) => /^image\/(png|jpeg|webp)$/i.test(f.type));
    const rejected = fileArr.length - accepted.length;
    const toProcess = accepted.slice(0, remaining);
    const overflow = accepted.length - toProcess.length;
    if (rejected) message.error(`${rejected} 张格式不支持，仅支持 PNG/JPEG/WebP`);
    if (overflow) message.warning(`已达上限，仅取前 ${toProcess.length} 张`);
    if (toProcess.length === 0) {
      message.warning("没有可载入的参考图");
      return;
    }

    message.loading({ key: "ref-compress", content: `正在优化 ${toProcess.length} 张参考图...` });
    const newUrls: string[] = [];
    try {
      for (const file of toProcess) {
        const result = await compressImage(file);
        let refBlob = result.blob;
        let refUrl = result.url;
        if (genMode === "greenscreen") {
          refBlob = await flattenImageOnGreen(refBlob);
          URL.revokeObjectURL(result.url);
          refUrl = URL.createObjectURL(refBlob);
        }
        newUrls.push(refUrl);
      }
      const acceptedCount = addRefImages(newUrls);
      const after = useImageGenStore.getState().refImages.length;
      if (acceptedCount === 0) {
        message.warning({
          key: "ref-compress",
          content: `参考图已满，未载入新图片（${after}/${MAX_REF_IMAGES}）`,
        });
        return;
      }
      message.success({
        key: "ref-compress",
        content: `已载入 ${acceptedCount} 张参考图（共 ${after}/${MAX_REF_IMAGES}）`,
      });
    } catch (e) {
      // 失败时 revoke 已生成的 blob URL，避免内存泄漏
      newUrls.forEach((u) => u.startsWith("blob:") && URL.revokeObjectURL(u));
      message.error({ key: "ref-compress", content: "参考图处理失败，请重试" });
    }
  }

  async function handleGenerate() {
    const trimmedPrompt = prompt.trim();
    const stylePreset = STYLE_PRESETS.find((s) => s.id === styleId);
    const styleFragment = stylePreset?.fragment.trim();
    // 图生图模式下，参考约束自带生成指引，即使提示词为空也允许生成
    const hasReferenceGuide = mode === "img2img" && !!currentImg2imgReferenceGuide?.fragment?.trim();
    if (!trimmedPrompt && !styleFragment && !hasReferenceGuide) {
      message.warning("请输入提示词或选择画风");
      return;
    }
    const { baseUrl, apiKey } = getEffectiveApiConfig();
    const effectiveN = hasOwnKey ? n : 1;

    // 调用时注入额外片段，输入框保持干净。
    // 画风片段放到用户提示词之后，避免前置画风削弱用户主语权重。
    const promptParts: string[] = [];
    const tailParts: string[] = [];

    // 根据生成模式构建最终提示词
    // 提示词为空（用户未配置）时回退到默认配置
    if (genMode === "greenscreen") {
      const gs = greenscreenPrompt.trim() || DEFAULT_GREENSCREEN_PROMPT;
      promptParts.push(gs);
    } else if (genMode === "spritesheet") {
      const ss = spritesheetPrompt.trim() || DEFAULT_SPRITESHEET_PROMPT;
      const nn = `${spritesheetN}x${spritesheetN}`;
      // 将提示词模板里的 NxN 占位符替换为实际数值
      const basePrompt = ss.replace(/n\s*x\s*n/gi, nn);
      promptParts.push(`${basePrompt}\n\nGrid: exactly ${nn} (${spritesheetN} rows × ${spritesheetN} columns, ${spritesheetN * spritesheetN} frames total)`);
    }

    if (mode === "img2img" && currentImg2imgReferenceGuide?.fragment) {
      promptParts.push(currentImg2imgReferenceGuide.fragment);
    }
    if (styleFragment) {
      tailParts.push(styleFragment);
    }
    const finalPrompt = [...promptParts, trimmedPrompt, ...tailParts].filter(Boolean).join("\n\n");

    // 图生图需要先把所有参考图转 base64
    let imagesBase64: string[] | undefined;
    if (mode === "img2img") {
      if (!refImages.length) {
        message.warning("请先上传参考图");
        return;
      }
      try {
        imagesBase64 = [];
        for (const refUrl of refImages) {
          const response = await fetch(refUrl);
          let blob = await response.blob();
          if (genMode === "greenscreen") {
            blob = await flattenImageOnGreen(blob);
          }
          imagesBase64.push(await blobToDataUrl(blob));
        }
      } catch {
        message.error("参考图加载失败");
        return;
      }
    }

    await runBatch({
      finalPrompt,
      imagesBase64,
      baseUrl,
      apiKey,
      size,
      n: effectiveN,
      quality,
      historySnapshot: {
        mode: mode === "psd" ? "text2img" : mode,
        prompt,
        size,
        quality,
      },
    });
  }

  // 持久化单张图到历史记录（每张独立一条，n=1）
  const persistTaskHistory = useCallback(async (src: string, snapshot: ImageHistorySnapshot) => {
    const response = await fetch(src);
    const blob = await response.blob();
    const imageId = await setImage(blob);
    const historyItem: HistoryItem = {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "image",
      mode: snapshot.mode,
      prompt: snapshot.prompt,
      model: "gpt-image-2",
      size: snapshot.size,
      n: 1,
      quality: snapshot.quality,
      imageIds: [imageId],
      status: "completed",
      createdAt: Date.now(),
    };
    addHistory(historyItem);
  }, [addHistory]);

  // 发起一次 n=N 单请求批次，后端线程池内部并行。
  // 入口职责：清空旧批次、初始化 UI 状态、提交、轮询、回调与软超时。
  const runBatch = useCallback(async (params: {
    finalPrompt: string;
    imagesBase64?: string[];
    baseUrl: string;
    apiKey: string;
    size: string;
    n: number;
    quality?: string;
    historySnapshot: ImageHistorySnapshot;
  }) => {
    abortActiveBatch();
    clearPendingImageBatch();
    setError(null);
    setFavorited(new Set());
    setGenerationAdapter(null);
    lockedSizeRef.current = params.size;
    lastBatchRef.current = params;

    const batchId = ++batchSeq;
    const batchCreatedAt = Date.now();
    const controller = new AbortController();
    resetTasks(params.n);
    const clientTaskIds = new Map<string, number>();
    const completedTaskIndexes = new Set<number>();
    const persistCurrentTaskBatch = () => {
      const b = activeBatch;
      if (!b || b.id !== batchId || b.adapter !== "task") return;
      const taskSnapshots = useImageGenStore
        .getState()
        .tasks
        .filter((task) => task.status !== "done")
        .map((task) => ({
          globalIndex: task.index + 1,
          status: task.status as Exclude<TaskStatus, "done">,
          progress: task.progress,
          error: task.error,
        }));
      writePendingImageBatch({
        version: PENDING_IMAGE_BATCH_VERSION,
        id: batchId,
        createdAt: batchCreatedAt,
        updatedAt: Date.now(),
        baseUrl: params.baseUrl,
        apiKey: params.apiKey,
        n: params.n,
        size: params.size,
        quality: params.quality,
        historySnapshot: params.historySnapshot,
        clientTaskIds: [...clientTaskIds].map(([taskId, globalIndex]) => ({ taskId, globalIndex })),
        taskSnapshots,
      });
    };
    const forgetClientTask = (globalIndex: number) => {
      for (const [taskId, index] of [...clientTaskIds]) {
        if (index === globalIndex) clientTaskIds.delete(taskId);
      }
    };
    const handleTaskResult = (taskIndex: number, images: string[]) => {
      if (!isActiveBatch(batchId) || completedTaskIndexes.has(taskIndex)) return;
      completedTaskIndexes.add(taskIndex);
      updateTask(taskIndex, { status: "done", results: images, progress: undefined, error: undefined });
      images.forEach((src) => persistTaskHistory(src, params.historySnapshot).catch(() => message.warning("历史记录保存失败")));
      forgetClientTask(taskIndex + 1);
      persistCurrentTaskBatch();
    };
    const handleTaskError = (taskIndex: number, err: string) => {
      if (!isActiveBatch(batchId) || completedTaskIndexes.has(taskIndex)) return;
      completedTaskIndexes.add(taskIndex);
      updateTask(taskIndex, { status: "error", error: err, progress: undefined });
      forgetClientTask(taskIndex + 1);
      persistCurrentTaskBatch();
    };
    activeBatch = {
      id: batchId,
      controller,
      softTimeoutId: window.setTimeout(() => {
        if (!isActiveBatch(batchId)) return;
        useImageGenStore.getState().tasks.forEach((task) => {
          if (task.status === "pending" || task.status === "loading") {
            updateTask(task.index, { status: "waiting" });
          }
        });
        setLoading(false);
        message.warning("生成仍在等待，你可以继续等结果，或直接开始下一次生成");
      }, IMAGE_GEN_SOFT_TIMEOUT_MS),
      clientTaskIds,
      handleTaskResult,
      handleTaskError,
      adapter: null,
      apiConfig: { baseUrl: params.baseUrl, apiKey: params.apiKey },
    };

    setLoading(true);
    try {
      await imageGenerationClient.submitBatch(
        {
          prompt: params.finalPrompt,
          model: "gpt-image-2",
          size: params.size,
          n: params.n,
          quality: params.quality,
          baseUrl: params.baseUrl,
          apiKey: params.apiKey,
          images: params.imagesBase64,
          adapter: imageGenAdapter,
        },
        {
          onAdapterResolved: (adapter) => {
            const b = activeBatch;
            if (!b || b.id !== batchId) return;
            b.adapter = adapter;
            setGenerationAdapter(adapter);
            if (adapter === "direct") {
              // 直连模式不持久化批次，无法断线恢复
              clearPendingImageBatch(batchId);
            } else {
              persistCurrentTaskBatch();
            }
          },
          onTaskSubmit: (globalIndex, taskId) => {
            if (!isActiveBatch(batchId)) return;
            clientTaskIds.set(taskId, globalIndex);
            persistCurrentTaskBatch();
          },
          onTaskProgress: (text) => {
            if (!isActiveBatch(batchId)) return;
            useImageGenStore.getState().tasks.forEach((task) => {
              if (task.status === "pending" || task.status === "loading") {
                updateTask(task.index, { status: "loading", progress: text });
              }
            });
            persistCurrentTaskBatch();
          },
          onTaskResult: (taskIndex, images) => {
            handleTaskResult(taskIndex, images);
          },
          onExtraResult: (src) => {
            if (!isActiveBatch(batchId)) return;
            addExtraResult(src);
            persistTaskHistory(src, params.historySnapshot).catch(() => message.warning("历史记录保存失败"));
          },
          onTaskError: (taskIndex, err) => {
            handleTaskError(taskIndex, err);
          },
          onAllDone: ({ ok, fail, extra }) => {
            if (!isActiveBatch(batchId)) return;
            clearBatchTimer();
            activeBatch = null;
            clearPendingImageBatch(batchId);
            setLoading(false);
            const totalOk = ok + extra;
            if (totalOk > 0) {
              message.success(`生成完成 ${totalOk} 张${fail > 0 ? `，失败 ${fail} 张` : ""}`);
            } else if (fail > 0) {
              setError(`全部失败 ${fail} 张`);
              message.error(`全部失败 ${fail} 张`);
            }
          },
        },
        { signal: controller.signal }
      );
    } catch (e) {
      if (!isActiveBatch(batchId)) return;
      const err = String((e as Error).message || e || "生成失败");
      clearBatchTimer();
      clearPendingImageBatch(batchId);
      activeBatch = null;
      useImageGenStore.getState().tasks.forEach((task) => {
        if (task.status === "pending" || task.status === "loading" || task.status === "waiting") {
          updateTask(task.index, { status: "error", error: err, progress: undefined });
        }
      });
      setError(err);
      message.error(err);
    }
  }, [persistTaskHistory, message, updateTask, addExtraResult, resetTasks, setLoading, setError, imageGenAdapter, setFavorited, setGenerationAdapter]);

  // 整体重试：后端 n=N 为整体请求，无法单独重试某张，此处重新发起整批
  const retryTask = useCallback(async (_index: number) => {
    const last = lastBatchRef.current;
    if (!last) {
      message.warning("参数已失效，请重新生成");
      return;
    }
    await runBatch(last);
  }, [runBatch, message]);

  // 停止当前批次：abort、清空运行时标记、把未完成任务标 error
  const handleStop = useCallback(() => {
    abortActiveBatch();
    clearPendingImageBatch();
    setLoading(false);
    useImageGenStore.getState().tasks.forEach((task) => {
      if (task.status === "pending" || task.status === "loading" || task.status === "waiting") {
        updateTask(task.index, { status: "error", error: "用户停止任务", progress: undefined });
      }
    });
    message.info("已停止任务");
  }, [updateTask, message, setLoading]);

  const resumePersistedTaskBatch = useCallback(async () => {
    if (activeBatch) {
      setLoading(true);
      return;
    }

    const saved = readPendingImageBatch();
    if (!saved) return;

    // 持久化的批次必然来自任务模式；若用户已切换到直连模式则不再尝试恢复
    if (imageGenAdapter !== "task") {
      clearPendingImageBatch(saved.id);
      return;
    }

    const batchId = ++batchSeq;
    const controller = new AbortController();
    const clientTaskIds = new Map(saved.clientTaskIds.map((item) => [item.taskId, item.globalIndex] as const));
    if (clientTaskIds.size === 0) {
      clearPendingImageBatch(saved.id);
      return;
    }

    const completedTaskIndexes = new Set<number>();
    const handleTaskResult = (taskIndex: number, images: string[]) => {
      if (!isActiveBatch(batchId) || completedTaskIndexes.has(taskIndex)) return;
      completedTaskIndexes.add(taskIndex);
      updateTask(taskIndex, { status: "done", results: images, progress: undefined, error: undefined });
      images.forEach((src) => persistTaskHistory(src, saved.historySnapshot).catch(() => message.warning("历史记录保存失败")));
      removePendingImageTask(saved.id, taskIndex + 1);
    };
    const handleTaskError = (taskIndex: number, err: string) => {
      if (!isActiveBatch(batchId) || completedTaskIndexes.has(taskIndex)) return;
      completedTaskIndexes.add(taskIndex);
      updateTask(taskIndex, { status: "error", error: err, progress: undefined });
      removePendingImageTask(saved.id, taskIndex + 1);
    };

    const ensureTaskPlaceholders = () => {
      const existingTasks = useImageGenStore.getState().tasks;
      const requiredCount = Math.max(saved.n, existingTasks.length);
      const byIndex = new Map(existingTasks.map((task) => [task.index, task] as const));
      let changed = existingTasks.length === 0;
      const baseTs = Date.now();

      for (let index = 0; index < requiredCount; index += 1) {
        if (byIndex.has(index)) continue;
        byIndex.set(index, {
          id: `resume-${saved.id}-${index}`,
          index,
          status: "pending" as TaskStatus,
          startedAt: baseTs,
        });
        changed = true;
      }

      if (changed) {
        setTasks([...byIndex.values()].sort((a, b) => a.index - b.index));
      }
    };

    ensureTaskPlaceholders();
    saved.taskSnapshots.forEach((snapshot) => {
      updateTask(snapshot.globalIndex - 1, {
        status: snapshot.status,
        progress: snapshot.progress,
        error: snapshot.error,
      });
    });
    setError(null);
    setGenerationAdapter("task");
    lockedSizeRef.current = saved.size;
    setLoading(true);

    // 任务模式：软超时以批次创建时刻为起点计算剩余时间，
    // 避免长时间挂起浏览器后恢复仍要等满整段软超时
    const elapsed = Date.now() - saved.createdAt;
    const remainingSoftMs = IMAGE_GEN_SOFT_TIMEOUT_MS - elapsed;
    const triggerSoftTimeout = () => {
      if (!isActiveBatch(batchId)) return;
      useImageGenStore.getState().tasks.forEach((task) => {
        if (task.status === "pending" || task.status === "loading") {
          updateTask(task.index, { status: "waiting" });
        }
      });
      setLoading(false);
      message.warning("恢复的任务仍在等待，你可以继续等结果，或直接开始下一次生成");
    };
    const softTimeoutId =
      remainingSoftMs <= 0
        ? window.setTimeout(triggerSoftTimeout, 0)
        : window.setTimeout(triggerSoftTimeout, remainingSoftMs);

    activeBatch = {
      id: batchId,
      controller,
      softTimeoutId,
      clientTaskIds,
      handleTaskResult,
      handleTaskError,
      adapter: "task",
      apiConfig: { baseUrl: saved.baseUrl, apiKey: saved.apiKey },
    };
    if (remainingSoftMs <= 0) {
      message.warning("上次任务已超过软超时，可直接开始下一次生成");
    } else {
      message.info("正在恢复上次未完成的生图任务");
    }

    try {
      await imageGenerationClient.resumeTasks(
        saved.clientTaskIds,
        { baseUrl: saved.baseUrl, apiKey: saved.apiKey },
        {
          onTaskProgress: (taskIndex, text) => {
            if (!isActiveBatch(batchId)) return;
            updateTask(taskIndex, { status: "loading", progress: text });
          },
          onTaskResult: (taskIndex, images) => handleTaskResult(taskIndex, images),
          onTaskError: (taskIndex, err) => handleTaskError(taskIndex, err),
          onAllDone: ({ ok, fail }) => {
            if (!isActiveBatch(batchId)) return;
            clearBatchTimer();
            activeBatch = null;
            clearPendingImageBatch(saved.id);
            setLoading(false);
            if (ok > 0) {
              message.success(`已恢复完成 ${ok} 张${fail > 0 ? `，失败 ${fail} 张` : ""}`);
            } else if (fail > 0) {
              setError(`恢复任务失败 ${fail} 张`);
            }
          },
        },
        { signal: controller.signal }
      );
    } catch {
      // 静默：resumeTasks 内部已处理取消与 abort
    }
  }, [message, persistTaskHistory, setError, setLoading, setTasks, updateTask, imageGenAdapter]);

  useEffect(() => {
    void resumePersistedTaskBatch();
  }, [resumePersistedTaskBatch]);

  // 页面回前台时立即查询任务状态，弥补后台 fetch 被中断导致的状态丢失
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== "visible") return;
      const batch = activeBatch;
      if (!batch || batch.clientTaskIds.size === 0) return;
      try {
        await imageGenerationClient.refreshTasks(
          [...batch.clientTaskIds].map(([taskId, globalIndex]) => ({ taskId, globalIndex })),
          batch.apiConfig,
          {
            onTaskProgress: (taskIndex, text) => {
              if (!isActiveBatch(batch.id)) return;
              updateTask(taskIndex, { status: "loading", progress: text });
            },
            onTaskResult: (taskIndex, images) => {
              if (isActiveBatch(batch.id)) batch.handleTaskResult(taskIndex, images);
            },
            onTaskError: (taskIndex, err) => {
              if (isActiveBatch(batch.id)) batch.handleTaskError(taskIndex, err);
            },
          }
        );
      } catch {
        // 静默，imageGenerationClient 内部轮询会处理
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [updateTask]);

  // 下面所有传给 TaskCard 的回调均 useCallback 稳定化，保证 TaskCard memo 生效
  const sendToMatte = useCallback(async (src: string) => {
    try {
      const cachedSrc = await cacheImageLocally(src);
      setIncomingImage({ src: cachedSrc, from: "image-gen" });
      navigate("/matte");
    } catch {
      message.error("图片缓存失败");
    }
  }, [setIncomingImage, navigate, message]);

  const sendToSuperRes = useCallback(async (src: string) => {
    try {
      const cachedSrc = await cacheImageLocally(src);
      // PNG → JPEG：减小输入体积加速推理，移除 alpha 通道（超分对纯 RGB 更友好）
      const jpegUrl = await pngToJpegUrl(cachedSrc);
      setIncomingImage({ src: jpegUrl, from: "image-gen" });
      navigate("/image-tools?tool=superres");
    } catch {
      message.error("图片处理失败");
    }
  }, [setIncomingImage, navigate, message]);

  const downloadImage = useCallback(async (src: string) => {
    try {
      const cachedSrc = await cacheImageLocally(src);
      const response = await fetch(cachedSrc);
      const blob = await response.blob();
      downloadBlob(blob, `gpt-image-${Date.now()}.png`);
    } catch {
      message.error("下载失败");
    }
  }, [message]);

  // favorited 用 ref 镜像，避免 toggleFavorite 依赖 favorited 导致回调每次收藏变化都重建
  const favoritedRef = useRef(favorited);
  useEffect(() => { favoritedRef.current = favorited; }, [favorited]);

  const toggleFavorite = useCallback(async (taskId: string, src: string, displayIndex: number) => {
    const current = favoritedRef.current;
    const isFavorited = current.has(taskId);
    if (isFavorited) {
      const next = new Set(current);
      next.delete(taskId);
      setFavorited(next);
    } else {
      const next = new Set(current);
      next.add(taskId);
      setFavorited(next);
      try {
        const blob = await (await fetch(src)).blob();
        const imageId = await setImage(blob);
        addAsset({
          id: `asset-${Date.now()}-${taskId}`,
          name: `${promptRef.current.slice(0, 20) || "生成图"}_${displayIndex + 1}`,
          type: "image",
          imageId,
          tags: ["AI生成", mode],
          metadata: {
            taskId,
            size: size === "auto" ? undefined : Number(size),
          },
          createdAt: Date.now(),
        });
      } catch {
        message.error("收藏失败");
      }
    }
  }, [addAsset, message, mode, size]);

  const editImage = useCallback(async (src: string) => {
    try {
      const cachedSrc = await cacheImageLocally(src);
      setMode("img2img");
      // 追加到已有参考图末尾，避免覆盖用户已上传的参考图；满额时提示
      if (refImages.length >= MAX_REF_IMAGES) {
        // 满额时 revoke 刚创建的 blob URL，避免泄漏
        if (cachedSrc.startsWith("blob:")) URL.revokeObjectURL(cachedSrc);
        message.warning(`参考图已满（${refImages.length}/${MAX_REF_IMAGES}），无法继续添加`);
        return;
      }
      const accepted = addRefImages([cachedSrc]);
      const total = useImageGenStore.getState().refImages.length;
      if (accepted > 0) {
        message.info(`已追加为图生图参考图（共 ${total}/${MAX_REF_IMAGES}）`);
      } else {
        // 兜底：addRefImages 未接受时 revoke，避免泄漏
        if (cachedSrc.startsWith("blob:")) URL.revokeObjectURL(cachedSrc);
        message.warning(`参考图已满（${total}/${MAX_REF_IMAGES}），无法继续添加`);
      }
    } catch {
      message.error("图片加载失败");
    }
  }, [setMode, addRefImages, refImages.length, message]);

  // 拆分为 PSD：将结果图转为 data URL，预填到 PSD 任务表单并切换 tab
  const splitToPsd = useCallback(async (src: string) => {
    try {
      const dataUrl = await toDataUrl(src);
      const p = promptRef.current;
      setPsdPendingImages([dataUrl]);
      setPsdPendingPrompt(p ? `基于以下参考图拆分为可编辑的 PSD 图层：\n${p}` : "将这张图片拆分为可编辑的 PSD 图层，保留文字、形状、图层结构");
      setMode("psd");
      message.success("已切换到 PSD 任务，参考图已载入");
    } catch {
      message.error("图片读取失败，无法拆分为 PSD");
    }
  }, [setPsdPendingImages, setPsdPendingPrompt, setMode, message]);

  // resultRatios 更新：用函数式 setState，回调本身稳定
  const handleResultRatio = useCallback((favoriteId: string, ratio: number) => {
    setResultRatios((prev) => (
      Math.abs((prev[favoriteId] ?? 0) - ratio) < 0.001
        ? prev
        : { ...prev, [favoriteId]: ratio }
    ));
  }, []);
  // 历史遗留：handleResultRatio 待后续接入，此处引用以通过 noUnusedLocals
  void handleResultRatio;

  async function handlePolish() {
    if (!prompt.trim()) {
      message.warning("请输入提示词");
      return;
    }
    setPolishing(true);
    try {
      const { baseUrl, apiKey } = getEffectiveApiConfig();
      const styleFragment = STYLE_PRESETS.find((s) => s.id === styleId)?.fragment;
      const polished = await polishPrompt({ baseUrl, apiKey, prompt, styleFragment });
      setUndoPrompt(prompt);
      setPrompt(polished);
      message.success("已应用 AI 润色结果");
    } catch (e) {
      message.error(String((e as Error).message) || "AI 润色失败");
    } finally {
      setPolishing(false);
    }
  }

  function undoPolish() {
    if (undoPrompt !== null) {
      setPrompt(undoPrompt);
      setUndoPrompt(null);
      message.info("已恢复原提示词");
    }
  }

  function getCurrentPromptSourceMode() {
    return mode === "img2img" ? "img2img" : "text2img";
  }

  function handleSaveCurrentPromptFavorite() {
    const trimmed = prompt.trim();
    if (!trimmed) {
      message.warning("请输入提示词");
      return;
    }
    const duplicate = findDuplicatePromptFavorite(trimmed);
    if (duplicate) {
      setCurrentActivePromptFavoriteId(duplicate.id);
      message.info("已关联到已有提示词收藏");
      return;
    }
    const item = addPromptFavorite({
      title: createPromptFavoriteTitle(trimmed),
      prompt: trimmed,
      sourceMode: getCurrentPromptSourceMode(),
      genMode,
      styleId,
    });
    setCurrentActivePromptFavoriteId(item.id);
    message.success("已收藏当前提示词");
  }

  function handleUsePromptFavorite(item: PromptFavorite) {
    if (prompt !== item.prompt) {
      setUndoPrompt(prompt);
    }
    setPrompt(item.prompt);
    setCurrentActivePromptFavoriteId(item.id);
    markPromptFavoriteUsed(item.id);
    setPromptFavoriteDrawerOpen(false);
    message.success("已替换为收藏提示词");
  }

  function handleUpdateActivePromptFavorite() {
    if (!activePromptFavorite) return;
    const trimmed = prompt.trim();
    if (!trimmed) {
      message.warning("请输入提示词");
      return;
    }
    updatePromptFavorite(activePromptFavorite.id, {
      prompt: trimmed,
      sourceMode: getCurrentPromptSourceMode(),
      genMode,
      styleId,
    });
    message.success("已更新当前收藏");
  }

  function handleSavePromptFavoriteAsNew() {
    const trimmed = prompt.trim();
    if (!trimmed) {
      message.warning("请输入提示词");
      return;
    }
    const item = addPromptFavorite({
      title: createPromptFavoriteTitle(trimmed),
      prompt: trimmed,
      sourceMode: getCurrentPromptSourceMode(),
      genMode,
      styleId,
    });
    setCurrentActivePromptFavoriteId(item.id);
    message.success("已另存为新收藏");
  }

  function handleDeletePromptFavorite(id: string) {
    removePromptFavorite(id);
    if (activePromptFavoriteId === id) setCurrentActivePromptFavoriteId(null);
    message.info("已删除提示词收藏");
  }

  function handleRenamePromptFavorite(id: string, title: string) {
    updatePromptFavorite(id, { title });
  }

  /* ============================================================
   * 派生：cards 数组（done 任务的多张图各占一个卡片）
   * 与 gridLayout（最优列数/行数/每格最大高度）
   * 均 useMemo 化：流式 partial 更新时只有 task 引用变化，
   * 但 tasks 数组引用也会随之变化 → 仍会重算 cards。
   * 不过 cards 计算只是浅遍历，远比重建全部内联 JSX 便宜；
   * 真正的重渲染隔离由 TaskCard memo 完成。
   * ============================================================ */
  type CardEntry = {
    key: string;
    task: GenTask;
    status: TaskStatus;
    src?: string;
    favoriteId: string;
    doneIdx?: number;
    isExtra?: boolean;
  };

  const cards = useMemo<CardEntry[]>(() => {
    if (tasks.length === 0 && extraResults.length === 0) return [];
    const result: CardEntry[] = [];
    let doneCounter = 0;
    tasks.forEach((task) => {
      if (task.status === "done" && task.results && task.results.length > 0) {
        task.results.forEach((src, subIdx) => {
          result.push({
            key: `${task.id}-${subIdx}`,
            task,
            status: "done",
            src,
            favoriteId: `${task.id}-${subIdx}`,
            doneIdx: doneCounter++,
          });
        });
      } else {
        result.push({
          key: task.id,
          task,
          status: task.status,
          favoriteId: task.id,
        });
      }
    });
    extraResults.forEach((src, index) => {
      const taskIndex = tasks.length + index;
      const extraTask: GenTask = {
        id: `extra-result-${index}`,
        index: taskIndex,
        status: "done",
        results: [src],
        startedAt: 0,
      };
      result.push({
        key: extraTask.id,
        task: extraTask,
        status: "done",
        src,
        favoriteId: extraTask.id,
        doneIdx: doneCounter++,
        isExtra: true,
      });
    });
    return result;
  }, [tasks, extraResults]);

  // 打开大图预览：以 favoriteId 为虚拟 imageId，进入时快照 imageIds 列表 + cardInfoMap
  // 锁定列表避免批次流式生成期间 doneImages 变化导致翻页索引错位
  const openPreview = useCallback((favoriteId: string) => {
    const imageIds: string[] = [];
    const cardInfoMap = new Map<string, { favoriteId: string; displayIndex: number; src: string }>();
    let displayCounter = 0;
    cards.forEach((c) => {
      if (c.doneIdx !== undefined && c.src) {
        const id = c.favoriteId;
        imageIds.push(id);
        cardInfoMap.set(id, { favoriteId: id, displayIndex: displayCounter++, src: c.src });
      }
    });
    setPreviewContext({ imageIds, cardInfoMap });
    setPreviewImageId(favoriteId);
  }, [cards]);

  // 进入预览后，批次生成期间新到达的 done 图按到达顺序追加到 previewContext 末尾。
  // 已锁定图的位置数字（displayIndex）不变，新图 displayIndex 从现有列表长度起算。
  // 与 Assets.tsx 删除时增量剔除 previewContext 的模式对称。
  useEffect(() => {
    if (!previewContext) return;
    const existing = new Set(previewContext.imageIds);
    const additions: Array<{ id: string; src: string; displayIndex: number }> = [];
    let nextDisplayIndex = previewContext.imageIds.length;
    for (const c of cards) {
      if (c.doneIdx !== undefined && c.src && !existing.has(c.favoriteId)) {
        additions.push({ id: c.favoriteId, src: c.src, displayIndex: nextDisplayIndex++ });
      }
    }
    if (additions.length === 0) return;
    setPreviewContext((prev) => {
      if (!prev) return prev;
      const nextMap = new Map(prev.cardInfoMap);
      additions.forEach((a) => {
        nextMap.set(a.id, { favoriteId: a.id, displayIndex: a.displayIndex, src: a.src });
      });
      return {
        imageIds: [...prev.imageIds, ...additions.map((a) => a.id)],
        cardInfoMap: nextMap,
      };
    });
  }, [cards, previewContext]);

  // 当前预览图对应的已收藏素材：基于 previewImageId（即 favoriteId）匹配 asset
  // 仅当该图已收藏且 asset 存在时有效，用于驱动分组 Tab 显示与移动
  const currentPreviewAsset = useMemo(() => {
    if (previewImageId === null) return undefined;
    return assetItems.find((a) => a.metadata.taskId === previewImageId);
  }, [previewImageId, assetItems]);

  // 切换预览图回调：重置"按住查看参考图"状态，避免跨图状态串扰
  const handleImageChange = useCallback((nextId: string) => {
    setPreviewCompareActive(false);
    setPreviewImageId(nextId);
  }, []);

  // 关闭预览回调：清理所有预览状态
  const handleClosePreview = useCallback(() => {
    setPreviewCompareActive(false);
    setPreviewImageId(null);
    setPreviewContext(null);
  }, []);

  // 大图预览工具栏 actions：按当前 previewImageId 派生 cardInfo 后组装
  // 通过 actions prop 注入通用组件 ImagePreviewWithToolbar，跳过其内部默认 actions 组装
  const previewActions = useMemo<ImagePreviewAction[] | undefined>(() => {
    if (previewImageId === null || !previewContext) return undefined;
    const cardInfo = previewContext.cardInfoMap.get(previewImageId);
    if (!cardInfo) return undefined;

    const actions: ImagePreviewAction[] = [
      {
        key: "favorite",
        title: favorited.has(cardInfo.favoriteId) ? "取消收藏" : "收藏",
        icon: favorited.has(cardInfo.favoriteId) ? <StarFilled /> : <StarOutlined />,
        active: favorited.has(cardInfo.favoriteId),
        onClick: () => toggleFavorite(cardInfo.favoriteId, cardInfo.src, cardInfo.displayIndex),
      },
      {
        key: "img2img",
        title: "用作图生图参考图",
        icon: <FileImageOutlined />,
        onClick: () => editImage(cardInfo.src),
      },
    ];

    if (genMode === "greenscreen") {
      actions.push({
        key: "matte",
        title: "送入抠图",
        icon: <ScissorOutlined />,
        onClick: () => sendToMatte(cardInfo.src),
      });
    }

    actions.push(
      {
        key: "psd",
        title: "拆分为 PSD",
        icon: <BlockOutlined />,
        onClick: () => splitToPsd(cardInfo.src),
      },
      {
        key: "superres",
        title: "超分 4K（本地）",
        icon: <ThunderboltOutlined />,
        onClick: () => sendToSuperRes(cardInfo.src),
      },
      {
        key: "download",
        title: "下载",
        icon: <DownloadOutlined />,
        onClick: () => downloadImage(cardInfo.src),
      },
    );

    if (firstCompareReferenceImage) {
      actions.unshift({
        key: "compare-reference",
        title: "按住查看第一张参考图",
        icon: <EyeOutlined />,
        pressed: previewCompareActive,
        onPointerDown: () => setPreviewCompareActive(true),
        onPointerUp: () => setPreviewCompareActive(false),
        onPointerLeave: () => setPreviewCompareActive(false),
        onPointerCancel: () => setPreviewCompareActive(false),
      });
    }

    return actions;
  }, [
    previewImageId,
    previewContext,
    favorited,
    genMode,
    firstCompareReferenceImage,
    previewCompareActive,
    toggleFavorite,
    editImage,
    sendToMatte,
    splitToPsd,
    sendToSuperRes,
    downloadImage,
  ]);

  const gridLayout = useMemo(() => {
    if (cards.length === 0) {
      return { cols: 1, rows: 1, cellMaxHpx: 80, cellMaxH: "80px", aspectRatio: "1 / 1", imgRatio: 1 };
    }
    // size 锁定为生成时的值，任务开始后切换 size 不影响格子尺寸
    const lockedSize = lockedSizeRef.current
      ? SIZE_OPTIONS.find((s) => s.value === lockedSizeRef.current)
      : currentSize;
    const imgRatio =
      lockedSize && lockedSize.tier !== "auto"
        ? lockedSize.w / lockedSize.h
        : 1;
    const GAP = 12;
    const CARD_OVERHEAD = 46; // card header(24) + padding(22)
    const RESERVED_H = 220;  // 顶栏 + Card title + body padding 估值
    const availH = Math.max(200, gridDims.h - RESERVED_H);
    const cols = gridDims.w > 0
      ? computeOptimalCols(cards.length, gridDims.w, availH, imgRatio, GAP, CARD_OVERHEAD)
      : 1;
    const rows = Math.ceil(cards.length / cols);
    const cellMaxHpx = computeCellMaxH(availH, rows, GAP, CARD_OVERHEAD);
    const aspectRatio =
      lockedSize && lockedSize.tier !== "auto"
        ? `${lockedSize.w} / ${lockedSize.h}`
        : "1 / 1";
    return {
      cols,
      rows,
      cellMaxHpx,
      cellMaxH: `${cellMaxHpx}px`,
      aspectRatio,
      imgRatio,
    };
  }, [cards, gridDims, currentSize]);
  // 历史遗留：gridLayout 待后续接入，此处引用以通过 noUnusedLocals
  void gridLayout;

  return (
    <div className="image-gen-page" style={{ maxWidth: 1440, margin: "0 auto" }}>
      <PageHeader
        title="AI 生图"
        description="基于 OpenAI gpt-image-2 的文生图与图生图。生成结果可一键送入抠图或拆分为 PSD。"
        icon={<PictureOutlined />}
      />

      <Segmented
        value={mode}
        onChange={(v) => setMode(v as typeof mode)}
        block
        options={[
          { label: "文生图", value: "text2img" },
          { label: "图生图", value: "img2img" },
          { label: "PSD任务", value: "psd" },
        ]}
        style={{ marginBottom: 12, maxWidth: 360 }}
      />

      {mode === "psd" ? (
        <PsdTaskPanel />
      ) : (
        <>
      <Row gutter={16}>
        <Col xs={24} lg={10} xl={9} xxl={8}>
          <Card style={{ background: "#18181b", borderColor: "#27272a" }} styles={{ body: { padding: 18 } }}>
            <Segmented
              value={genMode}
              onChange={(v) => setGenMode(v as typeof genMode)}
              block
              size="small"
              options={[
                { label: "普通", value: "normal" },
                { label: "绿幕", value: "greenscreen" },
                { label: "序列帧", value: "spritesheet" },
              ]}
              style={{ marginBottom: 16 }}
            />
            {genMode !== "normal" && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12, fontSize: 12 }}
                message={
                  genMode === "greenscreen"
                    ? "绿幕模式：自动在提示词前插入纯绿背景要求"
                    : `序列帧模式：自动在提示词前插入 ${spritesheetN}x${spritesheetN} 网格序列帧要求，生成完毕后自动拆分并预览动画`
                }
              />
            )}
            {genMode === "spritesheet" && (
              <Form.Item label={`序列帧网格 N×N（N=${spritesheetN}，共 ${spritesheetN * spritesheetN} 帧）`}>
                <Slider
                  min={2}
                  max={8}
                  value={spritesheetN}
                  onChange={setSpritesheetN}
                  marks={{ 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8" }}
                />
              </Form.Item>
            )}
            <Form layout="vertical">
              {mode === "img2img" && (
                <Form.Item label={`参考图 (${refImages.length}/${MAX_REF_IMAGES})`} className="reference-image-field">
                  {refImages.length === 0 ? (
                    <div className="reference-image-empty">
                      <FileUploadTrigger
                        accept="image/png,image/jpeg,image/webp"
                        variant="dropzone"
                        multiple
                        label="上传参考图"
                        hint={(
                          <>
                            点击、拖拽或 <span className="reference-image-kbd">Ctrl+V</span> 粘贴，支持多选，PNG / JPEG / WebP
                          </>
                        )}
                        icon={<InboxOutlined />}
                        onFiles={handleRefImageFiles}
                      />
                    </div>
                  ) : (
                    <div className="reference-images-grid">
                      {refImages.map((url, i) => (
                        <div className="reference-image-cell" key={`${i}-${url.slice(-32)}`}>
                          <img src={url} alt={`参考图 ${i + 1}`} className="reference-image-thumb" />
                          <button
                            type="button"
                            className="reference-image-remove"
                            title="移除"
                            onClick={() => removeRefImage(i)}
                          >
                            <DeleteOutlined />
                          </button>
                          <span className="reference-image-index">{i + 1}</span>
                        </div>
                      ))}
                      {refImages.length < MAX_REF_IMAGES && (
                        <div className="reference-image-add-cell">
                          <FileUploadTrigger
                            accept="image/png,image/jpeg,image/webp"
                            variant="dropzone"
                            multiple
                            label="添加"
                            icon={<PlusOutlined />}
                            onFiles={handleRefImageFiles}
                          />
                        </div>
                      )}
                      <div className="reference-images-actions">
                        <Button size="small" danger icon={<DeleteOutlined />} onClick={clearRefImages}>
                          全部清空
                        </Button>
                      </div>
                    </div>
                  )}
                </Form.Item>
              )}
              <div className="prompt-editor-field">
                <div className="prompt-editor-head">
                  <span className="prompt-editor-label">
                    <Text className="prompt-editor-required">*</Text>
                    <Text className="prompt-editor-title">提示词</Text>
                  </span>
                  <div className="prompt-editor-actions">
                    {undoPrompt !== null && (
                      <Button
                        size="small"
                        type="link"
                        title="撤销润色"
                        aria-label="撤销润色"
                        onClick={undoPolish}
                        style={{ padding: "0 4px", fontSize: 12, height: 24 }}
                      >
                        撤销
                      </Button>
                    )}
                    <Button
                      size="small"
                      icon={<PlusOutlined />}
                      title="收藏当前"
                      aria-label="收藏当前"
                      onClick={handleSaveCurrentPromptFavorite}
                    >
                      收藏当前
                    </Button>
                    <Button
                      size="small"
                      icon={<BookOutlined />}
                      title="选择收藏"
                      aria-label="选择收藏"
                      onClick={() => setPromptFavoriteDrawerOpen(true)}
                    >
                      选择收藏
                    </Button>
                    <Button
                      size="small"
                      icon={<ThunderboltOutlined />}
                      loading={polishing}
                      title="AI 润色"
                      aria-label="AI 润色"
                      onClick={handlePolish}
                    >
                      AI 润色
                    </Button>
                  </div>
                </div>
                <TextArea
                  rows={6}
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    setUndoPrompt(null);
                  }}
                  placeholder="一只在窗台上看雨的橘猫，胶片质感，柔和光线"
                  style={{ resize: "vertical" }}
                />
                {activePromptFavorite && (
                  <div className={`prompt-favorite-status${promptFavoriteDirty ? " is-dirty" : ""}`}>
                    <div className="prompt-favorite-status-copy">
                      <BookOutlined />
                      <span>正在使用收藏：{activePromptFavorite.title}</span>
                      <Tag color={promptFavoriteDirty ? "gold" : "green"} style={{ marginInlineEnd: 0 }}>
                        {promptFavoriteDirty ? "已修改" : "已同步"}
                      </Tag>
                    </div>
                    <Space size={6} wrap>
                      {promptFavoriteDirty && (
                        <Button
                          size="small"
                          type="primary"
                          icon={<SaveOutlined />}
                          onClick={handleUpdateActivePromptFavorite}
                        >
                          更新收藏
                        </Button>
                      )}
                      <Button size="small" onClick={handleSavePromptFavoriteAsNew}>
                        另存为
                      </Button>
                      <Button size="small" type="text" onClick={() => setCurrentActivePromptFavoriteId(null)}>
                        断开关联
                      </Button>
                    </Space>
                  </div>
                )}
              </div>

              {mode === "img2img" && (
                <div className="imagegen-preset-section">
                  <div className="imagegen-preset-head">
                    <Text className="imagegen-preset-title">参考约束</Text>
                    <Text className="imagegen-preset-desc">
                      {currentImg2imgReferenceGuide?.description ?? "选择生成时自动注入的参考图约束"}
                    </Text>
                  </div>
                  <div className="imagegen-preset-options">
                    {IMG2IMG_REFERENCE_GUIDES.map((p) => {
                      const active = p.id === img2imgReferenceGuideId;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className={`imagegen-preset-option${active ? " is-active" : ""}`}
                          onClick={() => setImg2imgReferenceGuideId(active ? null : p.id)}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="imagegen-preset-section">
                <div className="imagegen-preset-head">
                  <Text className="imagegen-preset-title">画风</Text>
                  {currentStylePreset?.description && (
                    <Text className="imagegen-preset-desc">
                      {currentStylePreset.description}
                    </Text>
                  )}
                </div>
                <div className="imagegen-preset-options">
                  {STYLE_PRESETS.map((p) => {
                    const active = p.id === styleId;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setStyleId(p.id)}
                        className={`imagegen-preset-option${active ? " is-active" : ""}`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 8 }}>
                  <Text style={{ color: "#a1a1aa", fontSize: 13 }}>宽高比</Text>
                  <Text style={{ color: "#52525b", fontSize: 11, marginLeft: 6 }}>
                    {currentSize && currentSize.tier !== "auto"
                      ? `${currentSize.w} x ${currentSize.h}`
                      : ""}
                  </Text>
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    gap: 8,
                  }}
                >
                  {SIZE_OPTIONS.map((s) => {
                    const active = s.value === size;
                    return (
                      <button
                        key={s.value}
                        onClick={() => setSize(s.value)}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 4,
                          padding: "10px 4px 8px",
                          borderRadius: 8,
                          border: active ? "1.5px solid #10b981" : "1px solid #27272a",
                          background: active ? "rgba(16, 185, 129, 0.1)" : "#18181b",
                          color: active ? "#34d399" : "#a1a1aa",
                          cursor: "pointer",
                          transition: "all 0.15s ease",
                          minHeight: 56,
                        }}
                      >
                        <SizeIcon ratio={s.ratio} />
                        <span style={{ fontSize: 12, fontWeight: active ? 600 : 500 }}>
                          {s.ratio}
                          {s.tier !== "1k" && s.tier !== "auto" && (
                            <span style={{ fontSize: 10, color: "#71717a" }}>
                              ({s.tier})
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {!hasOwnKey && n > 1 && (
                <Alert
                  type="info"
                  showIcon
                  message="未配置自有 API Key，生成数量已强制设为 1"
                  style={{ marginBottom: 12, fontSize: 12 }}
                />
              )}
              <Form.Item label={`生成数量: ${n}`}>
                <Slider
                  min={1}
                  max={24}
                  value={n}
                  onChange={setN}
                  disabled={!hasOwnKey || loading}
                  marks={{ 1: "1", 8: "8", 16: "16", 24: "24" }}
                />
                {!hasOwnKey && (
                  <Text style={{ color: "#71717a", fontSize: 11 }}>
                    配置自有 API Key 后可调整数量
                  </Text>
                )}
              </Form.Item>

              <Form.Item label="质量">
                <Segmented
                  block
                  value={quality}
                  onChange={(v) => setQuality(v as string)}
                  options={[
                    { label: "自动", value: "auto" },
                    { label: "低", value: "low" },
                    { label: "中", value: "medium" },
                    { label: "高", value: "high" },
                  ]}
                />
              </Form.Item>

              <div className="image-gen-action-bar">
                <div className="image-gen-action-summary" style={{ minWidth: 0 }}>
                  <Text style={{ color: "#d4d4d8", fontSize: 12, fontWeight: 600, display: "block" }}>
                    {mode === "img2img" ? "图生图" : "文生图"} · {currentSize?.ratio ?? "auto"}
                  </Text>
                  <Text style={{ color: "#71717a", fontSize: 11 }}>
                    {hasOwnKey ? `${n} 张` : "默认接口限制 1 张"} · {quality === "auto" ? "自动质量" : `${quality} 质量`}
                  </Text>
                  <Text style={{ color: generationAdapter === "task" ? "#34d399" : "#fbbf24", fontSize: 11, display: "block" }}>
                    {generationAdapter === "task"
                      ? "任务模式 · 支持后台恢复"
                      : generationAdapter === "direct"
                        ? "直连模式 · 不支持后台恢复"
                        : `${imageGenAdapter === "task" ? "任务模式" : "直连模式"} · 等待生成开始`}
                  </Text>
                </div>
                <div className="image-gen-action-controls" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <MagneticButton strength={0.35} className="image-gen-generate-wrap">
                    <Button
                      type="primary"
                      loading={loading}
                      onClick={handleGenerate}
                      size="large"
                      style={{
                        background: "linear-gradient(135deg, #10b981 0%, #047857 100%)",
                        border: "none",
                        fontWeight: 600,
                        minWidth: 112,
                        boxShadow: loading
                          ? "0 0 0 1px rgba(16, 185, 129, 0.4), 0 6px 18px rgba(16, 185, 129, 0.28)"
                          : "0 8px 22px rgba(16, 185, 129, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.18)",
                        borderRadius: 8,
                      }}
                    >
                      {loading ? "生成中" : "生成"}
                    </Button>
                  </MagneticButton>
                  {loading && (
                    <Button
                      danger
                      size="large"
                      onClick={handleStop}
                      style={{ minWidth: 96, borderRadius: 8, fontWeight: 600 }}
                    >
                      停止
                    </Button>
                  )}
                </div>
              </div>
            </Form>
          </Card>
        </Col>

        <Col xs={24} lg={14} xl={15} xxl={16}>
          <Card
            style={{ background: "#18181b", borderColor: "#27272a", minHeight: 480 }}
            styles={{ body: { padding: 14 } }}
            title={
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ color: "#a1a1aa" }}>
                  生成结果{doneImages.length > 0 || tasks.length > 0 ? ` (${doneImages.length}/${tasks.length})` : ""}
                </Text>
                {loading && (
                  <Text style={{ color: "#10b981", fontSize: 12 }}>生成中...</Text>
                )}
              </div>
            }
          >
            {/* 错误状态 - 在占位图位置直接展示错误内容 */}
            {!loading && error && tasks.length === 0 && (
              <div
                style={{
                  minHeight: 360,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: 10,
                  border: "1px dashed rgba(239, 68, 68, 0.45)",
                  background:
                    "repeating-conic-gradient(#1a1a1e 0% 25%, #131316 0% 50%) 50% / 24px 24px",
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                {/* 顶部红色提示条 */}
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 3,
                    background:
                      "linear-gradient(90deg, rgba(239,68,68,0) 0%, rgba(239,68,68,0.7) 50%, rgba(239,68,68,0) 100%)",
                    pointerEvents: "none",
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 12,
                    textAlign: "center",
                    padding: "24px 28px",
                    maxWidth: 460,
                  }}
                >
                  <div
                    style={{
                      width: 46,
                      height: 46,
                      borderRadius: 11,
                      background:
                        "radial-gradient(circle, rgba(239, 68, 68, 0.22), rgba(39, 39, 42, 0.55))",
                      border: "1px solid rgba(239, 68, 68, 0.55)",
                      display: "grid",
                      placeItems: "center",
                      boxShadow: "0 0 18px rgba(239, 68, 68, 0.25)",
                    }}
                  >
                    <CloseCircleOutlined style={{ color: "#f87171", fontSize: 20 }} />
                  </div>
                  <Text
                    style={{
                      color: "#fca5a5",
                      fontSize: 13,
                      fontWeight: 600,
                      letterSpacing: 0.2,
                    }}
                  >
                    生成失败
                  </Text>
                  <div
                    style={{
                      width: "100%",
                      background: "rgba(0, 0, 0, 0.35)",
                      border: "1px solid rgba(239, 68, 68, 0.22)",
                      borderRadius: 8,
                      padding: "10px 12px",
                      textAlign: "left",
                      maxHeight: 160,
                      overflowY: "auto",
                    }}
                  >
                    <Text
                      style={{
                        color: "#d4d4d8",
                        fontSize: 12,
                        fontFamily:
                          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        lineHeight: 1.55,
                        display: "block",
                      }}
                    >
                      {error}
                    </Text>
                  </div>
                  <Space size={8}>
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      onClick={() => {
                        setError(null);
                        handleGenerate();
                      }}
                    >
                      重试
                    </Button>
                    <Button
                      size="small"
                      type="text"
                      onClick={() => setError(null)}
                      style={{ color: "#71717a" }}
                    >
                      关闭
                    </Button>
                  </Space>
                </div>
              </div>
            )}

            {/* 空状态 - 自定义设计，不再是单行灰字 */}
            {!loading && !error && tasks.length === 0 && (
              <div
                className="checker-bg"
                style={{
                  minHeight: 360,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: 10,
                  border: "1px dashed rgba(63, 63, 70, 0.6)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 10,
                    textAlign: "center",
                    padding: 20,
                  }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 11,
                      background:
                        "radial-gradient(circle, rgba(82, 82, 91, 0.18), rgba(39, 39, 42, 0.5))",
                      border: "1px solid rgba(63, 63, 70, 0.7)",
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    <PictureOutlined style={{ color: "#71717a", fontSize: 18 }} />
                  </div>
                  <Text style={{ color: "#a1a1aa", fontSize: 13, fontWeight: 500 }}>
                    结果会显示在这里
                  </Text>
                  <Text style={{ color: "#52525b", fontSize: 11.5 }}>
                    填好提示词，点击生成
                  </Text>
                </div>
              </div>
            )}

            {/* 任务卡片网格：done 任务的多张图各占一个独立卡片，grid 布局。
                cards 与 gridLayout 已 useMemo 化（见组件顶部），
                每个 TaskCard 均 memo 化，流式 partial 仅触发对应卡片重渲染。 */}
            {cards.length > 0 && (
              <div
                ref={gridContainerRef}
                className="task-grid"
                style={{
                  "--cols": gridLayout.cols,
                  "--cell-max-h": gridLayout.cellMaxH,
                } as React.CSSProperties}
              >
                {cards.map((card, i) => (
                  <TaskCard
                    key={card.key}
                    task={card.task}
                    status={card.status}
                    src={card.src}
                    favoriteId={card.favoriteId}
                    displayIndex={i}
                    doneIdx={card.doneIdx}
                    isFavorited={favorited.has(card.favoriteId)}
                    previewRatio={resultRatios[card.favoriteId] ?? gridLayout.imgRatio}
                    aspectRatio={gridLayout.aspectRatio}
                    cellMaxH={gridLayout.cellMaxH}
                    genMode={genMode}
                    spritesheetN={spritesheetN}
                    reduceMotion={reduceMotion}
                    onRetry={retryTask}
                    onOpenPreview={openPreview}
                    onDownload={downloadImage}
                    onToggleFavorite={toggleFavorite}
                    onEditImage={editImage}
                    onSendToMatte={sendToMatte}
                    onSendToSuperRes={sendToSuperRes}
                    onSplitToPsd={splitToPsd}
                    onResultRatio={handleResultRatio}
                  />
                ))}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* 大图预览：复用通用组件 ImagePreviewWithToolbar，与 History/Assets 体验一致
          —— 左右侧大圆按钮 + 触屏 swipe + 键盘 ←/→ 翻页三件套
          —— 进入预览时锁定 imageIds 列表（previewContext），避免批次流式生成期间索引错位 */}
      {previewImageId !== null && previewContext && (
        <ImagePreviewWithToolbar
          imageId={previewImageId}
          src={previewContext.cardInfoMap.get(previewImageId)?.src ?? ""}
          imageIds={previewContext.imageIds}
          onClose={handleClosePreview}
          onImageChange={handleImageChange}
          actions={previewActions}
          currentAssetId={currentPreviewAsset?.id}
          currentGroupId={currentPreviewAsset?.groupId}
          groups={assetGroups}
          onMoveToGroup={moveAssetToGroup}
        />
      )}

      <PromptFavoriteDrawer
        open={promptFavoriteDrawerOpen}
        items={filteredPromptFavorites}
        activeId={activePromptFavoriteId}
        search={promptFavoriteSearch}
        onSearchChange={setPromptFavoriteSearch}
        onClose={() => setPromptFavoriteDrawerOpen(false)}
        onUse={handleUsePromptFavorite}
        onDelete={handleDeletePromptFavorite}
        onRename={handleRenamePromptFavorite}
      />
        </>
      )}
    </div>
  );
}
