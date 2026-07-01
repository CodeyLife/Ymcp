import { useEffect, useRef, useState, useCallback } from "react";
import { Card, Typography, Row, Col, Form, InputNumber, Select, Button, Input, Space, App, Tag, Switch } from "antd";
import { ScissorOutlined, DownloadOutlined, AimOutlined, UploadOutlined } from "@ant-design/icons";
import { useUIStore } from "@/stores/ui";
import { cacheImageLocally } from "@/lib/api";
import { setImage } from "@/lib/imageStore";
import { useAssetStore } from "@/stores/asset";
import { hexToRgb, rgbToHex, downloadBlob } from "@/lib/canvas";
import { applyChromaKey, contractAlpha, sampleBorderKey, type RGB } from "@/lib/chromaKey";
import { PageHeader, EmptyState } from "@/components/showtime";
import { FileUploadTrigger } from "@/components/FileUploadTrigger";

const { Text } = Typography;

const WHITE_KEY: RGB = [255, 255, 255];
const IMAGE_EXTENSION_RE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
const ILLEGAL_FILENAME_CHARS_RE = /[\\/:*?"<>|]+/g;

function removeImageExtension(name: string) {
  return name.trim().replace(IMAGE_EXTENSION_RE, "");
}

function sanitizeFileName(name: string) {
  return name
    .trim()
    .replace(ILLEGAL_FILENAME_CHARS_RE, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
}

function buildOutputNames(name: string, timestamp = Date.now()) {
  const fallbackBaseName = `matte-${timestamp}`;
  const baseName = sanitizeFileName(removeImageExtension(name)) || fallbackBaseName;
  return {
    assetName: baseName,
    downloadName: `${baseName}.png`,
  };
}

export default function Matte() {
  const { message } = App.useApp();
  const incomingImage = useUIStore((s) => s.incomingImage);
  const setIncomingImage = useUIStore((s) => s.setIncomingImage);
  const addAsset = useAssetStore((s) => s.add);
  const [src, setSrc] = useState<string | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [outputName, setOutputName] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [color, setColor] = useState("#00ff00");
  const [mode, setMode] = useState<"chroma" | "white">("chroma");
  const [tolerance, setTolerance] = useState(24);
  const [feather, setFeather] = useState(48);
  const [erode, setErode] = useState(1);
  const [spillCleanup, setSpillCleanup] = useState(true);
  const [detectedColor, setDetectedColor] = useState<string | null>(null);

  /**
   * 执行抠图。overrideKey 用于自动检测后立即处理，规避 setState 异步导致的 stale closure。
   * mode === "white" 时强制使用白色键，忽略 color。
   */
  const runMatte = useCallback(
    (overrideKey?: RGB) => {
      const canvas = canvasRef.current;
      const img = imgRef.current;
      if (!canvas || !img) return;

      const key: RGB =
        mode === "white"
          ? WHITE_KEY
          : overrideKey ?? (hexToRgb(color) as RGB);

      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const transparentThreshold = tolerance;
      const opaqueThreshold = tolerance + Math.max(1, feather);
      applyChromaKey(imageData, {
        key,
        tolerance,
        transparentThreshold,
        opaqueThreshold,
        softMatte: true,
        spillCleanup,
      });
      contractAlpha(imageData, erode);
      ctx.putImageData(imageData, 0, 0);
    },
    [color, mode, tolerance, feather, erode, spillCleanup]
  );

  /** 从图像边框采样键色（中位数），返回 RGB 与对应 hex */
  function detectKey(img: HTMLImageElement): { rgb: RGB; hex: string } {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const probe = document.createElement("canvas");
    probe.width = w;
    probe.height = h;
    const ctx = probe.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, w, h);
    const rgb = sampleBorderKey(imageData);
    return { rgb, hex: rgbToHex(rgb[0], rgb[1], rgb[2]) };
  }

  // 图片加载后：自动检测背景色并立即抠图（无 setTimeout、无重复逻辑）
  function onImageLoad() {
    const img = imgRef.current;
    if (!img) return;
    if (mode === "white") {
      runMatte();
      return;
    }
    const { rgb, hex } = detectKey(img);
    setColor(hex);
    setDetectedColor(hex);
    message.info(`检测到背景色 ${hex}，自动抠图中...`);
    runMatte(rgb);
    message.success("自动抠图完成");
  }

  // 守卫：StrictMode 开发模式下会双触发 effect，用 ref 标记已领取的 src 避免重复提示
  const claimedSrcRef = useRef<string | null>(null);
  useEffect(() => {
    if (!incomingImage) return;
    if (claimedSrcRef.current === incomingImage.src) return;
    claimedSrcRef.current = incomingImage.src;
    const from = incomingImage.from;
    cacheImageLocally(incomingImage.src)
      .then((cached) => {
        setSrc(cached);
        setUploadName(`来自 ${from}`);
        setOutputName(removeImageExtension(`matte-${from}`) || "matte");
        message.info(`已从 ${from} 载入图片`);
      })
      .catch(() => message.error("图片加载失败"));
    setIncomingImage(null);
  }, [incomingImage, setIncomingImage]);

  function onFile(files: FileList) {
    const f = files[0];
    if (!f) return;
    setSrc(URL.createObjectURL(f));
    setUploadName(f.name);
    setOutputName(removeImageExtension(f.name));
  }

  function manualDetectColor() {
    const img = imgRef.current;
    if (!img) return;
    const { rgb, hex } = detectKey(img);
    setColor(hex);
    setDetectedColor(hex);
    message.success(`检测到背景色 ${hex}`);
    runMatte(rgb);
  }

  function pickColor(e: React.MouseEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const probe = document.createElement("canvas");
    probe.width = img.naturalWidth;
    probe.height = img.naturalHeight;
    const ctx = probe.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * img.naturalWidth);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * img.naturalHeight);
    const [r, g, b] = ctx.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data;
    setColor(rgbToHex(r, g, b));
  }

  function download() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const outputNames = buildOutputNames(outputName);
      // 图片 Blob 直接存入 IndexedDB，store 只保存 imageId 引用
      const imageId = await setImage(blob);
      addAsset({
        id: `asset-matte-${Date.now()}`,
        name: outputNames.assetName,
        type: "image",
        imageId,
        tags: ["抠图"],
        source: "matte",
        metadata: { width: canvas.width, height: canvas.height },
        createdAt: Date.now(),
      });
      downloadBlob(blob, outputNames.downloadName);
      message.success("已下载并保存到素材库");
    }, "image/png");
  }

  return (
    <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 28px 48px" }}>
      <PageHeader
        title="抠图"
        description="颜色键与白底去除。载入图片后自动提取背景色并抠图，也可点击原图手动取色。"
        icon={<ScissorOutlined />}
      />

      <Row gutter={16}>
        <Col xs={24} lg={10} xl={9} xxl={8}>
          <Card style={{ background: "#18181b", borderColor: "#27272a" }} styles={{ body: { padding: 18 } }}>
            <Form layout="vertical">
              <Form.Item label="上传图片">
                <FileUploadTrigger
                  accept="image/png,image/jpeg,image/webp"
                  block
                  label="选择图片"
                  hint="PNG / JPEG / WebP"
                  selectedText={uploadName || undefined}
                  icon={<UploadOutlined />}
                  onFiles={onFile}
                />
              </Form.Item>
              <Form.Item label="导出文件名">
                <Input
                  value={outputName}
                  onChange={(e) => setOutputName(e.target.value)}
                  placeholder="matte"
                />
              </Form.Item>
              <Form.Item label="算法">
                <Select
                  value={mode}
                  onChange={setMode}
                  options={[
                    { label: "颜色键", value: "chroma" },
                    { label: "白底去除", value: "white" },
                  ]}
                />
              </Form.Item>
              <Form.Item label="目标颜色">
                <Space.Compact style={{ width: "100%" }}>
                  <Input
                    prefix={<div style={{ width: 16, height: 16, borderRadius: 4, background: color, border: "1px solid #3f3f46" }} />}
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    disabled={mode === "white"}
                  />
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    disabled={mode === "white"}
                    style={{ width: 40, height: 32, border: "none", background: "transparent" }}
                  />
                </Space.Compact>
                {detectedColor && mode === "chroma" && (
                  <div style={{ marginTop: 4, fontSize: 11, color: "#10b981" }}>
                    <Tag color="green" style={{ fontSize: 11 }}>自动检测: {detectedColor}</Tag>
                  </div>
                )}
              </Form.Item>
              <Form.Item label={`容差: ${tolerance}`}>
                <InputNumber min={0} max={255} value={tolerance} onChange={(v) => setTolerance(v ?? 0)} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label={`羽化: ${feather}`}>
                <InputNumber min={0} max={255} value={feather} onChange={(v) => setFeather(v ?? 0)} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label={`边缘腐蚀: ${erode}`}>
                <InputNumber min={0} max={8} value={erode} onChange={(v) => setErode(v ?? 0)} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="去溢色" valuePropName="checked">
                <Switch checked={spillCleanup} onChange={setSpillCleanup} />
              </Form.Item>
              <Space wrap>
                <Button type="primary" onClick={() => runMatte()} disabled={!src}>处理</Button>
                <Button icon={<AimOutlined />} onClick={manualDetectColor} disabled={!src || mode === "white"}>重新检测背景色</Button>
                <Button icon={<DownloadOutlined />} onClick={download} disabled={!src}>下载 PNG</Button>
              </Space>
            </Form>
          </Card>
        </Col>

        <Col xs={24} lg={14} xl={15} xxl={16}>
          <Card
            style={{ background: "#18181b", borderColor: "#27272a", minHeight: 480 }}
            styles={{ body: { padding: 14 } }}
            title={
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ color: "#a1a1aa" }}>抠图预览</Text>
                {detectedColor && mode === "chroma" && src && (
                  <Tag color="green" style={{ fontSize: 11, margin: 0 }}>检测: {detectedColor}</Tag>
                )}
              </div>
            }
          >
            {!src ? (
              <EmptyState
                icon={<ScissorOutlined />}
                title="上传图片后开始抠图"
                description="选择本地图片或从生图页送入，自动提取背景色并抠图。"
                minHeight={360}
              />
            ) : (
              <Row gutter={[12, 12]}>
                <Col xs={24} lg={12}>
                  <Text style={{ color: "#71717a", fontSize: 12, display: "block", marginBottom: 8 }}>原图（点击取色）</Text>
                  <div className="checker-bg" style={{ borderRadius: 8, padding: 10, textAlign: "center" }}>
                    <img
                      ref={imgRef}
                      src={src}
                      onLoad={onImageLoad}
                      onClick={pickColor}
                      alt="原图"
                      style={{ maxWidth: "100%", maxHeight: "calc(100vh - 220px)", cursor: "crosshair", display: "block", margin: "0 auto" }}
                    />
                  </div>
                </Col>
                <Col xs={24} lg={12}>
                  <Text style={{ color: "#71717a", fontSize: 12, display: "block", marginBottom: 8 }}>结果</Text>
                  <div className="checker-bg" style={{ borderRadius: 8, padding: 10, textAlign: "center" }}>
                    <canvas
                      ref={canvasRef}
                      style={{ maxWidth: "100%", maxHeight: "calc(100vh - 220px)", display: "block", margin: "0 auto" }}
                    />
                  </div>
                </Col>
              </Row>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
