from ymcp.contracts.common import ToolStatus
from ymcp.contracts.plan import PlanArtifacts, PlanRequest, PlanResult
from ymcp.contracts.workflow import ContinuationContract, HandoffOption, MemoryPreflight, ToolCallTemplate, WorkflowState
from ymcp.core.result import build_meta, build_next_action, build_risk
from ymcp.engine.memory_preflight import analyze_memory_context


def _is_vague(request: PlanRequest) -> bool:
    stripped = "".join(request.task.split())
    has_cjk = any("\u4e00" <= char <= "\u9fff" for char in stripped)
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
        host_action = "根据 review_verdict 修改计划。" if request.review_target else "请提供 review_target。"
        status = ToolStatus.OK if request.review_target else ToolStatus.NEEDS_INPUT
    elif mode == "consensus":
        verdict = None
        phase = "consensus_handoff"
        readiness = "ready_for_handoff"
        host_action = "调用 ralplan，并传入当前 task、constraints、known_context。"
        status = ToolStatus.OK
    elif mode == "interview":
        verdict = None
        phase = "interview_required"
        readiness = "needs_input"
        host_action = "调用 deep_interview 继续澄清需求。"
        status = ToolStatus.NEEDS_INPUT
    else:
        verdict = None
        phase = "direct_plan"
        readiness = "plan_ready"
        host_action = "宿主审阅计划后决定是否执行或交给 ralph。"
        status = ToolStatus.OK
    criteria = request.acceptance_criteria or ["计划包含目标、步骤、风险和验证方式。", "宿主能从计划中判断下一步。"]
    state = WorkflowState(
        workflow_name="plan",
        current_phase=phase,
        readiness=readiness,
        host_next_action=host_action,
        host_action_type="show_options" if mode == "direct" else ("call_tool" if mode in {"interview", "consensus"} else ("ask_user" if mode == "review" and not request.review_target else "run_host_execution")),
        required_host_inputs=["review_target"] if mode == "review" and not request.review_target else [],
        handoff_target="deep_interview" if mode == "interview" else ("ralplan" if mode == "consensus" else None),
        handoff_contract="传入 task、constraints、known_context。" if mode in {"interview", "consensus"} else None,
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
        summary=f"已按 {mode} 模式生成 plan 状态机投影。",
        assumptions=["Trae 负责继续提问、审阅、执行或调用下一个工具。"],
        next_actions=[build_next_action("下一步", host_action)],
        risks=[build_risk("缺少事实依据会降低计划可靠性。", "宿主应提供 known_context 或先做需求澄清。")],
        meta=build_meta("plan", "ymcp.contracts.plan.PlanResult", host_controls=["审阅", "提问", "执行", "调用后续工具"]),
        artifacts=PlanArtifacts(
            requirements_summary=[f"任务：{request.task}", f"模式：{mode}", *(f"约束：{c}" for c in request.constraints)],
            implementation_steps=[
                "确认需求和边界。",
                "列出可测试验收标准。",
                "按优先级实施最小闭环。",
                "运行验证并收集证据。",
            ],
            acceptance_criteria=criteria,
            risks_and_mitigations=["需求过宽：先调用 deep_interview。", "高风险方案：使用 ralplan consensus。"],
            verification_steps=["检查每条 acceptance criteria 是否可测试。", "执行宿主项目的测试/构建/检查命令。"],
            evidence_gaps=state.evidence_gaps,
            workflow_state=state,
            continuation=ContinuationContract(
                interaction_mode="handoff" if state.handoff_target else ("continue_workflow" if status is ToolStatus.OK else "ask_user"),
                continuation_required=True,
                continuation_kind="handoff_to_tool" if state.handoff_target else ("review_input" if mode == "review" and not request.review_target else ("user_clarification" if mode == "interview" else ("select_handoff_option" if mode == "direct" else "host_execution"))),
                continuation_payload={"next_tool": state.handoff_target, "mode": mode},
                recommended_user_message="请补充 review_target。" if mode == "review" and not request.review_target else ("计划已生成。请选择下一步：1) 使用 ralph 逐步实施并验证；2) 使用 ralplan 做共识规划；3) 回到 deep_interview 继续澄清。不要在用户选择前结束对话。" if mode == "direct" else None),
                recommended_host_action="向用户展示下一步工作流选项，并等待用户选择；不要在用户选择前结束对话。" if mode == "direct" else state.host_next_action,
                handoff_options=[] if mode != "direct" else [
                    HandoffOption(label="使用 ralph 逐步实施并验证", tool="ralph", description="使用当前计划进入执行与验证循环。", payload_hint={"approved_plan": "artifacts.requirements_summary", "verification_commands": "artifacts.verification_steps"}),
                    HandoffOption(label="使用 ralplan 做共识规划", tool="ralplan", description="当计划风险较高或需要多方案取舍时选择。", payload_hint={"task": "task", "current_phase": "planner_draft"}),
                    HandoffOption(label="回到 deep_interview 继续澄清", tool="deep_interview", description="如果仍觉得需求边界不清，继续深访。", payload_hint={"brief": "task"}),
                ],
                tool_call_templates=[
                    ToolCallTemplate(
                        tool="ralph",
                        purpose="用户选择进入执行验证循环时调用；approved_plan 用本次 plan 的 requirements_summary/implementation_steps 摘要。",
                        arguments={
                            "approved_plan": "把本次计划摘要、步骤、验收标准整理成一段文本",
                            "latest_evidence": ["刚执行或人工确认的最新证据；没有证据时先不要伪造"],
                            "verification_commands": ["本计划建议的测试/构建/lint/人工验收命令"],
                            "current_phase": "executing",
                        },
                    ),
                    ToolCallTemplate(
                        tool="ralplan",
                        purpose="用户选择高风险共识规划时调用。",
                        arguments={
                            "task": "沿用当前 plan.task 或宿主整理后的问题描述",
                            "current_phase": "planner_draft",
                            "constraints": ["必须保持的约束"],
                            "known_context": ["可选：项目事实、记忆摘要"],
                        },
                    ),
                    ToolCallTemplate(
                        tool="deep_interview",
                        purpose="用户认为需求仍不清楚时调用。",
                        arguments={
                            "brief": "沿用当前 task，说明还需要澄清",
                            "known_context": ["可选：当前计划中已确认的事实"],
                        },
                    ),
                ],
                default_option="ralph" if mode == "direct" else None,
                selection_required=mode == "direct",
                option_prompt="计划已生成。您希望我继续哪个方向？" if mode == "direct" else None,
            ),
            recommended_next_tool=state.handoff_target,
            review_verdict=verdict,
        ),
    )
