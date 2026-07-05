import { getImage } from "@/lib/imageStore";
import { MAX_REF_IMAGES, useImageGenStore } from "@/stores/imageGen";

export interface AddReferenceResult {
  ok: boolean;
  reason?: "image-not-found" | "ref-full";
  total: number;
}

/**
 * 将指定图片作为图生图参考图追加到现有参考图列表末尾。
 * - 不再替换第一张/全部参考图，避免覆盖用户已上传的参考图。
 * - 当参考图已达上限 MAX_REF_IMAGES 时返回 ref-full，由调用方决定如何提示。
 */
export async function addImageToImg2ImgReference(imageId: string): Promise<AddReferenceResult> {
  const blob = await getImage(imageId);
  if (!blob) {
    return { ok: false, reason: "image-not-found", total: useImageGenStore.getState().refImages.length };
  }

  const url = URL.createObjectURL(blob);
  const { setMode, addRefImages, refImages } = useImageGenStore.getState();

  if (refImages.length >= MAX_REF_IMAGES) {
    // 满额时 revoke 刚创建的 blob URL，避免泄漏
    URL.revokeObjectURL(url);
    return { ok: false, reason: "ref-full", total: refImages.length };
  }

  setMode("img2img");
  const accepted = addRefImages([url]);
  const total = useImageGenStore.getState().refImages.length;
  return { ok: accepted > 0, total };
}

export async function sendImageToImageGenReference(
  imageId: string,
  options: {
    navigate: (path: string) => void;
    onSuccess?: () => void;
    showSuccess: (content: string) => void;
    showError: (content: string) => void;
  }
) {
  try {
    const result = await addImageToImg2ImgReference(imageId);
    if (!result.ok) {
      if (result.reason === "ref-full") {
        options.showError(`参考图已满（${result.total}/${MAX_REF_IMAGES}），无法继续添加`);
      } else {
        options.showError("图片加载失败");
      }
      return;
    }
    options.onSuccess?.();
    options.showSuccess(`已追加为图生图参考图（共 ${result.total}/${MAX_REF_IMAGES}）`);
    options.navigate("/image-gen");
  } catch {
    options.showError("图片加载失败");
  }
}
