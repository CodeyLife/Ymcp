from ymcp.contracts.common import ToolStatus
from ymcp.contracts.plan import PlanArtifacts, PlanRequest, PlanResult
from ymcp.contracts.workflow import MemoryPreflight, WorkflowState
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
    criteria = request.acceptance_criteria or ["计划包含目标、步骤、风险和验证方式。", "宿主能从计划中判断下一步。"]
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
            recommended_next_tool=recommended_next_tool,
            review_verdict=verdict,
            requested_input=requested_input,
        ),
    )
