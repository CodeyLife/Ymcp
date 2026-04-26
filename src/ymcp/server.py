from __future__ import annotations

import inspect
import json
import logging
import os
import time
from typing import Annotated, Any

import mcp.types as types
from mcp.server.fastmcp import Context, FastMCP
from pydantic import BaseModel, Field, WithJsonSchema

from ymcp.capabilities import get_prompt_specs, get_resource_specs, prompt_template
from ymcp.contracts.common import HostActionType, ToolStatus
from ymcp.contracts.deep_interview import (
    DeepInterviewCompleteRequest,
    DeepInterviewCompleteResult,
    DeepInterviewRequest,
    DeepInterviewResult,
)
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
from ymcp.core.result import apply_selected_tool_handoff
from ymcp.engine.deep_interview import build_deep_interview, build_deep_interview_complete
from ymcp.engine.ralph import build_ralph, build_ralph_complete
from ymcp.engine.ralplan import build_ralplan, build_ralplan_architect, build_ralplan_complete, build_ralplan_critic
from ymcp.internal_registry import get_tool_specs
from ymcp.memory import build_memory_request_id, execute_memory_operation, memory_log_kv, memory_result_to_mcp_payload, mempalace_palace_path

LOGGER = logging.getLogger('ymcp')


def _single_choice_schema(title: str, description: str, options: list[tuple[str, str, str]]) -> dict[str, Any]:
    return {
        'type': 'string',
        'title': title,
        'description': description,
        'oneOf': [{'const': value, 'title': option_title} for value, option_title, _ in options],
    }


DeepInterviewNextChoice = Annotated[str, Field(description='ydeep_complete 完成后的下一步 workflow。'), WithJsonSchema(_single_choice_schema('下一步工作流', '请选择 ydeep_complete 完成后的下一步 workflow。', [('yplan', '进入 yplan', ''), ('ydo', '使用 ydo 执行任务', ''), ('refine_further', '继续澄清', '')]))]
RalplanNextChoice = Annotated[str, Field(description='yplan_complete 完成后的下一步 workflow。'), WithJsonSchema(_single_choice_schema('下一步工作流', '请选择 yplan_complete 完成后的下一步 workflow。', [('ydo', '使用 ydo 执行任务', ''), ('restart', '重新开始规划', ''), ('memory_store', '保存规划到记忆', '')]))]
RalphNextChoice = Annotated[str, Field(description='ydo_complete 完成后的下一步动作。'), WithJsonSchema(_single_choice_schema('下一步动作', '请选择 ydo_complete 完成后的下一步动作。', [('finish', '结束当前任务', ''), ('memory_store', '保存结果到记忆', ''), ('yplan', '回到 yplan', ''), ('continue_execution', '继续增强', '')]))]


class DeepInterviewNextInput(BaseModel):
    next_tool: DeepInterviewNextChoice


class RalplanNextInput(BaseModel):
    next_tool: RalplanNextChoice


class RalphNextInput(BaseModel):
    next_tool: RalphNextChoice


def configure_logging(level: int = logging.INFO) -> None:
    if logging.getLogger().handlers:
        return
    logging.basicConfig(level=level, format='%(levelname)s %(name)s: %(message)s')


def _supports_form_elicitation(ctx: Context | None) -> bool:
    if ctx is None:
        return False
    try:
        if not ctx.session.check_client_capability(types.ClientCapabilities(elicitation=types.ElicitationCapability())):
            return False
        client_params = getattr(ctx.session, '_client_params', None)
        client_caps = getattr(client_params, 'capabilities', None)
        elicitation = getattr(client_caps, 'elicitation', None)
        if elicitation is None:
            return False
        form_mode = getattr(elicitation, 'form', None)
        url_mode = getattr(elicitation, 'url', None)
        return form_mode is not None or (form_mode is None and url_mode is None)
    except ValueError:
        return False


def _finalize_selected(result, selected: str):
    apply_selected_tool_handoff(result, selected)
    result.status = ToolStatus.OK
    result.summary = f'已确认下一步：{selected}。'
    return result


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
    app = FastMCP(name='ymcp', instructions='Workflow tools ydeep / ydeep_complete / yplan / yplan_architect / yplan_critic / yplan_complete / ydo / ydo_complete with skill-guided reasoning and tool-enforced next-step gates.', log_level='ERROR')
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
    async def deep_interview(brief: str, known_context: list[str] | None = None, memory_context: Any = None, schema_version: str = '1.0', ctx: Context | None = None) -> DeepInterviewResult:
        request = DeepInterviewRequest(brief=brief, known_context=known_context or [], memory_context=memory_context or {}, schema_version=schema_version)
        result = build_deep_interview(request)
        return result

    @app.tool(name='ydeep_complete', description=descriptions['ydeep_complete'], structured_output=True)
    async def deep_interview_complete(brief: str, summary: str, known_context: list[str] | None = None, memory_context: Any = None, schema_version: str = '1.0', ctx: Context | None = None) -> DeepInterviewCompleteResult:
        request = DeepInterviewCompleteRequest(brief=brief, summary=summary, known_context=known_context or [], memory_context=memory_context or {}, schema_version=schema_version)
        result = build_deep_interview_complete(request)
        if result.meta.requires_elicitation and _supports_form_elicitation(ctx):
            choice = await ctx.elicit('需求澄清已完成。请选择下一步 workflow。', DeepInterviewNextInput)
            if choice.action == 'accept':
                return _finalize_selected(result, choice.data.next_tool)
        return result

    @app.tool(name='yplan', description=descriptions['yplan'], structured_output=True)
    async def ralplan(task: str, known_context: list[str] | None = None, memory_context: Any = None, schema_version: str = '1.0', ctx: Context | None = None) -> RalplanResult:
        request = RalplanRequest(task=task, known_context=known_context or [], memory_context=memory_context or {}, schema_version=schema_version)
        result = build_ralplan(request)
        return result

    @app.tool(name='yplan_architect', description=descriptions['yplan_architect'], structured_output=True)
    async def ralplan_architect(task: str, plan_summary: str = '', planner_notes: list[str] | None = None, known_context: list[str] | None = None, memory_context: Any = None, schema_version: str = '1.0', ctx: Context | None = None) -> RalplanArchitectResult:
        request = RalplanArchitectRequest(task=task, plan_summary=plan_summary, planner_notes=planner_notes or [], known_context=known_context or [], memory_context=memory_context or {}, schema_version=schema_version)
        return build_ralplan_architect(request)

    @app.tool(name='yplan_critic', description=descriptions['yplan_critic'], structured_output=True)
    async def ralplan_critic(task: str, plan_summary: str = '', planner_notes: list[str] | None = None, architect_notes: list[str] | None = None, critic_verdict: str = '', critic_notes: list[str] | None = None, acceptance_criteria: list[str] | None = None, known_context: list[str] | None = None, memory_context: Any = None, schema_version: str = '1.0', ctx: Context | None = None) -> RalplanCriticResult:
        request = RalplanCriticRequest(task=task, plan_summary=plan_summary, planner_notes=planner_notes or [], architect_notes=architect_notes or [], critic_verdict=critic_verdict, critic_notes=critic_notes or [], acceptance_criteria=acceptance_criteria or [], known_context=known_context or [], memory_context=memory_context or {}, schema_version=schema_version)
        return build_ralplan_critic(request)

    @app.tool(name='yplan_complete', description=descriptions['yplan_complete'], structured_output=True)
    async def ralplan_complete(task: str, summary: str, critic_verdict: str, plan_summary: str = '', planner_notes: list[str] | None = None, architect_notes: list[str] | None = None, critic_notes: list[str] | None = None, acceptance_criteria: list[str] | None = None, known_context: list[str] | None = None, memory_context: Any = None, schema_version: str = '1.0', ctx: Context | None = None) -> RalplanCompleteResult:
        request = RalplanCompleteRequest(task=task, summary=summary, critic_verdict=critic_verdict, plan_summary=plan_summary, planner_notes=planner_notes or [], architect_notes=architect_notes or [], critic_notes=critic_notes or [], acceptance_criteria=acceptance_criteria or [], known_context=known_context or [], memory_context=memory_context or {}, schema_version=schema_version)
        result = build_ralplan_complete(request)
        if result.meta.requires_elicitation and _supports_form_elicitation(ctx):
            choice = await ctx.elicit('共识规划已完成。请选择下一步 workflow。', RalplanNextInput)
            if choice.action == 'accept':
                return _finalize_selected(result, choice.data.next_tool)
        return result

    @app.tool(name='ydo', description=descriptions['ydo'], structured_output=True)
    async def ralph(approved_plan: str, schema_version: str = '1.0', ctx: Context | None = None) -> RalphResult:
        request = RalphRequest(approved_plan=approved_plan, schema_version=schema_version)
        result = build_ralph(request)
        return result

    @app.tool(name='ydo_complete', description=descriptions['ydo_complete'], structured_output=True)
    async def ralph_complete(approved_plan: str, summary: str, schema_version: str = '1.0', ctx: Context | None = None) -> RalphCompleteResult:
        request = RalphCompleteRequest(approved_plan=approved_plan, summary=summary, schema_version=schema_version)
        result = build_ralph_complete(request)
        if result.meta.requires_elicitation and _supports_form_elicitation(ctx):
            choice = await ctx.elicit('执行已完成。请选择下一步。', RalphNextInput)
            if choice.action == 'accept':
                return _finalize_selected(result, choice.data.next_tool)
        return result

    for tool_schema in MEMPALACE_TOOL_SCHEMAS:
        _register_mempalace_tool(app, name=tool_schema['name'], description=descriptions[tool_schema['name']], request_model=MEMPALACE_REQUEST_MODELS[tool_schema['name']])

    return app
