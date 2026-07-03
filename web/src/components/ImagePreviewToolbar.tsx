import { cloneElement, useCallback, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Image } from "antd";
import {
  DeleteOutlined,
  DownloadOutlined,
  FileImageOutlined,
  LeftOutlined,
  ReloadOutlined,
  RightOutlined,
  ScissorOutlined,
  StarFilled,
  StarOutlined,
} from "@ant-design/icons";
import type { MediaItem } from "@/components/MediaGallery";

export function getNextPreviewImageIdAfterDelete(imageIds: string[], currentImageId: string | null): string | null {
  if (!currentImageId) return imageIds[0] ?? null;
  const currentIndex = imageIds.indexOf(currentImageId);
  const remainingIds = imageIds.filter((id) => id !== currentImageId);
  if (remainingIds.length === 0) return null;
  if (currentIndex < 0) return remainingIds[0];
  return imageIds.slice(currentIndex + 1).find((id) => id !== currentImageId) ?? remainingIds[0];
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}

function isPreviewEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(".ant-image-preview-root, .ant-image-preview-wrap, .ant-image-preview-mask"));
}

interface ImagePreviewToolbarProps {
  originalNode: ReactNode;
  currentImageId: string;
  currentItem?: MediaItem;
  src: string;
  downloadFilename?: string;
  onDownload?: (imageId: string, item?: MediaItem) => void;
  onMatte?: (imageId: string, item?: MediaItem) => void;
  onImg2Img?: (imageId: string, item?: MediaItem) => void;
  onReuse?: (item: MediaItem) => void;
  onFavorite?: (item: MediaItem) => void;
  onDeleteCurrent?: (item: MediaItem) => void;
}

function ImagePreviewToolbar({
  originalNode,
  currentImageId,
  currentItem,
  src,
  downloadFilename,
  onDownload,
  onMatte,
  onImg2Img,
  onReuse,
  onFavorite,
  onDeleteCurrent,
}: ImagePreviewToolbarProps) {
  const canUseItemActions = Boolean(currentItem);

  return (
    <div className="image-preview-toolbar-with-action">
      {originalNode}
      <span className="image-preview-action-separator" aria-hidden />
      <button
        type="button"
        className="image-preview-img2img-button"
        title="用作图生图参考图"
        aria-label="用作图生图参考图"
        disabled={!onImg2Img}
        onClick={(e) => {
          e.stopPropagation();
          onImg2Img?.(currentImageId, currentItem);
        }}
      >
        <FileImageOutlined />
      </button>
      {onDownload && (
        <a
          className="image-preview-img2img-button"
          title="下载"
          aria-label="下载"
          href={src}
          download={downloadFilename ?? `image-${Date.now()}.png`}
          onClick={(e) => e.stopPropagation()}
        >
          <DownloadOutlined />
        </a>
      )}
      {onMatte && (
        <button
          type="button"
          className="image-preview-img2img-button"
          title="送入抠图"
          aria-label="送入抠图"
          onClick={(e) => {
            e.stopPropagation();
            onMatte(currentImageId, currentItem);
          }}
        >
          <ScissorOutlined />
        </button>
      )}
      {onReuse && currentItem && (
        <button
          type="button"
          className="image-preview-img2img-button"
          title="复用参数"
          aria-label="复用参数"
          onClick={(e) => {
            e.stopPropagation();
            onReuse(currentItem);
          }}
        >
          <ReloadOutlined />
        </button>
      )}
      {onFavorite && currentItem && (
        <button
          type="button"
          className={`image-preview-img2img-button${currentItem.favorited ? " image-preview-favorite-active" : ""}`}
          title={currentItem.favorited ? "取消收藏" : "收藏到素材库"}
          aria-label={currentItem.favorited ? "取消收藏" : "收藏到素材库"}
          onClick={(e) => {
            e.stopPropagation();
            onFavorite(currentItem);
          }}
        >
          {currentItem.favorited ? <StarFilled /> : <StarOutlined />}
        </button>
      )}
      {onDeleteCurrent && currentItem && (
        <button
          type="button"
          className="image-preview-img2img-button image-preview-danger-button"
          title="删除当前项"
          aria-label="删除当前项"
          disabled={!canUseItemActions}
          onClick={(e) => {
            e.stopPropagation();
            onDeleteCurrent(currentItem);
          }}
        >
          <DeleteOutlined />
        </button>
      )}
    </div>
  );
}

interface ImagePreviewWithToolbarProps {
  imageId: string;
  src: string;
  imageIds: string[];
  currentItem?: MediaItem;
  downloadFilename?: string;
  onClose: () => void;
  onImageChange: (imageId: string) => void;
  onDownload?: (imageId: string, item?: MediaItem) => void;
  onMatte?: (imageId: string, item?: MediaItem) => void;
  onImg2Img?: (imageId: string, item?: MediaItem) => void;
  onReuse?: (item: MediaItem) => void;
  onFavorite?: (item: MediaItem) => void;
  onDeleteCurrent?: (item: MediaItem) => void;
}

export function ImagePreviewWithToolbar({
  imageId,
  src,
  imageIds,
  currentItem,
  downloadFilename,
  onClose,
  onImageChange,
  onDownload,
  onMatte,
  onImg2Img,
  onReuse,
  onFavorite,
  onDeleteCurrent,
}: ImagePreviewWithToolbarProps) {
  const previewIndex = imageIds.indexOf(imageId);
  const canSwitchPreview = imageIds.length > 1 && previewIndex >= 0;

  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const scaleRef = useRef(1);

  const switchPreviewImage = useCallback((offset: -1 | 1) => {
    if (!canSwitchPreview) return;
    const nextIndex = (previewIndex + offset + imageIds.length) % imageIds.length;
    onImageChange(imageIds[nextIndex]);
  }, [canSwitchPreview, imageIds, onImageChange, previewIndex]);

  useEffect(() => {
    if (!canSwitchPreview) return;

    const onStart = (e: TouchEvent) => {
      if (!isPreviewEventTarget(e.target)) return;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      touchStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
      // 未放大时拦截 touch 事件，阻止 antd preview 拖动图片，让 swipe 专用
      if (scaleRef.current <= 1.001) {
        e.stopPropagation();
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (!isPreviewEventTarget(e.target)) return;
      const start = touchStartRef.current;
      if (!start) return;
      touchStartRef.current = null;
      // 放大状态下不触发翻页，保留 antd 原生拖拽查看细节
      if (scaleRef.current > 1.001) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const dt = Date.now() - start.t;
      // 水平 swipe 阈值：水平位移 > 40，水平位移 > 2 倍垂直位移，时间 < 1000ms
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 2 && dt < 1000) {
        switchPreviewImage(dx > 0 ? -1 : 1);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableEventTarget(e.target)) return;
      if (e.key === "ArrowLeft") switchPreviewImage(-1);
      else if (e.key === "ArrowRight") switchPreviewImage(1);
      else return;
      e.preventDefault();
    };

    // 使用捕获阶段监听，绕过 antd preview onTouchStart 的 stopPropagation
    document.addEventListener("touchstart", onStart, { passive: true, capture: true });
    document.addEventListener("touchend", onEnd, { passive: true, capture: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("touchstart", onStart, { capture: true } as EventListenerOptions);
      document.removeEventListener("touchend", onEnd, { capture: true } as EventListenerOptions);
      document.removeEventListener("keydown", onKey);
    };
  }, [canSwitchPreview, switchPreviewImage]);

  return (
    <>
      <Image
        style={{ display: "none" }}
        preview={{
          visible: true,
          onVisibleChange: (visible) => {
            if (!visible) onClose();
          },
          onTransform: (info) => {
            scaleRef.current = info.transform.scale;
          },
          src,
          toolbarRender: (originalNode, info) => (
            <ImagePreviewToolbar
              originalNode={cloneElement(originalNode, {}, info.icons.zoomOutIcon, info.icons.zoomInIcon)}
              currentImageId={imageId}
              currentItem={currentItem}
              src={src}
              downloadFilename={downloadFilename}
              onDownload={onDownload}
              onMatte={onMatte}
              onImg2Img={onImg2Img}
              onReuse={onReuse}
              onFavorite={onFavorite}
              onDeleteCurrent={onDeleteCurrent}
            />
          ),
        }}
        src={src}
      />
      {canSwitchPreview && createPortal(
        <>
          <button
            type="button"
            className="image-preview-side-nav image-preview-side-nav-left"
            title="上一张"
            aria-label="上一张"
            onClick={(e) => {
              e.stopPropagation();
              switchPreviewImage(-1);
            }}
          >
            <LeftOutlined />
          </button>
          <button
            type="button"
            className="image-preview-side-nav image-preview-side-nav-right"
            title="下一张"
            aria-label="下一张"
            onClick={(e) => {
              e.stopPropagation();
              switchPreviewImage(1);
            }}
          >
            <RightOutlined />
          </button>
        </>,
        document.body
      )}
    </>
  );
}
