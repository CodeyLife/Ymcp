import { useRef, useState } from "react";
import { App, Badge, Button, Input, Modal, Segmented, Spin, Tag } from "antd";
import { CheckCircleOutlined, RobotOutlined, SearchOutlined, StopOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import { NOVEL_AI_ACTIONS, runNovelAI } from "./ai";
import { novelDb, saveDocument } from "./db";
import { recordPreferenceSignal } from "./preferences";
import type { AIProposal, ManuscriptDocument, NovelContextPacket } from "./types";

function countWords(text: string) {
  return (text.match(/[\u3400-\u9fff]|[a-zA-Z0-9]+/g) ?? []).length;
}

function toHtml(text: string) {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text.split(/\n{2,}/).map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, "<br>")}</p>`).join("");
}

export default function AIWorkbench({ projectId, document, collapsed, onToggle }: { projectId: string; document?: ManuscriptDocument; collapsed: boolean; onToggle: () => void }) {
  const { message } = App.useApp();
  const project = useLiveQuery(() => novelDb.projects.get(projectId), [projectId]);
  const latestProposal = useLiveQuery(() => novelDb.proposals.where("projectId").equals(projectId).reverse().sortBy("createdAt").then((items) => items[0]), [projectId]);
  const [action, setAction] = useState<(typeof NOVEL_AI_ACTIONS)[number]["key"]>("plan-next");
  const [instruction, setInstruction] = useState<string>(NOVEL_AI_ACTIONS[0].instruction);
  const [running, setRunning] = useState(false);
  const [stream, setStream] = useState("");
  const [packet, setPacket] = useState<NovelContextPacket>();
  const [contextOpen, setContextOpen] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);

  async function run() {
    setRunning(true); setStream("");
    abortRef.current = new AbortController();
    try {
      const result = await runNovelAI({ projectId, action, instruction, targetDocumentId: document?.id, signal: abortRef.current.signal, onToken: setStream });
      setPacket(result.packet); message.success("AI 提案已生成，尚未写入正式资料");
    } catch (error) { if (!abortRef.current.signal.aborted) message.error(error instanceof Error ? error.message : "生成失败"); }
    finally { setRunning(false); }
  }

  async function accept(proposal: AIProposal) {
    if (document && ["draft", "rewrite"].includes(proposal.operation)) {
      await saveDocument({ ...document, contentHtml: toHtml(proposal.previewMarkdown), plainText: proposal.previewMarkdown, wordCount: countWords(proposal.previewMarkdown), status: "draft" }, `采纳 AI 前 ${new Date().toLocaleString("zh-CN")}`);
    }
    await novelDb.proposals.update(proposal.id, { status: "accepted", updatedAt: Date.now(), revision: proposal.revision + 1 });
    await recordPreferenceSignal({ projectId, sourceType: "proposal-accepted", sourceId: proposal.id, category: proposal.operation, preference: `采纳单步工具：${proposal.title}`, evidence: proposal.previewMarkdown.slice(0, 300), weight: 0.5 });
    message.success(document && ["draft", "rewrite"].includes(proposal.operation) ? "已写入正文，并保留采纳前版本" : "提案已归档为采纳");
  }

  async function reject(proposal: AIProposal) {
    await novelDb.proposals.update(proposal.id, { status: "rejected", updatedAt: Date.now(), revision: proposal.revision + 1 });
    await recordPreferenceSignal({ projectId, sourceType: "proposal-rejected", sourceId: proposal.id, category: proposal.operation, preference: `避免该单步结果：${proposal.title}`, evidence: proposal.previewMarkdown.slice(0, 300), weight: -0.5 });
  }

  if (collapsed) return <button className="novel-ai-collapsed" onClick={onToggle}><RobotOutlined /><span>AI</span>{latestProposal?.status === "pending" && <Badge status="processing" />}</button>;
  return <aside className="novel-ai-panel">
    <header><div><RobotOutlined /><div><strong>AI 编辑室</strong><small>{project?.settings.textModel}</small></div></div><Button type="text" onClick={onToggle}>›</Button></header>
    <div className="novel-ai-controls"><Segmented block value={action} onChange={(value) => { const item = NOVEL_AI_ACTIONS.find((candidate) => candidate.key === value)!; setAction(item.key); setInstruction(item.instruction); }} options={NOVEL_AI_ACTIONS.map((item) => ({ label: item.label, value: item.key }))} /><Input.TextArea rows={5} value={instruction} onChange={(event) => setInstruction(event.target.value)} /><div><Button icon={<SearchOutlined />} onClick={() => setContextOpen(true)} disabled={!packet}>查看上下文</Button>{running ? <Button danger icon={<StopOutlined />} onClick={() => abortRef.current?.abort()}>停止</Button> : <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => void run()}>生成提案</Button>}</div></div>
    {running && <div className="novel-ai-stream"><Spin size="small" /><span>智能体正在工作</span><pre>{stream || "正在冻结分层上下文……"}</pre></div>}
    {!running && latestProposal && <div className="novel-proposal"><div><Tag color={latestProposal.status === "pending" ? "gold" : latestProposal.status === "accepted" ? "green" : undefined}>{latestProposal.status === "pending" ? "待审阅" : latestProposal.status === "accepted" ? "已采纳" : "已放弃"}</Tag><small>{new Date(latestProposal.createdAt).toLocaleTimeString("zh-CN")}</small></div><h3>{latestProposal.title}</h3><pre>{latestProposal.previewMarkdown}</pre>{latestProposal.status === "pending" && <footer><Button onClick={() => void reject(latestProposal)}>放弃</Button><Button type="primary" icon={<CheckCircleOutlined />} onClick={() => void accept(latestProposal)}>采纳提案</Button></footer>}</div>}
    {!latestProposal && !running && <div className="novel-ai-empty"><RobotOutlined /><strong>从一个单步编辑任务开始</strong><p>完整章节生产请使用“创作流程”；这里保留可组合的单步工具。</p></div>}
    <Modal title="本次 AI 上下文" width={800} open={contextOpen} onCancel={() => setContextOpen(false)} footer={null}>{packet && <div className="novel-context-list"><div><strong>{packet.estimatedTokens.toLocaleString()}</strong> / {packet.tokenBudget.toLocaleString()} tokens · 省略 {packet.omittedSourceIds.length} 项 · {packet.skillRefs.length} Skills</div>{packet.skillRefs.length > 0 && <p>{packet.skillRefs.map((skill) => `${skill.name} ${skill.version}`).join(" · ")}</p>}{packet.sources.map((source) => <article key={`${source.kind}-${source.id}`}><header><Tag>{source.kind}</Tag><strong>{source.title}</strong><span>{source.priorityClass} · 权重 {source.weight}</span>{source.pinned && <Tag color="gold">固定</Tag>}</header><small>{source.reason} · {source.contentHash}</small><p>{source.content.slice(0, 600)}</p></article>)}</div>}</Modal>
  </aside>;
}
