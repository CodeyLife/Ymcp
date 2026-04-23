from ymcp.contracts.common import ToolStatus
from ymcp.contracts.plan import PlanArtifacts, PlanRequest, PlanResult
from ymcp.core.result import build_meta, build_next_action, build_risk


DEFAULT_PLAN_STEPS = [
    "Clarify the problem statement and desired outcome.",
    "Confirm scope boundaries and constraints.",
    "Break implementation into testable milestones.",
    "Verify results against acceptance criteria.",
]


def build_plan(request: PlanRequest) -> PlanResult:
    constraints = request.constraints or ["No explicit constraints provided."]
    desired_outcome = request.desired_outcome or "A structured plan the host can refine or execute."
    assumptions = [
        "The MCP host decides whether to execute or revise the plan.",
        f"Desired outcome: {desired_outcome}",
    ]
    return PlanResult(
        status=ToolStatus.OK,
        summary=f"Generated a host-controlled implementation plan for: {request.problem}",
        assumptions=assumptions,
        next_actions=[
            build_next_action("Review plan", "Review the returned plan steps and acceptance criteria."),
            build_next_action("Refine constraints", "Call the tool again with tighter constraints if needed."),
        ],
        risks=[
            build_risk("The initial problem statement may still hide unstated constraints.", "Use deep_interview to reduce ambiguity before execution.")
        ],
        meta=build_meta("plan", "ymcp.contracts.plan.PlanResult"),
        artifacts=PlanArtifacts(
            plan_steps=[f"{index + 1}. {step}" for index, step in enumerate(DEFAULT_PLAN_STEPS)],
            acceptance_criteria=[
                f"Returned plan addresses the problem: {request.problem}",
                f"Plan respects constraints: {', '.join(constraints)}",
                "Host can determine the next concrete execution step from the plan.",
            ],
            open_questions=[] if request.constraints else ["What additional constraints should the host enforce?"],
        ),
    )
