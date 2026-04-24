from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.ralph import RalphArtifacts, RalphRequest, RalphResult
from ymcp.contracts.workflow import CompletionGate, WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_meta, build_next_action


def _completion_gates(request: RalphRequest) -> list[CompletionGate]:
    return [
        CompletionGate(name="execution_context_present", satisfied=request.execution_context_present, detail="执行前应已有上下文快照、执行 brief 或等价上下文。"),
        CompletionGate(name="has_execution_evidence", satisfied=bool(request.latest_evidence), detail="需要最新执行证据。"),
        CompletionGate(name="has_verification_plan", satisfied=bool(request.verification_commands), detail="需要 verification_commands。"),
        CompletionGate(name="has_verification_results", satisfied=bool(request.verification_results), detail="需要验证结果输出。"),
        CompletionGate(name="regression_reverified", satisfied=request.regression_status == "passed", detail="回归状态应为 passed。"),
        CompletionGate(name="architect_reviewed", satisfied=bool(request.architect_review_summary), detail="至少应有一条架构/设计验证摘要。"),
        CompletionGate(name="distillation_checked", satisfied=request.distillation_status in {"checked", "none"}, detail="完成前需检查经验沉淀状态。"),
    ]


def build_ralph(request: RalphRequest) -> RalphResult:
    has_failures = bool(request.known_failures)
    gates = _completion_gates(request)
    missing_inputs: list[str] = []
    blockers: list[str] = []

    if not request.latest_evidence:
        missing_inputs.append("latest_evidence")
    if not request.verification_commands:
        missing_inputs.append("verification_commands")
    if request.verification_commands and not request.verification_results:
        missing_inputs.append("verification_results")
    if not request.execution_context_present:
        blockers.append("缺少执行前上下文或等价 brief。")
    if request.regression_status and request.regression_status != "passed":
        blockers.append(f"回归状态不是 passed（当前为 {request.regression_status}）。")
    if request.distillation_status in {None, "pending"}:
        blockers.append("经验沉淀检查尚未完成。")

    all_gates_satisfied = all(gate.satisfied for gate in gates)
    if request.current_phase == "complete" and all_gates_satisfied:
        judgement = "complete"
        status = ToolStatus.OK
        readiness = "complete"
        summary = "当前工作流已完成。"
        phase_detail = "当前工作流已完成；宿主应提供下一步动作选项，并通过 MCP Elicitation 让用户选择。"
    elif has_failures:
        judgement = "fixing"
        status = ToolStatus.NEEDS_INPUT
        readiness = "fixing"
        summary = "存在失败项，需先修复再继续。"
        phase_detail = summary
        blockers.extend(request.known_failures)
    elif "latest_evidence" in missing_inputs:
        judgement = "needs_more_evidence"
        status = ToolStatus.NEEDS_INPUT
        readiness = "needs_input"
        summary = "缺少最新执行证据；宿主应通过 MCP Elicitation 收集 latest_evidence。"
        phase_detail = summary
        missing_inputs = ["latest_evidence"]
    elif "verification_commands" in missing_inputs or "verification_results" in missing_inputs:
        judgement = "needs_verification_plan"
        status = ToolStatus.NEEDS_INPUT
        readiness = "needs_input"
        summary = "缺少验证计划或验证结果；宿主应通过 MCP Elicitation 补齐验证输入。"
        phase_detail = summary
        missing_inputs = [item for item in missing_inputs if item in {"verification_commands", "verification_results"}]
    else:
        judgement = "continue"
        status = ToolStatus.OK
        readiness = "executing"
        summary = "可继续执行。"
        phase_detail = "证据与验证输入已具备，可继续执行。"

    state = WorkflowState(
        workflow_name="ralph",
        current_phase=request.current_phase if judgement != "fixing" else "fixing",
        readiness=readiness,
        evidence_gaps=missing_inputs,
        blocked_reason="；".join(blockers) if blockers and judgement in {"fixing", "continue"} else None,
    )
    return RalphResult(
        status=status,
        summary=summary,
        assumptions=[],
        next_actions=[build_next_action("下一步", summary)],
        risks=[],
        meta=build_meta(
            "ralph",
            "ymcp.contracts.ralph.RalphResult",
            host_controls=["MCP Elicitation", "execution", "verification"],
            required_host_action=HostActionType.AWAIT_INPUT if judgement in {"needs_more_evidence", "needs_verification_plan", "complete"} else HostActionType.CONTINUE_EXECUTION,
            requires_elicitation=judgement in {"needs_more_evidence", "needs_verification_plan", "complete"},
            requires_explicit_user_choice=judgement == "complete",
        ),
        artifacts=RalphArtifacts(
            stop_continue_judgement=judgement,
            verification_checklist=request.verification_commands,
            missing_evidence=missing_inputs,
            completion_gates=gates,
            verification_summary=request.verification_results or ["待补充验证结果。"],
            evidence_freshness="fresh" if request.latest_evidence else "missing",
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(title="Ralph 状态", summary=phase_detail),
        ),
    )
