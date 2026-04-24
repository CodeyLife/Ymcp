from ymcp.contracts.common import ToolStatus
from ymcp.contracts.deep_interview import (
    DeepInterviewArtifacts,
    DeepInterviewRequest,
    DeepInterviewResult,
    DimensionScores,
    InterviewRound,
    ReadinessGates,
    SpecSkeleton,
)
from ymcp.contracts.workflow import MemoryPreflight, WorkflowChoiceMenu, WorkflowChoiceOption, WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_meta, build_next_action, build_risk
from ymcp.engine.memory_preflight import analyze_memory_context

PROFILE_THRESHOLDS = {"quick": 0.30, "standard": 0.20, "deep": 0.15}

QUESTION_BANK = {
    "intent": "你最希望这个需求解决的核心痛点是什么？请用一句话描述目标用户和当前卡点。",
    "outcome": "完成后最小可验证结果是什么？用户看到什么才算成功？",
    "scope": "第一版明确不做什么？请列出必须排除的边界。",
    "constraints": "有哪些技术、产品或使用方式约束必须始终成立？",
    "success": "请给出 2-3 条可测试的验收标准。",
    "context": "当前已有事实、文件、工具或宿主能力中，哪些会影响这个需求？",
}

RATIONALES = {
    "intent": "先澄清意图，避免直接进入实现细节。",
    "outcome": "结果不清会导致计划不可验收。",
    "scope": "Non-goals 是 deep_interview 的必过 readiness gate。",
    "constraints": "约束决定后续计划和执行边界。",
    "success": "成功标准必须可测试。",
    "context": "需要基于证据推进，无法确认时标记 evidence gap。",
}

CHOICE_OPTIONS = [
    WorkflowChoiceOption(
        id="ralplan",
        label="进入 ralplan",
        description="先做共识规划，再进入执行。",
        tool="ralplan",
        recommended=True,
    ),
    WorkflowChoiceOption(
        id="plan",
        label="进入 plan",
        description="直接产出更细的执行计划。",
        tool="plan",
    ),
    WorkflowChoiceOption(
        id="ralph",
        label="进入 ralph",
        description="基于澄清后的规格进入执行与验证闭环。",
        tool="ralph",
    ),
    WorkflowChoiceOption(
        id="refine_further",
        label="继续深访",
        description="保留当前规格，继续补充边界和细节。",
        tool="deep_interview",
    ),
]


def _score(request: DeepInterviewRequest) -> DimensionScores:
    rounds = len(request.prior_rounds)
    return DimensionScores(
        intent=min(1.0, 0.35 + 0.18 * rounds),
        outcome=min(1.0, 0.25 + 0.14 * rounds),
        scope=0.85 if request.non_goals else min(0.65, 0.2 + 0.12 * rounds),
        constraints=min(1.0, 0.3 + 0.12 * rounds + (0.1 if request.known_context else 0)),
        success=min(1.0, 0.2 + 0.13 * rounds),
        context=min(1.0, 0.2 + (0.35 if request.known_context else 0) + 0.08 * rounds),
    )


def _ambiguity(scores: DimensionScores) -> float:
    weighted = scores.intent * 0.25 + scores.outcome * 0.2 + scores.scope * 0.2 + scores.constraints * 0.15 + scores.success * 0.1 + scores.context * 0.1
    return round(max(0.0, 1.0 - weighted), 2)


def _weakest(scores: DimensionScores, request: DeepInterviewRequest) -> str:
    if not request.non_goals:
        return "scope"
    if not request.decision_boundaries:
        return "constraints"
    values = scores.model_dump()
    return min(values, key=values.get)


def build_deep_interview(request: DeepInterviewRequest) -> DeepInterviewResult:
    search_performed, retrieved_count, retrieved_context = analyze_memory_context(request.known_context, request.memory_context)
    threshold = PROFILE_THRESHOLDS.get(request.profile, request.target_threshold)
    scores = _score(request)
    ambiguity = _ambiguity(scores)
    pressure_pass = len(request.prior_rounds) >= 2
    gates = ReadinessGates(
        non_goals="resolved" if request.non_goals else "needs_clarification",
        decision_boundaries="resolved" if request.decision_boundaries else "needs_clarification",
        pressure_pass="complete" if pressure_pass else "not_started",
    )
    crystallize_ready = ambiguity <= threshold and gates.non_goals == "resolved" and gates.decision_boundaries == "resolved" and pressure_pass
    weakest = "success" if crystallize_ready else _weakest(scores, request)
    next_question = None if crystallize_ready else QUESTION_BANK[weakest]
    requested_input = (
        "请选择下一步工作流；宿主不得在用户选择前自动调用 plan、ralplan 或 ralph。"
        if crystallize_ready
        else "用户对 deep_interview 下一问的回答；支持 Elicitation 的客户端应由服务器发起 elicitation/create。"
    )
    phase_summary = (
        WorkflowPhaseSummary(
            title="需求已结晶，等待下一步工作流选择",
            summary="当前 deep_interview 已达到可交接状态，规格骨架已生成，下一步应由用户明确选择进入 ralplan、plan、ralph 或继续深访。",
            highlights=[
                f"当前歧义分数：{ambiguity}",
                "readiness gates 已满足：non_goals、decision_boundaries、pressure_pass",
                "服务器不会在未选择前自动跳转到后续 workflow",
            ],
        )
        if crystallize_ready
        else WorkflowPhaseSummary(
            title="仍需继续需求澄清",
            summary="当前需求尚未满足结晶条件，应继续回答下一问，优先补齐最弱维度与 readiness gates。",
            highlights=[
                f"当前最弱维度：{weakest}",
                f"当前歧义分数：{ambiguity}",
                f"下一问聚焦：{next_question}" if next_question else "下一问待宿主根据结果展示",
            ],
        )
    )
    choice_menu = (
        WorkflowChoiceMenu(
            title="请选择 deep_interview 的下一步工作流",
            prompt="需求已澄清完成。即使宿主未正确渲染 Elicitation，也应直接展示以下结构化选项，而不是结束对话。",
            options=CHOICE_OPTIONS,
            recommended_option_id="ralplan",
            fallback_instructions="若 Elicitation UI 不完整，宿主应直接按 options 渲染单选菜单，并在 selected_next_tool 为空时保持会话继续。",
        )
        if crystallize_ready
        else None
    )
    state = WorkflowState(
        workflow_name="deep_interview",
        current_phase="handoff_selection" if crystallize_ready else "intent_first_interview",
        readiness="needs_user_choice" if crystallize_ready else "needs_input",
        evidence_gaps=[] if request.known_context else ["缺少宿主可验证的项目上下文"],
        skill_source="skills/deep-interview/SKILL.md",
        memory_preflight=MemoryPreflight(
            required=not bool(request.known_context),
            reason="进入 deep_interview 前应先读取相关长期记忆。",
            query=request.brief,
            already_satisfied=bool(request.known_context),
            search_performed=search_performed,
            retrieved_count=retrieved_count,
            retrieved_context=retrieved_context,
        ),
    )
    spec = None
    if crystallize_ready:
        spec = SpecSkeleton(
            intent=request.brief,
            desired_outcome="由已完成问答生成执行就绪规格。",
            in_scope=[round.answer for round in request.prior_rounds[-2:] if round.answer],
            non_goals=request.non_goals,
            decision_boundaries=request.decision_boundaries,
        )
    return DeepInterviewResult(
        status=ToolStatus.NEEDS_INPUT if crystallize_ready else ToolStatus.NEEDS_INPUT,
        summary="需求已可结晶，等待用户选择下一步工作流。" if crystallize_ready else "deep_interview 需要继续通过 MCP Elicitation 收集用户回答。",
        assumptions=["用户输入应优先通过 MCP Elicitation 获取；不支持时仅返回标准 needs_input 结果。"],
        next_actions=[build_next_action("继续深访" if not crystallize_ready else "选择下一工具", requested_input)],
        risks=[build_risk("跳过 readiness gates 会导致后续计划不稳。", "必须明确 non_goals、decision_boundaries 并完成 pressure_pass。")],
        meta=build_meta("deep_interview", "ymcp.contracts.deep_interview.DeepInterviewResult", host_controls=["MCP Elicitation", "looping", "state persistence"]),
        artifacts=DeepInterviewArtifacts(
            ambiguity_score=ambiguity,
            weakest_dimension=weakest,
            next_question=next_question,
            question_rationale=RATIONALES.get(weakest),
            readiness_gates=gates,
            scores=scores,
            transcript_delta=[] if crystallize_ready else [InterviewRound(question=next_question or "", answer="")],
            workflow_state=state,
            phase_summary=phase_summary,
            requested_input=requested_input,
            choice_menu=choice_menu,
            spec_skeleton=spec,
        ),
    )
