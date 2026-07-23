import { Button, Input, Select, Tooltip } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { motion } from "motion/react";

import type { ArchitecturePhase, GrowthCurve, StoryArchitecture } from "./types";

export type ArchitectureEditableData = Pick<StoryArchitecture, "framework" | "status" | "centralQuestion" | "centralConflict" | "synopsis" | "phases" | "growthCurves">;

const FRAMEWORK_OPTIONS = [
  { value: "free", label: "自由结构" },
  { value: "three-act", label: "三幕式" },
  { value: "four-part", label: "起承转合" },
  { value: "save-the-cat", label: "Save the Cat" },
  { value: "snowflake", label: "雪花写作法" },
];

const STATUS_OPTIONS = [
  { value: "draft", label: "草案" },
  { value: "approved", label: "已批准" },
];

export function isArchitectureData(value: Record<string, unknown>): value is Record<string, unknown> & ArchitectureEditableData {
  return typeof value.framework === "string" && Array.isArray(value.phases);
}

export default function ArchitectureDataEditor({
  value,
  compareTo,
  onChange,
  readOnly = false,
  preview = false,
  showPhases = true,
}: {
  value: ArchitectureEditableData;
  compareTo?: ArchitectureEditableData;
  onChange?: (next: ArchitectureEditableData) => void;
  readOnly?: boolean;
  preview?: boolean;
  showPhases?: boolean;
}) {
  const comparing = Boolean(compareTo);
  const changeState = (current: unknown, compared: unknown) => comparing ? current === compared ? "unchanged" : "changed" : undefined;
  const update = (changes: Partial<ArchitectureEditableData>) => onChange?.({ ...value, ...changes });
  const updatePhase = (id: string, changes: Partial<ArchitecturePhase>) => update({ phases: value.phases.map((item) => item.id === id ? { ...item, ...changes } : item) });
  const growthCurves = value.growthCurves ?? [];
  const comparedGrowthCurves = compareTo?.growthCurves ?? [];
  const updateGrowthCurve = (id: string, changes: Partial<GrowthCurve>) => update({ growthCurves: growthCurves.map((item) => item.id === id ? { ...item, ...changes } : item) });
  const removeGrowthCurve = (id: string) => update({
    growthCurves: growthCurves.filter((item) => item.id !== id),
    phases: value.phases.map((phase) => phase.primaryCurveId === id ? { ...phase, primaryCurveId: "" } : phase),
  });
  const curveOptions = growthCurves.map((curve) => ({ value: curve.id, label: `${curve.kind === "main" ? "主线" : "生态"} · ${curve.subject || "未命名曲线"}` }));

  return <div className={`novel-architecture-data-editor${preview ? " preview" : ""}${readOnly ? " read-only" : ""}`}>
    <div className="novel-architecture-form">
      <section className="novel-architecture-meta">
        <label data-change-state={changeState(value.framework, compareTo?.framework)}><span>结构方法</span><Select value={value.framework} options={FRAMEWORK_OPTIONS} disabled={readOnly} onChange={(framework) => update({ framework })} /></label>
        <label data-change-state={changeState(value.status, compareTo?.status)}><span>架构状态</span><Select value={value.status} options={STATUS_OPTIONS} disabled={readOnly} onChange={(status) => update({ status })} /></label>
      </section>
      <label className="novel-architecture-core-field" data-change-state={changeState(value.centralQuestion, compareTo?.centralQuestion)}><span>核心问题</span><Input.TextArea readOnly={readOnly} rows={3} placeholder="贯穿全书、最终必须回答的问题" value={value.centralQuestion} onChange={(event) => update({ centralQuestion: event.target.value })} /></label>
      <label className="novel-architecture-core-field" data-change-state={changeState(value.centralConflict, compareTo?.centralConflict)}><span>核心冲突</span><Input.TextArea readOnly={readOnly} rows={3} placeholder="推动主角持续行动的主要矛盾" value={value.centralConflict} onChange={(event) => update({ centralConflict: event.target.value })} /></label>
      <label className="wide" data-change-state={changeState(value.synopsis, compareTo?.synopsis)}><span>全书梗概</span><Input.TextArea readOnly={readOnly} rows={6} placeholder="用一段连续叙述概括起因、升级、转折与结局" value={value.synopsis} onChange={(event) => update({ synopsis: event.target.value })} /></label>
    </div>
    {showPhases && <section className="novel-architecture-curves"><header><div><h3>增长曲线</h3><span>{growthCurves.length} 条</span></div>{!readOnly && <Button className="novel-architecture-add" icon={<PlusOutlined />} onClick={() => update({ growthCurves: [...growthCurves, { id: crypto.randomUUID(), kind: growthCurves.some((curve) => curve.kind === "main") ? "ecological" : "main", subject: "", resourceLoop: "", stageGoals: "", irreversibleChange: "" }] })}>添加曲线</Button>}</header>
      <div className="novel-architecture-curve-list">
        {growthCurves.map((curve, index) => {
          const comparedCurve = comparedGrowthCurves.find((item) => item.id === curve.id);
          const curveChanged = !comparedCurve || curve.kind !== comparedCurve.kind || curve.subject !== comparedCurve.subject || curve.resourceLoop !== comparedCurve.resourceLoop || curve.stageGoals !== comparedCurve.stageGoals || curve.irreversibleChange !== comparedCurve.irreversibleChange;
          return <article key={curve.id} data-change-state={comparing ? curveChanged ? "changed" : "unchanged" : undefined}><div className="novel-curve-index"><span>曲线</span><strong>{String(index + 1).padStart(2, "0")}</strong></div><div className="novel-curve-fields"><label data-change-state={changeState(curve.kind, comparedCurve?.kind)}><span>类型</span><Select value={curve.kind} disabled={readOnly} options={[{ value: "main", label: "主线增长曲线" }, { value: "ecological", label: "生态增长曲线" }]} onChange={(kind) => updateGrowthCurve(curve.id, { kind })} /></label><label data-change-state={changeState(curve.subject, comparedCurve?.subject)}><span>生态主体</span><Input readOnly={readOnly} placeholder="驱动此曲线的势力、体系或群体" value={curve.subject} onChange={(event) => updateGrowthCurve(curve.id, { subject: event.target.value })} /></label><label data-change-state={changeState(curve.resourceLoop, comparedCurve?.resourceLoop)}><span>资源循环</span><Input.TextArea readOnly={readOnly} rows={2} placeholder="资源如何获取、流转与消耗" value={curve.resourceLoop} onChange={(event) => updateGrowthCurve(curve.id, { resourceLoop: event.target.value })} /></label><label data-change-state={changeState(curve.stageGoals, comparedCurve?.stageGoals)}><span>阶段目标</span><Input.TextArea readOnly={readOnly} rows={2} placeholder="各阶段如何推进这条曲线" value={curve.stageGoals} onChange={(event) => updateGrowthCurve(curve.id, { stageGoals: event.target.value })} /></label><label className="wide" data-change-state={changeState(curve.irreversibleChange, comparedCurve?.irreversibleChange)}><span>不可逆变化</span><Input.TextArea readOnly={readOnly} rows={2} placeholder="曲线结束时世界发生的结构性变化" value={curve.irreversibleChange} onChange={(event) => updateGrowthCurve(curve.id, { irreversibleChange: event.target.value })} /></label></div>{!readOnly && <Tooltip title="删除增长曲线"><Button className="novel-phase-delete" danger type="text" aria-label={`删除增长曲线${curve.subject || index + 1}`} icon={<DeleteOutlined />} onClick={() => removeGrowthCurve(curve.id)} /></Tooltip>}</article>;
        })}
      </div>
    </section>}
    {showPhases && <section className="novel-architecture-beats"><header><div><h3>幕（宏观阶段）</h3><span>{value.phases.length} 幕</span></div>{!readOnly && <Button className="novel-architecture-add" icon={<PlusOutlined />} onClick={() => update({ phases: [...value.phases, { id: crypto.randomUUID(), title: `第 ${value.phases.length + 1} 幕`, purpose: "", turningPoint: "", order: value.phases.length, locked: false, primaryCurveId: "" }] })}>添加幕</Button>}</header>
      <div className="novel-architecture-phase-list">
        {value.phases.map((phase, index) => {
          const comparedPhase = compareTo?.phases.find((item) => item.id === phase.id);
          const phaseChanged = !comparedPhase || phase.title !== comparedPhase.title || phase.purpose !== comparedPhase.purpose || phase.turningPoint !== comparedPhase.turningPoint || phase.order !== comparedPhase.order || phase.locked !== comparedPhase.locked || phase.primaryCurveId !== comparedPhase.primaryCurveId;
          return <motion.article data-change-state={comparing ? phaseChanged ? "changed" : "unchanged" : undefined} layout={!readOnly} initial={preview ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .28, delay: preview ? 0 : Math.min(index * .04, .2) }} key={phase.id}><div className="novel-phase-index"><span>幕</span><strong>{String(index + 1).padStart(2, "0")}</strong></div><div className="novel-phase-fields"><label className="novel-phase-title" data-change-state={changeState(phase.title, comparedPhase?.title)}><span>幕标题</span><Input readOnly={readOnly} value={phase.title} onChange={(event) => updatePhase(phase.id, { title: event.target.value })} /></label><label data-change-state={changeState(phase.primaryCurveId, comparedPhase?.primaryCurveId)}><span>主要增长曲线</span><Select allowClear placeholder="选择本幕的主要驱动力" value={phase.primaryCurveId || undefined} disabled={readOnly} options={curveOptions} onChange={(primaryCurveId) => updatePhase(phase.id, { primaryCurveId: primaryCurveId ?? "" })} /></label><label data-change-state={changeState(phase.purpose, comparedPhase?.purpose)}><span>叙事使命</span><Input.TextArea readOnly={readOnly} rows={2} placeholder="本幕必须完成的叙事使命" value={phase.purpose} onChange={(event) => updatePhase(phase.id, { purpose: event.target.value })} /></label><label data-change-state={changeState(phase.turningPoint, comparedPhase?.turningPoint)}><span>不可逆转折</span><Input.TextArea readOnly={readOnly} rows={2} placeholder="结束时改变故事方向的决定性变化" value={phase.turningPoint} onChange={(event) => updatePhase(phase.id, { turningPoint: event.target.value })} /></label></div>{!readOnly && <Tooltip title="删除幕"><Button className="novel-phase-delete" danger type="text" aria-label={`删除${phase.title || `第 ${index + 1} 幕`}`} icon={<DeleteOutlined />} onClick={() => update({ phases: value.phases.filter((item) => item.id !== phase.id).map((item, order) => ({ ...item, order })) })} /></Tooltip>}</motion.article>;
        })}
      </div>
    </section>}
  </div>;
}
