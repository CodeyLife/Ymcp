from ymcp.contracts.common import ToolStatus
from ymcp.contracts.plan import PlanArtifacts, PlanRequest, PlanResult
from ymcp.contracts.workflow import MemoryPreflight, WorkflowChoiceMenu, WorkflowChoiceOption, WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_meta, build_next_action, build_risk
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
        verdict = "REVISE" if not request.review_target else "APPROVE_WITH_NOTES"
        phase = "review"
        readiness = "review_complete" if request.review_target else "needs_input"
        status = ToolStatus.OK if request.review_target else ToolStatus.NEEDS_INPUT
        requested_input = None if request.review_target else "review_target；支持 Elicitation 的客户端应由服务器发起表单请求。"
        recommended_next_tool = None
    elif mode == "consensus":
        verdict = None
        phase = "consensus_handoff"
        readiness = "ready_for_handoff"
        status = ToolStatus.OK
        requested_input = None
        recommended_next_tool = "ralplan"
    elif mode == "interview":
        verdict = None
        phase = "interview_required"
        readiness = "needs_input"
        status = ToolStatus.NEEDS_INPUT
        requested_input = "选择进入 deep_interview 或补充更具体需求；支持 Elicitation 的客户端应由服务器发起表单请求。"
        recommended_next_tool = "deep_interview"
    else:
        verdict = None
        phase = "direct_plan"
        readiness = "plan_ready"
        status = ToolStatus.OK
        requested_input = "选择下一步 workflow：ralph / ralplan / deep_interview；支持 Elicitation 的客户端应由服务器发起表单请求。"
        recommended_next_tool = None
    direct_options = [
        WorkflowChoiceOption(id="ralph", label="进入 ralph", description="基于当前计划进入执行与验证闭环。", kind="tool", tool="ralph", recommended=True),
        WorkflowChoiceOption(id="ralplan", label="进入 ralplan", description="如果需要多视角审查，再进入共识规划。", kind="tool", tool="ralplan"),
        WorkflowChoiceOption(id="deep_interview", label="返回 deep_interview", description="如果边界仍不清晰，继续澄清需求。", kind="tool", tool="deep_interview"),
    ]
    criteria = request.acceptance_criteria or ["计划包含目标、步骤、风险和验证方式。", "宿主能从计划中判断下一步。"]
    phase_summary = {
        "review": WorkflowPhaseSummary(
            title="计划 review 阶段",
            summary="当前处于 review 模式，等待宿主提供 review_target 或完成评审目标补充。",
            highlights=["review_target 缺失时不能完成 review", "宿主应继续索取评审目标"],
        ),
        "consensus_handoff": WorkflowPhaseSummary(
            title="建议进入 ralplan 共识规划",
            summary="当前任务适合交给 ralplan 进行 Planner / Architect / Critic 共识流程，以产出更稳健的批准方案。",
            highlights=["recommended_next_tool=ralplan", "适用于高风险或架构型问题"],
        ),
        "interview_required": WorkflowPhaseSummary(
            title="任务过于模糊，需要先澄清",
            summary="当前 task 信息不足，直接计划风险较高，应先进入 deep_interview 或补充更具体任务。",
            highlights=["缺少明确范围或验收标准", "宿主不应在此状态下自动直接执行"],
        ),
        "direct_plan": WorkflowPhaseSummary(
            title="直接计划已生成",
            summary="计划已可供宿主展示和执行，下一步应由用户在 ralph、ralplan 或 deep_interview 之间做选择。",
            highlights=[
                f"任务：{request.task}",
                f"验收标准数量：{len(criteria)}",
                "即使 Elicitation UI 异常，也应展示结构化下一步菜单",
            ],
        ),
    }[phase]
    choice_menu = None
    if phase == "direct_plan":
        choice_menu = WorkflowChoiceMenu(
            title="请选择 plan 之后的下一步 workflow",
            prompt="计划已生成。宿主应优先使用 Elicitation；若 UI 渲染异常，则直接展示以下 options。",
            options=direct_options,
            recommended_option_id="ralph",
            fallback_instructions="selected_next_tool 为空时，不要结束对话；应继续向用户呈现 options 并等待选择。",
        )
    state = WorkflowState(
        workflow_name="plan",
        current_phase=phase,
        readiness=readiness,
        evidence_gaps=[] if request.known_context else ["缺少项目事实；如宿主可检查文件，应先补充 known_context。"],
        skill_source="skills/plan/SKILL.md",
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
        summary=f"已按 {mode} 模式生成 plan 标准结构化结果。",
        assumptions=["用户输入应优先通过 MCP Elicitation 获取；不支持时仅返回标准 structuredContent。"],
        next_actions=[build_next_action("下一步", requested_input or (f"调用 {recommended_next_tool}" if recommended_next_tool else "按计划执行并验证。"))],
        risks=[build_risk("缺少事实依据会降低计划可靠性。", "提供 known_context 或先做需求澄清。")],
        meta=build_meta("plan", "ymcp.contracts.plan.PlanResult", host_controls=["MCP Elicitation", "execution", "verification"]),
        artifacts=PlanArtifacts(
            requirements_summary=[f"任务：{request.task}", f"模式：{mode}", *(f"约束：{c}" for c in request.constraints)],
            implementation_steps=["确认需求和边界。", "列出可测试验收标准。", "按优先级实施最小闭环。", "运行验证并收集证据。"],
            acceptance_criteria=criteria,
            risks_and_mitigations=["需求过宽：使用 deep_interview。", "高风险方案：使用 ralplan。"],
            verification_steps=["检查每条 acceptance criteria 是否可测试。", "执行宿主项目的测试/构建/检查命令。"],
            evidence_gaps=state.evidence_gaps,
            workflow_state=state,
            phase_summary=phase_summary,
            choice_menu=choice_menu,
            recommended_next_tool=recommended_next_tool,
            review_verdict=verdict,
            requested_input=requested_input,
        ),
    )
