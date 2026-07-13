import { Badge, Button, Progress, Tag } from "antd";
import { CheckCircleOutlined, ClockCircleOutlined, RobotOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { novelDb } from "./db";
import { PROJECT_GENERATION_STAGES } from "./generation";
import type { ManuscriptDocument } from "./types";

export function MarkdownContent({ content }: { content: string }) {
  return <div className="novel-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>;
}

export type NovelAssistantScope = "dashboard" | "planning" | "writing" | "library" | "review" | "settings";

export default function AIWorkbench({ projectId, document, targetLabel, collapsed, onToggle }: { projectId: string; document?: ManuscriptDocument; scope: NovelAssistantScope; targetLabel?: string; collapsed: boolean; onToggle: () => void }) {
  const project = useLiveQuery(() => novelDb.projects.get(projectId), [projectId]);
  const proposals = useLiveQuery(() => novelDb.proposals.where("projectId").equals(projectId).reverse().sortBy("createdAt"), [projectId]) ?? [];
  const agents = useLiveQuery(() => novelDb.agentRuns.where("projectId").equals(projectId).reverse().sortBy("createdAt"), [projectId]) ?? [];
  const projectRuns = useLiveQuery(() => novelDb.projectGenerationRuns.where("projectId").equals(projectId).reverse().sortBy("createdAt"), [projectId]) ?? [];
  const projectRun = projectRuns[0];
  const pending = proposals.filter((item) => item.status === "pending").length;
  if (collapsed) return <button className="novel-ai-collapsed" onClick={onToggle}><RobotOutlined /><span>AI</span>{pending > 0 && <Badge count={pending} size="small" />}</button>;
  return <aside className="novel-ai-panel novel-task-history">
    <header><div><RobotOutlined /><div><strong>AI 任务中心</strong><small>{targetLabel || document?.title || "当前项目"} · {project?.settings.textModel}</small></div></div><Button type="text" onClick={onToggle}>›</Button></header>
    {projectRun && <section className="novel-ai-run"><div><Tag color={projectRun.status === "failed" ? "red" : projectRun.status === "completed" ? "green" : "gold"}>{projectRun.status}</Tag><strong>全案生成</strong></div><Progress percent={Math.round(((projectRun.stageIndex + (projectRun.status === "completed" ? 1 : 0)) / PROJECT_GENERATION_STAGES.length) * 100)} showInfo={false} /><small>{projectRun.currentStage}{projectRun.error ? ` · ${projectRun.error}` : ""}</small></section>}
    <section className="novel-ai-history"><header><strong>候选历史</strong><Badge count={pending} showZero /></header>{proposals.slice(0, 8).map((proposal) => <article key={proposal.id}><div><Tag color={proposal.status === "pending" ? "gold" : proposal.status === "accepted" ? "green" : proposal.status === "partially_accepted" ? "blue" : undefined}>{proposal.status}</Tag><time>{new Date(proposal.createdAt).toLocaleTimeString("zh-CN")}</time></div><strong>{proposal.title}</strong><p>{proposal.items.length ? `${proposal.items.length} 个结构化候选项` : proposal.previewMarkdown.slice(0, 100)}</p></article>)}{!proposals.length && <p>尚无候选记录</p>}</section>
    <section className="novel-ai-history"><header><strong>模型任务</strong></header>{agents.slice(0, 8).map((agent) => <article key={agent.id}><div>{agent.status === "completed" ? <CheckCircleOutlined /> : <ClockCircleOutlined />}<time>{new Date(agent.createdAt).toLocaleTimeString("zh-CN")}</time></div><strong>{agent.goal}</strong><p>{agent.status}{agent.usage ? ` · ${agent.usage.inputTokens + agent.usage.outputTokens} tokens` : ""}</p></article>)}</section>
  </aside>;
}
