import { useMemo, useState } from "react";
import { App, Button, Empty, Input, Modal, Segmented, Select, Tag, Tooltip } from "antd";
import { AuditOutlined, ExperimentOutlined, PlusOutlined, ReloadOutlined, RollbackOutlined, RocketOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import {
  createCraftRuleCandidate,
  evaluateCraftRuleGate,
  evaluateCraftRuleOnFoundation,
  evaluateCraftRuleOnChapter,
  FOUNDATION_EVALUATION_TASKS,
  promoteCraftRuleCandidate,
  rollbackCraftRuleCandidate,
  submitCraftRuleReview,
  supportsChapterRuleEvaluation,
} from "./craft-rule-evolution";
import { novelDb } from "./db";
import { listPromptTemplates } from "./prompt-templates";
import { listAvailableSkills } from "./skills";
import type { CraftRuleCandidate, CraftRuleReviewRole, CraftRuleScopeAnalysis, CraftRuleTargetKind } from "./types";

const REVIEW_ROLES: Array<{ value: CraftRuleReviewRole; label: string }> = [
  { value: "plot-editor", label: "剧情" },
  { value: "character-editor", label: "人物" },
  { value: "prose-editor", label: "文笔" },
  { value: "long-form-editor", label: "长篇" },
];

const STATUS_LABELS: Record<CraftRuleCandidate["status"], string> = {
  proposed: "待评测",
  evaluating: "评测中",
  ready: "可晋升",
  rejected: "需重构",
  promoted: "已生效",
  "rolled-back": "已回滚",
};

const EMPTY_SCOPE: CraftRuleScopeAnalysis = {
  observedSymptom: "",
  failingLayer: "",
  underlyingMechanism: "",
  affectedInputClass: "",
  intendedBenefits: [],
  boundaries: [],
  nonGoals: [],
  regressionRisks: [],
};

function lines(value: string) {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

function latestReviews(candidate: CraftRuleCandidate) {
  return Object.fromEntries(candidate.reviews.map((review) => [review.role, review])) as Partial<Record<CraftRuleReviewRole, CraftRuleCandidate["reviews"][number]>>;
}

export default function CraftRuleGovernance({ projectId }: { projectId: string }) {
  const { message } = App.useApp();
  const candidates = useLiveQuery(() => novelDb.craftRuleCandidates.where("projectId").equals(projectId).reverse().sortBy("updatedAt"), [projectId]) ?? [];
  const skills = useLiveQuery(() => listAvailableSkills(projectId), [projectId]) ?? [];
  const prompts = useLiveQuery(() => listPromptTemplates(projectId), [projectId]) ?? [];
  const documents = useLiveQuery(() => novelDb.documents.where("projectId").equals(projectId).and((item) => !item.deletedAt).sortBy("order"), [projectId]) ?? [];
  const [createOpen, setCreateOpen] = useState(false);
  const [activeId, setActiveId] = useState<string>();
  const [targetKind, setTargetKind] = useState<CraftRuleTargetKind>("skill");
  const [targetId, setTargetId] = useState("");
  const [afterText, setAfterText] = useState("");
  const [rationale, setRationale] = useState("");
  const [scopeText, setScopeText] = useState<Record<keyof CraftRuleScopeAnalysis, string>>({
    observedSymptom: "", failingLayer: "", underlyingMechanism: "", affectedInputClass: "",
    intendedBenefits: "", boundaries: "", nonGoals: "", regressionRisks: "",
  });
  const [evaluationDocumentId, setEvaluationDocumentId] = useState("");
  const [foundationTaskKey, setFoundationTaskKey] = useState<typeof FOUNDATION_EVALUATION_TASKS[number]>("project-positioning");
  const [scenarioClass, setScenarioClass] = useState("");
  const [reviewRole, setReviewRole] = useState<CraftRuleReviewRole>("plot-editor");
  const [reviewVerdict, setReviewVerdict] = useState<"passed" | "revise" | "rejected">("passed");
  const [reviewSummary, setReviewSummary] = useState("");
  const [reviewConcerns, setReviewConcerns] = useState("");
  const [reviewerId, setReviewerId] = useState("author-reviewer");
  const [busy, setBusy] = useState<string>();

  const active = candidates.find((item) => item.id === activeId);
  const gate = active ? evaluateCraftRuleGate(active) : undefined;
  const reviewMap = active ? latestReviews(active) : {};
  const eligibleSkills = skills;
  const eligiblePrompts = prompts;
  const targetOptions = targetKind === "skill"
    ? eligibleSkills.map((item) => ({ value: item.skillId, label: `${item.name} · ${item.version}` }))
    : eligiblePrompts.map((item) => ({ value: item.templateId, label: `${item.name} · ${item.version}` }));
  const targetSource = useMemo(() => targetKind === "skill"
    ? skills.find((item) => item.skillId === targetId)?.prompt
    : prompts.find((item) => item.templateId === targetId)?.content, [afterText, prompts, skills, targetId, targetKind]);
  const activeStages = active?.targetKind === "skill"
    ? skills.find((item) => item.skillId === active.targetId)?.stages ?? []
    : prompts.find((item) => item.templateId === active?.targetId)?.stages ?? [];
  const activeUsesChapterEvaluation = supportsChapterRuleEvaluation(activeStages);

  function chooseTarget(kind: CraftRuleTargetKind, id: string) {
    setTargetKind(kind);
    setTargetId(id);
    const source = kind === "skill" ? skills.find((item) => item.skillId === id)?.prompt : prompts.find((item) => item.templateId === id)?.content;
    setAfterText(source ?? "");
  }

  function openCreate() {
    const first = eligibleSkills[0];
    setTargetKind("skill");
    setTargetId(first?.skillId ?? "");
    setAfterText(first?.prompt ?? "");
    setRationale("");
    setScopeText({ observedSymptom: "", failingLayer: "", underlyingMechanism: "", affectedInputClass: "", intendedBenefits: "", boundaries: "", nonGoals: "", regressionRisks: "" });
    setCreateOpen(true);
  }

  async function createCandidate() {
    setBusy("create");
    try {
      const scope: CraftRuleScopeAnalysis = {
        ...EMPTY_SCOPE,
        observedSymptom: scopeText.observedSymptom,
        failingLayer: scopeText.failingLayer,
        underlyingMechanism: scopeText.underlyingMechanism,
        affectedInputClass: scopeText.affectedInputClass,
        intendedBenefits: lines(scopeText.intendedBenefits),
        boundaries: lines(scopeText.boundaries),
        nonGoals: lines(scopeText.nonGoals),
        regressionRisks: lines(scopeText.regressionRisks),
      };
      const candidate = await createCraftRuleCandidate({ projectId, targetKind, targetId, afterText, rationale, scope });
      setCreateOpen(false);
      setActiveId(candidate.id);
      message.success("规则候选已创建");
    } catch (error) { message.error(error instanceof Error ? error.message : "创建失败"); }
    finally { setBusy(undefined); }
  }

  async function runEvaluation() {
    if (!active) return;
    setBusy("evaluate");
    try {
      if (activeUsesChapterEvaluation) await evaluateCraftRuleOnChapter({ candidateId: active.id, documentId: evaluationDocumentId, scenarioClass });
      else await evaluateCraftRuleOnFoundation({ candidateId: active.id, taskKey: foundationTaskKey, scenarioClass });
      setScenarioClass("");
      message.success("A/B 评测证据已登记");
    } catch (error) { message.error(error instanceof Error ? error.message : "评测失败"); }
    finally { setBusy(undefined); }
  }

  async function submitReview() {
    if (!active) return;
    setBusy("review");
    try {
      await submitCraftRuleReview({ candidateId: active.id, role: reviewRole, reviewer: "user", reviewerId, reviewRunId: crypto.randomUUID(), verdict: reviewVerdict, summary: reviewSummary, concerns: lines(reviewConcerns) });
      setReviewSummary(""); setReviewConcerns("");
      message.success("审核结论已记录");
    } catch (error) { message.error(error instanceof Error ? error.message : "审核失败"); }
    finally { setBusy(undefined); }
  }

  async function changeStatus(action: "promote" | "rollback") {
    if (!active) return;
    setBusy(action);
    try {
      if (action === "promote") {
        const candidate = await promoteCraftRuleCandidate(active.id);
        if (candidate.status === "rolled-back") message.error(`晋升后回归失败，已自动回滚：${candidate.promotionValidation?.summary ?? "未通过原失败场景验证"}`);
        else message.success(candidate.promotionValidation?.status === "passed" ? "新版本已生效，原失败场景回归通过" : "新版本已生效");
      } else {
        await rollbackCraftRuleCandidate(active.id);
        message.success("已切回评测前版本");
      }
    } catch (error) { message.error(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(undefined); }
  }

  return <section className="novel-rule-governance">
    <header><div><span>VERSIONED GOVERNANCE</span><h3>规则候选</h3></div><Button icon={<PlusOutlined />} onClick={openCreate}>新建候选</Button></header>
    {candidates.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无规则候选" /> : <div className="novel-rule-list">
      {candidates.map((candidate) => {
        const candidateGate = evaluateCraftRuleGate(candidate);
        const passedReviews = Object.values(candidateGate.latestReviews).filter((review) => review?.verdict === "passed").length;
        return <article key={candidate.id}>
          <div className={`novel-rule-state ${candidate.status}`}>{candidate.status === "promoted" ? <RocketOutlined /> : candidate.status === "rolled-back" ? <RollbackOutlined /> : <AuditOutlined />}</div>
          <div><header><strong>{candidate.targetId}</strong><Tag>{candidate.beforeVersion} → {candidate.proposedVersion}</Tag><Tag color={candidateGate.ready ? "green" : candidate.status === "rejected" ? "red" : "gold"}>{STATUS_LABELS[candidate.status]}</Tag></header><p>{candidate.rationale}</p></div>
          <div className="novel-rule-metrics"><span>{candidate.evidenceCases.length}/3 场景</span><span>{passedReviews}/4 审核</span><span>{candidateGate.averageScoreDelta >= 0 ? "+" : ""}{candidateGate.averageScoreDelta.toFixed(2)}</span></div>
          <Tooltip title="打开规则治理"><Button type="text" aria-label="打开规则治理" icon={<AuditOutlined />} onClick={() => { setActiveId(candidate.id); setEvaluationDocumentId(documents[0]?.id ?? ""); }} /></Tooltip>
        </article>;
      })}
    </div>}

    <Modal title="新建规则候选" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => void createCandidate()} confirmLoading={busy === "create"} okText="创建候选" width={880}>
      <div className="novel-rule-form">
        <label><span>目标类型</span><Segmented value={targetKind} options={[{ value: "skill", label: "Skill" }, { value: "system-prompt", label: "系统 Prompt" }]} onChange={(value) => { const kind = value as CraftRuleTargetKind; const firstId = kind === "skill" ? eligibleSkills[0]?.skillId : eligiblePrompts[0]?.templateId; chooseTarget(kind, firstId ?? ""); }} /></label>
        <label><span>目标版本</span><Select value={targetId || undefined} options={targetOptions} onChange={(value) => chooseTarget(targetKind, value)} /></label>
        <label className="wide"><span>候选内容</span><Input.TextArea rows={10} value={afterText} onChange={(event) => setAfterText(event.target.value)} /></label>
        <label className="wide"><span>修改理由</span><Input value={rationale} onChange={(event) => setRationale(event.target.value)} /></label>
        {(["observedSymptom", "failingLayer", "underlyingMechanism", "affectedInputClass"] as const).map((key) => <label key={key}><span>{{ observedSymptom: "观察症状", failingLayer: "失效层", underlyingMechanism: "底层机制", affectedInputClass: "输入类别" }[key]}</span><Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={scopeText[key]} onChange={(event) => setScopeText((current) => ({ ...current, [key]: event.target.value }))} /></label>)}
        {(["intendedBenefits", "boundaries", "nonGoals", "regressionRisks"] as const).map((key) => <label key={key}><span>{{ intendedBenefits: "预期收益（每行一项）", boundaries: "适用边界（每行一项）", nonGoals: "非目标（每行一项）", regressionRisks: "回归风险（每行一项）" }[key]}</span><Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} value={scopeText[key]} onChange={(event) => setScopeText((current) => ({ ...current, [key]: event.target.value }))} /></label>)}
        {targetSource && targetSource !== afterText && <small className="wide">基线内容已保留为不可变版本，候选不会立即生效。</small>}
      </div>
    </Modal>

    <Modal title={active ? `${active.targetId} · ${active.proposedVersion}` : "规则治理"} open={Boolean(active)} onCancel={() => setActiveId(undefined)} footer={null} width={920}>
      {active && gate && <div className="novel-rule-detail">
        <div className="novel-rule-gate"><Tag color={gate.ready ? "green" : "gold"}>{STATUS_LABELS[active.status]}</Tag><strong>平均变化 {gate.averageScoreDelta >= 0 ? "+" : ""}{gate.averageScoreDelta.toFixed(2)}</strong>{gate.reasons.map((reason) => <span key={reason}>{reason}</span>)}</div>
        {active.learningSource && <section><header><h4>Learning 来源</h4><Tag>{active.learningSource.kind === "external-review" ? "外部审核" : "章节审校"}</Tag></header><p>{active.scope.underlyingMechanism}</p><small>{active.scope.affectedInputClass} · {active.learningSource.issueIds.length} 个关联问题</small></section>}
        {active.promotionValidation && <section><header><h4>晋升回归</h4><Tag color={active.promotionValidation.status === "passed" ? "green" : active.promotionValidation.status === "failed" ? "red" : "gold"}>{active.promotionValidation.status}</Tag></header><p>{active.promotionValidation.summary}</p><small>{active.promotionValidation.scenarioClass} · {active.promotionValidation.activeVersion ?? "版本未知"}</small></section>}
        <section><header><h4>跨场景证据</h4><ExperimentOutlined /></header><div className="novel-rule-evidence">{active.evidenceCases.map((item) => <div key={item.caseId}><strong>{item.scenarioClass}</strong><span>{item.subjectKind === "chapter" ? documents.find((doc) => doc.id === item.documentId)?.title ?? item.subjectId : item.subjectId.replace("foundation:", "")}</span><span>{item.baselineScore.toFixed(2)} → {item.candidateScore.toFixed(2)}</span></div>)}{active.evidenceCases.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无评测证据" />}</div>{!["promoted", "rolled-back"].includes(active.status) && <div className="novel-rule-inline-form">{activeUsesChapterEvaluation ? <Select value={evaluationDocumentId || undefined} placeholder="评测章节" options={documents.map((item) => ({ value: item.id, label: `${item.order + 1}. ${item.title}` }))} onChange={setEvaluationDocumentId} /> : <Select value={foundationTaskKey} options={FOUNDATION_EVALUATION_TASKS.map((value) => ({ value, label: value }))} onChange={setFoundationTaskKey} />}<Input value={scenarioClass} placeholder="场景说明" onChange={(event) => setScenarioClass(event.target.value)} /><Button icon={<ExperimentOutlined />} loading={busy === "evaluate"} disabled={(activeUsesChapterEvaluation && !evaluationDocumentId) || !scenarioClass.trim()} onClick={() => void runEvaluation()}>运行 A/B</Button></div>}</section>
        <section><header><h4>专业审核</h4><AuditOutlined /></header><div className="novel-rule-review-grid">{REVIEW_ROLES.map((role) => { const review = reviewMap[role.value]; return <div key={role.value}><span>{role.label}</span><Tag color={review?.verdict === "passed" ? "green" : review?.verdict === "rejected" ? "red" : "default"}>{review ? review.verdict : "待审核"}</Tag><small>{review ? `${review.reviewerId} · ${review.summary}` : ""}</small></div>; })}</div>{!["promoted", "rolled-back"].includes(active.status) && <div className="novel-rule-review-form"><Select value={reviewRole} options={REVIEW_ROLES} onChange={setReviewRole} /><Select value={reviewVerdict} options={[{ value: "passed", label: "通过" }, { value: "revise", label: "需修订" }, { value: "rejected", label: "拒绝" }]} onChange={setReviewVerdict} /><Input value={reviewerId} placeholder="审核主体标识" onChange={(event) => setReviewerId(event.target.value)} /><Input value={reviewSummary} placeholder="审核结论" onChange={(event) => setReviewSummary(event.target.value)} /><Input.TextArea rows={2} value={reviewConcerns} placeholder="顾虑，每行一项" onChange={(event) => setReviewConcerns(event.target.value)} /><Button icon={<ReloadOutlined />} loading={busy === "review"} disabled={!reviewerId.trim() || !reviewSummary.trim()} onClick={() => void submitReview()}>记录审核</Button></div>}</section>
        <footer>{active.status === "ready" && <Button type="primary" icon={<RocketOutlined />} loading={busy === "promote"} onClick={() => void changeStatus("promote")}>晋升新版本</Button>}{active.status === "promoted" && <Button danger icon={<RollbackOutlined />} loading={busy === "rollback"} onClick={() => void changeStatus("rollback")}>回滚版本</Button>}</footer>
      </div>}
    </Modal>
  </section>;
}
