import { useEffect, useState } from "react";
import { App, Button, Empty, Input, Modal, Progress, Spin, Tag, Tooltip } from "antd";
import { CheckOutlined, CloseOutlined, EditOutlined, EyeOutlined, FileTextOutlined, PauseOutlined, PlayCircleOutlined, PoweroffOutlined, ReloadOutlined, SaveOutlined, StopOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useLiveQuery } from "dexie-react-hooks";
import { novelDb } from "./db";
import { bulkSetFactCandidateStatus, filterAcceptableFactIds, filterSafeAcceptableFactIds, formatFactCandidateValue, setFactCandidateStatus } from "./facts";
import { qualityDimensionLabel } from "./quality";
import { approveWorkflowStage, BUILTIN_CHAPTER_WORKFLOW, cancelWorkflow, listDocumentWorkflowRuns, pauseWorkflow, resumeWorkflow, startChapterWorkflow } from "./workflow";
import type { FactCandidate, ManuscriptDocument, QualityReport, WorkflowArtifact, WorkflowStage } from "./types";
import { MarkdownContent } from "./AIWorkbench";
import { prepareManuscriptChanges, replacePreparedManuscriptText } from "./manuscript-review";
import ChapterCollaboration from "./ChapterCollaboration";
import { ClosedLoopPanel } from "./evaluation/ClosedLoopPanel";
import type { CreativeBrief, NovelConversationThread } from "./types";

const STAGE_LABELS: Record<WorkflowStage, string> = {
  context: "冻结上下文", blueprint: "生成蓝图", "blueprint-approval": "蓝图审批", draft: "正文草稿", "deterministic-check": "规则检查", review: "专业审校", revision: "定向修订", "manuscript-approval": "正文审批", "fact-extraction": "事实提取", "fact-approval": "事实审批", commit: "正式提交", "character-enrichment": "人物完善",
};

function artifactForStage(run: { currentStage: WorkflowStage; blueprintArtifactId?: string; draftArtifactId?: string }, artifacts: WorkflowArtifact[]) {
  if (run.currentStage === "blueprint-approval") return artifacts.find((item) => item.id === run.blueprintArtifactId);
  if (run.currentStage === "manuscript-approval") return artifacts.find((item) => item.id === run.draftArtifactId);
  if (run.currentStage === "fact-approval") return artifacts.find((item) => item.kind === "fact-delta");
  return artifacts.at(-1);
}

export default function WorkflowCenter({ projectId, document }: { projectId: string; document?: ManuscriptDocument }) {
  const { message } = App.useApp();
  const runs = useLiveQuery(
    () => document ? listDocumentWorkflowRuns(projectId, document.id) : Promise.resolve([]),
    [projectId, document?.id],
  ) ?? [];
  const run = runs[0];
  const queriedArtifacts = useLiveQuery(async (): Promise<WorkflowArtifact[]> => run ? await novelDb.workflowArtifacts.where("workflowRunId").equals(run.id).sortBy("createdAt") : [], [run?.id]);
  const artifacts: WorkflowArtifact[] = queriedArtifacts ?? [];
  const report = useLiveQuery(async (): Promise<QualityReport | undefined> => run?.qualityReportId ? await novelDb.qualityReports.get(run.qualityReportId) : undefined, [run?.qualityReportId]);
  const queriedFacts = useLiveQuery(async (): Promise<FactCandidate[]> => run ? await novelDb.factCandidates.where("workflowRunId").equals(run.id).toArray() : [], [run?.id]);
  const facts: FactCandidate[] = queriedFacts ?? [];
  const queriedManuscriptChanges = useLiveQuery(async () => run?.draftArtifactId
    ? novelDb.manuscriptChanges.where("workflowRunId").equals(run.id).filter((change) => change.documentId === document?.id && change.sourceArtifactId === run.draftArtifactId).sortBy("order")
    : [], [document?.id, run?.id, run?.draftArtifactId]);
  const manuscriptChanges = queriedManuscriptChanges ?? [];
  const [conversationThread, setConversationThread] = useState<NovelConversationThread>();
  const [creativeBrief, setCreativeBrief] = useState<CreativeBrief>();
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [manuscriptModal, setManuscriptModal] = useState<"preview" | "edit" | null>(null);
  const [manuscriptDraft, setManuscriptDraft] = useState("");
  const [previewArtifact, setPreviewArtifact] = useState<WorkflowArtifact | null>(null);
  const approvalArtifact = run ? artifactForStage(run, artifacts) : undefined;
  const active = run && !["completed", "cancelled"].includes(run.status);
  const pendingFacts = facts.filter((item) => item.status === "pending").length;
  const pendingSafeFacts = facts.filter((item) => item.status === "pending" && !item.conflict && item.risk === "safe").length;
  const pendingAcceptableFacts = facts.filter((item) => item.status === "pending" && !item.conflict).length;
  const conflictFacts = facts.filter((item) => item.conflict).length;
  const acceptedFacts = facts.filter((item) => item.status === "accepted").length;
  const rejectedFacts = facts.filter((item) => item.status === "rejected").length;
  const pendingManuscriptChanges = manuscriptChanges.filter((change) => change.status === "pending");
  const manuscriptParagraphCount = approvalArtifact?.contentMarkdown.trim().split(/\n\s*\n/).filter(Boolean).length ?? 0;
  const manuscriptCharacterCount = approvalArtifact?.contentMarkdown.replace(/\s/g, "").length ?? 0;

  useEffect(() => {
    if (run?.status !== "waiting-approval" || run.currentStage !== "manuscript-approval" || !approvalArtifact || !document) return;
    void prepareManuscriptChanges({
      projectId,
      documentId: document.id,
      proposedText: approvalArtifact.contentMarkdown,
      workflowRunId: run.id,
      sourceArtifactId: approvalArtifact.id,
    }).catch((error) => message.error(error instanceof Error ? error.message : "逐段审阅准备失败"));
  }, [approvalArtifact?.id, document?.id, projectId, run?.currentStage, run?.id, run?.status]);

  async function perform(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    try { await action(); if (success) message.success(success); }
    catch (error) { message.error(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  }

  async function submitApproval(approved: boolean) {
    if (!run) return;
    return approveWorkflowStage(run.id, {
      approved,
      feedback,
    });
  }

  function openManuscriptModal(mode: "preview" | "edit") {
    setManuscriptDraft(approvalArtifact?.contentMarkdown ?? "");
    setManuscriptModal(mode);
  }

  async function saveManuscriptDraft() {
    if (!run || !document || !approvalArtifact) return;
    await perform(async () => {
      await replacePreparedManuscriptText({
        projectId,
        documentId: document.id,
        proposedText: manuscriptDraft,
        workflowRunId: run.id,
        sourceArtifactId: approvalArtifact.id,
      });
      setManuscriptModal(null);
    }, "正文修改已保存");
  }

  async function bulkFactAction(action: "accept-safe" | "accept-all" | "reject-all") {
    if (!run) return;
    let ids: string[] = [];
    let success = "";
    if (action === "accept-safe") {
      ids = filterSafeAcceptableFactIds(facts);
      success = `已采纳 ${ids.length} 项安全事实`;
    } else if (action === "accept-all") {
      ids = filterAcceptableFactIds(facts);
      success = `已采纳 ${ids.length} 项可采纳事实（冲突项已跳过）`;
    } else {
      ids = facts.filter((item) => item.status === "pending").map((item) => item.id);
      success = `已排除 ${ids.length} 项待审事实`;
    }
    if (!ids.length) {
      message.info(action === "accept-safe" ? "没有可一键采纳的安全事实" : action === "accept-all" ? "没有可一键采纳的待审事实" : "没有待排除的事实");
      return;
    }
    await bulkSetFactCandidateStatus(ids, action === "reject-all" ? "rejected" : "accepted");
    message.success(success);
  }

  return <div className="novel-view-content novel-workflow-center">
    <header className="novel-section-title"><div><span>CONTROLLED AGENT PIPELINE</span><h2>章节创作流程</h2><p>每个产物、审校证据和正式变更都沿同一条可恢复链路推进。</p></div>{active && <div className="novel-workflow-controls">{run.status === "paused" || run.status === "failed" ? <Button icon={<PlayCircleOutlined />} onClick={() => void perform(() => resumeWorkflow(run.id), "工作流已恢复")}>恢复</Button> : run.status === "running" ? <Button icon={<PauseOutlined />} onClick={() => void perform(() => pauseWorkflow(run.id))}>暂停</Button> : null}<Button danger icon={<StopOutlined />} onClick={() => void perform(() => cancelWorkflow(run.id))}>取消</Button></div>}</header>

    {!document ? <Empty description="请先选择一个章节" /> : !active ? <><ChapterCollaboration projectId={projectId} document={document} onStateChange={(thread, brief) => { setConversationThread(thread); setCreativeBrief(brief); }} /><section className="novel-workflow-launch"><div><span>STANDARD CHAPTER v2</span><h3>{document.title}</h3><p>{creativeBrief?.status === "confirmed" ? "创作简报已冻结，可以进入章节生产流程。" : "确认创作简报后启动章节生产。"}</p></div><Button type="primary" size="large" loading={busy} disabled={!conversationThread || creativeBrief?.status !== "confirmed"} icon={<ThunderboltOutlined />} onClick={() => void perform(() => startChapterWorkflow({ projectId, documentId: document.id, threadId: conversationThread!.id, briefId: creativeBrief!.id }), "工作流已启动")}>启动标准流程</Button></section><section className="novel-closed-loop-launch"><div><span>CLOSED LOOP EVAL</span><h3>一键闭环评估</h3><p>实验库快照 → 章节工作流 → 技能迭代 → 候选导出 → inspect → 晋升回写。试运行仅预览不写正式库；正式晋升将创建新章节版本。</p></div><ClosedLoopPanel projectId={projectId} document={document} conversationThread={conversationThread} creativeBrief={creativeBrief} /></section></> : <>
      <section className="novel-workflow-status"><div><Tag color={run.status === "failed" ? "red" : run.status === "waiting-approval" ? "gold" : run.status === "completed" ? "green" : "processing"}>{run.status}</Tag><strong>{STAGE_LABELS[run.currentStage]}</strong><span>第 {run.revisionIteration + 1} 轮 · {artifacts.length} 个产物</span></div>{busy && <Spin size="small" />} {run.error && <p>{run.error}</p>}</section>
      <div className="novel-workflow-rail">{BUILTIN_CHAPTER_WORKFLOW.stages.map((stage, index) => <Tooltip key={stage} title={STAGE_LABELS[stage]}><div className={index < run.stageIndex ? "done" : index === run.stageIndex ? "active" : ""}><i>{index < run.stageIndex ? <CheckOutlined /> : index + 1}</i><span>{STAGE_LABELS[stage]}</span></div></Tooltip>)}</div>

      {report && <section className="novel-quality-report"><header><div><span>QUALITY GATE</span><h3>{report.passed ? "质量门禁通过" : "需要修订或人工决策"}</h3></div><div className="novel-quality-score"><strong>{report.weightedScore}</strong><span>/ 5</span></div></header><div className="novel-quality-dimensions">{Object.entries(report.scores).map(([dimension, score]) => <div key={dimension}><label><span>{qualityDimensionLabel(dimension)}</span><b>{score.toFixed(1)}</b></label><Progress percent={score / 5 * 100} showInfo={false} strokeColor={score < 3 ? "#b5483a" : "#7d9c8b"} trailColor="#292b2e" /></div>)}</div><div className="novel-quality-issues">{report.issues.slice(0, 12).map((issue) => <article key={issue.id} className={issue.severity}><Tag color={issue.severity === "blocker" ? "red" : issue.severity === "major" ? "orange" : undefined}>{issue.severity}</Tag><div><strong>{issue.title}</strong><p>{issue.description}</p>{issue.excerpt && <blockquote>{issue.excerpt}</blockquote>}<small>{issue.rule} · {issue.deterministic ? "确定性检查" : "独立审校"}</small></div></article>)}</div></section>}

      {run.status === "waiting-approval" && <section className="novel-approval-desk"><header><span>HUMAN GATE</span><h3>{STAGE_LABELS[run.currentStage]}</h3></header>{approvalArtifact && run.currentStage !== "manuscript-approval" && <MarkdownContent content={approvalArtifact.contentMarkdown} />}
        {run.currentStage === "manuscript-approval" && <div className="novel-manuscript-review-entry">
          <div className="novel-manuscript-review-icon"><FileTextOutlined /></div>
          <div className="novel-manuscript-review-summary">
            <strong>{approvalArtifact?.title ?? document?.title ?? "章节正文"}</strong>
            {!queriedManuscriptChanges ? <span><Spin size="small" /> 正在准备正文</span> : <span>{manuscriptParagraphCount} 个段落 · {manuscriptCharacterCount.toLocaleString("zh-CN")} 字符 · {pendingManuscriptChanges.length} 项待应用变更</span>}
          </div>
          <div className="novel-manuscript-review-actions">
            <Button icon={<EyeOutlined />} disabled={!approvalArtifact} onClick={() => openManuscriptModal("preview")}>预览正文</Button>
            <Button icon={<EditOutlined />} disabled={!approvalArtifact} onClick={() => openManuscriptModal("edit")}>编辑正文</Button>
          </div>
        </div>}
        {run.currentStage === "fact-approval" && <>
          <div className="novel-fact-bulk-bar">
            <div className="novel-fact-bulk-stats">
              <span>共 {facts.length} 项</span>
              <Tag color="gold">待审 {pendingFacts}</Tag>
              <Tag color="green">已采纳 {acceptedFacts}</Tag>
              <Tag>已排除 {rejectedFacts}</Tag>
              {conflictFacts > 0 && <Tag color="red">冲突 {conflictFacts}</Tag>}
            </div>
            <div className="novel-fact-bulk-actions">
              <Tooltip title={pendingSafeFacts > 0 ? `采纳 ${pendingSafeFacts} 项 risk=safe 的非冲突待审事实` : "没有可一键采纳的安全事实"}>
                <Button icon={<ThunderboltOutlined />} disabled={pendingSafeFacts === 0} loading={busy} onClick={() => void perform(() => bulkFactAction("accept-safe"), undefined)}>一键采纳安全（{pendingSafeFacts}）</Button>
              </Tooltip>
              <Tooltip title={pendingAcceptableFacts > 0 ? `采纳 ${pendingAcceptableFacts} 项非冲突待审事实，冲突项保留待人工处理` : "没有可一键采纳的待审事实"}>
                <Button type="primary" ghost icon={<CheckOutlined />} disabled={pendingAcceptableFacts === 0} loading={busy} onClick={() => void perform(() => bulkFactAction("accept-all"), undefined)}>一键采纳全部可采纳（{pendingAcceptableFacts}）</Button>
              </Tooltip>
              <Tooltip title={pendingFacts > 0 ? `排除 ${pendingFacts} 项待审事实（含冲突项）` : "没有待排除的事实"}>
                <Button danger icon={<CloseOutlined />} disabled={pendingFacts === 0} loading={busy} onClick={() => void perform(() => bulkFactAction("reject-all"), undefined)}>一键排除所有待审（{pendingFacts}）</Button>
              </Tooltip>
            </div>
          </div>
          <div className="novel-fact-list">{facts.map((fact) => <article key={fact.id} className={fact.status}><div><Tag color={fact.conflict ? "red" : fact.status === "accepted" ? "green" : fact.status === "rejected" ? "default" : fact.risk === "high" ? "orange" : "gold"}>{fact.conflict ? "冲突" : fact.status === "accepted" && fact.decisionSource === "auto-policy" ? "自动采纳" : fact.status}</Tag><Tag color={fact.risk === "high" ? "orange" : "blue"}>{fact.risk === "high" ? "高风险" : "安全更新"}</Tag><strong>{fact.targetTable}.{fact.field}</strong><p>{formatFactCandidateValue(fact)}</p><blockquote>{fact.evidence}</blockquote><small>置信度 {Math.round(fact.confidence * 100)}% · {fact.novelty} · {fact.riskReason}</small></div><div><Button type={fact.status === "accepted" ? "primary" : "default"} icon={<CheckOutlined />} disabled={fact.conflict} onClick={() => void setFactCandidateStatus(fact.id, "accepted")}>采纳</Button><Button icon={<CloseOutlined />} onClick={() => void setFactCandidateStatus(fact.id, "rejected")}>排除</Button></div></article>)}</div>
        </>}
        {run.currentStage !== "fact-approval" && <Input.TextArea rows={3} value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="退回时填写具体修改要求；批准可留空。" />}
        <footer><Button icon={<PoweroffOutlined />} disabled={busy} onClick={() => void perform(() => pauseWorkflow(run.id), "已暂停审核，可在控制区恢复")}>关闭</Button><Button danger icon={<CloseOutlined />} loading={busy} onClick={() => void perform(() => submitApproval(false), "已退回流程")}>{run.currentStage === "fact-approval" ? "全部不提交" : "退回修改"}</Button><Button type="primary" icon={<CheckOutlined />} loading={busy} disabled={(run.currentStage === "fact-approval" && pendingFacts > 0) || (run.currentStage === "manuscript-approval" && !queriedManuscriptChanges)} onClick={() => void perform(() => submitApproval(true), "审批已提交")}>{run.currentStage === "fact-approval" ? `提交已采纳事实${pendingFacts ? `（尚有 ${pendingFacts} 项未决定）` : ""}` : run.currentStage === "manuscript-approval" ? `采纳正文（${pendingManuscriptChanges.length} 项变更）` : "批准并继续"}</Button></footer>
      </section>}

      <section className="novel-artifact-ledger"><header><span>ARTIFACT LEDGER</span><h3>工作产物</h3></header>{artifacts.map((artifact) => <article key={artifact.id} className="clickable" role="button" tabIndex={0} onClick={() => setPreviewArtifact(artifact)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPreviewArtifact(artifact); } }}><i>{artifact.kind.slice(0, 2).toUpperCase()}</i><div><strong>{artifact.title}</strong><p>{artifact.contentMarkdown.slice(0, 140)}</p><small>{STAGE_LABELS[artifact.stage]} · {artifact.skillRefs.length} Skills · {new Date(artifact.createdAt).toLocaleTimeString("zh-CN")}</small></div></article>)}</section>
      {run.status === "failed" && <Button icon={<ReloadOutlined />} onClick={() => void perform(() => resumeWorkflow(run.id))}>从失败步骤重试</Button>}
    </>}
    <Modal open={!!previewArtifact} title={previewArtifact?.title} onCancel={() => setPreviewArtifact(null)} footer={null} width={760} className="novel-artifact-modal" destroyOnClose>
      {previewArtifact && <div className="novel-artifact-detail">
        <div className="novel-artifact-detail-meta"><Tag color="gold">{STAGE_LABELS[previewArtifact.stage]}</Tag><Tag>{previewArtifact.kind}</Tag><small>{new Date(previewArtifact.createdAt).toLocaleString("zh-CN")}{previewArtifact.skillRefs.length > 0 ? ` · ${previewArtifact.skillRefs.length} Skills` : ""}{previewArtifact.model ? ` · ${previewArtifact.model}` : ""}</small></div>
        <MarkdownContent content={previewArtifact.contentMarkdown} />
      </div>}
    </Modal>
    <Modal
      open={!!manuscriptModal}
      title={manuscriptModal === "edit" ? "编辑章节正文" : "预览章节正文"}
      onCancel={() => setManuscriptModal(null)}
      width={900}
      className="novel-manuscript-modal"
      destroyOnClose
      footer={manuscriptModal === "edit" ? [
        <Button key="cancel" onClick={() => setManuscriptModal(null)}>取消</Button>,
        <Button key="save" type="primary" icon={<SaveOutlined />} loading={busy} onClick={() => void saveManuscriptDraft()}>保存正文</Button>,
      ] : [<Button key="close" onClick={() => setManuscriptModal(null)}>关闭</Button>]}
    >
      {manuscriptModal === "edit"
        ? <Input.TextArea className="novel-manuscript-editor" value={manuscriptDraft} onChange={(event) => setManuscriptDraft(event.target.value)} spellCheck={false} />
        : <div className="novel-manuscript-preview"><MarkdownContent content={approvalArtifact?.contentMarkdown ?? ""} /></div>}
    </Modal>
  </div>;
}
