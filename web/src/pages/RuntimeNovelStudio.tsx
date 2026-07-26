import { useMemo, useState } from "react";
import { Alert, App, Button, Input, Modal, Segmented, Skeleton, Tag } from "antd";
import { ArrowLeftOutlined, CheckOutlined, EditOutlined, FileTextOutlined, ReloadOutlined, RobotOutlined, SendOutlined, StopOutlined } from "@ant-design/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useNavigate, useParams } from "react-router-dom";
import { queryClient } from "@/lib/queryClient";
import { novelRuntimeClient } from "@/features/novel/runtime-client";
import { useNovelRuntimeEvents } from "@/features/novel/use-runtime-events";
import type { RuntimeChange } from "@/novel-runtime/contracts";
import "@/features/novel/runtime.css";

function artifactMarkdown(artifact: unknown) {
  if (!artifact || typeof artifact !== "object") return "";
  const envelope = artifact as { value?: Record<string, unknown> };
  const value = envelope.value ?? artifact as Record<string, unknown>;
  if (typeof value.previewMarkdown === "string") return value.previewMarkdown;
  const manuscript = value.manuscript as Record<string, unknown> | undefined;
  if (typeof manuscript?.contentMarkdown === "string") return manuscript.contentMarkdown;
  if (typeof manuscript?.plainText === "string") return manuscript.plainText;
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

const STATUS_LABEL: Record<string, string> = { queued: "排队中", running: "执行中", awaiting_review: "待确认", completed: "已完成", failed: "失败", cancelled: "已取消" };

export default function RuntimeNovelStudio() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [intentOpen, setIntentOpen] = useState<"plan" | "write" | "revise">();
  const [driver, setDriver] = useState<"external-mcp" | "human">("external-mcp");
  const [instruction, setInstruction] = useState("");
  const [target, setTarget] = useState("next");
  const [selectedChange, setSelectedChange] = useState<string>();
  const [revisionNote, setRevisionNote] = useState("");
  useNovelRuntimeEvents(projectId);
  const projectQuery = useQuery({ queryKey: ["novel-runtime", "project", projectId], queryFn: () => novelRuntimeClient.getProject(projectId), enabled: Boolean(projectId) });
  const statusQuery = useQuery({ queryKey: ["novel-runtime", "status", projectId], queryFn: () => novelRuntimeClient.status(projectId), enabled: Boolean(projectId), refetchInterval: 10_000 });
  const changeQuery = useQuery({ queryKey: ["novel-runtime", "change", selectedChange], queryFn: () => novelRuntimeClient.change(selectedChange!), enabled: Boolean(selectedChange) });
  const enqueue = useMutation({ mutationFn: () => novelRuntimeClient.enqueue({ projectId, kind: intentOpen!, instruction, target: intentOpen === "plan" ? undefined : target, driver }), onSuccess: () => { setIntentOpen(undefined); setInstruction(""); void queryClient.invalidateQueries({ queryKey: ["novel-runtime"] }); }, onError: (error) => message.error(error instanceof Error ? error.message : "提交失败") });
  const review = useMutation({ mutationFn: ({ change, decision }: { change: RuntimeChange; decision: "accept" | "reject" | "revise" }) => novelRuntimeClient.review(change.id, { projectId, decision, note: revisionNote }), onSuccess: () => { setSelectedChange(undefined); setRevisionNote(""); void queryClient.invalidateQueries({ queryKey: ["novel-runtime"] }); }, onError: (error) => message.error(error instanceof Error ? error.message : "审核失败") });
  const project = projectQuery.data?.project;
  const documents = projectQuery.data?.documents ?? [];
  const status = statusQuery.data;
  const operationRows = useMemo(() => status?.operations ?? [], [status]);
  const humanPendingChanges = useMemo(() => (status?.pendingChanges ?? []).filter((change) => operationRows.find((operation) => operation.id === change.operationId)?.driver === "human"), [operationRows, status?.pendingChanges]);
  const mcpPendingChanges = useMemo(() => (status?.pendingChanges ?? []).filter((change) => operationRows.find((operation) => operation.id === change.operationId)?.driver === "external-mcp"), [operationRows, status?.pendingChanges]);

  if (projectQuery.isLoading) return <div className="novel-runtime-studio"><Skeleton active /></div>;
  if (projectQuery.error || !project) return <div className="novel-runtime-studio"><Alert type="error" message="无法读取本地小说项目" action={<Button onClick={() => navigate("/novel-runtime")}>返回运行时项目库</Button>} /></div>;
  return <div className="novel-runtime-studio">
    <header><Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate("/novel-runtime")} /><div><span>LOCAL RUNTIME WORKSPACE</span><h1>{String(project.title)}</h1><p>{String(project.premise)}</p></div><div className="novel-runtime-actions"><Button icon={<FileTextOutlined />} onClick={() => { setIntentOpen("plan"); setDriver("external-mcp"); setInstruction("继续完善全书规划与章节安排"); }}>继续规划</Button><Button type="primary" icon={<SendOutlined />} onClick={() => { setIntentOpen("write"); setDriver("external-mcp"); setInstruction("根据已确认蓝图创作章节正文"); }}>MCP 写作</Button></div></header>
    <main><aside><section><h2>章节</h2>{documents.length ? documents.map((document) => <button key={String(document.id)} onClick={() => { setTarget(String(document.id)); setIntentOpen("revise"); setInstruction(`修订《${String(document.title)}》`); }}><FileTextOutlined /><span><strong>{String(document.title)}</strong><small>{String(document.status)} · {Number(document.wordCount ?? 0).toLocaleString()} 字</small></span><EditOutlined /></button>) : <p>完成规划并确认章节安排后，这里会出现章节。</p>}</section></aside>
      <div className="novel-runtime-work"><section className="novel-runtime-panel"><div className="novel-runtime-panel-title"><div><span>OPERATIONS</span><h2>创作进度</h2></div><Button type="text" icon={<ReloadOutlined />} onClick={() => void statusQuery.refetch()} /></div>{operationRows.length ? operationRows.map((operation) => <article key={operation.id} className="novel-runtime-operation"><Tag color={operation.status === "failed" ? "red" : operation.status === "awaiting_review" ? "gold" : "default"}>{STATUS_LABEL[operation.status]}</Tag><div><strong>{operation.kind === "plan" ? "小说规划" : operation.kind === "write" ? "章节写作" : "章节修订"}</strong><p>{String(operation.input.instruction ?? "")}</p>{operation.error && <Alert type="error" message={operation.error} />}</div><time>{new Date(operation.updatedAt).toLocaleString("zh-CN")}</time></article>) : <p className="novel-runtime-muted">还没有创作任务。</p>}</section>
      <section className="novel-runtime-panel"><div className="novel-runtime-panel-title"><div><span>REVIEW QUEUE</span><h2>待人工确认候选</h2></div></div>{humanPendingChanges.length ? humanPendingChanges.map((change) => <button className="novel-runtime-change" key={change.id} onClick={() => setSelectedChange(change.id)}><div><strong>{change.title}</strong><p>{change.summary}</p></div><Tag color="gold">待确认</Tag></button>) : <p className="novel-runtime-muted">当前没有需要人工确认的候选。</p>}</section>{mcpPendingChanges.length ? <section className="novel-runtime-panel"><div className="novel-runtime-panel-title"><div><span>MCP LOOP</span><h2>MCP 托管候选</h2></div></div>{mcpPendingChanges.map((change) => <article className="novel-runtime-change is-managed" key={change.id}><div><strong>{change.title}</strong><p>{change.summary}</p><small>外部 LLM 通过 MCP 读取完整候选、审核、补丁/重生成并提交；浏览器仅显示状态。</small></div><Tag icon={<RobotOutlined />} color="blue">MCP 推进</Tag></article>)}</section> : null}</div>
    </main>
    <Modal title={intentOpen === "plan" ? "继续规划" : intentOpen === "write" ? "写作章节" : "修订章节"} open={Boolean(intentOpen)} onCancel={() => setIntentOpen(undefined)} onOk={() => enqueue.mutate()} okText={driver === "external-mcp" ? "提交给 MCP 编排器" : "提交给人工审核流程"} confirmLoading={enqueue.isPending}><Segmented block value={driver} onChange={(value) => setDriver(value as "external-mcp" | "human")} options={[{ label: "MCP 外部 LLM", value: "external-mcp" }, { label: "人工操作", value: "human" }]} /><Input.TextArea rows={6} value={instruction} onChange={(event) => setInstruction(event.target.value)} />{intentOpen !== "plan" && <Segmented block value={target} onChange={(value) => setTarget(String(value))} options={[{ label: "下一章", value: "next" }, ...documents.map((document) => ({ label: String(document.title), value: String(document.id) }))]} />}</Modal>
    <Modal width={880} title={changeQuery.data?.change.title ?? "候选预览"} open={Boolean(selectedChange)} onCancel={() => setSelectedChange(undefined)} footer={changeQuery.data ? <div className="novel-runtime-review-actions"><Input value={revisionNote} onChange={(event) => setRevisionNote(event.target.value)} placeholder="拒绝或重做时可填写原因" /><Button danger icon={<StopOutlined />} onClick={() => review.mutate({ change: changeQuery.data.change, decision: "reject" })}>拒绝</Button><Button icon={<EditOutlined />} onClick={() => review.mutate({ change: changeQuery.data.change, decision: "revise" })}>重做</Button><Button type="primary" icon={<CheckOutlined />} onClick={() => review.mutate({ change: changeQuery.data.change, decision: "accept" })}>接受并写入</Button></div> : null}><div className="novel-runtime-preview">{changeQuery.isLoading ? <Skeleton active /> : <ReactMarkdown remarkPlugins={[remarkGfm]}>{artifactMarkdown(changeQuery.data?.artifact)}</ReactMarkdown>}</div></Modal>
  </div>;
}
