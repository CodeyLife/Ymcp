import { useState } from "react";
import {
  App, Image, Segmented, Input,
} from "antd";
import {
  AppstoreOutlined, UploadOutlined, SearchOutlined,
} from "@ant-design/icons";
import { useAssetStore, type AssetItem } from "@/stores/asset";
import { useUIStore } from "@/stores/ui";
import { downloadBlob } from "@/lib/canvas";
import { getImage, setImage } from "@/lib/imageStore";
import { useImageUrl } from "@/hooks/useImageUrl";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/showtime";
import { MediaGallery, type MediaItem, type MediaBadge } from "@/components/MediaGallery";
import { FileUploadTrigger } from "@/components/FileUploadTrigger";

type FilterType = "all" | "generated" | "uploaded" | "matte";

const SOURCE_BADGE: Record<AssetItem["source"], MediaBadge> = {
  generated: { label: "AI", color: "emerald" },
  uploaded:  { label: "上传", color: "blue" },
  matte:     { label: "抠图", color: "orange" },
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

function formatSize(bytes?: number) {
  if (!bytes) return undefined;
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export default function Assets() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const setIncomingImage = useUIStore((s) => s.setIncomingImage);
  const items = useAssetStore((s) => s.items);
  const add = useAssetStore((s) => s.add);
  const removeMany = useAssetStore((s) => s.removeMany);
  const [filter, setFilter] = useState<FilterType>("all");
  const [search, setSearch] = useState("");
  const [previewImageId, setPreviewImageId] = useState<string | null>(null);
  const previewSrc = useImageUrl(previewImageId);

  const filtered = items.filter((item) => {
    if (filter !== "all" && item.source !== filter) return false;
    if (search && !item.name.toLowerCase().includes(search.toLowerCase()) &&
        !item.tags.some((t) => t.toLowerCase().includes(search.toLowerCase()))) return false;
    return true;
  });

  // 归一化为 MediaItem
  const mediaItems: MediaItem[] = filtered.map((a) => {
    const metas = [{ label: "time", value: formatTime(a.createdAt) }];
    const sizeStr = formatSize(a.metadata.size);
    if (sizeStr) metas.push({ label: "size", value: sizeStr });
    return {
      id: a.id,
      imageIds: [a.imageId],
      title: a.name,
      metas,
      badge: SOURCE_BADGE[a.source],
      raw: a,
    };
  });

  async function downloadImage(imageId: string) {
    try {
      const blob = await getImage(imageId);
      if (!blob) {
        message.error("图片加载失败");
        return;
      }
      downloadBlob(blob, `asset-${Date.now()}.png`);
    } catch {
      message.error("下载失败");
    }
  }

  async function sendToMatte(imageId: string) {
    try {
      const blob = await getImage(imageId);
      if (!blob) {
        message.error("图片加载失败");
        return;
      }
      const url = URL.createObjectURL(blob);
      setIncomingImage({ src: url, from: "assets" });
      navigate("/matte");
    } catch {
      message.error("图片加载失败");
    }
  }

  async function handleUpload(files: FileList) {
    let count = 0;
    for (const file of Array.from(files)) {
      // 直接将 File（Blob 子类）存入 IndexedDB，返回 imageId 持久化引用
      const imageId = await setImage(file);
      add({
        id: `asset-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        type: "image",
        imageId,
        tags: ["上传"],
        source: "uploaded",
        metadata: { size: file.size },
        createdAt: Date.now(),
      });
      count++;
    }
    message.success(`已上传 ${count} 张图片`);
  }

  function handleDelete(ids: string[]) {
    removeMany(ids);
    message.success(`已删除 ${ids.length} 项`);
  }

  return (
    <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 28px 48px" }}>
      <PageHeader
        title="素材库"
        description="生成和上传的图片统一管理，支持搜索、筛选、批量删除和快速抠图。"
        icon={<AppstoreOutlined />}
        extra={
          <FileUploadTrigger
            accept="image/*"
            multiple
            label="上传"
            hint="PNG / JPEG / WebP"
            icon={<UploadOutlined />}
            onFiles={handleUpload}
          />
        }
      />

      {/* 筛选栏 */}
      <div style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <Segmented
          value={filter}
          onChange={(v) => setFilter(v as FilterType)}
          options={[
            { label: "全部", value: "all" },
            { label: "AI 生成", value: "generated" },
            { label: "上传", value: "uploaded" },
            { label: "抠图", value: "matte" },
          ]}
        />
        <Input
          prefix={<SearchOutlined style={{ color: "#52525b" }} />}
          placeholder="搜索名称或标签"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 220, background: "#18181b", borderColor: "#27272a" }}
          allowClear
        />
      </div>

      <MediaGallery
        items={mediaItems}
        emptyIcon={<AppstoreOutlined />}
        emptyTitle="暂无素材"
        emptyDescription="点击右上角上传，或在生图页保存生成结果到素材库。"
        onPreview={(imageId) => setPreviewImageId(imageId)}
        onDownload={(imageId) => downloadImage(imageId)}
        onMatte={(imageId) => sendToMatte(imageId)}
        onDelete={handleDelete}
      />

      {/* 大图预览 */}
      {previewImageId && previewSrc && (
        <Image
          style={{ display: "none" }}
          preview={{
            visible: !!previewImageId,
            onVisibleChange: (v) => !v && setPreviewImageId(null),
            src: previewSrc,
          }}
          src={previewSrc}
        />
      )}
    </div>
  );
}
