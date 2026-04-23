from ymcp.contracts.common import ToolStatus
from ymcp.contracts.ralplan import AdrDraft, RalplanArtifacts, RalplanRequest, RalplanResult, ViableOption
from ymcp.core.result import build_meta, build_next_action, build_risk


def build_ralplan(request: RalplanRequest) -> RalplanResult:
    options = [
        ViableOption(
            name="Single FastMCP package",
            pros=["Fastest path to executable value.", "Simplest pip install and update story."],
            cons=["Requires contract discipline from the first release."],
        ),
        ViableOption(
            name="Direct registration without internal registry",
            pros=["Lowest abstraction overhead."],
            cons=["Gets messy as the number of workflow tools grows."],
        ),
    ]
    if request.deliberate:
        options.append(
            ViableOption(
                name="Multi-package ecosystem",
                pros=["Potential future extensibility."],
                cons=["Overbuilt for v1 and delays runnable value."],
            )
        )
    return RalplanResult(
        status=ToolStatus.OK,
        summary=f"Produced a consensus-planning packet for: {request.task}",
        assumptions=[
            "The host or human reviewer decides whether the returned plan is approved.",
            "Consensus here is represented as a structured planning artifact, not a live multi-agent loop.",
        ],
        next_actions=[
            build_next_action("Review options", "Review the viable options and chosen approach with stakeholders."),
            build_next_action("Promote to execution", "Use the chosen approach to guide host-side execution."),
        ],
        risks=[
            build_risk("Chosen option can still drift into over-architecture.", "Keep v1 limited to the public contract surface and four required tools."),
        ],
        meta=build_meta("ralplan", "ymcp.contracts.ralplan.RalplanResult"),
        artifacts=RalplanArtifacts(
            principles=[
                "Runnable-first delivery",
                "Host-controlled workflow semantics",
                "Contract-first public API",
            ],
            decision_drivers=[
                "Deliver executable value quickly",
                "Keep host integration stable",
                "Minimize maintenance burden",
            ],
            viable_options=options,
            chosen_option="Single FastMCP package",
            adr=AdrDraft(
                decision="Use one FastMCP-based package with typed workflow contracts.",
                drivers=["Runnable v1", "Host-safe semantics", "Low maintenance"],
                alternatives_considered=[option.name for option in options],
                consequences=[
                    "Public extensibility is deferred.",
                    "The workflow contract becomes a public API immediately.",
                ],
                follow_ups=["Reassess online registries only after real host demand appears."],
            ),
            test_strategy=[
                "Unit test pure engines.",
                "Contract test tool metadata and typed artifacts.",
                "Integration test MCP discovery and tool calls.",
            ],
        ),
    )
