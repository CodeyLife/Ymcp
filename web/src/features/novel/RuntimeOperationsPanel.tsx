import { useMemo, useState } from "react";
import { Alert, App, Button, Input, Modal, Segmented, Skeleton, Tag } from "antd";
import { CheckOutlined, EditOutlined, FileTextOutlined, ReloadOutlined, SendOutlined, StopOutlined } from "@ant-design/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { queryClient } from "@/lib/queryClient";
import { getEffectiveApiConfig } from "@/stores/ui";
import { buildLegacyMigrationBundle } from "./legacy-runtime-migration";
import { NovelRuntimeHttpError, novelRuntimeClient } from "./runtime-client";
import { useNovelRuntimeEvents } from "./use-runtime-events";
import type { RuntimeChange } from "@/novel-runtime/contracts";
import "./runtime.css";

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

export default function RuntimeOperationsPanel({ projectId }: { projectId: string }) {
  const { message } = App.useApp();
  const [intentOpen, setIntentOpen] = useState<"plan" | "write" | "revise">();
  const [instruction, setInstruction] = useState("");
  const [target, setTarget] = useState("next");
  const [selectedChange, setSelectedChange] = useState<string>();
  const [revisionNote, setRevisionNote] = useState("");
  useNovelRuntimeEvents(projectId);
  const projectQuery = useQuery({ queryKey: ["novel-runtime", "project", projectId], queryFn: () => novelRuntimeClient.getProject(projectId), retry: false });
  const available = Boolean(projectQuery.data?.project);
  const needsMigration = projectQuery.error instanceof NovelRuntimeHttpError && projectQuery.error.code === "PROJECT_NOT_FOUND";
  const statusQuery = useQuery({ queryKey: ["novel-runtime", "status", projectId], queryFn: () => novelRuntimeClient.status(projectId), enabled: available, refetchInterval: 10_000 });
  const changeQuery = useQuery({ queryKey: ["novel-runtime", "change", selectedChange], queryFn: () => novelRuntimeClient.change(selectedChange!), enabled: Boolean(selectedChange) });
  const migrate = useMutation({
    mutationFn: async () => {
      const result = await novelRuntimeClient.migrate(await buildLegacyMigrationBundle([projectId]));
      const api = getEffectiveApiConfig();
      await novelRuntimeClient.updateApiConfig({ baseUrl: api.baseUrl, apiKey: api.apiKey, modelContextWindow: api.modelContextWindow });
      return result;
    },
    onSuccess: () => { message.success("项目已备份并迁移到统一小说运行时"); void queryClient.invalidateQueries({ queryKey: ["novel-runtime"] }); },
    onError: (error) => message.error(error instanceof Error ? error.message : "迁移失败"),
  });
  const enqueue = useMutation({
    mutationFn: () => novelRuntimeClient.enqueue({ projectId, kind: intentOpen!, instruction, target: intentOpen === "plan" ? undefined : target, driver: "human" }),
    onSuccess: () => { setIntentOpen(undefined); setInstruction(""); void queryClient.invalidateQueries({ queryKey: ["novel-runtime"] }); },
    onError: (error) => message.error(error instanceof Error ? error.message : "提交失败"),
  });
  const review = useMutation({
    mutationFn: ({ change, decision }: { change: RuntimeChange; decision: "accept" | "reject" | "revise" }) => novelRuntimeClient.review(change.id, { projectId, decision, note: revisionNote, actor: { type: "user", id: "novel-studio-author" } }),
    onSuccess: () => { setSelectedChange(undefined); setRevisionNote(""); void queryClient.invalidateQueries({ queryKey: ["novel-runtime"] }); },
    onError: (error) => message.error(error instanceof Error ? error.message : "审核失败"),
  });
  const documents = projectQuery.data?.documents ?? [];
  const status = statusQuery.data;
  const operationRows = useMemo(() => status?.operations ?? [], [status]);
  const selectedOwner = changeQuery.data ? operationRows.find((operation) => operation.id === changeQuery.data.change.operationId) : undefined;
  const userCanReview = selectedOwner?.driver === "human";

  if (projectQuery.isLoading) return <div className="novel-runtime-work"><Skeleton active /></div>;
  if (!available) return <div className="novel-runtime-work"><section className="novel-runtime-panel">{needsMigration ? <Alert type="info" showIcon message="启用统一小说运行时" description="生成、审核、修订和 MCP 将共同使用 SQLite 正式数据源。迁移前会创建完整归档，原 IndexedDB 保留用于人工回滚。" action={<Button type="primary" loading={migrate.isPending} onClick={() => migrate.mutate()}>备份并迁移当前项目</Button>} /> : <Alert type="error" showIcon message="小说运行时未连接" description="使用 npm run dev 同时启动本地 runtime 与网页，然后重试。" action={<Button onClick={() => void projectQuery.refetch()}>重试</Button>} />}</section></div>;

  return <div className="novel-runtime-work">
    <section className="novel-runtime-panel"><div className="novel-runtime-panel-title"><div><span>CREATION ENGINE</span><h2>统一创作任务</h2></div><div className="novel-runtime-actions"><Button icon={<FileTextOutlined />} onClick={() => { setIntentOpen("plan"); setInstruction("继续完善全书规划与章节安排"); }}>继续规划</Button><Button type="primary" icon={<SendOutlined />} onClick={() => { setIntentOpen("write"); setInstruction("根据已确认蓝图创作章节正文"); }}>写作章节</Button><Button type="text" icon={<ReloadOutlined />} onClick={() => void statusQuery.refetch()} /></div></div>
      {operationRows.length ? operationRows.map((operation) => <article key={operation.id} className="novel-runtime-operation"><Tag color={operation.status === "failed" ? "red" : operation.status === "awaiting_review" ? "gold" : "default"}>{STATUS_LABEL[operation.status]}</Tag><div><strong>{operation.kind === "plan" ? "小说规划" : operation.kind === "write" ? "章节写作" : "章节修订"}</strong><p>{String(operation.input.instruction ?? "")}</p><small>{operation.driver === "human" ? "用户审核" : "MCP 大模型审核"}</small>{operation.error && <Alert type="error" message={operation.error} />}</div><time>{new Date(operation.updatedAt).toLocaleString("zh-CN")}</time></article>) : <p className="novel-runtime-muted">还没有创作任务。</p>}
    </section>
    <section className="novel-runtime-panel"><div className="novel-runtime-panel-title"><div><span>REVIEW QUEUE</span><h2>待确认候选</h2></div></div>{status?.pendingChanges.length ? status.pendingChanges.map((change) => <button className="novel-runtime-change" key={change.id} onClick={() => setSelectedChange(change.id)}><div><strong>{change.title}</strong><p>{change.summary}</p><small>{change.evidence?.complete ? `产物完整 · 第 ${change.evidence.iteration + 1}/${change.evidence.maxIterations + 1} 轮` : "等待完整产物"}</small></div><Tag color="gold">待确认</Tag></button>) : <p className="novel-runtime-muted">当前没有需要确认的候选。</p>}</section>
    <Modal title={intentOpen === "plan" ? "继续规划" : intentOpen === "write" ? "写作章节" : "修订章节"} open={Boolean(intentOpen)} onCancel={() => setIntentOpen(undefined)} onOk={() => enqueue.mutate()} okText="提交到后台运行" confirmLoading={enqueue.isPending}><Input.TextArea rows={6} value={instruction} onChange={(event) => setInstruction(event.target.value)} />{intentOpen !== "plan" && <Segmented block value={target} onChange={(value) => setTarget(String(value))} options={[{ label: "下一章", value: "next" }, ...documents.map((document) => ({ label: String(document.title), value: String(document.id) }))]} />}</Modal>
    <Modal width={880} title={changeQuery.data?.change.title ?? "候选预览"} open={Boolean(selectedChange)} onCancel={() => setSelectedChange(undefined)} footer={changeQuery.data ? userCanReview ? <div className="novel-runtime-review-actions"><Input value={revisionNote} onChange={(event) => setRevisionNote(event.target.value)} placeholder="拒绝或重做时填写原因" /><Button danger icon={<StopOutlined />} onClick={() => review.mutate({ change: changeQuery.data.change, decision: "reject" })}>拒绝</Button><Button icon={<EditOutlined />} onClick={() => review.mutate({ change: changeQuery.data.change, decision: "revise" })}>重做</Button><Button type="primary" icon={<CheckOutlined />} onClick={() => review.mutate({ change: changeQuery.data.change, decision: "accept" })}>接受并写入</Button></div> : <Alert type="info" message="该候选由 MCP 大模型负责审核和推进，UI 仅提供只读检查。" /> : null}><div className="novel-runtime-preview">{changeQuery.isLoading ? <Skeleton active /> : <ReactMarkdown remarkPlugins={[remarkGfm]}>{artifactMarkdown(changeQuery.data?.artifact)}</ReactMarkdown>}</div></Modal>
  </div>;
}
