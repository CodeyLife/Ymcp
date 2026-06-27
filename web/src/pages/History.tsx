import { useState, useMemo } from "react";
import {
  App, Image,
} from "antd";
import {
  HistoryOutlined,
} from "@ant-design/icons";
import { useHistoryStore, type HistoryItem } from "@/stores/history";
import { useAssetStore } from "@/stores/asset";
import { useUIStore } from "@/stores/ui";
import { downloadBlob } from "@/lib/canvas";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/showtime";
import { MediaGallery, type MediaItem, type MediaBadge } from "@/components/MediaGallery";

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
  const setIncomingImage = useUIStore((s) => s.setIncomingImage);
  const items = useHistoryStore((s) => s.items);
  const removeMany = useHistoryStore((s) => s.removeMany);
  const assets = useAssetStore((s) => s.items);
  const addAsset = useAssetStore((s) => s.add);
  const removeByHistoryId = useAssetStore((s) => s.removeByHistoryId);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  // 从素材库派生“已收藏的历史项 id 集合”：收藏 = 写入素材库并附带 historyId
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
    images: h.images,
    title: h.prompt || "(无提示词)",
    metas: [
      { label: "time", value: formatTime(h.createdAt) },
      { label: "size", value: h.size === "auto" ? "auto" : h.size },
    ],
    badge: MODE_BADGE[h.mode],
    favorited: favoritedIds.has(h.id),
    raw: h,
  }));

  async function downloadImage(src: string) {
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      downloadBlob(blob, `history-${Date.now()}.png`);
    } catch {
      message.error("下载失败");
    }
  }

  function sendToMatte(src: string) {
    setIncomingImage({ src, from: "history" });
    navigate("/matte");
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

  function handleFavorite(item: MediaItem) {
    const h = item.raw as HistoryItem | undefined;
    if (!h) return;
    const src = h.images[0];
    if (!src) return;

    if (favoritedIds.has(h.id)) {
      // 取消收藏：移除由该历史项收藏而来的素材
      removeByHistoryId(h.id);
      message.info("已取消收藏");
    } else {
      // 收藏：将图片作为独立素材写入素材库，附带 historyId 反向关联
      addAsset({
        id: `asset-fav-${h.id}-${Date.now().toString(36)}`,
        name: h.prompt ? h.prompt.slice(0, 20) : "历史收藏",
        type: "image",
        src,
        thumbnail: src,
        tags: ["收藏", h.mode],
        source: "generated",
        metadata: { historyId: h.id },
        createdAt: Date.now(),
      });
      message.success("已收藏到素材库");
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
        onPreview={(src) => setPreviewSrc(src)}
        onDownload={(src) => downloadImage(src)}
        onMatte={(src) => sendToMatte(src)}
        onReuse={reuseParams}
        onFavorite={handleFavorite}
        onDelete={handleDelete}
      />

      {/* 大图预览 */}
      {previewSrc && (
        <Image
          style={{ display: "none" }}
          preview={{
            visible: !!previewSrc,
            onVisibleChange: (v) => !v && setPreviewSrc(null),
            src: previewSrc,
          }}
          src={previewSrc}
        />
      )}
    </div>
  );
}
