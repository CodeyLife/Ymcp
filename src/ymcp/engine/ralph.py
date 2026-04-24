from ymcp.contracts.common import ToolStatus
from ymcp.contracts.ralph import RalphArtifacts, RalphRequest, RalphResult
from ymcp.contracts.workflow import WorkflowChoiceMenu, WorkflowChoiceOption, WorkflowPhaseSummary, WorkflowState
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
    completion_options = [
        WorkflowChoiceOption(id="mempalace_add_drawer", label="写入 mempalace_add_drawer", description="保存完成摘要到长期记忆。", kind="tool", tool="mempalace_add_drawer", recommended=True),
        WorkflowChoiceOption(id="plan", label="进入 plan", description="基于结果重新规划。", kind="tool", tool="plan"),
        WorkflowChoiceOption(id="finish", label="结束当前流程", description="结束当前工作流，不再继续后续步骤。", kind="host_action", action="finish"),
    ]
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
    phase_summary = {
        "complete": WorkflowPhaseSummary(
            title="执行闭环已完成",
            summary="ralph 判断当前工作流已完成，宿主应让用户选择沉淀记忆、重新规划或直接结束，而不是立刻收尾。",
            highlights=[
                f"evidence 条数：{len(request.latest_evidence)}",
                f"verification_commands 条数：{len(request.verification_commands)}",
                "推荐下一步：写入长期记忆",
            ],
        ),
        "fixing": WorkflowPhaseSummary(
            title="存在失败项，需继续修复",
            summary="当前检测到已知失败项，宿主应优先修复再重新验证，而不是将此轮误判为完成。",
            highlights=request.known_failures or ["存在已知失败项"],
        ),
        "needs_more_evidence": WorkflowPhaseSummary(
            title="缺少执行证据",
            summary="当前还没有足够的新鲜证据，ralph 无法给出可靠继续/停止判断。",
            highlights=["需要补充 latest_evidence", "证据应来自真实执行或验证结果"],
        ),
        "needs_verification_plan": WorkflowPhaseSummary(
            title="缺少验证计划",
            summary="当前已有执行证据，但还没有明确 verification_commands，不能完成闭环判断。",
            highlights=["需要补充 verification_commands", "验证命令应可实际运行"],
        ),
        "continue": WorkflowPhaseSummary(
            title="继续执行中",
            summary="当前证据足够支撑继续执行，宿主应沿 approved plan 推进，并在关键节点重新调用 ralph。",
            highlights=[
                f"approved_plan：{request.approved_plan}",
                f"latest_evidence 条数：{len(request.latest_evidence)}",
            ],
        ),
    }[judgement]
    choice_menu = None
    if judgement == "complete":
        choice_menu = WorkflowChoiceMenu(
            title="请选择 ralph 完成后的下一步动作",
            prompt="执行闭环已完成。若宿主未正确渲染 Elicitation，也应直接展示以下结构化菜单。",
            options=completion_options,
            recommended_option_id="mempalace_add_drawer",
            fallback_instructions="selected_next_tool 为空时，不要结束对话；继续展示完成摘要和 options。",
        )
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
            phase_summary=phase_summary,
            choice_menu=choice_menu,
            requested_input=requested_input,
        ),
    )
