from ymcp.contracts.common import ToolStatus
from ymcp.contracts.deep_interview import (
    DeepInterviewArtifacts,
    AnswerOption,
    DeepInterviewRequest,
    DeepInterviewResult,
    DimensionScores,
    InterviewRound,
    ReadinessGates,
    SpecSkeleton,
)
from ymcp.contracts.workflow import ContinuationContract, HandoffOption, MemoryPreflight, WorkflowState
from ymcp.core.result import build_meta, build_next_action, build_risk

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
    "intent": "skill 要求先澄清意图，避免直接进入实现细节。",
    "outcome": "结果不清会导致计划不可验收。",
    "scope": "Non-goals 是 deep-interview 的必过 readiness gate。",
    "constraints": "约束决定后续计划和执行边界。",
    "success": "成功标准必须可测试，才能交给 plan/ralplan。",
    "context": "MCP 宿主应基于证据推进，无法确认时标记 evidence gap。",
}


def _score(request: DeepInterviewRequest) -> DimensionScores:
    rounds = len(request.prior_rounds)
    has_non_goals = bool(request.non_goals)
    has_boundaries = bool(request.decision_boundaries)
    return DimensionScores(
        intent=min(1.0, 0.35 + 0.18 * rounds),
        outcome=min(1.0, 0.25 + 0.14 * rounds),
        scope=0.85 if has_non_goals else min(0.65, 0.2 + 0.12 * rounds),
        constraints=min(1.0, 0.3 + 0.12 * rounds + (0.1 if request.known_context else 0)),
        success=min(1.0, 0.2 + 0.13 * rounds),
        context=min(1.0, 0.2 + (0.35 if request.known_context else 0) + 0.08 * rounds),
    )


def _ambiguity(scores: DimensionScores) -> float:
    weighted = (
        scores.intent * 0.25
        + scores.outcome * 0.2
        + scores.scope * 0.2
        + scores.constraints * 0.15
        + scores.success * 0.1
        + scores.context * 0.1
    )
    return round(max(0.0, 1.0 - weighted), 2)


def _weakest(scores: DimensionScores, request: DeepInterviewRequest) -> str:
    if not request.non_goals:
        return "scope"
    if not request.decision_boundaries:
        return "constraints"
    values = scores.model_dump()
    return min(values, key=values.get)



def _answer_options(dimension: str) -> list[AnswerOption]:
    if dimension == "scope":
        return [
            AnswerOption(label="必须做", value="must", description="这是第一版必须包含的范围。"),
            AnswerOption(label="可以后做", value="later", description="这有价值，但可以推迟。"),
            AnswerOption(label="明确不做", value="no", description="这不属于当前目标。"),
        ]
    if dimension == "constraints":
        return [
            AnswerOption(label="可自动决定", value="auto", description="实现者或宿主可以自行决定。"),
            AnswerOption(label="必须确认", value="confirm", description="继续前需要用户明确确认。"),
            AnswerOption(label="硬性约束", value="hard", description="任何方案都必须满足。"),
        ]
    return [
        AnswerOption(label="回答问题", value="answer", description="直接回答下一问。"),
        AnswerOption(label="补充例子", value="example", description="用具体例子说明。"),
        AnswerOption(label="跳过/不确定", value="unsure", description="当前无法回答，要求宿主记录为 evidence gap。"),
    ]


def build_deep_interview(request: DeepInterviewRequest) -> DeepInterviewResult:
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
    next_question = "需求已达到可结晶状态。请宿主把 spec_skeleton 交给 ralplan。" if crystallize_ready else QUESTION_BANK[weakest]
    state = WorkflowState(
        workflow_name="deep_interview",
        current_phase="crystallize" if crystallize_ready else "intent_first_interview",
        readiness="ready_for_handoff" if crystallize_ready else "needs_input",
        host_next_action="调用 ralplan 继续规划" if crystallize_ready else "宿主必须向用户提出 next_question，并提供 answer_options 供用户选择或自由回答；收到回答后追加到 prior_rounds 并再次调用 deep_interview。",
        required_host_inputs=[] if crystallize_ready else ["用户对下一问的回答"],
        handoff_target="ralplan" if crystallize_ready else None,
        handoff_contract="将 spec_skeleton 作为 task/known_context 输入给 ralplan。" if crystallize_ready else None,
        evidence_gaps=[] if request.known_context else ["缺少宿主可验证的项目上下文"],
        skill_source="skills/deep-interview/SKILL.md",
        memory_preflight=MemoryPreflight(
            required=not bool(request.known_context),
            reason="进入 deep_interview 前应先读取相关长期记忆，避免重复询问已知偏好/约定。",
            query=request.brief,
            already_satisfied=bool(request.known_context),
            search_performed=any(str(item).startswith("记忆检索：") for item in request.known_context),
            retrieved_count=sum(1 for item in request.known_context if str(item).startswith("记忆检索：")),
            retrieved_context=[item for item in request.known_context if str(item).startswith("记忆检索：")],
        ),
    )
    spec = None
    if crystallize_ready:
        spec = SpecSkeleton(
            intent=request.brief,
            desired_outcome="由宿主基于已完成问答生成执行就绪规格。",
            in_scope=[round.answer for round in request.prior_rounds[-2:] if round.answer],
            non_goals=request.non_goals,
            decision_boundaries=request.decision_boundaries,
        )
    return DeepInterviewResult(
        status=ToolStatus.OK if crystallize_ready else ToolStatus.NEEDS_INPUT,
        summary="已生成 deep_interview 状态机投影。" if not crystallize_ready else "需求已可结晶并交给 ralplan。",
        assumptions=["Trae 负责提问、保存 transcript/state 和循环调用。"],
        next_actions=[build_next_action("继续深访" if not crystallize_ready else "交给 ralplan", state.host_next_action)],
        risks=[build_risk("跳过 readiness gates 会导致后续计划不稳。", "必须明确 non_goals、decision_boundaries 并完成 pressure_pass。")],
        meta=build_meta("deep_interview", "ymcp.contracts.deep_interview.DeepInterviewResult", host_controls=["提问", "保存状态", "循环调用", "展示"]),
        artifacts=DeepInterviewArtifacts(
            interaction_mode="handoff" if crystallize_ready else "ask_user",
            answer_options=[] if crystallize_ready else _answer_options(weakest),
            continuation_instruction="需求已可交给 ralplan。" if crystallize_ready else "宿主必须等待用户回答，把 {question: next_question, answer: 用户回答} 追加到 prior_rounds 后再次调用 deep_interview；不要在提问后结束对话。",
            ambiguity_score=ambiguity,
            weakest_dimension=weakest,
            next_question=next_question,
            question_rationale=RATIONALES.get(weakest, "继续补齐最薄弱维度。"),
            readiness_gates=gates,
            scores=scores,
            transcript_delta=[] if crystallize_ready else [InterviewRound(question=next_question, answer="")],
            workflow_state=state,
            continuation=ContinuationContract(
                interaction_mode="handoff" if crystallize_ready else "ask_user",
                continuation_required=not crystallize_ready,
                continuation_kind="handoff_to_tool" if crystallize_ready else "user_answer",
                continuation_payload={
                    "next_tool": "ralplan" if crystallize_ready else None,
                    "question": None if crystallize_ready else next_question,
                    "append_to": None if crystallize_ready else "prior_rounds",
                },
                recommended_user_message=None if crystallize_ready else next_question,
                recommended_host_action="向用户展示下一步工作流选项，而不是结束对话。" if crystallize_ready else "等待用户回答，把回答追加到 prior_rounds 后再次调用 deep_interview。",
                handoff_options=[] if not crystallize_ready else [
                    HandoffOption(label="使用 ralplan 进行共识规划", tool="ralplan", description="适合需要确定实施优先级、方案取舍和验证策略的任务。", payload_hint={"task": "spec_skeleton.intent"}),
                    HandoffOption(label="直接使用 plan 生成执行计划", tool="plan", description="适合需求已清晰、风险较低，直接生成实施步骤。", payload_hint={"task": "spec_skeleton.intent", "mode": "direct"}),
                    HandoffOption(label="使用 ralph 逐步实施并验证", tool="ralph", description="适合已有明确计划或用户希望马上进入执行验证循环。", payload_hint={"approved_plan": "spec_skeleton"}),
                ],
                default_option="ralplan" if crystallize_ready else None,
                selection_required=crystallize_ready,
                option_prompt="需求澄清已完成。您希望我继续哪个方向？" if crystallize_ready else None,
            ),
            crystallize_ready=crystallize_ready,
            spec_skeleton=spec,
        ),
    )
