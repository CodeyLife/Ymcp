from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Type

from pydantic import BaseModel

from ymcp.contracts.deep_interview import DeepInterviewRequest, DeepInterviewResult
from ymcp.contracts.memory import (
    MEMPALACE_REQUEST_MODELS,
    MEMPALACE_TOOL_SCHEMAS,
    MemoryResult,
)
from ymcp.contracts.plan import PlanRequest, PlanResult
from ymcp.contracts.ralplan import RalplanRequest, RalplanResult
from ymcp.contracts.ralph import RalphRequest, RalphResult
from ymcp.engine.deep_interview import build_deep_interview
from ymcp.engine.plan import build_plan
from ymcp.engine.ralplan import build_ralplan
from ymcp.engine.ralph import build_ralph
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
        name="plan",
        description="根据模式输出 MCP 标准结构化计划结果；需要用户输入时优先使用 MCP Elicitation。",
        request_model=PlanRequest,
        response_model=PlanResult,
        handler=build_plan,
    ),
    ToolSpec(
        name="ralplan",
        description="输出 MCP 标准结构化 ralplan 共识结果；批准后的下一步选择优先使用 MCP Elicitation。",
        request_model=RalplanRequest,
        response_model=RalplanResult,
        handler=build_ralplan,
    ),
    ToolSpec(
        name="deep_interview",
        description="需求不明确时通过 MCP Elicitation 收集澄清回答；结晶后返回 handoff_options，宿主必须等待用户选择下一步 workflow。",
        request_model=DeepInterviewRequest,
        response_model=DeepInterviewResult,
        handler=build_deep_interview,
    ),
    ToolSpec(
        name="ralph",
        description="根据计划和证据返回 MCP 标准结构化验证状态；不执行命令；缺证据或完成选择优先使用 MCP Elicitation。",
        request_model=RalphRequest,
        response_model=RalphResult,
        handler=build_ralph,
    ),
)


def _memory_handler(tool_name: str):
    return lambda request: execute_memory_operation(
        tool_name,
        **request.model_dump(exclude={"schema_version"}, exclude_none=True),
    )


TOOL_SPECS = TOOL_SPECS + tuple(
    ToolSpec(
        name=tool_schema["name"],
        description=tool_schema["description"],
        request_model=MEMPALACE_REQUEST_MODELS[tool_schema["name"]],
        response_model=MemoryResult,
        handler=_memory_handler(tool_schema["name"]),
    )
    for tool_schema in MEMPALACE_TOOL_SCHEMAS
)


def get_tool_specs() -> tuple[ToolSpec, ...]:
    return TOOL_SPECS
