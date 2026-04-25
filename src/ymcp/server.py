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

from ymcp.contracts.memory import MEMPALACE_REQUEST_MODELS, MEMPALACE_TOOL_SCHEMAS, MemoryResult
from ymcp.contracts.deep_interview import DeepInterviewRequest, DeepInterviewResult, InterviewRound
from ymcp.contracts.plan import PlanRequest, PlanResult
from ymcp.contracts.ralplan import (
    RalplanArchitectRequest,
    RalplanArchitectResult,
    RalplanCriticRequest,
    RalplanCriticResult,
    RalplanHandoffRequest,
    RalplanHandoffResult,
    RalplanPlannerRequest,
    RalplanPlannerResult,
    RalplanRequest,
    RalplanResult,
)
from ymcp.contracts.ralph import RalphRequest, RalphResult
from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.workflow import MemoryContext, WorkflowPhaseSummary
from ymcp.capabilities import get_prompt_specs, get_resource_specs, prompt_template
from ymcp.engine.deep_interview import build_deep_interview
from ymcp.engine.plan import build_plan
from ymcp.engine.ralplan import (
    build_ralplan,
    build_ralplan_architect,
    build_ralplan_critic,
    build_ralplan_handoff,
    build_ralplan_planner,
)
from ymcp.engine.ralph import build_ralph
from ymcp.memory import (
    build_memory_request_id,
    execute_memory_operation,
    memory_log_kv,
    memory_result_to_mcp_payload,
    mempalace_palace_path,
)
from ymcp.internal_registry import get_tool_specs
from ymcp.core.result import apply_selected_tool_handoff, build_next_action

LOGGER = logging.getLogger("ymcp")


def _single_choice_schema(title: str, description: str, options: list[tuple[str, str, str]]) -> dict[str, Any]:
    return {
        "type": "string",
        "title": title,
        "description": description,
        "oneOf": [
            {"const": value, "title": option_title}
            for value, option_title, _option_description in options
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


def _deep_interview_target_dimension(result) -> str | None:
    strategy = getattr(result.artifacts, "question_strategy", None)
    return getattr(strategy, "target_dimension", None)


def _merge_deep_interview_answer(request: DeepInterviewRequest, result, answer_text: str) -> None:
    target = _deep_interview_target_dimension(result)
    if target == "scope":
        request.non_goals = _split_lines(answer_text) or [answer_text.strip()]
    elif target == "decision_boundaries":
        request.decision_boundaries = _split_lines(answer_text) or [answer_text.strip()]
    elif target == "context":
        request.repo_findings = _split_lines(answer_text) or [answer_text.strip()]


class PlanClarifyChoiceInput(BaseModel):
    next_action: PlanClarifyChoice


class PlanTaskDetailsInput(BaseModel):
    task_details: str


class PlanNextToolInput(BaseModel):
    next_tool: PlanNextToolChoice


class PlanReviewTargetInput(BaseModel):
    review_target: str


class RalplanNextToolInput(BaseModel):
    next_tool: RalplanNextToolChoice


class RalphEvidenceInput(BaseModel):
    latest_evidence_text: str


class RalphVerificationInput(BaseModel):
    verification_commands_text: str


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
        if not ctx.session.check_client_capability(types.ClientCapabilities(elicitation=types.ElicitationCapability())):
            return False
        client_params = getattr(ctx.session, "_client_params", None)
        client_caps = getattr(client_params, "capabilities", None)
        elicitation = getattr(client_caps, "elicitation", None)
        if elicitation is None:
            return False
        form_mode = getattr(elicitation, "form", None)
        url_mode = getattr(elicitation, "url", None)
        return form_mode is not None or (form_mode is None and url_mode is None)
    except ValueError:
        return False


def _split_lines(value: str) -> list[str]:
    return [line.strip() for line in value.splitlines() if line.strip()]


async def _emit_ralplan_progress(ctx: Context | None, phase_key: str, result: Any) -> None:
    if ctx is None:
        return
    phase_map = {
        "kickoff": (1, 5, "进入 ralplan，总入口已就绪，下一步是 Planner。"),
        "planner": (2, 5, "Planner 草案已生成，正在准备 Architect 审查。"),
        "architect": (3, 5, "Architect 审查已完成，下一步是 Critic。"),
        "critic_approved": (4, 5, "Critic 已批准当前规划，正在准备 handoff。"),
        "critic_needs_revision": (4, 5, "Critic 要求修订，当前不会继续自动 handoff。"),
        "handoff": (5, 5, "已到达 handoff，等待宿主展示下一步 workflow 选择。"),
        "handoff_blocked": (5, 5, "handoff 被阻断：critic verdict 未批准。"),
    }
    progress, total, base_message = phase_map[phase_key]
    phase_summary = getattr(getattr(result, "artifacts", None), "phase_summary", None)
    phase_title = getattr(phase_summary, "title", None)
    summary = getattr(result, "summary", None)
    selected_next_tool = getattr(getattr(result, "meta", None), "selected_next_tool", None)
    message_parts = [base_message]
    if phase_title:
        message_parts.append(f"阶段：{phase_title}。")
    if summary:
        message_parts.append(f"结果：{summary}")
    if selected_next_tool:
        message_parts.append(f"建议下一工具：{selected_next_tool}。")
    message = " ".join(message_parts)
    try:
        await ctx.info(message, logger_name="ymcp.ralplan")
        await ctx.report_progress(progress, total, base_message)
    except Exception:  # pragma: no cover - host transport failures should not break tool results
        LOGGER.debug("Failed to emit ralplan MCP progress notification.", exc_info=True)


def _handle_elicitation_non_accept(result, action: str, message: str):
    action_label = "拒绝" if action == "decline" else "取消"
    result.summary = f"{message}（用户已{action_label}）"
    result.next_actions = [build_next_action("下一步", "宿主可展示当前状态，并在用户愿意时重新发起 MCP Elicitation。")]
    result.meta.required_host_action = HostActionType.DISPLAY_ONLY
    result.meta.safe_to_auto_continue = False
    result.meta.selected_next_tool = None
    return result


def _register_mempalace_tool(app: FastMCP, *, name: str, description: str, request_model: type[BaseModel]) -> None:
    fields = request_model.model_fields
    parameters: list[inspect.Parameter] = []
    annotations: dict[str, Any] = {"return": MEMPALACE_REQUEST_MODELS.get(name, BaseModel)}

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

    signature = inspect.Signature(parameters=parameters, return_annotation=MemoryResult)

    def _tool_impl(**kwargs: Any) -> MemoryResult:
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
            payload = memory_result_to_mcp_payload(
                result,
                handler_name=f"{name}_handler",
                request_id=request_id,
                started_at=started_at,
            )
            return MemoryResult.model_validate(payload)
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
    annotations["return"] = MemoryResult
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
            _merge_deep_interview_answer(request, result, answer.data.answer)
            request.prior_rounds.append(InterviewRound(question=result.artifacts.next_question, answer=answer.data.answer))
            result = build_deep_interview(request)
        else:
            return _handle_elicitation_non_accept(result, answer.action, "用户未回答当前澄清问题，本轮 deep_interview 保持等待输入。")
    if result.artifacts.spec_skeleton is not None:
        handoff = await ctx.elicit("需求澄清已完成。请选择下一步工作流。", DeepInterviewNextToolInput)
        if handoff.action == "accept":
            apply_selected_tool_handoff(result, handoff.data.next_tool)
        else:
            return _handle_elicitation_non_accept(result, handoff.action, "用户未选择下一步 workflow，本轮 deep_interview 保持等待输入。")
    return result


async def _maybe_elicit_plan(ctx: Context | None, request: PlanRequest):
    result = build_plan(request)
    if not _supports_form_elicitation(ctx):
        return result
    phase = result.artifacts.workflow_state.current_phase
    if phase == "review" and not request.review_target:
        review = await ctx.elicit("请提供 review_target。", PlanReviewTargetInput)
        if review.action == "accept":
            request.review_target = review.data.review_target
            result = build_plan(request)
        else:
            return _handle_elicitation_non_accept(result, review.action, "用户未提供 review_target，本轮 plan 保持等待输入。")
    elif phase == "interview_required":
        choice = await ctx.elicit("当前任务过于模糊。请选择进入 deep_interview，或直接补充更具体任务。", PlanClarifyChoiceInput)
        if choice.action == "accept":
            if choice.data.next_action == "deep_interview":
                apply_selected_tool_handoff(result, "deep_interview")
            else:
                details = await ctx.elicit("请补充更具体的任务描述。", PlanTaskDetailsInput)
                if details.action == "accept":
                    request.task = details.data.task_details
                    request.mode = "auto"
                    result = build_plan(request)
                else:
                    return _handle_elicitation_non_accept(result, details.action, "用户未补充更具体的任务描述，本轮 plan 保持等待输入。")
        else:
            return _handle_elicitation_non_accept(result, choice.action, "用户未选择下一步动作，本轮 plan 保持等待输入。")
    elif phase == "direct_plan":
        choice = await ctx.elicit("计划已生成。请选择下一步 workflow。", PlanNextToolInput)
        if choice.action == "accept":
            apply_selected_tool_handoff(result, choice.data.next_tool)
        else:
            return _handle_elicitation_non_accept(result, choice.action, "用户未选择下一步 workflow，本轮 plan 保持等待输入。")
    return result


async def _maybe_elicit_ralplan_handoff(ctx: Context | None, request: RalplanHandoffRequest):
    result = build_ralplan_handoff(request)
    await _emit_ralplan_progress(ctx, "handoff" if result.status == ToolStatus.NEEDS_INPUT else "handoff_blocked", result)
    if result.status != ToolStatus.NEEDS_INPUT:
        return result
    if not _supports_form_elicitation(ctx):
        return result
    choice = await ctx.elicit("共识规划已批准。请选择下一步 workflow。", RalplanNextToolInput)
    if choice.action == "accept":
        apply_selected_tool_handoff(result, choice.data.next_tool)
    else:
        return _handle_elicitation_non_accept(result, choice.action, "用户未选择下一步 workflow，本轮 ralplan_handoff 保持等待输入。")
    return result


async def _maybe_elicit_ralph(ctx: Context | None, request: RalphRequest):
    result = build_ralph(request)
    if not _supports_form_elicitation(ctx):
        return result
    if result.artifacts.stop_continue_judgement == "needs_more_evidence":
        evidence = await ctx.elicit("请补充 latest_evidence。", RalphEvidenceInput)
        if evidence.action == "accept":
            request.latest_evidence = _split_lines(evidence.data.latest_evidence_text)
            result = build_ralph(request)
        else:
            return _handle_elicitation_non_accept(result, evidence.action, "用户未补充 latest_evidence，本轮 ralph 保持等待输入。")
    if result.artifacts.stop_continue_judgement == "needs_verification_plan":
        verification = await ctx.elicit("请补充 verification_commands。", RalphVerificationInput)
        if verification.action == "accept":
            request.verification_commands = _split_lines(verification.data.verification_commands_text)
            result = build_ralph(request)
        else:
            return _handle_elicitation_non_accept(result, verification.action, "用户未补充 verification_commands，本轮 ralph 保持等待输入。")
    if result.artifacts.stop_continue_judgement == "complete":
        choice = await ctx.elicit("Ralph 已判断当前工作流完成。请选择下一步。", RalphNextToolInput)
        if choice.action == "accept":
            apply_selected_tool_handoff(result, choice.data.next_tool)
        else:
            return _handle_elicitation_non_accept(result, choice.action, "用户未选择下一步动作，本轮 ralph 保持等待输入。")
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
    async def plan(task: str | None = None, problem: str | None = None, mode: str = "auto", constraints: list[str] | None = None, known_context: list[str] | None = None, memory_context: MemoryContext | None = None, acceptance_criteria: list[str] | None = None, review_target: str | None = None, desired_outcome: str | None = None, schema_version: str = "1.0", ctx: Context | None = None) -> PlanResult:
        task_value = task or problem or ""
        request = PlanRequest(task=task_value, mode=mode, constraints=constraints or [], known_context=known_context or [], memory_context=memory_context or MemoryContext(), acceptance_criteria=acceptance_criteria or [], review_target=review_target, desired_outcome=desired_outcome, schema_version=schema_version)
        return await _maybe_elicit_plan(ctx, request)

    @app.tool(name="ralplan", description=descriptions["ralplan"], structured_output=True)
    async def ralplan(task: str, constraints: list[str] | None = None, deliberate: bool = False, known_context: list[str] | None = None, memory_context: MemoryContext | None = None, review_iteration: int = 1, max_iterations: int = 5, feedback_bundle: list[str] | None = None, schema_version: str = "1.0", ctx: Context | None = None) -> RalplanResult:
        request = RalplanRequest(task=task, constraints=constraints or [], deliberate=deliberate, known_context=known_context or [], memory_context=memory_context or MemoryContext(), review_iteration=review_iteration, max_iterations=max_iterations, feedback_bundle=feedback_bundle or [], schema_version=schema_version)
        result = build_ralplan(request)
        await _emit_ralplan_progress(ctx, "kickoff", result)
        return result

    @app.tool(name="ralplan_planner", description=descriptions["ralplan_planner"], structured_output=True)
    async def ralplan_planner(task: str, constraints: list[str] | None = None, deliberate: bool = False, known_context: list[str] | None = None, memory_context: MemoryContext | None = None, kickoff_summary: str | None = None, review_iteration: int = 1, max_iterations: int = 5, feedback_bundle: list[str] | None = None, schema_version: str = "1.0", ctx: Context | None = None) -> RalplanPlannerResult:
        request = RalplanPlannerRequest(task=task, constraints=constraints or [], deliberate=deliberate, known_context=known_context or [], memory_context=memory_context or MemoryContext(), review_iteration=review_iteration, max_iterations=max_iterations, feedback_bundle=feedback_bundle or [], schema_version=schema_version)
        result = build_ralplan_planner(request)
        await _emit_ralplan_progress(ctx, "planner", result)
        return result

    @app.tool(name="ralplan_architect", description=descriptions["ralplan_architect"], structured_output=True)
    async def ralplan_architect(task: str, planner_draft: str, constraints: list[str] | None = None, deliberate: bool = False, known_context: list[str] | None = None, memory_context: MemoryContext | None = None, review_iteration: int = 1, max_iterations: int = 5, feedback_bundle: list[str] | None = None, schema_version: str = "1.0", ctx: Context | None = None) -> RalplanArchitectResult:
        request = RalplanArchitectRequest(task=task, planner_draft=planner_draft, constraints=constraints or [], deliberate=deliberate, known_context=known_context or [], memory_context=memory_context or MemoryContext(), review_iteration=review_iteration, max_iterations=max_iterations, feedback_bundle=feedback_bundle or [], schema_version=schema_version)
        result = build_ralplan_architect(request)
        await _emit_ralplan_progress(ctx, "architect", result)
        return result

    @app.tool(name="ralplan_critic", description=descriptions["ralplan_critic"], structured_output=True)
    async def ralplan_critic(task: str, planner_draft: str, architect_review: str, constraints: list[str] | None = None, deliberate: bool = False, known_context: list[str] | None = None, memory_context: MemoryContext | None = None, review_iteration: int = 1, max_iterations: int = 5, feedback_bundle: list[str] | None = None, schema_version: str = "1.0", ctx: Context | None = None) -> RalplanCriticResult:
        request = RalplanCriticRequest(task=task, planner_draft=planner_draft, architect_review=architect_review, constraints=constraints or [], deliberate=deliberate, known_context=known_context or [], memory_context=memory_context or MemoryContext(), review_iteration=review_iteration, max_iterations=max_iterations, feedback_bundle=feedback_bundle or [], schema_version=schema_version)
        result = build_ralplan_critic(request)
        phase_key = "critic_approved" if result.artifacts.critic_verdict == "APPROVE" else "critic_needs_revision"
        await _emit_ralplan_progress(ctx, phase_key, result)
        return result

    @app.tool(name="ralplan_handoff", description=descriptions["ralplan_handoff"], structured_output=True)
    async def ralplan_handoff(task: str, approved_plan_summary: str, critic_verdict: str, known_context: list[str] | None = None, memory_context: MemoryContext | None = None, schema_version: str = "1.0", ctx: Context | None = None) -> RalplanHandoffResult:
        request = RalplanHandoffRequest(task=task, approved_plan_summary=approved_plan_summary, critic_verdict=critic_verdict, known_context=known_context or [], memory_context=memory_context or MemoryContext(), schema_version=schema_version)
        return await _maybe_elicit_ralplan_handoff(ctx, request)

    @app.tool(name="deep_interview", description=descriptions["deep_interview"], structured_output=True)
    async def deep_interview(brief: str, prior_rounds: list[InterviewRound] | None = None, target_threshold: float = 0.2, profile: str = "standard", known_context: list[str] | None = None, repo_findings: list[str] | None = None, context_type: str | None = None, round_limit_override: int | None = None, memory_context: MemoryContext | None = None, non_goals: list[str] | None = None, decision_boundaries: list[str] | None = None, schema_version: str = "1.0", ctx: Context | None = None) -> DeepInterviewResult:
        request = DeepInterviewRequest(brief=brief, prior_rounds=prior_rounds or [], target_threshold=target_threshold, profile=profile, known_context=known_context or [], repo_findings=repo_findings or [], context_type=context_type, round_limit_override=round_limit_override, memory_context=memory_context or MemoryContext(), non_goals=non_goals or [], decision_boundaries=decision_boundaries or [], schema_version=schema_version)
        return await _maybe_elicit_deep_interview(ctx, request)

    @app.tool(name="ralph", description=descriptions["ralph"], structured_output=True)
    async def ralph(approved_plan: str, latest_evidence: list[str] | None = None, evidence: list[str] | None = None, current_phase: str = "executing", verification_commands: list[str] | None = None, verification_results: list[str] | None = None, known_failures: list[str] | None = None, regression_status: str | None = None, architect_review_summary: str | None = None, distillation_status: str | None = None, execution_context_present: bool = False, iteration: int = 1, max_iterations: int = 10, schema_version: str = "1.0", ctx: Context | None = None) -> RalphResult:
        request = RalphRequest(approved_plan=approved_plan, latest_evidence=latest_evidence or evidence or [], current_phase=current_phase, verification_commands=verification_commands or [], verification_results=verification_results or [], known_failures=known_failures or [], regression_status=regression_status, architect_review_summary=architect_review_summary, distillation_status=distillation_status, execution_context_present=execution_context_present, iteration=iteration, max_iterations=max_iterations, schema_version=schema_version)
        return await _maybe_elicit_ralph(ctx, request)

    for tool_schema in MEMPALACE_TOOL_SCHEMAS:
        _register_mempalace_tool(
            app,
            name=tool_schema["name"],
            description=descriptions[tool_schema["name"]],
            request_model=MEMPALACE_REQUEST_MODELS[tool_schema["name"]],
        )

    return app
