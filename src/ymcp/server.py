from __future__ import annotations

import json
import logging
from typing import Any

from mcp.server.fastmcp import FastMCP

from ymcp.contracts.deep_interview import DeepInterviewRequest, InterviewRound
from ymcp.contracts.plan import PlanRequest
from ymcp.contracts.ralplan import RalplanRequest
from ymcp.contracts.ralph import RalphRequest
from ymcp.contracts.workflow import MemoryContext
from ymcp.engine.deep_interview import build_deep_interview
from ymcp.engine.plan import build_plan
from ymcp.engine.ralplan import build_ralplan
from ymcp.engine.ralph import build_ralph
from ymcp.memory import call_mempalace_tool, limit_memory_result_items
from ymcp.internal_registry import get_tool_specs

LOGGER = logging.getLogger("ymcp")


def configure_logging(level: int = logging.INFO) -> None:
    if logging.getLogger().handlers:
        return
    logging.basicConfig(level=level, format="%(levelname)s %(name)s: %(message)s")


def _coerce_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            return [stripped]
        if isinstance(parsed, list):
            return parsed
        return [parsed]
    return [value]


def _coerce_str_list(value: Any) -> list[str]:
    return [str(item) for item in _coerce_list(value) if item is not None and str(item).strip()]


def _coerce_rounds(value: Any) -> list[InterviewRound]:
    rounds = []
    for item in _coerce_list(value):
        if isinstance(item, str):
            try:
                item = json.loads(item)
            except json.JSONDecodeError:
                item = {"question": "用户补充", "answer": item}
        rounds.append(InterviewRound.model_validate(item))
    return rounds



def _known_context(value: Any = None) -> list[str]:
    return _coerce_str_list(value)


def _memory_context(value: Any = None) -> MemoryContext:
    if value is None:
        return MemoryContext()
    if isinstance(value, MemoryContext):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return MemoryContext()
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError:
            return MemoryContext()
    if isinstance(value, dict):
        return MemoryContext.model_validate(value)
    return MemoryContext()


def create_app() -> FastMCP:
    app = FastMCP(
        name="ymcp",
        instructions="Host-controlled MCP workflow tools for plan, ralplan, deep_interview, and ralph.",
        log_level="ERROR",
    )
    descriptions = {spec.name: spec.description for spec in get_tool_specs()}

    @app.tool(name="plan", description=descriptions["plan"], structured_output=True)
    def plan(task: str | None = None, problem: str | None = None, mode: str = "auto", constraints: Any = None, known_context: Any = None, memory_context: Any = None, acceptance_criteria: Any = None, review_target: str | None = None, desired_outcome: str | None = None, schema_version: str = "1.0") -> dict[str, Any]:
        task_value = task or problem or ""
        request = PlanRequest(task=task_value, mode=mode, constraints=_coerce_str_list(constraints), known_context=_known_context(known_context), memory_context=_memory_context(memory_context), acceptance_criteria=_coerce_str_list(acceptance_criteria), review_target=review_target, desired_outcome=desired_outcome, schema_version=schema_version)
        return build_plan(request).to_mcp_result()

    @app.tool(name="ralplan", description=descriptions["ralplan"], structured_output=True)
    def ralplan(task: str, constraints: Any = None, deliberate: bool = False, interactive: bool = False, current_phase: str = "planner_draft", planner_draft: str | None = None, architect_feedback: Any = None, critic_feedback: Any = None, critic_verdict: str | None = None, known_context: Any = None, memory_context: Any = None, iteration: int = 1, schema_version: str = "1.0") -> dict[str, Any]:
        request = RalplanRequest(task=task, constraints=_coerce_str_list(constraints), deliberate=deliberate, interactive=interactive, current_phase=current_phase, planner_draft=planner_draft, architect_feedback=_coerce_str_list(architect_feedback), critic_feedback=_coerce_str_list(critic_feedback), critic_verdict_input=critic_verdict, known_context=_known_context(known_context), memory_context=_memory_context(memory_context), iteration=iteration, schema_version=schema_version)
        return build_ralplan(request).to_mcp_result()

    @app.tool(name="deep_interview", description=descriptions["deep_interview"], structured_output=True)
    def deep_interview(brief: str, prior_rounds: Any = None, target_threshold: float = 0.2, profile: str = "standard", known_context: Any = None, memory_context: Any = None, non_goals: Any = None, decision_boundaries: Any = None, schema_version: str = "1.0") -> dict[str, Any]:
        rounds = _coerce_rounds(prior_rounds)
        request = DeepInterviewRequest(brief=brief, prior_rounds=rounds, target_threshold=target_threshold, profile=profile, known_context=_known_context(known_context), memory_context=_memory_context(memory_context), non_goals=_coerce_str_list(non_goals), decision_boundaries=_coerce_str_list(decision_boundaries), schema_version=schema_version)
        return build_deep_interview(request).to_mcp_result()

    @app.tool(name="ralph", description=descriptions["ralph"], structured_output=True)
    def ralph(approved_plan: str, latest_evidence: Any = None, evidence: Any = None, current_phase: str = "executing", todo_status: Any = None, verification_commands: Any = None, known_failures: Any = None, iteration: int = 1, current_status: str | None = None, schema_version: str = "1.0") -> dict[str, Any]:
        request = RalphRequest(approved_plan=approved_plan, latest_evidence=_coerce_str_list(latest_evidence or evidence), current_phase=current_phase, todo_status=_coerce_str_list(todo_status), verification_commands=_coerce_str_list(verification_commands), known_failures=_coerce_str_list(known_failures), iteration=iteration, current_status=current_status, schema_version=schema_version)
        return build_ralph(request).to_mcp_result()


    @app.tool(name="memory_store", description=descriptions["memory_store"], structured_output=True)
    def memory_store(content: str, wing: str = "personal", room: str = "ymcp", source_file: str | None = None, added_by: str = "ymcp", schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_store", "store", "tool_add_drawer", wing=wing, room=room, content=content, source_file=source_file, added_by=added_by).to_mcp_result()

    @app.tool(name="memory_search", description=descriptions["memory_search"], structured_output=True)
    def memory_search(query: str, limit: int = 5, wing: str | None = "personal", room: str | None = None, max_distance: float = 1.5, min_similarity: float | None = None, context: str | None = None, schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_search", "search", "tool_search", query=query, limit=limit, wing=wing, room=room, max_distance=max_distance, min_similarity=min_similarity, context=context).to_mcp_result()

    @app.tool(name="memory_get", description=descriptions["memory_get"], structured_output=True)
    def memory_get(drawer_id: str, schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_get", "get", "tool_get_drawer", drawer_id=drawer_id).to_mcp_result()

    @app.tool(name="memory_update", description=descriptions["memory_update"], structured_output=True)
    def memory_update(drawer_id: str, content: str | None = None, wing: str | None = None, room: str | None = None, schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_update", "update", "tool_update_drawer", drawer_id=drawer_id, content=content, wing=wing, room=room).to_mcp_result()

    @app.tool(name="memory_delete", description=descriptions["memory_delete"], structured_output=True)
    def memory_delete(drawer_id: str, schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_delete", "delete", "tool_delete_drawer", drawer_id=drawer_id).to_mcp_result()

    @app.tool(name="memory_status", description=descriptions["memory_status"], structured_output=True)
    def memory_status(schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_status", "status", "tool_status").to_mcp_result()

    @app.tool(name="memory_list_wings", description=descriptions["memory_list_wings"], structured_output=True)
    def memory_list_wings(schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_list_wings", "list_wings", "tool_list_wings").to_mcp_result()

    @app.tool(name="memory_list_rooms", description=descriptions["memory_list_rooms"], structured_output=True)
    def memory_list_rooms(wing: str | None = "personal", schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_list_rooms", "list_rooms", "tool_list_rooms", wing=wing, room=None).to_mcp_result()

    @app.tool(name="memory_taxonomy", description=descriptions["memory_taxonomy"], structured_output=True)
    def memory_taxonomy(schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_taxonomy", "taxonomy", "tool_get_taxonomy").to_mcp_result()

    @app.tool(name="memory_check_duplicate", description=descriptions["memory_check_duplicate"], structured_output=True)
    def memory_check_duplicate(content: str, wing: str = "personal", room: str = "ymcp", schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_check_duplicate", "check_duplicate", "tool_check_duplicate", content=content, wing=wing, room=room).to_mcp_result()

    @app.tool(name="memory_reconnect", description=descriptions["memory_reconnect"], structured_output=True)
    def memory_reconnect(schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_reconnect", "reconnect", "tool_reconnect").to_mcp_result()

    @app.tool(name="memory_graph_stats", description=descriptions["memory_graph_stats"], structured_output=True)
    def memory_graph_stats(schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_graph_stats", "graph_stats", "tool_graph_stats").to_mcp_result()

    @app.tool(name="memory_graph_query", description=descriptions["memory_graph_query"], structured_output=True)
    def memory_graph_query(query: str, limit: int = 10, schema_version: str = "1.0") -> dict[str, Any]:
        result = call_mempalace_tool("memory_graph_query", "graph_query", "tool_kg_query", entity=query)
        return limit_memory_result_items(result, limit).to_mcp_result()

    @app.tool(name="memory_graph_traverse", description=descriptions["memory_graph_traverse"], structured_output=True)
    def memory_graph_traverse(start: str, depth: int = 2, schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_graph_traverse", "graph_traverse", "tool_traverse_graph", start_room=start, max_hops=depth).to_mcp_result()

    @app.tool(name="memory_kg_add", description=descriptions["memory_kg_add"], structured_output=True)
    def memory_kg_add(subject: str, predicate: str, object: str, source: str | None = "ymcp", schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_kg_add", "kg_add", "tool_kg_add", subject=subject, predicate=predicate, object=object, source_closet=source).to_mcp_result()

    @app.tool(name="memory_kg_timeline", description=descriptions["memory_kg_timeline"], structured_output=True)
    def memory_kg_timeline(query: str, limit: int = 10, schema_version: str = "1.0") -> dict[str, Any]:
        result = call_mempalace_tool("memory_kg_timeline", "kg_timeline", "tool_kg_timeline", entity=query)
        return limit_memory_result_items(result, limit).to_mcp_result()

    @app.tool(name="memory_kg_invalidate", description=descriptions["memory_kg_invalidate"], structured_output=True)
    def memory_kg_invalidate(subject: str, predicate: str, object: str, schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_kg_invalidate", "kg_invalidate", "tool_kg_invalidate", subject=subject, predicate=predicate, object=object).to_mcp_result()

    @app.tool(name="memory_create_tunnel", description=descriptions["memory_create_tunnel"], structured_output=True)
    def memory_create_tunnel(source: str, target: str, relationship: str | None = None, schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_create_tunnel", "create_tunnel", "tool_create_tunnel", source_wing="personal", source_room=source, target_wing="personal", target_room=target, label=relationship or "").to_mcp_result()

    @app.tool(name="memory_list_tunnels", description=descriptions["memory_list_tunnels"], structured_output=True)
    def memory_list_tunnels(schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_list_tunnels", "list_tunnels", "tool_list_tunnels").to_mcp_result()

    @app.tool(name="memory_find_tunnels", description=descriptions["memory_find_tunnels"], structured_output=True)
    def memory_find_tunnels(query: str, limit: int = 10, schema_version: str = "1.0") -> dict[str, Any]:
        result = call_mempalace_tool("memory_find_tunnels", "find_tunnels", "tool_find_tunnels", wing_a=query)
        return limit_memory_result_items(result, limit).to_mcp_result()

    @app.tool(name="memory_follow_tunnels", description=descriptions["memory_follow_tunnels"], structured_output=True)
    def memory_follow_tunnels(start: str, schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_follow_tunnels", "follow_tunnels", "tool_follow_tunnels", wing="personal", room=start).to_mcp_result()

    @app.tool(name="memory_delete_tunnel", description=descriptions["memory_delete_tunnel"], structured_output=True)
    def memory_delete_tunnel(tunnel_id: str, schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_delete_tunnel", "delete_tunnel", "tool_delete_tunnel", tunnel_id=tunnel_id).to_mcp_result()

    @app.tool(name="memory_diary_write", description=descriptions["memory_diary_write"], structured_output=True)
    def memory_diary_write(entry: str, date: str | None = None, schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_diary_write", "diary_write", "tool_diary_write", agent_name="ymcp", entry=entry, topic=date or "general").to_mcp_result()

    @app.tool(name="memory_diary_read", description=descriptions["memory_diary_read"], structured_output=True)
    def memory_diary_read(limit: int = 10, schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_diary_read", "diary_read", "tool_diary_read", agent_name="ymcp", last_n=limit).to_mcp_result()

    return app
