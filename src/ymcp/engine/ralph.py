from ymcp.contracts.common import ToolStatus
from ymcp.contracts.ralph import RalphArtifacts, RalphRequest, RalphResult
from ymcp.contracts.workflow import ContinuationContract, HandoffOption, ToolCallTemplate, WorkflowState
from ymcp.core.result import build_meta, build_next_action, build_risk


def build_ralph(request: RalphRequest) -> RalphResult:
    has_evidence = bool(request.latest_evidence)
    has_failures = bool(request.known_failures)
    verification_defined = bool(request.verification_commands)
    if request.current_phase == "complete":
        readiness = "complete"
        status = ToolStatus.OK
        next_action = "宿主可输出最终完成报告并沉淀可复用经验。"
        judgement = "complete"
        missing = []
    elif has_failures:
        readiness = "fixing"
        status = ToolStatus.NEEDS_INPUT
        next_action = "宿主应先修复失败项，再重新收集验证证据。"
        judgement = "fixing"
        missing = []
    elif not has_evidence:
        readiness = "needs_input"
        status = ToolStatus.NEEDS_INPUT
        next_action = "宿主需要提供最新测试、构建、lint 或人工验证证据。"
        judgement = "needs_more_evidence"
        missing = ["latest_evidence"]
    elif not verification_defined:
        readiness = "needs_input"
        status = ToolStatus.NEEDS_INPUT
        next_action = "宿主需要补充 verification_commands，便于判断是否可以完成。"
        judgement = "needs_verification_plan"
        missing = ["verification_commands"]
    else:
        readiness = "executing"
        status = ToolStatus.OK
        next_action = "宿主根据 approved plan 和最新证据继续执行下一步，并在关键节点重新调用 ralph。"
        judgement = "continue"
        missing = []
    state = WorkflowState(
        workflow_name="ralph",
        current_phase=request.current_phase if readiness != "fixing" else "fixing",
        readiness=readiness,
        host_next_action=next_action,
        host_action_type="show_options" if judgement == "complete" else ("collect_evidence" if missing else ("revise_plan" if has_failures else "run_host_execution")),
        required_host_inputs=missing,
        handoff_target=None,
        handoff_contract=None,
        evidence_gaps=missing,
        blocked_reason="存在已知失败项" if has_failures else None,
        skill_source="skills/ralph/SKILL.md",
    )
    reusable_memory = [e for e in request.latest_evidence if "约定" in e or "偏好" in e or "流程" in e][:3]
    skill_candidates = [f for f in request.known_failures if "流程" in f or "重复" in f][:3]
    return RalphResult(
        status=status,
        summary="已生成 ralph 宿主控制循环状态。",
        assumptions=["Trae 负责执行命令、保存状态、决定何时再次调用 ralph。"],
        next_actions=[build_next_action("继续 Ralph 循环", next_action)],
        risks=[build_risk("如果宿主不提供新鲜证据，ralph 只能返回泛化建议。", "每轮都附带最新验证结果和失败信息。")],
        meta=build_meta("ralph", "ymcp.contracts.ralph.RalphResult", host_controls=["执行", "验证", "循环调用", "沉淀经验"]),
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
            continuation=ContinuationContract(
                interaction_mode="complete" if judgement == "complete" else "continue_workflow",
                continuation_required=True,
                continuation_kind=("select_completion_option" if judgement == "complete" else ("provide_evidence" if missing else ("fix_failures" if has_failures else "host_execution"))),
                continuation_payload={"current_phase": state.current_phase, "missing_evidence": missing, "judgement": judgement},
                recommended_user_message="Ralph 已判断当前工作流完成。请选择下一步：1) 保存完成经验到记忆；2) 使用 plan 规划下一阶段；3) 结束当前工作流。不要在用户选择前结束对话。" if judgement == "complete" else None,
                recommended_host_action="向用户展示完成后的下一步选项，并等待用户选择；不要在用户选择前结束对话。" if judgement == "complete" else next_action,
                handoff_options=[] if judgement != "complete" else [
                    HandoffOption(label="保存完成经验到记忆", tool="memory_store", description="保存稳定事实、用户偏好、项目约定或踩坑结论。", payload_hint={"content": "artifacts.final_report_skeleton"}),
                    HandoffOption(label="使用 plan 规划下一阶段", tool="plan", description="基于本次完成结果继续规划下一阶段。", payload_hint={"task": "下一阶段计划", "mode": "auto"}),
                    HandoffOption(label="结束当前工作流", tool=None, description="只输出完成报告，不再调用其他工具。", payload_hint={}),
                ],
                tool_call_templates=[
                    ToolCallTemplate(
                        tool="ralph",
                        purpose="当前仍需补证据、修复失败或继续执行时，下一轮重新判断用。",
                        arguments={
                            "approved_plan": "保持同一个已批准计划摘要",
                            "latest_evidence": ["填入最新测试/构建/lint/人工验收结果摘要"],
                            "verification_commands": ["用于验证完成的命令或人工验收动作"],
                            "known_failures": ["如果有失败项，逐条列出；没有则传空列表"],
                            "current_phase": "executing / verifying / complete，根据宿主当前阶段填写",
                        },
                    ),
                    ToolCallTemplate(
                        tool="memory_store",
                        purpose="Ralph 判断完成且用户选择沉淀经验时调用。",
                        arguments={
                            "content": "根据 final_report_skeleton 整理稳定事实、项目约定或踩坑结论；不要保存临时日志或敏感信息",
                            "wing": "personal",
                            "room": "ymcp",
                            "added_by": "ymcp",
                        },
                    ),
                    ToolCallTemplate(
                        tool="plan",
                        purpose="Ralph 判断完成且用户选择规划下一阶段时调用。",
                        arguments={
                            "task": "下一阶段要规划的问题；基于本次完成结果由宿主整理",
                            "mode": "auto",
                            "known_context": ["本次完成摘要、剩余风险、可复用经验"],
                        },
                    ),
                ],
                default_option="memory_store" if judgement == "complete" else None,
                selection_required=judgement == "complete",
                option_prompt="Ralph 已判断当前工作流完成。您希望我继续哪个方向？" if judgement == "complete" else None,
            ),
        ),
    )
