import { get, set, del, delMany, clear, createStore } from "idb-keyval";

/**
 * IndexedDB 图片存储
 *
 * 设计目的：替代 localStorage 存放生图历史 / 素材库的图片数据。
 * localStorage 5MB 配额极易被 base64 图片撑爆，导致刷新后历史记录丢失。
 * IndexedDB 容量数百 MB 起步，原生支持 Blob 存储（无 base64 膨胀）。
 *
 * 数据模型：key = imageId（"img-{timestamp}-{rand}"），value = Blob。
 * zustand store 中只保存 imageId 引用，图片本体在此处单独分条存储。
 */

const imageStore = createStore("ymcp-image-db", "images");

/** 生成 imageId */
function genId(): string {
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 存入一张图片，返回 imageId */
export async function setImage(blob: Blob): Promise<string> {
  const id = genId();
  await set(id, blob, imageStore);
  return id;
}

/** 根据 imageId 取回图片 Blob */
export async function getImage(id: string): Promise<Blob | undefined> {
  return await get<Blob>(id, imageStore);
}

/** 删除单张图片 */
export async function deleteImage(id: string): Promise<void> {
  await del(id, imageStore);
}

/** 批量删除图片 */
export async function deleteManyImages(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await delMany(ids, imageStore);
}

/** 清空所有图片（用于清空历史 / 素材库时） */
export async function clearAllImages(): Promise<void> {
  await clear(imageStore);
}
