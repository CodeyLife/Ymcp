import { useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  Typography,
  Form,
  Input,
  Button,
  Row,
  Col,
  Space,
  App,
  Alert,
  Tag,
  Empty,
  Tooltip,
} from "antd";
import {
  BlockOutlined,
  DownloadOutlined,
  ReloadOutlined,
  DeleteOutlined,
  InboxOutlined,
  FileImageOutlined,
  ClockCircleOutlined,
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  LoadingOutlined,
} from "@ant-design/icons";
import { usePsdTaskStore, type PsdTaskView } from "@/stores/psdTask";
import { getEffectiveApiConfig } from "@/stores/ui";
import {
  createPsdTask,
  queryEditableFileTasks,
  downloadEditableFile,
  buildEditableFileUrl,
} from "@/lib/api";
import { downloadBlob } from "@/lib/canvas";
import { FileUploadTrigger } from "@/components/FileUploadTrigger";

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

const POLL_INTERVAL_MS = 4000;

function statusMeta(status: PsdTaskView["status"]): {
  color: string;
  text: string;
  icon: React.ReactNode;
} {
  switch (status) {
    case "queued":
      return { color: "default", text: "排队中", icon: <ClockCircleOutlined /> };
    case "running":
      return { color: "processing", text: "生成中", icon: <LoadingOutlined spin /> };
    case "success":
      return {
        color: "success",
        text: "完成",
        icon: <CheckCircleTwoTone twoToneColor="#10b981" />,
      };
    case "error":
      return {
        color: "error",
        text: "失败",
        icon: <CloseCircleTwoTone twoToneColor="#ef4444" />,
      };
    default:
      return { color: "default", text: status || "未知", icon: null };
  }
}

function formatTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 将本地 File 转为 data URL，便于复用 cacheImageLocally 之外的逻辑 */
async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function PsdTaskPanel() {
  const { message } = App.useApp();
  const tasks = usePsdTaskStore((s) => s.tasks);
  const creating = usePsdTaskStore((s) => s.creating);
  const createError = usePsdTaskStore((s) => s.createError);
  const upsertTask = usePsdTaskStore((s) => s.upsertTask);
  const patchTask = usePsdTaskStore((s) => s.patchTask);
  const removeTask = usePsdTaskStore((s) => s.removeTask);
  const clearAll = usePsdTaskStore((s) => s.clearAll);
  const setCreating = usePsdTaskStore((s) => s.setCreating);
  const setCreateError = usePsdTaskStore((s) => s.setCreateError);
  const pendingBase64Images = usePsdTaskStore((s) => s.pendingBase64Images);
  const pendingPrompt = usePsdTaskStore((s) => s.pendingPrompt);
  const consumePending = usePsdTaskStore((s) => s.consumePending);

  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<string[]>([]);

  // 挂载时消费"拆分为 PSD"预填内容
  const consumedRef = useRef(false);
  useEffect(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    const { images: pending, prompt: pendingP } = consumePending();
    if (pending.length > 0) setImages((prev) => [...pending, ...prev]);
    if (pendingP) setPrompt((prev) => (prev ? prev : pendingP));
  }, [consumePending]);

  // 同步外部 setPendingBase64Images / setPendingPrompt 调用
  useEffect(() => {
    if (pendingBase64Images.length > 0) {
      setImages((prev) => {
        const existing = new Set(prev);
        const next = [...prev];
        for (const url of pendingBase64Images) {
          if (!existing.has(url)) {
            next.push(url);
            existing.add(url);
          }
        }
        return next;
      });
      usePsdTaskStore.setState({ pendingBase64Images: [] });
    }
  }, [pendingBase64Images]);

  useEffect(() => {
    if (pendingPrompt) {
      setPrompt((prev) => (prev ? prev : pendingPrompt));
      usePsdTaskStore.setState({ pendingPrompt: "" });
    }
  }, [pendingPrompt]);

  const pendingIds = useMemo(
    () =>
      tasks
        .filter((t) => t.status === "queued" || t.status === "running")
        .map((t) => t.id)
        .filter(Boolean),
    [tasks]
  );

  // 轮询未完成任务
  useEffect(() => {
    if (pendingIds.length === 0) return;
    const ids = [...pendingIds];
    let cancelled = false;
    const { baseUrl, apiKey } = getEffectiveApiConfig();
    const poll = async () => {
      try {
        const resp = await queryEditableFileTasks(ids, { baseUrl, apiKey });
        if (cancelled) return;
        for (const item of resp.items) {
          upsertTask(item);
        }
        if (resp.missing_ids && resp.missing_ids.length > 0) {
          for (const missingId of resp.missing_ids) {
            patchTask(missingId, {
              status: "error",
              localError: "任务不存在或已被清理",
            });
          }
        }
      } catch (err) {
        // 静默：轮询失败不弹窗，下个 tick 再试
        if (import.meta.env.DEV) {
          console.warn("[psd] poll failed:", err);
        }
      }
    };
    void poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // 依赖 pendingIds.join：避免每轮 setTasks 触发 effect 重建（id 列表稳定即可）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingIds.join(","), upsertTask, patchTask]);

  async function handleAddFiles(files: FileList) {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    try {
      const dataUrls = await Promise.all(arr.map(fileToDataUrl));
      setImages((prev) => {
        const next = [...prev];
        const seen = new Set(next);
        for (const url of dataUrls) {
          if (!seen.has(url)) {
            next.push(url);
            seen.add(url);
          }
        }
        return next;
      });
    } catch {
      message.error("图片读取失败");
    }
  }

  function handleRemoveImage(idx: number) {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleCreate() {
    const trimmed = prompt.trim();
    if (!trimmed && images.length === 0) {
      message.warning("请输入提示词或上传参考图");
      return;
    }
    const { baseUrl, apiKey } = getEffectiveApiConfig();
    setCreateError(null);
    setCreating(true);
    try {
      const task = await createPsdTask(
        {
          prompt: trimmed,
          base64_images: images.length > 0 ? images : undefined,
          // 客户端幂等 ID：同一会话内重复点击不会被去重，但便于后端追踪
          client_task_id: `psd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        },
        { baseUrl, apiKey }
      );
      upsertTask(task, { origin: "user", promptSnapshot: trimmed });
      message.success("任务已创建");
      // 创建成功后保留提示词与图片，便于继续微调；用户可手动清空
    } catch (e) {
      const msg = String((e as Error).message) || "创建失败";
      setCreateError(msg);
      message.error(msg);
    } finally {
      setCreating(false);
    }
  }

  async function handleDownload(task: PsdTaskView, kind: "primary" | "zip") {
    const filePath = kind === "primary" ? task.result?.primary_url : task.result?.zip_url;
    if (!filePath) {
      message.warning("没有可下载的文件");
      return;
    }
    const { baseUrl, apiKey } = getEffectiveApiConfig();
    try {
      const blob = await downloadEditableFile(filePath, { baseUrl, apiKey });
      const ext = kind === "primary" ? "psd" : "zip";
      const baseName = task.promptSnapshot
        ? task.promptSnapshot.slice(0, 24).replace(/[^\w\u4e00-\u9fa5-]+/g, "_")
        : task.id.slice(0, 12);
      downloadBlob(blob, `${baseName || "psd-task"}.${ext}`);
    } catch (e) {
      message.error(String((e as Error).message) || "下载失败");
    }
  }

  async function handleRefreshOne(task: PsdTaskView) {
    const { baseUrl, apiKey } = getEffectiveApiConfig();
    try {
      const resp = await queryEditableFileTasks([task.id], { baseUrl, apiKey });
      if (resp.items.length > 0) {
        upsertTask(resp.items[0]);
        message.success("已刷新");
      } else if (resp.missing_ids?.includes(task.id)) {
        patchTask(task.id, { status: "error", localError: "任务不存在或已被清理" });
        message.warning("任务不存在");
      }
    } catch (e) {
      message.error(String((e as Error).message) || "刷新失败");
    }
  }

  return (
    <Row gutter={16}>
      <Col xs={24} lg={10} xl={9} xxl={8}>
        <Card
          style={{ background: "#18181b", borderColor: "#27272a" }}
          styles={{ body: { padding: 18 } }}
        >
          <div style={{ marginBottom: 12 }}>
            <Text style={{ color: "#a1a1aa", fontSize: 13 }}>
              PSD 任务
            </Text>
            <Paragraph style={{ color: "#71717a", fontSize: 12, marginTop: 4, marginBottom: 0 }}>
              输入主题、风格、页数等需求，可附参考图。后端生成完成后返回 PSD 主文件和素材 zip。
            </Paragraph>
          </div>

          {createError && (
            <Alert
              type="error"
              showIcon
              message={createError}
              style={{ marginBottom: 12, fontSize: 12 }}
              closable
              onClose={() => setCreateError(null)}
            />
          )}

          <Form layout="vertical">
            <Form.Item label="提示词">
              <TextArea
                rows={6}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="制作一份 8 页以内的季度业务汇报 PPT；或：将这张海报拆分为可编辑的 PSD 图层"
                style={{ resize: "vertical" }}
              />
            </Form.Item>

            <Form.Item label={`参考图（${images.length}）`}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <FileUploadTrigger
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  variant="dropzone"
                  label="上传参考图"
                  hint="点击或拖拽，PNG / JPEG / WebP，可多选"
                  icon={<InboxOutlined />}
                  onFiles={handleAddFiles}
                />
                {images.length > 0 && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
                      gap: 6,
                    }}
                  >
                    {images.map((url, idx) => (
                      <div
                        key={`${idx}-${url.slice(0, 32)}`}
                        style={{
                          position: "relative",
                          aspectRatio: "1 / 1",
                          borderRadius: 6,
                          overflow: "hidden",
                          border: "1px solid #27272a",
                          background: "#0a0a0a",
                        }}
                      >
                        <img
                          src={url}
                          alt={`参考图 ${idx + 1}`}
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                        <button
                          type="button"
                          onClick={() => handleRemoveImage(idx)}
                          aria-label="移除"
                          title="移除"
                          style={{
                            position: "absolute",
                            top: 2,
                            right: 2,
                            width: 18,
                            height: 18,
                            borderRadius: "50%",
                            border: "none",
                            background: "rgba(0,0,0,0.65)",
                            color: "#f4f4f5",
                            cursor: "pointer",
                            display: "grid",
                            placeItems: "center",
                            fontSize: 10,
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Form.Item>

            <Space style={{ width: "100%", justifyContent: "space-between" }}>
              <Button
                onClick={() => {
                  setPrompt("");
                  setImages([]);
                  setCreateError(null);
                }}
                disabled={creating || (prompt === "" && images.length === 0)}
              >
                清空
              </Button>
              <Button
                type="primary"
                loading={creating}
                onClick={handleCreate}
                style={{
                  background: "linear-gradient(135deg, #10b981 0%, #047857 100%)",
                  border: "none",
                  fontWeight: 600,
                  minWidth: 112,
                  boxShadow: creating
                    ? "0 0 0 1px rgba(16, 185, 129, 0.4), 0 6px 18px rgba(16, 185, 129, 0.28)"
                    : "0 8px 22px rgba(16, 185, 129, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.18)",
                  borderRadius: 8,
                }}
              >
                {creating ? "提交中" : "创建任务"}
              </Button>
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
              <Text style={{ color: "#a1a1aa" }}>任务列表（{tasks.length}）</Text>
              {tasks.length > 0 && (
                <Space size={8}>
                  <Tooltip title="刷新所有进行中任务">
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      onClick={() => {
                        const ids = tasks.map((t) => t.id).filter(Boolean);
                        if (ids.length === 0) return;
                        const { baseUrl, apiKey } = getEffectiveApiConfig();
                        queryEditableFileTasks(ids, { baseUrl, apiKey })
                          .then((resp) => {
                            for (const item of resp.items) upsertTask(item);
                            message.success("已同步");
                          })
                          .catch((e) => message.error(String((e as Error).message) || "同步失败"));
                      }}
                    >
                      同步
                    </Button>
                  </Tooltip>
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => {
                      clearAll();
                      message.info("已清空任务列表");
                    }}
                  >
                    清空
                  </Button>
                </Space>
              )}
            </div>
          }
        >
          {tasks.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span style={{ color: "#71717a", fontSize: 12 }}>
                  还没有 PSD 任务，先在左侧填写需求并创建
                </span>
              }
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {tasks.map((task) => {
                const meta = statusMeta(task.status);
                const hasPrimary = !!task.result?.primary_url;
                const hasZip = !!task.result?.zip_url;
                return (
                  <div
                    key={task.id}
                    style={{
                      border: "1px solid #27272a",
                      borderRadius: 10,
                      background: "#0f0f12",
                      padding: 12,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>
                        {meta.icon}
                        <span style={{ marginLeft: 4 }}>{meta.text}</span>
                      </Tag>
                      <Tag color={task.origin === "split" ? "purple" : "blue"} style={{ marginInlineEnd: 0 }}>
                        {task.origin === "split" ? "拆分派生" : "主动创建"}
                      </Tag>
                      <Tag style={{ marginInlineEnd: 0 }}>{task.kind || "psd"}</Tag>
                      <Text
                        style={{ color: "#52525b", fontSize: 11, marginLeft: "auto", fontFamily: "ui-monospace, monospace" }}
                        copyable={{ text: task.id }}
                      >
                        {task.id.slice(0, 12)}…
                      </Text>
                    </div>

                    <Text style={{ color: "#d4d4d8", fontSize: 13, whiteSpace: "pre-wrap" }}>
                      {task.promptSnapshot || "(未记录提示词)"}
                    </Text>

                    <div style={{ display: "flex", gap: 16, fontSize: 11, color: "#71717a" }}>
                      <span>创建：{formatTime(task.created_at)}</span>
                      <span>更新：{formatTime(task.updated_at)}</span>
                    </div>

                    {task.status === "error" && (task.error || task.localError) && (
                      <div
                        style={{
                          background: "rgba(239,68,68,0.08)",
                          border: "1px solid rgba(239,68,68,0.3)",
                          borderRadius: 6,
                          padding: "8px 10px",
                          fontSize: 12,
                          color: "#fca5a5",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {task.localError || task.error}
                      </div>
                    )}

                    {task.status === "success" && (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {hasPrimary && (
                          <Button
                            size="small"
                            type="primary"
                            icon={<DownloadOutlined />}
                            onClick={() => handleDownload(task, "primary")}
                          >
                            下载 PSD
                          </Button>
                        )}
                        {hasZip && (
                          <Button
                            size="small"
                            icon={<BlockOutlined />}
                            onClick={() => handleDownload(task, "zip")}
                          >
                            下载素材 ZIP
                          </Button>
                        )}
                        {task.result?.primary_url && (
                          <Tooltip title={buildEditableFileUrl(task.result.primary_url, { baseUrl: getEffectiveApiConfig().baseUrl })}>
                            <Button
                              size="small"
                              type="link"
                              icon={<FileImageOutlined />}
                              onClick={() => {
                                const { baseUrl } = getEffectiveApiConfig();
                                const url = buildEditableFileUrl(task.result!.primary_url!, { baseUrl });
                                // 直接打开（携带 token 不可能在浏览器地址栏，故仅在新标签打开公网链接）
                                if (url && /^https?:\/\//i.test(url)) {
                                  window.open(url, "_blank", "noopener,noreferrer");
                                } else {
                                  message.info("该文件需要授权下载，请使用下载按钮");
                                }
                              }}
                            >
                              在新标签打开
                            </Button>
                          </Tooltip>
                        )}
                      </div>
                    )}

                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <Button
                        size="small"
                        type="text"
                        icon={<ReloadOutlined />}
                        onClick={() => handleRefreshOne(task)}
                      >
                        刷新
                      </Button>
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => removeTask(task.id)}
                      >
                        移除
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </Col>
    </Row>
  );
}
