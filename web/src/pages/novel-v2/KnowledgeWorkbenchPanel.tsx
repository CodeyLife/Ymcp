import { useEffect, useMemo, useState } from "react";
import { Button, Input, Modal, Popconfirm, Segmented, Space, Table, Tabs, Tag, Tooltip, message } from "antd";
import { DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { motion } from "motion/react";
import "../novel-v2.css";
import { knowledgeKindMeta, shortId } from "./presentation";
import KnowledgeRecordForm, { type KnowledgeFormKind } from "./KnowledgeRecordForm";

type KnowledgeKind = "characters" | "relations" | "claims" | "chapter-memories" | "project-skills" | "skills";
type EditableKnowledgeKind = "characters" | "relations" | "claims" | "skills";
type KnowledgeRecord = Record<string, unknown> & { id?: string; readOnly?: boolean; source?: string };

const KINDS: Array<{ key: KnowledgeKind; label: string }> = [
  { key: "characters", label: "角色" },
  { key: "relations", label: "关系" },
  { key: "claims", label: "叙事事实" },
  { key: "chapter-memories", label: "章节记忆" },
  { key: "project-skills", label: "本项目 Skill" },
  { key: "skills", label: "全局 Skill 治理" },
];

const NEW_RECORD: Record<EditableKnowledgeKind, KnowledgeRecord> = {
  characters: { name: "", payload: { role: "", motivation: "", voiceAnchor: "" } },
  relations: { subjectId: "", predicate: "", objectId: "" },
  claims: { title: "", subjectRefs: [], predicate: "", content: "", narrativeStart: undefined, narrativeEnd: undefined },
  skills: { id: "", version: "1.0.0", capabilities: [], applicableTasks: [], qualityGates: [], promptSections: {}, enabled: true },
};

export function isEditableKnowledgeKind(kind: KnowledgeKind): kind is EditableKnowledgeKind {
  return kind === "characters" || kind === "relations" || kind === "claims" || kind === "skills";
}

function labelOf(record: KnowledgeRecord) {
  return String(record.name ?? record.title ?? record.skillId ?? record.predicate ?? record.documentId ?? record.taskKey ?? record.id ?? "未命名记录");
}

function recordId(record: KnowledgeRecord) {
  return String(record.id ?? record.skill_id ?? "");
}

// 按知识库类型提取人话摘要，避免直接 dump JSON
function describeRecord(kind: KnowledgeKind, record: KnowledgeRecord): string {
  const p = (record.payload ?? record) as Record<string, unknown>;
  const str = (v: unknown) => (v === undefined || v === null || v === "") ? "" : String(v);
  const arrLen = (v: unknown) => Array.isArray(v) ? v.length : 0;
  const compact = (v: unknown, max = 180) => {
    const text = str(v).replace(/\s+/gu, " ").trim();
    return text.length > max ? `${text.slice(0, max)}...` : text;
  };

  switch (kind) {
    case "characters":
      return [str(p.role), str(p.motivation)].filter(Boolean).join(" · ") || "角色档案";
    case "relations":
      return `${str(record.subjectId) || "?"} → ${str(record.predicate) || "?"} → ${str(record.objectId) || "?"}`;
    case "claims": {
      const authority = str(record.authority) || "candidate";
      const conf = typeof record.confidence === "number" ? record.confidence.toFixed(2) : "";
      return [compact(record.content), authority, conf ? `置信度 ${conf}` : ""].filter(Boolean).join(" · ");
    }
    case "chapter-memories":
      return compact(record.summary) || `第 ${str(record.narrativeStart) || "?"} 章 · ${arrLen(record.keyEvents)} 个关键事件`;
    case "project-skills":
    case "skills": {
      const ver = str(record.version);
      const caps = arrLen(record.capabilities);
      const enabled = record.enabled === false ? "已禁用" : "已启用";
      return `${enabled}${ver ? ` · v${ver}` : ""} · ${caps} 项能力`;
    }
    default:
      return str(record.name) || "记录";
  }
}

function sourceLabel(source: unknown): string {
  switch (source) {
    case "project-plan": return "当前契约";
    case "fact-extraction": return "章节抽取";
    case "manual-claim": return "作者维护";
    case "chapter-memory": return "章节派生";
    case "skill-bundle": return "当前 Bundle";
    case "skill-definition": return "全局定义";
    default: return "项目投影";
  }
}

export default function KnowledgeWorkbenchPanel({ projectId }: { projectId: string }) {
  const [kind, setKind] = useState<KnowledgeKind>("characters");
  const [records, setRecords] = useState<KnowledgeRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<KnowledgeRecord>();
  const [viewing, setViewing] = useState<KnowledgeRecord>();
  const [draft, setDraft] = useState<KnowledgeRecord>({});
  const [jsonText, setJsonText] = useState("");
  const [editorMode, setEditorMode] = useState<"form" | "json">("form");

  async function readJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
    const response = await fetch(input, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
    return body as T;
  }

  async function load(nextKind = kind) {
    setLoading(true);
    try {
      const body = await readJson<{ records: KnowledgeRecord[] }>(`/v2/projects/${encodeURIComponent(projectId)}/knowledge/${nextKind}`);
      setRecords(body.records ?? []);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(kind); }, [projectId, kind]);

  function openCreate() {
    if (!isEditableKnowledgeKind(kind)) return;
    setEditing({});
    setDraft(NEW_RECORD[kind]);
    setJsonText(JSON.stringify(NEW_RECORD[kind], null, 2));
    setEditorMode("form");
  }

  function openEdit(record: KnowledgeRecord) {
    setEditing(record);
    setDraft(record);
    setJsonText(JSON.stringify(record, null, 2));
    setEditorMode("form");
  }

  async function save() {
    if (!editing || !isEditableKnowledgeKind(kind)) return;
    let value: KnowledgeRecord;
    if (editorMode === "json") {
      try {
        value = JSON.parse(jsonText) as KnowledgeRecord;
      } catch {
        message.error("JSON 格式无效");
        return;
      }
    } else {
      value = draft;
    }
    const id = recordId(editing);
    const path = `/v2/projects/${encodeURIComponent(projectId)}/knowledge/${kind}${id ? `/${encodeURIComponent(id)}` : ""}`;
    try {
      await readJson(path, { method: id ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
      setEditing(undefined);
      await load();
      message.success(id ? "记录已更新" : "记录已创建");
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function remove(record: KnowledgeRecord) {
    const id = recordId(record);
    if (!id) return;
    try {
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}/knowledge/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
      message.success("记录已删除");
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  const kindMeta = knowledgeKindMeta(kind);
  const columns = useMemo(() => [
    { title: "记录", key: "label", width: 200, render: (_: unknown, record: KnowledgeRecord) => (
      <div className="novel-table-cell-stack">
        <Space size={6} align="center">
          <span className="novel-run-item-icon">{kindMeta.icon}</span>
          <strong>{labelOf(record)}</strong>
        </Space>
        <code className="novel-table-cell-sub">{recordId(record) ? shortId(recordId(record)) : "自动生成"}</code>
      </div>
    )},
    { title: "来源", key: "source", width: 110, render: (_: unknown, record: KnowledgeRecord) => <Tag>{sourceLabel(record.source)}</Tag> },
    { title: "详情", key: "data", render: (_: unknown, record: KnowledgeRecord) => (
      <span className="novel-table-cell-sub" style={{ fontSize: 12, color: "#a1a1aa" }}>{describeRecord(kind, record)}</span>
    )},
    {
      title: "操作", key: "actions", width: 120,
      render: (_: unknown, record: KnowledgeRecord) => (
        <Space size="small">
          <Tooltip title="查看详情"><Button type="text" icon={<EyeOutlined />} aria-label="查看详情" onClick={() => setViewing(record)} /></Tooltip>
          {isEditableKnowledgeKind(kind) && record.readOnly !== true ? <>
            <Tooltip title="编辑"><Button type="text" icon={<EditOutlined />} aria-label="编辑" onClick={() => openEdit(record)} /></Tooltip>
            <Popconfirm title="删除此记录？" okText="删除" okButtonProps={{ danger: true }} onConfirm={() => void remove(record)}>
              <Tooltip title="删除"><Button type="text" danger icon={<DeleteOutlined />} aria-label="删除" /></Tooltip>
            </Popconfirm>
          </> : null}
        </Space>
      ),
    },
  ], [kind]);

  return (
    <motion.section
      className="novel-knowledge-workbench"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="novel-card-head" style={{ marginBottom: 14 }}>
        <div>
          <span className="novel-eyebrow">{kindMeta.icon} {kindMeta.label} · 正式知识库</span>
          <h2 className="novel-display-h2" style={{ marginTop: 3 }}>创作资料工作台</h2>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
          {isEditableKnowledgeKind(kind) ? <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增记录</Button> : null}
        </Space>
      </div>
      <Tabs activeKey={kind} items={KINDS.map((item) => ({ key: item.key, label: item.label }))} onChange={(value) => setKind(value as KnowledgeKind)} />
      <Table rowKey={(record) => recordId(record) || JSON.stringify(record)} loading={loading} dataSource={records} columns={columns} pagination={{ pageSize: 12 }} scroll={{ x: 900 }} />
      <Modal title={viewing ? labelOf(viewing) : "资料详情"} open={Boolean(viewing)} onCancel={() => setViewing(undefined)} footer={<Button onClick={() => setViewing(undefined)}>关闭</Button>} width={820} destroyOnHidden>
        <pre style={{ margin: 0, maxHeight: "62vh", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 12, lineHeight: 1.65 }}>{viewing ? JSON.stringify(viewing, null, 2) : ""}</pre>
      </Modal>
      <Modal title={recordId(editing ?? {}) ? "编辑记录" : "新增记录"} open={Boolean(editing)} onCancel={() => setEditing(undefined)} onOk={() => void save()} okText="保存" width={820} destroyOnHidden>
        <Segmented
          value={editorMode}
          onChange={(v) => {
            const next = v as "form" | "json";
            if (next === "json") setJsonText(JSON.stringify(draft, null, 2));
            else {
              try { setDraft(JSON.parse(jsonText) as KnowledgeRecord); } catch { /* 保留 draft，非法 JSON 不回灌 */ }
            }
            setEditorMode(next);
          }}
          options={[{ value: "form", label: "结构化" }, { value: "json", label: "JSON" }]}
          style={{ marginBottom: 14 }}
        />
        {editorMode === "form" ? (
          <KnowledgeRecordForm kind={kind as KnowledgeFormKind} value={draft} onChange={setDraft} />
        ) : (
          <Input.TextArea value={jsonText} onChange={(event) => setJsonText(event.target.value)} autoSize={{ minRows: 16, maxRows: 28 }} spellCheck={false} style={{ fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" }} />
        )}
      </Modal>
    </motion.section>
  );
}
