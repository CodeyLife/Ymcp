import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Empty, Input, List, Modal, Space, Tag, Typography, message } from "antd";
import { CopyOutlined, DownOutlined, FormatPainterOutlined, PlayCircleOutlined, ToolOutlined, HistoryOutlined, ApiOutlined } from "@ant-design/icons";
import { motion } from "motion/react";
import "../novel-v2.css";
import { buildToolArgumentSkeleton, DIRECT_EXEC_TOOLS, TOOL_COUNT, TOOL_DESCRIPTIONS, TOOL_GROUP_COUNT, TOOL_GROUPS, type ToolInfo } from "../../novel-v2/mcp/tool-metadata";

export interface McpToolGatewayPanelProps {
  // 无 props，MCP 工具面板是全局的
}

interface CallRecord {
  id: string;
  timestamp: number;
  toolName: string;
  status: "success" | "error";
  argsText: string;
  summary: string;
}

const HISTORY_KEY = "mcp-tool-history";

function loadHistory(): CallRecord[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveHistory(records: CallRecord[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(records.slice(0, 10)));
}

function buildMcpCommand(toolName: string, args: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args ?? {} } }, null, 2);
}

async function directExecute(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case "novel_project_create": {
      // 对齐 v1 一句话创意入口:premise 必填,idempotencyKey 作为 projectId
      // autoBootstrap/includeChapterPlan 透传给后端,默认 true
      const premise = String(args.premise ?? "");
      const idempotencyKey = String(args.idempotencyKey ?? "");
      if (!premise || !idempotencyKey) throw new Error("premise 和 idempotencyKey 必填");
      const payload: Record<string, unknown> = {
        premise,
        idempotencyKey,
        ...(typeof args.autoBootstrap === "boolean" ? { autoBootstrap: args.autoBootstrap } : {}),
        ...(typeof args.includeChapterPlan === "boolean" ? { includeChapterPlan: args.includeChapterPlan } : {}),
      };
      if (typeof args.title === "string" && args.title.trim()) payload.title = args.title.trim();
      if (typeof args.genre === "string" && args.genre.trim()) payload.genre = args.genre.trim();
      if (typeof args.objective === "string" && args.objective.trim()) payload.objective = args.objective.trim();
      const res = await fetch("/v2/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "V2 API 请求失败");
      return body;
    }
    case "novel_project_list": {
      const res = await fetch("/v2/projects");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "V2 API 请求失败");
      return body;
    }
    case "novel_run_create": {
      const projectId = String(args.projectId ?? "");
      if (!projectId) throw new Error("projectId 必填");
      const res = await fetch(`/v2/projects/${encodeURIComponent(projectId)}/creative-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "V2 API 请求失败");
      return body;
    }
    case "novel_chapter_review": {
      const projectId = String(args.projectId ?? "");
      const documentId = String(args.documentId ?? "");
      if (!projectId || !documentId) throw new Error("projectId 和 documentId 必填");
      const res = await fetch(`/v2/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "V2 API 请求失败");
      return body;
    }
    case "novel_closed_loop_run": {
      const projectId = String(args.projectId ?? "");
      if (!projectId) throw new Error("projectId 必填");
      const res = await fetch(`/v2/projects/${encodeURIComponent(projectId)}/closed-loop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "V2 API 请求失败");
      return body;
    }
    default:
      throw new Error(`工具 ${toolName} 不支持直接执行，请复制 MCP 调用命令后通过 MCP server 调用`);
  }
}

function summarizeResult(result: unknown): string {
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (typeof obj.workflowId === "string") return `workflowId=${obj.workflowId}`;
    if (Array.isArray(obj.projects)) return `${obj.projects.length} 个项目`;
    if (obj.project && typeof obj.project === "object") return `project=${(obj.project as { id?: string }).id ?? "?"}`;
  }
  return JSON.stringify(result).slice(0, 80);
}

function makeRecordId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function statusPill(status: "success" | "error"): string {
  return status === "success" ? "novel-status-pill novel-status-pill-done" : "novel-status-pill novel-status-pill-failed";
}

export default function McpToolGatewayPanel(_props: McpToolGatewayPanelProps) {
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [argsText, setArgsText] = useState<string>("{}");
  const [result, setResult] = useState<unknown>(null);
  const [resultExpanded, setResultExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<CallRecord[]>([]);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  const toolInfo = useMemo<ToolInfo | null>(() => (selectedTool ? TOOL_DESCRIPTIONS[selectedTool] ?? { short: selectedTool, full: selectedTool } : null), [selectedTool]);
  const canDirectExec = useMemo(() => (selectedTool ? DIRECT_EXEC_TOOLS.has(selectedTool) : false), [selectedTool]);
  const executableCount = useMemo(() => {
    let count = 0;
    TOOL_GROUPS.forEach((g) => g.tools.forEach((t) => { if (DIRECT_EXEC_TOOLS.has(t)) count++; }));
    return count;
  }, []);

  function openTool(toolName: string) {
    setSelectedTool(toolName);
    setResult(null);
    setError(null);
    setArgsText(JSON.stringify(buildToolArgumentSkeleton(toolName), null, 2));
  }

  function closeTool() {
    setSelectedTool(null);
    setArgsText("{}");
    setResult(null);
    setError(null);
  }

  function formatJson() {
    try {
      const parsed = JSON.parse(argsText);
      setArgsText(JSON.stringify(parsed, null, 2));
      setError(null);
    } catch (err) {
      setError(`JSON 格式化失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function copyMcpCommand() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsText);
    } catch (err) {
      setError(`参数不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    try {
      await navigator.clipboard.writeText(buildMcpCommand(selectedTool ?? "", parsed));
      message.success("已复制 MCP 调用命令到剪贴板");
    } catch (err) {
      setError(`复制失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function appendHistory(record: CallRecord) {
    const next = [record, ...history].slice(0, 10);
    setHistory(next);
    saveHistory(next);
  }

  async function execute() {
    if (!selectedTool) return;
    setLoading(true);
    setError(null);
    setResult(null);
    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(argsText) as Record<string, unknown>;
    } catch (err) {
      setError(`参数不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
      setLoading(false);
      return;
    }
    try {
      const res = await directExecute(selectedTool, parsedArgs);
      setResult(res);
      setResultExpanded(false);
      appendHistory({ id: makeRecordId(), timestamp: Date.now(), toolName: selectedTool, status: "success", argsText, summary: summarizeResult(res) });
      message.success("执行成功");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      appendHistory({ id: makeRecordId(), timestamp: Date.now(), toolName: selectedTool, status: "error", argsText, summary: msg });
      message.error("执行失败");
    } finally {
      setLoading(false);
    }
  }

  function reapplyFromHistory(record: CallRecord) {
    setSelectedTool(record.toolName);
    setArgsText(record.argsText);
    setResult(null);
    setError(null);
  }

  return (
    <div className="novel-mcp-page">
      {/* ===== EDITORIAL TOPBAR ===== */}
      <motion.header
        className="novel-topbar"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="novel-topbar-body" style={{ minWidth: 0 }}>
          <span className="novel-eyebrow">MCP 工具</span>
          <h2 className="novel-display-h2" style={{ marginTop: 2 }}>
            工具调用网关
          </h2>
          <p className="novel-lede" style={{ margin: "8px 0 0" }}>
            {TOOL_COUNT} 个工具按 {TOOL_GROUP_COUNT} 个分组组织。点击工具卡片打开参数弹窗；支持「复制 MCP 调用命令」与「执行（通过 API）」。历史调用记录持久化到 localStorage。
          </p>
        </div>
        <div className="novel-topbar-actions">
          <span className="novel-status-pill novel-status-pill-done">{TOOL_COUNT} 工具</span>
          <span className="novel-status-pill novel-status-pill-running">{executableCount} 可执行</span>
        </div>
      </motion.header>

      {/* ===== STATS BENTO ===== */}
      <motion.section
        className="novel-bento"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="novel-card-mini novel-bento-mini">
          <div className="novel-card-mini-label"><ToolOutlined /> 工具总数</div>
          <div className="novel-card-mini-value">{TOOL_COUNT}</div>
          <div className="novel-card-mini-hint">覆盖创作全流程</div>
        </div>
        <div className="novel-card-mini novel-bento-mini">
          <div className="novel-card-mini-label"><ApiOutlined /> 分组数</div>
          <div className="novel-card-mini-value">{TOOL_GROUP_COUNT}</div>
          <div className="novel-card-mini-hint">按域组织</div>
        </div>
        <div className="novel-card-mini novel-bento-mini">
          <div className="novel-card-mini-label"><PlayCircleOutlined /> 可直接执行</div>
          <div className="novel-card-mini-value">{executableCount}</div>
          <div className="novel-card-mini-hint">通过 API 调用</div>
        </div>
        <div className="novel-card-mini novel-bento-mini">
          <div className="novel-card-mini-label"><HistoryOutlined /> 历史记录</div>
          <div className="novel-card-mini-value">{history.length}</div>
          <div className="novel-card-mini-hint">最近 10 次（localStorage）</div>
        </div>
      </motion.section>

      {/* ===== TOOL GROUPS GRID ===== */}
      <motion.section
        className="novel-mcp-groups"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
      >
        {TOOL_GROUPS.map((group) => (
          <div key={group.key} className="novel-card-support novel-mcp-group-card">
            <div className="novel-card-head">
              <h3 className="novel-display-h3">{group.title}</h3>
              <span className="novel-card-mini-hint">{group.tools.length} 工具</span>
            </div>
            <div className="novel-mcp-tool-list">
              {group.tools.map((toolName) => {
                const info = TOOL_DESCRIPTIONS[toolName];
                const executable = DIRECT_EXEC_TOOLS.has(toolName);
                return (
                  <button
                    key={toolName}
                    className={`novel-mcp-tool-item ${selectedTool === toolName ? "is-active" : ""}`}
                    onClick={() => openTool(toolName)}
                    type="button"
                  >
                    <span className="novel-mcp-tool-name">{toolName}</span>
                    <span className="novel-mcp-tool-meta">
                      <Tag color={executable ? "green" : "default"}>{info?.short ?? toolName}</Tag>
                      {executable && <span className="novel-status-pill novel-status-pill-done">可执行</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </motion.section>

      {/* ===== HISTORY ===== */}
      <motion.section
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
      >
        <Card title={<Space><HistoryOutlined /><span>历史调用记录</span></Space>} className="novel-v2-card novel-eval-data-card" extra={<Tag>{history.length} / 10</Tag>}>
          {history.length === 0 ? (
            <Empty description="暂无调用记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <List
              size="small"
              dataSource={history}
              renderItem={(record) => (
                <List.Item actions={[<Button type="link" size="small" onClick={() => reapplyFromHistory(record)}>重新填入</Button>]}>
                  <List.Item.Meta
                    title={
                      <Space size={6}>
                        <span className={statusPill(record.status)}>{record.status}</span>
                        <Typography.Text code>{record.toolName}</Typography.Text>
                      </Space>
                    }
                    description={
                      <span>
                        {new Date(record.timestamp).toLocaleString("zh-CN")} · {record.summary}
                      </span>
                    }
                  />
                </List.Item>
              )}
            />
          )}
        </Card>
      </motion.section>

      <Modal
        title={selectedTool ? `工具调用：${selectedTool}` : "工具调用"}
        open={Boolean(selectedTool)}
        onCancel={closeTool}
        footer={null}
        destroyOnHidden
        width={720}
      >
        {toolInfo && (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Alert type="info" showIcon message={toolInfo.full} />
            <div>
              <Typography.Text className="novel-v2-section-label">参数（JSON）</Typography.Text>
              <Input.TextArea
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                autoSize={{ minRows: 6, maxRows: 16 }}
                style={{ fontFamily: "var(--font-mono)" }}
              />
            </div>
            <Space wrap>
              <Button icon={<FormatPainterOutlined />} onClick={formatJson}>格式化 JSON</Button>
              <Button icon={<CopyOutlined />} onClick={() => void copyMcpCommand()}>复制 MCP 调用命令</Button>
              {canDirectExec ? (
                <Button type="primary" icon={<PlayCircleOutlined />} loading={loading} onClick={() => void execute()}>执行（通过 API）</Button>
              ) : (
                <Typography.Text type="secondary">该工具仅支持复制 MCP 命令后通过 MCP server 调用</Typography.Text>
              )}
            </Space>
            {error && <Alert type="error" showIcon message={error} />}
            {result !== null && (
              <div>
                <div
                  className="novel-mcp-result-head"
                  onClick={() => setResultExpanded((v) => !v)}
                >
                  <Space size={6} align="center">
                    <DownOutlined className={`novel-event-item-toggle ${resultExpanded ? "is-open" : ""}`} />
                    <Typography.Text className="novel-v2-section-label">执行结果</Typography.Text>
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {summarizeResult(result)}
                  </Typography.Text>
                </div>
                {resultExpanded && (
                  <pre
                    style={{
                      maxHeight: 320,
                      overflow: "auto",
                      marginTop: 8,
                      padding: 12,
                      border: "1px solid rgba(63,63,70,0.62)",
                      borderRadius: 8,
                      background: "rgba(9,9,11,0.62)",
                      color: "#d4d4d8",
                      fontSize: 12,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {JSON.stringify(result, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </Space>
        )}
      </Modal>
    </div>
  );
}
