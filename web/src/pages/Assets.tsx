import { useMemo, useRef, useState } from "react";
import {
  App, Input, Dropdown,
} from "antd";
import type { MenuProps } from "antd";
import {
  AppstoreOutlined, SearchOutlined,
  PlusOutlined, MoreOutlined, EditOutlined, DeleteOutlined, UploadOutlined,
} from "@ant-design/icons";
import { useAssetStore, type AssetItem } from "@/stores/asset";
import { downloadBlob } from "@/lib/canvas";
import { getImage, setImage } from "@/lib/imageStore";
import { useImageUrl } from "@/hooks/useImageUrl";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/showtime";
import { MediaGallery, type MediaItem } from "@/components/MediaGallery";
import { getNextPreviewImageIdAfterDelete, ImagePreviewWithToolbar } from "@/components/ImagePreviewToolbar";
import { sendImageToImageGenReference } from "@/lib/imageGenReference";

type GroupFilter =
  | { type: "all" }
  | { type: "ungrouped" }
  | { type: "group"; groupId: string };

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
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const items = useAssetStore((s) => s.items);
  const groups = useAssetStore((s) => s.groups);
  const addAsset = useAssetStore((s) => s.add);
  const removeMany = useAssetStore((s) => s.removeMany);
  const createGroup = useAssetStore((s) => s.createGroup);
  const renameGroup = useAssetStore((s) => s.renameGroup);
  const deleteGroup = useAssetStore((s) => s.deleteGroup);
  const moveItemToGroup = useAssetStore((s) => s.moveItemToGroup);
  // 默认选中第二个分组「未分组」
  const [filter, setFilter] = useState<GroupFilter>({ type: "ungrouped" });
  const [search, setSearch] = useState("");
  const [previewImageId, setPreviewImageId] = useState<string | null>(null);
  // 进入大图预览时锁定的上下文：imageIds 列表与 imageId → MediaItem 映射。
  // 切换收藏分组不影响上下切换与功能按钮，上下切换以进入预览时的列表为准。
  const [previewContext, setPreviewContext] = useState<{
    imageIds: string[];
    itemMap: Map<string, MediaItem>;
  } | null>(null);
  const previewSrc = useImageUrl(previewImageId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // memoize：避免 previewImageId 变化时重算过滤与映射，导致下游 MediaGallery 的 useMemo 失效
  const filtered = useMemo(
    () => items.filter((item) => {
      if (filter.type === "ungrouped" && item.groupId !== undefined) return false;
      if (filter.type === "group" && item.groupId !== filter.groupId) return false;
      if (search && !item.name.toLowerCase().includes(search.toLowerCase()) &&
          !item.tags.some((t) => t.toLowerCase().includes(search.toLowerCase()))) return false;
      return true;
    }),
    [items, filter, search]
  );

  // 归一化为 MediaItem
  const mediaItems: MediaItem[] = useMemo(
    () => filtered.map((a) => {
      const metas = [{ label: "time", value: formatTime(a.createdAt) }];
      const sizeStr = formatSize(a.metadata.size);
      if (sizeStr) metas.push({ label: "size", value: sizeStr });
      return {
        id: a.id,
        imageIds: [a.imageId],
        title: a.name,
        metas,
        raw: a,
      };
    }),
    [filtered]
  );
  // 锁定的 imageIds（上下切换以此为准，切换分组不影响）
  const lockedImageIds = previewContext?.imageIds ?? [];
  // 锁定的 currentItem（功能按钮以此为准，切换分组不影响）
  const lockedCurrentItem = previewImageId ? previewContext?.itemMap.get(previewImageId) : undefined;
  // 实时的 previewAsset（分组 Tab 高亮实时反映分组变化）
  const previewAsset = useMemo(
    () => items.find((a) => a.imageId === previewImageId),
    [items, previewImageId]
  );

  const openPreview = (imageId: string) => {
    setPreviewContext({
      imageIds: mediaItems.flatMap((item) => item.imageIds),
      itemMap: new Map(mediaItems.flatMap((item) => item.imageIds.map((id) => [id, item]))),
    });
    setPreviewImageId(imageId);
  };

  const closePreview = () => {
    setPreviewImageId(null);
    setPreviewContext(null);
  };

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

  async function sendToImageGen(imageId: string) {
    await sendImageToImageGenReference(imageId, {
      navigate,
      onSuccess: () => closePreview(),
      showSuccess: (content) => message.success(content),
      showError: (content) => message.error(content),
    });
  }

  /**
   * 裁剪结果入库：
   * - 把 PNG blob 写入 imageStore，得到新 imageId
   * - 作为新 AssetItem 加入素材库，归入当前预览素材所在分组（若有）
   * - 不影响原图，原图仍在素材库中
   */
  async function handleCropped(
    _imageId: string,
    item: MediaItem | undefined,
    blob: Blob,
    info: { width: number; height: number }
  ) {
    const raw = item?.raw as AssetItem | undefined;
    const newImageId = await setImage(blob);
    const baseName = raw?.name?.replace(/\.[^.]+$/, "") || "素材";
    addAsset({
      id: `asset-crop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: `${baseName}（裁剪 ${info.width}×${info.height}）`.slice(0, 60),
      type: "image",
      imageId: newImageId,
      tags: ["裁剪"],
      groupId: raw?.groupId,
      metadata: {
        width: info.width,
        height: info.height,
        size: blob.size,
      },
      createdAt: Date.now(),
    });
    message.success("已保存裁剪结果到当前分组");
  }

  function handleDelete(ids: string[]) {
    removeMany(ids);
    message.success(`已删除 ${ids.length} 项`);
  }

  function handleDeleteCurrent(item: MediaItem) {
    const nextId = getNextPreviewImageIdAfterDelete(lockedImageIds, previewImageId);
    handleDelete([item.id]);
    if (nextId) {
      setPreviewImageId(nextId);
      // 从锁定的上下文中移除已删除项，避免上下切换到已删除的图片
      const removedImageIds = new Set(item.imageIds);
      setPreviewContext((prev) => {
        if (!prev) return prev;
        const newItemMap = new Map(prev.itemMap);
        removedImageIds.forEach((id) => newItemMap.delete(id));
        return {
          imageIds: prev.imageIds.filter((id) => !removedImageIds.has(id)),
          itemMap: newItemMap,
        };
      });
    } else {
      closePreview();
    }
  }

  function buildPreviewDownloadName(item?: MediaItem) {
    const raw = item?.raw as AssetItem | undefined;
    const name = raw?.name?.trim();
    if (!name) return `asset-${Date.now()}.png`;
    return /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.png`;
  }

  async function handleUploadFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) {
      message.warning("请选择图片文件");
      return;
    }
    setUploading(true);
    // 上传归属规则：当前在某个分组内则归入该分组，否则归入「未分组」
    const targetGroupId = filter.type === "group" ? filter.groupId : undefined;
    let success = 0;
    try {
      for (const file of files) {
        try {
          const imageId = await setImage(file);
          const baseName = file.name.replace(/\.[^.]+$/, "");
          addAsset({
            id: `asset-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            name: baseName.slice(0, 40) || "上传素材",
            type: "image",
            imageId,
            tags: ["上传"],
            groupId: targetGroupId,
            metadata: {
              size: file.size,
            },
            createdAt: Date.now(),
          });
          success += 1;
        } catch {
          // 单张失败跳过，继续处理后续
        }
      }
      if (success > 0) {
        message.success(`已上传 ${success} 张图片`);
      } else {
        message.error("上传失败");
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleCreateGroup() {
    let name = "";
    modal.confirm({
      title: "新建分组",
      content: (
        <Input
          placeholder="分组名称"
          maxLength={20}
          autoFocus
          onChange={(e) => { name = e.target.value; }}
        />
      ),
      onOk: () => {
        const trimmed = name.trim();
        if (!trimmed) {
          message.warning("分组名称不能为空");
          return Promise.reject();
        }
        const id = createGroup(trimmed);
        setFilter({ type: "group", groupId: id });
        message.success("已创建分组");
      },
    });
  }

  function handleRenameGroup(id: string, oldName: string) {
    let name = oldName;
    modal.confirm({
      title: "重命名分组",
      content: (
        <Input
          placeholder="分组名称"
          maxLength={20}
          defaultValue={oldName}
          autoFocus
          onChange={(e) => { name = e.target.value; }}
        />
      ),
      onOk: () => {
        const trimmed = name.trim();
        if (!trimmed) {
          message.warning("分组名称不能为空");
          return Promise.reject();
        }
        renameGroup(id, trimmed);
        message.success("已重命名");
      },
    });
  }

  function handleDeleteGroup(id: string, name: string) {
    deleteGroup(id);
    setFilter({ type: "all" });
    message.success(`已删除分组「${name}」`);
  }

  function buildGroupMenu(group: { id: string; name: string }): MenuProps["items"] {
    return [
      {
        key: "rename",
        label: "重命名",
        icon: <EditOutlined />,
        onClick: () => handleRenameGroup(group.id, group.name),
      },
      {
        key: "delete",
        label: "删除分组",
        icon: <DeleteOutlined />,
        danger: true,
        onClick: () => {
          modal.confirm({
            title: `删除分组「${group.name}」？`,
            content: "分组内的素材将移至「未分组」，不会被删除。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: () => handleDeleteGroup(group.id, group.name),
          });
        },
      },
    ];
  }

  const isActive = (f: GroupFilter) => {
    if (filter.type === "all" && f.type === "all") return true;
    if (filter.type === "ungrouped" && f.type === "ungrouped") return true;
    if (filter.type === "group" && f.type === "group") return filter.groupId === f.groupId;
    return false;
  };

  return (
    <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 28px 48px" }}>
      <PageHeader
        title="素材库"
        description="收藏的图片统一管理，支持自定义分组、搜索和批量删除。"
        icon={<AppstoreOutlined />}
      />

      {/* 分组 Tab 栏 */}
      <div className="asset-group-tabs" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className={`asset-group-tab${isActive({ type: "all" }) ? " asset-group-tab-active" : ""}`}
          onClick={() => setFilter({ type: "all" })}
        >
          全部
        </button>
        <button
          type="button"
          className={`asset-group-tab${isActive({ type: "ungrouped" }) ? " asset-group-tab-active" : ""}`}
          onClick={() => setFilter({ type: "ungrouped" })}
        >
          未分组
        </button>
        {groups.map((g) => (
          <div
            key={g.id}
            className={`asset-group-tab-wrapper${isActive({ type: "group", groupId: g.id }) ? " asset-group-tab-active" : ""}`}
            style={{ display: "inline-flex", alignItems: "center" }}
          >
            <button
              type="button"
              className="asset-group-tab"
              onClick={() => setFilter({ type: "group", groupId: g.id })}
            >
              {g.name}
            </button>
            <Dropdown menu={{ items: buildGroupMenu(g) }} trigger={["click"]}>
              <button
                type="button"
                className="asset-group-tab-more"
                title="管理分组"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreOutlined />
              </button>
            </Dropdown>
          </div>
        ))}
        <button
          type="button"
          className="asset-group-tab asset-group-tab-add"
          onClick={handleCreateGroup}
          title="新建分组"
        >
          <PlusOutlined /> 新建
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => void handleUploadFiles(e.target.files)}
          style={{ display: "none" }}
        />
        <button
          type="button"
          className="asset-group-tab asset-group-tab-upload"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          title="上传图片到素材库"
        >
          <UploadOutlined /> {uploading ? "上传中..." : "上传"}
        </button>
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
        emptyDescription="在生图页或历史记录中收藏图片，即可在此管理。"
        onPreview={openPreview}
        onDownload={(imageId) => downloadImage(imageId)}
        getDownloadFilename={(_, item) => buildPreviewDownloadName(item)}
        onImg2Img={(imageId) => void sendToImageGen(imageId)}
        onDelete={handleDelete}
      />

      {/* 大图预览 */}
      {previewImageId && previewSrc && (
        <ImagePreviewWithToolbar
          imageId={previewImageId}
          src={previewSrc}
          imageIds={lockedImageIds}
          currentItem={lockedCurrentItem}
          downloadFilename={buildPreviewDownloadName(lockedCurrentItem)}
          onClose={closePreview}
          onImageChange={setPreviewImageId}
          onDownload={downloadImage}
          onImg2Img={(imageId) => void sendToImageGen(imageId)}
          onDeleteCurrent={handleDeleteCurrent}
          onCrop={handleCropped}
          cropTitle="裁剪并保存到素材库"
          currentAssetId={previewAsset?.id}
          currentGroupId={previewAsset?.groupId}
          groups={groups}
          onMoveToGroup={moveItemToGroup}
        />
      )}
    </div>
  );
}
