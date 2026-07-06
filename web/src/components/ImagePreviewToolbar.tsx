import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { ImagePreviewActionToolbar, type ImagePreviewAction } from "@/components/ImagePreviewActionToolbar";
import { ImagePreviewGroupTabs } from "@/components/ImagePreviewGroupTabs";
import { ImageCropModal } from "@/components/ImageCropModal";
import { ImageCachePinner } from "@/components/ImageCachePinner";
import type { AssetGroup } from "@/stores/asset";

const PREVIEW_CACHE_PIN_RADIUS = 2;

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
  onImg2Img?: (imageId: string, item?: MediaItem) => void;
  onReuse?: (item: MediaItem) => void;
  onFavorite?: (item: MediaItem) => void;
  onDeleteCurrent?: (item: MediaItem) => void;
  onCrop?: (imageId: string, item?: MediaItem) => void;
  /**
   * 自定义工具栏 actions。传入时跳过内部默认 actions 组装（img2img/裁剪/下载/复用/收藏/删除），
   * 直接用调用方提供的列表渲染。适用于 actions 与默认集合差异较大的场景（如 ImageGen）。
   */
  actions?: ImagePreviewAction[];
}

function ImagePreviewToolbar({
  originalNode,
  currentImageId,
  currentItem,
  src,
  downloadFilename,
  onDownload,
  onImg2Img,
  onReuse,
  onFavorite,
  onDeleteCurrent,
  onCrop,
  actions: customActions,
}: ImagePreviewToolbarProps) {
  const canUseItemActions = Boolean(currentItem);

  const defaultActions = useMemo<ImagePreviewAction[]>(() => {
    const list: ImagePreviewAction[] = [
      {
        key: "img2img",
        title: "用作图生图参考图",
        icon: <FileImageOutlined />,
        disabled: !onImg2Img,
        onClick: () => onImg2Img?.(currentImageId, currentItem),
      },
    ];

    if (onCrop) {
      list.push({
        key: "crop",
        title: "裁剪图片",
        icon: <ScissorOutlined />,
        onClick: () => onCrop(currentImageId, currentItem),
      });
    }

    if (onDownload) {
      list.push({
        key: "download",
        title: "下载",
        icon: <DownloadOutlined />,
        href: src,
        download: downloadFilename ?? `image-${Date.now()}.png`,
      });
    }

    if (onReuse && currentItem) {
      list.push({
        key: "reuse",
        title: "复用参数",
        icon: <ReloadOutlined />,
        onClick: () => onReuse(currentItem),
      });
    }

    if (onFavorite && currentItem) {
      list.push({
        key: "favorite",
        title: currentItem.favorited ? "取消收藏" : "收藏到素材库",
        icon: currentItem.favorited ? <StarFilled /> : <StarOutlined />,
        active: currentItem.favorited,
        onClick: () => onFavorite(currentItem),
      });
    }

    if (onDeleteCurrent && currentItem) {
      list.push({
        key: "delete",
        title: "删除当前项",
        icon: <DeleteOutlined />,
        danger: true,
        disabled: !canUseItemActions,
        onClick: () => onDeleteCurrent(currentItem),
      });
    }

    return list;
  }, [
    canUseItemActions,
    currentImageId,
    currentItem,
    downloadFilename,
    onCrop,
    onDeleteCurrent,
    onDownload,
    onFavorite,
    onImg2Img,
    onReuse,
    src,
  ]);

  return (
    <ImagePreviewActionToolbar
      originalNode={originalNode}
      actions={customActions ?? defaultActions}
    />
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
  onImg2Img?: (imageId: string, item?: MediaItem) => void;
  onReuse?: (item: MediaItem) => void;
  onFavorite?: (item: MediaItem) => void;
  onDeleteCurrent?: (item: MediaItem) => void;
  /**
   * 裁剪结果回调：用户在裁剪模态里确认后触发，blob 为 PNG。
   * 传入此回调会在工具栏出现「裁剪图片」按钮。
   */
  onCrop?: (imageId: string, item: MediaItem | undefined, blob: Blob, info: { width: number; height: number }) => void | Promise<void>;
  /** 裁剪模态标题，默认「裁剪图片」 */
  cropTitle?: string;
  /** 当前图片对应的素材 id（用于分组 Tab，存在则显示 Tab） */
  currentAssetId?: string;
  /** 当前素材所属分组 id */
  currentGroupId?: string;
  /** 自定义分组列表 */
  groups?: AssetGroup[];
  /** 移动素材到指定分组 */
  onMoveToGroup?: (assetId: string, groupId: string | undefined) => void;
  /**
   * 自定义工具栏 actions。传入时跳过内部默认 actions 组装（img2img/裁剪/下载/复用/收藏/删除），
   * 直接用调用方提供的列表渲染。适用于 actions 与默认集合差异较大的场景（如 ImageGen）。
   */
  actions?: ImagePreviewAction[];
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
  onImg2Img,
  onReuse,
  onFavorite,
  onDeleteCurrent,
  onCrop,
  cropTitle,
  currentAssetId,
  currentGroupId,
  groups,
  onMoveToGroup,
  actions,
}: ImagePreviewWithToolbarProps) {
  const previewIndex = imageIds.indexOf(imageId);
  const canSwitchPreview = imageIds.length > 1 && previewIndex >= 0;
  const pinnedImageIds = useMemo(() => {
    if (previewIndex < 0) return [];
    const start = Math.max(0, previewIndex - PREVIEW_CACHE_PIN_RADIUS);
    const end = Math.min(imageIds.length, previewIndex + PREVIEW_CACHE_PIN_RADIUS + 1);
    return imageIds.slice(start, end);
  }, [imageIds, previewIndex]);

  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const scaleRef = useRef(1);
  const [cropOpen, setCropOpen] = useState(false);
  const cropContextRef = useRef<{ imageId: string; item: MediaItem | undefined } | null>(null);

  const openCrop = useCallback(
    (id: string, item: MediaItem | undefined) => {
      cropContextRef.current = { imageId: id, item };
      setCropOpen(true);
    },
    []
  );

  const handleCrop = useCallback(
    async (blob: Blob, info: { width: number; height: number }) => {
      const ctx = cropContextRef.current;
      if (!ctx || !onCrop) return;
      await onCrop(ctx.imageId, ctx.item, blob, info);
    },
    [onCrop]
  );

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
          toolbarRender: (_originalNode, _info) => (
            <ImagePreviewToolbar
              originalNode={null}
              currentImageId={imageId}
              currentItem={currentItem}
              src={src}
              downloadFilename={downloadFilename}
              onDownload={onDownload}
              onImg2Img={onImg2Img}
              onReuse={onReuse}
              onFavorite={onFavorite}
              onDeleteCurrent={onDeleteCurrent}
              onCrop={onCrop ? openCrop : undefined}
              actions={actions}
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
          {/* 索引徽章：当前位置 / 总数。previewIndex 与 imageIds.length 已就绪，零新 props */}
          <div className="image-preview-index-badge" aria-live="polite">
            {previewIndex + 1} / {imageIds.length}
          </div>
        </>,
        document.body
      )}
      {currentAssetId && onMoveToGroup && groups && (
        <ImagePreviewGroupTabs
          currentAssetId={currentAssetId}
          currentGroupId={currentGroupId}
          groups={groups}
          onMoveToGroup={onMoveToGroup}
        />
      )}
      {onCrop && (
        <ImageCropModal
          open={cropOpen}
          src={src}
          title={cropTitle}
          onClose={() => setCropOpen(false)}
          onCrop={handleCrop}
        />
      )}
      {pinnedImageIds.length > 0 && (
        <ImageCachePinner ids={pinnedImageIds} />
      )}
    </>
  );
}
