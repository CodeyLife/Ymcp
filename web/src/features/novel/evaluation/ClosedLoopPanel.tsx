/**
 * 闭环评估 UI 面板：在章节视图提供"一键闭环试运行 / 正式晋升"入口，并展示结果。
 *
 * 设计依据：
 * - 编排逻辑：[closed-loop.ts](./closed-loop.ts) 的 `runClosedLoop`
 * - 接入点：[WorkflowCenter.tsx](../WorkflowCenter.tsx) 的 `!active` 分支
 *   （projectId/document.id/conversationThread.id/creativeBrief.id 四个 ID 已在作用域内）
 *
 * UX 决策：
 * - **dryRun 默认路径**：单独的"试运行"按钮（不晋升），让用户先看候选预览再决定是否晋升。
 * - **promote 二次确认**：通过 antd `Modal.confirm` 弹窗确认，因为晋升会修改正式库。
 * - **长任务反馈**：button `loading` + 副文案"可能需要数分钟"。`runClosedLoop` 内部不暴露
 *   progress callback（架构阶段决策：先做最小可用 UI，未来需要时再加 `onProgress` 钩子）。
 * - **结果展示**：单一 Modal 内分段（概览/检查/候选/回执/hash 对比），便于一次性诊断。
 * - **错误展示**：在 Modal 内用 `Alert` 展示完整 `error.message`，不只 Toast（长任务诊断需求）。
 */
import { useState } from "react";
import { Alert, App, Button, Modal, Spin, Tag, Tooltip } from "antd";
import {
  CheckCircleOutlined,
  CloudSyncOutlined,
  ExperimentOutlined,
  ExclamationCircleOutlined,
  RobotOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import type { CreativeBrief, ManuscriptDocument, NovelConversationThread } from "../types";
import { MarkdownContent } from "../AIWorkbench";
import { novelDb } from "../db";
import { useClosedLoop } from "./useClosedLoop";
import type { ClosedLoopResult } from "./closed-loop";

export interface ClosedLoopPanelProps {
  projectId: string;
  document: ManuscriptDocument;
  conversationThread?: NovelConversationThread;
  creativeBrief?: CreativeBrief;
}

/** 截断长 hash 字符串为前 8 + … + 后 8 形式，便于阅读。 */
function shortHash(hash: string): string {
  if (hash.length <= 20) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

/** 格式化时间戳为本地时间字符串。 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN");
}

export function ClosedLoopPanel({
  projectId,
  document: doc,
  conversationThread,
  creativeBrief,
}: ClosedLoopPanelProps) {
  const { message, modal } = App.useApp();
  const [resultModalOpen, setResultModalOpen] = useState(false);

  const canRun = !!conversationThread && creativeBrief?.status === "confirmed";

  const closedLoop = useClosedLoop({
    canonicalDb: novelDb,
    projectId,
    chapterId: doc.id,
    threadId: conversationThread?.id ?? "",
    briefId: creativeBrief?.id ?? "",
  });

  const canPromote = !!closedLoop.result
    && closedLoop.result.check.status === "ready"
    && !closedLoop.result.receipt
    && closedLoop.result.candidate.sourceProjectId === projectId
    && closedLoop.result.candidate.targetDocument.documentId === doc.id;

  async function execute() {
    if (!canRun) {
      message.warning("请先确认创作简报后再启动闭环评估");
      return;
    }
    setResultModalOpen(true);
    await closedLoop.run({ dryRun: true });
  }

  function handlePromoteClick() {
    if (!canRun) {
      message.warning("请先确认创作简报后再启动闭环评估");
      return;
    }
    if (!canPromote || !closedLoop.result) {
      message.warning("请先完成闭环试运行并确认候选检查通过");
      return;
    }
    const candidateId = closedLoop.result.candidate.id;
    modal.confirm({
      title: "确认晋升当前候选？",
      icon: <ExclamationCircleOutlined />,
      content:
        `将晋升刚才预览的候选 ${candidateId.slice(0, 8)}，写入其章节正文、采纳事实、skill prompt 与项目绑定，并创建新的章节版本。此操作不可撤销。`,
      okText: "确认晋升",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        setResultModalOpen(true);
        await closedLoop.promote();
      },
    });
  }

  function handleCloseModal() {
    setResultModalOpen(false);
  }

  return (
    <div className="novel-closed-loop-panel">
      <div className="novel-closed-loop-actions">
        <Tooltip title={canRun ? "执行完整闭环但不写正式库，用于预览候选" : "请先确认创作简报"}>
          <Button
            icon={<ExperimentOutlined />}
            loading={closedLoop.busy}
            disabled={!canRun || closedLoop.busy}
            onClick={() => void execute()}
          >
            闭环试运行
          </Button>
        </Tooltip>
        <Tooltip title={canPromote ? "晋升刚才预览并检查通过的候选" : "请先完成闭环试运行"}>
          <Button
            type="primary"
            danger
            icon={<ThunderboltOutlined />}
            loading={closedLoop.busy}
            disabled={!canRun || !canPromote || closedLoop.busy}
            onClick={handlePromoteClick}
          >
            闭环正式晋升
          </Button>
        </Tooltip>
      </div>
      {closedLoop.busy && (
        <div className="novel-closed-loop-busy-hint">
          <Spin size="small" />
          <span>执行中：捕获快照 → 工作流 → 技能迭代 → 候选导出 → 检查 → 晋升，可能需要数分钟。</span>
        </div>
      )}
      <Modal
        open={resultModalOpen}
        title="闭环评估结果"
        onCancel={handleCloseModal}
        footer={[
          <Button key="close" onClick={handleCloseModal}>关闭</Button>,
          <Button key="promote" type="primary" danger disabled={!canPromote || closedLoop.busy} loading={closedLoop.busy} onClick={handlePromoteClick}>晋升当前候选</Button>,
        ]}
        width={820}
        destroyOnHidden
        className="novel-closed-loop-modal"
      >
        <ClosedLoopResultContent
          busy={closedLoop.busy}
          error={closedLoop.error}
          result={closedLoop.result}
        />
      </Modal>
    </div>
  );
}

/** 结果 Modal 的主体内容：根据 busy/error/result 状态切换展示。 */
export function ClosedLoopResultContent({
  busy,
  error,
  result,
}: {
  busy: boolean;
  error?: string;
  result?: ClosedLoopResult;
}) {
  if (busy && !result && !error) {
    return (
      <div className="novel-closed-loop-loading">
        <Spin />
        <p>正在执行闭环评估，请稍候…</p>
      </div>
    );
  }
  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message="闭环执行失败"
        description={<pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre>}
      />
    );
  }
  if (!result) {
    return <Alert type="info" showIcon message="尚未执行闭环评估" />;
  }
  return <ClosedLoopResultBody result={result} />;
}

/** 完整结果展示：概览 / 检查 / 候选 / 回执 / hash 对比。 */
function ClosedLoopResultBody({ result }: { result: ClosedLoopResult }) {
  const { check, candidate, receipt, canonicalHashBefore, canonicalHashAfter, experimentId, workflowRunId } = result;
  const hashAdvanced = canonicalHashBefore !== canonicalHashAfter;
  return (
    <div className="novel-closed-loop-result">
      <section className="novel-closed-loop-section">
        <header><span>OVERVIEW</span><h4>执行概览</h4></header>
        <dl className="novel-closed-loop-meta">
          <dt>实验 ID</dt><dd><code>{experimentId}</code></dd>
          <dt>工作流 ID</dt><dd><code>{workflowRunId}</code></dd>
          <dt>导出时间</dt><dd>{formatTime(candidate.provenance.exportedAt)}</dd>
          <dt>实验耗时</dt>
          <dd>{((candidate.provenance.exportedAt - candidate.provenance.experimentStartedAt) / 1000).toFixed(1)} 秒</dd>
          <dt>代码版本</dt><dd><code>{candidate.provenance.codeRevision}</code></dd>
          <dt>模型</dt><dd><code>{candidate.provenance.model}</code></dd>
        </dl>
      </section>

      <section className="novel-closed-loop-section">
        <header><span>INSPECT</span><h4>检查结果</h4></header>
        <div className="novel-closed-loop-inspect">
          <Tag color={check.status === "ready" ? "green" : "red"}>{check.status}</Tag>
          <Tag color={check.baselineMatches ? "green" : "red"}>
            {check.baselineMatches ? "基线一致" : "基线漂移"}
          </Tag>
          {check.issues.length > 0 && (
            <ul>
              {check.issues.map((issue, idx) => <li key={idx}>{issue}</li>)}
            </ul>
          )}
          {check.deterministicBlockers.length > 0 && (
            <Alert
              type="error"
              showIcon
              message="确定性阻断项"
              description={<ul>{check.deterministicBlockers.map((b, idx) => <li key={idx}>{b}</li>)}</ul>}
            />
          )}
        </div>
      </section>

      <section className="novel-closed-loop-section">
        <header><span>CANDIDATE</span><h4>候选包</h4></header>
        <dl className="novel-closed-loop-meta">
          <dt>章节标题</dt><dd>{candidate.manuscript.title}</dd>
          <dt>正文 hash</dt><dd><code>{shortHash(candidate.manuscript.contentHash)}</code></dd>
          <dt>采纳事实</dt><dd>{candidate.acceptedFacts.length} 项</dd>
          <dt>迭代技能</dt><dd>{candidate.iteratedSkills.length} 项</dd>
          <dt>调整绑定</dt><dd>{candidate.iteratedBindings.length} 项</dd>
          <dt>质量分</dt>
          <dd>
            <Tag color={candidate.qualityEvidence.weightedScore >= 4 ? "green" : candidate.qualityEvidence.weightedScore >= 3 ? "gold" : "red"}>
              {candidate.qualityEvidence.weightedScore.toFixed(2)} / 5
            </Tag>
            <span>blocker {candidate.qualityEvidence.blockerCount} · major {candidate.qualityEvidence.majorCount} · warning {candidate.qualityEvidence.warningCount}</span>
          </dd>
        </dl>
        {candidate.acceptedFacts.length > 0 && (
          <details>
            <summary>检查将写入的事实（{candidate.acceptedFacts.length} 项）</summary>
            <ul>
              {candidate.acceptedFacts.map((fact) => (
                <li key={fact.sourceCandidateId}>
                  <strong>{fact.payload.humanReadable}</strong>
                  <p>{fact.payload.evidence}</p>
                </li>
              ))}
            </ul>
          </details>
        )}
        {candidate.iteratedSkills.length > 0 && (
          <div className="novel-closed-loop-skills">
            <strong><RobotOutlined /> 迭代后的 Skill prompts</strong>
            <ul>
              {candidate.iteratedSkills.map((skill) => (
                <li key={skill.skillId}>
                  <code>{skill.skillId}</code>
                  <p>{skill.rationale}</p>
                  <details>
                    <summary>检查 prompt 变更</summary>
                    <strong>变更前</strong>
                    <pre style={{ whiteSpace: "pre-wrap" }}>{skill.beforePrompt}</pre>
                    <strong>变更后</strong>
                    <pre style={{ whiteSpace: "pre-wrap" }}>{skill.afterPrompt}</pre>
                  </details>
                </li>
              ))}
            </ul>
          </div>
        )}
        <details>
          <summary>预览章节正文（{candidate.manuscript.plainText.length} 字）</summary>
          <MarkdownContent content={candidate.manuscript.contentHtml} />
        </details>
      </section>

      <section className="novel-closed-loop-section">
        <header><span>RECEIPT</span><h4>晋升回执</h4></header>
        {!receipt ? (
          <Alert type="info" showIcon message="本次为 dry-run，未执行晋升" />
        ) : (
          <div className="novel-closed-loop-receipt">
            <Tag color={receipt.status === "promoted" ? "green" : receipt.status === "already-promoted" ? "blue" : "red"}>
              {receipt.status}
            </Tag>
            {receipt.createdRevisionId && (
              <dl className="novel-closed-loop-meta">
                <dt>新建版本</dt><dd><code>{receipt.createdRevisionId}</code></dd>
                <dt>新事实</dt><dd>{receipt.createdFactAssertionIds.length} 项</dd>
                <dt>新记忆</dt><dd>{receipt.createdMemoryIds.length} 项</dd>
                <dt>操作记录</dt><dd>{receipt.createdOperationIds.length} 项</dd>
                <dt>晋升时间</dt><dd>{formatTime(receipt.promotedAt)}</dd>
              </dl>
            )}
            {receipt.error && (
              <Alert type="error" showIcon message="晋升被拒绝" description={receipt.error} />
            )}
          </div>
        )}
      </section>

      <section className="novel-closed-loop-section">
        <header><span>HASH DELTA</span><h4>正式库 hash 对比</h4></header>
        <div className="novel-closed-loop-hash">
          <Tag icon={<CloudSyncOutlined />} color={hashAdvanced ? "green" : "default"}>
            {hashAdvanced ? "已前进" : "未变化"}
          </Tag>
          <dl className="novel-closed-loop-meta">
            <dt>实验前</dt><dd><code>{shortHash(canonicalHashBefore)}</code></dd>
            <dt>实验后</dt><dd><code>{shortHash(canonicalHashAfter)}</code></dd>
          </dl>
          {hashAdvanced ? (
            <Alert
              type="success"
              showIcon
              icon={<CheckCircleOutlined />}
              message="正式库已前进：候选已成功晋升"
            />
          ) : receipt?.status === "promoted" ? (
            <Alert type="warning" showIcon message="晋升成功但 hash 未前进，请检查" />
          ) : (
            <Alert type="info" showIcon message="dry-run 或 inspect 未通过，正式库未变化" />
          )}
        </div>
      </section>
    </div>
  );
}
