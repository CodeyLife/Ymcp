from __future__ import annotations

import inspect
import json
import logging
import os
import time
from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from pydantic import BaseModel, Field, create_model

from ymcp.capabilities import get_prompt_specs, get_resource_specs, prompt_template
from ymcp.contracts.common import ElicitationState, HostActionType, ToolStatus
from ymcp.contracts.deep_interview import (
    DeepInterviewCompleteRequest,
    DeepInterviewCompleteResult,
    DeepInterviewRequest,
    DeepInterviewResult,
)
from ymcp.contracts.imagegen import ImagegenRequest, ImagegenResult
from ymcp.contracts.memory import MEMPALACE_REQUEST_MODELS, MEMPALACE_TOOL_SCHEMAS, MemoryResult
from ymcp.contracts.ralph import RalphCompleteRequest, RalphCompleteResult, RalphRequest, RalphResult
from ymcp.contracts.ralplan import (
    RalplanArchitectRequest,
    RalplanArchitectResult,
    RalplanCompleteRequest,
    RalplanCompleteResult,
    RalplanCriticRequest,
    RalplanCriticResult,
    RalplanRequest,
    RalplanResult,
)
from ymcp.core.versioning import SCHEMA_VERSION
from ymcp.engine.deep_interview import build_deep_interview, build_deep_interview_complete
from ymcp.engine.imagegen import build_imagegen
from ymcp.engine.ralph import build_ralph, build_ralph_complete
from ymcp.engine.ralplan import build_ralplan, build_ralplan_architect, build_ralplan_complete, build_ralplan_critic
from ymcp.internal_registry import get_tool_specs
from ymcp.memory import build_memory_request_id, execute_memory_operation, memory_log_kv, memory_result_to_mcp_payload, mempalace_palace_path

LOGGER = logging.getLogger('ymcp')


def _handoff_menu_lines(options: tuple[Any, ...] | list[Any]) -> str:
    lines: list[str] = []
    for option in options:
        recommended = " [recommended]" if getattr(option, 'recommended', False) else ""
        lines.append(f"- {option.title} (`{option.value}`){recommended}: {option.description}")
    return '\n'.join(lines)


def _handoff_choice_schema(options: tuple[Any, ...] | list[Any]) -> type[BaseModel]:
    values = tuple(option.value for option in options)
    default = next((option.value for option in options if getattr(option, 'recommended', False)), values[0])
    description = '；'.join(f'{option.value} = {option.title}：{option.description}' for option in options)
    return create_model(
        'YmcpHandoffChoice',
        choice=(
            str,
            Field(
                default=default,
                title='下一步',
                description=description,
                json_schema_extra={'enum': list(values)},
            ),
        ),
    )


def _update_workflow_state(result: Any, *, current_phase: str, readiness: str, current_focus: str, blocked_reason: str | None = None, selected_option: str | None = None) -> None:
    artifacts = getattr(result, 'artifacts', None)
    workflow_state = getattr(artifacts, 'workflow_state', None)
    if workflow_state is None:
        return
    workflow_state.current_phase = current_phase
    workflow_state.readiness = readiness
    workflow_state.current_focus = current_focus
    workflow_state.blocked_reason = blocked_reason
    if selected_option and hasattr(artifacts, 'selected_option'):
        artifacts.selected_option = selected_option


def _apply_interactive_handoff_fallback(result: Any, *, reason: str) -> Any:
    result.status = ToolStatus.BLOCKED
    result.meta.required_host_action = HostActionType.AWAIT_INPUT
    result.meta.host_controls = ['display', 'selected_option tool recall']
    result.meta.elicitation_error = reason
    result.meta.menu_authority = 'meta.handoff.options'
    result.meta.ui_request = {
        'kind': 'await_selected_option',
        'selected_option_param': 'selected_option',
    }
    _update_workflow_state(
        result,
        current_phase='awaiting_user_selection',
        readiness='awaiting_user_selection',
        current_focus='fallback_requires_interactive_menu',
        blocked_reason='interactive_menu_required',
    )
    result.next_actions = []
    result.summary = (
        'WORKFLOW_PAUSED_AWAITING_SELECTED_OPTION: '
        '宿主必须通过 meta.handoff.options 提供的固定选项收集用户的下一步流程需求，'
        '并将所选 value 作为 selected_option 回传当前流程菜单 tool；'
        'assistant 不得用自然语言、markdown 文本菜单或自动选择替代宿主交互控件。'
    )
    return result


async def _maybe_elicit_handoff_choice(ctx: Context | None, result: Any, *, message_prefix: str) -> Any:
    artifacts = getattr(result, 'artifacts', None)
    if getattr(artifacts, 'selected_option', None):
        return result
    if result.status is ToolStatus.BLOCKED:
        return result
    if result.meta.handoff is None or not result.meta.handoff.options:
        return result

    result.meta.elicitation_required = True
    options = result.meta.handoff.options
    values = tuple(option.value for option in options)
    if not values:
        return result

    ChoiceSchema = _handoff_choice_schema(options)
    menu_lines = _handoff_menu_lines(options)
    contract_note = '宿主必须用 handoff.options 渲染真实交互选择控件并收集 selected_option；assistant 不得用自然语言或 markdown 列表代渲染选项，也不得自动继续。'
    message = f"{message_prefix}\n\n{contract_note}\n\n选项数据如下，仅供宿主 UI 控件渲染：\n{menu_lines}"
    _update_workflow_state(
        result,
        current_phase='elicitation_requested',
        readiness='elicitation_requested',
        current_focus='elicitation_requested',
    )

    if ctx is None:
        result.meta.elicitation_state = ElicitationState.UNSUPPORTED
        return _apply_interactive_handoff_fallback(
            result,
            reason='当前调用通道未提供 MCP Elicitation 上下文，无法完成流程菜单阶段所要求的菜单选择',
        )

    try:
        request_context = ctx.request_context
    except Exception:
        request_context = None

    if request_context is None:
        result.meta.elicitation_state = ElicitationState.UNSUPPORTED
        return _apply_interactive_handoff_fallback(
            result,
            reason='当前调用通道未提供可用的 MCP Elicitation 上下文，无法完成流程菜单阶段所要求的菜单选择',
        )

    try:
        elicitation = await ctx.elicit(message, ChoiceSchema)
    except Exception as exc:
        result.meta.elicitation_state = ElicitationState.FAILED
        return _apply_interactive_handoff_fallback(
            result,
            reason=f'Elicitation 调用失败（{type(exc).__name__}: {exc}）',
        )

    action = getattr(elicitation, 'action', None)
    if action == 'accept':
        selected = elicitation.data.choice
        if selected not in values:
            result.meta.elicitation_state = ElicitationState.FAILED
            return _apply_interactive_handoff_fallback(
                result,
                reason=f'Elicitation 返回了非法选项 `{selected}`。合法选项只能来自 handoff.options：{", ".join(values)}',
            )
        result.meta.required_host_action = HostActionType.DISPLAY_ONLY
        result.meta.elicitation_state = ElicitationState.ACCEPTED
        result.meta.elicitation_selected_option = selected
        _update_workflow_state(
            result,
            current_phase='selection_confirmed',
            readiness='selection_confirmed',
            current_focus=f'selected:{selected}',
            selected_option=selected,
        )
        result.summary = f"{result.summary}\n\nElicitation 已完成，用户选择了 `{selected}`。"
        return result

    result.status = ToolStatus.NEEDS_INPUT
    result.meta.required_host_action = HostActionType.AWAIT_INPUT
    if action == 'decline':
        result.meta.elicitation_state = ElicitationState.DECLINED
    elif action == 'cancel':
        result.meta.elicitation_state = ElicitationState.CANCELLED
    else:
        result.meta.elicitation_state = ElicitationState.FAILED
    _update_workflow_state(
        result,
        current_phase='awaiting_user_selection',
        readiness='awaiting_user_selection',
        current_focus='awaiting_user_selection',
        blocked_reason='user_choice_pending',
    )
    result.summary = f"{result.summary}\n\nElicitation 未完成（{action}）。宿主必须继续基于 handoff.options 渲染真实交互控件并等待 selected_option；assistant 不得输出文本菜单。"
    return result


def configure_logging(level: int = logging.INFO) -> None:
    if logging.getLogger().handlers:
        return
    logging.basicConfig(level=level, format='%(levelname)s %(name)s: %(message)s')


def _register_mempalace_tool(app: FastMCP, *, name: str, description: str, request_model: type[BaseModel]) -> None:
    fields = request_model.model_fields
    parameters: list[inspect.Parameter] = []
    annotations: dict[str, Any] = {'return': MEMPALACE_REQUEST_MODELS.get(name, BaseModel)}
    ordered_fields = sorted(fields.items(), key=lambda item: (not item[1].is_required(),))
    for field_name, field_info in ordered_fields:
        if field_name == 'schema_version':
            continue
        default = inspect.Parameter.empty if field_info.is_required() else field_info.default
        parameters.append(inspect.Parameter(field_name, kind=inspect.Parameter.POSITIONAL_OR_KEYWORD, default=default, annotation=field_info.annotation))
        annotations[field_name] = field_info.annotation
    signature = inspect.Signature(parameters=parameters, return_annotation=MemoryResult)

    def _tool_impl(**kwargs: Any) -> MemoryResult:
        request_id = build_memory_request_id()
        started_at = time.perf_counter()
        memory_log_kv(f'{name}_handler_start', request_id=request_id, pid=os.getpid(), palace_path=mempalace_palace_path())
        validated = request_model.model_validate(kwargs)
        result = execute_memory_operation(name, **validated.model_dump(exclude={'schema_version'}, exclude_none=True))
        payload = memory_result_to_mcp_payload(result, handler_name=f'{name}_handler', request_id=request_id, started_at=started_at)
        return MemoryResult.model_validate(payload)

    _tool_impl.__name__ = name
    _tool_impl.__qualname__ = name
    _tool_impl.__doc__ = description
    annotations['return'] = MemoryResult
    _tool_impl.__annotations__ = annotations
    _tool_impl.__signature__ = signature
    app.add_tool(_tool_impl, name=name, description=description, structured_output=True)


def create_app() -> FastMCP:
    app = FastMCP(name='ymcp', instructions='Workflow tools ydeep / ydeep_menu / yplan / yplan_architect / yplan_critic / yplan_menu / ydo / ydo_menu / yimggen with skill-guided reasoning and lightweight Elicitation-oriented handoff options.', log_level='ERROR')
    descriptions = {spec.name: spec.description for spec in get_tool_specs()}

    for resource_spec in get_resource_specs():
        def _make_resource_content(content: str):
            def _resource_content() -> str:
                return content
            return _resource_content
        app.resource(resource_spec.uri, name=resource_spec.name, title=resource_spec.title, description=resource_spec.description, mime_type=resource_spec.mime_type)(_make_resource_content(resource_spec.content))

    prompt_descriptions = {spec.name: spec.description for spec in get_prompt_specs()}

    for prompt_spec in get_prompt_specs():
        def _make_prompt(name: str):
            def _prompt(arguments: str = "{arguments}") -> str:
                return prompt_template(name, arguments=arguments)
            return _prompt

        app.prompt(name=prompt_spec.name, title=prompt_spec.title, description=prompt_descriptions[prompt_spec.name])(_make_prompt(prompt_spec.name))

    @app.tool(name='ydeep', description=descriptions['ydeep'], structured_output=True)
    async def deep_interview(brief: str, known_context: list[str] | None = None, memory_context: Any = None, schema_version: str = SCHEMA_VERSION, ctx: Context | None = None) -> DeepInterviewResult:
        request = DeepInterviewRequest(brief=brief, known_context=known_context or [], memory_context=memory_context or {}, schema_version=schema_version)
        result = build_deep_interview(request)
        return result

    @app.tool(name='ydeep_menu', description=descriptions['ydeep_menu'], structured_output=True)
    async def deep_interview_complete(summary: str, selected_option: str | None = None, brief: str | None = None, known_context: list[str] | None = None, memory_context: Any = None, schema_version: str = SCHEMA_VERSION, ctx: Context | None = None) -> DeepInterviewCompleteResult:
        request = DeepInterviewCompleteRequest(summary=summary, selected_option=selected_option, brief=brief, known_context=known_context or [], memory_context=memory_context or {}, schema_version=schema_version)
        result = build_deep_interview_complete(request)
        return await _maybe_elicit_handoff_choice(ctx, result, message_prefix='需求澄清阶段已完成。宿主必须渲染交互式选择控件；assistant 不得用文本代渲染。')

    @app.tool(name='yplan', description=descriptions['yplan'], structured_output=True)
    async def ralplan(task: str, known_context: list[str] | None = None, memory_context: Any = None, schema_version: str = SCHEMA_VERSION, ctx: Context | None = None) -> RalplanResult:
        request = RalplanRequest(task=task, known_context=known_context or [], memory_context=memory_context or {}, schema_version=schema_version)
        result = build_ralplan(request)
        return result

    @app.tool(name='yplan_architect', description=descriptions['yplan_architect'], structured_output=True)
    async def ralplan_architect(schema_version: str = SCHEMA_VERSION, ctx: Context | None = None) -> RalplanArchitectResult:
        request = RalplanArchitectRequest(schema_version=schema_version)
        return build_ralplan_architect(request)

    @app.tool(name='yplan_critic', description=descriptions['yplan_critic'], structured_output=True)
    async def ralplan_critic(architect_summary: str | None = None, schema_version: str = SCHEMA_VERSION, ctx: Context | None = None) -> RalplanCriticResult:
        request = RalplanCriticRequest(architect_summary=architect_summary, schema_version=schema_version)
        return build_ralplan_critic(request)

    @app.tool(name='yplan_menu', description=descriptions['yplan_menu'], structured_output=True)
    async def ralplan_complete(critic_summary: str | None = None, selected_option: str | None = None, schema_version: str = SCHEMA_VERSION, ctx: Context | None = None) -> RalplanCompleteResult:
        request = RalplanCompleteRequest(critic_summary=critic_summary, selected_option=selected_option, schema_version=schema_version)
        result = build_ralplan_complete(request)
        return await _maybe_elicit_handoff_choice(ctx, result, message_prefix='规划阶段已完成。宿主必须渲染交互式选择控件；assistant 不得用文本代渲染。')

    @app.tool(name='yimggen', description=descriptions['yimggen'], structured_output=True)
    async def imagegen(brief: str, output_root: str | None = None, asset_slug: str | None = None, dimensions: str | None = None, frame_count: int | None = None, transparent: bool = True, memory_context: Any = None, schema_version: str = SCHEMA_VERSION, ctx: Context | None = None) -> ImagegenResult:
        request = ImagegenRequest(brief=brief, output_root=output_root, asset_slug=asset_slug, dimensions=dimensions, frame_count=frame_count, transparent=transparent, memory_context=memory_context or {}, schema_version=schema_version)
        return build_imagegen(request)

    @app.tool(name='ydo', description=descriptions['ydo'], structured_output=True)
    async def ralph(memory_context: Any = None, schema_version: str = SCHEMA_VERSION, ctx: Context | None = None) -> RalphResult:
        request = RalphRequest(memory_context=memory_context or {}, schema_version=schema_version)
        result = build_ralph(request)
        return result

    @app.tool(name='ydo_menu', description=descriptions['ydo_menu'], structured_output=True)
    async def ralph_complete(selected_option: str | None = None, memory_context: Any = None, schema_version: str = SCHEMA_VERSION, ctx: Context | None = None) -> RalphCompleteResult:
        request = RalphCompleteRequest(selected_option=selected_option, memory_context=memory_context or {}, schema_version=schema_version)
        result = build_ralph_complete(request)
        return await _maybe_elicit_handoff_choice(ctx, result, message_prefix='执行阶段当前一轮已结束。宿主必须渲染交互式选择控件；assistant 不得用文本代渲染。')

    for tool_schema in MEMPALACE_TOOL_SCHEMAS:
        _register_mempalace_tool(app, name=tool_schema['name'], description=descriptions[tool_schema['name']], request_model=MEMPALACE_REQUEST_MODELS[tool_schema['name']])

    return app

