import { getImage } from "@/lib/imageStore";
import { useImageGenStore } from "@/stores/imageGen";

export async function setImageAsImg2ImgReference(imageId: string): Promise<boolean> {
  const blob = await getImage(imageId);
  if (!blob) return false;

  const url = URL.createObjectURL(blob);
  const { refImage, setMode, setRefImage } = useImageGenStore.getState();

  if (refImage?.startsWith("blob:")) {
    URL.revokeObjectURL(refImage);
  }

  setMode("img2img");
  setRefImage(url);
  return true;
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
    const ok = await setImageAsImg2ImgReference(imageId);
    if (!ok) {
      options.showError("图片加载失败");
      return;
    }
    options.onSuccess?.();
    options.showSuccess("已切换到图生图，参考图已载入");
    options.navigate("/image-gen");
  } catch {
    options.showError("图片加载失败");
  }
}
