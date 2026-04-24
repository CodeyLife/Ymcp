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
        description="作为 ralplan 共识流程总入口，返回首个应调用的子工具并要求宿主按显式 handoff 串联。",
        request_model=RalplanRequest,
        response_model=RalplanResult,
        handler=build_ralplan,
    ),
    ToolSpec(
        name="ralplan_planner",
        description="Ymcp 直接产出 Planner 草案，并显式 handoff 到 ralplan_architect。",
        request_model=RalplanPlannerRequest,
        response_model=RalplanPlannerResult,
        handler=build_ralplan_planner,
    ),
    ToolSpec(
        name="ralplan_architect",
        description="Ymcp 直接产出 Architect 审查结果，并显式 handoff 到 ralplan_critic。",
        request_model=RalplanArchitectRequest,
        response_model=RalplanArchitectResult,
        handler=build_ralplan_architect,
    ),
    ToolSpec(
        name="ralplan_critic",
        description="Ymcp 直接产出 Critic verdict；批准时显式 handoff 到 ralplan_handoff。",
        request_model=RalplanCriticRequest,
        response_model=RalplanCriticResult,
        handler=build_ralplan_critic,
    ),
    ToolSpec(
        name="ralplan_handoff",
        description="只在 Critic 批准后收集下一步 workflow 选择；需要 MCP Elicitation，不支持时阻断。",
        request_model=RalplanHandoffRequest,
        response_model=RalplanHandoffResult,
        handler=build_ralplan_handoff,
    ),
    ToolSpec(
        name="deep_interview",
        description="需求不明确时通过 MCP Elicitation 收集澄清回答；宿主只负责响应服务器发起的 Elicitation 与后续 handoff。",
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
