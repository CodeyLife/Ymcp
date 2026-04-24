from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.plan import PlanArtifacts, PlanRequest, PlanResult
from ymcp.contracts.workflow import MemoryPreflight, WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_meta, build_next_action
from ymcp.engine.memory_preflight import analyze_memory_context


def _is_vague(request: PlanRequest) -> bool:
    stripped = "".join(request.task.split())
    has_cjk = any("一" <= char <= "鿿" for char in stripped)
    too_short = len(stripped) < 4 if has_cjk else len(request.task.split()) < 8
    return request.mode == "auto" and too_short and not request.acceptance_criteria and not request.constraints and not request.known_context and not request.desired_outcome


def build_plan(request: PlanRequest) -> PlanResult:
    search_performed, retrieved_count, retrieved_context = analyze_memory_context(request.known_context, request.memory_context)
    mode = request.mode
    if mode == "auto":
        mode = "interview" if _is_vague(request) else "direct"

    if mode == "review":
        phase = "review"
        status = ToolStatus.OK if request.review_target else ToolStatus.NEEDS_INPUT
        readiness = "review_complete" if request.review_target else "needs_input"
        phase_summary = WorkflowPhaseSummary(title="计划 review", summary="宿主应通过 MCP Elicitation 收集 review_target。" if not request.review_target else "review 已完成。")
        plan_summary = f"任务：{request.task}；review 目标：{request.review_target or '待补充'}。"
    elif mode == "consensus":
        phase = "consensus_handoff"
        status = ToolStatus.OK
        readiness = "ready_for_handoff"
        phase_summary = WorkflowPhaseSummary(title="转入共识规划", summary="宿主应提供下一步 workflow 选项，并通过 MCP Elicitation 让用户决定是否进入 ralplan。")
        plan_summary = f"任务：{request.task}；建议进入 ralplan。"
    elif mode == "interview":
        phase = "interview_required"
        status = ToolStatus.NEEDS_INPUT
        readiness = "needs_input"
        phase_summary = WorkflowPhaseSummary(title="需要先澄清", summary="任务过于模糊；宿主应通过 MCP Elicitation 让用户选择进入 deep_interview 或补充更具体目标。")
        plan_summary = f"任务：{request.task}；当前信息不足，不能直接给出可靠计划。"
    else:
        phase = "direct_plan"
        status = ToolStatus.OK
        readiness = "plan_ready"
        phase_summary = WorkflowPhaseSummary(title="直接计划", summary="计划已生成；宿主应提供下一步 workflow 选项，并通过 MCP Elicitation 让用户显式选择。")
        plan_summary = f"任务：{request.task}；先确认边界，再执行最小闭环并验证。"

    state = WorkflowState(
        workflow_name="plan",
        current_phase=phase,
        readiness=readiness,
        evidence_gaps=[] if request.known_context else ["缺少项目事实或现有实现线索。"],
        memory_preflight=MemoryPreflight(
            required=not bool(request.known_context),
            reason="进入 plan 前应先搜索历史约束、用户偏好和项目决策。",
            query=request.task,
            already_satisfied=bool(request.known_context),
            search_performed=search_performed,
            retrieved_count=retrieved_count,
            retrieved_context=retrieved_context,
        ),
    )
    return PlanResult(
        status=status,
        summary=phase_summary.summary,
        assumptions=[],
        next_actions=[build_next_action("下一步", phase_summary.summary)],
        risks=[],
        meta=build_meta(
            "plan",
            "ymcp.contracts.plan.PlanResult",
            host_controls=["MCP Elicitation", "execution", "verification"],
            required_host_action=HostActionType.AWAIT_INPUT if status is ToolStatus.NEEDS_INPUT or phase in {"consensus_handoff", "direct_plan"} else HostActionType.DISPLAY_ONLY,
            requires_elicitation=status is ToolStatus.NEEDS_INPUT or phase in {"consensus_handoff", "direct_plan"},
            requires_explicit_user_choice=phase in {"interview_required", "consensus_handoff", "direct_plan"},
        ),
        artifacts=PlanArtifacts(
            plan_summary=plan_summary,
            acceptance_criteria=request.acceptance_criteria,
            workflow_state=state,
            phase_summary=phase_summary,
        ),
    )
