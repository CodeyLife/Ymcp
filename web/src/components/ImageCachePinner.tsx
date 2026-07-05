import { useImageUrl } from "@/hooks/useImageUrl";

/**
 * ImageCachePinnerItem - 单个 imageId 的缓存钉子。
 * 仅用于通过 useImageUrl 持有 blob URL 的引用计数，不渲染任何内容。
 * 挂载时 refCount += 1 并触发加载；卸载时 refCount -= 1，归零则回收。
 */
function ImageCachePinnerItem({ id }: { id: string }) {
  useImageUrl(id);
  return null;
}

interface ImageCachePinnerProps {
  /** 需要钉住缓存引用的 imageId 列表 */
  ids: string[];
}

/**
 * ImageCachePinner - 预览期间钉住相邻图片的缓存引用。
 *
 * 用途：大图预览切换上一张/下一张时，目标图片可能不在当前分页（pageSize=24）内，
 * 导致缓存未命中、需要重新读取 IndexedDB。通过本组件对「当前 ±N」的 imageId
 * 持有 useImageUrl 引用，使其 blob URL 在预览期间不被淘汰，切换时即可瞬间命中缓存。
 *
 * 本组件不渲染任何可见内容。
 */
export function ImageCachePinner({ ids }: ImageCachePinnerProps) {
  return (
    <>
      {ids.map((id) => (
        <ImageCachePinnerItem key={id} id={id} />
      ))}
    </>
  );
}
