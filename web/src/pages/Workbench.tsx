import { useRef, useState, useEffect } from "react";
import {
  Card, Typography, Form, InputNumber, Input, Button, Row, Col, Space, App, Progress,
} from "antd";
import {
  ToolOutlined, DownloadOutlined, FileZipOutlined, PlayCircleOutlined, UploadOutlined,
} from "@ant-design/icons";
import {
  seekVideo, canvasToBlob, downloadBlob, makeZip, formatClock, applyCanvasKey,
  type FrameItem,
} from "@/lib/canvas";
import { PageHeader, EmptyState } from "@/components/showtime";
import { FileUploadTrigger } from "@/components/FileUploadTrigger";

const { Text } = Typography;

export default function Workbench() {
  const { message } = App.useApp();
  const videoRef = useRef<HTMLVideoElement>(null);
  const sheetRef = useRef<HTMLCanvasElement>(null);
  const [fileName, setFileName] = useState<string>("");
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [meta, setMeta] = useState<{ dur: number; w: number; h: number }>({ dur: 0, w: 0, h: 0 });
  const [currentTime, setCurrentTime] = useState(0);
  const [frames, setFrames] = useState<FrameItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);

  const [fps, setFps] = useState(12);
  const [maxFrames, setMaxFrames] = useState(300);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState<number | null>(null);
  const [outW, setOutW] = useState<number | null>(null);
  const [outH, setOutH] = useState<number | null>(null);
  const [cols, setCols] = useState(4);
  const [keyColor, setKeyColor] = useState("");
  const [tolerance, setTolerance] = useState(42);
  const [feather, setFeather] = useState(38);

  function onFile(files: FileList) {
    const f = files[0];
    if (!f) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    const url = URL.createObjectURL(f);
    setVideoUrl(url);
    setFileName(f.name);
    setFrames([]);
  }

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoUrl) return;
    const onMeta = () => {
      setMeta({ dur: v.duration || 0, w: v.videoWidth, h: v.videoHeight });
      setEndSec(null);
    };
    const onTime = () => setCurrentTime(v.currentTime);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("timeupdate", onTime);
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("timeupdate", onTime);
    };
  }, [videoUrl]);

  function setRangePoint(point: "start" | "end") {
    const v = videoRef.current;
    if (!v) return;
    const t = Math.round(v.currentTime * 100) / 100;
    if (point === "start") setStartSec(t);
    else setEndSec(t);
  }

  function buildTimes(): number[] {
    const v = videoRef.current;
    if (!v) return [];
    const dur = v.duration || 0;
    const s = Math.max(0, Math.min(dur, startSec));
    const e = endSec != null ? Math.max(s, Math.min(dur, endSec)) : dur;
    const step = 1 / Math.max(1, fps);
    const times: number[] = [];
    for (let t = s; t <= e + 0.0001 && times.length < maxFrames; t += step) {
      times.push(Math.min(e, t));
    }
    if (!times.length) times.push(s);
    return times;
  }

  async function extract() {
    const v = videoRef.current;
    if (!v || !v.videoWidth) {
      message.warning("请先选择并加载视频");
      return;
    }
    const times = buildTimes();
    const w = Math.max(1, outW ?? v.videoWidth);
    const h = Math.max(1, outH ?? v.videoHeight);
    setLoading(true);
    setProgress(0);
    setFrames([]);
    const result: FrameItem[] = [];
    const fc = document.createElement("canvas");
    fc.width = w;
    fc.height = h;
    const fctx = fc.getContext("2d")!;
    for (let i = 0; i < times.length; i++) {
      await seekVideo(v, times[i]);
      fctx.clearRect(0, 0, w, h);
      fctx.drawImage(v, 0, 0, w, h);
      if (keyColor) applyCanvasKey(fc, keyColor, tolerance, feather);
      const copy = document.createElement("canvas");
      copy.width = w;
      copy.height = h;
      copy.getContext("2d")!.drawImage(fc, 0, 0);
      const blob = await canvasToBlob(copy);
      result.push({
        name: `frame_${String(i).padStart(4, "0")}.png`,
        blob,
        canvas: copy,
      });
      setProgress(Math.round(((i + 1) / times.length) * 100));
      if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    setFrames(result);
    renderSheet(result);
    setLoading(false);
    message.success(`提取完成，共 ${result.length} 帧`);
  }

  function renderSheet(list: FrameItem[]) {
    const sheet = sheetRef.current;
    if (!sheet || !list.length) return;
    const c = Math.max(1, cols);
    const rows = Math.ceil(list.length / c);
    const cw = list[0].canvas.width;
    const ch = list[0].canvas.height;
    sheet.width = c * cw;
    sheet.height = rows * ch;
    const ctx = sheet.getContext("2d")!;
    ctx.clearRect(0, 0, sheet.width, sheet.height);
    list.forEach((f, i) => {
      ctx.drawImage(f.canvas, (i % c) * cw, Math.floor(i / c) * ch);
    });
  }

  async function downloadZip() {
    if (!frames.length) return;
    downloadBlob(await makeZip(frames), "video_frames.zip");
  }

  function downloadSheet() {
    const sheet = sheetRef.current;
    if (!sheet || !sheet.width) return;
    sheet.toBlob((blob) => blob && downloadBlob(blob, "spritesheet.png"), "image/png");
  }

  const durLabel = meta.dur ? formatClock(meta.dur) : "--:--";

  return (
    <div style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 28px 48px" }}>
      <PageHeader
        title="视频转序列帧"
        description="纯浏览器抽帧，不上传服务器。支持透明抠色与 Sprite Sheet 导出。"
        icon={<ToolOutlined />}
      />

      <Row gutter={16}>
        <Col xs={24} lg={9}>
          <Card style={{ background: "#18181b", borderColor: "#27272a" }} styles={{ body: { padding: 18 } }}>
            <Form layout="vertical">
              <Form.Item label="视频文件">
                <FileUploadTrigger
                  accept="video/*"
                  block
                  label="选择视频文件"
                  hint="MP4 / WebM / MOV"
                  selectedText={fileName || undefined}
                  icon={<UploadOutlined />}
                  onFiles={onFile}
                />
              </Form.Item>

              {videoUrl && (
                <div
                  className="checker-bg"
                  style={{ borderRadius: 8, padding: 8, marginBottom: 14, textAlign: "center" }}
                >
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    controls
                    playsInline
                    muted
                    style={{ maxWidth: "100%", maxHeight: 220, borderRadius: 6 }}
                  />
                  <div style={{ fontSize: 11, color: "#71717a", marginTop: 6 }}>
                    {fileName} · {meta.w}x{meta.h} · {durLabel}
                  </div>
                </div>
              )}

              <Space style={{ marginBottom: 12 }}>
                <Button size="small" onClick={() => setRangePoint("start")}>设为起点</Button>
                <Button size="small" onClick={() => setRangePoint("end")}>设为终点</Button>
                <Text style={{ color: "#71717a", fontSize: 12 }}>
                  {formatClock(currentTime)} / {durLabel}
                </Text>
              </Space>

              <Row gutter={10}>
                <Col span={12}>
                  <Form.Item label="目标 FPS">
                    <InputNumber min={1} max={60} value={fps} onChange={(v) => setFps(v ?? 12)} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="最大帧数">
                    <InputNumber min={1} max={2000} value={maxFrames} onChange={(v) => setMaxFrames(v ?? 300)} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={10}>
                <Col span={12}>
                  <Form.Item label="起始秒">
                    <InputNumber min={0} step={0.05} value={startSec} onChange={(v) => setStartSec(v ?? 0)} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="结束秒">
                    <InputNumber min={0} step={0.05} value={endSec ?? undefined} placeholder="默认结尾" onChange={(v) => setEndSec(v ?? null)} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={10}>
                <Col span={12}>
                  <Form.Item label="输出宽度">
                    <InputNumber min={1} value={outW ?? undefined} placeholder="原宽" onChange={(v) => setOutW(v ?? null)} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="输出高度">
                    <InputNumber min={1} value={outH ?? undefined} placeholder="原高" onChange={(v) => setOutH(v ?? null)} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
              </Row>

              <div style={{ height: 1, background: "#27272a", margin: "4px 0 14px" }} />

              <Form.Item label="Sprite 列数">
                <InputNumber min={1} value={cols} onChange={(v) => setCols(v ?? 4)} style={{ width: "100%" }} />
              </Form.Item>
              <Row gutter={10}>
                <Col span={12}>
                  <Form.Item label="透明抠色">
                    <Input value={keyColor} onChange={(e) => setKeyColor(e.target.value)} placeholder="如 #00ff00" />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label="容差">
                    <InputNumber min={0} max={255} value={tolerance} onChange={(v) => setTolerance(v ?? 42)} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label="羽化">
                    <InputNumber min={1} max={255} value={feather} onChange={(v) => setFeather(v ?? 38)} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
              </Row>

              <Button type="primary" block loading={loading} onClick={extract} disabled={!videoUrl}>
                <PlayCircleOutlined /> 提取序列帧
              </Button>
            </Form>
          </Card>
        </Col>

        <Col xs={24} lg={15}>
          <Card
            style={{ background: "#18181b", borderColor: "#27272a", minHeight: 480 }}
            styles={{ body: { padding: 18 } }}
            title={
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ color: "#a1a1aa" }}>序列帧 ({frames.length})</Text>
                {frames.length > 0 && (
                  <Space>
                    <Button size="small" icon={<FileZipOutlined />} onClick={downloadZip}>PNG ZIP</Button>
                    <Button size="small" icon={<DownloadOutlined />} onClick={downloadSheet}>Sprite Sheet</Button>
                  </Space>
                )}
              </div>
            }
          >
            {loading && (
              <div style={{ marginBottom: 14 }}>
                <Progress percent={progress} strokeColor={{ from: "#10b981", to: "#34d399" }} />
              </div>
            )}

            {frames.length === 0 && !loading ? (
              <EmptyState
                icon={<PlayCircleOutlined />}
                title="上传视频后提取序列帧"
                description="选择本地视频文件，调整 FPS 与帧数范围，开始抽帧。"
                minHeight={280}
              />
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  maxHeight: "calc(100vh - 320px)",
                  overflow: "auto",
                  padding: 4,
                }}
              >
                {frames.map((f, i) => (
                  <div
                    key={i}
                    className="checker-bg"
                    style={{
                      borderRadius: 8,
                      overflow: "hidden",
                      border: "1px solid #27272a",
                      textAlign: "center",
                      padding: 4,
                    }}
                  >
                    <div style={{ fontSize: 10, color: "#71717a", marginBottom: 2, paddingLeft: 6, textAlign: "left" }}>
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
                      style={{ maxWidth: "100%", maxHeight: 320, objectFit: "contain", imageRendering: "pixelated", display: "block", margin: "0 auto" }}
                    />
                  </div>
                ))}
              </div>
            )}

            {frames.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <Text style={{ color: "#71717a", fontSize: 12, display: "block", marginBottom: 8 }}>
                  Sprite Sheet 预览
                </Text>
                <div className="checker-bg" style={{ borderRadius: 8, padding: 8, textAlign: "center" }}>
                  <canvas
                    ref={sheetRef}
                    style={{ maxWidth: "100%", maxHeight: 480, imageRendering: "pixelated" }}
                  />
                </div>
              </div>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
