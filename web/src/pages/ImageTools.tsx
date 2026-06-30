import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Card, Typography, Form, InputNumber, Button, Row, Col, Space, App, Tabs, Segmented, Input, Slider, Tag, Checkbox,
} from "antd";
import {
  AppstoreOutlined, ColumnHeightOutlined, BlockOutlined, DownloadOutlined, PlusOutlined,
  BgColorsOutlined, CompressOutlined, ScissorOutlined, ShrinkOutlined,
} from "@ant-design/icons";
import { loadImageFromFile, loadImagesFromFiles, downloadBlob, canvasToBlob } from "@/lib/canvas";
import { PageHeader, EmptyState, GlassCard } from "@/components/showtime";
import { FileUploadTrigger } from "@/components/FileUploadTrigger";

const { Text } = Typography;

const CARD_STYLE = { background: "#18181b", borderColor: "#27272a" };
const PANEL_BODY = { padding: 18 };

type LoadedImage = {
  image: HTMLImageElement;
  url: string;
  name: string;
  size: number;
};

type OutputInfo = {
  w: number;
  h: number;
  blob?: Blob;
  type?: string;
};

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

function useObjectUrlCleanup(url: string) {
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
}

function drawImageContain(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
  fill?: string,
) {
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }
  ctx.drawImage(image, 0, 0, width, height);
}

function ToolStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="tool-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ToolIntro() {
  const stats = [
    { label: "本地处理", value: "6 个工具" },
    { label: "图片出入", value: "PNG / JPEG / WebP" },
    { label: "适合场景", value: "生图资产整理" },
  ];
  return (
    <div className="image-tools-hero">
      <div>
        <div className="tool-kicker">Offline image lab</div>
        <h2>把生成结果变成可交付素材</h2>
        <p>
          所有处理都在浏览器端完成，适合把 AI 生图、Sprite 帧、图标和素材草稿快速整理成项目可用资源。
        </p>
      </div>
      <div className="tool-stat-grid">
        {stats.map((stat) => <ToolStat key={stat.label} label={stat.label} value={stat.value} />)}
      </div>
    </div>
  );
}

function PreviewCanvas({
  canvasRef,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  ready,
  maxHeight = "calc(100vh - 240px)",
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  emptyIcon: ReactNode;
  emptyTitle: string;
  emptyDescription: string;
  ready: boolean;
  maxHeight?: string;
}) {
  return ready ? (
    <div className="checker-bg tool-preview-stage">
      <canvas ref={canvasRef} style={{ maxWidth: "100%", maxHeight, imageRendering: "pixelated" }} />
    </div>
  ) : (
    <EmptyState icon={emptyIcon} title={emptyTitle} description={emptyDescription} minHeight={300} />
  );
}

/* ===== 合成帧表 ===== */
function ComposePanel() {
  const { message } = App.useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [items, setItems] = useState<{ image: HTMLImageElement; url: string; name: string }[]>([]);
  const itemsRef = useRef(items);
  const [cols, setCols] = useState(4);
  const [gap, setGap] = useState(0);
  const [bg, setBg] = useState("#000000");
  const [outputInfo, setOutputInfo] = useState({ w: 0, h: 0 });

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => () => itemsRef.current.forEach((item) => URL.revokeObjectURL(item.url)), []);

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
    setOutputInfo({ w: canvas.width, h: canvas.height });
    message.success("合成完成");
  }

  function download() {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width) return;
    canvas.toBlob((blob) => blob && downloadBlob(blob, "compose_sheet.png"), "image/png");
  }

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={8}>
        <Card className="tool-control-card" style={CARD_STYLE} styles={{ body: PANEL_BODY }}>
          <Form layout="vertical">
            <Form.Item label="添加图片">
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
            <div className="tool-meta-row">
              <ToolStat label="输入" value={`${items.length} 图`} />
              <ToolStat label="输出" value={outputInfo.w ? `${outputInfo.w}×${outputInfo.h}` : "待合成"} />
            </div>
            <Form.Item label="列数">
              <InputNumber min={1} max={32} value={cols} onChange={(v) => setCols(v ?? 4)} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="间距">
              <InputNumber min={0} max={64} value={gap} onChange={(v) => setGap(v ?? 0)} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="背景色">
              <Input value={bg} onChange={(e) => setBg(e.target.value)} prefix={<span className="color-chip" style={{ background: bg }} />} />
            </Form.Item>
            <Space wrap>
              <Button type="primary" onClick={compose} disabled={!items.length}>合成</Button>
              <Button icon={<DownloadOutlined />} onClick={download} disabled={!outputInfo.w}>下载</Button>
            </Space>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={16}>
        <Card style={{ ...CARD_STYLE, minHeight: 480 }} styles={{ body: { padding: 14 } }} title={<Text style={{ color: "#a1a1aa" }}>合成结果</Text>}>
          <PreviewCanvas canvasRef={canvasRef} ready={items.length > 0} emptyIcon={<BlockOutlined />} emptyTitle="添加图片后合成 Sprite Sheet" emptyDescription="用于把连续帧、角色动作或图标组快速合成为一张帧表。" />
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
  const itemsRef = useRef(items);
  const [dir, setDir] = useState<"horizontal" | "vertical" | "stack">("horizontal");
  const [gap, setGap] = useState(0);
  const [bg, setBg] = useState("#000000");
  const [outputInfo, setOutputInfo] = useState({ w: 0, h: 0 });

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => () => itemsRef.current.forEach((item) => URL.revokeObjectURL(item.url)), []);

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
    setOutputInfo({ w: canvas.width, h: canvas.height });
    message.success("拼接完成");
  }

  function download() {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width) return;
    canvas.toBlob((blob) => blob && downloadBlob(blob, "stitch.png"), "image/png");
  }

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={8}>
        <Card className="tool-control-card" style={CARD_STYLE} styles={{ body: PANEL_BODY }}>
          <Form layout="vertical">
            <Form.Item label="添加图片">
              <FileUploadTrigger accept="image/*" multiple block label="选择图片" hint="PNG / JPEG / WebP" selectedText={items.length > 0 ? `已选 ${items.length} 张` : undefined} icon={<PlusOutlined />} onFiles={onFiles} />
            </Form.Item>
            <div className="tool-meta-row">
              <ToolStat label="输入" value={`${items.length} 图`} />
              <ToolStat label="输出" value={outputInfo.w ? `${outputInfo.w}×${outputInfo.h}` : "待拼接"} />
            </div>
            <Form.Item label="方向">
              <Segmented block value={dir} onChange={(v) => setDir(v as typeof dir)} options={[{ label: "横向", value: "horizontal" }, { label: "纵向", value: "vertical" }, { label: "叠放", value: "stack" }]} />
            </Form.Item>
            <Form.Item label="间距">
              <InputNumber min={0} max={128} value={gap} onChange={(v) => setGap(v ?? 0)} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="背景色">
              <Input value={bg} onChange={(e) => setBg(e.target.value)} prefix={<span className="color-chip" style={{ background: bg }} />} />
            </Form.Item>
            <Space wrap>
              <Button type="primary" onClick={stitch} disabled={!items.length}>拼接</Button>
              <Button icon={<DownloadOutlined />} onClick={download} disabled={!outputInfo.w}>下载</Button>
            </Space>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={16}>
        <Card style={{ ...CARD_STYLE, minHeight: 480 }} styles={{ body: { padding: 14 } }} title={<Text style={{ color: "#a1a1aa" }}>拼接结果</Text>}>
          <PreviewCanvas canvasRef={canvasRef} ready={items.length > 0} emptyIcon={<ColumnHeightOutlined />} emptyTitle="添加图片后拼接" emptyDescription="适合长图、对照图和社媒预览拼版，可调整间距和底色。" />
        </Card>
      </Col>
    </Row>
  );
}

/* ===== 像素化 ===== */
function PixelatePanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [imgUrl, setImgUrl] = useState("");
  const [blockSize, setBlockSize] = useState(8);
  const [displayScale, setDisplayScale] = useState(8);
  const [outputInfo, setOutputInfo] = useState({ w: 0, h: 0 });
  useObjectUrlCleanup(imgUrl);

  function onFile(files: FileList) {
    const f = files[0];
    if (!f) return;
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    const url = URL.createObjectURL(f);
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = url;
    setImgUrl(url);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d")!;
    const w = Math.max(1, Math.floor(img.naturalWidth / blockSize));
    const h = Math.max(1, Math.floor(img.naturalHeight / blockSize));
    canvas.width = w;
    canvas.height = h;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    setOutputInfo({ w, h });
  }, [img, blockSize]);

  function download() {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width) return;
    canvas.toBlob((blob) => blob && downloadBlob(blob, "pixelated.png"), "image/png");
  }

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={8}>
        <Card className="tool-control-card" style={CARD_STYLE} styles={{ body: PANEL_BODY }}>
          <Form layout="vertical">
            <Form.Item label="图片">
              <FileUploadTrigger accept="image/*" block label="选择图片" hint="PNG / JPEG / WebP" selectedText={img ? "已载入图片" : undefined} icon={<PlusOutlined />} onFiles={onFile} />
            </Form.Item>
            <div className="tool-meta-row">
              <ToolStat label="原始" value={img ? `${img.naturalWidth}×${img.naturalHeight}` : "待上传"} />
              <ToolStat label="输出" value={outputInfo.w ? `${outputInfo.w}×${outputInfo.h}` : "待处理"} />
            </div>
            <Form.Item label={`像素块大小: ${blockSize}px`}>
              <InputNumber min={2} max={64} value={blockSize} onChange={(v) => setBlockSize(v ?? 8)} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label={`预览放大: ×${displayScale}`}>
              <Slider min={1} max={16} value={displayScale} onChange={setDisplayScale} />
            </Form.Item>
            <Button icon={<DownloadOutlined />} onClick={download} disabled={!img}>下载</Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={16}>
        <Card style={{ ...CARD_STYLE, minHeight: 480 }} styles={{ body: { padding: 14 } }} title={<Text style={{ color: "#a1a1aa" }}>原图 / 像素化效果</Text>}>
          {!img ? <EmptyState icon={<AppstoreOutlined />} title="上传图片后像素化" description="把图片按块大小下采样，适合做头像、图标和像素风素材。" minHeight={300} /> : (
            <div className="pixel-workspace">
              <div className="pixel-source">
                <span className="pixel-label">原图</span>
                <img src={imgUrl} alt="原图预览" />
              </div>
              <div className="pixel-effect">
                <span className="pixel-label">效果</span>
                <div className="tool-result-strip">
                  <Tag color="green">{outputInfo.w ? `${outputInfo.w}×${outputInfo.h}` : "待处理"}</Tag>
                  <Tag>块 {blockSize}px</Tag>
                </div>
                <div className="checker-bg tool-preview-stage">
                  <canvas ref={canvasRef} style={{ width: `${outputInfo.w * displayScale}px`, height: "auto", imageRendering: "pixelated" }} />
                </div>
              </div>
            </div>
          )}
        </Card>
      </Col>
    </Row>
  );
}

/* ===== 缩放 ===== */
function ScalePanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [imgUrl, setImgUrl] = useState("");
  const [targetW, setTargetW] = useState(64);
  const [targetH, setTargetH] = useState(64);
  const [lockRatio, setLockRatio] = useState(true);
  const [preset, setPreset] = useState<"custom" | "50" | "100" | "200">("custom");
  const [outputInfo, setOutputInfo] = useState({ w: 0, h: 0 });
  useObjectUrlCleanup(imgUrl);

  function onFile(files: FileList) {
    const f = files[0];
    if (!f) return;
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    const url = URL.createObjectURL(f);
    const image = new Image();
    image.onload = () => {
      setImg(image);
      setTargetW(image.naturalWidth);
      setTargetH(image.naturalHeight);
      setPreset("100");
    };
    image.src = url;
    setImgUrl(url);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d")!;
    const w = Math.max(1, targetW);
    const h = Math.max(1, targetH);
    canvas.width = w;
    canvas.height = h;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    setOutputInfo({ w, h });
  }, [img, targetW, targetH]);

  function applyPreset(value: "custom" | "50" | "100" | "200") {
    setPreset(value);
    if (!img || value === "custom") return;
    const ratio = Number(value) / 100;
    setTargetW(Math.max(1, Math.round(img.naturalWidth * ratio)));
    setTargetH(Math.max(1, Math.round(img.naturalHeight * ratio)));
  }

  function onWidthChange(v: number | null) {
    const next = v ?? 1;
    setTargetW(next);
    setPreset("custom");
    if (lockRatio && img) {
      setTargetH(Math.max(1, Math.round((next / img.naturalWidth) * img.naturalHeight)));
    }
  }

  function onHeightChange(v: number | null) {
    const next = v ?? 1;
    setTargetH(next);
    setPreset("custom");
    if (lockRatio && img) {
      setTargetW(Math.max(1, Math.round((next / img.naturalHeight) * img.naturalWidth)));
    }
  }

  function download() {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width) return;
    canvas.toBlob((blob) => blob && downloadBlob(blob, "scaled.png"), "image/png");
  }

  const scalePct = img && outputInfo.w ? Math.round((outputInfo.w / img.naturalWidth) * 100) : 0;

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={8}>
        <Card className="tool-control-card" style={CARD_STYLE} styles={{ body: PANEL_BODY }}>
          <Form layout="vertical">
            <Form.Item label="图片">
              <FileUploadTrigger accept="image/*" block label="选择图片" hint="PNG / JPEG / WebP" selectedText={img ? "已载入图片" : undefined} icon={<PlusOutlined />} onFiles={onFile} />
            </Form.Item>
            <div className="tool-meta-row">
              <ToolStat label="原始" value={img ? `${img.naturalWidth}×${img.naturalHeight}` : "待上传"} />
              <ToolStat label="输出" value={outputInfo.w ? `${outputInfo.w}×${outputInfo.h}` : "待处理"} />
            </div>
            <Form.Item label="预设">
              <Segmented block value={preset} onChange={(v) => applyPreset(v as typeof preset)} options={[{ label: "自定义", value: "custom" }, { label: "50%", value: "50" }, { label: "100%", value: "100" }, { label: "200%", value: "200" }]} />
            </Form.Item>
            <Form.Item>
              <Checkbox checked={lockRatio} onChange={(e) => setLockRatio(e.target.checked)}>锁定宽高比</Checkbox>
            </Form.Item>
            <Row gutter={10}>
              <Col span={12}><Form.Item label="目标宽"><InputNumber min={1} max={8192} value={targetW} onChange={(v) => onWidthChange(v ?? 1)} style={{ width: "100%" }} /></Form.Item></Col>
              <Col span={12}><Form.Item label="目标高"><InputNumber min={1} max={8192} value={targetH} onChange={(v) => onHeightChange(v ?? 1)} style={{ width: "100%" }} /></Form.Item></Col>
            </Row>
            <Button icon={<DownloadOutlined />} onClick={download} disabled={!img}>下载</Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={16}>
        <Card style={{ ...CARD_STYLE, minHeight: 480 }} styles={{ body: { padding: 14 } }} title={<Text style={{ color: "#a1a1aa" }}>原图 / 缩放效果</Text>}>
          {!img ? <EmptyState icon={<ShrinkOutlined />} title="上传图片后缩放" description="高质量重采样到指定尺寸，支持按比例与自定义。" minHeight={300} /> : (
            <div className="pixel-workspace">
              <div className="pixel-source">
                <span className="pixel-label">原图</span>
                <img src={imgUrl} alt="原图预览" />
              </div>
              <div className="pixel-effect">
                <span className="pixel-label">效果</span>
                <div className="tool-result-strip">
                  <Tag color="green">{outputInfo.w ? `${outputInfo.w}×${outputInfo.h}` : "待处理"}</Tag>
                  {scalePct > 0 && <Tag color="cyan">{scalePct}%</Tag>}
                </div>
                <div className="checker-bg tool-preview-stage">
                  <canvas ref={canvasRef} style={{ maxWidth: "100%", maxHeight: "calc(100vh - 320px)", imageRendering: "auto" }} />
                </div>
              </div>
            </div>
          )}
        </Card>
      </Col>
    </Row>
  );
}

/* ===== 格式导出/压缩 ===== */
function FormatPanel() {
  const { message } = App.useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [source, setSource] = useState<LoadedImage | null>(null);
  const [format, setFormat] = useState<"image/png" | "image/jpeg" | "image/webp">("image/webp");
  const [quality, setQuality] = useState(86);
  const [maxW, setMaxW] = useState(1600);
  const [maxH, setMaxH] = useState(1600);
  const [bg, setBg] = useState("#0a0a0a");
  const [output, setOutput] = useState<OutputInfo>({ w: 0, h: 0 });
  useObjectUrlCleanup(source?.url ?? "");

  async function onFile(files: FileList) {
    const f = files[0];
    if (!f) return;
    const { image, url } = await loadImageFromFile(f);
    if (source?.url) URL.revokeObjectURL(source.url);
    setSource({ image, url, name: f.name, size: f.size });
    setMaxW(image.naturalWidth);
    setMaxH(image.naturalHeight);
    setOutput({ w: 0, h: 0 });
  }

  function render() {
    const canvas = canvasRef.current;
    if (!canvas || !source) return;
    const ratio = Math.min(1, maxW / source.image.naturalWidth, maxH / source.image.naturalHeight);
    const w = Math.max(1, Math.round(source.image.naturalWidth * ratio));
    const h = Math.max(1, Math.round(source.image.naturalHeight * ratio));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    drawImageContain(ctx, source.image, w, h, format === "image/png" ? undefined : bg);
    canvas.toBlob((blob) => {
      if (!blob) return;
      setOutput({ w, h, blob, type: format });
      message.success(`已导出预览 ${formatBytes(blob.size)}`);
    }, format, format === "image/png" ? undefined : quality / 100);
  }

  function download() {
    if (!output.blob) return;
    const ext = output.type === "image/jpeg" ? "jpg" : output.type === "image/png" ? "png" : "webp";
    downloadBlob(output.blob, `ymcp_export.${ext}`);
  }

  const saved = source && output.blob ? source.size - output.blob.size : 0;

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={8}>
        <Card className="tool-control-card" style={CARD_STYLE} styles={{ body: PANEL_BODY }}>
          <Form layout="vertical">
            <Form.Item label="图片">
              <FileUploadTrigger accept="image/*" block label="选择图片" hint="离线转格式和压缩" selectedText={source?.name} icon={<PlusOutlined />} onFiles={onFile} />
            </Form.Item>
            <div className="tool-meta-row">
              <ToolStat label="原始" value={source ? `${source.image.naturalWidth}×${source.image.naturalHeight}` : "待上传"} />
              <ToolStat label="大小" value={source ? formatBytes(source.size) : "0 B"} />
            </div>
            <Form.Item label="输出格式">
              <Segmented block value={format} onChange={(v) => setFormat(v as typeof format)} options={[{ label: "WebP", value: "image/webp" }, { label: "JPEG", value: "image/jpeg" }, { label: "PNG", value: "image/png" }]} />
            </Form.Item>
            {format !== "image/png" && (
              <Form.Item label={`质量: ${quality}%`}>
                <Slider min={40} max={100} value={quality} onChange={setQuality} />
              </Form.Item>
            )}
            <Row gutter={10}>
              <Col span={12}><Form.Item label="最大宽"><InputNumber min={1} max={8192} value={maxW} onChange={(v) => setMaxW(v ?? 1)} style={{ width: "100%" }} /></Form.Item></Col>
              <Col span={12}><Form.Item label="最大高"><InputNumber min={1} max={8192} value={maxH} onChange={(v) => setMaxH(v ?? 1)} style={{ width: "100%" }} /></Form.Item></Col>
            </Row>
            {format !== "image/png" && <Form.Item label="透明底色"><Input value={bg} onChange={(e) => setBg(e.target.value)} prefix={<span className="color-chip" style={{ background: bg }} />} /></Form.Item>}
            <Space wrap>
              <Button type="primary" onClick={render} disabled={!source}>生成预览</Button>
              <Button icon={<DownloadOutlined />} onClick={download} disabled={!output.blob}>下载</Button>
            </Space>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={16}>
        <Card style={{ ...CARD_STYLE, minHeight: 480 }} styles={{ body: { padding: 14 } }} title={<Text style={{ color: "#a1a1aa" }}>导出预览</Text>}>
          {!source ? <EmptyState icon={<CompressOutlined />} title="上传图片后导出" description="把生成图转换成 WebP、JPEG 或 PNG，可限制最大尺寸。" minHeight={300} /> : (
            <>
              <div className="tool-result-strip">
                <Tag color="green">{output.w ? `${output.w}×${output.h}` : "未生成"}</Tag>
                <Tag>{output.blob ? formatBytes(output.blob.size) : "待计算"}</Tag>
                {saved > 0 && <Tag color="cyan">节省 {formatBytes(saved)}</Tag>}
              </div>
              <div className="checker-bg tool-preview-stage"><canvas ref={canvasRef} style={{ maxWidth: "100%", maxHeight: "calc(100vh - 280px)" }} /></div>
            </>
          )}
        </Card>
      </Col>
    </Row>
  );
}

/* ===== 透明裁切 ===== */
function TrimPanel() {
  const { message } = App.useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [source, setSource] = useState<LoadedImage | null>(null);
  const [alphaThreshold, setAlphaThreshold] = useState(8);
  const [padding, setPadding] = useState(0);
  const [output, setOutput] = useState({ w: 0, h: 0, bounds: "" });
  useObjectUrlCleanup(source?.url ?? "");

  async function onFile(files: FileList) {
    const f = files[0];
    if (!f) return;
    const { image, url } = await loadImageFromFile(f);
    if (source?.url) URL.revokeObjectURL(source.url);
    setSource({ image, url, name: f.name, size: f.size });
    setOutput({ w: 0, h: 0, bounds: "" });
  }

  function trim() {
    const canvas = canvasRef.current;
    if (!canvas || !source) return;
    const temp = document.createElement("canvas");
    temp.width = source.image.naturalWidth;
    temp.height = source.image.naturalHeight;
    const tctx = temp.getContext("2d")!;
    tctx.drawImage(source.image, 0, 0);
    const data = tctx.getImageData(0, 0, temp.width, temp.height).data;
    let minX = temp.width;
    let minY = temp.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < temp.height; y += 1) {
      for (let x = 0; x < temp.width; x += 1) {
        const alpha = data[(y * temp.width + x) * 4 + 3];
        if (alpha > alphaThreshold) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (maxX < 0 || maxY < 0) {
      message.warning("没有找到不透明像素");
      return;
    }
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;
    canvas.width = cropW + padding * 2;
    canvas.height = cropH + padding * 2;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(temp, minX, minY, cropW, cropH, padding, padding, cropW, cropH);
    setOutput({ w: canvas.width, h: canvas.height, bounds: `${cropW}×${cropH}` });
    message.success("裁切完成");
  }

  async function download() {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width) return;
    downloadBlob(await canvasToBlob(canvas), "trimmed_asset.png");
  }

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={8}>
        <Card className="tool-control-card" style={CARD_STYLE} styles={{ body: PANEL_BODY }}>
          <Form layout="vertical">
            <Form.Item label="透明图片">
              <FileUploadTrigger accept="image/png,image/webp" block label="选择图片" hint="适合 PNG / WebP 素材" selectedText={source?.name} icon={<PlusOutlined />} onFiles={onFile} />
            </Form.Item>
            <div className="tool-meta-row">
              <ToolStat label="原始" value={source ? `${source.image.naturalWidth}×${source.image.naturalHeight}` : "待上传"} />
              <ToolStat label="输出" value={output.w ? `${output.w}×${output.h}` : "待裁切"} />
            </div>
            <Form.Item label={`Alpha 阈值: ${alphaThreshold}`}>
              <Slider min={0} max={128} value={alphaThreshold} onChange={setAlphaThreshold} />
            </Form.Item>
            <Form.Item label="外扩留白">
              <InputNumber min={0} max={512} value={padding} onChange={(v) => setPadding(v ?? 0)} style={{ width: "100%" }} />
            </Form.Item>
            <Space wrap>
              <Button type="primary" onClick={trim} disabled={!source}>裁切透明边</Button>
              <Button icon={<DownloadOutlined />} onClick={download} disabled={!output.w}>下载</Button>
            </Space>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={16}>
        <Card style={{ ...CARD_STYLE, minHeight: 480 }} styles={{ body: { padding: 14 } }} title={<Text style={{ color: "#a1a1aa" }}>裁切结果</Text>}>
          {!source ? <EmptyState icon={<ScissorOutlined />} title="上传透明素材" description="自动寻找不透明区域，去掉多余透明边并保留可控留白。" minHeight={300} /> : (
            <>
              <div className="tool-result-strip"><Tag color="green">{output.bounds ? `内容 ${output.bounds}` : "未裁切"}</Tag><Tag>{output.w ? `画布 ${output.w}×${output.h}` : "待生成"}</Tag></div>
              <div className="checker-bg tool-preview-stage"><canvas ref={canvasRef} style={{ maxWidth: "100%", maxHeight: "calc(100vh - 280px)", imageRendering: "pixelated" }} /></div>
            </>
          )}
        </Card>
      </Col>
    </Row>
  );
}

/* ===== 调色板提取 ===== */
function PalettePanel() {
  const { message } = App.useApp();
  const [source, setSource] = useState<LoadedImage | null>(null);
  const [colors, setColors] = useState<{ hex: string; count: number }[]>([]);
  const [sampleStep, setSampleStep] = useState(6);
  const [bucketSize, setBucketSize] = useState(32);
  useObjectUrlCleanup(source?.url ?? "");

  async function onFile(files: FileList) {
    const f = files[0];
    if (!f) return;
    const { image, url } = await loadImageFromFile(f);
    if (source?.url) URL.revokeObjectURL(source.url);
    setSource({ image, url, name: f.name, size: f.size });
    setColors([]);
  }

  function extract() {
    if (!source) return;
    const canvas = document.createElement("canvas");
    const maxSide = 512;
    const ratio = Math.min(1, maxSide / Math.max(source.image.naturalWidth, source.image.naturalHeight));
    canvas.width = Math.max(1, Math.round(source.image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(source.image.naturalHeight * ratio));
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(source.image, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = new Map<string, number>();
    const step = Math.max(1, sampleStep);
    const bucket = Math.max(8, bucketSize);
    for (let y = 0; y < canvas.height; y += step) {
      for (let x = 0; x < canvas.width; x += step) {
        const i = (y * canvas.width + x) * 4;
        if (imageData[i + 3] < 16) continue;
        const r = Math.min(255, Math.round(imageData[i] / bucket) * bucket);
        const g = Math.min(255, Math.round(imageData[i + 1] / bucket) * bucket);
        const b = Math.min(255, Math.round(imageData[i + 2] / bucket) * bucket);
        const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
        counts.set(hex, (counts.get(hex) ?? 0) + 1);
      }
    }
    const result = [...counts.entries()]
      .map(([hex, count]) => ({ hex, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
    setColors(result);
    message.success(`提取 ${result.length} 个主色`);
  }

  async function copyPalette() {
    const text = colors.map((color) => color.hex).join("\n");
    await navigator.clipboard.writeText(text);
    message.success("已复制色板");
  }

  const total = useMemo(() => colors.reduce((sum, color) => sum + color.count, 0), [colors]);

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={8}>
        <Card className="tool-control-card" style={CARD_STYLE} styles={{ body: PANEL_BODY }}>
          <Form layout="vertical">
            <Form.Item label="图片">
              <FileUploadTrigger accept="image/*" block label="选择图片" hint="从素材提取主色" selectedText={source?.name} icon={<PlusOutlined />} onFiles={onFile} />
            </Form.Item>
            <div className="tool-meta-row">
              <ToolStat label="原始" value={source ? `${source.image.naturalWidth}×${source.image.naturalHeight}` : "待上传"} />
              <ToolStat label="色板" value={colors.length ? `${colors.length} 色` : "待提取"} />
            </div>
            <Form.Item label="采样步长">
              <InputNumber min={1} max={24} value={sampleStep} onChange={(v) => setSampleStep(v ?? 6)} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="颜色归并">
              <Segmented block value={bucketSize} onChange={(v) => setBucketSize(Number(v))} options={[{ label: "细", value: 16 }, { label: "中", value: 32 }, { label: "粗", value: 48 }]} />
            </Form.Item>
            <Space wrap>
              <Button type="primary" onClick={extract} disabled={!source}>提取主色</Button>
              <Button onClick={copyPalette} disabled={!colors.length}>复制色板</Button>
            </Space>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={16}>
        <Card style={{ ...CARD_STYLE, minHeight: 480 }} styles={{ body: { padding: 14 } }} title={<Text style={{ color: "#a1a1aa" }}>调色板</Text>}>
          {!source ? <EmptyState icon={<BgColorsOutlined />} title="上传图片提取配色" description="适合从角色图、场景图或产品图里提取项目色板。" minHeight={300} /> : (
            <div className="palette-workspace">
              <div className="palette-source"><img src={source.url} alt="待提取配色的图片预览" /></div>
              {colors.length ? (
                <div className="palette-grid">
                  {colors.map((color) => (
                    <button key={color.hex} className="palette-swatch" onClick={() => navigator.clipboard.writeText(color.hex).then(() => message.success(`已复制 ${color.hex}`))}>
                      <span className="palette-color" style={{ background: color.hex }} />
                      <span className="palette-hex">{color.hex}</span>
                      <span className="palette-ratio">{total ? Math.round((color.count / total) * 100) : 0}%</span>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState icon={<BgColorsOutlined />} title="尚未提取" description="点击提取主色后会生成可复制的项目色板。" minHeight={240} />
              )}
            </div>
          )}
        </Card>
      </Col>
    </Row>
  );
}

export default function ImageTools() {
  const tools = [
    { key: "format", label: <span><CompressOutlined /> 格式导出</span>, children: <FormatPanel /> },
    { key: "trim", label: <span><ScissorOutlined /> 透明裁切</span>, children: <TrimPanel /> },
    { key: "palette", label: <span><BgColorsOutlined /> 调色板</span>, children: <PalettePanel /> },
    { key: "compose", label: <span><BlockOutlined /> 合成帧表</span>, children: <ComposePanel /> },
    { key: "stitch", label: <span><ColumnHeightOutlined /> 简单拼接</span>, children: <StitchPanel /> },
    { key: "pixelate", label: <span><AppstoreOutlined /> 像素化</span>, children: <PixelatePanel /> },
    { key: "scale", label: <span><ShrinkOutlined /> 缩放</span>, children: <ScalePanel /> },
  ];

  return (
    <div className="image-tools-page">
      <PageHeader
        title="图像工具集"
        description="离线整理 AI 生图、Sprite 帧、透明素材与项目配色。所有处理都在浏览器本地完成。"
        icon={<AppstoreOutlined />}
      />
      <ToolIntro />
      <GlassCard className="image-tools-tabs-card" padding={16} spotlight>
        <Tabs defaultActiveKey="format" items={tools} />
      </GlassCard>
    </div>
  );
}
