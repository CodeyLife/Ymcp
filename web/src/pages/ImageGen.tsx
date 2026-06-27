import { useState, useEffect, useRef, useCallback } from "react";
import {
  Card, Typography, Segmented, Form, Input, Slider, Button, Row, Col, Space, App, Alert, Image, Switch, Tag,
} from "antd";
import { PictureOutlined, ScissorOutlined, DownloadOutlined, StarOutlined, StarFilled, EditOutlined, CloseCircleOutlined, ReloadOutlined, PlayCircleOutlined, PauseCircleOutlined, ThunderboltOutlined, InboxOutlined, DeleteOutlined } from "@ant-design/icons";
import { useUIStore, getEffectiveApiConfig } from "@/stores/ui";
import { useImageGenStore, type TaskStatus } from "@/stores/imageGen";
import { useHistoryStore, type HistoryItem } from "@/stores/history";
import { useAssetStore } from "@/stores/asset";
import { generateImageStream, generateImageBatch, cacheImageLocally, polishPrompt, toDataUrl, type BatchTaskParams } from "@/lib/api";
import { STYLE_PRESETS } from "@/lib/imagegenPresets";
import { downloadBlob } from "@/lib/canvas";
import { useNavigate } from "react-router-dom";
import { DiffusionLoader } from "@/components/DiffusionLoader";
import { MagneticButton } from "@/components/motion";
import { PageHeader, TiltCard } from "@/components/showtime";
import { FileUploadTrigger } from "@/components/FileUploadTrigger";
import { motion } from "motion/react";
import { useMotionMode } from "@/hooks/useMotionMode";

const { Text } = Typography;
const { TextArea } = Input;

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
    done: { color: "success", text: "完成" },
    error: { color: "error", text: "失败" },
  };
  const cfg = map[status];
  return <Tag color={cfg.color} style={{ marginInlineEnd: 0 }}>{cfg.text}</Tag>;
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

  // 动画播放循环
  useEffect(() => {
    if (!animPlaying || !frames.length) return;
    const interval = 1000 / animFps;
    let lastTime = performance.now();
    let idx = animFrame;
    const tick = (now: number) => {
      if (now - lastTime >= interval) {
        idx = idx + 1;
        if (idx >= frames.length) {
          if (animLoop) idx = 0;
          else { setAnimPlaying(false); setAnimFrame(frames.length - 1); return; }
        }
        setAnimFrame(idx);
        drawAnimFrame(idx);
        lastTime = now;
      }
      animTimerRef.current = requestAnimationFrame(tick);
    };
    animTimerRef.current = requestAnimationFrame(tick);
    return () => { if (animTimerRef.current) cancelAnimationFrame(animTimerRef.current); };
  }, [animPlaying, animFps, animLoop, frames, animFrame, drawAnimFrame]);

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

export default function ImageGen() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const setIncomingImage = useUIStore((s) => s.setIncomingImage);

  const mode = useImageGenStore((s) => s.mode);
  const genMode = useImageGenStore((s) => s.genMode);
  const prompt = useImageGenStore((s) => s.prompt);
  const size = useImageGenStore((s) => s.size);
  const n = useImageGenStore((s) => s.n);
  const spritesheetN = useImageGenStore((s) => s.spritesheetN);
  const quality = useImageGenStore((s) => s.quality);
  const styleId = useImageGenStore((s) => s.styleId);
  const refImage = useImageGenStore((s) => s.refImage);
  const tasks = useImageGenStore((s) => s.tasks);
  const loading = useImageGenStore((s) => s.loading);
  const error = useImageGenStore((s) => s.error);
  const setMode = useImageGenStore((s) => s.setMode);
  const setGenMode = useImageGenStore((s) => s.setGenMode);
  const setPrompt = useImageGenStore((s) => s.setPrompt);
  const setSize = useImageGenStore((s) => s.setSize);
  const setN = useImageGenStore((s) => s.setN);
  const setSpritesheetN = useImageGenStore((s) => s.setSpritesheetN);
  const setQuality = useImageGenStore((s) => s.setQuality);
  const setStyleId = useImageGenStore((s) => s.setStyleId);
  const setRefImage = useImageGenStore((s) => s.setRefImage);
  const updateTask = useImageGenStore((s) => s.updateTask);
  const resetTasks = useImageGenStore((s) => s.resetTasks);
  const setLoading = useImageGenStore((s) => s.setLoading);
  const setError = useImageGenStore((s) => s.setError);

  const greenscreenPrompt = useUIStore((s) => s.greenscreenPrompt);
  const spritesheetPrompt = useUIStore((s) => s.spritesheetPrompt);

  const addHistory = useHistoryStore((s) => s.add);
  const addAsset = useAssetStore((s) => s.add);

  // 派生：已完成的图列表（一个任务可能返回多张，全部扁平化）
  const doneImages = tasks.flatMap((t) =>
    t.status === "done" && t.results ? t.results.map((src) => ({ task: t, src })) : []
  );

  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [favorited, setFavorited] = useState<Set<string>>(new Set());
  const [polishing, setPolishing] = useState(false);
  const [undoPrompt, setUndoPrompt] = useState<string | null>(null);
  const reduceMotion = useMotionMode();

  // 暂存最近一次批量生成的参数，供单任务重试复用
  const lastBatchRef = useRef<{
    finalPrompt: string;
    imageBase64?: string;
    baseUrl: string;
    apiKey: string;
    quality?: string;
  } | null>(null);

  // 锁定生成时的 size value，任务进行/完成后切换 size 不影响已渲染格子的尺寸
  const lockedSizeRef = useRef<string | null>(null);

  // 结果区容器实测尺寸，用于动态计算最优网格列数（不溢出视口）
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const [gridDims, setGridDims] = useState({ w: 0, h: 0 });

  const { hasOwnKey } = getEffectiveApiConfig();

  useEffect(() => {
    if (!hasOwnKey && n > 1) setN(1);
  }, [hasOwnKey, n, setN]);

  // 监听结果区容器尺寸，用于动态算最优网格列数
  // 依赖 tasks.length：task-grid 渲染后 ref 才可用，effect 重新执行
  useEffect(() => {
    const el = gridContainerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = window.innerHeight;
      setGridDims((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [tasks.length]);

  const currentSize = SIZE_OPTIONS.find((s) => s.value === size);
  const currentStylePreset = STYLE_PRESETS.find((s) => s.id === styleId);

  function handleRefImageFiles(files: FileList) {
    const file = files[0];
    if (!file) return;
    setRefImage(URL.createObjectURL(file));
  }

  async function handleGenerate() {
    if (!prompt.trim()) {
      message.warning("请输入提示词");
      return;
    }
    setError(null);
    setFavorited(new Set());
    // 锁定本次生成使用的 size，后续切换 size 不影响已渲染格子
    lockedSizeRef.current = size;

    const { baseUrl, apiKey } = getEffectiveApiConfig();
    const effectiveN = hasOwnKey ? n : 1;

    // 画风片段：调用时注入（与 greenscreen/spritesheet 一致），输入框保持干净
    let finalPrompt = prompt;
    const stylePreset = STYLE_PRESETS.find((s) => s.id === styleId);
    if (stylePreset?.fragment) {
      finalPrompt = `${stylePreset.fragment}\n\n${finalPrompt}`;
    }

    // 根据生成模式构建最终提示词
    if (genMode === "greenscreen" && greenscreenPrompt.trim()) {
      finalPrompt = `${greenscreenPrompt.trim()}\n\n${finalPrompt}`;
    } else if (genMode === "spritesheet" && spritesheetPrompt.trim()) {
      const nn = `${spritesheetN}x${spritesheetN}`;
      // 将提示词模板里的 NxN 占位符替换为实际数值
      const basePrompt = spritesheetPrompt.trim().replace(/n\s*x\s*n/gi, nn);
      finalPrompt = `${basePrompt}\n\nGrid: exactly ${nn} (${spritesheetN} rows × ${spritesheetN} columns, ${spritesheetN * spritesheetN} frames total)\n\n${finalPrompt}`;
    }

    // 图生图需要先转 base64
    let imageBase64: string | undefined;
    if (mode === "img2img") {
      if (!refImage) {
        message.warning("请先上传参考图");
        return;
      }
      try {
        const response = await fetch(refImage);
        const blob = await response.blob();
        imageBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch {
        message.error("参考图加载失败");
        return;
      }
    }

    // 暂存参数，供单任务重试复用
    lastBatchRef.current = { finalPrompt, imageBase64, baseUrl, apiKey, quality };

    // 初始化 N 个 pending 任务
    resetTasks(effectiveN);
    setLoading(true);

    const batchTasks: BatchTaskParams[] = Array.from({ length: effectiveN }, () => ({
      prompt: finalPrompt,
      model: "gpt-image-2",
      size,
      quality,
      baseUrl,
      apiKey,
      image: imageBase64,
    }));

    await generateImageBatch(
      batchTasks,
      {
        onTaskPartial: (idx, src) => updateTask(idx, { status: "loading", partial: src }),
        onTaskComplete: (idx, images) => {
          updateTask(idx, { status: "done", results: images, partial: undefined, error: undefined });
          // 增量写入历史：每张完成即写，不等全部完成
          images.forEach((src) => persistTaskHistory(src).catch(() => {}));
        },
        onTaskError: (idx, err) => updateTask(idx, { status: "error", error: err, partial: undefined }),
        onAllDone: (summary) => {
          setLoading(false);
          const ok = summary.reduce((acc, s) => acc + (s.images?.length ?? 0), 0);
          const fail = summary.filter((s) => s.error).length;
          if (ok > 0) {
            message.success(`生成完成 ${ok} 张${fail > 0 ? `，失败 ${fail} 张` : ""}`);
          } else if (fail > 0) {
            setError(`全部失败 ${fail} 张`);
            message.error(`全部失败 ${fail} 张`);
          }
        },
      },
      { concurrency: 3 }
    );
  }

  // 持久化单张图到历史记录（每张独立一条，n=1）
  async function persistTaskHistory(src: string) {
    const dataUrl = await toDataUrl(src);
    const historyItem: HistoryItem = {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "image",
      mode,
      prompt,
      model: "gpt-image-2",
      size,
      n: 1,
      quality,
      images: [dataUrl],
      status: "completed",
      createdAt: Date.now(),
    };
    addHistory(historyItem);
  }

  // 单任务重试：仅重试该任务，不影响其他
  async function retryTask(index: number) {
    const last = lastBatchRef.current;
    if (!last) {
      message.warning("参数已失效，请重新生成");
      return;
    }
    updateTask(index, { status: "loading", partial: undefined, error: undefined });
    await generateImageStream(
      {
        prompt: last.finalPrompt,
        model: "gpt-image-2",
        size,
        n: 1,
        quality: last.quality,
        baseUrl: last.baseUrl,
        apiKey: last.apiKey,
        image: last.imageBase64,
      },
      {
        onPartial: (src) => updateTask(index, { status: "loading", partial: src }),
        onComplete: (images) => {
          if (images.length > 0) {
            updateTask(index, { status: "done", results: images, partial: undefined, error: undefined });
            images.forEach((src) => persistTaskHistory(src).catch(() => {}));
          } else {
            updateTask(index, { status: "error", error: "未收到结果" });
          }
        },
        onError: (err) => updateTask(index, { status: "error", error: err, partial: undefined }),
      }
    );
  }

  // 打开大图预览：定位到 doneImages 中的位置
  function openPreview(doneIdx: number) {
    if (doneIdx >= 0 && doneIdx < doneImages.length) setPreviewIndex(doneIdx);
  }

  async function sendToMatte(src: string) {
    try {
      // 确保图片已缓存到本地
      const cachedSrc = await cacheImageLocally(src);
      setIncomingImage({ src: cachedSrc, from: "image-gen" });
      navigate("/matte");
    } catch {
      message.error("图片缓存失败");
    }
  }

  async function downloadImage(src: string) {
    try {
      const cachedSrc = await cacheImageLocally(src);
      const response = await fetch(cachedSrc);
      const blob = await response.blob();
      downloadBlob(blob, `gpt-image-${Date.now()}.png`);
    } catch {
      message.error("下载失败");
    }
  }

  async function toggleFavorite(taskId: string, src: string, displayIndex: number) {
    const isFavorited = favorited.has(taskId);
    if (isFavorited) {
      // 取消收藏
      const next = new Set(favorited);
      next.delete(taskId);
      setFavorited(next);
      message.info("已取消收藏");
    } else {
      // 添加到素材库：转为 data URL 持久化，避免刷新后失效
      const next = new Set(favorited);
      next.add(taskId);
      setFavorited(next);
      try {
        const dataUrl = await toDataUrl(src);
        addAsset({
          id: `asset-${Date.now()}-${taskId}`,
          name: `${prompt.slice(0, 20) || "生成图"}_${displayIndex + 1}`,
          type: "image",
          src: dataUrl,
          thumbnail: dataUrl,
          tags: ["AI生成", mode],
          source: "generated",
          metadata: { size: size === "auto" ? undefined : Number(size) },
          createdAt: Date.now(),
        });
        message.success("已收藏到素材库");
      } catch {
        message.error("收藏失败");
      }
    }
  }

  async function editImage(src: string) {
    try {
      const cachedSrc = await cacheImageLocally(src);
      setMode("img2img");
      setRefImage(cachedSrc);
      message.info("已切换到图生图，参考图已载入");
    } catch {
      message.error("图片加载失败");
    }
  }

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

  return (
    <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 28px 48px" }}>
      <PageHeader
        title="AI 生图"
        description="基于 OpenAI gpt-image-2 的文生图与图生图。生成结果可一键送入抠图。"
        icon={<PictureOutlined />}
      />

      <Row gutter={16}>
        <Col xs={24} lg={10} xl={9} xxl={8}>
          <Card style={{ background: "#18181b", borderColor: "#27272a" }} styles={{ body: { padding: 18 } }}>
            <Segmented
              value={mode}
              onChange={(v) => setMode(v as typeof mode)}
              block
              options={[
                { label: "文生图", value: "text2img" },
                { label: "图生图", value: "img2img" },
              ]}
              style={{ marginBottom: 12 }}
            />
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
                <Form.Item label="参考图">
                  <FileUploadTrigger
                    accept="image/png,image/jpeg,image/webp"
                    variant="dropzone"
                    label="点击或拖拽上传参考图"
                    hint="PNG / JPEG / WebP"
                    selectedText={refImage ? "已载入参考图" : undefined}
                    icon={<InboxOutlined />}
                    onFiles={handleRefImageFiles}
                  />
                  {refImage && (
                    <div style={{ marginTop: 8, position: "relative" }}>
                      <img
                        src={refImage}
                        alt="参考图"
                        style={{
                          maxWidth: "100%",
                          maxHeight: 200,
                          borderRadius: 8,
                          objectFit: "contain",
                          background: "#131316",
                          display: "block",
                          margin: "0 auto",
                        }}
                      />
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => setRefImage(null)}
                        style={{ position: "absolute", top: 8, right: 8 }}
                      >
                        移除
                      </Button>
                    </div>
                  )}
                </Form.Item>
              )}
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span>
                    <Text style={{ color: "#ff4d4f", marginRight: 4 }}>*</Text>
                    <Text style={{ color: "#a1a1aa", fontSize: 14 }}>提示词</Text>
                  </span>
                  <Space size={4}>
                    {undoPrompt !== null && (
                      <Button
                        size="small"
                        type="link"
                        onClick={undoPolish}
                        style={{ padding: "0 4px", fontSize: 12, height: 24 }}
                      >
                        撤销
                      </Button>
                    )}
                    <Button
                      size="small"
                      icon={<ThunderboltOutlined />}
                      loading={polishing}
                      onClick={handlePolish}
                    >
                      AI 润色
                    </Button>
                  </Space>
                </div>
                <TextArea
                  rows={9}
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    setUndoPrompt(null);
                  }}
                  placeholder="一只在窗台上看雨的橘猫，胶片质感，柔和光线"
                  style={{ resize: "vertical" }}
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
                  <Text style={{ color: "#a1a1aa", fontSize: 13 }}>画风</Text>
                  {currentStylePreset?.description && (
                    <Text style={{ color: "#52525b", fontSize: 11 }}>
                      {currentStylePreset.description}
                    </Text>
                  )}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {STYLE_PRESETS.map((p) => {
                    const active = p.id === styleId;
                    return (
                      <button
                        key={p.id}
                        onClick={() => setStyleId(p.id)}
                        style={{
                          padding: "4px 12px",
                          borderRadius: 14,
                          border: active ? "1px solid #10b981" : "1px solid #27272a",
                          background: active ? "rgba(16, 185, 129, 0.1)" : "#18181b",
                          color: active ? "#34d399" : "#a1a1aa",
                          cursor: "pointer",
                          fontSize: 12,
                          fontWeight: active ? 600 : 500,
                          transition: "all 0.15s ease",
                        }}
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
                  max={10}
                  value={n}
                  onChange={setN}
                  disabled={!hasOwnKey}
                  marks={{ 1: "1", 5: "5", 10: "10" }}
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

              <Space>
                <MagneticButton strength={0.35}>
                  <Button
                    type="primary"
                    loading={loading}
                    onClick={handleGenerate}
                    style={{
                      background: "linear-gradient(135deg, #10b981 0%, #047857 100%)",
                      border: "none",
                      fontWeight: 600,
                      boxShadow: loading
                        ? "0 0 0 1px rgba(16, 185, 129, 0.4), 0 6px 18px rgba(16, 185, 129, 0.28)"
                        : "0 8px 22px rgba(16, 185, 129, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.18)",
                      borderRadius: 8,
                    }}
                  >
                    {loading ? "生成中" : "生成"}
                  </Button>
                </MagneticButton>
              </Space>
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

            {/* 任务卡片网格：done 任务的多张图各占一个独立卡片，grid 布局 */}
            {(() => {
              if (tasks.length === 0) return null;
              // 扁平化为卡片：done 任务的每张图一个卡片，其他状态一个任务一个卡片
              const cards: {
                key: string;
                task: typeof tasks[number];
                status: TaskStatus;
                src?: string;
                favoriteId: string;
                doneIdx?: number;
              }[] = [];
              let doneCounter = 0;
              tasks.forEach((task) => {
                if (task.status === "done" && task.results && task.results.length > 0) {
                  task.results.forEach((src, subIdx) => {
                    cards.push({
                      key: `${task.id}-${subIdx}`,
                      task,
                      status: "done",
                      src,
                      favoriteId: `${task.id}-${subIdx}`,
                      doneIdx: doneCounter++,
                    });
                  });
                } else {
                  cards.push({
                    key: task.id,
                    task,
                    status: task.status,
                    favoriteId: task.id,
                  });
                }
              });
              // 用容器实测宽高 + 图片宽高比动态算最优列数，保证不溢出视口
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
              // 每格图片最大高度（硬上限 px）：保证 rows 行总高不超 availH
              const cellMaxHpx = computeCellMaxH(availH, rows, GAP, CARD_OVERHEAD);
              const cellMaxH = `${cellMaxHpx}px`;
              return (
                <div
                  ref={gridContainerRef}
                  className="task-grid"
                  style={{
                    "--cols": cols,
                    "--cell-max-h": cellMaxH,
                  } as React.CSSProperties}
                >
                  {cards.map((card, i) => {
                    const task = card.task;
                    const isDone = card.status === "done" && card.src;
                    const aspectRatio =
                      lockedSize && lockedSize.tier !== "auto"
                        ? `${lockedSize.w} / ${lockedSize.h}`
                        : "1 / 1";
                    return (
                      <motion.div
                        key={card.key}
                        initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.94 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{
                          duration: 0.5,
                          delay: i * 0.06,
                          ease: [0.16, 1, 0.3, 1],
                        }}
                      >
                        <div className="task-card">
                          {/* header：序号 + 状态 + 重试 */}
                          <div className="task-header">
                            <span className="task-index">#{String(i + 1).padStart(2, "0")}</span>
                            <TaskStatusTag status={card.status} />
                            {card.status === "error" && (
                              <Button
                                size="small"
                                type="text"
                                icon={<ReloadOutlined />}
                                onClick={() => retryTask(task.index)}
                                style={{ color: "#f87171", marginLeft: "auto" }}
                              >
                                重试
                              </Button>
                            )}
                          </div>

                          {/* body：预览图 */}
                          <div className="task-body">
                            {/* pending / loading 无 partial：DiffusionLoader 占满整个格子背景 */}
                            {(card.status === "pending" || (card.status === "loading" && !task.partial)) && (
                              <div
                                style={{
                                  maxHeight: "var(--cell-max-h)",
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
                                  label={card.status === "loading" ? "生成中" : "等待中"}
                                />
                              </div>
                            )}

                            {/* loading 有 partial：流式中间帧 */}
                            {card.status === "loading" && task.partial && (
                              <div
                                className="checker-bg"
                                style={{
                                  maxHeight: "var(--cell-max-h)",
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

                            {/* error：错误内容 */}
                            {card.status === "error" && (
                              <div
                                style={{
                                  maxHeight: "var(--cell-max-h)",
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

                            {/* done：结果图（spritesheet 走 SpritesheetPreview，其余走 TiltCard 大图） */}
                            {isDone && genMode === "spritesheet" && (
                              <SpritesheetPreview
                                src={card.src!}
                                n={spritesheetN}
                                onDownload={downloadImage}
                              />
                            )}
                            {isDone && genMode !== "spritesheet" && (
                              <TiltCard
                                max={6}
                                className="result-tilt"
                                onClick={() => openPreview(card.doneIdx!)}
                                style={{ cursor: "pointer" }}
                              >
                                <div
                                  className="checker-bg"
                                  style={{
                                    maxHeight: "var(--cell-max-h)",
                                    maxWidth: "100%",
                                    aspectRatio,
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
                                    width: "100%",
                                  }}
                                >
                                  <img
                                    src={card.src}
                                    alt={`结果 ${i + 1}`}
                                    style={{ width: "100%", height: "100%", objectFit: "contain" }}
                                  />
                                  {/* 顶部 emerald 扫描高光 - 入场瞬间扫过 */}
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
                                      animationDelay: `${i * 0.06}s`,
                                    }}
                                  />
                                  {/* 悬浮操作栏 */}
                                  <div
                                    className="result-actions"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <button
                                      type="button"
                                      aria-label={favorited.has(card.favoriteId) ? "取消收藏" : "收藏"}
                                      title={favorited.has(card.favoriteId) ? "取消收藏" : "收藏"}
                                      className={favorited.has(card.favoriteId) ? "is-active" : undefined}
                                      onClick={() => toggleFavorite(card.favoriteId, card.src!, i)}
                                    >
                                      {favorited.has(card.favoriteId)
                                        ? <StarFilled style={{ color: "#fbbf24" }} />
                                        : <StarOutlined />}
                                    </button>
                                    <button
                                      type="button"
                                      aria-label="编辑（送入图生图）"
                                      title="编辑（送入图生图）"
                                      onClick={() => editImage(card.src!)}
                                    >
                                      <EditOutlined />
                                    </button>
                                    <button
                                      type="button"
                                      aria-label="送入抠图"
                                      title="送入抠图"
                                      onClick={() => sendToMatte(card.src!)}
                                    >
                                      <ScissorOutlined />
                                    </button>
                                    <button
                                      type="button"
                                      aria-label="下载"
                                      title="下载"
                                      onClick={() => downloadImage(card.src!)}
                                    >
                                      <DownloadOutlined />
                                    </button>
                                  </div>
                                </div>
                              </TiltCard>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              );
            })()}
          </Card>
        </Col>
      </Row>

      {/* 大图预览：支持同批多图左右切换（doneImages 扁平化） */}
      {previewIndex !== null && doneImages.length > 0 && (
        <div style={{ display: "none" }}>
          <Image.PreviewGroup
            preview={{
              visible: previewIndex !== null,
              current: Math.min(previewIndex, doneImages.length - 1),
              onVisibleChange: (v: boolean) => !v && setPreviewIndex(null),
              onChange: (idx: number) => setPreviewIndex(idx),
            }}
          >
            {doneImages.map((item, i) => (
              <Image key={`${item.task.id}-${i}`} src={item.src} />
            ))}
          </Image.PreviewGroup>
        </div>
      )}
    </div>
  );
}
