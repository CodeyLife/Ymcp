import { useMemo, useState } from "react";
import { Alert, App, Button, Input, Modal, Segmented, Skeleton, Tag } from "antd";
import { CheckOutlined, EditOutlined, FileTextOutlined, NodeIndexOutlined, ReloadOutlined, RobotOutlined, SendOutlined, StopOutlined } from "@ant-design/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSearchParams } from "react-router-dom";
import { queryClient } from "@/lib/queryClient";
import { getEffectiveApiConfig } from "@/stores/ui";
import { buildLegacyMigrationBundle } from "./legacy-runtime-migration";
import { isArchitectureOperation, NovelRuntimeHttpError, novelRuntimeClient } from "./runtime-client";
import { useNovelRuntimeEvents } from "./use-runtime-events";
import type { RuntimeChange } from "@/novel-runtime/contracts";
import type { ManuscriptDocument } from "./types";
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

export interface RuntimeOperationsPanelProps {
  projectId: string;
  document?: ManuscriptDocument;
  compact?: boolean;
}

export default function RuntimeOperationsPanel({ projectId, document, compact = false }: RuntimeOperationsPanelProps) {
  const { message } = App.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const [intentOpen, setIntentOpen] = useState<"plan" | "write" | "revise">();
  const [driver, setDriver] = useState<"external-mcp" | "human">("external-mcp");
  const [instruction, setInstruction] = useState("");
  const [target, setTarget] = useState(document?.id ?? "next");
  // plan 类 operation 的子任务类别，标识本次规划目标（架构/角色/世界观数据等）。
  // taskKey 同时是 UI 识别"全书架构候选"并跳转结构化审阅的依据，缺失会导致候选无法被正确分类。
  const [planTaskKey, setPlanTaskKey] = useState<"project-positioning" | "architecture" | "story-bible" | "characters" | "relations" | "worldview">("architecture");
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
    mutationFn: () => novelRuntimeClient.enqueue({ projectId, kind: intentOpen!, instruction, target: intentOpen === "plan" ? undefined : document?.id ?? target, taskKey: intentOpen === "plan" ? planTaskKey : undefined, driver }),
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
  // operationRows 保留全部 operations（含历史），用于 pendingChanges 的 owner 匹配（owner 可能是任意状态）。
  const operationRows = useMemo(() => status?.operations ?? [], [status]);
  // CREATION ENGINE 只显示活跃任务（queued/running/awaiting_review），不显示 completed/failed/cancelled 历史，
  // 避免历史堆积让用户误以为是"待审核候选"。
  const activeOperationRows = useMemo(() => status?.activeOperations ?? [], [status]);
  const operationMatchesDocument = (operation: (typeof operationRows)[number]) => !compact || !document || (operation.kind !== "plan" && (operation.input.target === document.id || operation.input.target === document.title));
  const visibleOperations = useMemo(() => activeOperationRows.filter(operationMatchesDocument), [compact, document, activeOperationRows]);
  const visiblePendingChanges = useMemo(() => (status?.pendingChanges ?? []).filter((change) => {
    const owner = operationRows.find((operation) => operation.id === change.operationId);
    return owner ? operationMatchesDocument(owner) : !compact;
  }), [compact, document, operationRows, status?.pendingChanges]);
  const visibleHumanPendingChanges = useMemo(() => visiblePendingChanges.filter((change) => operationRows.find((operation) => operation.id === change.operationId)?.driver === "human"), [operationRows, visiblePendingChanges]);
  const visibleMcpPendingChanges = useMemo(() => visiblePendingChanges.filter((change) => operationRows.find((operation) => operation.id === change.operationId)?.driver === "external-mcp"), [operationRows, visiblePendingChanges]);
  const selectedOwner = changeQuery.data ? operationRows.find((operation) => operation.id === changeQuery.data.change.operationId) : undefined;
  const userCanReview = selectedOwner?.driver === "human";

  if (projectQuery.isLoading) return <div className="novel-runtime-work"><Skeleton active /></div>;
  if (!available) return <div className="novel-runtime-work"><section className="novel-runtime-panel">{needsMigration ? <Alert type="info" showIcon message="启用统一小说运行时" description="生成、审核、修订和 MCP 将共同使用 SQLite 正式数据源。迁移前会创建完整归档，原 IndexedDB 保留用于人工回滚。" action={<Button type="primary" loading={migrate.isPending} onClick={() => migrate.mutate()}>备份并迁移当前项目</Button>} /> : <Alert type="error" showIcon message="小说运行时未连接" description="使用 npm run dev 同时启动本地 runtime 与网页，然后重试。" action={<Button onClick={() => void projectQuery.refetch()}>重试</Button>} />}</section></div>;

  return <div className="novel-runtime-work">
    <section className="novel-runtime-panel"><div className="novel-runtime-panel-title"><div><span>CREATION ENGINE</span><h2>{compact ? "统一章节流程" : "统一创作任务"}</h2></div><div className="novel-runtime-actions">{!compact && <Button icon={<FileTextOutlined />} onClick={() => { setIntentOpen("plan"); setDriver("external-mcp"); setInstruction("继续完善全书规划与章节安排"); }}>继续规划</Button>}<Button type="primary" icon={<SendOutlined />} disabled={compact && !document} onClick={() => { setIntentOpen("write"); setDriver("external-mcp"); setTarget(document?.id ?? "next"); setInstruction(document ? `根据《${document.title}》已确认蓝图创作章节正文` : "根据已确认蓝图创作章节正文"); }}>MCP 写作</Button><Button icon={<EditOutlined />} disabled={compact && !document} onClick={() => { setIntentOpen("revise"); setDriver("external-mcp"); setTarget(document?.id ?? "next"); setInstruction(document ? `由外部 LLM 审核并改进《${document.title}》正文` : "由外部 LLM 审核并改进章节正文"); }}>MCP 审校</Button><Button type="text" icon={<ReloadOutlined />} onClick={() => void statusQuery.refetch()} /></div></div>
      {visibleOperations.length ? visibleOperations.map((operation) => <article key={operation.id} className="novel-runtime-operation"><Tag color={operation.status === "failed" ? "red" : operation.status === "awaiting_review" ? "gold" : "default"}>{STATUS_LABEL[operation.status]}</Tag><div><strong>{operation.kind === "plan" ? "小说规划" : operation.kind === "write" ? "章节写作" : "章节修订"}</strong><p>{String(operation.input.instruction ?? "")}</p><small>{operation.driver === "human" ? "人工审核同一流程" : "外部 LLM 通过 MCP 审核、修订与提交"}</small>{operation.error && <Alert type="error" message={operation.error} />}</div><time>{new Date(operation.updatedAt).toLocaleString("zh-CN")}</time></article>) : <p className="novel-runtime-muted">还没有创作任务。</p>}
    </section>
    <section className="novel-runtime-panel"><div className="novel-runtime-panel-title"><div><span>REVIEW QUEUE</span><h2>待人工确认候选</h2></div></div>{visibleHumanPendingChanges.length ? visibleHumanPendingChanges.map((change) => {
      const owner = operationRows.find((operation) => operation.id === change.operationId);
      const archCandidate = isArchitectureOperation(owner);
      const openChange = () => {
        if (archCandidate) {
          // 全书架构类候选：跳转到全书架构板块结构化审阅（ArchitectureDataEditor + compareTo）
          // 合并写入 view/changeId，保留 document 等已有 URL 参数
          const next = new URLSearchParams(searchParams);
          next.set("view", "planning");
          next.set("changeId", change.id);
          setSearchParams(next);
        } else {
          setSelectedChange(change.id);
        }
      };
      return <button className="novel-runtime-change" key={change.id} onClick={openChange}><div><strong>{change.title}</strong><p>{change.summary}</p><small>{change.evidence?.complete ? `产物完整 · 第 ${change.evidence.iteration + 1}/${change.evidence.maxIterations === null ? "持续" : change.evidence.maxIterations + 1} 轮` : "等待完整产物"}</small>{archCandidate && <small className="novel-runtime-change-arch"><NodeIndexOutlined /> 全书架构候选 · 点击进入结构化审阅</small>}</div><Tag color="gold">待确认</Tag></button>;
    }) : <p className="novel-runtime-muted">当前没有需要人工确认的候选。</p>}</section>
    {visibleMcpPendingChanges.length ? <section className="novel-runtime-panel"><div className="novel-runtime-panel-title"><div><span>MCP LOOP</span><h2>MCP 托管候选</h2></div></div>{visibleMcpPendingChanges.map((change) => <article className="novel-runtime-change is-managed" key={change.id}><div><strong>{change.title}</strong><p>{change.summary}</p><small>{change.evidence?.complete ? `内部校验${change.evidence.internalGate?.passed ? "已通过" : "待修复"} · 第 ${change.evidence.iteration + 1}/持续 轮` : "等待完整产物"}；外部 LLM 需通过 MCP 读取完整候选、审核、补丁/重生成并提交。</small></div><Tag icon={<RobotOutlined />} color="blue">MCP 推进</Tag></article>)}</section> : null}
    <Modal title={intentOpen === "plan" ? "继续规划" : intentOpen === "write" ? "写作章节" : "审校/修订章节"} open={Boolean(intentOpen)} onCancel={() => setIntentOpen(undefined)} onOk={() => enqueue.mutate()} okText={driver === "external-mcp" ? "提交给 MCP 编排器" : "提交给人工审核流程"} confirmLoading={enqueue.isPending}><Segmented block value={driver} onChange={(value) => setDriver(value as "external-mcp" | "human")} options={[{ label: "MCP 外部 LLM", value: "external-mcp" }, { label: "人工操作", value: "human" }]} />{intentOpen === "plan" && <><div className="novel-runtime-modal-label">规划子任务类别</div><Segmented block value={planTaskKey} onChange={(value) => setPlanTaskKey(value as typeof planTaskKey)} options={[{ label: "全书架构", value: "architecture" }, { label: "项目定位", value: "project-positioning" }, { label: "故事圣经", value: "story-bible" }, { label: "角色", value: "characters" }, { label: "关系", value: "relations" }, { label: "世界观", value: "worldview" }]} /></>}<Input.TextArea rows={6} value={instruction} onChange={(event) => setInstruction(event.target.value)} />{intentOpen !== "plan" && !document && <Segmented block value={target} onChange={(value) => setTarget(String(value))} options={[{ label: "下一章", value: "next" }, ...documents.map((document) => ({ label: String(document.title), value: String(document.id) }))]} />}{document && intentOpen !== "plan" && <Alert type="info" showIcon message={`目标章节：${document.title}`} description="该任务会进入统一运行时流程；MCP 与人工只区别于谁执行审核、修订和提交动作。" />}</Modal>
    <Modal width={880} title={changeQuery.data?.change.title ?? "候选预览"} open={Boolean(selectedChange)} onCancel={() => setSelectedChange(undefined)} footer={changeQuery.data ? userCanReview ? <div className="novel-runtime-review-actions"><Input value={revisionNote} onChange={(event) => setRevisionNote(event.target.value)} placeholder="拒绝或重做时填写原因" /><Button danger icon={<StopOutlined />} onClick={() => review.mutate({ change: changeQuery.data.change, decision: "reject" })}>拒绝</Button><Button icon={<EditOutlined />} onClick={() => review.mutate({ change: changeQuery.data.change, decision: "revise" })}>重做</Button><Button type="primary" icon={<CheckOutlined />} onClick={() => review.mutate({ change: changeQuery.data.change, decision: "accept" })}>接受并写入</Button></div> : <Alert type="info" message="该候选由 MCP 大模型负责审核和推进，UI 仅提供只读检查。" /> : null}><div className="novel-runtime-preview">{changeQuery.isLoading ? <Skeleton active /> : <ReactMarkdown remarkPlugins={[remarkGfm]}>{artifactMarkdown(changeQuery.data?.artifact)}</ReactMarkdown>}</div></Modal>
  </div>;
}
