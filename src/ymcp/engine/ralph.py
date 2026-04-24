from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.ralph import RalphArtifacts, RalphRequest, RalphResult
from ymcp.contracts.workflow import WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_meta, build_next_action


def build_ralph(request: RalphRequest) -> RalphResult:
    has_evidence = bool(request.latest_evidence)
    has_failures = bool(request.known_failures)
    verification_defined = bool(request.verification_commands)
    if request.current_phase == "complete":
        judgement = "complete"
        status = ToolStatus.OK
        readiness = "complete"
        summary = "当前工作流已完成；宿主应提供下一步动作选项，并通过 MCP Elicitation 让用户选择。"
        missing = []
    elif has_failures:
        judgement = "fixing"
        status = ToolStatus.NEEDS_INPUT
        readiness = "fixing"
        summary = "存在失败项，需先修复再继续。"
        missing = []
    elif not has_evidence:
        judgement = "needs_more_evidence"
        status = ToolStatus.NEEDS_INPUT
        readiness = "needs_input"
        summary = "缺少最新执行证据；宿主应通过 MCP Elicitation 收集 latest_evidence。"
        missing = ["latest_evidence"]
    elif not verification_defined:
        judgement = "needs_verification_plan"
        status = ToolStatus.NEEDS_INPUT
        readiness = "needs_input"
        summary = "缺少验证计划；宿主应通过 MCP Elicitation 收集 verification_commands。"
        missing = ["verification_commands"]
    else:
        judgement = "continue"
        status = ToolStatus.OK
        readiness = "executing"
        summary = "证据足够，可继续执行。"
        missing = []

    state = WorkflowState(
        workflow_name="ralph",
        current_phase=request.current_phase if judgement != "fixing" else "fixing",
        readiness=readiness,
        evidence_gaps=missing,
        blocked_reason="存在已知失败项" if has_failures else None,
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
            missing_evidence=missing,
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(title="Ralph 状态", summary=summary),
        ),
    )
