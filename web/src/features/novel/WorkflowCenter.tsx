import { useState } from "react";
import { App, Button, Empty, Input, Progress, Spin, Tag, Tooltip } from "antd";
import { CheckOutlined, CloseOutlined, PauseOutlined, PlayCircleOutlined, ReloadOutlined, StopOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import { novelDb } from "./db";
import { setFactCandidateStatus } from "./facts";
import { QUALITY_DIMENSION_LABELS } from "./quality";
import { approveWorkflowStage, BUILTIN_CHAPTER_WORKFLOW, cancelWorkflow, pauseWorkflow, resumeWorkflow, startChapterWorkflow } from "./workflow";
import type { FactCandidate, ManuscriptDocument, QualityReport, WorkflowArtifact, WorkflowStage } from "./types";
import { MarkdownContent } from "./AIWorkbench";

const STAGE_LABELS: Record<WorkflowStage, string> = {
  context: "冻结上下文", blueprint: "生成蓝图", "blueprint-approval": "蓝图审批", draft: "正文草稿", "deterministic-check": "规则检查", review: "专业审校", revision: "定向修订", "manuscript-approval": "正文审批", "fact-extraction": "事实提取", "fact-approval": "事实审批", commit: "正式提交",
};

function artifactForStage(run: { currentStage: WorkflowStage; blueprintArtifactId?: string; draftArtifactId?: string }, artifacts: WorkflowArtifact[]) {
  if (run.currentStage === "blueprint-approval") return artifacts.find((item) => item.id === run.blueprintArtifactId);
  if (run.currentStage === "manuscript-approval") return artifacts.find((item) => item.id === run.draftArtifactId);
  if (run.currentStage === "fact-approval") return artifacts.find((item) => item.kind === "fact-delta");
  return artifacts.at(-1);
}

export default function WorkflowCenter({ projectId, document }: { projectId: string; document?: ManuscriptDocument }) {
  const { message } = App.useApp();
  const runs = useLiveQuery(() => novelDb.workflowRuns.where("projectId").equals(projectId).reverse().sortBy("createdAt"), [projectId]) ?? [];
  const run = runs[0];
  const queriedArtifacts = useLiveQuery(async (): Promise<WorkflowArtifact[]> => run ? await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).sortBy("createdAt") : [], [run?.id]);
  const artifacts: WorkflowArtifact[] = queriedArtifacts ?? [];
  const report = useLiveQuery(async (): Promise<QualityReport | undefined> => run?.qualityReportId ? await novelDb.qualityReports.get(run.qualityReportId) : undefined, [run?.qualityReportId]);
  const queriedFacts = useLiveQuery(async (): Promise<FactCandidate[]> => run ? await novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray() : [], [run?.id]);
  const facts: FactCandidate[] = queriedFacts ?? [];
  const [instruction, setInstruction] = useState("依据当前章节蓝图、场景计划和故事状态，完成本章正文、审校与事实更新。");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const approvalArtifact = run ? artifactForStage(run, artifacts) : undefined;
  const active = run && !["completed", "cancelled"].includes(run.status);
  const pendingFacts = facts.filter((item) => item.status === "pending").length;

  async function perform(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    try { await action(); if (success) message.success(success); }
    catch (error) { message.error(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  }

  return <div className="novel-view-content novel-workflow-center">
    <header className="novel-section-title"><div><span>CONTROLLED AGENT PIPELINE</span><h2>章节创作流程</h2><p>每个产物、审校证据和正式变更都沿同一条可恢复链路推进。</p></div>{active && <div className="novel-workflow-controls">{run.status === "paused" || run.status === "failed" ? <Button icon={<PlayCircleOutlined />} onClick={() => void perform(() => resumeWorkflow(run.id), "工作流已恢复")}>恢复</Button> : run.status === "running" ? <Button icon={<PauseOutlined />} onClick={() => void perform(() => pauseWorkflow(run.id))}>暂停</Button> : null}<Button danger icon={<StopOutlined />} onClick={() => void perform(() => cancelWorkflow(run.id))}>取消</Button></div>}</header>

    {!document ? <Empty description="请先选择一个章节" /> : !active ? <section className="novel-workflow-launch"><div><span>STANDARD CHAPTER v2</span><h3>{document.title}</h3><p>先审批蓝图，再自动完成草稿、规则检查、五类独立审校和最多两轮定向修订。正文与事实分别确认。</p></div><Input.TextArea value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={5} /><Button type="primary" size="large" loading={busy} icon={<ThunderboltOutlined />} onClick={() => void perform(() => startChapterWorkflow({ projectId, documentId: document.id, instruction }), "工作流已启动")}>启动标准流程</Button></section> : <>
      <section className="novel-workflow-status"><div><Tag color={run.status === "failed" ? "red" : run.status === "waiting-approval" ? "gold" : run.status === "completed" ? "green" : "processing"}>{run.status}</Tag><strong>{STAGE_LABELS[run.currentStage]}</strong><span>第 {run.revisionIteration + 1} 轮 · {artifacts.length} 个产物</span></div>{busy && <Spin size="small" />} {run.error && <p>{run.error}</p>}</section>
      <div className="novel-workflow-rail">{BUILTIN_CHAPTER_WORKFLOW.stages.map((stage, index) => <Tooltip key={stage} title={STAGE_LABELS[stage]}><div className={index < run.stageIndex ? "done" : index === run.stageIndex ? "active" : ""}><i>{index < run.stageIndex ? <CheckOutlined /> : index + 1}</i><span>{STAGE_LABELS[stage]}</span></div></Tooltip>)}</div>

      {report && <section className="novel-quality-report"><header><div><span>QUALITY GATE</span><h3>{report.passed ? "质量门禁通过" : "需要修订或人工决策"}</h3></div><div className="novel-quality-score"><strong>{report.weightedScore}</strong><span>/ 5</span></div></header><div className="novel-quality-dimensions">{Object.entries(report.scores).map(([dimension, score]) => <div key={dimension}><label><span>{QUALITY_DIMENSION_LABELS[dimension as keyof typeof QUALITY_DIMENSION_LABELS]}</span><b>{score.toFixed(1)}</b></label><Progress percent={score / 5 * 100} showInfo={false} strokeColor={score < 3 ? "#b5483a" : "#7d9c8b"} trailColor="#292b2e" /></div>)}</div><div className="novel-quality-issues">{report.issues.slice(0, 12).map((issue) => <article key={issue.id} className={issue.severity}><Tag color={issue.severity === "blocker" ? "red" : issue.severity === "major" ? "orange" : undefined}>{issue.severity}</Tag><div><strong>{issue.title}</strong><p>{issue.description}</p>{issue.excerpt && <blockquote>{issue.excerpt}</blockquote>}<small>{issue.rule} · {issue.deterministic ? "确定性检查" : "独立审校"}</small></div></article>)}</div></section>}

      {run.status === "waiting-approval" && <section className="novel-approval-desk"><header><span>HUMAN GATE</span><h3>{STAGE_LABELS[run.currentStage]}</h3></header>{approvalArtifact && <MarkdownContent content={approvalArtifact.contentMarkdown} />}
        {run.currentStage === "fact-approval" && <div className="novel-fact-list">{facts.map((fact) => <article key={fact.id} className={fact.status}><div><Tag color={fact.conflict ? "red" : fact.status === "accepted" ? "green" : fact.status === "rejected" ? "default" : "gold"}>{fact.conflict ? "冲突" : fact.status}</Tag><strong>{fact.targetTable}.{fact.field}</strong><p>{String(fact.after)}</p><blockquote>{fact.evidence}</blockquote><small>置信度 {Math.round(fact.confidence * 100)}% · {fact.novelty}</small></div><div><Button type={fact.status === "accepted" ? "primary" : "default"} icon={<CheckOutlined />} disabled={fact.conflict} onClick={() => void setFactCandidateStatus(fact.id, "accepted")}>采纳</Button><Button icon={<CloseOutlined />} onClick={() => void setFactCandidateStatus(fact.id, "rejected")}>排除</Button></div></article>)}</div>}
        {run.currentStage !== "fact-approval" && <Input.TextArea rows={3} value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="退回时填写具体修改要求；批准可留空。" />}
        <footer><Button danger icon={<CloseOutlined />} loading={busy} onClick={() => void perform(() => approveWorkflowStage(run.id, { approved: false, feedback }), "已退回流程")}>{run.currentStage === "fact-approval" ? "全部不提交" : "退回修改"}</Button><Button type="primary" icon={<CheckOutlined />} loading={busy} disabled={run.currentStage === "fact-approval" && pendingFacts > 0} onClick={() => void perform(() => approveWorkflowStage(run.id, { approved: true, feedback }), "审批已提交")}>{run.currentStage === "fact-approval" ? `提交已采纳事实${pendingFacts ? `（尚有 ${pendingFacts} 项未决定）` : ""}` : "批准并继续"}</Button></footer>
      </section>}

      <section className="novel-artifact-ledger"><header><span>ARTIFACT LEDGER</span><h3>工作产物</h3></header>{artifacts.map((artifact) => <article key={artifact.id}><i>{artifact.kind.slice(0, 2).toUpperCase()}</i><div><strong>{artifact.title}</strong><p>{artifact.contentMarkdown.slice(0, 140)}</p><small>{STAGE_LABELS[artifact.stage]} · {artifact.skillRefs.length} Skills · {new Date(artifact.createdAt).toLocaleTimeString("zh-CN")}</small></div></article>)}</section>
      {run.status === "failed" && <Button icon={<ReloadOutlined />} onClick={() => void perform(() => resumeWorkflow(run.id))}>从失败步骤重试</Button>}
    </>}
  </div>;
}
