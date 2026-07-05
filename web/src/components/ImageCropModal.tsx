import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Radio, Space, Tooltip, App } from "antd";
import {
  CheckOutlined,
  CloseOutlined,
  RedoOutlined,
  ScissorOutlined,
} from "@ant-design/icons";
import { canvasToBlob } from "@/lib/canvas";

/**
 * 图片裁剪模态
 * - 在大图预览工具栏点击「裁剪」触发
 * - 用户拖拽框选裁剪区域，可移动、可四角缩放
 * - 支持纵横比预设：自由 / 1:1 / 3:4 / 4:3 / 16:9 / 9:16
 * - 确认后通过 canvas 裁剪原图并输出 Blob（PNG），交给调用方入库
 *
 * 坐标系约定：
 * - 显示坐标：图片在容器内 contain-fit 后的可见像素位置，左上为 (0,0)
 * - 自然坐标：原图真实像素位置，用于最终裁剪
 * 转换：natural = display * (naturalSize / displayedSize)
 */

export type CropAspectKey = "free" | "1:1" | "3:4" | "4:3" | "16:9" | "9:16";

const ASPECT_PRESETS: { key: CropAspectKey; label: string; ratio: number | null }[] = [
  { key: "free", label: "自由", ratio: null },
  { key: "1:1", label: "1:1", ratio: 1 },
  { key: "3:4", label: "3:4", ratio: 3 / 4 },
  { key: "4:3", label: "4:3", ratio: 4 / 3 },
  { key: "16:9", label: "16:9", ratio: 16 / 9 },
  { key: "9:16", label: "9:16", ratio: 9 / 16 },
];

/** 选区，全部使用显示坐标系 */
interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 图片在裁剪画布中的实际可见盒子（相对 crop-canvas-wrap） */
interface ImageBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 缩放把手位置（null 表示正在创建新选区） */
type Handle = "nw" | "ne" | "sw" | "se" | "move" | null;

/** 把手字面量，用于 renderHandle（不含 null） */
type HandleKind = "nw" | "ne" | "sw" | "se";

interface ImageCropModalProps {
  open: boolean;
  src: string | null;
  onClose: () => void;
  /** 裁剪完成回调，返回原图自然像素下的 Blob */
  onCrop: (blob: Blob, info: { width: number; height: number }) => void | Promise<void>;
  /** 模态标题，默认「裁剪图片」 */
  title?: string;
}

const MIN_SIZE = 16; // 选区最小尺寸（显示坐标）

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** 把选区限制在画布边界内 */
function clampRect(rect: CropRect, bounds: { w: number; h: number }): CropRect {
  let w = clamp(rect.w, 0, bounds.w);
  let h = clamp(rect.h, 0, bounds.h);
  let x = clamp(rect.x, 0, bounds.w - w);
  let y = clamp(rect.y, 0, bounds.h - h);
  return { x, y, w, h };
}

export function ImageCropModal({ open, src, onClose, onCrop, title = "裁剪图片" }: ImageCropModalProps) {
  const { message } = App.useApp();
  const imgWrapRef = useRef<HTMLDivElement | null>(null);
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const naturalSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const displayedSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const imageBoxRef = useRef<ImageBox>({ x: 0, y: 0, w: 0, h: 0 });
  /** 拖拽中暂存的起点（显示坐标） */
  const dragRef = useRef<{
    handle: Handle;
    startX: number;
    startY: number;
    origRect: CropRect;
  } | null>(null);

  const [aspectKey, setAspectKey] = useState<CropAspectKey>("free");
  const [rect, setRect] = useState<CropRect | null>(null);
  const [imageBox, setImageBox] = useState<ImageBox>({ x: 0, y: 0, w: 0, h: 0 });
  const [submitting, setSubmitting] = useState(false);

  // 切换模态时重置状态
  useEffect(() => {
    if (open) {
      setRect(null);
      setImageBox({ x: 0, y: 0, w: 0, h: 0 });
      setAspectKey("free");
      setSubmitting(false);
    }
  }, [open, src]);

  // 计算图片显示尺寸与位置（图片是 contain-fit 居中显示，坐标层必须对齐图片盒子）
  const refreshDisplayedSize = useCallback(() => {
    const img = imgElRef.current;
    const wrap = imgWrapRef.current;
    if (!img || !wrap) return;
    const imgRect = img.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const nextBox = {
      x: imgRect.left - wrapRect.left,
      y: imgRect.top - wrapRect.top,
      w: imgRect.width,
      h: imgRect.height,
    };
    imageBoxRef.current = nextBox;
    displayedSizeRef.current = { w: nextBox.w, h: nextBox.h };
    setImageBox(nextBox);
  }, []);

  const onImgLoad = useCallback(() => {
    const img = imgElRef.current;
    if (!img) return;
    naturalSizeRef.current = { w: img.naturalWidth, h: img.naturalHeight };
    refreshDisplayedSize();
    // 默认选区：留 10% 边距
    const disp = displayedSizeRef.current;
    if (disp.w > 0 && disp.h > 0) {
      setRect({
        x: disp.w * 0.1,
        y: disp.h * 0.1,
        w: disp.w * 0.8,
        h: disp.h * 0.8,
      });
    }
  }, [refreshDisplayedSize]);

  // 窗口尺寸变化时重新计算图片盒子，并按比例缩放选区
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      const prevSize = displayedSizeRef.current;
      refreshDisplayedSize();
      const nextSize = displayedSizeRef.current;
      setRect((prev) => {
        if (!prev) return prev;
        if (prevSize.w <= 0 || prevSize.h <= 0 || nextSize.w <= 0 || nextSize.h <= 0) {
          return clampRect(prev, nextSize);
        }
        return clampRect(
          {
            x: prev.x * (nextSize.w / prevSize.w),
            y: prev.y * (nextSize.h / prevSize.h),
            w: prev.w * (nextSize.w / prevSize.w),
            h: prev.h * (nextSize.h / prevSize.h),
          },
          nextSize
        );
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, refreshDisplayedSize]);

  const aspect = useMemo(() => {
    return ASPECT_PRESETS.find((p) => p.key === aspectKey)?.ratio ?? null;
  }, [aspectKey]);

  // 切换纵横比时调整选区
  const changeAspect = useCallback((key: CropAspectKey) => {
    setAspectKey(key);
    const ratio = ASPECT_PRESETS.find((p) => p.key === key)?.ratio ?? null;
    if (!ratio) return;
    setRect((prev) => {
      if (!prev) return prev;
      const bounds = displayedSizeRef.current;
      // 以高度为基准保持中心，宽度 = h * ratio
      const h = prev.h;
      let w = h * ratio;
      const cx = prev.x + prev.w / 2;
      const cy = prev.y + prev.h / 2;
      let x = cx - w / 2;
      let y = cy - h / 2;
      // 越界则缩放回画布内（按宽度反推高度）
      if (w > bounds.w) {
        w = bounds.w;
        const newH = w / ratio;
        x = 0;
        y = clamp(cy - newH / 2, 0, bounds.h - newH);
        return clampRect({ x, y, w, h: newH }, bounds);
      }
      return clampRect({ x, y, w, h }, bounds);
    });
  }, []);

  const getRelativePoint = useCallback((clientX: number, clientY: number) => {
    const wrap = imgWrapRef.current;
    if (!wrap) return { x: 0, y: 0 };
    const wrapRect = wrap.getBoundingClientRect();
    const box = imageBoxRef.current;
    if (box.w <= 0 || box.h <= 0) return { x: 0, y: 0 };
    return {
      x: clamp(clientX - wrapRect.left - box.x, 0, box.w),
      y: clamp(clientY - wrapRect.top - box.y, 0, box.h),
    };
  }, []);

  // 选区/把手 pointer 事件
  const onRegionPointerDown = useCallback(
    (e: React.PointerEvent, handle: Handle) => {
      e.stopPropagation();
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      const p = getRelativePoint(e.clientX, e.clientY);
      dragRef.current = {
        handle,
        startX: p.x,
        startY: p.y,
        origRect: rect ?? { x: 0, y: 0, w: 0, h: 0 },
      };
    },
    [getRelativePoint, rect]
  );

  const onRegionPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const p = getRelativePoint(e.clientX, e.clientY);
      const dx = p.x - drag.startX;
      const dy = p.y - drag.startY;
      const bounds = displayedSizeRef.current;
      const ratio = aspect;
      const orig = drag.origRect;

      let next: CropRect;
      switch (drag.handle) {
        case "move":
          next = {
            x: orig.x + dx,
            y: orig.y + dy,
            w: orig.w,
            h: orig.h,
          };
          next = clampRect(next, bounds);
          break;
        case "nw": {
          // 锚定右下角
          const right = orig.x + orig.w;
          const bottom = orig.y + orig.h;
          let x = clamp(orig.x + dx, 0, right - MIN_SIZE);
          let y = clamp(orig.y + dy, 0, bottom - MIN_SIZE);
          let w = right - x;
          let h = bottom - y;
          if (ratio) {
            // 以 w 为基准反推 h，保持左上对齐右上角 → 锚右下角不变
            h = w / ratio;
            if (y + h > bottom) {
              h = bottom - y;
              w = h * ratio;
            }
          }
          next = { x: right - w, y: bottom - h, w, h };
          break;
        }
        case "ne": {
          const bottom = orig.y + orig.h;
          let x = orig.x;
          let y = clamp(orig.y + dy, 0, bottom - MIN_SIZE);
          let w = clamp(orig.w + dx, MIN_SIZE, bounds.w - x);
          let h = bottom - y;
          if (ratio) {
            h = w / ratio;
            if (y + h > bottom) {
              h = bottom - y;
              w = h * ratio;
            }
          }
          next = { x, y: bottom - h, w, h };
          break;
        }
        case "sw": {
          const right = orig.x + orig.w;
          let x = clamp(orig.x + dx, 0, right - MIN_SIZE);
          let y = orig.y;
          let w = right - x;
          let h = clamp(orig.h + dy, MIN_SIZE, bounds.h - y);
          if (ratio) {
            w = h * ratio;
            if (x + w > right) {
              w = right - x;
              h = w / ratio;
            }
          }
          next = { x: right - w, y, w, h };
          break;
        }
        case "se": {
          let x = orig.x;
          let y = orig.y;
          let w = clamp(orig.w + dx, MIN_SIZE, bounds.w - x);
          let h = clamp(orig.h + dy, MIN_SIZE, bounds.h - y);
          if (ratio) {
            h = w / ratio;
            if (h > bounds.h - y) {
              h = bounds.h - y;
              w = h * ratio;
            }
          }
          next = { x, y, w, h };
          break;
        }
        default:
          // 创建选区：从起点拖到当前
          next = {
            x: Math.min(drag.startX, p.x),
            y: Math.min(drag.startY, p.y),
            w: Math.abs(dx),
            h: Math.abs(dy),
          };
          if (ratio) {
            // 以较大维度为准
            if (next.w / ratio > next.h) {
              next.h = next.w / ratio;
            } else {
              next.w = next.h * ratio;
            }
          }
          next = clampRect(next, bounds);
      }
      setRect(next);
    },
    [aspect, getRelativePoint]
  );

  const onRegionPointerUp = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  }, []);

  // 画布空白处按下：开始创建选区
  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      const p = getRelativePoint(e.clientX, e.clientY);
      dragRef.current = {
        handle: null,
        startX: p.x,
        startY: p.y,
        origRect: { x: p.x, y: p.y, w: 0, h: 0 },
      };
    },
    [getRelativePoint]
  );

  // 选区自然像素尺寸
  const naturalCropSize = useMemo(() => {
    if (!rect) return { w: 0, h: 0 };
    const disp = displayedSizeRef.current;
    const nat = naturalSizeRef.current;
    if (disp.w === 0 || disp.h === 0) return { w: 0, h: 0 };
    const sx = nat.w / disp.w;
    const sy = nat.h / disp.h;
    return {
      w: Math.round(rect.w * sx),
      h: Math.round(rect.h * sy),
    };
  }, [rect]);

  const handleReset = useCallback(() => {
    const disp = displayedSizeRef.current;
    if (disp.w === 0 || disp.h === 0) {
      setRect(null);
      return;
    }
    setRect({
      x: disp.w * 0.1,
      y: disp.h * 0.1,
      w: disp.w * 0.8,
      h: disp.h * 0.8,
    });
    setAspectKey("free");
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!rect || rect.w < 1 || rect.h < 1) {
      message.warning("请先框选裁剪区域");
      return;
    }
    const nat = naturalSizeRef.current;
    const disp = displayedSizeRef.current;
    if (nat.w === 0 || nat.h === 0 || disp.w === 0 || disp.h === 0) {
      message.error("图片尚未加载完成");
      return;
    }
    const sx = nat.w / disp.w;
    const sy = nat.h / disp.h;
    const cropX = Math.round(rect.x * sx);
    const cropY = Math.round(rect.y * sy);
    const cropW = Math.round(rect.w * sx);
    const cropH = Math.round(rect.h * sy);
    if (cropW < 1 || cropH < 1) {
      message.warning("裁剪区域过小");
      return;
    }
    setSubmitting(true);
    try {
      // 用原始 src 重新加载图片到 canvas 上裁剪（保证用自然分辨率）
      // 本项目 src 已归一化为 blob:/data: URL（远程图会经 cacheImageLocally 下载），
      // 不需要 crossOrigin，避免 canvas 被污染导致 toBlob 失败
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("图片加载失败"));
        img.src = src ?? "";
      });
      const canvas = document.createElement("canvas");
      canvas.width = cropW;
      canvas.height = cropH;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("无法创建 canvas 上下文");
      ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      const blob = await canvasToBlob(canvas);
      await onCrop(blob, { width: cropW, height: cropH });
      onClose();
    } catch (e) {
      message.error(`裁剪失败：${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }, [message, onClose, onCrop, rect, src]);

  // 渲染把手
  const renderHandle = (handle: HandleKind, style: React.CSSProperties) => (
    <div
      key={handle}
      className="crop-handle"
      style={{
        position: "absolute",
        width: 12,
        height: 12,
        background: "#fff",
        border: "1.5px solid #34d399",
        borderRadius: 3,
        boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
        cursor: `${handle}-resize`,
        touchAction: "none",
        ...style,
      }}
      onPointerDown={(e) => onRegionPointerDown(e, handle)}
      onPointerMove={onRegionPointerMove}
      onPointerUp={onRegionPointerUp}
    />
  );

  return (
    <Modal
      open={open}
      title={
        <Space size={8}>
          <ScissorOutlined />
          <span>{title}</span>
        </Space>
      }
      onCancel={onClose}
      footer={null}
      width="min(960px, 92vw)"
      destroyOnClose
      maskClosable={false}
      styles={{ body: { padding: 0 } }}
    >
      <div className="crop-modal-body">
        {/* 顶部工具条：纵横比 + 操作 */}
        <div className="crop-toolbar">
          <Radio.Group
            size="small"
            value={aspectKey}
            onChange={(e) => changeAspect(e.target.value as CropAspectKey)}
            optionType="button"
            buttonStyle="solid"
          >
            {ASPECT_PRESETS.map((p) => (
              <Radio.Button key={p.key} value={p.key}>
                {p.label}
              </Radio.Button>
            ))}
          </Radio.Group>
          <div className="crop-toolbar-right">
            {naturalCropSize.w > 0 && (
              <span className="crop-size-info">
                {naturalCropSize.w} × {naturalCropSize.h}
              </span>
            )}
            <Tooltip title="重置选区">
              <button
                type="button"
                className="crop-toolbar-btn"
                onClick={handleReset}
                disabled={submitting}
              >
                <RedoOutlined />
              </button>
            </Tooltip>
            <Tooltip title="取消">
              <button
                type="button"
                className="crop-toolbar-btn crop-toolbar-btn-danger"
                onClick={onClose}
                disabled={submitting}
              >
                <CloseOutlined />
              </button>
            </Tooltip>
            <Tooltip title="确认裁剪">
              <button
                type="button"
                className="crop-toolbar-btn crop-toolbar-btn-primary"
                onClick={() => void handleConfirm()}
                disabled={submitting || !rect}
              >
                <CheckOutlined />
              </button>
            </Tooltip>
          </div>
        </div>

        {/* 画布区 */}
        <div
          className="crop-canvas-wrap"
          ref={imgWrapRef}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onRegionPointerMove}
          onPointerUp={onRegionPointerUp}
        >
          {src ? (
            <img
              ref={imgElRef}
              src={src}
              alt="待裁剪"
              onLoad={onImgLoad}
              draggable={false}
              className="crop-image"
            />
          ) : (
            <div className="crop-image-empty">图片加载失败</div>
          )}

          {rect && imageBox.w > 0 && imageBox.h > 0 && (
            <div
              className="crop-overlay-layer"
              style={{
                left: imageBox.x,
                top: imageBox.y,
                width: imageBox.w,
                height: imageBox.h,
              }}
            >
              {/* 遮罩：暗化非选区区域。坐标相对图片盒子，不再包含居中留白。 */}
              <div
                className="crop-mask"
                style={{
                  left: 0,
                  top: 0,
                  width: rect.x,
                  height: "100%",
                }}
              />
              <div
                className="crop-mask"
                style={{
                  left: rect.x + rect.w,
                  top: 0,
                  right: 0,
                  height: "100%",
                }}
              />
              <div
                className="crop-mask"
                style={{
                  left: rect.x,
                  top: 0,
                  width: rect.w,
                  height: rect.y,
                }}
              />
              <div
                className="crop-mask"
                style={{
                  left: rect.x,
                  top: rect.y + rect.h,
                  width: rect.w,
                  bottom: 0,
                }}
              />

              {/* 选区 */}
              <div
                className="crop-region"
                style={{
                  left: rect.x,
                  top: rect.y,
                  width: rect.w,
                  height: rect.h,
                }}
                onPointerDown={(e) => onRegionPointerDown(e, "move")}
                onPointerMove={onRegionPointerMove}
                onPointerUp={onRegionPointerUp}
              >
                {/* 三分线辅助 */}
                <div className="crop-grid-line crop-grid-line-v" style={{ left: "33.33%" }} />
                <div className="crop-grid-line crop-grid-line-v" style={{ left: "66.66%" }} />
                <div className="crop-grid-line crop-grid-line-h" style={{ top: "33.33%" }} />
                <div className="crop-grid-line crop-grid-line-h" style={{ top: "66.66%" }} />

                {renderHandle("nw", { left: -6, top: -6 })}
                {renderHandle("ne", { right: -6, top: -6 })}
                {renderHandle("sw", { left: -6, bottom: -6 })}
                {renderHandle("se", { right: -6, bottom: -6 })}
              </div>
            </div>
          )}
        </div>

        <div className="crop-tip">
          在空白处拖拽创建选区 · 选区内拖动可移动 · 四角可缩放
        </div>
      </div>
    </Modal>
  );
}
