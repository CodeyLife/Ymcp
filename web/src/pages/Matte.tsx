import { useEffect, useRef, useState, useCallback } from "react";
import { Card, Typography, Row, Col, Form, InputNumber, Select, Button, Input, Space, App, Tag } from "antd";
import { ScissorOutlined, DownloadOutlined, AimOutlined, UploadOutlined } from "@ant-design/icons";
import { useUIStore } from "@/stores/ui";
import { cacheImageLocally } from "@/lib/api";
import { useAssetStore } from "@/stores/asset";
import { downloadBlob } from "@/lib/canvas";
import { PageHeader } from "@/components/showtime";
import { FileUploadTrigger } from "@/components/FileUploadTrigger";

const { Text } = Typography;

interface HexRgb { r: number; g: number; b: number }

function hexToRgb(hex: string): HexRgb {
  const raw = hex.replace("#", "");
  const full = raw.length === 3
    ? raw.split("").map((c) => c + c).join("")
    : raw.padEnd(6, "0").slice(0, 6);
  return {
    r: parseInt(full.slice(0, 2), 16) || 0,
    g: parseInt(full.slice(2, 4), 16) || 0,
    b: parseInt(full.slice(4, 6), 16) || 0,
  };
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 背景色提取：采样图片四条边的像素，取出现次数最多的颜色。
 * 参考 ymcp dominant_image_color，但只用边缘像素更准确。
 */
function detectBackgroundColor(img: HTMLImageElement): string {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);

  const edgeThickness = Math.max(2, Math.round(Math.min(w, h) * 0.05));
  const counter = new Map<string, number>();

  function sample(x: number, y: number) {
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    // 量化到 16 级以合并相近颜色
    const r = Math.round(pixel[0] / 16) * 16;
    const g = Math.round(pixel[1] / 16) * 16;
    const b = Math.round(pixel[2] / 16) * 16;
    const key = `${r},${g},${b}`;
    counter.set(key, (counter.get(key) || 0) + 1);
  }

  // 采样四条边
  for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 100))) {
    for (let t = 0; t < edgeThickness; t++) {
      sample(x, t);           // 上边
      sample(x, h - 1 - t);   // 下边
    }
  }
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 100))) {
    for (let t = 0; t < edgeThickness; t++) {
      sample(t, y);           // 左边
      sample(w - 1 - t, y);   // 右边
    }
  }

  if (counter.size === 0) return "#00ff00";

  let bestKey = "";
  let bestCount = 0;
  for (const [k, v] of counter) {
    if (v > bestCount) {
      bestCount = v;
      bestKey = k;
    }
  }
  const [r, g, b] = bestKey.split(",").map(Number);
  return rgbToHex(r, g, b);
}

export default function Matte() {
  const { message } = App.useApp();
  const incomingImage = useUIStore((s) => s.incomingImage);
  const setIncomingImage = useUIStore((s) => s.setIncomingImage);
  const addAsset = useAssetStore((s) => s.add);
  const [src, setSrc] = useState<string | null>(null);
  const [uploadName, setUploadName] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [color, setColor] = useState("#00ff00");
  const [mode, setMode] = useState<"chroma" | "white">("chroma");
  const [tolerance, setTolerance] = useState(72);
  const [feather, setFeather] = useState(54);
  const [erode, setErode] = useState(1);
  const [autoDetect] = useState(true);
  const [detectedColor, setDetectedColor] = useState<string | null>(null);

  const runMatte = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const target = hexToRgb(color);
    const soft = Math.max(1, feather);
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const dist = mode === "white"
        ? Math.sqrt((255 - r) ** 2 + (255 - g) ** 2 + (255 - b) ** 2)
        : Math.sqrt((target.r - r) ** 2 + (target.g - g) ** 2 + (target.b - b) ** 2);
      const alpha = dist <= tolerance
        ? 0
        : dist >= tolerance + soft
        ? 255
        : Math.round(((dist - tolerance) / soft) * 255);
      data[i + 3] = Math.min(data[i + 3], alpha);
    }
    // 边缘腐蚀
    if (erode > 0) {
      const alphaData = new Uint8ClampedArray(data.length / 4);
      for (let i = 0; i < data.length; i += 4) {
        alphaData[i / 4] = data[i + 3];
      }
      const w = canvas.width;
      const h = canvas.height;
      for (let e = 0; e < erode; e++) {
        const tmp = new Uint8ClampedArray(alphaData);
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const idx = y * w + x;
            const minNeighbor = Math.min(
              tmp[idx], tmp[idx - 1], tmp[idx + 1],
              tmp[idx - w], tmp[idx + w]
            );
            alphaData[idx] = Math.min(tmp[idx], minNeighbor);
          }
        }
      }
      for (let i = 0; i < data.length; i += 4) {
        data[i + 3] = alphaData[i / 4];
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }, [color, mode, tolerance, feather, erode]);

  // 图片加载后自动提取背景色 + 自动抠图
  function onImageLoad() {
    const img = imgRef.current;
    if (!img || !autoDetect) {
      runMatte();
      return;
    }
    const detected = detectBackgroundColor(img);
    setColor(detected);
    setDetectedColor(detected);
    message.info(`检测到背景色 ${detected}，自动抠图中...`);
    // 等待 state 更新后再执行抠图
    setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas || !img) return;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      const target = hexToRgb(detected);
      const soft = Math.max(1, feather);
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const dist = Math.sqrt((target.r - r) ** 2 + (target.g - g) ** 2 + (target.b - b) ** 2);
        const alpha = dist <= tolerance
          ? 0
          : dist >= tolerance + soft
          ? 255
          : Math.round(((dist - tolerance) / soft) * 255);
        data[i + 3] = Math.min(data[i + 3], alpha);
      }
      if (erode > 0) {
        const alphaData = new Uint8ClampedArray(data.length / 4);
        for (let i = 0; i < data.length; i += 4) {
          alphaData[i / 4] = data[i + 3];
        }
        const w = canvas.width;
        const h = canvas.height;
        for (let e = 0; e < erode; e++) {
          const tmp = new Uint8ClampedArray(alphaData);
          for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
              const idx = y * w + x;
              const minNeighbor = Math.min(
                tmp[idx], tmp[idx - 1], tmp[idx + 1],
                tmp[idx - w], tmp[idx + w]
              );
              alphaData[idx] = Math.min(tmp[idx], minNeighbor);
            }
          }
        }
        for (let i = 0; i < data.length; i += 4) {
          data[i + 3] = alphaData[i / 4];
        }
      }
      ctx.putImageData(imageData, 0, 0);
      message.success("自动抠图完成");
    }, 50);
  }

  useEffect(() => {
    if (incomingImage) {
      cacheImageLocally(incomingImage.src)
        .then((cached) => {
          setSrc(cached);
          setUploadName(`来自 ${incomingImage.from}`);
          message.info(`已从 ${incomingImage.from} 载入图片`);
        })
        .catch(() => message.error("图片加载失败"));
      setIncomingImage(null);
    }
  }, [incomingImage, setIncomingImage]);

  function onFile(files: FileList) {
    const f = files[0];
    if (!f) return;
    setSrc(URL.createObjectURL(f));
    setUploadName(f.name);
  }

  function manualDetectColor() {
    const img = imgRef.current;
    if (!img) return;
    const detected = detectBackgroundColor(img);
    setColor(detected);
    setDetectedColor(detected);
    message.success(`检测到背景色 ${detected}`);
    runMatte();
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
    canvas.toBlob((blob) => {
      if (!blob) return;
      // 用 data URL 持久化到素材库，避免 blob URL 刷新后失效
      const dataUrl = canvas.toDataURL("image/png");
      addAsset({
        id: `asset-matte-${Date.now()}`,
        name: `抠图结果_${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
        type: "image",
        src: dataUrl,
        thumbnail: dataUrl,
        tags: ["抠图"],
        source: "matte",
        metadata: { width: canvas.width, height: canvas.height },
        createdAt: Date.now(),
      });
      downloadBlob(blob, `matte-${Date.now()}.png`);
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
        <Col xs={24} lg={8}>
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
                  />
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    style={{ width: 40, height: 32, border: "none", background: "transparent" }}
                  />
                </Space.Compact>
                {detectedColor && (
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
              <Space wrap>
                <Button type="primary" onClick={runMatte} disabled={!src}>处理</Button>
                <Button icon={<AimOutlined />} onClick={manualDetectColor} disabled={!src}>重新检测背景色</Button>
                <Button icon={<DownloadOutlined />} onClick={download} disabled={!src}>下载 PNG</Button>
              </Space>
            </Form>
          </Card>
        </Col>

        <Col xs={24} lg={16}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <Text style={{ color: "#71717a", fontSize: 12, display: "block", marginBottom: 8 }}>原图（点击取色）</Text>
              <div className="checker-bg" style={{ borderRadius: 8, minHeight: 240, padding: 10, textAlign: "center" }}>
                {src ? (
                  <img
                    ref={imgRef}
                    src={src}
                    onLoad={onImageLoad}
                    onClick={pickColor}
                    alt="原图"
                    style={{ maxWidth: "100%", maxHeight: "calc(100vh - 280px)", cursor: "crosshair", display: "block", margin: "0 auto" }}
                  />
                ) : (
                  <div style={{ height: 240, display: "grid", placeItems: "center" }}>
                    <Text style={{ color: "#52525b" }}>上传或从生图送入</Text>
                  </div>
                )}
              </div>
            </div>
            <div>
              <Text style={{ color: "#71717a", fontSize: 12, display: "block", marginBottom: 8 }}>结果</Text>
              <div className="checker-bg" style={{ borderRadius: 8, minHeight: 240, padding: 10, textAlign: "center" }}>
                <canvas
                  ref={canvasRef}
                  style={{ maxWidth: "100%", maxHeight: "calc(100vh - 280px)", display: "block", margin: "0 auto" }}
                />
              </div>
            </div>
          </div>
        </Col>
      </Row>
    </div>
  );
}
