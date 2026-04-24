from ymcp.contracts.common import ToolStatus
from ymcp.contracts.ralph import RalphArtifacts, RalphRequest, RalphResult
from ymcp.contracts.workflow import WorkflowState
from ymcp.core.result import build_meta, build_next_action, build_risk


def build_ralph(request: RalphRequest) -> RalphResult:
    has_evidence = bool(request.latest_evidence)
    has_failures = bool(request.known_failures)
    verification_defined = bool(request.verification_commands)
    requested_input = None
    if request.current_phase == "complete":
        readiness = "complete"
        status = ToolStatus.OK
        next_action = "选择下一步：mempalace_add_drawer / plan / finish；支持 Elicitation 的客户端应由服务器发起表单请求。"
        judgement = "complete"
        missing = []
        requested_input = next_action
    elif has_failures:
        readiness = "fixing"
        status = ToolStatus.NEEDS_INPUT
        next_action = "先修复失败项，再重新收集验证证据。"
        judgement = "fixing"
        missing = []
    elif not has_evidence:
        readiness = "needs_input"
        status = ToolStatus.NEEDS_INPUT
        next_action = "需要 latest_evidence；支持 Elicitation 的客户端应由服务器发起表单请求。"
        judgement = "needs_more_evidence"
        missing = ["latest_evidence"]
        requested_input = next_action
    elif not verification_defined:
        readiness = "needs_input"
        status = ToolStatus.NEEDS_INPUT
        next_action = "需要 verification_commands；支持 Elicitation 的客户端应由服务器发起表单请求。"
        judgement = "needs_verification_plan"
        missing = ["verification_commands"]
        requested_input = next_action
    else:
        readiness = "executing"
        status = ToolStatus.OK
        next_action = "根据 approved plan 和最新证据继续执行下一步，并在关键节点重新调用 ralph。"
        judgement = "continue"
        missing = []
    state = WorkflowState(
        workflow_name="ralph",
        current_phase=request.current_phase if readiness != "fixing" else "fixing",
        readiness=readiness,
        evidence_gaps=missing,
        blocked_reason="存在已知失败项" if has_failures else None,
        skill_source="skills/ralph/SKILL.md",
    )
    reusable_memory = [e for e in request.latest_evidence if "约定" in e or "偏好" in e or "流程" in e][:3]
    skill_candidates = [f for f in request.known_failures if "流程" in f or "重复" in f][:3]
    return RalphResult(
        status=status,
        summary="已生成 ralph 标准结构化结果。",
        assumptions=["用户输入应优先通过 MCP Elicitation 获取；不支持时仅返回标准 structuredContent。"],
        next_actions=[build_next_action("继续 Ralph 循环", next_action)],
        risks=[build_risk("如果不提供新鲜证据，ralph 只能返回泛化建议。", "每轮都附带最新验证结果和失败信息。")],
        meta=build_meta("ralph", "ymcp.contracts.ralph.RalphResult", host_controls=["MCP Elicitation", "execution", "verification"]),
        artifacts=RalphArtifacts(
            recommended_next_action=next_action,
            verification_checklist=request.verification_commands or ["定义至少一条验证命令或验收动作。"],
            stop_continue_judgement=judgement,
            outstanding_risks=request.known_failures or ["宿主可能过度信任工具输出而跳过验证。"],
            missing_evidence=missing,
            reusable_memory_candidates=reusable_memory,
            skill_improvement_candidates=skill_candidates,
            final_report_skeleton=["完成内容", "验证证据", "剩余风险", "可沉淀经验"],
            workflow_state=state,
            requested_input=requested_input,
        ),
    )
