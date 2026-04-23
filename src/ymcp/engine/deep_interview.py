from ymcp.contracts.common import ToolStatus
from ymcp.contracts.deep_interview import DeepInterviewArtifacts, DeepInterviewRequest, DeepInterviewResult, InterviewRound, ReadinessGates
from ymcp.core.result import build_meta, build_next_action, build_risk


QUESTION_BANK = {
    "intent": "What core pain should this workflow tool solve for the host user?",
    "scope": "What should the workflow explicitly not do in v1?",
    "constraints": "What technical or product constraints must always hold?",
}


def _weakest_dimension(brief: str, prior_rounds: list[InterviewRound]) -> str:
    if not prior_rounds:
        return "intent"
    if len(brief.split()) < 8:
        return "scope"
    return "constraints"


def build_deep_interview(request: DeepInterviewRequest) -> DeepInterviewResult:
    weakest = _weakest_dimension(request.brief, request.prior_rounds)
    ambiguity = 0.7 if not request.prior_rounds else max(0.1, 0.5 - (0.1 * len(request.prior_rounds)))
    status = ToolStatus.NEEDS_INPUT if ambiguity > request.target_threshold else ToolStatus.OK
    transcript_delta = [InterviewRound(question=QUESTION_BANK[weakest], answer="")]
    return DeepInterviewResult(
        status=status,
        summary="Generated host-controlled interview guidance and ambiguity scoring.",
        assumptions=[
            "The host asks the next question and stores transcript/state.",
            "The returned ambiguity score is a heuristic for host-side guidance, not autonomous progression.",
        ],
        next_actions=[
            build_next_action("Ask next question", QUESTION_BANK[weakest]),
            build_next_action("Re-score", "Call the tool again after the host captures the next answer."),
        ],
        risks=[
            build_risk("The brief may still hide non-goals or decision boundaries.", "Continue host-controlled interviewing until readiness gates are explicit."),
        ],
        meta=build_meta(
            "deep_interview",
            "ymcp.contracts.deep_interview.DeepInterviewResult",
            host_controls=["asking the user", "transcript/state", "looping", "display"],
        ),
        artifacts=DeepInterviewArtifacts(
            ambiguity_score=ambiguity,
            weakest_dimension=weakest,
            next_question=QUESTION_BANK[weakest],
            readiness_gates=ReadinessGates(
                non_goals="needs_clarification" if not request.prior_rounds else "in_progress",
                decision_boundaries="needs_clarification" if len(request.prior_rounds) < 2 else "in_progress",
                pressure_pass="not_started" if len(request.prior_rounds) < 2 else "in_progress",
            ),
            transcript_delta=transcript_delta,
        ),
    )
