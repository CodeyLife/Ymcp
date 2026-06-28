import { useEffect, useRef, useState } from "react";
import {
  Card, Typography, Form, InputNumber, Button, Row, Col, Space, App, Tabs, Segmented, Input,
} from "antd";
import {
  AppstoreOutlined, ColumnHeightOutlined, BlockOutlined, DownloadOutlined, PlusOutlined,
} from "@ant-design/icons";
import { loadImagesFromFiles, downloadBlob } from "@/lib/canvas";
import { PageHeader, EmptyState } from "@/components/showtime";
import { FileUploadTrigger } from "@/components/FileUploadTrigger";

const { Text } = Typography;

/* ===== 合成帧表 ===== */
function ComposePanel() {
  const { message } = App.useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [items, setItems] = useState<{ image: HTMLImageElement; url: string; name: string }[]>([]);
  const [cols, setCols] = useState(4);
  const [gap, setGap] = useState(0);
  const [bg, setBg] = useState("#000000");

  async function onFiles(fileList: FileList) {
    const files = Array.from(fileList);
    if (!files.length) return;
    const loaded = await loadImagesFromFiles(files);
    setItems((prev) => [
      ...prev,
      ...loaded.map((l) => ({ image: l.image, url: l.url, name: l.file.name })),
    ]);
  }

  function compose() {
    const canvas = canvasRef.current;
    if (!canvas || !items.length) return;
    const cellW = Math.max(...items.map((it) => it.image.naturalWidth));
    const cellH = Math.max(...items.map((it) => it.image.naturalHeight));
    const c = Math.max(1, cols);
    const rows = Math.ceil(items.length / c);
    canvas.width = c * cellW + (c + 1) * gap;
    canvas.height = rows * cellH + (rows + 1) * gap;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    items.forEach((it, i) => {
      const x = (i % c) * (cellW + gap) + gap;
      const y = Math.floor(i / c) * (cellH + gap) + gap;
      const dx = (cellW - it.image.naturalWidth) / 2;
      const dy = (cellH - it.image.naturalHeight) / 2;
      ctx.drawImage(it.image, x + dx, y + dy);
    });
    message.success("合成完成");
  }

  function download() {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width) return;
    canvas.toBlob((blob) => blob && downloadBlob(blob, "compose_sheet.png"), "image/png");
  }

  return (
    <Row gutter={16}>
      <Col xs={24} lg={8}>
        <Card style={{ background: "#18181b", borderColor: "#27272a" }} styles={{ body: { padding: 18 } }}>
          <Form layout="vertical">
            <Form.Item label="添加图片（可多选）">
              <FileUploadTrigger
                accept="image/*"
                multiple
                block
                label="选择图片"
                hint="可一次选择多张"
                selectedText={items.length > 0 ? `已选 ${items.length} 张` : undefined}
                icon={<PlusOutlined />}
                onFiles={onFiles}
              />
            </Form.Item>
            {items.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <Text style={{ color: "#71717a", fontSize: 12 }}>已选 {items.length} 张</Text>
              </div>
            )}
            <Form.Item label="列数">
              <InputNumber min={1} max={32} value={cols} onChange={(v) => setCols(v ?? 4)} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="间距">
              <InputNumber min={0} max={64} value={gap} onChange={(v) => setGap(v ?? 0)} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="背景色">
              <Input value={bg} onChange={(e) => setBg(e.target.value)} prefix={<span style={{ width: 14, height: 14, borderRadius: 3, background: bg, display: "inline-block", border: "1px solid #3f3f46" }} />} />
            </Form.Item>
            <Space>
              <Button type="primary" onClick={compose} disabled={!items.length}>合成</Button>
              <Button icon={<DownloadOutlined />} onClick={download} disabled={!items.length}>下载</Button>
            </Space>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={16}>
        <Card
          style={{ background: "#18181b", borderColor: "#27272a", minHeight: 480 }}
          styles={{ body: { padding: 14 } }}
          title={<Text style={{ color: "#a1a1aa" }}>合成结果{items.length > 0 ? ` (${items.length} 图)` : ""}</Text>}
        >
          {items.length === 0 ? (
            <EmptyState icon={<BlockOutlined />} title="添加图片后合成 Sprite Sheet" description="支持多张图片合成帧表，可调整行列与间距。" minHeight={280} />
          ) : (
            <div className="checker-bg" style={{ borderRadius: 8, padding: 12, textAlign: "center", overflow: "auto", maxHeight: "calc(100vh - 220px)" }}>
              <canvas ref={canvasRef} style={{ maxWidth: "100%", imageRendering: "pixelated" }} />
            </div>
          )}
        </Card>
      </Col>
    </Row>
  );
}

/* ===== 简单拼接 ===== */
function StitchPanel() {
  const { message } = App.useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [items, setItems] = useState<{ image: HTMLImageElement; url: string }[]>([]);
  const [dir, setDir] = useState<"horizontal" | "vertical" | "stack">("horizontal");
  const [gap, setGap] = useState(0);
  const [bg, setBg] = useState("#000000");

  async function onFiles(fileList: FileList) {
    const files = Array.from(fileList);
    if (!files.length) return;
    const loaded = await loadImagesFromFiles(files);
    setItems((prev) => [...prev, ...loaded.map((l) => ({ image: l.image, url: l.url }))]);
  }

  function stitch() {
    const canvas = canvasRef.current;
    if (!canvas || !items.length) return;
    if (dir === "stack") {
      canvas.width = Math.max(...items.map((it) => it.image.naturalWidth));
      canvas.height = items.reduce((sum, it) => sum + it.image.naturalHeight, 0) + gap * (items.length - 1);
    } else if (dir === "horizontal") {
      canvas.width = items.reduce((sum, it) => sum + it.image.naturalWidth, 0) + gap * (items.length - 1);
      canvas.height = Math.max(...items.map((it) => it.image.naturalHeight));
    } else {
      canvas.width = Math.max(...items.map((it) => it.image.naturalWidth));
      canvas.height = items.reduce((sum, it) => sum + it.image.naturalHeight, 0) + gap * (items.length - 1);
    }
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let pos = 0;
    items.forEach((it) => {
      if (dir === "horizontal") {
        ctx.drawImage(it.image, pos, 0);
        pos += it.image.naturalWidth + gap;
      } else {
        ctx.drawImage(it.image, 0, pos);
        pos += it.image.naturalHeight + gap;
      }
    });
    message.success("拼接完成");
  }

  function download() {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width) return;
    canvas.toBlob((blob) => blob && downloadBlob(blob, "stitch.png"), "image/png");
  }

  return (
    <Row gutter={16}>
      <Col xs={24} lg={8}>
        <Card style={{ background: "#18181b", borderColor: "#27272a" }} styles={{ body: { padding: 18 } }}>
          <Form layout="vertical">
            <Form.Item label="添加图片">
              <FileUploadTrigger
                accept="image/*"
                multiple
                block
                label="选择图片"
                hint="PNG / JPEG / WebP"
                selectedText={items.length > 0 ? `已选 ${items.length} 张` : undefined}
                icon={<PlusOutlined />}
                onFiles={onFiles}
              />
            </Form.Item>
            <Form.Item label="方向">
              <Segmented block value={dir} onChange={(v) => setDir(v as typeof dir)} options={[
                { label: "横向", value: "horizontal" },
                { label: "纵向", value: "vertical" },
                { label: "叠放", value: "stack" },
              ]} />
            </Form.Item>
            <Form.Item label="间距">
              <InputNumber min={0} max={128} value={gap} onChange={(v) => setGap(v ?? 0)} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="背景色">
              <Input value={bg} onChange={(e) => setBg(e.target.value)} prefix={<span style={{ width: 14, height: 14, borderRadius: 3, background: bg, display: "inline-block", border: "1px solid #3f3f46" }} />} />
            </Form.Item>
            <Space>
              <Button type="primary" onClick={stitch} disabled={!items.length}>拼接</Button>
              <Button icon={<DownloadOutlined />} onClick={download} disabled={!items.length}>下载</Button>
            </Space>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={16}>
        <Card
          style={{ background: "#18181b", borderColor: "#27272a", minHeight: 480 }}
          styles={{ body: { padding: 14 } }}
          title={<Text style={{ color: "#a1a1aa" }}>拼接结果{items.length > 0 ? ` (${items.length} 图)` : ""}</Text>}
        >
          {items.length === 0 ? (
            <EmptyState icon={<ColumnHeightOutlined />} title="添加图片后拼接" description="纵向或横向拼接多张图片，可调整间距与对齐。" minHeight={280} />
          ) : (
            <div className="checker-bg" style={{ borderRadius: 8, padding: 12, textAlign: "center", overflow: "auto", maxHeight: "calc(100vh - 220px)" }}>
              <canvas ref={canvasRef} style={{ maxWidth: "100%", imageRendering: "pixelated" }} />
            </div>
          )}
        </Card>
      </Col>
    </Row>
  );
}

/* ===== 像素化/缩放 ===== */
function PixelPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [imgUrl, setImgUrl] = useState("");
  const [mode, setMode] = useState<"pixel" | "scale">("pixel");
  const [blockSize, setBlockSize] = useState(8);
  const [targetW, setTargetW] = useState(64);
  const [targetH, setTargetH] = useState(64);
  // 跟踪输出尺寸与显示倍率，供 JSX 渲染使用（canvas ref 在 render 期间读取会是旧值）
  const [outputInfo, setOutputInfo] = useState({ w: 0, h: 0, scale: 1 });

  function onFile(files: FileList) {
    const f = files[0];
    if (!f) return;
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    const url = URL.createObjectURL(f);
    const image = new Image();
    image.onload = () => {
      setImg(image);
    };
    image.src = url;
    setImgUrl(url);
  }

  // 使用 useEffect 绑定绘制逻辑，避免闭包陷阱（旧实现中 run 通过 requestAnimationFrame 调用，
  // 其闭包内的 img 仍是 null，导致首次上传后无预览）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d")!;
    let w: number, h: number;
    if (mode === "pixel") {
      w = Math.max(1, Math.floor(img.naturalWidth / blockSize));
      h = Math.max(1, Math.floor(img.naturalHeight / blockSize));
      canvas.width = w;
      canvas.height = h;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
    } else {
      w = Math.max(1, targetW);
      h = Math.max(1, targetH);
      canvas.width = w;
      canvas.height = h;
      ctx.imageSmoothingEnabled = true;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
    }
    // 像素化模式下输出图通常很小（如 64×64），放大显示以便观察；缩放模式按 1:1 显示
    const scale = mode === "pixel" ? Math.min(16, Math.max(1, Math.floor(320 / Math.max(w, 1)))) : 1;
    setOutputInfo({ w, h, scale });
  }, [img, mode, blockSize, targetW, targetH]);

  function download() {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width) return;
    canvas.toBlob((blob) => blob && downloadBlob(blob, "pixel_out.png"), "image/png");
  }

  return (
    <Row gutter={16}>
      <Col xs={24} lg={8}>
        <Card style={{ background: "#18181b", borderColor: "#27272a" }} styles={{ body: { padding: 18 } }}>
          <Form layout="vertical">
            <Form.Item label="图片">
              <FileUploadTrigger
                accept="image/*"
                block
                label="选择图片"
                hint="PNG / JPEG / WebP"
                selectedText={img ? "已载入图片" : undefined}
                icon={<PlusOutlined />}
                onFiles={onFile}
              />
            </Form.Item>
            {img && (
              <div style={{ marginBottom: 12, display: "flex", flexDirection: "column", gap: 2 }}>
                <Text style={{ color: "#71717a", fontSize: 12 }}>
                  原始尺寸: {img.naturalWidth} × {img.naturalHeight}
                </Text>
                {outputInfo.w > 0 && (
                  <Text style={{ color: "#71717a", fontSize: 12 }}>
                    输出尺寸: {outputInfo.w} × {outputInfo.h}
                    {outputInfo.scale > 1 ? ` （显示放大 ${outputInfo.scale}×）` : ""}
                  </Text>
                )}
              </div>
            )}
            <Form.Item label="模式">
              <Segmented block value={mode} onChange={(v) => setMode(v as typeof mode)} options={[
                { label: "像素化", value: "pixel" },
                { label: "缩放", value: "scale" },
              ]} />
            </Form.Item>
            {mode === "pixel" ? (
              <Form.Item label={`像素块大小: ${blockSize}px`}>
                <InputNumber min={2} max={64} value={blockSize} onChange={(v) => setBlockSize(v ?? 8)} style={{ width: "100%" }} />
              </Form.Item>
            ) : (
              <Row gutter={10}>
                <Col span={12}>
                  <Form.Item label="目标宽">
                    <InputNumber min={1} max={4096} value={targetW} onChange={(v) => setTargetW(v ?? 64)} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="目标高">
                    <InputNumber min={1} max={4096} value={targetH} onChange={(v) => setTargetH(v ?? 64)} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
              </Row>
            )}
            <Space>
              <Button icon={<DownloadOutlined />} onClick={download} disabled={!img}>下载</Button>
            </Space>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={16}>
        <Card
          style={{ background: "#18181b", borderColor: "#27272a", minHeight: 480 }}
          styles={{ body: { padding: 14 } }}
          title={<Text style={{ color: "#a1a1aa" }}>处理结果{img ? ` (${outputInfo.w}×${outputInfo.h})` : ""}</Text>}
        >
          {!img ? (
            <EmptyState icon={<AppstoreOutlined />} title="上传图片后处理" description="支持像素化与缩放，纯浏览器处理。" minHeight={280} />
          ) : (
            <div className="checker-bg" style={{ borderRadius: 8, padding: 12, textAlign: "center", overflow: "auto", maxHeight: "calc(100vh - 220px)" }}>
              <canvas
                ref={canvasRef}
                style={{
                  maxWidth: "100%",
                  imageRendering: "pixelated",
                  width: outputInfo.scale > 1 ? `${outputInfo.w * outputInfo.scale}px` : "auto",
                  height: "auto",
                }}
              />
            </div>
          )}
        </Card>
      </Col>
    </Row>
  );
}

export default function ImageTools() {
  return (
    <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 28px 48px" }}>
      <PageHeader
        title="图像工具集"
        description="合成 Sprite Sheet、拼接图片、像素化与缩放。纯浏览器处理。"
        icon={<AppstoreOutlined />}
      />
      <Card style={{ background: "#18181b", borderColor: "#27272a" }} styles={{ body: { padding: 18 } }}>
        <Tabs
          defaultActiveKey="compose"
          items={[
            { key: "compose", label: <span><BlockOutlined /> 合成帧表</span>, children: <ComposePanel /> },
            { key: "stitch", label: <span><ColumnHeightOutlined /> 简单拼接</span>, children: <StitchPanel /> },
            { key: "pixel", label: <span><AppstoreOutlined /> 像素化/缩放</span>, children: <PixelPanel /> },
          ]}
        />
      </Card>
    </div>
  );
}
