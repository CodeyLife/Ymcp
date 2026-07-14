import { Input, InputNumber, Select, Switch } from "antd";

const FIELD_LABELS: Record<string, string> = {
  kind: "类型", title: "标题", name: "名称", summary: "摘要", description: "说明",
  order: "顺序", status: "状态", centralQuestion: "核心命题", centralConflict: "核心冲突",
  phases: "结构阶段",
  theme: "主题", genre: "题材", tone: "基调", causality: "因果", outcome: "结果",
  objective: "目标", conflict: "冲突", turningPoint: "转折", hook: "钩子",
  targetWords: "目标字数", informationRelease: "信息释放", mustHappen: "必须发生",
  flexible: "可调整", forbidden: "禁止事项", characterIds: "关联角色", locationIds: "关联地点",
  plotThreadIds: "关联剧情线", foreshadowingIds: "关联伏笔", participantIds: "参与对象",
  causeIds: "前因", consequenceIds: "后果", storyDate: "故事时间", narrativeOrder: "叙事顺序",
  relationType: "关系类型", publicLabel: "表面关系", privateTruth: "真实关系", nextMove: "下一步",
  clue: "线索表现", truth: "真实含义", urgency: "紧迫度", priority: "优先级", progress: "进度",
};

export function fieldLabel(key: string) {
  return FIELD_LABELS[key] ?? key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (value) => value.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function FriendlyValue({ value, editable, onChange, depth = 0 }: { value: unknown; editable: boolean; onChange: (value: unknown) => void; depth?: number }) {
  if (Array.isArray(value)) {
    const stringList = value.every((item) => typeof item === "string");
    if (stringList) return editable
      ? <Select mode="tags" value={value.map(String)} onChange={onChange} open={false} tokenSeparators={[",", "，"]} placeholder="暂无内容" />
      : <div className="novel-data-tags">{value.length ? value.map((item, index) => <span key={`${String(item)}-${index}`}>{String(item)}</span>) : <em>暂无内容</em>}</div>;
    return <div className="novel-data-list">{value.map((item, index) => <section key={index}><header>第 {index + 1} 项</header><FriendlyValue value={item} editable={editable} depth={depth + 1} onChange={(next) => onChange(value.map((current, itemIndex) => itemIndex === index ? next : current))} /></section>)}</div>;
  }
  if (isRecord(value)) {
    return <div className={`novel-data-object depth-${Math.min(depth, 2)}`}>{Object.entries(value).map(([key, item]) => <div key={key} className={`novel-data-field${isRecord(item) || Array.isArray(item) && item.some(isRecord) ? " wide" : ""}`}><span>{fieldLabel(key)}</span><FriendlyValue value={item} editable={editable} depth={depth + 1} onChange={(next) => onChange({ ...value, [key]: next })} /></div>)}</div>;
  }
  if (typeof value === "boolean") return editable ? <Switch checked={value} onChange={onChange} /> : <strong>{value ? "是" : "否"}</strong>;
  if (typeof value === "number") return editable ? <InputNumber value={value} onChange={(next) => onChange(next ?? 0)} /> : <strong>{value}</strong>;
  if (editable) {
    const text = value == null ? "" : String(value);
    return text.length > 72 || text.includes("\n")
      ? <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} value={text} onChange={(event) => onChange(event.target.value)} />
      : <Input value={text} onChange={(event) => onChange(event.target.value)} />;
  }
  return <p>{value == null || value === "" ? "尚未设定" : String(value)}</p>;
}

export default function ProposalDataCard({ value, editable = false, onChange }: { value: Record<string, unknown>; editable?: boolean; onChange?: (value: Record<string, unknown>) => void }) {
  return <div className="novel-proposal-data-card"><FriendlyValue value={value} editable={editable} onChange={(next) => { if (isRecord(next)) onChange?.(next); }} /></div>;
}
