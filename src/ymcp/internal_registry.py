from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Type

from pydantic import BaseModel

from ymcp.complete_copy import with_blocked_on_unsupported_elicitation
from ymcp.contracts.deep_interview import (
    DeepInterviewRequest,
    DeepInterviewResult,
)
from ymcp.contracts.imagegen import ImagegenRequest, ImagegenResult
from ymcp.contracts.menu import MenuRequest, MenuResult
from ymcp.contracts.memory import MEMPALACE_REQUEST_MODELS, MEMPALACE_TOOL_SCHEMAS, MemoryResult
from ymcp.contracts.ralph import RalphRequest, RalphResult
from ymcp.contracts.ralplan import (
    RalplanRequest,
    RalplanResult,
)
from ymcp.engine.deep_interview import build_deep_interview
from ymcp.engine.imagegen import build_imagegen
from ymcp.engine.menu import build_menu
from ymcp.engine.ralph import build_ralph
from ymcp.engine.ralplan import build_ralplan
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
        description='需求澄清启动 tool。模型应使用返回的 deep-interview skill_content 完成调研；完成任务并输出总结文案后调用统一 menu tool，并把 yplan / refine_further 作为 options 参数传入。',
        request_model=DeepInterviewRequest,
        response_model=DeepInterviewResult,
        handler=build_deep_interview,
    ),
    ToolSpec(
        name='yplan',
        description='共识规划阶段化 tool。模型应使用返回的 plan skill_content，按 phase=start/planner/architect/critic 顺序提交 planner_summary、architect_summary、critic_verdict 和 critic_summary；只有 critic_verdict=APPROVE 才能输出最终规划总结并调用 menu，ITERATE/REJECT 必须继续 yplan 修订且不得宣告任务完成。',
        request_model=RalplanRequest,
        response_model=RalplanResult,
        handler=build_ralplan,
    ),
    ToolSpec(
        name='ydo',
        description='执行验证启动 tool。模型应使用返回的 ralph skill_content 完成执行、修复、验证流程；完成任务并输出总结文案后调用统一 menu tool，并把 finish / memory_store / yplan / continue_execution 作为 options 参数传入。',
        request_model=RalphRequest,
        response_model=RalphResult,
        handler=build_ralph,
    ),
    ToolSpec(
        name='menu',
        description=with_blocked_on_unsupported_elicitation(
            '统一 workflow 流程菜单 tool。模型在完成 ydeep / yplan / ydo 阶段任务并输出总结文案后调用本 tool；tool 通过 workflow-menu 指导、优先 MCP Elicitation，并在 Elicitation 失败时启动 localhost WebUI fallback 提供真实可交互选项。'
        ),
        request_model=MenuRequest,
        response_model=MenuResult,
        handler=build_menu,
    ),
    ToolSpec(
        name='yimggen',
        description='本地图片/序列帧生成启动 tool。模型应使用返回的 imagegen skill_content 编写或调整 Python/Pillow 脚本，在本地生成 frames、sprite、preview 等产物；本 tool 不调用远程图片 API、不使用外部模型、不执行任意脚本。',
        request_model=ImagegenRequest,
        response_model=ImagegenResult,
        handler=build_imagegen,
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


