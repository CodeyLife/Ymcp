import { useRef, useState, useEffect, useCallback } from "react";
import {
  Card, Typography, Form, InputNumber, Button, Row, Col, Space, App, Segmented, Slider, Switch, Tag,
} from "antd";
import {
  BorderOuterOutlined, FileZipOutlined, EyeOutlined, PlayCircleOutlined, PauseCircleOutlined,
} from "@ant-design/icons";
import { loadImageFromFile, canvasToBlob, downloadBlob, makeZip, type FrameItem } from "@/lib/canvas";
import { useUIStore } from "@/stores/ui";
import { PageHeader, EmptyState } from "@/components/showtime";

const { Text } = Typography;

export default function SpriteSplit() {
  const { message } = App.useApp();
  const previewRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<HTMLCanvasElement>(null);
  const animTimerRef = useRef<number | null>(null);

  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [imgUrl, setImgUrl] = useState("");
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [rows, setRows] = useState(4);
  const [cols, setCols] = useState(4);
  const [padX, setPadX] = useState(0);
  const [padY, setPadY] = useState(0);
  const [showGrid, setShowGrid] = useState(true);
  const [frames, setFrames] = useState<FrameItem[]>([]);

  // 动画预览状态
  const [animPlaying, setAnimPlaying] = useState(false);
  const [animFps, setAnimFps] = useState(8);
  const [animFrame, setAnimFrame] = useState(0);
  const [animLoop, setAnimLoop] = useState(true);

  const incomingImage = useUIStore((s) => s.incomingImage);

  // 接收跨页传来的图片
  useEffect(() => {
    if (!incomingImage?.src) return;
    let cancelled = false;
    let revokeUrl: string | null = null;
    (async () => {
      try {
        const resp = await fetch(incomingImage.src);
        const blob = await resp.blob();
        const file = new File([blob], "sprite.png", { type: blob.type || "image/png" });
        const { image, url } = await loadImageFromFile(file);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        if (imgUrl) URL.revokeObjectURL(imgUrl);
        revokeUrl = url;
        setImg(image);
        setImgUrl(url);
        setFrames([]);
        setMode("auto");
        if (incomingImage.from === "image-gen") {
          message.info("已载入生图结果，默认自动推测网格");
        }
        // 直接用 image 绘制，避免闭包里 img 还是 null
        requestAnimationFrame(() => {
          const canvas = previewRef.current;
          if (!canvas) return;
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(image, 0, 0);
          // 绘制网格
          const gc = gridRef.current;
          if (!gc) return;
          gc.width = canvas.width;
          gc.height = canvas.height;
          const gctx = gc.getContext("2d");
          if (!gctx) return;
          gctx.clearRect(0, 0, gc.width, gc.height);
          const ratio = image.naturalWidth / image.naturalHeight;
          let r: number, c: number;
          if (ratio > 1) {
            c = Math.max(2, Math.round(ratio * 2));
            r = Math.max(2, Math.round(c / ratio));
          } else {
            r = Math.max(2, Math.round((1 / ratio) * 2));
            c = Math.max(2, Math.round(r * ratio));
          }
          const cw = image.naturalWidth / c;
          const ch = image.naturalHeight / r;
          gctx.strokeStyle = "rgba(16, 185, 129, 0.85)";
          gctx.lineWidth = Math.max(1, Math.round(Math.min(gc.width, gc.height) / 400));
          for (let y = 0; y < r; y++) {
            for (let x = 0; x < c; x++) {
              gctx.strokeRect(x * cw, y * ch, cw, ch);
            }
          }
        });
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

  // 清理跨页传图状态
  useEffect(() => {
    return () => {
      if (animTimerRef.current) cancelAnimationFrame(animTimerRef.current);
      if (imgUrl) URL.revokeObjectURL(imgUrl);
    };
  }, [imgUrl]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    const { image, url } = await loadImageFromFile(f);
    setImg(image);
    setImgUrl(url);
    setFrames([]);
    requestAnimationFrame(drawPreview);
  }

  function drawPreview() {
    const canvas = previewRef.current;
    if (!canvas || !img) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    drawGrid();
  }

  function drawGrid() {
    const gc = gridRef.current;
    const pc = previewRef.current;
    if (!gc || !pc || !img) return;
    gc.width = pc.width;
    gc.height = pc.height;
    const ctx = gc.getContext("2d")!;
    ctx.clearRect(0, 0, gc.width, gc.height);
    const { cw, ch, r, c } = cellGeometry();
    ctx.strokeStyle = "rgba(16, 185, 129, 0.85)";
    ctx.lineWidth = Math.max(1, Math.round(Math.min(gc.width, gc.height) / 400));
    for (let y = 0; y < r; y++) {
      for (let x = 0; x < c; x++) {
        ctx.strokeRect(x * cw + padX, y * ch + padY, cw - padX * 2, ch - padY * 2);
      }
    }
  }

  function cellGeometry() {
    if (!img) return { cw: 0, ch: 0, r: 0, c: 0 };
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    let r = rows;
    let c = cols;
    if (mode === "auto") {
      // 自动推测：假设接近正方形的网格，根据宽高比推测
      const ratio = w / h;
      if (ratio > 1) {
        c = Math.max(2, Math.round(ratio * 2));
        r = Math.max(2, Math.round(c / ratio));
      } else {
        r = Math.max(2, Math.round((1 / ratio) * 2));
        c = Math.max(2, Math.round(r * ratio));
      }
    }
    const cw = w / c;
    const ch = h / r;
    return { cw, ch, r, c };
  }

  function split() {
    if (!img) return;
    const { cw, ch, r, c } = cellGeometry();
    const result: FrameItem[] = [];
    for (let y = 0; y < r; y++) {
      for (let x = 0; x < c; x++) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(cw - padX * 2));
        canvas.height = Math.max(1, Math.round(ch - padY * 2));
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(
          img,
          x * cw + padX,
          y * ch + padY,
          cw - padX * 2,
          ch - padY * 2,
          0,
          0,
          canvas.width,
          canvas.height
        );
        result.push({
          name: `cell_${String(y).padStart(2, "0")}_${String(x).padStart(2, "0")}.png`,
          blob: new Blob(),
          canvas,
        });
      }
    }
    Promise.all(
      result.map(async (f) => {
        f.blob = await canvasToBlob(f.canvas);
      })
    ).then(() => {
      setFrames(result);
      setAnimFrame(0);
      message.success(`拆分完成，共 ${result.length} 帧`);
    });
  }

  async function downloadZip() {
    if (!frames.length) return;
    downloadBlob(await makeZip(frames), "sprite_split.zip");
  }

  function downloadOne(i: number) {
    const f = frames[i];
    if (!f) return;
    downloadBlob(f.blob, f.name);
  }

  // 动画预览：绘制指定帧
  const drawAnimFrame = useCallback((frameIdx: number) => {
    const canvas = animRef.current;
    if (!canvas || !frames.length) return;
    const f = frames[frameIdx % frames.length];
    if (!f?.canvas) return;
    canvas.width = f.canvas.width;
    canvas.height = f.canvas.height;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(f.canvas, 0, 0);
  }, [frames]);

  // 动画播放循环
  useEffect(() => {
    if (!animPlaying || !frames.length) return;
    const interval = 1000 / animFps;
    let lastTime = performance.now();
    let idx = animFrame;

    const tick = (now: number) => {
      if (now - lastTime >= interval) {
        idx = idx + 1;
        if (idx >= frames.length) {
          if (animLoop) {
            idx = 0;
          } else {
            setAnimPlaying(false);
            setAnimFrame(frames.length - 1);
            return;
          }
        }
        setAnimFrame(idx);
        drawAnimFrame(idx);
        lastTime = now;
      }
      animTimerRef.current = requestAnimationFrame(tick);
    };
    animTimerRef.current = requestAnimationFrame(tick);
    return () => {
      if (animTimerRef.current) cancelAnimationFrame(animTimerRef.current);
    };
  }, [animPlaying, animFps, animLoop, frames, animFrame, drawAnimFrame]);

  // 手动切换帧时也重绘
  useEffect(() => {
    if (!animPlaying) drawAnimFrame(animFrame);
  }, [animFrame, animPlaying, drawAnimFrame]);

  const { r: gridR, c: gridC } = cellGeometry();

  return (
    <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 28px 48px" }}>
      <PageHeader
        title="SpriteSheet 拆分"
        description="等分网格切割，批量导出 PNG 帧。默认自动推测网格，支持动画预览。"
        icon={<BorderOuterOutlined />}
      />

      <Row gutter={16}>
        <Col xs={24} lg={7}>
          <Card style={{ background: "#18181b", borderColor: "#27272a" }} styles={{ body: { padding: 18 } }}>
            <Form layout="vertical">
              <Form.Item label="Sprite Sheet 图片">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={onFile}
                  style={{ width: "100%", color: "#a1a1aa", fontSize: 13 }}
                />
              </Form.Item>
              <Form.Item label="模式">
                <Segmented
                  block
                  value={mode}
                  onChange={(v) => { setMode(v as typeof mode); requestAnimationFrame(drawGrid); }}
                  options={[
                    { label: "自动推测", value: "auto" },
                    { label: "手动行列", value: "manual" },
                  ]}
                />
              </Form.Item>
              {mode === "manual" && (
                <Row gutter={10}>
                  <Col span={12}>
                    <Form.Item label="行数">
                      <InputNumber min={1} max={64} value={rows} onChange={(v) => { setRows(v ?? 1); requestAnimationFrame(drawGrid); }} style={{ width: "100%" }} />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item label="列数">
                      <InputNumber min={1} max={64} value={cols} onChange={(v) => { setCols(v ?? 1); requestAnimationFrame(drawGrid); }} style={{ width: "100%" }} />
                    </Form.Item>
                  </Col>
                </Row>
              )}
              {img && (
                <div style={{ marginBottom: 12, fontSize: 12, color: "#71717a" }}>
                  推测网格：<Tag color="green">{gridR} 行 × {gridC} 列</Tag>
                  共 {gridR * gridC} 帧
                </div>
              )}
              <Row gutter={10}>
                <Col span={12}>
                  <Form.Item label="水平内边距">
                    <InputNumber min={0} value={padX} onChange={(v) => { setPadX(v ?? 0); requestAnimationFrame(drawGrid); }} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="垂直内边距">
                    <InputNumber min={0} value={padY} onChange={(v) => { setPadY(v ?? 0); requestAnimationFrame(drawGrid); }} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
              </Row>
              <Space style={{ marginBottom: 12 }}>
                <Button size="small" icon={<EyeOutlined />} onClick={() => { setShowGrid((s) => !s); requestAnimationFrame(drawGrid); }}>
                  {showGrid ? "隐藏网格" : "显示网格"}
                </Button>
              </Space>
              <div style={{ height: 1, background: "#27272a", margin: "4px 0 14px" }} />
              <Button type="primary" block onClick={split} disabled={!img}>
                拆分并导出
              </Button>
              {frames.length > 0 && (
                <Button block icon={<FileZipOutlined />} onClick={downloadZip} style={{ marginTop: 8 }}>
                  下载 ZIP ({frames.length})
                </Button>
              )}
            </Form>
          </Card>
        </Col>

        <Col xs={24} lg={17}>
          <Card
            style={{ background: "#18181b", borderColor: "#27272a", minHeight: 480 }}
            styles={{ body: { padding: 18 } }}
            title={<Text style={{ color: "#a1a1aa" }}>预览与切片</Text>}
          >
            {!img ? (
              <EmptyState
                icon={<BorderOuterOutlined />}
                title="上传 Sprite Sheet"
                description="选择本地图片或从生图页发送图片，自动推测网格。"
                minHeight={360}
              />
            ) : (
              <>
                <div className="checker-bg" style={{ borderRadius: 8, padding: 12, textAlign: "center", marginBottom: 16, position: "relative" }}>
                  <div style={{ display: "inline-block", position: "relative" }}>
                    <canvas ref={previewRef} style={{ maxWidth: "100%", maxHeight: "calc(100vh - 240px)", imageRendering: "pixelated" }} />
                    {showGrid && (
                      <canvas
                        ref={gridRef}
                        style={{
                          position: "absolute",
                          left: 0,
                          top: 0,
                          maxWidth: "100%",
                          maxHeight: "calc(100vh - 240px)",
                          pointerEvents: "none",
                          imageRendering: "pixelated",
                        }}
                      />
                    )}
                  </div>
                </div>

                {frames.length > 0 && (
                  <>
                    {/* 动画预览区 */}
                    <div
                      style={{
                        background: "#0a0a0a",
                        borderRadius: 8,
                        padding: 16,
                        marginBottom: 16,
                        border: "1px solid #27272a",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                        <Text style={{ color: "#a1a1aa", fontSize: 13 }}>
                          动画预览
                        </Text>
                        <Space size={12}>
                          <Button
                            size="small"
                            type={animPlaying ? "default" : "primary"}
                            icon={animPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                            onClick={() => setAnimPlaying((p) => !p)}
                          >
                            {animPlaying ? "暂停" : "播放"}
                          </Button>
                          <Space size={4}>
                            <Text style={{ color: "#71717a", fontSize: 12 }}>循环</Text>
                            <Switch size="small" checked={animLoop} onChange={setAnimLoop} />
                          </Space>
                        </Space>
                      </div>
                      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                        <div className="checker-bg" style={{ borderRadius: 6, padding: 8, flex: "0 0 auto" }}>
                          <canvas
                            ref={animRef}
                            style={{ maxWidth: 200, maxHeight: 200, imageRendering: "pixelated" }}
                          />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Text style={{ color: "#71717a", fontSize: 12, display: "block", marginBottom: 4 }}>
                            帧率: {animFps} FPS
                          </Text>
                          <Slider
                            min={1}
                            max={30}
                            value={animFps}
                            onChange={setAnimFps}
                            style={{ marginBottom: 8 }}
                          />
                          <Text style={{ color: "#71717a", fontSize: 12, display: "block", marginBottom: 4 }}>
                            帧: {animFrame + 1} / {frames.length}
                          </Text>
                          <Slider
                            min={0}
                            max={frames.length - 1}
                            value={animFrame}
                            onChange={(v) => { setAnimFrame(v); setAnimPlaying(false); }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* 帧列表 */}
                    <Text style={{ color: "#71717a", fontSize: 12, display: "block", marginBottom: 8 }}>
                      切片列表（点击下载）
                    </Text>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                        maxHeight: "calc(100vh - 220px)",
                        overflow: "auto",
                        padding: 4,
                      }}
                    >
                      {frames.map((f, i) => (
                        <div
                          key={i}
                          onClick={() => downloadOne(i)}
                          className="checker-bg"
                          style={{
                            borderRadius: 8,
                            overflow: "hidden",
                            border: i === animFrame ? "2px solid #10b981" : "1px solid #27272a",
                            cursor: "pointer",
                            transition: "border-color 0.15s",
                            position: "relative",
                            textAlign: "center",
                            padding: 6,
                          }}
                          onMouseEnter={(e) => { if (i !== animFrame) e.currentTarget.style.borderColor = "#10b981"; }}
                          onMouseLeave={(e) => { if (i !== animFrame) e.currentTarget.style.borderColor = "#27272a"; }}
                        >
                          <div style={{ fontSize: 10, color: "#71717a", marginBottom: 4, paddingLeft: 6, textAlign: "left" }}>
                            {String(i + 1).padStart(3, "0")} · {f.canvas.width}×{f.canvas.height}
                          </div>
                          <canvas
                            ref={(el) => {
                              if (el && f.canvas) {
                                el.width = f.canvas.width;
                                el.height = f.canvas.height;
                                el.getContext("2d")!.drawImage(f.canvas, 0, 0);
                              }
                            }}
                            style={{ maxWidth: "100%", maxHeight: 220, objectFit: "contain", imageRendering: "pixelated", display: "block", margin: "0 auto" }}
                          />
                          {i === animFrame && (
                            <div style={{
                              position: "absolute",
                              top: 6,
                              right: 6,
                              background: "rgba(16,185,129,0.85)",
                              color: "#fff",
                              fontSize: 10,
                              textAlign: "center",
                              padding: "1px 6px",
                              borderRadius: 4,
                            }}>
                              当前 {i + 1}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
