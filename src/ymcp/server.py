from __future__ import annotations

import json
import inspect
import logging
import os
import time
from typing import Annotated, Any

import mcp.types as types
from mcp.server.fastmcp import Context, FastMCP
from pydantic import BaseModel, Field, WithJsonSchema

from ymcp.contracts.memory import MEMPALACE_REQUEST_MODELS, MEMPALACE_TOOL_SCHEMAS
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
    execute_memory_operation,
    memory_log_kv,
    memory_result_to_mcp_payload,
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
                ("mempalace_add_drawer", "mempalace_add_drawer", "将规划摘要写入长期记忆。"),
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
                ("mempalace_add_drawer", "mempalace_add_drawer", "保存完成摘要到长期记忆。"),
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


def _register_mempalace_tool(app: FastMCP, *, name: str, description: str, request_model: type[BaseModel]) -> None:
    fields = request_model.model_fields
    parameters: list[inspect.Parameter] = []
    annotations: dict[str, Any] = {"return": dict[str, Any]}

    ordered_fields = sorted(fields.items(), key=lambda item: (not item[1].is_required(),))

    for field_name, field_info in ordered_fields:
        if field_name == "schema_version":
            continue
        field_dict = field_info.asdict()
        field_description = field_dict["attributes"].get("description")
        annotation = Annotated[
            (
                field_dict["annotation"],
                *field_dict["metadata"],
                Field(description=field_description) if field_description else Field(),
            )
        ]
        default = inspect.Parameter.empty if field_info.is_required() else field_info.default
        parameters.append(
            inspect.Parameter(
                field_name,
                kind=inspect.Parameter.POSITIONAL_OR_KEYWORD,
                default=default,
                annotation=annotation,
            )
        )
        annotations[field_name] = annotation

    signature = inspect.Signature(parameters=parameters, return_annotation=dict[str, Any])

    def _tool_impl(**kwargs: Any) -> dict[str, Any]:
        request_id = build_memory_request_id()
        started_at = time.perf_counter()
        memory_log_kv(
            f"{name}_handler_start",
            request_id=request_id,
            pid=os.getpid(),
            palace_path=mempalace_palace_path(),
        )
        try:
            validated = request_model.model_validate(kwargs)
            result = execute_memory_operation(
                name,
                **validated.model_dump(exclude={"schema_version"}, exclude_none=True),
            )
            return memory_result_to_mcp_payload(
                result,
                handler_name=f"{name}_handler",
                request_id=request_id,
                started_at=started_at,
            )
        except Exception as exc:
            duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
            memory_log_kv(
                f"{name}_handler_error",
                request_id=request_id,
                pid=os.getpid(),
                duration_ms=duration_ms,
                error_type=type(exc).__name__,
                error_message=str(exc),
            )
            raise

    _tool_impl.__name__ = name
    _tool_impl.__qualname__ = name
    _tool_impl.__doc__ = description
    _tool_impl.__annotations__ = annotations
    _tool_impl.__signature__ = signature
    app.add_tool(_tool_impl, name=name, description=description, structured_output=True)


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

    for tool_schema in MEMPALACE_TOOL_SCHEMAS:
        _register_mempalace_tool(
            app,
            name=tool_schema["name"],
            description=descriptions[tool_schema["name"]],
            request_model=MEMPALACE_REQUEST_MODELS[tool_schema["name"]],
        )

    return app
