from __future__ import annotations

import json
import logging
import os
import time
from typing import Annotated, Any

import mcp.types as types
from mcp.server.fastmcp import Context, FastMCP
from pydantic import BaseModel, Field, WithJsonSchema

from ymcp.contracts.deep_interview import DeepInterviewRequest, InterviewRound
from ymcp.contracts.plan import PlanRequest
from ymcp.contracts.ralplan import RalplanRequest
from ymcp.contracts.ralph import RalphRequest
from ymcp.contracts.workflow import MemoryContext
from ymcp.capabilities import get_prompt_specs, get_resource_specs, prompt_template
from ymcp.engine.deep_interview import build_deep_interview
from ymcp.engine.plan import build_plan
from ymcp.engine.ralplan import build_ralplan
from ymcp.engine.ralph import build_ralph
from ymcp.memory import (
    build_memory_request_id,
    call_mempalace_tool,
    limit_memory_result_items,
    memory_log_kv,
    mempalace_palace_path,
)
from ymcp.internal_registry import get_tool_specs

LOGGER = logging.getLogger("ymcp")


def _single_choice_schema(title: str, description: str, options: list[tuple[str, str, str]]) -> dict[str, Any]:
    return {
        "type": "string",
        "title": title,
        "description": description,
        "oneOf": [
            {"const": value, "title": option_title, "description": option_description}
            for value, option_title, option_description in options
        ],
    }


DeepInterviewNextToolChoice = Annotated[
    str,
    Field(description="下一步 workflow 的唯一选择值。"),
    WithJsonSchema(
        _single_choice_schema(
            "下一步工作流",
            "请选择 deep_interview 结晶后的下一步 workflow；宿主应将该字段渲染为单选项而不是普通文本。",
            [
                ("ralplan", "ralplan（推荐）", "进入共识规划，再推进后续执行。"),
                ("plan", "plan", "先生成更直接的执行计划。"),
                ("ralph", "ralph", "基于澄清规格直接进入执行与验证闭环。"),
                ("refine_further", "继续深访", "继续补充边界、约束或验收标准。"),
            ],
        )
    ),
]

PlanClarifyChoice = Annotated[
    str,
    Field(description="plan 在任务模糊时的下一步动作。"),
    WithJsonSchema(
        _single_choice_schema(
            "下一步动作",
            "请选择进入 deep_interview，或直接补充更具体任务。",
            [
                ("deep_interview", "进入 deep_interview", "继续澄清需求。"),
                ("provide_details", "直接补充细节", "保持在 plan 内继续提供更明确任务。"),
            ],
        )
    ),
]

PlanNextToolChoice = Annotated[
    str,
    Field(description="plan 产出后的下一步 workflow。"),
    WithJsonSchema(
        _single_choice_schema(
            "下一步工作流",
            "请选择 plan 之后的下一步 workflow。",
            [
                ("ralph", "ralph", "进入执行与验证闭环。"),
                ("ralplan", "ralplan", "进入共识规划。"),
                ("deep_interview", "deep_interview", "返回需求澄清。"),
            ],
        )
    ),
]

RalplanNextToolChoice = Annotated[
    str,
    Field(description="ralplan 批准后的下一步 workflow。"),
    WithJsonSchema(
        _single_choice_schema(
            "下一步工作流",
            "请选择 ralplan 批准后的下一步 workflow。",
            [
                ("ralph", "ralph", "按批准方案进入执行与验证。"),
                ("plan", "plan", "先把批准方案拆成更细执行计划。"),
                ("memory_store", "memory_store", "将规划摘要写入长期记忆。"),
            ],
        )
    ),
]

RalphNextToolChoice = Annotated[
    str,
    Field(description="ralph 完成后的下一步动作。"),
    WithJsonSchema(
        _single_choice_schema(
            "下一步动作",
            "请选择 ralph 完成后的下一步动作。",
            [
                ("memory_store", "memory_store", "保存完成摘要到长期记忆。"),
                ("plan", "plan", "基于结果重新规划。"),
                ("finish", "finish", "结束当前流程。"),
            ],
        )
    ),
]


class DeepInterviewAnswerInput(BaseModel):
    answer: str


class DeepInterviewNextToolInput(BaseModel):
    next_tool: DeepInterviewNextToolChoice


class PlanClarifyInput(BaseModel):
    next_action: PlanClarifyChoice
    task_details: str | None = None


class PlanNextToolInput(BaseModel):
    next_tool: PlanNextToolChoice


class PlanReviewTargetInput(BaseModel):
    review_target: str


class RalplanNextToolInput(BaseModel):
    next_tool: RalplanNextToolChoice


class RalphEvidenceInput(BaseModel):
    latest_evidence: list[str]


class RalphVerificationInput(BaseModel):
    verification_commands: list[str]


class RalphNextToolInput(BaseModel):
    next_tool: RalphNextToolChoice


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


def _supports_form_elicitation(ctx: Context | None) -> bool:
    if ctx is None:
        return False
    try:
        return ctx.session.check_client_capability(
            types.ClientCapabilities(
                elicitation=types.ElicitationCapability(form=types.FormElicitationCapability())
            )
        )
    except ValueError:
        return False


async def _maybe_elicit_deep_interview(ctx: Context | None, request: DeepInterviewRequest):
    result = build_deep_interview(request)
    if not _supports_form_elicitation(ctx):
        return result
    if result.artifacts.next_question:
        answer = await ctx.elicit(result.artifacts.next_question, DeepInterviewAnswerInput)
        if answer.action == "accept":
            request.prior_rounds.append(InterviewRound(question=result.artifacts.next_question, answer=answer.data.answer))
            result = build_deep_interview(request)
    if result.artifacts.spec_skeleton is not None and result.artifacts.requested_input:
        handoff = await ctx.elicit("需求澄清已完成。请选择下一步工作流。", DeepInterviewNextToolInput)
        if handoff.action == "accept":
            result.artifacts.selected_next_tool = handoff.data.next_tool
    return result


async def _maybe_elicit_plan(ctx: Context | None, request: PlanRequest):
    result = build_plan(request)
    if not _supports_form_elicitation(ctx):
        return result
    phase = result.artifacts.workflow_state.current_phase
    if phase == "review" and result.artifacts.requested_input:
        review = await ctx.elicit("请提供 review_target。", PlanReviewTargetInput)
        if review.action == "accept":
            request.review_target = review.data.review_target
            result = build_plan(request)
    elif phase == "interview_required":
        choice = await ctx.elicit("当前任务过于模糊。请选择进入 deep_interview，或直接补充更具体任务。", PlanClarifyInput)
        if choice.action == "accept":
            if choice.data.next_action == "deep_interview":
                result.artifacts.selected_next_tool = "deep_interview"
            elif choice.data.task_details:
                request.task = choice.data.task_details
                request.mode = "auto"
                result = build_plan(request)
    elif phase == "direct_plan":
        choice = await ctx.elicit("计划已生成。请选择下一步 workflow。", PlanNextToolInput)
        if choice.action == "accept":
            result.artifacts.selected_next_tool = choice.data.next_tool
    return result


async def _maybe_elicit_ralplan(ctx: Context | None, request: RalplanRequest):
    result = build_ralplan(request)
    if not _supports_form_elicitation(ctx):
        return result
    if result.artifacts.requested_input:
        choice = await ctx.elicit("共识规划已批准。请选择下一步 workflow。", RalplanNextToolInput)
        if choice.action == "accept":
            result.artifacts.selected_next_tool = choice.data.next_tool
    return result


async def _maybe_elicit_ralph(ctx: Context | None, request: RalphRequest):
    result = build_ralph(request)
    if not _supports_form_elicitation(ctx):
        return result
    if result.artifacts.stop_continue_judgement == "needs_more_evidence":
        evidence = await ctx.elicit("请补充 latest_evidence。", RalphEvidenceInput)
        if evidence.action == "accept":
            request.latest_evidence = evidence.data.latest_evidence
            result = build_ralph(request)
    if result.artifacts.stop_continue_judgement == "needs_verification_plan":
        verification = await ctx.elicit("请补充 verification_commands。", RalphVerificationInput)
        if verification.action == "accept":
            request.verification_commands = verification.data.verification_commands
            result = build_ralph(request)
    if result.artifacts.stop_continue_judgement == "complete":
        choice = await ctx.elicit("Ralph 已判断当前工作流完成。请选择下一步。", RalphNextToolInput)
        if choice.action == "accept":
            result.artifacts.selected_next_tool = choice.data.next_tool
    return result


def create_app() -> FastMCP:
    app = FastMCP(
        name="ymcp",
        instructions="MCP-first workflow tools using standard structured tool results and official elicitation when user input is required.",
        log_level="ERROR",
    )
    descriptions = {spec.name: spec.description for spec in get_tool_specs()}

    for resource_spec in get_resource_specs():
        def _make_resource_content(content: str):
            def _resource_content() -> str:
                return content

            return _resource_content

        app.resource(
            resource_spec.uri,
            name=resource_spec.name,
            title=resource_spec.title,
            description=resource_spec.description,
            mime_type=resource_spec.mime_type,
        )(_make_resource_content(resource_spec.content))

    prompt_descriptions = {spec.name: spec.description for spec in get_prompt_specs()}

    @app.prompt(name="deep_interview_clarify", title="Deep Interview Clarify", description=prompt_descriptions["deep_interview_clarify"])
    def deep_interview_clarify(brief: str = "{brief}") -> str:
        return prompt_template("deep_interview_clarify", brief=brief)

    @app.prompt(name="plan_direct", title="Plan Direct", description=prompt_descriptions["plan_direct"])
    def plan_direct(task: str = "{task}") -> str:
        return prompt_template("plan_direct", task=task)

    @app.prompt(name="ralplan_consensus", title="Ralplan Consensus", description=prompt_descriptions["ralplan_consensus"])
    def ralplan_consensus(task: str = "{task}") -> str:
        return prompt_template("ralplan_consensus", task=task)

    @app.prompt(name="ralplan_planner_pass", title="Ralplan Planner Pass", description=prompt_descriptions["ralplan_planner_pass"])
    def ralplan_planner_pass(task: str = "{task}", deliberate: bool = False, constraints: Any = "{constraints}") -> str:
        return prompt_template("ralplan_planner_pass", task=task, deliberate=deliberate, constraints=constraints)

    @app.prompt(name="ralplan_architect_pass", title="Ralplan Architect Pass", description=prompt_descriptions["ralplan_architect_pass"])
    def ralplan_architect_pass(task: str = "{task}", planner_draft: str = "{planner_draft}", deliberate: bool = False) -> str:
        return prompt_template("ralplan_architect_pass", task=task, planner_draft=planner_draft, deliberate=deliberate)

    @app.prompt(name="ralplan_critic_pass", title="Ralplan Critic Pass", description=prompt_descriptions["ralplan_critic_pass"])
    def ralplan_critic_pass(task: str = "{task}", planner_draft: str = "{planner_draft}", architect_feedback: Any = "{architect_feedback}", deliberate: bool = False) -> str:
        return prompt_template("ralplan_critic_pass", task=task, planner_draft=planner_draft, architect_feedback=architect_feedback, deliberate=deliberate)

    @app.prompt(name="ralph_verify", title="Ralph Verify", description=prompt_descriptions["ralph_verify"])
    def ralph_verify(approved_plan: str = "{approved_plan}", latest_evidence: str = "{latest_evidence}") -> str:
        return prompt_template("ralph_verify", approved_plan=approved_plan, latest_evidence=latest_evidence)

    @app.prompt(name="memory_store_after_completion", title="Memory Store After Completion", description=prompt_descriptions["memory_store_after_completion"])
    def memory_store_after_completion(summary: str = "{summary}") -> str:
        return prompt_template("memory_store_after_completion", summary=summary)

    @app.tool(name="plan", description=descriptions["plan"], structured_output=True)
    async def plan(task: str | None = None, problem: str | None = None, mode: str = "auto", constraints: Any = None, known_context: Any = None, memory_context: Any = None, acceptance_criteria: Any = None, review_target: str | None = None, desired_outcome: str | None = None, schema_version: str = "1.0", ctx: Context | None = None) -> dict[str, Any]:
        task_value = task or problem or ""
        request = PlanRequest(task=task_value, mode=mode, constraints=_coerce_str_list(constraints), known_context=_known_context(known_context), memory_context=_memory_context(memory_context), acceptance_criteria=_coerce_str_list(acceptance_criteria), review_target=review_target, desired_outcome=desired_outcome, schema_version=schema_version)
        return (await _maybe_elicit_plan(ctx, request)).to_mcp_result()

    @app.tool(name="ralplan", description=descriptions["ralplan"], structured_output=True)
    async def ralplan(task: str, constraints: Any = None, deliberate: bool = False, interactive: bool = False, current_phase: str = "planner_draft", planner_draft: str | None = None, architect_feedback: Any = None, critic_feedback: Any = None, critic_verdict: str | None = None, known_context: Any = None, memory_context: Any = None, iteration: int = 1, schema_version: str = "1.0", ctx: Context | None = None) -> dict[str, Any]:
        request = RalplanRequest(task=task, constraints=_coerce_str_list(constraints), deliberate=deliberate, interactive=interactive, current_phase=current_phase, planner_draft=planner_draft, architect_feedback=_coerce_str_list(architect_feedback), critic_feedback=_coerce_str_list(critic_feedback), critic_verdict_input=critic_verdict, known_context=_known_context(known_context), memory_context=_memory_context(memory_context), iteration=iteration, schema_version=schema_version)
        return (await _maybe_elicit_ralplan(ctx, request)).to_mcp_result()

    @app.tool(name="deep_interview", description=descriptions["deep_interview"], structured_output=True)
    async def deep_interview(brief: str, prior_rounds: Any = None, target_threshold: float = 0.2, profile: str = "standard", known_context: Any = None, memory_context: Any = None, non_goals: Any = None, decision_boundaries: Any = None, schema_version: str = "1.0", ctx: Context | None = None) -> dict[str, Any]:
        rounds = _coerce_rounds(prior_rounds)
        request = DeepInterviewRequest(brief=brief, prior_rounds=rounds, target_threshold=target_threshold, profile=profile, known_context=_known_context(known_context), memory_context=_memory_context(memory_context), non_goals=_coerce_str_list(non_goals), decision_boundaries=_coerce_str_list(decision_boundaries), schema_version=schema_version)
        return (await _maybe_elicit_deep_interview(ctx, request)).to_mcp_result()

    @app.tool(name="ralph", description=descriptions["ralph"], structured_output=True)
    async def ralph(approved_plan: str, latest_evidence: Any = None, evidence: Any = None, current_phase: str = "executing", todo_status: Any = None, verification_commands: Any = None, known_failures: Any = None, iteration: int = 1, current_status: str | None = None, schema_version: str = "1.0", ctx: Context | None = None) -> dict[str, Any]:
        request = RalphRequest(approved_plan=approved_plan, latest_evidence=_coerce_str_list(latest_evidence or evidence), current_phase=current_phase, todo_status=_coerce_str_list(todo_status), verification_commands=_coerce_str_list(verification_commands), known_failures=_coerce_str_list(known_failures), iteration=iteration, current_status=current_status, schema_version=schema_version)
        return (await _maybe_elicit_ralph(ctx, request)).to_mcp_result()

    @app.tool(name="memory_store", description=descriptions["memory_store"], structured_output=True)
    def memory_store(content: str, wing: str = "personal", room: str = "ymcp", source_file: str | None = None, added_by: str = "ymcp", schema_version: str = "1.0") -> dict[str, Any]:
        return call_mempalace_tool("memory_store", "store", "tool_add_drawer", wing=wing, room=room, content=content, source_file=source_file, added_by=added_by).to_mcp_result()

    @app.tool(name="memory_search", description=descriptions["memory_search"], structured_output=True)
    def memory_search(query: str, limit: int = 5, wing: str | None = "personal", room: str | None = None, max_distance: float = 1.5, min_similarity: float | None = None, context: str | None = None, schema_version: str = "1.0") -> dict[str, Any]:
        request_id = build_memory_request_id()
        started_at = time.perf_counter()
        memory_log_kv(
            "memory_search_handler_start",
            request_id=request_id,
            pid=os.getpid(),
            palace_path=mempalace_palace_path(),
            query_length=len(query),
            limit=limit,
            wing=wing,
            room=room,
            max_distance=max_distance,
            min_similarity=min_similarity,
            context_length=(len(context) if context else 0),
        )
        try:
            result = call_mempalace_tool(
                "memory_search",
                "search",
                "tool_search",
                query=query,
                limit=limit,
                wing=wing,
                room=room,
                max_distance=max_distance,
                min_similarity=min_similarity,
                context=context,
                request_id=request_id,
            )
            duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
            memory_log_kv(
                "memory_search_handler_end",
                request_id=request_id,
                pid=os.getpid(),
                duration_ms=duration_ms,
                status=result.status.value,
                result_count=result.artifacts.count,
                message=result.artifacts.message,
            )
            payload = result.to_mcp_result()
            memory_log_kv(
                "memory_search_handler_return",
                request_id=request_id,
                pid=os.getpid(),
                payload_status=payload.get("status"),
                payload_keys=",".join(sorted(payload.keys())),
                artifacts_count=payload.get("artifacts", {}).get("count"),
            )
            return payload
        except Exception as exc:
            duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
            memory_log_kv(
                "memory_search_handler_error",
                request_id=request_id,
                pid=os.getpid(),
                duration_ms=duration_ms,
                error_type=type(exc).__name__,
                error_message=str(exc),
            )
            raise

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
        request_id = build_memory_request_id()
        started_at = time.perf_counter()
        memory_log_kv(
            "memory_status_handler_start",
            request_id=request_id,
            pid=os.getpid(),
            palace_path=mempalace_palace_path(),
        )
        try:
            result = call_mempalace_tool(
                "memory_status",
                "status",
                "tool_status",
                request_id=request_id,
            )
            duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
            memory_log_kv(
                "memory_status_handler_end",
                request_id=request_id,
                pid=os.getpid(),
                duration_ms=duration_ms,
                status=result.status.value,
                result_count=result.artifacts.count,
                message=result.artifacts.message,
            )
            payload = result.to_mcp_result()
            memory_log_kv(
                "memory_status_handler_return",
                request_id=request_id,
                pid=os.getpid(),
                payload_status=payload.get("status"),
                payload_keys=",".join(sorted(payload.keys())),
                artifacts_count=payload.get("artifacts", {}).get("count"),
            )
            return payload
        except Exception as exc:
            duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
            memory_log_kv(
                "memory_status_handler_error",
                request_id=request_id,
                pid=os.getpid(),
                duration_ms=duration_ms,
                error_type=type(exc).__name__,
                error_message=str(exc),
            )
            raise

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
