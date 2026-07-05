import { createPortal } from "react-dom";
import type { AssetGroup } from "@/stores/asset";

interface ImagePreviewGroupTabsProps {
  /** 当前图片对应的素材 id；为空时不渲染 */
  currentAssetId?: string;
  /** 当前素材所属分组 id；undefined = 未分组 */
  currentGroupId?: string;
  groups: AssetGroup[];
  onMoveToGroup: (assetId: string, groupId: string | undefined) => void;
}

/**
 * 大图预览顶部分组快捷切换浮层。
 * 仅当 currentAssetId 存在时渲染，点击 Tab 即把当前素材移动到对应分组。
 */
export function ImagePreviewGroupTabs({
  currentAssetId,
  currentGroupId,
  groups,
  onMoveToGroup,
}: ImagePreviewGroupTabsProps) {
  if (!currentAssetId || typeof document === "undefined") return null;

  const handleMove = (groupId: string | undefined) => {
    if (groupId === currentGroupId) return;
    onMoveToGroup(currentAssetId, groupId);
  };

  return createPortal(
    <div className="image-preview-group-tabs" role="tablist" aria-label="收藏分组切换">
      <button
        type="button"
        role="tab"
        aria-selected={currentGroupId === undefined}
        className={`image-preview-group-tab${currentGroupId === undefined ? " image-preview-group-tab-active" : ""}`}
        onClick={() => handleMove(undefined)}
      >
        未分组
      </button>
      {groups.map((g) => (
        <button
          key={g.id}
          type="button"
          role="tab"
          aria-selected={currentGroupId === g.id}
          className={`image-preview-group-tab${currentGroupId === g.id ? " image-preview-group-tab-active" : ""}`}
          onClick={() => handleMove(g.id)}
        >
          {g.name}
        </button>
      ))}
    </div>,
    document.body
  );
}
