import { useMemo, useState } from "react";
import { Alert, App, Button, Input, Tag } from "antd";
import { CheckOutlined, CloseOutlined, EditOutlined } from "@ant-design/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";

import ArchitectureDataEditor, { type ArchitectureEditableData } from "./ArchitectureDataEditor";
import { novelDb } from "./db";
import { novelRuntimeClient } from "./runtime-client";
import type { RuntimeChange, RuntimeOperation } from "@/novel-runtime/contracts";

/** 把 runtime proposal item 的 payload（Record）适配为 ArchitectureEditableData。 */
function architectureValue(value: Record<string, unknown>): ArchitectureEditableData {
  return {
    framework: ["free", "three-act", "four-part", "save-the-cat", "snowflake"].includes(String(value.framework)) ? value.framework as ArchitectureEditableData["framework"] : "free",
    status: value.status === "approved" ? "approved" : "draft",
    centralQuestion: String(value.centralQuestion ?? ""),
    centralConflict: String(value.centralConflict ?? ""),
    synopsis: String(value.synopsis ?? ""),
    phases: Array.isArray(value.phases) ? value.phases as ArchitectureEditableData["phases"] : [],
    growthCurves: Array.isArray(value.growthCurves) ? value.growthCurves as ArchitectureEditableData["growthCurves"] : [],
  };
}

/** 从 runtime change artifact 解析出 architecture payload。
 *  artifact 形态：{ kind: "proposal", value: { items: [{ id, label, payload, targetTable, targetId }] } }
 *  architecture task 的 artifact 只有一个 item，payload 即 ArchitectureEditableData。 */
function extractArchitecturePayload(artifact: unknown): ArchitectureEditableData | undefined {
  if (!artifact || typeof artifact !== "object") return undefined;
  const envelope = artifact as { kind?: string; value?: { items?: Array<{ payload?: unknown }> } };
  if (envelope.kind !== "proposal") return undefined;
  const items = envelope.value?.items ?? [];
  const archItem = items.find((item) => item.payload && typeof item.payload === "object");
  if (!archItem?.payload) return undefined;
  return architectureValue(archItem.payload as Record<string, unknown>);
}

export default function RuntimeArchitectureReview({
  projectId,
  change,
  operation,
  onResolved,
}: {
  projectId: string;
  change: RuntimeChange;
  /** 候选所属的 operation，用于判断 driver 决定 UI 可操作性。
   *  external-mcp driver 的候选由 MCP 大模型负责审核、修订与提交，UI 仅提供只读比对；
   *  human driver 的候选可由用户在 UI 直接 accept/reject/revise。 */
  operation?: RuntimeOperation;
  onResolved: () => void;
}) {
  const { message } = App.useApp();
  const [revisionNote, setRevisionNote] = useState("");
  // SSE 订阅由父级 OutlineDocView 统一建立，此处不重复订阅，避免双 EventSource 浪费连接。

  // 当前正式架构（作为 compareTo 比对基线）
  const architecture = useLiveQuery(() => novelDb.architectures.where("projectId").equals(projectId).first(), [projectId]);
  const compareTo = useMemo<ArchitectureEditableData | undefined>(() => {
    if (!architecture) return undefined;
    return architectureValue(architecture as unknown as Record<string, unknown>);
  }, [architecture]);

  // 拉取候选 artifact（含 proposal items + payload）
  const changeQuery = useQuery({
    queryKey: ["novel-runtime", "change", change.id],
    queryFn: () => novelRuntimeClient.change(change.id),
  });

  const candidate = useMemo(() => extractArchitecturePayload(changeQuery.data?.artifact), [changeQuery.data?.artifact]);

  const review = useMutation({
    mutationFn: ({ decision }: { decision: "accept" | "reject" | "revise" }) => novelRuntimeClient.review(change.id, {
      projectId,
      decision,
      note: revisionNote,
      actor: { type: "user", id: "novel-studio-author" },
    }),
    onSuccess: (_data, variables) => {
      message.success(variables.decision === "accept" ? "候选已接受并写入正式架构" : variables.decision === "reject" ? "候选已拒绝" : "候选已退回重做");
      setRevisionNote("");
      onResolved();
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "审核失败"),
  });

  const evidence = change.evidence;
  const internalPassed = evidence?.internalGate?.passed === true;
  const hasArtifact = Boolean(candidate);
  const artifactLoaded = !changeQuery.isLoading && !changeQuery.isError;
  // external-mcp driver：候选由 MCP 大模型审核推进，UI 仅只读比对；
  // human driver：用户可直接在 UI 完成 accept/reject/revise。
  const userCanReview = operation?.driver === "human";
  const driverLabel = operation?.driver === "human" ? "人工审核流程" : "MCP 外部 LLM 审核";

  return (
    <section className="novel-outline-review-mode" aria-label="全书架构候选审核">
      <header className="novel-outline-review-header">
        <div>
          <span>ARCHITECTURE REVIEW</span>
          <h2>审核全书架构候选</h2>
          <p>{change.summary || "外部 LLM 通过 MCP 提交的全书架构候选，与当前正式架构并排比对后决定接受、退回或拒绝。"}</p>
        </div>
        <Tag color="gold">待确认 · 第 {(evidence?.iteration ?? 0) + 1} 轮 · {driverLabel}</Tag>
      </header>

      {!hasArtifact && changeQuery.isLoading && <Alert type="info" showIcon message="正在加载候选内容…" />}
      {!hasArtifact && changeQuery.error && <Alert type="error" showIcon message="候选加载失败" description={changeQuery.error instanceof Error ? changeQuery.error.message : "未知错误"} />}
      {/* artifact 加载成功但格式不符合 proposal envelope：明确告知用户，避免空白 */}
      {!hasArtifact && artifactLoaded && !changeQuery.error && (
        <Alert type="warning" showIcon message="候选内容格式不支持结构化审阅" description="该候选 artifact 不是 proposal envelope，无法解析为全书架构数据。请在 AI 任务中心使用 Markdown 预览查看原始内容。" />
      )}

      {hasArtifact && (
        <>
          {evidence && !internalPassed && (
            <Alert
              type="warning"
              showIcon
              message="项目内部质量门未通过"
              description={evidence.internalGate?.reason || `仍有 ${evidence.blockerCount ?? 0} 个 blocker、${evidence.majorCount ?? 0} 个 major`}
            />
          )}
          {evidence?.openIssues?.length ? (
            <Alert
              type="info"
              showIcon
              message="内部审核发现问题"
              description={<ul className="novel-runtime-issue-list">{evidence.openIssues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
            />
          ) : null}

          <div className="novel-proposal-compare split">
            {compareTo && (
              <section className="novel-proposal-compare-panel before">
                <header><span>当前正式架构</span><small>修改前</small></header>
                <div className="novel-proposal-surface">
                  <ArchitectureDataEditor preview readOnly value={compareTo} compareTo={candidate} showPhases />
                </div>
              </section>
            )}
            <section className="novel-proposal-compare-panel after">
              <header><span>候选架构</span><small>修改后</small></header>
              <div className="novel-proposal-surface">
                <ArchitectureDataEditor preview readOnly value={candidate!} compareTo={compareTo} showPhases />
              </div>
            </section>
          </div>

          {userCanReview ? (
            <footer className="novel-outline-review-footer">
              <div>
                <Input value={revisionNote} onChange={(event) => setRevisionNote(event.target.value)} placeholder="拒绝或重做时填写原因（可选）" style={{ width: 320 }} />
                <Button icon={<CloseOutlined />} disabled={review.isPending} onClick={() => review.mutate({ decision: "reject" })}>拒绝</Button>
                <Button icon={<EditOutlined />} disabled={review.isPending} onClick={() => review.mutate({ decision: "revise" })}>退回重做</Button>
              </div>
              <Button type="primary" size="large" icon={<CheckOutlined />} loading={review.isPending} onClick={() => review.mutate({ decision: "accept" })}>接受并写入正式架构</Button>
            </footer>
          ) : (
            <Alert type="info" showIcon message="该候选由 MCP 大模型负责审核和推进，UI 仅提供只读比对。" description="如需接受、退回或拒绝，请在 AI 任务中心通过 MCP 审核流程完成决策。" />
          )}
        </>
      )}
    </section>
  );
}
