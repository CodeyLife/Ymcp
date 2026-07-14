import { useState } from "react";
import { Badge, Button, Segmented, Tag } from "antd";
import { CheckCircleOutlined, ClockCircleOutlined, FileSearchOutlined, RightOutlined, RobotOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { novelDb } from "./db";
import type { ManuscriptDocument } from "./types";

export function MarkdownContent({ content }: { content: string }) {
  return <div className="novel-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>;
}

export type NovelAssistantScope = "dashboard" | "planning" | "writing" | "library" | "review" | "settings";

const PROPOSAL_STATUS_LABEL: Record<string, string> = {
  pending: "待审核",
  accepted: "已采纳",
  partially_accepted: "部分采纳",
  rejected: "已退回",
};

const AGENT_STATUS_LABEL: Record<string, string> = {
  pending: "等待中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
};

export default function AIWorkbench({ projectId, document, targetLabel, collapsed, onToggle }: { projectId: string; document?: ManuscriptDocument; scope: NovelAssistantScope; targetLabel?: string; collapsed: boolean; onToggle: () => void }) {
  const project = useLiveQuery(() => novelDb.projects.get(projectId), [projectId]);
  const proposals = useLiveQuery(() => novelDb.proposals.where("projectId").equals(projectId).reverse().sortBy("createdAt"), [projectId]) ?? [];
  const agents = useLiveQuery(() => novelDb.agentRuns.where("projectId").equals(projectId).reverse().sortBy("createdAt"), [projectId]) ?? [];
  const contexts = useLiveQuery(() => novelDb.contextPackets.where("projectId").equals(projectId).reverse().sortBy("createdAt"), [projectId]) ?? [];
  const pending = proposals.filter((item) => item.status === "pending").length;
  const [historyView, setHistoryView] = useState<"proposals" | "agents" | "contexts">("proposals");
  if (collapsed) return <button className="novel-ai-collapsed" aria-label="展开 AI 任务中心" title="展开 AI 任务中心" onClick={onToggle}><RobotOutlined /><span>AI</span>{pending > 0 && <Badge count={pending} size="small" />}</button>;
  return <aside className="novel-ai-panel novel-task-history">
    <header><div><span className="novel-ai-mark"><RobotOutlined /></span><div><strong>AI 任务中心</strong><small>{targetLabel || document?.title || "当前项目"} · {project?.settings.textModel}</small></div></div><Button type="text" icon={<RightOutlined />} aria-label="收起 AI 任务中心" title="收起 AI 任务中心" onClick={onToggle} /></header>
    <div className="novel-ai-view-switcher"><Segmented block value={historyView} onChange={(value) => setHistoryView(value as "proposals" | "agents" | "contexts")} options={[{ value: "proposals", label: `候选 ${pending}` }, { value: "agents", label: "模型任务" }, { value: "contexts", label: "上下文" }]} /></div>
    <section className={`novel-ai-history${historyView === "proposals" ? " active" : ""}`}><header><div><strong>候选历史</strong><small>优先处理待审核的结构化建议</small></div><Badge count={pending} showZero /></header>{proposals.slice(0, 12).map((proposal) => <article key={proposal.id}><div><Tag color={proposal.status === "pending" ? "gold" : proposal.status === "accepted" ? "green" : proposal.status === "partially_accepted" ? "blue" : undefined}>{PROPOSAL_STATUS_LABEL[proposal.status] ?? proposal.status}</Tag><time>{new Date(proposal.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></div><strong>{proposal.title}</strong><p>{proposal.items.length ? `${proposal.items.length} 个结构化候选项` : proposal.previewMarkdown.slice(0, 100)}</p></article>)}{!proposals.length && <p className="novel-ai-empty-copy">尚无候选记录</p>}</section>
    <section className={`novel-ai-history${historyView === "agents" ? " active" : ""}`}><header><div><strong>模型任务</strong><small>最近执行记录与用量</small></div></header>{agents.slice(0, 12).map((agent) => <article key={agent.id}><div><span className={`novel-agent-status ${agent.status}`}>{agent.status === "completed" ? <CheckCircleOutlined /> : <ClockCircleOutlined />}{AGENT_STATUS_LABEL[agent.status] ?? agent.status}</span><time>{new Date(agent.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></div><strong>{agent.goal}</strong><p>{agent.usage ? `${(agent.usage.inputTokens + agent.usage.outputTokens).toLocaleString()} tokens` : "等待用量统计"}</p></article>)}{!agents.length && <p className="novel-ai-empty-copy">尚无模型任务</p>}</section>
    <section className={`novel-ai-history novel-context-receipts${historyView === "contexts" ? " active" : ""}`}><header><div><strong>上下文回执</strong><small>模型实际读取与省略的资料</small></div></header>{contexts.slice(0, 10).map((packet) => <article key={packet.id}><div><Tag icon={<FileSearchOutlined />}>{packet.informationView?.mode === "character" ? "角色视角" : packet.informationView?.mode === "reader" ? "读者视角" : "作者视角"}</Tag><time>{new Date(packet.compiledAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></div><strong>{packet.task}</strong><p>{packet.estimatedTokens.toLocaleString()} / {packet.tokenBudget.toLocaleString()} tokens · {packet.sources.length} 项读取 · {packet.omittedSourceIds.length} 项省略</p><details><summary>查看资料明细</summary><div className="novel-context-receipt-detail"><section><b>已读取</b><ul>{packet.sources.map((item) => <li key={item.id}><Tag>{item.layer}</Tag><span>{item.title}</span><small>{item.estimatedTokens} tokens · {item.visibilityReason}</small></li>)}</ul></section>{packet.omissions?.length ? <section><b>已省略</b><ul>{packet.omissions.map((item) => <li key={item.sourceId}><Tag>{item.layer}</Tag><span>{item.title}</span><small>{item.estimatedTokens} tokens · {item.reason}</small></li>)}</ul></section> : null}</div></details></article>)}{!contexts.length && <p className="novel-ai-empty-copy">尚无上下文回执</p>}</section>
  </aside>;
}
