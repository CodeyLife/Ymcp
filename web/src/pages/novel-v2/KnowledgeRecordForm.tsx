/* ============================================================
 * KnowledgeRecordForm — 知识库记录结构化表单（替换裸 JSON 编辑）
 *
 * 现状：KnowledgeWorkbenchPanel 用一个 TextArea 手编整条 JSON，易错且门槛高。
 * 这里用「按类型的字段 schema 注册表」驱动表单渲染：
 * - 每种知识库（planning/worldview/characters/relations/timeline/facts/skills）
 *   声明自己的字段（路径/类型/选项/校验），表单据此渲染对应控件
 * - 复杂子结构（promptSections / objectValue / content）退化为「子字段级 JSON」编辑，
 *   而非整条记录 JSON —— 大幅降低出错面
 * - 字符串数组（constraints/capabilities/...）用 tags 输入，免手写 JSON 数组
 *
 * 设计依据：AGENTS.md「reusable contracts」—— 字段 schema 是领域内在结构，
 * 不是针对某条记录的特例；新增知识库类型只需在 SCHEMA 加一条注册项。
 * ============================================================ */

import { useEffect, useRef, useState } from "react";
import { Input, InputNumber, Select, Switch } from "antd";
import "./knowledge-form.css";

export type KnowledgeFormKind = "planning" | "worldview" | "characters" | "relations" | "timeline" | "facts" | "skills";

type FieldType = "text" | "textarea" | "number" | "select" | "switch" | "stringList" | "json";

export interface FieldSchema {
  /** 记录在对象中的 dot 路径（支持 payload.xxx 嵌套） */
  path: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  rows?: number;
  help?: string;
  /** 2 = 占满整行，1 = 半行 */
  span?: 1 | 2;
}

/** 各知识库类型的字段 schema（领域内在结构，非特例） */
export const KNOWLEDGE_FORM_SCHEMA: Record<KnowledgeFormKind, FieldSchema[]> = {
  planning: [
    { path: "name", label: "规划名称", type: "text", span: 2, placeholder: "如：全书基调 / 第一卷主线" },
    { path: "payload.objective", label: "创作目标", type: "textarea", rows: 3, span: 2, placeholder: "这条规划要达成什么" },
    { path: "payload.constraints", label: "约束条件", type: "stringList", span: 2, help: "每条约束一项，回车添加" },
  ],
  worldview: [
    { path: "name", label: "设定名称", type: "text", span: 2, placeholder: "如：星环城的物理法则" },
    { path: "payload.rule", label: "规则", type: "textarea", rows: 3, span: 2, placeholder: "这个世界如何运作" },
    { path: "payload.boundary", label: "边界", type: "textarea", rows: 3, span: 2, placeholder: "什么不能发生 / 未明确定义的部分" },
  ],
  characters: [
    { path: "name", label: "角色名", type: "text", placeholder: "如：林晚" },
    { path: "payload.role", label: "定位 / 身份", type: "text", placeholder: "如：拾光者 / 向导" },
    { path: "payload.motivation", label: "动机", type: "textarea", rows: 3, span: 2, placeholder: "TA 想要什么、害怕什么" },
    { path: "payload.voiceAnchor", label: "声部锚点", type: "textarea", rows: 3, span: 2, help: "语气 / 用词 / 节奏 / 禁忌，供人物声音一致性" },
  ],
  relations: [
    { path: "subjectId", label: "主体", type: "text", placeholder: "如：林晚" },
    { path: "predicate", label: "关系", type: "text", placeholder: "如：师徒 / 敌对 / 守护" },
    { path: "objectId", label: "客体", type: "text", placeholder: "如：陆沉" },
  ],
  timeline: [
    { path: "narrativeTime", label: "章节序号", type: "number", min: 1, step: 1 },
    { path: "eventType", label: "事件类型", type: "text", placeholder: "如：转折 / 揭示 / 相遇" },
    { path: "content", label: "事件内容", type: "json", span: 2, help: "结构化事件描述（JSON）" },
  ],
  facts: [
    { path: "subjectId", label: "主体", type: "text", placeholder: "如：林晚" },
    { path: "predicate", label: "谓词", type: "text", placeholder: "如：持有 / 知晓 / 位于" },
    { path: "objectValue", label: "值", type: "json", span: 2, help: "事实的取值（可为字符串/对象 JSON）" },
    { path: "truthStatus", label: "真值状态", type: "select", options: [
      { value: "objective", label: "客观" },
      { value: "belief", label: "信念" },
      { value: "lie", label: "谎言" },
      { value: "candidate", label: "候选" },
    ] },
    { path: "confidence", label: "置信度", type: "number", min: 0, max: 1, step: 0.05 },
  ],
  skills: [
    { path: "id", label: "Skill ID", type: "text", placeholder: "如：chapter-draft" },
    { path: "version", label: "版本", type: "text", placeholder: "如：1.0.0" },
    { path: "capabilities", label: "能力", type: "stringList", span: 2 },
    { path: "applicableTasks", label: "适用任务", type: "stringList", span: 2 },
    { path: "qualityGates", label: "质量门", type: "stringList", span: 2 },
    { path: "enabled", label: "启用", type: "switch" },
    { path: "promptSections", label: "Prompt 段", type: "json", span: 2, help: "提示词分段（JSON 对象）" },
  ],
};

// ---------- dot 路径 get / set（不可变） ----------
function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc == null ? undefined : (acc as Record<string, unknown>)[key]), obj);
}

function setPath(obj: unknown, path: string, value: unknown): unknown {
  const keys = path.split(".");
  const root: Record<string, unknown> = Array.isArray(obj) ? ([...obj] as unknown as Record<string, unknown>) : { ...(obj as Record<string, unknown>) };
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const next = cur[k];
    cur[k] = Array.isArray(next) ? ([...next] as unknown as Record<string, unknown>) : { ...((next as Record<string, unknown>) ?? {}) };
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
  return root;
}

// ---------- 子字段级 JSON 编辑器（允许中间态非法，合法才上抛） ----------
function JsonField({ value, onChange, rows = 4, placeholder }: { value: unknown; onChange: (v: unknown) => void; rows?: number; placeholder?: string }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [invalid, setInvalid] = useState(false);
  // 记录最近一次由本控件上抛的序列化值；外部值与之不同才回灌，避免打字时被重排
  const lastEmitted = useRef<string>(JSON.stringify(value ?? {}, null, 2));
  useEffect(() => {
    const serialized = JSON.stringify(value ?? {}, null, 2);
    if (serialized !== lastEmitted.current) {
      lastEmitted.current = serialized;
      setText(serialized);
      setInvalid(false);
    }
  }, [value]);
  return (
    <div className={`krf-json ${invalid ? "is-invalid" : ""}`}>
      <Input.TextArea
        value={text}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder ?? "{ }"}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          try {
            const parsed = JSON.parse(next);
            lastEmitted.current = JSON.stringify(parsed, null, 2);
            onChange(parsed);
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
        style={{ fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 12 }}
      />
      {invalid && <div className="krf-json-error">JSON 格式无效，修正后才会保存</div>}
    </div>
  );
}

export interface KnowledgeRecordFormProps {
  kind: KnowledgeFormKind;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

export function KnowledgeRecordForm({ kind, value, onChange }: KnowledgeRecordFormProps) {
  const fields = KNOWLEDGE_FORM_SCHEMA[kind] ?? [];
  const update = (path: string, v: unknown) => onChange(setPath(value, path, v) as Record<string, unknown>);

  return (
    <div className="krf-grid">
      {fields.map((f) => {
        const v = getPath(value, f.path);
        const span = f.span ?? 1;
        return (
          <div key={f.path} className={`krf-field ${span === 2 ? "is-span2" : ""}`}>
            <label className="krf-label">{f.label}</label>
            {f.type === "text" && <Input value={(v as string) ?? ""} placeholder={f.placeholder} onChange={(e) => update(f.path, e.target.value)} />}
            {f.type === "textarea" && <Input.TextArea value={(v as string) ?? ""} rows={f.rows ?? 3} placeholder={f.placeholder} onChange={(e) => update(f.path, e.target.value)} />}
            {f.type === "number" && <InputNumber style={{ width: "100%" }} value={typeof v === "number" ? v : undefined} min={f.min} max={f.max} step={f.step} onChange={(n) => update(f.path, n)} />}
            {f.type === "select" && <Select style={{ width: "100%" }} value={(v as string) ?? undefined} options={f.options} onChange={(n) => update(f.path, n)} />}
            {f.type === "switch" && <Switch checked={v !== false} onChange={(n) => update(f.path, n)} />}
            {f.type === "stringList" && (
              <Select mode="tags" style={{ width: "100%" }} value={Array.isArray(v) ? (v as string[]) : []} placeholder={f.placeholder ?? "回车添加"} onChange={(n) => update(f.path, n)} open={false} suffixIcon={null} />
            )}
            {f.type === "json" && <JsonField value={v} onChange={(n) => update(f.path, n)} rows={f.rows ?? 4} placeholder={f.placeholder} />}
            {f.help && <div className="krf-help">{f.help}</div>}
          </div>
        );
      })}
    </div>
  );
}

export default KnowledgeRecordForm;
