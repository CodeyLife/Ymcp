from ymcp.contracts.common import ToolStatus
from ymcp.contracts.ralplan import AdrDraft, RalplanArtifacts, RalplanRequest, RalplanResult, ViableOption
from ymcp.contracts.workflow import ContinuationContract, HandoffContract, HandoffOption, MemoryPreflight, WorkflowState
from ymcp.core.result import build_meta, build_next_action, build_risk


def _options(deliberate: bool) -> list[ViableOption]:
    options = [
        ViableOption(name="状态机投影", pros=["最适合 Trae 宿主循环调用", "避免把 skill 原文直接塞给用户"], cons=["需要维护额外 contract 字段"]),
        ViableOption(name="prompt 包投影", pros=["最贴近 skill 原文"], cons=["Trae 使用成本高", "不够 MCP-native"]),
    ]
    if deliberate:
        options.append(ViableOption(name="双层模式", pros=["兼顾保真与易用"], cons=["实现复杂度更高"] ))
    return options





def _detect_critic_verdict(request: RalplanRequest) -> str:
    if request.critic_verdict_input:
        normalized = request.critic_verdict_input.strip().upper()
        if normalized in {"APPROVE", "REVISE", "REJECT"}:
            return normalized
    joined = "\n".join(request.critic_feedback).upper()
    if "REJECT" in joined or "驳回" in "\n".join(request.critic_feedback):
        return "REJECT"
    if "APPROVE" in joined or "批准" in "\n".join(request.critic_feedback) or "通过" in "\n".join(request.critic_feedback):
        return "APPROVE"
    if request.critic_feedback:
        return "REVISE"
    return "APPROVE"


def build_ralplan(request: RalplanRequest) -> RalplanResult:
    phase = request.current_phase
    options = _options(request.deliberate)
    chosen_option = "状态机投影"
    architect_prompt = None
    critic_prompt = None
    revise = []
    critic_verdict = None
    handoff = None
    status = ToolStatus.OK
    readiness = "in_progress"
    host_action = "宿主按当前阶段切换 perspective，并把结果继续传回 ralplan。"
    handoff_target = None
    if phase == "planner_draft":
        architect_prompt = "请以 Architect 视角审查当前 favored option 的边界、反例和 tradeoff。"
        host_action = "宿主下一步应以 Architect 视角审查 planner draft。"
        handoff_target = "ralplan"
    elif phase == "architect_review":
        critic_prompt = "请以 Critic 视角检查 plan 的清晰度、测试性、风险和验证步骤。"
        host_action = "宿主下一步应以 Critic 视角评估 architect review 之后的计划。"
        handoff_target = "ralplan"
    elif phase == "critic_review":
        critic_verdict = _detect_critic_verdict(request)
        if critic_verdict in {"REVISE", "REJECT"}:
            phase = "revise"
            revise = request.critic_feedback or ["请补齐 acceptance criteria、验证步骤和架构边界。"]
            host_action = "宿主应根据 critic feedback 修订 planner draft，然后再次进入 architect_review。" if critic_verdict == "REVISE" else "宿主应重新规划或缩小范围，然后从 planner_draft 重新开始。"
            handoff_target = "ralplan"
            readiness = "needs_revision" if critic_verdict == "REVISE" else "rejected"
            status = ToolStatus.NEEDS_INPUT
        else:
            phase = "approved"
            readiness = "ready_for_handoff"
            handoff_target = "ralph"
            handoff = HandoffContract(
                target_tool="ralph",
                invocation_summary=f"已批准计划：{request.task}",
                required_inputs=["approved_plan", "latest_evidence", "verification_commands"],
                constraints_to_preserve=["宿主控制执行", "不得将 MCP server 视为 agent runtime"],
            )
            host_action = "宿主应把 approved plan 摘要和验证命令交给 ralph。"
    elif phase == "revise":
        phase = "architect_review"
        host_action = "宿主应使用修订后的计划重新进行 Architect 审查。"
        handoff_target = "ralplan"
        status = ToolStatus.NEEDS_INPUT
    elif phase in {"approved", "handoff_to_ralph"}:
        phase = "handoff_to_ralph"
        readiness = "ready_for_handoff"
        handoff_target = "ralph"
        handoff = HandoffContract(
            target_tool="ralph",
            invocation_summary=f"已批准计划：{request.task}",
            required_inputs=["approved_plan", "latest_evidence", "verification_commands"],
            constraints_to_preserve=["宿主控制执行", "按批准计划收集验证证据"],
        )
        host_action = "宿主调用 ralph，并传入 approved plan 和最新证据。"
    state = WorkflowState(
        workflow_name="ralplan",
        current_phase=phase,
        readiness=readiness,
        host_next_action=host_action,
        required_host_inputs=["planner_draft"] if phase == "planner_draft" and not request.planner_draft else [],
        handoff_target=handoff_target,
        handoff_contract=handoff.invocation_summary if handoff else None,
        evidence_gaps=[] if request.planner_draft or phase == "planner_draft" else ["缺少 planner draft 或评审反馈。"],
        blocked_reason=None,
        skill_source="skills/ralplan/SKILL.md",
        memory_preflight=MemoryPreflight(
            required=phase == "planner_draft" and not bool(request.constraints),
            reason="进入 ralplan 共识规划前应读取相关记忆，补充历史方案、约束和踩坑结论。",
            query=request.task,
            already_satisfied=bool(request.constraints) or phase != "planner_draft",
        ),
    )
    return RalplanResult(
        status=status,
        summary=f"已生成 ralplan 阶段 `{phase}` 的状态机投影。",
        assumptions=["Planner / Architect / Critic 视角在同一 Trae 宿主上下文中顺序完成。"],
        next_actions=[build_next_action("继续共识规划", host_action)],
        risks=[build_risk("若跳过 Architect 或 Critic 阶段，计划质量会显著下降。", "必须按顺序推进 planner → architect → critic。")],
        meta=build_meta("ralplan", "ymcp.contracts.ralplan.RalplanResult", host_controls=["切换视角", "保留评审记录", "决定是否交接 ralph"]),
        artifacts=RalplanArtifacts(
            principles=["宿主控制执行", "状态机投影优先", "以可测试计划为准"],
            decision_drivers=["Trae 易用性", "MCP 输出结构化", "避免虚假 agent loop"],
            viable_options=options,
            chosen_option=chosen_option,
            adr=AdrDraft(
                decision="将 skills 语义投影为 MCP 状态机，而不是直接输出整段 skill 文本。",
                drivers=["Trae 更易消费", "更适合结构化交接", "避免宿主误解为自动执行器"],
                alternatives_considered=[o.name for o in options],
                consequences=["需要维护 workflow_state 字段", "文档和测试必须同步更新"],
                follow_ups=["批准后交给 ralph，按验证证据继续推进。"],
            ),
            test_strategy=["单元测试各 phase 转移", "契约测试 handoff_contract", "集成测试多轮 ralplan 调用"],
            architect_review_prompt=architect_prompt,
            critic_review_prompt=critic_prompt,
            revise_instructions=revise,
            workflow_state=state,
            continuation=ContinuationContract(
                interaction_mode="handoff" if handoff_target == "ralph" else "continue_workflow",
                continuation_required=handoff_target != "ralph",
                continuation_kind="handoff_to_tool" if handoff_target == "ralph" else "next_phase",
                continuation_payload={"next_phase": phase, "next_tool": handoff_target},
                recommended_user_message=None,
                recommended_host_action="向用户展示批准后的下一步选项，而不是结束对话。" if handoff_target == "ralph" else host_action,
                handoff_options=[] if handoff_target != "ralph" else [
                    HandoffOption(label="使用 ralph 逐步实施并验证", tool="ralph", description="按批准计划进入执行、修复和验证循环。", payload_hint={"approved_plan": "handoff_contract.invocation_summary"}),
                    HandoffOption(label="使用 plan 拆成更细执行计划", tool="plan", description="先把批准方案拆成更细的执行步骤。", payload_hint={"task": "task", "mode": "direct"}),
                    HandoffOption(label="保存规划摘要到记忆", tool="memory_store", description="把批准的架构决策、约束和验证策略保存为长期记忆。", payload_hint={"content": "artifacts.adr"}),
                ],
                default_option="ralph" if handoff_target == "ralph" else None,
                selection_required=handoff_target == "ralph",
                option_prompt="共识规划已批准。您希望我继续哪个方向？" if handoff_target == "ralph" else None,
            ),
            critic_verdict=critic_verdict,
            handoff_contract=handoff,
        ),
    )
