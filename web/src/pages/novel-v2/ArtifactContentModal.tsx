import { useEffect, useState } from "react";
import { Modal, Spin, Typography, Tag, Space, Empty } from "antd";
import { FileTextOutlined } from "@ant-design/icons";
import { artifactKindMeta, artifactPreview, relativeTime, shortId } from "./presentation";

/**
 * 产物内容查看器。
 *
 * 设计依据：AGENTS.md「Presentation Layer Semantic Translation」——
 * 用户反馈产物 ID 展示无用，应直接展示产物内容或提供按钮快速查看。
 *
 * 该组件负责：
 * 1. 调用 /v2/artifacts/:artifactId/content 拉取产物正文
 * 2. 用 artifactPreview 给出语义化摘要
 * 3. 在 Modal 中以可滚动正文形式展示，避免裸 ID/JSON 暴露
 */

export interface ArtifactSummary {
  id: string;
  kind: string;
  taskId?: string;
  fingerprint?: string;
  structuredData?: Record<string, unknown>;
  createdAt?: number;
}

export interface ArtifactContentModalProps {
  artifact: ArtifactSummary | null;
  open: boolean;
  onClose: () => void;
}

interface ArtifactContentResponse {
  text: string;
  kind: string;
  artifactId: string;
  wordCount: number;
}

async function fetchArtifactContent(artifactId: string): Promise<ArtifactContentResponse> {
  const response = await fetch(`/v2/artifacts/${encodeURIComponent(artifactId)}/content`);
  const body = await response.json();
  if (!response.ok) throw new Error((body as { error?: string }).error ?? "产物内容读取失败");
  return body as ArtifactContentResponse;
}

export default function ArtifactContentModal({ artifact, open, onClose }: ArtifactContentModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !artifact) {
      setContent(null);
      setErrorText(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrorText(null);
    setContent(null);
    fetchArtifactContent(artifact.id)
      .then((data) => {
        if (cancelled) return;
        setContent(data.text);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setErrorText(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, artifact?.id]);

  const kindMeta = artifact ? artifactKindMeta(artifact.kind) : { label: "产物", icon: <FileTextOutlined /> };
  const preview = artifact ? artifactPreview(artifact.kind, artifact.structuredData) : "";

  return (
    <Modal
      title={
        <Space size={8} align="center">
          <span className="novel-artifact-item-icon">{kindMeta.icon}</span>
          <span>{kindMeta.label}内容</span>
          {artifact && <Tag className="novel-event-item-cat">{kindMeta.label}</Tag>}
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={860}
      destroyOnHidden
      className="novel-artifact-modal"
    >
      {artifact && (
        <div className="novel-artifact-modal-meta">
          <div className="novel-artifact-modal-meta-line">
            <span className="novel-artifact-modal-meta-label">摘要</span>
            <span className="novel-artifact-modal-meta-value">{preview}</span>
          </div>
          <div className="novel-artifact-modal-meta-line">
            <span className="novel-artifact-modal-meta-label">来源任务</span>
            <code className="novel-artifact-modal-meta-mono">{shortId(artifact.taskId, 12)}</code>
          </div>
          {artifact.createdAt !== undefined && (
            <div className="novel-artifact-modal-meta-line">
              <span className="novel-artifact-modal-meta-label">生成时间</span>
              <span className="novel-artifact-modal-meta-value">{relativeTime(artifact.createdAt)}</span>
            </div>
          )}
        </div>
      )}

      <div className="novel-artifact-modal-body">
        {loading ? (
          <div className="novel-artifact-modal-loading">
            <Spin size="large" />
            <div className="novel-artifact-modal-loading-hint">正在从对象存储读取产物正文…</div>
          </div>
        ) : errorText ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div className="novel-artifact-modal-error">
                <div>{errorText}</div>
                <div className="novel-artifact-modal-error-hint">
                  该产物可能为结构化产物（如审核记录、上下文包），无正文内容可展示。
                </div>
              </div>
            }
          />
        ) : content !== null ? (
          <Typography.Paragraph className="novel-artifact-modal-text">
            {content}
          </Typography.Paragraph>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无内容" />
        )}
      </div>
    </Modal>
  );
}

/**
 * 产物卡片：展示语义化摘要 + 「查看内容」按钮。
 * 替代旧的 shortId + fingerprint 展示。
 */
export function ArtifactCard({
  artifact,
  onView,
}: {
  artifact: ArtifactSummary;
  onView: (artifact: ArtifactSummary) => void;
}) {
  const kindMeta = artifactKindMeta(artifact.kind);
  const preview = artifactPreview(artifact.kind, artifact.structuredData);
  return (
    <div className="novel-artifact-item">
      <div className="novel-artifact-item-header">
        <Space size={6} align="center">
          <span className="novel-artifact-item-icon">{kindMeta.icon}</span>
          <span className="novel-artifact-item-kind">{kindMeta.label}</span>
        </Space>
        <button
          type="button"
          className="novel-artifact-item-view-btn"
          onClick={() => onView(artifact)}
          aria-label={`查看 ${kindMeta.label} 内容`}
        >
          查看内容
        </button>
      </div>
      <div className="novel-artifact-item-summary">{preview}</div>
      {artifact.createdAt !== undefined && (
        <div className="novel-artifact-item-time">{relativeTime(artifact.createdAt)}</div>
      )}
    </div>
  );
}

// 导出 fetchArtifactContent 供外部直接调用（如错误提示场景）
export { fetchArtifactContent };
