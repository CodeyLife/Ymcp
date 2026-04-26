from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Type

from pydantic import BaseModel

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
from ymcp.engine.deep_interview import build_deep_interview, build_deep_interview_complete
from ymcp.engine.ralph import build_ralph, build_ralph_complete
from ymcp.engine.ralplan import build_ralplan, build_ralplan_architect, build_ralplan_complete, build_ralplan_critic
from ymcp.memory import execute_memory_operation


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    request_model: Type[BaseModel]
    response_model: Type[BaseModel]
    handler: Callable[[BaseModel], BaseModel]


TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name='ydeep',
        description='需求澄清启动 tool。它要求模型使用返回的 deep-interview skill_content 完成完整需求调研并输出总结文案；最后必须调用 `ydeep_complete`，由完成 tool 触发下一步 Elicitation。',
        request_model=DeepInterviewRequest,
        response_model=DeepInterviewResult,
        handler=build_deep_interview,
    ),
    ToolSpec(
        name='ydeep_complete',
        description='需求澄清完成 tool。模型在使用 prompt `deep-interview` 完成调研后必须调用本 tool；调用后应立即通过 Elicitation 提供下一步 workflow 选项。',
        request_model=DeepInterviewCompleteRequest,
        response_model=DeepInterviewCompleteResult,
        handler=build_deep_interview_complete,
    ),
    ToolSpec(
        name='yplan',
        description='共识规划启动 tool。它要求模型使用返回的 planner skill_content 完成 planner 阶段并输出总结文案；最后必须调用 `yplan_architect`。',
        request_model=RalplanRequest,
        response_model=RalplanResult,
        handler=build_ralplan,
    ),
    ToolSpec(
        name='yplan_architect',
        description='共识规划 architect 阶段 tool。模型在进入本阶段后，应使用返回的 architect skill_content 完成 architect 阶段并输出总结文案；最后调用 `yplan_critic`。',
        request_model=RalplanArchitectRequest,
        response_model=RalplanArchitectResult,
        handler=build_ralplan_architect,
    ),
    ToolSpec(
        name='yplan_critic',
        description='共识规划 critic 阶段 tool。模型在进入本阶段后，应使用返回的 critic skill_content 完成 critic 阶段并输出总结文案；最后调用 `yplan_complete`。',
        request_model=RalplanCriticRequest,
        response_model=RalplanCriticResult,
        handler=build_ralplan_critic,
    ),
    ToolSpec(
        name='yplan_complete',
        description='共识规划完成 tool。模型在完成 critic 评估后必须调用本 tool；调用后应立即通过 Elicitation 提供 `ydo`、`restart`、`memory_store` 选项。',
        request_model=RalplanCompleteRequest,
        response_model=RalplanCompleteResult,
        handler=build_ralplan_complete,
    ),
    ToolSpec(
        name='ydo',
        description='执行验证启动 tool。它要求模型使用返回的 ralph skill_content 完成执行、修复、验证流程并输出总结文案；最后必须调用 `ydo_complete`。',
        request_model=RalphRequest,
        response_model=RalphResult,
        handler=build_ralph,
    ),
    ToolSpec(
        name='ydo_complete',
        description='执行验证完成 tool。模型在完成 ralph 执行循环后必须调用本 tool；调用后应立即通过 Elicitation 提供 `finish`、`memory_store`、`yplan`、`continue_execution` 选项。',
        request_model=RalphCompleteRequest,
        response_model=RalphCompleteResult,
        handler=build_ralph_complete,
    ),
)


def _memory_handler(tool_name: str):
    return lambda request: execute_memory_operation(
        tool_name,
        **request.model_dump(exclude={'schema_version'}, exclude_none=True),
    )


TOOL_SPECS = TOOL_SPECS + tuple(
    ToolSpec(
        name=tool_schema['name'],
        description=tool_schema['description'],
        request_model=MEMPALACE_REQUEST_MODELS[tool_schema['name']],
        response_model=MemoryResult,
        handler=_memory_handler(tool_schema['name']),
    )
    for tool_schema in MEMPALACE_TOOL_SCHEMAS
)


def get_tool_specs() -> tuple[ToolSpec, ...]:
    return TOOL_SPECS
