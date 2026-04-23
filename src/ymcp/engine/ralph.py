from ymcp.contracts.common import ToolStatus
from ymcp.contracts.ralph import RalphArtifacts, RalphRequest, RalphResult
from ymcp.core.result import build_meta, build_next_action, build_risk


def build_ralph(request: RalphRequest) -> RalphResult:
    has_evidence = bool(request.evidence)
    status = ToolStatus.OK if has_evidence else ToolStatus.NEEDS_INPUT
    summary = "Returned host next-step guidance from the approved plan."
    if not has_evidence:
        summary = "More host-supplied evidence is required before a strong next-step judgement is possible."
    return RalphResult(
        status=status,
        summary=summary,
        assumptions=[
            "The host owns command execution, verification, looping, and persistence.",
            "This tool only projects the next recommended action from the approved plan.",
        ],
        next_actions=[
            build_next_action("Gather evidence", "Provide the latest outputs, logs, or completed milestones to refine the recommendation."),
            build_next_action("Execute host-side", "Use the recommendation to drive host-controlled execution and verification."),
        ],
        risks=[
            build_risk("Without fresh evidence, the next step may be too generic.", "Re-run after the host gathers results from the last action."),
        ],
        meta=build_meta(
            "ralph",
            "ymcp.contracts.ralph.RalphResult",
            host_controls=["execution", "looping", "verification", "persistence", "display"],
        ),
        artifacts=RalphArtifacts(
            recommended_next_action="Validate the current milestone against the test spec and then implement the highest-priority missing contract or behavior.",
            verification_checklist=[
                "Confirm the current change maps to an approved plan item.",
                "Run the relevant contract/integration tests.",
                "Capture evidence before deciding whether to continue or stop.",
            ],
            stop_continue_judgement="continue" if has_evidence else "needs_more_evidence",
            outstanding_risks=[
                "Host may over-trust the guidance as an execution engine.",
                "Evidence may be stale or incomplete.",
            ],
        ),
    )
