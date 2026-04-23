from __future__ import annotations

import logging
from typing import Any

from mcp.server.fastmcp import FastMCP

from ymcp.contracts.deep_interview import DeepInterviewRequest, InterviewRound
from ymcp.contracts.plan import PlanRequest
from ymcp.contracts.ralplan import RalplanRequest
from ymcp.contracts.ralph import RalphRequest
from ymcp.engine.deep_interview import build_deep_interview
from ymcp.engine.plan import build_plan
from ymcp.engine.ralplan import build_ralplan
from ymcp.engine.ralph import build_ralph
from ymcp.internal_registry import get_tool_specs

LOGGER = logging.getLogger("ymcp")


def configure_logging(level: int = logging.INFO) -> None:
    if logging.getLogger().handlers:
        return
    logging.basicConfig(level=level, format="%(levelname)s %(name)s: %(message)s")


def create_app() -> FastMCP:
    app = FastMCP(
        name="ymcp",
        instructions="Host-controlled MCP workflow tools for plan, ralplan, deep_interview, and ralph.",
        log_level="ERROR",
    )
    descriptions = {spec.name: spec.description for spec in get_tool_specs()}

    @app.tool(name="plan", description=descriptions["plan"], structured_output=True)
    def plan(problem: str, constraints: list[str] | None = None, desired_outcome: str | None = None, schema_version: str = "1.0") -> dict[str, Any]:
        request = PlanRequest(problem=problem, constraints=constraints or [], desired_outcome=desired_outcome, schema_version=schema_version)
        return build_plan(request).to_mcp_result()

    @app.tool(name="ralplan", description=descriptions["ralplan"], structured_output=True)
    def ralplan(task: str, constraints: list[str] | None = None, deliberate: bool = False, schema_version: str = "1.0") -> dict[str, Any]:
        request = RalplanRequest(task=task, constraints=constraints or [], deliberate=deliberate, schema_version=schema_version)
        return build_ralplan(request).to_mcp_result()

    @app.tool(name="deep_interview", description=descriptions["deep_interview"], structured_output=True)
    def deep_interview(brief: str, prior_rounds: list[dict[str, str]] | None = None, target_threshold: float = 0.2, schema_version: str = "1.0") -> dict[str, Any]:
        rounds = [InterviewRound.model_validate(item) for item in (prior_rounds or [])]
        request = DeepInterviewRequest(brief=brief, prior_rounds=rounds, target_threshold=target_threshold, schema_version=schema_version)
        return build_deep_interview(request).to_mcp_result()

    @app.tool(name="ralph", description=descriptions["ralph"], structured_output=True)
    def ralph(approved_plan: str, evidence: list[str] | None = None, current_status: str | None = None, schema_version: str = "1.0") -> dict[str, Any]:
        request = RalphRequest(approved_plan=approved_plan, evidence=evidence or [], current_status=current_status, schema_version=schema_version)
        return build_ralph(request).to_mcp_result()

    return app
