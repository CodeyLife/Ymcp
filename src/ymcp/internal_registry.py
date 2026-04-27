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
        description='需求澄清启动 tool。模型应使用返回的 deep-interview skill_content 完成调研；tool 只提供下一步 handoff，不要求回传中间 artifact。',
        request_model=DeepInterviewRequest,
        response_model=DeepInterviewResult,
        handler=build_deep_interview,
    ),
    ToolSpec(
        name='ydeep_complete',
        description='需求澄清完成 tool。模型在完成 deep-interview 调研后调用本 tool；tool 产出 clarified_artifact，并通过强制 Elicitation 返回统一 handoff 选项，由宿主按固定约定决定如何进入 yplan 或继续澄清。若宿主不支持 Elicitation，则本 tool 应返回 blocked。',
        request_model=DeepInterviewCompleteRequest,
        response_model=DeepInterviewCompleteResult,
        handler=build_deep_interview_complete,
    ),
    ToolSpec(
        name='yplan',
        description='共识规划启动 tool。模型应使用返回的 planner skill_content 完成 planner 阶段；tool 强约束下一步只能进入 yplan_architect。输入只保留 task，其他来源转换由宿主完成。',
        request_model=RalplanRequest,
        response_model=RalplanResult,
        handler=build_ralplan,
    ),
    ToolSpec(
        name='yplan_architect',
        description='共识规划 architect 阶段 tool。模型在进入本阶段后，使用 architect skill_content 继续推理；tool 只负责提供下一步 handoff，不要求回传中间 planning artifact。',
        request_model=RalplanArchitectRequest,
        response_model=RalplanArchitectResult,
        handler=build_ralplan_architect,
    ),
    ToolSpec(
        name='yplan_critic',
        description='共识规划 critic 阶段 tool。模型在进入本阶段后，使用 critic skill_content 继续推理，并自主判断是调用 yplan_complete 收口，还是在否决后强制回到 yplan 重开规划；tool 不强制固定 verdict 协议，也不要求回传中间 artifact。',
        request_model=RalplanCriticRequest,
        response_model=RalplanCriticResult,
        handler=build_ralplan_critic,
    ),
    ToolSpec(
        name='yplan_complete',
        description='共识规划完成 tool。模型在完成 critic 评估后调用本 tool；本 tool 是无输入收口阶段，通过强制 Elicitation 返回 handoff 选项，用于决定是否进入 ydo、restart 或 memory_store，不再要求 summary 或构造交接 artifact。若宿主不支持 Elicitation，则本 tool 应返回 blocked。',
        request_model=RalplanCompleteRequest,
        response_model=RalplanCompleteResult,
        handler=build_ralplan_complete,
    ),
    ToolSpec(
        name='ydo',
        description='执行验证启动 tool。模型应使用返回的 ralph skill_content 完成执行、修复、验证流程；本 tool 不再要求 approved_plan_artifact 输入，而是依赖当前调用链上下文继续执行。',
        request_model=RalphRequest,
        response_model=RalphResult,
        handler=build_ralph,
    ),
    ToolSpec(
        name='ydo_complete',
        description='执行验证完成 tool。模型在完成 ralph 执行循环后调用本 tool；本 tool 是无输入收口阶段，会通过强制 Elicitation 返回统一 handoff 选项（如 finish / memory_store / yplan / continue_execution），由宿主按固定约定决定是收尾、重规划还是继续执行。若宿主不支持 Elicitation，则本 tool 应返回 blocked。',
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


