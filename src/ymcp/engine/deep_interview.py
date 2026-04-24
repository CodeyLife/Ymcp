from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.deep_interview import DeepInterviewArtifacts, DeepInterviewRequest, DeepInterviewResult, InterviewRound, SpecSkeleton
from ymcp.contracts.workflow import MemoryPreflight, WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_meta, build_next_action
from ymcp.engine.memory_preflight import analyze_memory_context

PROFILE_THRESHOLDS = {"quick": 0.30, "standard": 0.20, "deep": 0.15}
QUESTION_BANK = {
    "intent": "你最希望这个需求解决的核心痛点是什么？",
    "outcome": "完成后最小可验证结果是什么？",
    "scope": "第一版明确不做什么？",
    "constraints": "有哪些必须始终成立的约束？",
    "success": "请给出 2-3 条可测试的验收标准。",
    "context": "当前哪些事实、文件或宿主能力会影响这个需求？",
}


def _resolved_score(request: DeepInterviewRequest) -> float:
    rounds = len(request.prior_rounds)
    bonus = 0.15 if request.known_context else 0.0
    return min(1.0, 0.2 + rounds * 0.15 + bonus + (0.2 if request.non_goals else 0.0) + (0.2 if request.decision_boundaries else 0.0))


def build_deep_interview(request: DeepInterviewRequest) -> DeepInterviewResult:
    search_performed, retrieved_count, retrieved_context = analyze_memory_context(request.known_context, request.memory_context)
    threshold = PROFILE_THRESHOLDS.get(request.profile, request.target_threshold)
    resolved = _resolved_score(request)
    crystallize_ready = resolved >= (1 - threshold) and bool(request.non_goals) and bool(request.decision_boundaries) and len(request.prior_rounds) >= 2
    next_question = None
    if not crystallize_ready:
        if not request.non_goals:
            next_question = QUESTION_BANK["scope"]
        elif not request.decision_boundaries:
            next_question = QUESTION_BANK["constraints"]
        elif len(request.prior_rounds) < 2:
            next_question = QUESTION_BANK["intent"]
        else:
            next_question = QUESTION_BANK["success"]

    phase_summary = WorkflowPhaseSummary(
        title="需求已结晶" if crystallize_ready else "继续澄清",
        summary="宿主应提供下一步 workflow 选项，并通过 MCP Elicitation 让用户选择。" if crystallize_ready else "宿主应通过 MCP Elicitation 展示下一问并收集用户回答，直到需求结晶。",
    )
    state = WorkflowState(
        workflow_name="deep_interview",
        current_phase="handoff_selection" if crystallize_ready else "clarifying",
        readiness="needs_user_choice" if crystallize_ready else "needs_input",
        evidence_gaps=[] if request.known_context else ["缺少宿主可验证的项目上下文。"],
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
        status=ToolStatus.NEEDS_INPUT,
        summary=phase_summary.summary,
        assumptions=[],
        next_actions=[build_next_action("下一步", phase_summary.summary)],
        risks=[],
        meta=build_meta(
            "deep_interview",
            "ymcp.contracts.deep_interview.DeepInterviewResult",
            host_controls=["MCP Elicitation", "looping", "state persistence"],
            required_host_action=HostActionType.AWAIT_INPUT,
            requires_elicitation=True,
            requires_explicit_user_choice=crystallize_ready,
        ),
        artifacts=DeepInterviewArtifacts(
            next_question=next_question,
            workflow_state=state,
            phase_summary=phase_summary,
            spec_skeleton=spec,
        ),
    )
