import { useEffect, useRef, useState, useCallback } from "react";
import {
  Card, Typography, Form, Button, Row, Col, Space, App, Progress, Tag, Image, Segmented,
} from "antd";
import {
  ThunderboltOutlined, DownloadOutlined, PlusOutlined, ReloadOutlined,
} from "@ant-design/icons";
import { loadImageFromFile, downloadBlob } from "@/lib/canvas";
import { getModelArrayBuffer, getCachedModelSize, MODEL_INFO } from "@/lib/modelStore";
import { getSuperResEngine, type SuperResBackend } from "@/lib/superRes";
import { useUIStore } from "@/stores/ui";
import { FileUploadTrigger } from "@/components/FileUploadTrigger";

const { Text } = Typography;
const CARD_STYLE = { background: "#18181b", borderColor: "#27272a" };
const PANEL_BODY = { padding: 18 };

type Source = {
  image: HTMLImageElement;
  url: string;
  name: string;
  mime: string;
};

type ModelState = "idle" | "downloading" | "ready" | "error";
type UpscaleState = "idle" | "running" | "done" | "error";

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function ToolStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="tool-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function getOutputFormat(mime: string) {
  if (mime === "image/jpeg" || mime === "image/jpg") {
    return { mime: "image/jpeg", ext: "jpg", quality: 0.95 };
  }
  if (mime === "image/webp") {
    return { mime: "image/webp", ext: "webp", quality: 0.95 };
  }
  return { mime: "image/png", ext: "png" };
}

export default function SuperResPanel() {
  const { message } = App.useApp();
  const incomingImage = useUIStore((s) => s.incomingImage);
  const setIncomingImage = useUIStore((s) => s.setIncomingImage);

  const [source, setSource] = useState<Source | null>(null);
  const [scale, setScale] = useState<2 | 3 | 4>(4);
  const [modelState, setModelState] = useState<ModelState>("idle");
  const [modelProgress, setModelProgress] = useState(0);
  const [cachedSize, setCachedSize] = useState<number | null>(null);
  const [backend, setBackend] = useState<SuperResBackend | null>(null);
  const [upscaleState, setUpscaleState] = useState<UpscaleState>("idle");
  const [upscaleProgress, setUpscaleProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultImageData, setResultImageData] = useState<ImageData | null>(null);
  const [resultSize, setResultSize] = useState<{ w: number; h: number } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const previewRef = useRef<HTMLCanvasElement>(null);
  const resultRef = useRef<HTMLCanvasElement>(null);

  // 检查模型缓存状态
  useEffect(() => {
    getCachedModelSize().then((size) => {
      setCachedSize(size);
      if (size) setModelState("ready");
    });
  }, []);

  // 接收跨页传来的图片（来自 ImageGen）
  useEffect(() => {
    if (!incomingImage?.src) return;
    let cancelled = false;
    let revokeUrl: string | null = null;
    (async () => {
      try {
        const resp = await fetch(incomingImage.src);
        const blob = await resp.blob();
        const inputMime = blob.type || "image/png";
        const inputExt = getOutputFormat(inputMime).ext;
        const file = new File([blob], `superres.${inputExt}`, { type: inputMime });
        const { image, url } = await loadImageFromFile(file);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        if (source) URL.revokeObjectURL(source.url);
        revokeUrl = url;
        setSource({ image, url, name: `来自 ${incomingImage.from}`, mime: inputMime });
        setResultUrl(null);
        setResultImageData(null);
        setResultSize(null);
        setPreviewOpen(false);
        message.info("已载入图片，可开始超分");
        // 消费后清空，避免重复触发
        setIncomingImage(null);
      } catch {
        if (!cancelled) message.error("图片加载失败");
      }
    })();
    return () => {
      cancelled = true;
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingImage]);

  // 清理 source URL
  useEffect(() => {
    return () => {
      if (source) URL.revokeObjectURL(source.url);
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [source, resultUrl]);

  // 绘制原图预览
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas || !source) return;
    canvas.width = source.image.naturalWidth;
    canvas.height = source.image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source.image, 0, 0);
  }, [source]);

  async function onFile(file: File) {
    const { image, url } = await loadImageFromFile(file);
    if (source) URL.revokeObjectURL(source.url);
    setSource({ image, url, name: file.name, mime: file.type || "image/png" });
    setResultUrl(null);
    setResultImageData(null);
    setResultSize(null);
    setPreviewOpen(false);
    setUpscaleState("idle");
  }

  useEffect(() => {
    const canvas = resultRef.current;
    if (!canvas || !resultImageData) return;
    canvas.width = resultImageData.width;
    canvas.height = resultImageData.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(resultImageData, 0, 0);
  }, [resultImageData, resultUrl]);

  /** 下载模型并初始化引擎 */
  const ensureModel = useCallback(async (): Promise<boolean> => {
    if (modelState === "ready" && backend) return true;

    setModelState("downloading");
    setModelProgress(0);
    try {
      const buffer = await getModelArrayBuffer((loaded, total) => {
        setModelProgress(total > 0 ? loaded / total : 0);
      });
      const engine = getSuperResEngine();
      const b = await engine.init(buffer);
      setBackend(b);
      setModelState("ready");
      setCachedSize(buffer.byteLength);
      message.success(`模型就绪 (${b === "webgpu" ? "WebGPU" : "WASM"})`);
      return true;
    } catch (e) {
      setModelState("error");
      message.error(`模型加载失败: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }, [modelState, backend, message]);

  /** 执行超分 */
  async function handleUpscale() {
    if (!source) return;

    // 确保模型就绪
    const ok = await ensureModel();
    if (!ok) return;

    setUpscaleState("running");
    setUpscaleProgress(0);

    try {
      // 从原图获取 ImageData
      const w = source.image.naturalWidth;
      const h = source.image.naturalHeight;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(source.image, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);

      // 推理（模型固定 4x）
      const engine = getSuperResEngine();
      const result4x = await engine.upscale(imageData, (p) => {
        setUpscaleProgress(p);
      });

      // 若目标倍率 < 4，高质量降采样到目标尺寸
      let finalResult = result4x;
      if (scale < 4) {
        const tmpCanvas = document.createElement("canvas");
        tmpCanvas.width = result4x.width;
        tmpCanvas.height = result4x.height;
        tmpCanvas.getContext("2d")!.putImageData(result4x, 0, 0);
        const downCanvas = document.createElement("canvas");
        downCanvas.width = w * scale;
        downCanvas.height = h * scale;
        const dctx = downCanvas.getContext("2d")!;
        dctx.imageSmoothingEnabled = true;
        dctx.imageSmoothingQuality = "high";
        dctx.drawImage(tmpCanvas, 0, 0, downCanvas.width, downCanvas.height);
        finalResult = dctx.getImageData(0, 0, downCanvas.width, downCanvas.height);
      }

      // 生成可下载的 blob URL
      const outCanvas = document.createElement("canvas");
      outCanvas.width = finalResult.width;
      outCanvas.height = finalResult.height;
      const outCtx = outCanvas.getContext("2d")!;
      const outputFormat = getOutputFormat(source.mime);
      if (outputFormat.mime === "image/jpeg") {
        outCtx.fillStyle = "#ffffff";
        outCtx.fillRect(0, 0, outCanvas.width, outCanvas.height);
      }
      outCtx.putImageData(finalResult, 0, 0);
      const blob: Blob = await new Promise((resolve) =>
        outCanvas.toBlob((b) => resolve(b!), outputFormat.mime, outputFormat.quality),
      );
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      const url = URL.createObjectURL(blob);
      setResultImageData(finalResult);
      setResultUrl(url);
      setResultSize({ w: finalResult.width, h: finalResult.height });
      setUpscaleState("done");
      message.success(`超分完成: ${finalResult.width}×${finalResult.height}`);
    } catch (e) {
      setUpscaleState("error");
      message.error(`超分失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function handleDownload() {
    if (!resultUrl) return;
    const outputFormat = getOutputFormat(source?.mime || "image/png");
    fetch(resultUrl)
      .then((r) => r.blob())
      .then((blob) => downloadBlob(blob, `superres-${Date.now()}.${outputFormat.ext}`))
      .catch(() => message.error("下载失败"));
  }

  const targetW = source ? source.image.naturalWidth * scale : 0;
  const targetH = source ? source.image.naturalHeight * scale : 0;

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={8}>
        <Card className="tool-control-card" style={CARD_STYLE} styles={{ body: PANEL_BODY }}>
          <Form layout="vertical">
            <Form.Item label="图片">
              <FileUploadTrigger
                accept="image/*"
                block
                label="选择图片"
                hint="支持 PNG / JPEG / WebP"
                selectedText={source?.name}
                icon={<PlusOutlined />}
                onFiles={(fl) => {
                  const f = Array.from(fl)[0];
                  if (f) onFile(f);
                }}
              />
            </Form.Item>

            <Form.Item label="放大倍率">
              <Segmented
                block
                value={scale}
                onChange={(v) => setScale(v as 2 | 3 | 4)}
                options={[
                  { label: "2x", value: 2 },
                  { label: "3x", value: 3 },
                  { label: "4x", value: 4 },
                ]}
              />
            </Form.Item>

            <div className="tool-meta-row">
              <ToolStat
                label="原始"
                value={source ? `${source.image.naturalWidth}×${source.image.naturalHeight}` : "待上传"}
              />
              <ToolStat
                label={`目标 ${scale}x`}
                value={source ? `${targetW}×${targetH}` : "—"}
              />
            </div>

            {/* 模型状态 */}
            <Form.Item label="模型">
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Space size={6}>
                  <Tag color={modelState === "ready" ? "green" : modelState === "error" ? "red" : "default"}>
                    {modelState === "idle" && "未下载"}
                    {modelState === "downloading" && "下载中…"}
                    {modelState === "ready" && "就绪"}
                    {modelState === "error" && "失败"}
                  </Tag>
                  {backend && (
                    <Tag color={backend === "webgpu" ? "geekblue" : "orange"}>
                      {backend === "webgpu" ? "WebGPU" : "WASM"}
                    </Tag>
                  )}
                  {cachedSize != null && cachedSize > 0 && (
                    <Text style={{ color: "#71717a", fontSize: 12 }}>{formatBytes(cachedSize)}</Text>
                  )}
                </Space>
                {modelState === "downloading" && (
                  <Progress percent={Math.round(modelProgress * 100)} size="small" />
                )}
                <Text style={{ color: "#71717a", fontSize: 11 }}>
                  {MODEL_INFO.name} · 首次下载后本地缓存
                </Text>
              </div>
            </Form.Item>

            {/* 推理进度 */}
            {upscaleState === "running" && (
              <Form.Item label="推理进度">
                <Progress percent={Math.round(upscaleProgress * 100)} size="small" status="active" />
              </Form.Item>
            )}

            <Space wrap>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                onClick={handleUpscale}
                disabled={!source || upscaleState === "running" || modelState === "downloading"}
                loading={upscaleState === "running" || modelState === "downloading"}
              >
                {upscaleState === "running" ? "超分中…" : `开始超分 ${scale}x`}
              </Button>
              <Button
                icon={<DownloadOutlined />}
                onClick={handleDownload}
                disabled={!resultUrl}
              >
                下载
              </Button>
              {modelState === "error" && (
                <Button
                  icon={<ReloadOutlined />}
                  onClick={() => {
                    setModelState("idle");
                    setBackend(null);
                  }}
                >
                  重试
                </Button>
              )}
            </Space>
          </Form>
        </Card>
      </Col>

      <Col xs={24} lg={16}>
        <Card
          style={{ ...CARD_STYLE, minHeight: 480 }}
          styles={{ body: { padding: 14 } }}
          title={
            <Space>
              <Text style={{ color: "#a1a1aa" }}>超分结果</Text>
              {resultSize && (
                <Tag color="green">{resultSize.w}×{resultSize.h}</Tag>
              )}
            </Space>
          }
        >
          {resultUrl ? (
            <div
              className="checker-bg tool-preview-stage"
              role="button"
              tabIndex={0}
              title="点击查看大图"
              onClick={() => setPreviewOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setPreviewOpen(true);
                }
              }}
              style={{ cursor: "zoom-in" }}
            >
              <canvas
                ref={resultRef}
                style={{ maxWidth: "100%", maxHeight: "calc(100vh - 240px)" }}
              />
              <Image
                style={{ display: "none" }}
                preview={{
                  visible: previewOpen,
                  onVisibleChange: setPreviewOpen,
                  src: resultUrl,
                }}
                src={resultUrl}
              />
            </div>
          ) : source ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
              <div className="checker-bg tool-preview-stage" style={{ width: "100%" }}>
                <canvas
                  ref={previewRef}
                  style={{ maxWidth: "100%", maxHeight: "calc(100vh - 280px)" }}
                />
              </div>
              <Text style={{ color: "#71717a", fontSize: 12 }}>
                原图预览 · 点击"开始超分 {scale}x"生成 {scale} 倍高清图
              </Text>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                minHeight: 300,
                gap: 12,
              }}
            >
              <ThunderboltOutlined style={{ fontSize: 48, color: "#3f3f46" }} />
              <Text style={{ color: "#71717a" }}>上传图片开始超分</Text>
              <Text style={{ color: "#52525b", fontSize: 12 }}>
                Real-ESRGAN 4x 放大 · 浏览器本地推理 · WebGPU 加速
              </Text>
            </div>
          )}
        </Card>
      </Col>
    </Row>
  );
}
