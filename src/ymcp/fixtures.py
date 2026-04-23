from __future__ import annotations

from typing import Any

FIXTURES: dict[str, dict[str, Any]] = {
    "plan": {
        "task": "Ship a host-controlled MCP workflow tool",
        "constraints": ["Keep execution in the host", "Return typed artifacts"],
        "desired_outcome": "A plan the host can review and execute outside the MCP server.",
    },
    "ralplan": {
        "task": "Create an implementation plan for a Python MCP workflow server",
        "constraints": ["Exactly four v1 tools", "No agent runtime inside the server"],
    },
    "deep_interview": {
        "brief": "Need a Python MCP workflow library for Trae tool calls",
        "prior_rounds": [],
    },
    "ralph": {
        "approved_plan": "Implement the approved Ymcp PRD with tests and docs",
        "latest_evidence": ["package scaffolding exists", "contract tests pass"],
        "verification_commands": ["python -m pytest"],
        "current_status": "implementation in progress",
    },
    "memory_status": {},
    "memory_search": {"query": "Ymcp 发布流程", "limit": 3},
}


def fixture_for(tool_name: str) -> dict[str, Any]:
    try:
        return dict(FIXTURES[tool_name])
    except KeyError as exc:
        available = ", ".join(sorted(FIXTURES))
        raise ValueError(f"Unknown fixture tool {tool_name!r}; available: {available}") from exc
