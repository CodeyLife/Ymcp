import { useState, useMemo } from "react";
import {
  App,
} from "antd";
import {
  HistoryOutlined,
} from "@ant-design/icons";
import { useHistoryStore, type HistoryItem } from "@/stores/history";
import { useAssetStore } from "@/stores/asset";
import { downloadBlob } from "@/lib/canvas";
import { getImage, setImage } from "@/lib/imageStore";
import { useImageUrl } from "@/hooks/useImageUrl";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/showtime";
import { MediaGallery, type MediaItem, type MediaBadge } from "@/components/MediaGallery";
import { getNextPreviewImageIdAfterDelete, ImagePreviewWithToolbar } from "@/components/ImagePreviewToolbar";
import { sendImageToImageGenReference } from "@/lib/imageGenReference";

const MODE_BADGE: Record<HistoryItem["mode"], MediaBadge> = {
  text2img: { label: "文生图", color: "emerald" },
  img2img:  { label: "图生图", color: "violet" },
};

function formatTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (d.toDateString() === now.toDateString()) return `今天 ${d.toTimeString().slice(0, 5)}`;
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function History() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const items = useHistoryStore((s) => s.items);
  const removeMany = useHistoryStore((s) => s.removeMany);
  const removeImage = useHistoryStore((s) => s.removeImage);
  const assets = useAssetStore((s) => s.items);
  const assetGroups = useAssetStore((s) => s.groups);
  const addAsset = useAssetStore((s) => s.add);
  const removeByHistoryId = useAssetStore((s) => s.removeByHistoryId);
  const moveItemToGroup = useAssetStore((s) => s.moveItemToGroup);
  const [previewImageId, setPreviewImageId] = useState<string | null>(null);
  const previewSrc = useImageUrl(previewImageId);

  // 从素材库派生"已收藏的历史项 id 集合"：收藏 = 写入素材库并附带 historyId
  const favoritedIds = useMemo(() => {
    const set = new Set<string>();
    for (const a of assets) {
      const hid = a.metadata.historyId;
      if (hid) set.add(hid);
    }
    return set;
  }, [assets]);

  // 归一化为 MediaItem（与 Assets 使用相同结构）
  const mediaItems: MediaItem[] = items.map((h) => ({
    id: h.id,
    imageIds: h.imageIds,
    title: h.prompt || "(无提示词)",
    metas: [
      { label: "time", value: formatTime(h.createdAt) },
      { label: "size", value: h.size === "auto" ? "auto" : h.size },
    ],
    badge: MODE_BADGE[h.mode],
    favorited: favoritedIds.has(h.id),
    raw: h,
  }));
  const previewImageIds = useMemo(
    () => mediaItems.flatMap((item) => item.imageIds),
    [mediaItems]
  );
  const previewItem = useMemo(
    () => mediaItems.find((item) => previewImageId ? item.imageIds.includes(previewImageId) : false),
    [mediaItems, previewImageId]
  );
  // 当前预览图对应的已收藏素材（仅已收藏时存在）
  const previewAsset = useMemo(() => {
    const h = previewItem?.raw as HistoryItem | undefined;
    if (!h) return undefined;
    return assets.find((a) => a.metadata.historyId === h.id);
  }, [assets, previewItem]);

  async function downloadImage(imageId: string) {
    try {
      const blob = await getImage(imageId);
      if (!blob) {
        message.error("图片加载失败");
        return;
      }
      downloadBlob(blob, `history-${Date.now()}.png`);
    } catch {
      message.error("下载失败");
    }
  }

  async function sendToImageGen(imageId: string) {
    await sendImageToImageGenReference(imageId, {
      navigate,
      onSuccess: () => setPreviewImageId(null),
      showSuccess: (content) => message.success(content),
      showError: (content) => message.error(content),
    });
  }

  /**
   * 裁剪结果入库：
   * - 把 PNG blob 写入 imageStore，得到新 imageId
   * - 作为新 AssetItem 加入素材库（未分组），不影响历史记录
   */
  async function handleCropped(
    _imageId: string,
    item: MediaItem | undefined,
    blob: Blob,
    info: { width: number; height: number }
  ) {
    const raw = item?.raw as HistoryItem | undefined;
    const newImageId = await setImage(blob);
    const baseName = raw?.prompt?.trim().slice(0, 20) || "历史裁剪";
    addAsset({
      id: `asset-crop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: `${baseName}（裁剪 ${info.width}×${info.height}）`.slice(0, 60),
      type: "image",
      imageId: newImageId,
      tags: ["裁剪"],
      metadata: {
        width: info.width,
        height: info.height,
        size: blob.size,
      },
      createdAt: Date.now(),
    });
    message.success("已保存裁剪结果到素材库");
  }

  function reuseParams(item: MediaItem) {
    // TODO P1: 恢复参数到生图页面（提示词、尺寸、模式、模型等）
    const raw = item.raw as HistoryItem | undefined;
    void raw;
    message.info("参数已恢复（开发中）");
    navigate("/image-gen");
  }

  function handleDelete(ids: string[]) {
    // 仅删除历史记录；已收藏的图片作为独立素材保存在素材库，不受影响
    const preserved = ids.filter((id) => favoritedIds.has(id)).length;
    removeMany(ids);
    if (preserved > 0) {
      message.success(`已删除 ${ids.length} 项，其中 ${preserved} 张已收藏素材已保留在素材库`);
    } else {
      message.success(`已删除 ${ids.length} 项`);
    }
  }

  function handleDeleteCurrent(item: MediaItem) {
    const removedImageId = previewImageId;
    if (!removedImageId) return;
    const nextId = getNextPreviewImageIdAfterDelete(previewImageIds, removedImageId);
    removeImage(item.id, removedImageId);
    message.success("已删除");
    setPreviewImageId(nextId ?? null);
  }

  function buildPreviewDownloadName(item?: MediaItem) {
    const raw = item?.raw as HistoryItem | undefined;
    return `history-${raw?.id ?? Date.now()}.png`;
  }

  async function handleFavorite(item: MediaItem) {
    const h = item.raw as HistoryItem | undefined;
    if (!h) return;
    const imageId = h.imageIds[0];
    if (!imageId) return;

    if (favoritedIds.has(h.id)) {
      // 取消收藏：移除由该历史项收藏而来的素材
      removeByHistoryId(h.id);
    } else {
      // 收藏：复制图片到独立 imageId（避免 history 删除时清理影响 asset）
      try {
        const blob = await getImage(imageId);
        if (!blob) {
          message.error("图片加载失败");
          return;
        }
        const newImageId = await setImage(blob);
        addAsset({
          id: `asset-fav-${h.id}-${Date.now().toString(36)}`,
          name: h.prompt ? h.prompt.slice(0, 20) : "历史收藏",
          type: "image",
          imageId: newImageId,
          tags: ["收藏", h.mode],
          metadata: { historyId: h.id },
          createdAt: Date.now(),
        });
      } catch {
        message.error("收藏失败");
      }
    }
  }

  return (
    <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 28px 48px" }}>
      <PageHeader
        title="历史记录"
        description="所有生图记录自动保存到本地，支持回看、下载、复用参数和批量删除。"
        icon={<HistoryOutlined />}
      />

      <MediaGallery
        items={mediaItems}
        emptyIcon={<HistoryOutlined />}
        emptyTitle="暂无历史记录"
        emptyDescription="生成的作品会自动保存在这里，支持回看、复用参数与收藏。"
        onPreview={(imageId) => setPreviewImageId(imageId)}
        onDownload={(imageId) => downloadImage(imageId)}
        getDownloadFilename={(_, item) => buildPreviewDownloadName(item)}
        onImg2Img={(imageId) => void sendToImageGen(imageId)}
        onReuse={reuseParams}
        onFavorite={handleFavorite}
        onDelete={handleDelete}
      />

      {/* 大图预览 */}
      {previewImageId && previewSrc && (
        <ImagePreviewWithToolbar
          imageId={previewImageId}
          src={previewSrc}
          imageIds={previewImageIds}
          currentItem={previewItem}
          downloadFilename={buildPreviewDownloadName(previewItem)}
          onClose={() => setPreviewImageId(null)}
          onImageChange={setPreviewImageId}
          onDownload={downloadImage}
          onImg2Img={(imageId) => void sendToImageGen(imageId)}
          onReuse={reuseParams}
          onFavorite={(item) => void handleFavorite(item)}
          onDeleteCurrent={handleDeleteCurrent}
          onCrop={handleCropped}
          cropTitle="裁剪并保存到素材库"
          currentAssetId={previewAsset?.id}
          currentGroupId={previewAsset?.groupId}
          groups={assetGroups}
          onMoveToGroup={moveItemToGroup}
        />
      )}
    </div>
  );
}
