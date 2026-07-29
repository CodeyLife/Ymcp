import {
  AuditOutlined,
  BlockOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DatabaseOutlined,
  EditOutlined,
  ExperimentOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  ForkOutlined,
  FundProjectionScreenOutlined,
  HighlightOutlined,
  PauseCircleOutlined,
  PlayCircleFilled,
  ReloadOutlined,
  RocketOutlined,
  RollbackOutlined,
  SafetyOutlined,
  ScissorOutlined,
  SendOutlined,
  StopFilled,
  ThunderboltFilled,
  ThunderboltOutlined,
} from "@ant-design/icons";
import type { ReactNode } from "react";

/* ============================================================
 * 小说创作 V2 — 展示层语义转译
 * 把 API 返回的 raw 技术字段（workflowType / status / event_type /
 * artifact.kind / payload）统一映射为用户可读的中文标签、图标与摘要。
 * 所有 novel 创作板块共享，避免各面板各自硬编码 raw id/JSON 展示。
 * ============================================================ */

// ----- workflowType → 中文标签 + 图标 -----
const WORKFLOW_TYPE_META: Record<string, { label: string; icon: ReactNode }> = {
  "novel-intent": { label: "创作意图", icon: <SendOutlined /> },
  "chapter-review": { label: "章节审校", icon: <AuditOutlined /> },
  "creative-run": { label: "创意执行", icon: <ThunderboltOutlined /> },
};

export function workflowTypeMeta(workflowType: string | undefined): { label: string; icon: ReactNode } {
  if (!workflowType) return { label: "运行", icon: <PlayCircleFilled /> };
  return WORKFLOW_TYPE_META[workflowType] ?? { label: workflowType, icon: <PlayCircleFilled /> };
}

// ----- 运行/任务 status → 中文标签 + 状态药丸 class -----
const STATUS_META: Record<string, { label: string; pill: string; icon: ReactNode }> = {
  received: { label: "已接收", pill: "novel-status-pill novel-status-pill-idle", icon: <ClockCircleOutlined /> },
  accepted: { label: "已受理", pill: "novel-status-pill novel-status-pill-running", icon: <ClockCircleOutlined /> },
  pending: { label: "等待中", pill: "novel-status-pill novel-status-pill-idle", icon: <ClockCircleOutlined /> },
  running: { label: "运行中", pill: "novel-status-pill novel-status-pill-running", icon: <ReloadOutlined spin /> },
  paused: { label: "已暂停", pill: "novel-status-pill novel-status-pill-running", icon: <ClockCircleOutlined /> },
  completed: { label: "已完成", pill: "novel-status-pill novel-status-pill-done", icon: <CheckCircleFilled /> },
  succeeded: { label: "已成功", pill: "novel-status-pill novel-status-pill-done", icon: <CheckCircleFilled /> },
  failed: { label: "失败", pill: "novel-status-pill novel-status-pill-failed", icon: <StopFilled /> },
  cancelled: { label: "已取消", pill: "novel-status-pill novel-status-pill-failed", icon: <StopFilled /> },
  rejected: { label: "已拒绝", pill: "novel-status-pill novel-status-pill-failed", icon: <StopFilled /> },
};

export function statusMeta(status: string | undefined): { label: string; pill: string; icon: ReactNode } {
  if (!status) return { label: "未知", pill: "novel-status-pill novel-status-pill-idle", icon: <ClockCircleOutlined /> };
  return STATUS_META[status] ?? { label: status, pill: "novel-status-pill novel-status-pill-idle", icon: <ClockCircleOutlined /> };
}

// ----- artifact.kind → 中文标签 + 图标 -----
const ARTIFACT_KIND_META: Record<string, { label: string; icon: ReactNode }> = {
  draft: { label: "初稿", icon: <FileTextOutlined /> },
  review: { label: "审核", icon: <AuditOutlined /> },
  revision: { label: "修订稿", icon: <EditOutlined /> },
  "fact-extraction": { label: "事实抽取", icon: <DatabaseOutlined /> },
  summary: { label: "摘要", icon: <FileSearchOutlined /> },
  foundation: { label: "基础设定", icon: <FundProjectionScreenOutlined /> },
  blueprint: { label: "执行蓝图", icon: <FundProjectionScreenOutlined /> },
  context: { label: "上下文包", icon: <FileSearchOutlined /> },
  memory: { label: "记忆产物", icon: <DatabaseOutlined /> },
};

export function artifactKindMeta(kind: string | undefined): { label: string; icon: ReactNode } {
  if (!kind) return { label: "产物", icon: <FileTextOutlined /> };
  return ARTIFACT_KIND_META[kind] ?? { label: kind, icon: <FileTextOutlined /> };
}

// 从 structuredData 提取一行预览摘要，替代裸 ID 展示
export function artifactPreview(kind: string | undefined, structuredData: Record<string, unknown> | undefined): string {
  const d = structuredData ?? {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

  switch (kind) {
    case "draft": {
      const model = str(d.model) ?? str((d.modelProvenance as Record<string, unknown>)?.model);
      return model ? `草稿 · 模型 ${model}` : "草稿产物";
    }
    case "revision": {
      const windows = Array.isArray(d.revisionWindows) ? d.revisionWindows : undefined;
      const mode = str(d.revisionMode);
      if (windows) return `修订稿 · ${windows.length} 处修改`;
      if (mode === "full-fallback") return "修订稿 · 全文重写";
      return "修订稿产物";
    }
    case "review":
      return "审核记录";
    case "fact-extraction": {
      const source = str(d.sourceArtifactId);
      return source ? `事实抽取 · 来源 ${shortId(source, 8)}` : "事实抽取产物";
    }
    case "summary": {
      const critique = str(d.critique);
      if (critique) return critique.length > 60 ? `反思：${critique.slice(0, 60)}…` : `反思：${critique}`;
      return "反思摘要";
    }
    case "foundation": {
      const taskKey = str(d.taskKey);
      return taskKey ? `基础设定 · ${taskKey}` : "基础设定产物";
    }
    default:
      return "产物";
  }
}

// ----- 事件分类 -----
export type EventCategory = "运行" | "任务" | "产物" | "记忆" | "学习" | "文档" | "其他";

// 事件详情中提取的关键字段（标签 + 值），替代 raw JSON 展示
export interface EventField {
  label: string;
  value: string;
  mono?: boolean; // 渲染为等宽 code
}

export interface EventDescription {
  label: string;       // 一句话标题，如「初稿已生成」
  category: EventCategory;
  summary: string;     // 补充说明（不重复 label，提供上下文）
  icon: ReactNode;
  fields?: EventField[]; // 从 payload 提取的关键字段
}

// ----- 工作流阶段 → 中文标签 -----
const WORKFLOW_STAGE_META: Record<string, string> = {
  context: "上下文构建",
  blueprint: "蓝图生成",
  "blueprint-approval": "蓝图审批",
  draft: "草稿撰写",
  "deterministic-check": "确定性校验",
  review: "审核",
  revision: "修订",
  "manuscript-approval": "稿件审批",
  "fact-extraction": "事实抽取",
  "fact-approval": "事实审批",
  commit: "提交定稿",
  "character-enrichment": "角色充实",
  planning: "全书规划",
  foundation: "基础设定",
  drafting: "草稿撰写",
};

function stageLabel(stage: unknown): string | undefined {
  if (typeof stage !== "string" || !stage) return undefined;
  return WORKFLOW_STAGE_META[stage] ?? stage;
}

// 安全提取字符串
function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

// 把 outbox event_type + payload 转译为用户可读描述
export function describeEvent(eventType: string | undefined, payload: unknown): EventDescription {
  const type = (eventType ?? "event").trim();
  const p = (payload ?? {}) as Record<string, unknown>;
  const runId = str(p.runId) ?? str(p.workflowId);
  const taskId = str(p.taskId);
  const artifactId = str(p.artifactId);
  const stage = stageLabel(p.stage ?? p.workflowStage);

  // workflow.{status} —— 运行状态变更
  if (type.startsWith("workflow.")) {
    const st = type.replace("workflow.", "");
    const meta = statusMeta(st);
    const fields: EventField[] = [];
    if (runId) fields.push({ label: "运行 ID", value: shortId(runId, 10), mono: true });
    if (stage) fields.push({ label: "阶段", value: stage });
    const error = str(p.error);
    if (error) fields.push({ label: "错误", value: error });
    const finalStatus = str(p.finalStatus);
    if (finalStatus) fields.push({ label: "最终状态", value: statusMeta(finalStatus).label });
    const reason = str(p.reason);
    if (reason) fields.push({ label: "原因", value: reason });

    // 按状态给出不重复 label 的上下文摘要
    const summaryMap: Record<string, string> = {
      received: "Runtime 已接收创作意图，等待启动工作流",
      accepted: "工作流已确认，即将开始执行",
      running: stage ? `正在执行「${stage}」阶段` : "工作流正在执行",
      completed: "工作流全部阶段执行完毕",
      succeeded: "工作流全部阶段执行完毕",
      failed: error ? `执行失败：${error}` : "工作流执行过程中失败",
      cancelled: reason ? `已取消：${reason}` : "工作流被手动取消",
      rejected: "工作流被拒绝",
    };
    return {
      label: `运行${meta.label}`,
      category: "运行",
      summary: summaryMap[st] ?? `运行状态变更为「${meta.label}」`,
      icon: <ThunderboltFilled />,
      fields: fields.length ? fields : undefined,
    };
  }

  // artifact.{kind}.ready —— 产物就绪
  if (type.startsWith("artifact.") && type.endsWith(".ready")) {
    const kind = type.replace("artifact.", "").replace(/\.ready$/, "");
    const meta = artifactKindMeta(kind);
    const fields: EventField[] = [];
    if (artifactId) fields.push({ label: "产物 ID", value: shortId(artifactId, 10), mono: true });
    if (taskId) fields.push({ label: "来源任务", value: shortId(taskId, 10), mono: true });
    return {
      label: `${meta.label}已生成`,
      category: "产物",
      summary: `${meta.label}产物已就绪，可进入下一阶段`,
      icon: meta.icon,
      fields: fields.length ? fields : undefined,
    };
  }

  // task.{status} —— 任务状态变更
  if (type.startsWith("task.")) {
    const st = type.replace("task.", "");
    const meta = statusMeta(st);
    const fields: EventField[] = [];
    if (taskId) fields.push({ label: "任务 ID", value: shortId(taskId, 10), mono: true });
    if (stage) fields.push({ label: "阶段", value: stage });
    const error = str(p.error);
    if (error) fields.push({ label: "错误", value: error });
    return {
      label: `任务${meta.label}`,
      category: "任务",
      summary: taskId ? `任务 ${shortId(taskId, 8)} ${meta.label}` : `任务状态变更为「${meta.label}」`,
      icon: <ClockCircleOutlined />,
      fields: fields.length ? fields : undefined,
    };
  }

  // stage.started / stage.completed —— 阶段开始/完成
  if (type === "stage.started" || type === "stage.completed") {
    const isStart = type === "stage.started";
    const fields: EventField[] = [];
    if (taskId) fields.push({ label: "任务 ID", value: shortId(taskId, 10), mono: true });
    if (stage) fields.push({ label: "阶段", value: stage });
    const attemptId = str(p.attemptId);
    if (attemptId) fields.push({ label: "尝试", value: shortId(attemptId, 8), mono: true });
    return {
      label: stage ? `${stage}${isStart ? "开始" : "完成"}` : isStart ? "阶段开始" : "阶段完成",
      category: "任务",
      summary: isStart
        ? (stage ? `进入「${stage}」阶段` : "任务开始执行")
        : (stage ? `「${stage}」阶段执行完毕` : "任务执行完毕"),
      icon: isStart ? <PlayCircleFilled /> : <CheckCircleFilled />,
      fields: fields.length ? fields : undefined,
    };
  }

  // execution-blueprint.ready —— 蓝图就绪
  if (type === "execution-blueprint.ready") {
    const fields: EventField[] = [];
    const blueprintId = str(p.blueprintId) ?? str(p.artifactId);
    if (blueprintId) fields.push({ label: "蓝图 ID", value: shortId(blueprintId, 10), mono: true });
    return {
      label: "执行蓝图就绪",
      category: "产物",
      summary: "章节执行蓝图已生成，即将进入草稿阶段",
      icon: <FundProjectionScreenOutlined />,
      fields: fields.length ? fields : undefined,
    };
  }

  // memory-claim.upserted —— 记忆声明
  if (type === "memory-claim.upserted") {
    const novelty = str(p.novelty);
    const fields: EventField[] = [];
    const title = str(p.title);
    if (title) fields.push({ label: "标题", value: title });
    if (novelty) fields.push({ label: "新颖性", value: novelty === "new" ? "新增" : "更新" });
    return {
      label: novelty === "new" ? "新记忆声明" : "记忆声明更新",
      category: "记忆",
      summary: title ? `事实「${title}」已写入知识库` : "事实记忆已写入知识库",
      icon: <DatabaseOutlined />,
      fields: fields.length ? fields : undefined,
    };
  }

  // chapter-memory.upserted —— 章节记忆
  if (type === "chapter-memory.upserted") {
    const fields: EventField[] = [];
    const docId = str(p.documentId);
    if (docId) fields.push({ label: "章节", value: shortId(docId, 10), mono: true });
    const range = p.narrativeRange;
    if (range && typeof range === "object") {
      const r = range as { start?: number; end?: number };
      if (r.start !== undefined) fields.push({ label: "章节范围", value: `第 ${r.start}${r.end !== undefined ? `-${r.end}` : ""} 章` });
    }
    return {
      label: "章节记忆更新",
      category: "记忆",
      summary: "章节记忆已更新，将用于后续创作",
      icon: <DatabaseOutlined />,
      fields: fields.length ? fields : undefined,
    };
  }

  // learning.* —— 学习评估
  if (type.startsWith("learning.")) {
    if (type === "learning.propose-improvement") {
      return { label: "改进建议提出", category: "学习", summary: "审核闭环提出技能/提示词改进建议", icon: <HighlightOutlined /> };
    }
    if (type === "learning.promotion-regression-required") {
      return { label: "晋升待回归", category: "学习", summary: "技能晋升需回归验证后生效", icon: <HighlightOutlined /> };
    }
    return { label: "学习评估", category: "学习", summary: "审核经验已沉淀为学习评估", icon: <HighlightOutlined /> };
  }

  // manuscript-revision.committed —— 稿件修订提交
  if (type === "manuscript-revision.committed") {
    const revision = p.revision;
    return {
      label: "稿件修订已提交",
      category: "文档",
      summary: typeof revision === "number" ? `章节内容已更新至 revision ${revision}` : "章节内容已更新",
      icon: <EditOutlined />,
    };
  }

  // document.updated / document.deleted
  if (type === "document.updated") return { label: "章节文档更新", category: "文档", summary: "章节文档信息已更新", icon: <FileTextOutlined /> };
  if (type === "document.deleted") return { label: "章节文档删除", category: "文档", summary: "章节文档已删除", icon: <FileTextOutlined /> };
  if (type === "project.updated") return { label: "项目信息更新", category: "文档", summary: "项目基本信息已更新", icon: <FileTextOutlined /> };

  // knowledge.{action}
  if (type.startsWith("knowledge.")) {
    return { label: "知识库变更", category: "记忆", summary: "知识库记录已更新", icon: <DatabaseOutlined /> };
  }

  // 兜底：保留 raw type 但提取已知字段，仍给一个友好框架
  const fields: EventField[] = [];
  if (runId) fields.push({ label: "运行 ID", value: shortId(runId, 10), mono: true });
  if (taskId) fields.push({ label: "任务 ID", value: shortId(taskId, 10), mono: true });
  if (artifactId) fields.push({ label: "产物 ID", value: shortId(artifactId, 10), mono: true });
  if (stage) fields.push({ label: "阶段", value: stage });
  return {
    label: type,
    category: "其他",
    summary: "系统事件",
    icon: <ThunderboltOutlined />,
    fields: fields.length ? fields : undefined,
  };
}

// ----- 通用工具：短 id、相对时间 -----
export function shortId(id: string | undefined, len = 8): string {
  if (!id) return "";
  return id.length <= len ? id : id.slice(0, len);
}

export function relativeTime(ts: string | number | undefined): string {
  if (ts === undefined || ts === null || ts === "") return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 0) return date.toLocaleString("zh-CN");
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return date.toLocaleString("zh-CN");
}

// ============================================================
// 文档状态（planned / draft / review / revision / final / archived）
// ============================================================
const DOCUMENT_STATUS_META: Record<string, { label: string; pill: string }> = {
  planned: { label: "已规划", pill: "novel-status-pill novel-status-pill-idle" },
  draft: { label: "草稿中", pill: "novel-status-pill novel-status-pill-running" },
  review: { label: "审校中", pill: "novel-status-pill novel-status-pill-running" },
  revision: { label: "修订中", pill: "novel-status-pill novel-status-pill-running" },
  final: { label: "已定稿", pill: "novel-status-pill novel-status-pill-done" },
  archived: { label: "已归档", pill: "novel-status-pill novel-status-pill-idle" },
};

export function documentStatusMeta(status: string | undefined): { label: string; pill: string } {
  if (!status) return { label: "未知", pill: "novel-status-pill novel-status-pill-idle" };
  return DOCUMENT_STATUS_META[status] ?? { label: status, pill: "novel-status-pill novel-status-pill-idle" };
}

// ============================================================
// Creative Run 模式
// ============================================================
const RUN_MODE_META: Record<string, { label: string; icon: ReactNode }> = {
  chapter: { label: "章节生成", icon: <FileTextOutlined /> },
  "segment-auto": { label: "自动分段", icon: <ScissorOutlined /> },
};

export function runModeMeta(mode: string | undefined): { label: string; icon: ReactNode } {
  if (!mode) return { label: "未设置", icon: <FileTextOutlined /> };
  return RUN_MODE_META[mode] ?? { label: mode, icon: <FileTextOutlined /> };
}

// ============================================================
// 工作项状态（WorkItemStatus）
// ============================================================
const WORK_ITEM_STATUS_META: Record<string, { label: string; pill: string; tag: string }> = {
  pending: { label: "等待中", pill: "novel-status-pill novel-status-pill-idle", tag: "default" },
  running: { label: "执行中", pill: "novel-status-pill novel-status-pill-running", tag: "blue" },
  accepted: { label: "已采纳", pill: "novel-status-pill novel-status-pill-done", tag: "green" },
  revised: { label: "已修订", pill: "novel-status-pill novel-status-pill-done", tag: "cyan" },
  retried: { label: "重试中", pill: "novel-status-pill novel-status-pill-running", tag: "orange" },
  recovered: { label: "已恢复", pill: "novel-status-pill novel-status-pill-done", tag: "purple" },
  failed: { label: "失败", pill: "novel-status-pill novel-status-pill-failed", tag: "red" },
};

export function workItemStatusMeta(status: string | undefined): { label: string; pill: string; tag: string } {
  if (!status) return { label: "未知", pill: "novel-status-pill novel-status-pill-idle", tag: "default" };
  return WORK_ITEM_STATUS_META[status] ?? { label: status, pill: "novel-status-pill novel-status-pill-idle", tag: "default" };
}

// ============================================================
// 审核裁决（ReviewVerdict）
// ============================================================
const REVIEW_VERDICT_META: Record<string, { label: string; tag: string; icon: ReactNode }> = {
  passed: { label: "通过", tag: "green", icon: <CheckCircleFilled /> },
  revise: { label: "需修订", tag: "orange", icon: <EditOutlined /> },
  blocked: { label: "阻塞", tag: "red", icon: <BlockOutlined /> },
};

export function reviewVerdictMeta(verdict: string | undefined): { label: string; tag: string; icon: ReactNode } {
  if (!verdict) return { label: "未知", tag: "default", icon: <ClockCircleOutlined /> };
  return REVIEW_VERDICT_META[verdict] ?? { label: verdict, tag: "default", icon: <ClockCircleOutlined /> };
}

// ============================================================
// 命令类型（work.* / review.* / run.*）
// ============================================================
const COMMAND_TYPE_META: Record<string, { label: string; scope: "work" | "run" | "review" }> = {
  "work.start": { label: "启动工作项", scope: "work" },
  "work.accept": { label: "采纳工作项", scope: "work" },
  "work.revise": { label: "修订工作项", scope: "work" },
  "work.retry": { label: "重试工作项", scope: "work" },
  "work.recover": { label: "恢复工作项", scope: "work" },
  "review.request": { label: "请求审核", scope: "review" },
  "review.submit": { label: "提交审核", scope: "review" },
  "run.pause": { label: "暂停运行", scope: "run" },
  "run.resume": { label: "恢复运行", scope: "run" },
  "run.cancel": { label: "取消运行", scope: "run" },
};

export function commandTypeMeta(type: string | undefined): { label: string; scope: "work" | "run" | "review" } {
  if (!type) return { label: "未知命令", scope: "work" };
  return COMMAND_TYPE_META[type] ?? { label: type, scope: "work" };
}

// ============================================================
// 实验工作区状态
// ============================================================
const EXPERIMENT_STATUS_META: Record<string, { label: string; tag: string; pill: string }> = {
  active: { label: "活跃", tag: "green", pill: "novel-status-pill novel-status-pill-running" },
  closed: { label: "已关闭", tag: "default", pill: "novel-status-pill novel-status-pill-idle" },
  deleted: { label: "已删除", tag: "red", pill: "novel-status-pill novel-status-pill-failed" },
};

export function experimentStatusMeta(status: string | undefined): { label: string; tag: string; pill: string } {
  if (!status) return { label: "未知", tag: "default", pill: "novel-status-pill novel-status-pill-idle" };
  return EXPERIMENT_STATUS_META[status] ?? { label: status, tag: "default", pill: "novel-status-pill novel-status-pill-idle" };
}

// ============================================================
// 晋升收据状态
// ============================================================
const RECEIPT_STATUS_META: Record<string, { label: string; pill: string; icon: ReactNode }> = {
  promoted: { label: "已晋升", pill: "novel-status-pill novel-status-pill-done", icon: <RocketOutlined /> },
  "rolled-back": { label: "已回滚", pill: "novel-status-pill novel-status-pill-running", icon: <RollbackOutlined /> },
  failed: { label: "失败", pill: "novel-status-pill novel-status-pill-failed", icon: <CloseCircleOutlined /> },
};

export function receiptStatusMeta(status: string | undefined): { label: string; pill: string; icon: ReactNode } {
  if (!status) return { label: "未知", pill: "novel-status-pill novel-status-pill-idle", icon: <ClockCircleOutlined /> };
  return RECEIPT_STATUS_META[status] ?? { label: status, pill: "novel-status-pill novel-status-pill-idle", icon: <ClockCircleOutlined /> };
}

// ============================================================
// 晋升决策（accept / reject）
// ============================================================
const DECISION_META: Record<string, { label: string }> = {
  accept: { label: "采纳" },
  reject: { label: "拒绝" },
};

export function decisionMeta(decision: string | undefined): { label: string } {
  if (!decision) return { label: "未知" };
  return DECISION_META[decision] ?? { label: decision };
}

// ============================================================
// 知识库类型（KnowledgeKind）
// ============================================================
const KNOWLEDGE_KIND_META: Record<string, { label: string; icon: ReactNode }> = {
  planning: { label: "规划", icon: <FundProjectionScreenOutlined /> },
  worldview: { label: "世界观", icon: <DatabaseOutlined /> },
  characters: { label: "角色", icon: <SafetyOutlined /> },
  relations: { label: "关系", icon: <ForkOutlined /> },
  timeline: { label: "时间线", icon: <ClockCircleOutlined /> },
  facts: { label: "事实账本", icon: <FileSearchOutlined /> },
  skills: { label: "Skill 治理", icon: <HighlightOutlined /> },
  foundation: { label: "Foundation", icon: <ExperimentOutlined /> },
};

export function knowledgeKindMeta(kind: string | undefined): { label: string; icon: ReactNode } {
  if (!kind) return { label: "未分类", icon: <DatabaseOutlined /> };
  return KNOWLEDGE_KIND_META[kind] ?? { label: kind, icon: <DatabaseOutlined /> };
}

// ============================================================
// Creative Run 事件描述（复用 describeEvent 但补充 creative 专属事件）
// ============================================================
export function describeCreativeEvent(eventType: string | undefined, payload: unknown): EventDescription {
  const type = (eventType ?? "event").trim();
  const p = (payload ?? {}) as Record<string, unknown>;
  const runId = str(p.runId);
  const workItemId = str(p.workItemId);
  const reviewer = str(p.reviewer);

  // creative-run 专属命令事件
  if (type.startsWith("command.")) {
    const cmd = type.replace("command.", "");
    const meta = commandTypeMeta(cmd);
    const fields: EventField[] = [];
    if (workItemId) fields.push({ label: "工作项", value: shortId(workItemId, 10), mono: true });
    if (runId) fields.push({ label: "运行 ID", value: shortId(runId, 10), mono: true });
    return {
      label: `命令已提交：${meta.label}`,
      category: "任务",
      summary: `${meta.scope === "run" ? "运行级" : meta.scope === "review" ? "审核级" : "工作项级"}命令「${meta.label}」已提交`,
      icon: <SendOutlined />,
      fields: fields.length ? fields : undefined,
    };
  }

  // work-item 状态变更
  if (type.startsWith("work-item.") || type.startsWith("work_item.")) {
    const st = type.replace(/^(work-item|work_item)\./, "");
    const meta = workItemStatusMeta(st);
    const fields: EventField[] = [];
    if (workItemId) fields.push({ label: "工作项", value: shortId(workItemId, 10), mono: true });
    return {
      label: `工作项${meta.label}`,
      category: "任务",
      summary: workItemId ? `工作项 ${shortId(workItemId, 8)} ${meta.label}` : `工作项状态变更为「${meta.label}」`,
      icon: <FileTextOutlined />,
      fields: fields.length ? fields : undefined,
    };
  }

  // review 结果
  if (type.startsWith("review.")) {
    const verdict = typeof p.verdict === "string" ? p.verdict : type.replace("review.", "");
    const meta = reviewVerdictMeta(verdict);
    const fields: EventField[] = [];
    if (reviewer) fields.push({ label: "审核人", value: reviewer });
    const issueCount = typeof p.issueCount === "number" ? p.issueCount : undefined;
    if (issueCount !== undefined) fields.push({ label: "问题数", value: String(issueCount) });
    const summary = str(p.summary);
    return {
      label: `审核${meta.label}`,
      category: "任务",
      summary: summary ?? `审核裁决为「${meta.label}」`,
      icon: <AuditOutlined />,
      fields: fields.length ? fields : undefined,
    };
  }

  // run 状态变更
  if (type.startsWith("run.") && type !== "run.cancel") {
    const st = type.replace("run.", "");
    const meta = statusMeta(st);
    const fields: EventField[] = [];
    if (runId) fields.push({ label: "运行 ID", value: shortId(runId, 10), mono: true });
    const summaryMap: Record<string, string> = {
      pending: "运行已创建，等待启动",
      running: "工作流正在执行",
      paused: "运行被手动暂停",
      completed: "运行全部执行完毕",
      cancelled: "运行被手动取消",
    };
    return {
      label: `运行${meta.label}`,
      category: "运行",
      summary: summaryMap[st] ?? `运行状态变更为「${meta.label}」`,
      icon: <ThunderboltFilled />,
      fields: fields.length ? fields : undefined,
    };
  }
  if (type === "run.cancel") {
    const fields: EventField[] = [];
    if (runId) fields.push({ label: "运行 ID", value: shortId(runId, 10), mono: true });
    return { label: "运行已取消", category: "运行", summary: "运行被手动取消", icon: <StopFilled />, fields: fields.length ? fields : undefined };
  }
  if (type === "run.pause") {
    const fields: EventField[] = [];
    if (runId) fields.push({ label: "运行 ID", value: shortId(runId, 10), mono: true });
    return { label: "运行已暂停", category: "运行", summary: "运行被手动暂停，可恢复", icon: <PauseCircleOutlined />, fields: fields.length ? fields : undefined };
  }
  if (type === "run.resume") {
    const fields: EventField[] = [];
    if (runId) fields.push({ label: "运行 ID", value: shortId(runId, 10), mono: true });
    return { label: "运行已恢复", category: "运行", summary: "运行从暂停状态恢复执行", icon: <PlayCircleFilled />, fields: fields.length ? fields : undefined };
  }

  // 兜底：复用通用 describeEvent
  return describeEvent(type, payload);
}
