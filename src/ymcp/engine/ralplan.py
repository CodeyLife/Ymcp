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
from ymcp.contracts.workflow import ADRSection, HandoffGuidance, MemoryPreflight, OptionSummary, QualityCheck, WorkflowPhaseSummary, WorkflowState
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


def _base_principles() -> list[str]:
    return [
        "保持 MCP-first：只输出结构化结果与 handoff，不执行工作流外部动作。",
        "优先增量兼容：新增字段不破坏现有 host 消费方式。",
        "质量门禁显式化：批准必须基于结构化检查，而不是弱摘要。",
    ]


def _decision_drivers(request) -> list[str]:
    drivers = ["语义与 skill 对齐", "继续符合宿主驱动边界", "回归风险可控"]
    if request.deliberate:
        drivers.append("高风险任务需要更强预案和验证")
    return drivers[:3]


def _viable_options(request) -> list[OptionSummary]:
    return [
        OptionSummary(
            name="Option A: 文档收敛",
            summary="只修文档与宿主指南，不增强 engine 语义。",
            pros=["改动小", "风险低"],
            cons=["无法解决 contract 与 skill 语义脱节"],
        ),
        OptionSummary(
            name="Option B: 结构化 contract + engine",
            summary="补齐 MCP tool 能表达的 skill 语义，但不引入执行器行为。",
            pros=["最符合 MCP-first", "宿主可直接消费 richer artifacts"],
            cons=["contracts 与 tests 改动面较大"],
        ),
    ]


def _planner_markdown(request, principles: list[str], drivers: list[str], options: list[OptionSummary]) -> str:
    return "\n".join(
        [
            f"# Plan Draft: {request.task}",
            "",
            "## Principles",
            *[f"- {item}" for item in principles],
            "",
            "## Decision Drivers",
            *[f"- {item}" for item in drivers],
            "",
            "## Options",
            *[
                "\n".join(
                    [
                        f"### {option.name}",
                        f"- Summary: {option.summary}",
                        *[f"- Pro: {pro}" for pro in option.pros],
                        *[f"- Con: {con}" for con in option.cons],
                    ]
                )
                for option in options
            ],
        ]
    )


def _critic_quality_checks(request: RalplanCriticRequest, deliberate: bool) -> list[QualityCheck]:
    checks = [
        QualityCheck(name="planner_draft_present", passed=bool(request.planner_draft.strip()), detail="planner_draft 已提供。"),
        QualityCheck(name="architect_review_present", passed=bool(request.architect_review.strip()), detail="architect_review 已提供。"),
        QualityCheck(name="context_present", passed=bool(request.known_context), detail="建议使用已知上下文支撑批准结论。"),
    ]
    if deliberate:
        checks.append(QualityCheck(name="deliberate_mode_requires_premortem", passed="Pre-mortem" in request.planner_draft or "premortem" in request.planner_draft.lower(), detail="deliberate 模式要求 pre-mortem。"))
        checks.append(QualityCheck(name="deliberate_mode_requires_expanded_test_plan", passed="Expanded Test Plan" in request.planner_draft or "unit" in request.planner_draft.lower(), detail="deliberate 模式要求 expanded test plan。"))
    return checks


def _build_adr(task: str) -> ADRSection:
    return ADRSection(
        decision=f"采用结构化 contract + engine 的方式对齐 {task}。",
        drivers=["MCP-first", "宿主驱动", "增量兼容"],
        alternatives_considered=["只修文档", "将 skill 执行器行为下沉到 tool"],
        why_chosen="既恢复可消费语义，又不破坏 Ymcp 的 MCP workflow server 边界。",
        consequences=["contracts 扩展", "docs 需同步收敛", "skill 继续保留执行策略"],
        follow_ups=["后续可统一 deep_interview / plan / ralplan / ralph 的公共 artifact。"],
    )


def _build_handoff_guidance(task: str, lane: str) -> HandoffGuidance:
    return HandoffGuidance(
        summary_to_pass=f"按批准方案推进：{task}",
        constraints_to_preserve=["保持 MCP-first 边界", "不要在未显式选择前自动 handoff", "保留现有 selected_next_tool 语义"],
        expected_verification_evidence=["更新后的 contracts/engines/docs/tests", "python -m pytest -q 通过"],
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
        summary="进入 ralplan 总入口；下一步应调用 ralplan_planner。",
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
            phase_summary=WorkflowPhaseSummary(title="Ralplan 总入口", summary="当前 phase 仅用于起步和显式 handoff。"),
            selected_next_tool="ralplan_planner",
        ),
    )


def build_ralplan_planner(request: RalplanPlannerRequest) -> RalplanPlannerResult:
    principles = _base_principles()
    drivers = _decision_drivers(request)
    options = _viable_options(request)
    recommended = options[1].name
    planner_markdown_draft = _planner_markdown(request, principles, drivers, options)
    premortem = [
        "如果 contract 扩展过多，宿主可能难以适配。",
        "如果 docs 不同步，宿主会误判 Ymcp 已执行更多行为。",
        "如果 critic 门禁过弱，会继续产生 skill/contract 漂移。",
    ] if request.deliberate else []
    expanded_test_plan = [
        "Unit: contracts / engine logic",
        "Integration: server elicitation + handoff",
        "E2E: deep_interview -> ralplan -> ralph",
        "Observability: workflow_state and selected_next_tool logging",
    ] if request.deliberate else []
    state = WorkflowState(
        workflow_name="ralplan_planner",
        current_phase="planner",
        readiness="planner_complete",
        evidence_gaps=[] if request.known_context else ["缺少模块名、事件名或目录线索。"],
        memory_preflight=_memory_preflight(request.task, request.known_context, request.memory_context, required=not bool(request.known_context)),
    )
    return RalplanPlannerResult(
        status=ToolStatus.OK,
        summary="Planner 已完成；下一步进入 Architect。",
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
            principles=principles,
            decision_drivers=drivers,
            viable_options=options,
            recommended_option=recommended,
            option_invalidation_rationale=["Option A 无法解决 contract 与 skill 的真实语义缺口。"],
            planner_markdown_draft=planner_markdown_draft,
            premortem_scenarios=premortem,
            expanded_test_plan=expanded_test_plan,
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(title="Planner 已完成", summary="当前 phase 已产出结构化 RALPLAN-DR 草稿。"),
            selected_next_tool="ralplan_architect",
        ),
    )


def build_ralplan_architect(request: RalplanArchitectRequest) -> RalplanArchitectResult:
    steelman = "如果仅修文档而不改 contract，可以降低实施风险并快速统一表述。"
    tensions = ["结构化字段更完整，但会提升宿主适配成本。", "quality gates 更强，但可能让审批路径更严格。"]
    synthesis = "采用增量兼容策略：新增字段，不替换旧字段；同时保留现有 handoff / workflow_state 语义。"
    architect_review = "架构建议：保留宿主驱动边界，仅补 MCP tool 可稳定表达的结构化语义。"
    markdown = "\n".join(
        [
            f"# Architect Review: {request.task}",
            "",
            f"- Steelman counterargument: {steelman}",
            *[f"- Tradeoff: {item}" for item in tensions],
            f"- Synthesis: {synthesis}",
        ]
    )
    state = WorkflowState(
        workflow_name="ralplan_architect",
        current_phase="architect",
        readiness="architect_complete",
        evidence_gaps=[] if request.known_context else ["若没有具体模块名，Critic 阶段需提醒补充代码证据。"],
        memory_preflight=_memory_preflight(request.task, request.known_context, request.memory_context, required=not bool(request.known_context)),
    )
    return RalplanArchitectResult(
        status=ToolStatus.OK,
        summary="Architect 已完成；下一步进入 Critic。",
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
            steelman_counterargument=steelman,
            tradeoff_tensions=tensions,
            synthesis_path=synthesis,
            principle_violations=[] if not request.deliberate else ["若 docs 不同步，会违反“文档服从 runtime contract”原则。"],
            architect_review_markdown=markdown,
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(title="Architect 已完成", summary="当前 phase 已给出反方观点、tradeoff 与综合建议。"),
            selected_next_tool="ralplan_critic",
        ),
    )


def build_ralplan_critic(request: RalplanCriticRequest) -> RalplanCriticResult:
    checks = _critic_quality_checks(request, request.deliberate)
    all_pass = all(check.passed for check in checks)
    has_context = bool(request.known_context)
    verdict = "APPROVE" if all_pass and has_context else ("ITERATE" if all_pass else "REJECT")
    approved_plan_summary = f"已批准：采用结构化 contract + engine 的方式推进“{request.task}”。" if verdict == "APPROVE" else None
    revise_instructions = []
    rejection_reasons = []
    if not has_context:
        revise_instructions.append("补充具体模块名、事件名或入口上下文后再审批。")
    for check in checks:
        if not check.passed:
            rejection_reasons.append(check.detail)
    required_revisions = revise_instructions + rejection_reasons
    approval_reasons = ["已有上下文，且 Planner/Architect 产物结构完整。"] if verdict == "APPROVE" else []
    state = WorkflowState(
        workflow_name="ralplan_critic",
        current_phase="critic",
        readiness="ready_for_handoff" if verdict == "APPROVE" else "needs_revision",
        evidence_gaps=[] if has_context else ["缺少代码位置、事件名或已知模块线索。"],
        memory_preflight=_memory_preflight(request.task, request.known_context, request.memory_context, required=not has_context),
    )
    next_tool = "ralplan_handoff" if verdict == "APPROVE" else None
    critic_markdown = "\n".join(
        [
            f"# Critic Verdict: {request.task}",
            f"- Verdict: {verdict}",
            *[f"- Check {'PASS' if check.passed else 'FAIL'}: {check.name} — {check.detail}" for check in checks],
            *[f"- Required revision: {item}" for item in required_revisions],
        ]
    )
    return RalplanCriticResult(
        status=ToolStatus.OK if verdict == "APPROVE" else ToolStatus.NEEDS_INPUT,
        summary="Critic 已批准当前计划；下一步进入 handoff。" if verdict == "APPROVE" else "Critic 要求修订后再继续。",
        assumptions=[],
        next_actions=[build_next_action("下一步", "调用 ralplan_handoff。" if verdict == "APPROVE" else "补充上下文或修订后重新进入 planner/architect/critic。")],
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
            quality_checks=checks,
            approval_reasons=approval_reasons,
            rejection_reasons=rejection_reasons,
            required_revisions=required_revisions,
            critic_review_markdown=critic_markdown,
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(title="Critic 已完成", summary="当前 phase 已完成审批。" if verdict == "APPROVE" else "当前 phase 已完成审查并要求修订。"),
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
    approved_markdown = "\n".join(
        [
            f"# Approved Plan: {request.task}",
            "",
            f"- Summary: {request.approved_plan_summary}",
            "",
            "## ADR",
            "- Decision: 采用结构化 contract + engine 的方式推进。",
            "- Drivers: MCP-first / 宿主驱动 / 增量兼容。",
            "- Alternatives considered: 只修文档；把 skill 执行器行为搬进 tool。",
            "- Why chosen: 恢复可消费语义且不破坏 Ymcp 边界。",
        ]
    ) if approved else None
    adr = _build_adr(request.task) if approved else None
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
            approved_plan_markdown=approved_markdown,
            adr=adr,
            ralph_handoff_guidance=_build_handoff_guidance(request.task, "Ralph"),
            workflow_state=state,
            phase_summary=WorkflowPhaseSummary(title="Ralplan Handoff", summary="当前 phase 只负责收集下一步 workflow 选择。" if approved else "当前 phase 被 critic verdict 阻断。"),
        ),
    )
