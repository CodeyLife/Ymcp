import type { ReactNode } from "react";
import { Image, Popconfirm } from "antd";
import {
  DeleteOutlined,
  DownOutlined,
  DownloadOutlined,
  FileImageOutlined,
  ReloadOutlined,
  ScissorOutlined,
  StarFilled,
  StarOutlined,
  UpOutlined,
} from "@ant-design/icons";
import type { MediaItem } from "@/components/MediaGallery";

interface ImagePreviewToolbarProps {
  originalNode: ReactNode;
  imageIds: string[];
  currentImageId: string;
  currentItem?: MediaItem;
  src: string;
  downloadFilename?: string;
  onImageChange: (imageId: string) => void;
  onDownload?: (imageId: string, item?: MediaItem) => void;
  onMatte?: (imageId: string, item?: MediaItem) => void;
  onImg2Img?: (imageId: string, item?: MediaItem) => void;
  onReuse?: (item: MediaItem) => void;
  onFavorite?: (item: MediaItem) => void;
  onDeleteCurrent?: (item: MediaItem) => void;
}

function ImagePreviewToolbar({
  originalNode,
  imageIds,
  currentImageId,
  currentItem,
  src,
  downloadFilename,
  onImageChange,
  onDownload,
  onMatte,
  onImg2Img,
  onReuse,
  onFavorite,
  onDeleteCurrent,
}: ImagePreviewToolbarProps) {
  const previewIndex = imageIds.indexOf(currentImageId);
  const canSwitchPreview = imageIds.length > 1 && previewIndex >= 0;
  const canUseItemActions = Boolean(currentItem);

  const switchPreviewImage = (offset: -1 | 1) => {
    if (!canSwitchPreview) return;
    const nextIndex = (previewIndex + offset + imageIds.length) % imageIds.length;
    onImageChange(imageIds[nextIndex]);
  };

  return (
    <div className="image-preview-toolbar-with-action">
      {originalNode}
      <span className="image-preview-action-separator" aria-hidden />
      <button
        type="button"
        className="image-preview-img2img-button"
        title="上一张"
        aria-label="上一张"
        disabled={!canSwitchPreview}
        onClick={(e) => {
          e.stopPropagation();
          switchPreviewImage(-1);
        }}
      >
        <UpOutlined />
      </button>
      <button
        type="button"
        className="image-preview-img2img-button"
        title="下一张"
        aria-label="下一张"
        disabled={!canSwitchPreview}
        onClick={(e) => {
          e.stopPropagation();
          switchPreviewImage(1);
        }}
      >
        <DownOutlined />
      </button>
      <button
        type="button"
        className="image-preview-img2img-button image-preview-img2img-button-primary"
        title="用作图生图参考图"
        aria-label="用作图生图参考图"
        disabled={!onImg2Img}
        onClick={(e) => {
          e.stopPropagation();
          onImg2Img?.(currentImageId, currentItem);
        }}
      >
        <FileImageOutlined />
        <span>图生图</span>
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
        <Popconfirm
          title="确认删除当前项？"
          description="此操作不可撤销"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={(e) => {
            e?.stopPropagation();
            onDeleteCurrent(currentItem);
          }}
        >
          <button
            type="button"
            className="image-preview-img2img-button image-preview-danger-button"
            title="删除当前项"
            aria-label="删除当前项"
            disabled={!canUseItemActions}
            onClick={(e) => e.stopPropagation()}
          >
            <DeleteOutlined />
          </button>
        </Popconfirm>
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
  return (
    <Image
      style={{ display: "none" }}
      preview={{
        visible: true,
        onVisibleChange: (visible) => {
          if (!visible) onClose();
        },
        src,
        toolbarRender: (originalNode) => (
          <ImagePreviewToolbar
            originalNode={originalNode}
            imageIds={imageIds}
            currentImageId={imageId}
            currentItem={currentItem}
            src={src}
            downloadFilename={downloadFilename}
            onImageChange={onImageChange}
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
  );
}
