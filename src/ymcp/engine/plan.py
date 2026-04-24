from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.plan import PlanArtifacts, PlanRequest, PlanResult
from ymcp.contracts.workflow import HandoffContract, MemoryPreflight, QualityCheck, WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_meta, build_next_action
from ymcp.engine.memory_preflight import analyze_memory_context


def _is_vague(request: PlanRequest) -> bool:
    stripped = "".join(request.task.split())
    has_cjk = any("一" <= char <= "鿿" for char in stripped)
    too_short = len(stripped) < 4 if has_cjk else len(request.task.split()) < 8
    return request.mode == "auto" and too_short and not request.acceptance_criteria and not request.constraints and not request.known_context and not request.desired_outcome


def _quality_checks(request: PlanRequest, mode: str, has_context: bool) -> list[QualityCheck]:
    has_acceptance = bool(request.acceptance_criteria)
    return [
        QualityCheck(name="task_defined", passed=bool(request.task.strip()), detail="任务描述已提供。"),
        QualityCheck(name="context_grounded", passed=has_context or mode in {"interview", "review"}, detail="已提供 known_context，或当前模式允许先补上下文。"),
        QualityCheck(name="acceptance_defined", passed=has_acceptance or mode in {"interview", "review", "consensus"}, detail="direct 计划建议至少给出一条可测试验收标准。"),
    ]


def _requirements_summary(request: PlanRequest) -> list[str]:
    summary = [f"任务：{request.task}"]
    if request.desired_outcome:
        summary.append(f"期望结果：{request.desired_outcome}")
    if request.constraints:
        summary.append(f"约束：{'；'.join(request.constraints)}")
    if request.known_context:
        summary.append(f"已知上下文：{'；'.join(request.known_context[:3])}")
    return summary


def _implementation_steps(request: PlanRequest) -> list[str]:
    task = request.task
    return [
        f"梳理 `{task}` 的目标、边界和已知上下文。",
        "形成实现/修改步骤，并明确影响范围与验证方式。",
        "在实施前确认验收标准、风险和回归验证路径。",
    ]


def _verification_plan(request: PlanRequest) -> list[str]:
    checks = [*request.acceptance_criteria] if request.acceptance_criteria else ["至少补充一条可执行验收标准。"]
    checks.append("实现完成后运行相关测试/检查并记录证据。")
    return checks


def _plan_markdown_draft(request: PlanRequest, requirements_summary: list[str], implementation_steps: list[str], verification_plan: list[str]) -> str:
    acceptance = request.acceptance_criteria or ["[待补充] 至少一条可测试验收标准"]
    risks = request.constraints or ["[待确认] 是否存在必须保留的不变量或宿主边界"]
    return "\n".join(
        [
            f"# Plan: {request.task}",
            "",
            "## Requirements Summary",
            *[f"- {line}" for line in requirements_summary],
            "",
            "## Acceptance Criteria",
            *[f"- {line}" for line in acceptance],
            "",
            "## Implementation Steps",
            *[f"{idx}. {line}" for idx, line in enumerate(implementation_steps, 1)],
            "",
            "## Risks and Mitigations",
            *[f"- {line}" for line in risks],
            "",
            "## Verification Plan",
            *[f"- {line}" for line in verification_plan],
        ]
    )


def build_plan(request: PlanRequest) -> PlanResult:
    search_performed, retrieved_count, retrieved_context = analyze_memory_context(request.known_context, request.memory_context)
    mode = request.mode
    if mode == "auto":
        mode = "interview" if _is_vague(request) else "direct"

    has_context = bool(request.known_context)
    requirements_summary = _requirements_summary(request)
    implementation_steps = _implementation_steps(request)
    verification_plan = _verification_plan(request)
    plan_markdown_draft = _plan_markdown_draft(request, requirements_summary, implementation_steps, verification_plan)
    quality_checks = _quality_checks(request, mode, has_context)
    review_findings = [f"Review target: {request.review_target}"] if request.review_target else []
    required_revisions = [] if request.review_target else ["补充 review_target 以进行 reviewer pass。"]
    handoff_contracts = [
        HandoffContract(tool="ralph", input_artifact="plan_markdown_draft", consumer_expectations=["按计划执行并回传最新证据。"], already_satisfied_stages=["planning"], residual_risk=[]),
        HandoffContract(tool="ralplan", input_artifact="plan_markdown_draft", consumer_expectations=["进入更严格的共识规划。"], already_satisfied_stages=["direct_planning"], residual_risk=[]),
        HandoffContract(tool="deep_interview", input_artifact="plan_markdown_draft", consumer_expectations=["继续澄清不清楚的边界。"], already_satisfied_stages=["initial_triage"], residual_risk=["当前任务仍可能过于模糊"]),
    ]

    if mode == "review":
        phase = "review"
        status = ToolStatus.OK if request.review_target else ToolStatus.NEEDS_INPUT
        readiness = "review_complete" if request.review_target else "needs_input"
        result_summary = "需要 review_target。" if not request.review_target else "计划 review 已完成。"
        phase_summary = WorkflowPhaseSummary(
            title="计划 review",
            summary="宿主应通过 MCP Elicitation 收集 review_target，并基于其进行 reviewer pass。" if not request.review_target else "review 已完成，可消费 reviewer verdict / findings / required revisions。",
            highlights=["以 reviewer 视角评估现有计划是否足够可执行。"],
        )
        review_verdict = "REVISE" if request.review_target else None
        if request.review_target:
            review_findings.append("当前 review 仅完成结构化评估占位，需根据目标补更具体问题。")
            required_revisions = ["将 review findings 细化为文件/模块级问题列表。"]
    elif mode == "consensus":
        phase = "consensus_handoff"
        status = ToolStatus.OK
        readiness = "ready_for_handoff"
        result_summary = "宿主应提供下一步 workflow 选项，并通过 MCP Elicitation 让用户决定是否进入 ralplan。"
        phase_summary = WorkflowPhaseSummary(
            title="转入共识规划",
            summary="当前 direct plan 已生成，可作为 ralplan 的输入草稿；宿主应通过 MCP Elicitation 决定是否进入 ralplan。",
            highlights=["当前 direct plan 已可作为 ralplan 的输入草稿。"],
        )
        review_verdict = None
    elif mode == "interview":
        phase = "interview_required"
        status = ToolStatus.NEEDS_INPUT
        readiness = "needs_input"
        result_summary = "任务过于模糊，需要先澄清。"
        phase_summary = WorkflowPhaseSummary(
            title="需要先澄清",
            summary="任务当前不足以生成可靠计划；宿主应通过 MCP Elicitation 让用户选择进入 deep_interview 或直接补充更具体目标。",
            highlights=["当前缺少足够上下文，先不要进入实现计划。"],
        )
        review_verdict = None
    else:
        phase = "direct_plan"
        status = ToolStatus.OK
        readiness = "plan_ready"
        result_summary = "宿主应提供下一步 workflow 选项，并通过 MCP Elicitation 让用户显式选择。"
        phase_summary = WorkflowPhaseSummary(
            title="直接计划",
            summary="当前已生成结构化 plan_markdown_draft、implementation steps 与 verification plan；宿主应通过 MCP Elicitation 选择下一步 workflow。",
            highlights=["当前已生成结构化 plan_markdown_draft。"],
        )
        review_verdict = None

    state = WorkflowState(
        workflow_name="plan",
        current_phase=phase,
        readiness=readiness,
        evidence_gaps=[] if has_context else ["缺少项目事实或现有实现线索。"],
        memory_preflight=MemoryPreflight(
            required=not has_context,
            reason="进入 plan 前应先搜索历史约束、用户偏好和项目决策。",
            query=request.task,
            already_satisfied=has_context,
            search_performed=search_performed,
            retrieved_count=retrieved_count,
            retrieved_context=retrieved_context,
        ),
    )
    return PlanResult(
        status=status,
        summary=result_summary,
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
            acceptance_criteria=request.acceptance_criteria,
            requirements_summary=requirements_summary,
            implementation_steps=implementation_steps,
            risks_and_mitigations=request.constraints or ["补充风险与缓解措施。"],
            verification_plan=verification_plan,
            plan_markdown_draft=plan_markdown_draft,
            mode_reason="任务过于模糊，需先澄清。" if mode == "interview" else f"当前以 {mode} 模式处理。",
            quality_checks=quality_checks,
            review_verdict=review_verdict,
            review_findings=review_findings,
            required_revisions=required_revisions,
            handoff_contracts=handoff_contracts,
            workflow_state=state,
            phase_summary=phase_summary,
        ),
    )
