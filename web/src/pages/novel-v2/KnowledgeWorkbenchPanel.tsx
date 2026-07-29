import { useEffect, useMemo, useState } from "react";
import { Button, Input, Modal, Popconfirm, Segmented, Space, Table, Tabs, message } from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { motion } from "motion/react";
import "../novel-v2.css";
import { knowledgeKindMeta, shortId } from "./presentation";
import KnowledgeRecordForm, { type KnowledgeFormKind } from "./KnowledgeRecordForm";

type KnowledgeKind = "planning" | "worldview" | "characters" | "relations" | "timeline" | "facts" | "skills";
type KnowledgeRecord = Record<string, unknown> & { id?: string };

const KINDS: Array<{ key: KnowledgeKind; label: string }> = [
  { key: "planning", label: "规划" },
  { key: "worldview", label: "世界观" },
  { key: "characters", label: "角色" },
  { key: "relations", label: "关系" },
  { key: "timeline", label: "时间线" },
  { key: "facts", label: "事实账本" },
  { key: "skills", label: "Skill 治理" },
];

const NEW_RECORD: Record<KnowledgeKind, KnowledgeRecord> = {
  planning: { name: "", payload: { objective: "", constraints: [] } },
  worldview: { name: "", payload: { rule: "", boundary: "" } },
  characters: { name: "", payload: { role: "", motivation: "", voiceAnchor: "" } },
  relations: { subjectId: "", predicate: "", objectId: "" },
  timeline: { narrativeTime: 1, eventType: "", content: {} },
  facts: { subjectId: "", predicate: "", objectValue: {}, truthStatus: "candidate", confidence: 0.8 },
  skills: { id: "", version: "1.0.0", capabilities: [], applicableTasks: [], qualityGates: [], promptSections: {}, enabled: true },
};

function labelOf(record: KnowledgeRecord) {
  return String(record.name ?? record.predicate ?? record.event_type ?? record.eventType ?? record.taskId ?? record.task_id ?? record.id ?? "未命名记录");
}

function recordId(record: KnowledgeRecord) {
  return String(record.id ?? record.skill_id ?? "");
}

// 按知识库类型提取人话摘要，避免直接 dump JSON
function describeRecord(kind: KnowledgeKind, record: KnowledgeRecord): string {
  const p = (record.payload ?? record) as Record<string, unknown>;
  const str = (v: unknown) => (v === undefined || v === null || v === "") ? "" : String(v);
  const arrLen = (v: unknown) => Array.isArray(v) ? v.length : 0;

  switch (kind) {
    case "planning":
      return str(p.objective) || `规划记录 · ${arrLen(p.constraints)} 条约束`;
    case "worldview":
      return str(p.rule) || str(p.boundary) || "世界观规则";
    case "characters":
      return [str(p.role), str(p.motivation)].filter(Boolean).join(" · ") || "角色档案";
    case "relations":
      return `${str(record.subjectId) || "?"} → ${str(record.predicate) || "?"} → ${str(record.objectId) || "?"}`;
    case "timeline":
      return `第 ${str(record.narrativeTime) || "?"} 章 · ${str(record.eventType) || "事件"}`;
    case "facts": {
      const truth = str(record.truthStatus) || "candidate";
      const conf = typeof record.confidence === "number" ? record.confidence.toFixed(2) : "";
      return `${str(record.subjectId) || "?"} · ${str(record.predicate) || "?"} · ${truth}${conf ? ` (${conf})` : ""}`;
    }
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

export default function KnowledgeWorkbenchPanel({ projectId }: { projectId: string }) {
  const [kind, setKind] = useState<KnowledgeKind>("planning");
  const [records, setRecords] = useState<KnowledgeRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<KnowledgeRecord>();
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
    if (!editing) return;
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
    await readJson(path, { method: id ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    setEditing(undefined);
    await load();
    message.success(id ? "记录已更新" : "记录已创建");
  }

  async function remove(record: KnowledgeRecord) {
    const id = recordId(record);
    if (!id) return;
    await readJson(`/v2/projects/${encodeURIComponent(projectId)}/knowledge/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
    message.success("记录已删除");
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
    { title: "详情", key: "data", render: (_: unknown, record: KnowledgeRecord) => (
      <span className="novel-table-cell-sub" style={{ fontSize: 12, color: "#a1a1aa" }}>{describeRecord(kind, record)}</span>
    )},
    {
      title: "操作", key: "actions", width: 120,
      render: (_: unknown, record: KnowledgeRecord) => (
        <Space size="small">
          <Button type="text" icon={<EditOutlined />} aria-label="编辑" onClick={() => openEdit(record)} />
          <Popconfirm title="删除此记录？" okText="删除" okButtonProps={{ danger: true }} onConfirm={() => void remove(record)}>
            <Button type="text" danger icon={<DeleteOutlined />} aria-label="删除" />
          </Popconfirm>
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
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增记录</Button>
        </Space>
      </div>
      <Tabs activeKey={kind} items={KINDS.map((item) => ({ key: item.key, label: item.label }))} onChange={(value) => setKind(value as KnowledgeKind)} />
      <Table rowKey={(record) => recordId(record) || JSON.stringify(record)} loading={loading} dataSource={records} columns={columns} pagination={{ pageSize: 12 }} scroll={{ x: 760 }} />
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
