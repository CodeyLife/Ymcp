from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.deep_interview import (
    ContextSnapshotDraft,
    DeepInterviewArtifacts,
    DeepInterviewRequest,
    DeepInterviewResult,
    ExecutionSpec,
    InterviewRound,
    QuestionStrategy,
    SpecSkeleton,
)
from ymcp.contracts.workflow import ClarityScore, HandoffContract, MemoryPreflight, ReadinessGates, WorkflowPhaseSummary, WorkflowState
from ymcp.core.result import build_meta, build_next_action
from ymcp.engine.memory_preflight import analyze_memory_context

PROFILE_SETTINGS = {
    "quick": {"threshold": 0.30, "max_rounds": 5},
    "standard": {"threshold": 0.20, "max_rounds": 12},
    "deep": {"threshold": 0.15, "max_rounds": 20},
}
QUESTION_BANK = {
    "intent": "你最希望这个需求解决的核心痛点是什么？",
    "outcome": "完成后最小可验证结果是什么？",
    "scope": "第一版明确不做什么？",
    "constraints": "有哪些必须始终成立的约束？",
    "success": "请给出 2-3 条可测试的验收标准。",
    "decision_boundaries": "哪些决策可以由 OMX/宿主自行决定，哪些必须先得到你的确认？",
    "context": "当前哪些事实、文件或宿主能力会影响这个需求？",
}


def _extract_items(text: str) -> list[str]:
    raw_lines = [line.strip(" -*•\t") for line in text.replace("；", "\n").replace(";", "\n").splitlines()]
    items = [line for line in raw_lines if line]
    if items:
        return items
    compact = [part.strip() for part in text.replace("，", ",").split(",") if part.strip()]
    return compact or ([text.strip()] if text.strip() else [])


def _context_type(request: DeepInterviewRequest) -> str:
    if request.context_type in {"greenfield", "brownfield"}:
        return request.context_type
    return "brownfield" if (request.known_context or request.repo_findings) else "greenfield"


def _round_focus(question: str) -> str:
    mapping = {
        "第一版明确不做什么": "scope",
        "哪些决策可以由 OMX/宿主自行决定": "decision_boundaries",
        "核心痛点": "intent",
        "最小可验证结果": "outcome",
        "始终成立的约束": "constraints",
        "验收标准": "success",
        "哪些事实、文件或宿主能力": "context",
    }
    for marker, focus in mapping.items():
        if marker in question:
            return focus
    return "intent"


def _rounds_by_focus(request: DeepInterviewRequest) -> dict[str, list[InterviewRound]]:
    grouped: dict[str, list[InterviewRound]] = {}
    for round_item in request.prior_rounds:
        grouped.setdefault(_round_focus(round_item.question), []).append(round_item)
    return grouped


def _has_pressure_pass(request: DeepInterviewRequest) -> bool:
    grouped = _rounds_by_focus(request)
    return any(len(rounds) >= 2 for rounds in grouped.values()) or len(request.prior_rounds) >= 4


def _score(value: float) -> float:
    return max(0.0, min(1.0, round(value, 3)))


def _build_clarity_breakdown(request: DeepInterviewRequest, brownfield: bool, pressure_pass_complete: bool, memory_hits: list[str]) -> list[ClarityScore]:
    grouped = _rounds_by_focus(request)
    has_repo_context = bool(request.known_context or request.repo_findings)
    scores = [
        ClarityScore(
            dimension="intent",
            score=_score(0.35 + (0.25 if request.brief.strip() else 0.0) + (0.2 if grouped.get("intent") else 0.0) + (0.1 if pressure_pass_complete else 0.0)),
            justification="已有任务描述，且{}意图追问。".format("已做过" if grouped.get("intent") else "尚未做"),
            gap="还需要更明确的根因或业务动机。" if not grouped.get("intent") else "还可以再压一次隐藏假设。",
        ),
        ClarityScore(
            dimension="outcome",
            score=_score(0.15 + (0.3 if grouped.get("outcome") else 0.0) + (0.2 if grouped.get("success") else 0.0) + (0.15 if (grouped.get("success") and has_repo_context) else 0.0) + (0.1 if len(request.prior_rounds) >= 2 else 0.0)),
            justification="{}明确问过结果或验收。".format("已经" if (grouped.get("outcome") or grouped.get("success")) else "还没有"),
            gap="需要更清楚的完成态或最小可验证结果。" if not grouped.get("outcome") else "可以把结果再转成更具体验收标准。",
        ),
        ClarityScore(
            dimension="scope",
            score=_score(0.1 + (0.5 if request.non_goals else 0.0) + (0.15 if grouped.get("scope") else 0.0) + (0.15 if request.decision_boundaries else 0.0)),
            justification="{}显式 non-goals。".format("已有" if request.non_goals else "缺少"),
            gap="必须先说清楚第一版不做什么。" if not request.non_goals else "还可以继续压缩到更小可交付范围。",
        ),
        ClarityScore(
            dimension="constraints",
            score=_score(0.15 + (0.3 if grouped.get("constraints") else 0.0) + (0.3 if request.decision_boundaries else 0.0) + (0.15 if (request.decision_boundaries and has_repo_context) else 0.0) + (0.1 if has_repo_context else 0.0)),
            justification="{}约束/决策边界已露出。".format("部分" if (grouped.get("constraints") or request.decision_boundaries) else "尚无"),
            gap="还需要明确不可违背的约束。" if not grouped.get("constraints") else "需要把边界和硬约束进一步区分。",
        ),
        ClarityScore(
            dimension="success",
            score=_score(0.1 + (0.5 if grouped.get("success") else 0.0) + (0.1 if (grouped.get("success") and request.decision_boundaries) else 0.0) + (0.2 if len(request.prior_rounds) >= 3 else 0.0)),
            justification="{}验收标准追问。".format("已经有" if grouped.get("success") else "尚未有"),
            gap="需要可测试验收标准。" if not grouped.get("success") else "还可以压成更可执行的验证语句。",
        ),
    ]
    if brownfield:
        scores.append(
            ClarityScore(
                dimension="context",
                score=_score(0.2 + (0.35 if has_repo_context else 0.0) + (0.2 if grouped.get("context") else 0.0) + (0.15 if memory_hits else 0.0)),
                justification="{} repo/context 证据。".format("已有" if has_repo_context else "缺少"),
                gap="brownfield 需要宿主先补 repo_findings/known_context。" if not has_repo_context else "还可以补更多文件/接口证据。",
            )
        )
    return scores


def _ambiguity(scores: list[ClarityScore], brownfield: bool) -> float:
    score_map = {item.dimension: item.score for item in scores}
    if brownfield:
        resolved = (
            score_map["intent"] * 0.25
            + score_map["outcome"] * 0.20
            + score_map["scope"] * 0.20
            + score_map["constraints"] * 0.15
            + score_map["success"] * 0.10
            + score_map["context"] * 0.10
        )
    else:
        resolved = (
            score_map["intent"] * 0.30
            + score_map["outcome"] * 0.25
            + score_map["scope"] * 0.20
            + score_map["constraints"] * 0.15
            + score_map["success"] * 0.10
        )
    return _score(1 - resolved)


def _challenge_modes(request: DeepInterviewRequest, ambiguity_score: float, scope_score: float, intent_score: float) -> list[str]:
    modes: list[str] = []
    rounds = len(request.prior_rounds)
    if rounds >= 2:
        modes.append("contrarian")
    if rounds >= 4 and scope_score < 0.8:
        modes.append("simplifier")
    if rounds >= 5 and ambiguity_score > 0.25 and intent_score < 0.8:
        modes.append("ontologist")
    return modes


def _acceptance_criteria(request: DeepInterviewRequest) -> list[str]:
    grouped = _rounds_by_focus(request)
    items: list[str] = []
    for round_item in grouped.get("success", []):
        items.extend(_extract_items(round_item.answer))
    return items


def _constraints(request: DeepInterviewRequest) -> list[str]:
    grouped = _rounds_by_focus(request)
    items: list[str] = []
    for round_item in grouped.get("constraints", []):
        items.extend(_extract_items(round_item.answer))
    return items


def _desired_outcome(request: DeepInterviewRequest) -> str:
    grouped = _rounds_by_focus(request)
    if grouped.get("outcome"):
        return grouped["outcome"][-1].answer.strip()
    return "仍需通过后续澄清确认最小可验证结果。"


def _transcript_summary(request: DeepInterviewRequest) -> list[str]:
    return [f"Q: {round_item.question} | A: {round_item.answer}" for round_item in request.prior_rounds[-6:]]


def _context_snapshot(request: DeepInterviewRequest, context_type: str) -> ContextSnapshotDraft:
    constraints = _constraints(request)
    return ContextSnapshotDraft(
        task_statement=request.brief,
        desired_outcome=_desired_outcome(request),
        stated_solution=request.brief,
        probable_intent_hypothesis="用户想先把需求边界和决策权限说清楚，再把结果交给后续 workflow。",
        known_facts=[*request.known_context, *request.repo_findings],
        constraints=constraints,
        unknowns=["成功标准仍需细化"] if not _acceptance_criteria(request) else [],
        decision_boundary_unknowns=[] if request.decision_boundaries else ["尚未明确哪些决策可由宿主/OMX 直接决定。"],
        likely_touchpoints=[context_type, *request.repo_findings[:3]],
    )


def _handoff_contracts(spec_path: str, residual_risk: list[str]) -> list[HandoffContract]:
    common_done = ["requirements_discovery", "intent_boundary_clarification"]
    return [
        HandoffContract(
            tool="ralplan",
            input_artifact=spec_path,
            consumer_expectations=["把 deep-interview 规格视为当前需求真相源。", "围绕已明确边界做架构/规划，而不是重复访谈。"],
            already_satisfied_stages=common_done,
            residual_risk=residual_risk,
        ),
        HandoffContract(
            tool="plan",
            input_artifact=spec_path,
            consumer_expectations=["把规格压缩成直接执行计划。", "保留 non-goals 和 decision boundaries。"],
            already_satisfied_stages=common_done,
            residual_risk=residual_risk,
        ),
        HandoffContract(
            tool="ralph",
            input_artifact=spec_path,
            consumer_expectations=["按澄清后的验收标准持续执行/验证。", "不要重新打开需求访谈，除非用户明确要求。"],
            already_satisfied_stages=common_done,
            residual_risk=residual_risk,
        ),
        HandoffContract(
            tool="refine_further",
            input_artifact=spec_path,
            consumer_expectations=["继续围绕最低分维度追问。", "优先消除 residual risk。"],
            already_satisfied_stages=["context_snapshot_created"],
            residual_risk=residual_risk,
        ),
    ]


def _question_strategy(request: DeepInterviewRequest, scores: list[ClarityScore], brownfield: bool, readiness: ReadinessGates, ambiguity_score: float) -> tuple[str | None, QuestionStrategy | None, str, str]:
    score_map = {item.dimension: item for item in scores}
    if brownfield and not (request.known_context or request.repo_findings):
        return None, None, "brownfield_grounding", "context"
    if not readiness.non_goals_resolved:
        return QUESTION_BANK["scope"], QuestionStrategy(target_dimension="scope", mode="boundary", rationale="先明确 non-goals，避免后续访谈继续扩 scope。"), "intent_first", "scope"
    if not readiness.decision_boundaries_resolved:
        return QUESTION_BANK["decision_boundaries"], QuestionStrategy(target_dimension="decision_boundaries", mode="authority", rationale="需要把决策权限和必须确认的边界分开。"), "intent_first", "decision_boundaries"
    if len(request.prior_rounds) >= 2 and not readiness.pressure_pass_complete:
        weakest = min((item for item in scores if item.dimension != "context"), key=lambda item: item.score)
        return QUESTION_BANK.get(weakest.dimension, QUESTION_BANK["intent"]), QuestionStrategy(target_dimension=weakest.dimension, mode="contrarian", rationale="需要至少一次 pressure pass，回头追问同一薄弱维度的隐藏假设或取舍。"), "intent_first", weakest.dimension
    stage_one = [score_map["intent"], score_map["outcome"], score_map["scope"]]
    if min(item.score for item in stage_one) < 0.75:
        weakest = min(stage_one, key=lambda item: item.score)
        return QUESTION_BANK[weakest.dimension], QuestionStrategy(target_dimension=weakest.dimension, mode="evidence", rationale="优先补 intent/outcome/scope，先把需求目标和边界钉牢。"), "intent_first", weakest.dimension
    stage_two = [score_map["constraints"], score_map["success"]]
    if min(item.score for item in stage_two) < 0.75:
        weakest = min(stage_two, key=lambda item: item.score)
        return QUESTION_BANK[weakest.dimension], QuestionStrategy(target_dimension=weakest.dimension, mode="tradeoff", rationale="进入 feasibility 阶段，补硬约束和验收标准。"), "feasibility", weakest.dimension
    if brownfield and score_map["context"].score < 0.75:
        return None, None, "brownfield_grounding", "context"
    weakest = min(scores, key=lambda item: item.score)
    return QUESTION_BANK.get(weakest.dimension, QUESTION_BANK["success"]), QuestionStrategy(target_dimension=weakest.dimension, mode="refinement", rationale=f"继续压最低分维度，当前 ambiguity={ambiguity_score:.2f}。"), "clarifying", weakest.dimension


def _build_question_text(round_index: int, focus: str, ambiguity_score: float, question: str) -> str:
    return f"Round {round_index} | Target: {focus} | Ambiguity: {int(ambiguity_score * 100)}%\n\n{question}"


def build_deep_interview(request: DeepInterviewRequest) -> DeepInterviewResult:
    search_performed, retrieved_count, retrieved_context = analyze_memory_context(request.known_context, request.memory_context)
    profile_config = PROFILE_SETTINGS.get(request.profile, PROFILE_SETTINGS["standard"])
    threshold = profile_config["threshold"] if request.profile in PROFILE_SETTINGS else request.target_threshold
    max_rounds = request.round_limit_override or profile_config["max_rounds"]
    brownfield = _context_type(request) == "brownfield"
    readiness = ReadinessGates(
        non_goals_resolved=bool(request.non_goals),
        decision_boundaries_resolved=bool(request.decision_boundaries),
        pressure_pass_complete=_has_pressure_pass(request),
    )
    clarity_breakdown = _build_clarity_breakdown(request, brownfield, readiness.pressure_pass_complete, retrieved_context)
    ambiguity_score = _ambiguity(clarity_breakdown, brownfield)
    round_limit_hit = len(request.prior_rounds) >= max_rounds
    crystallize_ready = (
        not round_limit_hit
        and ambiguity_score <= threshold
        and readiness.non_goals_resolved
        and readiness.decision_boundaries_resolved
        and readiness.pressure_pass_complete
        and (not brownfield or bool(request.known_context or request.repo_findings))
    )
    next_question, strategy, current_phase, current_focus = _question_strategy(request, clarity_breakdown, brownfield, readiness, ambiguity_score)
    if crystallize_ready:
        next_question = None
        strategy = None
        current_phase = "handoff_selection"
        current_focus = "handoff"
    if next_question is not None:
        next_question = _build_question_text(len(request.prior_rounds) + 1, current_focus, ambiguity_score, next_question)
    residual_risk: list[str] = []
    if not readiness.non_goals_resolved:
        residual_risk.append("non-goals 尚未明确")
    if not readiness.decision_boundaries_resolved:
        residual_risk.append("decision boundaries 尚未明确")
    if not readiness.pressure_pass_complete:
        residual_risk.append("尚未完成至少一次 pressure pass")
    if brownfield and not (request.known_context or request.repo_findings):
        residual_risk.append("brownfield 缺少 repo_findings/known_context")
    if ambiguity_score > threshold:
        residual_risk.append(f"当前 ambiguity={ambiguity_score:.2f}，高于阈值 {threshold:.2f}")
    if round_limit_hit:
        residual_risk.append(f"已达到 profile 最大轮次 {max_rounds}")
        crystallize_ready = True
        current_phase = "handoff_selection"
    evidence_gaps = []
    if not request.known_context and not request.repo_findings:
        evidence_gaps.append("缺少宿主可验证的项目上下文。")
    if brownfield and not (request.known_context or request.repo_findings):
        evidence_gaps.append("当前被识别为 brownfield；宿主应先补充 repo_findings 或 known_context。")

    if crystallize_ready:
        result_summary = "宿主应提供下一步 workflow 选项，并通过 MCP Elicitation 让用户选择。"
        phase_summary = WorkflowPhaseSummary(
            title="需求已结晶",
            summary="当前 phase 已达到需求结晶，可以进入 handoff 选择。",
            highlights=[
                f"final ambiguity={ambiguity_score:.2f} / threshold={threshold:.2f}",
                "deep-interview 已产出 execution_spec 和 handoff_contracts。",
            ],
        )
    elif brownfield and not (request.known_context or request.repo_findings):
        result_summary = "宿主应先补 repo_findings / known_context，再继续 deep_interview；不要向用户追问代码库内部事实。"
        phase_summary = WorkflowPhaseSummary(
            title="等待 brownfield 证据",
            summary="当前 phase 缺少 brownfield grounding 所需的仓库证据。",
            highlights=["当前缺少可验证仓库证据，无法完成 brownfield grounding。"],
        )
    else:
        result_summary = "宿主应通过 MCP Elicitation 展示下一问并收集用户回答，直到需求结晶。"
        phase_summary = WorkflowPhaseSummary(
            title="继续澄清",
            summary="当前 phase 仍在澄清需求边界和验收条件。",
            highlights=[
                f"next_focus={current_focus}",
                f"ambiguity={ambiguity_score:.2f}",
                f"challenge_modes={', '.join(_challenge_modes(request, ambiguity_score, next(item.score for item in clarity_breakdown if item.dimension == 'scope'), next(item.score for item in clarity_breakdown if item.dimension == 'intent')))}" or "none",
            ],
        )
    state = WorkflowState(
        workflow_name="deep_interview",
        current_phase="handoff_selection" if crystallize_ready else current_phase,
        readiness="needs_user_choice" if crystallize_ready else ("needs_host_context" if brownfield and not (request.known_context or request.repo_findings) else "needs_input"),
        evidence_gaps=evidence_gaps,
        memory_preflight=MemoryPreflight(
            required=not bool(request.known_context or request.repo_findings),
            reason="进入 deep_interview 前应先读取相关长期记忆。",
            query=request.brief,
            already_satisfied=bool(request.known_context or request.repo_findings),
            search_performed=search_performed,
            retrieved_count=retrieved_count,
            retrieved_context=retrieved_context,
        ),
        current_focus=current_focus,
    )
    spec = None
    execution_spec = None
    handoff_contracts: list[HandoffContract] = []
    spec_path = ".omx/specs/deep-interview-generated.md"
    if crystallize_ready:
        spec = SpecSkeleton(
            intent=request.brief,
            desired_outcome=_desired_outcome(request),
            in_scope=[round_item.answer for round_item in request.prior_rounds[-2:] if round_item.answer],
            non_goals=request.non_goals,
            decision_boundaries=request.decision_boundaries,
        )
        execution_spec = ExecutionSpec(
            profile=request.profile,
            context_type=_context_type(request),
            rounds=len(request.prior_rounds),
            final_ambiguity=ambiguity_score,
            threshold=threshold,
            intent=request.brief,
            desired_outcome=_desired_outcome(request),
            in_scope=[round_item.answer for round_item in request.prior_rounds[-3:] if round_item.answer],
            out_of_scope=request.non_goals,
            decision_boundaries=request.decision_boundaries,
            constraints=_constraints(request),
            acceptance_criteria=_acceptance_criteria(request),
            brownfield_evidence=[*request.known_context, *request.repo_findings],
            transcript_summary=_transcript_summary(request),
            residual_risk=residual_risk,
        )
        handoff_contracts = _handoff_contracts(spec_path, residual_risk)
    return DeepInterviewResult(
        status=ToolStatus.NEEDS_INPUT,
        summary=result_summary,
        assumptions=[],
        next_actions=[build_next_action("下一步", result_summary)],
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
            ambiguity_score=ambiguity_score,
            clarity_breakdown=clarity_breakdown,
            readiness_gates=readiness,
            question_strategy=strategy,
            context_snapshot_draft=_context_snapshot(request, _context_type(request)),
            interview_transcript_summary=_transcript_summary(request),
            execution_spec=execution_spec,
            handoff_contracts=handoff_contracts,
            residual_risk=residual_risk,
        ),
    )
