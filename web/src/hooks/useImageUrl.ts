import { useEffect, useState } from "react";
import { getImage } from "@/lib/imageStore";

/**
 * useImageUrl - 将 imageId 异步解析为可用于 <img src> 的 blob URL
 *
 * 全局缓存：同一 imageId 多处使用只创建一个 blob URL，通过引用计数管理生命周期。
 * 当 refCount 降为 0 时 revoke 并清理缓存，避免内存泄漏。
 */

interface CacheEntry {
  url: string | null; // null = 加载中
  refCount: number;
  promise: Promise<void> | null;
}

const cache = new Map<string, CacheEntry>();

/**
 * 加载 imageId 对应的 blob URL（如已缓存则直接返回）。
 * 返回的 url 在缓存命中时同步可用，否则需 await 后再读取 cache。
 */
function loadImage(imageId: string): Promise<void> {
  const existing = cache.get(imageId);
  if (existing && existing.promise) return existing.promise;
  if (existing && existing.url) return Promise.resolve();

  const promise = (async () => {
    const blob = await getImage(imageId);
    const entry = cache.get(imageId);
    if (!entry) return; // 已被清理
    if (blob) {
      entry.url = URL.createObjectURL(blob);
    } else {
      entry.url = null; // 占位，表示加载完成但无数据
    }
    entry.promise = null;
  })();

  if (existing) {
    existing.promise = promise;
  } else {
    cache.set(imageId, { url: null, refCount: 0, promise });
  }
  return promise;
}

/** 同步读取已缓存的 url（未加载返回 undefined） */
function getCachedUrl(imageId: string): string | undefined {
  const entry = cache.get(imageId);
  if (!entry) return undefined;
  return entry.url ?? undefined;
}

export function useImageUrl(imageId: string | undefined | null): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() =>
    imageId ? getCachedUrl(imageId) : undefined
  );

  useEffect(() => {
    if (!imageId) {
      setUrl(undefined);
      return;
    }

    // 引用计数 +1
    const entry = cache.get(imageId);
    if (entry) {
      entry.refCount += 1;
    } else {
      cache.set(imageId, { url: null, refCount: 1, promise: null });
    }

    // 同步命中
    const cached = getCachedUrl(imageId);
    if (cached !== undefined) {
      setUrl(cached);
    } else {
      setUrl(undefined);
    }

    // 异步加载
    let cancelled = false;
    loadImage(imageId).then(() => {
      if (cancelled) return;
      setUrl(getCachedUrl(imageId));
    });

    return () => {
      cancelled = true;
      const e = cache.get(imageId);
      if (!e) return;
      e.refCount = Math.max(0, e.refCount - 1);
      if (e.refCount === 0) {
        if (e.url) URL.revokeObjectURL(e.url);
        cache.delete(imageId);
      }
    };
  }, [imageId]);

  return url;
}

/**
 * 同步获取 imageId 对应的 blob URL（不通过 hook）。
 * 用于回调中需要立即拿到 URL 的场景。调用方负责 revoke 返回的 URL。
 */
export async function fetchImageUrl(imageId: string): Promise<string | undefined> {
  const cached = getCachedUrl(imageId);
  if (cached) return cached;
  await loadImage(imageId);
  return getCachedUrl(imageId);
}

/** 清理 hook 缓存中指定 imageId（用于从 store 删除时同步清理） */
export function evictImageUrl(imageId: string): void {
  const entry = cache.get(imageId);
  if (!entry) return;
  if (entry.url) URL.revokeObjectURL(entry.url);
  cache.delete(imageId);
}
