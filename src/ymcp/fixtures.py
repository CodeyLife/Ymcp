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
        "constraints": ["Host drives the chain", "No agent runtime inside the server"],
    },
    "ralplan_planner": {
        "task": "Create an implementation plan for a Python MCP workflow server",
        "constraints": ["Host drives the chain"],
        "known_context": ["workflow server contract exists"],
    },
    "ralplan_architect": {
        "task": "Create an implementation plan for a Python MCP workflow server",
        "planner_draft": "Draft: inspect host contract, preserve MCP-first boundary.",
        "known_context": ["workflow server contract exists"],
    },
    "ralplan_critic": {
        "task": "Create an implementation plan for a Python MCP workflow server",
        "planner_draft": "Draft: inspect host contract, preserve MCP-first boundary.",
        "architect_review": "Review: ensure host never guesses next tool and explicit handoff is enforced.",
        "known_context": ["workflow server contract exists"],
    },
    "ralplan_handoff": {
        "task": "Create an implementation plan for a Python MCP workflow server",
        "critic_verdict": "APPROVE",
        "approved_plan_summary": "Approved: host-controlled MCP workflow refactor.",
        "known_context": ["workflow server contract exists"],
    },
    "deep_interview": {
        "brief": "Need a Python MCP workflow library for Trae tool calls",
        "prior_rounds": [],
    },
    "ralph": {
        "approved_plan": "Implement the approved Ymcp PRD with tests and docs",
        "latest_evidence": ["package scaffolding exists", "contract tests pass"],
        "verification_commands": ["python -m pytest"],
    },
    "mempalace_status": {},
    "mempalace_search": {"query": "Ymcp 发布流程", "limit": 3},
}


def fixture_for(tool_name: str) -> dict[str, Any]:
    try:
        return dict(FIXTURES[tool_name])
    except KeyError as exc:
        available = ", ".join(sorted(FIXTURES))
        raise ValueError(f"Unknown fixture tool {tool_name!r}; available: {available}") from exc
