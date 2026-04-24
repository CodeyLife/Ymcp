from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.ralplan import (
    RalplanArchitectArtifacts,
    RalplanArchitectRequest,
    RalplanArchitectResult,
    RalplanCriticArtifacts,
    RalplanCriticRequest,
    RalplanCriticResult,
    RalplanHandoffArtifacts,
    RalplanHandoffRequest,
    RalplanHandoffResult,
    RalplanPlannerArtifacts,
    RalplanPlannerRequest,
    RalplanPlannerResult,
    RalplanArtifacts,
    RalplanRequest,
    RalplanResult,
)
from ymcp.contracts.workflow import MemoryPreflight, WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_meta, build_next_action
from ymcp.engine.memory_preflight import analyze_memory_context


def _memory_preflight(task: str, known_context: list[str], memory_context, *, required: bool) -> MemoryPreflight:
    search_performed, retrieved_count, retrieved_context = analyze_memory_context(known_context, memory_context)
    return MemoryPreflight(
        required=required,
        reason="进入 ralplan 前应先读取历史约束、已知故障和相关项目记忆。",
        query=task,
        already_satisfied=bool(known_context),
        search_performed=search_performed,
        retrieved_count=retrieved_count,
        retrieved_context=retrieved_context,
    )


def build_ralplan(request: RalplanRequest) -> RalplanResult:
    state = WorkflowState(
        workflow_name="ralplan",
        current_phase="kickoff",
        readiness="ready_for_planner",
        evidence_gaps=[] if request.known_context else ["建议先补充已知代码线索、模块名或历史记忆。"],
        memory_preflight=_memory_preflight(request.task, request.known_context, request.memory_context, required=not bool(request.known_context)),
    )
    return RalplanResult(
        status=ToolStatus.OK,
        summary="进入 ralplan 总入口，下一步应调用 ralplan_planner。",
        assumptions=[],
        next_actions=[build_next_action("下一步", "调用 ralplan_planner。")],
        risks=[],
        meta=build_meta(
            "ralplan",
            "ymcp.contracts.ralplan.RalplanResult",
            host_controls=["display", "call_selected_tool", "state persistence"],
            required_host_action=HostActionType.CALL_SELECTED_TOOL,
            safe_to_auto_continue=True,
            selected_next_tool="ralplan_planner",
        ),
        artifacts=RalplanArtifacts(
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(title="Ralplan 总入口", summary="当前只负责起步，不产出三角色结论。"),
            selected_next_tool="ralplan_planner",
        ),
    )


def build_ralplan_planner(request: RalplanPlannerRequest) -> RalplanPlannerResult:
    planner_draft = f"任务：{request.task}；排查顺序：后端状态变更 → 消息发布 → 前端订阅过滤。"
    state = WorkflowState(
        workflow_name="ralplan_planner",
        current_phase="planner",
        readiness="planner_complete",
        evidence_gaps=[] if request.known_context else ["缺少模块名、事件名或目录线索。"],
        memory_preflight=_memory_preflight(request.task, request.known_context, request.memory_context, required=not bool(request.known_context)),
    )
    return RalplanPlannerResult(
        status=ToolStatus.OK,
        summary="Planner 已完成，下一步进入 Architect。",
        assumptions=[],
        next_actions=[build_next_action("下一步", "调用 ralplan_architect，并传入 planner_draft。")],
        risks=[],
        meta=build_meta(
            "ralplan_planner",
            "ymcp.contracts.ralplan.RalplanPlannerResult",
            host_controls=["display", "call_selected_tool"],
            required_host_action=HostActionType.CALL_SELECTED_TOOL,
            safe_to_auto_continue=True,
            selected_next_tool="ralplan_architect",
        ),
        artifacts=RalplanPlannerArtifacts(
            planner_draft=planner_draft,
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(title="Planner 已完成", summary="已生成单一、明确的分析主线。"),
            selected_next_tool="ralplan_architect",
        ),
    )


def build_ralplan_architect(request: RalplanArchitectRequest) -> RalplanArchitectResult:
    architect_review = "边界：必须同时覆盖后端触发点、消息发布和前端订阅过滤。"
    state = WorkflowState(
        workflow_name="ralplan_architect",
        current_phase="architect",
        readiness="architect_complete",
        evidence_gaps=[] if request.known_context else ["若没有具体模块名，Critic 阶段需提醒补充代码证据。"],
        memory_preflight=_memory_preflight(request.task, request.known_context, request.memory_context, required=not bool(request.known_context)),
    )
    return RalplanArchitectResult(
        status=ToolStatus.OK,
        summary="Architect 已完成，下一步进入 Critic。",
        assumptions=[],
        next_actions=[build_next_action("下一步", "调用 ralplan_critic，并传入 planner_draft 与 architect_review。")],
        risks=[],
        meta=build_meta(
            "ralplan_architect",
            "ymcp.contracts.ralplan.RalplanArchitectResult",
            host_controls=["display", "call_selected_tool"],
            required_host_action=HostActionType.CALL_SELECTED_TOOL,
            safe_to_auto_continue=True,
            selected_next_tool="ralplan_critic",
        ),
        artifacts=RalplanArchitectArtifacts(
            architect_review=architect_review,
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(title="Architect 已完成", summary="已补齐边界与反例检查要求。"),
            selected_next_tool="ralplan_critic",
        ),
    )


def build_ralplan_critic(request: RalplanCriticRequest) -> RalplanCriticResult:
    has_context = bool(request.known_context)
    verdict = "APPROVE" if has_context else "REVISE"
    approved_plan_summary = f"已批准：按后端状态变更 → 消息发布 → 前端订阅过滤的顺序排查“{request.task}”。" if verdict == "APPROVE" else None
    revise_instructions = [] if verdict == "APPROVE" else ["补充具体模块名、事件名或 Hub/方法入口后重跑。"]
    state = WorkflowState(
        workflow_name="ralplan_critic",
        current_phase="critic",
        readiness="ready_for_handoff" if verdict == "APPROVE" else "needs_revision",
        evidence_gaps=[] if has_context else ["缺少代码位置、事件名或已知模块线索。"],
        memory_preflight=_memory_preflight(request.task, request.known_context, request.memory_context, required=not has_context),
    )
    next_tool = "ralplan_handoff" if verdict == "APPROVE" else None
    return RalplanCriticResult(
        status=ToolStatus.OK if verdict == "APPROVE" else ToolStatus.NEEDS_INPUT,
        summary="Critic 已批准当前计划。" if verdict == "APPROVE" else "Critic 要求补充上下文后重跑。",
        assumptions=[],
        next_actions=[build_next_action("下一步", "调用 ralplan_handoff。" if verdict == "APPROVE" else "补充上下文后重新从 ralplan_planner 开始。")],
        risks=[],
        meta=build_meta(
            "ralplan_critic",
            "ymcp.contracts.ralplan.RalplanCriticResult",
            host_controls=["display", "call_selected_tool"],
            required_host_action=HostActionType.CALL_SELECTED_TOOL if verdict == "APPROVE" else HostActionType.DISPLAY_ONLY,
            safe_to_auto_continue=verdict == "APPROVE",
            selected_next_tool=next_tool,
        ),
        artifacts=RalplanCriticArtifacts(
            critic_verdict=verdict,
            approved_plan_summary=approved_plan_summary,
            revise_instructions=revise_instructions,
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(title="Critic 已完成", summary="当前计划已批准。" if verdict == "APPROVE" else "当前计划未批准。"),
            selected_next_tool=next_tool,
        ),
    )


def build_ralplan_handoff(request: RalplanHandoffRequest) -> RalplanHandoffResult:
    normalized_verdict = request.critic_verdict.strip().upper()
    approved = normalized_verdict == "APPROVE"
    state = WorkflowState(
        workflow_name="ralplan_handoff",
        current_phase="handoff",
        readiness="needs_user_choice" if approved else "blocked",
        evidence_gaps=[] if approved else ["只有 APPROVE 的 critic_verdict 才能进入 handoff。"],
        blocked_reason=None if approved else "critic_verdict 不是 APPROVE。",
        memory_preflight=_memory_preflight(request.task, request.known_context, request.memory_context, required=not bool(request.known_context)),
    )
    return RalplanHandoffResult(
        status=ToolStatus.NEEDS_INPUT if approved else ToolStatus.BLOCKED,
        summary="需要宿主提供工作流选项，并通过 MCP Elicitation 让用户选择下一步 workflow。" if approved else "当前结果未被批准，不能进入下一步 workflow 选择。",
        assumptions=[],
        next_actions=[build_next_action("下一步", "宿主应展示下一步 workflow 选项，并通过 MCP Elicitation 收集用户选择。" if approved else "先修订计划再重新走三角色流程。")],
        risks=[],
        meta=build_meta(
            "ralplan_handoff",
            "ymcp.contracts.ralplan.RalplanHandoffResult",
            host_controls=["MCP Elicitation", "display", "call_selected_tool"],
            required_host_action=HostActionType.AWAIT_INPUT if approved else HostActionType.STOP,
            safe_to_auto_continue=False,
            requires_elicitation=approved,
            requires_explicit_user_choice=approved,
        ),
        artifacts=RalplanHandoffArtifacts(
            approved_plan_summary=request.approved_plan_summary,
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(title="Ralplan Handoff", summary="当前只负责收集下一步 workflow 选择。" if approved else "由于未批准，handoff 被阻断。"),
        ),
    )
