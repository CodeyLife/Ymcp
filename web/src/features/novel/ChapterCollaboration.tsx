import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Empty, Input, InputNumber, Select, Spin, Tag, Tooltip } from "antd";
import { CheckOutlined, EyeInvisibleOutlined, PushpinOutlined, SendOutlined, UndoOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import { MarkdownContent } from "./AIWorkbench";
import { novelDb } from "./db";
import { novelMemoryService } from "./memory-service";
import type { CreativeBrief, ManuscriptDocument, NovelConversationThread, NovelRetrievalRun } from "./types";

function lines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function text(values: string[]) {
  return values.join("\n");
}

export default function ChapterCollaboration({ projectId, document, onStateChange }: { projectId: string; document: ManuscriptDocument; onStateChange?: (thread?: NovelConversationThread, brief?: CreativeBrief) => void }) {
  const { message } = App.useApp();
  const [threadId, setThreadId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [savingBrief, setSavingBrief] = useState(false);
  const [briefDraft, setBriefDraft] = useState<CreativeBrief>();
  const activeDocumentIdRef = useRef(document.id);
  activeDocumentIdRef.current = document.id;
  const thread = useLiveQuery(() => threadId ? novelDb.conversationThreads.get(threadId) : undefined, [threadId]);
  const messages = useLiveQuery(() => threadId ? novelDb.conversationMessages.where("threadId").equals(threadId).sortBy("createdAt") : [], [threadId]) ?? [];
  const briefs = useLiveQuery(() => threadId ? novelDb.creativeBriefs.where("threadId").equals(threadId).reverse().sortBy("updatedAt") : [], [threadId]) ?? [];
  const brief = briefs.find((item) => item.status !== "superseded");
  const memories = useLiveQuery(() => novelDb.conversationMemories.where("projectId").equals(projectId).and((item) => item.status === "active").reverse().sortBy("updatedAt"), [projectId]) ?? [];
  const entities = useLiveQuery(() => novelDb.entities.where("[projectId+kind]").equals([projectId, "character"]).toArray(), [projectId]) ?? [];

  useEffect(() => {
    let live = true;
    setThreadId(undefined);
    setBriefDraft(undefined);
    setDraft("");
    setSending(false);
    setSavingBrief(false);
    onStateChange?.();
    void novelMemoryService.getOrCreateThread({ projectId, targetDocumentId: document.id }).then(async (created) => {
      if (!live) return;
      setThreadId(created.id);
      await novelMemoryService.getDraftBrief(created.id);
    }).catch((error) => message.error(error instanceof Error ? error.message : "协作对话初始化失败"));
    return () => { live = false; };
  }, [document.id, projectId]);

  useEffect(() => { setBriefDraft(brief ? { ...brief } : undefined); }, [brief?.id, brief?.updatedAt]);
  useEffect(() => {
    const ready = thread?.targetId === document.id && brief?.targetDocumentId === document.id;
    onStateChange?.(ready ? thread : undefined, ready ? brief : undefined);
  }, [brief, document.id, onStateChange, thread]);

  const sourceRuns = useLiveQuery(async (): Promise<Map<string, NovelRetrievalRun>> => {
    const ids = messages.map((item) => item.retrievalRunId).filter((id): id is string => Boolean(id));
    const runs = await novelDb.retrievalRuns.bulkGet(ids);
    return new Map(runs.filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => [item.id, item]));
  }, [messages.map((item) => item.retrievalRunId).join("|")]) ?? new Map<string, NovelRetrievalRun>();

  const confirmed = brief?.status === "confirmed";
  const unresolved = briefDraft?.openQuestions.length ?? 0;
  const canSend = Boolean(threadId && thread?.targetId === document.id && draft.trim() && !sending);
  const recentMemories = useMemo(() => memories.slice(0, 6), [memories]);

  async function send() {
    if (!threadId || thread?.targetId !== document.id || !draft.trim()) return;
    const targetDocumentId = document.id;
    const content = draft.trim();
    setDraft("");
    setSending(true);
    try { await novelMemoryService.runConversationTurn({ threadId, content }); }
    catch (error) {
      if (activeDocumentIdRef.current === targetDocumentId) setDraft(content);
      message.error(error instanceof Error ? error.message : "协作对话失败");
    }
    finally { setSending(false); }
  }

  async function saveBrief(confirm = false) {
    if (!briefDraft || briefDraft.targetDocumentId !== document.id) return;
    setSavingBrief(true);
    try {
      const saved = await novelMemoryService.updateBrief(briefDraft.id, {
        goal: briefDraft.goal, povCharacterId: briefDraft.povCharacterId, factCutoffOrder: briefDraft.factCutoffOrder,
        tone: briefDraft.tone, languageRequirements: briefDraft.languageRequirements, mustHappen: briefDraft.mustHappen,
        forbidden: briefDraft.forbidden, targetWords: briefDraft.targetWords, referencedMemoryIds: briefDraft.referencedMemoryIds, openQuestions: briefDraft.openQuestions,
      });
      if (confirm) {
        await novelMemoryService.confirmBrief(saved.id);
        message.success("创作简报已确认");
      } else message.success("创作简报已保存");
    } catch (error) { message.error(error instanceof Error ? error.message : "简报保存失败"); }
    finally { setSavingBrief(false); }
  }

  async function sourceOverride(sourceId: string, mode: "pin" | "exclude" | "clear") {
    if (!threadId || thread?.targetId !== document.id) return;
    await novelMemoryService.setSourceOverride(threadId, sourceId, mode);
  }

  return <div className="novel-collaboration-shell">
    <section className="novel-collaboration-dialogue">
      <header><div><span>CHAPTER SESSION</span><h3>创作协作</h3></div>{thread && <Tag>{messages.length} 轮记录</Tag>}</header>
      <div className="novel-collaboration-messages">
        {!messages.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有本章协作记录" />}
        {messages.map((item) => {
          const run = item.retrievalRunId ? sourceRuns.get(item.retrievalRunId) : undefined;
          const hits = run?.hits.filter((hit) => run.selectedSourceIds.includes(hit.sourceId)) ?? [];
          return <article key={item.id} className={`novel-collaboration-message ${item.role}`}>
            <div className="novel-collaboration-message-meta"><strong>{item.role === "user" ? "作者" : "协作编辑"}</strong><time>{new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></div>
            {item.role === "assistant" ? <MarkdownContent content={item.content} /> : <p>{item.content}</p>}
            {hits.length > 0 && <details className="novel-retrieval-receipt"><summary>引用 {hits.length} 项资料 · {run?.rounds.length ?? 1} 轮检索</summary><div>{hits.map((hit) => {
              const pinned = thread?.pinnedSourceIds.includes(hit.sourceId);
              const excluded = thread?.excludedSourceIds.includes(hit.sourceId);
              return <section key={hit.sourceId}><div><Tag>{hit.kind}</Tag><strong>{hit.title}</strong><span>{Math.round(hit.fusedScore * 1000) / 1000}</span></div><p>{hit.content.slice(0, 220)}</p><small>{hit.reason} · 证据 {hit.evidenceRefs.join("、") || hit.sourceId}</small><footer><Tooltip title={pinned ? "取消固定" : "固定到后续上下文"}><Button type="text" size="small" icon={<PushpinOutlined />} className={pinned ? "active" : ""} onClick={() => void sourceOverride(hit.sourceId, pinned ? "clear" : "pin")} /></Tooltip><Tooltip title={excluded ? "取消排除" : "从后续检索排除"}><Button type="text" size="small" icon={<EyeInvisibleOutlined />} danger={excluded} onClick={() => void sourceOverride(hit.sourceId, excluded ? "clear" : "exclude")} /></Tooltip></footer></section>;
            })}</div></details>}
          </article>;
        })}
        {sending && <div className="novel-collaboration-thinking"><Spin size="small" /><span>正在检索并整理本轮资料</span></div>}
      </div>
      <div className="novel-collaboration-composer"><Input.TextArea value={draft} onChange={(event) => setDraft(event.target.value)} autoSize={{ minRows: 2, maxRows: 6 }} placeholder="补充本章目标、人物状态、节奏或语言要求" onPressEnter={(event) => { if (!event.shiftKey) { event.preventDefault(); if (canSend) void send(); } }} /><Button type="primary" icon={<SendOutlined />} disabled={!canSend} loading={sending} aria-label="发送" title="发送" onClick={() => void send()} /></div>
      {recentMemories.length > 0 && <div className="novel-active-memories"><header><strong>已生效偏好</strong><span>{recentMemories.length}</span></header>{recentMemories.map((memory) => <div key={memory.id}><span>{memory.content}</span><Tooltip title="撤销这条偏好"><Button type="text" size="small" icon={<UndoOutlined />} onClick={() => void novelMemoryService.revokeMemory(memory.id)} /></Tooltip></div>)}</div>}
    </section>

    <section className={`novel-creative-brief${confirmed ? " confirmed" : ""}`}>
      <header><div><span>CREATIVE BRIEF</span><h3>本次创作简报</h3></div><Tag color={confirmed ? "green" : "gold"}>{confirmed ? "已确认" : "草稿"}</Tag></header>
      {!briefDraft ? <Spin /> : <div className="novel-brief-fields">
        <label>创作目标<Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} value={briefDraft.goal} onChange={(event) => setBriefDraft({ ...briefDraft, goal: event.target.value })} /></label>
        <div className="novel-brief-grid"><label>POV<Select allowClear value={briefDraft.povCharacterId} options={entities.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => setBriefDraft({ ...briefDraft, povCharacterId: value })} /></label><label>目标字数<InputNumber min={100} max={50000} value={briefDraft.targetWords} onChange={(value) => setBriefDraft({ ...briefDraft, targetWords: value ?? 5000 })} /></label></div>
        <label>基调<Input value={briefDraft.tone} onChange={(event) => setBriefDraft({ ...briefDraft, tone: event.target.value })} placeholder="沿用项目基调" /></label>
        <label>语言要求<Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} value={text(briefDraft.languageRequirements)} onChange={(event) => setBriefDraft({ ...briefDraft, languageRequirements: lines(event.target.value) })} placeholder="每行一项" /></label>
        <label className="must">必写事项<Input.TextArea autoSize={{ minRows: 3, maxRows: 7 }} value={text(briefDraft.mustHappen)} onChange={(event) => setBriefDraft({ ...briefDraft, mustHappen: lines(event.target.value) })} placeholder="每行一项" /></label>
        <label className="forbidden">禁写事项<Input.TextArea autoSize={{ minRows: 3, maxRows: 7 }} value={text(briefDraft.forbidden)} onChange={(event) => setBriefDraft({ ...briefDraft, forbidden: lines(event.target.value) })} placeholder="每行一项" /></label>
        <label>未决问题<Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} value={text(briefDraft.openQuestions)} onChange={(event) => setBriefDraft({ ...briefDraft, openQuestions: lines(event.target.value) })} placeholder="清空后才能确认" /></label>
        <footer><Button loading={savingBrief} onClick={() => void saveBrief(false)}>保存</Button><Button type="primary" icon={<CheckOutlined />} loading={savingBrief} disabled={!briefDraft.goal.trim() || unresolved > 0} onClick={() => void saveBrief(true)}>{confirmed ? "重新确认" : "确认简报"}</Button></footer>
      </div>}
    </section>
  </div>;
}
